/**
 * 工作区：一次渲染可用的静态数据定义、模板、数据集与资源仓库。
 *
 * 渲染入口只接收 Workspace 对象，不关心它来自哪里；loadWorkspace 从本地目录读出一个工作区，
 * 日后的 MCP 服务、HTTP 服务可以从数据库组装同样的对象。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { createMemoryResourceRepository, openResourceRepository, snapshotResourceRepository, type ResourceRepository } from './resources.js';
import { localAccessProblem, withLocalAccess } from './local-access.js';
import { significantDigits } from './schema/formats.js';
import { MAX_SIGNIFICANT_DIGITS } from './schema/model.js';
import { describeError, isRecord } from './util.js';

export interface StaticSchemaRef {
  readonly name: string;
  readonly version: number;
}

export interface StaticSchemaEntry {
  readonly ref: StaticSchemaRef;
  /** 数据定义 DSL 原文；本期渲染不读取。 */
  readonly definition?: unknown;
  /** 编译产物 JSON Schema（M103）。渲染入口只读取它，出图时不编译。 */
  readonly compiled?: Record<string, unknown>;
}

export interface TemplateEntry {
  readonly name: string;
  readonly document: unknown;
  readonly source?: string;
}

/** 数据集文件分为身份（dataset）与业务数据（data）两部分（M90 S6）。 */
export interface DatasetDocument {
  readonly dataset: {
    readonly id?: string;
    readonly staticSchema: StaticSchemaRef;
    readonly [key: string]: unknown;
  };
  readonly data: unknown;
}

export interface DatasetEntry {
  readonly id: string;
  readonly document: DatasetDocument;
  readonly source?: string;
}

export interface Workspace {
  readonly staticSchemas: readonly StaticSchemaEntry[];
  readonly templates: readonly TemplateEntry[];
  readonly datasets: readonly DatasetEntry[];
  readonly resources: ResourceRepository;
  /** 读取工作区时发现的问题，每次渲染都会带上。 */
  readonly problems: readonly Problem[];
}

export function formatStaticSchemaRef(ref: StaticSchemaRef): string {
  return `${ref.name} v${ref.version}`;
}

export function sameStaticSchema(a: StaticSchemaRef, b: StaticSchemaRef): boolean {
  return a.name === b.name && a.version === b.version;
}

export function parseStaticSchemaRef(value: unknown): StaticSchemaRef | undefined {
  if (!isRecord(value)) return undefined;
  const { name, version } = value;
  if (typeof name !== 'string' || name === '') return undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return undefined;
  return { name, version };
}

/** 检查一份数据集文档的身份部分；数据部分由编译产物校验。 */
export function parseDatasetDocument(value: unknown): DatasetDocument | string {
  if (!isRecord(value) || !isRecord(value['dataset']) || !('data' in value)) {
    return '数据集必须由 dataset（身份）与 data（数据）两部分组成';
  }
  // 未知键报错，不静默忽略（M223）：根只有 dataset 与 data；身份部分的其他键（名称、来源等）不作要求。
  const extra = Object.keys(value).filter((key) => key !== 'dataset' && key !== 'data');
  if (extra.length > 0) return `数据集只能有 dataset 与 data 两部分，不能有 ${extra.join('、')}`;
  const identity = value['dataset'];
  const schemaRef = identity['staticSchema'];
  if (isRecord(schemaRef)) {
    const unknown = Object.keys(schemaRef).filter((key) => key !== 'name' && key !== 'version');
    if (unknown.length > 0) return `数据集的 dataset.staticSchema 只能写 name 与 version，不能有 ${unknown.join('、')}`;
  }
  const staticSchema = parseStaticSchemaRef(schemaRef);
  if (!staticSchema) return '数据集的 dataset.staticSchema 必须写明静态数据定义的名称与版本号';
  if (identity['id'] !== undefined && typeof identity['id'] !== 'string') return '数据集的 dataset.id 必须是文本';
  return { dataset: { ...identity, staticSchema }, data: value['data'] };
}

/**
 * 从本地目录读取工作区。目录下每个 .json 文件按内容归类：
 * - `dslVersion` 为 `renderweave-schema/…`：数据定义 DSL；
 * - `dslVersion` 为 `renderweave-template/…`：模板；
 * - 带 `x-renderweave-static-schema` 的 JSON Schema：编译产物；
 * - 由 `dataset` 与 `data` 组成：数据集；
 * - 其他文件（如渲染请求）忽略。
 * 资源仓库是另一个目录，因为同一个资源仓库常被多个工作区共用。
 */
