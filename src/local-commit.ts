/** 应用提交的持久意图。调用方已持有全部参与目录的 local-access 约束。 */
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isRecord } from './util.js';
import { isDeepStrictEqual } from 'node:util';

const POINTER = '.apply-pending';
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
export const localPath = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
type Bytes = { readonly bytes: string; readonly sha256: string };
type Change = { readonly path: string; readonly before: Bytes | null; readonly after: Bytes };
interface Intent {
  readonly format: 'renderweave-apply-intent/1'; readonly id: string; readonly contentIdentity: string;
  readonly workspace: string; readonly round: string; readonly files: readonly Change[];
  readonly baseline: Readonly<Record<string, string>>;
  readonly guards: Readonly<Record<string, string>>;
}
export class LocalRecoveryRequired extends Error {
  constructor(readonly directory: string, readonly conflicts: readonly string[], detail?: string) {
    super(`应用提交需要恢复，尚未提供完整状态：${directory}；${detail ?? `检测到外部新修改：${conflicts.join('、')}`}。保留提交意图和现有内容；处理冲突后重试公开读取或应用，勿删除恢复记录`);
  }
}
async function bytesOrNull(path: string): Promise<Buffer | null> {
  try { return await readFile(path); } catch (error) { if (isRecord(error) && error.code === 'ENOENT') return null; throw error; }
}
function pack(bytes: Uint8Array): Bytes { return { bytes: Buffer.from(bytes).toString('base64'), sha256: digest(bytes) }; }
function unpack(value: Bytes): Buffer {
  const bytes = Buffer.from(value.bytes, 'base64');
  if (digest(bytes) !== value.sha256) throw new Error('恢复字节与记录哈希不一致');
  return bytes;
}
async function durableFile(path: string, bytes: Uint8Array | string) {
  const handle = await open(path, 'wx');
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
/** 写完整临时字节再发布；创建用 hard link 保持排他性，不产生可见的空文件。 */
async function publish(path: string, bytes: Uint8Array | string, create: boolean) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await durableFile(temporary, bytes);
  try { if (create) await link(temporary, path); else await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
async function pointer(root: string): Promise<{ journal: string; sha256: string } | undefined> {
  const bytes = await bytesOrNull(join(root, POINTER)); if (!bytes) return undefined;
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || typeof value.journal !== 'string' || typeof value.sha256 !== 'string') throw new Error('提交指针无效');
  return { journal: value.journal, sha256: value.sha256 };
}
async function pending(root: string): Promise<{ journal: string; intent: Intent } | undefined> {
  try {
    const ref = await pointer(root); if (!ref) return undefined;
    const bytes = await readFile(ref.journal);
    if (digest(bytes) !== ref.sha256) throw new Error('提交意图哈希不一致');
    const intent = JSON.parse(bytes.toString('utf8')) as Intent;
    if (intent.format !== 'renderweave-apply-intent/1' || !Array.isArray(intent.files) ||
      ![intent.workspace, intent.round].some(path => localPath(path) === localPath(root)) ||
      localPath(ref.journal) !== localPath(join(intent.round, '.apply-transactions', intent.id, 'intent.json'))) throw new Error('提交意图位置或格式无效');
    for (const file of intent.files) {
      if (![intent.workspace, intent.round].some(path => localPath(path) === localPath(dirname(file.path)))) throw new Error('提交目标超出参与目录');
      unpack(file.after); if (file.before) unpack(file.before);
    }
    return { journal: ref.journal, intent };
  } catch (error) { throw new LocalRecoveryRequired(root, [], String(error)); }
}

/** 在取得约束前发现全部参与目录；取得后必须再次发现，消除发现与锁定之间的变化。 */
export async function commitDirectories(roots: readonly string[]): Promise<string[]> {
  const directories = new Set(roots);
  for (const root of directories) {
    const item = await pending(root);
    if (item) { directories.add(localPath(item.intent.workspace)); directories.add(localPath(item.intent.round)); }
  }
  return [...directories].sort();
}
export async function recoverCommits(roots: readonly string[]): Promise<void> {
  const seen = new Set<string>();
  for (const root of roots) {
    const item = await pending(root); if (!item || seen.has(item.journal)) continue;
    seen.add(item.journal); await finish(item.journal, item.intent);
  }
}
async function workspaceState(dir: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const file of (await readdir(dir)).filter(name => name.endsWith('.json')).sort()) state[file] = digest(await readFile(join(dir, file)));
  return state;
}
async function finish(journal: string, intent: Intent): Promise<void> {
  const completed = join(dirname(journal), 'committed');
  const journalHash = digest(await readFile(journal)), receipt = await bytesOrNull(completed);
  if (receipt && receipt.toString('utf8') !== `${journalHash}\n`) throw new LocalRecoveryRequired(intent.workspace, [], '完成凭据与提交意图不一致');
  if (!receipt) {
    for (const root of [intent.workspace, intent.round]) {
      const ref = await pointer(root);
      if (!ref) await publish(join(root, POINTER), JSON.stringify({ journal, sha256: journalHash }), true);
      else if (localPath(ref.journal) !== localPath(journal) || ref.sha256 !== journalHash) throw new LocalRecoveryRequired(root, [], '参与目录已有另一份未完成提交');
    }
    const conflicts: string[] = [], state = await workspaceState(intent.workspace);
    const changes = new Map(intent.files.filter(f => localPath(dirname(f.path)) === localPath(intent.workspace)).map(f => [basename(f.path), f]));
    for (const name of new Set([...Object.keys(intent.baseline), ...Object.keys(state)])) {
      if (changes.has(name)) continue;
      if (state[name] !== intent.baseline[name]) conflicts.push(join(intent.workspace, name));
    }
    for (const [path, expected] of Object.entries(intent.guards)) {
      const bytes = await bytesOrNull(path); if (!bytes || digest(bytes) !== expected) conflicts.push(path);
    }
    for (const file of intent.files) {
      const bytes = await bytesOrNull(file.path), actual = bytes && digest(bytes);
      if (actual !== (file.before?.sha256 ?? null) && actual !== file.after.sha256) conflicts.push(file.path);
    }
    if (conflicts.length) throw new LocalRecoveryRequired(intent.workspace, conflicts);
    try {
      for (const file of intent.files) {
        const bytes = await bytesOrNull(file.path), actual = bytes && digest(bytes);
        if (actual === file.after.sha256) continue;
        if (actual !== (file.before?.sha256 ?? null)) throw new LocalRecoveryRequired(intent.workspace, [file.path]);
        await publish(file.path, unpack(file.after), file.before === null);
      }
      await publish(completed, `${journalHash}\n`, true);
    } catch (error) {
      if (error instanceof LocalRecoveryRequired) throw error;
      throw new LocalRecoveryRequired(intent.workspace, [], `提交未完成：${String(error)}`);
    }
  }
  // 成功标记先持久化。清理中断时只清理相同指针，绝不重写已完成之后的新内容。
  for (const root of [intent.workspace, intent.round]) {
    const ref = await pointer(root);
    if (ref && localPath(ref.journal) === localPath(journal)) await rm(join(root, POINTER));
  }
}

