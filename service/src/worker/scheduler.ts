/**
 * 渲染 worker 的调度（ADR-0017）：从队列领取任务，交给渲染器，再把结果写回队列。一次只做一项。
 * 渲染器有两种：进程内（内存后端的快速测试用）与渲染子进程（child-runner.ts，生产与 Docker 后端测试用）。
 *
 * 批次项（票据 07）另有几条：
 * - 只领自己构建的批次项（预览哪个构建都可以领）；停止时不再领预览，做完本构建排队的批次项再退出；
 * - 渲染中定期查看批次是否已取消，取消了就结束正在渲染的一项，标为未执行；
 * - 没渲染完（超时、内存超限、崩溃）的项写问题清单，标为失败；这一项已登记时以登记的为准；
 * - 领取有租约，worker 中途退出时同构建的 worker 过了租约重领；领了 MAX_ATTEMPTS 次仍没做完记失败。
 */
import type { BatchItemTask, ClaimedTask, ItemResult, ServiceBackend, TaskResult } from '../backend.js';
import { committedItem, KILLED, NOT_STARTED, notRunItem } from '../batches.js';
import { itemDeliverer } from '../delivery.js';
import { manifestBytes } from '../engine.js';
import type { Logger } from '../log.js';
import { renderPreview } from '../preview.js';

/** 渲染器的计数，经 worker 的健康检查可见。 */
export interface RunnerStats {
  /** 已结束的任务数，含超时与失败。 */
  tasks: number;
  timeouts: number;
  memoryKills: number;
  crashes: number;
  /** 批次取消时结束正在渲染的一项的次数。 */
  cancels: number;
  /** 渲染子进程换新的次数（超时、内存超限、崩溃、取消或做满项数）。 */
  restarts: number;
}

/** 渲染器的结果：预览的结果、批次项的结果，或取消时被结束。 */
export type RunOutcome = TaskResult | ItemResult | { readonly cancelled: true };

export interface Runner {
  /** 做一项；超时、内存超限与崩溃都变成结果里的问题，不抛错。signal 中止时能结束的渲染器结束正在做的一项，答 cancelled。 */
  run(task: ClaimedTask, signal?: AbortSignal): Promise<RunOutcome>;
  close(): Promise<void>;
  readonly stats: RunnerStats;
}

export const emptyStats = (): RunnerStats => ({ tasks: 0, timeouts: 0, memoryKills: 0, crashes: 0, cancels: 0, restarts: 0 });

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

/** 一项最多领取几次：每次都过了租约没写回（worker 中途退出），再领到就记失败。 */
export const MAX_ATTEMPTS = 3;

/** 进程内渲染：内存后端的快速测试用；打断不了同步绘制，所以没有超时，取消对正在做的一项也不生效。 */
export function inProcessRunner(backend: ServiceBackend): Runner {
  const stats = emptyStats(), deliver = itemDeliverer();
  return {
    stats,
    async run(task) {
      const storage = backend.tenant(task.tenantId).storage;
      try { return task.kind === 'preview' ? await renderPreview(storage, task.request) : await deliver(storage, task); }
      catch (error) { return failedResult(error); }
      finally { stats.tasks++; }
    },
    async close() {},
  };
}

export interface Scheduler {
  /** 停下：做完正在做的那一项就退出。 */
  stop(): Promise<void>;
  /** 停止前排空（滚动发布）：不再领预览，做完本构建排队的批次项再退出。 */
  drain(): Promise<void>;
  readonly stats: RunnerStats;
}

export interface SchedulerOptions {
  readonly backend: ServiceBackend;
  readonly runner: Runner;
  readonly logger: Logger;
  readonly pollMs: number;
  readonly workerId: string;
  /** 本 worker 的构建标识：只领这个构建接受的批次项。 */
  readonly build: string;
  /** 批次项的租约，毫秒：要比单项超时长，过了还没写回才让别的 worker 重领。 */
  readonly leaseMs: number;
  /** 渲染批次项时隔多久查看一次批次是否已取消，毫秒。 */
  readonly cancelPollMs?: number;
}

