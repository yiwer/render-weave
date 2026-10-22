/**
 * 渲染 worker 的健康检查（ADR-0017）：/healthz 存活，/readyz 就绪。只用 node:http。
 * 两者都带渲染器的计数：已做的任务、超时、内存超限、崩溃与子进程换新的次数、渲染用时；就绪检查另带队列积压（票据 15）。
 */
import { createServer, type Server } from 'node:http';
import type { ServiceBackend } from '../backend.js';
import type { Logger } from '../log.js';
import { readinessWithBacklog } from '../tasks.js';
import type { RunnerStats } from './scheduler.js';

export function createWorkerHealthServer(deps: { readonly backend: ServiceBackend; readonly build: string; readonly logger: Logger; readonly stats?: RunnerStats }): Server {
  const renderer = () => (deps.stats ? { renderer: { ...deps.stats } } : {});
  return createServer((request, response) => {
    const reply = (code: number, body: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method !== 'GET') return reply(405, { status: 'methodNotAllowed' });
    if (request.url === '/healthz') return reply(200, { status: 'ok', service: 'worker', build: deps.build, ...renderer() });
    if (request.url === '/readyz') {
      readinessWithBacklog(deps.backend, new Date()).then((result) => {
        if (!result.ready) deps.logger.warn({ checks: result.checks }, 'worker 未就绪');
        reply(result.ready ? 200 : 503, { status: result.ready ? 'ready' : 'unready', service: 'worker', build: deps.build, ...result, ...renderer() });
      }, (error: Error) => reply(500, { status: 'error', message: error.message }));
      return;
    }
    reply(404, { status: 'notFound' });
  });
}
