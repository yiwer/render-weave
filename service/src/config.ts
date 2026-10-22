/**
 * 服务配置只从环境变量读取：数据库与对象存储的凭据不写进镜像与仓库（M259）。
 * 缺少或不合法时只列出变量名，从不输出取值。
 * 接口进程与 worker 用应用账号连库；部署步骤 setup 用属主账号执行迁移，并设置应用账号的密码（M262）。
 */
import { DEFAULT_WEBHOOK_CONFIG, SECRET_KEY_SHAPE, type WebhookConfig } from './webhooks.js';

export interface S3Config {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** 兼容 S3 的自建存储一般要用路径形式的地址。 */
  readonly forcePathStyle: boolean;
}

export interface ServiceConfig {
  /** 应用账号 renderweave_app 的连接串。 */
  readonly databaseUrl: string;
  readonly s3: S3Config;
  readonly port: number;
  readonly logLevel: string;
}

export interface SetupConfig {
  /** 属主账号的连接串：执行迁移、设置应用账号的密码。 */
  readonly ownerDatabaseUrl: string;
  readonly appDatabasePassword: string;
  readonly s3: S3Config;
  readonly logLevel: string;
}

export class ConfigError extends Error {}

function reader(env: NodeJS.ProcessEnv) {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') missing.push(name);
    return value ?? '';
  };
  const s3 = (): S3Config => ({
    endpoint: required('RW_S3_ENDPOINT'),
    region: env['RW_S3_REGION'] || 'us-east-1',
    bucket: required('RW_S3_BUCKET'),
    accessKeyId: required('RW_S3_ACCESS_KEY_ID'),
    secretAccessKey: required('RW_S3_SECRET_ACCESS_KEY'),
    forcePathStyle: env['RW_S3_FORCE_PATH_STYLE'] !== 'false',
  });
  const done = () => { if (missing.length) throw new ConfigError(`缺少环境变量：${missing.join('、')}`); };
  return { required, s3, done, logLevel: env['RW_LOG_LEVEL'] || 'info' };
}

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { readonly port: number }): ServiceConfig {
  const read = reader(env);
  const config = { databaseUrl: read.required('RW_DATABASE_URL'), s3: read.s3(), port: env['RW_PORT'] ? Number(env['RW_PORT']) : defaults.port, logLevel: read.logLevel };
  read.done();
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new ConfigError('环境变量 RW_PORT 必须是 1–65535 的整数');
  return config;
}

/** 渲染 worker 的数值（ADR-0017）：缺省值按容量基线定（票据 15，M302）；内存上限与 CPU 是容器的限制，不在这里。 */
export interface WorkerConfig {
  /** 单项超时，毫秒：调度进程到时结束渲染子进程。 */
  readonly renderTimeoutMs: number;
  /** 渲染子进程做满这么多项后换新。 */
  readonly recycleAfter: number;
  /** 队列空时隔多久再看，毫秒。 */
  readonly pollMs: number;
}

const integerReader = (env: NodeJS.ProcessEnv) => (name: string, fallback: number, min: number) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new ConfigError(`环境变量 ${name} 必须是不小于 ${min} 的整数`);
  return value;
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const integer = integerReader(env);
  return { renderTimeoutMs: integer('RW_RENDER_TIMEOUT_MS', 60_000, 100), recycleAfter: integer('RW_RENDER_RECYCLE_AFTER', 500, 1), pollMs: integer('RW_WORKER_POLL_MS', 100, 5) };
}

/** 接口进程的对账任务（票据 09，ADR-0020）：隔多久对一次账，批次闲置多久、又没有它的构建的 worker 时退回预占。 */
export interface ReconcileConfig {
  readonly intervalMs: number;
  readonly graceMs: number;
}

export function loadReconcileConfig(env: NodeJS.ProcessEnv): ReconcileConfig {
  const integer = integerReader(env);
  return { intervalMs: integer('RW_RECONCILE_MS', 60_000, 100), graceMs: integer('RW_RESERVATION_GRACE_MS', 600_000, 0) };
}

/** 接口进程清理预览与重放的任务行（票据 15）：保留多久；至少两分钟，比预览的等待时长与频率窗口都长。 */
export function loadTaskRetentionMs(env: NodeJS.ProcessEnv): number {
  return integerReader(env)('RW_TASK_RETENTION_MS', 3_600_000, 120_000);
}

export function loadSetupConfig(env: NodeJS.ProcessEnv): SetupConfig {
  const read = reader(env);
  const config = { ownerDatabaseUrl: read.required('RW_OWNER_DATABASE_URL'), appDatabasePassword: read.required('RW_APP_DATABASE_PASSWORD'), s3: read.s3(), logLevel: read.logLevel };
  read.done();
  if (config.appDatabasePassword.length < 16) throw new ConfigError('环境变量 RW_APP_DATABASE_PASSWORD 至少要 16 个字符');
  return config;
}

/** 接口进程的 webhook 投递（票据 11）：服务密钥加密各 webhook 的签名密钥；数值缺省见 DEFAULT_WEBHOOK_CONFIG。 */
export function loadWebhookConfig(env: NodeJS.ProcessEnv): { readonly secretKey: Uint8Array; readonly config: WebhookConfig } {
  const read = reader(env), raw = read.required('RW_SECRET_KEY');
  read.done();
  if (!SECRET_KEY_SHAPE.test(raw)) throw new ConfigError('环境变量 RW_SECRET_KEY 必须是 64 位小写十六进制（32 字节）');
  const integer = integerReader(env), flag = env['RW_WEBHOOK_ALLOW_PRIVATE'] ?? 'false';
  if (flag !== 'true' && flag !== 'false') throw new ConfigError('环境变量 RW_WEBHOOK_ALLOW_PRIVATE 只能是 true 或 false');
  return {
    secretKey: new Uint8Array(Buffer.from(raw, 'hex')),
    config: {
      pollMs: integer('RW_WEBHOOK_POLL_MS', DEFAULT_WEBHOOK_CONFIG.pollMs, 5),
      retryBaseMs: integer('RW_WEBHOOK_RETRY_BASE_MS', DEFAULT_WEBHOOK_CONFIG.retryBaseMs, 1),
      maxAttempts: integer('RW_WEBHOOK_MAX_ATTEMPTS', DEFAULT_WEBHOOK_CONFIG.maxAttempts, 1),
      timeoutMs: integer('RW_WEBHOOK_TIMEOUT_MS', DEFAULT_WEBHOOK_CONFIG.timeoutMs, 100),
      allowPrivate: flag === 'true',
    },
  };
}
