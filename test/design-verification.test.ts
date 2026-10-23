import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { compareDesignImages, parseDesignCheckPlan, verifyTemplateDesign, render, loadWorkspace, runAgentTask, readReview, changeReview,
  type DesignCheckPlan, type Workspace } from '../src/index.js';
import { greetingRequest, loadSingleText, m402Dir, repoRoot, resourcesDir, singleTextDir, withTemplate } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const empty: DesignCheckPlan = { format: 'renderweave-design-checks/1', basis: '测试用人工尺寸范围，不作为项目通用字号', cases: [], styles: [] };
const plan: DesignCheckPlan = { ...empty, styles: [{ id: '问候', path: '问候牌/问候语', expect: { fontSize: { min: 9, max: 12 }, colors: ['#e60012'] } }] };
let workspace: Workspace, sample: Uint8Array, dir: string;
beforeAll(async () => {
  workspace = await loadSingleText();
  sample = (await render(workspace, greetingRequest())).image!.bytes;
  dir = await mkdtemp(join(tmpdir(), 'rw-design-check-'));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
const verify = (ws: Workspace, p = plan, dpi = 50) => verifyTemplateDesign({ workspace: ws, candidates: [],
  request: greetingRequest({ output: { width: 160, height: 40, dpi, format: 'png' } }), plan: p });

it.each([50, 100])('实际字号 5.5 mm 不达线、11 mm 达线，DPI %i 不改物理判断', async (dpi) => {
  const small = withTemplate(workspace, '问候牌', (d) => { d.artboard.children[0].fontSize = 5.5; });
  const good = withTemplate(workspace, '问候牌', (d) => { d.artboard.children[0].fontSize = 11; });
  expect((await verify(small, plan, dpi)).report).toMatchObject({ status: 'failed', failures: [{ path: '问候牌/问候语', message: expect.stringContaining('5.5') }] });
  expect((await verify(good, plan, dpi)).report.status).toBe('passed');
});

it('所有重复实例都会检查，遗漏路径不当作通过；报告未覆盖实例', async () => {
  const repeated = withTemplate(workspace, '问候牌', (d) => {
    const second = structuredClone(d.artboard.children[0]); second.name = '第二行'; second.fontSize = 5.5;
    d.artboard.children.push(second);
  });
  const all = await verify(repeated, { ...empty, styles: [{ id: '全部文字', path: '问候牌/*', minCount: 2, expect: { fontSize: { min: 9, max: 12 } } }] });
  expect(all.report.cases[0]?.checkedInstances).toBe(2);
  expect(all.report.failures.some((f) => f.path === '问候牌/第二行')).toBe(true);
  const missing = await verify(repeated, { ...empty, styles: [{ ...plan.styles[0]!, path: '问候牌/不存在' }] });
  expect(missing.report.status).toBe('failed');
  expect(missing.report.cases[0]?.uncoveredCount).toBe(2);
});

it('两站边界保留原可选徽标，触发子模板宽度问题；原数据不变', async () => {
  let ws = await loadWorkspace({ dir: m402Dir, resourcesDir });
  ws = withTemplate(ws, '站点', (d) => {
    const walk = (node: any) => { if (node.name === '标识行') { node.place.width = 'fill'; node.itemLayout.widths = 'equal'; } node.children?.forEach(walk); };
    walk(d.artboard);
  });
  ws = withTemplate(ws, '标识图标', (d) => { d.artboard.sizeRange.width = { min: 1, max: 100 }; });
  const original = JSON.stringify(ws.datasets);
  const { report } = await verifyTemplateDesign({ workspace: ws, candidates: [],
    request: { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 0 },
      output: { width: 740, height: 165, dpi: 50, format: 'png' } },
    plan: { ...empty, cases: [{ id: '两站+原徽标', changes: [{ path: '/stops', op: 'resize', length: 2 }] }] } });
  expect(report.cases[1]?.passed).toBe(false);
  expect(report.failures.some((f) => f.case === '两站+原徽标' && f.message.includes('render.sizeOutOfRange') && f.message.includes('标识行'))).toBe(true);
  expect(JSON.stringify(ws.datasets)).toBe(original);
});

it('相同图为 1，改色/缩字会降低得分，低分区域映射到元素并生成热图', async () => {
  const self = await compareDesignImages({ reference: sample, actual: sample, widthMm: 160, heightMm: 40 });
  expect(self.report.ssim).toBeCloseTo(1, 10);
  expect(self.report.rgbSimilarity).toBe(1);
  const bad = withTemplate(workspace, '问候牌', (d) => { d.artboard.children[0].fontSize = 5.5; d.artboard.children[0].color = '#0000ff'; });
  const rendered = await render(bad, greetingRequest());
  const diff = await compareDesignImages({ reference: sample, actual: rendered.image!.bytes, widthMm: 160, heightMm: 40, layout: rendered.layout!.root });
  expect(diff.report.ssim).toBeLessThan(0.99);
  expect(diff.report.rgbSimilarity).toBeLessThan(1);
  expect(diff.report.worstRegions?.some((r) => r.elements.includes('问候牌/问候语'))).toBe(true);
  expect(diff.heatmap?.length).toBeGreaterThan(100);
});

it('画板比例不符要求校准；图片哈希不符不使用错误参考', async () => {
  expect((await compareDesignImages({ reference: sample, actual: sample, widthMm: 160, heightMm: 80 })).report.status).toBe('alignmentRequired');
  const mismatch = await verifyTemplateDesign({ workspace, candidates: [], request: greetingRequest(), sample,
    plan: { ...empty, reference: { sha256: '0'.repeat(64) } } });
  expect(mismatch.report.status).toBe('failed');
  expect(mismatch.report.visual).toBeUndefined();
});

it('命名区域独立计分，保持核准状态；区域越界和重复 ID 被拒绝', async () => {
  const request = greetingRequest({ output: { width: 160, height: 40, dpi: 25.4, format: 'png' } });
  const before = await render(workspace, request);
  const after = await render(withTemplate(workspace, '问候牌', (d) => { d.artboard.children[0].color = '#0000ff'; }), request);
  const targets = [{ id: 'whole', goal: '测试区域，待核准', approval: 'proposed' as const, region: { x: 0, y: 0, width: 160, height: 40 } }];
  const compared = await compareDesignImages({ reference: before.image!.bytes, actual: after.image!.bytes, widthMm: 160, heightMm: 40,
    targets, layout: after.layout!.root });
  expect(compared.report.targets?.[0]).toMatchObject({ id: 'whole', approval: 'proposed', ssim: compared.report.ssim,
    rgbSimilarity: compared.report.rgbSimilarity, region: targets[0]!.region, elements: ['问候牌/问候语'] });
  await expect(compareDesignImages({ reference: before.image!.bytes, actual: after.image!.bytes, widthMm: 160, heightMm: 40,
    targets: [{ ...targets[0]!, region: { x: 159, y: 0, width: 2, height: 40 } }] })).rejects.toThrow('参考画板内');
  expect(() => parseDesignCheckPlan({ ...empty, reference: { sha256: hash(before.image!.bytes), targets: [...targets, ...targets] } })).toThrow('ID 重复');
});

it('MCP 默认只披露命名区域分数；按目标取完整证据，核准状态不创建像素门槛', async () => {
  const root = join(dir, 'targets'); await mkdir(join(root, 'candidates'), { recursive: true });
  const main = structuredClone(workspace.templates[0]!.document) as any;
  main.name = '命名区域'; main.artboard.children[0].color = '#0000ff';
  await writeFile(join(root, 'candidates/main.json'), JSON.stringify(main));
  await writeFile(join(root, 'outcome.json'), JSON.stringify({ candidates: ['candidates/main.json'], pending: [], notes: '目标诊断' }));
  const request = greetingRequest({ template: main.name, output: { width: 160, height: 40, dpi: 25.4, format: 'png' } });
  const picture = (await render(workspace, { ...request, template: '问候牌' })).image!.bytes;
  await writeFile(join(root, 'sample.png'), picture);
  const targets = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, goal: '目标'.repeat(150), approval: i ? 'approved' : 'proposed',
    region: { x: 0, y: 0, width: 160, height: 40 } }));
  const context = join(dir, 'targets-context.json');
  await writeFile(context, JSON.stringify({ task: 'template-design', request,
    designChecks: { plan: { ...empty, reference: { sha256: hash(picture), targets } }, sampleFile: join(root, 'sample.png') } }));
  const mcp = startMcp(['--workspace', singleTextDir, '--resources', resourcesDir, '--root', root, '--outcome-context', context]);
  try {
    const initial = await mcp.callJson('check_outcome');
    expect(initial.verdict).toBe('qualified');
    expect(initial.assessment.design.visual.targets).toHaveLength(12);
    expect(initial.assessment.design.visual.targets[0]).not.toHaveProperty('goal');
    expect(initial.assessment.design.visual.targets[0].ssim).toBeLessThan(1);
    const detail = await mcp.callJson('check_outcome', { designTarget: 'r0' });
    expect(detail.assessment.design.visual.targets).toEqual([expect.objectContaining({ id: 'r0', approval: 'proposed', goal: targets[0]!.goal,
      elements: ['命名区域/问候语'] })]);
    expect(JSON.stringify(detail.assessment.design).length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(initial.assessment.design).length).toBeLessThanOrEqual(8000);
    expect((await mcp.call('check_outcome', { designTarget: 'unknown' })).isError).toBe(true);
    expect((await mcp.call('check_outcome', { designTarget: 'r0', designCase: 'reference' })).isError).toBe(true);
  } finally { await mcp.close(); }
});

