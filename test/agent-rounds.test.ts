/**
 * 带反馈的下一轮与模板辅助修改（第三阶段票据 07、验收 A09）：用假执行器造出轮次，经公开入口审核、应用，断言
 * 下一轮拿到的素材、上一轮成果（含审核时的修改）与反馈，轮次链，模板辅助修改的工作副本、结构化差异与修改前后的预览，
 * 以及模板已被他人保存时的覆盖与重做（M49–M52、M58）；另有 `agent run` 按任务校验 --definition 与 --dataset（票据 16）。
 */
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  AgentUsageError, applyAgentRound, changeReview, deliverBatch, diffTemplate, importResources, initializeResourceStore, loadWorkspace,
  openVersionedResourceStore, readReview, render, runAgentTask, type AgentRunOptions, type ReviewView, type VersionedResourceStore,
} from '../src/index.js';
import { repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const KEY = `rw-test-key-${Math.random().toString(36).slice(2)}`;
const TEMPLATE = 'renderweave-template/1';

const text = (name: string, slot: string, place: Record<string, unknown>) =>
  ({ type: 'text', name, content: [{ slot }], font: 'res:font-hei-medium', fontSize: 8, color: '#000000', verticalAlign: 'center', place });
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
const PINK = { ...BANNER.artboard.children[0], fill: '#FFE8E8' };
const withChildren = <T extends { artboard: object }>(template: T, children: unknown[]) => ({ ...template, artboard: { ...template.artboard, children } });
const PINK_BANNER = withChildren(BANNER, [PINK, BANNER.artboard.children[1]]);

/** 模板辅助设计第 1 轮：底色是待确认项。 */
const DESIGN_SUBMISSION = {
  candidates: [BANNER_FILE, WORDS_FILE],
  locations: [{ file: BANNER_FILE, path: '问候横幅/文字区', where: '中部的问候语', region: { x: 10, y: 10, width: 100, height: 20 } }],
  pending: [{ file: BANNER_FILE, path: '问候横幅/底色', candidate: '#FFE8E8', reason: 'inferred', note: '底色按示例图估计' }],
  notes: '主模板调用文字子模板。',
};
const REQUIREMENT = '1. `问候横幅/底色` 改成浅粉色 #FFE8E8，与示例图一致。\n2. `横幅文字/问候语` 保持不变。\n';
/** 模板辅助修改：只改了主模板的底色；文字子模板原样列出，只记提示。 */
const REVISION_SUBMISSION = {
  candidates: [BANNER_FILE, WORDS_FILE],
  locations: [{ file: BANNER_FILE, path: '底色', where: '整块底色' }],
  pending: [{ file: BANNER_FILE, path: '底色', candidate: '#FFE8E8', reason: 'inferred', note: '粉色的深浅按示例图估计' }],
  notes: '按修改要求第 1 条把底色改成浅粉色；第 2 条没有改动。',
};

let base: string, storeDir: string, store: VersionedResourceStore;
let count = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-agent07-'));
  await writeFile(join(base, 'brief.md'), '# 项目说明：示例\n');
  storeDir = join(base, 'resources');
  expect((await initializeResourceStore(storeDir)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: storeDir })).problems).toEqual([]);
  store = (await openVersionedResourceStore(storeDir)).store!;
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 工作区：single-text 的问候（数据集 ds-greeting、模板问候牌）；saved 时另有已保存的问候横幅与横幅文字。 */
async function workspace(saved: boolean): Promise<string> {
  const dir = join(base, `workspace-${++count}`);
  await cp(singleTextDir, dir, { recursive: true });
  if (saved) {
    await writeFile(join(dir, 'template-banner.json'), JSON.stringify(BANNER, null, 2));
    await writeFile(join(dir, 'template-banner-words.json'), JSON.stringify(WORDS, null, 2));
  }
  return dir;
}

async function file(name: string, value: unknown): Promise<string> {
  const path = join(base, `${++count}-${name}`);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  return path;
}

/** 用假执行器跑一轮：files 是 Agent 交回的文件，省略时 Agent 什么都不写。 */
function run(files: Record<string, unknown> | undefined, options: Partial<AgentRunOptions>) {
  return (async () => {
    let preset = 'none';
    if (files) {
      preset = join(base, `preset-${++count}`);
      await mkdir(preset, { recursive: true });
      for (const [path, value] of Object.entries(files)) {
        await mkdir(join(preset, path, '..'), { recursive: true });
        await writeFile(join(preset, path), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      }
    }
    const first = options.from === undefined ? { sample: join(resourcesDir, 'images/test/quadrants.png'), brief: join(base, 'brief.md'), resources: storeDir } : {};
    return runAgentTask({
      ...first, out: join(base, `round-${++count}`), key: KEY, keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] }, ...options,
    });
  })();
}

const designRound = async (dir: string, files: Record<string, unknown> = { 'outcome.json': DESIGN_SUBMISSION, [BANNER_FILE]: BANNER, [WORDS_FILE]: WORDS }) =>
  run(files, { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request: await file('banner-request.json', BANNER_REQUEST) });
const revisionRound = async (dir: string, files: Record<string, unknown> | undefined = { 'outcome.json': REVISION_SUBMISSION, [BANNER_FILE]: PINK_BANNER }) =>
  run(files, { task: 'template-revision', workspace: dir, request: await file('banner-request.json', BANNER_REQUEST), requirement: await file('requirement.md', REQUIREMENT) });

async function decide(dir: string, changes: unknown[]): Promise<ReviewView> {
  let view: ReviewView | undefined;
  for (const change of changes) {
    const result = await changeReview(dir, change);
    expect(result.problems).toEqual([]);
    view = result.view;
  }
  return view!;
}

/** 经命令行发起：返回退出码与标准错误；key 只在这次调用期间放进环境变量。 */
async function cli(args: string[]): Promise<[number, string]> {
  const stderr: string[] = [];
  process.env['RW_TEST_KEY'] = KEY;
  try {
    const code = await runCli(['agent', 'run', ...args, '--key-env', 'RW_TEST_KEY'], { stdout: () => {}, stderr: (value) => stderr.push(value) });
    return [code, stderr.join('')];
  } finally {
    delete process.env['RW_TEST_KEY'];
  }
}