/** 新成功记录必须有对应的不可变意图及完成凭据；旧记录不补造新凭据。 */
export async function verifyApplicationReceipt(round: string, value: unknown): Promise<void> {
  if (!isRecord(value) || typeof value.workspace !== 'string' || typeof value.appliedAt !== 'string' || !Array.isArray(value.published) ||
    !isRecord(value.fingerprints) || typeof value.overwrite !== 'boolean') throw new Error('应用记录结构无效');
  if (value.format === 'renderweave-applied/1') return;
  if (value.format !== 'renderweave-applied/2' || typeof value.commitId !== 'string' || !/^[\da-f-]{36}$/.test(value.commitId)) throw new Error('应用提交标识无效');
  const directory = join(round, '.apply-transactions', value.commitId), bytes = await readFile(join(directory, 'intent.json'));
  if ((await readFile(join(directory, 'committed'), 'utf8')) !== `${digest(bytes)}\n`) throw new Error('应用完成凭据无法核对');
  const intent = JSON.parse(bytes.toString('utf8')) as Intent;
  const currentRound = await realpath(round);
  if (localPath(intent.round) !== localPath(currentRound)) throw new Error('应用凭据属于另一轮次');
  for (const name of ['review.json', 'round.json', 'outcome.json']) {
    const path = join(currentRound, name);
    if (intent.guards[path] !== digest(await readFile(path))) throw new Error(`应用凭据与当前轮次依据不一致：${name}`);
  }
  const result = intent.files.find(file => localPath(file.path) === localPath(join(intent.round, 'applied.json')));
  if (intent.id !== value.commitId || intent.contentIdentity !== value.contentIdentity || !result ||
    !isDeepStrictEqual(JSON.parse(unpack(result.after).toString('utf8')), value)) throw new Error('应用结果与提交意图不一致');
}

export async function commitApplication(options: {
  readonly id: string; readonly contentIdentity: string; readonly workspace: string; readonly round: string;
  readonly files: readonly { path: string; value: unknown; mode: 'create' | 'replace' }[];
}): Promise<void> {
  options = { ...options, workspace: await realpath(options.workspace), round: await realpath(options.round),
    files: await Promise.all(options.files.map(async file => ({ ...file, path: join(await realpath(dirname(file.path)), basename(file.path)) }))) };
  const changes: Change[] = [];
  for (const file of options.files) {
    const before = await bytesOrNull(file.path);
    if ((file.mode === 'create' && before !== null) || (file.mode === 'replace' && before === null)) throw new Error(`提交目标状态变化：${file.path}`);
    changes.push({ path: file.path, before: before && pack(before), after: pack(Buffer.from(`${JSON.stringify(file.value, null, 2)}\n`)) });
  }
  const guards: Record<string, string> = {};
  for (const name of ['review.json', 'round.json', 'outcome.json']) { const path = join(options.round, name); guards[path] = digest(await readFile(path)); }
  const intent: Intent = { format: 'renderweave-apply-intent/1', id: options.id, contentIdentity: options.contentIdentity,
    workspace: options.workspace, round: options.round, files: changes, baseline: await workspaceState(options.workspace), guards };
  const directory = join(options.round, '.apply-transactions', options.id), journal = join(directory, 'intent.json');
  await mkdir(directory, { recursive: true });
  const bytes = `${JSON.stringify(intent, null, 2)}\n`;
  await durableFile(journal, bytes);
  const ref = JSON.stringify({ journal, sha256: digest(bytes) });
  // 所有参与者都有指针之后才开始改业务文件。准备期间强退时仍是完整旧状态。
  for (const root of [options.workspace, options.round]) await publish(join(root, POINTER), ref, true);
  await finish(journal, intent);
}
