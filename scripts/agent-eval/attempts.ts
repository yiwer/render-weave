/** 评估尝试原件与兼容阶段视图。实际执行只写唯一目录，已完成原件不再改写。 */
import {createHash, randomUUID} from 'node:crypto';
import {cp, link, mkdir, open, readdir, readFile, rename, rm, unlink} from 'node:fs/promises';
import {basename, join, relative, resolve} from 'node:path';
import {hostname} from 'node:os';
import {readReview} from '../../src/index.js';
import {withLocalAccess} from '../../src/local-access.js';
import type {Launcher, RoundSpec} from './eval.js';

export interface AttemptRecord {
  readonly format: 'renderweave-eval-attempt/1';
  readonly id: string;
  readonly stage: string;
  readonly task: RoundSpec['task'];
  readonly startedAt: string | null;
  readonly owner: {readonly host: string; readonly pid: number} | null;
  readonly experiment: string | null;
  readonly input: Omit<RoundSpec, 'out'>;
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
async function hashes(dir: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error(`尝试原件包含不能固定的链接：${prefix + entry.name}`);
    if (entry.name === '.write-lock' || !prefix && (['completed.json', 'completed.seal.json'].includes(entry.name) || /^\.metadata-.*\.tmp$/.test(entry.name))) continue;
    const name = prefix + entry.name, path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(path, name + '/'));
    else result[name] = sha(await readFile(path));
  }
  return result;
}
async function writeNew(file: string, value: unknown): Promise<void> {
  const temporary = join(resolve(file, '..'), '.metadata-' + randomUUID() + '.tmp');
  const handle = await open(temporary, 'wx');
  try {await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync();} finally {await handle.close();}
  try {await link(temporary, file);} finally {await unlink(temporary);}
}
async function startAttempt(unit: string, record: AttemptRecord): Promise<string> {
  const dir = join(unit, 'attempts', record.id), staging = join(unit, '.attempt-' + record.id);
  await mkdir(staging, {recursive: true});
  await writeNew(join(staging, 'started.json'), record);
  await mkdir(join(unit, 'attempts'), {recursive: true});
  await rename(staging, dir);
  return dir;
}
/** 封存先提交完整值，兼容记录随后发布；中途退出仍可从封存读取同一完成事实。摘要只用于内容完整性，不是认证。 */
async function completeAttempt(dir: string, completion: AttemptCompletion): Promise<void> {
  await writeNew(join(dir, 'completed.seal.json'), {completion, sha256: sha(JSON.stringify(completion))});
  await writeNew(join(dir, 'completed.json'), completion);
}
async function list(unit: string): Promise<SavedAttempt[]> {
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
    if (completion && JSON.stringify(completion.files) !== JSON.stringify(await hashes(dir))) throw new Error(`尝试原件已改变：${dir}`);
    result.push({record, completion, dir});
  }
  return result.sort((a, b) => (a.record.startedAt ?? '').localeCompare(b.record.startedAt ?? '') || a.record.id.localeCompare(b.record.id));
}
export async function savedAttempts(unit: string): Promise<SavedAttempt[]> {return list(unit);}

export async function evaluationTiming(outDir: string, attempts: readonly {elapsedMs: number | null}[]) {
  const directory = join(outDir, 'segments');
  const files = await readdir(directory).catch((error: NodeJS.ErrnoException) => {if (error.code === 'ENOENT') return []; throw error;});
  const starts = files.filter(file => file.endsWith('.started.json'));
  const intervals: [number, number][] = [];
  let incompleteSessions = 0;
  for (const file of starts) {
    const begin = await readJson<{startedAt: string}>(join(directory, file));
    const end = await readJson<{endedAt: string}>(join(directory, file.replace('.started.json', '.completed.json')));
    const a = Date.parse(begin?.startedAt ?? ''), b = Date.parse(end?.endedAt ?? '');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) incompleteSessions++;
    else intervals.push([a, b]);
  }
  let knownWallMs = 0, previousEnd = -Infinity;
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    knownWallMs += Math.max(0, end - Math.max(previousEnd, start)); previousEnd = Math.max(previousEnd, end);
  }
  return {sessions: starts.length, incompleteSessions, actualWallMs: starts.length && !incompleteSessions ? knownWallMs : null, knownWallMs,
    attemptsElapsedMs: attempts.reduce((total, attempt) => total + (attempt.elapsedMs ?? 0), 0), unknownAttemptDurations: attempts.filter(attempt => attempt.elapsedMs === null).length};
}

async function publish(attempt: SavedAttempt, stage: string): Promise<void> {
  const original = join(attempt.dir, 'round');
  try {await readdir(original);} catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error;}
  const unit = resolve(attempt.dir, '../..');
  // 只替换本单元的派生视图；原始尝试目录永不删除。
  if (resolve(stage, '..') !== unit || basename(stage) !== attempt.record.stage || !['definition', 'dataset', 'template', 'revision', 'feedback'].includes(basename(stage))) throw new Error('尝试阶段路径不合法');
  const next = join(unit, `.view-${randomUUID()}`), previous = join(unit, `.old-view-${randomUUID()}`);
  await cp(original, next, {recursive: true});
  await writeNew(join(next, '.attempt.json'), {id: attempt.record.id, source: relative(unit, attempt.dir).replaceAll('\\', '/')});
  let moved = false;
  try {await rename(stage, previous); moved = true;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
  await rename(next, stage);
  if (moved) await rm(previous, {recursive: true, force: true});
}

