/**
 * 代建推送的差异与冲突（票据 05，M264）：命令行交来清单，服务按自己的当前状态判定新增、更新、不变与冲突。
 * - 静态数据定义与编译产物：同名同版本只能新增；服务端已有而字节不同是冲突（ADR-0008）。
 * - 数据集：同 ID 只能新增；已有而字节不同是冲突，推送不覆盖租户里的数据集。
 * - 模板：按名称对比当前修订，字节不同就记一个新修订。
 * - 资源：按 ID 对比；种类不同、或两边都有的内容版本字节不同是冲突；本地多出的内容版本追加，服务端多出的不动。
 */
import { problem, ServiceProblemCodes, type ServiceProblem } from './api/problems.js';
import { DOCUMENT_KINDS, documentSource, type AuthoringState, type ContentStore, type DocumentKind, type PushWrites, type StoredDocument } from './backend.js';
import { classifyWorkspaceDocument, parseJsonKeepingPrecision, parseResourceRef } from './engine.js';

export interface PushManifest {
  readonly documents: readonly StoredDocument[];
  readonly resources: readonly { readonly id: string; readonly kind: 'image' | 'font'; readonly versions: readonly { readonly version: number; readonly sha256: string; readonly byteLength: number }[] }[];
}

const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const byteLength = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
/** 推送清单的 JSON Schema；同键重复、内容版本不连续等规则由 checkManifest 判断。 */
export const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['documents', 'resources'],
  additionalProperties: false,
  properties: {
    documents: {
      type: 'array', maxItems: 5000,
      items: {
        type: 'object', required: ['kind', 'key', 'sha256', 'byteLength'], additionalProperties: false,
        properties: { kind: { type: 'string', enum: DOCUMENT_KINDS }, key: { type: 'string', minLength: 1, maxLength: 500 }, sha256, byteLength },
      },
    },
    resources: {
      type: 'array', maxItems: 5000,
      items: {
        type: 'object', required: ['id', 'kind', 'versions'], additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 200 },
          kind: { type: 'string', enum: ['image', 'font'] },
          versions: {
            type: 'array', minItems: 1, maxItems: 1000,
            items: { type: 'object', required: ['version', 'sha256', 'byteLength'], additionalProperties: false, properties: { version: { type: 'integer', minimum: 1 }, sha256, byteLength } },
          },
        },
      },
    },
  },
} as const;

/** 清单自身的规则：同种类同键只出现一次；资源 ID 合规、只出现一次，内容版本从 v1 连续。 */
export function checkManifest(manifest: PushManifest): ServiceProblem[] {
  const problems: ServiceProblem[] = [];
  const seen = new Set<string>();
  manifest.documents.forEach((document, i) => {
    const source = documentSource(document.kind, document.key);
    if (seen.has(source)) problems.push(problem(ServiceProblemCodes.requestInvalid, `request.body.documents.${i}`, `清单里 ${source} 出现了不止一次`));
    seen.add(source);
  });
  const ids = new Set<string>();
  manifest.resources.forEach((resource, i) => {
    const where = `request.body.resources.${i}`;
    if (parseResourceRef(`res:${resource.id}`) !== resource.id) problems.push(problem(ServiceProblemCodes.requestInvalid, `${where}.id`, `资源 ID 不合规：${resource.id}`));
    else if (ids.has(resource.id)) problems.push(problem(ServiceProblemCodes.requestInvalid, `${where}.id`, `清单里资源 ${resource.id} 出现了不止一次`));
    ids.add(resource.id);
    if (resource.versions.some((content, j) => content.version !== j + 1)) {
      problems.push(problem(ServiceProblemCodes.requestInvalid, `${where}.versions`, `资源 ${resource.id} 的内容版本必须从 v1 连续排列`));
    }
  });
  return problems;
}

export type DiffStatus = 'added' | 'updated' | 'unchanged' | 'conflict';

export interface DocumentDiff {
  readonly kind: DocumentKind;
  readonly key: string;
  readonly status: DiffStatus;
  readonly reason?: string;
  /** 模板：推送前服务端的当前修订。 */
  readonly currentRevision?: number;
  /** 模板：提交后新记的修订。 */
  readonly revision?: number;
}

