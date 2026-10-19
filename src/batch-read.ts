/** 辨认批次：批次清单已发布即运行已结束；缺少时按各项已发布的完成清单辨认已完整的项，不把残留文件当成功。 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { RecordError, recordFail } from './record-input.js';
import { itemDirectory, localBatchSource, type BatchSource } from './record-stores.js';
import type { BatchItemStatus, BatchManifest } from './output-records.js';
import { describeError, isRecord } from './util.js';

/** 没有批次清单时找到的一项。 */
export interface FoundBatchItem {
  /** 由子目录名得出的输入顺序，从 1 开始。 */
  readonly index: number;
  /** 可直接打开的本项目录。 */
  readonly directory: string;
  /** delivered/previewed：完成清单已发布，内容完整；incomplete：没有完成清单（失败或中断），不算交付。 */
  readonly status: 'delivered' | 'previewed' | 'incomplete';
  /** 完成清单中的项标识；incomplete 没有。 */
  readonly id?: string;
}
/** finished：batch.json 已发布，整批运行已结束（可能有失败、未执行或已取消）；unfinished：没有 batch.json，运行中断或仍在进行。 */
export type BatchReading =
  | { readonly state: 'finished'; readonly directory: string; readonly manifest: BatchManifest }
  | { readonly state: 'unfinished'; readonly directory: string; readonly items: readonly FoundBatchItem[] };

const STATUSES = new Set<BatchItemStatus>(['delivered', 'previewed', 'failed', 'notRun']);
const json = (bytes: Uint8Array): unknown => JSON.parse(Buffer.from(bytes).toString('utf8'));

/** 只看完成清单是否已发布并核对格式与项标识；逐文件哈希由 record-read 负责。 */
async function itemManifest(source: BatchSource, index: number): Promise<{ status: 'delivered' | 'previewed'; id: string } | undefined> {
  const completion = await source.completion(index);
  if (!completion) return undefined;
  const record = completion.name === 'record.json', raw = json(completion.bytes);
  if (!isRecord(raw) || raw.format !== (record ? 'renderweave-output-record/1' : 'renderweave-preview/1') || typeof raw.itemId !== 'string' || !raw.itemId) {
    recordFail(`第 ${itemDirectory(index)} 项的完成清单不合法`);
  }
  return { status: record ? 'delivered' : 'previewed', id: raw.itemId };
}

function batchManifest(raw: unknown): BatchManifest {
  if (!isRecord(raw) || raw.format !== 'renderweave-batch/1') recordFail('不支持的批次清单格式版本');
  if (typeof raw.build !== 'string' || typeof raw.template !== 'string' || (raw.mode !== 'final' && raw.mode !== 'draft') ||
    !isRecord(raw.summary) || !Array.isArray(raw.items) || !Array.isArray(raw.problems)) recordFail('批次清单不完整');
  raw.items.forEach((entry: unknown, i) => {
    if (!isRecord(entry) || entry.index !== i + 1 || typeof entry.id !== 'string' || !STATUSES.has(entry.status as BatchItemStatus) ||
      (entry.directory !== undefined && entry.directory !== itemDirectory(i + 1)) ||
      (entry.status === 'delivered' && raw.mode !== 'final') || (entry.status === 'previewed' && raw.mode !== 'draft')) recordFail(`批次清单第 ${i + 1} 项不合法`);
  });
  return raw as unknown as BatchManifest;
}

/** 读取本地批次目录。 */
export function readBatch(options: { readonly dir: string }): Promise<{ batch?: BatchReading; problems: readonly Problem[] }> {
  return readBatchFrom(localBatchSource(options.dir));
}

/**
 * 读取一个批次。有批次清单时核对清单与各项成果一致后返回清单；
 * 没有时按各项已发布的 record.json 或 preview.json 判定该项完整，其余报告为 incomplete。
 */
export async function readBatchFrom(source: BatchSource): Promise<{ batch?: BatchReading; problems: readonly Problem[] }> {
  try {
    const published = await source.manifest();
    const indexes = await source.items();
    if (!published) {
      const items: FoundBatchItem[] = [];
      for (const index of indexes) {
        const found = await itemManifest(source, index);
        items.push({ index, directory: source.itemLocation(index), status: found?.status ?? 'incomplete', ...(found ? { id: found.id } : {}) });
      }
      const complete = items.filter((item) => item.status !== 'incomplete');
      if (new Set(complete.map((item) => item.status)).size > 1) recordFail('批次目录中同时有正式记录与草稿预览');
      if (new Set(complete.map((item) => item.id)).size !== complete.length) recordFail('批次目录中的项标识重复');
      return { batch: { state: 'unfinished', directory: source.location, items }, problems: [] };
    }
    const manifest = batchManifest(json(published));
    const listed = new Set<number>();
    for (const entry of manifest.items) {
      if (!entry.directory) continue;
      listed.add(entry.index);
      if (!indexes.includes(entry.index)) recordFail(`批次清单列出的目录不存在：${entry.directory}`);
      const found = await itemManifest(source, entry.index);
      const expected = entry.status === 'delivered' || entry.status === 'previewed' ? entry.status : undefined;
      if (found?.status !== expected || (found && found.id !== entry.id)) recordFail(`第 ${entry.directory} 项与批次清单不一致`);
    }
    // 写入失败的项在清单中没有目录，存储中却可能留下未发布完成清单的残留成果。
    for (const index of indexes.filter((index) => !listed.has(index))) {
      const entry = manifest.items[index - 1];
      if (entry?.status !== 'failed' || await itemManifest(source, index)) recordFail(`批次目录含清单未列出的子目录：${itemDirectory(index)}`);
    }
    return { batch: { state: 'finished', directory: source.location, manifest }, problems: [] };
  } catch (error) {
    return { problems: [severe(error instanceof RecordError ? error.code : ProblemCodes.recordInvalid, { kind: 'input', source: 'outputRecord' }, describeError(error))] };
  }
}
