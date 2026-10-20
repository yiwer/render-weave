/**
 * 计量与额度跑 PostgreSQL 加 S3 后端：同一组用例由测试进程里的 worker 交付。
 * 另有只在这里测的崩溃对账（ADR-0020）：在测试容器里用镜像里编译好的服务另起一个接口进程与一个 worker 进程，
 * 批次进行中把两个进程都强杀（SIGKILL），再只起接口进程：它的对账任务等那个构建的 worker 不再在线、批次闲置过了宽限，
 * 退回遗留的预占；之后再起 worker 把批次交付完，成功的项照样计已用，每项只计一次。
 * 两个子进程跑的是服务代码的一份副本，副本里多一个文件，构建标识与 Compose 里的 worker 不同：批次只能由它交付，强杀后就没人接手。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { createWorld } from './api-suite.js';
import { describeMetering } from './metering-suite.js';
import { seedGreeting, seedStress, stressRequest } from './seed.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeMetering('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** 能画完、又要画一阵子的一项（压力细牌 2,000 项，本机约 0.7 秒）。 */
const slowItem = (id: string) => {
  const { template: _template, ...rest } = stressRequest(2000, { template: '压力细牌', height: 2000, padding: 40 });
  return { id, ...rest };
};

/** 服务代码的副本：引擎与服务的 dist、迁移与包描述，外加一个标记文件，构建标识因此与镜像里的不同。依赖仍用测试镜像里装好的。 */
async function copyBuild(dir: string): Promise<string> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(join(dir, 'service'), { recursive: true });
  await cp(join(REPO, 'dist'), join(dir, 'dist'), { recursive: true });
  await writeFile(join(dir, 'dist', 'crash-test-marker.js'), '// 只为让构建标识与镜像里的不同\n');
  await cp(join(REPO, 'service', 'dist'), join(dir, 'service', 'dist'), { recursive: true });
  await cp(join(REPO, 'service', 'migrations'), join(dir, 'service', 'migrations'), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await cp(join(REPO, file), join(dir, file));
  await cp(join(REPO, 'service', 'package.json'), join(dir, 'service', 'package.json'));
  await symlink(join(REPO, 'service', 'node_modules'), join(dir, 'service', 'node_modules'), 'dir');
  return join(dir, 'service', 'dist', 'main.js');
}

interface Child { readonly process: ChildProcess; readonly logs: string[] }

function start(main: string, command: 'api' | 'worker', env: Record<string, string>): Child {
  const logs: string[] = [];
  const child = spawn(process.execPath, [main, command], { env: { ...process.env, RW_LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout!, child.stderr!]) stream.on('data', (chunk) => logs.push(...String(chunk).split('\n').filter(Boolean)));
  return { process: child, logs };
}

async function ready(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error(`等不到就绪：${url}`);
    await sleep(200);
  }
}

const kill = (child: Child) => new Promise<void>((resolve) => {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return resolve();
  child.process.once('exit', () => resolve());
  child.process.kill('SIGKILL');
});

