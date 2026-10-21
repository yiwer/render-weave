/**
 * webhook（票据 11，M246）：只经 HTTP 驱动，用测试里自建的接收端核对投递、签名与重试。
 * - 客户管理员与 API 密钥注册、停用 webhook，签名密钥只在注册时出现一次；URL 在注册时检查；
 * - 批次结束（完成、部分失败、全部失败、取消）时每个启用的 webhook 收到一次事件，正文是批次摘要；
 * - 签名按文档的做法独立核对：HMAC-SHA256(签名密钥, "<时间戳>.<正文>")，时间戳是发送时刻；
 * - 失败按指数退避重试，试满次数记失败；停用后不再投递；投递记录可查。
 * 同一组用例跑两种后端：内存后端在测试进程里起投递任务；Docker 后端由 Compose 里真实的接口进程投递（与测试进程用同一个服务密钥）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { rendererBuildId } from '../src/engine.js';
import { createLogger } from '../src/log.js';
import { DEFAULT_WEBHOOK_CONFIG, startWebhookDispatcher, type WebhookConfig, type WebhookDispatcher } from '../src/webhooks.js';
import { inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { seedGreeting } from './seed.js';

export interface WebhookSuiteOptions {
  /** 投递的数值：内存后端给测试进程里的投递任务，Docker 后端是 Compose 里接口进程的配置。 */
  readonly config: WebhookConfig;
  /** 测试进程里起投递任务（内存后端）；否则由别的进程投递。 */
  readonly inProcessDispatcher: boolean;
  /** 接收端监听的地址，与投递任务看得到的地址。 */
  readonly receiverHost: { readonly bind: string; readonly advertise: string };
  /** 读库里存的签名密钥（Docker 后端核对只存密文）。 */
  readonly storedSecrets?: () => Promise<string[]>;
}

/** 接收端对第 n 个请求（从 1 起）的回答：状态码、不回答、断开、重定向，或等测试放行后再答。 */
type Answer = number | 'hang' | 'close' | { readonly redirect: string } | { readonly hold: Promise<number> };
interface Received { readonly headers: IncomingHttpHeaders; readonly body: string; readonly at: number }

