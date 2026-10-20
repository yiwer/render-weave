/**
 * 服务配置只从环境变量读取：数据库与对象存储的凭据不写进镜像与仓库（M259）。
 * 缺少或不合法时只列出变量名，从不输出取值。
 * 接口进程与 worker 用应用账号连库；部署步骤 setup 用属主账号执行迁移，并设置应用账号的密码（M262）。
 */
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

/** 渲染 worker 的数值（ADR-0017）：暂定的缺省值，容量基线（票据 15）实测后再定；内存上限是容器的限制，不在这里。 */
export interface WorkerConfig {
  /** 单项超时，毫秒：调度进程到时结束渲染子进程。 */
  readonly renderTimeoutMs: number;
  /** 渲染子进程做满这么多项后换新。 */
  readonly recycleAfter: number;
  /** 队列空时隔多久再看，毫秒。 */
  readonly pollMs: number;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const integer = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) throw new ConfigError(`环境变量 ${name} 必须是不小于 ${min} 的整数`);
    return value;
  };
  return { renderTimeoutMs: integer('RW_RENDER_TIMEOUT_MS', 30_000, 100), recycleAfter: integer('RW_RENDER_RECYCLE_AFTER', 500, 1), pollMs: integer('RW_WORKER_POLL_MS', 100, 5) };
}

export function loadSetupConfig(env: NodeJS.ProcessEnv): SetupConfig {
  const read = reader(env);
  const config = { ownerDatabaseUrl: read.required('RW_OWNER_DATABASE_URL'), appDatabasePassword: read.required('RW_APP_DATABASE_PASSWORD'), s3: read.s3(), logLevel: read.logLevel };
  read.done();
  if (config.appDatabasePassword.length < 16) throw new ConfigError('环境变量 RW_APP_DATABASE_PASSWORD 至少要 16 个字符');
  return config;
}
