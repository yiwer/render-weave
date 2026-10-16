// 假执行器：在流程测试中代替 Claude Code，不调用模型。
// 用法：node fake-claude.mjs <预置成果目录|none> [Claude Code 参数…]；提示词从标准输入读。
// 它把预置成果复制进工作目录，记录收到的参数、环境变量名（不记值）与提示词，再输出流式日志的初始化与结果消息。
// 预置目录里有 .api-error 时，模拟模型服务报错：结果消息带 is_error 与这段文字（Claude Code 的结束方式仍是 success）。
import { existsSync, readFileSync } from 'node:fs';
import { cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [preset, ...args] = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
await writeFile('fake-run.json', JSON.stringify({
  args, prompt, env: Object.keys(process.env).sort(),
  configDir: process.env.CLAUDE_CONFIG_DIR, model: process.env.ANTHROPIC_MODEL, baseUrl: process.env.ANTHROPIC_BASE_URL,
  hasToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
}));
if (preset !== 'none') await cp(preset, process.cwd(), { recursive: true });
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
write({ type: 'system', subtype: 'init', model: process.env.ANTHROPIC_MODEL, claude_code_version: 'fake-1', mcp_servers: [{ name: 'rw', status: 'connected' }] });
const apiError = preset !== 'none' && existsSync(join(preset, '.api-error')) ? readFileSync(join(preset, '.api-error'), 'utf8') : undefined;
if (apiError) write({ type: 'result', subtype: 'success', is_error: true, num_turns: 1, duration_ms: 300, result: apiError, usage: { input_tokens: 0, output_tokens: 0 } });
else write({ type: 'result', subtype: 'success', is_error: false, num_turns: 7, duration_ms: 1200,
  usage: { input_tokens: 11, output_tokens: 222, cache_read_input_tokens: 33, cache_creation_input_tokens: 44 } });
