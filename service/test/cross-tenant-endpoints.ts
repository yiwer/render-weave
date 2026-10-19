/**
 * 跨租户端点清单（票据 04，ADR-0018 的两道防线）：凡是能触及租户数据的端点都列在这里。
 * API 用例对每一项用另一租户的会话、API 密钥与代建令牌访问：
 * - 路径里带对象 ID 的，回答必须与访问随机 ID 完全相同，被拒绝且不泄露对象是否存在；
 * - 不带对象 ID 的（本租户由身份决定），回答里不能出现另一租户的任何 ID。
 * 后续票据新增端点时把它加进这张清单；用例会核对已注册的路由，漏列的端点让测试失败。
 */
import { createHash } from 'node:crypto';

/** 租户 A 的对象，用来构造请求。 */
export interface TenantObjects {
  readonly tenantId: string;
  readonly memberId: string;
  readonly apiKeyId: string;
}

export interface CrossTenantEndpoint {
  /** 与路由表一致：方法加路径模板。 */
  readonly route: string;
  /** 请求体是字节时按 application/octet-stream 发送。 */
  request(objects: TenantObjects): { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly url: string; readonly body?: unknown };
  /** 路径里有没有对象 ID：有就与随机 ID 比较，没有就检查回答里不出现另一租户的 ID。 */
  readonly addressesObject: boolean;
}

export const CROSS_TENANT_ENDPOINTS: readonly CrossTenantEndpoint[] = [
  { route: 'GET /v1/tenant', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/tenant' }) },
  { route: 'GET /v1/members', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/members' }) },
  { route: 'PATCH /v1/members/:memberId', addressesObject: true, request: (a) => ({ method: 'PATCH', url: `/v1/members/${a.memberId}`, body: { role: 'admin' } }) },
  { route: 'GET /v1/api-keys', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/api-keys' }) },
  { route: 'POST /v1/api-keys', addressesObject: false, request: () => ({ method: 'POST', url: '/v1/api-keys', body: { name: '跨租户检查' } }) },
  { route: 'DELETE /v1/api-keys/:keyId', addressesObject: true, request: (a) => ({ method: 'DELETE', url: `/v1/api-keys/${a.apiKeyId}` }) },
  { route: 'GET /v1/audit-events', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/audit-events' }) },
  { route: 'GET /v1/authoring/tenants/:tenantId', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/authoring/tenants/${a.tenantId}` }) },
  // 代建推送（票据 05）：目标租户写在路径里，只认令牌被指定的租户。
  { route: 'GET /v1/authoring/tenants/:tenantId/workspace', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/authoring/tenants/${a.tenantId}/workspace` }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/push-plans', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/authoring/tenants/${a.tenantId}/push-plans`, body: { documents: [], resources: [] } }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/pushes', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/authoring/tenants/${a.tenantId}/pushes`, body: { documents: [], resources: [] } }) },
  { route: 'PUT /v1/authoring/tenants/:tenantId/contents/:sha256', addressesObject: true,
    request: (a) => ({ method: 'PUT', url: `/v1/authoring/tenants/${a.tenantId}/contents/${SAMPLE_SHA256}`, body: SAMPLE }) },
  { route: 'GET /v1/authoring/tenants/:tenantId/contents/:sha256', addressesObject: true,
    request: (a) => ({ method: 'GET', url: `/v1/authoring/tenants/${a.tenantId}/contents/${SAMPLE_SHA256}` }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/template-current', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/authoring/tenants/${a.tenantId}/template-current`, body: { template: '问候牌', revision: 1 } }) },
];

/** 上传内容的样例：几个字节与它的 SHA-256。 */
const SAMPLE = new Uint8Array(Buffer.from('跨租户检查'));
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE).digest('hex');

/**
 * 不进清单的路由按访问要求判断：公开端点、只看身份自己的端点（/v1/me、登出），
 * 以及平台管理员专用的端点（本来就跨租户，每次操作都记进目标租户的审计）。
 */
export const EXEMPT_ACCESS = new Set(['public', 'authenticated', 'session', 'platform.tenants', 'platform.members', 'platform.authoringTokens', 'platform.plans']);
