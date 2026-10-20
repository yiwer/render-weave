/**
 * 模板与草稿预览跑 PostgreSQL 加 S3 后端：任务进 PostgreSQL 队列，由 Compose 里的 worker 进程渲染。
 * 单项超时、内存超限与子进程换新在这里测；数值由 test-docker.mjs 设给 worker（RW_RENDER_TIMEOUT_MS 等）。
 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describePreview } from './preview-suite.js';
import { postgresBackend, workerUrl } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describePreview('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, {
  inProcessWorker: false,
  isolation: { workerUrl, timeoutMs: Number(process.env['RW_RENDER_TIMEOUT_MS']), recycleAfter: Number(process.env['RW_RENDER_RECYCLE_AFTER']) },
});
