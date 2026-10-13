/** 批量正式交付、完整性读取与自足重放；渲染逻辑统一调用 render。 */
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { render, type RenderResult, type RenderOptions } from './render.js';
import { createMemoryResourceRepository, parseResourceRef, type ResourceKind } from './resources.js';
import type { VersionedResourceInfo, VersionedResourceStore } from './versioned-resources.js';
import { isRecord, describeError } from './util.js';
import { rendererBuildId } from './renderer-build.js';
import { checkBatchTemplate, parseBatchEnvelope, parseBatchItem, prepareRecordInput, RecordError, recordFail, recordOptions, singleRequest,
  type BatchEnvelope, type RecordDocuments, type RecordInput } from './record-input.js';
import { createExclusiveDirectory, digest, fileInfo, jsonBytes, publishManifest, publishRecordDirectory, readRecordFile, recordRoot,
  storageAvailable, validFile, writeDurableFiles, type RecordFile } from './record-files.js';

export type { BatchRenderRequest } from './record-input.js';
export { MAX_BATCH_ITEMS } from './record-input.js';
export type RecordedResource = { readonly id: string; readonly state: 'missing' } |
  (VersionedResourceInfo & { readonly state: 'available'; readonly file: string });
export interface OutputRecord {
  readonly format: 'renderweave-output-record/1';
  readonly build: string;
  readonly itemId: string;
  readonly resources: readonly RecordedResource[];
  readonly files: readonly RecordFile[];
}

export type BatchItemStatus = 'delivered' | 'failed' | 'notRun';
/** 本项目录中的受控文件名；成功项四个都有，失败项只有问题清单和可用的布局摘要。 */
export interface BatchItemFiles {
  readonly image?: 'image.png' | 'image.jpg';
  readonly problems: 'problems.json';
  readonly layout?: 'layout.json';
  readonly record?: 'record.json';
}
/** batch.json 中的一项。目录名由输入序号生成，相对批次目录；项标识只作数据。 */
export interface BatchItemEntry {
  /** 输入顺序，从 1 开始。 */
  readonly index: number;
  readonly id: string;
  readonly status: BatchItemStatus;
  readonly directory?: string;
  readonly files?: BatchItemFiles;
  readonly severe: number;
  readonly hints: number;
  /** 没有本项目录时（写入失败或未执行）说明原因。 */
  readonly reason?: string;
}
/** 逐项结果：目录为可直接打开的路径，另带完整问题清单。 */
export interface BatchItemResult extends Omit<BatchItemEntry, 'directory'> {
  readonly directory?: string;
  readonly problems: readonly Problem[];
}
export interface BatchSummary { readonly total: number; readonly delivered: number; readonly failed: number; readonly notRun: number }
/** 批次目录的 batch.json：全部项结束后最后发布。 */
export interface BatchManifest {
  readonly format: 'renderweave-batch/1';
  readonly build: string;
  readonly template: string;
  readonly mode: 'final';
  readonly summary: BatchSummary;
  readonly items: readonly BatchItemEntry[];
  readonly problems: readonly Problem[];
}
export interface BatchProgress { readonly completed: number; readonly total: number }
export interface BatchDeliveryResult {
  /** 批次目录；整批拒绝时没有，也不会创建。 */
  readonly directory?: string;
  readonly summary: BatchSummary;
  /** 按输入顺序；只含状态、问题与文件引用，不含图片字节。 */
  readonly items: readonly BatchItemResult[];
  /** 批次级问题：整批拒绝、停止调度或 batch.json 写入失败。 */
  readonly problems: readonly Problem[];
}

function failure(error: unknown): Problem[] {
  return [severe(error instanceof RecordError ? error.code : ProblemCodes.recordInvalid, { kind: 'input', source: 'outputRecord' }, describeError(error))];
}
function resultFiles(result: RenderResult): Map<string, Uint8Array> {
  if (!result.image || !result.layout) recordFail('正式渲染未生成完整成果');
  return new Map([
    [result.image.format === 'png' ? 'image.png' : 'image.jpg', result.image.bytes],
    ['problems.json', jsonBytes(result.problems)], ['layout.json', jsonBytes(result.layout)],
  ]);
}

