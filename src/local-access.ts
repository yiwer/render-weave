/** 本地产品入口共享的短时读取/提交约束；进程中断后的恢复由提交恢复机制负责。 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProblemCodes, severe } from './problems.js';
import { isRecord } from './util.js';
import { commitDirectories, LocalRecoveryRequired, recoverCommits } from './local-commit.js';

const held = new AsyncLocalStorage<ReadonlySet<string>>();
export class LocalAccessBusy extends Error {
  constructor(readonly directory: string) { super(`目录正在读取或提交：${directory}；请稍后重试，勿删除活动 .write-lock`); }
}
export function localAccessProblem(error: unknown) {
  if (error instanceof LocalRecoveryRequired) return severe(ProblemCodes.applyRecoveryRequired, { kind: 'input', source: error.directory }, error.message);
  return error instanceof LocalAccessBusy ? severe(ProblemCodes.localStoreBusy, { kind: 'input', source: error.directory }, error.message) : undefined;
}
interface OwnedLock { root: string; token: string; stop: () => Promise<void>; unlock: () => Promise<void> }
const LEASE_MS = 500;

/** OS 生命周期保证回收者也强退时仍能重新获得互斥；不通过删除别人的锁来争夺恢复权。 */
async function processMutex(root: string): Promise<() => Promise<void>> {
  const name = `renderweave-${createHash('sha256').update(root).digest('hex')}`;
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : process.platform === 'linux' ? `\0${name}` : undefined;
  if (!path) throw new Error('本地可恢复提交的进程互斥目前支持 Windows 与 Linux');
  const server = createServer(socket => socket.destroy()); server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', error => { server.close(); reject(isRecord(error) && error.code === 'EADDRINUSE' ? new LocalAccessBusy(root) : error); });
    server.listen(path, resolve);
  });
  return () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function acquire(root: string): Promise<OwnedLock> {
  const unlock = await processMutex(root);
  const token = randomUUID(), lock = join(root, '.write-lock'), temporary = join(root, `.write-lock-${token}`);
  let acquired = false;
  const ownerName = `owner-${token}.json`, leaseName = `lease-${token}`;
  try {
    if (await stat(lock).then(s => s.isDirectory(), () => false)) {
      await reclaim(root);
      if (await stat(lock).then(s => s.isDirectory(), () => false)) throw new LocalAccessBusy(root);
    }
    await mkdir(temporary);
    await writeFile(join(temporary, ownerName), JSON.stringify({ token, pid: process.pid, host: hostname(), startedAt: Date.now() - process.uptime() * 1000 }));
    await writeFile(join(temporary, leaseName), token);
    // 完整拥有者记录与目录同时可见；回收者不会误删尚未写好拥有者的活动空目录。
    try { await rename(temporary, lock); acquired = true; }
    catch (error) {
      if ((isRecord(error) && ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(String(error.code))) || await stat(lock).then(s => s.isDirectory(), () => false)) { await reclaim(root); throw new LocalAccessBusy(root); }
      throw error;
    }
  } finally {
    if (!acquired) {
      try { await rm(join(temporary, ownerName), { force: true }); await rm(join(temporary, leaseName), { force: true }); await rmdir(temporary).catch(() => undefined); }
      finally { await unlock(); }
    }
  }
  let pulse = Promise.resolve();
  const timer = setInterval(() => { pulse = pulse.then(() => writeFile(join(lock, leaseName), token)).catch(() => undefined); }, 100);
  timer.unref();
  return { root, token, unlock, stop: async () => { clearInterval(timer); await pulse; } };
}
async function reclaim(root: string): Promise<void> {
  const lock = join(root, '.write-lock');
  let names: string[]; try { names = await readdir(lock); } catch { return; }
  // 只有本实现的原子初始化目录才有拥有者；旧版空锁不能证明死亡，保守保留。
  const ownerName = names.find(name => /^owner-[\da-f-]+\.json$/.test(name));
  if (!ownerName) return;
  try {
    const owner: unknown = JSON.parse(await readFile(join(lock, ownerName), 'utf8'));
    if (!isRecord(owner) || typeof owner.token !== 'string' || ownerName !== `owner-${owner.token}.json` ||
      owner.host !== hostname() || typeof owner.pid !== 'number' || typeof owner.startedAt !== 'number') return;
    const lease = join(lock, `lease-${owner.token}`);
    const leaseTime = await stat(lease).then(s => s.mtimeMs, () => 0);
    if (Date.now() - leaseTime < LEASE_MS) return;
    try { process.kill(owner.pid, 0); return; } catch (error) { if (!isRecord(error) || error.code !== 'ESRCH') return; }
    // OS 互斥保证只有本恢复者能移动 .write-lock；整体移走后再清理，清理中强退不会留下活动路径中的空锁。
    const abandoned = join(root, `.write-abandoned-${owner.token}-${randomUUID()}`);
    await rename(lock, abandoned);
    await rm(join(abandoned, `lease-${owner.token}`), { force: true });
    await rm(join(abandoned, ownerName), { force: true });
    await rmdir(abandoned).catch(() => undefined);
  } catch { /* 无法证明拥有者死亡时不接管。 */ }
}

/** 真实路径去重并排序；遇到占用立即释放已取得的约束，不等待另一方持有的目录。 */
export async function withLocalAccess<T>(directories: readonly string[], action: () => Promise<T>, waitMs = 1000): Promise<T> {
  let roots = [...new Set(await Promise.all(directories.map(async dir => {
    const path = await realpath(dir); return process.platform === 'win32' ? path.toLowerCase() : path;
  })))].sort();
  const inherited = held.getStore() ?? new Set<string>(), owned: OwnedLock[] = [];
  // 读者可在尚未持有任何约束时有界重试；每次失败先全部释放，不带锁等待另一目录。
  const deadline = Date.now() + (inherited.size ? 0 : waitMs);
  try {
    for (;;) {
      try {
        roots = await commitDirectories(roots);
        for (const root of roots) {
          if (inherited.has(root)) continue;
          owned.push(await acquire(root));
        }
        const required = await commitDirectories(roots);
        if (required.some(root => !roots.includes(root))) { roots = required; await release(owned); continue; }
        break;
      } catch (error) {
        await release(owned);
        if (!(error instanceof LocalAccessBusy) || Date.now() >= deadline) throw error;
        await delay(10);
      }
    }
    return await held.run(new Set([...inherited, ...owned.map(lock => lock.root)]), async () => {
      if (owned.length) await recoverCommits(roots);
      return action();
    });
  } finally {
    await release(owned);
  }
}

async function release(owned: OwnedLock[]): Promise<void> {
  let failure: unknown;
  for (const lock of owned.splice(0).reverse()) {
    try {
      await lock.stop();
      const released = join(lock.root, `.write-released-${lock.token}`);
      await rename(join(lock.root, '.write-lock'), released);
      await rm(join(released, `lease-${lock.token}`), { force: true });
      await rm(join(released, `owner-${lock.token}.json`), { force: true });
      await rmdir(released);
    } catch (error) { failure ??= error; }
    finally { try { await lock.unlock(); } catch (error) { failure ??= error; } }
  }
  if (failure) throw failure;
}
