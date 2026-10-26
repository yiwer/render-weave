/** Tool Runner 执行器原型：经公开命令行与本机模型协议夹具验收，不启动 Claude Code。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyAgentRound, changeReview, readReview } from '../src/index.js';
import { loadCanvasKit } from '../src/canvaskit.js';
import { resourcesDir, repoRoot } from './support/fixtures.js';
import { nativeModelFixture } from './support/native-model-fixture.js';

let base: string;
beforeAll(async () => { await mkdir(join(repoRoot, 'test-output'), { recursive: true }); base = await mkdtemp(join(repoRoot, 'test-output', 'rw-tool-runner-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

const run = (args: readonly string[], key: string) => new Promise<{ code: number | null; output: string }>((resolve) => {
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), ...args], { cwd: repoRoot, windowsHide: true, env: { ...process.env, RW_TEST_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', (b) => { output += String(b); }); child.stderr.on('data', (b) => { output += String(b); });
  child.on('close', (code) => resolve({ code, output }));
});

it('Tool Runner 执行器拒绝工作目录外的读写，经受管 MCP 核对后交回，成果照常审核与应用', async () => {
  const out = join(base, 'round'), workspace = join(base, 'workspace'), secretFile = join(base, 'outside-secret.txt'), brief = join(base, 'brief.md');
  const secret = 'isolated-secret-tool-runner-do-not-share', key = 'isolated-model-key-tool-runner';
  await mkdir(workspace); await writeFile(secretFile, secret); await writeFile(brief, '按图提取文字牌的数据定义。');
  const agent = join(out, 'agent');
  const candidate = { dslVersion: 'renderweave-schema/1', name: '文字牌', fields: [{ name: 'message', displayName: '文字', type: 'text' }] };
  const fixture = await nativeModelFixture([
    [{ name: 'Read', input: { file_path: secretFile } }, { name: 'Write', input: { file_path: join(out, 'logs', 'outcome-context.json'), content: '{}' } }, { name: 'Write', input: { file_path: join(out, 'review.json'), content: '{"status":"approved"}' } }],
    [{ name: 'Read', input: { file_path: 'docs/brief.md' } }, { name: 'Glob', input: { pattern: 'docs/*.md' } }],
    [{ name: 'Write', input: { file_path: join(agent, 'candidates', 'schema.json'), content: JSON.stringify(candidate) } }, { name: 'Write', input: { file_path: 'outcome.json', content: JSON.stringify({ candidates: ['candidates/schema.json'], pending: [], notes: '提取了一个文字字段' }) } }],
    [{ name: 'mcp__rw__check_outcome', input: {} }],
  ]);
  try {
    const executed = await run(['agent', 'run', '--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', brief, '--resources', resourcesDir,
      '--workspace', workspace, '--out', out, '--key-env', 'RW_TEST_KEY', '--endpoint', fixture.endpoint, '--executor', 'tool-runner', '--max-turns', '12'], key);
    expect(executed.code, executed.output).toBe(0);
    const record = JSON.parse(await readFile(join(out, 'round.json'), 'utf8'));
    expect(record.runtime.executor).toBe('tool-runner');
    expect(record.verdict).toBe('qualified');
    expect(record.run).toMatchObject({ exitCode: 0, endedBy: 'success', turns: 5, inputTokens: 500, outputTokens: 100, mcp: ['rw:connected'] });

    // 工作目录外的读写全部拒绝，宿主文件不变，秘密不进入模型请求。
    // 每次请求都带完整历史，最后一次请求里有全部工具结果。
    const results: any[] = fixture.requests.at(-1).messages.filter((message: any) => Array.isArray(message.content))
      .flatMap((message: any) => message.content).filter((block: any) => block.type === 'tool_result');
    expect(results.filter((result) => result.is_error).map((result) => result.tool_use_id).sort()).toEqual(['tool_1_0', 'tool_1_1', 'tool_1_2']);
    expect(JSON.stringify(fixture.requests)).not.toContain(secret);
    expect(JSON.parse(await readFile(join(out, 'logs/outcome-context.json'), 'utf8')).task).toBe('definition-extraction');
    expect(JSON.stringify(results.find((result) => result.tool_use_id === 'tool_2_1')?.content)).toContain('docs/brief.md');
    expect(JSON.stringify(results.find((result) => result.tool_use_id === 'tool_4_0')?.content)).toContain('qualified');
    // 模型请求只经本轮代理：上游收到宿主的 key，执行器日志里没有它。
    expect(await readFile(join(out, 'logs/stream.jsonl'), 'utf8')).not.toContain(key);

    // 事件按 Claude Code 的形状记录，工具调用照常进入受管 MCP 的调用日志。
    const events = (await readFile(join(out, 'logs/stream.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init', executor: 'tool-runner' });
    expect(events.at(-1)).toMatchObject({ type: 'result', subtype: 'success', is_error: false, num_turns: 5 });
    expect(await readFile(join(out, 'logs/tools.jsonl'), 'utf8')).toContain('"tool":"check_outcome"');

    expect((await readReview(out)).view!.candidates[0]!.document).toMatchObject(candidate);
    await changeReview(out, { type: 'confirmRest', confirmed: true });
    expect((await changeReview(out, { type: 'approve' })).problems).toEqual([]);
    expect((await applyAgentRound({ roundDir: out })).problems).toEqual([]);
  } finally { await fixture.close(); }
}, 90000);

/** 最后一次模型请求里的全部图片：数量与 PNG 头里的宽高。 */
function requestImages(request: any): { width: number; height: number }[] {
  const found: { width: number; height: number }[] = [];
  const visit = (value: any): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'image') { const bytes = Buffer.from(value.source.data, 'base64'); found.push({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }); return; }
    Object.values(value).forEach(visit);
  };
  visit(request.messages);
  return found;
}

