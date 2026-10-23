/**
 * 资源仓库：按资源 ID 管理图片资源与字体资源，资源引用写成 `res:资源ID`（M90 S8）。
 *
 * 文件形式：旧 resources.json 列出 ID、种类与相对路径；版本清单固定内容版本并校验字节。
 * 引擎只通过 ResourceRepository 接口取资源，日后换成数据库或对象存储不影响引擎。
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { ProblemCodes, severe, type Problem, type ProblemCode } from './problems.js';
import { describeError, isRecord } from './util.js';

export type ResourceKind = 'image' | 'font';

export interface ResourceInfo {
  readonly id: string;
  readonly kind: ResourceKind;
}

export interface ResourceRepository {
  get(id: string): ResourceInfo | undefined;
  /** 全部资源，按资源 ID 排序。 */
  list(): readonly ResourceInfo[];
  /** 读取资源内容；资源不存在或文件无法读取时抛出 ResourceReadError。 */
  read(id: string): Promise<Uint8Array>;
}

/** 在本地读取约束内取得全部字节；计算阶段只读副本，未使用的损坏资源不阻止其他出图。 */
export async function snapshotResourceRepository(repository: ResourceRepository): Promise<ResourceRepository> {
  const infos = repository.list().map(item => repository.get(item.id)!);
  const contents = new Map<string, Uint8Array | { error: unknown }>();
  for (const info of infos) {
    try { contents.set(info.id, Uint8Array.from(await repository.read(info.id))); }
    catch (error) { contents.set(info.id, { error }); }
  }
  return { get: id => infos.find(info => info.id === id), list: () => infos,
    async read(id) {
      const content = contents.get(id);
      if (!content) throw new ResourceReadError(id, `资源仓库中没有资源 ${id}`);
      if (!(content instanceof Uint8Array)) throw content.error;
      return Uint8Array.from(content);
    } };
}

export class ResourceReadError extends Error {
  constructor(
    readonly resourceId: string,
    message: string,
    readonly code: ProblemCode = ProblemCodes.resourceUnreadable,
  ) {
    super(message);
  }
}

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RESOURCE_REF = /^res:([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** 解析 `res:资源ID`，格式不对时返回 undefined。 */
export function parseResourceRef(ref: string): string | undefined {
  return RESOURCE_REF.exec(ref)?.[1];
}

const MANIFEST = 'resources.json';

interface FileEntry extends ResourceInfo {
  readonly file: string;
  readonly sha256?: string;
  readonly byteLength?: number;
}

/** 自动识别新旧清单。旧清单返回可用部分；版本清单错误时整体拒绝。 */
export async function openResourceRepository(
  dir: string,
): Promise<{ repository: ResourceRepository; problems: Problem[] }> {
  const problems: Problem[] = [];
  const entries = new Map<string, FileEntry>();
  const manifestPath = join(dir, MANIFEST);
  const location = { kind: 'input', source: manifestPath } as const;

  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    problems.push(
      severe(ProblemCodes.inputUnreadable, location, `资源仓库清单无法读取：${describeError(error)}`),
    );
    return { repository: new FileResourceRepository(entries), problems };
  }

  if (isRecord(manifest) && 'format' in manifest) {
    const { openVersionedResourceStore } = await import('./versioned-resources.js');
    const result = await openVersionedResourceStore(dir);
    return { repository: result.store?.pin().repository ?? new FileResourceRepository(entries), problems: result.problems };
  }
  const list = isRecord(manifest) ? manifest['resources'] : undefined;
  if (!Array.isArray(list)) {
    problems.push(severe(ProblemCodes.inputUnreadable, location, '资源仓库清单缺少 resources 列表'));
    return { repository: new FileResourceRepository(entries), problems };
  }

  list.forEach((item, position) => {
    const where = { kind: 'input', source: `${manifestPath}#resources[${position + 1}]` } as const;
    if (!isRecord(item)) {
      problems.push(severe(ProblemCodes.inputUnreadable, where, '资源条目必须是对象'));
      return;
    }
    const { id, kind, file } = item;
    if (typeof id !== 'string' || !RESOURCE_ID.test(id)) {
      problems.push(severe(ProblemCodes.inputUnreadable, where, `资源 ID 不合法：${String(id)}`));
      return;
    }
    if (kind !== 'image' && kind !== 'font') {
      problems.push(severe(ProblemCodes.inputUnreadable, where, `资源 ${id} 的种类必须是 image 或 font`));
      return;
    }
    if (typeof file !== 'string' || !isInside(dir, file)) {
      problems.push(severe(ProblemCodes.inputUnreadable, where, `资源 ${id} 的文件路径必须位于仓库目录内`));
      return;
    }
    if (entries.has(id)) {
      problems.push(severe(ProblemCodes.inputDuplicate, where, `资源 ID 重复：${id}`));
      return;
    }
    entries.set(id, { id, kind, file: join(dir, file),
      ...(typeof item.sha256 === 'string' ? { sha256: item.sha256 } : {}),
      ...(typeof item.byteLength === 'number' ? { byteLength: item.byteLength } : {}) });
  });

  return { repository: new FileResourceRepository(entries), problems };
}

class FileResourceRepository implements ResourceRepository {
  constructor(private readonly entries: ReadonlyMap<string, FileEntry>) {}

  get(id: string): ResourceInfo | undefined {
    const entry = this.entries.get(id);
    return entry && { id: entry.id, kind: entry.kind };
  }

  list(): readonly ResourceInfo[] {
    return sortedInfos(this.entries.values());
  }

  async read(id: string): Promise<Uint8Array> {
    const entry = this.entries.get(id);
    if (!entry) throw new ResourceReadError(id, `资源仓库中没有资源 ${id}`);
    try {
      const bytes = new Uint8Array(await readFile(entry.file));
      if (entry.sha256 !== undefined && (createHash('sha256').update(bytes).digest('hex') !== entry.sha256 || bytes.length !== entry.byteLength)) {
        throw new Error(`资源 ${id} 的字节与固定记录不符`);
      }
      return bytes;
    } catch (error) {
      const hintText = entry.kind === 'font' ? '；字体文件需先运行 npm run fetch-fonts 获取' : '';
      throw new ResourceReadError(id, `资源 ${id} 的文件无法读取：${describeError(error)}${hintText}`);
    }
  }
}

/** 内存中的资源仓库，供集成方（MCP 服务、HTTP 服务）与测试直接提供资源内容。 */
export function createMemoryResourceRepository(
  resources: ReadonlyArray<ResourceInfo & { readonly bytes: Uint8Array }>,
): ResourceRepository {
  const entries = new Map(resources.map((resource) => [resource.id, resource]));
  return {
    get(id) {
      const entry = entries.get(id);
      return entry && { id: entry.id, kind: entry.kind };
    },
    list: () => sortedInfos(entries.values()),
    async read(id) {
      const entry = entries.get(id);
      if (!entry) throw new ResourceReadError(id, `资源仓库中没有资源 ${id}`);
      return entry.bytes;
    },
  };
}

export function sortedInfos(entries: Iterable<ResourceInfo>): ResourceInfo[] {
  return [...entries].map(({ id, kind }) => ({ id, kind })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function isInside(dir: string, file: string): boolean {
  if (isAbsolute(file)) return false;
  const rel = relative(dir, join(dir, normalize(file)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
