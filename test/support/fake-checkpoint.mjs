// 假执行器只写工作副本，经真实 MCP 协议检查，随后等待宿主测试决定继续或强退。
import { spawn } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
const preset = process.argv[2];
for await (const _ of process.stdin) {}
await cp(preset, process.cwd(), { recursive: true });
const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.rw;
const mcp = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let sequence = 0;
createInterface({ input: mcp.stdout }).on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); });
const request = (method, params) => new Promise(resolve => {
  const id = ++sequence; pending.set(id, resolve); mcp.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params}) + '\n');
});
await request('initialize', {protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'checkpoint-fixture',version:'1'}});
const tools = await request('tools/list', {});
const reply = await request('tools/call', {name:'check_outcome',arguments:{}});
await writeFile('checkpoint-observed.json', JSON.stringify({ reply, tools, executorPid: process.pid,
  hasBridgeSecret: Boolean(process.env.RW_CHECKPOINT_HOST || process.env.RW_CHECKPOINT_TOKEN) }));
while (true) {
  try { await readFile('continue'); break; } catch {} await new Promise(resolve => setTimeout(resolve, 20));
}
mcp.stdin.end();
console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1}));
