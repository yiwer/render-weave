/**
 * 开放 API 的客户端：控制台只经它访问服务（M248），不另开后端接口。
 * 会话令牌放在本标签页的 sessionStorage，关掉标签页就丢；任何请求答 401 都视为会话失效，回到登录页。
 * 错误一律是 { problems }，原样交给页面显示。
 */
import type {
  ApiKeyInfo, AuditEvent, BatchView, DatasetEntry, ExcelImport, Identity, Member, PageOf, PreviewReply, Problem, RecordEntry, ReplacementCheck, ResourceInfo,
  StaticSchemaDetail, StaticSchemaSummary, TemplateInfo, Usage, UsageEvent, UsageKind, Webhook, WebhookDelivery,
} from './types.js';

const TOKEN_KEY = 'renderweave.console.token';

export class ApiError extends Error {
  constructor(readonly status: number, readonly problems: readonly Problem[], readonly body?: Record<string, unknown>) {
    super(problems.map((problem) => problem.message).join('；') || `请求失败（${status}）`);
  }
}

export const session = {
  get token(): string | undefined {
    try { return sessionStorage.getItem(TOKEN_KEY) ?? undefined; } catch { return undefined; }
  },
  set(token: string) {
    try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* 存不了时本页仍可用，刷新后要重新登录 */ }
    memory = token;
  },
  clear() {
    try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* 同上 */ }
    memory = undefined;
  },
};
let memory: string | undefined;
let unauthorized: () => void = () => {};
export const onUnauthorized = (handler: () => void) => { unauthorized = handler; };

/** 用量可能变了（提交或取消批次、批次结束）：顶栏的本月剩余重新读取。返回取消订阅的函数。 */
const usageListeners = new Set<() => void>();
export const onUsageChanged = (listener: () => void) => { usageListeners.add(listener); return () => { usageListeners.delete(listener); }; };
export const usageChanged = () => { for (const listener of usageListeners) listener(); };
/** 请求成功之后通知用量可能变了。 */
const changingUsage = async <T>(request: Promise<T>): Promise<T> => {
  const reply = await request;
  usageChanged();
  return reply;
};

const problemOf = (message: string): Problem => ({ code: 'request.failed', level: 'severe', location: { kind: 'input', source: 'request' }, message });

interface RequestOptions {
  readonly json?: unknown;
  /** 已写好的 JSON 原文：数据集按原文发送，服务端按原文检查数值（M112）。 */
  readonly jsonText?: string;
  readonly bytes?: Blob;
  readonly headers?: Record<string, string>;
}

async function send(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
  const token = session.token ?? memory;
  const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}), ...options.headers };
  let body: BodyInit | undefined;
  if (options.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(options.json); }
  if (options.jsonText !== undefined) { headers['content-type'] = 'application/json'; body = options.jsonText; }
  if (options.bytes !== undefined) { headers['content-type'] = 'application/octet-stream'; body = options.bytes; }
  let response: Response;
  try { response = await fetch(path, { method, headers, ...(body === undefined ? {} : { body }) }); }
  catch { throw new ApiError(0, [problemOf('连不上出图服务，请检查网络后重试')]); }
  if (response.ok) return response;
  let parsed: Record<string, unknown> | undefined;
  try { parsed = await response.json() as Record<string, unknown>; } catch { parsed = undefined; }
  const problems = Array.isArray(parsed?.['problems']) ? parsed['problems'] as Problem[] : [problemOf(`请求失败（${response.status}）`)];
  if (response.status === 401 && path !== '/v1/sessions') { session.clear(); unauthorized(); }
  throw new ApiError(response.status, problems, parsed);
}

const json = async <T>(method: string, path: string, options?: RequestOptions) => (await send(method, path, options)).json() as Promise<T>;
const enc = encodeURIComponent;
/** 查询串：略去空值。 */
const search = (query: Record<string, string | number | undefined>) => {
  const text = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (value === undefined || value === '' ? [] : [[key, String(value)]]))).toString();
  return text ? `?${text}` : '';
};
/** 翻页的回答：列表在 key 下，next 原样带回。 */
const page = async <T>(path: string, key: string): Promise<PageOf<T>> => {
  const reply = await json<Record<string, unknown>>('GET', path);
  return { items: reply[key] as T[], ...(typeof reply['next'] === 'string' ? { next: reply['next'] } : {}) };
};

export interface RecordQuery { readonly batchId?: string; readonly template?: string; readonly from?: string; readonly to?: string; readonly before?: string }