export interface ResourceDiff {
  readonly id: string;
  readonly kind: 'image' | 'font';
  readonly status: DiffStatus;
  readonly reason?: string;
  readonly localVersion: number;
  readonly serverVersion?: number;
}

export interface PushDiff {
  readonly summary: { readonly added: number; readonly updated: number; readonly unchanged: number; readonly conflicts: number };
  readonly documents: readonly DocumentDiff[];
  readonly resources: readonly ResourceDiff[];
}

const KIND_NAMES = { image: '图片', font: '字体' } as const;

function documentConflict(kind: DocumentKind, key: string): string {
  switch (kind) {
    case 'definition': return `服务端已有 ${key}，内容不同；已发布的静态数据定义不可变（ADR-0008），改动请发布为新版本`;
    case 'compiled': return `服务端已有 ${key} 的编译产物，内容不同；编译产物随静态数据定义不可变（ADR-0008）`;
    default: return `服务端已有数据集 ${key}，内容不同；推送不覆盖租户里的数据集，要换内容请另起数据集 ID`;
  }
}

/** 按服务端的当前状态判定清单里每一项。 */
export function diffPush(manifest: PushManifest, state: AuthoringState): PushDiff {
  const stored = new Map(state.documents.map((document) => [documentSource(document.kind, document.key), document]));
  const templates = new Map(state.templates.map((template) => [template.name, template]));
  const resources = new Map(state.resources.map((resource) => [resource.id, resource]));
  const documents = manifest.documents.map((local): DocumentDiff => {
    const server = stored.get(documentSource(local.kind, local.key));
    if (local.kind === 'template') {
      const template = templates.get(local.key);
      if (!template) return { kind: local.kind, key: local.key, status: 'added' };
      const current = template.revisions.find((item) => item.revision === template.currentRevision)!;
      return { kind: local.kind, key: local.key, status: current.sha256 === local.sha256 ? 'unchanged' : 'updated', currentRevision: template.currentRevision };
    }
    if (!server) return { kind: local.kind, key: local.key, status: 'added' };
    if (server.sha256 === local.sha256) return { kind: local.kind, key: local.key, status: 'unchanged' };
    return { kind: local.kind, key: local.key, status: 'conflict', reason: documentConflict(local.kind, local.key) };
  });
  const resourceDiffs = manifest.resources.map((local): ResourceDiff => {
    const server = resources.get(local.id), localVersion = local.versions.length;
    if (!server) return { id: local.id, kind: local.kind, status: 'added', localVersion };
    const base = { id: local.id, kind: local.kind, localVersion, serverVersion: server.currentVersion };
    if (server.kind !== local.kind) {
      return { ...base, status: 'conflict', reason: `服务端的 ${local.id} 是${KIND_NAMES[server.kind]}，本地是${KIND_NAMES[local.kind]}；资源种类创建后不可改变` };
    }
    const forked = local.versions.find((content, i) => i < server.versions.length && content.sha256 !== server.versions[i]!.sha256);
    if (forked) return { ...base, status: 'conflict', reason: `服务端的 ${local.id} v${forked.version} 与本地内容不同；内容版本只能追加，两边已经分叉` };
    return { ...base, status: localVersion > server.currentVersion ? 'updated' : 'unchanged' };
  });
  const all = [...documents, ...resourceDiffs];
  const count = (status: DiffStatus) => all.filter((item) => item.status === status).length;
  return {
    summary: { added: count('added'), updated: count('updated'), unchanged: count('unchanged'), conflicts: count('conflict') },
    documents, resources: resourceDiffs,
  };
}

/** 冲突逐项变成问题，位置是"种类:键"或"resource:资源ID"。 */
export function conflictProblems(diff: PushDiff): ServiceProblem[] {
  return [
    ...diff.documents.filter((item) => item.status === 'conflict').map((item) => problem(ServiceProblemCodes.pushConflict, documentSource(item.kind, item.key), item.reason!)),
    ...diff.resources.filter((item) => item.status === 'conflict').map((item) => problem(ServiceProblemCodes.pushConflict, `resource:${item.id}`, item.reason!)),
  ];
}

