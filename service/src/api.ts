/**
 * 接口进程（ADR-0017）：鉴权、校验、检查额度，再把任务写进队列；它自己不渲染。
 * HTTP 框架用 Fastify（M259）。本期只有健康检查，开放 API 的端点随后续票据加入。
 */
import Fastify from 'fastify';
import type { BlobStore } from './blobs.js';
import type { Db } from './db.js';
import { readiness } from './health.js';
import type { Logger } from './log.js';
import type { Migration } from './migrate.js';

export interface ApiDependencies {
  readonly db: Db;
  readonly blobs: BlobStore;
  readonly migrations: readonly Migration[];
  readonly build: string;
  readonly logger: Logger;
}

export function createApi(deps: ApiDependencies) {
  const app = Fastify({ loggerInstance: deps.logger });
  // 健康检查由编排每隔几秒调用一次，只在出问题时记日志。
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok', service: 'api', build: deps.build }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const result = await readiness(deps.db, deps.blobs, deps.migrations);
    if (!result.ready) deps.logger.warn({ checks: result.checks }, '接口进程未就绪');
    reply.code(result.ready ? 200 : 503);
    return { status: result.ready ? 'ready' : 'unready', service: 'api', build: deps.build, ...result };
  });
  return app;
}
