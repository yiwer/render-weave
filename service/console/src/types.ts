/** 控制台用到的开放 API 回答（见 docs/service.md）。 */

export type ProblemLocation =
  | { readonly kind: 'field'; readonly path: string }
  | { readonly kind: 'parameter'; readonly name: string; readonly path?: string }
  | { readonly kind: 'element'; readonly path: string }
  | { readonly kind: 'check'; readonly template: string; readonly name: string; readonly path?: string }
  | { readonly kind: 'variable'; readonly template: string; readonly name: string; readonly path?: string }
  | { readonly kind: 'definition'; readonly schema: string; readonly path: string }
  | { readonly kind: 'input'; readonly source: string };

export interface Problem {
  readonly code: string;
  readonly level: 'severe' | 'hint';
  readonly location: ProblemLocation;
  readonly message: string;
}

/** 套餐（M274）。 */
export interface PlanSettings {
  readonly monthlyImages: number;
  readonly maxPixels: number;
  readonly concurrency: number;
}

export interface AuthoringTokenInfo {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly tenantIds: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

/** 平台管理页的一行租户。 */
export interface PlatformTenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly plan: PlanSettings;
  readonly images: { readonly limit: number; readonly used: number; readonly reserved: number; readonly remaining: number };
  readonly tokens: Readonly<Record<string, number>>;
  readonly members: number;
}

interface TaskCounts { readonly preview: number; readonly batchItem: number; readonly replay: number }

/** GET /v1/platform/overview。 */
export interface PlatformOverview {
  readonly service: {
    readonly ready: boolean;
    readonly schemaVersion?: number;
    readonly checks: Readonly<Record<string, string>>;
    readonly workers: readonly { readonly build: string; readonly workers: number }[];
    readonly queue?: { readonly queued: TaskCounts; readonly running: TaskCounts; readonly oldestQueuedMs: number };
  };
  readonly period: string;
  readonly tenants: readonly PlatformTenant[];
}

export interface Identity {
  readonly kind: 'member' | 'platformUser' | 'apiKey' | 'authoringToken';
  readonly role: string;
  readonly userId?: string;
  readonly email?: string;
  readonly tenantId?: string;
}

export interface Tenant { readonly id: string; readonly name: string; readonly createdAt: string }

export type TokenKind ='inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens';
export type UsageKind = 'image' | TokenKind;

/** 一个计费周期的用量（票据 09）：周期是按 UTC+8 切分的自然月。 */
export interface Usage {
  readonly period: string;
  readonly start: string;
  readonly end: string;
  readonly plan: { readonly monthlyImages: number; readonly maxPixels: number; readonly concurrency: number };
  readonly images: { readonly limit: number; readonly used: number; readonly reserved: number; readonly remaining: number };
  readonly tokens: Readonly<Record<TokenKind, number>>;
}

/** 一条用量事件：出处是批次与项，或代建的一轮。 */
export interface UsageEvent {
  readonly id: string;
  readonly at: string;
  readonly period: string;
  readonly kind: UsageKind;
  readonly quantity: number;
  readonly batchId?: string;
  readonly index?: number;
  readonly round?: { readonly sha256: string; readonly task: string; readonly round: number };
}

/** 一条出图记录（票据 08）：正式交付成功、已登记的一项。 */
export interface RecordEntry {
  readonly batchId: string;
  readonly index: number;
  readonly id: string;
  readonly template: string;
  readonly build: string;
  readonly deliveredAt: string;
  readonly image: string;
}

export interface Member {
  readonly id: string;
  readonly email: string;
  readonly role: 'admin' | 'operator';
  readonly active: boolean;
  readonly createdAt: string;
}

export interface ApiKeyInfo {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly description?: string;
  readonly events: readonly string[];
  readonly secretPrefix: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly disabledAt?: string;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly batchId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly createdAt: string;
  readonly nextAttemptAt?: string;
  readonly finishedAt?: string;
  readonly attempts: readonly { readonly attempt: number; readonly at: string; readonly durationMs: number; readonly statusCode?: number; readonly error?: string }[];
}

