/** 轮次的宿主持久记录。单文件原子发布状态及追加事件；拥有者永不按超时接管（ADR-0024）。 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { isRecord } from '../util.js';
import { canonical } from './diff.js';
import { AgentUsageError, exists, sha256 } from './round-files.js';
import { materialHashes } from './provenance.js';
import type { RoundInputs, RoundRecord } from './run.js';

const OWNER = 'execution-owner.json', STATE = 'execution.json', START = 'round-start.json';
const PHASES = ['preparing', 'executing', 'finalizing', 'completed'];
const STATUSES = ['running', 'completed', 'failed', 'stopped'];
export type ExecutionPhase = 'preparing' | 'executing' | 'finalizing' | 'completed';
export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'pendingRecovery';
interface Owner { readonly id: string; readonly host: string; readonly pid: number; readonly startedAt: string }
export interface RoundStart {
  readonly format: 'renderweave-round-start/1'; readonly task: RoundRecord['task']; readonly round: number;
  readonly startedAt: string; readonly inputs: RoundInputs; readonly inputIdentity: string;
  readonly files: Readonly<Record<string, string>>;
}
export interface ExecutionEvent {
  readonly sequence: number; readonly at: string; readonly phase: ExecutionPhase; readonly status: ExecutionStatus; readonly reason?: string;
}
interface ExecutionRecord {
  readonly format: 'renderweave-execution/1'; readonly owner: Owner; readonly phase: ExecutionPhase; readonly status: ExecutionStatus;
  readonly executorPid?: number; readonly executorExited?: boolean; readonly startSha256?: string; readonly recordSha256?: string;
  readonly events: readonly ExecutionEvent[];
}
export interface RoundExecution extends ExecutionRecord {
  readonly start?: RoundStart; readonly committed: boolean; readonly diagnostics: readonly string[];
}

/** 临时文件与目标在同目录；进程强退只能留下旧的完整版本或新的完整版本。 */
export async function writeAtomicJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx');
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  try {
    if (exclusive) await link(temporary, path);
    else await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** 同轮目录只允许首次创建者写入，已有/陈旧拥有者都必须另开轮次。 */
export async function claimExecution(dir: string, startedAt: string) {
  await mkdir(dir, { recursive: true });
  const owner: Owner = { id: randomUUID(), host: hostname(), pid: process.pid, startedAt };
  try { await writeAtomicJson(join(dir, OWNER), owner, true); }
  catch { throw new AgentUsageError(`轮次已有拥有者或无法确认拥有者，拒绝覆盖或接管：${dir}`); }
  let state: ExecutionRecord = { format: 'renderweave-execution/1', owner, phase: 'preparing', status: 'running', events: [] };
  const update = async (phase: ExecutionPhase, status: ExecutionStatus, reason?: string, extra: Partial<ExecutionRecord> = {}) => {
    const current = JSON.parse(await readFile(join(dir, OWNER), 'utf8')) as Owner;
    if (current.id !== owner.id) throw new AgentUsageError('轮次拥有者不匹配，拒绝继续写入');
    const event: ExecutionEvent = { sequence: state.events.length + 1, at: new Date().toISOString(), phase, status, ...(reason ? { reason } : {}) };
    state = { ...state, ...extra, phase, status, events: [...state.events, event] };
    await writeAtomicJson(join(dir, STATE), state);
  };
  await update('preparing', 'running');
  return {
    async initialize(value: Omit<RoundStart, 'format' | 'inputIdentity' | 'files'>) {
      const files = await materialHashes(join(dir, 'logs'), 'logs');
      const start: RoundStart = { format: 'renderweave-round-start/1', ...value, files, inputIdentity: sha256(canonical({ inputs: value.inputs, files })) };
      await writeAtomicJson(join(dir, START), start, true);
      await update('preparing', 'running', '固定输入已提交', { startSha256: sha256(await readFile(join(dir, START))) });
    },
    async executing(pid: number) { await update('executing', 'running', undefined, { executorPid: pid }); },
    async finalizing() { await update('finalizing', 'running', '执行器已退出，正在检查成果', { executorExited: true }); },
    async checked() { await update('finalizing', 'running', '成果检查已完成，等待最终记录提交'); },
    async finish(record: RoundRecord) {
      const stopped = record.run.stopped ? '硬额度耗尽' : record.run.endedBy === 'error_max_turns' ? '已达到轮数上限' : undefined;
      const status = stopped ? 'stopped' : record.run.error || record.run.exitCode !== 0 ? 'failed' : 'completed';
      await update('completed', status, stopped ?? (status === 'failed' ? '执行器失败，详见轮次日志' : '最终记录已提交'),
        { recordSha256: sha256(await readFile(join(dir, 'round.json'))) });
    },
    async fail() { await update(state.phase, 'failed', '宿主未完成提交，已有文件仅供诊断'); },
  };
}

function alive(pid: number, host: string): boolean | undefined {
  if (host !== hostname()) return undefined;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? false : undefined; }
}

