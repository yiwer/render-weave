/**
 * 开放 API 的 OpenAPI 3.1 描述（票据 11，M246）：GET /v1/openapi.json 返回它，docs/api/openapi.json 是它的快照。
 * - 路径、方法与请求的 JSON Schema 取自已注册的路由（服务实际执行的校验），说明、回答与错误状态写在本文件的 ROUTE_DOCS；
 *   每个路由都要有说明，少了或多了都在生成时报错；
 * - 批量交付、草稿预览与数据集的请求体就是 DSL 1.0 的 JSON Schema（schemas/），原样收进 components；
 * - 错误回答一律是问题清单，HTTP 状态按类别映射（PROBLEM_STATUS）；
 * - 1.x 只做加法（docs/api.md）：回答里可能出现新的属性与枚举值，客户端应忽略不认识的。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ACTOR_KINDS, TOKEN_KINDS, USAGE_KINDS, WEBHOOK_EVENT_TYPES } from '../backend.js';
import { MANIFEST_SCHEMA } from '../push.js';
import type { Access } from './permissions.js';
import { ServiceProblemCodes, type ServiceProblemCode } from './problems.js';
import { PLAN_SCHEMA } from './usage.js';

/** 开放 API 的版本：只做加法时升次版本号，并在 docs/api.md 的变更记录里写一行。 */
export const API_VERSION = '1.6.0';

/** 已注册的路由：方法、路径、访问要求与路由声明的 JSON Schema（请求体、查询串）。 */
export interface DocumentedRoute {
  readonly method: string;
  readonly url: string;
  readonly access: Access;
  readonly schema?: { readonly body?: unknown; readonly querystring?: unknown };
}

/**
 * 服务的问题码对应的 HTTP 状态（阶段 4 PRD「开放 API」）：请求不合法 400（请求体类型不对 415、超出大小与规模 413）、未鉴权 401、
 * 无权限 403、不存在 404、冲突 409、额度不足或限频 429、暂时无法完成 503、服务内部错误 500。
 * 引擎的问题码（数据集、模板与批次请求的检查）一般随 400 返回，另见 ENGINE_PROBLEM_STATUS。
 */
export const PROBLEM_STATUS: Readonly<Record<ServiceProblemCode, readonly number[]>> = {
  [ServiceProblemCodes.requestInvalid]: [400, 415],
  [ServiceProblemCodes.notFound]: [404],
  [ServiceProblemCodes.authRequired]: [401],
  [ServiceProblemCodes.authInvalidCredentials]: [401],
  [ServiceProblemCodes.authForbidden]: [403],
  [ServiceProblemCodes.memberEmailTaken]: [409],
  [ServiceProblemCodes.memberLastAdmin]: [409],
  [ServiceProblemCodes.pushConflict]: [409],
  [ServiceProblemCodes.pushContentMissing]: [400],
  [ServiceProblemCodes.pushContentMismatch]: [400],
  [ServiceProblemCodes.draftStale]: [409],
  [ServiceProblemCodes.draftVersionTaken]: [409],
  [ServiceProblemCodes.templateRevisionConflict]: [409],
  [ServiceProblemCodes.limitRequestTooLarge]: [413],
  [ServiceProblemCodes.limitDatasetTooLarge]: [413],
  [ServiceProblemCodes.limitPixelsExceeded]: [413],
  [ServiceProblemCodes.limitExpansionExceeded]: [413],
  [ServiceProblemCodes.previewRateLimited]: [429],
  [ServiceProblemCodes.workerUnavailable]: [503],
  [ServiceProblemCodes.batchIdempotencyConflict]: [409],
  [ServiceProblemCodes.inputDuplicate]: [409],
  [ServiceProblemCodes.resourceReplacementInvalid]: [400],
  [ServiceProblemCodes.resourceReplacementStale]: [409],
  [ServiceProblemCodes.replayBuildUnavailable]: [503],
  [ServiceProblemCodes.replayRateLimited]: [429],
  [ServiceProblemCodes.quotaExceeded]: [429],
  [ServiceProblemCodes.webhookUrlNotAllowed]: [400],
  [ServiceProblemCodes.webhookLimitReached]: [409],
  [ServiceProblemCodes.importWorkbookUnreadable]: [400],
  [ServiceProblemCodes.limitWorkbookTooLarge]: [413],
  [ServiceProblemCodes.internalError]: [500],
};

/** 引擎的问题码不在 PROBLEM_STATUS 里时随 400 返回；以下几个另有状态：出图记录与对象存储不符 500，读不了租户的资源仓库 500。 */
export const ENGINE_PROBLEM_STATUS: Readonly<Record<string, readonly number[]>> = {
  'record.integrityMismatch': [500],
  'input.unreadable': [400, 409, 500],
};

// —— 组件 ——

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const int = (description?: string, minimum = 0) => ({ type: 'integer', minimum, ...(description ? { description } : {}) });
const instant = (description: string) => ({ type: 'string', format: 'date-time', description });
const uuid = (description: string) => ({ type: 'string', format: 'uuid', description });
const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$', description: '内容的 SHA-256，64 位小写十六进制' };
const object = (properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties), extra: Record<string, unknown> = {}) =>
  ({ type: 'object', required: [...required], properties, ...extra });