it('均匀灰度图 SSIM 与常量图的解析公式一致', async () => {
  const gray = async (color: string) => (await render(withTemplate(workspace, '问候牌', (d) => {
    d.artboard.children = []; d.artboard.fill = color;
  }), greetingRequest({ output: { width: 152.4, height: 50.8, dpi: 100, format: 'png' } }))).image!.bytes;
  // 整数像素画板，避免半像素边缘的透明度参与白底合成。
  const comparison = await compareDesignImages({ reference: await gray('#646464'), actual: await gray('#787878'), widthMm: 152.4, heightMm: 50.8 });
  expect(comparison.report.ssim).toBeCloseTo((2 * 100 * 120 + 6.5025) / (100 ** 2 + 120 ** 2 + 6.5025), 7);
  expect(comparison.report.rgbSimilarity).toBeCloseTo(1 - 20 / 255, 7);
});

it('候选、请求、数据、计划和资源变化均改变绑定指纹；未知路径不能静默忽略', async () => {
  const base = (await verify(workspace)).report.fingerprint;
  const changed = withTemplate(workspace, '问候牌', (d) => { d.artboard.children[0].fontSize = 5.5; });
  expect((await verify(changed)).report.fingerprint).not.toBe(base);
  expect((await verify(workspace, { ...plan, basis: '新基准' })).report.fingerprint).not.toBe(base);
  expect((await verify(workspace, plan, 100)).report.fingerprint).not.toBe(base);
  const datasets = workspace.datasets.map((d) => ({ ...d, document: { ...d.document, data: { message: '已修改' } } }));
  expect((await verify({ ...workspace, datasets })).report.fingerprint).not.toBe(base);
  const resources = { ...workspace.resources, list: () => workspace.resources.list(), read: async (id: string) => new Uint8Array([...(await workspace.resources.read(id)), 0]) };
  expect((await verify({ ...workspace, resources })).report.fingerprint).not.toBe(base);
  const invalid = await verify(workspace, { ...empty, cases: [{ id: '错误路径', changes: [{ path: '/missing', op: 'remove' }] }] });
  expect(invalid.report.status).toBe('failed');
  expect(() => parseDesignCheckPlan({ ...empty, cases: [{ id: 'reference' }] })).toThrow();
  expect(() => parseDesignCheckPlan({ ...empty, cases: [{ id: '坏字段', changes: [{ path: '/__proto__/polluted', op: 'set', value: true }] }] })).toThrow();
});