interface PlannedItem {
  readonly index: number;
  readonly raw: BatchEnvelope['items'][number];
  /** 准备阶段的项级问题；有问题的项不渲染。 */
  readonly problems: readonly Problem[];
}
interface Frozen {
  readonly envelope: BatchEnvelope;
  readonly documents: RecordDocuments;
  readonly configured: Required<RenderOptions>;
  readonly pinned: ReadonlyMap<string, VersionedResourceInfo>;
  readonly contents: ReadonlyMap<string, Uint8Array>;
  readonly build: string;
  readonly root: string;
  readonly outDir: string;
}
const singleBatch = (envelope: BatchEnvelope, raw: BatchEnvelope['items'][number]) => ({ template: envelope.template, mode: envelope.mode, items: [raw] });
const severeCount = (problems: readonly Problem[]) => problems.filter((p) => p.level === 'severe').length;

/**
 * 批量正式交付：一个根模板、final 模式、1–1,000 个带唯一 id 的渲染项，串行逐项交付到新批次目录。
 * 首次异步操作前固定文档、全部渲染项、配置及资源版本映射；外层非法、根模板无法准备、固定资源不符或目标已存在则整批拒绝。
 * 项级错误只使本项失败；单项写入失败后探测存储，整体不可写则停止，后续项标为未执行。
 * 每项结束即调用 onItem，返回值只含状态与文件引用，不累积图片字节。
 */
