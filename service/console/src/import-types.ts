import type { Problem, SchemaRef } from './types.js';
export interface ImportJob {
  id: string; revision: number; status: 'queued' | 'running' | 'needsReview' | 'applied' | 'failed' | 'cancelled';
  filename: string; brief: string; staticSchema: SchemaRef; createdAt: string; updatedAt: string;
  source: { sha256: string }; events: { sequence: number; at: string; message: string }[]; message?: string; datasetIds?: string[];
}
export interface ImportReview {
  notes: string;
  candidates: { path: string; name?: string; edited: boolean; document?: { dataset: Record<string, unknown>; data: unknown }; problems: Problem[] }[];
  pending: { item: number; file: string; note: string; decision?: { note?: string } }[];
  problems: Problem[];
  excel?: {
    sheets: { id: string; name: string }[];
    sources: { datasetId: string; path: string; sheet: string; cells: string[]; rule: string; parts?: string[]; mapping?: { separators: string[]; values: Record<string, unknown> } }[];
    comments?: { sheet: string; cell: string; text: string; author: string; part: string; vml?: { row: number; column: number; anchor: number[]; visible: boolean } }[];
    context: { sheet: string; range: string; reason: string }[];
    commentContext?: { sheet: string; cell: string; reason: string }[];
  };
}
export interface ImportDetail { job: ImportJob; review?: ImportReview }
export interface ImportCells { sheets: { id: string; name: string }[]; sheet: string; cells: { address: string; value?: unknown; display?: string; formula?: string; displayStatus?: string }[]; total: number; offset: number }
