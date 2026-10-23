/** 本地产品入口共享的短时读取/提交约束；进程中断后的恢复由提交恢复机制负责。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProblemCodes, severe } from './problems.js';
import { isRecord } from './util.js';

const held = new AsyncLocalStorage<ReadonlySet<string>>();
export class LocalAccessBusy extends Error {
  constructor(readonly directory: string) { super(`目录正在读取或提交：${directory}；请稍后重试，勿删除活动 .write-lock`); }
}
export function localAccessProblem(error: unknown) {
  return error instanceof LocalAccessBusy ? severe(ProblemCodes.localStoreBusy, { kind: 'input', source: error.directory }, error.message) : undefined;
}

/** 真实路径去重并排序；遇到占用立即释放已取得的约束，不等待另一方持有的目录。 */
export async function withLocalAccess<T>(directories: readonly string[], action: () => Promise<T>, waitMs = 1000): Promise<T> {
  const roots = [...new Set(await Promise.all(directories.map(async dir => {
    const path = await realpath(dir); return process.platform === 'win32' ? path.toLowerCase() : path;
  })))].sort();
  const inherited = held.getStore() ?? new Set<string>(), owned: string[] = [];
  // 读者可在尚未持有任何约束时有界重试；每次失败先全部释放，不带锁等待另一目录。
  const deadline = Date.now() + (inherited.size ? 0 : waitMs);
  try {
    for (;;) {
      try {
        for (const root of roots) {
          if (inherited.has(root)) continue;
          try { await mkdir(join(root, '.write-lock')); owned.push(root); }
          catch (error) { if (isRecord(error) && error.code === 'EEXIST') throw new LocalAccessBusy(root); throw error; }
        }
        break;
      } catch (error) {
        for (const root of owned.reverse()) await rmdir(join(root, '.write-lock'));
        owned.length = 0;
        if (!(error instanceof LocalAccessBusy) || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
    return await held.run(new Set([...inherited, ...owned]), action);
  } finally {
    for (const root of owned.reverse()) await rmdir(join(root, '.write-lock'));
  }
}