export async function deliverBatch(options: {
  readonly workspace: RecordDocuments;
  readonly resources: VersionedResourceStore;
  readonly request: unknown;
  readonly outDir: string;
  readonly renderOptions?: RenderOptions;
  readonly onItem?: (item: BatchItemResult, progress: BatchProgress) => void | Promise<void>;
}): Promise<BatchDeliveryResult> {
  let frozen: Frozen, plan: PlannedItem[];
  try {
    const envelope = parseBatchEnvelope(options.request);
    const configured = recordOptions(options.renderOptions);
    const { templates, datasets, staticSchemas, problems } = options.workspace;
    const documents: RecordDocuments = structuredClone({ templates, datasets, staticSchemas, problems });
    const templateKinds = checkBatchTemplate(documents, envelope.template, configured);
    const kinds = new Map<string, ResourceKind>(templateKinds);
    plan = envelope.items.map((raw, i) => {
      const { item, problems: parsed } = parseBatchItem(envelope, raw);
      if (!item) return { index: i + 1, raw, problems: parsed };
      try {
        for (const [id, kind] of prepareRecordInput(documents, singleBatch(envelope, raw), configured).resourceKinds) if (!kinds.has(id)) kinds.set(id, kind);
        return { index: i + 1, raw, problems: [] };
      } catch (error) {
        if (!(error instanceof RecordError)) throw error;
        return { index: i + 1, raw, problems: failure(error) };
      }
    });
    // 资源版本映射在任何异步读取前同步固定；运行中仓库再有替换也不混入本批。
    const pinned = new Map<string, VersionedResourceInfo>();
    for (const id of [...kinds.keys()].sort()) {
      const info = structuredClone(options.resources.get(id));
      if (!info) continue;
      if (info.id !== id || !Number.isSafeInteger(info.version) || info.version < 1) recordFail(`资源 ${id} 的固定版本元信息不合法`);
      if (templateKinds.has(id) && info.kind !== templateKinds.get(id)) recordFail(`资源 ${id} 的种类应为 ${templateKinds.get(id)}`);
      pinned.set(id, info);
    }
    const contents = new Map<string, Uint8Array>();
    for (const [id, info] of pinned) {
      const bytes = new Uint8Array(await options.resources.read(id, info.version));
      if (digest(bytes) !== info.sha256 || bytes.length !== info.byteLength) recordFail(`资源 ${id} 与固定版本不一致`, ProblemCodes.recordIntegrityMismatch);
      contents.set(id, bytes);
    }
    const build = await rendererBuildId();
    const root = await createExclusiveDirectory(options.outDir);
    frozen = { envelope, documents, configured, pinned, contents, build, root, outDir: options.outDir };
  } catch (error) {
    return { summary: { total: 0, delivered: 0, failed: 0, notRun: 0 }, items: [], problems: failure(error) };
  }

  const items: BatchItemResult[] = [], problems: Problem[] = [];
  let stop: Problem | undefined;
  for (const planned of plan) {
    let item: BatchItemResult;
    if (stop) {
      const reason = `批次已停止，未执行：${stop.message}`;
      item = { index: planned.index, id: planned.raw.id, status: 'notRun', severe: 1, hints: 0, reason,
        problems: [severe(ProblemCodes.deliveryNotRun, { kind: 'input', source: 'outputRecord' }, reason)] };
    } else {
      const executed = await deliverItem(frozen, planned);
      item = executed.item;
      if (executed.writeFailed && !(await storageAvailable(frozen.root, `.probe-${itemDirectory(planned.index)}.tmp`))) {
        stop = severe(ProblemCodes.deliveryStorageUnavailable, { kind: 'input', source: 'outputRecord' }, `第 ${planned.index} 项写入失败后批次目录已不可写，停止调度`);
        problems.push(stop);
      }
    }
    items.push(item);
    try { await options.onItem?.(item, { completed: items.length, total: plan.length }); } catch (error) {
      if (!stop) {
        stop = severe(ProblemCodes.deliveryStopped, { kind: 'input', source: 'outputRecord' }, `进度回调失败，停止调度：${describeError(error)}`);
        problems.push(stop);
      }
    }
  }
  const count = (status: BatchItemStatus) => items.filter((item) => item.status === status).length;
  const summary: BatchSummary = { total: items.length, delivered: count('delivered'), failed: count('failed'), notRun: count('notRun') };
  const entries: BatchItemEntry[] = items.map(({ problems: _problems, directory, index, id, status, ...rest }) =>
    ({ index, id, status, ...(directory ? { directory: itemDirectory(index) } : {}), ...rest }));
  try {
    const manifest: BatchManifest = { format: 'renderweave-batch/1', build: frozen.build, template: frozen.envelope.template, mode: frozen.envelope.mode, summary, items: entries, problems };
    await publishManifest(frozen.root, 'batch.json', manifest);
  } catch (error) { problems.push(...failure(error)); }
  return { directory: frozen.outDir, summary, items, problems };
}

const itemDirectory = (index: number) => String(index).padStart(4, '0');

