/**
 * 渲染子进程（ADR-0017）：由调度进程 fork，经 IPC 一次收一项、交回一项的结果。
 * 自己连数据库与对象存储读租户的工作区与资源（配置与调度进程相同，经环境变量继承），只渲染，不写队列。
 * 启动时把 oom_score_adj 调到最高：容器内存不够时内核先结束它，调度进程活下来再起新的。
 */
import { writeFile } from 'node:fs/promises';
import type { TaskResult } from '../backend.js';
import { loadConfig } from '../config.js';
import { preloadRenderer } from '../engine.js';
import { createPostgresBackend } from '../postgres/backend.js';
import { createS3Client, s3Blobs } from '../postgres/blobs.js';
import { createDb } from '../postgres/db.js';
import { renderPreview } from '../preview.js';
import { failedResult } from './scheduler.js';

try { await writeFile('/proc/self/oom_score_adj', '1000'); } catch { /* 不是 Linux，或没有 /proc */ }

const config = loadConfig(process.env, { port: 8081 });
const backend = createPostgresBackend({ db: createDb(config.databaseUrl), blobs: s3Blobs(createS3Client(config.s3), config.s3.bucket), migrations: [] });
await preloadRenderer();

process.on('message', (message: { type?: string; id?: string; tenantId?: string; request?: unknown }) => {
  if (message?.type !== 'task') return;
  void (async () => {
    let result: TaskResult;
    try { result = await renderPreview(backend.tenant(message.tenantId!).storage, message.request); }
    catch (error) { result = failedResult(error); }
    process.send!({ type: 'result', id: message.id, result });
  })();
});
// 调度进程退出时子进程跟着退出。
process.on('disconnect', () => process.exit(0));
process.send!({ type: 'ready' });
