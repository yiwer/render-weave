// 假执行器：在流程测试中代替 Claude Code，不调用模型。
// 用法：node fake-claude.mjs <预置成果目录|none> [Claude Code 参数…]；提示词从标准输入读。
// 它把预置成果复制进工作目录，记录收到的参数、环境变量名（不记值）与提示词，再输出流式日志的初始化与结果消息。
// 预置目录里有 .api-error 时，模拟模型服务报错：结果消息带 is_error 与这段文字（Claude Code 的结束方式仍是 success）。
// 预置目录里有 .max-turns 时，模拟用满轮数：结束方式 error_max_turns、is_error 为真、没有结果文字，轮数取文件内容。
// 预置目录里有 .model-calls.json 时，像 Claude Code 一样依次向 ANTHROPIC_BASE_URL 发 Messages 请求，响应写进 model-calls-result.json。
// 每项是 { body, token?, headers? }：token 为 "wrong" 时换一个错的令牌；body 中的 "{{tool_use_id}}" 换成上一次响应里第一个工具调用的 id。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';

const [preset, ...args] = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const token = process.env.ANTHROPIC_AUTH_TOKEN;
await writeFile('fake-run.json', JSON.stringify({
  args, prompt, env: Object.keys(process.env).sort(),
  configDir: process.env.CLAUDE_CONFIG_DIR, model: process.env.ANTHROPIC_MODEL, baseUrl: process.env.ANTHROPIC_BASE_URL,
  hasToken: Boolean(token), tokenSha256: token ? createHash('sha256').update(token).digest('hex') : null,
}));
if (preset !== 'none') await cp(preset, process.cwd(), { recursive: true });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ type: 'system', subtype: 'init', model: process.env.ANTHROPIC_MODEL, claude_code_version: 'fake-1', mcp_servers: [{ name: 'rw', status: 'connected' }] });
// 逐条发运行时事件；等待期间仍存活，供宿主停止/交接测试使用。
if (existsSync('.events.json')) for (const event of JSON.parse(readFileSync('.events.json', 'utf8'))) write(event);
if (existsSync('.wait-after-events')) {
  await new Promise((done) => setTimeout(done, 20000));
  await writeFile('continued-after-events', '运行时仍在继续');
}
// 错误事件后仍尝试继续运行，用于验证宿主主动停止，而不是假执行器自行退出。
if (existsSync('.runtime-error.json')) {
  const event = JSON.parse(readFileSync('.runtime-error.json', 'utf8'));
  write(event);
  await new Promise((done) => setTimeout(done, event.waitMs ?? 20000));
  await writeFile('continued-after-error', '运行时仍在继续');
}

const calls = preset !== 'none' && existsSync(join(preset, '.model-calls.json')) ? JSON.parse(readFileSync(join(preset, '.model-calls.json'), 'utf8')) : [];
const results = [];
let toolUseId;
for (const call of calls) {
  const body = JSON.stringify(call.body).replaceAll('{{tool_use_id}}', toolUseId ?? '');
  const base = new URL(process.env.ANTHROPIC_BASE_URL);
  const response = await new Promise((done, fail) => {
    const req = httpRequest({
      host: base.hostname, port: base.port, method: 'POST', path: '/v1/messages?beta=true',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${call.token === 'wrong' ? 'wrong-token' : token}`, 'x-claude-code-session-id': 'fake-session', ...call.headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => done({ status: res.statusCode, text }));
    });
    req.on('error', fail);
    req.end(body);
  });
  const events = response.text.startsWith('event:')
    ? response.text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.split('\n').find((line) => line.startsWith('data: ')).slice(6)))
    : undefined;
  const parsed = events ? undefined : JSON.parse(response.text);
  toolUseId = events?.find((event) => event.type === 'content_block_start' && event.content_block.type === 'tool_use')?.content_block.id
    ?? parsed?.content?.find((block) => block.type === 'tool_use')?.id ?? toolUseId;
  results.push({ status: response.status, ...(events ? { events } : { json: parsed }) });
}
if (calls.length > 0) await writeFile('model-calls-result.json', JSON.stringify(results, null, 2));

const apiError = preset !== 'none' && existsSync(join(preset, '.api-error')) ? readFileSync(join(preset, '.api-error'), 'utf8') : undefined;
const maxTurns = preset !== 'none' && existsSync(join(preset, '.max-turns')) ? Number(readFileSync(join(preset, '.max-turns'), 'utf8')) : undefined;
if (maxTurns !== undefined) write({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: maxTurns, duration_ms: 900, usage: { input_tokens: 5, output_tokens: 50 } });
else if (apiError) write({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, duration_ms: 300, result: apiError, usage: { input_tokens: 0, output_tokens: 0 } });
else write({ type: 'result', subtype: 'success', is_error: false, num_turns: 7, duration_ms: 1200,
  usage: { input_tokens: 11, output_tokens: 222, output_tokens_details: { thinking_tokens: 150 }, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