export const api = {
  login: (email: string, password: string) => json<{ token: string; identity: Identity }>('POST', '/v1/sessions', { json: { email, password } }),
  logout: async () => { await send('DELETE', '/v1/sessions/current'); },
  me: () => json<Identity>('GET', '/v1/me'),
  usage: (period?: string) => json<Usage>('GET', `/v1/usage${search({ period })}`),
  usageEvents: (query: { readonly period?: string; readonly kind?: UsageKind; readonly before?: string }) =>
    page<UsageEvent>(`/v1/usage/events${search({ ...query, limit: 50 })}`, 'events'),

  records: (query: RecordQuery) => page<RecordEntry>(`/v1/records${search({ ...query, limit: 50 })}`, 'records'),

  members: () => json<{ members: Member[] }>('GET', '/v1/members'),
  updateMember: (id: string, change: { role?: Member['role']; active?: boolean }) => json<Member>('PATCH', `/v1/members/${enc(id)}`, { json: change }),
  apiKeys: () => json<{ apiKeys: ApiKeyInfo[] }>('GET', '/v1/api-keys'),
  createApiKey: (name: string) => json<{ key: string; apiKey: ApiKeyInfo }>('POST', '/v1/api-keys', { json: { name } }),
  revokeApiKey: async (id: string) => { await send('DELETE', `/v1/api-keys/${enc(id)}`); },
  auditEvents: (before?: string) => page<AuditEvent>(`/v1/audit-events${search({ limit: 50, before })}`, 'events'),
  webhooks: () => json<{ webhooks: Webhook[] }>('GET', '/v1/webhooks'),
  createWebhook: (body: { url: string; description?: string }) => json<{ webhook: Webhook; secret: string }>('POST', '/v1/webhooks', { json: body }),
  updateWebhook: (id: string, change: { active?: boolean; description?: string }) => json<Webhook>('PATCH', `/v1/webhooks/${enc(id)}`, { json: change }),
  webhookDeliveries: (id: string, before?: string) => page<WebhookDelivery>(`/v1/webhooks/${enc(id)}/deliveries${search({ limit: 50, before })}`, 'deliveries'),

  templates: () => json<{ templates: TemplateInfo[] }>('GET', '/v1/templates'),
  template: (name: string) => json<TemplateInfo>('GET', `/v1/templates/${enc(name)}`),
  staticSchemas: () => json<{ staticSchemas: StaticSchemaSummary[] }>('GET', '/v1/static-schemas'),
  staticSchema: (name: string, version: number) => json<StaticSchemaDetail>('GET', `/v1/static-schemas/${enc(name)}/versions/${version}`),
  blankWorkbook: async (name: string, version: number) => (await send('GET', `/v1/static-schemas/${enc(name)}/versions/${version}/workbook`)).blob(),

  datasets: () => json<{ datasets: DatasetEntry[] }>('GET', '/v1/datasets'),
  datasetText: async (id: string) => (await send('GET', `/v1/datasets/${enc(id)}`)).text(),
  createDataset: (text: string) => json<{ dataset: DatasetEntry; problems: Problem[] }>('POST', '/v1/datasets', { jsonText: text }),
  updateDataset: (id: string, text: string) => json<{ dataset: DatasetEntry; problems: Problem[] }>('PUT', `/v1/datasets/${enc(id)}`, { jsonText: text }),
  copyDataset: (id: string, copy: { id: string; name?: string }) => json<{ dataset: DatasetEntry; problems: Problem[] }>('POST', `/v1/datasets/${enc(id)}/copies`, { json: copy }),
  checkDataset: (text: string) => json<{ problems: Problem[] }>('POST', '/v1/dataset-checks', { jsonText: text }),

  resources: () => json<{ resources: ResourceInfo[] }>('GET', '/v1/resources'),
  resourceBytes: async (id: string, version: number) => (await send('GET', `/v1/resources/${enc(id)}/versions/${version}/content`)).arrayBuffer(),
  uploadImage: (file: Blob) => json<{ id: string; kind: 'image'; version: number }>('POST', '/v1/resources?kind=image', { bytes: file }),
  uploadResource: (kind: 'image' | 'font', file: Blob, id?: string) =>
    json<{ id: string; kind: 'image' | 'font'; version: number }>('POST', `/v1/resources${search({ kind, id })}`, { bytes: file }),
  checkReplacement: (id: string, file: Blob) => json<{ check: ReplacementCheck; problems: Problem[] }>('POST', `/v1/resources/${enc(id)}/replacement-checks`, { bytes: file }),
  applyReplacement: (id: string, check: ReplacementCheck) => json<{ id: string; version: number }>('POST', `/v1/resources/${enc(id)}/replacements`, { json: { check } }),

  importExcel: (request: { template: string; workbook: string; parameters: unknown; output: unknown }) => json<ExcelImport>('POST', '/v1/excel-imports', { json: request }),

  preview: (request: unknown) => json<PreviewReply>('POST', '/v1/previews', { json: request }),

  submitBatch: (request: unknown, idempotencyKey: string) =>
    changingUsage(json<BatchView>('POST', '/v1/batches', { json: request, headers: { 'idempotency-key': idempotencyKey } })),
  batch: (id: string) => json<BatchView>('GET', `/v1/batches/${enc(id)}`),
  cancelBatch: (id: string) => changingUsage(json<BatchView>('POST', `/v1/batches/${enc(id)}/cancel`)),
  download: async (path: string) => (await send('GET', path)).blob(),
};

/** 把下载的内容交给浏览器保存。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** 资源内容一律以 application/octet-stream 回答；按文件头认出图片类型，才能在 <img> 里显示。 */
export function imageBlob(bytes: ArrayBuffer): Blob {
  const head = new Uint8Array(bytes.slice(0, 12));
  const ascii = String.fromCharCode(...head);
  const type = head[0] === 0x89 && ascii.slice(1, 4) === 'PNG' ? 'image/png'
    : head[0] === 0xff && head[1] === 0xd8 ? 'image/jpeg'
    : ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP' ? 'image/webp'
    : ascii.startsWith('GIF8') ? 'image/gif'
    : 'image/svg+xml';
  return new Blob([bytes], { type });
}
