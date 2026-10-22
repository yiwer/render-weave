/** 通过公开轮次入口验证资料披露、运行时观测与恢复；不调用付费模型。 */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { runAgentTask, changeReview, type AgentRunOptions } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { repoRoot, resourcesDir, singleTextDir, greetingRequest } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const candidate = 'candidates/main.json';
const state = { stage: '骨架', summary: '已对齐三块区域', decisions: ['底色按原图'], remaining: ['长文本未测'], next: ['检查长文本'] };
const outcome = { candidates: [candidate], pending: [], notes: '尚需视觉核查' };
let base: string, workspace: string, template: unknown, count = 0;
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-context-'));
  workspace = join(base, 'workspace');
  await cp(singleTextDir, workspace, { recursive: true });
  template = { ...await json(join(workspace, 'template-greeting.json')), name: '问候新牌' };
  vi.stubEnv('RW_CONTEXT_TEST_KEY', 'local-test');
  await writeFile(join(base, 'brief.md'), '客户原文：保留问候字段，整体对齐示例图。');
  await writeFile(join(base, 'request.json'), JSON.stringify(greetingRequest({ template: '问候新牌' })));
});
afterAll(async () => { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); });
async function run(files: Record<string, unknown> = {}, options: Partial<AgentRunOptions> = {}) {
  const preset = join(base, 'preset-' + ++count);
  await mkdir(preset);
  for (const [path, value] of Object.entries(files)) {
    await mkdir(join(preset, path, '..'), { recursive: true });
    await writeFile(join(preset, path), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return runAgentTask({
    ...(!options.from ? { task: 'template-design', sample: join(resourcesDir, 'images/test/quadrants.png'), brief: join(base, 'brief.md'),
      resources: resourcesDir, workspace, dataset: 'ds-greeting', request: join(base, 'request.json'), domain: 'route-sign' } : {}),
    out: join(base, 'round-' + ++count), key: 'local-test', keyEnv: 'RW_TEST_KEY',
    claude: { command: process.execPath, args: [FAKE, preset] }, ...options,
  });
}
const response = (id: string, usage: unknown, content: unknown[] = []) => ({ type: 'assistant', message: { id, usage, content } });

it('短入口保留客户与基准，完整参考逐章无损可取，领域适用条件保留', async () => {
  const result = await run();
  const docs = join(result.roundDir, 'agent/docs');
  const prompt = await readFile(join(result.roundDir, 'logs/prompt.md'), 'utf8');
  expect(prompt.length).toBeLessThan(900);
  expect(prompt).toContain('已有数据集 ds-greeting');
  expect(prompt).not.toMatch(/全部文档|先读 docs\/ 下/);
  expect(await readFile(join(docs, 'brief.md'), 'utf8')).toBe('客户原文：保留问候字段，整体对齐示例图。');
  expect(await readdir(docs)).not.toContain('dsl-reference.md');
  expect(await readdir(docs)).not.toContain('guide.md');
  const core = await readFile(join(docs, 'core.md'), 'utf8');
  expect(core.length).toBeLessThan(1200);
  expect(core).toContain('template-guide.md');
  const guide = (await readFile(join(repoRoot, 'agent/guide.md'), 'utf8')).replaceAll('\r\n', '\n');
  const templateGuide = await readFile(join(docs, 'template-guide.md'), 'utf8');
  expect(templateGuide).toContain(guide.split('\n## 模板\n')[1]!.split('\n## ')[0]);
  expect(templateGuide).not.toContain('## 拆分');
  expect(templateGuide).not.toContain('## 转录');
  const index = await readFile(join(docs, 'dsl-index.md'), 'utf8');
  expect(index).toMatch(/SHA-256：[a-f0-9]{64}/);
  const chapters = (await readdir(join(docs, 'dsl'))).sort();
  const full = (await Promise.all(chapters.map((file) => readFile(join(docs, 'dsl', file), 'utf8')))).join('');
  expect(full).toBe((await readFile(join(repoRoot, 'agent/reference/template.md'), 'utf8')).replaceAll('\r\n', '\n'));
  const domain = await readFile(join(docs, 'domain-route-sign.md'), 'utf8');
  expect(domain).toContain('示例图上没有的元素');
  expect(domain).toContain('## 模板');
  expect(domain).not.toContain('## 数据定义与数据集');
  expect((await json(join(result.roundDir, 'agent/fake-run.json'))).args).toContain('--disable-slash-commands');
  expect(result.record.runtime.skills).toBe('disabled');
  expect(result.record.run.context?.peakInputTokens).toBeNull(); // 累计 result.usage 不能冒充单请求输入
});

it('按 message/tool ID 去重，缓存计入有效输入，压缩与图片体积分开记录', async () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300, output_tokens: 10 };
  const call = { type: 'tool_use', id: 'read-1', name: 'Read', input: {} };
  const toolResult = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1',
    content: [{ type: 'text', text: '你好abc' }, { type: 'image', source: { type: 'base64', data: 'AAAA' } }] }] } };
  const result = await run({ '.events.json': [
    { type: 'system', subtype: 'init', skills: [], plugins: [{ name: 'builtin' }], tools: ['Read'] },
    response('m1', usage, [call]), response('m1', { ...usage, output_tokens: 15 }, [call]), toolResult, toolResult,
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 600 } },
    response('m2', { input_tokens: 150, output_tokens: 4 }), response('m3', { output_tokens: 2 }),
  ] });
  const report = await json(join(result.roundDir, 'context.json'));
  expect(report).toMatchObject({ peakInputTokens: 600, limit: null,
    tools: { calls: 1, results: 1, textChars: 5, images: 1, encodedImageChars: 4 },
    compactions: [{ beforeTokens: 600 }], runtime: { skills: [], plugins: ['builtin'], tools: ['Read'] } });
  expect(report.requests).toEqual([
    { id: 'm1', inputTokens: 100, cacheReadTokens: 200, cacheCreationTokens: 300, outputTokens: 15, effectiveInputTokens: 600 },
    { id: 'm2', inputTokens: 150, outputTokens: 4, effectiveInputTokens: 150 }, { id: 'm3', outputTokens: 2 },
  ]);
  expect(result.record.run.context).toEqual({ requests: 3, peakInputTokens: 600, compactions: 1 });
  expect(result.record.run.contextStopped).toBeUndefined();
});

