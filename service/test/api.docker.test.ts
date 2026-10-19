/** 开放 API 用例跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效），与内存后端同一组用例。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeApi } from './api-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeApi('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});