it('宿主计划进入成果和审核检查，接续保留；改计划被拒绝', async () => {
  const work = join(dir, 'work'); await cp(singleTextDir, work, { recursive: true });
  const candidate = structuredClone(workspace.templates[0]!.document) as any;
  candidate.name = '新问候牌'; candidate.artboard.children[0].fontSize = 5.5;
  const preset = join(dir, 'preset'); await mkdir(join(preset, 'candidates'), { recursive: true });
  await writeFile(join(preset, 'candidates/main.json'), JSON.stringify(candidate));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/main.json'], pending: [], notes: '检查全部实例' }));
  await writeFile(join(dir, 'sample.png'), sample);
  await writeFile(join(dir, 'brief.md'), '已有数据集，按示例做模板');
  await writeFile(join(dir, 'request.json'), JSON.stringify(greetingRequest({ template: '新问候牌' })));
  await writeFile(join(dir, 'checks.json'), JSON.stringify({ ...plan, styles: [{ ...plan.styles[0], path: '新问候牌/问候语' }], reference: { sha256: hash(sample) } }));
  const runtime = { key: 'local-test', keyEnv: 'RW_TEST', claude: { command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset] } };
  const first = await runAgentTask({ ...runtime, task: 'template-design', out: join(dir, 'round1'), workspace: work, resources: resourcesDir,
    dataset: 'ds-greeting', sample: join(dir, 'sample.png'), brief: join(dir, 'brief.md'), request: join(dir, 'request.json'), checks: join(dir, 'checks.json') });
  expect(first.check.verdict).toBe('unqualified');
  expect(first.check.assessment.design?.status).toBe('failed');
  const mcp = startMcp(['--workspace', join(first.roundDir, 'snapshot'), '--resources', resourcesDir, '--root', join(first.roundDir, 'agent'),
    '--outcome-context', join(first.roundDir, 'logs/outcome-context.json')]);
  try {
    const before = await mcp.callJson('check_outcome');
    expect(before.assessment.design.fingerprint).toBe(first.check.assessment.design?.fingerprint);
    const edited = structuredClone(candidate); edited.artboard.children[0].fontSize = 11;
    await writeFile(join(first.roundDir, 'agent/candidates/main.json'), JSON.stringify(edited));
    const after = await mcp.callJson('check_outcome');
    expect(after.assessment.design.status).toBe('passed');
    expect(after.assessment.design.fingerprint).not.toBe(before.assessment.design.fingerprint);
  } finally { await mcp.close(); }
  expect((await readReview(first.roundDir)).view?.design?.status).toBe('failed');
  await changeReview(first.roundDir, { type: 'confirmRest', confirmed: true });
  expect((await changeReview(first.roundDir, { type: 'approve' })).problems.length).toBeGreaterThan(0);
  await writeFile(join(dir, 'feedback.md'), '修正字号');
  candidate.artboard.children[0].fontSize = 11;
  await writeFile(join(preset, 'candidates/main.json'), JSON.stringify(candidate));
  const second = await runAgentTask({ ...runtime, from: first.roundDir, feedback: join(dir, 'feedback.md'), out: join(dir, 'round2') });
  expect(second.check.assessment.design?.status).toBe('passed');
  expect(second.record.inputs.checks?.sha256).toBe(first.record.inputs.checks?.sha256);
  await writeFile(join(first.roundDir, 'design-checks.json'), JSON.stringify(empty));
  expect((await readReview(first.roundDir)).problems[0]?.message).toContain('核查计划已变化');
  await expect(runAgentTask({ ...runtime, from: first.roundDir, feedback: join(dir, 'feedback.md'), out: join(dir, 'round3') })).rejects.toThrow('核查计划已变化');
});

