/** 本地资源内容版本：不可变内容文件先落盘，整份清单最后发布。 */
import * as fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { hint, ProblemCodes, severe, type Problem, type ProblemCode } from './problems.js';
import { parseResourceRef, ResourceReadError, type ResourceInfo, type ResourceRepository } from './resources.js';
import { describeError, isRecord } from './util.js';

const FORMAT = 'renderweave-resources/1';
const MANIFEST = 'resources.json';
const LOCK = '.write-lock';

export interface VersionedResourceInfo extends ResourceInfo {
  readonly version: number;
  readonly sha256: string;
  readonly byteLength: number;
}
export type ResourceVersionMap = Readonly<Record<string, number>>;
export interface PinnedResources {
  readonly repository?: ResourceRepository;
  readonly versions?: ResourceVersionMap;
  readonly problems: Problem[];
}
/** 打开时的清单快照；重新打开才能看到后续导入。读取始终核对完整性。 */
export interface VersionedResourceStore {
  list(): readonly VersionedResourceInfo[];
  get(id: string, version?: number): VersionedResourceInfo | undefined;
  read(id: string, version: number): Promise<Uint8Array>;
  /** 省略映射则固定全部当前版本；显式映射只暴露列出的资源，不回退到当前版本。 */
  pin(versions?: ResourceVersionMap): PinnedResources;
}
interface ContentVersion { version: number; sha256: string; byteLength: number; file: string }
interface Entry extends ResourceInfo { currentVersion: number; versions: ContentVersion[] }
interface Manifest { format: typeof FORMAT; resources: Entry[] }

class StoreError extends Error {
  constructor(readonly code: ProblemCode, readonly source: string, message: string) { super(message); }
}
function problem(error: unknown, source: string): Problem {
  return severe(error instanceof StoreError ? error.code : ProblemCodes.resourceWriteFailed,
    { kind: 'input', source: error instanceof StoreError ? error.source : source }, describeError(error));
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const validId = (id: unknown): id is string => typeof id === 'string' && parseResourceRef(`res:${id}`) === id;
function fail(source: string, message: string, code: ProblemCode = ProblemCodes.inputUnreadable): never {
  throw new StoreError(code, source, message);
}

async function loadManifest(dir: string): Promise<Manifest> {
  const path = join(dir, MANIFEST);
  let value: unknown;
  try {
    if (!(await fs.lstat(path)).isFile()) fail(path, '资源清单必须是普通文件，不能是链接');
    value = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof StoreError) throw error;
    fail(path, `资源清单无法读取：${describeError(error)}`);
  }
  if (!isRecord(value) || value.format !== FORMAT || !Array.isArray(value.resources)) fail(path, `需要 ${FORMAT} 清单`);
  const ids = new Set<string>();
  const resources: Entry[] = [];
  for (const [i, item] of value.resources.entries()) {
    const source = `${path}#resources[${i + 1}]`;
    if (!isRecord(item) || !validId(item.id) || (item.kind !== 'image' && item.kind !== 'font') ||
      !positive(item.currentVersion) || !Array.isArray(item.versions) || item.versions.length === 0) fail(source, '资源条目或当前版本不合法');
    if (ids.has(item.id)) fail(source, `资源 ID 重复：${item.id}`, ProblemCodes.inputDuplicate);
    ids.add(item.id);
    const versions: ContentVersion[] = [];
    for (const [j, version] of item.versions.entries()) {
      const where = `${source}.versions[${j + 1}]`;
      if (!isRecord(version) || version.version !== j + 1 || typeof version.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(version.sha256) || typeof version.byteLength !== 'number' ||
        !Number.isSafeInteger(version.byteLength) || version.byteLength < 0 || typeof version.file !== 'string' ||
        !/^objects\/[a-f0-9-]{36}\.bin$/.test(version.file)) fail(where, '内容版本、SHA-256、字节数或内容路径不合法');
      versions.push({ version: j + 1, sha256: version.sha256, byteLength: version.byteLength, file: version.file });
    }
    if (item.currentVersion !== versions.length) fail(source, '当前版本必须是最后一个连续内容版本');
    resources.push({ id: item.id, kind: item.kind, currentVersion: item.currentVersion, versions });
  }
  return { format: FORMAT, resources };
}

function metadata(entry: Entry, content: ContentVersion): VersionedResourceInfo {
  return { id: entry.id, kind: entry.kind, version: content.version, sha256: content.sha256, byteLength: content.byteLength };
}

