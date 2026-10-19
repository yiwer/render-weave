/**
 * 渲染 worker 的调度进程（ADR-0017）。本期只有骨架：启动时确认迁移与代码一致，提供健康检查。
 * 领取任务、渲染子进程与超时结束随草稿预览与批量交付加入。
 */
import { createServer, type Server } from 'node:http';
import type { ServiceBackend } from './backend.js';
import type { Logger } from './log.js';

/** 健康检查端点：/healthz 存活，/readyz 就绪。只用 node:http。 */
export function createWorkerHealthServer(deps: { readonly backend: ServiceBackend; readonly build: string; readonly logger: Logger }): Server {
  return createServer((request, response) => {
    const reply = (code: number, body: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return reply(405, { status: 'methodNotAllowed' });
    if (request.url === '/healthz') return reply(200, { status: 'ok', service: 'worker', build: deps.build });
    if (request.url === '/readyz') {
      deps.backend.readiness().then((result) => {
        if (!result.ready) deps.logger.warn({ checks: result.checks }, 'worker 未就绪');
        reply(result.ready ? 200 : 503, { status: result.ready ? 'ready' : 'unready', service: 'worker', build: deps.build, ...result });
      }, (error: Error) => reply(500, { status: 'error', message: error.message }));
      return;
    }
    reply(404, { status: 'notFound' });
  });
}
