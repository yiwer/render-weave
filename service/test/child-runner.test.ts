/**
 * 渲染子进程在两项之间退出（M350）：用假的子进程脚本代替 render-child，只经 Runner 的 run、stats 与 close 观察。
 * 超时、内存超限与做满项数换新要真实的渲染与容器内存上限，在 Docker 后端测（preview-suite 的 isolation 段）；
 * 两项之间的退出在 Docker 后端触发不了：tester 容器结束不了 worker 容器里的子进程，单项超时又短于能撑爆内存的压力牌。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreviewTask } from '../src/backend.js';
import { createLogger } from '../src/log.js';
import { childRunner } from '../src/worker/child-runner.js';
import type { Runner, RunOutcome } from '../src/worker/scheduler.js';

const FAKE_CHILD = fileURLToPath(new URL('./fake-render-child.mjs', import.meta.url));

describe('渲染子进程在两项之间退出', () => {
  let dir: string, runner: Runner, logs: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-child-runner-'));
    logs = [];
    const logger = createLogger('worker', 'sha256:test', 'info', { write: (line: string) => { logs.push(JSON.parse(line).msg); } });
    runner = childRunner({ script: FAKE_CHILD, timeoutMs: 20_000, recycleAfter: 100, logger, memoryEvents: join(dir, 'memory.events') });
  });
  afterEach(async () => {
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const task = (id: string, request: Record<string, unknown> = {}): PreviewTask => ({ id, tenantId: 't', kind: 'preview', request });
  const pid = (outcome: RunOutcome) => (outcome as { pid?: number }).pid;
  const until = async (condition: () => boolean) => {
    for (const deadline = Date.now() + 10_000; !condition(); await new Promise((resolve) => setTimeout(resolve, 10))) {
      if (Date.now() > deadline) throw new Error('等了 10 秒条件仍不成立');
    }
  };

  it('交回结果后自己退出：空闲时立即换新预热，下一项在新的子进程上照常完成', async () => {
    const first = await runner.run(task('a', { then: 'exit' }));
    await until(() => runner.stats.restarts === 1);
    const second = await runner.run(task('b'));
    expect(second).toMatchObject({ problems: [] });
    expect(pid(second)).not.toBe(pid(first));
    expect(runner.stats).toMatchObject({ tasks: 2, crashes: 0, timeouts: 0, memoryKills: 0, restarts: 1 });
    expect(logs).toContain('渲染子进程在两项之间退出');
  });

  it('两项之间被外部结束：同样换新，下一项照常完成', async () => {
    const first = await runner.run(task('a'));
    process.kill(pid(first)!, 'SIGKILL');
    await until(() => runner.stats.restarts === 1);
    const second = await runner.run(task('b'));
    expect(second).toMatchObject({ problems: [] });
    expect(pid(second)).not.toBe(pid(first));
    expect(runner.stats).toMatchObject({ tasks: 2, crashes: 0, restarts: 1 });
  });

  it('交任务时子进程已断开：本项没交出去，换新后再交，照常完成；只算一项', async () => {
    const marker = join(dir, 'disconnected');
    const first = await runner.run(task('a', { then: 'disconnect', marker }));
    await until(() => existsSync(marker));
    expect(runner.stats.restarts).toBe(0);
    const second = await runner.run(task('b'));
    expect(second).toMatchObject({ problems: [] });
    expect(pid(second)).not.toBe(pid(first));
    expect(runner.stats).toMatchObject({ tasks: 2, crashes: 0, restarts: 1 });
    expect(logs).toContain('渲染子进程已退出，本项没交出去，换新后再交');
  });
});
