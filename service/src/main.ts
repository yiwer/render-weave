/**
 * 服务入口：node service/dist/main.js <命令>
 * - api：执行数据库迁移后启动接口进程；
 * - worker：确认迁移与代码一致后启动渲染 worker 的调度进程；
 * - setup：部署时建好对象存储的桶（运行时只用读、写、取头信息、列举）；
 * - build-id：输出渲染器构建标识，镜像以它打标签（ADR-0019）。
 * 配置只从环境变量读取（M259）。日志是每行一个 JSON 对象。
 */
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import { createApi } from './api.js';
import { createS3Client, s3Blobs } from './blobs.js';
import { ConfigError, loadConfig } from './config.js';
import { createDb } from './db.js';
import { rendererBuildId } from './engine.js';
import { createLogger, type Logger } from './log.js';
import { loadMigrations, migrate } from './migrate.js';
import { createWorkerHealthServer, waitForMigrations } from './worker.js';

const command = process.argv[2];

async function main(): Promise<void> {
  if (command === 'build-id') {
    process.stdout.write(`${await rendererBuildId()}\n`);
    return;
  }
  if (command !== 'api' && command !== 'worker' && command !== 'setup') {
    process.stderr.write('用法：node service/dist/main.js api|worker|setup|build-id\n');
    process.exitCode = 2;
    return;
  }
  const build = await rendererBuildId();
  let logger: Logger = createLogger(command, build, process.env['RW_LOG_LEVEL'] || 'info');
  try {
    const config = loadConfig(process.env, { port: command === 'worker' ? 8081 : 8080 });
    logger = createLogger(command, build, config.logLevel);
    const s3 = createS3Client(config.s3);
    if (command === 'setup') return await setup(s3, config.s3.bucket, logger);
    const db = createDb(config.databaseUrl), blobs = s3Blobs(s3, config.s3.bucket), migrations = await loadMigrations();
    const deps = { db, blobs, migrations, build, logger };
    let close: () => Promise<void>;
    if (command === 'api') {
      const state = await migrate(db, migrations);
      logger.info({ schemaVersion: state.version, applied: state.applied }, '数据库迁移完成');
      const app = createApi(deps);
      await app.listen({ host: '0.0.0.0', port: config.port });
      close = () => app.close();
    } else {
      const schemaVersion = await waitForMigrations(deps, 60_000);
      const server = createWorkerHealthServer(deps);
      await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', resolve));
      logger.info({ schemaVersion, port: config.port }, 'worker 就绪，等待任务');
      close = () => new Promise((resolve) => server.close(() => resolve()));
    }
    const stop = async (signal: string) => {
      logger.info({ signal }, '收到停止信号');
      await close();
      await db.end();
      process.exit(0);
    };
    process.once('SIGTERM', () => void stop('SIGTERM'));
    process.once('SIGINT', () => void stop('SIGINT'));
  } catch (error) {
    logger.fatal({ err: error instanceof ConfigError ? { message: error.message } : error }, '启动失败');
    process.exitCode = 1;
  }
}

/** 建桶；对象存储刚起来时会拒绝连接，最多重试 60 秒。 */
async function setup(s3: ReturnType<typeof createS3Client>, bucket: string, logger: Logger): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
      logger.info({ bucket }, '已建桶');
      return;
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'BucketAlreadyOwnedByYou' || name === 'BucketAlreadyExists') {
        logger.info({ bucket }, '桶已存在');
        return;
      }
      if (Date.now() > deadline) throw error;
      logger.info({ reason: (error as Error).message }, '等待对象存储就绪');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

await main();