const codes = (problems: readonly { code: string }[]) => problems.map((problem) => problem.code);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const approveRevision = (dir: string) => decide(dir, [{ type: 'decide', item: 1, action: 'adopt' }, { type: 'confirmRest', confirmed: true }, { type: 'approve' }]);

describe('受阻成果与中断草稿（票据 31）', () => {
  it('交回检查与 MCP 都识别渲染能力阻塞；可看草稿，确认全部内容仍不能批准或应用；修正后重新评估', async () => {
    const dir = await workspace(false);
    const arabic = withChildren(WORDS, [{ ...WORDS.artboard.children[0], content: [{ text: 'سلام' }] }]);
    const round = await designRound(dir, { 'outcome.json': DESIGN_SUBMISSION, [BANNER_FILE]: BANNER, [WORDS_FILE]: arabic });
    expect(round.outcome).toBeDefined();
    expect(round.check).toMatchObject({ verdict: 'unqualified', assessment: { structure: 'valid', candidates: 'valid', content: 'needsReview',
      render: { status: 'blocked', hasImage: true, capabilityBlocked: true, blocking: true } } });
    expect(round.check.assessment.render.problems).toContainEqual(expect.objectContaining({ code: 'text.unshapedScript', level: 'severe' }));
    const mcp = await startMcp(['--workspace', join(round.roundDir, 'snapshot'), '--resources', storeDir, '--root', join(round.roundDir, 'agent'),
      '--outcome-context', join(round.roundDir, 'logs/outcome-context.json')]);
    try {
      expect((await mcp.callJson('check_outcome', {})).assessment).toEqual(round.check.assessment);
      await writeFile(join(round.roundDir, 'agent', WORDS_FILE), JSON.stringify(WORDS));
      expect(await mcp.callJson('check_outcome', {})).toMatchObject({ verdict: 'qualified', assessment: { render: { status: 'renderable', capabilityBlocked: false } } });
    } finally { await mcp.close(); }
    const view = await decide(round.roundDir, [{ type: 'decide', item: 1, action: 'adopt' }, { type: 'confirmRest', confirmed: true }]);
    expect(view.preview?.image).toBeDefined();
    expect(view.preview?.assessment).toMatchObject({ status: 'blocked', capabilityBlocked: true });
    expect(view.canApprove).toBe(false);
    expect((await changeReview(round.roundDir, { type: 'approve' })).problems.length).toBeGreaterThan(0);
    expect((await applyAgentRound({ roundDir: round.roundDir, workspace: dir })).applied).toBeUndefined();
    const next = await run({ 'outcome.json': { ...DESIGN_SUBMISSION, pending: [] }, [WORDS_FILE]: WORDS },
      { from: round.roundDir, feedback: await file('feedback.md', '改成支持的文字以验证恢复路径。') });
    expect(next.check.assessment.render.status).toBe('renderable');
  });

  it('没有成果时单独抢救候选与哈希，可预览但不允许审核操作；损坏候选仍留在原目录', async () => {
    const dir = await workspace(false);
    const round = await designRound(dir, { [BANNER_FILE]: BANNER, [WORDS_FILE]: WORDS, 'candidates/partial.json': '{' });
    expect(existsSync(join(round.roundDir, 'outcome.json'))).toBe(false);
    const draft = await json(join(round.roundDir, 'draft.json'));
    expect(draft).toMatchObject({ format: 'renderweave-draft/1', source: 'hostRecovery', check: { assessment: { render: { status: 'renderable' } } } });
    expect(draft.outcome.candidates).toHaveLength(2);
    for (const candidate of draft.outcome.candidates) expect(candidate.sha256).toBe(await sha256(join(round.roundDir, candidate.path)));
    const { view } = await readReview(round.roundDir);
    expect(view).toMatchObject({ round: { source: 'hostRecovery' }, canApprove: false });
    expect(view?.preview?.image).toBeDefined();
    expect((await changeReview(round.roundDir, { type: 'confirmRest', confirmed: true })).problems[0]?.message).toContain('只能查看');
    expect((await applyAgentRound({ roundDir: round.roundDir, workspace: dir })).applied).toBeUndefined();
    await writeFile(join(round.roundDir, WORDS_FILE), JSON.stringify({ ...WORDS, name: '篡改' }));
    expect((await readReview(round.roundDir)).problems[0]?.message).toContain('被改动');
  });

  it('审核后当前工作区数据引入能力阻塞时，overwrite 也不能应用', async () => {
    const dir = await workspace(true);
    const round = await revisionRound(dir);
    await approveRevision(round.roundDir);
    const dataFile = (await readdir(dir)).find((name) => name.startsWith('dataset'))!;
    const dataset = await json(join(dir, dataFile));
    dataset.data.message = 'سلام';
    await writeFile(join(dir, dataFile), JSON.stringify(dataset));
    const applied = await applyAgentRound({ roundDir: round.roundDir, workspace: dir, overwrite: true });
    expect(applied.applied).toBeUndefined();
    expect(applied.problems).toContainEqual(expect.objectContaining({ code: 'text.unshapedScript', level: 'severe' }));
    expect(await json(join(dir, 'template-banner.json'))).toEqual(BANNER);
  });
});

