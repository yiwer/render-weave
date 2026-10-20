/**
 * 渲染 worker 的调度（ADR-0017）：从队列领取任务，交给渲染器，再把结果写回队列。一次只做一项。
 * 渲染器有两种：进程内（内存后端的快速测试用）与渲染子进程（child-runner.ts，生产与 Docker 后端测试用）。
 */
import type { ClaimedTask, ServiceBackend, TaskResult } from '../backend.js';
import type { Logger } from '../log.js';
import { renderPreview } from '../preview.js';

/** 渲染器的计数，经 worker 的健康检查可见。 */
export interface RunnerStats {
  /** 已结束的任务数，含超时与失败。 */
  tasks: number;
  timeouts: number;
  memoryKills: number;
  crashes: number;
  /** 渲染子进程换新的次数（超时、内存超限、崩溃或做满项数）。 */
  restarts: number;
}

export interface Runner {
  /** 渲染一项；超时、内存超限与崩溃都变成结果里的问题，不抛错。 */
  run(task: ClaimedTask): Promise<TaskResult>;
  close(): Promise<void>;
  readonly stats: RunnerStats;
}

export const emptyStats = (): RunnerStats => ({ tasks: 0, timeouts: 0, memoryKills: 0, crashes: 0, restarts: 0 });

/** worker 的问题码（票据 06）：本项没有渲染完，原因在 worker 一侧。 */
export const WorkerProblemCodes = {
  timeout: 'worker.timeout',
  memoryExceeded: 'worker.memoryExceeded',
  crashed: 'worker.crashed',
  failed: 'worker.failed',
} as const;

export const workerProblem = (code: (typeof WorkerProblemCodes)[keyof typeof WorkerProblemCodes], message: string): TaskResult =>
  ({ problems: [{ level: 'severe', code, location: { kind: 'input', source: 'render' }, message }] });

/** 渲染时抛出的异常（例如读不到存储）：本项失败。 */
export const failedResult = (error: unknown): TaskResult =>
  workerProblem(WorkerProblemCodes.failed, `渲染失败：${error instanceof Error ? error.message : String(error)}`);

/** 进程内渲染：内存后端的快速测试用；打断不了同步绘制，所以没有超时。 */
export function inProcessRunner(backend: ServiceBackend): Runner {
  const stats = emptyStats();
  return {
    stats,
    async run(task) {
      try { return await renderPreview(backend.tenant(task.tenantId).storage, task.request); }
      catch (error) { return failedResult(error); }
      finally { stats.tasks++; }
    },
    async close() {},
  };
}

export interface Scheduler {
  stop(): Promise<void>;
  readonly stats: RunnerStats;
}

/** 循环领取任务；队列空时每隔 pollMs 再看。stop 等正在做的那一项做完。 */
export function startScheduler(options: { readonly backend: ServiceBackend; readonly runner: Runner; readonly logger: Logger; readonly pollMs: number; readonly workerId: string }): Scheduler {
  const { backend, runner, logger, pollMs, workerId } = options;
  let stopped = false;
  let wake: (() => void) | undefined;
  const sleep = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, pollMs);
    wake = () => { clearTimeout(timer); resolve(); };
  });
  const loop = (async () => {
    while (!stopped) {
      let task: ClaimedTask | undefined;
      try { task = await backend.queue.claim(workerId, new Date()); }
      catch (error) { logger.error({ err: error }, '领取任务失败'); }
      if (!task) { await sleep(); continue; }
      const started = Date.now();
      const result = await runner.run(task);
      try {
        await backend.queue.finish(task, result, new Date());
        logger.info({ taskId: task.id, tenantId: task.tenantId, kind: task.kind, ms: Date.now() - started, problems: result.problems.length, image: Boolean(result.image) }, '任务完成');
      } catch (error) { logger.error({ err: error, taskId: task.id }, '写回任务结果失败'); }
    }
  })();
  return {
    stats: runner.stats,
    async stop() {
      stopped = true;
      wake?.();
      await loop;
      await runner.close();
    },
  };
}