/** 路径逐段拒绝链接，防止源文件或内容目录经 junction/symlink 指向仓库外。 */
async function localFile(root: string, file: string): Promise<string> {
  if (!file || isAbsolute(file) || win32.isAbsolute(file) || /[:\0]/.test(file)) fail(file, '资源路径必须是仓库内相对路径');
  const parts = file.replaceAll('\\', '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) fail(file, '资源路径不能含空段、. 或 ..');
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) fail(path, '资源路径必须经过普通目录并指向普通文件，不能包含链接');
  }
  const rel = relative(root, await fs.realpath(path));
  if (rel === '..' || rel.startsWith(`..${win32.sep}`) || rel.startsWith('../') || isAbsolute(rel)) fail(path, '资源路径越出仓库');
  return path;
}

class FileVersionedStore implements VersionedResourceStore {
  private readonly entries: Map<string, Entry>;
  constructor(private readonly dir: string, manifest: Manifest) {
    this.entries = new Map(manifest.resources.map((entry) => [entry.id, entry]));
  }
  list(): VersionedResourceInfo[] {
    return [...this.entries.keys()].sort().map((id) => this.get(id)!);
  }
  get(id: string, version?: number): VersionedResourceInfo | undefined {
    const entry = this.entries.get(id);
    const content = entry?.versions.find((item) => item.version === (version ?? entry.currentVersion));
    return entry && content ? metadata(entry, content) : undefined;
  }
  async read(id: string, version: number): Promise<Uint8Array> {
    const entry = this.entries.get(id);
    const content = entry?.versions.find((item) => item.version === version);
    if (!content) throw new ResourceReadError(id, `资源 ${id} 的版本 ${version} 不存在`, ProblemCodes.resourceVersionNotFound);
    let bytes: Uint8Array;
    try { bytes = new Uint8Array(await fs.readFile(await localFile(this.dir, content.file))); }
    catch (error) { throw new ResourceReadError(id, `资源 ${id} v${version} 无法读取：${describeError(error)}`); }
    if (bytes.length !== content.byteLength || hash(bytes) !== content.sha256) {
      throw new ResourceReadError(id, `资源 ${id} v${version} 完整性校验失败：${content.file}`, ProblemCodes.resourceIntegrityMismatch);
    }
    return bytes;
  }
  pin(versions?: ResourceVersionMap): PinnedResources {
    const selected = versions ?? Object.fromEntries(this.list().map((item) => [item.id, item.version]));
    const problems: Problem[] = [];
    if (!isRecord(selected)) return { problems: [severe(ProblemCodes.resourceVersionNotFound, { kind: 'input', source: 'resourceVersions' }, '资源版本映射必须是对象')] };
    const fixed = Object.create(null) as Record<string, number>;
    for (const [id, version] of Object.entries(selected)) {
      if (!positive(version) || !this.get(id, version)) problems.push(severe(ProblemCodes.resourceVersionNotFound,
        { kind: 'input', source: `resourceVersions.${id}` }, `资源 ${id} 的版本 ${version} 不存在`));
      else fixed[id] = version;
    }
    if (problems.length) return { problems };
    Object.freeze(fixed);
    return { versions: fixed, problems, repository: {
      get: (id) => Object.hasOwn(fixed, id) ? this.get(id, fixed[id]) : undefined,
      read: async (id) => {
        if (!Object.hasOwn(fixed, id)) throw new ResourceReadError(id, `固定版本映射中没有资源 ${id}`, ProblemCodes.resourceVersionNotFound);
        return this.read(id, fixed[id]!);
      },
    } };
  }
}

export async function openVersionedResourceStore(dir: string): Promise<{ store?: VersionedResourceStore; problems: Problem[] }> {
  try {
    const root = await fs.realpath(dir);
    return { store: new FileVersionedStore(root, await loadManifest(root)), problems: [] };
  } catch (error) {
    const issue = problem(error, join(dir, MANIFEST));
    if (!(error instanceof StoreError)) issue.code = ProblemCodes.inputUnreadable;
    return { problems: [issue] };
  }
}