describe('带反馈的下一轮（M58）', () => {
  it('下一轮拿到素材、上一轮成果（含审核时的修改）与反馈；工作区重新取快照；轮次链可查', async () => {
    const dir = await workspace(false);
    const first = await designRound(dir);
    await decide(first.roundDir, [{ type: 'decide', item: 1, action: 'edit', value: PINK }, { type: 'reject', comment: '文字区太靠上，往下移 5 mm' }]);
    // 两轮之间工作区有变化：下一轮重新取快照，不沿用上一轮的快照。
    await writeFile(join(dir, 'note.json'), '{}');
    const feedback = await file('feedback.md', '文字区往下移 5 mm，底色保持审核时改的浅粉色。\n');

    const second = await run({ 'outcome.json': { candidates: [BANNER_FILE, WORDS_FILE], pending: [], notes: '按反馈下移文字区。' } }, { from: first.roundDir, feedback });
    expect(second.check.verdict).toBe('qualified');
    const { record } = second;
    expect(record).toMatchObject({ task: 'template-design', round: 2 });
    expect(record.inputs.previous).toEqual({
      dir: first.roundDir, round: 1, outcomeSha256: await sha256(join(first.roundDir, 'outcome.json')),
      reviewSha256: await sha256(join(first.roundDir, 'review.json')), reviewStatus: 'rejected',
    });
    expect(record.inputs).toMatchObject({
      dataset: 'ds-greeting', request: { template: '问候横幅' }, resources: storeDir, sample: { sha256: first.record.inputs.sample.sha256 },
      feedback: { file: 'feedback.md', sha256: await sha256(feedback) },
    });
    expect(record.inputs.workspace.fingerprint).not.toBe(first.record.inputs.workspace.fingerprint);
    expect(await readdir(join(second.roundDir, 'snapshot'))).toContain('note.json');
    expect(second.outcome!.round).toBe(2);
    expect(second.outcome!.inputs.previous).toMatchObject({ dir: first.roundDir, round: 1 });

    // 候选从上一轮成果（含审核时把底色改成浅粉色）开始；previous/ 是上一轮的原样记录。
    const agent = join(second.roundDir, 'agent');
    expect(await json(join(agent, BANNER_FILE))).toEqual(PINK_BANNER);
    expect(await json(join(agent, 'previous', BANNER_FILE))).toEqual(PINK_BANNER);
    expect(await json(join(agent, 'previous', WORDS_FILE))).toEqual(WORDS);
    expect((await readdir(join(agent, 'previous'))).sort()).toEqual(['candidates', 'check.json', 'outcome.json', 'review.json']);
    expect(await readFile(join(agent, 'previous/review.json'), 'utf8')).toBe(await readFile(join(first.roundDir, 'review.json'), 'utf8'));
    expect(await readFile(join(agent, 'docs/feedback.md'), 'utf8')).toBe(await readFile(feedback, 'utf8'));
    expect(await readFile(join(second.roundDir, 'feedback.md'), 'utf8')).toBe(await readFile(feedback, 'utf8'));
    const prompt = (await json(join(agent, 'fake-run.json'))).prompt as string;
    const nextRound = (await readFile(join(repoRoot, 'agent/tasks/template-next-round.md'), 'utf8')).replaceAll('{round}', '2');
    expect(prompt).toContain('为已发布的 问候 v1 设计模板');
    expect(prompt).toContain(nextRound.split('{seeds}')[0]);
    expect(prompt).toContain('candidates/ 中已放好上一轮的成果（含审核时的修改）');
    expect(prompt).not.toMatch(/\{(round|seeds|sample|template|dataset)\}/);

    const view = (await readReview(second.roundDir)).view!;
    expect(view.round).toMatchObject({ round: 2, feedback: await readFile(feedback, 'utf8') });
    expect(view.round.chain).toEqual([
      { round: 1, dir: first.roundDir, task: 'template-design', verdict: 'qualified', review: 'rejected', applied: false },
      { round: 2, dir: second.roundDir, task: 'template-design', verdict: 'qualified', applied: false },
    ]);

    // 第 3 轮接在第 2 轮之后，链一直追到第 1 轮；上一轮的目录不见了，链在那里断开。
    const third = await run({ 'outcome.json': { candidates: [BANNER_FILE, WORDS_FILE], pending: [], notes: '第 3 轮。' } }, { from: second.roundDir, feedback });
    expect(third.record.round).toBe(3);
    expect((await readReview(third.roundDir)).view!.round.chain.map((link) => [link.round, link.dir])).toEqual([[1, first.roundDir], [2, second.roundDir], [3, third.roundDir]]);
    await rm(first.roundDir, { recursive: true, force: true });
    expect((await readReview(third.roundDir)).view!.round.chain.map((link) => [link.round, link.missing ?? false])).toEqual([[1, true], [2, false], [3, false]]);
  });

  it('上一轮结构不合格时，下一轮拿到当时交回的文件与问题清单', async () => {
    const dir = await workspace(false);
    const { notes: _notes, ...broken } = DESIGN_SUBMISSION;
    const first = await designRound(dir, { 'outcome.json': broken, [BANNER_FILE]: BANNER, [WORDS_FILE]: WORDS, 'candidates/drafts/extra.json': { note: '草稿' } });
    expect(first.outcome).toBeUndefined();
    const second = await run(undefined, { from: first.roundDir, feedback: await file('feedback.md', '补上 notes。') });
    expect(second.record.inputs.previous).toMatchObject({ round: 1, outcomeSha256: null, reviewSha256: null, reviewStatus: null });
    const agent = join(second.roundDir, 'agent');
    expect(await json(join(agent, BANNER_FILE))).toEqual(BANNER);
    expect(await json(join(agent, 'candidates/drafts/extra.json'))).toEqual({ note: '草稿' });
    expect((await readdir(join(agent, 'previous'))).sort()).toEqual(['candidates', 'check.json', 'draft.json']);
    expect((await json(join(agent, 'previous/check.json'))).verdict).toBe('unqualified');
    expect((await json(join(agent, 'fake-run.json'))).prompt).toContain('上一轮的成果结构不合格');
  });

  it('下一轮沿用上一轮的输入：不能再给任务、素材与基准；必须带反馈；上一轮要有轮次记录', async () => {
    const dir = await workspace(false);
    const first = await designRound(dir);
    const feedback = await file('feedback.md', '再调一下。');
    const cases: [Partial<AgentRunOptions>, string][] = [
      [{ from: first.roundDir, feedback, task: 'template-design' }, '不能再给 --task'],
      [{ from: first.roundDir, feedback, workspace: dir, dataset: 'ds-greeting' }, '不能再给 --workspace、--dataset'],
      [{ from: first.roundDir }, '要用 --feedback 给出反馈'],
      [{ from: join(base, 'no-such-round'), feedback }, '上一轮的轮次记录无法读取'],
      [{ task: 'template-design', feedback, workspace: dir, dataset: 'ds-greeting', request: await file('r.json', BANNER_REQUEST) }, '--feedback 只用于带 --from 发起的下一轮'],
    ];
    for (const [options, message] of cases) {
      await expect(run(undefined, options)).rejects.toThrow(AgentUsageError);
      await expect(run(undefined, options)).rejects.toThrow(message);
    }
    // 上一轮的审核结果与成果对不上，不能作为下一轮的基础。
    await writeFile(join(first.roundDir, 'review.json'), '{"format":"renderweave-review/1"}');
    await expect(run(undefined, { from: first.roundDir, feedback })).rejects.toThrow('上一轮的审核结果不能使用');

    expect(await cli(['--from', first.roundDir, '--feedback', feedback, '--task', '模板辅助设计', '--out', join(base, 'cli-next')]))
      .toEqual([2, expect.stringContaining('不能再给 --task')]);
    expect(await cli(['--from', first.roundDir, '--out', join(base, 'cli-next')])).toEqual([2, expect.stringContaining('要用 --feedback')]);
    expect(await cli(['--task', '模板辅助设计', '--out', join(base, 'cli-next')])).toEqual([2, expect.stringContaining('renderweave agent run --from')]);
  });
});