it('Read 读大图时缩到 2000 像素以内并说明原图尺寸，累计 21 张图后请求里每张图仍不超限', async () => {
  const out = join(base, 'large-image'), brief = join(base, 'large-image.md'), sample = join(base, 'large-sample.png');
  await writeFile(brief, '看图。');
  // 与 M402 示例图同量级：长边 3500 像素，超过一次请求超过 20 张图时的 2000 像素上限。
  const ck = await loadCanvasKit();
  const surface = ck.MakeSurface(3500, 800)!;
  surface.getCanvas().clear(ck.Color(200, 120, 40, 1));
  const snapshot = surface.makeImageSnapshot();
  await writeFile(sample, snapshot.encodeToBytes()!);
  snapshot.delete(); surface.delete();
  const fixture = await nativeModelFixture([
    Array.from({ length: 21 }, () => ({ name: 'Read', input: { file_path: 'sample.png' } })),
  ]);
  try {
    const executed = await run(['agent', 'run', '--task', 'definition-extraction', '--sample', sample, '--brief', brief, '--resources', resourcesDir,
      '--out', out, '--key-env', 'RW_TEST_KEY', '--endpoint', fixture.endpoint, '--executor', 'tool-runner', '--max-turns', '4'], 'isolated-key-large-image');
    expect(fixture.requests, executed.output).toHaveLength(2);
    const images = requestImages(fixture.requests[1]);
    expect(images).toHaveLength(21);
    expect(images.every((image) => image.width === 2000 && image.height === 457)).toBe(true);
    expect(JSON.stringify(fixture.requests[1].messages)).toContain('原图 3500×800 像素，缩小到 2000×457 返回');
    expect(JSON.parse(await readFile(join(out, 'round.json'), 'utf8')).run.error).toBeUndefined();
  } finally { await fixture.close(); }
}, 90000);

it('图片到 100 张上限后改用文字说明，不让请求超限', async () => {
  const out = join(base, 'many-images'), brief = join(base, 'many-images.md');
  await writeFile(brief, '看图。');
  const fixture = await nativeModelFixture([
    Array.from({ length: 101 }, () => ({ name: 'Read', input: { file_path: 'sample.png' } })),
  ]);
  try {
    const executed = await run(['agent', 'run', '--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', brief, '--resources', resourcesDir,
      '--out', out, '--key-env', 'RW_TEST_KEY', '--endpoint', fixture.endpoint, '--executor', 'tool-runner', '--max-turns', '4'], 'isolated-key-many-images');
    expect(fixture.requests, executed.output).toHaveLength(2);
    expect(requestImages(fixture.requests[1])).toHaveLength(100);
    const withheld = fixture.requests[1].messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
      .filter((block: any) => block.type === 'tool_result' && JSON.stringify(block.content).includes('这张图没有返回'));
    expect(withheld).toHaveLength(1);
  } finally { await fixture.close(); }
}, 90000);

it('Tool Runner 执行器用满轮数时按 error_max_turns 结束，不再请求模型，最后一轮已执行的工具照实记录', async () => {
  const out = join(base, 'max-turns'), brief = join(base, 'max-turns.md');
  await writeFile(brief, '提取图中文字。');
  const fixture = await nativeModelFixture([
    [{ name: 'Glob', input: { pattern: '*' } }],
    [{ name: 'Write', input: { file_path: 'scratch/late.txt', content: '不应写出' } }],
  ]);
  try {
    const executed = await run(['agent', 'run', '--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', brief, '--resources', resourcesDir,
      '--out', out, '--key-env', 'RW_TEST_KEY', '--endpoint', fixture.endpoint, '--executor', 'tool-runner', '--max-turns', '2'], 'isolated-key-max-turns');
    expect(executed.code, executed.output).toBe(1);
    const record = JSON.parse(await readFile(join(out, 'round.json'), 'utf8'));
    expect(record.run).toMatchObject({ endedBy: 'error_max_turns', turns: 2 });
    expect(record.run.error).toContain('用满了轮数上限');
    expect(fixture.requests).toHaveLength(2);
    const events = (await readFile(join(out, 'logs/stream.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const written = await readFile(join(out, 'agent/scratch/late.txt'), 'utf8').catch(() => undefined);
    const logged = events.some((event) => event.type === 'user' && event.message.content.some((block: any) => block.tool_use_id === 'tool_2_0'));
    expect(logged).toBe(written !== undefined);
  } finally { await fixture.close(); }
}, 60000);
