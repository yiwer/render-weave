/** 配置只从环境变量读取；缺少时列出变量名，从不输出取值（M259）。 */
import { expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const complete = {
  RW_DATABASE_URL: 'postgres://user:db-secret@db:5432/renderweave',
  RW_S3_ENDPOINT: 'http://s3:9000',
  RW_S3_BUCKET: 'renderweave',
  RW_S3_ACCESS_KEY_ID: 'access-id',
  RW_S3_SECRET_ACCESS_KEY: 's3-secret',
};

it('读出全部配置；端口与日志级别有缺省值，路径形式地址缺省开启', () => {
  expect(loadConfig(complete, { port: 8081 })).toEqual({
    databaseUrl: complete.RW_DATABASE_URL,
    s3: { endpoint: 'http://s3:9000', region: 'us-east-1', bucket: 'renderweave', accessKeyId: 'access-id', secretAccessKey: 's3-secret', forcePathStyle: true },
    port: 8081,
    logLevel: 'info',
  });
});

it('缺少凭据时报出全部缺少的变量名，不带任何取值', () => {
  const { RW_S3_SECRET_ACCESS_KEY: _secret, RW_DATABASE_URL: _url, ...partial } = complete;
  let error: unknown;
  try { loadConfig(partial, { port: 8080 }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ConfigError);
  expect((error as Error).message).toBe('缺少环境变量：RW_DATABASE_URL、RW_S3_SECRET_ACCESS_KEY');
  expect(() => loadConfig({ ...complete, RW_PORT: '70000' }, { port: 8080 })).toThrow(/RW_PORT/);
  expect(() => loadConfig({ ...complete, RW_PORT: '70000' }, { port: 8080 })).not.toThrow(/s3-secret|db-secret/);
});
