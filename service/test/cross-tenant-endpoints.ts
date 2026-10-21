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
  readonly templateName: string;
  /** 静态数据定义的名称（版本 1）。 */
  readonly staticSchemaName: string;
  readonly batchId: string;
  readonly datasetId: string;
  readonly resourceId: string;
  readonly webhookId: string;
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
  // 模板与草稿预览（票据 06）：客户端点的租户由身份决定；代建端点在路径里写目标租户。
  { route: 'GET /v1/templates', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/templates' }) },
  { route: 'GET /v1/templates/:name', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/templates/${encodeURIComponent(a.templateName)}` }) },
  { route: 'POST /v1/previews', addressesObject: false, request: (a) => ({ method: 'POST', url: '/v1/previews', body: preview(a.templateName) }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/previews', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/authoring/tenants/${a.tenantId}/previews`, body: preview(a.templateName) }) },
  { route: 'POST /v1/authoring/tenants/:tenantId/template-current', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/authoring/tenants/${a.tenantId}/template-current`, body: { template: '问候牌', revision: 1 } }) },
  // 批量交付（票据 07）：提交的租户由身份决定；批次 ID 在路径里，别的租户的批次与不存在的同样答 404。
  { route: 'POST /v1/batches', addressesObject: false, request: (a) => ({ method: 'POST', url: '/v1/batches', body: batch(a.templateName) }) },
  { route: 'GET /v1/batches/:batchId', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/batches/${a.batchId}` }) },
  { route: 'POST /v1/batches/:batchId/cancel', addressesObject: true, request: (a) => ({ method: 'POST', url: `/v1/batches/${a.batchId}/cancel` }) },
  // 数据集与资源（票据 10）：租户由身份决定；数据集 ID 与资源 ID 在路径里，别的租户的与不存在的同样答 404。
  // 静态数据定义（票据 12）：只读；别的租户的与不存在的同样答 404。
  { route: 'GET /v1/static-schemas', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/static-schemas' }) },
  { route: 'GET /v1/static-schemas/:name/versions/:version', addressesObject: true,
    request: (a) => ({ method: 'GET', url: `/v1/static-schemas/${encodeURIComponent(a.staticSchemaName)}/versions/1` }) },
  { route: 'GET /v1/static-schemas/:name/versions/:version/workbook', addressesObject: true,
    request: (a) => ({ method: 'GET', url: `/v1/static-schemas/${encodeURIComponent(a.staticSchemaName)}/versions/1/workbook` }) },
  // Excel 导入（票据 13）：租户由身份决定，模板名写在请求体里；另一租户没有这个模板，答问题清单。
  { route: 'POST /v1/excel-imports', addressesObject: false,
    request: (a) => ({ method: 'POST', url: '/v1/excel-imports', body: { template: a.templateName, workbook: 'UEsDBA==', output: { width: 160, height: 40, dpi: 120, format: 'png' } } }) },
  { route: 'GET /v1/datasets', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/datasets' }) },
  { route: 'POST /v1/datasets', addressesObject: false, request: (a) => ({ method: 'POST', url: '/v1/datasets', body: dataset(a.datasetId) }) },
  { route: 'POST /v1/dataset-checks', addressesObject: false, request: (a) => ({ method: 'POST', url: '/v1/dataset-checks', body: dataset(a.datasetId) }) },
  { route: 'GET /v1/datasets/:datasetId', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/datasets/${encodeURIComponent(a.datasetId)}` }) },
  { route: 'PUT /v1/datasets/:datasetId', addressesObject: true,
    request: (a) => ({ method: 'PUT', url: `/v1/datasets/${encodeURIComponent(a.datasetId)}`, body: dataset(a.datasetId) }) },
  { route: 'POST /v1/datasets/:datasetId/copies', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/datasets/${encodeURIComponent(a.datasetId)}/copies`, body: { id: 'ds-cross-tenant-copy' } }) },
  { route: 'GET /v1/resources', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/resources' }) },
  // 上传新资源不指定 ID：用 A 的资源 ID 会在另一租户建一个同名资源，之后按 ID 访问就不再是"不存在"。
  { route: 'POST /v1/resources', addressesObject: false, request: () => ({ method: 'POST', url: '/v1/resources?kind=image', body: SAMPLE }) },
  { route: 'GET /v1/resources/:resourceId', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/resources/${a.resourceId}` }) },
  { route: 'GET /v1/resources/:resourceId/versions/:version/content', addressesObject: true,
    request: (a) => ({ method: 'GET', url: `/v1/resources/${a.resourceId}/versions/1/content` }) },
  { route: 'POST /v1/resources/:resourceId/replacement-checks', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/resources/${a.resourceId}/replacement-checks`, body: SAMPLE }) },
  { route: 'POST /v1/resources/:resourceId/replacements', addressesObject: true,
    request: (a) => ({ method: 'POST', url: `/v1/resources/${a.resourceId}/replacements`, body: { check: replacementCheck(a.resourceId) } }) },
  // 出图记录（票据 08）：查询的租户由身份决定；批次 ID 在路径里，别的租户的批次与不存在的同样答 404。
  { route: 'GET /v1/records', addressesObject: false, request: (a) => ({ method: 'GET', url: `/v1/records?batchId=${a.batchId}` }) },
  { route: 'GET /v1/batches/:batchId/items/:index/files/:name', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/batches/${a.batchId}/items/1/files/problems.json` }) },
  { route: 'GET /v1/batches/:batchId/images.zip', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/batches/${a.batchId}/images.zip` }) },
  { route: 'GET /v1/batches/:batchId/export.zip', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/batches/${a.batchId}/export.zip` }) },
  { route: 'GET /v1/batches/:batchId/items/:index/export.zip', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/batches/${a.batchId}/items/1/export.zip` }) },
  { route: 'POST /v1/batches/:batchId/items/:index/replay', addressesObject: true, request: (a) => ({ method: 'POST', url: `/v1/batches/${a.batchId}/items/1/replay` }) },
  // 计量与额度（票据 09）：用量的租户由身份决定，回答里不能有另一租户的批次与 ID。
  { route: 'GET /v1/usage', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/usage' }) },
  { route: 'GET /v1/usage/events', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/usage/events' }) },
  // webhook（票据 11）：租户由身份决定；webhook ID 在路径里，别的租户的与不存在的同样答 404。
  { route: 'GET /v1/webhooks', addressesObject: false, request: () => ({ method: 'GET', url: '/v1/webhooks' }) },
  { route: 'POST /v1/webhooks', addressesObject: false, request: () => ({ method: 'POST', url: '/v1/webhooks', body: { url: 'https://example.com/cross-tenant' } }) },
  { route: 'GET /v1/webhooks/:webhookId', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/webhooks/${a.webhookId}` }) },
  { route: 'PATCH /v1/webhooks/:webhookId', addressesObject: true, request: (a) => ({ method: 'PATCH', url: `/v1/webhooks/${a.webhookId}`, body: { active: false } }) },
  { route: 'GET /v1/webhooks/:webhookId/deliveries', addressesObject: true, request: (a) => ({ method: 'GET', url: `/v1/webhooks/${a.webhookId}/deliveries` }) },
];

/** 用 A 的数据集 ID 写一份数据集；另一租户没有它的数据定义，保存答 400。 */
const dataset = (id: string) => ({ dataset: { id, staticSchema: { name: '问候', version: 1 } }, data: { message: '跨租户检查' } });
/** 结构完整的替换检查报告：资源不在本租户时答 404。 */
const replacementCheck = (id: string) => ({
  resource: { id, kind: 'image', version: 1, sha256: SAMPLE_SHA256, byteLength: SAMPLE.length },
  replacement: { sha256: SAMPLE_SHA256, byteLength: SAMPLE.length },
  impact: { workspaceFingerprint: SAMPLE_SHA256, renderOptions: { fallbackFonts: [], svgFonts: [] }, references: [], configuration: [], scope: '' },
});

/** 用 A 的模板名预览；另一租户没有这个模板，入队前就答问题清单。 */
const preview = (template: string) => ({ template, dataset: { id: 'ds-greeting' }, output: { width: 160, height: 40, dpi: 120, format: 'png' } });
/** 用 A 的模板名提交批次；另一租户没有这个模板，整批拒绝。 */
const batch = (template: string) => ({ template, items: [{ id: '1', dataset: { id: 'ds-greeting' }, output: { width: 160, height: 40, dpi: 120, format: 'png' } }] });

/** 上传内容的样例：几个字节与它的 SHA-256。 */
const SAMPLE = new Uint8Array(Buffer.from('跨租户检查'));
const SAMPLE_SHA256 = createHash('sha256').update(SAMPLE).digest('hex');

/**
 * 不进清单的路由按访问要求判断：公开端点、只看身份自己的端点（/v1/me、登出），
 * 以及平台管理员专用的端点（本来就跨租户，每次操作都记进目标租户的审计）。
 */
export const EXEMPT_ACCESS = new Set(['public', 'authenticated', 'session', 'platform.tenants', 'platform.members', 'platform.authoringTokens', 'platform.plans']);
