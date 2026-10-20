/**
 * 数据集接口（票据 10）：只经 HTTP 驱动，断言响应、问题清单与经 API 可见的结果（读回的字节、列表、预览、审计）。
 * 同一组用例跑两种后端：内存后端加进程内 worker 进 npm test；PostgreSQL 加 S3 在 Docker 后端测试里跑，预览由 Compose 里的 worker 渲染。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { checkDataset, loadWorkspace, type Workspace } from '../src/engine.js';
import { inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { greetingPreview, M402_DIR, RESOURCES_DIR, seedDocuments, seedM402 } from './seed.js';

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const GREETING = { name: '问候', version: 1 };
const hello = (id: string | undefined, message = '你好') =>
  ({ dataset: { ...(id === undefined ? {} : { id }), name: '你好', staticSchema: GREETING }, data: { message } });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;

export function describeDatasets(name: string, makeBackend: () => Promise<ServiceBackend>, options: { readonly inProcessWorker: boolean }): void {
  describe(`数据集接口（${name}）`, () => {
    let world: World, backend: ServiceBackend, scheduler: Scheduler | undefined;
    /** 本机的 M402 工作区：服务的校验结果与引擎对它的校验比较。 */
    let m402: Workspace, m402Dataset: any;
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
      await seedM402(backend.tenant(world.b.id).storage);
      if (options.inProcessWorker) scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'in-process', build: 'sha256:datasets-suite', leaseMs: 60_000 });
      m402 = await loadWorkspace({ dir: M402_DIR, resourcesDir: RESOURCES_DIR });
      m402Dataset = JSON.parse(await readFile(`${M402_DIR}dataset-m402.json`, 'utf8'));
    });
    afterAll(async () => { await scheduler?.stop(); });

    /** 数据集按原文发送：JSON 文本加 application/json。 */
    const send = (method: 'POST' | 'PUT', url: string, token: string, body: string) => world.call(method, url, token, body, { 'content-type': 'application/json' });

    it('新建、读取、列出、修改与复制；读回的是保存时的原始字节；审计只记对象，不记内容', async () => {
      const { call, a } = world;
      const raw = `{"dataset":{"id":"ds-hello","name":"你好","staticSchema":{"name":"问候","version":1}},\n    "data":{"message":"你好"}}  \n`;
      const created = await send('POST', '/v1/datasets', a.operator.token, raw);
      expect(created.status, created.raw).toBe(201);
      const entry = { id: 'ds-hello', name: '你好', staticSchema: GREETING, sha256: sha256(raw), byteLength: Buffer.byteLength(raw) };
      expect(created.body).toEqual({ dataset: entry, problems: [] });
      const read = await call('GET', '/v1/datasets/ds-hello', a.key.token);
      expect(read.status).toBe(200);
      expect(read.headers['content-type']).toMatch(/^application\/json/);
      expect(read.bytes.equals(Buffer.from(raw))).toBe(true);

      const listed = await call('GET', '/v1/datasets', a.operator.token);
      expect(listed.body.datasets.map((dataset: { id: string }) => dataset.id)).toEqual(['ds-greeting', 'ds-hello']);
      expect(listed.body.datasets[1]).toEqual(entry);
      expect(listed.body.datasets[0]).toMatchObject({ id: 'ds-greeting', name: '欢迎乘坐', staticSchema: GREETING });

      const changed = text(hello('ds-hello', '早上好'));
      expect(await send('PUT', '/v1/datasets/ds-hello', a.key.token, changed))
        .toMatchObject({ status: 200, body: { dataset: { id: 'ds-hello', sha256: sha256(changed) }, problems: [] } });
      expect((await call('GET', '/v1/datasets/ds-hello', a.operator.token)).raw).toBe(changed);

      const copied = await call('POST', '/v1/datasets/ds-hello/copies', a.operator.token, { id: '问候-副本', name: '早上好（副本）' });
      expect(copied, copied.raw).toMatchObject({ status: 201, body: { dataset: { id: '问候-副本', name: '早上好（副本）', staticSchema: GREETING }, problems: [] } });
      const copy = await call('GET', `/v1/datasets/${encodeURIComponent('问候-副本')}`, a.operator.token);
      expect(copy.body).toEqual({ dataset: { id: '问候-副本', name: '早上好（副本）', staticSchema: GREETING }, data: { message: '早上好' } });
      expect((await call('POST', `/v1/datasets/${encodeURIComponent('问候-副本')}/copies`, a.operator.token, { id: 'ds-copy-2' })).body.dataset.name).toBe('早上好（副本）');
      expect((await call('GET', '/v1/datasets/ds-hello', a.operator.token)).raw).toBe(changed);
      expect((await call('GET', '/v1/datasets', a.operator.token)).body.datasets.map((dataset: { id: string }) => dataset.id))
        .toEqual(['ds-copy-2', 'ds-greeting', 'ds-hello', '问候-副本']);

      const events = (await call('GET', '/v1/audit-events?limit=500', a.admin.token)).body.events;
      const actions = events.filter((event: { action: string }) => event.action.startsWith('dataset.')).map((event: any) => [event.action, event.object.id, event.actor.kind]);
      expect(actions).toEqual(expect.arrayContaining([
        ['dataset.create', 'ds-hello', 'member'], ['dataset.update', 'ds-hello', 'apiKey'], ['dataset.copy', '问候-副本', 'member'], ['dataset.copy', 'ds-copy-2', 'member'],
      ]));
      expect(JSON.stringify(events)).not.toContain('早上好');
    });

    it('保存的数据集就是出图用的数据：按 ID 预览与内联同一份数据的预览逐字节相同', async () => {
      const { call, a } = world;
      const document = hello('ds-preview', '欢迎光临');
      expect((await send('POST', '/v1/datasets', a.operator.token, text(document))).status).toBe(201);
      const byId = await call('POST', '/v1/previews', a.operator.token, greetingPreview({ dataset: { id: 'ds-preview' } }));
      const inline = await call('POST', '/v1/previews', a.operator.token, greetingPreview({ dataset: { inline: document } }));
      expect(byId.status, byId.raw.slice(0, 300)).toBe(200);
      expect(byId.body.image.base64).toBe(inline.body.image.base64);
      expect(byId.body.problems).toEqual(inline.body.problems);
    });

    it('保存时按编译产物校验：问题定位到字段，与引擎对同一份数据的检查相同；有严重问题时不保存', async () => {
      const { call, b } = world;
      const document = structuredClone(m402Dataset);
      document.dataset.id = 'ds-broken';
      document.data.fare = '两元';
      document.data.stops[3].landmark = 'res:no-such-landmark';
      document.data.stops[4].landmark = 'res:font-hei-medium';
      delete document.data.routeNo;
      const body = text(document);
      const expected = checkDataset(new Uint8Array(Buffer.from(body)), m402).problems;
      expect(expected.map((problem: { code: string }) => problem.code).sort())
        .toEqual(['dataset.requiredMissing', 'dataset.resourceKindMismatch', 'dataset.resourceNotFound', 'dataset.typeMismatch']);

      const rejected = await send('POST', '/v1/datasets', b.operator.token, body);
      expect(rejected.status).toBe(400);
      expect(rejected.body.problems).toEqual(expected);
      expect((await call('GET', '/v1/datasets/ds-broken', b.operator.token)).status).toBe(404);

      const before = await call('GET', '/v1/datasets/ds-m402-wanguocheng', b.operator.token);
      const update = await send('PUT', '/v1/datasets/ds-m402-wanguocheng', b.operator.token, text({ ...document, dataset: { ...document.dataset, id: 'ds-m402-wanguocheng' } }));
      expect(update.status).toBe(400);
      expect(update.body.problems).toEqual(expected);
      expect((await call('GET', '/v1/datasets/ds-m402-wanguocheng', b.operator.token)).raw).toBe(before.raw);

      // 推送进来的数据集不经校验；原件有严重问题时不复制，问题与校验原件相同。
      const pushed = { ...m402Dataset, dataset: { ...m402Dataset.dataset, id: 'ds-pushed-broken' }, data: { ...m402Dataset.data, routeNoImage: 'res:no-such-image' } };
      await seedDocuments(backend.tenant(b.id).storage, [new Uint8Array(Buffer.from(text(pushed)))]);
      expect(await call('POST', '/v1/datasets/ds-pushed-broken/copies', b.operator.token, { id: 'ds-pushed-copy' }))
        .toMatchObject({ status: 400, body: { problems: [{ code: 'dataset.resourceNotFound', location: { kind: 'field', path: 'routeNoImage' } }] } });
      expect((await call('GET', '/v1/datasets/ds-pushed-copy', b.operator.token)).status).toBe(404);

      // 引用租户里的图片资源的合格数据集可以保存。
      const valid = text({ ...m402Dataset, dataset: { ...m402Dataset.dataset, id: 'ds-m402-saved' } });
      expect(await send('POST', '/v1/datasets', b.key.token, valid)).toMatchObject({ status: 201, body: { dataset: { id: 'ds-m402-saved' }, problems: [] } });
    });

    it('只校验、不保存：给出与保存时相同的问题清单，供表单实时提示；不要求 dataset.id', async () => {
      const { call, a, b } = world;
      const listed = (await call('GET', '/v1/datasets', a.operator.token)).body;
      expect(await send('POST', '/v1/dataset-checks', a.operator.token, text(hello(undefined)))).toMatchObject({ status: 200, body: { problems: [] } });
      const long = await send('POST', '/v1/dataset-checks', a.key.token, text({ ...hello(undefined), data: { message: '这句问候语写得太长了超过了二十个字的上限啊啊啊', extra: 1 } }));
      expect(long.status).toBe(200);
      expect(long.body.problems.map((problem: any) => [problem.code, problem.location]).sort()).toEqual([
        ['dataset.constraintViolated', { kind: 'field', path: 'message' }], ['dataset.unknownKey', { kind: 'field', path: 'extra' }],
      ]);
      // 超过 15 位有效数字的数值照原文报出，不在读请求体时就失真（M112）。
      const precise = await send('POST', '/v1/dataset-checks', a.operator.token, '{"dataset":{"staticSchema":{"name":"问候","version":1}},"data":{"message":"你好","n":0.12345678901234567}}');
      expect(precise.body.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'dataset.tooManyDigits', message: expect.stringContaining('0.12345678901234567') })]));
      expect((await send('POST', '/v1/dataset-checks', a.operator.token, '{"dataset":')).body.problems).toEqual([expect.objectContaining({ code: 'input.unreadable' })]);

      const document = { ...m402Dataset, data: { ...m402Dataset.data, routeNoImage: 'res:no-such-image' } };
      const body = text(document);
      expect((await send('POST', '/v1/dataset-checks', b.operator.token, body)).body.problems).toEqual(checkDataset(new Uint8Array(Buffer.from(body)), m402).problems);
      expect((await call('GET', '/v1/datasets', a.operator.token)).body).toEqual(listed);
    });

    it('冲突与请求校验：同一 ID 不能再建；修改与复制要求原件已有；路径与正文的 ID 要一致；ID 要合规；超过数据集字节上限答 413', async () => {
      const { call, a } = world;
      const document = text(hello('ds-conflict'));
      expect((await send('POST', '/v1/datasets', a.operator.token, document)).status).toBe(201);
      const duplicate = { status: 409, body: { problems: [{ code: 'input.duplicate' }] } };
      expect(await send('POST', '/v1/datasets', a.operator.token, document)).toMatchObject(duplicate);
      expect(await send('POST', '/v1/datasets', a.operator.token, text(hello('ds-greeting')))).toMatchObject(duplicate);
      expect(await call('POST', '/v1/datasets/ds-conflict/copies', a.operator.token, { id: 'ds-greeting' })).toMatchObject(duplicate);
      expect(await send('PUT', '/v1/datasets/ds-nothing', a.operator.token, text(hello('ds-nothing')))).toMatchObject({ status: 404, body: { problems: [{ code: 'request.notFound' }] } });
      expect((await call('POST', '/v1/datasets/ds-nothing/copies', a.operator.token, { id: 'ds-new' })).status).toBe(404);
      expect((await call('GET', '/v1/datasets/ds-nothing', a.operator.token)).status).toBe(404);

      const idProblem = { status: 400, body: { problems: [{ code: 'request.invalid', location: { kind: 'input', source: 'request.body.dataset.id' } }] } };
      expect(await send('PUT', '/v1/datasets/ds-conflict', a.operator.token, text(hello('ds-other')))).toMatchObject(idProblem);
      expect(await send('POST', '/v1/datasets', a.operator.token, text(hello(undefined)))).toMatchObject(idProblem);
      for (const id of ['', ' ds', 'ds ', 'ds\n1', 'x'.repeat(201)]) {
        expect(await send('POST', '/v1/datasets', a.operator.token, text(hello(id))), JSON.stringify(id)).toMatchObject(idProblem);
        expect((await call('POST', '/v1/datasets/ds-conflict/copies', a.operator.token, { id })).status, JSON.stringify(id)).toBe(400);
      }
      expect((await call('POST', '/v1/datasets/ds-conflict/copies', a.operator.token, { id: 'ds-x', extra: 1 })).status).toBe(400);
      expect(await send('POST', '/v1/datasets', a.operator.token, '{"dataset":')).toMatchObject({ status: 400, body: { problems: [{ code: 'input.unreadable' }] } });
      expect(await send('POST', '/v1/datasets', a.operator.token, text({ template: '问候牌' }))).toMatchObject({ status: 400, body: { problems: [{ code: 'dataset.invalid' }] } });
      expect((await call('POST', '/v1/datasets', a.operator.token, document, { 'content-type': 'text/plain' })).status).toBe(415);

      const limited = await createWorld(backend, { api: { limits: { maxDatasetBytes: 200 } } });
      const big = text(hello('ds-big', '你好'.repeat(9)));
      expect(Buffer.byteLength(big)).toBeGreaterThan(200);
      for (const [method, url] of [['POST', '/v1/datasets'], ['POST', '/v1/dataset-checks']] as const) {
        expect(await limited.call(method, url, limited.a.operator.token, big, { 'content-type': 'application/json' }))
          .toMatchObject({ status: 413, body: { problems: [{ code: 'limit.requestTooLarge' }] } });
      }
    });
  });
}
