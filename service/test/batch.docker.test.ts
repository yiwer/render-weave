/**
 * 批量正式交付跑 PostgreSQL 加 S3 后端：批次项进 PostgreSQL 队列。测试进程接受的批次由测试进程里的 worker 交付；
 * 批次中的内存超限、取消时结束正在渲染的一项与跨批次去重经 Compose 里的接口进程提交，由真实的 worker 交付；
 * worker 的内存上限由 test-docker.mjs 设定。
 */
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeBatches } from './batch-suite.js';
import { apiUrl, config, postgresBackend, s3, workerUrl } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

/** 列出前缀下的全部对象键。 */
async function listObjects(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3.bucket, Prefix: prefix, ContinuationToken: token }));
    keys.push(...(page.Contents ?? []).map((object) => object.Key!));
    token = page.NextContinuationToken;
  } while (token);
  return keys.sort();
}

describeBatches('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, {
  ownsQueue: false,
  realWorker: { apiUrl, workerUrl, listObjects },
});
