/**
 * 开放 API 用例：账号、租户与鉴权（票据 04，M247、M261）。只经 HTTP 请求驱动，断言响应、问题清单与经 API 可见的结果。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApi, type ApiOptions } from '../src/api/app.js';
import { ROLE_PERMISSIONS, type IdentityRole } from '../src/api/permissions.js';
import { ENGINE_MAX_PIXELS, type Plan, type ServiceBackend } from '../src/backend.js';
import { generatePassword, hashPassword } from '../src/credentials.js';
import { createLogger } from '../src/log.js';
import { CROSS_TENANT_ENDPOINTS, EXEMPT_ACCESS, type TenantObjects } from './cross-tenant-endpoints.js';
import { openApiChecker } from './openapi-check.js';
import { seedGreeting } from './seed.js';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** body 是解析后的 JSON（响应是 JSON 时），raw 是响应文本，bytes 是原始字节。 */
interface Reply { status: number; body: any; raw: string; bytes: Buffer; headers: Record<string, unknown> }
interface Person { id: string; email: string; password: string; token: string }
interface TenantFixture { id: string; admin: Person; operator: Person; key: { id: string; token: string }; engineer: { id: string; token: string } }

const email = (role: string) => `${role}-${randomUUID()}@example.test`;
/** 上传内容的样例：几个字节与它的 SHA-256。 */
const SAMPLE = new Uint8Array(Buffer.from('样例内容'));
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE).digest('hex');
/** 模板不存在的预览请求：入队前就答问题清单。 */
const BLOCKED_PREVIEW = { template: '没有这个模板', dataset: { id: 'ds-greeting' }, output: { width: 160, height: 40, dpi: 120, format: 'png' } };
/** 根模板不存在的批次：整批拒绝，不建批次。 */
const BLOCKED_BATCH = { template: '没有这个模板', items: [{ id: '1', dataset: { id: 'ds-greeting' }, output: { width: 160, height: 40, dpi: 120, format: 'png' } }] };
/** 模板不存在的 Excel 导入：读工作簿之前就答问题清单。 */
const BLOCKED_IMPORT = { template: '没有这个模板', workbook: 'UEsDBA==', output: { width: 160, height: 40, dpi: 120, format: 'png' } };
const ids = (value: unknown) => JSON.stringify(value);
/** 权限矩阵用的数据集：数据定义不在租户里，保存答 400，校验答问题清单。 */
const MATRIX_DATASET = { dataset: { id: 'ds-matrix', staticSchema: { name: '矩阵', version: 1 } }, data: {} };
/** 结构完整的替换检查报告：资源不在租户里，应用答 404。 */
const replacementCheck = (id: string) => ({
  resource: { id, kind: 'image', version: 1, sha256: SAMPLE_SHA256, byteLength: SAMPLE.length },
  replacement: { sha256: SAMPLE_SHA256, byteLength: SAMPLE.length },
  impact: { workspaceFingerprint: SAMPLE_SHA256, renderOptions: { fallbackFonts: [], svgFonts: [] }, references: [], configuration: [], scope: '' },
});

/** 按 OpenAPI 描述核对回答的检查器：描述由路由生成，与后端无关，同一进程里只建一次。 */
let checker: ReturnType<typeof openApiChecker> | undefined;

/** 环境里两个租户的缺省套餐：额度宽裕，不妨碍别的用例；额度的用例另设。 */
export const WORLD_PLAN: Plan = { monthlyImages: 100_000, maxPixels: ENGINE_MAX_PIXELS, concurrency: 2 };

