/**
 * 开放 API 的 OpenAPI 合同（票据 11，M246）：描述覆盖全部端点，有快照；相对 1.0.0 基线只做加法；错误回答逐个端点核对。
 * 每个 API 用例的回答都另经 createWorld 按描述核对（openapi-check.ts），这里核对描述本身与按端点逐个探查的错误回答。
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { API_VERSION } from '../src/api/openapi.js';
import { ROLE_PERMISSIONS, type Permission } from '../src/api/permissions.js';
import { createMemoryBackend } from '../src/memory.js';
import { createWorld, type World } from './api-suite.js';
import { breakingChanges } from './openapi-compat.js';

const BASELINE = fileURLToPath(new URL('../../docs/api/openapi-1.0.0.json', import.meta.url));
const API_DOC = fileURLToPath(new URL('../../docs/api.md', import.meta.url));
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
type Json = Record<string, any>;

const operations = (doc: Json) => Object.entries(doc['paths'] as Record<string, Json>).flatMap(([path, item]) =>
  METHODS.filter((method) => item[method]).map((method) => ({ method: method.toUpperCase() as 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', path, operation: item[method] as Json })));

describe('开放 API 的 OpenAPI 合同', () => {
  let world: World, doc: Json;
  beforeAll(async () => {
    world = await createWorld(createMemoryBackend());
    const reply = await world.call('GET', '/v1/openapi.json');
    expect(reply.status).toBe(200);
    doc = reply.body;
  });

  it('公开的 /v1/openapi.json 描述全部端点，快照在 docs/api/openapi.json；有变化时必须显式更新（npx vitest run -u）', async () => {
    const routes = world.app.routeTable.map((route) => `${route.method} ${route.url.replace(/:([A-Za-z0-9]+)/g, '{$1}')}`).sort();
    expect(operations(doc).map(({ method, path }) => `${method} ${path}`).sort()).toEqual(routes);
    expect(doc['info'].version).toBe(API_VERSION);
    const ids = operations(doc).map(({ operation }) => operation['operationId']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const { method, path, operation } of operations(doc)) {
      const at = `${method} ${path}`, statuses = Object.keys(operation['responses']);
      expect(operation['summary'], at).toBeTruthy();
      expect(statuses.some((status) => status.startsWith('2')), at).toBe(true);
      if (operation['x-access'] !== 'public') expect(statuses, at).toContain('401');
      // /readyz 的 503 是就绪状态，不是错误回答；其余错误回答一律是问题清单。
      for (const status of statuses.filter((code) => Number(code) >= 400 && path.startsWith('/v1/'))) {
        expect(operation['responses'][status], `${at} ${status}`).toEqual({ $ref: `#/components/responses/Error${status}` });
        expect(doc['components'].responses[`Error${status}`].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/ErrorResponse' });
      }
    }
    await expect(`${JSON.stringify(doc, null, 2)}\n`).toMatchFileSnapshot('../../docs/api/openapi.json');
  });

  it('描述里的 Schema 在严格模式下都能编译：没有拼错的关键字与找不到的引用', () => {
    const ajv = new Ajv2020({ strict: true, strictTypes: false, strictRequired: false, strictTuples: false });
    ajv.addFormat('uuid', true).addFormat('date-time', true);
    const schemas = doc['components'].schemas as Record<string, Json>;
    const key = (name: string) => (typeof schemas[name]!['$id'] === 'string' ? schemas[name]!['$id'] : `urn:openapi:components:${name}`);
    const rewrite = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/"#\/components\/schemas\/([A-Za-z]+)"/g, (_m, name: string) => JSON.stringify(key(name))));
    for (const [name, schema] of Object.entries(schemas)) ajv.addSchema(typeof schema['$id'] === 'string' ? schema : { ...(rewrite(schema) as Json), $id: key(name) });
    for (const name of Object.keys(schemas)) expect(() => ajv.getSchema(key(name)), name).not.toThrow();
    for (const { method, path, operation } of operations(doc)) {
      const inline = [
        ...((operation['parameters'] ?? []) as Json[]).map((parameter) => parameter['schema']),
        ...Object.values((operation['requestBody']?.content ?? {}) as Record<string, Json>).map((content) => content['schema']),
        ...Object.values(operation['responses'] as Record<string, Json>).flatMap((response) => Object.values((response['content'] ?? {}) as Record<string, Json>).map((content) => content['schema'])),
      ];
      for (const schema of inline) expect(() => ajv.compile(rewrite(schema) as Json), `${method} ${path}`).not.toThrow();
    }
  });

  it('相对 1.0.0 基线只做了加法；描述变了就要升版本，并在 docs/api.md 的变更记录里写一行', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Json;
    expect(breakingChanges(baseline, doc)).toEqual([]);
    const unversioned = (value: Json) => JSON.stringify({ ...value, info: { ...value['info'], version: '' } });
    if (unversioned(baseline) !== unversioned(doc)) expect(doc['info'].version, '描述与 1.0.0 基线不同，要升版本').not.toBe(baseline['info'].version);
    expect(readFileSync(API_DOC, 'utf8')).toContain(`| ${doc['info'].version} |`);
  });

  it('兼容检查认出不兼容的改动，放过只做加法的改动', () => {
    const changed = (edit: (copy: Json) => void) => {
      const copy = structuredClone(doc);
      edit(copy);
      return breakingChanges(doc, copy);
    };
    const schema = (copy: Json, path: string, method: string) => copy['paths'][path][method].requestBody.content['application/json'].schema;
    const breaking: [string, (copy: Json) => void, RegExp][] = [
      ['删端点', (copy) => { delete copy['paths']['/v1/usage'].get; }, /GET \/v1\/usage：端点被删除/],
      ['请求新增必填', (copy) => { const body = schema(copy, '/v1/api-keys', 'post'); body.properties.label = { type: 'string' }; body.required.push('label'); }, /新增必填 label/],
      ['请求收紧取值范围', (copy) => { copy['components'].schemas.PlanInput.properties.concurrency.maximum = 32; }, /PUT \/v1\/platform\/tenants\/\{tenantId\}\/plan 请求体\.concurrency：maximum 收紧/],
      ['请求删掉属性', (copy) => { delete schema(copy, '/v1/webhooks', 'post').properties.description; }, /不再接受 description/],
      ['新增必填参数', (copy) => { copy['paths']['/v1/records'].get.parameters.push({ name: 'tenant', in: 'query', required: true, schema: { type: 'string' } }); }, /新增必填参数 query:tenant/],
      ['回答删属性', (copy) => { delete copy['components'].schemas.Batch.properties.summary; }, /删除了属性 summary/],
      ['回答放宽类型', (copy) => { copy['components'].schemas.Usage.properties.images.properties.limit.type = ['integer', 'null']; }, /limit：类型放宽/],
      ['回答必有变可有', (copy) => { copy['components'].schemas.Webhook.required = ['id']; }, /url 不再必有/],
      ['删成功状态', (copy) => { delete copy['paths']['/v1/batches'].post.responses['202']; }, /不再回答 202/],
      ['事件正文删属性', (copy) => { delete copy['components'].schemas.BatchHeader.properties.outcome; }, /webhook batch\.finished 正文.*删除了属性 outcome/],
      ['访问要求改变', (copy) => { copy['paths']['/v1/usage'].get['x-access'] = 'members.manage'; }, /访问要求/],
      ['DSL 请求收窄', (copy) => { copy['components'].schemas.BatchRequest.properties.items.maxItems = 10; }, /POST \/v1\/batches 请求体.*maxItems 收紧/],
    ];
    for (const [name, edit, expected] of breaking) expect(changed(edit).join('\n'), name).toMatch(expected);
    const additive: [string, (copy: Json) => void][] = [
      ['新增端点', (copy) => { copy['paths']['/v1/new'] = { get: { 'x-access': 'tenant.read', responses: { '200': { description: '新' } } } }; }],
      ['请求新增可选属性', (copy) => { schema(copy, '/v1/api-keys', 'post').properties.note = { type: 'string' }; }],
      ['请求放宽取值范围', (copy) => { copy['components'].schemas.PlanInput.properties.concurrency.maximum = 128; }],
      ['回答新增属性', (copy) => { copy['components'].schemas.Batch.properties.priority = { type: 'integer' }; }],
      ['回答新增枚举值', (copy) => { copy['components'].schemas.BatchOutcome.enum.push('expired'); }],
      ['新增错误状态', (copy) => { copy['paths']['/v1/usage'].get.responses['418'] = { description: '新' }; }],
      ['新增可选参数', (copy) => { copy['paths']['/v1/records'].get.parameters.push({ name: 'status', in: 'query', required: false, schema: { type: 'string' } }); }],
    ];
    for (const [name, edit] of additive) expect(changed(edit), name).toEqual([]);
  });

  it('逐个端点核对错误回答：未鉴权 401，路径里的对象不存在 404，请求体与查询串不合规 400；回答都与描述相符', async () => {
    const { call, a, platform } = world;
    const tokenFor = (access: string) => {
      if (access === 'authenticated' || access === 'session') return a.operator.token;
      if (access.startsWith('platform.')) return platform;
      if (access.startsWith('authoring.')) return a.engineer.token;
      return ROLE_PERMISSIONS.admin.includes(access as Permission) ? a.admin.token : undefined;
    };
    const missing: Record<string, string> = { name: encodeURIComponent(`不存在-${randomUUID()}`), datasetId: encodeURIComponent(`不存在-${randomUUID()}`),
      resourceId: 'missing-resource', version: '1', index: '1', sha256: '0'.repeat(64) };
    const fill = (path: string, values: (name: string) => string) => path.replace(/\{([A-Za-z0-9]+)\}/g, (_m, name: string) => values(name));
    const probed = { unauthenticated: 0, notFound: 0, body: 0, query: 0 };
    for (const { method, path, operation } of operations(doc)) {
      const access = operation['x-access'] as string, at = `${method} ${path}`;
      if (access === 'public') continue;
      const token = tokenFor(access)!;
      expect(token, at).toBeTruthy();
      const authoring = path.startsWith('/v1/authoring/');
      const params = [...path.matchAll(/\{([A-Za-z0-9]+)\}/g)].map(([, name]) => name!);
      const sample = fill(path, (name) => (name === 'tenantId' && authoring ? a.id : missing[name] ?? randomUUID()));

      const anonymous = await call(method, sample, undefined);
      expect(anonymous, at).toMatchObject({ status: 401, body: { problems: [{ code: 'auth.required', level: 'severe', location: { kind: 'input', source: 'request.authorization' } }] } });
      probed.unauthenticated++;

      if (params.length && !operation['requestBody']) {
        // 代建端点只有目标租户时，用没指定给这个令牌的租户；否则目标租户是自己的，别的对象不存在。
        const url = fill(path, (name) => (name === 'tenantId' && authoring && params.length > 1 ? a.id : missing[name] ?? randomUUID()));
        expect(await call(method, url, token), `${at} 不存在`).toMatchObject({ status: 404, body: { problems: [{ code: 'request.notFound' }] } });
        probed.notFound++;
      }
      const json = operation['requestBody']?.content?.['application/json'];
      if (json) {
        const url = fill(path, (name) => (name === 'tenantId' && authoring ? a.id : name === 'datasetId' ? 'ds-greeting' : missing[name] ?? randomUUID()));
        const reply = await call(method, url, token, []);
        // 只校验的端点把数据集的问题放在 200 的回答里。
        expect(reply.status, `${at} 请求体 []：${reply.raw.slice(0, 200)}`).toBe(path === '/v1/dataset-checks' ? 200 : 400);
        expect(reply.body.problems.every((problem: { location: { kind: string; source?: string } }) => problem.location.kind !== 'input' || problem.location.source?.startsWith('request')
          || problem.location.source === 'dataset'), at).toBe(true);
        probed.body++;
      }
      if ((operation['parameters'] ?? []).some((parameter: Json) => parameter['in'] === 'query')) {
        const url = `${fill(path, (name) => (name === 'tenantId' && authoring ? a.id : missing[name] ?? randomUUID()))}?unknownParameter=1`;
        expect(await call(method, url, token, method === 'POST' ? new Uint8Array([1]) : undefined), `${at} 未知的查询参数`)
          .toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
        probed.query++;
      }
    }
    expect(probed.unauthenticated).toBeGreaterThan(55);
    expect(probed).toMatchObject({ notFound: expect.any(Number), body: expect.any(Number), query: expect.any(Number) });
    expect(Math.min(probed.notFound, probed.body, probed.query)).toBeGreaterThan(5);
  });
});
