// 完整执行器边界：真实写候选、真实 MCP 检查，再输出适配器结构化调用与结果。
import { spawn } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
const preset = process.argv[2];
for await (const _ of process.stdin) {}
await cp(preset, process.cwd(), { recursive: true });
const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.rw;
const mcp = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map(); let sequence = 0, toolSequence = 0;
createInterface({ input: mcp.stdout }).on('line', line => { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); });
const request = (method, params) => new Promise(resolve => {
  const id = ++sequence; pending.set(id, resolve); mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const begin = (name, input) => {
  const id = `call-${++toolSequence}`;
  console.log(JSON.stringify({ type: 'assistant', message: { id: `message-${toolSequence}`, role: 'assistant', usage: { input_tokens: 10, output_tokens: 3 }, content: [{ type: 'tool_use', id, name, input }] } }));
  return id;
};
const end = (id, content) => console.log(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } }));
await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stagnation-fixture', version: '1' } });
const actions = JSON.parse(await readFile('actions.json', 'utf8'));
for (const action of actions) {
  if (action.kind === 'check') {
    const id = begin('mcp__rw__check_outcome', {});
    const reply = await request('tools/call', { name: 'check_outcome', arguments: {} });
    end(id, reply.result.content);
  } else if (action.kind === 'write') {
    const path = resolve('candidates/schema.json'), content = JSON.stringify({ dslVersion: 'renderweave-schema/1', name: '线路', fields: action.fields.map(name => ({ name, displayName: name, type: 'text' })) });
    const id = begin('Write', { file_path: path, content });
    await writeFile(path, content); end(id, `File created successfully at: ${path}`);
  } else if (action.kind === 'finish') {
    mcp.stdin.end();
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: toolSequence }));
    process.exit(0);
  }
}
await new Promise(() => {});
