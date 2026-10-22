// 本地协议回放：真实 runAgentTask + Claude Code + MCP；响应由脚本指定，不评价模型质量。
// node scripts/agent-context-probe.mjs --before <已构建基线> --after <已构建修改版> --claude <原生可执行文件> --out <新目录>
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => process.argv.slice(2 + i * 2, 4 + i * 2)));
for (const name of ['--before', '--after', '--claude', '--out']) if (!args[name]) throw new Error('缺少 ' + name);
const root = resolve(args['--out']), inputs = resolve(args['--after']);
await mkdir(root, { recursive: true });
const reports = [];
for (const variant of ['before', 'after']) {
  const repo = resolve(args['--' + variant]), out = join(root, variant), requests = [];
  const { runAgentTask } = await import(pathToFileURL(join(repo, 'dist/agent/run.js')).href);
  const read = (file, id) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: join(out, 'agent/docs', file) } });
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.url.includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 1 })); return;
      }
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(501); res.end(); return; }
      const index = requests.length;
      const system = JSON.stringify(body.system ?? []), messages = JSON.stringify(body.messages ?? []), tools = JSON.stringify(body.tools ?? []);
      const combined = system + messages + tools;
      requests.push({ index, systemChars: system.length, messageChars: messages.length, toolDefinitionChars: tools.length,
        totalTextEnvelopeChars: combined.length, tools: (body.tools ?? []).map((tool) => tool.name),
        toolErrors: (body.messages ?? []).flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result' && block.is_error).length,
        hasMattPluginMarkers: /mattpocock|matt-pocock|ask-matt|grill-with-docs|Two-axis review of the diff/i.test(combined),
        hasRootOwnerInstruction: combined.includes('你是这件事的 owner') });
      const initial = variant === 'before'
        ? ['brief.md', 'request.json', 'guide.md', 'domain-route-sign.md', 'outcome.md', 'dsl-reference.md']
        : ['brief.md', 'request.json', 'core.md', 'domain-route-sign.md', 'outcome.md', 'dsl-index.md'];
      // 相同目标：取回起步规则及文件结构/常见错误。after 只回读索引指向的前三章。
      const content = index === 0 ? initial.map((file, i) => read(file, 'initial-' + i))
        : variant === 'after' && index === 1 ? ['00', '01', '02'].map((number) => read('dsl/section-' + number + '.md', 'chapter-' + number))
          : [{ type: 'text', text: 'Local context capture completed; no design produced.' }];
      const stopReason = content[0].type === 'tool_use' ? 'tool_use' : 'end_turn';
      const message = { id: 'msg-probe-' + index, type: 'message', role: 'assistant', model: body.model,
        content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100 + index, output_tokens: 1 } };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, value) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...value }) + '\n\n');
      event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
      content.forEach((block, i) => {
        event('content_block_start', { index: i, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
        event('content_block_delta', { index: i, delta: block.type === 'tool_use'
          ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
        event('content_block_stop', { index: i });
      });
      event('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
      event('message_stop', {}); res.end();
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const result = await runAgentTask({ task: 'template-design',
      sample: join(inputs, 'fixtures/resources/images/test/quadrants.png'),
      brief: join(inputs, 'scripts/agent-eval/scenarios/m402/brief-template.md'),
      request: join(inputs, 'scripts/agent-eval/scenarios/m402/request-template.json'),
      workspace: join(inputs, 'docs/examples/m402-dsl'), resources: join(inputs, 'fixtures/resources'),
      domain: 'route-sign', dataset: 'ds-m402-wanguocheng', out,
      model: 'claude-haiku-5-5', maxTurns: 5, key: 'local-probe-not-a-secret', keyEnv: 'LOCAL_PROBE',
      endpoint: 'http://127.0.0.1:' + server.address().port, claude: { command: resolve(args['--claude']) } });
    const events = (await readFile(join(out, 'logs/stream.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init');
    const report = { variant, runtime: init?.claude_code_version, exitCode: result.record.run.exitCode,
      init: { skills: init?.skills, plugins: init?.plugins?.map((plugin) => plugin.name), tools: init?.tools, mcp: init?.mcp_servers },
      requests, result: events.find((event) => event.type === 'result')?.subtype };
    reports.push(report);
    console.log(JSON.stringify({ variant, requests: requests.map((request) => request.totalTextEnvelopeChars), skills: init?.skills?.length,
      tools: init?.tools?.length, mcp: init?.mcp_servers }));
  } finally { await new Promise((done) => server.close(done)); }
}
await writeFile(join(root, 'summary.json'), JSON.stringify({
  method: '真实 Claude Code/MCP、本地脚本端点；同一 M402 输入与资源，同一起步资料需求。无模型设计、无图像读取；sample 仅为有效输入占位图。无凭据/请求正文落库。',
  units: 'JSON 文本封套 UTF-16 字符数（含工具定义与历史），不是 token；响应 usage 为合成值，不可用于模型占用判断。',
  reports,
}, null, 2) + '\n');
if (reports.some((report) => report.exitCode !== 0 || report.requests.some((request) => request.toolErrors > 0) ||
  report.init.mcp?.find((server) => server.name === 'rw')?.status !== 'connected')) process.exitCode = 1;
