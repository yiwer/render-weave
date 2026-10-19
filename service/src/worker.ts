/**
 * 渲染 worker 的调度进程（ADR-0017）。本期只有骨架：启动时确认迁移与代码一致，提供健康检查。
 * 领取任务、渲染子进程与超时结束随草稿预览与批量交付加入。
 */
import { createServer, type Server } from 'node:http';
import type { BlobStore } from './blobs.js';
import type { Db } from './db.js';
import { readiness } from './health.js';
import type { Logger } from './log.js';
import { checkMigrations, type Migration, type MigrationState } from './migrate.js';

export interface WorkerDependencies {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly migrations: readonly Migration[];
  readonly build: string;
  readonly logger: Logger;
}

/** 等接口进程执行完迁移；数据库有代码不认识的版本或迁移被改过时直接失败。 */
export async function waitForMigrations(deps: WorkerDependencies, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state: MigrationState | undefined, reason = '';
    try { state = await checkMigrations(deps.db, deps.migrations); }
    catch (error) { reason = `数据库不可用：${(error as Error).message}`; }
    if (state) {
      if (state.problems.length) throw new Error(state.problems.join('；'));
      if (!state.pending.length) return state.version;
      reason = `等待迁移：${state.pending.join('、')}`;
    }
    if (Date.now() > deadline) throw new Error(`worker 启动超时，${reason}`);
    deps.logger.info({ reason }, 'worker 等待数据库就绪');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** 健康检查端点：/healthz 存活，/readyz 就绪。只用 node:http。 */
export function createWorkerHealthServer(deps: WorkerDependencies): Server {
  return createServer((request, response) => {
    const reply = (code: number, body: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return reply(405, { status: 'methodNotAllowed' });
    if (request.url === '/healthz') return reply(200, { status: 'ok', service: 'worker', build: deps.build });
    if (request.url === '/readyz') {
      readiness(deps.db, deps.blobs, deps.migrations).then((result) => {
        if (!result.ready) deps.logger.warn({ checks: result.checks }, 'worker 未就绪');
        reply(result.ready ? 200 : 503, { status: result.ready ? 'ready' : 'unready', service: 'worker', build: deps.build, ...result });
      }, (error: Error) => reply(500, { status: 'error', message: error.message }));
      return;
    }
    reply(404, { status: 'notFound' });
  });
}
