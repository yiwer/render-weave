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

export interface Identity {
  readonly kind: 'member' | 'platformUser' | 'apiKey' | 'authoringToken';
  readonly role: string;
  readonly userId?: string;
  readonly email?: string;
  readonly tenantId?: string;
}

export type TokenKind = 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens';
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

export interface StaticSchemaSummary { readonly name: string; readonly version: number; readonly displayName: string; readonly description?: string }
export interface StaticSchemaDetail extends StaticSchemaSummary { readonly compiled: Record<string, unknown> }

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
}

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
