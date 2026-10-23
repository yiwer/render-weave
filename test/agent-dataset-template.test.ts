/**
 * 数据集提取与模板辅助设计（第三阶段票据 06、验收 A07、A08、A09）：用假执行器造出两种轮次，
 * 经公开入口审核、应用，断言 RenderWeave 重新渲染的预览、待确认项未处理完之前不能写入数据集（M46）、
 * 写入工作区的内容，以及之后经交付入口正式出图。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  AgentUsageError, applyAgentRound, changeReview, deliverBatch, importResources, initializeResourceStore, loadWorkspace, openVersionedResourceStore,
  publishStaticSchema, readOutputRecord, readReview, render, runAgentTask, startReviewServer,
  type AgentRunOptions, type ReviewView, type StaticSchemaEntry, type VersionedResourceStore,
} from '../src/index.js';
import { copyWorkspaceFixture, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const KEY = `rw-test-key-${Math.random().toString(36).slice(2)}`;
const SCHEMA = 'renderweave-schema/1', TEMPLATE = 'renderweave-template/1';

const SESSION = { dslVersion: SCHEMA, name: '场次', fields: [{ name: 'title', displayName: '标题', type: 'text', constraints: { required: true, maxLength: 10 } }] };
const BADGE = { dslVersion: SCHEMA, name: '胸牌', fields: [
  { name: 'fullName', displayName: '姓名', type: 'text', constraints: { required: true, maxLength: 12 } },
  { name: 'sessions', displayName: '场次', type: 'list', items: { type: 'ref', ref: { name: '场次', version: 1 } }, constraints: { maxItems: 3 } },
  { name: 'tags', displayName: '标签', type: 'list', items: { type: 'text' }, constraints: { maxItems: 3 } },
] };
const text = (name: string, slot: string, place: Record<string, unknown>) =>
  ({ type: 'text', name, content: [{ slot }], font: 'res:font-hei-medium', fontSize: 8, color: '#000000', verticalAlign: 'center', place });
const CARD = { dslVersion: TEMPLATE, name: '胸牌卡', base: { name: '胸牌', version: 1 }, artboard: {
  sizeRange: { width: { min: 50, max: 300 }, height: { min: 20, max: 200 } }, fill: '#FFFFFF', layout: { mode: 'free' },
  children: [text('姓名', 'fullName', { left: 5, top: 5, width: { fixed: 90 }, height: { fixed: 12 } })],
} };
const CARD_REQUEST = { template: '胸牌卡', parameters: {}, output: { width: 100, height: 30, dpi: 50, format: 'png' }, mode: 'final' };

const DATASET = { dataset: { id: 'badge-li', name: '李雷的胸牌', staticSchema: { name: '胸牌', version: 1 } },
  data: { fullName: '李雷', sessions: [{ title: '开幕式' }, {}], tags: ['VIP'] } };
const DATASET_FILE = 'candidates/dataset-badge-li.json';
const DATASET_SUBMISSION = {
  candidates: [DATASET_FILE],
  locations: [
    { file: DATASET_FILE, path: 'fullName', where: '正中的姓名', region: { x: 4, y: 4, width: 20, height: 10 } },
    { file: DATASET_FILE, path: 'sessions[1]', where: '底部场次表第一行' },
  ],
  pending: [
    { file: DATASET_FILE, path: 'sessions[2].title', candidate: '闭幕式', reason: 'unreadable', note: '第二场被挂绳挡住一半' },
    { file: DATASET_FILE, path: 'tags', candidate: ['VIP'], reason: 'inferred', note: '图上的金色角标推断为 VIP' },
    { file: DATASET_FILE, path: 'fullName', reason: 'conflicting', note: '姓名与项目说明中的名单不一致' },
  ],
  notes: '按示例图转录。',
};

const BANNER_FILE = 'candidates/template-banner.json', WORDS_FILE = 'candidates/template-banner-words.json';
const BANNER = { dslVersion: TEMPLATE, name: '问候横幅', base: { name: '问候', version: 1 }, artboard: {
  sizeRange: { width: { min: 100, max: 300 }, height: { min: 20, max: 100 } }, layout: { mode: 'free' },
  children: [
    { type: 'rect', name: '底色', fill: '#FFF4E0', place: { left: 0, top: 0, width: { fixed: 200 }, height: { fixed: 50 } } },
    { type: 'call', name: '文字区', template: '横幅文字', data: 'current', place: { left: 10, top: 10, width: { fixed: 180 }, height: { fixed: 30 } } },
  ],
} };
const WORDS = { dslVersion: TEMPLATE, name: '横幅文字', base: { name: '问候', version: 1 }, artboard: {
  sizeRange: { width: { min: 50, max: 300 }, height: { min: 10, max: 100 } }, layout: { mode: 'free' },
  children: [text('问候语', 'message', { left: 0, top: 0, width: { fixed: 180 }, height: { fixed: 30 } })],
} };
const BANNER_REQUEST = { template: '问候横幅', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 200, height: 50, dpi: 50, format: 'png' }, mode: 'final' };
const TEMPLATE_SUBMISSION = {
  candidates: [BANNER_FILE, WORDS_FILE],
  locations: [{ file: BANNER_FILE, path: '问候横幅/文字区', where: '中部的问候语', region: { x: 10, y: 10, width: 100, height: 20 } }],
  pending: [{ file: BANNER_FILE, path: '问候横幅/底色', candidate: '#FFE8E8', reason: 'inferred', note: '底色按示例图估计' }],
  notes: '主模板调用文字子模板。',
};
const PINK = { ...BANNER.artboard.children[0], fill: '#FFE8E8' };

let base: string, storeDir: string, store: VersionedResourceStore;
let count = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-agent06-'));
  await writeFile(join(base, 'brief.md'), '# 项目说明：示例\n');
  // 交付入口要求版本化的资源仓库：Agent 轮次、审核预览与正式出图都用同一个。
  storeDir = join(base, 'resources');
  expect((await initializeResourceStore(storeDir)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: storeDir })).problems).toEqual([]);
  store = (await openVersionedResourceStore(storeDir)).store!;
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 工作区：single-text 的问候，加上已发布的场次 v1、胸牌 v1 与模板胸牌卡。 */
async function workspace(): Promise<string> {
  const dir = join(base, `workspace-${++count}`);
  await copyWorkspaceFixture(singleTextDir, dir);
  const published: StaticSchemaEntry[] = [];
  for (const [stem, definition] of [['session', SESSION], ['badge', BADGE]] as const) {
    const result = publishStaticSchema(definition, published);
    expect(result.problems).toEqual([]);
    published.push(result.published!);
    await writeFile(join(dir, `schema-${stem}-v1.json`), JSON.stringify(result.published!.definition, null, 2));
    await writeFile(join(dir, `compiled-${stem}-v1.schema.json`), JSON.stringify(result.published!.compiled, null, 2));
  }
  await writeFile(join(dir, 'template-card.json'), JSON.stringify(CARD, null, 2));
  return dir;
}