const array = (items: unknown, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
/** 结构由引擎定义、随引擎版本演进的对象：只描述外层，内部见说明里的文档。 */
const freeform = (description: string) => ({ type: 'object', description, additionalProperties: true });
const staticSchemaRef = object({ name: str('静态数据定义名称'), version: int('版本', 1) });

function dslSchema(file: string): Record<string, unknown> {
  const { $schema: _schema, ...schema } = JSON.parse(readFileSync(fileURLToPath(new URL(`../../../schemas/${file}`, import.meta.url)), 'utf8')) as Record<string, unknown>;
  return schema;
}

const PROBLEM_LOCATION = {
  description: '问题的位置：字段、对外参数、元素、检查项、派生变量、数据定义或请求的输入（source 是请求里的位置，如 request.body.url）',
  oneOf: [
    object({ kind: { const: 'field' }, path: str('字段路径') }),
    object({ kind: { const: 'parameter' }, name: str('参数名'), path: str() }, ['kind', 'name']),
    object({ kind: { const: 'element' }, path: str('元素路径') }),
    object({ kind: { const: 'check' }, template: str(), name: str(), path: str() }, ['kind', 'template', 'name']),
    object({ kind: { const: 'variable' }, template: str(), name: str(), path: str() }, ['kind', 'template', 'name']),
    object({ kind: { const: 'definition' }, schema: str(), path: str() }),
    object({ kind: { const: 'input' }, source: str() }),
  ],
};

const SCHEMAS: Record<string, unknown> = {
  Problem: object({
    level: { type: 'string', enum: ['severe', 'hint'], description: '严重（severe）或提示（hint）' },
    code: { type: 'string', description: '问题码：服务的问题码见 docs/api.md，引擎的问题码与命令行相同' },
    location: PROBLEM_LOCATION,
    message: str('中文说明'),
  }, ['level', 'code', 'location', 'message']),
  ProblemList: array(ref('Problem'), '问题清单：格式与命令行、引擎的问题清单相同'),
  ErrorResponse: object({
    problems: { type: 'array', minItems: 1, items: ref('Problem') },
    quota: { ...ref('QuotaShortfall'), description: '额度不足（429 quota.exceeded）时：本期的限额、已用、预占、剩余与本批项数' },
    diff: { ...ref('PushDiff'), description: '推送冲突（409 push.conflict）时：逐项差异' },
    currentSha256: { ...sha256, description: '保存草案或工作副本时预期哈希不是当前内容（409 draft.stale）：当前内容哈希（1.2.0）' },
    conflict: { ...ref('TemplateRevisionConflict'), description: '保存模板时基准不是当前修订（409 template.revisionConflict）：两边差异（1.5.0）' },
  }, ['problems'], { description: '错误回答：问题清单，额度不足、推送冲突、草案过期与修订冲突时另带说明情况的字段' }),
  QuotaShortfall: object({ period: str('计费周期 YYYY-MM'), limit: int(), used: int(), reserved: int(), remaining: int(), requested: int() }),

  // 账号与租户
  Tenant: object({ id: uuid('租户 ID'), name: str(), createdAt: instant('创建时间') }),
  TenantWithPlan: object({ id: uuid('租户 ID'), name: str(), createdAt: instant('创建时间'), plan: ref('Plan') }),
  Member: object({ id: uuid('成员 ID'), tenantId: uuid('租户 ID'), email: str(), role: { type: 'string', enum: ['admin', 'operator'] }, active: { type: 'boolean' }, createdAt: instant('创建时间') }),
  ApiKey: object({ id: uuid('API 密钥 ID'), name: str(), prefix: str('密钥的前几个字符'), createdAt: instant('创建时间'), revokedAt: instant('吊销时间') },
    ['id', 'name', 'prefix', 'createdAt']),
  AuthoringToken: object({ id: uuid('代建令牌 ID'), label: str(), prefix: str(), tenantIds: array(uuid('被指定的租户')), createdAt: instant('签发时间'),
    expiresAt: instant('过期时间'), revokedAt: instant('吊销时间') }, ['id', 'label', 'prefix', 'tenantIds', 'createdAt', 'expiresAt']),
  Identity: { description: '当前身份', oneOf: [
    object({ kind: { const: 'member' }, role: { type: 'string', enum: ['admin', 'operator'] }, userId: uuid('成员 ID'), email: str(), tenantId: uuid('租户 ID') }),
    object({ kind: { const: 'platformUser' }, role: { const: 'platformAdmin' }, userId: uuid('平台用户 ID'), email: str() }),
    object({ kind: { const: 'apiKey' }, role: { const: 'apiKey' }, keyId: uuid('API 密钥 ID'), name: str(), tenantId: uuid('租户 ID') }),
    object({ kind: { const: 'authoringToken' }, role: { const: 'authoringEngineer' }, tokenId: uuid('代建令牌 ID'), label: str(), tenantIds: array(uuid('被指定的租户')) }),
  ] },
  AuditEvent: object({
    id: str('事件 ID，按时间递增'), tenantId: { type: ['string', 'null'], description: '租户 ID；平台级事件为 null' }, at: instant('时间'),
    actor: object({ kind: { type: 'string', enum: [...ACTOR_KINDS] }, id: str(), label: str() }),
    action: str('操作，如 batch.create'), object: object({ type: str(), id: str() }), crossTenant: { type: 'boolean', description: '平台管理员或代建工程师的跨租户操作' },
    beforeSha256: { ...sha256, description: '代建写入：对象写入前的内容哈希（1.1.0）' }, afterSha256: { ...sha256, description: '代建写入：对象写入后的内容哈希（1.1.0）' },
    diff: ref('AuditDiff'), round: str('代建轮次（1.1.0；P2 的 Agent 填写）'), reason: str('写入理由（1.1.0；P2 的 Agent 填写）'),
  }, ['id', 'tenantId', 'at', 'actor', 'action', 'object', 'crossTenant']),
  AuditDiff: object({
    added: int('新增几项'), removed: int('删除几项'), changed: int('修改几项'),
    paths: array(object({
      path: str('改动的位置，如 template:问候牌、resource:logo'), change: { type: 'string', enum: ['added', 'removed', 'changed'] },
      beforeSha256: { ...sha256, description: '改动前的内容哈希；新增没有' }, afterSha256: { ...sha256, description: '改动后的内容哈希；删除没有' },
    }, ['path', 'change']), '至多 50 项；计数之和大于项数时没列全'),
  }, ['added', 'removed', 'changed', 'paths'], { description: '代建写入的差异摘要（1.1.0，M347）' }),

  // 套餐与用量
  Plan: object({
    monthlyImages: int('每月出图张数'), maxPixels: int('单张最大像素', 1), concurrency: int('预览与重放的并发数', 1),
  }, ['monthlyImages', 'maxPixels', 'concurrency'], { description: '套餐（M274）' }),
  Usage: object({
    period: str('计费周期 YYYY-MM（按 UTC+8 切分的自然月）'), start: instant('周期开始'), end: instant('周期结束（不含）'), plan: ref('Plan'),
    images: object({ limit: int('限额'), used: int('已用'), reserved: int('预占'), remaining: int('剩余 = 限额 − 已用 − 预占，不小于 0') }),
    tokens: object(Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, int()]))),
  }),
  UsageEvent: object({
    id: str('事件 ID'), at: instant('时间'), period: str('计费周期'), kind: { type: 'string', enum: USAGE_KINDS }, quantity: int('数量', 1),
    batchId: uuid('正式交付成功的一张：所属批次'), index: int('项序号', 1),
    round: object({ sha256, task: str('代建任务'), round: int('轮次', 1) }, ['sha256', 'task', 'round'], { description: '代建的一轮：round.json 的 SHA-256、任务与轮次' }),
  }, ['id', 'at', 'period', 'kind', 'quantity']),

  QueueBacklog: object({
    queued: object({ preview: int(), batchItem: int(), replay: int() }), running: object({ preview: int(), batchItem: int(), replay: int() }),
    oldestQueuedMs: int('排队最久的一项已经等了多久，毫秒；没有排队的任务时是 0'),
  }, ['queued', 'running', 'oldestQueuedMs'], { description: '队列积压（跨租户，只有计数）' }),
  PlatformOverview: object({
    service: object({
      ready: { type: 'boolean', description: '接口进程就绪' }, schemaVersion: int('数据库迁移版本'), checks: { type: 'object', additionalProperties: str(), description: '各项检查的结果，ok 是通过' },
      workers: array(object({ build: str('构建标识'), workers: int('最近报到的 worker 数') }), '在线的 worker，按构建'),
      queue: { ...ref('QueueBacklog'), description: '没就绪时没有' },
    }, ['ready', 'checks', 'workers']),
    period: str('本月的计费周期 YYYY-MM'),
    tenants: array(object({
      id: uuid('租户 ID'), name: str(), createdAt: instant('创建时间'), plan: ref('Plan'),
      images: object({ limit: int('限额'), used: int('已用'), reserved: int('预占'), remaining: int('剩余') }),
      tokens: object(Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, int()])), undefined, { description: '本月代建的 token；只记不拦（M242）' }),
      members: int('启用的成员数'),
    })),
  }, ['service', 'period', 'tenants'], { description: '平台管理页的汇总（1.3.0）' }),

  // 模板与预览
  Template: object({
    name: str('模板名称'), currentRevision: int('当前修订', 1), base: { ...staticSchemaRef, description: '所用的数据定义' },
    sizeRange: object({ width: object({ min: { type: 'number' }, max: { type: 'number' } }), height: object({ min: { type: 'number' }, max: { type: 'number' } }) },
      ['width', 'height'], { description: '适用尺寸范围，毫米' }),
    parameters: array(object({
      name: str(), displayName: str(), type: { type: 'string', enum: ['text', 'number', 'date', 'time', 'datetime', 'boolean', 'image', 'color'] },
      constraints: object({ integer: { type: 'boolean' }, min: { type: 'number' }, max: { type: 'number' }, minLength: int(), maxLength: int(), pattern: str(),
        enum: array({ type: ['string', 'number'] }) }, []),
      default: { type: ['string', 'number', 'boolean'] },
    }, ['name', 'displayName', 'type', 'constraints']), '对外参数'),
    problems: { ...ref('ProblemList'), description: '模板读不了时只有名称、当前修订与问题清单' },
  }, ['name', 'currentRevision']),
  PreviewResult: object({
    image: object({ format: { type: 'string', enum: ['png', 'jpeg'] }, widthPx: int(), heightPx: int(), dpi: { type: 'number' }, base64: str('图片字节的 base64') }),
    problems: ref('ProblemList'),
    layout: freeform('布局摘要：元素路径、位置与尺寸（docs/render-modes.md）'),
    elements: array(object({ path: str('元素路径，同布局摘要'), source: object({ template: str('源模板'), path: str('元素在源模板里的路径，第一段是模板名') }) }),
      '会显示的元素实例各自的来源，循环与子模板调用里的元素指向它所在的模板文档（1.5.0）'),
  }, ['problems'], { description: '草稿预览：图片、问题清单与布局摘要；无法展开时只有问题清单' }),

  // 批量交付
  RenderRequest: dslSchema('render-request.schema.json'),
  BatchRequest: dslSchema('batch-request.schema.json'),
  BatchSummary: object(Object.fromEntries(['total', 'delivered', 'previewed', 'failed', 'notRun', 'severe', 'hints'].map((key) => [key, int()])),
    undefined, { description: '批次清单的汇总：项数、交付、草稿、失败、未执行，以及严重问题与提示的个数' }),
  BatchOutcome: { type: 'string', enum: ['completed', 'partiallyFailed', 'failed', 'cancelled'],
    description: '结束时的结果：全部交付、部分失败、全部失败、已取消（请求过取消的批次一律是 cancelled）' },
  BatchItem: { description: '一项：还没结束时只有状态；结束后有结果与问题清单', oneOf: [
    object({ index: int('项序号', 1), id: str('渲染项标识'), status: { type: 'string', enum: ['queued', 'running'] } }),
    object({
      index: int('项序号', 1), id: str('渲染项标识'), status: { type: 'string', enum: ['delivered', 'failed', 'notRun'] },
      files: object({ image: { type: 'string', enum: ['image.png', 'image.jpg'] }, problems: { const: 'problems.json' }, layout: { const: 'layout.json' },
        record: { const: 'record.json' }, preview: { const: 'preview.json' } }, ['problems'], { description: '这一项登记的文件，用 files 端点下载' }),
      severe: int(), hints: int(), reason: str('未执行的原因'), problems: ref('ProblemList'),
    }, ['index', 'id', 'status', 'severe', 'hints', 'problems']),
  ] },
  BatchHeader: object({
    id: uuid('批次 ID'), template: str('根模板'), mode: { const: 'final' }, build: str('接受批次的构建标识'), idempotencyKey: str('提交时的幂等键'),
    outcome: ref('BatchOutcome'), cancelRequested: { type: 'boolean' }, createdAt: instant('接受时间'), finishedAt: instant('结束时间'),
    summary: ref('BatchSummary'), problems: { ...ref('ProblemList'), description: '批次级问题，如取消' },
  }, ['id', 'template', 'mode', 'build', 'cancelRequested', 'createdAt', 'summary', 'problems'], { description: '批次的摘要（webhook 事件里的批次）' }),
  Batch: object({
    id: uuid('批次 ID'), template: str('根模板'), mode: { const: 'final' }, build: str('接受批次的构建标识'), idempotencyKey: str('提交时的幂等键'),
    status: { type: 'string', enum: ['running', 'finished'], description: 'finished：全部项结束，批次清单已发布' },
    outcome: { ...ref('BatchOutcome'), description: '结束后才有' }, cancelRequested: { type: 'boolean' }, createdAt: instant('接受时间'), finishedAt: instant('结束时间'),
    progress: object({ completed: int('已结束的项'), total: int('项数') }), summary: ref('BatchSummary'), items: array(ref('BatchItem')),
    problems: { ...ref('ProblemList'), description: '批次级问题，如取消' },
  }, ['id', 'template', 'mode', 'build', 'status', 'cancelRequested', 'createdAt', 'progress', 'summary', 'items', 'problems']),

  // 数据定义与草案（1.2.0）
  DefinitionDraft: object({
    name: str('数据定义名称'), baseVersion: int('基于的静态版本；新名称没有', 1), sha256: { ...sha256, description: '当前内容的 SHA-256，保存时作为预期哈希' }, byteLength: int('字节数'),
    createdAt: instant('新建时间'), updatedAt: instant('最后保存时间'), updatedBy: str('最后保存者：邮箱或代建令牌的标签'),
  }, ['name', 'sha256', 'byteLength', 'createdAt', 'updatedAt', 'updatedBy'], { description: '数据定义草案：一个名称至多一份' }),
  Definition: object({
    name: str('数据定义名称'), displayName: str('显示名称：最新静态版本的；还没发布过时取草案的'),
    versions: array(object({
      version: int('版本', 1), displayName: str('这一版的显示名称'), datasets: int('绑定这一版的数据集份数'), templates: int('基准是这一版的模板个数'),
    }), '静态版本，按版本号升序'),
    draft: { ...ref('DefinitionDraft'), description: '草案；没有就是没有草案' },
  }, ['name', 'displayName', 'versions']),
  DefinitionDraftCheck: object({
    sha256: { ...sha256, description: '校验的是这份内容' }, problems: { ...ref('ProblemList'), description: '问题清单，定位到字段；有严重问题时不能发布' },
    version: int('发布后的版本号；有严重问题时没有', 1), compiled: freeform('编译产物 JSON Schema，与发布产物相同；有严重问题时没有'),
    affectedBindings: array(object({
      field: str('与基于的版本相比被删除的字段；改名等于删一个、加一个'),
      templates: array(object({ name: str('模板名称'), base: { ...staticSchemaRef, description: '模板的基准' } }), '当前修订读到这个字段的模板'),
    }), '会影响绑定的字段'),
  }, ['sha256', 'problems', 'affectedBindings']),

  DefinitionPublishCheck: object({
    sha256: { ...sha256, description: '预检的是这份内容' }, baseVersion: int('基于的静态版本；新名称没有', 1),
    problems: { ...ref('ProblemList'), description: '问题清单；有严重问题时发布会被拒绝，下面的字段都没有' },
    version: int('发布后的版本号', 1),
    diff: freeform('与基于版本的字段级差异：definition 是数据定义自身的改动，fields 是逐字段的增删改与属性键，order 是字段顺序的变化'),
    datasets: object({
      total: int('绑定基于版本的数据集份数'), checked: int('这次校验了几份'), complete: { type: 'boolean', description: 'false：超过上限，只校验了前面的，未全部核对' },
      mismatched: int('校验的这些里，按新版会失配的份数'),
      samples: array(object({ id: str('数据集 ID'), problemCount: int('严重问题数'), problems: { ...ref('ProblemList'), description: '至多 5 条' } }), '前 20 份失配的问题摘要'),
    }),
    templates: array(object({ name: str('模板名称'), base: { ...staticSchemaRef, description: '模板绑定的版本' } }), '基准是这个名称的模板；发布不改动它们'),
  }, ['sha256', 'problems'], { description: '发布预检（1.4.0）' }),
  DefinitionPublished: object({
    name: str('数据定义名称'), version: int('新版本', 1), baseVersion: int('基于的静态版本；新名称没有', 1),
    definitionSha256: { ...sha256, description: '静态数据定义原文的 SHA-256' }, compiledSha256: { ...sha256, description: '编译产物的 SHA-256' },
  }, ['name', 'version', 'definitionSha256', 'compiledSha256'], { description: '发布的结果（1.4.0）' }),

  // 数据集与资源
  DatasetDocument: dslSchema('dataset.schema.json'),
  StaticSchemaSummary: object({ name: str('静态数据定义名称'), version: int('版本', 1), displayName: str('显示名称'), description: str() },
    ['name', 'version', 'displayName']),
  StaticSchema: object({
    name: str('静态数据定义名称'), version: int('版本', 1), displayName: str('显示名称'), description: str(),
    definition: freeform('静态数据定义的原文（DSL 1.0，schemas/data-definition.schema.json）'),
    compiled: freeform('编译产物：JSON Schema 2020-12，title 是显示名称，x-renderweave-type 标明日期、时刻、时间与图片，数据定义引用已内联（ADR-0006）'),
  }, ['name', 'version', 'displayName', 'definition', 'compiled']),
  WorkbookCell: object({ sheet: str('工作表'), row: int('行号（Excel 里看到的，从 1 起）', 1), column: str('列号，如 C；整行的问题没有'), header: str('这一列的表头') },
    ['sheet', 'row'], { description: '工作簿里的位置' }),
  ImportProblem: object({
    level: { type: 'string', enum: ['severe', 'hint'], description: '严重（severe）或提示（hint）' },
    code: { type: 'string', description: '引擎的问题码（与保存数据集时相同），或导入的问题码（import.*，见 docs/api.md）' },
    location: PROBLEM_LOCATION,
    message: str('中文说明'),
    cell: ref('WorkbookCell'),
  }, ['level', 'code', 'location', 'message'], { description: '导入的问题：格式与问题清单相同，另带它在工作簿里的位置' }),
  ExcelImportRow: object({
    row: int('主表的行号', 1), itemId: str('渲染项 ID：渲染项 ID 列的值，没有时是"第 N 行"'),
    status: { type: 'string', enum: ['accepted', 'rejected'], description: '没有严重问题的行进批量请求（accepted），有的不进（rejected）' },
    dataset: { ...ref('DatasetDocument'), description: '这一行读出的数据集；身份部分的 origin 写明工作表与行号' },
    problems: array(ref('ImportProblem'), '这一行的问题：与保存数据集时相同的检查，加上导入的问题'),
  }),
  ExcelImport: object({
    template: str('模板名称'), staticSchema: { ...staticSchemaRef, description: '模板所用的数据定义，各行按它读取与校验' }, sheet: str('主表：一行一个渲染项'),
    summary: object({ rows: int('数据行'), accepted: int('能提交的行'), rejected: int('有严重问题、不进批次的行') }),
    rows: array(ref('ExcelImportRow')),
    problems: array(ref('ImportProblem'), '整份的问题：不认识的列、没人引用的行、没有数据行等'),
    batch: { ...ref('BatchRequest'), description: '只含能提交的行的批量请求，数据集内联；确认后原样提交到 POST /v1/batches。没有能提交的行或整份有严重问题时没有' },
  }, ['template', 'staticSchema', 'sheet', 'summary', 'rows', 'problems']),
  DatasetEntry: object({ id: str('数据集 ID'), name: str(), staticSchema: { ...staticSchemaRef, description: '所选的静态数据定义' }, sha256, byteLength: int('字节数') },
    ['id', 'sha256', 'byteLength']),
  DatasetSaved: object({ dataset: ref('DatasetEntry'), problems: { ...ref('ProblemList'), description: '保存时的提示' } }),
  ContentVersion: object({ version: int('内容版本', 1), sha256, byteLength: int('字节数') }),
  Resource: object({ id: str('资源 ID'), kind: { type: 'string', enum: ['image', 'font'] }, currentVersion: int('当前内容版本', 1), versions: array(ref('ContentVersion')) }),
  ResourceVersion: object({ id: str('资源 ID'), kind: { type: 'string', enum: ['image', 'font'] }, version: int('内容版本', 1), sha256, byteLength: int('字节数') }),
  ReplacementCheck: object({
    resource: ref('ResourceVersion'), replacement: object({ sha256, byteLength: int() }),
    impact: object({
      workspaceFingerprint: sha256, renderOptions: object({ fallbackFonts: array(str()), svgFonts: array(str()) }),
      references: array(object({ kind: { type: 'string', enum: ['templateFixed', 'stateStyle', 'parameterDefault', 'derivedValue', 'callArgument', 'datasetImage'] },
        document: str('文档'), source: str(), path: str('JSON Pointer') }), '受影响的模板与数据集里的引用'),
      configuration: array(object({ kind: { type: 'string', enum: ['fallbackFonts', 'svgFonts'] }, path: str() }), '受影响的字体配置'),
      scope: str('检查范围的说明'),
    }),
  }, undefined, { description: '替换检查报告：应用替换时原样交回' }),

  // 出图记录
  RecordEntry: object({
    batchId: uuid('批次 ID'), index: int('项序号', 1), id: str('渲染项标识'), template: str(), build: str('构建标识'), deliveredAt: instant('登记时间'),
    image: { type: 'string', enum: ['image.png', 'image.jpg'] },
  }),
  ReplayResult: object({
    batchId: uuid('批次 ID'), index: int('项序号', 1), id: str('渲染项标识'), build: str('记录所属的构建'), matched: { type: 'boolean', description: '重新渲染的成果与记录逐字节相同' },
    replay: object({ format: { const: 'renderweave-replay/1' }, build: str(), itemId: str(), matched: { const: true },
      files: array(object({ file: str(), sha256, byteLength: int() })) }),
    problems: ref('ProblemList'),
  }, ['batchId', 'index', 'id', 'build', 'matched', 'problems']),
  Build: object({ build: str('构建标识'), image: str('镜像标签'), records: int('引用它的出图记录数'), lastDeliveredAt: instant('最近一次登记'), workers: int('在线的 worker') },
    ['build', 'image', 'records', 'workers']),

  // 代建推送
  StoredDocument: object({ kind: { type: 'string', enum: ['definition', 'compiled', 'template', 'dataset'] }, key: str(), sha256, byteLength: int() }),
  TemplateRevisions: object({
    name: str('模板名称'), currentRevision: int('当前修订', 1),
    current: object({
      source: { type: 'string', enum: ['push', 'web'], description: 'push：推送产生的，或代建工程师自己指回的；web：保存工作副本，或客户管理员指回的' },
      action: { type: 'string', enum: ['revision', 'setCurrent'], description: 'revision：记了新修订；setCurrent：指回已有的修订' },
      by: str('产生它的主体'), at: instant('产生的时间'),
    }, ['source', 'action', 'by', 'at'], { description: '当前修订的来历（1.6.0）' }),
    revisions: array(object({ revision: int('修订号', 1), sha256, byteLength: int(), createdAt: instant('产生时间'), pushedBy: str('产生它的主体：代建令牌的标签或成员的邮箱'),
      source: { type: 'string', enum: ['push', 'web'], description: '来源：推送，或保存工作副本（1.5.0）' } })),
  }),
  TemplateWorkingCopy: object({
    name: str('模板名称'), baseRevision: int('基于的修订；复制出来的新模板没有', 1), sha256: { ...sha256, description: '当前内容的 SHA-256，暂存与保存时作为预期哈希' }, byteLength: int('字节数'),
    createdAt: instant('新建时间'), updatedAt: instant('最后暂存时间'), updatedBy: str('最后暂存者：邮箱或代建令牌的标签'),
  }, ['name', 'sha256', 'byteLength', 'createdAt', 'updatedAt', 'updatedBy'], { description: '模板工作副本：一个名称至多一份（1.5.0）' }),
  TemplateRevisionDiff: object({
    status: { type: 'string', enum: ['modified', 'unchanged', 'added'], description: 'added：没有已保存的内容可比' },
    changes: array(freeform('一处改动：path 是元素路径或模板层的键，target 是 element 或 template，change 是 added、removed、changed，改了的属性在 properties'), '结构化差异'),
  }),
  TemplateRevisionConflict: object({
    baseRevision: int('工作副本基于的修订；复制出来的新模板没有', 1), currentRevision: int('现在的当前修订', 1),
    ours: { ...ref('TemplateRevisionDiff'), description: '基准到工作副本：这边改了什么' }, theirs: { ...ref('TemplateRevisionDiff'), description: '基准到当前修订：别人改了什么' },
  }, ['currentRevision', 'ours', 'theirs']),
  TemplateWorkingCopyCheck: object({
    sha256: { ...sha256, description: '检查的是这份内容' }, baseRevision: int('基于的修订', 1), currentRevision: int('现在的当前修订；还没保存过的新模板没有', 1),
    problems: { ...ref('ProblemList'), description: '模板静态检查的问题，含它调用的模板；有严重问题时不能保存' },
    changes: { ...ref('TemplateRevisionDiff'), description: '当前修订到工作副本的结构化差异' },
    conflict: { ...ref('TemplateRevisionConflict'), description: '基准不是当前修订时才有' },
  }, ['sha256', 'problems', 'changes'], { description: '工作副本的检查（1.5.0）' }),
  TemplateSaved: object({
    name: str('模板名称'), revision: int('当前修订', 1), status: { type: 'string', enum: ['saved', 'unchanged'], description: 'unchanged：内容与当前修订字节相同，不记新修订，工作副本照样删除' },
    sha256: { ...sha256, description: '当前修订的内容哈希' },
  }, undefined, { description: '保存模板的结果（1.5.0）' }),
  AuthoringState: object({ documents: array(ref('StoredDocument')), templates: array(ref('TemplateRevisions')), resources: array(ref('Resource')) }),
  PushDiff: object({
    summary: object({ added: int(), updated: int(), unchanged: int(), conflicts: int() }),
    documents: array(object({ kind: { type: 'string', enum: ['definition', 'compiled', 'template', 'dataset'] }, key: str(),
      status: { type: 'string', enum: ['added', 'updated', 'unchanged', 'conflict'] }, reason: str(), currentRevision: int('', 1), revision: int('提交后新记的修订', 1) },
    ['kind', 'key', 'status'])),
    resources: array(object({ id: str(), kind: { type: 'string', enum: ['image', 'font'] }, status: { type: 'string', enum: ['added', 'updated', 'unchanged', 'conflict'] },
      reason: str(), localVersion: int('', 1), serverVersion: int('', 1) }, ['id', 'kind', 'status', 'localVersion'])),
  }),

  // webhook
  Webhook: object({
    id: uuid('webhook ID'), url: str('接收地址'), description: str(), events: array({ type: 'string', enum: WEBHOOK_EVENT_TYPES }, '订阅的事件'),
    secretPrefix: str('签名密钥的前几个字符'), active: { type: 'boolean' }, createdAt: instant('注册时间'), disabledAt: instant('停用时间'),
  }, ['id', 'url', 'events', 'secretPrefix', 'active', 'createdAt']),
  WebhookDelivery: object({
    id: str('投递 ID'), webhookId: uuid('webhook ID'), eventId: uuid('事件 ID'), eventType: { type: 'string', enum: WEBHOOK_EVENT_TYPES }, batchId: uuid('批次 ID'),
    status: { type: 'string', enum: ['pending', 'succeeded', 'failed'], description: 'pending 还会再试；succeeded 收到 2xx；failed 试满次数仍没成功' },
    createdAt: instant('记下的时间'), nextAttemptAt: instant('下一次尝试'), finishedAt: instant('成功或放弃的时间'),
    attempts: array(object({ attempt: int('第几次', 1), at: instant('开始时间'), durationMs: int('耗时，毫秒'), statusCode: int('收到的 HTTP 状态', 100), error: str('没收到回答的原因') },
      ['attempt', 'at', 'durationMs'])),
  }, ['id', 'webhookId', 'eventId', 'eventType', 'batchId', 'status', 'createdAt', 'attempts']),
  BatchFinishedEvent: object({
    id: uuid('事件 ID：同一事件重试时不变，接收端按它去重'), type: { const: 'batch.finished' }, createdAt: instant('批次结束的时间'), tenantId: uuid('租户 ID'),
    data: object({ batch: ref('BatchHeader') }),
  }, undefined, { description: '批次结束事件的正文' }),
};

