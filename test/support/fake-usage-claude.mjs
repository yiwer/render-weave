// 受控执行器：按给定用量和结束原因交回成果，不调用模型。
import { cp, writeFile, access, readFile, appendFile } from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
if (process.argv.includes('--version')) { console.log('fake-usage-1'); process.exit(0); }
const parameters = process.argv.slice(2);
const [preset, usage, error, holdParameter] = parameters.slice(0, parameters.indexOf('-p') < 0 ? undefined : parameters.indexOf('-p'));
for await (const _ of process.stdin) { /* 消费提示词 */ }
if (preset !== 'none') await cp(preset, process.cwd(), {recursive: true});
const emit = value => console.log(JSON.stringify(value));
if (holdParameter?.startsWith('hold:')) {
  const config = JSON.parse(await readFile(process.argv[process.argv.indexOf('--mcp-config') + 1], 'utf8'));
  const server = config.mcpServers.rw;
  await new Promise((resolve, reject) => {
    const child = spawn(server.command, server.args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {stdout += chunk;});
    child.stderr.on('data', chunk => {stderr += chunk;});
    child.on('error', reject);
    child.on('close', code => {
      try {
        const reply = stdout.trim().split('\n').map(line => JSON.parse(line)).find(message => message.id === 2);
        if (code !== 0 || !reply?.result || reply.result.isError || reply.error) throw new Error(`MCP夹具失败：${stderr || stdout}`);
        resolve();
      } catch (error) {reject(error);}
    });
    child.stdin.end([ {jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'usage-fixture', version: '1'}}},
      {jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'list_resources', arguments: {}}} ].map(value => JSON.stringify(value) + '\n').join(''));
  });
  // 模拟进程退出时工具日志的最后一行只写了一部分；前面的完整调用仍必须计数。
  await appendFile(join(process.cwd(), '../logs/tools.jsonl'), '{"tool":');
  emit({type: 'user', message: {content: [{type: 'tool_result', content: '<persisted-output>controlled-runtime-result</persisted-output>'}]}});
}
emit({type: 'system', subtype: 'init', model: process.env.ANTHROPIC_MODEL, claude_code_version: 'fake-usage-1'});
if (usage === 'unknown') process.kill(process.pid, 'SIGKILL');
if (usage !== 'unknown') emit({type: 'result', subtype: 'success', is_error: !!error, result: error ?? '', num_turns: 2,
  usage: JSON.parse(usage)});

const hold = holdParameter?.startsWith('hold:') ? holdParameter.slice(5) : undefined;
if (hold) {
  const exists = await access(hold).then(() => true, () => false);
  if (!exists) {await writeFile(hold, JSON.stringify({pid: process.pid, host: process.ppid})); await new Promise(() => {setInterval(() => {}, 1000);});}
}
