/** 执行器启动的纯 stdio 转发器。令牌、输入依据与保存能力不进入这个进程。 */
import { connect } from 'node:net';
const socket = connect(process.argv[2]!);
socket.on('connect', () => {
  process.stdin.on('data', data => socket.write(`${JSON.stringify({ data: Buffer.from(data).toString('base64') })}\n`));
  process.stdin.on('end', () => socket.write('{"end":true}\n'));
  socket.pipe(process.stdout);
});
socket.on('error', () => { process.stderr.write('受管 MCP 连接不可用\n'); process.exitCode = 1; process.stdin.destroy(); });
socket.on('close', () => process.stdin.destroy());