/** 错误状态的说明。 */
const STATUS_TEXT: Readonly<Record<number, string>> = {
  400: '请求不合法：问题清单定位到请求的位置', 401: '未鉴权：缺少、过期或吊销的会话、API 密钥或代建令牌', 403: '当前身份没有这项操作的权限',
  404: '不存在；别的租户的对象同样答 404', 409: '与已有内容冲突', 413: '请求、数据集、像素或展开规模超出上限', 415: '请求体的类型不对',
  429: '额度不足或超出频率与并发', 500: '服务内部错误', 503: '暂时无法完成，稍后再试',
};

// —— 各路由的说明 ——

type Body = 'batchRequest' | 'renderRequest' | 'datasetDocument' | 'definitionDocument' | 'templateDocument' | 'binary';
interface Reply {
  readonly status: number;
  readonly description: string;
  /** JSON 回答的 Schema；binary 是字节回答的媒体类型；都没有是空回答。 */
  readonly json?: unknown;
  readonly binary?: readonly string[];
}
interface RouteDoc {
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  /** 路由没有声明请求体的 Schema 时，请求体是什么。 */
  readonly body?: Body;
  readonly replies: readonly Reply[];
  /** 除了按访问要求与请求自动列出的错误状态之外，还会有的。 */
  readonly errors?: readonly number[];
  /** 请求头参数。 */
  readonly headers?: readonly { readonly name: string; readonly description: string }[];
}

