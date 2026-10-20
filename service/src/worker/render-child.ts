/**
 * 渲染子进程（ADR-0017）：由调度进程 fork，经 IPC 一次收一项、交回一项的结果。
 * 自己连数据库与对象存储读租户的工作区与资源（配置与调度进程相同，经环境变量继承），不写队列。
 * 预览只渲染；批次项（票据 07）按快照交付，先写对象，再在一个事务里登记这一项；重放（票据 08）读记录、重新渲染并比对。
 * 启动时把 oom_score_adj 调到最高：容器内存不够时内核先结束它，调度进程活下来再起新的。
 */
import { writeFile } from 'node:fs/promises';
import type { ClaimedTask, ItemResult, ReplayResult, TaskResult } from '../backend.js';
import { loadConfig } from '../config.js';
import { itemDeliverer } from '../delivery.js';
import { preloadRenderer } from '../engine.js';
import { createPostgresBackend } from '../postgres/backend.js';
import { createS3Client, s3Blobs } from '../postgres/blobs.js';
import { createDb } from '../postgres/db.js';
import { renderPreview } from '../preview.js';
import { replayItem } from '../records.js';
import { failedResult } from './scheduler.js';

try { await writeFile('/proc/self/oom_score_adj', '1000'); } catch { /* 不是 Linux，或没有 /proc */ }

const config = loadConfig(process.env, { port: 8081 });
const backend = createPostgresBackend({ db: createDb(config.databaseUrl), blobs: s3Blobs(createS3Client(config.s3), config.s3.bucket), migrations: [] });
const deliver = itemDeliverer();
await preloadRenderer();

process.on('message', (message: { type?: string; task?: ClaimedTask }) => {
  if (message?.type !== 'task' || !message.task) return;
  const task = message.task;
  void (async () => {
    let result: TaskResult | ItemResult | ReplayResult;
    const storage = backend.tenant(task.tenantId).storage;
    try {
      if (task.kind === 'preview') result = await renderPreview(storage, task.request);
      else result = task.kind === 'replay' ? await replayItem(storage, task) : await deliver(storage, task);
    }
    catch (error) { result = failedResult(error); }
    process.send!({ type: 'result', id: task.id, result });
  })();
});
// 调度进程退出时子进程跟着退出。
process.on('disconnect', () => process.exit(0));
process.send!({ type: 'ready' });
