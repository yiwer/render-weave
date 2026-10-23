import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { checkAgentOutcome, createLayoutReference, parseDesignCheckPlan, render, runAgentRepair, runAgentTask,
  type AgentRunOptions, type DesignCheckPlan, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { greetingRequest, loadSingleText, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

let root: string, workspace: Workspace, plan: DesignCheckPlan, options: AgentRunOptions;
let count = 0;
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = async (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rw-repair-'));
  workspace = await loadSingleText();
  const good = await render(workspace, greetingRequest());
  const reference = createLayoutReference(good.layout!, '测试人工核准：含完整文字和逐字字号颜色');
  plan = { format: 'renderweave-design-checks/1', basis: '公开测试', cases: [], styles: [], reference: { sha256: hash(good.image!.bytes) },
    repair: { approval: 'approved', regions: [{ id: '文字区', paths: reference.elements.map(e => e.path) }],
      references: [{ case: 'reference', geometry: true, reference }] } };
  await writeFile(join(root, 'sample.png'), good.image!.bytes);
  await writeFile(join(root, 'requirement.md'), '保持元素名称，对照参考修复。');
  await writeFile(join(root, 'brief.md'), '保持绑定，局部修复。');
  await json(join(root, 'checks.json'), plan);
  await json(join(root, 'request.json'), greetingRequest());
  options = { task: 'template-revision', out: '', key: 'local-test', keyEnv: 'RW_TEST', workspace: singleTextDir, resources: resourcesDir,
    requirement: join(root, 'requirement.md'), sample: join(root, 'sample.png'), brief: join(root, 'brief.md'), request: join(root, 'request.json'), checks: join(root, 'checks.json'), maxTurns: 20 };
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function preset(bad = false) {
  const dir = join(root, 'preset-' + count++); await mkdir(join(dir, 'candidates'), { recursive: true });
  const candidate = structuredClone(workspace.templates[0]!.document) as any;
  if (bad) candidate.artboard.children[0].fontSize = 3;
  await json(join(dir, 'candidates/main.json'), candidate);
  await json(join(dir, 'outcome.json'), { candidates: ['candidates/main.json'], pending: [], notes: '待人工审核' });
  return { dir, claude: { command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), dir] } };
}
async function check(dir: string, p = plan) {
  return checkAgentOutcome({ task: 'template-revision', agentDir: dir, workspace,
    context: { revision: { templates: ['问候牌'] }, request: { ...greetingRequest(), template: '问候牌' }, designChecks: { plan: p, sampleFile: join(root, 'sample.png') } } });
}

it('拒绝未核准、空参考、缺用例、路径重叠及未对齐片段；旧无 repair 计划仍合法', () => {
  const change = (fn: (p: any) => void) => { const p = structuredClone(plan); fn(p); return p; };
  for (const p of [
    change(p => { p.repair.approval = 'proposed'; }), change(p => { p.repair.references[0].reference.elements = []; }),
    change(p => { p.cases.push({ id: 'binding' }); }), change(p => { p.repair.regions.push(p.repair.regions[0]); }),
    change(p => { p.repair.references[0].reference.elements[0].characters.pop(); }), change(p => { delete p.reference; }),
  ]) expect(() => parseDesignCheckPlan(p)).toThrow();
  const { repair: _, ...old } = plan; expect(parseDesignCheckPlan(old)).toEqual(old);
});

it('只对新鲜且完整检查停止，未知墨迹框及骨架不能通过；技术 qualified 不是修复通过', async () => {
  const good = await preset(); const bad = await preset(true);
  expect((await check(good.dir)).assessment.repair).toMatchObject({ stop: true, failed: 0, unknown: 0, checked: 7 });
  const failed = await check(bad.dir);
  expect(failed.verdict).toBe('qualified'); expect(failed.assessment.repair).toMatchObject({ stop: false, reason: 'checksFailed' });
  const ink = structuredClone(plan); ink.repair!.references[0]!.reference.elements[0]!.boxKind = 'ink';
  expect((await check(good.dir, ink)).assessment.repair).toMatchObject({ stop: false, unknown: 2 });
  const empty = structuredClone(workspace.templates[0]!.document) as any; empty.artboard.children = [];
  await json(join(good.dir, 'candidates/main.json'), empty);
  expect((await check(good.dir)).assessment.repair?.stop).toBe(false);
});

it('MCP 短反馈两区域去重、不泄露完整参考；候选变动重新测量，按需详情仍有界', async () => {
  const p = await preset(true), context = join(root, 'mcp-context.json');
  await json(context, { task: 'template-revision', revision: { templates: ['问候牌'] }, request: greetingRequest(), designChecks: { plan, sampleFile: join(root, 'sample.png') } });
  const mcp = startMcp(['--workspace', singleTextDir, '--resources', resourcesDir, '--root', p.dir, '--outcome-context', context]);
  try {
    const before = await mcp.callJson('check_outcome');
    expect(before.assessment.repair.stop).toBe(false);
    expect(before.assessment.repair.feedback.length).toBeLessThanOrEqual(1200);
    expect(JSON.parse(before.assessment.repair.feedback.split('\n')[1])).toHaveLength(1);
    expect(before.assessment.design.repair).not.toHaveProperty('checks');
    expect(JSON.stringify(before.assessment)).not.toContain('characters');
    const detail = await mcp.callJson('check_outcome', { designCase: 'reference' });
    expect(JSON.stringify(detail.assessment.design).length).toBeLessThanOrEqual(8000);
    expect(detail.assessment.design.failures.some((f: any) => f.dimension === 'font')).toBe(true);
    await json(join(p.dir, 'candidates/main.json'), workspace.templates[0]!.document);
    const after = await mcp.callJson('check_outcome');
    expect(after.assessment.repair.stop).toBe(true);
    expect(after.assessment.repair.fingerprint).not.toBe(before.assessment.repair.fingerprint);
  } finally { await mcp.close(); }
});

it('原数据合格但绑定回归失败不能停止；三个区域只反馈两个且每区域只一项', async () => {
  const p = await preset(), variantRequest = greetingRequest({ dataset: { inline: { ...workspace.datasets[0]!.document, data: { message: '另一位用户' } } } });
  const variant = await render(workspace, variantRequest);
  const checks = structuredClone(plan);
  (checks as any).cases = [{ id: 'binding', changes: [{ path: '/message', op: 'set', value: '另一位用户' }] }];
  (checks.repair!.references as any[]).push({ case: 'binding', geometry: false, reference: createLayoutReference(variant.layout!, '绑定回归参考') });
  const d = structuredClone(workspace.templates[0]!.document) as any;
  d.artboard.children[0].content = [{ text: plan.repair!.references[0]!.reference.elements[0]!.text }];
  await json(join(p.dir, 'candidates/main.json'), d);
  const actual = await check(p.dir, checks);
  expect(actual.assessment.design?.repair?.checks.filter(c => c.id.startsWith('reference/')).every(c => c.pass)).toBe(true);
  expect(actual.assessment.repair?.stop).toBe(false);
  expect(actual.assessment.design?.repair?.checks.some(c => c.id.startsWith('binding/') && !c.pass)).toBe(true);

  // 已核准三处目标均有字号与颜色退化，不能把同一区域的两项挤满预算。
  const multiple = structuredClone(workspace.templates[0]!.document) as any;
  multiple.artboard.children = [0, 1, 2].map(i => ({ ...structuredClone(multiple.artboard.children[0]), name: '区域' + i }));
  const ws = { ...workspace, templates: [{ ...workspace.templates[0]!, document: multiple }] };
  const good = await render(ws, greetingRequest());
  const ref = createLayoutReference(good.layout!, '三个核准区域');
  const many = { ...plan, reference: { sha256: hash(good.image!.bytes) }, repair: { approval: 'approved' as const,
    regions: ref.elements.map(e => ({ id: e.path, paths: [e.path] })), references: [{ case: 'reference', geometry: true, reference: ref }] } };
  const sampleFile = join(root, 'multiple.png'); await writeFile(sampleFile, good.image!.bytes);
  for (const child of multiple.artboard.children) { child.fontSize = 3; child.color = '#0000ff'; }
  await json(join(p.dir, 'candidates/main.json'), multiple);
  const measured = await checkAgentOutcome({ task: 'template-revision', agentDir: p.dir, workspace,
    context: { revision: { templates: ['问候牌'] }, request: { ...greetingRequest(), template: '问候牌' }, designChecks: { plan: many, sampleFile } } });
  const feedback = measured.assessment.repair!.feedback;
  const items = JSON.parse(feedback.split('\n')[1]!);
  expect(items).toHaveLength(2); expect(new Set(items.map((i: any) => i.region)).size).toBe(2); expect(feedback.length).toBeLessThanOrEqual(1200);
});

it('显式自动修复完成即停止，完整参考不复制给 Agent，skills 仍禁用；手动接续可继续', async () => {
  const p = await preset();
  const result = await runAgentRepair({ ...options, claude: p.claude, out: join(root, 'complete') }, 2);
  expect(result.repairRun).toMatchObject({ reason: 'complete', maxRounds: 2, rounds: [{ stop: true }] });
  expect(await readdir(join(root, 'complete'))).not.toContain('round-2');
  expect(JSON.parse(await readFile(join(result.roundDir, 'agent/docs/design-checks.json'), 'utf8'))).not.toHaveProperty('repair');
  expect(JSON.parse(await readFile(join(result.roundDir, 'design-checks.json'), 'utf8'))).toHaveProperty('repair');
  expect(result.record.runtime.skills).toBe('disabled');
  await writeFile(join(root, 'manual-feedback.md'), '用户明确继续审核');
  const next = await runAgentTask({ key: 'local-test', keyEnv: 'RW_TEST', claude: p.claude, out: join(root, 'manual'),
    from: result.roundDir, feedback: join(root, 'manual-feedback.md') });
  expect(next.record.round).toBe(2);
  expect(JSON.parse(await readFile(join(next.roundDir, 'agent/previous/check.json'), 'utf8')).assessment.design.repair).not.toHaveProperty('checks');
  expect(JSON.parse(await readFile(join(result.roundDir, 'check.json'), 'utf8')).assessment.design.repair.checks).toHaveLength(7);
});

it('预算用尽与成功分开，固定修改预算；用交回后当前候选重算而非信任 MCP 的旧停止报告', async () => {
  const p = await preset();
  await json(join(p.dir, '.mcp-calls.json'), [{ name: 'check_outcome' }]);
  const changed = structuredClone(workspace.templates[0]!.document) as any; changed.artboard.children[0].fontSize = 3;
  await json(join(p.dir, '.after-mcp-files.json'), { 'candidates/main.json': changed });
  const result = await runAgentRepair({ ...options, claude: p.claude, out: join(root, 'budget') }, 2);
  expect(result.repairRun.reason).toBe('budget'); expect(result.repairRun.rounds).toHaveLength(2);
  expect(result.repairRun.rounds.every(r => !r.stop)).toBe(true);
  const answers = JSON.parse(await readFile(join(result.roundDir, 'agent/mcp-answers.json'), 'utf8'));
  expect(answers[0].assessment.repair.stop).toBe(true);
  expect(result.check.assessment.repair?.fingerprint).not.toBe(answers[0].assessment.repair.fingerprint);
  for (const round of result.repairRun.rounds) expect(JSON.parse(await readFile(join(round.dir, 'round.json'), 'utf8')).runtime.maxTurns).toBe(20);
});

it('运行中断及待人工确认时不续轮', async () => {
  const p = await preset(true); await writeFile(join(p.dir, '.max-turns'), '20');
  const interrupted = await runAgentRepair({ ...options, claude: p.claude, out: join(root, 'interrupted') }, 2);
  expect(interrupted.repairRun).toMatchObject({ reason: 'runtimeStopped', rounds: [{ stop: false }] });
  const pending = await preset();
  await json(join(pending.dir, 'outcome.json'), { candidates: ['candidates/main.json'], pending: [{ file: 'candidates/main.json', reason: 'inferred', note: '请人工核准' }], notes: '待审核' });
  const review = await runAgentRepair({ ...options, claude: pending.claude, out: join(root, 'pending') }, 2);
  expect(review.repairRun).toMatchObject({ reason: 'pendingReview', rounds: [{ stop: false }] });
});

it('宿主输入在执行期间变化，拒绝自动续轮或报告完成', async () => {
  const work = join(root, 'changing-work'); await cp(singleTextDir, work, { recursive: true });
  const p = await preset();
  const result = await runAgentRepair({ ...options, workspace: work, claude: p.claude, out: join(root, 'changed'),
    onStart: () => writeFileSync(join(work, 'changed.json'), '{}') }, 2);
  expect(result.repairRun).toMatchObject({ reason: 'inputsChanged' });
  expect(result.repairRun.rounds).toHaveLength(1);
});

it.each(['docs/brief.md', '../request.json', '../requirement.md'])('实际继承副本 %s 被改写时停止，不携带旧反馈续轮', async (file) => {
  const p = await preset(true);
  await json(join(p.dir, '.mcp-calls.json'), [{ name: 'check_outcome' }]);
  await json(join(p.dir, '.after-mcp-files.json'), { [file]: { changed: '不是启动时的输入' } });
  const result = await runAgentRepair({ ...options, claude: p.claude, out: join(root, 'copy-drift-' + count++) }, 2);
  expect(result.repairRun.reason).toBe('inputsChanged');
  expect(result.repairRun.rounds).toHaveLength(1);
});

it('第二轮反馈副本被改写，第三轮不会注入变化后的历史反馈', async () => {
  const p = await preset(true); let calls = 0;
  await json(join(p.dir, '.mcp-calls.json'), [{ name: 'check_outcome' }]);
  const result = await runAgentRepair({ ...options, claude: p.claude, out: join(root, 'feedback-drift'), onStart: () => {
    if (++calls === 2) writeFileSync(join(p.dir, '.after-mcp-files.json'), JSON.stringify({ '../feedback.md': '修改过的历史反馈' }));
  } }, 3);
  expect(result.repairRun.reason).toBe('inputsChanged'); expect(result.repairRun.rounds).toHaveLength(2);
  expect(calls).toBe(2);
});

it('已检查候选的归档副本后改，不把旧候选的反馈带入第三轮', async () => {
  const p = await preset(true); let calls = 0; const out = join(root, 'candidate-drift');
  const result = await runAgentRepair({ ...options, claude: p.claude, out, onStart: () => {
    if (++calls === 2) writeFileSync(join(out, 'round-1/candidates/main.json'), '{}');
  } }, 3);
  expect(result.repairRun.reason).toBe('inputsChanged'); expect(result.repairRun.rounds).toHaveLength(2);
});

it('无核准计划、非法预算在模型调用前拒绝；CLI 识别新选项', async () => {
  await expect(runAgentRepair({ ...options, checks: undefined, out: join(root, 'no-plan') }, 2)).rejects.toThrow('核准');
  await expect(runAgentRepair({ ...options, out: join(root, 'invalid') }, 5)).rejects.toThrow('1–4');
  process.env['RW_REPAIR_TEST_KEY'] = 'local-test';
  const errors: string[] = [];
  try {
    const code = await runCli(['agent', 'run', '--task', 'template-revision', '--sample', options.sample!, '--brief', options.brief!,
      '--resources', resourcesDir, '--out', join(root, 'cli'), '--key-env', 'RW_REPAIR_TEST_KEY', '--repair-rounds', '0'],
    { stdout: () => {}, stderr: text => errors.push(text) });
    expect(code).toBe(2); expect(errors.join('')).toContain('--repair-rounds 必须');
  } finally { delete process.env['RW_REPAIR_TEST_KEY']; }
});