const ok = (json: unknown, description = '成功', status = 200): Reply => ({ status, description, json });
const created = (json: unknown, description = '已创建'): Reply => ({ status: 201, description, json });
const none = (description = '成功，没有正文'): Reply => ({ status: 204, description });
const list = (key: string, item: string, extra: Record<string, unknown> = {}) => object({ [key]: array(ref(item)), ...extra }, [key]);
const page = (key: string, item: string, cursor: string) => object({ [key]: array(ref(item)), next: str(cursor) }, [key]);

/** 数据定义与草案（P1 票据 04，M345）：客户端点与代建端点一份实现、一份说明，只差寻址。 */
function definitionDocs(prefix: string, tag: string): Record<string, RouteDoc> {
  const draft = `${prefix}/definitions/:name/draft`;
  return {
    [`GET ${prefix}/definitions`]: { tag, summary: '本租户的数据定义：每个名称的静态版本、各版本被多少数据集与模板使用，以及草案', replies: [ok(list('definitions', 'Definition'))] },
    [`POST ${draft}`]: { tag, summary: '新建草案：空白，或从某个静态版本另起', errors: [409],
      description: '这个名称已有草案答 409；空白新建不能用已有静态版本的名称（409），要改它请从某个版本另起。', replies: [created(ref('DefinitionDraft'))] },
    [`GET ${draft}`]: { tag, summary: '读草案：登记信息与原文', replies: [ok(object({
      ...(SCHEMAS['DefinitionDraft'] as { properties: Record<string, unknown> }).properties, content: str('草案原文，与保存时逐字节相同，其 SHA-256 是 sha256'),
    }, ['name', 'sha256', 'byteLength', 'createdAt', 'updatedAt', 'updatedBy', 'content']))] },
    [`PUT ${draft}`]: { tag, summary: '整份替换草案，带预期 SHA-256；不是当前内容答 409 并给当前哈希', body: 'definitionDocument', errors: [409, 413, 415],
      description: '按原始字节存。只要求是 UTF-8 的 JSON 对象、name 与路径一致，还没写完的草案也能存；问题由校验回答。', replies: [ok(ref('DefinitionDraft'))] },
    [`GET ${draft}/check`]: { tag, summary: '校验草案并预览编译产物，不写任何东西；列出与基于的版本相比会影响绑定的字段与用到它们的模板', replies: [ok(ref('DefinitionDraftCheck'))] },
    [`DELETE ${draft}`]: { tag, summary: '删除草案', replies: [none('已删除')] },
    [`POST ${draft}/publish-check`]: { tag, summary: '发布预检，不写任何东西：字段级差异、按新版会失配的数据集份数、基准是这个名称的模板', errors: [409],
      description: '绑定基于版本的数据集按 ID 排序逐份校验，超过 1,000 份只校验前面的，datasets.complete 为 false。', replies: [ok(ref('DefinitionPublishCheck'))] },
    [`POST ${draft}/publish`]: { tag, summary: '把草案发布为下一个静态数据定义，删除草案；产物与本地 renderweave publish 逐字节相同', errors: [409],
      description: '严重问题答 400，问题码与本地发布相同。预期哈希不是当前内容答 409 draft.stale；版本被别的发布或推送先占了答 409 draft.versionTaken，什么也没写。回退：从旧版本另起草案（fromVersion），再发布成新版本。',
      replies: [created(ref('DefinitionPublished'))] },
  };
}

