/** 唯一尝试的只读完整性核对，评估与订单共用；哈希不是认证。 */
import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentTaskId} from './tasks.js';
export interface AttemptRecord {
  readonly format: 'renderweave-eval-attempt/1';
  readonly id: string;
  readonly stage: string;
  readonly task: AgentTaskId;
  readonly startedAt: string | null;
  readonly owner: {readonly host: string; readonly pid: number} | null;
  readonly experiment: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly legacy?: true;
}
export interface AttemptCompletion {
  readonly endedAt: string | null;
  readonly elapsedMs: number | null;
  readonly error?: string;
  readonly recovered?: true;
  readonly eligible?: boolean;
  readonly files: Readonly<Record<string, string>>;
}
export interface SavedAttempt {
  readonly record: AttemptRecord;
  readonly completion?: AttemptCompletion;
  readonly dir: string;
}
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
async function readJson<T>(file: string): Promise<T | undefined> {
  try {return JSON.parse(await readFile(file, 'utf8')) as T;} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`尝试记录无法核对：${file}`, {cause: error});
  }
}
export async function attemptFileHashes(dir: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`尝试原件包含不能固定的链接：${prefix + entry.name}`);
    // 与资料身份共用协调目录口径；进入前排除初始化、释放和回收残留，普通同前缀文件仍需核对。
    if (entry.isDirectory() && /^\.write-(?:lock|released|abandoned)(?:-|$)/.test(entry.name)) continue;
    if (!prefix && (['completed.json', 'completed.seal.json'].includes(entry.name) || /^\.metadata-.*\.tmp$/.test(entry.name))) continue;
    const name = prefix + entry.name, path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await attemptFileHashes(path, name + '/'));
    else result[name] = sha(await readFile(path));
  }
  return result;
}
export async function readSavedAttempts(unit: string): Promise<SavedAttempt[]> {
  const directory = join(unit, 'attempts');
  let ids: string[];
  try {ids = await readdir(directory);} catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: SavedAttempt[] = [];
  for (const id of ids.sort()) {
    const dir = join(directory, id), record = await readJson<AttemptRecord>(join(dir, 'started.json'));
    if (!record || record.id !== id || record.format !== 'renderweave-eval-attempt/1') throw new Error(`尝试身份损坏：${dir}`);
    const compatibility = await readJson<AttemptCompletion>(join(dir, 'completed.json'));
    const seal = await readJson<{completion: AttemptCompletion; sha256: string}>(join(dir, 'completed.seal.json'));
    if ((compatibility && !seal) || (seal && (!seal.completion || sha(JSON.stringify(seal.completion)) !== seal.sha256
      || (compatibility && sha(JSON.stringify(compatibility)) !== seal.sha256)))) throw new Error(`尝试完成记录已改变：${dir}`);
    const completion = seal?.completion;
    if (completion && JSON.stringify(completion.files) !== JSON.stringify(await attemptFileHashes(dir))) throw new Error(`尝试原件已改变：${dir}`);
    result.push({record, completion, dir});
  }
  return result.sort((a, b) => (a.record.startedAt ?? '').localeCompare(b.record.startedAt ?? '') || a.record.id.localeCompare(b.record.id));
}
