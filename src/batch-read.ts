/** 辨认批次目录：batch.json 已发布即运行已结束；缺少时按各项已发布的完成清单辨认已完整的项，不把残留文件当成功。 */
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { MAX_BATCH_ITEMS, RecordError, recordFail } from './record-input.js';
import { readRecordFile } from './record-files.js';
import { itemDirectory, type BatchItemStatus, type BatchManifest } from './output-records.js';
import { describeError, isRecord } from './util.js';

/** 没有 batch.json 时找到的一项。 */
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

const ITEM = /^\d{4}$/;
const STATUSES = new Set<BatchItemStatus>(['delivered', 'previewed', 'failed', 'notRun']);
const json = async (root: string, file: string): Promise<unknown> => JSON.parse(Buffer.from(await readRecordFile(root, file)).toString('utf8'));
async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 只看完成清单是否已发布并核对格式与项标识；逐文件哈希由 record-read 负责。 */
async function itemManifest(root: string, name: string): Promise<{ status: 'delivered' | 'previewed'; id: string } | undefined> {
  const dir = join(root, name);
  if (!(await fs.lstat(dir)).isDirectory()) recordFail(`批次子目录必须是普通目录：${name}`);
  const record = await exists(join(dir, 'record.json')), preview = await exists(join(dir, 'preview.json'));
  if (record && preview) recordFail(`第 ${name} 项同时有出图记录与预览清单`);
  if (!record && !preview) return undefined;
  const raw = await json(dir, record ? 'record.json' : 'preview.json');
  if (!isRecord(raw) || raw.format !== (record ? 'renderweave-output-record/1' : 'renderweave-preview/1') || typeof raw.itemId !== 'string' || !raw.itemId) {
    recordFail(`第 ${name} 项的完成清单不合法`);
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

/**
 * 读取批次目录。有 batch.json 时核对清单与各项目录一致后返回清单；
 * 没有时扫描受控序号子目录，以已发布的 record.json 或 preview.json 判定该项完整，其余报告为 incomplete。
 */
export async function readBatch(options: { readonly dir: string }): Promise<{ batch?: BatchReading; problems: readonly Problem[] }> {
  try {
    const path = resolve(options.dir);
    if (!(await fs.lstat(path)).isDirectory()) recordFail('批次目录不能是链接或文件');
    const root = await fs.realpath(path), names = await fs.readdir(root);
    // 以点开头的是未发布的临时文件或存储探测文件，不参与辨认。
    for (const name of names) {
      if (name === 'batch.json' || name.startsWith('.')) continue;
      if (!ITEM.test(name) || Number(name) < 1 || Number(name) > MAX_BATCH_ITEMS) recordFail(`不是批次目录：含非受控条目 ${name}`);
    }
    const directories = names.filter((name) => ITEM.test(name)).sort();
    if (!names.includes('batch.json')) {
      const items: FoundBatchItem[] = [];
      for (const name of directories) {
        const found = await itemManifest(root, name);
        items.push({ index: Number(name), directory: join(options.dir, name), status: found?.status ?? 'incomplete', ...(found ? { id: found.id } : {}) });
      }
      const complete = items.filter((item) => item.status !== 'incomplete');
      if (new Set(complete.map((item) => item.status)).size > 1) recordFail('批次目录中同时有正式记录与草稿预览');
      if (new Set(complete.map((item) => item.id)).size !== complete.length) recordFail('批次目录中的项标识重复');
      return { batch: { state: 'unfinished', directory: options.dir, items }, problems: [] };
    }
    const manifest = batchManifest(await json(root, 'batch.json'));
    const listed = new Set<string>();
    for (const entry of manifest.items) {
      if (!entry.directory) continue;
      listed.add(entry.directory);
      if (!directories.includes(entry.directory)) recordFail(`批次清单列出的目录不存在：${entry.directory}`);
      const found = await itemManifest(root, entry.directory);
      const expected = entry.status === 'delivered' || entry.status === 'previewed' ? entry.status : undefined;
      if (found?.status !== expected || (found && found.id !== entry.id)) recordFail(`第 ${entry.directory} 项与批次清单不一致`);
    }
    // 写入失败的项在清单中没有目录，磁盘上却可能留下未发布完成清单的残留目录。
    for (const name of directories.filter((name) => !listed.has(name))) {
      const entry = manifest.items[Number(name) - 1];
      if (entry?.status !== 'failed' || await itemManifest(root, name)) recordFail(`批次目录含清单未列出的子目录：${name}`);
    }
    return { batch: { state: 'finished', directory: options.dir, manifest }, problems: [] };
  } catch (error) {
    return { problems: [severe(error instanceof RecordError ? error.code : ProblemCodes.recordInvalid, { kind: 'input', source: 'outputRecord' }, describeError(error))] };
  }
}
