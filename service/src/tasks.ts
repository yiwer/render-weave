/**
 * 队列积压与任务行的清理（票据 15，M303）。
 * - 积压：各种类排队与渲染中的任务数、排队最久的等了多久。经 worker 的就绪检查可见；接口进程定期记进结构化日志，
 *   worker 全停时也看得到。接口进程的就绪检查对外公开，不带积压。
 * - 清理：预览与重放的结果由接口进程同步取走，过了保留期的行由接口进程定期删掉，表不随预览次数一直长大。
 *   批次项的行是批次逐项状态与出图记录列表的来源，不删。
 */
import type { QueueBacklog, Readiness, ServiceBackend, TaskCounts } from './backend.js';
import type { Logger } from './log.js';
import { every, type Periodic } from './periodic.js';

/** 两种后端查出的排队与渲染中的任务：每行是一组任务的种类、状态、个数与最早入队时间。 */
export interface BacklogRow { readonly kind: keyof TaskCounts; readonly status: 'queued' | 'running'; readonly tasks: number; readonly oldest: Date }

export function backlogOf(rows: readonly BacklogRow[], now: Date): QueueBacklog {
  const counts = (status: BacklogRow['status']): TaskCounts => {
    const of = (kind: keyof TaskCounts) => rows.filter((row) => row.kind === kind && row.status === status).reduce((sum, row) => sum + row.tasks, 0);
    return { preview: of('preview'), batchItem: of('batchItem'), replay: of('replay') };
  };
  const oldest = Math.min(...rows.filter((row) => row.status === 'queued').map((row) => row.oldest.getTime()));
  return { queued: counts('queued'), running: counts('running'), oldestQueuedMs: Number.isFinite(oldest) ? Math.max(0, now.getTime() - oldest) : 0 };
}

const idle = (backlog: QueueBacklog) => Object.values(backlog.queued).every((n) => n === 0) && Object.values(backlog.running).every((n) => n === 0);

/** worker 的就绪检查带上队列积压：没就绪时只给检查项；积压查不出来时不带它，就绪与否不受影响。 */
export async function readinessWithBacklog(backend: ServiceBackend, now: Date): Promise<Readiness & { readonly queue?: QueueBacklog }> {
  const result = await backend.readiness();
  if (!result.ready) return result;
  try { return { ...result, queue: await backend.queue.backlog(now) }; } catch { return result; }
}

/** 删掉 now − retentionMs 之前入队的预览与重放任务行，返回删了几行。 */
export async function purgeTasks(backend: ServiceBackend, now: Date, retentionMs: number): Promise<number> {
  return backend.queue.purge(new Date(now.getTime() - retentionMs));
}

/** 接口进程的队列维护：启动时与之后定期清理任务行（删了行时记一行），队列不空时记一行积压。 */
export function startQueueMaintenance(options: { readonly backend: ServiceBackend; readonly logger: Logger; readonly intervalMs: number; readonly retentionMs: number }): Periodic {
  const { backend, logger, intervalMs, retentionMs } = options;
  return every(intervalMs, async () => {
    try {
      const now = new Date(), removed = await purgeTasks(backend, now, retentionMs);
      if (removed) logger.info({ removed, retentionMs }, '清理预览与重放的任务行');
      const backlog = await backend.queue.backlog(now);
      if (!idle(backlog)) logger.info({ queue: backlog }, '队列积压');
    } catch (error) { logger.warn({ err: error }, '队列维护失败，下次再试'); }
  });
}