async function receiver(host: WebhookSuiteOptions['receiverHost'], answer: (n: number) => Answer = () => 200) {
  const received: Received[] = [];
  const server = createServer((request, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() });
      const reply = answer(received.length);
      if (reply === 'hang') return;
      if (reply === 'close') return void request.socket.destroy();
      if (typeof reply === 'number') return void response.writeHead(reply).end('ok');
      if ('redirect' in reply) return void response.writeHead(302, { location: reply.redirect }).end();
      void reply.hold.then((status) => response.writeHead(status).end('ok'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, host.bind, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host.advertise}:${port}/hooks`, received,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
type Receiver = Awaited<ReturnType<typeof receiver>>;

/** 按文档独立核对签名：t=<秒>,v1=<十六进制>，v1 = HMAC-SHA256(签名密钥, "<t>.<正文>")。 */
function verify(secret: string, header: unknown, body: string): { valid: boolean; timestamp: number } {
  const match = typeof header === 'string' ? /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header) : null;
  if (!match) return { valid: false, timestamp: 0 };
  const expected = createHmac('sha256', secret).update(`${match[1]}.${body}`).digest();
  return { valid: timingSafeEqual(expected, Buffer.from(match[2]!, 'hex')), timestamp: Number(match[1]) };
}

const OUTPUT = { width: 160, height: 40, dpi: 120, format: 'png' };
const inline = (message: string) => ({ inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message } } });
const deliverable = (tag: string, n: number) => ({ template: '问候牌', items: Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i + 1}`, dataset: inline(`${tag} ${i + 1}`), output: OUTPUT })) });
const missing = (tag: string, n: number) => ({ template: '问候牌', items: Array.from({ length: n }, (_, i) => ({ id: `${tag}-${i + 1}`, dataset: { id: 'no-such-dataset' }, output: OUTPUT })) });
/** 两项交付、一项失败。 */
const mixed = (tag: string) => ({ template: '问候牌', items: [...deliverable(tag, 2).items, { id: `${tag}-missing`, dataset: { id: 'no-such-dataset' }, output: OUTPUT }] });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function describeWebhooks(name: string, makeBackend: () => Promise<ServiceBackend>, options: WebhookSuiteOptions): void {
  const { config } = options;
  describe(`webhook（${name}）`, () => {
    let world: World, backend: ServiceBackend, scheduler: Scheduler | undefined, dispatcher: WebhookDispatcher | undefined;
    const receivers: Receiver[] = [];
    /** 投递任务的日志与接口进程的写到同一处，最后一并核对不含密钥。 */
    const startDispatcher = (overrides: Partial<WebhookConfig> = {}) =>
      startWebhookDispatcher({ backend, logger: createLogger('api', 'sha256:test', 'info', world.sink), secretKey: world.secretKey, config: { ...config, ...overrides } });
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
      await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
      const build = await rendererBuildId();
      scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: `webhooks-${Math.random()}`, build, leaseMs: 60_000 });
      if (options.inProcessDispatcher) dispatcher = startDispatcher();
    });
    afterAll(async () => {
      await dispatcher?.stop();
      await scheduler?.stop();
      for (const open of receivers) await open.close();
    });

    const listen = async (answer?: (n: number) => Answer) => {
      const created = await receiver(options.receiverHost, answer);
      receivers.push(created);
      return created;
    };
    const register = async (url: string, token = world.b.admin.token, extra: Record<string, unknown> = {}) => {
      const reply = await world.call('POST', '/v1/webhooks', token, { url, ...extra });
      expect(reply.status, reply.raw.slice(0, 300)).toBe(201);
      world.secrets.push(reply.body.secret);
      return { id: reply.body.webhook.id as string, secret: reply.body.secret as string, webhook: reply.body.webhook };
    };
    const patch = async (id: string, change: object, token = world.b.admin.token) => {
      const reply = await world.call('PATCH', `/v1/webhooks/${id}`, token, change);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const until = async (check: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`等不到：${what}`);
        await sleep(10);
      }
    };
    const finishedBatch = async (body: unknown) => {
      const reply = await world.call('POST', '/v1/batches', world.b.key.token, body);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(202);
      let view: any;
      await until(async () => (view = (await world.call('GET', `/v1/batches/${reply.body.id}`, world.b.key.token)).body).status === 'finished', `批次 ${reply.body.id} 结束`);
      return view;
    };
    const deliveries = async (id: string, query = '') => {
      const reply = await world.call('GET', `/v1/webhooks/${id}/deliveries${query}`, world.b.admin.token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body.deliveries as any[];
    };
    /** 等到投递任务又看过几轮：用来断言"之后没有再投"。 */
    const quiet = () => sleep(Math.max(config.pollMs * 5, 300));

    it('客户管理员与 API 密钥注册、查看、停用与重新启用；签名密钥只在注册时出现一次；操作记审计', async () => {
      const { call, b } = world;
      const byAdmin = await register('http://example.com/a/../hooks?x=1', b.admin.token, { description: '订单系统' });
      expect(byAdmin.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
      expect(byAdmin.webhook).toEqual({ id: byAdmin.id, url: 'http://example.com/hooks?x=1', description: '订单系统', events: ['batch.finished'],
        secretPrefix: byAdmin.secret.slice(0, 12), active: true, createdAt: expect.any(String) });
      const byKey = await register('https://example.com/key', b.key.token, { events: ['batch.finished'] });
      expect(byKey.secret).not.toBe(byAdmin.secret);

      const listed = await call('GET', '/v1/webhooks', b.key.token);
      expect(listed.body.webhooks.map((hook: { id: string }) => hook.id)).toEqual(expect.arrayContaining([byAdmin.id, byKey.id]));
      const shown = await call('GET', `/v1/webhooks/${byAdmin.id}`, b.admin.token);
      expect(shown.body).toEqual(byAdmin.webhook);
      for (const reply of [listed, shown]) for (const secret of [byAdmin.secret, byKey.secret]) expect(reply.raw).not.toContain(secret);

      const disabled = await patch(byAdmin.id, { active: false }, b.key.token);
      expect(disabled).toMatchObject({ active: false, disabledAt: expect.any(String), description: '订单系统' });
      const enabled = await patch(byAdmin.id, { active: true, description: '订单系统（新）' });
      expect(enabled).toEqual({ ...byAdmin.webhook, description: '订单系统（新）' });
      await patch(byAdmin.id, { active: false });
      await patch(byKey.id, { active: false });

      for (const [body, code] of [
        [{}, 'request.invalid'], [{ url: 'ftp://example.com/x' }, 'webhook.urlNotAllowed'], [{ url: 'not a url' }, 'webhook.urlNotAllowed'],
        [{ url: 'https://user:pw@example.com/x' }, 'webhook.urlNotAllowed'], [{ url: 'https://example.com/x#part' }, 'webhook.urlNotAllowed'],
        [{ url: 'https://example.com/x', events: ['batch.started'] }, 'request.invalid'], [{ url: 'https://example.com/x', events: [] }, 'request.invalid'],
        [{ url: 'https://example.com/x', secret: 'mine' }, 'request.invalid'],
      ] as const) {
        expect(await call('POST', '/v1/webhooks', b.admin.token, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { problems: [{ code, level: 'severe' }] } });
      }
      for (const change of [{}, { url: 'https://example.com/other' }, { active: 'no' }]) {
        expect((await call('PATCH', `/v1/webhooks/${byKey.id}`, b.admin.token, change)).status, JSON.stringify(change)).toBe(400);
      }
      expect((await call('GET', '/v1/webhooks/not-a-uuid', b.admin.token)).status).toBe(404);

      const audit = await call('GET', '/v1/audit-events?limit=50', b.admin.token);
      const actions = audit.body.events.filter((event: { object: { type: string } }) => event.object.type === 'webhook')
        .map((event: { action: string; object: { id: string }; actor: { kind: string } }) => `${event.action} ${event.object.id} ${event.actor.kind}`);
      expect(actions).toEqual(expect.arrayContaining([`webhook.create ${byAdmin.id} member`, `webhook.create ${byKey.id} apiKey`, `webhook.update ${byAdmin.id} apiKey`]));
      for (const secret of [byAdmin.secret, byKey.secret]) expect(audit.raw).not.toContain(secret);
      if (options.storedSecrets) {
        const stored = await options.storedSecrets();
        expect(stored.length).toBeGreaterThan(0);
        for (const sealed of stored) {
          expect(sealed).toMatch(/^v1\./);
          for (const secret of [byAdmin.secret, byKey.secret]) expect(sealed).not.toContain(secret.slice(6));
        }
      }
    });

    it('每个租户最多同时启用 10 个；停用一个才能再注册或重新启用', async () => {
      const { call, a } = world;
      const ids: string[] = [];
      for (let i = (await call('GET', '/v1/webhooks', a.admin.token)).body.webhooks.filter((hook: { active: boolean }) => hook.active).length; i < 10; i++) {
        ids.push((await register(`https://example.com/limit/${i}`, a.admin.token)).id);
      }
      const over = await call('POST', '/v1/webhooks', a.key.token, { url: 'https://example.com/limit/over' });
      expect(over).toMatchObject({ status: 409, body: { problems: [{ code: 'webhook.limitReached' }] } });
      await patch(ids[0]!, { active: false }, a.admin.token);
      const again = await register('https://example.com/limit/again', a.admin.token);
      expect(await call('PATCH', `/v1/webhooks/${ids[0]}`, a.admin.token, { active: true })).toMatchObject({ status: 409, body: { problems: [{ code: 'webhook.limitReached' }] } });
      // 收尾：都停用，免得别的用例在租户 A 结束的批次投到 example.com。
      for (const id of [...ids.slice(1), again.id]) await patch(id, { active: false }, a.admin.token);
    });

    it('注册时只收 https 与公网地址（生产配置）', async () => {
      const strict = await createWorld(backend, { api: { allowPrivateWebhooks: false, secretKey: world.secretKey } });
      for (const url of ['http://example.com/hooks', 'https://127.0.0.1/hooks', 'https://127.1.2.3:8443/x', 'https://[::1]/x', 'https://10.0.0.8/x', 'https://172.20.1.1/x',
        'https://192.168.1.10/x', 'https://169.254.169.254/latest/meta-data', 'https://100.64.0.1/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x',
        'https://[::ffff:127.0.0.1]/x', 'https://0.0.0.0/x', 'https://localhost/x', 'https://api.localhost/x']) {
        const reply = await strict.call('POST', '/v1/webhooks', strict.a.admin.token, { url });
        expect(reply, url).toMatchObject({ status: 400, body: { problems: [{ code: 'webhook.urlNotAllowed', location: { source: 'request.body.url' } }] } });
      }
      const ok = await strict.call('POST', '/v1/webhooks', strict.a.admin.token, { url: 'https://8.8.8.8/hooks' });
      expect(ok.status, ok.raw.slice(0, 300)).toBe(201);
      world.secrets.push(ok.body.secret);
      expect((await strict.call('PATCH', `/v1/webhooks/${ok.body.webhook.id}`, strict.a.admin.token, { active: false })).status).toBe(200);
    });

    it('批次结束时每个启用的 webhook 各收到一次事件：正文是批次摘要，签名用各自的密钥、时间戳是发送时刻', async () => {
      const { call, b } = world;
      const first = await listen(), second = await listen(), off = await listen();
      const one = await register(first.url, b.admin.token), two = await register(second.url, b.key.token), stopped = await register(off.url);
      await patch(stopped.id, { active: false });

      const batch = await finishedBatch(mixed('webhook'));
      expect(batch).toMatchObject({ outcome: 'partiallyFailed', summary: { total: 3, delivered: 2, failed: 1, notRun: 0 } });
      await until(() => first.received.length === 1 && second.received.length === 1, '两个接收端各收到一次');
      await quiet();
      expect([first.received.length, second.received.length, off.received.length]).toEqual([1, 1, 0]);

      const [toFirst, toSecond] = [first.received[0]!, second.received[0]!];
      expect(toFirst.body).toBe(toSecond.body);
      const event = JSON.parse(toFirst.body);
      expect(event).toEqual({ id: expect.any(String), type: 'batch.finished', createdAt: expect.any(String), tenantId: b.id, data: { batch: {
        id: batch.id, template: '问候牌', mode: 'final', build: batch.build, outcome: 'partiallyFailed', cancelRequested: false,
        createdAt: batch.createdAt, finishedAt: batch.finishedAt, summary: batch.summary, problems: [],
      } } });
      for (const [received, mine, other] of [[toFirst, one, two], [toSecond, two, one]] as const) {
        expect(received.headers).toMatchObject({ 'content-type': 'application/json', 'renderweave-event-id': event.id, 'renderweave-event-type': 'batch.finished',
          'renderweave-attempt': '1' });
        const signed = verify(mine.secret, received.headers['renderweave-signature'], received.body);
        expect(signed.valid).toBe(true);
        expect(Math.abs(signed.timestamp * 1000 - received.at)).toBeLessThan(5_000);
        expect(verify(other.secret, received.headers['renderweave-signature'], received.body).valid).toBe(false);
        expect(verify(mine.secret, received.headers['renderweave-signature'], received.body.replace('partiallyFailed', 'completed')).valid).toBe(false);
      }
      expect(toFirst.headers['renderweave-delivery-id']).not.toBe(toSecond.headers['renderweave-delivery-id']);

      const records = await deliveries(one.id);
      expect(records).toEqual([{ id: toFirst.headers['renderweave-delivery-id'], webhookId: one.id, eventId: event.id, eventType: 'batch.finished', batchId: batch.id,
        status: 'succeeded', createdAt: expect.any(String), finishedAt: expect.any(String),
        attempts: [{ attempt: 1, at: expect.any(String), durationMs: expect.any(Number), statusCode: 200 }] }]);
      expect(await deliveries(stopped.id)).toEqual([]);
      // 另一租户看不到这些投递记录。
      expect((await call('GET', `/v1/webhooks/${one.id}/deliveries`, world.a.admin.token)).status).toBe(404);
      for (const id of [one.id, two.id]) await patch(id, { active: false });
    });

    it('事件的结果：全部交付、全部失败与取消各一种；投递记录可以翻页', async () => {
      const sink = await listen(), hook = await register(sink.url);
      const completed = await finishedBatch(deliverable('done', 2));
      const failed = await finishedBatch(missing('bad', 2));
      // 取消：worker 停着时提交再取消，各项都没开始，批次当即结束。
      await scheduler!.stop();
      const submitted = await world.call('POST', '/v1/batches', world.b.key.token, deliverable('cancel', 2));
      const cancelled = await world.call('POST', `/v1/batches/${submitted.body.id}/cancel`, world.b.key.token);
      scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: `webhooks-${Math.random()}`, build: await rendererBuildId(), leaseMs: 60_000 });
      expect(cancelled.body).toMatchObject({ status: 'finished', outcome: 'cancelled', summary: { notRun: 2 } });
      expect([completed.outcome, failed.outcome]).toEqual(['completed', 'failed']);

      await until(() => sink.received.length === 3, '三个批次的事件');
      await quiet();
      expect(sink.received).toHaveLength(3);
      const outcomes = new Map(sink.received.map((received) => {
        const batch = JSON.parse(received.body).data.batch;
        return [batch.id, `${batch.outcome} ${batch.summary.delivered}/${batch.summary.total}`];
      }));
      expect(outcomes).toEqual(new Map([[completed.id, 'completed 2/2'], [failed.id, 'failed 0/2'], [submitted.body.id, 'cancelled 0/2']]));

      const page1 = await world.call('GET', `/v1/webhooks/${hook.id}/deliveries?limit=2`, world.b.admin.token);
      const page2 = await world.call('GET', `/v1/webhooks/${hook.id}/deliveries?limit=2&before=${page1.body.next}`, world.b.admin.token);
      expect(page1.body.deliveries).toHaveLength(2);
      expect(page2.body).toEqual({ deliveries: [expect.objectContaining({ status: 'succeeded' })] });
      const ids = [...page1.body.deliveries, ...page2.body.deliveries].map((delivery: { id: string }) => Number(delivery.id));
      expect(ids).toEqual([...ids].sort((x, y) => y - x));
      expect((await world.call('GET', `/v1/webhooks/${hook.id}/deliveries?limit=0`, world.b.admin.token)).status).toBe(400);
      await patch(hook.id, { active: false });
    });

    it('失败按指数退避重试：500、超时、断开之后成功；每次重签、事件 ID 不变；记录各次尝试', async () => {
      const flaky = await listen((n) => ([500, 'hang', 'close'] as const)[n - 1] ?? 204);
      const hook = await register(flaky.url);
      await finishedBatch(deliverable('retry', 1));
      await until(async () => (await deliveries(hook.id))[0]?.status === 'succeeded', '第 4 次投递成功', 30_000);
      const [record] = await deliveries(hook.id);
      expect(record.attempts.map((attempt: any) => attempt.statusCode ?? attempt.error.split('：')[0])).toEqual([500, '超时', '连接失败', 204]);
      expect(record.attempts.map((attempt: any) => attempt.attempt)).toEqual([1, 2, 3, 4]);
      // 第 n 次失败后至少等 retryBase × 2^(n−1) 才再试。
      const starts = record.attempts.map((attempt: any) => Date.parse(attempt.at));
      for (let n = 1; n < starts.length; n++) expect(starts[n]! - starts[n - 1]!, `第 ${n} 次之后`).toBeGreaterThanOrEqual(config.retryBaseMs * 2 ** (n - 1) - 5);
      expect(record.attempts[1].durationMs).toBeGreaterThanOrEqual(config.timeoutMs - 5);

      expect(flaky.received).toHaveLength(4);
      expect(new Set(flaky.received.map((received) => received.body)).size).toBe(1);
      expect(new Set(flaky.received.map((received) => received.headers['renderweave-event-id'])).size).toBe(1);
      expect(flaky.received.map((received) => received.headers['renderweave-attempt'])).toEqual(['1', '2', '3', '4']);
      const timestamps = flaky.received.map((received) => verify(hook.secret, received.headers['renderweave-signature'], received.body));
      expect(timestamps.every((signed) => signed.valid)).toBe(true);
      expect(timestamps.at(-1)!.timestamp).toBeGreaterThan(timestamps[0]!.timestamp);
      await patch(hook.id, { active: false });
    });

    it(`试满 ${config.maxAttempts} 次仍失败就记失败、不再投；重定向不跟随，算作失败`, async () => {
      const target = await listen(), down = await listen(() => 503), moved = await listen(() => ({ redirect: target.url }));
      const failing = await register(down.url), redirecting = await register(moved.url);
      await finishedBatch(deliverable('down', 1));
      await until(async () => (await deliveries(failing.id))[0]?.status === 'failed', '试满次数后记失败', 30_000);
      await quiet();
      expect(down.received).toHaveLength(config.maxAttempts);
      const [record] = await deliveries(failing.id);
      expect(record).toMatchObject({ status: 'failed', finishedAt: expect.any(String) });
      expect(record.nextAttemptAt).toBeUndefined();
      expect(record.attempts.map((attempt: any) => attempt.statusCode)).toEqual(Array(config.maxAttempts).fill(503));

      await until(async () => (await deliveries(redirecting.id))[0]?.attempts.length >= 1, '重定向的第一次尝试');
      await patch(redirecting.id, { active: false });
      // 302 不算收到：这条投递在重试或已试满记失败，不是 succeeded；每次尝试都是 302。
      const redirected = (await deliveries(redirecting.id))[0];
      expect(['pending', 'failed']).toContain(redirected.status);
      expect(redirected.attempts.map((attempt: any) => attempt.statusCode)).toEqual(Array(redirected.attempts.length).fill(302));
      expect(target.received).toHaveLength(0);
      await patch(failing.id, { active: false });
    });

    it('停用后不再投递，排着的重试也停下；重新启用后接着投', async () => {
      let release!: (status: number) => void;
      const held = new Promise<number>((resolve) => { release = resolve; });
      const gate = await listen((n) => (n === 1 ? { hold: held } : 200));
      const hook = await register(gate.url);
      await finishedBatch(deliverable('pause', 1));
      await until(() => gate.received.length === 1, '第一次投递到达');
      await patch(hook.id, { active: false });
      release(500);
      await until(async () => (await deliveries(hook.id))[0]?.attempts.length === 1, '第一次尝试记下');
      await sleep(config.retryBaseMs * 4);
      await quiet();
      expect(gate.received).toHaveLength(1);
      expect((await deliveries(hook.id))[0]).toMatchObject({ status: 'pending', attempts: [{ statusCode: 500 }] });

      await patch(hook.id, { active: true });
      await until(async () => (await deliveries(hook.id))[0]?.status === 'succeeded', '重新启用后投递成功');
      expect(gate.received).toHaveLength(2);
      await patch(hook.id, { active: false });
    });

    if (options.inProcessDispatcher) {
      it('投递时再查解析出的地址：生产配置不连本机与内网，DNS 指向回环的主机名也挡住', async () => {
        await dispatcher!.stop();
        const guarded = startDispatcher({ allowPrivate: false });
        try {
          const local = await listen();
          const literal = await register(local.url);
          const named = await register(local.url.replace('127.0.0.1', 'localhost'));
          await finishedBatch(deliverable('guard', 1));
          await until(async () => (await deliveries(literal.id))[0]?.attempts.length >= 1 && (await deliveries(named.id))[0]?.attempts.length >= 1, '两次尝试都记下');
          expect((await deliveries(literal.id))[0].attempts[0].error).toMatch(/127\.0\.0\.1.*内网、回环或保留地址，不投递/);
          expect((await deliveries(named.id))[0].attempts[0].error).toMatch(/内网、回环或保留地址，不投递/);
          expect(local.received).toHaveLength(0);
          for (const id of [literal.id, named.id]) await patch(id, { active: false });
        } finally {
          await guarded.stop();
          dispatcher = startDispatcher();
        }
      });
    }

    it('签名密钥不进日志；投递失败的日志只有租户、webhook、投递、第几次与原因，没有 URL 与正文', async () => {
      const text = world.logs.join('\n');
      for (const secret of world.secrets) expect(text).not.toContain(secret);
      if (!options.inProcessDispatcher) return;
      const failures = world.logs.map((line) => JSON.parse(line)).filter((entry) => typeof entry.msg === 'string' && entry.msg.startsWith('webhook 投递失败'));
      expect(failures.length).toBeGreaterThan(0);
      for (const entry of failures) {
        expect(entry).toMatchObject({ tenantId: world.b.id, webhookId: expect.any(String), deliveryId: expect.any(String), attempt: expect.any(Number) });
        expect(JSON.stringify(entry)).not.toMatch(/batch\.finished|\/hooks|whsec_|"url"/);
      }
    });
  });
}

/** 测试与 Docker 后端测试共用的数值：退避与超时足够短，用例在几秒内跑完。 */
export const TEST_WEBHOOK_CONFIG: WebhookConfig = { ...DEFAULT_WEBHOOK_CONFIG, pollMs: 20, retryBaseMs: 150, maxAttempts: 4, timeoutMs: 600, allowPrivate: true };