/** 交付一项。成功需图片、问题清单、布局摘要和记录全部写好；渲染失败也写出问题清单与可用的布局摘要。 */
async function deliverItem(frozen: Frozen, planned: PlannedItem): Promise<{ item: BatchItemResult; writeFailed: boolean }> {
  const name = itemDirectory(planned.index), path = join(frozen.root, name), directory = join(frozen.outDir, name);
  const base = { index: planned.index, id: planned.raw.id };
  const failed = async (problems: readonly Problem[], layout?: unknown): Promise<{ item: BatchItemResult; writeFailed: boolean }> => {
    const counts = { severe: severeCount(problems), hints: problems.length - severeCount(problems) };
    try {
      const files = new Map([['problems.json', jsonBytes(problems)]]);
      if (layout) files.set('layout.json', jsonBytes(layout));
      await writeDurableFiles(await createExclusiveDirectory(path, false), files);
      return { item: { ...base, status: 'failed', directory, files: { problems: 'problems.json', ...(layout ? { layout: 'layout.json' as const } : {}) }, ...counts, problems }, writeFailed: false };
    } catch (error) {
      const all = [...problems, ...failure(error)];
      return { item: { ...base, status: 'failed', severe: severeCount(all), hints: counts.hints, reason: describeError(error), problems: all }, writeFailed: true };
    }
  };
  if (planned.problems.length) return failed(planned.problems);
  let rendered: RenderResult;
  const files = new Map<string, Uint8Array>();
  const resources: RecordedResource[] = [];
  try {
    const prepared = prepareRecordInput(frozen.documents, singleBatch(frozen.envelope, planned.raw), frozen.configured);
    const inputBytes = jsonBytes(prepared.input);
    const input: RecordInput = JSON.parse(Buffer.from(inputBytes).toString('utf8'));
    const memory: { id: string; kind: ResourceKind; bytes: Uint8Array }[] = [];
    for (const [id, kind] of prepared.resourceKinds) {
      const info = frozen.pinned.get(id);
      if (!info) { resources.push({ id, state: 'missing' }); continue; }
      if (info.kind !== kind) recordFail(`资源 ${id} 的种类应为 ${kind}`);
      const file = `${kind}-${String(memory.length + 1).padStart(6, '0')}.bin`, bytes = frozen.contents.get(id)!;
      resources.push({ ...info, state: 'available', file });
      files.set(file, bytes); memory.push({ id, kind, bytes });
    }
    files.set('input.json', inputBytes);
    rendered = await render({ ...input.documents, resources: createMemoryResourceRepository(memory) }, singleRequest(input.batch), input.options);
  } catch (error) { return failed(failure(error)); }
  if (!rendered.image || !rendered.layout) return failed(rendered.problems, rendered.layout);
  for (const [file, bytes] of resultFiles(rendered)) files.set(file, bytes);
  const image = rendered.image.format === 'png' ? 'image.png' : 'image.jpg';
  const record: OutputRecord = { format: 'renderweave-output-record/1', build: frozen.build, itemId: planned.raw.id, resources, files: [...files].map(([file, bytes]) => fileInfo(file, bytes)) };
  try { await publishRecordDirectory(path, files, 'record.json', record, false); } catch (error) {
    const problems = [...rendered.problems, ...failure(error)];
    return { item: { ...base, status: 'failed', severe: severeCount(problems), hints: problems.length - severeCount(problems), reason: describeError(error), problems }, writeFailed: true };
  }
  const { problems } = rendered;
  return { item: { ...base, status: 'delivered', directory, files: { image, problems: 'problems.json', layout: 'layout.json', record: 'record.json' },
    severe: severeCount(problems), hints: problems.length - severeCount(problems), problems }, writeFailed: false };
}