describe('模板辅助修改：发起与成果', () => {
  it('输入检查；主模板调用树中的已保存模板复制进 candidates/ 作为工作副本，并记录所基于的保存内容', async () => {
    const dir = await workspace(true);
    const request = await file('banner-request.json', BANNER_REQUEST);
    const requirement = await file('requirement.md', REQUIREMENT);
    const cases: [Partial<AgentRunOptions>, string][] = [
      [{ workspace: dir, request }, '要用 --requirement 给出修改要求'],
      [{ workspace: dir, requirement }, '要用 --request 给出出图请求'],
      [{ workspace: dir, request, requirement, definition: '问候' }, '不用 --definition'],
      [{ request, requirement }, '要用 --workspace'],
      [{ workspace: dir, request: await file('r.json', { ...BANNER_REQUEST, template: '会员卡' }), requirement }, '出图请求的模板 会员卡 不在工作区中'],
      [{ workspace: dir, request: await file('r.json', { ...BANNER_REQUEST, dataset: undefined }), requirement }, '要用已保存的数据集'],
      [{ workspace: dir, request: await file('r.json', { ...BANNER_REQUEST, dataset: { id: 'ds-none' } }), requirement }, '工作区中没有数据集 ds-none'],
      [{ workspace: dir, request, requirement: await file('r.md', '把 `问候横幅/角标` 去掉；`问候横幅/文字区/问候语` 加粗。') },
        '修改要求中的元素路径在已保存的模板中找不到：问候横幅/角标（模板中没有元素 问候横幅/角标）；问候横幅/文字区/问候语（元素路径进入了被调模板 横幅文字'],
      [{ workspace: dir, request, requirement: await file('r.md', '  \n') }, '修改要求是空的'],
    ];
    for (const [options, message] of cases) {
      await expect(run(undefined, { task: 'template-revision', ...options })).rejects.toThrow(message);
    }
    await expect(run(undefined, { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request, requirement })).rejects.toThrow('只有模板辅助修改用 --requirement');

    // 数据集也可以用 --dataset 给出。
    const round = await run(undefined, { task: 'template-revision', workspace: dir, dataset: 'ds-greeting', request: await file('r.json', { ...BANNER_REQUEST, dataset: undefined }), requirement });
    const agent = join(round.roundDir, 'agent');
    expect((await readdir(join(agent, 'candidates'))).sort()).toEqual(['template-banner-words.json', 'template-banner.json']);
    expect(await readFile(join(agent, BANNER_FILE))).toEqual(await readFile(join(dir, 'template-banner.json')));
    expect(await readFile(join(agent, WORDS_FILE))).toEqual(await readFile(join(dir, 'template-banner-words.json')));
    expect(round.record.inputs).toMatchObject({
      dataset: 'ds-greeting', request: { template: '问候横幅' }, definition: null, previous: null,
      templates: [
        { name: '问候横幅', file: 'template-banner.json', sha256: await sha256(join(dir, 'template-banner.json')) },
        { name: '横幅文字', file: 'template-banner-words.json', sha256: await sha256(join(dir, 'template-banner-words.json')) },
      ],
      requirement: { file: 'requirement.md', sha256: await sha256(requirement) },
    });
    expect(await readFile(join(round.roundDir, 'requirement.md'), 'utf8')).toBe(REQUIREMENT);
    expect(await readFile(join(agent, 'docs/requirement.md'), 'utf8')).toBe(REQUIREMENT);
    expect(await json(join(round.roundDir, 'request.json'))).toEqual(BANNER_REQUEST);
    const prompt = (await json(join(agent, 'fake-run.json'))).prompt as string;
    expect(prompt).toBe((await readFile(join(repoRoot, 'agent/tasks/template-revision.md'), 'utf8')).replaceAll('{sample}', 'sample.png')
      .replaceAll('{template}', '问候横幅').replaceAll('{dataset}', 'ds-greeting')
      .replaceAll('{templates}', '问候横幅（candidates/template-banner.json）、横幅文字（candidates/template-banner-words.json）'));
    expect(round.record.runtime).toMatchObject({ maxTurns: 80, mcpTools: ['list_documents', 'read_document', 'list_resources', 'check_templates', 'render_draft', 'inspect_layout', 'view_image', 'dsl_reference', 'check_outcome'] });
    expect(await json(join(round.roundDir, 'logs/outcome-context.json'))).toEqual({
      task: 'template-revision', request: BANNER_REQUEST, revision: { templates: ['问候横幅', '横幅文字'] },
    });
    expect(await readFile(join(agent, 'docs/dsl-index.md'), 'utf8')).toContain('完整示例');
  });

  it('成果带相对已保存模板的结构化差异；没改的只记提示；可以新建模板，调用树以外的已保存模板不能改', async () => {
    const dir = await workspace(true);
    const { check, outcome } = await revisionRound(dir);
    expect(check.verdict).toBe('qualified');
    const banner = check.candidates.find((candidate) => candidate.path === BANNER_FILE)!;
    expect(banner.revision).toEqual({ status: 'modified', changes: [
      { path: '问候横幅/底色', target: 'element', change: 'changed', properties: [{ key: 'fill', before: '#FFF4E0', after: '#FFE8E8' }] },
    ] });
    expect(check.candidates.find((candidate) => candidate.path === WORDS_FILE)!.revision).toEqual({ status: 'unchanged', changes: [] });
    expect(check.problems.map((problem) => [problem.level, problem.message])).toEqual([['hint', '工作副本与已保存的模板 横幅文字 相同，应用时不写入']]);
    expect(outcome!.candidates.map((candidate) => [candidate.path, candidate.revises])).toEqual([
      [BANNER_FILE, { file: 'template-banner.json', sha256: await sha256(join(dir, 'template-banner.json')) }],
      [WORDS_FILE, { file: 'template-banner-words.json', sha256: await sha256(join(dir, 'template-banner-words.json')) }],
    ]);
    // 元素路径省略模板名的待确认项与图上位置，在成果中照样指向元素。
    expect(outcome!.pending[0]).toMatchObject({ file: BANNER_FILE, path: '底色' });

    // 新建的被调模板没有基准；修改调用树以外的已保存模板（问候牌）不合格。
    const CORNER = { ...WORDS, name: '横幅角标' };
    const added = await revisionRound(dir, { 'outcome.json': { ...REVISION_SUBMISSION, candidates: [BANNER_FILE, 'candidates/template-corner.json'] },
      [BANNER_FILE]: PINK_BANNER, 'candidates/template-corner.json': CORNER });
    expect(added.check.verdict).toBe('qualified');
    expect(added.check.candidates.find((candidate) => candidate.name === '横幅角标')!.revision).toEqual({ status: 'added', changes: [] });
    expect(added.outcome!.candidates.find((candidate) => candidate.name === '横幅角标')!.revises).toBeUndefined();
    const greeting = JSON.parse(await readFile(join(dir, 'template-greeting.json'), 'utf8'));
    const outside = await revisionRound(dir, { 'outcome.json': { ...REVISION_SUBMISSION, candidates: [BANNER_FILE, 'candidates/template-greeting.json'] },
      [BANNER_FILE]: PINK_BANNER, 'candidates/template-greeting.json': { ...greeting, artboard: { ...greeting.artboard, fill: '#000000' } } });
    expect(outside.check.verdict).toBe('unqualified');
    expect(outside.check.candidates.find((candidate) => candidate.name === '问候牌')!.problems[0]!.message)
      .toBe('模板辅助修改只能改出图请求主模板调用到的模板（问候横幅、横幅文字）：问候牌 不在其中');
  });

  it('结构化差异：元素按路径配对，子元素换序单独列出；参数、派生变量与检查项按名称比对', () => {
    const corner = { type: 'rect', name: '角标', fill: '#E60012', place: { left: 180, top: 0, width: { fixed: 20 }, height: { fixed: 10 } } };
    const after = {
      ...BANNER, parameters: [{ name: 'tone', displayName: '色调', type: 'text', visibility: 'public' }],
      artboard: { ...BANNER.artboard, fill: '#FFFFFF', children: [BANNER.artboard.children[1], { ...PINK, children: [corner] }] },
    };
    expect(diffTemplate(BANNER, after)).toEqual([
      { path: 'parameters', target: 'template', change: 'added', properties: [{ key: 'tone', after: after.parameters[0] }] },
      { path: '问候横幅', target: 'element', change: 'changed', properties: [{ key: 'fill', after: '#FFFFFF' }, { key: 'children', before: ['底色', '文字区'], after: ['文字区', '底色'] }] },
      { path: '问候横幅/底色', target: 'element', change: 'changed', properties: [{ key: 'fill', before: '#FFF4E0', after: '#FFE8E8' }] },
      { path: '问候横幅/底色/角标', target: 'element', change: 'added', after: corner },
    ]);
    expect(diffTemplate(after, BANNER).map((change) => [change.path, change.change])).toEqual([
      ['parameters', 'removed'], ['问候横幅', 'changed'], ['问候横幅/底色', 'changed'], ['问候横幅/底色/角标', 'removed'],
    ]);
    expect(diffTemplate(BANNER, structuredClone(BANNER))).toEqual([]);
  });
});

