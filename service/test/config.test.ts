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

it('接口进程的 webhook 配置：服务密钥必填、是 64 位十六进制，缺少与不合规时只报变量名；其余有缺省值', async () => {
  const { loadWebhookConfig } = await import('../src/config.js');
  const key = 'ab'.repeat(32);
  expect(loadWebhookConfig({ RW_SECRET_KEY: key })).toEqual({
    secretKey: new Uint8Array(Buffer.from(key, 'hex')),
    config: { pollMs: 1_000, retryBaseMs: 60_000, maxAttempts: 8, timeoutMs: 10_000, allowPrivate: false },
  });
  expect(loadWebhookConfig({ RW_SECRET_KEY: key, RW_WEBHOOK_POLL_MS: '50', RW_WEBHOOK_RETRY_BASE_MS: '100', RW_WEBHOOK_MAX_ATTEMPTS: '3',
    RW_WEBHOOK_TIMEOUT_MS: '2000', RW_WEBHOOK_ALLOW_PRIVATE: 'true' }).config).toEqual({ pollMs: 50, retryBaseMs: 100, maxAttempts: 3, timeoutMs: 2000, allowPrivate: true });
  expect(() => loadWebhookConfig({})).toThrow('缺少环境变量：RW_SECRET_KEY');
  for (const bad of ['ab'.repeat(31), `${'ab'.repeat(31)}zz`, 'AB'.repeat(32)]) {
    let error: unknown;
    try { loadWebhookConfig({ RW_SECRET_KEY: bad }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as Error).message).toBe('环境变量 RW_SECRET_KEY 必须是 64 位小写十六进制（32 字节）');
  }
  expect(() => loadWebhookConfig({ RW_SECRET_KEY: key, RW_WEBHOOK_MAX_ATTEMPTS: '0' })).toThrow(/RW_WEBHOOK_MAX_ATTEMPTS/);
  expect(() => loadWebhookConfig({ RW_SECRET_KEY: key, RW_WEBHOOK_ALLOW_PRIVATE: 'yes' })).toThrow(/RW_WEBHOOK_ALLOW_PRIVATE/);
});

it('worker 与任务行清理的缺省值按容量基线（票据 15，M302）：单项超时 60 秒、做满 500 项换新；预览与重放的任务行保留 1 小时，至少 2 分钟', async () => {
  const { loadTaskRetentionMs, loadWorkerConfig } = await import('../src/config.js');
  expect(loadWorkerConfig({})).toEqual({ renderTimeoutMs: 60_000, recycleAfter: 500, pollMs: 100 });
  expect(loadTaskRetentionMs({})).toBe(3_600_000);
  expect(loadTaskRetentionMs({ RW_TASK_RETENTION_MS: '120000' })).toBe(120_000);
  expect(() => loadTaskRetentionMs({ RW_TASK_RETENTION_MS: '60000' })).toThrow('环境变量 RW_TASK_RETENTION_MS 必须是不小于 120000 的整数');
});