export async function loadWorkspace(options: { dir: string; resourcesDir: string }): Promise<Workspace> {
  try {
    const captured = await withLocalAccess([options.dir, options.resourcesDir], async () => {
      const entries = await localWorkspaceDocuments(options.dir).list();
      const { repository, problems } = await openResourceRepository(options.resourcesDir);
      return { entries, resources: await snapshotResourceRepository(repository), problems };
    }, 1000);
    const documents = await readWorkspaceDocuments({ location: options.dir, list: async () => captured.entries });
    return { ...documents, resources: captured.resources, problems: [...documents.problems, ...captured.problems] };
  } catch (error) {
    return { staticSchemas: [], templates: [], datasets: [], resources: createMemoryResourceRepository([]),
      problems: [localAccessProblem(error) ?? severe(ProblemCodes.inputUnreadable, { kind: 'input', source: options.dir }, `工作区无法读取：${describeError(error)}`)] };
  }
}

/** 工作区中的一份文档：来源说明（本地是文件路径）与按需读取的原始字节。 */
export interface WorkspaceDocumentEntry {
  readonly source: string;
  read(): Promise<Uint8Array>;
}

/**
 * 工作区文档的来源（ADR-0018）：本地目录、内存或服务端存储。
 * 渲染只认解析后的 Workspace；来源只负责列出文档并给出原始字节，归类、精度检查与重复检查都在 readWorkspaceDocuments 中统一做。
 */
export interface WorkspaceDocumentSource {
  /** 来源的位置说明，列不出文档时作为问题位置。 */
  readonly location: string;
  /** 按来源排序列出全部文档；列不出时抛错。 */
  list(): Promise<readonly WorkspaceDocumentEntry[]>;
}

/** 本地目录：目录下的每个 .json 文件是一份文档。 */
export function localWorkspaceDocuments(dir: string): WorkspaceDocumentSource {
  return {
    location: dir,
    list: () => withLocalAccess([dir], async () => {
      const entries: WorkspaceDocumentEntry[] = [];
      for (const file of (await readdir(dir)).filter(file => file.endsWith('.json')).sort()) {
        const source = join(dir, file);
        try { const bytes = await readFile(source); entries.push({ source, read: async () => Uint8Array.from(bytes) }); }
        catch (error) { entries.push({ source, read: async () => { throw error; } }); }
      }
      return entries;
    }, 1000),
  };
}

/** 内存中的文档，供服务端与测试直接提供原始字节。 */
export function memoryWorkspaceDocuments(documents: readonly { readonly source: string; readonly bytes: Uint8Array }[], location = 'memory'): WorkspaceDocumentSource {
  const entries = [...documents].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .map(({ source, bytes }) => ({ source, read: async () => bytes }));
  return { location, list: async () => entries };
}

/** 发布只读取工作区文档，资源仓库的可用性不影响版本历史。 */
export async function loadWorkspaceDocuments(dir: string): Promise<Omit<Workspace, 'resources'>> {
  return readWorkspaceDocuments(localWorkspaceDocuments(dir));
}

