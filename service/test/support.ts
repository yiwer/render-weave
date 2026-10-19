/** Docker 后端测试的连接：配置与服务一样只从环境变量读取。 */
import { createS3Client, s3Blobs } from '../src/blobs.js';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db.js';

export const config = loadConfig(process.env, { port: 8080 });
export const s3 = createS3Client(config.s3);
export const blobs = s3Blobs(s3, config.s3.bucket);
export const connect = () => createDb(config.databaseUrl);

/** 换掉连接串里的数据库名，迁移测试在临时数据库里进行。 */
export function databaseUrl(name: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

export const apiUrl = process.env['RW_API_URL'] ?? 'http://127.0.0.1:8080';
export const workerUrl = process.env['RW_WORKER_URL'] ?? 'http://127.0.0.1:8081';