export const ACTOR_KINDS = ['member', 'apiKey', 'authoringToken', 'platformUser', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** 代建写入的差异摘要：计数是全部的，路径至多 50 项。 */
export interface AuditDiff {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
  readonly paths: readonly { readonly path: string; readonly change: 'added' | 'removed' | 'changed'; readonly beforeSha256?: string; readonly afterSha256?: string }[];
}

export interface AuditEvent {
  readonly id: string;
  readonly at: string;
  readonly actor: { readonly kind: string; readonly id: string; readonly label: string };
  readonly action: string;
  readonly object: { readonly type: string; readonly id: string };
  readonly crossTenant: boolean;
  /** 代建写入（API 1.1.0）：写入前后的内容哈希与差异摘要；轮次与理由给 Agent 用。 */
  readonly beforeSha256?: string;
  readonly afterSha256?: string;
  readonly diff?: AuditDiff;
  readonly round?: string;
  readonly reason?: string;
}

/** 审计的筛选：主体种类与时间，from 含、to 不含。 */
export interface AuditQuery { readonly actorKind?: ActorKind; readonly from?: string; readonly to?: string }

/** 一页结果：next 原样带回就是下一页。 */
export interface PageOf<T> { readonly items: readonly T[]; readonly next?: string }

export interface SchemaRef { readonly name: string; readonly version: number }
export interface Range { readonly min: number; readonly max: number }

export interface TemplateParameter {
  readonly name: string;
  readonly displayName: string;
  readonly type: 'text' | 'number' | 'date' | 'time' | 'datetime' | 'boolean' | 'image' | 'color';
  readonly constraints?: { readonly enum?: readonly (string | number)[]; readonly min?: number; readonly max?: number; readonly integer?: boolean; readonly maxLength?: number };
  readonly default?: unknown;
}

export interface TemplateInfo {
  readonly name: string;
  readonly currentRevision: number;
  readonly base?: SchemaRef;
  readonly sizeRange?: { readonly width: Range; readonly height: Range };
  readonly parameters?: readonly TemplateParameter[];
  readonly problems?: readonly Problem[];
}

/** 模板工作副本（P1 票据 07）：一个模板至多一份，记它基于哪个修订；复制出来的新模板没有基准。 */
export interface TemplateWorkingCopy {
  readonly name: string;
  readonly baseRevision?: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

/** 结构化差异的一处改动（引擎的 revisionDiff）：path 是元素路径或模板层的键，改了的属性在 properties。 */
export interface TemplateChange {
  readonly path: string;
  readonly target: 'element' | 'template';
  readonly change: 'added' | 'removed' | 'changed';
  readonly properties?: readonly { readonly key: string; readonly before?: unknown; readonly after?: unknown }[];
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface RevisionDiff {
  readonly status: 'modified' | 'unchanged' | 'added';
  readonly changes: readonly TemplateChange[];
}

/** 基准不是当前修订时的两边差异：ours 是基准到工作副本，theirs 是基准到当前修订。 */
export interface RevisionConflict {
  readonly baseRevision?: number;
  readonly currentRevision: number;
  readonly ours: RevisionDiff;
  readonly theirs: RevisionDiff;
}

export interface WorkingCopyCheck {
  readonly sha256: string;
  readonly baseRevision?: number;
  readonly currentRevision?: number;
  readonly problems: readonly Problem[];
  readonly changes: RevisionDiff;
  readonly conflict?: RevisionConflict;
}

export interface TemplateSaved { readonly name: string; readonly revision: number; readonly status: 'saved' | 'unchanged'; readonly sha256: string }

export interface TemplateRevisions {
  readonly name: string;
  readonly currentRevision: number;
  /** 当前修订的来历：指回不产生修订，所以另外记（1.6.0）。 */
  readonly current?: { readonly source: 'push' | 'web'; readonly action: 'revision' | 'setCurrent'; readonly by: string; readonly at: string };
  readonly revisions: readonly { readonly revision: number; readonly sha256: string; readonly byteLength: number; readonly createdAt: string; readonly pushedBy: string; readonly source: 'push' | 'web' }[];
}

/** Excel 导入（票据 13）：工作簿里的位置与导入预览。 */
export interface WorkbookCell { readonly sheet: string; readonly row: number; readonly column?: string; readonly header?: string }
export type ImportProblem = Problem & { readonly cell?: WorkbookCell };
export interface ExcelImportRow {
  readonly row: number;
  readonly itemId: string;
  readonly status: 'accepted' | 'rejected';
  readonly dataset: unknown;
  readonly problems: readonly ImportProblem[];
}
export interface ExcelImport {
  readonly template: string;
  readonly staticSchema: SchemaRef;
  readonly sheet: string;
  readonly summary: { readonly rows: number; readonly accepted: number; readonly rejected: number };
  readonly rows: readonly ExcelImportRow[];
  readonly problems: readonly ImportProblem[];
  readonly batch?: { readonly template: string; readonly mode: 'final'; readonly items: readonly Record<string, unknown>[] };
}

export interface StaticSchemaSummary { readonly name: string; readonly version: number; readonly displayName: string; readonly description?: string; readonly fieldCount?: number; readonly referenceDepth?: number }
export interface StaticSchemaDetail extends StaticSchemaSummary { readonly definition: DefinitionDocument; readonly compiled: Record<string, unknown> }

export type FieldType = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'boolean' | 'image' | 'list' | 'ref';

/** 列表的元素：类型、约束与引用（docs/dsl/data-definition.md）。 */
export interface DefinitionItems { readonly type: FieldType; readonly constraints?: Readonly<Record<string, unknown>>; readonly ref?: SchemaRef }

export interface DefinitionField extends DefinitionItems {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly items?: DefinitionItems;
}

/** 数据定义文档。没写完的草案也能存，页面只改 fields，别的键原样带回。 */
export interface DefinitionDocument {
  readonly dslVersion: string;
  readonly name: string;
  readonly version?: number;
  readonly displayName?: string;
  readonly description?: string;
  readonly fields: readonly DefinitionField[];
}

/** 数据定义草案（P1 票据 04）：一个名称至多一份，内容哈希是保存时的预期哈希。 */
export interface DefinitionDraft {
  /** 只有列数据定义时才有。 */
  readonly displayName?: string;
  readonly fieldCount?: number;
  readonly name: string;
  readonly baseVersion?: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface Definition {
  readonly name: string;
  readonly displayName: string;
  readonly versions: readonly { readonly version: number; readonly displayName: string; readonly datasets: number; readonly templates: number }[];
  readonly draft?: DefinitionDraft;
}

export interface TemplateBinding { readonly name: string; readonly base: SchemaRef }

/** GET /v1/definitions/{name}：另带每个字段被哪些模板读到。 */
export interface DefinitionDetail extends Definition {
  readonly fieldUses: readonly { readonly field: string; readonly templates: readonly TemplateBinding[] }[];
}

export interface DefinitionDraftCheck {
  readonly sha256: string;
  readonly problems: readonly Problem[];
  readonly version?: number;
  readonly compiled?: Record<string, unknown>;
  readonly affectedBindings: readonly { readonly field: string; readonly templates: readonly TemplateBinding[] }[];
}

export interface DefinitionProperty { readonly key: string; readonly before?: unknown; readonly after?: unknown }

export interface DefinitionFieldChange {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'changed';
  readonly before?: DefinitionField;
  readonly after?: DefinitionField;
  readonly properties?: readonly DefinitionProperty[];
  readonly affectsBindings?: boolean;
}

/** 引擎 diffDefinition 的结果（去掉 problems）。 */
export interface DefinitionDiff {
  readonly definition: readonly DefinitionProperty[];
  readonly fields: readonly DefinitionFieldChange[];
  readonly order?: { readonly before: readonly string[]; readonly after: readonly string[] };
}

/** 发布预检（P1 票据 05）：有严重问题时只有 sha256、baseVersion 与 problems。 */
export interface DefinitionPublishCheck {
  readonly sha256: string;
  readonly baseVersion?: number;
  readonly problems: readonly Problem[];
  readonly version?: number;
  readonly diff?: DefinitionDiff;
  readonly datasets?: {
    readonly total: number;
    readonly checked: number;
    readonly complete: boolean;
    readonly mismatched: number;
    readonly samples: readonly { readonly id: string; readonly problemCount: number; readonly problems: readonly Problem[] }[];
  };
  readonly templates?: readonly TemplateBinding[];
}

export interface DefinitionPublished { readonly name: string; readonly version: number; readonly baseVersion?: number; readonly definitionSha256: string; readonly compiledSha256: string }

/** 发布记录的一行（M355）：谁、何时与来源取自审计，找不到时没有。 */
export interface DefinitionPublication {
  readonly name: string;
  readonly version: number;
  readonly displayName: string;
  readonly sha256: string;
  readonly compiledSha256: string;
  readonly baseVersion?: number;
  readonly baseSha256?: string;
  readonly source?: 'web' | 'push';
  readonly at?: string;
  readonly actor?: { readonly kind: string; readonly label: string };
  readonly diff: DefinitionDiff;
}

export interface DatasetEntry {
  readonly id: string;
  readonly name?: string;
  readonly staticSchema?: SchemaRef;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface ResourceInfo {
  readonly id: string;
  readonly kind: 'image' | 'font';
  readonly currentVersion: number;
  readonly versions?: readonly { readonly version: number; readonly sha256: string; readonly byteLength: number }[];
}

/** 替换检查报告（票据 10，M152）：应用替换时原样交回。 */
export interface ReplacementCheck {
  readonly resource: { readonly id: string; readonly kind: 'image' | 'font'; readonly version: number; readonly sha256: string; readonly byteLength: number };
  readonly replacement: { readonly sha256: string; readonly byteLength: number };
  readonly impact: {
    readonly workspaceFingerprint: string;
    readonly renderOptions: { readonly fallbackFonts: readonly string[]; readonly svgFonts: readonly string[] };
    readonly references: readonly { readonly kind: string; readonly document: string; readonly source: string; readonly path: string }[];
    readonly configuration: readonly { readonly kind: 'fallbackFonts' | 'svgFonts'; readonly path: string }[];
    readonly scope: string;
  };
}

export interface OutputSettings { readonly width: number; readonly height: number; readonly dpi: number; readonly format: 'png' | 'jpeg' }

export interface LayoutNode {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly children?: readonly LayoutNode[];
}

export interface PreviewReply {
  readonly image?: { readonly format: 'png' | 'jpeg'; readonly widthPx: number; readonly heightPx: number; readonly dpi: number; readonly base64: string };
  readonly problems: readonly Problem[];
  readonly layout?: { readonly output: { readonly width: number; readonly height: number }; readonly root: LayoutNode };
  /** 元素定位：会显示的元素实例，path 与布局摘要的元素路径相同，source 是它所在的模板文档与在文档里的路径。 */
  readonly elements?: readonly ElementLocation[];
}

export interface ElementLocation { readonly path: string; readonly source: { readonly template: string; readonly path: string } }

export type ItemStatus = 'queued' | 'running' | 'delivered' | 'failed' | 'notRun';

export interface BatchItem {
  readonly index: number;
  readonly id: string;
  readonly status: ItemStatus;
  readonly files?: { readonly image?: string };
  readonly problems?: readonly Problem[];
}

export interface BatchView {
  readonly id: string;
  readonly template: string;
  readonly status: 'running' | 'finished';
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly summary: { readonly total: number; readonly delivered: number; readonly failed: number; readonly notRun: number };
  readonly items: readonly BatchItem[];
  readonly problems: readonly Problem[];
}

/** 审批策略（P1 票据 11）：两个范围各一个开关，缺省关。 */
export type ApprovalScope = 'definitions' | 'templates';
export interface ApprovalSetting { readonly required: boolean; readonly updatedAt?: string; readonly updatedBy?: string }
export type ApprovalPolicy = Readonly<Record<ApprovalScope, ApprovalSetting>>;

/** 发布申请：一次发布或推送留下的待批准记录，固定内容哈希与基准。 */
export interface PublishRequest {
  readonly id: string;
  readonly kind: 'definitionPublish' | 'templateSave' | 'templateSetCurrent' | 'push';
  readonly subject: string;
  readonly scopes: readonly ApprovalScope[];
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired';
  readonly sha256: string;
  readonly beforeSha256?: string;
  readonly baseVersion?: number;
  readonly version?: number;
  readonly baseRevision?: number;
  readonly revision?: number;
  readonly overwrite?: boolean;
  readonly diff: { readonly added: number; readonly removed: number; readonly changed: number; readonly paths: readonly { readonly path: string; readonly change: 'added' | 'removed' | 'changed' }[] };
  readonly requestedBy: { readonly kind: string; readonly id: string; readonly label: string };
  readonly requestedAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly message?: string;
}

/** 详情：待处理时另有重核结果与它改了什么；changes 的结构随 kind 不同。 */
export interface PublishRequestDetail extends PublishRequest {
  readonly changes?: unknown;
  readonly recheck?: { readonly valid: boolean; readonly message?: string; readonly blockers?: readonly Problem[] };
}
