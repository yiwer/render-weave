/**
 * 接口进程里的定期任务（对账、队列维护、webhook 投递）共用的循环：启动时做一次，之后每 intervalMs 做一次；
 * 上一次没做完时，这一次排在它后面，不重叠。work 自己记日志、不抛错。
 */
export interface Periodic {
  /** 立即再做一次（排在正在做的那次后面）。 */
  tick(): Promise<void>;
  /** 停下：不再开始新的一次，等正在做的那次做完。 */
  stop(): Promise<void>;
}

export function every(intervalMs: number, work: () => Promise<void>): Periodic {
  let running: Promise<void> = Promise.resolve(), stopped = false;
  const tick = () => (running = running.then(() => (stopped ? undefined : work())));
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return {
    tick,
    async stop() {
      clearInterval(timer);
      stopped = true;
      await running;
    },
  };
}
