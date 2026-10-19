/**
 * 出图记录的存储（ADR-0018、ADR-0019）：批次成果的去处，以及记录与批次的读取来源。
 *
 * 本地实现沿用批次目录：目标排他创建，内容写完并同步后最后发布完成清单，同批相同资源副本以硬链接共享。
 * 内存实现供测试与服务端的快速测试使用；服务端以对象存储加数据库实现同一组接口。
 */
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { BatchManifest, OutputRecord, PreviewManifest } from './output-records.js';
import { ProblemCodes } from './problems.js';
import { createExclusiveDirectory, jsonBytes, publishManifest, publishRecordDirectory, readRecordFile, recordRoot, storageAvailable,
  writeDurableFiles, type SharedContents } from './record-files.js';
import { MAX_BATCH_ITEMS, recordFail } from './record-input.js';

/** 本项成果的目录名由输入顺序生成，从 0001 开始。 */
export const itemDirectory = (index: number) => String(index).padStart(4, '0');

/** 一项的成果：正式成功项带 record.json，草稿项带 preview.json，失败项只有问题清单与可用的布局摘要。 */
export interface BatchItemContents {
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly manifest?: { readonly name: 'record.json'; readonly value: OutputRecord } | { readonly name: 'preview.json'; readonly value: PreviewManifest };
  /** 可在同批各项之间共享的资源副本：文件名 → 已核对的 SHA-256。 */
  readonly shared?: ReadonlyMap<string, string>;
}

/** 一个批次的成果去处。 */
export interface BatchOutput {
  /** 本项成果的位置；本地是可以直接打开的目录。 */
  location(index: number): string;
  /** 写入本项成果，有完成清单时最后发布它。抛错即本项写入失败。 */
  write(index: number, contents: BatchItemContents): Promise<void>;
  /** 某项写入失败后，判断目标存储是否整体可用。 */
  available(index: number): Promise<boolean>;
  /** 全部项结束后发布批次清单。 */
  finish(manifest: BatchManifest): Promise<void>;
}

/** 一条出图记录的读取来源：record.json 与它列出的文件。 */
export interface RecordSource {
  readonly location: string;
  read(file: string): Promise<Uint8Array>;
}

/** 一个批次的读取来源。 */
export interface BatchSource {
  readonly location: string;
  itemLocation(index: number): string;
  /** 已发布的批次清单原文；还没发布时为 undefined。 */
  manifest(): Promise<Uint8Array | undefined>;
  /** 已有成果的项序号，升序。 */
  items(): Promise<readonly number[]>;
  /** 本项已发布的完成清单；没有时为 undefined。 */
  completion(index: number): Promise<{ readonly name: 'record.json' | 'preview.json'; readonly bytes: Uint8Array } | undefined>;
}

/** 在新目录中交付一个批次；目录已存在即失败（M153）。 */
export async function createLocalBatchOutput(outDir: string): Promise<BatchOutput> {
  const root = await createExclusiveDirectory(outDir);
  // 本批已写好的资源副本，后续项用硬链接共享同一内容。
  const shared: SharedContents = new Map();
  return {
    location: (index) => join(outDir, itemDirectory(index)),
    async write(index, { files, manifest, shared: digests }) {
      const path = join(root, itemDirectory(index));
      if (!manifest) await writeDurableFiles(await createExclusiveDirectory(path, false), files);
      else await publishRecordDirectory(path, files, manifest.name, manifest.value, false, digests ? { contents: shared, digests } : undefined);
    },
    available: (index) => storageAvailable(root, `.probe-${itemDirectory(index)}.tmp`),
    finish: (manifest) => publishManifest(root, 'batch.json', manifest),
  };
}

/** 本地记录目录。 */
export function localRecordSource(dir: string): RecordSource {
  let root: Promise<string> | undefined;
  return { location: dir, read: async (file) => readRecordFile(await (root ??= recordRoot(dir)), file) };
}

const ITEM = /^\d{4}$/;
async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** 本地批次目录：只认受控的序号子目录与 batch.json，以点开头的是未发布的临时文件或存储探测文件。 */
export function localBatchSource(dir: string): BatchSource {
  let opened: Promise<{ root: string; names: string[] }> | undefined;
  const open = () => opened ??= (async () => {
    const path = resolve(dir);
    if (!(await fs.lstat(path)).isDirectory()) recordFail('批次目录不能是链接或文件');
    const root = await fs.realpath(path), names = await fs.readdir(root);
    for (const name of names) {
      if (name === 'batch.json' || name.startsWith('.')) continue;
      if (!ITEM.test(name) || Number(name) < 1 || Number(name) > MAX_BATCH_ITEMS) recordFail(`不是批次目录：含非受控条目 ${name}`);
    }
    return { root, names };
  })();
  return {
    location: dir,
    itemLocation: (index) => join(dir, itemDirectory(index)),
    async manifest() {
      const { root, names } = await open();
      return names.includes('batch.json') ? readRecordFile(root, 'batch.json') : undefined;
    },
    items: async () => (await open()).names.filter((name) => ITEM.test(name)).sort().map(Number),
    async completion(index) {
      const name = itemDirectory(index), path = join((await open()).root, name);
      if (!(await fs.lstat(path)).isDirectory()) recordFail(`批次子目录必须是普通目录：${name}`);
      const record = await exists(join(path, 'record.json')), preview = await exists(join(path, 'preview.json'));
      if (record && preview) recordFail(`第 ${name} 项同时有出图记录与预览清单`);
      if (!record && !preview) return undefined;
      const file = record ? 'record.json' : 'preview.json';
      return { name: file, bytes: await readRecordFile(path, file) };
    },
  };
}

/** 内存中的一个批次：同一份内容既是成果去处，也是批次与记录的读取来源。 */
export interface MemoryBatch {
  readonly output: BatchOutput;
  readonly batch: BatchSource;
  record(index: number): RecordSource;
}

export function createMemoryBatch(location = 'memory'): MemoryBatch {
  const items = new Map<number, { files: Map<string, Uint8Array>; completion?: { name: 'record.json' | 'preview.json'; bytes: Uint8Array } }>();
  let manifest: Uint8Array | undefined;
  const itemLocation = (index: number) => `${location}/${itemDirectory(index)}`;
  const output: BatchOutput = {
    location: itemLocation,
    async write(index, contents) {
      if (items.has(index)) recordFail(`第 ${itemDirectory(index)} 项已有成果，不能覆盖`, ProblemCodes.deliveryWriteFailed);
      const files = new Map<string, Uint8Array>([...contents.files].map(([file, bytes]) => [file, new Uint8Array(bytes)]));
      if (!contents.manifest) { items.set(index, { files }); return; }
      const completion = { name: contents.manifest.name, bytes: jsonBytes(contents.manifest.value) };
      files.set(completion.name, completion.bytes);
      items.set(index, { files, completion });
    },
    available: async () => true,
    async finish(value) {
      if (manifest) recordFail('批次清单已发布，不能覆盖', ProblemCodes.deliveryWriteFailed);
      manifest = jsonBytes(value);
    },
  };
  const batch: BatchSource = {
    location,
    itemLocation,
    manifest: async () => manifest,
    items: async () => [...items.keys()].sort((a, b) => a - b),
    completion: async (index) => items.get(index)?.completion,
  };
  const record = (index: number): RecordSource => ({
    location: itemLocation(index),
    async read(file) {
      const bytes = items.get(index)?.files.get(file);
      if (!bytes) recordFail(`记录文件不存在：${file}`);
      return new Uint8Array(bytes);
    },
  });
  return { output, batch, record };
}