/** 一套环境：平台管理员、两个租户（各有管理员、操作员、API 密钥，与只指定给该租户的代建令牌）。代建推送的用例也用它。 */
export async function createWorld(backend: ServiceBackend, options: { readonly api?: Partial<ApiOptions>; readonly plan?: Plan } = {}) {
  const clock = { value: new Date() };
  const logs: string[] = [], secrets: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { logs.push(...String(chunk).split('\n').filter(Boolean)); done(); } });
  // 测试里的 webhook 接收端在本机或测试容器里：放开内网地址。服务密钥与投递任务用同一个：
  // Docker 后端测试用 Compose 里接口进程的密钥（它的投递任务也会领到这里记的投递），其余每套环境随机生成。
  const secretKey = new Uint8Array(process.env['RW_SECRET_KEY'] ? Buffer.from(process.env['RW_SECRET_KEY'], 'hex') : randomBytes(32));
  const app = createApi({ backend, build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'info', sink), now: () => clock.value, passwordCost: 'test',
    secretKey, allowPrivateWebhooks: true, ...options.api });
  // 每个回答都按 OpenAPI 描述核对（票据 11）：记下匹配到的路由模板，回答与描述不符时这次调用就失败。
  const routes = new WeakMap<object, string>();
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.routeOptions.url) routes.set(request.raw, request.routeOptions.url);
    return payload;
  });
  /** 字节作为 application/octet-stream 发送，其他请求体作为 JSON 发送；extra 是另加的请求头（如幂等键）。 */
  const call = async (method: Method, url: string, token?: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply> => {
    const binary = body instanceof Uint8Array;
    const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(binary ? { 'content-type': 'application/octet-stream' } : {}), ...extra };
    const response = await app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: binary ? Buffer.from(body) : body as object }) });
    const contentType = String(response.headers['content-type'] ?? '');
    const route = routes.get(response.raw.req);
    const violations = (checker ??= openApiChecker(JSON.parse((await app.inject({ method: 'GET', url: '/v1/openapi.json' })).body)))({
      method, ...(route ? { route } : {}), status: response.statusCode, contentType, body: contentType.startsWith('application/json') ? response.body : '',
    });
    if (violations.length) throw new Error(`回答与 OpenAPI 描述不符：\n${violations.join('\n')}\n回答：${response.body.slice(0, 500)}`);
    const json = contentType.startsWith('application/json');
    return { status: response.statusCode, body: json && response.body ? JSON.parse(response.body) : undefined, raw: response.body, bytes: response.rawPayload, headers: response.headers };
  };
  const login = async (address: string, password: string) => {
    const reply = await call('POST', '/v1/sessions', undefined, { email: address, password });
    expect(reply.status).toBe(201);
    secrets.push(reply.body.token);
    return reply.body.token as string;
  };

  const platformEmail = email('platform'), platformPassword = generatePassword();
  secrets.push(platformPassword);
  await backend.platform.createPlatformUser(platformEmail, await hashPassword(platformPassword, 'test'));
  const platform = await login(platformEmail, platformPassword);

  const member = async (tenantId: string, role: 'admin' | 'operator'): Promise<Person> => {
    const address = email(role);
    const created = await call('POST', `/v1/platform/tenants/${tenantId}/members`, platform, { email: address, role });
    expect(created.status).toBe(201);
    secrets.push(created.body.initialPassword);
    return { id: created.body.member.id, email: address, password: created.body.initialPassword, token: await login(address, created.body.initialPassword) };
  };
  const tenant = async (name: string): Promise<TenantFixture> => {
    const created = await call('POST', '/v1/platform/tenants', platform, { name, plan: options.plan ?? WORLD_PLAN });
    expect(created.status).toBe(201);
    const id = created.body.id, admin = await member(id, 'admin'), operator = await member(id, 'operator');
    const key = await call('POST', '/v1/api-keys', admin.token, { name: `${name} 的密钥` });
    const engineer = await call('POST', '/v1/platform/authoring-tokens', platform, { label: `${name} 的代建工程师`, tenantIds: [id] });
    secrets.push(key.body.key, engineer.body.token);
    return { id, admin, operator, key: { id: key.body.apiKey.id, token: key.body.key }, engineer: { id: engineer.body.authoringToken.id, token: engineer.body.token } };
  };
  const a = await tenant('租户 A'), b = await tenant('租户 B');
  // 租户 A 有问候牌样例的文档，跨租户端点清单用它的模板名。
  await seedGreeting(backend.tenant(a.id).storage);
  return { app, backend, clock, logs, sink, secrets, secretKey, call, login, member, platform, platformLogin: { email: platformEmail, password: platformPassword }, a, b };
}
export type World = Awaited<ReturnType<typeof createWorld>>;

/** M247 的权限矩阵；本期用量的合计操作员也能看（M300），明细仍只给客户管理员。 */
const MATRIX: Record<IdentityRole, readonly string[]> = {
  operator: ['tenant.read', 'datasets.write', 'resources.upload', 'preview', 'deliver', 'records.read', 'usage.summary'],
  admin: ['tenant.read', 'datasets.write', 'resources.upload', 'preview', 'deliver', 'records.read', 'usage.summary',
    'members.manage', 'apiKeys.manage', 'webhooks.manage', 'resources.replace', 'usage.read', 'audit.read'],
  apiKey: ['tenant.read', 'datasets.write', 'resources.upload', 'preview', 'deliver', 'records.read', 'usage.summary', 'webhooks.manage'],
  authoringEngineer: ['authoring.read', 'authoring.push', 'authoring.preview'],
  platformAdmin: ['platform.tenants', 'platform.members', 'platform.authoringTokens', 'platform.plans'],
};

