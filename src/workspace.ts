/**
 * 工作区：一次渲染可用的静态数据定义、模板、数据集与资源仓库。
 *
 * 渲染入口只接收 Workspace 对象，不关心它来自哪里；loadWorkspace 从本地目录读出一个工作区，
 * 日后的 MCP 服务、HTTP 服务可以从数据库组装同样的对象。
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { openResourceRepository, type ResourceRepository } from './resources.js';
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
  const identity = value['dataset'];
  const staticSchema = parseStaticSchemaRef(identity['staticSchema']);
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
  const documents = await loadWorkspaceDocuments(options.dir);
  const { repository, problems } = await openResourceRepository(options.resourcesDir);
  return { ...documents, resources: repository, problems: [...documents.problems, ...problems] };
}

/** 发布只读取工作区文档，资源仓库的可用性不影响版本历史。 */
export async function loadWorkspaceDocuments(dir: string): Promise<Omit<Workspace, 'resources'>> {
  const problems: Problem[] = [];
  const definitions = new Map<string, { ref: StaticSchemaRef; definition?: unknown; compiled?: Record<string, unknown> }>();
  const templates = new Map<string, TemplateEntry>();
  const datasets = new Map<string, DatasetEntry>();

  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    problems.push(
      severe(ProblemCodes.inputUnreadable, { kind: 'input', source: dir }, `工作区目录无法读取：${describeError(error)}`),
    );
  }

  for (const file of files) {
    const source = join(dir, file);
    const location = { kind: 'input', source } as const;
    let document: unknown;
    const tooPrecise: string[] = [];
    try {
      document = parseJsonKeepingPrecision(await readFile(source, 'utf8'), tooPrecise);
    } catch (error) {
      problems.push(severe(ProblemCodes.inputUnreadable, location, `工作区文件无法读取：${describeError(error)}`));
      continue;
    }
    if (!isRecord(document)) continue;

    const dslVersion = document['dslVersion'];
    if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-schema/')) {
      const ref = parseStaticSchemaRef(document);
      if (!ref) {
        problems.push(severe(ProblemCodes.inputUnreadable, location, '数据定义缺少名称或版本号'));
        continue;
      }
      const entry = definitions.get(formatStaticSchemaRef(ref)) ?? { ref };
      if (entry.definition !== undefined) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `静态数据定义重复：${formatStaticSchemaRef(ref)}`));
        continue;
      }
      definitions.set(formatStaticSchemaRef(ref), { ...entry, definition: document });
    } else if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-template/')) {
      const name = document['name'];
      if (typeof name !== 'string' || name === '') {
        problems.push(severe(ProblemCodes.inputUnreadable, location, '模板缺少名称'));
        continue;
      }
      if (templates.has(name)) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `模板名称重复：${name}`));
        continue;
      }
      templates.set(name, { name, document, source });
    } else if ('x-renderweave-static-schema' in document) {
      const ref = parseStaticSchemaRef(document['x-renderweave-static-schema']);
      if (!ref) {
        problems.push(severe(ProblemCodes.inputUnreadable, location, '编译产物的 x-renderweave-static-schema 缺少名称或版本号'));
        continue;
      }
      const entry = definitions.get(formatStaticSchemaRef(ref)) ?? { ref };
      if (entry.compiled !== undefined) {
        problems.push(severe(ProblemCodes.inputDuplicate, location, `编译产物重复：${formatStaticSchemaRef(ref)}`));
        continue;
      }
      definitions.set(formatStaticSchemaRef(ref), { ...entry, compiled: document });
    } else if ('dataset' in document && 'data' in document) {
      const parsed = parseDatasetDocument(document);
      if (typeof parsed === 'string') {
        problems.push(severe(ProblemCodes.inputUnreadable, location, parsed));
        continue;
      }
      const id = parsed.dataset.id;
      if (id === undefined) {
        problems.push(severe(ProblemCodes.inputUnreadable, location, '工作区中的数据集必须有 dataset.id'));
        continue;
      }
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
      datasets.set(id, { id, document: parsed, source });
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
