/**
 * 健康检查与结构化日志：Compose 起的接口进程与 worker 都就绪；依赖不可用时报未就绪，响应里不带凭据。
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { createS3Client, s3Blobs } from '../src/blobs.js';
import { createDb, type Db } from '../src/db.js';
import { createLogger } from '../src/log.js';
import { loadMigrations, type Migration } from '../src/migrate.js';
import { apiUrl, blobs, config, connect, databaseUrl, workerUrl } from './support.js';

let db: Db, migrations: Migration[];
beforeAll(async () => { db = connect(); migrations = await loadMigrations(); });
afterAll(async () => { await db.end(); });

const get = async (url: string) => { const response = await fetch(url); return { status: response.status, body: await response.json() as Record<string, any> }; };

it('接口进程与 worker：存活与就绪检查都通过，带同一个构建标识与当前的数据库版本', async () => {
  const api = await get(`${apiUrl}/healthz`), worker = await get(`${workerUrl}/healthz`);
  expect(api).toMatchObject({ status: 200, body: { status: 'ok', service: 'api' } });
  expect(worker).toMatchObject({ status: 200, body: { status: 'ok', service: 'worker' } });
  expect(api.body.build).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(worker.body.build).toBe(api.body.build);
  for (const url of [apiUrl, workerUrl]) {
    expect(await get(`${url}/readyz`)).toMatchObject({ status: 200, body: {
      status: 'ready', ready: true, schemaVersion: migrations.length, checks: { database: 'ok', migrations: 'ok', storage: 'ok' } } });
  }
});

it('对象存储或数据库不可用时报未就绪（503），只给检查项与原因，不带凭据', async () => {
  const brokenS3 = s3Blobs(createS3Client({ ...config.s3, secretAccessKey: 'wrong-secret' }), config.s3.bucket);
  const broken = createDb(databaseUrl('missing_database'));
  try {
    for (const [deps, failing] of [[{ db, blobs: brokenS3 }, 'storage'], [{ db: broken, blobs }, 'database']] as const) {
      const app = createApi({ ...deps, migrations, build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'silent') });
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      await app.close();
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body).toMatchObject({ status: 'unready', ready: false });
      expect(body.checks[failing]).not.toBe('ok');
      for (const secret of [config.s3.secretAccessKey, config.s3.accessKeyId, new URL(config.databaseUrl).password]) expect(response.body).not.toContain(secret);
    }
  } finally { await broken.end(); }
});

it('日志每行是一个 JSON 对象，带时间、级别、服务名、构建标识与说明；请求头里的凭据被遮盖', async () => {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(...String(chunk).split('\n').filter(Boolean)); done(); } });
  const app = createApi({ db, blobs, migrations, build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'info', sink) });
  await app.inject({ method: 'GET', url: '/not-found', headers: { authorization: 'Bearer secret-token' } });
  await app.close();
  expect(lines.length).toBeGreaterThan(0);
  for (const line of lines) {
    const entry = JSON.parse(line);
    expect(entry).toMatchObject({ service: 'api', build: 'sha256:test' });
    expect(typeof entry.time).toBe('string');
    expect(typeof entry.level).toBe('number');
    expect(typeof entry.msg).toBe('string');
  }
  expect(lines.join('\n')).not.toContain('secret-token');
});
