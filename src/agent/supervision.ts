/** 轻量监督边界只负责截止时间、信号和所属进程树；业务检查仍在轮次宿主中。 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentRunOptions, AgentRunResult, RoundRecord, RoundUsage } from './run.js';
import type { QuotaStop } from './quota.js';
import { AgentUsageError } from './round-files.js';
import { stoppedMessage, stoppedResult } from './stopped-round.js';
import type { StagnationStop } from './stagnation.js';
import { credentialRedactor } from './credential-redaction.js';
import { writeCleanupReceipt, type CleanupEvent } from './execution.js';

export const DEFAULT_ROUND_TIMEOUT_MS = 60 * 60 * 1000;
export const SAVE_GRACE_MS = 30 * 1000;
/** 进程树终止与宿主退出各自的确认期限。Windows 的 taskkill /T 空闲时就要 3.5–4 秒，负载高时更久。 */
export const TREE_CLEANUP_MS = 30 * 1000;
export type RoundStop = QuotaStop | StagnationStop | { readonly reason: 'timeout'; readonly roundTimeoutMs: number } | { readonly reason: 'cancelled' };
export interface PreparedRound { readonly roundDir: string; readonly record: Pick<RoundRecord, 'task' | 'round' | 'startedAt' | 'inputs' | 'runtime'> }
export interface HostControl { ready(value: PreparedRound): Promise<void>; stop(reason: RoundStop): void; usage(value: Omit<RoundUsage, 'wallMs'>): void }

/** 没能确认本轮进程树已全部结束。成果是否已提交，由调用方按所处的收尾步骤判断。 */
export class TreeCleanupError extends Error {
  constructor(readonly detail: string) { super(`本轮进程树清理未确认：${detail}`); }
}

