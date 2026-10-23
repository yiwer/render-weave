/**
 * 批量正式交付（票据 07，ADR-0017、ADR-0019、M246）：只经 HTTP 驱动，断言批次状态、逐项结果与问题清单。
 * 交付的成果另经租户存储的读取接口（引擎的 BatchSource 与 RecordSource，票据 08 的导出就建在它上面）核对：
 * 与引擎在本进程里按同一份输入交付的批次清单、出图记录逐字节相同，记录能重放。
 *
 * 测试进程里的接口进程接受的批次，带测试进程的构建标识，只有同构建的 worker 能交付：两种后端都在测试进程里起一个 worker。
 * - 内存后端：跑在 npm test 里；测试独占队列，调度顺序、构建固定与排空（都涉及预览）只在这里测；
 * - PostgreSQL 加 S3：同一组用例另跑数据库里的队列与租约；Compose 里真实的 worker 是镜像里的构建，不领测试进程接受的批次，
 *   所以用例 1 逐字节与本进程相同，也就证明了别的构建的 worker 没有插手。批次中的内存超限、取消时结束正在渲染的一项与跨批次去重
 *   经真实的接口进程提交，由真实的 worker 交付。
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatchItemTask, ClaimedTask, ServiceBackend, TenantStorage } from '../src/backend.js';
import {
  createMemoryBatch, freezeBatch, readBatchFrom, readWorkspaceDocuments, rendererBuildId, replayRecord, runFrozenBatch,
} from '../src/engine.js';
import { purgeTasks } from '../src/tasks.js';
import { createWorkerHealthServer } from '../src/worker/health.js';
import { emptyStats, inProcessRunner, startScheduler, type Runner, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { seedGreeting, seedStress, stressRequest } from './seed.js';

export interface BatchSuiteOptions {
  /** 测试独占队列：没有别的 worker 会来领预览（内存后端）。 */
  readonly ownsQueue: boolean;
  /** Compose 里真实的接口进程与 worker：单项超时、取消时结束子进程与对象存储的检查。 */
  readonly realWorker?: {
    readonly apiUrl: string; readonly workerUrl: string; readonly listObjects: (prefix: string) => Promise<string[]>;
  };
}

const OUTPUT = { width: 160, height: 40, dpi: 120, format: 'png' };
const inline = (message: string) => ({ inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message } } });
/** 问候牌的三项：两项能交付，一项的数据集不存在。 */
const GREETING_ITEMS = [
  { id: 'saved', dataset: { id: 'ds-greeting' }, output: OUTPUT },
  { id: 'inline', dataset: inline('下一站 人民广场'), output: OUTPUT },
  { id: 'missing', dataset: { id: 'no-such-dataset' }, output: OUTPUT },
];
const greetingBatch = (items: readonly object[] = GREETING_ITEMS) => ({ template: '问候牌', items });
/** 压力牌的一项：项数多时排版费时、内存不大。 */
const stressItem = (id: string, items: number, options: Parameters<typeof stressRequest>[1] = {}) => {
  const { template: _template, ...rest } = stressRequest(items, options);
  return { id, ...rest };
};
/**
 * 正式模式下能画完、又要画一阵子的一项：压力细牌 2,000 项（缺省展开上限之内），本机约 0.7 秒，加上读快照与字体，
 * 足够在渲染中途取消（2026-10-19 实测；正式模式有严重问题时不画，很快就失败，所以要画得下）。
 */
const SLOW = stressItem('slow', 2000, { template: '压力细牌', height: 2000, padding: 40 });
/** 1 亿像素的正式图（引擎上限之内）：Docker 后端测试的 worker 只有 512 MB，画不完就被结束。 */
const HUGE = { id: 'huge', dataset: { id: 'ds-greeting' }, output: { width: 200, height: 200, dpi: 1270, format: 'png' } };
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 引擎在本进程里按同一份输入交付：租户存储里的文档与资源，成果写进内存批次。 */
async function engineBatch(storage: TenantStorage, request: unknown) {
  const opened = await storage.resources.open();
  const frozen = await freezeBatch({ workspace: await readWorkspaceDocuments(storage.documents), resources: opened.store!, request });
  expect(frozen.problems).toEqual([]);
  const memory = createMemoryBatch();
  const result = await runFrozenBatch({ snapshot: frozen.snapshot!, contents: async (info) => frozen.contents!.get(info.id)!, output: memory.output });
  return { memory, result };
}

