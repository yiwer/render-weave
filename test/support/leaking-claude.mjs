// 故意输出执行器拿到的令牌，用于验证宿主流脱敏；不用于证明文件权限。
import { writeFile, mkdir } from 'node:fs/promises';
const [observed, mode] = process.argv.slice(2);
for await (const _ of process.stdin) { /* 读完公开提示词 */ }
const token = process.env.ANTHROPIC_AUTH_TOKEN;
if (mode === 'resume') {
  await mkdir('candidates', { recursive: true });
  await writeFile('candidates/schema.json', JSON.stringify({ dslVersion: 'renderweave-schema/1', name: '恢复文字牌', fields: [{ name: 'message', type: 'text' }] }));
  await writeFile('outcome.json', JSON.stringify({ candidates: ['candidates/schema.json'], pending: [], notes: '失败后可接续候选' }));
}
await writeFile(observed, token);
const chunks = [token.slice(0, 13), token.slice(13, 29), token.slice(29)];
process.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"');
process.stderr.write('credential=');
for (const piece of chunks) { process.stdout.write(piece); process.stderr.write(piece); await new Promise(resolve => setTimeout(resolve, 10)); }
process.stdout.write('"}]}}\n'); process.stderr.write('\n');
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: mode === 'failure' || mode === 'resume', result: `diagnostic ${token}`, num_turns: 1, usage: { input_tokens: 12, output_tokens: 23 } }) + '\n');
if (mode === 'quota') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'api_retry', error: { type: 'GoUsageLimitError', metadata: { limitName: 'weekly' }, message: token } }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 30000));
  await writeFile('continued-after-quota', 'unexpected');
}
if (mode === 'timeout') {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', model: token, claude_code_version: 'test-runtime', mcp_servers: [] }) + '\n');
  await new Promise(resolve => setTimeout(resolve, 30000));
}