describe('模板辅助修改：审核与应用', () => {
  it('修改前后的预览都由 RenderWeave 渲染，同时显示差异；审核时改动工作副本，差异与修改后的预览随之更新', async () => {
    const dir = await workspace(true);
    const { roundDir } = await revisionRound(dir);
    const view = (await readReview(roundDir)).view!;
    expect(view.round).toMatchObject({ round: 1, requirement: REQUIREMENT });
    expect(view.round.chain).toHaveLength(1);
    expect(view.preview).toMatchObject({ blocking: true, problems: [], request: BANNER_REQUEST });
    expect(view.previewBefore).toMatchObject({ blocking: false, problems: [], request: BANNER_REQUEST });
    const banner = view.candidates.find((candidate) => candidate.path === BANNER_FILE)!;
    expect(banner.revision).toEqual({
      status: 'modified', basis: { file: 'template-banner.json', sha256: await sha256(join(dir, 'template-banner.json')) },
      changes: [{ path: '问候横幅/底色', target: 'element', change: 'changed', properties: [{ key: 'fill', before: '#FFF4E0', after: '#FFE8E8' }] }],
    });
    expect(view.candidates.find((candidate) => candidate.path === WORDS_FILE)!.revision!.status).toBe('unchanged');

    // 两张预览与直接渲染的结果逐字节一致：修改前用已保存的模板，修改后用工作副本代替同名的已保存模板（M50）。
    const saved = await loadWorkspace({ dir: join(roundDir, 'snapshot'), resourcesDir: storeDir });
    const overlay = (document: unknown) => ({ ...saved, templates: [...saved.templates.filter((entry) => entry.name !== '问候横幅'), { name: '问候横幅', document }] });
    const draft = (dpi: number) => ({ ...BANNER_REQUEST, mode: 'draft', output: { ...BANNER_REQUEST.output, dpi } });
    const beforeBytes = await readFile(join(roundDir, view.previewBefore!.image!));
    const afterBytes = await readFile(join(roundDir, view.preview!.image!));
    expect(Buffer.from((await render(saved, draft(view.previewBefore!.dpi!))).image!.bytes)).toEqual(beforeBytes);
    expect(Buffer.from((await render(overlay(PINK_BANNER), draft(view.preview!.dpi!))).image!.bytes)).toEqual(afterBytes);
    expect(afterBytes.equals(beforeBytes)).toBe(false);

    const deeper = { ...PINK, fill: '#FFD0D0' };
    const edited = await decide(roundDir, [{ type: 'decide', item: 1, action: 'edit', value: deeper }]);
    expect(edited.candidates.find((candidate) => candidate.path === BANNER_FILE)!.revision!.changes[0]!.properties).toEqual([{ key: 'fill', before: '#FFF4E0', after: '#FFD0D0' }]);
    expect(Buffer.from((await render(overlay(withChildren(BANNER, [deeper, BANNER.artboard.children[1]])), draft(edited.preview!.dpi!))).image!.bytes))
      .toEqual(await readFile(join(roundDir, edited.preview!.image!)));
    expect(edited.previewBefore!.image).toBe(view.previewBefore!.image);
  });

  it('审核通过后工作副本替换已保存的模板，没改的不写；之后正式出图', async () => {
    const dir = await workspace(true);
    const { roundDir } = await revisionRound(dir);
    const words = await readFile(join(dir, 'template-banner-words.json'));
    await approveRevision(roundDir);
    const applied = await applyAgentRound({ roundDir });
    expect(applied.problems).toEqual([]);
    expect(applied.applied!.published).toEqual([{ candidate: BANNER_FILE, kind: 'template', name: '问候横幅', files: ['template-banner.json'], replaced: true }]);
    expect(applied.applied!.unchanged).toEqual(['横幅文字']);
    expect(await json(join(dir, 'template-banner.json'))).toEqual(PINK_BANNER);
    expect(await readFile(join(dir, 'template-banner-words.json'))).toEqual(words);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const view = (await readReview(roundDir)).view!;
    expect(view.applied?.published[0]?.replaced).toBe(true);
    expect(view.round.chain[0]!.applied).toBe(true);

    const { template, mode, ...item } = BANNER_REQUEST;
    const delivered = await deliverBatch({ workspace: await loadWorkspace({ dir, resourcesDir: storeDir }), resources: store, outDir: join(base, `batch-${++count}`),
      request: { template, mode, items: [{ id: 'banner', ...item }] } });
    expect(delivered.problems).toEqual([]);
    expect(delivered.summary).toMatchObject({ total: 1, delivered: 1 });
    expect(codes((await applyAgentRound({ roundDir })).problems)).toEqual(['apply.alreadyApplied']);

    // 应用之后再带反馈发起下一轮：候选从应用后最新保存的模板开始，已含上一轮的修改。
    const next = await run(undefined, { from: roundDir, feedback: await file('feedback.md', '本站 0 时不标本站。') });
    expect(next.record.inputs.previous).toMatchObject({ round: 1, reviewStatus: 'approved', basisChanged: true });
    expect(await json(join(next.roundDir, 'agent', BANNER_FILE))).toEqual(PINK_BANNER);
    expect((await json(join(next.roundDir, 'agent/fake-run.json'))).prompt).toContain('上一轮的成果已经应用');
    expect((await readReview(next.roundDir)).view).toMatchObject({ round: { source: 'hostRecovery' }, canApprove: false });
  });

  it('修改要求只在第 1 轮核对元素路径：上一轮把元素改了名并应用后，下一轮照样沿用修改要求', async () => {
    const dir = await workspace(true);
    const renamed = withChildren(BANNER, [{ ...PINK, name: '背景' }, BANNER.artboard.children[1]]);
    const { roundDir } = await revisionRound(dir, { 'outcome.json': { ...REVISION_SUBMISSION, locations: [], pending: [] }, [BANNER_FILE]: renamed });
    await decide(roundDir, [{ type: 'confirmRest', confirmed: true }, { type: 'approve' }]);
    expect((await applyAgentRound({ roundDir })).problems).toEqual([]);
    const next = await run(undefined, { from: roundDir, feedback: await file('feedback.md', '背景再浅一点。') });
    expect(next.record.round).toBe(2);
    expect(await readFile(join(next.roundDir, 'requirement.md'), 'utf8')).toBe(REQUIREMENT);
    expect(await json(join(next.roundDir, 'agent', BANNER_FILE))).toEqual(renamed);
  });

  it('模板已被他人保存：列出他人的改动，由人选择覆盖或基于最新内容重做（M51）', async () => {
    const dir = await workspace(true);
    const { roundDir } = await revisionRound(dir);
    await approveRevision(roundDir);
    const basis = await sha256(join(dir, 'template-banner.json'));
    const moved = { ...BANNER.artboard.children[1], place: { ...BANNER.artboard.children[1]!.place, top: 15 } };
    await writeFile(join(dir, 'template-banner.json'), JSON.stringify(withChildren(BANNER, [BANNER.artboard.children[0], moved]), null, 2));
    const theirs = await readFile(join(dir, 'template-banner.json'));

    const refused = await applyAgentRound({ roundDir });
    expect(codes(refused.problems)).toEqual(['apply.workspaceChanged']);
    expect(refused.problems[0]!.message).toContain('要修改的模板已被他人保存（问候横幅）');
    expect(refused.drift!.changed).toEqual(['template-banner.json']);
    expect(refused.drift!.templates).toEqual([{
      name: '问候横幅', basis: { file: 'template-banner.json', sha256: basis }, current: { file: 'template-banner.json', sha256: await sha256(join(dir, 'template-banner.json')) },
      changes: [{ path: '问候横幅/文字区', target: 'element', change: 'changed', properties: [{ key: 'place', before: BANNER.artboard.children[1]!.place, after: moved.place }] }],
    }]);
    expect(await readFile(join(dir, 'template-banner.json'))).toEqual(theirs);

    // 重做：带反馈发起下一轮。已保存的模板变了，候选从最新保存的内容开始，上一轮的工作副本只作参考。
    const redo = await run(undefined, { from: roundDir, feedback: await file('feedback.md', '模板已被他人改过，在最新内容上重做。') });
    expect(redo.record.inputs.previous).toMatchObject({ round: 1, reviewStatus: 'approved', basisChanged: true });
    expect(redo.record.inputs.templates![0]).toEqual({ name: '问候横幅', file: 'template-banner.json', sha256: await sha256(join(dir, 'template-banner.json')) });
    expect(await readFile(join(redo.roundDir, 'agent', BANNER_FILE))).toEqual(theirs);
    expect(await json(join(redo.roundDir, 'agent/previous', BANNER_FILE))).toEqual(PINK_BANNER);
    expect(await readFile(join(redo.roundDir, 'requirement.md'), 'utf8')).toBe(REQUIREMENT);
    expect((await json(join(redo.roundDir, 'agent/fake-run.json'))).prompt).toContain('已保存的模板在上一轮之后被人改过');

    // 覆盖：明确选择后用工作副本替换，他人的改动随之丢失，记录在应用记录里。
    const overwritten = await applyAgentRound({ roundDir, overwrite: true });
    expect(overwritten.problems).toEqual([]);
    expect(overwritten.applied).toMatchObject({ overwrite: true, drift: { templates: [{ name: '问候横幅' }] } });
    expect(await json(join(dir, 'template-banner.json'))).toEqual(PINK_BANNER);
  });

  it('多轮的模板辅助修改：已保存的模板没变时，下一轮从上一轮的工作副本继续；只有无关文件变化时不列模板冲突', async () => {
    const dir = await workspace(true);
    const first = await revisionRound(dir);
    const next = await run(undefined, { from: first.roundDir, feedback: await file('feedback.md', '底色再浅一点。') });
    expect(next.record.inputs.previous).toMatchObject({ basisChanged: false, reviewStatus: null });
    expect(await json(join(next.roundDir, 'agent', BANNER_FILE))).toEqual(PINK_BANNER);
    expect(await json(join(next.roundDir, 'agent', WORDS_FILE))).toEqual(WORDS);
    expect(next.record.inputs.request).toMatchObject({ template: '问候横幅' });

    await approveRevision(first.roundDir);
    await writeFile(join(dir, 'template-greeting.json'), (await readFile(join(dir, 'template-greeting.json'), 'utf8')).replace('#FFF4E0', '#FFFFFF'));
    const refused = await applyAgentRound({ roundDir: first.roundDir });
    expect(refused.drift!.templates).toEqual([]);
    expect(refused.problems[0]!.message).toContain('工作区自成果生成后已变化');
  });

  it('写入失败时撤回本次写入：新建模板的文件名已被占用时，已保存的模板不被替换', async () => {
    const dir = await workspace(true);
    const CORNER = { ...WORDS, name: '横幅角标' };
    const { roundDir } = await revisionRound(dir, { 'outcome.json': { ...REVISION_SUBMISSION, candidates: [BANNER_FILE, 'candidates/template-corner.json'] },
      [BANNER_FILE]: PINK_BANNER, 'candidates/template-corner.json': CORNER });
    await approveRevision(roundDir);
    await writeFile(join(dir, 'template-corner.json'), '{"note":"别人放的文件"}');
    const before = await readFile(join(dir, 'template-banner.json'));
    const failed = await applyAgentRound({ roundDir, overwrite: true });
    expect(codes(failed.problems)).toEqual(['apply.failed']);
    expect(await readFile(join(dir, 'template-banner.json'))).toEqual(before);
    expect(await readFile(join(dir, 'template-corner.json'), 'utf8')).toBe('{"note":"别人放的文件"}');
  });

  it.runIf(process.platform === 'win32')('Windows：替换第二个模板失败时，已替换的第一个恢复原内容', async () => {
    const dir = await workspace(true);
    const bigger = withChildren(WORDS, [{ ...WORDS.artboard.children[0], fontSize: 10 }]);
    const { roundDir } = await revisionRound(dir, { 'outcome.json': REVISION_SUBMISSION, [BANNER_FILE]: PINK_BANNER, [WORDS_FILE]: bigger });
    await approveRevision(roundDir);
    const banner = await readFile(join(dir, 'template-banner.json')), words = await readFile(join(dir, 'template-banner-words.json'));
    await chmod(join(dir, 'template-banner-words.json'), 0o444);
    try {
      const failed = await applyAgentRound({ roundDir });
      expect(codes(failed.problems)).toEqual(['apply.failed']);
      expect(await readFile(join(dir, 'template-banner.json'))).toEqual(banner);
      expect(await readFile(join(dir, 'template-banner-words.json'))).toEqual(words);
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      await chmod(join(dir, 'template-banner-words.json'), 0o644);
    }
  });
});

