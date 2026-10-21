/**
 * 健康检查与结构化日志：Compose 起的接口进程与 worker 都用应用账号连库并就绪；依赖不可用时报未就绪，响应里不带凭据。
 */
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '../src/api/app.js';
import { createLogger } from '../src/log.js';
import { createPostgresBackend } from '../src/postgres/backend.js';
import { createS3Client, s3Blobs } from '../src/postgres/blobs.js';
import { createDb, type Db } from '../src/postgres/db.js';
import { loadMigrations, type Migration } from '../src/postgres/migrate.js';
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

it('服务用的是应用账号：不是超级用户，也不是表的属主，行级安全对它生效', async () => {
  const { rows: [role] } = await db.query(`SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`);
  expect(role).toMatchObject({ name: 'renderweave_app', rolsuper: false, rolbypassrls: false });
  const { rows: owned } = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user`);
  expect(owned).toEqual([]);
});

it('对象存储或数据库不可用时报未就绪（503），只给检查项与原因，不带凭据', async () => {
  const brokenS3 = s3Blobs(createS3Client({ ...config.s3, secretAccessKey: 'wrong-secret' }), config.s3.bucket);
  const brokenDb = createDb(databaseUrl(config.databaseUrl, 'missing_database'));
  try {
    for (const [backend, failing] of [
      [createPostgresBackend({ db, blobs: brokenS3, migrations }), 'storage'],
      [createPostgresBackend({ db: brokenDb, blobs, migrations }), 'database'],
    ] as const) {
      const app = createApi({ backend, build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'silent'), secretKey: new Uint8Array(32) });
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      await app.close();
      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body).toMatchObject({ status: 'unready', ready: false });
      expect(body.checks[failing]).not.toBe('ok');
      for (const secret of [config.s3.secretAccessKey, config.s3.accessKeyId, new URL(config.databaseUrl).password]) expect(response.body).not.toContain(secret);
    }
  } finally { await brokenDb.end(); }
});

it('日志每行是一个 JSON 对象，带时间、级别、服务名、构建标识与说明；请求头里的凭据不进日志', async () => {
  const lines: string[] = [];
  const sink = new Writable({ write(chunk, _encoding, done) { lines.push(...String(chunk).split('\n').filter(Boolean)); done(); } });
  const app = createApi({ backend: createPostgresBackend({ db, blobs, migrations }), build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'info', sink), secretKey: new Uint8Array(32) });
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

it('Compose 里的接口进程提供 OpenAPI 描述，与测试进程按同一份代码生成的相同（镜像里带着 DSL 的 JSON Schema）', async () => {
  const served = await get(`${apiUrl}/v1/openapi.json`);
  expect(served.status).toBe(200);
  const app = createApi({ backend: createPostgresBackend({ db, blobs, migrations }), build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'silent'), secretKey: new Uint8Array(32) });
  const local = (await app.inject({ method: 'GET', url: '/v1/openapi.json' })).json();
  await app.close();
  expect(served.body).toEqual(local);
  expect(served.body['components'].schemas.BatchRequest.$id).toBe('urn:renderweave:dsl:1:batch-request');
});
