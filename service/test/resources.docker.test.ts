/** 资源接口跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效）：提交点是带预期版本条件的数据库事务。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeResources } from './resources-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeResources('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});
