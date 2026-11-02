/** 数据定义草案的用例跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效），与内存后端同一组用例。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeDefinitions } from './definitions-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeDefinitions('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});
