/** Excel 导入跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效）；批次由测试进程里同构建的 worker 交付。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeImports } from './imports-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeImports('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});