/** 循环领取任务；队列空时每隔 pollMs 再看。 */
export function startScheduler(options: SchedulerOptions): Scheduler {
  const { backend, runner, logger, pollMs, workerId, build, leaseMs, cancelPollMs = 200 } = options;
  let stopped = false, draining = false;
  let wake: (() => void) | undefined;
  const sleep = () => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, pollMs);
    wake = () => { clearTimeout(timer); resolve(); };
  });

  const batchOf = (task: BatchItemTask) => backend.tenant(task.tenantId).storage.openBatch(task.batchId);

  /** 渲染器没交回结果的批次项：已登记的以登记的为准；取消的标为未执行；其余写问题清单，标为失败。 */
  const settle = async (task: BatchItemTask, outcome: RunOutcome): Promise<ItemResult> => {
    if ('status' in outcome) return outcome;
    const batch = batchOf(task);
    const committed = await committedItem(batch, task.index, task.itemId);
    if (committed) return committed;
    if ('cancelled' in outcome) return notRunItem(task.index, task.itemId, KILLED);
    const { problems } = outcome, severe = problems.filter((p) => p.level === 'severe').length;
    const base = { index: task.index, id: task.itemId, status: 'failed' as const, severe, hints: problems.length - severe, problems };
    try {
      await batch.output.write(task.index, { files: new Map([['problems.json', manifestBytes(problems)]]) });
    } catch {
      return (await committedItem(batch, task.index, task.itemId)) ?? base;
    }
    return { ...base, directory: batch.output.location(task.index), files: { problems: 'problems.json' } };
  };

  const runItem = async (task: BatchItemTask): Promise<ItemResult> => {
    if (task.attempts > MAX_ATTEMPTS) {
      return settle(task, workerProblem(WorkerProblemCodes.crashed, `本项已领取 ${MAX_ATTEMPTS} 次，每次都没做完（worker 中途退出），不再重试`));
    }
    // 重领到已取消批次的项：还没登记就不开始。
    if (await backend.queue.cancelRequested(task)) return (await committedItem(batchOf(task), task.index, task.itemId)) ?? notRunItem(task.index, task.itemId, NOT_STARTED);
    const controller = new AbortController();
    let checking = false;
    const watch = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      backend.queue.cancelRequested(task).then((cancelled) => { if (cancelled) controller.abort(); }, () => undefined).finally(() => { checking = false; });
    }, cancelPollMs);
    try { return await settle(task, await runner.run(task, controller.signal)); }
    finally { clearInterval(watch); }
  };

  const loop = (async () => {
    while (!stopped) {
      let task: ClaimedTask | undefined;
      try { task = await backend.queue.claim(workerId, new Date(), { build, leaseMs, previews: !draining }); }
      catch (error) {
        logger.error({ err: error }, '领取任务失败');
        if (draining) break;
      }
      if (!task) {
        if (draining) break;
        await sleep();
        continue;
      }
      const started = Date.now();
      try {
        if (task.kind === 'preview') {
          const result = await runner.run(task) as TaskResult;
          await backend.queue.finish(task, result, new Date());
          logger.info({ taskId: task.id, tenantId: task.tenantId, kind: task.kind, ms: Date.now() - started, problems: result.problems.length, image: Boolean(result.image) }, '任务完成');
        } else {
          const item = await runItem(task);
          const written = await backend.queue.finishItem(task, item, new Date());
          logger.info({ taskId: task.id, tenantId: task.tenantId, kind: task.kind, batchId: task.batchId, index: task.index, attempts: task.attempts,
            ms: Date.now() - started, status: item.status, problems: item.problems.length, ...(written ? {} : { stale: true }) }, written ? '批次项完成' : '批次项已被重领，结果不写回');
        }
      } catch (error) { logger.error({ err: error, taskId: task.id }, '写回任务结果失败'); }
    }
  })();
  const finish = async () => {
    wake?.();
    await loop;
    await runner.close();
  };
  return {
    stats: runner.stats,
    async stop() {
      stopped = true;
      await finish();
    },
    async drain() {
      draining = true;
      await finish();
    },
  };
}