async function file(name: string, value: unknown): Promise<string> {
  const path = join(base, `${++count}-${name}`);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

function run(files: Record<string, unknown>, options: Partial<AgentRunOptions> & Pick<AgentRunOptions, 'task'>) {
  return (async () => {
    const preset = join(base, `preset-${++count}`);
    for (const [path, value] of Object.entries(files)) {
      await mkdir(join(preset, path, '..'), { recursive: true });
      await writeFile(join(preset, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    }
    return runAgentTask({
      sample: join(resourcesDir, 'images/test/quadrants.png'), brief: join(base, 'brief.md'), resources: storeDir, out: join(base, `round-${++count}`),
      key: KEY, keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] }, ...options,
    });
  })();
}

const datasetRound = async (dir: string, submission: unknown = DATASET_SUBMISSION, dataset: unknown = DATASET) => run(
  { 'outcome.json': submission, [DATASET_FILE]: dataset, 'scratch/agent-preview.png': 'Agent 自己的图' },
  { task: 'dataset-extraction', workspace: dir, definition: '胸牌', request: await file('card-request.json', CARD_REQUEST) });
const templateRound = async (dir: string, submission: unknown = TEMPLATE_SUBMISSION, banner: unknown = BANNER) => run(
  { 'outcome.json': submission, [BANNER_FILE]: banner, [WORDS_FILE]: WORDS },
  { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request: await file('banner-request.json', BANNER_REQUEST) });

async function decide(dir: string, changes: unknown[]): Promise<ReviewView> {
  let view: ReviewView | undefined;
  for (const change of changes) {
    const result = await changeReview(dir, change);
    expect(result.problems).toEqual([]);
    view = result.view;
  }
  return view!;
}

const codes = (problems: readonly { code: string }[]) => problems.map((problem) => problem.code);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('发起数据集提取与模板辅助设计', () => {
  it('正常轮次固定参考输入并保存真实提示词、资料与比较报告；下一轮拒绝被篡改的参考', async () => {
    const dir = await workspace();
    const reference = await file('reference.json', { sampleWidthPx: 8, sampleHeightPx: 8, artboardWidthMm: 200, artboardHeightMm: 50, approvedRegions: [] });
    const sampleBytes = await readFile(join(resourcesDir, 'images/test/quadrants.png'));
    const dimensions = await import('../src/index.js').then(({ readPngInfo }) => readPngInfo(sampleBytes));
    await writeFile(reference, JSON.stringify({ sampleWidthPx: dimensions.width, sampleHeightPx: dimensions.height, artboardWidthMm: 200, artboardHeightMm: 50, approvedRegions: [] }));
    const round = await run({ 'outcome.json': TEMPLATE_SUBMISSION, [BANNER_FILE]: BANNER, [WORDS_FILE]: WORDS },
      { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request: await file('reference-request.json', BANNER_REQUEST), reference });
    const known = await json(join(round.roundDir, 'logs/outcome-context.json'));
    expect(known.baseline.sampleSha256).toBe(round.record.inputs.sample.sha256);
    expect(known.referenceImage.path).toContain('logs');
    expect(round.check.assessment.visual?.status).toBe('notChecked');
    const provenance = await json(join(round.roundDir, 'logs/provenance.json'));
    expect(provenance.mcpContract).toBe('0.16.0'); expect(provenance.engine).toMatch(/^sha256:/);
    expect(provenance.actualMaterials['materials/guide.md']).toHaveLength(64);
    expect(await readFile(join(round.roundDir, 'logs/prompt.md'), 'utf8')).toBe((await json(join(round.roundDir, 'agent/fake-run.json'))).prompt);
    await writeFile(join(round.roundDir, 'logs/reference.json'), '{}');
    await expect(run({}, { task: undefined, from: round.roundDir, sample: undefined, brief: undefined, resources: undefined, feedback: join(base, 'brief.md') })).rejects.toThrow('参考资料已改变');
  });
  it('任务顺序与输入：数据集提取要已发布的数据定义，模板辅助设计要已保存的数据集与出图请求', async () => {
    const dir = await workspace();
    const request = await file('card-request.json', CARD_REQUEST);
    const banner = await file('banner-request.json', BANNER_REQUEST);
    const cases: [Partial<AgentRunOptions> & Pick<AgentRunOptions, 'task'>, string][] = [
      [{ task: 'dataset-extraction', workspace: dir }, '先做数据定义提取'],
      [{ task: 'dataset-extraction', definition: '胸牌' }, '要用 --workspace 指定'],
      [{ task: 'dataset-extraction', workspace: dir, definition: '会员卡' }, '工作区中没有已发布的数据定义 会员卡'],
      [{ task: 'dataset-extraction', workspace: dir, definition: '胸牌@2' }, '可用：场次@1、胸牌@1、问候@1'],
      [{ task: 'dataset-extraction', workspace: dir, definition: '胸牌', request: banner }, '出图请求的模板 问候横幅 不在工作区中'],
      [{ task: 'dataset-extraction', workspace: dir, definition: '场次', request }, '出图请求的模板 胸牌卡 的基准不是 场次 v1'],
      [{ task: 'template-design', workspace: dir, definition: '问候', request: banner }, '先做数据集提取并应用'],
      [{ task: 'template-design', workspace: dir, dataset: 'ds-greeting' }, '要用 --request'],
      [{ task: 'template-design', workspace: dir, dataset: 'ds-none', request: banner }, '工作区中没有数据集 ds-none'],
      [{ task: 'template-design', workspace: dir, dataset: 'ds-greeting', definition: '胸牌', request: banner }, '与 --definition 胸牌 不一致'],
      [{ task: 'template-design', workspace: dir, dataset: 'ds-greeting', request: await file('wrong.json', { ...BANNER_REQUEST, dataset: { id: 'other' } }) }, '{"id": "ds-greeting"}'],
      [{ task: 'definition-extraction', request }, '不用出图请求'],
    ];
    for (const [options, message] of cases) {
      await expect(run({}, options)).rejects.toThrow(AgentUsageError);
      await expect(run({}, options)).rejects.toThrow(message);
    }
  });

  it('轮次记录所基于的数据定义、数据集与出图请求；资料、提示词与工具随任务而定', async () => {
    const dir = await workspace();
    const dataset = await datasetRound(dir);
    expect(dataset.record.inputs).toMatchObject({ definition: { name: '胸牌', version: 1 }, dataset: null, request: { file: 'request.json', template: '胸牌卡' }, resources: storeDir });
    const { dataset: _dataset, ...withoutDataset } = { ...CARD_REQUEST, dataset: undefined };
    expect(await json(join(dataset.roundDir, 'request.json'))).toEqual(withoutDataset);
    expect(await json(join(dataset.roundDir, 'agent/docs/request.json'))).toEqual(withoutDataset);
    const fake = await json(join(dataset.roundDir, 'agent/fake-run.json'));
    expect(fake.prompt).toBe((await readFile(join(repoRoot, 'agent/tasks/dataset-extraction.md'), 'utf8')).replaceAll('{sample}', 'sample.png').replaceAll('{definition}', '胸牌 v1'));
    expect(fake.prompt).not.toMatch(/\{|线路|站名|M402/);
    expect(await readFile(join(dataset.roundDir, 'agent/docs/dsl-reference.md'), 'utf8')).toBe(await readFile(join(repoRoot, 'agent/reference/data-definition.md'), 'utf8'));
    expect(dataset.record.runtime.mcpTools.join(',')).toBe('list_documents,read_document,list_resources,check_dataset,view_image,dsl_reference,render_draft,outcome_feedback,check_outcome');
    expect(await json(join(dataset.roundDir, 'logs/outcome-context.json'))).toEqual({
      task: 'dataset-extraction', briefText: await readFile(dataset.record.inputs.brief.source, 'utf8'), definition: { name: '胸牌', version: 1 }, request: withoutDataset, resourceIdentity: expect.any(Array),
    });

    const template = await templateRound(dir);
    expect(template.record.inputs).toMatchObject({ definition: { name: '问候', version: 1 }, dataset: 'ds-greeting', request: { template: '问候横幅' } });
    expect(template.record.runtime.maxTurns).toBe(80);
    const prompt = (await json(join(template.roundDir, 'agent/fake-run.json'))).prompt;
    expect(prompt).toContain('主模板名 问候横幅');
    expect(prompt).toContain('已保存的 ds-greeting');
    expect(await readFile(join(template.roundDir, 'agent/docs/dsl-reference.md'), 'utf8')).toBe(await readFile(join(repoRoot, 'agent/reference/template.md'), 'utf8'));
    expect(template.record.runtime.mcpTools.join(','))
      .toBe('list_documents,read_document,list_resources,check_templates,render_draft,compare_reference,inspect_layout,view_image,dsl_reference,outcome_feedback,check_outcome');
    expect(await json(join(template.roundDir, 'logs/outcome-context.json'))).toEqual({ task: 'template-design', request: await json(join(template.roundDir, 'request.json')), resourceIdentity: expect.any(Array) });
  });
});

describe('数据集提取的成果与审核', () => {
  it('候选数据集经 Schema 前置校验与引擎校验；待确认位置上的问题留给审核，不计入结论', async () => {
    const dir = await workspace();
    const result = await datasetRound(dir);
    expect(result.check.verdict).toBe('qualified');
    expect(result.check.problems).toEqual([]);
    // 第二场的标题文件中没有，候选值"闭幕式"补上之后才完整；按候选值校验，所以没有问题。
    expect(result.check.candidates[0]).toMatchObject({ path: DATASET_FILE, kind: 'dataset', name: 'badge-li', problems: [] });

    const missing = await datasetRound(dir, { ...DATASET_SUBMISSION, pending: [{ ...DATASET_SUBMISSION.pending[0], candidate: undefined }, DATASET_SUBMISSION.pending[2]] },
      { ...DATASET, data: { ...DATASET.data, fullName: '一二三四五六七八九十一二三' } });
    expect(missing.check.verdict).toBe('qualified');
    expect(missing.check.candidates[0]!.deferred!.map((problem) => [problem.code, (problem.location as { path: string }).path]).sort())
      .toEqual([['dataset.constraintViolated', 'fullName'], ['dataset.requiredMissing', 'sessions[2].title']]);

    const cases: [unknown, string][] = [
      [{ ...DATASET, extra: 1 }, '不符合 schemas/dataset.schema.json：根 不能有 extra'],
      [{ ...DATASET, dataset: { ...DATASET.dataset, id: 'ds-greeting' } }, '工作区已有数据集 ds-greeting'],
      [{ ...DATASET, dataset: { ...DATASET.dataset, staticSchema: { name: '问候', version: 1 } } }, '数据集要选定本轮的数据定义 胸牌 v1'],
      [{ ...DATASET, data: { ...DATASET.data, sessions: [...DATASET.data.sessions, { title: '午餐' }, { title: '晚宴' }] } }, '不满足约束'],
    ];
    for (const [dataset, message] of cases) {
      const bad = await datasetRound(dir, DATASET_SUBMISSION, dataset);
      expect(bad.check.verdict).toBe('unqualified');
      expect(bad.check.candidates[0]!.problems.map((problem) => problem.message)).toContainEqual(expect.stringContaining(message));
    }
    const structure = await datasetRound(dir, { ...DATASET_SUBMISSION, pending: [{ file: DATASET_FILE, path: 'sessions[5].title', reason: 'unreadable', note: '说明' }] });
    expect(structure.check.problems.map((problem) => problem.message)).toEqual(['数据集中没有 sessions[5].title：列表只有 2 项']);
    const kind = await run({ 'outcome.json': { candidates: ['candidates/schema.json'], pending: [], notes: '说明' }, 'candidates/schema.json': SESSION },
      { task: 'dataset-extraction', workspace: dir, definition: '胸牌' });
    expect(kind.check.problems.map((problem) => problem.message)).toEqual([expect.stringContaining('数据集提取的候选只能是数据集')]);
  });

  it('审核页的预览由 RenderWeave 用已保存的模板与审核后的数据集重新渲染；未处理的待确认项用候选值（M46）', async () => {
    const dir = await workspace();
    const { roundDir } = await datasetRound(dir);
    const view = (await readReview(roundDir)).view!;
    const candidate = view.candidates[0]!;
    expect(candidate).toMatchObject({ kind: 'dataset', name: 'badge-li', displayName: '李雷的胸牌', staticSchema: { name: '胸牌', version: 1 } });
    expect(candidate.entries!.map((entry) => [entry.path, entry.value, entry.pending, entry.location?.where ?? null])).toEqual([
      ['fullName', '李雷', [3], '正中的姓名'],
      ['sessions[1].title', '开幕式', [], '底部场次表第一行'],
      ['sessions[2].title', '闭幕式', [1], null],
      ['tags', ['VIP'], [2], null],
    ]);
    expect(view.pending.map((item) => [item.item, item.current ?? null])).toEqual([[1, null], [2, ['VIP']], [3, '李雷']]);

    const preview = view.preview!;
    expect(preview).toMatchObject({ blocking: false, problems: [], request: { template: '胸牌卡', dataset: { candidate: DATASET_FILE } } });
    const image = await readFile(join(roundDir, preview.image!));
    // 与直接渲染一致：快照工作区、已保存的模板，数据集是填上候选值的候选。
    const snapshot = await loadWorkspace({ dir: join(roundDir, 'snapshot'), resourcesDir: storeDir });
    const reviewed = { ...DATASET, data: { ...DATASET.data, sessions: [{ title: '开幕式' }, { title: '闭幕式' }] } };
    const direct = await render(snapshot, { ...CARD_REQUEST, mode: 'draft', dataset: { inline: reviewed }, output: { ...CARD_REQUEST.output, dpi: preview.dpi } });
    expect(Buffer.from(direct.image!.bytes)).toEqual(image);
    expect(image).not.toEqual(await readFile(join(roundDir, 'agent/scratch/agent-preview.png')));

    // 待确认项没处理完不能通过，也就不能写入数据集（M46）。
    expect(codes((await changeReview(roundDir, { type: 'approve' })).problems)).toEqual(['review.pending']);
    expect(codes((await applyAgentRound({ roundDir })).problems)).toEqual(['review.notApproved']);

    const decided = await decide(roundDir, [
      { type: 'decide', item: 1, action: 'adopt' },
      { type: 'decide', item: 2, action: 'empty' },
      { type: 'decide', item: 3, action: 'edit', value: '李磊' },
      { type: 'confirmRest', confirmed: true },
    ]);
    expect(decided.canApprove).toBe(true);
    expect(decided.candidates[0]!.entries!.map((entry) => [entry.path, entry.value, entry.state])).toEqual([
      ['fullName', '李磊', 'edited'], ['sessions[1].title', '开幕式', 'kept'], ['sessions[2].title', '闭幕式', 'kept'], ['tags', ['VIP'], 'removed'],
    ]);
    expect(decided.preview!.image).not.toBe(preview.image);
    expect(codes((await changeReview(roundDir, { type: 'decide', item: 1, action: 'edit' })).problems)).toEqual(['review.invalid']);
  });

  it('审核通过后写入数据集，之后经交付入口正式出图，产生出图记录', async () => {
    const dir = await workspace();
    const { roundDir } = await datasetRound(dir);
    await decide(roundDir, [
      { type: 'decide', item: 1, action: 'adopt' }, { type: 'decide', item: 2, action: 'empty' }, { type: 'decide', item: 3, action: 'edit', value: '李磊' },
      { type: 'confirmRest', confirmed: true }, { type: 'approve' },
    ]);
    const applied = await applyAgentRound({ roundDir });
    expect(applied.problems).toEqual([]);
    expect(applied.applied!.published).toEqual([{ candidate: DATASET_FILE, kind: 'dataset', name: 'badge-li', files: ['dataset-badge-li.json'] }]);
    expect(await json(join(dir, 'dataset-badge-li.json'))).toEqual({ ...DATASET, data: { fullName: '李磊', sessions: [{ title: '开幕式' }, { title: '闭幕式' }] } });

    const out = join(base, `batch-${++count}`);
    const delivered = await deliverBatch({
      workspace: await loadWorkspace({ dir, resourcesDir: storeDir }), resources: store, outDir: out,
      request: { template: '胸牌卡', mode: 'final', items: [{ id: 'li', dataset: { id: 'badge-li' }, parameters: {}, output: CARD_REQUEST.output }] },
    });
    expect(delivered.problems).toEqual([]);
    expect(delivered.summary).toMatchObject({ total: 1, delivered: 1 });
    const record = await readOutputRecord({ dir: join(delivered.directory!, (await readdir(delivered.directory!)).find((name) => name !== 'batch.json')!) });
    expect(record.problems).toEqual([]);
    expect(record.record).toBeDefined();
  });
});

describe('模板辅助设计的成果与审核', () => {
  it('候选模板经 Schema 前置校验与静态检查；主模板必须在候选中，不能与工作区已有的模板重名', async () => {
    const dir = await workspace();
    const result = await templateRound(dir);
    expect(result.check.verdict).toBe('qualified');
    expect(result.check.candidates.map((candidate) => [candidate.path, candidate.kind, candidate.name, candidate.problems])).toEqual([
      [BANNER_FILE, 'template', '问候横幅', []], [WORDS_FILE, 'template', '横幅文字', []],
    ]);
    const noMain = await run({ 'outcome.json': { ...TEMPLATE_SUBMISSION, candidates: [WORDS_FILE], locations: [], pending: [] }, [WORDS_FILE]: WORDS },
      { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request: await file('banner-request.json', BANNER_REQUEST) });
    expect(noMain.check.problems.map((problem) => problem.message)).toEqual(['出图请求的主模板 问候横幅 不在候选中']);
    const element = await templateRound(dir, { ...TEMPLATE_SUBMISSION, pending: [{ ...TEMPLATE_SUBMISSION.pending[0], path: '问候横幅/边框' }] });
    expect(element.check.problems.map((problem) => problem.message)).toEqual(['模板中没有元素 问候横幅/边框']);
    const cases: [unknown, string][] = [
      [{ ...BANNER, colour: 'red' }, '不符合 schemas/template.schema.json：根 不能有 colour'],
      [{ ...BANNER, name: '问候牌' }, '工作区已有模板 问候牌'],
      [{ ...BANNER, artboard: { ...BANNER.artboard, children: [BANNER.artboard.children[0], { ...BANNER.artboard.children[1], template: '不存在' }] } }, '不存在'],
    ];
    for (const [banner, message] of cases) {
      const bad = await templateRound(dir, { ...TEMPLATE_SUBMISSION, pending: [], locations: [] }, banner);
      expect(bad.check.verdict).toBe('unqualified');
      expect(bad.check.candidates.flatMap((candidate) => candidate.problems.map((problem) => problem.message))).toContainEqual(expect.stringContaining(message));
    }
  });

  it('元素路径可以省略模板名；穿进被调模板的图上位置只记提示，在元素清单中挂到调用元素那一行', async () => {
    const dir = await workspace();
    const result = await templateRound(dir, { ...TEMPLATE_SUBMISSION, pending: [{ ...TEMPLATE_SUBMISSION.pending[0], path: '底色' }],
      locations: [{ file: BANNER_FILE, path: '文字区/问候语', where: '中部的问候语', region: { x: 10, y: 10, width: 100, height: 20 } }] });
    expect(result.check.verdict).toBe('qualified');
    expect(result.check.problems.map((problem) => [problem.level, problem.message])).toEqual([['hint', expect.stringContaining('元素路径进入了被调模板 横幅文字')]]);
    const view = (await readReview(result.roundDir)).view!;
    expect(view.pending[0]).toMatchObject({ path: '问候横幅/底色', current: BANNER.artboard.children[0] });
    expect(view.candidates.find((candidate) => candidate.path === BANNER_FILE)!.elements!.map((element) => [element.path, element.pending, element.location?.where ?? null]))
      .toEqual([['问候横幅/底色', [1], null], ['问候横幅/文字区', [], '中部的问候语']]);
    const edited = await decide(result.roundDir, [{ type: 'decide', item: 1, action: 'edit', value: PINK }]);
    expect(edited.candidates.find((candidate) => candidate.path === BANNER_FILE)!.elements![0]!.state).toBe('edited');
  });

  it('审核页按候选模板与已保存的数据集重新渲染预览；改动元素后预览随之更新；预览的严重问题阻止通过', async () => {
    const dir = await workspace();
    const { roundDir } = await templateRound(dir);
    const view = (await readReview(roundDir)).view!;
    const banner = view.candidates.find((candidate) => candidate.path === BANNER_FILE)!;
    expect(banner.template).toEqual({ base: { name: '问候', version: 1 }, parameters: [] });
    expect(banner.elements!.map((element) => [element.path, element.type, element.pending, element.location?.where ?? null, element.state])).toEqual([
      ['问候横幅/底色', 'rect', [1], null, 'kept'], ['问候横幅/文字区', 'call', [], '中部的问候语', 'kept'],
    ]);
    expect(view.pending[0]).toMatchObject({ current: BANNER.artboard.children[0], candidate: '#FFE8E8' });
    expect(view.preview).toMatchObject({ blocking: true, problems: [], request: BANNER_REQUEST });

    const snapshot = await loadWorkspace({ dir: join(roundDir, 'snapshot'), resourcesDir: storeDir });
    const overlay = (document: unknown) => ({ ...snapshot, templates: [...snapshot.templates,
      { name: '问候横幅', document, source: BANNER_FILE }, { name: '横幅文字', document: WORDS, source: WORDS_FILE }] });
    const draft = (dpi: number) => ({ ...BANNER_REQUEST, mode: 'draft', output: { ...BANNER_REQUEST.output, dpi } });
    expect(Buffer.from((await render(overlay(BANNER), draft(view.preview!.dpi!))).image!.bytes)).toEqual(await readFile(join(roundDir, view.preview!.image!)));

    const edited = await decide(roundDir, [{ type: 'decide', item: 1, action: 'edit', value: PINK }, { type: 'confirmRest', confirmed: true }]);
    expect(edited.candidates.find((candidate) => candidate.path === BANNER_FILE)!.elements!.map((element) => element.state)).toEqual(['edited', 'kept']);
    const pink = { ...BANNER, artboard: { ...BANNER.artboard, children: [PINK, BANNER.artboard.children[1]] } };
    expect(Buffer.from((await render(overlay(pink), draft(edited.preview!.dpi!))).image!.bytes)).toEqual(await readFile(join(roundDir, edited.preview!.image!)));
    expect(edited.canApprove).toBe(true);
    const removed = await decide(roundDir, [{ type: 'decide', item: 1, action: 'empty' }]);
    expect(removed.candidates.find((candidate) => candidate.path === BANNER_FILE)!.elements!.map((element) => [element.path, element.state]))
      .toEqual([['问候横幅/文字区', 'kept'], ['问候横幅/底色', 'removed']]);

    // 画板尺寸范围装不下出图请求：静态检查看不出，交回检查和预览都报严重问题。
    const narrow = { ...BANNER, artboard: { ...BANNER.artboard, sizeRange: { ...BANNER.artboard.sizeRange, width: { min: 100, max: 150 } } } };
    const small = await templateRound(dir, TEMPLATE_SUBMISSION, narrow);
    expect(small.check.verdict).toBe('unqualified');
    expect(small.check.assessment.render.status).toBe('blocked');
    const blocked = await decide(small.roundDir, [{ type: 'decide', item: 1, action: 'adopt' }, { type: 'confirmRest', confirmed: true }]);
    expect(codes(blocked.preview!.problems)).toContain('render.sizeOutOfRange');
    expect(blocked.canApprove).toBe(false);
    expect(codes((await changeReview(small.roundDir, { type: 'approve' })).problems)).toEqual(['review.pending']);
  });

  it('审核通过后保存模板，之后正式出图；工作区出现同名模板时即使覆盖也拒绝，工作区不变', async () => {
    const dir = await workspace();
    const { roundDir } = await templateRound(dir);
    await decide(roundDir, [{ type: 'decide', item: 1, action: 'edit', value: PINK }, { type: 'confirmRest', confirmed: true }, { type: 'approve' }]);
    const applied = await applyAgentRound({ roundDir });
    expect(applied.problems).toEqual([]);
    expect(applied.applied!.published.map((item) => [item.kind, item.name, item.files])).toEqual([
      ['template', '问候横幅', ['template-banner.json']], ['template', '横幅文字', ['template-banner-words.json']],
    ]);
    expect((await json(join(dir, 'template-banner.json'))).artboard.children[0]).toEqual(PINK);
    const out = join(base, `batch-${++count}`);
    const { template, mode, ...item } = BANNER_REQUEST;
    const delivered = await deliverBatch({ workspace: await loadWorkspace({ dir, resourcesDir: storeDir }), resources: store, outDir: out,
      request: { template, mode, items: [{ id: 'banner', ...item }] } });
    expect(delivered.problems).toEqual([]);
    expect(delivered.summary).toMatchObject({ total: 1, delivered: 1 });

    const other = await workspace();
    const second = await templateRound(other);
    await decide(second.roundDir, [{ type: 'decide', item: 1, action: 'adopt' }, { type: 'confirmRest', confirmed: true }, { type: 'approve' }]);
    await writeFile(join(other, 'template-someone.json'), JSON.stringify({ ...WORDS, name: '问候横幅' }));
    const before = await readdir(other);
    expect(codes((await applyAgentRound({ roundDir: second.roundDir })).problems)).toEqual(['apply.workspaceChanged']);
    const overwritten = await applyAgentRound({ roundDir: second.roundDir, overwrite: true });
    expect(codes(overwritten.problems)).toEqual(['apply.failed']);
    expect(overwritten.problems[0]!.message).toContain('工作区已有模板 问候横幅');
    expect(await readdir(other)).toEqual(before);
  });

  it('审核页服务给出预览图；命令行接受 --definition、--dataset 与 --request', async () => {
    const dir = await workspace();
    const { roundDir } = await templateRound(dir);
    const server = await startReviewServer({ roundDir });
    try {
      const view = ((await (await fetch(`${server.url}api/review`)).json()) as { view: ReviewView }).view;
      const response = await fetch(`${server.url}${view.preview!.image}`);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(roundDir, view.preview!.image!)));
      expect((await fetch(`${server.url}previews/${'0'.repeat(64)}.png`)).status).toBe(404);
      expect((await fetch(`${server.url}previews/../review.json`)).status).toBe(404);
    } finally {
      await server.close();
    }
    process.env['RW_TEST_KEY'] = KEY;
    try {
      const stderr: string[] = [];
      const code = await runCli(['agent', 'run', '--task', '模板辅助设计', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', join(base, 'brief.md'),
        '--resources', storeDir, '--out', join(base, 'cli-template'), '--workspace', dir, '--dataset', 'ds-greeting', '--key-env', 'RW_TEST_KEY'],
      { stdout: () => {}, stderr: (text) => stderr.push(text) });
      expect([code, stderr.join('')]).toEqual([2, expect.stringContaining('要用 --request')]);
    } finally {
      delete process.env['RW_TEST_KEY'];
    }
  });
});
