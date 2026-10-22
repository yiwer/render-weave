/**
 * 出图控制台的浏览器端到端测试跑 Docker 后端（票据 12）：浏览器是 tester 容器里的 Chromium（Alpine 的软件包，playwright-core 驱动），
 * 打开 Compose 里真实的接口进程提供的 /console/；预览与交付由 Compose 里真实的 worker 完成。
 * 准备数据与核对结果经同一个 PostgreSQL 加 S3 后端上的开放 API。webhook 由 Compose 里的接口进程投递给 tester 容器里的接收端（票据 14）。
 */
import { networkInterfaces } from 'node:os';
import { afterAll } from 'vitest';
import type { Db } from '../src/postgres/db.js';
import { describeConsole } from './console-suite.js';
import { apiUrl, postgresBackend } from './support.js';

const pools: Db[] = [];
afterAll(async () => { await Promise.all(pools.map((db) => db.end())); });

describeConsole('PostgreSQL 加 S3', async () => {
  const { db, backend } = await postgresBackend();
  pools.push(db);
  return backend;
}, {
  start: async () => ({ baseUrl: apiUrl, stop: async () => undefined }),
  // tester 容器在 Compose 网络里的 IPv4 地址：接口进程按它连接接收端（test-docker.mjs 放开了内网地址）。
  receiverHost: { bind: '0.0.0.0', advertise: Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)!.address },
  // 容器里以 root 运行，Chromium 要关掉沙箱；/dev/shm 很小，改用临时目录。
  launch: { executablePath: process.env['RW_CHROMIUM'] ?? '/usr/bin/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'] },
});