it('长名称与24个用例仍能经MCP返回有界结论，并按用例取详情', async () => {
  const root = join(dir, 'large'); await mkdir(join(root, 'candidates'), { recursive: true });
  const main = structuredClone(workspace.templates[0]!.document) as any; main.name = '长名称核查';
  main.artboard.children = Array.from({ length: 12 }, (_, i) => ({ type: 'rect', name: String(i) + '长'.repeat(300), fill: '#000000',
    place: { left: i, top: 0, width: { fixed: 1 }, height: { fixed: 1 } } }));
  await writeFile(join(root, 'candidates/main.json'), JSON.stringify(main));
  await writeFile(join(root, 'outcome.json'), JSON.stringify({ candidates: ['candidates/main.json'], pending: [], notes: '有界摘要' }));
  await writeFile(join(root, 'sample.png'), sample);
  const p = { ...empty, cases: Array.from({ length: 23 }, (_, i) => ({ id: 'c' + i })) };
  const context = join(dir, 'large-context.json');
  await writeFile(context, JSON.stringify({ task: 'template-design', request: greetingRequest({ template: main.name }),
    designChecks: { plan: p, sampleFile: join(root, 'sample.png') } }));
  const mcp = startMcp(['--workspace', singleTextDir, '--resources', resourcesDir, '--root', root, '--outcome-context', context]);
  try {
    const summary = await mcp.callJson('check_outcome');
    expect(summary.verdict).toBe('qualified');
    expect(summary.assessment.design).toMatchObject({ status: 'passed', caseCount: 24, passedCases: 24 });
    expect(JSON.stringify(summary.assessment.design).length).toBeLessThanOrEqual(8000);
    const detail = await mcp.callJson('check_outcome', { designCase: 'c22' });
    expect(detail.assessment.design.cases).toHaveLength(1);
    expect(detail.assessment.design.cases[0].uncovered).toHaveLength(12);
    // 前面用例耗尽全局40项后，后面的样式失败仍可按用例取回。
    const failing = { ...p, styles: [{ id: '尺寸', path: '长名称核查/*', expect: { width: { min: 2, max: 3 } } }] };
    await writeFile(context, JSON.stringify({ task: 'template-design', request: greetingRequest({ template: main.name }),
      designChecks: { plan: failing, sampleFile: join(root, 'sample.png') } }));
  } finally { await mcp.close(); }
  const failingMcp = startMcp(['--workspace', singleTextDir, '--resources', resourcesDir, '--root', root, '--outcome-context', context]);
  try {
    const last = await failingMcp.callJson('check_outcome', { designCase: 'c22' });
    expect(last.assessment.design).toMatchObject({ status: 'failed', failureCount: 288 });
    expect(last.assessment.design.cases[0]).toMatchObject({ id: 'c22', passed: false, failureCount: 12 });
    expect(last.assessment.design.failures.length).toBeGreaterThan(0);
    expect(last.assessment.design.failures.every((f: { case: string; message: string }) => f.case === 'c22' && f.message.includes('width'))).toBe(true);
    expect(JSON.stringify(last.assessment.design).length).toBeLessThanOrEqual(8000);
  } finally { await failingMcp.close(); }
});
