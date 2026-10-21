/**
 * webhook 跑 PostgreSQL 加 S3 后端：投递由 Compose 里真实的接口进程完成（它与测试进程用同一个服务密钥，投递配置由 test-docker.mjs 设定），
 * 接收端在 tester 容器里，按容器在 Compose 网络里的地址注册。另核对库里只存签名密钥的密文。
 */
import { networkInterfaces } from 'node:os';
import { afterAll, expect } from 'vitest';
import { loadWebhookConfig } from '../src/config.js';
import type { Db } from '../src/postgres/db.js';
import { connectOwner, postgresBackend } from './support.js';
import { describeWebhooks, TEST_WEBHOOK_CONFIG } from './webhooks-suite.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

/** tester 容器在 Compose 网络里的 IPv4 地址：接口进程按它连接接收端。 */
const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
const { config } = loadWebhookConfig(process.env);
expect(config, 'test-docker.mjs 给接口进程与 tester 的投递配置要与用例的一致').toEqual(TEST_WEBHOOK_CONFIG);

describeWebhooks('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, {
  config, inProcessDispatcher: false, receiverHost: { bind: '0.0.0.0', advertise: address! },
  storedSecrets: async () => {
    const owner = connectOwner();
    try { return (await owner.query<{ secret_sealed: string }>('SELECT secret_sealed FROM webhooks')).rows.map((row) => row.secret_sealed); }
    finally { await owner.end(); }
  },
});