/** 读出并归类一个来源中的全部文档；无法读取或无法归类的文档记为问题，不中断其他文档。 */
export async function readWorkspaceDocuments(source: WorkspaceDocumentSource): Promise<Omit<Workspace, 'resources'>> {
  const problems: Problem[] = [];
  const definitions = new Map<string, { ref: StaticSchemaRef; definition?: unknown; compiled?: Record<string, unknown> }>();
  const templates = new Map<string, TemplateEntry>();
  const datasets = new Map<string, DatasetEntry>();

  let entries: readonly WorkspaceDocumentEntry[] = [];
  try {
    entries = await source.list();
  } catch (error) {
    problems.push(
      localAccessProblem(error) ?? severe(ProblemCodes.inputUnreadable, { kind: 'input', source: source.location }, `工作区目录无法读取：${describeError(error)}`),
    );
  }

  for (const entry of entries) {
    const source = entry.source;
    const location = { kind: 'input', source } as const;
    let document: unknown;
    const tooPrecise: string[] = [];
    try {
      document = parseJsonKeepingPrecision(Buffer.from(await entry.read()).toString('utf8'), tooPrecise);
    } catch (error) {
      problems.push(severe(ProblemCodes.inputUnreadable, location, `工作区文件无法读取：${describeError(error)}`));
      continue;
    }
    const found = classifyWorkspaceDocument(document);
    if (found.kind === 'invalid') {
      problems.push(severe(ProblemCodes.inputUnreadable, location, found.message));
    } else if (found.kind === 'definition' || found.kind === 'compiled') {
      const part = found.kind === 'definition' ? 'definition' : 'compiled';
      const entry = definitions.get(formatStaticSchemaRef(found.ref)) ?? { ref: found.ref };
      if (entry[part] !== undefined) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `${part === 'definition' ? '静态数据定义' : '编译产物'}重复：${formatStaticSchemaRef(found.ref)}`));
        continue;
      }
      definitions.set(formatStaticSchemaRef(found.ref), { ...entry, [part]: document });
    } else if (found.kind === 'template') {
      if (templates.has(found.name)) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `模板名称重复：${found.name}`));
        continue;
      }
      templates.set(found.name, { name: found.name, document, source });
    } else if (found.kind === 'dataset') {
      const { id } = found;
      if (datasets.has(id)) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `数据集 ID 重复：${id}`));
        continue;
      }
      for (const literal of tooPrecise) {
        problems.push(
          severe(
            ProblemCodes.datasetTooManyDigits,
            location,
            `数据集 ${id} 中的数值 ${literal} 超过 ${MAX_SIGNIFICANT_DIGITS} 位有效数字，按双精度读取会失真（M112）`,
          ),
        );
      }
      datasets.set(id, { id, document: found.document, source });
    }
  }

  return {
    staticSchemas: [...definitions.values()],
    templates: [...templates.values()],
    datasets: [...datasets.values()],
    problems,
  };
}

/**
 * 一份工作区文档的种类与身份（readWorkspaceDocuments 与代建推送共用）：
 * 数据定义与编译产物以"名称@版本"为键，模板以名称为键，数据集以 dataset.id 为键；其他 JSON（如渲染请求）不属于工作区。
 */
export type WorkspaceDocumentClass =
  | { readonly kind: 'definition' | 'compiled'; readonly key: string; readonly ref: StaticSchemaRef }
  | { readonly kind: 'template'; readonly key: string; readonly name: string }
  | { readonly kind: 'dataset'; readonly key: string; readonly id: string; readonly document: DatasetDocument }
  | { readonly kind: 'invalid'; readonly message: string }
  | { readonly kind: 'other' };

/** 按内容归类一份已解析的工作区文档；规则见 loadWorkspace。 */
export function classifyWorkspaceDocument(document: unknown): WorkspaceDocumentClass {
  if (!isRecord(document)) return { kind: 'other' };
  const dslVersion = document['dslVersion'];
  const refKey = (ref: StaticSchemaRef) => `${ref.name}@${ref.version}`;
  if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-schema/')) {
    const ref = parseStaticSchemaRef(document);
    return ref ? { kind: 'definition', key: refKey(ref), ref } : { kind: 'invalid', message: '数据定义缺少名称或版本号' };
  }
  if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-template/')) {
    const name = document['name'];
    return typeof name === 'string' && name !== '' ? { kind: 'template', key: name, name } : { kind: 'invalid', message: '模板缺少名称' };
  }
  if ('x-renderweave-static-schema' in document) {
    const ref = parseStaticSchemaRef(document['x-renderweave-static-schema']);
    return ref ? { kind: 'compiled', key: refKey(ref), ref } : { kind: 'invalid', message: '编译产物的 x-renderweave-static-schema 缺少名称或版本号' };
  }
  if ('dataset' in document && 'data' in document) {
    const parsed = parseDatasetDocument(document);
    if (typeof parsed === 'string') return { kind: 'invalid', message: parsed };
    const id = parsed.dataset.id;
    if (id === undefined) return { kind: 'invalid', message: '工作区中的数据集必须有 dataset.id' };
    return { kind: 'dataset', key: id, id, document: parsed };
  }
  return { kind: 'other' };
}

/**
 * 解析 JSON，并记下超过 15 位有效数字的数值原文：这样的数值按双精度读取后会失真，
 * 之后再也无法从读出的值发现（M112）。依赖 JSON.parse 的原文访问（Node 22 起可用）。
 */
export function parseJsonKeepingPrecision(text: string, tooPrecise: string[]): unknown {
  return JSON.parse(text, function (_key, value, context?: { source?: string }) {
    if (typeof value === 'number' && context?.source && significantDigits(context.source) > MAX_SIGNIFICANT_DIGITS) {
      tooPrecise.push(context.source);
    }
    return value;
  });
}