/** 模板工作副本与修订（P1 票据 07，M345）：客户端点与代建端点一份实现、一份说明，只差寻址。 */
function workingCopyDocs(prefix: string, tag: string): Record<string, RouteDoc> {
  const template = `${prefix}/templates/:name`, copy = `${template}/working-copy`;
  return {
    [`GET ${prefix}/template-working-copies`]: { tag, summary: '本租户的模板工作副本', replies: [ok(list('workingCopies', 'TemplateWorkingCopy'))] },
    [`POST ${copy}`]: { tag, summary: '从当前修订新建工作副本，记基准修订；已有工作副本答 409', errors: [409], replies: [created(ref('TemplateWorkingCopy'))] },
    [`GET ${copy}`]: { tag, summary: '读工作副本：登记信息与原文', replies: [ok(object({
      ...(SCHEMAS['TemplateWorkingCopy'] as { properties: Record<string, unknown> }).properties, content: str('工作副本原文，与暂存时逐字节相同，其 SHA-256 是 sha256'),
    }, ['name', 'sha256', 'byteLength', 'createdAt', 'updatedAt', 'updatedBy', 'content']))] },
    [`PUT ${copy}`]: { tag, summary: '暂存：整份替换，带预期 SHA-256；不影响当前修订，出图照旧读当前修订', body: 'templateDocument', errors: [409, 413, 415],
      description: '按原始字节存。只要求是 UTF-8 的 JSON 对象、name 与路径一致，还没写完的工作副本也能存。', replies: [ok(ref('TemplateWorkingCopy'))] },
    [`DELETE ${copy}`]: { tag, summary: '丢弃工作副本', replies: [none('已丢弃')] },
    [`GET ${copy}/check`]: { tag, summary: '模板静态检查与结构化差异，不写任何东西；基准不是当前修订时另给两边差异', replies: [ok(ref('TemplateWorkingCopyCheck'))] },
    [`POST ${copy}/save`]: { tag, summary: '保存模板：记新修订（字节相同记为不变），当前修订指向它，删除工作副本', errors: [409],
      description: '模板静态检查有严重问题时答 400。预期哈希不是当前内容答 409 draft.stale。基准不是当前修订答 409 template.revisionConflict，回答带两边差异；overwrite 为 true 才覆盖。',
      replies: [ok(ref('TemplateSaved'))] },
    [`POST ${template}/copies`]: { tag, summary: '复制为新模板：内容与基准数据定义取当前修订，成为没有基准修订的工作副本，保存时记修订 1', errors: [409], replies: [created(ref('TemplateWorkingCopy'))] },
    [`GET ${template}/revisions`]: { tag, summary: '模板的修订历史：修订号、主体、时间与来源', replies: [ok(ref('TemplateRevisions'))] },
  };
}

const ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  'GET /healthz': { tag: '运维', summary: '存活检查', replies: [ok(object({ status: { const: 'ok' }, service: str(), build: str() }))] },
  'GET /readyz': { tag: '运维', summary: '就绪检查：数据库、迁移与对象存储', replies: [
    ok(object({ status: { const: 'ready' }, service: str(), build: str(), ready: { const: true }, schemaVersion: int(), checks: { type: 'object', additionalProperties: str() } },
      ['status', 'service', 'build', 'ready', 'checks']), '就绪'),
    { status: 503, description: '未就绪：checks 写明哪一项', json: object({ status: { const: 'unready' }, service: str(), build: str(), ready: { const: false }, schemaVersion: int(),
      checks: { type: 'object', additionalProperties: str() } }, ['status', 'service', 'build', 'ready', 'checks']) },
  ] },
  'GET /v1/openapi.json': { tag: '运维', summary: '本描述（OpenAPI 3.1）', replies: [ok({ type: 'object', description: 'OpenAPI 描述' })] },

  'POST /v1/sessions': { tag: '账号', summary: '登录：邮箱加密码换会话令牌（12 小时）', errors: [401], replies: [created(object({ token: str('会话令牌，只出现这一次'), expiresAt: instant('过期时间'), identity: ref('Identity') }), '已登录')] },
  'DELETE /v1/sessions/current': { tag: '账号', summary: '登出当前会话', replies: [none('已登出')] },
  'GET /v1/me': { tag: '账号', summary: '当前身份', replies: [ok(ref('Identity'))] },

  'GET /v1/platform/tenants': { tag: '平台管理', summary: '列出租户', replies: [ok(list('tenants', 'Tenant'))] },
  'POST /v1/platform/tenants': { tag: '平台管理', summary: '开通租户，可一并设套餐', replies: [created(ref('TenantWithPlan'))] },
  'GET /v1/platform/tenants/:tenantId/members': { tag: '平台管理', summary: '列出租户的成员', replies: [ok(list('members', 'Member'))] },
  'POST /v1/platform/tenants/:tenantId/members': { tag: '平台管理', summary: '建成员账号，初始密码只出现一次', errors: [409],
    replies: [created(object({ member: ref('Member'), initialPassword: str('初始密码，只出现这一次') }))] },
  'POST /v1/platform/tenants/:tenantId/members/:memberId/password-reset': { tag: '平台管理', summary: '重置成员密码：新密码只出现一次，旧会话失效',
    replies: [ok(object({ password: str('新密码，只出现这一次') }))] },
  'GET /v1/platform/authoring-tokens': { tag: '平台管理', summary: '列出代建令牌', replies: [ok(list('tokens', 'AuthoringToken'))] },
  'POST /v1/platform/authoring-tokens': { tag: '平台管理', summary: '签发代建令牌，令牌只出现一次；指定的租户不存在时答 404', errors: [404], replies: [created(object({ token: str('代建令牌，只出现这一次'), authoringToken: ref('AuthoringToken') }))] },
  'DELETE /v1/platform/authoring-tokens/:tokenId': { tag: '平台管理', summary: '吊销代建令牌', replies: [none('已吊销')] },
  'GET /v1/platform/tenants/:tenantId/plan': { tag: '平台管理', summary: '租户的套餐', replies: [ok(ref('Plan'))] },
  'PUT /v1/platform/tenants/:tenantId/plan': { tag: '平台管理', summary: '设置套餐；当期限额随之改变', replies: [ok(ref('Plan'))] },
  'GET /v1/platform/tenants/:tenantId/usage': { tag: '平台管理', summary: '租户一个计费周期的用量', replies: [ok(ref('Usage'))] },
  'GET /v1/platform/tenants/:tenantId/usage/events': { tag: '平台管理', summary: '租户的用量明细', replies: [ok(object({ period: str(), events: array(ref('UsageEvent')), next: str('下一页的 before') }, ['period', 'events']))] },
  'GET /v1/platform/overview': { tag: '平台管理', summary: '服务健康，与每个租户的套餐、本月用量和启用的成员数；记进每个租户的审计', replies: [ok(ref('PlatformOverview'))] },
  'GET /v1/platform/builds': { tag: '平台管理', summary: '被出图记录引用的构建与在线的 worker', replies: [ok(list('builds', 'Build'))] },

  'GET /v1/tenant': { tag: '租户', summary: '本租户', replies: [ok(ref('Tenant'))] },
  'GET /v1/members': { tag: '租户', summary: '本租户的成员', replies: [ok(list('members', 'Member'))] },
  'PATCH /v1/members/:memberId': { tag: '租户', summary: '改成员的角色或停用、启用；至少保留一个启用的管理员', errors: [409], replies: [ok(ref('Member'))] },
  'GET /v1/api-keys': { tag: '租户', summary: '本租户的 API 密钥', replies: [ok(list('apiKeys', 'ApiKey'))] },
  'POST /v1/api-keys': { tag: '租户', summary: '创建 API 密钥，密钥只出现一次', replies: [created(object({ key: str('API 密钥，只出现这一次'), apiKey: ref('ApiKey') }))] },
  'DELETE /v1/api-keys/:keyId': { tag: '租户', summary: '吊销 API 密钥', replies: [none('已吊销')] },
  'GET /v1/audit-events': { tag: '租户', summary: '本租户的审计日志，按时间倒序；可按主体种类与时间筛选（from 含、to 不含）', replies: [ok(page('events', 'AuditEvent', '下一页的 before'))] },
  'GET /v1/audit-events/export.csv': { tag: '租户', summary: '按同样的筛选把审计导出为 CSV，按时间倒序；一次至多 10,000 条，超出时答 400，要缩小时间范围',
    replies: [{ status: 200, description: 'UTF-8（带 BOM）的 CSV，列名同 AuditEvent 的字段，差异的路径写成 JSON', binary: ['text/csv'] }] },

  'GET /v1/templates': { tag: '模板与预览', summary: '本租户的模板：适用尺寸范围、所用的数据定义与对外参数', replies: [ok(list('templates', 'Template'))] },
  'GET /v1/templates/:name': { tag: '模板与预览', summary: '一个模板', replies: [ok(ref('Template'))] },
  'POST /v1/previews': { tag: '模板与预览', summary: '草稿预览：同步返回图片与问题清单，不计额度', body: 'renderRequest', errors: [413, 429, 503],
    description: '请求是 DSL 1.0 的渲染请求（mode 只能省略或为 draft）。无法展开时只答问题清单；按套餐的并发数与每分钟次数限流。workingCopies=true 时用模板工作副本预览，检查与限制都一样。',
    replies: [ok(ref('PreviewResult'))] },

  'POST /v1/batches': { tag: '批量交付', summary: '提交批量正式交付：固定批次后按项异步交付', body: 'batchRequest', errors: [409, 413, 429],
    description: '请求是 DSL 1.0 的批次请求（mode 只能省略或为 final）。外层不合法整批拒绝；单项超限只让这一项失败。带 Idempotency-Key 时重试拿回同一批次（200）。'
      + '本月额度不够整批拒绝（429 quota.exceeded，回答带 quota）。',
    headers: [{ name: 'Idempotency-Key', description: '幂等键：1–200 个可见字符；同一个键配不同的请求答 409' }],
    replies: [{ status: 202, description: '已接受', json: ref('Batch') }, ok(ref('Batch'), '同一个幂等键的重试：返回原来的批次')] },
  'GET /v1/batches/:batchId': { tag: '批量交付', summary: '批次的进度与逐项结果', replies: [ok(ref('Batch'))] },
  'POST /v1/batches/:batchId/cancel': { tag: '批量交付', summary: '取消：排队的项标为未执行，正在渲染的一项被结束', replies: [ok(ref('Batch'))] },

  'GET /v1/static-schemas': { tag: '数据集', summary: '本租户的静态数据定义：名称、版本与显示名称', replies: [ok(list('staticSchemas', 'StaticSchemaSummary'))] },
  'GET /v1/static-schemas/:name/versions/:version': { tag: '数据集', summary: '一个静态数据定义的原文与编译产物；按编译产物生成数据集表单',
    replies: [ok(ref('StaticSchema'))] },
  'GET /v1/static-schemas/:name/versions/:version/workbook': { tag: '数据集', summary: 'Excel 导入的空白表：按数据定义生成表头，引用与引用列表各一张表',
    replies: [{ status: 200, description: '空白的 .xlsx', binary: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] }] },
  'POST /v1/excel-imports': { tag: '批量交付', summary: 'Excel 导入预览：逐行的数据集与问题，以及只含能提交的行的批量请求；不保存任何东西', errors: [413],
    description: '一行一个渲染项，列对应顶层字段（显示名称或字段名称），简单类型的列表用顿号、逗号、分号或换行分开写在一格，'
      + '引用与引用列表另起一张以字段显示名称命名的工作表，用关联值对应主表的行。文件、解压后的大小、单元格数、主表行数与引用展开的行数超出上限整份拒绝（413 limit.workbookTooLarge），'
      + '读不了的文件答 400 import.workbookUnreadable。出图参数与对外参数不合规时列在整份的 problems 里，回答没有 batch。确认后把回答里的 batch 提交到 POST /v1/batches。',
    replies: [ok(ref('ExcelImport'))] },
  'GET /v1/datasets': { tag: '数据集', summary: '本租户的数据集', replies: [ok(list('datasets', 'DatasetEntry'))] },
  'POST /v1/datasets': { tag: '数据集', summary: '新建数据集：按原始字节保存，按所选静态数据定义校验', body: 'datasetDocument', errors: [409, 413, 415],
    replies: [created(ref('DatasetSaved'))] },
  'POST /v1/dataset-checks': { tag: '数据集', summary: '只校验、不保存', body: 'datasetDocument', errors: [413, 415], replies: [ok(object({ problems: ref('ProblemList') }))] },
  'GET /v1/datasets/:datasetId': { tag: '数据集', summary: '读回保存时的原始字节', replies: [ok(ref('DatasetDocument'), '数据集文档（保存时的字节）')] },
  'PUT /v1/datasets/:datasetId': { tag: '数据集', summary: '修改数据集', body: 'datasetDocument', errors: [413, 415], replies: [ok(ref('DatasetSaved'))] },
  'POST /v1/datasets/:datasetId/copies': { tag: '数据集', summary: '复制数据集：只换 ID 与名称', errors: [409], replies: [created(ref('DatasetSaved'))] },

  'GET /v1/resources': { tag: '资源', summary: '本租户的图片与字体资源', replies: [ok(list('resources', 'Resource'))] },
  'POST /v1/resources': { tag: '资源', summary: '上传新的图片或字体，从 v1 开始', body: 'binary', errors: [409, 413, 415], replies: [created(ref('ResourceVersion'))] },
  'GET /v1/resources/:resourceId': { tag: '资源', summary: '一个资源与它的内容版本', replies: [ok(ref('Resource'))] },
  'GET /v1/resources/:resourceId/versions/:version/content': { tag: '资源', summary: '读回一个内容版本的字节', replies: [{ status: 200, description: '内容', binary: ['application/octet-stream'] }] },
  'POST /v1/resources/:resourceId/replacement-checks': { tag: '资源', summary: '替换检查：只读，返回受影响的模板、数据集与字体配置', body: 'binary', errors: [409, 413, 415],
    replies: [ok(object({ check: ref('ReplacementCheck'), problems: ref('ProblemList') }))] },
  'POST /v1/resources/:resourceId/replacements': { tag: '资源', summary: '凭检查报告应用替换：按预期版本追加内容版本', errors: [409], replies: [ok(ref('ResourceVersion'))] },

  'GET /v1/records': { tag: '出图记录', summary: '查询出图记录：按登记时间倒序，可按批次、模板与时间筛选', replies: [ok(page('records', 'RecordEntry', '下一页的 before，原样带回'))] },
  'GET /v1/batches/:batchId/items/:index/files/:name': { tag: '出图记录', summary: '下载一项的一个文件（图片、问题清单、布局摘要或出图记录）', errors: [500],
    replies: [{ status: 200, description: '文件内容；读取时按登记的哈希核对', binary: ['image/png', 'image/jpeg', 'application/json'] }] },
  'GET /v1/batches/:batchId/images.zip': { tag: '出图记录', summary: '整批图片的压缩包', errors: [500], replies: [{ status: 200, description: '压缩包', binary: ['application/zip'] }] },
  'GET /v1/batches/:batchId/export.zip': { tag: '出图记录', summary: '按批次导出：与本地 deliver 的批次目录相同，能离线重放', errors: [500],
    replies: [{ status: 200, description: '压缩包', binary: ['application/zip'] }] },
  'GET /v1/batches/:batchId/items/:index/export.zip': { tag: '出图记录', summary: '按项导出', errors: [500], replies: [{ status: 200, description: '压缩包', binary: ['application/zip'] }] },
  'POST /v1/batches/:batchId/items/:index/replay': { tag: '出图记录', summary: '重放：交给记录所属构建的 worker，与记录逐字节比对', errors: [429, 500, 503],
    replies: [ok(ref('ReplayResult'))] },

  'GET /v1/usage': { tag: '用量', summary: '本租户一个计费周期的用量与剩余额度；客户成员与 API 密钥都能看', replies: [ok(ref('Usage'))] },
  'GET /v1/usage/events': { tag: '用量', summary: '用量明细，按 ID 倒序；只给客户管理员', replies: [ok(object({ period: str(), events: array(ref('UsageEvent')), next: str('下一页的 before') }, ['period', 'events']))] },

  'POST /v1/webhooks': { tag: 'webhook', summary: '注册 webhook；签名密钥只在这里出现一次', errors: [409],
    description: '生产只收 https 与公网地址。缺省订阅 batch.finished。每个租户最多同时启用 10 个。',
    replies: [created(object({ webhook: ref('Webhook'), secret: str('签名密钥（whsec_ 开头），只出现这一次') }))] },
  'GET /v1/webhooks': { tag: 'webhook', summary: '本租户的 webhook', replies: [ok(list('webhooks', 'Webhook'))] },
  'GET /v1/webhooks/:webhookId': { tag: 'webhook', summary: '一个 webhook', replies: [ok(ref('Webhook'))] },
  'PATCH /v1/webhooks/:webhookId': { tag: 'webhook', summary: '停用、重新启用或改说明', errors: [409], replies: [ok(ref('Webhook'))] },
  'GET /v1/webhooks/:webhookId/deliveries': { tag: 'webhook', summary: '投递记录：各次尝试的时间、耗时与 HTTP 状态或原因', replies: [ok(page('deliveries', 'WebhookDelivery', '下一页的 before'))] },

  'GET /v1/authoring/tenants/:tenantId': { tag: '代建', summary: '被指定的租户', replies: [ok(ref('Tenant'))] },
  'GET /v1/authoring/tenants/:tenantId/workspace': { tag: '代建', summary: '租户工作区的当前状态', replies: [ok(ref('AuthoringState'))] },
  'GET /v1/authoring/tenants/:tenantId/contents/:sha256': { tag: '代建', summary: '按 SHA-256 读回已登记的内容', replies: [{ status: 200, description: '内容', binary: ['application/octet-stream'] }] },
  'PUT /v1/authoring/tenants/:tenantId/contents/:sha256': { tag: '代建', summary: '上传一份内容，按路径里的 SHA-256 核对', body: 'binary', errors: [413, 415], replies: [none('已上传')] },
  'POST /v1/authoring/tenants/:tenantId/push-plans': { tag: '代建', summary: '推送前的差异，不写任何东西', errors: [413],
    replies: [ok(object({ ...(SCHEMAS['PushDiff'] as { properties: Record<string, unknown> }).properties, uploads: array(sha256, '提交前要上传的内容') }, ['summary', 'documents', 'resources', 'uploads']))] },
  'POST /v1/authoring/tenants/:tenantId/pushes': { tag: '代建', summary: '提交推送：有冲突整体拒绝', errors: [409, 413],
    replies: [ok(object({ pushId: uuid('推送 ID'), ...(SCHEMAS['PushDiff'] as { properties: Record<string, unknown> }).properties,
      usage: object({ rounds: int('附了几轮'), recorded: int('这次新记了几轮'), tokens: object(Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, int()])), []) }) }))] },
  'POST /v1/authoring/tenants/:tenantId/previews': { tag: '代建', summary: '用被指定租户的身份看草稿预览', body: 'renderRequest', errors: [413, 429, 503], replies: [ok(ref('PreviewResult'))] },
  'POST /v1/authoring/tenants/:tenantId/template-current': { tag: '代建', summary: '把模板的当前修订指向已有的一个修订', replies: [ok(ref('TemplateRevisions'))] },
  ...definitionDocs('/v1', '数据定义'),
  ...definitionDocs('/v1/authoring/tenants/:tenantId', '代建'),
  ...workingCopyDocs('/v1', '模板与预览'),
  ...workingCopyDocs('/v1/authoring/tenants/:tenantId', '代建'),
  'POST /v1/template-current': { tag: '模板与预览', summary: '把模板的当前修订指向已有的一个修订，可以指回旧修订', errors: [404], replies: [ok(ref('TemplateRevisions'))] },
};

