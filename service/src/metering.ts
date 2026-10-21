/**
 * 对账任务（票据 09，ADR-0020）：退回崩溃后遗留的预占。接口进程启动时做一次，之后定期做。
 * 预占记在批次上，逐项结算、取消与批次结束都在事务里退回；只有接受批次的构建再没有 worker（worker 被强杀、
 * 滚动发布时旧 worker 没排空就没了）时，批次停在半路，它的预占才没人退回。这样的批次闲置超过宽限时间就由这里退回。
 * 以后若又有那个构建的 worker 把它交付完，成功的项照样计已用。
 */
import type { ReleasedReservation, ServiceBackend } from './backend.js';
import type { Logger } from './log.js';
import { WORKER_STALE_MS } from './worker/scheduler.js';

/** 对账一次：接受批次的构建在 WORKER_STALE_MS 内没有 worker 报到、批次闲置超过 graceMs，就退回它的预占。 */
export async function reconcileReservations(backend: ServiceBackend, now: Date, graceMs: number): Promise<readonly ReleasedReservation[]> {
  return backend.reconcileReservations({ onlineSince: new Date(now.getTime() - WORKER_STALE_MS), idleBefore: new Date(now.getTime() - graceMs) });
}

export interface Reconciler {
  stop(): Promise<void>;
}

/** 定期对账；每退回一个批次的预占记一行日志（租户、批次与数目，不含业务内容）。 */
export function startReconciler(options: { readonly backend: ServiceBackend; readonly logger: Logger; readonly intervalMs: number; readonly graceMs: number }): Reconciler {
  const { backend, logger, intervalMs, graceMs } = options;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = running.then(async () => {
      try {
        for (const entry of await reconcileReservations(backend, new Date(), graceMs)) logger.info(entry, '对账：退回遗留的预占');
      } catch (error) { logger.warn({ err: error }, '对账失败，下次再试'); }
    });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
