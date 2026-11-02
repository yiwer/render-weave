/** 审批策略与发布申请的用例跑 PostgreSQL 加 S3 后端（应用账号，行级安全生效）：批准与内容同一个事务靠它验证。 */
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeApprovals } from './approvals-suite.js';
import { postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeApprovals('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
});