const PATH_PARAMS: Readonly<Record<string, Record<string, unknown>>> = {
  tenantId: uuid('租户 ID'), memberId: uuid('成员 ID'), keyId: uuid('API 密钥 ID'), tokenId: uuid('代建令牌 ID'), batchId: uuid('批次 ID'), webhookId: uuid('webhook ID'),
  name: str('名称'), datasetId: str('数据集 ID'), resourceId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$', description: '资源 ID' },
  version: { type: 'string', pattern: '^[1-9][0-9]{0,8}$', description: '内容版本' }, index: { type: 'string', pattern: '^[1-9][0-9]{0,3}$', description: '项序号（从 1 起）' },
  sha256,
};

const REQUEST_BODIES: Readonly<Record<Body, { content: Record<string, unknown>; description: string }>> = {
  batchRequest: { description: 'DSL 1.0 的批次请求', content: { 'application/json': { schema: ref('BatchRequest') } } },
  renderRequest: { description: 'DSL 1.0 的渲染请求', content: { 'application/json': { schema: ref('RenderRequest') } } },
  datasetDocument: { description: 'DSL 1.0 的数据集文档，按原始字节保存', content: { 'application/json': { schema: ref('DatasetDocument') } } },
  templateDocument: { description: '模板 DSL 的 JSON 文档，按原始字节保存；可以还有问题，保存模板时才拒绝', content: { 'application/json': { schema: { type: 'object', description: '模板 DSL（renderweave-template/1）' } } } },
  definitionDocument: { description: '数据定义 DSL 的 JSON 文档，按原始字节保存；可以还有问题，由校验回答', content: { 'application/json': { schema: { type: 'object', description: '数据定义 DSL（renderweave-schema/1）' } } } },
  binary: { description: '原始字节', content: { 'application/octet-stream': { schema: { type: 'string', contentMediaType: 'application/octet-stream' } } } },
};