export function describeBatches(name: string, makeBackend: () => Promise<ServiceBackend>, options: BatchSuiteOptions): void {
  describe(`批量正式交付（${name}）`, () => {
    let world: World, backend: ServiceBackend, build: string;
    let scheduler: Scheduler | undefined;
    const startWorker = (runner?: Runner, extra: { build?: string; leaseMs?: number } = {}) =>
      startScheduler({ backend, runner: runner ?? inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: `in-process-${Math.random()}`, build: extra.build ?? build, leaseMs: extra.leaseMs ?? 60_000 });
    beforeAll(async () => {
      backend = await makeBackend();
      build = await rendererBuildId();
      world = await createWorld(backend, { api: { limits: { maxElements: 100_000, maxLoopItems: 50_000 } } });
      await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
      await seedStress(backend.tenant(world.b.id).storage);
      scheduler = startWorker();
    });
    afterAll(async () => { await scheduler?.stop(); });

    const submit = (body: unknown, token = world.b.key.token, headers: Record<string, string> = {}) => world.call('POST', '/v1/batches', token, body, headers);
    const view = (id: string, token = world.b.key.token) => world.call('GET', `/v1/batches/${id}`, token);
    /** 轮询到批次结束。 */
    const finished = async (id: string, token = world.b.key.token, timeoutMs = 60_000,
      read: (id: string, token: string) => Promise<{ status: number; body: any; raw: string }> = view) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const reply = await read(id, token);
        expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
        if (reply.body.status === 'finished') return reply.body;
        if (Date.now() > deadline) throw new Error(`批次 ${id} 没有在 ${timeoutMs} ms 内结束：${reply.raw.slice(0, 500)}`);
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
    const stored = (id: string) => backend.tenant(world.b.id).storage.openBatch(id);

    it('提交即返回批次，按项异步交付；逐项结果、批次清单与出图记录和引擎在本进程交付的逐字节相同，记录能重放', async () => {
      const reply = await submit(greetingBatch());
      expect(reply.status, reply.raw.slice(0, 500)).toBe(202);
      expect(reply.body).toMatchObject({ template: '问候牌', mode: 'final', build, cancelRequested: false, progress: { total: 3 } });
      expect(reply.body.items.map((item: { id: string }) => item.id)).toEqual(['saved', 'inline', 'missing']);
      const done = await finished(reply.body.id);
      expect(done.summary).toEqual({ total: 3, delivered: 2, previewed: 0, failed: 1, notRun: 0, severe: done.summary.severe, hints: done.summary.hints });
      expect(done.progress).toEqual({ completed: 3, total: 3 });
      expect(done.finishedAt).toEqual(expect.any(String));

      const local = await engineBatch(backend.tenant(world.b.id).storage, { ...greetingBatch(), mode: 'final' });
      // 逐项结果与单次渲染一致（票据 02）：失败项的问题清单与引擎交付的相同。
      expect(done.items.map((item: { status: string }) => item.status)).toEqual(['delivered', 'delivered', 'failed']);
      expect(done.items[2].problems).toEqual(local.result.items[2]!.problems);
      expect(done.items[2].problems.map((p: { code: string }) => p.code)).toContain('input.datasetNotFound');
      expect(done.items[0]).toMatchObject({ files: { image: 'image.png', problems: 'problems.json', layout: 'layout.json', record: 'record.json' } });
      // 全部项结束后的批次清单与本地 batch.json 语义相同（M153），字节也相同。
      const batch = stored(done.id);
      expect(Buffer.from((await batch.source.manifest())!).toString()).toBe(Buffer.from((await local.memory.batch.manifest())!).toString());
      for (const index of [1, 2]) {
        for (const file of ['record.json', 'input.json', 'image.png', 'problems.json', 'layout.json']) {
          expect(Buffer.from(await batch.record(index).read(file)).equals(Buffer.from(await local.memory.record(index).read(file))), `${index} ${file}`).toBe(true);
        }
        const replayed = await replayRecord(batch.record(index));
        expect(replayed.replayed?.manifest.matched, JSON.stringify(replayed.problems)).toBe(true);
      }
      const read = await readBatchFrom(batch.source);
      expect(read.batch).toMatchObject({ state: 'finished', manifest: { summary: { delivered: 2, failed: 1 } } });
    });

    it('单张正式图也是一项的批次；不写 mode 就是正式交付，草稿不走批量交付', async () => {
      const single = await submit(greetingBatch([GREETING_ITEMS[0]!]), world.b.operator.token);
      expect(single.status).toBe(202);
      expect((await finished(single.body.id, world.b.operator.token)).summary).toMatchObject({ total: 1, delivered: 1 });
      expect(await submit({ ...greetingBatch(), mode: 'draft' })).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', location: { source: 'request.mode' } }] } });
    });

    it('外层非法整批拒绝，不建批次：问题清单与本地交付相同', async () => {
      expect(await submit({ template: '问候牌', items: [] })).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
      const missing = { ...greetingBatch(), template: '没有这个模板' };
      const rejected = await submit(missing);
      expect(rejected.status).toBe(400);
      const storage = backend.tenant(world.b.id).storage;
      const local = await freezeBatch({ workspace: await readWorkspaceDocuments(storage.documents), resources: (await storage.resources.open()).store!, request: { ...missing, mode: 'final' } });
      expect(rejected.body.problems).toEqual(local.problems);
      expect(rejected.body.problems.map((p: { code: string }) => p.code)).toEqual(['input.templateNotFound', 'render.expansionBlocked']);
      const many = Array.from({ length: 1001 }, (_, i) => ({ ...GREETING_ITEMS[0], id: `item-${i}` }));
      expect((await submit(greetingBatch(many))).body.problems[0].message).toContain('1000');
      expect(await submit(greetingBatch([GREETING_ITEMS[0]!, GREETING_ITEMS[0]!]))).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', message: expect.stringContaining('重复') }] } });
      expect(await submit([])).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', location: { source: 'request.body' } }] } });
    });

    it('入队前的限制：请求超出字节上限整批拒绝；单项超出像素、展开规模或数据集字节数只让这一项失败，问题码与预览相同，不渲染', async () => {
      const limited = await createWorld(backend, { api: { limits: { maxBatchRequestBytes: 2048, maxDatasetBytes: 100, maxPixels: 1_000_000, maxElements: 12, maxLoopItems: 5 } } });
      const tenant = limited.b;
      await seedGreeting(backend.tenant(tenant.id).storage, { withFont: true });
      await seedStress(backend.tenant(tenant.id).storage);
      const call = (body: unknown) => limited.call('POST', '/v1/batches', tenant.key.token, body);
      expect(await call(greetingBatch([{ ...GREETING_ITEMS[1], parameters: { padding: 'x'.repeat(3000) } }])))
        .toMatchObject({ status: 413, body: { problems: [{ code: 'limit.requestTooLarge' }] } });
      const reply = await call(greetingBatch([
        { id: 'ok', dataset: inline('你好'), output: OUTPUT },
        { id: 'pixels', dataset: inline('你好'), output: { ...OUTPUT, dpi: 600 } },
        { id: 'dataset', dataset: { id: 'ds-greeting' }, output: OUTPUT },
      ]));
      expect(reply.status, reply.raw.slice(0, 300)).toBe(202);
      const stress = await call({ template: '压力牌', items: [stressItem('loop', 6)] });
      expect(stress.status, stress.raw.slice(0, 300)).toBe(202);
      const done = async (id: string) => {
        for (;;) {
          const state = await limited.call('GET', `/v1/batches/${id}`, tenant.key.token);
          if (state.body.status === 'finished') return state.body;
          await sleep(20);
        }
      };
      const items = (await done(reply.body.id)).items;
      expect(items.map((item: { status: string }) => item.status)).toEqual(['delivered', 'failed', 'failed']);
      expect(items[1].problems).toEqual([expect.objectContaining({ code: 'limit.pixelsExceeded', location: { kind: 'input', source: 'request.items.1.output' } })]);
      expect(items[2].problems).toEqual([expect.objectContaining({ code: 'limit.datasetTooLarge', location: { kind: 'input', source: 'request.items.2.dataset' } })]);
      const loop = (await done(stress.body.id)).items[0];
      expect(loop.problems.map((p: { code: string; message: string }) => `${p.code} ${p.message}`)).toEqual([
        expect.stringMatching(/^limit\.expansionExceeded .*循环项数为 6.*上限 5/), expect.stringMatching(/^limit\.expansionExceeded .*元素数为 14.*上限 12/)]);
      await limited.app.close();
    });

    it('幂等键：重试返回同一批次，不重复交付；同一个键配不同的请求答 409；键只在本租户内有效', async () => {
      const key = { 'idempotency-key': `重试-${Math.random()}` };
      const first = await submit(greetingBatch(), world.b.key.token, key);
      expect(first.status).toBe(202);
      expect(first.body.idempotencyKey).toBe(key['idempotency-key']);
      const again = await submit(greetingBatch(), world.b.operator.token, key);
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.id);
      const done = await finished(first.body.id);
      expect(done.summary).toMatchObject({ total: 3, delivered: 2 });
      // 结束后重试仍是同一批次，逐项结果不变。
      expect((await submit(greetingBatch(), world.b.key.token, key)).body).toEqual(done);
      expect(await submit(greetingBatch([GREETING_ITEMS[0]!]), world.b.key.token, key))
        .toMatchObject({ status: 409, body: { problems: [{ code: 'batch.idempotencyConflict' }] } });
      const other = await submit({ ...greetingBatch(), template: '问候牌' }, world.a.key.token, key);
      expect(other.status).toBe(202);
      expect(other.body.id).not.toBe(first.body.id);
      expect(await submit(greetingBatch(), world.b.key.token, { 'idempotency-key': '' })).toMatchObject({ status: 400 });
    });

    it('审计：提交与取消批次都记审计；API 密钥提交的记密钥名，不记密钥', async () => {
      const reply = await submit(greetingBatch([GREETING_ITEMS[0]!]));
      await finished(reply.body.id);
      await world.call('POST', `/v1/batches/${reply.body.id}/cancel`, world.b.operator.token);
      const events = (await world.call('GET', '/v1/audit-events?limit=500', world.b.admin.token)).body.events as { action: string; object: { id: string }; actor: { kind: string } }[];
      expect(events.find((event) => event.action === 'batch.create' && event.object.id === reply.body.id)).toMatchObject({ actor: { kind: 'apiKey' } });
      expect(events.find((event) => event.action === 'batch.cancel' && event.object.id === reply.body.id)).toMatchObject({ actor: { kind: 'member' } });
    });

    it('取消：还没开始的项标为未执行；正在渲染的一项做完（进程内打断不了）；批次清单写明已取消；结束后再取消不改变什么', async () => {
      await scheduler!.stop();
      const queued = await submit(greetingBatch());
      const cancelled = await world.call('POST', `/v1/batches/${queued.body.id}/cancel`, world.b.operator.token);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ status: 'finished', cancelRequested: true, summary: { total: 3, notRun: 3 } });
      expect(cancelled.body.problems).toEqual([expect.objectContaining({ code: 'delivery.cancelled' })]);
      expect(cancelled.body.items[0].problems).toEqual([expect.objectContaining({ code: 'delivery.notRun' })]);
      const manifest = JSON.parse(Buffer.from((await stored(queued.body.id).source.manifest())!).toString());
      expect(manifest).toMatchObject({ summary: { notRun: 3 }, problems: [{ code: 'delivery.cancelled' }] });

      // 第一项渲染中被取消：做完它，其余两项未执行。
      let release!: () => void, started!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const running = new Promise<void>((resolve) => { started = resolve; });
      const inner = inProcessRunner(backend);
      const gated: Runner = { stats: inner.stats, close: inner.close, async run(task, signal) { started(); await gate; return inner.run(task, signal); } };
      scheduler = startWorker(gated);
      const batch = await submit(greetingBatch());
      await running;
      const cancel = await world.call('POST', `/v1/batches/${batch.body.id}/cancel`, world.b.key.token);
      expect(cancel.body).toMatchObject({ status: 'running', cancelRequested: true });
      expect(cancel.body.items.map((item: { status: string }) => item.status)).toEqual(['running', 'notRun', 'notRun']);
      release();
      const done = await finished(batch.body.id);
      expect(done.summary).toMatchObject({ delivered: 1, notRun: 2 });
      expect(done.problems).toEqual([expect.objectContaining({ code: 'delivery.cancelled' })]);
      const again = await world.call('POST', `/v1/batches/${batch.body.id}/cancel`, world.b.key.token);
      expect(again.body).toEqual(done);
      const untouched = await submit(greetingBatch([GREETING_ITEMS[0]!]));
      const later = await finished(untouched.body.id);
      expect((await world.call('POST', `/v1/batches/${untouched.body.id}/cancel`, world.b.key.token)).body).toEqual(later);
      expect(later.cancelRequested).toBe(false);
      await scheduler.stop();
      scheduler = startWorker();
    });

    if (options.ownsQueue) {
      it('一个批次只由接受它的那个构建的 worker 处理；别的构建的 worker 照样做预览', async () => {
        await scheduler!.stop();
        const other = startWorker(undefined, { build: 'sha256:other' });
        const reply = await submit(greetingBatch([GREETING_ITEMS[0]!]));
        await sleep(150);
        expect((await view(reply.body.id)).body.items[0].status).toBe('queued');
        const preview = await world.call('POST', '/v1/previews', world.b.operator.token, { template: '问候牌', dataset: { id: 'ds-greeting' }, output: OUTPUT });
        expect(preview.status).toBe(200);
        expect(other.stats.tasks).toBe(1);
        await other.stop();
        scheduler = startWorker();
        expect((await finished(reply.body.id)).summary.delivered).toBe(1);
      });

      it('停止时 worker 做完本构建已接受的项再退出，期间不再领预览', async () => {
        await scheduler!.stop();
        let release!: () => void, started!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const running = new Promise<void>((resolve) => { started = resolve; });
        const inner = inProcessRunner(backend);
        const gated: Runner = { stats: inner.stats, close: inner.close, async run(task, signal) { started(); await gate; return inner.run(task, signal); } };
        const draining = startWorker(gated);
        const reply = await submit(greetingBatch());
        await running;
        const drained = draining.drain();
        const limited = await createWorld(backend, { api: { limits: { previewWaitMs: 1500 } } });
        await seedGreeting(backend.tenant(limited.b.id).storage, { withFont: true });
        const preview = limited.call('POST', '/v1/previews', limited.b.operator.token, { template: '问候牌', dataset: { id: 'ds-greeting' }, output: OUTPUT });
        await sleep(100);
        release();
        await drained;
        expect((await view(reply.body.id)).body.summary).toMatchObject({ delivered: 2, failed: 1 });
        expect((await preview).status).toBe(503);
        expect(draining.stats.tasks).toBe(3);
        await limited.app.close();
        scheduler = startWorker();
      });
    }

    it('批次项的租约：worker 中途退出时同构建的 worker 过了租约重领；已登记的项沿用，记录只提交一次；过期的写回不生效；领了 3 次仍没做完记失败', async () => {
      await scheduler!.stop();
      // 第一个 worker 交付并登记了第一项，却在写回结果前"退出"：一直不交回，等放行才交回（那时已过期）。
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
      const dead = startWorker(dying, { leaseMs: 200 });
      const reply = await submit(greetingBatch());
      await until(async () => first !== undefined && (await stored(reply.body.id).source.items()).includes(1), '第一项已登记');
      scheduler = startWorker(undefined, { leaseMs: 200 });
      const done = await finished(reply.body.id);
      expect(done.summary).toMatchObject({ delivered: 2, failed: 1 });
      const manifest = Buffer.from((await stored(reply.body.id).source.manifest())!);
      // 过期的 worker 这时才交回：不改结果，也不重发布批次清单。
      release();
      await dead.stop();
      expect((await view(reply.body.id)).body).toEqual(done);
      expect(Buffer.from((await stored(reply.body.id).source.manifest())!).equals(manifest)).toBe(true);
      expect(await stored(reply.body.id).source.items()).toEqual([1, 2, 3]);

      // 第一次领取没登记，拖到第二次领取正在做时才交回一个失败的结果：写回以领取次数作凭据，以第二次的为准。
      await scheduler.stop();
      let releaseLate!: () => void, releaseSecond!: () => void, secondStarted!: () => void;
      const late = new Promise<void>((resolve) => { releaseLate = resolve; });
      const second = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const secondRunning = new Promise<void>((resolve) => { secondStarted = resolve; });
      const stale: Runner = { stats: emptyStats(), close: async () => undefined, async run(task) {
        await late;
        const problem = { level: 'severe' as const, code: 'delivery.writeFailed', location: { kind: 'input' as const, source: 'outputRecord' }, message: '输出未交付' };
        return { index: (task as BatchItemTask).index, id: (task as BatchItemTask).itemId, status: 'failed', severe: 1, hints: 0, reason: problem.message, problems: [problem] };
      } };
      const slow: Runner = { stats: emptyStats(), close: async () => undefined, async run(task, signal) { secondStarted(); await second; return inner.run(task, signal); } };
      const lateWorker = startWorker(stale, { leaseMs: 100 });
      const fenced = await submit(greetingBatch([GREETING_ITEMS[0]!]));
      await sleep(150);
      scheduler = startWorker(slow);
      await secondRunning;
      releaseLate();
      await lateWorker.stop();
      expect((await view(fenced.body.id)).body.items[0].status).toBe('running');
      releaseSecond();
      expect((await finished(fenced.body.id)).items[0].status).toBe('delivered');

      // 每次领取都没做完：第 4 次领到时直接记失败。
      await scheduler.stop();
      const hang: Runner = { stats: emptyStats(), close: async () => undefined, run: () => new Promise(() => undefined) };
      const hung = [startWorker(hang, { leaseMs: 100 })];
      const stuck = await submit(greetingBatch([GREETING_ITEMS[0]!]));
      for (let i = 2; i <= 3; i++) {
        await sleep(150);
        hung.push(startWorker(hang, { leaseMs: 100 }));
      }
      await sleep(150);
      scheduler = startWorker(undefined, { leaseMs: 100 });
      const failed = await finished(stuck.body.id);
      expect(failed.items[0]).toMatchObject({ status: 'failed', files: { problems: 'problems.json' }, problems: [{ code: 'worker.crashed', message: expect.stringContaining('3 次') }] });
      const written = JSON.parse(Buffer.from(await stored(stuck.body.id).record(1).read('problems.json')).toString());
      expect(written).toEqual(failed.items[0].problems);
    });

    if (options.ownsQueue) {
      it('调度顺序：预览优先；批次项按项序号轮转，后提交的小批次不被先提交的大批次堵住', async () => {
        await scheduler!.stop();
        const order: string[] = [];
        const inner = inProcessRunner(backend);
        const recording: Runner = { stats: inner.stats, close: inner.close, async run(task, signal) {
          order.push(task.kind === 'preview' ? 'preview' : `${task.batchId === big ? 'A' : 'B'}${task.index}`);
          return inner.run(task, signal);
        } };
        const big = (await submit(greetingBatch([GREETING_ITEMS[0]!, { ...GREETING_ITEMS[1]!, id: 'two' }, { ...GREETING_ITEMS[1]!, id: 'three' }]))).body.id as string;
        const small = (await submit(greetingBatch([GREETING_ITEMS[0]!]))).body.id as string;
        const preview = world.call('POST', '/v1/previews', world.b.operator.token, { template: '问候牌', dataset: { id: 'ds-greeting' }, output: OUTPUT });
        await sleep(50);
        scheduler = startWorker(recording);
        expect((await preview).status).toBe(200);
        await finished(big);
        await finished(small);
        expect(order).toEqual(['preview', 'A1', 'B1', 'A2', 'A3']);
      });
    }

    if (options.realWorker) {
      const { apiUrl, workerUrl, listObjects } = options.realWorker;
      const stats = async () => ((await (await fetch(`${workerUrl}/healthz`)).json()) as { renderer: { tasks: number; timeouts: number; memoryKills: number; cancels: number } }).renderer;
      /** 经 Compose 里真实的接口进程：批次带镜像里的构建标识，由真实的 worker 交付。 */
      const remote = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
        const response = await fetch(`${apiUrl}${path}`, { method, headers: { authorization: `Bearer ${world.b.key.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const raw = await response.text();
        return { status: response.status, body: raw ? JSON.parse(raw) : undefined, raw };
      };
      const remoteView = (id: string) => remote('GET', `/v1/batches/${id}`);
      const remoteSubmit = (body: unknown) => remote('POST', '/v1/batches', body);
      const remoteFinished = (id: string) => finished(id, world.b.key.token, 60_000, remoteView);

      it('批次中超出内存上限的一项被结束并标为失败，同批其他项照常交付；子进程换新后照常', async () => {
        const before = await stats();
        const reply = await remoteSubmit(greetingBatch([GREETING_ITEMS[0]!, HUGE, { ...GREETING_ITEMS[1]!, id: 'after' }]));
        expect(reply.status, reply.raw.slice(0, 300)).toBe(202);
        const done = await remoteFinished(reply.body.id);
        expect(done.items.map((item: { status: string }) => item.status)).toEqual(['delivered', 'failed', 'delivered']);
        expect(done.items[1]).toMatchObject({ files: { problems: 'problems.json' }, problems: [{ code: 'worker.memoryExceeded' }] });
        expect((await stats()).memoryKills).toBe(before.memoryKills + 1);
      });

      it('取消时正在渲染的一项由调度进程结束，标为未执行', async () => {
        const before = await stats();
        const reply = await remoteSubmit({ template: '压力细牌', items: [SLOW, stressItem('next', 3, { template: '压力细牌' })] });
        await until(async () => (await remoteView(reply.body.id)).body.items[0].status === 'running', '第一项开始渲染');
        const cancel = await remote('POST', `/v1/batches/${reply.body.id}/cancel`);
        expect(cancel.status).toBe(200);
        const done = await remoteFinished(reply.body.id);
        expect(done.items.map((item: { status: string }) => item.status)).toEqual(['notRun', 'notRun']);
        expect(done.items[0].problems).toEqual([expect.objectContaining({ code: 'delivery.notRun', message: expect.stringContaining('结束') })]);
        const after = await stats();
        expect(after.cancels).toBe(before.cancels + 1);
        expect(after.timeouts).toBe(before.timeouts);
      });

      it('同一租户内相同字节只存一份，跨批次也是：同样的批次再交一次，对象存储里不多一个对象', async () => {
        const items = [GREETING_ITEMS[0]!, GREETING_ITEMS[1]!];
        await remoteFinished((await remoteSubmit(greetingBatch(items))).body.id);
        const before = await listObjects(`tenants/${world.b.id}/`);
        const again = await remoteFinished((await remoteSubmit(greetingBatch(items))).body.id);
        expect(again.summary.delivered).toBe(2);
        expect(await listObjects(`tenants/${world.b.id}/`)).toEqual(before);
      });
    }

    it('任务行的清理：过了保留期的预览与重放任务行被删；批次项的行不删，批次的逐项状态与出图记录照旧可查', async () => {
      const preview = await world.call('POST', '/v1/previews', world.b.operator.token, { template: '问候牌', dataset: { id: 'ds-greeting' }, output: OUTPUT });
      expect(preview.status).toBe(200);
      const done = await finished((await submit(greetingBatch([GREETING_ITEMS[0]!]))).body.id);
      const replayed = await world.call('POST', `/v1/batches/${done.id}/items/1/replay`, world.b.key.token);
      expect(replayed.status, replayed.raw.slice(0, 300)).toBe(200);
      const records = async () => (await world.call('GET', `/v1/records?batchId=${done.id}`, world.b.key.token)).body;
      const [state, listed] = [(await view(done.id)).body, await records()];
      expect(listed.records).toHaveLength(1);
      // 保留期 0：此刻之前入队的预览与重放都删掉。
      expect(await purgeTasks(backend, new Date(Date.now() + 1), 0)).toBeGreaterThanOrEqual(2);
      expect(await purgeTasks(backend, new Date(Date.now() + 1), 0)).toBe(0);
      expect((await view(done.id)).body).toEqual(state);
      expect(await records()).toEqual(listed);
      expect((await world.call('POST', `/v1/batches/${done.id}/items/1/replay`, world.b.key.token)).status).toBe(200);
    });

    if (options.ownsQueue) {
      it('队列积压与渲染用时：worker 的就绪检查给出各种类排队与渲染中的任务数、排队最久的等了多久，做完后归零；存活检查给渲染用时；接口进程公开的就绪检查不带积压', async () => {
        const idle = { queued: { preview: 0, batchItem: 0, replay: 0 }, running: { preview: 0, batchItem: 0, replay: 0 }, oldestQueuedMs: 0 };
        const runner = inProcessRunner(backend);
        const health = createWorkerHealthServer({ backend, build, logger: silentLogger, stats: runner.stats });
        await new Promise<void>((resolve) => health.listen(0, '127.0.0.1', resolve));
        const url = `http://127.0.0.1:${(health.address() as AddressInfo).port}`;
        try {
          const backlog = async () => ((await (await fetch(`${url}/readyz`)).json()) as { queue: typeof idle }).queue;
          expect(await backlog()).toEqual(idle);
          expect((await world.app.inject({ method: 'GET', url: '/readyz' })).json()).not.toHaveProperty('queue');
          await scheduler!.stop();
          // 批次按接口进程的时钟入队：拨到 5 秒前，排队最久的一项至少等了 5 秒。
          world.clock.value = new Date(Date.now() - 5_000);
          const reply = await submit(greetingBatch());
          const waiting = await backlog();
          expect(waiting).toEqual({ ...idle, queued: { preview: 0, batchItem: 3, replay: 0 }, oldestQueuedMs: expect.any(Number) });
          expect(waiting.oldestQueuedMs).toBeGreaterThanOrEqual(5_000);
          expect(waiting.oldestQueuedMs).toBeLessThan(60_000);
          scheduler = startWorker(runner);
          await finished(reply.body.id);
          expect(await backlog()).toEqual(idle);
          const { renderer } = (await (await fetch(`${url}/healthz`)).json()) as { renderer: { tasks: number; renderMs: number; maxRenderMs: number } };
          expect(renderer.tasks).toBe(3);
          expect(renderer.maxRenderMs).toBeGreaterThan(0);
          expect(renderer.renderMs).toBeGreaterThanOrEqual(renderer.maxRenderMs);
        } finally { await new Promise<void>((resolve) => health.close(() => resolve())); }
      });
    }

    it('批次请求里的令牌与密码不进日志', () => {
      const text = world.logs.join('\n');
      for (const secret of world.secrets) expect(text).not.toContain(secret);
    });
  });
}
