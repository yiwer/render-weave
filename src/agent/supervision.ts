/** 轻量监督边界只负责截止时间、信号和所属进程树；业务检查仍在轮次宿主中。 */
import { fork, spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AgentRunOptions, AgentRunResult, RoundRecord, RoundUsage } from './run.js';
import type { QuotaStop } from './quota.js';
import { AgentUsageError } from './round-files.js';
import { stoppedResult } from './stopped-round.js';
import type { StagnationStop } from './stagnation.js';

export const DEFAULT_ROUND_TIMEOUT_MS = 60 * 60 * 1000;
export const SAVE_GRACE_MS = 30 * 1000;
export type RoundStop = QuotaStop | StagnationStop | { readonly reason: 'timeout'; readonly roundTimeoutMs: number } | { readonly reason: 'cancelled' };
export interface PreparedRound { readonly roundDir: string; readonly record: Pick<RoundRecord, 'task' | 'round' | 'startedAt' | 'inputs' | 'runtime'> }
export interface HostControl { ready(value: PreparedRound): Promise<void>; stop(reason: RoundStop): void; usage(value: Omit<RoundUsage, 'wallMs'>): void }

export async function terminateOwnedTree(child: ChildProcess, requireLiveRoot = false): Promise<void> {
  if (!child.pid) return;
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (process.platform === 'win32' && requireLiveRoot && exited()) throw new Error('本轮宿主已异常退出，无法凭失效根 PID 确认所有后代已结束');
  if (process.platform === 'win32' && !exited()) await new Promise<void>((resolve, reject) => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const deadline = setTimeout(() => { killer.kill('SIGKILL'); reject(new Error('本轮进程树终止未获确认')); }, 5000);
    killer.once('error', error => { clearTimeout(deadline); reject(error); });
    killer.once('close', code => { clearTimeout(deadline); if (code === 0) resolve(); else reject(new Error(`本轮进程树终止失败：${code}`)); });
  });
  if (process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  if (!exited()) await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.off('close', closed); reject(new Error('本轮宿主退出未获确认')); }, 5000);
    const closed = () => { clearTimeout(deadline); resolve(); };
    child.once('close', closed);
  });
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
  const child = host();
  let prepared: PreparedRound | undefined, timer: ReturnType<typeof setTimeout> | undefined, started = 0, stopping = false;
  let errors = '', knownUsage: Omit<RoundUsage, 'wallMs'> = {};
  child.stderr!.on('data', bytes => { errors = (errors + String(bytes)).slice(-4000); });
  return new Promise<AgentRunResult>((resolve, reject) => {
    const cancel = () => { void stop({ reason: 'cancelled' }).catch(reject); };
    const close = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); };
    const finish = async (value: AgentRunResult) => { close(); stopping = true; await terminateOwnedTree(child); resolve(value); };
    const stop = async (reason: RoundStop) => {
      if (stopping) return;
      stopping = true; close(); const stopStarted = performance.now();
      await terminateOwnedTree(child, true);
      if (!prepared) { reject(new Error('轮次在固定输入完成前停止；仅保留准备诊断')); return; }
      const usage = { ...knownUsage, wallMs: Date.now() - started };
      const saver = host();
      let saved = false;
      const incomplete = async (detail: string) => { if (saved) return; saved = true; clearTimeout(grace); await terminateOwnedTree(saver); resolve(stoppedResult(prepared!, reason, usage, 'incomplete', detail)); };
      const grace = setTimeout(() => { void incomplete(`本地保存超过 ${SAVE_GRACE_MS} 毫秒，未完成；已有完整检查点仍保留`).catch(reject); }, Math.max(1, SAVE_GRACE_MS - (performance.now() - stopStarted)));
      saver.stderr!.resume();
      saver.on('error', error => { void incomplete(`本地保存未完成：${error.message}`).catch(reject); });
      saver.on('close', code => { void incomplete(`保存宿主提前退出（${String(code)}），本地保存未完成`).catch(reject); });
      saver.on('message', async (message: any) => {
        if (message.type === 'result' && !saved) { saved = true; clearTimeout(grace); try { await terminateOwnedTree(saver); resolve(message.value); } catch (error) { reject(error); } }
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
      if (message.type === 'start') options.onStart?.(message.roundDir);
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
        stopping = true; close(); void terminateOwnedTree(child).then(() => reject(message.usage ? new AgentUsageError(message.message) : new Error(message.message)), reject);
      }
    });
    options.signal?.addEventListener('abort', cancel, { once: true });
    const { onStart: _onStart, onBudget: _onBudget, signal: _signal, ...serializable } = options;
    child.send({ mode: 'run', options: serializable });
  });
}