const pathOf = (url: string) => url.replace(/:([A-Za-z0-9]+)/g, '{$1}');
/** 错误回答按状态放进 components.responses，各端点引用。 */
const errorResponse = (status: number) => ({ $ref: `#/components/responses/Error${status}` });

/** 路由声明里几处共用的请求 Schema 放进 components，引用它们（按对象本身认）。 */
const sharedRequestSchemas = (): ReadonlyMap<unknown, string> => new Map<unknown, string>([[MANIFEST_SCHEMA, 'PushManifest'], [PLAN_SCHEMA, 'PlanInput']]);
function named(schema: unknown, shared: ReadonlyMap<unknown, string>): unknown {
  const name = shared.get(schema);
  if (name) return ref(name);
  if (Array.isArray(schema)) return schema.map((item) => named(item, shared));
  if (typeof schema !== 'object' || schema === null) return schema;
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, named(value, shared)]));
}

/** 一个路由会有的错误状态：按访问要求（401、403）、请求（400）、路径里的对象（404），加上路由说明里列出的。 */
function errorStatuses(route: DocumentedRoute, doc: RouteDoc): number[] {
  const statuses = new Set(doc.errors ?? []);
  if (route.access !== 'public') statuses.add(401);
  if (route.access !== 'public' && route.access !== 'authenticated') statuses.add(403);
  if (route.schema?.body || route.schema?.querystring || doc.body) statuses.add(400);
  if (route.url.includes(':')) statuses.add(404);
  return [...statuses].sort((a, b) => a - b);
}

function operation(route: DocumentedRoute, doc: RouteDoc, shared: ReadonlyMap<unknown, string>): Record<string, unknown> {
  const params = [...route.url.matchAll(/:([A-Za-z0-9]+)/g)].map(([, name]) => ({ name: name!, in: 'path', required: true, schema: PATH_PARAMS[name!] ?? str() }));
  const query = route.schema?.querystring as { properties?: Record<string, unknown>; required?: string[] } | undefined;
  const parameters = [
    ...params,
    ...Object.entries(query?.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: query?.required?.includes(name) ?? false, schema })),
    ...(doc.headers ?? []).map((header) => ({ name: header.name, in: 'header', required: false, description: header.description, schema: str() })),
  ];
  const requestBody = route.schema?.body ? { required: true, content: { 'application/json': { schema: named(route.schema.body, shared) } } }
    : doc.body ? { required: true, ...REQUEST_BODIES[doc.body] } : undefined;
  const responses: Record<string, unknown> = {};
  for (const reply of doc.replies) {
    responses[String(reply.status)] = {
      description: reply.description,
      ...(reply.json ? { content: { 'application/json': { schema: reply.json } } } : {}),
      ...(reply.binary ? { content: Object.fromEntries(reply.binary.map((type) => [type, { schema: { type: 'string', contentMediaType: type } }])) } : {}),
    };
  }
  for (const status of errorStatuses(route, doc)) responses[String(status)] = errorResponse(status);
  return {
    operationId: route.method.toLowerCase() + route.url.split(/[^A-Za-z0-9]+/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(''),
    tags: [doc.tag], summary: doc.summary, ...(doc.description ? { description: doc.description } : {}),
    'x-access': route.access,
    ...(route.access === 'public' ? { security: [] } : {}),
    ...(parameters.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
}

/** 由已注册的路由生成 OpenAPI 描述；有路由没写说明、或说明里有不存在的路由时报错。 */
export function buildOpenApi(routes: readonly DocumentedRoute[]): Record<string, unknown> {
  const keys = new Set(routes.map((route) => `${route.method} ${route.url}`));
  const undocumented = [...keys].filter((key) => !ROUTE_DOCS[key]);
  const stale = Object.keys(ROUTE_DOCS).filter((key) => !keys.has(key));
  if (undocumented.length || stale.length) throw new Error(`OpenAPI 说明与路由不符：没有说明 ${undocumented.join('、') || '无'}；多余 ${stale.join('、') || '无'}`);
  const paths: Record<string, Record<string, unknown>> = {}, shared = sharedRequestSchemas(), statuses = new Set<number>();
  for (const route of [...routes].sort((a, b) => (pathOf(a.url) < pathOf(b.url) ? -1 : pathOf(a.url) > pathOf(b.url) ? 1 : a.method < b.method ? -1 : 1))) {
    const doc = ROUTE_DOCS[`${route.method} ${route.url}`]!;
    for (const status of errorStatuses(route, doc)) statuses.add(status);
    (paths[pathOf(route.url)] ??= {})[route.method.toLowerCase()] = operation(route, doc, shared);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'RenderWeave 出图服务开放 API', version: API_VERSION,
      description: '按数据定义、模板与数据集出图的多租户服务。错误回答一律是问题清单；1.x 只做加法，客户端应忽略不认识的属性与枚举值。说明见 docs/api.md。',
    },
    servers: [{ url: '/' }],
    security: [{ bearer: [] }],
    tags: [...new Set(Object.values(ROUTE_DOCS).map((doc) => doc.tag))].map((name) => ({ name })),
    paths,
    webhooks: {
      'batch.finished': { post: {
        summary: '批次结束（完成、部分失败、全部失败或取消）时，向每个启用、订阅了它的 webhook 投递一次',
        description: '请求头 RenderWeave-Signature: t=<Unix 秒>,v1=<HMAC-SHA256(签名密钥, "<t>.<正文>") 的十六进制>；另带 RenderWeave-Event-Id、RenderWeave-Event-Type、'
          + 'RenderWeave-Delivery-Id 与 RenderWeave-Attempt。2xx 算成功，其余按指数退避重试有限次。接收端按事件 ID 去重。',
        requestBody: { required: true, content: { 'application/json': { schema: ref('BatchFinishedEvent') } } },
        responses: { '200': { description: '任何 2xx 都算收到' } },
      } },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: '会话令牌（rws_）、API 密钥（rwk_）或代建令牌（rwa_）' } },
      schemas: { ...SCHEMAS, ...Object.fromEntries([...shared].map(([schema, name]) => [name, schema])) },
      responses: Object.fromEntries([...statuses].sort((a, b) => a - b).map((status) => [`Error${status}`,
        { description: STATUS_TEXT[status] ?? '错误', content: { 'application/json': { schema: ref('ErrorResponse') } } }])),
    },
  };
}