it.each([true, false])('达到阈值主动停止并续接；Agent 已保存成果=%s', async (saved) => {
  const first = await run({ [candidate]: template, 'state.json': state, ...(saved ? { 'outcome.json': outcome } : {}),
    '.events.json': [response('at-limit', { input_tokens: 20, cache_read_input_tokens: 80 })], '.wait-after-events': '' }, { contextLimit: 100 });
  expect(first.record.run.contextStopped).toEqual({ reason: 'contextLimit', limit: 100, observedInputTokens: 100 });
  expect(first.check.verdict).toBe('unqualified');
  expect(first.record.run.stopped).toBeUndefined();
  expect(first.record.run.error).toContain('handoff-feedback.md');
  expect(await readdir(join(first.roundDir, 'agent'))).not.toContain('continued-after-events');
  expect(await json(join(first.roundDir, candidate))).toEqual(template);
  expect(await json(join(first.roundDir, 'handoff.json'))).toMatchObject({ source: saved ? 'agent' : 'hostRecovery', reason: 'contextLimit', progress: state });
  if (!saved) {
    expect(first.outcome).toBeUndefined();
    expect(first.draft).toBe('draft.json');
    expect((await changeReview(first.roundDir, { type: 'approve' })).problems.length).toBeGreaterThan(0);
  }
  const second = await run({ 'outcome.json': outcome }, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  expect(await json(join(second.roundDir, 'agent', candidate))).toEqual(template);
  const handoff = await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8');
  expect(handoff).toContain(state.summary);
  expect(handoff).toContain('旧核查不表示本轮通过');
  expect(await readFile(join(second.roundDir, 'agent/docs/brief.md'), 'utf8')).toContain('客户原文');
  expect(second.check.verdict).toBe('qualified');
  expect(second.record.runtime.contextLimit).toBeNull();
});

it.each(['candidate', 'inputs', 'manifest'])('变更 %s 后不携带旧进度', async (change) => {
  const isolated = join(base, 'workspace-' + ++count);
  await cp(workspace, isolated, { recursive: true });
  const first = await run({ [candidate]: template, 'state.json': state, 'outcome.json': outcome }, { workspace: isolated });
  if (change === 'candidate') {
    await writeFile(join(first.roundDir, candidate), JSON.stringify({ ...(template as object), description: '人工修改' }));
    await expect(run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') })).rejects.toThrow('候选文件自成果生成后被改动');
    return;
  }
  if (change === 'inputs') await writeFile(join(isolated, 'note.json'), '{}');
  if (change === 'manifest') await writeFile(join(first.roundDir, 'handoff.json'), '{}');
  const second = await run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  const handoff = await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8');
  expect(handoff).toContain('失效或损坏');
  expect(handoff).not.toContain(state.summary);
});

it.each(['not json', { ...state, summary: 'x'.repeat(501) }, 'x'.repeat(24001)])('损坏或过大 state 不成为交接摘要', async (badState) => {
  const first = await run({ 'state.json': badState });
  const handoff = await json(join(first.roundDir, 'handoff.json'));
  expect(handoff.progress).toBeUndefined();
  expect(handoff.progressWarning).toBeTruthy();
});

it('CLI 非法预算在创建轮次/启动前失败', async () => {
  for (const value of ['0', '-1', '1.5', 'NaN']) {
    const out = join(base, 'invalid-' + ++count), stderr: string[] = [];
    const code = await runCli(['agent', 'run', '--task', 'template-design', '--out', out, '--context-limit=' + value,
      '--sample', 'unused.png', '--brief', 'unused.md', '--resources', resourcesDir, '--key-env', 'RW_CONTEXT_TEST_KEY'],
      { stdout: () => {}, stderr: (text) => { stderr.push(text); } });
    expect(code).not.toBe(0);
    expect(stderr.join('')).toContain('--context-limit 必须是正整数');
    await expect(readdir(out)).rejects.toThrow();
  }
});

it('审核中修改候选可续接，但旧进度失效', async () => {
  const pending = [{ file: candidate, path: '问候新牌/问候语', reason: 'inferred', note: '字号需确认' }];
  const first = await run({ [candidate]: template, 'state.json': state, 'outcome.json': { ...outcome, pending } });
  const original = await json(join(singleTextDir, 'template-greeting.json'));
  const edited = await changeReview(first.roundDir, { type: 'decide', item: 1, action: 'edit',
    value: { ...original.artboard.children[0], fontSize: 9 } });
  expect(edited.problems).toEqual([]);
  const second = await run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  expect(await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8')).toContain('失效或损坏');
  expect((await json(join(second.roundDir, 'agent', candidate))).artboard.children[0].fontSize).toBe(9);
});

it('资源内容替换而清单未变时，旧进度失效', async () => {
  const resources = join(base, 'mutable-resources');
  await mkdir(resources);
  await writeFile(join(resources, 'resources.json'), JSON.stringify({ resources: [{ id: 'image-a', kind: 'image', file: 'image.png' }] }));
  await cp(join(resourcesDir, 'images/test/quadrants.png'), join(resources, 'image.png'));
  const first = await run({ 'state.json': state }, { resources });
  await writeFile(join(resources, 'image.png'), 'changed bytes');
  const second = await run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  expect(await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8')).toContain('失效或损坏');
});

it('第三轮交接仍能读回第二轮反馈原文，约束不依赖 state', async () => {
  const first = await run({ [candidate]: template, 'outcome.json': outcome });
  const feedback = join(base, 'customer-feedback.md');
  await writeFile(feedback, '客户新增约束：标题字号固定 12 mm；不得改动底色。');
  const second = await run({ 'outcome.json': outcome, '.events.json': [response('stop-round2', { input_tokens: 100 })], '.wait-after-events': '' },
    { from: first.roundDir, feedback, contextLimit: 100 });
  expect(second.record.run.contextStopped).toBeDefined();
  const third = await run({}, { from: second.roundDir, feedback: join(second.roundDir, 'handoff-feedback.md') });
  expect(await readFile(join(third.roundDir, 'agent/docs/feedback-history/round-2.md'), 'utf8')).toBe(await readFile(feedback, 'utf8'));
  expect(await readFile(join(third.roundDir, 'agent/docs/feedback-history.md'), 'utf8')).toContain('未被取代的历史约束仍有效');
  expect(await readFile(join(third.roundDir, 'logs/prompt.md'), 'utf8')).toContain('docs/feedback-history.md');
});

it.each([true, false])('恢复草稿新增候选后旧进度失效；原本有候选=%s', async (hadCandidate) => {
  const first = await run({ 'state.json': state, ...(hadCandidate ? { [candidate]: template } : {}) });
  await writeFile(join(first.roundDir, 'agent/candidates/added.json'), JSON.stringify({ ...(template as object), name: '新增牌' }));
  const second = await run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  expect(await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8')).toContain('失效或损坏');
});

it('候选位于 .json 后缀目录仍保存轮次并可接续', async () => {
  const nested = 'candidates/nested.json/main.json';
  const first = await run({ [nested]: template, 'outcome.json': { ...outcome, candidates: [nested] }, 'state.json': state });
  expect(first.check.verdict).toBe('qualified');
  expect((await json(join(first.roundDir, 'handoff.json'))).workingCandidates).toEqual([{ path: nested, sha256: expect.any(String) }]);
  expect((await json(join(first.roundDir, 'round.json'))).run.handoffSha256).toBeTruthy();
  const second = await run({}, { from: first.roundDir, feedback: join(first.roundDir, 'handoff-feedback.md') });
  expect(await readFile(join(second.roundDir, 'agent/docs/handoff.md'), 'utf8')).toContain(state.summary);
});
