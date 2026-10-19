/**
 * 服务配置只从环境变量读取：数据库与对象存储的凭据不写进镜像与仓库（M259）。
 * 缺少或不合法时只列出变量名，从不输出取值。
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
  readonly databaseUrl: string;
  readonly s3: S3Config;
  readonly port: number;
  readonly logLevel: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { readonly port: number }): ServiceConfig {
  const missing: string[] = [];
  const required = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === '') missing.push(name);
    return value ?? '';
  };
  const config = {
    databaseUrl: required('RW_DATABASE_URL'),
    s3: {
      endpoint: required('RW_S3_ENDPOINT'),
      region: env['RW_S3_REGION'] || 'us-east-1',
      bucket: required('RW_S3_BUCKET'),
      accessKeyId: required('RW_S3_ACCESS_KEY_ID'),
      secretAccessKey: required('RW_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: env['RW_S3_FORCE_PATH_STYLE'] !== 'false',
    },
    port: env['RW_PORT'] ? Number(env['RW_PORT']) : defaults.port,
    logLevel: env['RW_LOG_LEVEL'] || 'info',
  };
  if (missing.length) throw new ConfigError(`缺少环境变量：${missing.join('、')}`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) throw new ConfigError('环境变量 RW_PORT 必须是 1–65535 的整数');
  return config;
}
