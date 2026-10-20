/**
 * 模板与草稿预览（票据 06，ADR-0017）：只经 HTTP 驱动，断言响应、问题清单与图片。
 * - 内存后端：进程内 worker，跑在 npm test 里；
 * - PostgreSQL 加 S3：任务进 PostgreSQL 队列，由 Compose 里真实的 worker 进程渲染；单项超时、内存超限与恢复只在这里测。
 */
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { loadWorkspace, render } from '../src/engine.js';
import { emptyStats, inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { greetingPreview, seedGreeting, seedStress, SINGLE_TEXT, stressRequest } from './seed.js';

const RESOURCES = fileURLToPath(new URL('../../fixtures/resources/', import.meta.url));

export interface PreviewSuiteOptions {
  /** 在测试进程里起 worker（内存后端）；否则由 Compose 里的 worker 渲染。 */
  readonly inProcessWorker: boolean;
  /** 测超时、内存超限与恢复：需要真实的 worker 进程与容器内存上限。 */
  readonly isolation?: { readonly workerUrl: string; readonly timeoutMs: number; readonly recycleAfter: number };
}

export function describePreview(name: string, makeBackend: () => Promise<ServiceBackend>, options: PreviewSuiteOptions): void {
  describe(`模板与草稿预览（${name}）`, () => {
    let world: World, scheduler: Scheduler | undefined;
    let backend: ServiceBackend;
    /** 本机直接渲染的结果，与服务的预览逐字节比较。 */
    let local: Awaited<ReturnType<typeof render>>;
    beforeAll(async () => {
      backend = await makeBackend();
      // 压力牌项数多，展开规模放宽到能入队；限额的用例另起一个接口进程。
      world = await createWorld(backend, { api: { limits: { maxElements: 100_000, maxLoopItems: 50_000 } } });
      await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
      await seedStress(backend.tenant(world.b.id).storage);
      if (options.inProcessWorker) scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'in-process' });
      const workspace = await loadWorkspace({ dir: SINGLE_TEXT, resourcesDir: RESOURCES });
      local = await render(workspace, { ...greetingPreview(), mode: 'draft' });
    });
    afterAll(async () => { await scheduler?.stop(); });

    const preview = (token: string, body: unknown, url = '/v1/previews') => world.call('POST', url, token, body);
    const decoded = (reply: { body: { image?: { base64: string } } }) => Buffer.from(reply.body.image!.base64, 'base64');

    it('模板列表与只读查看：名称、当前修订、适用尺寸范围、对外参数与所用的数据定义', async () => {
      const { call, b } = world;
      const listed = await call('GET', '/v1/templates', b.operator.token);
      expect(listed.status).toBe(200);
      expect(listed.body.templates.map((t: { name: string }) => t.name).sort()).toEqual(['压力牌', '压力项卡', '问候牌'].sort());
      const greeting = { name: '问候牌', currentRevision: 1, base: { name: '问候', version: 1 },
        sizeRange: { width: { min: 50, max: 1500 }, height: { min: 20, max: 200 } }, parameters: [] };
      expect(listed.body.templates.find((t: { name: string }) => t.name === '问候牌')).toEqual(greeting);
      expect(await call('GET', `/v1/templates/${encodeURIComponent('问候牌')}`, b.key.token)).toMatchObject({ status: 200, body: greeting });
      expect((await call('GET', `/v1/templates/${encodeURIComponent('没有这个模板')}`, b.operator.token)).status).toBe(404);
    });

    it('草稿预览同步返回图片、问题清单与布局摘要，与本机渲染逐字节相同；不写 mode 就是草稿，正式图不走预览', async () => {
      const { b } = world;
      const reply = await preview(b.operator.token, greetingPreview());
      expect(reply.status, reply.raw.slice(0, 500)).toBe(200);
      expect(reply.body.image).toMatchObject({ format: 'png', widthPx: local.image!.widthPx, heightPx: local.image!.heightPx, dpi: 120 });
      expect(decoded(reply).equals(Buffer.from(local.image!.bytes))).toBe(true);
      expect(reply.body.problems).toEqual(local.problems);
      expect(reply.body.layout).toEqual(local.layout);
      expect(await preview(b.key.token, greetingPreview({ mode: 'final' }))).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', location: { source: 'request.mode' } }] } });
    });

    it('无法展开的请求在入队前就答问题清单，与单次渲染相同，没有图片', async () => {
      const { b } = world;
      const reply = await preview(b.operator.token, greetingPreview({ dataset: { id: 'no-such-dataset' } }));
      expect(reply.status).toBe(200);
      expect(reply.body.image).toBeUndefined();
      expect(reply.body.problems.map((p: { code: string }) => p.code)).toEqual(expect.arrayContaining(['input.datasetNotFound', 'render.expansionBlocked']));
      expect((await preview(b.operator.token, greetingPreview({ output: { width: 160, height: 40, dpi: 120, format: 'png', extra: 1 } }))).body.problems[0].code).toBe('request.invalid');
    });

    it('入队前的限制：请求与数据集字节数、单张像素、展开后的元素数与循环项数，超限直接拒绝', async () => {
      const limited = await createWorld(backend, { api: { limits: { maxRequestBytes: 4096, maxDatasetBytes: 100, maxPixels: 1_000_000, maxElements: 12, maxLoopItems: 5 } } });
      const tenant = limited.b;
      await seedGreeting(backend.tenant(tenant.id).storage, { withFont: true });
      await seedStress(backend.tenant(tenant.id).storage);
      const call = (body: unknown) => limited.call('POST', '/v1/previews', tenant.operator.token, body);
      const inline = { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: '你好' } } };
      expect(await call(greetingPreview({ dataset: inline, parameters: { padding: 'x'.repeat(5000) } }))).toMatchObject({ status: 413, body: { problems: [{ code: 'limit.requestTooLarge' }] } });
      expect(await call(greetingPreview())).toMatchObject({ status: 413, body: { problems: [{ code: 'limit.datasetTooLarge', location: { source: 'request.dataset' } }] } });
      expect(await call(greetingPreview({ dataset: inline, output: { width: 160, height: 40, dpi: 600, format: 'png' } })))
        .toMatchObject({ status: 413, body: { problems: [{ code: 'limit.pixelsExceeded', location: { source: 'request.output' } }] } });
      const expansion = await call(stressRequest(6));
      // 6 项超过循环项上限 5；展开后 14 个元素也超过上限 12：两条都报。
      expect(expansion.status).toBe(413);
      expect(expansion.body.problems.map((p: { code: string; message: string }) => `${p.code} ${p.message}`)).toEqual([
        expect.stringMatching(/^limit\.expansionExceeded .*循环项数为 6.*上限 5/), expect.stringMatching(/^limit\.expansionExceeded .*元素数为 14.*上限 12/)]);
      const raw = await limited.app.inject({ method: 'POST', url: '/v1/previews', headers: { authorization: `Bearer ${tenant.operator.token}`, 'content-type': 'application/json' },
        payload: '{"template":"问候牌","parameters":{"n":1.0000000000000001234},"dataset":{"id":"x"},"output":{"width":1,"height":1,"dpi":1,"format":"png"}}' });
      expect(raw.statusCode).toBe(400);
      expect(raw.json().problems[0].message).toContain('15 位有效数字');
      await limited.app.close();
    });

    it('按租户限制预览的并发与频率：超过答 429；worker 迟迟不接时答 503，任务撤回不占并发', async () => {
      const clock = { value: new Date() };
      // 进程内 worker 停下时只等 300 ms 就答 503；真实的 worker 要轮询队列、读字体，等得长一些。
      const previewWaitMs = options.inProcessWorker ? 300 : 10_000;
      const limited = await createWorld(backend, { api: { now: () => clock.value, limits: { previewConcurrency: 2, previewPerMinute: 4, previewWaitMs } } });
      const tenant = limited.b;
      await seedGreeting(backend.tenant(tenant.id).storage, { withFont: true });
      const call = () => limited.call('POST', '/v1/previews', tenant.operator.token, greetingPreview());
      if (options.inProcessWorker) {
        await scheduler!.stop();
        // worker 停着：前两个排队等待，第三个超过并发答 429；等不到 worker 的两个答 503。
        const replies = await Promise.all([call(), call(), new Promise((resolve) => setTimeout(resolve, 50)).then(call)]);
        expect(replies.map((reply) => reply.status).sort()).toEqual([429, 503, 503]);
        expect(replies.find((reply) => reply.status === 429)!.body.problems[0]).toMatchObject({ code: 'preview.rateLimited', message: expect.stringContaining('并发') });
        expect(replies.find((reply) => reply.status === 503)!.body.problems[0].code).toBe('worker.unavailable');
        scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'in-process' });
        expect((await call()).status).toBe(200);
        // 撤回的两个不再渲染：新起的 worker 只做了这一项。
        expect(scheduler.stats.tasks).toBe(1);
        expect((await call()).status).toBe(200);
        // 一分钟内已有 4 个预览请求入队（撤回的也算，被拒的不算）：第 5 个超过频率。
        const rate = await call();
        expect(rate).toMatchObject({ status: 429, body: { problems: [{ code: 'preview.rateLimited', message: expect.stringContaining('每分钟') }] } });
        expect(rate.raw).not.toContain(tenant.id);
        clock.value = new Date(clock.value.getTime() + 61_000);
        expect((await call()).status).toBe(200);
      } else {
        for (let i = 0; i < 4; i++) expect((await call()).status).toBe(200);
        expect((await call()).status).toBe(429);
        clock.value = new Date(clock.value.getTime() + 61_000);
        expect((await call()).status).toBe(200);
      }
      await limited.app.close();
    });

    if (options.inProcessWorker) {
      it('worker 中途卡住：等不到结果答 503；入队超过等待时长的任务不再占并发', async () => {
        const clock = { value: new Date() };
        const limited = await createWorld(backend, { api: { now: () => clock.value, limits: { previewConcurrency: 1, previewWaitMs: 200 } } });
        await seedGreeting(backend.tenant(limited.b.id).storage, { withFont: true });
        await scheduler!.stop();
        // 领了任务却永远不交回：任务一直停在渲染中（这个调度器不停，它的循环永远等着）。
        startScheduler({ backend, runner: { stats: emptyStats(), run: () => new Promise(() => undefined), close: async () => undefined }, logger: silentLogger, pollMs: 5, workerId: 'stuck' });
        const call = () => limited.call('POST', '/v1/previews', limited.b.operator.token, greetingPreview());
        expect(await call()).toMatchObject({ status: 503, body: { problems: [{ code: 'worker.unavailable' }] } });
        expect(await call()).toMatchObject({ status: 429, body: { problems: [{ code: 'preview.rateLimited' }] } });
        scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'in-process' });
        clock.value = new Date(clock.value.getTime() + 1_000);
        expect((await call()).status).toBe(200);
        await limited.app.close();
      });
    }

    it('代建工程师用被指定租户的身份预览，记审计；别的租户答 404', async () => {
      const { a, b, call } = world;
      const reply = await preview(b.engineer.token, greetingPreview(), `/v1/authoring/tenants/${b.id}/previews`);
      expect(reply.status).toBe(200);
      expect(decoded(reply).equals(Buffer.from(local.image!.bytes))).toBe(true);
      expect((await preview(a.engineer.token, greetingPreview(), `/v1/authoring/tenants/${b.id}/previews`)).status).toBe(404);
      const events = (await call('GET', '/v1/audit-events?limit=500', b.admin.token)).body.events as { action: string; crossTenant: boolean; actor: { kind: string } }[];
      expect(events.find((event) => event.action === 'authoring.preview')).toMatchObject({ crossTenant: true, actor: { kind: 'authoringToken' } });
    });

    if (options.isolation) {
      const { workerUrl, timeoutMs, recycleAfter } = options.isolation;
      const stats = async () => ((await (await fetch(`${workerUrl}/healthz`)).json()) as { renderer: { tasks: number; timeouts: number; memoryKills: number; restarts: number } }).renderer;

      it('单项超时：调度进程结束子进程，本项失败并写明超时；worker 自动恢复，后续预览照常', async () => {
        const { b } = world;
        const before = await stats();
        const reply = await preview(b.operator.token, stressRequest(6000));
        expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
        expect(reply.body.image).toBeUndefined();
        expect(reply.body.problems).toEqual([expect.objectContaining({ code: 'worker.timeout', message: expect.stringContaining(`${timeoutMs}`) })]);
        expect((await stats()).timeouts).toBe(before.timeouts + 1);
        const next = await preview(b.operator.token, greetingPreview());
        expect(decoded(next).equals(Buffer.from(local.image!.bytes))).toBe(true);
      });

      it('内存超限：容器的内存上限结束子进程，本项失败并写明内存超限；worker 自动恢复，后续预览照常', async () => {
        const { b } = world;
        const before = await stats();
        const reply = await preview(b.operator.token, greetingPreview({ output: { width: 200, height: 200, dpi: 1270, format: 'png' } }));
        expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
        expect(reply.body.image).toBeUndefined();
        expect(reply.body.problems).toEqual([expect.objectContaining({ code: 'worker.memoryExceeded' })]);
        expect((await stats()).memoryKills).toBe(before.memoryKills + 1);
        const next = await preview(b.operator.token, greetingPreview());
        expect(decoded(next).equals(Buffer.from(local.image!.bytes))).toBe(true);
      });

      it(`渲染子进程在任务之间复用，做满 ${recycleAfter} 项换新`, async () => {
        const { b } = world;
        const before = await stats();
        for (let i = 0; i < recycleAfter * 2; i++) expect((await preview(b.operator.token, greetingPreview())).status).toBe(200);
        const after = await stats();
        expect(after.tasks - before.tasks).toBe(recycleAfter * 2);
        expect(after.restarts - before.restarts).toBeGreaterThanOrEqual(1);
        expect(after.restarts - before.restarts).toBeLessThanOrEqual(2);
      });
    }

    it('预览请求里的令牌与密码不进日志', () => {
      const text = world.logs.join('\n');
      for (const secret of world.secrets) expect(text).not.toContain(secret);
    });
  });
}

/** 进程内 worker 的日志不看。 */
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