/** 读取不改写历史；活 PID 只表示可能仍可写，不用它授权接管。 */
export async function readExecution(dir: string): Promise<{ execution?: RoundExecution; problems: Problem[] }> {
  if (!(await exists(join(dir, OWNER))) && !(await exists(join(dir, STATE))) && !(await exists(join(dir, START)))) {
    try { if (!JSON.parse(await readFile(join(dir, 'round.json'), 'utf8')).execution) return { problems: [] }; }
    catch { return { problems: [] }; }
  }
  const problems: Problem[] = [];
  const invalid = (file: string, message: string) => problems.push(severe(ProblemCodes.roundInvalid, { kind: 'input', source: join(dir, file) }, message));
  let state: ExecutionRecord;
  try {
    const value: unknown = JSON.parse(await readFile(join(dir, STATE), 'utf8'));
    if (!isRecord(value) || value.format !== 'renderweave-execution/1' || !isRecord(value.owner) || typeof value.owner.id !== 'string'
      || !Number.isSafeInteger(value.owner.pid) || Number(value.owner.pid) < 1 || typeof value.owner.host !== 'string' || typeof value.owner.startedAt !== 'string'
      || !Array.isArray(value.events) || value.events.length === 0 || !PHASES.includes(String(value.phase)) || !STATUSES.includes(String(value.status))) throw new Error('状态格式或拥有者身份不完整');
    if (value.events.some((event: unknown, index: number) => !isRecord(event) || event.sequence !== index + 1
      || typeof event.at !== 'string' || !PHASES.includes(String(event.phase)) || !STATUSES.includes(String(event.status)))
      || value.events.at(-1).phase !== value.phase || value.events.at(-1).status !== value.status
      || (value.recordSha256 && value.phase !== 'completed') || (value.phase === 'completed' && (!value.recordSha256 || value.status === 'running'))) throw new Error('事件历史或提交状态不完整');
    state = value as unknown as ExecutionRecord;
  } catch { invalid(STATE, '轮次状态缺失、损坏或身份不完整，拒绝使用残留成果'); return { problems }; }
  try {
    const owner: unknown = JSON.parse(await readFile(join(dir, OWNER), 'utf8'));
    if (!isRecord(owner) || canonical(owner) !== canonical(state.owner)) throw new Error('拥有者身份与状态记录不一致');
  } catch { invalid(OWNER, '拥有者缺失、损坏或身份与状态记录不一致，拒绝使用残留成果'); return { problems }; }
  let start: RoundStart | undefined;
  // 启动记录先于状态引用独占发布；两次发布之间强退时仍可读其自校验的输入事实。
  if (state.startSha256 || await exists(join(dir, START))) {
    try {
      const bytes = await readFile(join(dir, START));
      const value = JSON.parse(bytes.toString('utf8')) as RoundStart;
      if ((state.startSha256 && sha256(bytes) !== state.startSha256) || value.format !== 'renderweave-round-start/1' || !value.inputs
        || !isRecord(value.files) || value.inputIdentity !== sha256(canonical({ inputs: value.inputs, files: value.files }))) throw new Error('启动身份损坏');
      start = value;
    } catch { invalid(START, '固定输入记录缺失或内容身份不匹配'); }
  }
  let committed = false;
  if (state.recordSha256) {
    try { committed = sha256(await readFile(join(dir, 'round.json'))) === state.recordSha256; } catch { /* 诊断如下 */ }
    if (!committed) invalid('round.json', '最终记录缺失或与提交身份不符');
  }
  committed = committed && !!start && !!state.startSha256 && problems.length === 0;
  let status = state.status;
  const diagnostics: string[] = [];
  if (!committed) {
    diagnostics.push(start ? '最终记录尚未提交，没有可审核的正式成果；残留文件仅供诊断' : '固定输入尚未提交完整，没有可审核的正式成果');
    const hostAlive = alive(state.owner.pid, state.owner.host);
    if (state.status === 'running' && hostAlive !== true) {
      const executorAlive = state.executorExited ? false : state.executorPid ? alive(state.executorPid, state.owner.host) : undefined;
      status = hostAlive === false && executorAlive === false ? 'interrupted' : 'pendingRecovery';
      diagnostics.push(status === 'interrupted' ? '宿主已退出，本轮中断' : '宿主已退出或身份无法确认；执行器可能仍可写，禁止接管');
    }
  }
  return { execution: { ...state, status, ...(start ? { start } : {}), committed, diagnostics }, problems };
}
