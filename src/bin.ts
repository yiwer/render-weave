#!/usr/bin/env node
import { runCli } from './cli.js';

const argv = process.argv.slice(2), controller = new AbortController();
// deliver 在项间响应 Ctrl+C：当前项完成并提交后停止。只监听一次，再按一次恢复默认行为，立即结束进程；其他命令保持默认。
if (argv[0] === 'deliver') {
  process.once('SIGINT', () => {
    process.stderr.write('收到中断：当前项完成并提交后停止；再按一次 Ctrl+C 立即结束\n');
    controller.abort();
  });
}
// agent review 在 Ctrl+C 时关闭审核页服务再退出；审核结果每次操作都已写入 review.json。
if (argv[0] === 'agent' && argv[1] === 'review') process.once('SIGINT', () => controller.abort());
if (argv[0] === 'agent' && argv[1] === 'run') {
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
}
// mcp 的标准输出只能有协议消息：其他输出一律改到标准错误流。
if (argv[0] === 'mcp') console.log = console.info = console.debug = console.warn = (...args: unknown[]) => console.error(...args);
process.exitCode = await runCli(argv, {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  signal: controller.signal,
  stdin: process.stdin,
});