describe('agent run 按任务校验 --definition 与 --dataset（票据 16）', () => {
  const greetingRequest = join(singleTextDir, 'render-request-greeting.json');

  it('不属于该任务或缺少的 --definition、--dataset 报用法错误，不创建轮次目录', async () => {
    const dir = await workspace(false);
    const banner = await file('banner-request.json', BANNER_REQUEST);
    const cases: [Partial<AgentRunOptions>, string][] = [
      [{ task: 'dataset-extraction', workspace: dir, dataset: 'ds-x' }, '数据集提取不用 --dataset：'],
      // 以前这里在 readRequest 中解引用不存在的数据定义，抛 TypeError。
      [{ task: 'dataset-extraction', workspace: dir, dataset: 'ds-x', request: greetingRequest }, '数据集提取不用 --dataset：'],
      [{ task: 'dataset-extraction', workspace: dir, definition: '问候', dataset: 'ds-greeting' }, '数据集提取不用 --dataset：'],
      [{ task: 'definition-extraction', definition: '问候' }, '数据定义提取不用 --definition：'],
      [{ task: 'definition-extraction', workspace: dir, dataset: 'ds-x' }, '数据定义提取不用 --dataset：'],
      [{ task: 'definition-extraction', definition: '问候', dataset: 'ds-x' }, '数据定义提取不用 --definition、--dataset：'],
      [{ task: 'template-design', workspace: dir, request: banner }, '模板辅助设计要基于已保存的数据集'],
      [{ task: 'template-design', workspace: dir, definition: '问候', request: banner }, '模板辅助设计要基于已保存的数据集'],
    ];
    for (const [options, message] of cases) {
      const out = join(base, `rejected-${++count}`);
      await expect(run(undefined, { ...options, out })).rejects.toThrow(AgentUsageError);
      await expect(run(undefined, { ...options, out })).rejects.toThrow(message);
      expect(existsSync(out)).toBe(false);
    }

    // 命令行：退出码 2，同样不创建轮次目录。
    const inputs = ['--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', join(base, 'brief.md'), '--resources', storeDir];
    const commands: [string[], string][] = [
      [['--task', '数据集提取', '--workspace', dir, '--dataset', 'ds-x'], '数据集提取不用 --dataset：'],
      [['--task', '数据集提取', '--workspace', dir, '--dataset', 'ds-x', '--request', greetingRequest], '数据集提取不用 --dataset：'],
      [['--task', '数据定义提取', '--definition', '问候'], '数据定义提取不用 --definition：'],
      [['--task', '数据定义提取', '--workspace', dir, '--dataset', 'ds-x'], '数据定义提取不用 --dataset：'],
    ];
    for (const [args, message] of commands) {
      const out = join(base, `cli-rejected-${++count}`);
      expect(await cli([...args, ...inputs, '--out', out])).toEqual([2, expect.stringContaining(message)]);
      expect(existsSync(out)).toBe(false);
    }
  });

  it('该任务用得上的参数照常发起：数据集提取给 --definition；模板辅助设计 --definition 可省略；模板辅助修改 --dataset 可选', async () => {
    const dir = await workspace(true);
    const extraction = await run(undefined, { task: 'dataset-extraction', workspace: dir, definition: '问候', request: greetingRequest });
    const greeting = { name: '问候', version: 1 };
    expect(extraction.record.inputs).toMatchObject({ definition: greeting, dataset: null, request: { template: '问候牌' } });
    expect(await json(join(extraction.roundDir, 'logs/outcome-context.json'))).toEqual({ task: 'dataset-extraction', definition: greeting, request: await json(join(extraction.roundDir, 'request.json')) });
    expect((await json(join(extraction.roundDir, 'agent/fake-run.json'))).prompt).toContain('按已发布的数据定义 问候 v1，');

    const request = await file('banner-request.json', BANNER_REQUEST);
    for (const definition of [undefined, '问候', '问候@1']) {
      const design = await run(undefined, { task: 'template-design', workspace: dir, dataset: 'ds-greeting', request, ...(definition ? { definition } : {}) });
      expect(design.record.inputs).toMatchObject({ definition: greeting, dataset: 'ds-greeting' });
    }

    const requirement = await file('requirement.md', REQUIREMENT);
    for (const dataset of [undefined, 'ds-greeting']) {
      const revision = await run(undefined, { task: 'template-revision', workspace: dir, request, requirement, ...(dataset ? { dataset } : {}) });
      expect(revision.record.inputs).toMatchObject({ definition: null, dataset: 'ds-greeting', request: { template: '问候横幅' } });
    }
  });
});

