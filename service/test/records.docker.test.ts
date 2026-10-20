/**
 * 出图记录跑 PostgreSQL 加 S3 后端：测试进程的 worker 与 Compose 里真实的 worker 是两个构建，验证重放按构建路由；
 * 直接改写对象存储里的对象，验证读取时的完整性核对。
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll } from 'vitest';
import { blobKey } from '../src/postgres/blobs.js';
import type { Db } from '../src/postgres/db.js';
import { describeRecords } from './records-suite.js';
import { apiUrl, config, postgresBackend, s3 } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeRecords('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, {
  realWorker: {
    apiUrl,
    overwriteObject: async (tenantId, sha256, bytes) => {
      await s3.send(new PutObjectCommand({ Bucket: config.s3.bucket, Key: blobKey(tenantId, sha256), Body: bytes, ContentLength: bytes.length }));
    },
  },
});