export async function terminateOwnedTree(child: ChildProcess, requireLiveRoot = false): Promise<void> {
  if (!child.pid) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (process.platform === 'win32' && requireLiveRoot && exited()) throw new TreeCleanupError('本轮宿主已异常退出，无法凭失效根 PID 确认所有后代已结束');
  if (process.platform === 'win32' && !exited()) await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const deadline = setTimeout(() => { killer.kill('SIGKILL'); reject(new TreeCleanupError(`taskkill ${TREE_CLEANUP_MS} 毫秒内没有返回`)); }, TREE_CLEANUP_MS);
    killer.once('error', error => { clearTimeout(deadline); reject(new TreeCleanupError(`taskkill 无法启动：${error.message}`)); });
    killer.once('close', code => { clearTimeout(deadline); if (code === 0) resolve(); else reject(new TreeCleanupError(`taskkill 退出码 ${code}`)); });
  });
  if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  if (!exited()) await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.off('close', closed); reject(new TreeCleanupError(`宿主 ${TREE_CLEANUP_MS} 毫秒内没有退出`)); }, TREE_CLEANUP_MS);
    const closed = () => { clearTimeout(deadline); resolve(); };
    child.once('close', closed);
  });
}
/** 清理未确认时不再等这个子进程：断开 IPC 后宿主自行回收它的子树（run-worker），命令行可以退出。 */
function release(child: ChildProcess) {
  if (child.connected) child.disconnect();
  child.stderr?.destroy(); child.unref();
}
function host() {
  const source = import.meta.url.endsWith('.ts');
  return fork(fileURLToPath(new URL(source ? './run-worker.ts' : './run-worker.js', import.meta.url)), [], {
    execArgv: [...process.execArgv, ...(source ? ['--import', 'tsx'] : [])],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true, detached: process.platform !== 'win32',
  });
}
export async function superviseRound(options: AgentRunOptions): Promise<AgentRunResult> {
  const timeout = options.roundTimeoutMs ?? DEFAULT_ROUND_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new AgentUsageError('--timeout-ms 必须是有限正值');
  if (options.stagnationThreshold !== undefined && (!Number.isSafeInteger(options.stagnationThreshold) || options.stagnationThreshold < 1))
    throw new AgentUsageError('--stagnation-threshold 必须是正整数');
  if (options.maxTurns !== undefined && (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)) throw new AgentUsageError('--max-turns 必须是正整数');
  if (options.maxTokens !== undefined) throw new AgentUsageError('当前适配器不支持实时硬 token 限额；--max-tokens 不能执行');
  if (options.maxCostUsd !== undefined) throw new AgentUsageError('当前适配器不支持实时硬费用限额；--max-cost-usd 不能执行');
  if (options.signal?.aborted) throw new AgentUsageError('轮次开始前已取消');
  const safe = credentialRedactor([options.key]); const child = host();
  let prepared: PreparedRound | undefined, timer: ReturnType<typeof setTimeout> | undefined, started = 0, stopping = false;
  let errors = '', knownUsage: Omit<RoundUsage, 'wallMs'> = {};
  child.stderr!.pipe(safe.stream()).on('data', bytes => { errors = (errors + String(bytes)).slice(-4000); });
  let roundDir: string | undefined; const cleanupEvents: CleanupEvent[] = [];
  /** 终止并确认进程树。未确认时写清理回执、放开这个子进程并返回该错误；成果能否照常交回由调用方按收尾步骤决定。 */
  const cleanup = async (target: ChildProcess, after: CleanupEvent['after'], given: { requireLiveRoot?: boolean; stop?: RoundStop } = {}): Promise<TreeCleanupError | undefined> => {
    try { await terminateOwnedTree(target, given.requireLiveRoot); return undefined; }
    catch (error) {
      if (!(error instanceof TreeCleanupError)) throw error;
      release(target);
      if (roundDir) {
        cleanupEvents.push({ at: new Date().toISOString(), after, detail: error.message, ...(given.stop ? { stop: given.stop } : {}) });
        await writeCleanupReceipt(roundDir, cleanupEvents);
      }
      return error;
    }
  };
  const warned = (value: AgentRunResult, error: TreeCleanupError | undefined): AgentRunResult => error ? { ...value, cleanup: { confirmed: false, detail: error.message } } : value;
  return new Promise<AgentRunResult>((resolve, reject) => {
    const cancel = () => { void stop({ reason: 'cancelled' }).catch(reject); };
    const close = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
    // 宿主发结果前已提交最终记录；进程树清理未确认只影响后代，成果照常交回并带告警。
    const finish = async (value: AgentRunResult) => { close(); stopping = true; resolve(warned(value, await cleanup(child, 'result'))); };
    const stop = async (reason: RoundStop) => {
      if (stopping) return;
      stopping = true; close(); const stopStarted = performance.now();
      const unconfirmed = await cleanup(child, 'stop', { requireLiveRoot: true, stop: reason });
      // 不能确认原宿主及其后代已结束时，保存进程不能代它提交停止结果。
      if (unconfirmed) { reject(new TreeCleanupError(`${unconfirmed.detail}；${stoppedMessage(reason)}，未能保存停止结果`)); return; }
      if (!prepared) { reject(new Error('轮次在固定输入完成前停止；仅保留准备诊断')); return; }
      const usage = { ...knownUsage, wallMs: Date.now() - started };
      const saver = host();
      let saved = false;
      const incomplete = async (detail: string) => {
        if (saved) return; saved = true; clearTimeout(grace);
        resolve(warned(stoppedResult(prepared!, reason, usage, 'incomplete', safe.text(detail)), await cleanup(saver, 'save')));
      };
      const grace = setTimeout(() => { void incomplete(`本地保存超过 ${SAVE_GRACE_MS} 毫秒，未完成；已有完整检查点仍保留`).catch(reject); }, Math.max(1, SAVE_GRACE_MS - (performance.now() - stopStarted)));
      saver.stderr!.resume();
      saver.on('error', error => { void incomplete(`本地保存未完成：${error.message}`).catch(reject); });
      saver.on('close', code => { void incomplete(`保存宿主提前退出（${String(code)}），本地保存未完成`).catch(reject); });
      saver.on('message', async (message: any) => {
        if (message.type === 'result' && !saved) { saved = true; clearTimeout(grace); try { resolve(warned(message.value, await cleanup(saver, 'save'))); } catch (error) { reject(error); } }
        if (message.type === 'error') void incomplete(`本地保存未完成：${message.message}`).catch(reject);
      });
      saver.send({ mode: 'save', prepared, reason, ownerPid: child.pid, usage });
    };
    child.on('error', error => { close(); reject(error); });
    child.on('close', code => { if (!stopping) {
      close(); stopping = true;
      // Linux 进程组在组长死亡后仍可定向终止；Windows 不凭已失效根 PID 猜测后代。
      const failure = new Error(`轮次宿主提前退出（${String(code)}）；已有记录仅供诊断，后代可写性须按执行状态核对：${errors.slice(-1000)}`);
      void terminateOwnedTree(child).then(() => reject(failure), () => reject(failure));
    } });
    child.on('message', (message: any) => {
      if (message.type === 'usage') knownUsage = message.value;
      if (message.type === 'start') { roundDir = message.roundDir; options.onStart?.(message.roundDir); }
      if (message.type === 'ready') {
        if (stopping) return;
        options.onBudget?.(message.value.record.runtime);
        prepared = message.value; started = Date.now(); const clockStart = performance.now();
        const deadline = () => {
          const remaining = timeout - (performance.now() - clockStart);
          if (remaining > 0) timer = setTimeout(deadline, Math.min(remaining, 2147483647));
          else void stop({ reason: 'timeout', roundTimeoutMs: timeout }).catch(reject);
        };
        deadline();
        child.send({ type: 'ready' });
      }
      if (message.type === 'stop') void stop(message.reason).catch(reject);
      if (message.type === 'result' && !stopping) void finish(message.value).catch(reject);
      if (message.type === 'error' && !stopping) {
        stopping = true; close();
        const failure = message.usage ? new AgentUsageError(safe.text(message.message)) : new Error(safe.text(message.message));
        // 清理未确认只记回执；报出的仍是宿主的原始错误，不被清理结果遮住。
        void cleanup(child, 'error').then(() => reject(failure), () => reject(failure));
      }
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    const { onStart: _onStart, onBudget: _onBudget, signal: _signal, ...serializable } = options;
    child.send({ mode: 'run', options: serializable });
  });
}