describe('agent run 先校验出图请求再开始，用满轮数时说明原因（票据 28）', () => {
  it('出图请求缺 mode：第一行就是用法错误，没有"开始"，不建轮次目录', async () => {
    const dir = await workspace(false);
    const { mode: _mode, ...noMode } = BANNER_REQUEST;
    const out = join(base, `round-${++count}`);
    const [code, stderr] = await cli(['--task', '模板辅助设计', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', join(base, 'brief.md'),
      '--resources', storeDir, '--workspace', dir, '--dataset', 'ds-greeting', '--request', await file('no-mode.json', noMode), '--out', out]);
    expect(code).toBe(2);
    expect(stderr.startsWith('出图请求不合格')).toBe(true);
    expect(stderr).not.toContain('开始');
    expect(existsSync(out)).toBe(false);
  });

  it('用满轮数：run.error 说明轮数上限与 --from，不是空的"模型服务报错："', async () => {
    const result = await designRound(await workspace(false), { '.max-turns': '80' });
    expect(result.record.run.endedBy).toBe('error_max_turns');
    expect(result.record.run.error).toBe('用满了轮数上限（80 轮）；没有交回成果时，可以用 --from 带反馈接着做');
    expect(result.check.verdict).toBe('unqualified');
  });
});

describe('推理力度与思考 token（票据 23）', () => {
  it('--effort 传给 Claude Code，round.json 记力度与思考 token；不给时不传', async () => {
    const given = await designRound(await workspace(false));
    const low = await run({ 'outcome.json': DESIGN_SUBMISSION, [BANNER_FILE]: BANNER, [WORDS_FILE]: WORDS },
      { task: 'template-design', workspace: await workspace(false), dataset: 'ds-greeting', request: await file('banner-request.json', BANNER_REQUEST), effort: 'low' });
    const args = async (dir: string): Promise<string[]> => (await json(join(dir, 'agent/fake-run.json'))).args;
    const effortOf = (list: string[]) => (list.includes('--effort') ? list[list.indexOf('--effort') + 1] : undefined);
    expect(effortOf(await args(low.roundDir))).toBe('low');
    expect(low.record.runtime.effort).toBe('low');
    expect(low.record.run.thinkingTokens).toBe(150);
    expect(effortOf(await args(given.roundDir))).toBeUndefined();
    expect(given.record.runtime.effort).toBeNull();
    expect(given.record.run.thinkingTokens).toBe(150);
  });

  it('--effort 取值不对时是用法错误', async () => {
    const [code, stderr] = await cli(['--task', '数据定义提取', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', join(base, 'brief.md'),
      '--resources', storeDir, '--out', join(base, `round-${++count}`), '--effort', 'tiny']);
    expect([code, stderr]).toEqual([2, '--effort 只能取 low、medium、high、xhigh、max\n']);
  });
});
