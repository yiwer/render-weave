/** 本轮检查桥与受管 MCP。令牌仅传入宿主拥有的 MCP 子进程；执行器只拿 stdio 转发地址。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer as pipeServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { CheckpointCheck } from './checkpoints.js';

export async function startCheckpointHost(options: { args: readonly string[]; env: NodeJS.ProcessEnv; check: () => Promise<CheckpointCheck> }) {
  const token = randomUUID(), name = `renderweave-${randomUUID()}`;
  const pipe = process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
  const children = new Set<ChildProcess>(), sockets = new Set<Socket>();
  const server = httpServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/check' || request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    let body = '';
    for await (const chunk of request) { body += String(chunk); if (body.length > 16) { response.writeHead(400).end(); return; } }
    if (body !== '{}') { response.writeHead(400).end(); return; }
    try { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(await options.check())); }
    catch { response.writeHead(500).end('宿主检查失败，未发布检查点'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('检查桥地址不可用');
  const bridge = pipeServer(socket => {
    sockets.add(socket);
    const child = spawn(process.execPath, [...options.args], { env: { ...options.env,
      RW_CHECKPOINT_HOST: `http://127.0.0.1:${address.port}/check`, RW_CHECKPOINT_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.add(child);
    // Windows 命名管道不能靠半关闭保留回包方向，输入 EOF 单独传递。
    const input = createInterface({ input: socket, crlfDelay: Infinity });
    input.on('line', line => {
      try {
        const frame = JSON.parse(line);
        if (frame.end === true) child.stdin.end();
        else if (typeof frame.data === 'string') child.stdin.write(Buffer.from(frame.data, 'base64'));
        else socket.destroy();
      } catch { socket.destroy(); }
    });
    child.stdout.pipe(socket); child.stderr.resume();
    child.on('error', () => socket.destroy());
    child.on('close', () => { children.delete(child); socket.end(); });
    socket.on('error', () => child.kill());
    socket.on('close', () => { sockets.delete(socket); child.kill(); });
    child.stdin.on('error', () => socket.destroy());
  });
  try { await new Promise<void>((resolve, reject) => { bridge.once('error', reject); bridge.listen(pipe, resolve); }); }
  catch (error) { server.close(); throw error; }
  return {
    config: { type: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./mcp-forward.js', import.meta.url)), pipe] },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const child of children) child.kill();
      await Promise.all([new Promise<void>(resolve => bridge.close(() => resolve())), new Promise<void>(resolve => server.close(() => resolve()))]);
    },
  };
}

/** 只有受管 MCP 的环境包含这对值；参数、判据与结果不从 Agent 请求读取。 */
export function managedOutcomeCheck(): (() => Promise<CheckpointCheck>) | undefined {
  const url = process.env.RW_CHECKPOINT_HOST, token = process.env.RW_CHECKPOINT_TOKEN;
  if (!url && !token) return undefined;
  if (!url || !/^http:\/\/127\.0\.0\.1:\d+\/check$/.test(url) || !token) throw new Error('受管检查桥配置不完整');
  return async () => {
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
    if (!response.ok) throw new Error('宿主检查未完成，未收到检查点保存完成信号');
    return await response.json() as CheckpointCheck;
  };
}
