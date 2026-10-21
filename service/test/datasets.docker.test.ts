/** 数据集接口跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效）；预览由 Compose 里的 worker 渲染。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeDatasets } from './datasets-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeDatasets('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, { inProcessWorker: false });