/** 排他写事务。只清理本次成功创建的文件，清单发布后不回滚内容。 */
async function writeTransaction(dir: string, initialize: boolean,
  prepare: (root: string, write: (file: string, bytes: Uint8Array) => Promise<void>) => Promise<Manifest>,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const owned: string[] = [];
  let root = resolve(dir);
  let locked = false;
  let committed = false;
  let temporary: string | undefined;
  try {
    if (initialize) await fs.mkdir(root, { recursive: true });
    root = await fs.realpath(root);
    try { await fs.mkdir(join(root, LOCK)); locked = true; }
    catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') fail(join(root, LOCK), '资源仓库正在写入；稍后重试，勿删除活动写锁', ProblemCodes.resourceStoreBusy);
      throw error;
    }
    const write = async (file: string, bytes: Uint8Array) => {
      const path = join(root, file);
      const handle = await fs.open(path, 'wx');
      owned.push(path);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
    };
    const manifest = await prepare(root, write);
    const name = `.manifest-${randomUUID()}.tmp`;
    temporary = join(root, name);
    await write(name, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    // 初始化用 link 的不覆盖语义；导入在持锁期间原子替换整份清单。
    if (initialize) await fs.link(temporary, join(root, MANIFEST));
    else await fs.rename(temporary, join(root, MANIFEST));
    committed = true;
  } catch (error) { problems.push(problem(error, join(root, MANIFEST))); }
  finally {
    const cleanup = committed ? (temporary && owned.includes(temporary) ? [temporary] : []) : owned;
    for (const path of cleanup) {
      try { await fs.rm(path, { force: true }); }
      catch (error) { problems.push(hint(ProblemCodes.resourceWriteFailed, { kind: 'input', source: path }, `临时文件清理失败：${describeError(error)}`)); }
    }
    if (locked) {
      try { await fs.rmdir(join(root, LOCK)); }
      catch (error) { problems.push(hint(ProblemCodes.resourceWriteFailed, { kind: 'input', source: join(root, LOCK) }, `写锁清理失败：${describeError(error)}`)); }
    }
  }
  return problems;
}

/** 准备一个空的版本仓库；绝不覆盖已有清单。 */
export async function initializeResourceStore(dir: string): Promise<{ problems: Problem[] }> {
  return { problems: await writeTransaction(dir, true, async () => ({ format: FORMAT, resources: [] })) };
}

/** 把旧清单的全部资源作为 v1 导入；整批成功或整批不可见，源目录保持原样。 */
export async function importResources(options: { sourceDir: string; dir: string }): Promise<{ imported: readonly VersionedResourceInfo[]; problems: Problem[] }> {
  let imported: VersionedResourceInfo[] = [];
  const problems = await writeTransaction(options.dir, false, async (root, write) => {
    const manifest = await loadManifest(root);
    let sourceRoot: string;
    try { sourceRoot = await fs.realpath(options.sourceDir); }
    catch (error) { fail(options.sourceDir, `源仓库无法读取：${describeError(error)}`); }
    const sourcePath = join(sourceRoot, MANIFEST);
    let source: unknown;
    try { source = JSON.parse(await fs.readFile(await localFile(sourceRoot, MANIFEST), 'utf8')); }
    catch (error) { fail(sourcePath, `源清单无法读取：${describeError(error)}`); }
    if (!isRecord(source) || 'format' in source || !Array.isArray(source.resources)) fail(sourcePath, '导入源必须是旧版 resources 清单');
    const ids = new Set(manifest.resources.map((entry) => entry.id));
    for (const [i, item] of source.resources.entries()) {
      const where = `${sourcePath}#resources[${i + 1}]`;
      if (!isRecord(item) || !validId(item.id) || (item.kind !== 'image' && item.kind !== 'font') || typeof item.file !== 'string') fail(where, '源资源条目不合法');
      if (ids.has(item.id)) fail(`${sourcePath}#${item.id}`, `目标仓库已有资源 ${item.id}，不能导入覆盖`, ProblemCodes.inputDuplicate);
      ids.add(item.id);
    }
    const objects = join(root, 'objects');
    try { await fs.mkdir(objects); }
    catch (error) { if (!(isRecord(error) && error.code === 'EEXIST')) throw error; }
    if (!(await fs.lstat(objects)).isDirectory() || await fs.realpath(objects) !== objects) fail(objects, '内容目录必须是仓库内普通目录，不能是链接');
    for (const item of source.resources as { id: string; kind: 'image' | 'font'; file: string }[]) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await fs.readFile(await localFile(sourceRoot, item.file))); }
      catch (error) { fail(`${sourcePath}#${item.id}`, `资源 ${item.id} 无法导入：${describeError(error)}`, ProblemCodes.resourceUnreadable); }
      const content: ContentVersion = { version: 1, sha256: hash(bytes), byteLength: bytes.length, file: `objects/${randomUUID()}.bin` };
      await write(content.file, bytes);
      const entry: Entry = { id: item.id, kind: item.kind, currentVersion: 1, versions: [content] };
      manifest.resources.push(entry);
      imported.push(metadata(entry, content));
    }
    return manifest;
  });
  if (problems.some((issue) => issue.level === 'severe')) imported = [];
  return { imported, problems };
}
