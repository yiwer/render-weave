/**
 * Docker 后端测试的连接：配置与服务一样只从环境变量读取。
 * 服务用应用账号（RW_DATABASE_URL，行级安全对它生效）；迁移测试另用属主账号（RW_OWNER_DATABASE_URL）建临时数据库。
 */
import { loadConfig } from '../src/config.js';
import { createPostgresBackend } from '../src/postgres/backend.js';
import { createS3Client, s3Blobs } from '../src/postgres/blobs.js';
import { createDb } from '../src/postgres/db.js';
import { loadMigrations } from '../src/postgres/migrate.js';

export const config = loadConfig(process.env, { port: 8080 });
export const ownerUrl = process.env['RW_OWNER_DATABASE_URL'] ?? '';
export const s3 = createS3Client(config.s3);
export const blobs = s3Blobs(s3, config.s3.bucket);
export const connect = () => createDb(config.databaseUrl);
export const connectOwner = () => createDb(ownerUrl);

/** 应用账号上的 PostgreSQL 加 S3 后端；调用方负责 db.end()。 */
export async function postgresBackend() {
  const db = connect();
  return { db, backend: createPostgresBackend({ db, blobs, migrations: await loadMigrations() }) };
}

/** 换掉连接串里的数据库名，迁移测试在临时数据库里进行。 */
export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export const apiUrl = process.env['RW_API_URL'] ?? 'http://127.0.0.1:8080';
export const workerUrl = process.env['RW_WORKER_URL'] ?? 'http://127.0.0.1:8081';