/** 先恢复已完成执行但尚未发布的阶段视图；未完成旧尝试仍保留，不补造终检。 */
export async function restoreAttempt(spec: RoundSpec, unit: string): Promise<void> {
  const attempts = (await list(unit)).filter(attempt => attempt.record.stage === basename(spec.out));
  for (const attempt of attempts) {
    if (attempt.completion || attempt.record.legacy) continue;
    const owner = attempt.record.owner;
    if (owner) {
      let alive = owner.host !== hostname();
      if (!alive) try {process.kill(owner.pid, 0); alive = true;} catch (error) {alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';}
      if (alive) throw new Error(`尝试拥有者仍存活或无法确认退出：${attempt.record.id}`);
    }
    const inspected = await readReview(join(attempt.dir, 'round'));
    const execution = inspected.execution;
    if (inspected.problems.length || !execution || !execution.committed && execution.status !== 'interrupted') {
      throw new Error(`旧尝试执行器尚可写或无法确认完成：${attempt.record.id}`);
    }
    const round = await readJson<{verdict?: string; run?: unknown}>(join(attempt.dir, 'round/round.json')).catch(() => undefined);
    const proof = await readJson<{experiment: string}>(join(attempt.dir, 'round/evaluation.json'));
    const eligible = execution.committed && !!round?.run && ['qualified', 'unqualified'].includes(round.verdict ?? '')
      && (!attempt.record.experiment || proof?.experiment === attempt.record.experiment);
    const completion: AttemptCompletion = {endedAt: null, elapsedMs: null, recovered: true, eligible,
      ...(!eligible ? {error: '原派发中断或缺少实验封存，不能作为有效观测；保留已知用量'} : {}), files: await hashes(attempt.dir)};
    await completeAttempt(attempt.dir, completion);
  }
  const completed = (await list(unit)).filter(attempt => attempt.record.stage === basename(spec.out) && attempt.completion && attempt.completion.eligible !== false).at(-1);
  if (!completed) return;
  const current = await readJson<{id: string}>(join(spec.out, '.attempt.json'));
  if (current?.id !== completed.record.id) await publish(completed, spec.out);
}

/** 调用方须在单元短锁内恢复、重核并预留；模型执行不占用短锁。 */
export async function prepareAttempt(spec: RoundSpec, unit: string): Promise<SavedAttempt> {
  if (resolve(spec.out, '..') !== resolve(unit)) throw new Error('尝试输出必须属于当前单元');
  const attempts = await list(unit);
  // 旧阶段仍保留可证的最后一次成果，不声称补齐已被旧运行器删除的重试历史。
  if (!attempts.some(attempt => attempt.record.stage === basename(spec.out))) {
    let exists = false;
    try {await readdir(spec.out); exists = true;} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    if (exists) {
      const id = randomUUID(), dir = join(unit, 'attempts', id), {out: _out, ...input} = spec;
      const record: AttemptRecord = {format: 'renderweave-eval-attempt/1', id, stage: basename(spec.out), task: spec.task,
        startedAt: null, owner: null, experiment: null, input, legacy: true};
      await startAttempt(unit, record);
      await cp(spec.out, join(dir, 'round'), {recursive: true});
      await completeAttempt(dir, {endedAt: null, elapsedMs: null, files: await hashes(dir)});
    }
  }
  const id = randomUUID(), dir = join(unit, 'attempts', id), started = Date.now(), {out: _out, ...input} = spec;
  const manifest = await readJson<{identity?: unknown}>(join(unit, '../../eval.json'));
  const record: AttemptRecord = {format: 'renderweave-eval-attempt/1', id, stage: basename(spec.out), task: spec.task,
    startedAt: new Date(started).toISOString(), owner: {host: hostname(), pid: process.pid}, experiment: manifest?.identity ? 'sha256:' + sha(JSON.stringify(manifest.identity)) : null, input};
  await startAttempt(unit, record);
  return {record, dir};
}

export async function executeAttempt(spec: RoundSpec, attempt: SavedAttempt, launch: Launcher): Promise<void> {
  const {record, dir} = attempt;
  let failure: unknown;
  try {await launch({...spec, out: join(dir, 'round')});} catch (error) {failure = error;}
  await withLocalAccess([resolve(dir, '../..')], async () => {
    const completion: AttemptCompletion = {endedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(record.startedAt!),
      ...(failure ? {error: failure instanceof Error ? failure.message : String(failure)} : {}), files: await hashes(dir)};
    await completeAttempt(dir, completion);
    await publish({record, completion, dir}, spec.out);
  });
  if (failure) throw failure;
}
