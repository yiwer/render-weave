/**
 * 渲染子进程（ADR-0017）：调度进程 fork 一个子进程，经 IPC 一次交给它一项。
 * - 单项超时：调度进程结束子进程，本项失败；
 * - 内存超限：容器的内存上限结束子进程（子进程把 oom_score_adj 调到最高，内核先选它），本项失败；
 *   是否是内存超限看本容器 cgroup 的 memory.events 里 oom_kill 有没有增加；
 * - 批次取消（票据 07）：调度进程中止 signal 时结束子进程，本项答 cancelled；
 * - 子进程在任务之间复用，做满 recycleAfter 项、超时、内存超限、取消或崩溃后换新；换下后立即起一个新的预热。
 */
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { ClaimedTask, ItemResult, ReplayResult, TaskResult } from '../backend.js';
import type { Logger } from '../log.js';
import { emptyStats, workerProblem, WorkerProblemCodes, type Runner } from './scheduler.js';

export interface ChildRunnerOptions {
  /** 子进程脚本（render-child.js）。 */
  readonly script: string;
  readonly timeoutMs: number;
  readonly recycleAfter: number;
  readonly logger: Logger;
  /** cgroup v2 的内存事件文件；读不到时内存超限记为崩溃。 */
  readonly memoryEvents?: string;
}

interface Child {
  readonly process: ChildProcess;
  readonly ready: Promise<void>;
  tasks: number;
}

type Outcome = { result: TaskResult | ItemResult | ReplayResult } | { timeout: true } | { cancelled: true } | { exit: { code: number | null; signal: NodeJS.Signals | null } };

export function childRunner(options: ChildRunnerOptions): Runner {
  const { script, timeoutMs, recycleAfter, logger, memoryEvents = '/sys/fs/cgroup/memory.events' } = options;
  const stats = emptyStats();
  let child: Child | undefined;
  let closed = false;

  const spawn = (): Child => {
    const process = fork(script, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: { type?: string }) => {
        if (message?.type !== 'ready') return;
        process.off('message', onMessage);
        resolve();
      };
      process.on('message', onMessage);
      process.once('exit', (code, signal) => reject(new Error(`渲染子进程没能启动（退出码 ${code}，信号 ${signal}）`)));
    });
    ready.catch(() => undefined);
    return (child = { process, ready, tasks: 0 });
  };

  /** 换下一个子进程：还活着就结束它，再起一个新的预热。 */
  const retire = async (current: Child, reason: string) => {
    if (child === current) child = undefined;
    if (current.process.exitCode === null && current.process.signalCode === null) {
      const exited = once(current.process, 'exit');
      current.process.kill('SIGKILL');
      await exited;
    }
    stats.restarts++;
    logger.info({ reason, tasks: current.tasks }, '渲染子进程换新');
    if (!closed) spawn();
  };

  const oomKills = async (): Promise<number | undefined> => {
    try { return Number(/^oom_kill (\d+)$/m.exec(await readFile(memoryEvents, 'utf8'))?.[1]); }
    catch { return undefined; }
  };

  const dispatch = (current: Child, task: ClaimedTask, signal?: AbortSignal) => new Promise<Outcome>((resolve) => {
    const { process } = current;
    const onMessage = (message: { type?: string; id?: string; result?: TaskResult | ItemResult | ReplayResult }) => {
      if (message?.type === 'result' && message.id === task.id) done({ result: message.result! });
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => done({ exit: { code, signal } });
    const onAbort = () => done({ cancelled: true });
    const timer = setTimeout(() => done({ timeout: true }), timeoutMs);
    const done = (outcome: Outcome) => {
      clearTimeout(timer);
      process.off('message', onMessage);
      process.off('exit', onExit);
      signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    process.on('message', onMessage);
    process.once('exit', onExit);
    signal?.addEventListener('abort', onAbort, { once: true });
    process.send({ type: 'task', task });
    if (signal?.aborted) onAbort();
  });

  spawn();
  return {
    stats,
    async run(task, signal) {
      const current = child ?? spawn();
      try {
        await current.ready;
      } catch (error) {
        stats.tasks++;
        stats.crashes++;
        await retire(current, 'startFailed');
        return workerProblem(WorkerProblemCodes.crashed, (error as Error).message);
      }
      const before = await oomKills();
      const outcome = await dispatch(current, task, signal);
      stats.tasks++;
      if ('result' in outcome) {
        current.tasks++;
        if (current.tasks >= recycleAfter) await retire(current, 'recycle');
        return outcome.result;
      }
      await retire(current, 'timeout' in outcome ? 'timeout' : 'cancelled' in outcome ? 'cancel' : 'exit');
      if ('cancelled' in outcome) {
        stats.cancels++;
        logger.info({ taskId: task.id, tenantId: task.tenantId }, '批次已取消，结束正在渲染的一项');
        return { cancelled: true };
      }
      if ('timeout' in outcome) {
        stats.timeouts++;
        logger.warn({ taskId: task.id, tenantId: task.tenantId, timeoutMs }, '渲染超时，已结束子进程');
        return workerProblem(WorkerProblemCodes.timeout, `渲染超过 ${timeoutMs} ms 的单项时限，已结束；本项没有出图`);
      }
      const after = await oomKills();
      if (before !== undefined && after !== undefined && after > before) {
        stats.memoryKills++;
        logger.warn({ taskId: task.id, tenantId: task.tenantId }, '渲染超出内存上限，子进程被结束');
        return workerProblem(WorkerProblemCodes.memoryExceeded, '渲染超出 worker 的内存上限，子进程被结束；本项没有出图');
      }
      stats.crashes++;
      logger.warn({ taskId: task.id, tenantId: task.tenantId, ...outcome.exit }, '渲染子进程意外退出');
      return workerProblem(WorkerProblemCodes.crashed, `渲染子进程意外退出（退出码 ${outcome.exit.code}，信号 ${outcome.exit.signal}）；本项没有出图`);
    },
    async close() {
      closed = true;
      if (child) await retire(child, 'close');
    },
  };
}
