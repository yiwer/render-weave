/**
 * Docker 后端测试（不进 npm test）：从空环境起服务，在 Compose 网络里的 tester 容器中跑 service/test，
 * 再核对各服务的日志每行都是 JSON。默认前后都清空容器与数据卷；加 --keep 则结束后保留环境。
 * 用法：node service/scripts/test-docker.mjs [--keep]
 */
import { spawnSync } from 'node:child_process';
import { capture, ensureEnv, root, run, up } from './docker.mjs';

const keep = process.argv.includes('--keep');
// worker 用极小的单项超时、内存上限与换新项数，稳定触发超时、内存超限与子进程换新（票据 06）。
// 一般的预览远在这些值之内；1 亿像素的草稿在内存上限内放不下，6000 项的压力牌要好几秒但内存不多。
// 停止时 worker 排空本构建排队的批次项（票据 07）；测试结束时队列已空，宽限给 60 秒就够。
Object.assign(process.env, { RW_RENDER_TIMEOUT_MS: '1500', RW_WORKER_MEMORY: '512m', RW_RENDER_RECYCLE_AFTER: '5', RW_WORKER_STOP_GRACE: '60s' });
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
