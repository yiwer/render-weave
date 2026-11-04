import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { postgresBackend } from './support.js';
import { describeAgentJobs } from './agent-jobs-suite.js';
const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map(db => db.end())); });
describeAgentJobs('数据集导入（PostgreSQL 加 S3）', async () => { const { db, backend } = await postgresBackend(); pools.push(db); return backend; });