/** 没有冲突时要写入的内容：新增的文档、新增或更新的模板修订、新资源与追加的内容版本。 */
export function pushWrites(manifest: PushManifest, diff: PushDiff): PushWrites {
  const changed = (status: DiffStatus) => status === 'added' || status === 'updated';
  return {
    documents: manifest.documents.filter((document, i) => document.kind !== 'template' && diff.documents[i]!.status === 'added'),
    templates: manifest.documents.filter((document, i) => document.kind === 'template' && changed(diff.documents[i]!.status))
      .map((document) => ({ name: document.key, sha256: document.sha256, byteLength: document.byteLength })),
    resources: manifest.resources.flatMap((resource, i) => {
      const item = diff.resources[i]!;
      if (!changed(item.status)) return [];
      return [{ id: resource.id, kind: resource.kind, create: item.status === 'added', versions: resource.versions.slice(item.serverVersion ?? 0) }];
    }),
  };
}

/** 要写入的全部内容的 SHA-256（去重）。 */
export function writtenContents(writes: PushWrites): string[] {
  return [...new Set([...writes.documents, ...writes.templates, ...writes.resources.flatMap((resource) => resource.versions)].map((item) => item.sha256))];
}

const KIND_LABELS: Record<DocumentKind, string> = { definition: '数据定义', compiled: '编译产物', template: '模板', dataset: '数据集' };

/** 要写入的内容都已上传，字节数与声明一致；文档的种类与键按内容核对，不信声明。 */
export async function verifyContents(writes: PushWrites, contents: ContentStore): Promise<ServiceProblem[]> {
  const problems: ServiceProblem[] = [];
  const check = async (source: string, claim: { sha256: string; byteLength: number }, kind?: DocumentKind, key?: string) => {
    const bytes = await contents.get(claim.sha256);
    if (!bytes) {
      problems.push(problem(ServiceProblemCodes.pushContentMissing, source, `内容 ${claim.sha256} 还没有上传`));
      return;
    }
    if (bytes.length !== claim.byteLength) {
      problems.push(problem(ServiceProblemCodes.pushContentMismatch, source, `内容是 ${bytes.length} 字节，声明的是 ${claim.byteLength} 字节`));
      return;
    }
    if (!kind) return;
    let found;
    try { found = classifyWorkspaceDocument(parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), [])); }
    catch { found = undefined; }
    const actual = found && found.kind !== 'invalid' && found.kind !== 'other' ? found : undefined;
    if (!actual || actual.kind !== kind || actual.key !== key) {
      const what = actual ? `${KIND_LABELS[actual.kind]} ${actual.key}` : '不是数据定义、编译产物、模板或数据集';
      problems.push(problem(ServiceProblemCodes.pushContentMismatch, source, `内容是${actual ? ' ' : ''}${what}，与声明的${KIND_LABELS[kind]} ${key} 不符`));
    }
  };
  for (const document of writes.documents) await check(documentSource(document.kind, document.key), document, document.kind, document.key);
  for (const template of writes.templates) await check(documentSource('template', template.name), template, 'template', template.name);
  for (const resource of writes.resources) {
    for (const content of resource.versions) await check(`resource:${resource.id}@v${content.version}`, content);
  }
  return problems;
}

/** 按固定顺序排列（不依赖数据库的排序规则）：文档按种类与键，模板按名称，资源按 ID。 */
export function sortedState(state: AuthoringState): AuthoringState {
  const by = <T>(key: (item: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return {
    documents: [...state.documents].sort(by((document) => documentSource(document.kind, document.key))),
    templates: [...state.templates].sort(by((template) => template.name)).map((template) => ({ ...template, revisions: [...template.revisions].sort((a, b) => a.revision - b.revision) })),
    resources: [...state.resources].sort(by((resource) => resource.id)),
  };
}

/** 已登记的内容：工作区文档、模板的全部修订与资源的全部内容版本。没登记的上传内容读不到。 */
export function registeredContents(state: AuthoringState): Set<string> {
  return new Set([
    ...state.documents.map((document) => document.sha256),
    ...state.templates.flatMap((template) => template.revisions.map((revision) => revision.sha256)),
    ...state.resources.flatMap((resource) => resource.versions.map((content) => content.sha256)),
  ]);
}