async function loadRecord(dir: string): Promise<{ record: OutputRecord; input: RecordInput; files: Map<string, Uint8Array> }> {
  const root = await recordRoot(dir);
  const raw: unknown = JSON.parse(Buffer.from(await readRecordFile(root, 'record.json')).toString('utf8'));
  if (!isRecord(raw) || raw.format !== 'renderweave-output-record/1') recordFail('不支持的出图记录格式版本');
  if (typeof raw.build !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.build) || typeof raw.itemId !== 'string' || !raw.itemId || !Array.isArray(raw.files) || !Array.isArray(raw.resources)) recordFail('出图记录清单不完整');
  const files = new Map<string, Uint8Array>();
  for (const entry of raw.files) {
    if (!validFile(entry) || files.has(entry.file)) recordFail('记录文件条目不合法或重复');
    const bytes = await readRecordFile(root, entry.file);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.byteLength) recordFail(`记录文件已损坏：${entry.file}`, ProblemCodes.recordIntegrityMismatch);
    files.set(entry.file, bytes);
  }
  for (const file of ['input.json', 'problems.json', 'layout.json']) if (!files.has(file)) recordFail(`缺少记录文件：${file}`);
  const saved: unknown = JSON.parse(Buffer.from(files.get('input.json')!).toString('utf8'));
  if (!isRecord(saved) || !isRecord(saved.documents) || !isRecord(saved.options) || !Array.isArray(saved.options.fallbackFonts) || !Array.isArray(saved.options.svgFonts)) recordFail('记录输入不完整');
  const { input, resourceKinds } = prepareRecordInput(saved.documents as unknown as RecordDocuments, saved.batch, saved.options);
  if (digest(jsonBytes(input.documents)) !== digest(jsonBytes(saved.documents))) recordFail('记录文档依赖不完整或含有非规范内容');
  if (raw.itemId !== input.batch.items[0]!.id) recordFail('记录项标识与请求不一致');
  const expected = new Set(['input.json', 'problems.json', 'layout.json', singleRequest(input.batch).output.format === 'png' ? 'image.png' : 'image.jpg']);
  const seen = new Set<string>();
  for (const entry of raw.resources) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !parseResourceRef(`res:${entry.id}`) || seen.has(entry.id)) recordFail('记录资源条目不合法或重复');
    seen.add(entry.id);
    if (entry.state === 'missing') {
      if (Object.keys(entry).some((key) => key !== 'id' && key !== 'state')) recordFail('缺失资源不能带内容引用');
    } else if (entry.state === 'available' && entry.kind === resourceKinds.get(entry.id) && (entry.kind === 'font' || entry.kind === 'image') && Number.isSafeInteger(entry.version) && Number(entry.version) > 0 && validFile(entry) && new RegExp(`^${entry.kind}-\\d{6}\\.bin$`).test(entry.file)) {
      const bytes = files.get(entry.file);
      if (!bytes || expected.has(entry.file) || digest(bytes) !== entry.sha256 || bytes.length !== entry.byteLength) recordFail('资源版本与记录内容不一致');
      expected.add(entry.file);
    } else recordFail('记录资源元信息不完整');
  }
  if (resourceKinds.size !== seen.size || [...resourceKinds.keys()].some((id) => !seen.has(id))) recordFail('记录缺少资源的可用或缺失状态');
  if (expected.size !== files.size || [...expected].some((file) => !files.has(file))) recordFail('记录成果或资源文件集合不完整');
  return { record: raw as unknown as OutputRecord, input, files };
}

/** 读取会核对全部内容的完整性，但不要求当前构建可重放。 */
export async function readOutputRecord(options: { readonly dir: string }): Promise<{ record?: OutputRecord; problems: readonly Problem[] }> {
  try { return { record: (await loadRecord(options.dir)).record, problems: [] }; }
  catch (error) { return { problems: failure(error) }; }
}

/** 仅从记录构建内存工作区，实际重新渲染并比对图片、问题清单和布局摘要。 */
export async function replayOutputRecord(options: { readonly dir: string; readonly outDir: string }): Promise<{ replayed?: { readonly directory: string; readonly image: string }; problems: readonly Problem[] }> {
  try {
    const { dir, outDir } = options;
    const { record, input, files } = await loadRecord(dir);
    if (record.build !== await rendererBuildId()) recordFail('渲染器构建不匹配；请使用创建记录的确切引擎与依赖', ProblemCodes.recordBuildMismatch);
    const memory = record.resources.flatMap((entry) => entry.state === 'available' ? [{ id: entry.id, kind: entry.kind, bytes: files.get(entry.file)! }] : []);
    const result = await render({ ...input.documents, resources: createMemoryResourceRepository(memory) }, singleRequest(input.batch), input.options);
    if (!result.image || !result.layout) recordFail('记录输入重新渲染失败', ProblemCodes.recordReplayMismatch);
    const regenerated = resultFiles(result);
    for (const [file, bytes] of regenerated) if (digest(bytes) !== digest(files.get(file)!)) recordFail(`重放结果不一致：${file}`, ProblemCodes.recordReplayMismatch);
    await publishRecordDirectory(outDir, regenerated, 'replay.json', { format: 'renderweave-replay/1', build: record.build, itemId: record.itemId, matched: true, files: [...regenerated].map(([file, bytes]) => fileInfo(file, bytes)) });
    return { problems: result.problems, replayed: { directory: outDir, image: result.image.format === 'png' ? 'image.png' : 'image.jpg' } };
  } catch (error) { return { problems: failure(error) }; }
}
