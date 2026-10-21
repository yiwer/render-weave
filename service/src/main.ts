/**
 * 服务入口：node service/dist/main.js <命令>
 * - setup：部署步骤。用属主账号执行数据库迁移、设置应用账号的密码，再建好对象存储的桶（M262）；
 * - api：等迁移与代码一致后启动接口进程，用应用账号连库；定期对账，退回崩溃后遗留的预占（票据 09）；
 *   投递 webhook：批次结束的事件签名后发给各 webhook，失败按退避重试（票据 11）；
 *   在 /console/ 下提供构建好的出图控制台（票据 12）；
 * - worker：等迁移与代码一致后启动渲染 worker 的调度进程：领取任务交给渲染子进程，超时结束子进程（ADR-0017）；
 *   收到 SIGTERM 时排空：不再领预览，做完本构建已接受的批次项再退出（票据 07）；
 * - platform-admin <邮箱>：建平台管理员账号，随机初始密码只在标准输出显示一次；
 * - build-id：输出渲染器构建标识，镜像以它打标签（ADR-0019）。
 * 配置只从环境变量读取（M259）。日志是每行一个 JSON 对象。
 */
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { createApi } from './api/app.js';
import { EmailTakenError } from './backend.js';
import { ConfigError, loadConfig, loadReconcileConfig, loadSetupConfig, loadWebhookConfig, loadWorkerConfig } from './config.js';
import { generatePassword, hashPassword } from './credentials.js';
import { rendererBuildId } from './engine.js';
import { createLogger, type Logger } from './log.js';
import { startReconciler } from './metering.js';
import { createPostgresBackend } from './postgres/backend.js';
import { createS3Client, s3Blobs } from './postgres/blobs.js';
import { createDb } from './postgres/db.js';
import { loadMigrations, migrate, setAppRolePassword, waitForMigrations } from './postgres/migrate.js';
import { childRunner } from './worker/child-runner.js';
import { createWorkerHealthServer } from './worker/health.js';
import { startScheduler } from './worker/scheduler.js';
import { startWebhookDispatcher } from './webhooks.js';

const [command, argument] = process.argv.slice(2);
const COMMANDS = ['setup', 'api', 'worker', 'platform-admin'] as const;

async function main(): Promise<void> {
  if (command === 'build-id') {
    process.stdout.write(`${await rendererBuildId()}\n`);
    return;
  }
  if (!COMMANDS.includes(command as never)) {
    process.stderr.write('用法：node service/dist/main.js setup|api|worker|build-id|platform-admin <邮箱>\n');
    process.exitCode = 2;
    return;
  }
  const build = await rendererBuildId();
  const service = command === 'worker' ? 'worker' : command === 'api' ? 'api' : 'setup';
  let logger: Logger = createLogger(service, build, process.env['RW_LOG_LEVEL'] || 'info');
  try {
    if (command === 'setup') {
      const config = loadSetupConfig(process.env);
      logger = createLogger('setup', build, config.logLevel);
      const owner = createDb(config.ownerDatabaseUrl);
      try {
        const state = await migrate(owner, await loadMigrations());
        logger.info({ schemaVersion: state.version, applied: state.applied }, '数据库迁移完成');
        await setAppRolePassword(owner, config.appDatabasePassword);
        logger.info('应用账号已可登录');
      } finally { await owner.end(); }
      await createBucket(createS3Client(config.s3), config.s3.bucket, logger);
      return;
    }

    const config = loadConfig(process.env, { port: command === 'worker' ? 8081 : 8080 });
    logger = createLogger(service, build, config.logLevel);
    const db = createDb(config.databaseUrl), migrations = await loadMigrations();
    const backend = createPostgresBackend({ db, blobs: s3Blobs(createS3Client(config.s3), config.s3.bucket), migrations });
    const schemaVersion = await waitForMigrations(db, migrations, 60_000, (reason) => logger.info({ reason }, '等待数据库就绪'));

    if (command === 'platform-admin') {
      if (!argument) throw new ConfigError('用法：platform-admin <邮箱>');
      const password = generatePassword();
      try {
        const user = await backend.platform.createPlatformUser(argument, await hashPassword(password));
        await backend.platform.appendAudit({ actor: { kind: 'system', id: 'cli', label: '命令行' }, action: 'platformUser.create', object: { type: 'platformUser', id: user.id }, crossTenant: false }, new Date());
        logger.info({ userId: user.id }, '已建平台管理员');
        process.stdout.write(`平台管理员 ${user.email} 的初始密码（只显示这一次）：${password}\n`);
      } catch (error) {
        if (error instanceof EmailTakenError) throw new ConfigError('这个邮箱已有账号');
        throw error;
      } finally { await db.end(); }
      return;
    }

    let close: () => Promise<void>;
    if (command === 'api') {
      const reconcile = loadReconcileConfig(process.env), webhooks = loadWebhookConfig(process.env);
      // 出图控制台（票据 12）：service/dist/console，由 service 的 npm run build 构建。
      const app = createApi({
        backend, build, logger, secretKey: webhooks.secretKey, allowPrivateWebhooks: webhooks.config.allowPrivate,
        consoleDir: fileURLToPath(new URL('./console/', import.meta.url)),
      });
      await app.listen({ host: '0.0.0.0', port: config.port });
      const reconciler = startReconciler({ backend, logger, ...reconcile });
      const dispatcher = startWebhookDispatcher({ backend, logger, secretKey: webhooks.secretKey, config: webhooks.config });
      logger.info({ schemaVersion, port: config.port, ...reconcile, webhooks: webhooks.config }, '接口进程就绪');
      close = async () => {
        await dispatcher.stop();
        await reconciler.stop();
        await app.close();
      };
    } else {
      const worker = loadWorkerConfig(process.env);
      const runner = childRunner({ script: fileURLToPath(new URL('./worker/render-child.js', import.meta.url)), timeoutMs: worker.renderTimeoutMs, recycleAfter: worker.recycleAfter, logger });
      // 批次项的租约比单项超时多一分钟：过了还没写回，说明这个 worker 中途退出了，同构建的 worker 可以重领。
      const scheduler = startScheduler({ backend, runner, logger, pollMs: worker.pollMs, workerId: `${hostname()}:${process.pid}`, build, leaseMs: worker.renderTimeoutMs + 60_000 });
      const server = createWorkerHealthServer({ backend, build, logger, stats: runner.stats });
      await new Promise<void>((resolve) => server.listen(config.port, '0.0.0.0', resolve));
      logger.info({ schemaVersion, port: config.port, ...worker }, 'worker 就绪，等待任务');
      close = async () => {
        logger.info('排空：不再领预览，做完本构建已接受的批次项再退出');
        await scheduler.drain();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      };
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
async function createBucket(s3: S3Client, bucket: string, logger: Logger): Promise<void> {
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