/** 每个需要鉴权的端点允许哪些身份；对象 ID 用随机值，允许的身份得到 404 或成功，不允许的得到 403。 */
const ENDPOINTS: readonly { route: string; allow: readonly IdentityRole[]; request(world: World): { method: Method; url: string; body?: unknown } }[] = [
  { route: 'GET /v1/me', allow: ['platformAdmin', 'admin', 'operator', 'apiKey', 'authoringEngineer'], request: () => ({ method: 'GET', url: '/v1/me' }) },
  { route: 'DELETE /v1/sessions/current', allow: ['platformAdmin', 'admin', 'operator'], request: () => ({ method: 'DELETE', url: '/v1/sessions/current' }) },
  { route: 'GET /v1/platform/tenants', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: '/v1/platform/tenants' }) },
  { route: 'POST /v1/platform/tenants', allow: ['platformAdmin'], request: () => ({ method: 'POST', url: '/v1/platform/tenants', body: { name: '矩阵' } }) },
  { route: 'GET /v1/platform/tenants/:tenantId/members', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: `/v1/platform/tenants/${randomUUID()}/members` }) },
  { route: 'POST /v1/platform/tenants/:tenantId/members', allow: ['platformAdmin'],
    request: () => ({ method: 'POST', url: `/v1/platform/tenants/${randomUUID()}/members`, body: { email: email('matrix'), role: 'operator' } }) },
  { route: 'POST /v1/platform/tenants/:tenantId/members/:memberId/password-reset', allow: ['platformAdmin'],
    request: () => ({ method: 'POST', url: `/v1/platform/tenants/${randomUUID()}/members/${randomUUID()}/password-reset` }) },
  { route: 'GET /v1/platform/authoring-tokens', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: '/v1/platform/authoring-tokens' }) },
  { route: 'POST /v1/platform/authoring-tokens', allow: ['platformAdmin'],
    request: () => ({ method: 'POST', url: '/v1/platform/authoring-tokens', body: { label: '矩阵', tenantIds: [randomUUID()] } }) },
  { route: 'DELETE /v1/platform/authoring-tokens/:tokenId', allow: ['platformAdmin'], request: () => ({ method: 'DELETE', url: `/v1/platform/authoring-tokens/${randomUUID()}` }) },
  { route: 'GET /v1/tenant', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/tenant' }) },
  { route: 'GET /v1/members', allow: ['admin'], request: () => ({ method: 'GET', url: '/v1/members' }) },
  { route: 'PATCH /v1/members/:memberId', allow: ['admin'], request: () => ({ method: 'PATCH', url: `/v1/members/${randomUUID()}`, body: { role: 'operator' } }) },
  { route: 'GET /v1/api-keys', allow: ['admin'], request: () => ({ method: 'GET', url: '/v1/api-keys' }) },
  { route: 'POST /v1/api-keys', allow: ['admin'], request: () => ({ method: 'POST', url: '/v1/api-keys', body: { name: '矩阵' } }) },
  { route: 'DELETE /v1/api-keys/:keyId', allow: ['admin'], request: () => ({ method: 'DELETE', url: `/v1/api-keys/${randomUUID()}` }) },
  { route: 'GET /v1/audit-events', allow: ['admin'], request: () => ({ method: 'GET', url: '/v1/audit-events' }) },
  { route: 'GET /v1/audit-events/export.csv', allow: ['admin'], request: () => ({ method: 'GET', url: '/v1/audit-events/export.csv' }) },
  { route: 'GET /v1/authoring/tenants/:tenantId', allow: ['authoringEngineer'], request: (world) => ({ method: 'GET', url: `/v1/authoring/tenants/${world.a.id}` }) },
  { route: 'GET /v1/authoring/tenants/:tenantId/workspace', allow: ['authoringEngineer'], request: (world) => ({ method: 'GET', url: `/v1/authoring/tenants/${world.a.id}/workspace` }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/push-plans', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'POST', url: `/v1/authoring/tenants/${world.a.id}/push-plans`, body: { documents: [], resources: [] } }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/pushes', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'POST', url: `/v1/authoring/tenants/${world.a.id}/pushes`, body: { documents: [], resources: [] } }) },
  { route: 'PUT /v1/authoring/tenants/:tenantId/contents/:sha256', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'PUT', url: `/v1/authoring/tenants/${world.a.id}/contents/${SAMPLE_SHA256}`, body: SAMPLE }) },
  { route: 'GET /v1/authoring/tenants/:tenantId/contents/:sha256', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'GET', url: `/v1/authoring/tenants/${world.a.id}/contents/${SAMPLE_SHA256}` }) },
  { route: 'GET /v1/templates', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/templates' }) },
  { route: 'GET /v1/templates/:name', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/templates/${encodeURIComponent('问候牌')}` }) },
  // 预览请求用不存在的模板：入队前就答问题清单，不需要 worker。
  { route: 'POST /v1/previews', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/previews', body: BLOCKED_PREVIEW }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/previews', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'POST', url: `/v1/authoring/tenants/${world.a.id}/previews`, body: BLOCKED_PREVIEW }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/template-current', allow: ['authoringEngineer'],
    request: (world) => ({ method: 'POST', url: `/v1/authoring/tenants/${world.a.id}/template-current`, body: { template: '矩阵', revision: 1 } }) },
  // 批量交付（票据 07）：提交用不存在的模板，整批拒绝，不需要 worker。
  { route: 'POST /v1/batches', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/batches', body: BLOCKED_BATCH }) },
  { route: 'GET /v1/batches/:batchId', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/batches/${randomUUID()}` }) },
  { route: 'POST /v1/batches/:batchId/cancel', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: `/v1/batches/${randomUUID()}/cancel` }) },
  // 数据集与资源（票据 10）：对象 ID 用随机值；数据集的请求体按 JSON 原文发送。
  { route: 'GET /v1/static-schemas', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/static-schemas' }) },
  { route: 'GET /v1/static-schemas/:name/versions/:version', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'GET', url: `/v1/static-schemas/${encodeURIComponent('问候')}/versions/1` }) },
  { route: 'GET /v1/static-schemas/:name/versions/:version/workbook', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'GET', url: `/v1/static-schemas/${encodeURIComponent('问候')}/versions/1/workbook` }) },
  // Excel 导入（票据 13）：用不存在的模板，读工作簿之前就答问题清单。
  { route: 'POST /v1/excel-imports', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/excel-imports', body: BLOCKED_IMPORT }) },
  { route: 'GET /v1/datasets', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/datasets' }) },
  { route: 'GET /v1/datasets/:datasetId', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/datasets/ds-${randomUUID()}` }) },
  { route: 'POST /v1/datasets', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/datasets', body: MATRIX_DATASET }) },
  { route: 'PUT /v1/datasets/:datasetId', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'PUT', url: '/v1/datasets/ds-matrix', body: MATRIX_DATASET }) },
  { route: 'POST /v1/datasets/:datasetId/copies', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'POST', url: `/v1/datasets/ds-${randomUUID()}/copies`, body: { id: 'ds-matrix-copy' } }) },
  { route: 'POST /v1/dataset-checks', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/dataset-checks', body: MATRIX_DATASET }) },
  { route: 'GET /v1/resources', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/resources' }) },
  { route: 'GET /v1/resources/:resourceId', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/resources/r${randomUUID()}` }) },
  { route: 'GET /v1/resources/:resourceId/versions/:version/content', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'GET', url: `/v1/resources/r${randomUUID()}/versions/1/content` }) },
  { route: 'POST /v1/resources', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'POST', url: `/v1/resources?kind=image&id=r${randomUUID()}`, body: SAMPLE }) },
  { route: 'POST /v1/resources/:resourceId/replacement-checks', allow: ['admin'],
    request: () => ({ method: 'POST', url: `/v1/resources/r${randomUUID()}/replacement-checks`, body: SAMPLE }) },
  { route: 'POST /v1/resources/:resourceId/replacements', allow: ['admin'],
    request: () => ({ method: 'POST', url: `/v1/resources/r${randomUUID()}/replacements`, body: { check: replacementCheck(`r${randomUUID()}`) } }) },
  // 出图记录（票据 08）：批次 ID 用随机值。
  { route: 'GET /v1/records', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/records' }) },
  { route: 'GET /v1/batches/:batchId/items/:index/files/:name', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'GET', url: `/v1/batches/${randomUUID()}/items/1/files/image.png` }) },
  { route: 'GET /v1/batches/:batchId/images.zip', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/batches/${randomUUID()}/images.zip` }) },
  { route: 'GET /v1/batches/:batchId/export.zip', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/batches/${randomUUID()}/export.zip` }) },
  { route: 'GET /v1/batches/:batchId/items/:index/export.zip', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'GET', url: `/v1/batches/${randomUUID()}/items/1/export.zip` }) },
  { route: 'POST /v1/batches/:batchId/items/:index/replay', allow: ['admin', 'operator', 'apiKey'],
    request: () => ({ method: 'POST', url: `/v1/batches/${randomUUID()}/items/1/replay` }) },
  { route: 'GET /v1/platform/builds', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: '/v1/platform/builds' }) },
  // 计量与额度（票据 09）：本租户一个周期的用量合计客户成员与 API 密钥都能看（M300），明细只给客户管理员；
  // 平台管理员设套餐、看任一租户的用量，租户 ID 用随机值。
  { route: 'GET /v1/usage', allow: ['admin', 'operator', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/usage' }) },
  { route: 'GET /v1/usage/events', allow: ['admin'], request: () => ({ method: 'GET', url: '/v1/usage/events' }) },
  { route: 'GET /v1/platform/tenants/:tenantId/plan', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: `/v1/platform/tenants/${randomUUID()}/plan` }) },
  { route: 'PUT /v1/platform/tenants/:tenantId/plan', allow: ['platformAdmin'],
    request: () => ({ method: 'PUT', url: `/v1/platform/tenants/${randomUUID()}/plan`, body: { monthlyImages: 1, maxPixels: 1, concurrency: 1 } }) },
  { route: 'GET /v1/platform/tenants/:tenantId/usage', allow: ['platformAdmin'], request: () => ({ method: 'GET', url: `/v1/platform/tenants/${randomUUID()}/usage` }) },
  { route: 'GET /v1/platform/tenants/:tenantId/usage/events', allow: ['platformAdmin'],
    request: () => ({ method: 'GET', url: `/v1/platform/tenants/${randomUUID()}/usage/events` }) },
  // webhook（票据 11）：客户管理员与 API 密钥；注册用不合规的 URL，允许的身份答 400，不留下 webhook。
  { route: 'GET /v1/webhooks', allow: ['admin', 'apiKey'], request: () => ({ method: 'GET', url: '/v1/webhooks' }) },
  { route: 'POST /v1/webhooks', allow: ['admin', 'apiKey'], request: () => ({ method: 'POST', url: '/v1/webhooks', body: { url: 'ftp://example.com/matrix' } }) },
  { route: 'GET /v1/webhooks/:webhookId', allow: ['admin', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/webhooks/${randomUUID()}` }) },
  { route: 'PATCH /v1/webhooks/:webhookId', allow: ['admin', 'apiKey'], request: () => ({ method: 'PATCH', url: `/v1/webhooks/${randomUUID()}`, body: { active: false } }) },
  { route: 'GET /v1/webhooks/:webhookId/deliveries', allow: ['admin', 'apiKey'], request: () => ({ method: 'GET', url: `/v1/webhooks/${randomUUID()}/deliveries` }) },
];

export function describeApi(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`开放 API：账号、租户与鉴权（${name}）`, () => {
    let world: World;
    beforeAll(async () => { world = await createWorld(await makeBackend()); });

    it('平台管理员开通租户与成员账号；成员用邮箱加密码登录，密码以慢哈希保存', async () => {
      const { call, a, b, platform, backend } = world;
      expect(await call('GET', '/v1/me', a.operator.token)).toMatchObject({ status: 200, body: { kind: 'member', role: 'operator', tenantId: a.id, email: a.operator.email } });
      const login = (await backend.platform.findLogin(a.operator.email))!;
      expect(login.passwordHash).toMatch(/^scrypt\$1024\$8\$1\$/);
      expect(login.passwordHash).not.toContain(a.operator.password);
      expect((await call('POST', '/v1/sessions', undefined, { email: a.operator.email.toUpperCase(), password: a.operator.password })).status).toBe(201);
      const taken = await call('POST', `/v1/platform/tenants/${b.id}/members`, platform, { email: a.operator.email, role: 'operator' });
      expect(taken).toMatchObject({ status: 409, body: { problems: [{ code: 'member.emailTaken', level: 'severe' }] } });
      expect((await call('POST', `/v1/platform/tenants/${randomUUID()}/members`, platform, { email: email('nobody'), role: 'operator' })).status).toBe(404);
      const tenants = await call('GET', '/v1/platform/tenants', platform);
      expect(tenants.body.tenants.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([a.id, b.id]));
    });

    it('登录失败不区分邮箱不存在与密码错误；登出与过期的会话立即失效', async () => {
      const { call, clock, login, a } = world;
      const unknown = await call('POST', '/v1/sessions', undefined, { email: email('nobody'), password: 'whatever-password' });
      const wrong = await call('POST', '/v1/sessions', undefined, { email: a.operator.email, password: 'wrong-password' });
      expect(unknown).toMatchObject({ status: 401, body: { problems: [{ code: 'auth.invalidCredentials' }] } });
      expect(wrong.raw).toBe(unknown.raw);
      const session = await login(a.operator.email, a.operator.password);
      expect((await call('DELETE', '/v1/sessions/current', session)).status).toBe(204);
      expect(await call('GET', '/v1/me', session)).toMatchObject({ status: 401, body: { problems: [{ code: 'auth.required' }] } });
      const expiring = await login(a.operator.email, a.operator.password);
      const start = clock.value;
      try {
        clock.value = new Date(start.getTime() + 11 * 3_600_000);
        expect((await call('GET', '/v1/me', expiring)).status).toBe(200);
        clock.value = new Date(start.getTime() + 13 * 3_600_000);
        expect((await call('GET', '/v1/me', expiring)).status).toBe(401);
      } finally { clock.value = start; }
      for (const token of [undefined, 'not-a-token', `rws_${'x'.repeat(43)}`]) expect((await call('GET', '/v1/me', token)).status).toBe(401);
    });

    it('平台管理员重置密码：新密码只显示一次，旧密码与旧会话立即失效', async () => {
      const { call, member, platform, login, a, b } = world;
      const person = await member(b.id, 'operator');
      const reset = await call('POST', `/v1/platform/tenants/${b.id}/members/${person.id}/password-reset`, platform);
      expect(reset.status).toBe(200);
      world.secrets.push(reset.body.password);
      expect((await call('POST', '/v1/sessions', undefined, { email: person.email, password: person.password })).status).toBe(401);
      expect((await call('GET', '/v1/me', person.token)).status).toBe(401);
      await login(person.email, reset.body.password);
      expect((await call('POST', `/v1/platform/tenants/${a.id}/members/${person.id}/password-reset`, platform)).status).toBe(404);
    });

    it('客户管理员管理本租户的成员与角色；停用即吊销会话；至少保留一个启用的管理员', async () => {
      const { call, member, a, b } = world;
      const listed = await call('GET', '/v1/members', a.admin.token);
      expect(listed.body.members.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([a.admin.id, a.operator.id]));
      expect(ids(listed.body)).not.toContain(b.admin.id);
      expect(await call('PATCH', `/v1/members/${a.operator.id}`, a.admin.token, { role: 'admin' })).toMatchObject({ status: 200, body: { role: 'admin' } });
      expect(await call('GET', '/v1/members', a.operator.token)).toMatchObject({ status: 200 });
      expect(await call('PATCH', `/v1/members/${a.operator.id}`, a.admin.token, { role: 'operator' })).toMatchObject({ status: 200, body: { role: 'operator' } });
      expect((await call('GET', '/v1/members', a.operator.token)).status).toBe(403);

      const leaving = await member(a.id, 'operator');
      expect(await call('PATCH', `/v1/members/${leaving.id}`, a.admin.token, { active: false })).toMatchObject({ status: 200, body: { active: false } });
      expect((await call('GET', '/v1/me', leaving.token)).status).toBe(401);
      expect((await call('POST', '/v1/sessions', undefined, { email: leaving.email, password: leaving.password })).status).toBe(401);
      // 重新启用后，停用前的会话仍然无效：停用时已吊销，不是只靠账号状态挡住。
      expect(await call('PATCH', `/v1/members/${leaving.id}`, a.admin.token, { active: true })).toMatchObject({ status: 200, body: { active: true } });
      expect((await call('GET', '/v1/me', leaving.token)).status).toBe(401);
      expect((await call('POST', '/v1/sessions', undefined, { email: leaving.email, password: leaving.password })).status).toBe(201);

      for (const change of [{ active: false }, { role: 'operator' }]) {
        expect(await call('PATCH', `/v1/members/${a.admin.id}`, a.admin.token, change)).toMatchObject({ status: 409, body: { problems: [{ code: 'member.lastAdmin' }] } });
      }
      expect((await call('PATCH', `/v1/members/${a.operator.id}`, a.admin.token, {})).status).toBe(400);
      expect(await call('PATCH', `/v1/members/${a.operator.id}`, a.admin.token, { role: 'owner' })).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
      expect((await call('PATCH', '/v1/members/../../platform/tenants', a.admin.token, { role: 'admin' })).status).toBe(404);
    });

    it('API 密钥：只在创建时显示一次，服务端只存哈希；带密钥的请求有操作员权限；吊销后立即失效', async () => {
      const { call, a } = world;
      const created = await call('POST', '/v1/api-keys', a.admin.token, { name: '集成' });
      expect(created).toMatchObject({ status: 201, body: { apiKey: { name: '集成' } } });
      const key: string = created.body.key;
      world.secrets.push(key);
      expect(key).toMatch(/^rwk_[A-Za-z0-9_-]{43}$/);
      expect(key.startsWith(created.body.apiKey.prefix)).toBe(true);
      const listed = await call('GET', '/v1/api-keys', a.admin.token);
      expect(listed.raw).not.toContain(key);
      expect(listed.body.apiKeys.find((k: { id: string }) => k.id === created.body.apiKey.id)).toEqual(created.body.apiKey);
      expect(await call('GET', '/v1/tenant', key)).toMatchObject({ status: 200, body: { id: a.id } });
      expect(await call('GET', '/v1/me', key)).toMatchObject({ status: 200, body: { kind: 'apiKey', tenantId: a.id, name: '集成' } });
      expect((await call('DELETE', `/v1/api-keys/${created.body.apiKey.id}`, a.admin.token)).status).toBe(204);
      expect((await call('GET', '/v1/tenant', key)).status).toBe(401);
      const after = await call('GET', '/v1/api-keys', a.admin.token);
      expect(after.body.apiKeys.find((k: { id: string }) => k.id === created.body.apiKey.id).revokedAt).toBeTruthy();
    });

    it('代建令牌只能访问被指定的租户；吊销或过期后立即失效', async () => {
      const { call, clock, platform, a, b } = world;
      expect(await call('GET', `/v1/authoring/tenants/${a.id}`, a.engineer.token)).toMatchObject({ status: 200, body: { id: a.id } });
      const other = await call('GET', `/v1/authoring/tenants/${b.id}`, a.engineer.token);
      const random = await call('GET', `/v1/authoring/tenants/${randomUUID()}`, a.engineer.token);
      expect(other.status).toBe(404);
      expect(other.raw).toBe(random.raw);
      for (const url of ['/v1/tenant', '/v1/members', '/v1/platform/tenants']) expect((await call('GET', url, a.engineer.token)).status).toBe(403);

      const issued = await call('POST', '/v1/platform/authoring-tokens', platform, { label: '临时', tenantIds: [a.id], expiresInDays: 1 });
      world.secrets.push(issued.body.token);
      expect(issued.body.authoringToken).toMatchObject({ tenantIds: [a.id], label: '临时' });
      const start = clock.value;
      try {
        clock.value = new Date(start.getTime() + 2 * 86_400_000);
        expect((await call('GET', `/v1/authoring/tenants/${a.id}`, issued.body.token)).status).toBe(401);
      } finally { clock.value = start; }
      expect((await call('DELETE', `/v1/platform/authoring-tokens/${issued.body.authoringToken.id}`, platform)).status).toBe(204);
      expect((await call('GET', `/v1/authoring/tenants/${a.id}`, issued.body.token)).status).toBe(401);
      const tokens = await call('GET', '/v1/platform/authoring-tokens', platform);
      expect(tokens.raw).not.toContain(issued.body.token);
    });

    it('权限矩阵（M247）：五种身份逐项覆盖；每个需要鉴权的端点都在矩阵里', async () => {
      expect(ROLE_PERMISSIONS).toEqual(MATRIX);
      const { app, call, login, a } = world;
      const routes = app.routeTable.filter((route) => route.access !== 'public').map((route) => `${route.method} ${route.url}`).sort();
      expect(ENDPOINTS.map((endpoint) => endpoint.route).sort()).toEqual(routes);
      for (const endpoint of ENDPOINTS) {
        // 登出会吊销调用者的会话：每个端点都给会话身份新登录一次。
        const tokens: Record<IdentityRole, string> = {
          platformAdmin: await login(world.platformLogin.email, world.platformLogin.password),
          admin: await login(a.admin.email, a.admin.password),
          operator: await login(a.operator.email, a.operator.password),
          apiKey: a.key.token,
          authoringEngineer: a.engineer.token,
        };
        const { method, url, body } = endpoint.request(world);
        expect((await call(method, url, undefined, body)).status, `${endpoint.route} 匿名`).toBe(401);
        for (const role of Object.keys(MATRIX) as IdentityRole[]) {
          const status = (await call(method, url, tokens[role], body)).status;
          if (endpoint.allow.includes(role)) expect([401, 403], `${endpoint.route} ${role}`).not.toContain(status);
          else expect(status, `${endpoint.route} ${role}`).toBe(403);
        }
      }
    });

    it('跨租户端点清单：另一租户的会话、密钥与代建令牌被拒绝，也不泄露对象是否存在', async () => {
      const { app, call, a, b } = world;
      const listed = new Set(CROSS_TENANT_ENDPOINTS.map((endpoint) => endpoint.route));
      const missing = app.routeTable.filter((route) => !EXEMPT_ACCESS.has(route.access) && !listed.has(`${route.method} ${route.url}`));
      expect(missing, '能触及租户数据的端点都要加进跨租户端点清单').toEqual([]);
      // A 的一个批次：没有 worker 时停在排队中，照样能查、能取消。
      const batch = await call('POST', '/v1/batches', a.key.token, { ...BLOCKED_BATCH, template: '问候牌' });
      expect(batch.status, batch.raw.slice(0, 300)).toBe(202);
      // A 的一个资源（数据集用推送进来的 ds-greeting）。
      expect((await call('POST', '/v1/resources?kind=image&id=a-logo', a.operator.token, SAMPLE)).status).toBe(201);
      // A 的一个 webhook（停用的，不会投递）。
      const hook = await call('POST', '/v1/webhooks', a.admin.token, { url: 'https://example.com/a-hook' });
      expect(hook.status, hook.raw.slice(0, 300)).toBe(201);
      world.secrets.push(hook.body.secret);
      expect((await call('PATCH', `/v1/webhooks/${hook.body.webhook.id}`, a.admin.token, { active: false })).status).toBe(200);
      const objects: TenantObjects = { tenantId: a.id, memberId: a.operator.id, apiKeyId: a.key.id, templateName: '问候牌', staticSchemaName: '问候', batchId: batch.body.id, datasetId: 'ds-greeting', resourceId: 'a-logo',
        webhookId: hook.body.webhook.id };
      const random: TenantObjects = { tenantId: randomUUID(), memberId: randomUUID(), apiKeyId: randomUUID(), templateName: `模板-${randomUUID()}`, staticSchemaName: `定义-${randomUUID()}`, batchId: randomUUID(),
        datasetId: `ds-${randomUUID()}`, resourceId: `r${randomUUID()}`, webhookId: randomUUID() };
      const aIds = [a.id, a.admin.id, a.operator.id, a.key.id, a.engineer.id, batch.body.id, hook.body.webhook.id];
      for (const endpoint of CROSS_TENANT_ENDPOINTS) {
        for (const [who, token] of [['B 的管理员', b.admin.token], ['B 的操作员', b.operator.token], ['B 的密钥', b.key.token], ['B 的代建令牌', b.engineer.token]] as const) {
          const request = endpoint.request(objects);
          const reply = await call(request.method, request.url, token, request.body);
          if (endpoint.addressesObject) {
            const control = endpoint.request(random);
            const expected = await call(control.method, control.url, token, control.body);
            expect([403, 404], `${endpoint.route} ${who}`).toContain(reply.status);
            expect(reply.raw, `${endpoint.route} ${who}`).toBe(expected.raw);
          } else {
            for (const id of aIds) expect(reply.raw, `${endpoint.route} ${who}`).not.toContain(id);
          }
        }
      }
      // A 的对象没有被另一租户改动：A 的密钥仍然有效，A 的操作员仍是操作员，A 的数据集与资源照旧。
      expect((await call('GET', '/v1/tenant', a.key.token)).status).toBe(200);
      expect((await call('GET', '/v1/me', a.operator.token)).body.role).toBe('operator');
      expect((await call('GET', '/v1/datasets/ds-greeting', a.operator.token)).body.data).toEqual({ message: '欢迎乘坐 M402 路' });
      expect((await call('GET', '/v1/resources/a-logo', a.operator.token)).body.currentVersion).toBe(1);
      expect((await call('GET', `/v1/webhooks/${hook.body.webhook.id}`, a.admin.token)).body).toMatchObject({ url: 'https://example.com/a-hook', active: false });
    });

    it('审计：写操作与跨租户操作追加写入，不记密钥；客户管理员只能看本租户；可以分页', async () => {
      const { call, a, b } = world;
      const all: any[] = [];
      let next: string | undefined;
      do {
        const page = await call('GET', `/v1/audit-events?limit=5${next ? `&before=${next}` : ''}`, a.admin.token);
        expect(page.status).toBe(200);
        expect(page.body.events.length).toBeLessThanOrEqual(5);
        all.push(...page.body.events);
        next = page.body.next;
      } while (next);
      expect(new Set(all.map((event) => event.id)).size).toBe(all.length);
      const find = (action: string) => all.filter((event) => event.action === action);
      expect(find('tenant.create')[0]).toMatchObject({ tenantId: a.id, actor: { kind: 'platformUser' }, object: { type: 'tenant', id: a.id }, crossTenant: true });
      expect(find('member.create').map((event) => event.object.id)).toEqual(expect.arrayContaining([a.admin.id, a.operator.id]));
      expect(find('member.create').every((event) => event.crossTenant)).toBe(true);
      expect(find('session.create').some((event) => event.actor.id === a.operator.id && !event.crossTenant)).toBe(true);
      expect(find('apiKey.create')[0]).toMatchObject({ actor: { kind: 'member', id: a.admin.id }, crossTenant: false });
      expect(find('authoring.access')[0]).toMatchObject({ actor: { kind: 'authoringToken', id: a.engineer.id }, crossTenant: true });
      const text = JSON.stringify(all);
      for (const secret of world.secrets) expect(text).not.toContain(secret);
      for (const id of [b.id, b.admin.id, b.key.id]) expect(text).not.toContain(id);
      for (const token of [a.operator.token, a.key.token]) expect((await call('GET', '/v1/audit-events', token)).status).toBe(403);
      expect((await call('GET', '/v1/audit-events?before=abc', a.admin.token)).status).toBe(400);
    });

    it('请求校验：问题清单带问题码、等级与位置；未知端点答 404', async () => {
      const { call, platform } = world;
      const empty = await call('POST', '/v1/sessions', undefined, {});
      expect(empty).toMatchObject({ status: 400, body: { problems: [{ level: 'severe', code: 'request.invalid', location: { kind: 'input', source: 'request.body' } }] } });
      const extra = await call('POST', '/v1/platform/tenants', platform, { name: 'x', tier: 'gold' });
      expect(extra.body.problems[0]).toMatchObject({ code: 'request.invalid', message: expect.stringContaining('tier') });
      expect(await call('GET', '/v1/nothing', platform)).toMatchObject({ status: 404, body: { problems: [{ code: 'request.notFound' }] } });
    });

    it('密钥、令牌与密码不进日志；日志每行是 JSON', () => {
      expect(world.logs.length).toBeGreaterThan(0);
      for (const line of world.logs) expect(() => JSON.parse(line)).not.toThrow();
      const text = world.logs.join('\n');
      for (const secret of world.secrets) expect(text).not.toContain(secret);
    });
  });
}
