/**
 * 计量与额度（票据 09，ADR-0020、M242）：只经 HTTP 驱动，断言能否交付、哪里被拒绝、额度怎样变化，以及经 API 可见的用量明细。
 * - 提交批次先预占本批项数，额度不够整批拒绝（429 quota.exceeded，说明里写剩余额度）；
 * - 逐项结算：成功的计 1 张、记一条用量事件，失败与未执行的退回预占，批次结束退回剩余预占；
 * - 同一幂等键重试、worker 重领同一项都只计一次；草稿预览与重放不计额度；
 * - 周期是按 UTC+8 切分的自然月，不结转；对账任务退回没人再交付的批次遗留的预占。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN, ENGINE_MAX_PIXELS, periodOf, type ClaimedTask, type Plan, type ServiceBackend } from '../src/backend.js';
import { rendererBuildId } from '../src/engine.js';
import { reconcileReservations } from '../src/metering.js';
import { emptyStats, inProcessRunner, startScheduler, type Runner, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { greetingPreview, seedGreeting } from './seed.js';

const OUTPUT = { width: 160, height: 40, dpi: 120, format: 'png' };
const inline = (message: string) => ({ inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message } } });
/** 问候牌的三项：两项交付，一项的数据集不存在（失败）。 */
const greetingBatch = (tag: string) => ({ template: '问候牌', items: [
  { id: `${tag}-saved`, dataset: { id: 'ds-greeting' }, output: OUTPUT },
  { id: `${tag}-inline`, dataset: inline(`下一站 ${tag}`), output: OUTPUT },
  { id: `${tag}-missing`, dataset: { id: 'no-such-dataset' }, output: OUTPUT },
] });
/** n 项都能交付的问候牌批次。 */
const deliverable = (tag: string, n: number) => ({ template: '问候牌', items: Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i + 1}`, dataset: inline(`${tag} ${i + 1}`), output: OUTPUT })) });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeMetering(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`计量与额度（${name}）`, () => {
    let world: World, backend: ServiceBackend, build: string, scheduler: Scheduler | undefined;
    /** 平台管理员与客户管理员的会话；把时钟拨到几年后时会话已过期，要重新登录。 */
    let platformToken: string, adminToken: string;
    const startWorker = (runner?: Runner, leaseMs = 60_000) =>
      startScheduler({ backend, runner: runner ?? inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: `metering-${Math.random()}`, build, leaseMs });
    const stopWorker = async () => { await scheduler?.stop(); scheduler = undefined; };
    beforeAll(async () => {
      backend = await makeBackend();
      build = await rendererBuildId();
      world = await createWorld(backend);
      await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
      platformToken = world.platform;
      adminToken = world.b.admin.token;
    });
    afterAll(async () => { await stopWorker(); });
    const relogin = async () => {
      platformToken = await world.login(world.platformLogin.email, world.platformLogin.password);
      adminToken = await world.login(tenant().admin.email, tenant().admin.password);
    };

    const tenant = () => world.b;
    const setPlan = async (plan: Partial<Plan>, tenantId = tenant().id) => {
      const reply = await world.call('PUT', `/v1/platform/tenants/${tenantId}/plan`, platformToken, { ...DEFAULT_PLAN, ...plan });
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body as Plan;
    };
    const usage = async (query = '') => {
      const reply = await world.call('GET', `/v1/usage${query}`, adminToken);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const imageEvents = async (period = periodOf(world.clock.value)) => {
      const reply = await world.call('GET', `/v1/usage/events?kind=image&limit=500&period=${period}`, adminToken);
      expect(reply.status).toBe(200);
      return reply.body.events as { batchId: string; index: number; quantity: number; kind: string }[];
    };
    const submit = (body: unknown, headers: Record<string, string> = {}) => world.call('POST', '/v1/batches', tenant().key.token, body, headers);
    const accepted = async (body: unknown, headers: Record<string, string> = {}) => {
      const reply = await submit(body, headers);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(202);
      return reply.body.id as string;
    };
    const finished = async (id: string, timeoutMs = 60_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = await world.call('GET', `/v1/batches/${id}`, tenant().key.token);
        if (reply.body.status === 'finished') return reply.body;
        if (Date.now() > deadline) throw new Error(`批次 ${id} 没有结束：${reply.raw.slice(0, 300)}`);
        await sleep(20);
      }
    };
    const until = async (check: () => Promise<boolean>, what: string, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`等不到：${what}`);
        await sleep(10);
      }
    };

    it('平台管理员设置套餐：建租户时可以一并设，不设时每月 0 张；取值越界答 400；客户管理员在用量里看得到套餐与额度', async () => {
      const { call, platform } = world;
      const bare = await call('POST', '/v1/platform/tenants', platform, { name: '没设套餐' });
      expect(bare).toMatchObject({ status: 201, body: { plan: DEFAULT_PLAN } });
      expect(DEFAULT_PLAN).toEqual({ monthlyImages: 0, maxPixels: ENGINE_MAX_PIXELS, concurrency: 2 });
      const withPlan = await call('POST', '/v1/platform/tenants', platform, { name: '一并设套餐', plan: { monthlyImages: 30, maxPixels: 4_000_000, concurrency: 3 } });
      expect(withPlan.body.plan).toEqual({ monthlyImages: 30, maxPixels: 4_000_000, concurrency: 3 });
      expect((await call('GET', `/v1/platform/tenants/${withPlan.body.id}/plan`, platform)).body).toEqual({ monthlyImages: 30, maxPixels: 4_000_000, concurrency: 3 });

      const plan = `/v1/platform/tenants/${tenant().id}/plan`;
      for (const bad of [{ ...DEFAULT_PLAN, monthlyImages: -1 }, { ...DEFAULT_PLAN, maxPixels: ENGINE_MAX_PIXELS + 1 }, { ...DEFAULT_PLAN, maxPixels: 0 },
        { ...DEFAULT_PLAN, concurrency: 0 }, { ...DEFAULT_PLAN, concurrency: 1.5 }, { monthlyImages: 10, maxPixels: 100 }, { ...DEFAULT_PLAN, price: 1 }]) {
        expect((await call('PUT', plan, platform, bad)).body.problems[0].code, JSON.stringify(bad)).toBe('request.invalid');
      }
      expect((await call('PUT', `/v1/platform/tenants/${crypto.randomUUID()}/plan`, platform, DEFAULT_PLAN)).status).toBe(404);
      expect(await setPlan({ monthlyImages: 5 })).toEqual({ ...DEFAULT_PLAN, monthlyImages: 5 });

      const period = periodOf(world.clock.value), view = await usage();
      expect(view).toEqual({
        period, start: expect.any(String), end: expect.any(String), plan: { ...DEFAULT_PLAN, monthlyImages: 5 },
        images: { limit: 5, used: 0, reserved: 0, remaining: 5 },
        tokens: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      });
      // 平台管理员看到的与客户管理员相同；设套餐、看用量都记进租户的审计，标为跨租户操作。
      expect((await call('GET', `/v1/platform/tenants/${tenant().id}/usage`, platform)).body).toEqual(view);
      const audit = (await call('GET', '/v1/audit-events?limit=500', tenant().admin.token)).body.events as { action: string; crossTenant: boolean; actor: { kind: string } }[];
      expect(audit.filter((event) => event.action === 'plan.update').every((event) => event.crossTenant && event.actor.kind === 'platformUser')).toBe(true);
      expect(audit.some((event) => event.action === 'usage.read' && event.crossTenant)).toBe(true);
      for (const query of ['?period=2026-13', '?period=x', '/../usage?period=202610']) expect((await call('GET', `/v1/usage${query}`, tenant().admin.token)).status).not.toBe(200);
      expect((await call('GET', '/v1/usage/events?kind=pixels', tenant().admin.token)).status).toBe(400);
    });

    it('提交批次先预占本批项数；额度不够整批拒绝，答 429 与剩余额度、不建批次；逐项结算，失败项退回预占；正好用完也可以', async () => {
      await setPlan({ monthlyImages: 5 });
      const before = await usage();
      const first = await accepted(greetingBatch('预占'));
      expect((await usage()).images).toEqual({ limit: 5, used: 0, reserved: 3, remaining: 2 });

      const rejected = await submit(greetingBatch('超额'));
      expect(rejected.status).toBe(429);
      expect(rejected.body.problems).toEqual([{ level: 'severe', code: 'quota.exceeded', location: { kind: 'input', source: 'request.items' }, message: expect.stringContaining('剩余 2 张') }]);
      expect(rejected.body.problems[0].message).toContain('本批 3 项');
      expect(rejected.body.quota).toEqual({ period: before.period, limit: 5, used: 0, reserved: 3, remaining: 2, requested: 3 });
      expect(rejected.raw).not.toContain(world.a.id);
      const audit = (await world.call('GET', '/v1/audit-events?limit=500', tenant().admin.token)).body.events as { action: string }[];
      expect(audit.filter((event) => event.action === 'batch.create')).toHaveLength(1);
      expect((await usage()).images).toEqual({ limit: 5, used: 0, reserved: 3, remaining: 2 });

      scheduler = startWorker();
      expect((await finished(first)).summary).toMatchObject({ delivered: 2, failed: 1 });
      expect((await usage()).images).toEqual({ limit: 5, used: 2, reserved: 0, remaining: 3 });
      const events = await imageEvents();
      expect(events.map((event) => [event.batchId, event.index, event.quantity]).sort()).toEqual([[first, 1, 1], [first, 2, 1]]);

      // 已用 2 + 本批 3 = 5，正好用完；再交 1 项就超了。
      expect((await finished(await accepted(deliverable('用完', 3)))).summary.delivered).toBe(3);
      expect((await usage()).images).toEqual({ limit: 5, used: 5, reserved: 0, remaining: 0 });
      expect((await submit(deliverable('多一项', 1))).body.quota).toMatchObject({ remaining: 0, requested: 1 });
      // 套餐调高后当期的限额随之改变。
      await setPlan({ monthlyImages: 100 });
      expect((await usage()).images).toEqual({ limit: 100, used: 5, reserved: 0, remaining: 95 });
      expect(await imageEvents()).toHaveLength(5);
    });

    it('同一幂等键重试：返回同一批次，不重复预占也不重复计费；额度用完后重试照样返回那个批次', async () => {
      await stopWorker();
      const start = (await usage()).images, key = { 'idempotency-key': `计费-${Math.random()}` };
      const id = await accepted(greetingBatch('幂等'), key);
      const retried = await submit(greetingBatch('幂等'), key);
      expect(retried.status).toBe(200);
      expect(retried.body.id).toBe(id);
      expect((await usage()).images).toMatchObject({ used: start.used, reserved: start.reserved + 3 });
      scheduler = startWorker();
      await finished(id);
      await setPlan({ monthlyImages: start.used + 2 });
      const again = await submit(greetingBatch('幂等'), key);
      expect(again).toMatchObject({ status: 200, body: { id } });
      expect((await usage()).images).toEqual({ limit: start.used + 2, used: start.used + 2, reserved: 0, remaining: 0 });
      expect((await imageEvents()).filter((event) => event.batchId === id)).toHaveLength(2);

      // 同一个键同时提交两次，额度正好只够一批：一个建批次，另一个拿到同一批次，不因额度已被前一个预占而答 429。
      await stopWorker();
      const now = (await usage()).images, raceKey = { 'idempotency-key': `并发-${Math.random()}` };
      await setPlan({ monthlyImages: now.used + now.reserved + 3 });
      const [one, two] = await Promise.all([submit(greetingBatch('并发'), raceKey), submit(greetingBatch('并发'), raceKey)]);
      expect([one.status, two.status].sort()).toEqual([200, 202]);
      expect(two.body.id).toBe(one.body.id);
      expect((await usage()).images.reserved).toBe(now.reserved + 3);
      scheduler = startWorker();
      await finished(one.body.id);
      await setPlan({ monthlyImages: 1_000 });
    });

    it('worker 登记了一项却在写回前退出：同构建的 worker 过了租约重领，沿用登记的结果，这一项只计一次', async () => {
      await stopWorker();
      const start = (await usage()).images;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const inner = inProcessRunner(backend);
      let first: ClaimedTask | undefined;
      const dying: Runner = { stats: emptyStats(), close: async () => undefined, async run(task, signal) {
        first ??= task;
        const result = await inner.run(task, signal);
        if (task === first) await gate;
        return result;
      } };
      const dead = startWorker(dying, 200);
      const id = await accepted(greetingBatch('重领'));
      // 第一项已登记并结算：已用加 1。
      await until(async () => (await usage()).images.used === start.used + 1, '第一项已结算');
      scheduler = startWorker(undefined, 200);
      expect((await finished(id)).summary).toMatchObject({ delivered: 2, failed: 1 });
      release();
      await dead.stop();
      expect((await usage()).images).toMatchObject({ used: start.used + 2, reserved: start.reserved });
      expect((await imageEvents()).filter((event) => event.batchId === id).map((event) => event.index).sort()).toEqual([1, 2]);
    });

    it('取消：排队的项标为未执行，当即退回预占，不计已用', async () => {
      await stopWorker();
      const start = (await usage()).images;
      const id = await accepted(greetingBatch('取消'));
      expect((await usage()).images.reserved).toBe(start.reserved + 3);
      const cancelled = await world.call('POST', `/v1/batches/${id}/cancel`, tenant().key.token);
      expect(cancelled.body.summary).toMatchObject({ notRun: 3 });
      expect((await usage()).images).toEqual(start);
      scheduler = startWorker();
    });

    it('批次进行中：失败项当即退回预占（登记了问题清单的，与没写成成果的）；取消时排队的项当即退回，正在渲染的一项做完后结算', async () => {
      await stopWorker();
      const start = (await usage()).images;
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const running = new Promise<void>((resolve) => { started = resolve; });
      const inner = inProcessRunner(backend);
      // 第 2 项的成果没写成（输出未交付，没有登记）；第 3 项渲染到一半停住，等放行。
      const gated: Runner = { stats: inner.stats, close: inner.close, async run(task, signal) {
        if (task.kind === 'batchItem' && task.index === 2) {
          const problem = { level: 'severe' as const, code: 'delivery.writeFailed', location: { kind: 'input' as const, source: 'outputRecord' }, message: '输出未交付' };
          return { index: task.index, id: task.itemId, status: 'failed', severe: 1, hints: 0, reason: problem.message, problems: [problem] };
        }
        if (task.kind === 'batchItem' && task.index === 3) { started(); await gate; }
        return inner.run(task, signal);
      } };
      scheduler = startWorker(gated);
      const [saved, inlineItem, missing] = greetingBatch('进行中').items;
      try {
        const id = await accepted({ template: '问候牌', items: [missing, { ...saved, id: '没写成' }, saved, inlineItem] });
        await running;
        // 第 1 项失败（登记了问题清单）、第 2 项失败（没有登记）：各退回 1；第 3 项还在渲染，第 4 项排队。
        await until(async () => (await usage()).images.reserved === start.reserved + 2, '失败项退回预占');
        expect((await usage()).images.used).toBe(start.used);
        await world.call('POST', `/v1/batches/${id}/cancel`, tenant().key.token);
        expect((await usage()).images).toMatchObject({ used: start.used, reserved: start.reserved + 1 });
        release();
        expect((await finished(id)).summary).toMatchObject({ delivered: 1, failed: 2, notRun: 1 });
      } finally { release(); }
      expect((await usage()).images).toMatchObject({ used: start.used + 1, reserved: start.reserved });
      await stopWorker();
      scheduler = startWorker();
    });

    it('草稿预览与重放不计额度', async () => {
      scheduler ??= startWorker();
      const id = await accepted(greetingBatch('重放'));
      await finished(id);
      const start = await usage(), events = (await imageEvents()).length;
      for (let i = 0; i < 2; i++) expect((await world.call('POST', '/v1/previews', tenant().operator.token, greetingPreview())).status).toBe(200);
      const replay = await world.call('POST', `/v1/batches/${id}/items/1/replay`, tenant().key.token);
      expect(replay).toMatchObject({ status: 200, body: { matched: true } });
      expect(await usage()).toEqual(start);
      expect(await imageEvents()).toHaveLength(events);
    });

    it('套餐的单张最大像素：超过的预览答 413；批次中超过的项失败、不计已用，预占在批次结束时退回', async () => {
      scheduler ??= startWorker();
      await setPlan({ monthlyImages: 1_000, maxPixels: 1_000 });
      const start = (await usage()).images;
      const preview = await world.call('POST', '/v1/previews', tenant().operator.token, greetingPreview());
      expect(preview).toMatchObject({ status: 413, body: { problems: [{ code: 'limit.pixelsExceeded', message: expect.stringContaining('超出单张上限 1000') }] } });
      const done = await finished(await accepted(deliverable('大图', 1)));
      expect(done.items[0]).toMatchObject({ status: 'failed', problems: [expect.objectContaining({ code: 'limit.pixelsExceeded' })] });
      expect((await usage()).images).toEqual(start);
      await setPlan({ monthlyImages: 1_000 });
    });

    it('计费周期按 UTC+8 切分的自然月，不结转；用量可按周期查询；批次的结算记在接受它的周期', async () => {
      scheduler ??= startWorker();
      const saved = world.clock.value;
      try {
        // 2031-01-31 23:59:59（UTC+8）还在 1 月。
        world.clock.value = new Date('2031-01-31T15:59:59.000Z');
        await relogin();
        await setPlan({ monthlyImages: 3 });
        expect((await usage()).period).toBe('2031-01');
        const january = await accepted(deliverable('一月', 2));
        // 跨过 UTC+8 的零点才交付完：仍记在接受它的 1 月。
        world.clock.value = new Date('2031-01-31T16:00:00.000Z');
        await finished(january);
        const february = await usage();
        expect(february).toMatchObject({ period: '2031-02', start: '2031-01-31T16:00:00.000Z', end: '2031-02-28T16:00:00.000Z', images: { limit: 3, used: 0, reserved: 0, remaining: 3 } });
        expect(await usage('?period=2031-01')).toMatchObject({ start: '2030-12-31T16:00:00.000Z', end: '2031-01-31T16:00:00.000Z', images: { limit: 3, used: 2, reserved: 0, remaining: 1 } });
        expect((await imageEvents('2031-01')).map((event) => event.batchId)).toEqual([january, january]);
        // 不结转：1 月剩下的 1 张不带到 2 月，2 月照样是 3 张。
        expect((await finished(await accepted(deliverable('二月', 3)))).summary.delivered).toBe(3);
        expect((await usage()).images).toEqual({ limit: 3, used: 3, reserved: 0, remaining: 0 });
      } finally {
        world.clock.value = saved;
        await relogin();
        await setPlan({ monthlyImages: 1_000 });
      }
    });

    it('对账：接受批次的构建没有 worker、批次闲置超过宽限时间，退回遗留的预占；那个构建的 worker 回来后交付的项照样计已用', async () => {
      await stopWorker();
      const start = (await usage()).images;
      const id = await accepted(greetingBatch('对账'));
      const mine = (released: readonly { batchId: string; released: number }[]) => released.filter((entry) => entry.batchId === id);
      // 还在宽限时间里：不退。
      expect(mine(await reconcileReservations(backend, new Date(), 600_000))).toEqual([]);
      // 构建还有 worker 在线（可能正忙别的批次）：不退。
      await backend.workers.heartbeat('metering-busy', build, new Date());
      expect(mine(await reconcileReservations(backend, new Date(Date.now() + 1), 0))).toEqual([]);
      await backend.workers.leave('metering-busy');
      expect((await usage()).images.reserved).toBe(start.reserved + 3);
      // 没有这个构建的 worker、批次闲置超过宽限：退回全部 3 项的预占，只退一次。
      const online = [...await backend.workers.online(new Date(Date.now() - 30_000))];
      expect(mine(await reconcileReservations(backend, new Date(Date.now() + 1), 0)), `在线：${JSON.stringify(online)}，本构建 ${build}`)
        .toEqual([{ tenantId: tenant().id, batchId: id, released: 3 }]);
      expect(mine(await reconcileReservations(backend, new Date(Date.now() + 1), 0))).toEqual([]);
      expect((await usage()).images).toEqual(start);
      // worker 回来把批次交付完：成功的两项计已用，预占不会退成负数。
      scheduler = startWorker();
      expect((await finished(id)).summary).toMatchObject({ delivered: 2, failed: 1 });
      expect((await usage()).images).toMatchObject({ used: start.used + 2, reserved: start.reserved });
      expect((await imageEvents()).filter((event) => event.batchId === id)).toHaveLength(2);
    });

    it('用量明细按 ID 倒序、可按种类筛选与翻页；只有本租户的客户管理员与平台管理员看得到', async () => {
      const { call, platform } = world;
      const all = await imageEvents();
      const page = await call('GET', '/v1/usage/events?kind=image&limit=2', tenant().admin.token);
      expect(page.body.events).toEqual(all.slice(0, 2));
      const next = await call('GET', `/v1/usage/events?kind=image&limit=2&before=${page.body.next}`, tenant().admin.token);
      expect(next.body.events).toEqual(all.slice(2, 4));
      expect(all[0]).toEqual({ id: expect.any(String), at: expect.any(String), period: periodOf(world.clock.value), kind: 'image', quantity: 1, batchId: expect.any(String), index: expect.any(Number) });
      expect((await call('GET', `/v1/platform/tenants/${tenant().id}/usage/events?kind=image&limit=500`, platform)).body.events).toEqual(all);
      for (const token of [tenant().operator.token, tenant().key.token, tenant().engineer.token]) expect((await call('GET', '/v1/usage', token)).status).toBe(403);
      // 另一个租户的管理员只看到自己的（没有用量）。
      const other = await call('GET', '/v1/usage/events?limit=500', world.a.admin.token);
      expect(other.body.events).toEqual([]);
      expect(other.raw).not.toContain(tenant().id);
    });
  });
}