describe('崩溃后对账（PostgreSQL 加 S3，真实进程）', () => {
  const dir = join(REPO, `.crash-build-${process.pid}`);
  const children: Child[] = [];
  afterAll(async () => {
    await Promise.all(children.map(kill));
    await rm(dir, { recursive: true, force: true });
  });

  it('批次进行中强杀接口进程与 worker：只起接口进程，对账退回遗留的预占；worker 回来交付完，每项只计一次', async () => {
    const { db, backend } = await postgresBackend();
    pools.push(db);
    const world = await createWorld(backend, { plan: { monthlyImages: 10, maxPixels: 100_000_000, concurrency: 2 } });
    // 压力细牌用问候牌样例带的字体 font-hei-medium。
    await seedGreeting(backend.tenant(world.b.id).storage, { withFont: true });
    await seedStress(backend.tenant(world.b.id).storage);
    const main = await copyBuild(dir);
    const api = 'http://127.0.0.1:18080', worker = 'http://127.0.0.1:18081';
    // 单项超时 5 秒（租约因此是 65 秒）；对账每 0.5 秒一次，宽限 2 秒。
    const apiEnv = { RW_PORT: '18080', RW_RECONCILE_MS: '500', RW_RESERVATION_GRACE_MS: '2000' };
    const workerEnv = { RW_PORT: '18081', RW_RENDER_TIMEOUT_MS: '5000', RW_RENDER_RECYCLE_AFTER: '500' };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${api}${path}`, { method, headers: { authorization: `Bearer ${world.b.key.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, body: await response.json() as any };
    };
    const usage = async () => (await world.call('GET', `/v1/platform/tenants/${world.b.id}/usage`, world.platform)).body.images;
    const batch = async (id: string) => (await world.call('GET', `/v1/batches/${id}`, world.b.key.token)).body;

    const firstApi = start(main, 'api', apiEnv), firstWorker = start(main, 'worker', workerEnv);
    children.push(firstApi, firstWorker);
    await ready(`${api}/readyz`);
    await ready(`${worker}/readyz`);
    const build = (await (await fetch(`${api}/healthz`)).json() as { build: string }).build;
    const submitted = await call('POST', '/v1/batches', { template: '压力细牌', items: ['s1', 's2', 's3', 's4'].map(slowItem) });
    expect(submitted.status, JSON.stringify(submitted.body).slice(0, 300)).toBe(202);
    expect(submitted.body.build).toBe(build);
    const id = submitted.body.id as string;
    const accepted = await usage();
    expect(accepted.limit).toBe(10);
    expect(accepted.used + accepted.reserved).toBe(4);

    // 第一项交付后、批次做完前强杀两个进程。
    const deadline = Date.now() + 60_000;
    for (;;) {
      const items = (await batch(id)).items as { status: string; problems?: unknown }[];
      const failed = items.find((item) => item.status === 'failed');
      const tail = firstWorker.logs.slice(-20).join('\n');
      if (failed) throw new Error(`子进程交付失败：${JSON.stringify(failed).slice(0, 800)}\n${tail}`);
      if (items.some((item) => item.status === 'delivered')) break;
      if (Date.now() > deadline) throw new Error(`第一项迟迟没有交付：\n${tail}`);
      await sleep(50);
    }
    await Promise.all([kill(firstApi), kill(firstWorker)]);
    const killed = await usage(), state = await batch(id);
    expect(state.status).not.toBe('finished');
    expect(killed.used).toBeGreaterThanOrEqual(1);
    expect(killed.used + killed.reserved).toBe(4);

    // 只起接口进程：被强杀的 worker 没有离开，30 秒后才不算在线；之后批次闲置过了宽限，预占退回。
    const secondApi = start(main, 'api', apiEnv);
    children.push(secondApi);
    await ready(`${api}/readyz`);
    const reconcileBy = Date.now() + 90_000;
    while ((await usage()).reserved > 0) {
      if (Date.now() > reconcileBy) throw new Error(`预占迟迟没有退回：${JSON.stringify(await usage())}`);
      await sleep(500);
    }
    expect(await usage()).toEqual({ limit: 10, used: killed.used, reserved: 0, remaining: 10 - killed.used });
    const reconciled = secondApi.logs.map((line) => JSON.parse(line)).filter((entry) => entry.msg === '对账：退回遗留的预占' && entry.batchId === id);
    expect(reconciled).toEqual([expect.objectContaining({ tenantId: world.b.id, batchId: id, released: killed.reserved, build })]);

    // worker 回来：排队的项先交付，被强杀时正在做的一项过了租约重领；每项只计一次，预占不会退成负数。
    const secondWorker = start(main, 'worker', workerEnv);
    children.push(secondWorker);
    const finishBy = Date.now() + 150_000;
    let done = await batch(id);
    while (done.status !== 'finished') {
      if (Date.now() > finishBy) throw new Error(`批次迟迟没有交付完：${JSON.stringify(done).slice(0, 500)}`);
      await sleep(500);
      done = await batch(id);
    }
    expect(done.summary).toMatchObject({ total: 4, delivered: 4 });
    expect(await usage()).toEqual({ limit: 10, used: 4, reserved: 0, remaining: 6 });
    const events = (await world.call('GET', `/v1/platform/tenants/${world.b.id}/usage/events?kind=image&limit=500`, world.platform)).body.events as { batchId: string; index: number }[];
    expect(events.filter((event) => event.batchId === id).map((event) => event.index).sort()).toEqual([1, 2, 3, 4]);

    // 子进程的日志每行是 JSON，不含令牌与密钥。
    const logs = [...firstApi.logs, ...firstWorker.logs, ...secondApi.logs, ...secondWorker.logs];
    for (const line of logs) expect(() => JSON.parse(line), line).not.toThrow();
    for (const secret of world.secrets) expect(logs.join('\n')).not.toContain(secret);
    await Promise.all([kill(secondApi), kill(secondWorker)]);
  }, 300_000);
});
