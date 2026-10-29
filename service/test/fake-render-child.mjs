/**
 * 假的渲染子进程（child-runner.test.ts 用）：IPC 协议与 src/worker/render-child.ts 相同，就绪后一次收一项、交回一项。
 * 不渲染，结果里带上自己的 pid。request.then 决定交回之后做什么：
 * - exit：退出（两项之间崩溃）；
 * - disconnect：断开 IPC 但不退出，断开后写 request.marker；30 秒后自己退出，免得测试失败时留下进程。
 */
import { writeFileSync } from 'node:fs';

const exitOnDisconnect = () => process.exit(0);

process.on('message', (message) => {
  if (message?.type !== 'task') return;
  const { id, request } = message.task;
  process.send({ type: 'result', id, result: { problems: [], pid: process.pid } }, () => {
    if (request?.then === 'exit') process.exit(3);
    if (request?.then === 'disconnect') {
      process.off('disconnect', exitOnDisconnect);
      process.once('disconnect', () => writeFileSync(request.marker, ''));
      setTimeout(() => process.exit(0), 30_000);
      process.disconnect();
    }
  });
});
process.on('disconnect', exitOnDisconnect);
process.send({ type: 'ready' });
