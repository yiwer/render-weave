/** 批量正式交付、完整性读取与自足重放；渲染逻辑统一调用 render。 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { prepareRender, render, templateBlocked, type RenderResult, type RenderOptions } from './render.js';
import type { RenderMode } from './request.js';
import { createMemoryResourceRepository, parseResourceRef, type ResourceKind, type ResourceRepository } from './resources.js';
import type { VersionedResourceInfo, VersionedResourceStore } from './versioned-resources.js';
import type { Workspace } from './workspace.js';
import { isRecord, describeError } from './util.js';
import { rendererBuildId } from './renderer-build.js';
import { checkBatchTemplate, parseBatchEnvelope, parseBatchItem, prepareRecordInput, RecordError, recordFail, recordOptions, singleRequest,
  type BatchEnvelope, type RecordDocuments, type RecordInput } from './record-input.js';
import { digest, fileInfo, jsonBytes, publishRecordDirectory, validFile, type RecordFile } from './record-files.js';
import { createLocalBatchOutput, itemDirectory, localRecordSource, type BatchOutput, type RecordSource } from './record-stores.js';

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

/** delivered：正式交付成功；previewed：草稿预览已生成，可能仍有严重问题，不是可交付成品。 */
export type BatchItemStatus = 'delivered' | 'previewed' | 'failed' | 'notRun';
/** 本项目录中的受控文件名：正式成功项有图片、问题清单、布局摘要和记录；草稿项以 draft 命名图片并以 preview.json 收尾；失败项只有问题清单和可用的布局摘要。 */
export interface BatchItemFiles {
  readonly image?: 'image.png' | 'image.jpg' | 'draft.png' | 'draft.jpg';
  readonly problems: 'problems.json';
  readonly layout?: 'layout.json';
  readonly record?: 'record.json';
  readonly preview?: 'preview.json';
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
/** 各状态的项数，以及全部项的严重问题与提示总数；草稿批次的严重问题数说明它不能直接交付。 */
export interface BatchSummary {
  readonly total: number;
  readonly delivered: number;
  readonly previewed: number;
  readonly failed: number;
  readonly notRun: number;
  readonly severe: number;
  readonly hints: number;
}
/** 草稿项目录的 preview.json：预览成果写完后最后发布；不是出图记录，不能重放。 */
export interface PreviewManifest {
  readonly format: 'renderweave-preview/1';
  readonly mode: 'draft';
  readonly build: string;
  readonly itemId: string;
  readonly files: readonly RecordFile[];
}
/** 批次目录的 batch.json：全部项结束后最后发布。 */
export interface BatchManifest {
  readonly format: 'renderweave-batch/1';
  readonly build: string;
  readonly template: string;
  readonly mode: RenderMode;
  readonly summary: BatchSummary;
  readonly items: readonly BatchItemEntry[];
  readonly problems: readonly Problem[];
}
export interface BatchProgress { readonly completed: number; readonly total: number }
export interface BatchDeliveryResult {
  /** 批次目录；整批拒绝时没有，也不会创建。 */
  readonly directory?: string;
  /** 批次模式；整批拒绝时没有。 */
  readonly mode?: RenderMode;
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

/**
 * 批次快照（M153）：固定后的外层请求、文档、渲染配置、资源版本映射与构建标识，以及各项准备阶段的问题。
 * 可序列化为 JSON：服务端把它存起来，各项可以由不同的 worker 按同一份快照交付（ADR-0017）。
 */
export interface BatchSnapshot {
  readonly format: 'renderweave-batch-snapshot/1';
  readonly build: string;
  readonly envelope: BatchEnvelope;
  readonly documents: RecordDocuments;
  readonly options: Required<RenderOptions>;
  /** 固定的资源内容版本，按资源 ID 排序。 */
  readonly resources: readonly VersionedResourceInfo[];
  /** 按输入顺序；有准备阶段问题的项不渲染。 */
  readonly items: readonly { readonly index: number; readonly id: string; readonly problems: readonly Problem[] }[];
}
/** 按固定版本取资源内容；调用方负责内容与版本一致（版本仓库的读取会核对完整性）。 */
export type PinnedContents = (resource: VersionedResourceInfo) => Promise<Uint8Array>;

const singleBatch = (envelope: BatchEnvelope, raw: BatchEnvelope['items'][number]) => ({ template: envelope.template, mode: envelope.mode, items: [raw] });
const NO_ITEMS: BatchSummary = { total: 0, delivered: 0, previewed: 0, failed: 0, notRun: 0, severe: 0, hints: 0 };
const batchProblem = (code: Problem['code'], message: string) => severe(code, { kind: 'input', source: 'outputRecord' }, message);
const cancelledBeforeStart = (): BatchDeliveryResult => ({ summary: NO_ITEMS, items: [], problems: [batchProblem(ProblemCodes.deliveryCancelled, '批次在开始执行前已取消，未建目录')] });
const severeCount = (problems: readonly Problem[]) => problems.filter((p) => p.level === 'severe').length;

/**
 * 固定一个批次：校验外层，复制文档、全部渲染项与配置，固定资源版本映射并核对固定版本的字节。
 * 外层非法、根模板无法准备或固定资源不符时整批拒绝；项级错误记在快照的对应项上。
 * 同时返回已核对的资源内容，供同一进程内逐项交付复用。
 */
export async function freezeBatch(options: {
  readonly workspace: RecordDocuments;
  readonly resources: VersionedResourceStore;
  readonly request: unknown;
  readonly renderOptions?: RenderOptions;
}): Promise<{ snapshot?: BatchSnapshot; contents?: ReadonlyMap<string, Uint8Array>; problems: readonly Problem[] }> {
  try {
    const envelope = parseBatchEnvelope(options.request);
    const configured = recordOptions(options.renderOptions);
    const { templates, datasets, staticSchemas, problems } = options.workspace;
    const documents: RecordDocuments = structuredClone({ templates, datasets, staticSchemas, problems });
    // 单次渲染也会报的问题，由渲染入口的同步前段给出，与单次渲染相同；能展开却成不了记录的，才报记录的问题（M258）。
    let current: ResourceRepository | undefined;
    const workspace = (): Workspace => ({ ...documents, resources: current ??= options.resources.pin().repository ?? createMemoryResourceRepository([]) });
    let templateKinds: Map<string, ResourceKind>;
    try { templateKinds = checkBatchTemplate(documents, envelope.template, configured); } catch (error) {
      if (!(error instanceof RecordError)) throw error;
      if (documents.problems.some((p) => p.level === 'severe')) return { problems: [...documents.problems] };
      return { problems: templateBlocked(workspace(), envelope.template) ?? failure(error) };
    }
    const kinds = new Map<string, ResourceKind>(templateKinds);
    const unexpandable = (raw: BatchEnvelope['items'][number]) => {
      const { prepared, problems } = prepareRender(workspace(),
        { template: envelope.template, mode: envelope.mode, dataset: raw.dataset, parameters: raw.parameters, output: raw.output });
      return prepared ? undefined : problems;
    };
    const items = envelope.items.map((raw, i) => {
      const { item, problems: parsed } = parseBatchItem(envelope, raw);
      if (!item) return { index: i + 1, id: raw.id, problems: unexpandable(raw) ?? parsed };
      try {
        for (const [id, kind] of prepareRecordInput(documents, singleBatch(envelope, raw), configured).resourceKinds) if (!kinds.has(id)) kinds.set(id, kind);
        return { index: i + 1, id: raw.id, problems: [] };
      } catch (error) {
        if (!(error instanceof RecordError)) throw error;
        return { index: i + 1, id: raw.id, problems: unexpandable(raw) ?? failure(error) };
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
    const snapshot: BatchSnapshot = { format: 'renderweave-batch-snapshot/1', build, envelope, documents, options: configured, resources: [...pinned.values()], items };
    return { snapshot, contents, problems: [] };
  } catch (error) {
    return { problems: failure(error) };
  }
}

/**
 * 按批次快照交付一项，成果经 output 写入。成功需图片、问题清单、布局摘要和记录全部写好；
 * 渲染失败也写出问题清单与可用的布局摘要。writeFailed 表示成果没能写入，调用方据此探测存储是否整体可用。
 */
export async function deliverBatchItem(options: {
  readonly snapshot: BatchSnapshot;
  /** 输入顺序，从 1 开始。 */
  readonly index: number;
  readonly contents: PinnedContents;
  readonly output: BatchOutput;
}): Promise<{ item: BatchItemResult; writeFailed: boolean }> {
  const { snapshot, index, output } = options;
  const planned = snapshot.items[index - 1], raw = snapshot.envelope.items[index - 1];
  if (snapshot.format !== 'renderweave-batch-snapshot/1' || !planned || !raw || planned.index !== index) {
    const invalid = batchProblem(ProblemCodes.recordInvalid, '批次快照不合法或没有这一项');
    return { item: { index, id: raw?.id ?? '', status: 'failed', severe: 1, hints: 0, reason: invalid.message, problems: [invalid] }, writeFailed: false };
  }
  const base = { index, id: raw.id };
  const written = (status: BatchItemStatus, files: BatchItemFiles, problems: readonly Problem[]): BatchItemResult =>
    ({ ...base, status, directory: output.location(index), files, severe: severeCount(problems), hints: problems.length - severeCount(problems), problems });
  const writeFailure = (problems: readonly Problem[], error: unknown): { item: BatchItemResult; writeFailed: boolean } => {
    const all = [...problems, ...failure(error)];
    return { item: { ...base, status: 'failed', severe: severeCount(all), hints: problems.length - severeCount(problems), reason: describeError(error), problems: all }, writeFailed: true };
  };
  const failed = async (problems: readonly Problem[], layout?: unknown): Promise<{ item: BatchItemResult; writeFailed: boolean }> => {
    try {
      const files = new Map([['problems.json', jsonBytes(problems)]]);
      if (layout) files.set('layout.json', jsonBytes(layout));
      await output.write(index, { files });
      return { item: written('failed', { problems: 'problems.json', ...(layout ? { layout: 'layout.json' as const } : {}) }, problems), writeFailed: false };
    } catch (error) { return writeFailure(problems, error); }
  };
  if (planned.problems.length) return failed(planned.problems);
  let rendered: RenderResult;
  const files = new Map<string, Uint8Array>();
  // 资源副本的 SHA-256 取自固定版本：字节已在固定时核对，不再逐项重复散列。
  const digests = new Map<string, string>();
  const resources: RecordedResource[] = [];
  try {
    const prepared = prepareRecordInput(snapshot.documents, singleBatch(snapshot.envelope, raw), snapshot.options);
    const inputBytes = jsonBytes(prepared.input);
    const input: RecordInput = JSON.parse(Buffer.from(inputBytes).toString('utf8'));
    const pinned = new Map(snapshot.resources.map((info) => [info.id, info]));
    const memory: { id: string; kind: ResourceKind; bytes: Uint8Array }[] = [];
    for (const [id, kind] of prepared.resourceKinds) {
      const info = pinned.get(id);
      if (!info) { resources.push({ id, state: 'missing' }); continue; }
      if (info.kind !== kind) recordFail(`资源 ${id} 的种类应为 ${kind}`);
      const file = `${kind}-${String(memory.length + 1).padStart(6, '0')}.bin`, bytes = await options.contents(info);
      resources.push({ ...info, state: 'available', file });
      files.set(file, bytes); digests.set(file, info.sha256); memory.push({ id, kind, bytes });
    }
    files.set('input.json', inputBytes);
    rendered = await render({ ...input.documents, resources: createMemoryResourceRepository(memory) }, singleRequest(input.batch), input.options);
  } catch (error) { return failed(failure(error)); }
  // 无法展开（两种模式）或正式有严重问题时没有图片：本项失败，保留问题清单与可用的布局摘要。
  if (!rendered.image || !rendered.layout) return failed(rendered.problems, rendered.layout);
  const { problems } = rendered;
  const draft = snapshot.envelope.mode === 'draft';
  const image = draft ? (rendered.image.format === 'png' ? 'draft.png' : 'draft.jpg') : (rendered.image.format === 'png' ? 'image.png' : 'image.jpg');
  try {
    if (draft) {
      // 草稿只保存预览成果，不复制输入与资源，也不生成出图记录。
      const preview = new Map([[image, rendered.image.bytes], ['problems.json', jsonBytes(problems)], ['layout.json', jsonBytes(rendered.layout)]]);
      const manifest: PreviewManifest = { format: 'renderweave-preview/1', mode: 'draft', build: snapshot.build, itemId: raw.id, files: [...preview].map(([file, bytes]) => fileInfo(file, bytes)) };
      await output.write(index, { files: preview, manifest: { name: 'preview.json', value: manifest } });
    } else {
      for (const [file, bytes] of resultFiles(rendered)) files.set(file, bytes);
      const record: OutputRecord = { format: 'renderweave-output-record/1', build: snapshot.build, itemId: raw.id, resources,
        files: [...files].map(([file, bytes]) => digests.has(file) ? { file, sha256: digests.get(file)!, byteLength: bytes.length } : fileInfo(file, bytes)) };
      await output.write(index, { files, manifest: { name: 'record.json', value: record }, shared: digests });
    }
  } catch (error) { return writeFailure(problems, error); }
  const itemFiles: BatchItemFiles = draft ? { image, problems: 'problems.json', layout: 'layout.json', preview: 'preview.json' } : { image, problems: 'problems.json', layout: 'layout.json', record: 'record.json' };
  return { item: written(draft ? 'previewed' : 'delivered', itemFiles, problems), writeFailed: false };
}

/** 由逐项结果与批次级问题汇总批次清单。 */
export function summarizeBatch(snapshot: BatchSnapshot, items: readonly BatchItemResult[], problems: readonly Problem[]): BatchManifest {
  const count = (status: BatchItemStatus) => items.filter((item) => item.status === status).length;
  const summary: BatchSummary = { total: items.length, delivered: count('delivered'), previewed: count('previewed'), failed: count('failed'), notRun: count('notRun'),
    severe: items.reduce((sum, item) => sum + item.severe, 0), hints: items.reduce((sum, item) => sum + item.hints, 0) };
  const entries: BatchItemEntry[] = items.map(({ problems: _problems, directory, index, id, status, ...rest }) =>
    ({ index, id, status, ...(directory ? { directory: itemDirectory(index) } : {}), ...rest }));
  return { format: 'renderweave-batch/1', build: snapshot.build, template: snapshot.envelope.template, mode: snapshot.envelope.mode, summary, items: entries, problems: [...problems] };
}

/**
 * 在一个进程内按顺序交付已固定的批次，最后发布批次清单。
 * 单项写入失败后探测存储，整体不可写则停止，后续项标为未执行。每项结束即调用 onItem，返回值只含状态与文件引用，不累积图片字节。
 * signal 取消在项与项之间生效：正在执行的一项完成并提交后停止，其余项标为未执行，批次清单照常发布。
 */
export async function runFrozenBatch(options: {
  readonly snapshot: BatchSnapshot;
  readonly contents: PinnedContents;
  readonly output: BatchOutput;
  readonly onItem?: (item: BatchItemResult, progress: BatchProgress) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<BatchDeliveryResult> {
  const { snapshot, output } = options;
  const items: BatchItemResult[] = [], problems: Problem[] = [];
  let stop: Problem | undefined;
  for (const planned of snapshot.items) {
    let item: BatchItemResult;
    // 取消只在开始下一项前检查：同步 WASM 绘制无法中途打断，正在执行的一项总会完成并提交。
    if (!stop && options.signal?.aborted) {
      stop = batchProblem(ProblemCodes.deliveryCancelled, '已取消，当前项完成后停止调度');
      problems.push(stop);
    }
    if (stop) {
      const reason = `批次已停止，未执行：${stop.message}`;
      item = { index: planned.index, id: planned.id, status: 'notRun', severe: 1, hints: 0, reason,
        problems: [batchProblem(ProblemCodes.deliveryNotRun, reason)] };
    } else {
      const executed = await deliverBatchItem({ snapshot, index: planned.index, contents: options.contents, output });
      item = executed.item;
      if (executed.writeFailed && !(await output.available(planned.index))) {
        stop = batchProblem(ProblemCodes.deliveryStorageUnavailable, `第 ${planned.index} 项写入失败后批次目录已不可写，停止调度`);
        problems.push(stop);
      }
    }
    items.push(item);
    try { await options.onItem?.(item, { completed: items.length, total: snapshot.items.length }); } catch (error) {
      if (!stop) {
        stop = batchProblem(ProblemCodes.deliveryStopped, `进度回调失败，停止调度：${describeError(error)}`);
        problems.push(stop);
      }
    }
  }
  const manifest = summarizeBatch(snapshot, items, problems);
  try { await output.finish(manifest); } catch (error) { problems.push(...failure(error)); }
  return { mode: snapshot.envelope.mode, summary: manifest.summary, items, problems };
}

/**
 * 批量交付：一个根模板、整批统一的 final 或 draft 模式、1–1,000 个带唯一 id 的渲染项，串行逐项交付到新批次目录。
 * final 成功项是出图记录（delivered）；draft 有图即为预览（previewed，可含严重问题），不生成记录。
 * 首次异步操作前固定文档、全部渲染项、配置及资源版本映射；外层非法、根模板无法准备、固定资源不符或目标已存在则整批拒绝。
 * 项级错误只使本项失败；单项写入失败后探测存储，整体不可写则停止，后续项标为未执行。
 * 每项结束即调用 onItem，返回值只含状态与文件引用，不累积图片字节。
 * 同批各项相同的资源副本以硬链接共享，每条记录仍持有自己的文件入口；链接失败回退独立复制。
 * signal 取消在项与项之间生效：正在执行的一项完成并提交后停止，其余项标为未执行，batch.json 照常发布；建目录前已取消则不建目录。
 */
export async function deliverBatch(options: {
  readonly workspace: RecordDocuments;
  readonly resources: VersionedResourceStore;
  readonly request: unknown;
  readonly outDir: string;
  readonly renderOptions?: RenderOptions;
  readonly onItem?: (item: BatchItemResult, progress: BatchProgress) => void | Promise<void>;
  readonly signal?: AbortSignal;
}): Promise<BatchDeliveryResult> {
  if (options.signal?.aborted) return cancelledBeforeStart();
  const frozen = await freezeBatch(options);
  if (!frozen.snapshot) return { summary: NO_ITEMS, items: [], problems: frozen.problems };
  if (options.signal?.aborted) return cancelledBeforeStart();
  let output: BatchOutput;
  try { output = await createLocalBatchOutput(options.outDir); } catch (error) {
    return { summary: NO_ITEMS, items: [], problems: failure(error) };
  }
  const contents = frozen.contents!;
  const result = await runFrozenBatch({ snapshot: frozen.snapshot, contents: async (info) => contents.get(info.id)!, output, onItem: options.onItem, signal: options.signal });
  return { directory: options.outDir, ...result };
}

export { itemDirectory };

async function loadRecord(source: RecordSource): Promise<{ record: OutputRecord; input: RecordInput; files: Map<string, Uint8Array> }> {
  const raw: unknown = JSON.parse(Buffer.from(await source.read('record.json')).toString('utf8'));
  if (!isRecord(raw) || raw.format !== 'renderweave-output-record/1') recordFail('不支持的出图记录格式版本');
  if (typeof raw.build !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.build) || typeof raw.itemId !== 'string' || !raw.itemId || !Array.isArray(raw.files) || !Array.isArray(raw.resources)) recordFail('出图记录清单不完整');
  const files = new Map<string, Uint8Array>();
  for (const entry of raw.files) {
    if (!validFile(entry) || files.has(entry.file)) recordFail('记录文件条目不合法或重复');
    const bytes = await source.read(entry.file);
    if (digest(bytes) !== entry.sha256 || bytes.length !== entry.byteLength) recordFail(`记录文件已损坏：${entry.file}`, ProblemCodes.recordIntegrityMismatch);
    files.set(entry.file, bytes);
  }
  for (const file of ['input.json', 'problems.json', 'layout.json']) if (!files.has(file)) recordFail(`缺少记录文件：${file}`);
  const saved: unknown = JSON.parse(Buffer.from(files.get('input.json')!).toString('utf8'));
  if (!isRecord(saved) || !isRecord(saved.documents) || !isRecord(saved.options) || !Array.isArray(saved.options.fallbackFonts) || !Array.isArray(saved.options.svgFonts)) recordFail('记录输入不完整');
  const { input, resourceKinds } = prepareRecordInput(saved.documents as unknown as RecordDocuments, saved.batch, saved.options);
  if (digest(jsonBytes(input.documents)) !== digest(jsonBytes(saved.documents))) recordFail('记录文档依赖不完整或含有非规范内容');
  if (raw.itemId !== input.batch.items[0]!.id) recordFail('记录项标识与请求不一致');
  if (input.batch.mode !== 'final') recordFail('出图记录只能来自正式交付；草稿预览不能读取或重放');
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

/** 读取本地记录目录；会核对全部内容的完整性，但不要求当前构建可重放。 */
export function readOutputRecord(options: { readonly dir: string }): Promise<{ record?: OutputRecord; problems: readonly Problem[] }> {
  return readRecord(localRecordSource(options.dir));
}

/** 读取一条记录并核对全部内容的完整性，不要求当前构建可重放。 */
export async function readRecord(source: RecordSource): Promise<{ record?: OutputRecord; problems: readonly Problem[] }> {
  try { return { record: (await loadRecord(source)).record, problems: [] }; }
  catch (error) { return { problems: failure(error) }; }
}

/** 重放成果的完成清单（replay.json）。 */
export interface ReplayManifest {
  readonly format: 'renderweave-replay/1';
  readonly build: string;
  readonly itemId: string;
  readonly matched: true;
  readonly files: readonly RecordFile[];
}

/**
 * 仅从记录构建内存工作区，实际重新渲染并比对图片、问题清单和布局摘要。
 * 返回重新生成的成果与它的完成清单，由调用方决定写到哪里；构建不是记录所属的确切构建时拒绝。
 */
export async function replayRecord(source: RecordSource): Promise<{
  replayed?: { readonly files: ReadonlyMap<string, Uint8Array>; readonly manifest: ReplayManifest; readonly image: 'image.png' | 'image.jpg' };
  problems: readonly Problem[];
}> {
  try {
    const { record, input, files } = await loadRecord(source);
    if (record.build !== await rendererBuildId()) recordFail('渲染器构建不匹配；请使用创建记录的确切引擎与依赖', ProblemCodes.recordBuildMismatch);
    const memory = record.resources.flatMap((entry) => entry.state === 'available' ? [{ id: entry.id, kind: entry.kind, bytes: files.get(entry.file)! }] : []);
    const result = await render({ ...input.documents, resources: createMemoryResourceRepository(memory) }, singleRequest(input.batch), input.options);
    if (!result.image || !result.layout) recordFail('记录输入重新渲染失败', ProblemCodes.recordReplayMismatch);
    const regenerated = resultFiles(result);
    for (const [file, bytes] of regenerated) if (digest(bytes) !== digest(files.get(file)!)) recordFail(`重放结果不一致：${file}`, ProblemCodes.recordReplayMismatch);
    const manifest: ReplayManifest = { format: 'renderweave-replay/1', build: record.build, itemId: record.itemId, matched: true, files: [...regenerated].map(([file, bytes]) => fileInfo(file, bytes)) };
    return { problems: result.problems, replayed: { files: regenerated, manifest, image: result.image.format === 'png' ? 'image.png' : 'image.jpg' } };
  } catch (error) { return { problems: failure(error) }; }
}

/** 重放本地记录目录，成果写到新目录。 */
export async function replayOutputRecord(options: { readonly dir: string; readonly outDir: string }): Promise<{ replayed?: { readonly directory: string; readonly image: string }; problems: readonly Problem[] }> {
  const result = await replayRecord(localRecordSource(options.dir));
  if (!result.replayed) return { problems: result.problems };
  try { await publishRecordDirectory(options.outDir, result.replayed.files, 'replay.json', result.replayed.manifest); }
  catch (error) { return { problems: failure(error) }; }
  return { problems: result.problems, replayed: { directory: options.outDir, image: result.replayed.image } };
}
