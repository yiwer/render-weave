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
  readonly email?: string;
  readonly tenantId?: string;
}

export interface Usage {
  readonly period: string;
  readonly images: { readonly limit: number; readonly used: number; readonly reserved: number; readonly remaining: number };
}

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
