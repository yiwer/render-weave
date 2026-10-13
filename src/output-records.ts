/** 单项正式交付、完整性读取与自足重放；渲染逻辑统一调用 render。 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { render, type RenderResult, type RenderOptions } from './render.js';
import { createMemoryResourceRepository, parseResourceRef, type ResourceKind } from './resources.js';
import type { VersionedResourceInfo, VersionedResourceStore } from './versioned-resources.js';
import { isRecord, describeError } from './util.js';
import { rendererBuildId } from './renderer-build.js';
import { prepareRecordInput, RecordError, recordFail, singleRequest, type RecordDocuments, type RecordInput } from './record-input.js';
import { digest, fileInfo, jsonBytes, publishRecordDirectory, readRecordFile, recordRoot, validFile, type RecordFile } from './record-files.js';

export type { BatchRenderRequest } from './record-input.js';
export type RecordedResource = { readonly id: string; readonly state: 'missing' } |
  (VersionedResourceInfo & { readonly state: 'available'; readonly file: string });
export interface OutputRecord {
  readonly format: 'renderweave-output-record/1';
  readonly build: string;
  readonly itemId: string;
  readonly resources: readonly RecordedResource[];
  readonly files: readonly RecordFile[];
}
export interface DeliveryReference {
  readonly id: string;
  readonly directory: string;
  readonly image: string;
  readonly problems: 'problems.json';
  readonly layout: 'layout.json';
  readonly record: 'record.json';
}
export interface DeliveryResult { readonly delivered?: DeliveryReference; readonly problems: readonly Problem[] }

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

/** 接受单项批量合同；资源仓库必须有内容版本。返回文件引用，不累积图片字节。 */
export async function deliverBatch(options: {
  readonly workspace: RecordDocuments;
  readonly resources: VersionedResourceStore;
  readonly request: unknown;
  readonly outDir: string;
  readonly renderOptions?: RenderOptions;
}): Promise<DeliveryResult> {
  try {
    const prepared = prepareRecordInput(options.workspace, options.request, options.renderOptions);
    const inputBytes = jsonBytes(prepared.input);
    const input: RecordInput = JSON.parse(Buffer.from(inputBytes).toString('utf8'));
    const { resources: store, outDir } = options;
    // 所有元信息先同步固定，后续读取按确切版本；绝不渲染后重新取当前资源。
    const selected = [...prepared.resourceKinds].map(([id, kind]) => ({ id, kind, info: structuredClone(store.get(id)) }));
    const resources: RecordedResource[] = [];
    const files = new Map<string, Uint8Array>();
    const memory: { id: string; kind: ResourceKind; bytes: Uint8Array }[] = [];
    for (const { id, kind, info } of selected) {
      if (!info) { resources.push({ id, state: 'missing' }); continue; }
      if (info.id !== id || !Number.isSafeInteger(info.version) || info.version < 1) recordFail(`资源 ${id} 的固定版本元信息不合法`);
      if (info.kind !== kind) recordFail(`资源 ${id} 的种类应为 ${kind}`);
      const bytes = new Uint8Array(await store.read(id, info.version));
      if (digest(bytes) !== info.sha256 || bytes.length !== info.byteLength) recordFail(`资源 ${id} 与固定版本不一致`, ProblemCodes.recordIntegrityMismatch);
      const file = `${kind}-${String(memory.length + 1).padStart(6, '0')}.bin`;
      resources.push({ ...info, state: 'available', file });
      files.set(file, bytes); memory.push({ id, kind, bytes });
    }
    const build = await rendererBuildId();
    const result = await render({ ...input.documents, resources: createMemoryResourceRepository(memory) }, singleRequest(input.batch), input.options);
    if (!result.image || !result.layout) return { problems: result.problems };
    files.set('input.json', inputBytes);
    for (const [file, bytes] of resultFiles(result)) files.set(file, bytes);
    const itemId = input.batch.items[0]!.id;
    const record: OutputRecord = { format: 'renderweave-output-record/1', build, itemId, resources, files: [...files].map(([file, bytes]) => fileInfo(file, bytes)) };
    await publishRecordDirectory(outDir, files, 'record.json', record);
    return { problems: result.problems, delivered: { id: itemId, directory: outDir, image: result.image.format === 'png' ? 'image.png' : 'image.jpg', problems: 'problems.json', layout: 'layout.json', record: 'record.json' } };
  } catch (error) { return { problems: failure(error) }; }
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
