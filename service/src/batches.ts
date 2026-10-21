/**
 * 批次的逐项结果与汇总（票据 07，M153、ADR-0019）：内存与 PostgreSQL 后端、接口进程与 worker 共用。
 * 批次清单由引擎的 summarizeBatch 生成，语义与字节都与本地 deliver 的 batch.json 相同。
 */
import type { BatchState, ItemResult, ResultProblem, TenantBatch } from './backend.js';
import { ProblemCodes, summarizeBatch, type BatchItemFiles, type BatchItemResult, type BatchManifest, type RenderMode } from './engine.js';

const RECORD_LOCATION = { kind: 'input', source: 'outputRecord' } as const;
export const batchProblem = (code: string, message: string): ResultProblem => ({ level: 'severe', code, location: RECORD_LOCATION, message });

export const CANCELLED = '已取消：还没开始的项未执行，正在渲染的一项被结束';
export const NOT_STARTED = '批次已取消，本项没有开始，未执行';
export const KILLED = '批次已取消，本项渲染中被结束，未交付';

/** 未执行的一项：批次取消时还没开始，或渲染中被结束。 */
export const notRunItem = (index: number, id: string, reason: string): ItemResult =>
  ({ index, id, status: 'notRun', severe: 1, hints: 0, reason, problems: [batchProblem(ProblemCodes.deliveryNotRun, reason)] });

const severeCount = (problems: readonly ResultProblem[]) => problems.filter((p) => p.level === 'severe').length;

/** 引擎写出的文件引用的键序：图片、问题清单、布局摘要、完成清单。 */
function canonicalFiles(files: BatchItemFiles): BatchItemFiles {
  return {
    ...(files.image ? { image: files.image } : {}), problems: files.problems, ...(files.layout ? { layout: files.layout } : {}),
    ...(files.record ? { record: files.record } : {}), ...(files.preview ? { preview: files.preview } : {}),
  };
}

/** 结果的键按引擎的顺序排列：数据库的 jsonb 不保留键序，批次清单的字节要与本地相同。 */
export function canonicalItem(item: ItemResult): ItemResult {
  return {
    index: item.index, id: item.id, status: item.status, ...(item.directory ? { directory: item.directory } : {}),
    ...(item.files ? { files: canonicalFiles(item.files) } : {}), severe: item.severe, hints: item.hints,
    ...(item.reason === undefined ? {} : { reason: item.reason }), problems: item.problems,
  };
}

/** 全部项结束后的批次清单（batch.json）。取消过的批次带批次级问题 delivery.cancelled。 */
export function batchManifest(batch: { readonly build: string; readonly template: string; readonly mode: RenderMode; readonly cancelled: boolean },
  items: readonly ItemResult[]): BatchManifest {
  return summarizeBatch({ build: batch.build, envelope: { template: batch.template, mode: batch.mode } },
    [...items].sort((a, b) => a.index - b.index).map(canonicalItem) as unknown as BatchItemResult[],
    batch.cancelled ? [batchProblem(ProblemCodes.deliveryCancelled, CANCELLED) as never] : []);
}

/**
 * 已登记的一项：按登记的文件还原它的结果，与引擎交付时返回的相同。worker 重领已登记的项时沿用它，不重渲染（ADR-0019）。
 * 还没登记时 undefined。
 */
export async function committedItem(batch: TenantBatch, index: number, id: string): Promise<ItemResult | undefined> {
  const registered = await batch.itemFiles(index);
  if (!registered) return undefined;
  const names = registered.map((file) => file.name);
  const problems = JSON.parse(Buffer.from(await batch.record(index).read('problems.json')).toString('utf8')) as ResultProblem[];
  const delivered = names.includes('record.json');
  const image = names.find((name) => name === 'image.png' || name === 'image.jpg') as BatchItemFiles['image'];
  const files: BatchItemFiles = delivered
    ? { image, problems: 'problems.json', layout: 'layout.json', record: 'record.json' }
    : { problems: 'problems.json', ...(names.includes('layout.json') ? { layout: 'layout.json' as const } : {}) };
  const severe = severeCount(problems);
  return { index, id, status: delivered ? 'delivered' : 'failed', directory: batch.output.location(index), files, severe, hints: problems.length - severe, problems };
}

/**
 * 批次结束的结果（票据 11）：请求过取消的是 cancelled；否则全部交付是 completed，一项也没交付是 failed，其余是 partiallyFailed。
 * 取消请求晚于最后一项开始时，各项可能都已交付，仍记 cancelled，与批次清单里的 delivery.cancelled 一致。
 */
export type BatchOutcome = 'completed' | 'partiallyFailed' | 'failed' | 'cancelled';

export function batchOutcome(summary: BatchManifest['summary'], cancelled: boolean): BatchOutcome {
  if (cancelled) return 'cancelled';
  if (summary.delivered === summary.total) return 'completed';
  return summary.delivered === 0 ? 'failed' : 'partiallyFailed';
}

/** 接口回答里的批次。 */
export interface BatchView {
  readonly id: string;
  readonly template: string;
  readonly mode: RenderMode;
  readonly build: string;
  readonly idempotencyKey?: string;
  /** running：还有项没结束；finished：全部项结束，批次清单已发布。 */
  readonly status: 'running' | 'finished';
  /** 结束时才有（票据 11）：全部交付、部分失败、全部失败或已取消。 */
  readonly outcome?: BatchOutcome;
  readonly cancelRequested: boolean;
  readonly createdAt: string;
  readonly finishedAt?: string;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly summary: BatchManifest['summary'];
  readonly items: readonly Record<string, unknown>[];
  readonly problems: readonly ResultProblem[];
}

export function batchView(state: BatchState): BatchView {
  const ended = state.items.flatMap((item) => (item.result ? [item.result] : []));
  const count = (status: ItemResult['status']) => ended.filter((item) => item.status === status).length;
  const summary = state.manifest?.summary ?? {
    total: state.items.length, delivered: count('delivered'), previewed: 0, failed: count('failed'), notRun: count('notRun'),
    severe: ended.reduce((sum, item) => sum + item.severe, 0), hints: ended.reduce((sum, item) => sum + item.hints, 0),
  };
  return {
    id: state.batchId, template: state.template, mode: state.mode, build: state.build,
    ...(state.idempotencyKey === undefined ? {} : { idempotencyKey: state.idempotencyKey }),
    status: state.manifest ? 'finished' : 'running',
    ...(state.manifest ? { outcome: batchOutcome(state.manifest.summary, state.cancelRequestedAt !== undefined) } : {}),
    cancelRequested: state.cancelRequestedAt !== undefined,
    createdAt: state.createdAt, ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    progress: { completed: ended.length, total: state.items.length }, summary,
    items: state.items.map((item) => {
      if (!item.result) return { index: item.index, id: item.id, status: item.status };
      const { directory: _directory, ...result } = canonicalItem(item.result);
      return result;
    }),
    problems: state.manifest?.problems ?? [],
  };
}

/** 批次结束事件的正文（票据 11）：批次的摘要，不含逐项结果；接收端要逐项结果时用 GET /v1/batches/{batchId} 取。 */
export function batchFinishedEvent(event: { readonly id: string; readonly tenantId: string; readonly createdAt: Date }, state: BatchState): string {
  const { items: _items, progress: _progress, status: _status, ...batch } = batchView(state);
  return JSON.stringify({ id: event.id, type: 'batch.finished', createdAt: event.createdAt.toISOString(), tenantId: event.tenantId, data: { batch } });
}
