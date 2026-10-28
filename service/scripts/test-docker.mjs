/**
 * Docker 后端测试（不进 npm test）：从空环境起服务，在 Compose 网络里的 tester 容器中跑 service/test，
 * 再核对各服务的日志每行都是 JSON。默认前后都清空容器与数据卷；加 --keep 则结束后保留环境。
 * 用法：node service/scripts/test-docker.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { capture, ensureEnv, root, run, up } from './docker.mjs';

const keep = process.argv.includes('--keep');
// worker 用小的单项超时、内存上限与换新项数，稳定触发超时、内存超限与子进程换新（票据 06）。
// 单项超时照 M302 的规则取（M349）：测试里最慢的正常一项是换新后第一项的 M402 与问候牌的重放，本机约 2 秒，不到 8 秒的三分之一；
// 16,000 项的压力牌要 17 秒左右，8 秒时内存约 340 MB，稳定超时而不是内存超限。1 亿像素的草稿在 512 MB 内放不下。
// 停止时 worker 排空本构建排队的批次项（票据 07）；测试结束时队列已空，宽限给 60 秒就够。
Object.assign(process.env, { RW_RENDER_TIMEOUT_MS: '8000', RW_WORKER_MEMORY: '512m', RW_RENDER_RECYCLE_AFTER: '5', RW_WORKER_STOP_GRACE: '60s' });
// 接口进程投递 webhook 给 tester 容器里的接收端（票据 11）：放开内网地址，退避与超时缩短，与用例的 TEST_WEBHOOK_CONFIG 一致。
Object.assign(process.env, { RW_WEBHOOK_ALLOW_PRIVATE: 'true', RW_WEBHOOK_POLL_MS: '20', RW_WEBHOOK_RETRY_BASE_MS: '150', RW_WEBHOOK_MAX_ATTEMPTS: '4', RW_WEBHOOK_TIMEOUT_MS: '600' });
ensureEnv();
run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
let status = 1;
try {
  const { build, image } = up();
  console.error(`服务已就绪：${image}`);
  status = spawnSync('docker', ['compose', '--profile', 'test', 'run', '--rm', '--build', 'tester'], { cwd: root, stdio: 'inherit' }).status ?? 1;

  // 结构化日志：接口进程、worker 与建桶步骤的每一行都是带服务名与构建标识的 JSON。
  const lines = capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', 'setup', 'api', 'worker']).split('\n').filter((line) => line.trim());
  const bad = lines.filter((line) => {
    try {
      const entry = JSON.parse(line);
      return !(typeof entry.level === 'number' && typeof entry.time === 'string' && typeof entry.msg === 'string' && ['setup', 'api', 'worker'].includes(entry.service) && entry.build === build);
    } catch { return true; }
  });
  console.error(`日志 ${lines.length} 行，不合格 ${bad.length} 行`);
  if (bad.length) { console.error(bad.slice(0, 5).join('\n')); status = 1; }
} finally {
  if (!keep) run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
}
process.exitCode = status;
