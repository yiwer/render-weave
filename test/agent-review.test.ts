/**
 * 审核与应用（第三阶段票据 05、验收 A07、A08）：用假执行器造出一轮成果，经公开入口与命令行审核、应用，
 * 断言 review.json、能否通过、写进工作区的内容，以及被拒绝时工作区一字不变。审核页服务另做接口级测试。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { applyAgentRound, changeReview, readReview, runAgentTask, startReviewServer, type ReviewView } from '../src/index.js';
import { copyWorkspaceFixture, resourcesDir, singleTextDir } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const KEY = `rw-test-key-${Math.random().toString(36).slice(2)}`;

const ROLE = { name: 'role', displayName: '身份', type: 'text', constraints: { enum: ['讲者'] } };
const BADGE = { dslVersion: 'renderweave-schema/1', name: '胸牌', fields: [
  { name: 'fullName', displayName: '姓名', type: 'text', constraints: { required: true, maxLength: 12 } },
  ROLE,
  { name: 'seat', displayName: '座位号', type: 'number', constraints: { integer: true, min: 1 } },
  { name: 'session', displayName: '场次', type: 'ref', ref: { name: '场次', version: 1 } },
  { name: 'tags', displayName: '标签', type: 'list', items: { type: 'text', constraints: { maxLength: 4 } }, constraints: { maxItems: 3 } },
] };
const SESSION = { dslVersion: 'renderweave-schema/1', name: '场次', fields: [{ name: 'title', displayName: '标题', type: 'text', constraints: { required: true } }] };
const GREETING = { dslVersion: 'renderweave-schema/1', name: '问候', fields: [{ name: 'message', displayName: '问候语', type: 'text' }] };
const SUBMISSION = {
  candidates: ['candidates/schema-badge.json', 'candidates/schema-session.json', 'candidates/schema-greeting.json'],
  locations: [
    { file: 'candidates/schema-badge.json', path: 'fullName', where: '正中大号姓名', region: { x: 10, y: 20, width: 30, height: 15 } },
    { file: 'candidates/schema-badge.json', path: 'role', where: '姓名下方色带' },
  ],
  pending: [
    { file: 'candidates/schema-badge.json', path: 'role', candidate: ['讲者', '嘉宾'], reason: 'inferred', note: '图上只有讲者' },
    { file: 'candidates/schema-badge.json', path: 'seat', reason: 'unreadable', note: '座位号印得很淡' },
    { file: 'candidates/schema-greeting.json', reason: 'conflicting', note: '与工作区已有的问候冲突' },
  ],
  notes: '关键取舍：场次单独成定义。',
};
const EDITED_ROLE = { name: 'role', displayName: '身份', type: 'text', constraints: { required: true, enum: ['讲者', '嘉宾', '工作人员'] } };

let base: string;
let count = 0;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-review-'));
  await writeFile(join(base, 'brief.md'), '# 项目说明：示例会议胸牌\n');
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 工作区副本：顶层 JSON 文件来自 single-text，另可加文件。 */
async function workspaceCopy(extra: Record<string, unknown> = {}): Promise<string> {
  const dir = join(base, `workspace-${++count}`);
  await copyWorkspaceFixture(singleTextDir, dir);
  for (const [file, value] of Object.entries(extra)) await writeFile(join(dir, file), JSON.stringify(value, null, 2));
  return dir;
}

/** 用假执行器跑一轮，返回轮次目录。 */
async function round(options: { workspace?: string; submission?: unknown; files?: Record<string, unknown> } = {}): Promise<string> {
  const preset = join(base, `preset-${++count}`);
  const files = options.files ?? { 'candidates/schema-badge.json': BADGE, 'candidates/schema-session.json': SESSION, 'candidates/schema-greeting.json': GREETING };
  for (const [path, value] of Object.entries({ 'outcome.json': options.submission ?? SUBMISSION, ...files })) {
    await mkdir(join(preset, path, '..'), { recursive: true });
    await writeFile(join(preset, path), JSON.stringify(value, null, 2));
  }
  const result = await runAgentTask({
    task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'), brief: join(base, 'brief.md'), resources: resourcesDir,
    out: join(base, `round-${++count}`), key: KEY, keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] },
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
  });
  expect(result.outcome).toBeDefined();
  return result.roundDir;
}

/** 处理全部待确认项并整体确认：role 改值、seat 标为空、问候采纳。 */
async function decideAll(dir: string): Promise<ReviewView> {
  for (const change of [
    { type: 'decide', item: 1, action: 'edit', value: EDITED_ROLE },
    { type: 'decide', item: 2, action: 'empty' },
    { type: 'decide', item: 3, action: 'adopt' },
    { type: 'confirmRest', confirmed: true },
  ]) expect((await changeReview(dir, change)).problems).toEqual([]);
  return (await readReview(dir)).view!;
}

async function approved(dir: string): Promise<void> {
  await decideAll(dir);
  expect((await changeReview(dir, { type: 'approve' })).problems).toEqual([]);
}

/** 目录下全部文件及内容，用来断言工作区一字不变。 */
async function contents(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) result[join(entry.parentPath, entry.name).slice(dir.length + 1)] = (await readFile(join(entry.parentPath, entry.name))).toString('base64');
  }
  return result;
}

const codes = (problems: readonly { code: string }[]) => problems.map((problem) => problem.code);
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('审核视图', () => {
  it('列出待确认项、字段清单（类型、约束、图上位置）与编译产物摘要；没处理完不能通过', async () => {
    const dir = await round({ workspace: await workspaceCopy() });
    const { view, problems } = await readReview(dir);
    expect(problems).toEqual([]);
    expect(view).toMatchObject({ saved: false, canApprove: false, review: { status: 'inProgress', decisions: [], restConfirmed: false },
      round: { task: 'definition-extraction', taskName: '数据定义提取', verdict: 'qualified', sample: 'agent/sample.png', notes: SUBMISSION.notes } });
    expect(view!.problems.map((problem) => problem.message)).toEqual([
      '待确认项 1 尚未处理：candidates/schema-badge.json · role',
      '待确认项 2 尚未处理：candidates/schema-badge.json · seat',
      '待确认项 3 尚未处理：candidates/schema-greeting.json',
      '其余内容尚未整体确认',
    ]);
    expect(view!.pending[0]).toMatchObject({ item: 1, reasonName: '推测', current: ROLE, candidate: ['讲者', '嘉宾'], location: SUBMISSION.locations[1] });
    expect(view!.pending[2]).toMatchObject({ item: 3, reasonName: '来源冲突', current: GREETING });

    const badge = view!.candidates.find((candidate) => candidate.name === '胸牌')!;
    expect(badge.fields.map((field) => [field.name, field.type, field.constraints, field.location?.where ?? null, field.pending, field.state])).toEqual([
      ['fullName', '文本', ['必填', '长度 ≤ 12'], '正中大号姓名', [], 'kept'],
      ['role', '文本', ['可选值 讲者'], '姓名下方色带', [1], 'kept'],
      ['seat', '数值', ['取值 ≥ 1', '整数'], null, [2], 'kept'],
      ['session', '引用 场次 v1', [], null, [], 'kept'],
      ['tags', '列表<文本>', ['项数 ≤ 3', '每项长度 ≤ 4'], null, [], 'kept'],
    ]);
    expect(badge.fields[0]!.location?.region).toEqual({ x: 10, y: 20, width: 30, height: 15 });
    expect(badge).toMatchObject({ published: { name: '胸牌', version: 1 }, compiled: { title: '胸牌 v1', properties: 5, required: ['fullName'] } });
    expect(badge.compiled!.schema['x-renderweave-static-schema']).toEqual({ name: '胸牌', version: 1 });
    expect(view!.candidates.find((candidate) => candidate.name === '问候')!.published).toEqual({ name: '问候', version: 2 });

    const refused = await changeReview(dir, { type: 'approve' });
    expect(codes(refused.problems)).toEqual(['review.pending']);
    expect(refused.problems[0]!.message).toContain('待确认项 1 尚未处理');
    expect(await readdir(dir)).not.toContain('review.json');
  });

  it('逐项处理并整体确认后可以通过；审核结果存进 review.json，关闭后重开继续', async () => {
    const dir = await round({ workspace: await workspaceCopy() });
    expect((await changeReview(dir, { type: 'decide', item: 1, action: 'edit', value: EDITED_ROLE })).problems).toEqual([]);
    // 关闭后重开：重新读取，处理结果仍在。
    const reopened = (await readReview(dir)).view!;
    expect(reopened.saved).toBe(true);
    expect(reopened.pending[0]!.decision).toEqual({ item: 1, file: 'candidates/schema-badge.json', path: 'role', action: 'edit', value: EDITED_ROLE });
    expect(reopened.pending[1]!.decision).toBeUndefined();

    const view = await decideAll(dir);
    expect(view.canApprove).toBe(true);
    expect(view.problems).toEqual([]);
    const badge = view.candidates.find((candidate) => candidate.name === '胸牌')!;
    expect(badge.fields.map((field) => [field.name, field.state, field.constraints])).toEqual([
      ['fullName', 'kept', ['必填', '长度 ≤ 12']],
      ['role', 'edited', ['必填', '可选值 讲者、嘉宾、工作人员']],
      ['seat', 'removed', ['取值 ≥ 1', '整数']],
      ['session', 'kept', []],
      ['tags', 'kept', ['项数 ≤ 3', '每项长度 ≤ 4']],
    ]);
    expect(badge.compiled!.required).toEqual(['fullName', 'role']);
    expect((badge.document as { fields: { name: string }[] }).fields.map((field) => field.name)).toEqual(['fullName', 'role', 'session', 'tags']);

    expect((await changeReview(dir, { type: 'approve', comment: '身份按会务分类补全' })).problems).toEqual([]);
    const saved = await json(join(dir, 'review.json'));
    expect(saved).toMatchObject({ format: 'renderweave-review/1', status: 'approved', restConfirmed: true, comment: '身份按会务分类补全',
      outcomeSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(saved.decisions.map((decision: { item: number; action: string }) => [decision.item, decision.action])).toEqual([[1, 'edit'], [2, 'empty'], [3, 'adopt']]);

    // 给出结论后要先撤回才能改；撤回后回到审核中。
    const locked = await changeReview(dir, { type: 'decide', item: 2, action: 'adopt' });
    expect(locked.problems.map((problem) => problem.message)).toEqual([expect.stringContaining('先撤回结论')]);
    expect((await changeReview(dir, { type: 'reopen' })).view!.review).toMatchObject({ status: 'inProgress' });
    expect((await json(join(dir, 'review.json'))).decidedAt).toBeUndefined();
  });

  it('拒绝不合规的操作；改值后定义不合格时不能通过；同一位置的处理结果不一致时报出', async () => {
    const dir = await round({ workspace: await workspaceCopy() });
    for (const [change, message] of [
      [{ type: 'decide', item: 9, action: 'adopt' }, '没有待确认项 9'],
      [{ type: 'decide', item: 1, action: 'guess' }, '处理方式只能是 adopt、edit、empty'],
      [{ type: 'decide', item: 1, action: 'edit' }, '改值时要给出字段 role 的完整写法'],
      [{ type: 'decide', item: 3, action: 'edit', value: [] }, '改值时要给出整份定义'],
      [{ type: 'decide', item: 1, action: 'empty', value: 1 }, '只有改值才带新值'],
      [{ type: 'reject', comment: '  ' }, '审核未通过时要写明理由'],
      [{ type: 'reopen' }, '没有可撤回的结论'],
      [{ type: 'publish' }, '无法识别的审核操作'],
      ['approve', '审核操作必须是带 type 的对象'],
    ] as const) {
      const result = await changeReview(dir, change);
      expect([codes(result.problems), result.problems[0]?.message]).toEqual([['review.invalid'], expect.stringContaining(message)]);
    }
    expect(await readdir(dir)).not.toContain('review.json');

    await decideAll(dir);
    const broken = await changeReview(dir, { type: 'decide', item: 1, action: 'edit', value: { ...EDITED_ROLE, type: 'colour' } });
    expect(broken.problems).toEqual([]);
    expect(broken.view!.canApprove).toBe(false);
    expect(codes(broken.view!.candidates.find((candidate) => candidate.name === '胸牌')!.problems)).toContain('definition.invalid');
    expect(codes((await changeReview(dir, { type: 'approve' })).problems)).toEqual(['review.pending']);

    // 两个待确认项指向同一字段，一个改值、一个标为空。
    const twice = await round({ submission: { ...SUBMISSION, pending: [SUBMISSION.pending[0], { ...SUBMISSION.pending[0], reason: 'conflicting', note: '两处写法不同' }] } });
    await changeReview(twice, { type: 'decide', item: 1, action: 'edit', value: EDITED_ROLE });
    const conflict = await changeReview(twice, { type: 'decide', item: 2, action: 'empty' });
    expect(conflict.view!.problems.map((problem) => [problem.code, problem.message])).toContainEqual(['review.invalid', '待确认项 1、2 指向同一位置，处理结果不一致']);
  });

  it('整份标为空的候选不发布，引用它的定义随之报错；整份改值以审核结果为准，字段按原文比对标出改动', async () => {
    const dir = await round({ submission: { ...SUBMISSION, pending: [
      { file: 'candidates/schema-session.json', reason: 'inferred', note: '场次也许不必单列' },
      { file: 'candidates/schema-badge.json', reason: 'requiredMissing', note: '图上看不出是否有贵宾通道标记' },
    ] } });
    const dropped = (await changeReview(dir, { type: 'decide', item: 1, action: 'empty' })).view!;
    const session = dropped.candidates.find((candidate) => candidate.path === 'candidates/schema-session.json')!;
    expect(session).toMatchObject({ dropped: true });
    expect(session.published).toBeUndefined();
    expect(codes(dropped.candidates.find((candidate) => candidate.name === '胸牌')!.problems)).toContain('definition.refNotFound');

    await changeReview(dir, { type: 'decide', item: 1, action: 'adopt' });
    const vip = { name: 'vip', displayName: '贵宾通道', type: 'boolean' };
    const rewritten = { ...BADGE, fields: [BADGE.fields[0], EDITED_ROLE, BADGE.fields[3], BADGE.fields[4], vip] };
    const edited = (await changeReview(dir, { type: 'decide', item: 2, action: 'edit', value: rewritten })).view!;
    const badge = edited.candidates.find((candidate) => candidate.path === 'candidates/schema-badge.json')!;
    expect(badge).toMatchObject({ edited: true, dropped: false, published: { name: '胸牌', version: 1 }, problems: [] });
    expect(badge.fields.map((field) => [field.name, field.state])).toEqual([
      ['fullName', 'kept'], ['role', 'edited'], ['session', 'kept'], ['tags', 'kept'], ['vip', 'edited'], ['seat', 'removed'],
    ]);
    expect(badge.fields[0]!.location?.where).toBe('正中大号姓名');
    expect(badge.compiled!.properties).toBe(5);
  });

  it('review.json 针对的不是当前成果、候选被改动、没有成果时都不能继续', async () => {
    const dir = await round();
    await changeReview(dir, { type: 'confirmRest', confirmed: true });
    const review = await json(join(dir, 'review.json'));
    await writeFile(join(dir, 'review.json'), JSON.stringify({ ...review, outcomeSha256: '0'.repeat(64) }));
    const { view } = await readReview(dir);
    expect(view!.problems.map((problem) => [problem.code, problem.message])).toContainEqual(
      ['review.invalid', '审核结果针对的是另一份成果（outcome.json 已变化）；删除 review.json 后重新审核']);
    expect(codes((await changeReview(dir, { type: 'confirmRest', confirmed: false })).problems)).toEqual(['review.invalid']);

    await writeFile(join(dir, 'candidates/schema-session.json'), JSON.stringify({ ...SESSION, name: '会场' }));
    const tampered = await readReview(dir);
    expect(tampered.view).toBeUndefined();
    expect(tampered.problems.map((problem) => problem.message)).toEqual(['候选文件自成果生成后被改动：candidates/schema-session.json']);

    const empty = join(base, 'not-a-round');
    await mkdir(empty, { recursive: true });
    expect(codes((await readReview(empty)).problems)).toEqual(['round.invalid']);
  });
});

describe('应用', () => {
  it('未审核、审核中与审核未通过的轮次都不能应用，工作区一字不变', async () => {
    const workspace = await workspaceCopy();
    const dir = await round({ workspace });
    const before = await contents(workspace);
    const unreviewed = await applyAgentRound({ roundDir: dir });
    expect([codes(unreviewed.problems), unreviewed.problems[0]!.message]).toEqual([['review.notApproved'], expect.stringContaining('还没有审核')]);

    await decideAll(dir);
    expect((await applyAgentRound({ roundDir: dir })).problems[0]!.message).toBe('审核还没有通过；不能应用');

    await changeReview(dir, { type: 'reject', comment: '身份分类需要客户确认' });
    const rejected = await applyAgentRound({ roundDir: dir });
    expect(rejected.problems[0]!.message).toBe('审核未通过：身份分类需要客户确认；不能应用');
    expect(rejected.applied).toBeUndefined();
    expect(await contents(workspace)).toEqual(before);
    expect(await readdir(dir)).not.toContain('applied.json');
  });

  it('审核通过后发布为下一个版本，审核时改过的内容以审核结果为准；同一轮不能再应用', async () => {
    const workspace = await workspaceCopy();
    const dir = await round({ workspace });
    await approved(dir);
    const result = await applyAgentRound({ roundDir: dir });
    expect(result.problems).toEqual([]);
    expect(result.drift).toBeUndefined();
    expect(result.applied!.published.map((item) => [item.candidate, item.name, item.version, item.files])).toEqual([
      ['candidates/schema-session.json', '场次', 1, ['schema-session-v1.json', 'compiled-session-v1.schema.json']],
      ['candidates/schema-greeting.json', '问候', 2, ['schema-greeting-v2.json', 'compiled-greeting-v2.schema.json']],
      ['candidates/schema-badge.json', '胸牌', 1, ['schema-badge-v1.json', 'compiled-badge-v1.schema.json']],
    ]);
    const badge = await json(join(workspace, 'schema-badge-v1.json'));
    expect(badge.version).toBe(1);
    expect(badge.fields.map((field: { name: string }) => field.name)).toEqual(['fullName', 'role', 'session', 'tags']);
    expect(badge.fields[1]).toEqual(EDITED_ROLE);
    expect((await json(join(workspace, 'compiled-badge-v1.schema.json')))['x-renderweave-static-schema']).toEqual({ name: '胸牌', version: 1 });
    expect(await json(join(workspace, 'schema-greeting-v2.json'))).toEqual({ ...GREETING, version: 2 });
    expect(await json(join(dir, 'applied.json'))).toEqual(result.applied);
    expect(result.applied).toMatchObject({ format: 'renderweave-applied/2', workspace, overwrite: false });
    expect(result.applied!.fingerprints.before).toBe(result.applied!.fingerprints.round);

    const again = await applyAgentRound({ roundDir: dir, overwrite: true });
    expect(again.problems).toEqual([]); expect(again.applied).toEqual(result.applied);
    expect(codes((await changeReview(dir, { type: 'reopen' })).problems)).toEqual(['review.invalid']);
    expect((await readReview(dir)).view!.applied).toEqual(result.applied);
  });

  it('工作区自成果生成后已变化：列出差异并拒绝；明确选择覆盖后按当前工作区发布，候选间的引用改到新版本', async () => {
    const workspace = await workspaceCopy();
    const dir = await round({ workspace });
    await approved(dir);
    // 别人先发布了场次 v1，并改了模板。
    await writeFile(join(workspace, 'schema-meeting-v1.json'), JSON.stringify({ ...SESSION, version: 1 }));
    await writeFile(join(workspace, 'template-greeting.json'), (await readFile(join(workspace, 'template-greeting.json'), 'utf8')).replace('}', ' }'));
    const before = await contents(workspace);

    const refused = await applyAgentRound({ roundDir: dir });
    expect(codes(refused.problems)).toEqual(['apply.workspaceChanged']);
    expect(refused.drift).toMatchObject({ added: ['schema-meeting-v1.json'], removed: [], changed: ['template-greeting.json'],
      newerDefinitions: [{ name: '场次', snapshot: null, workspace: 1 }] });
    expect(refused.drift!.expected).not.toBe(refused.drift!.actual);
    expect(await contents(workspace)).toEqual(before);

    const result = await applyAgentRound({ roundDir: dir, overwrite: true });
    expect(result.problems).toEqual([]);
    expect(result.applied!.overwrite).toBe(true);
    expect(result.applied!.published.map((item) => `${item.name} v${item.version}`)).toEqual(['场次 v2', '问候 v2', '胸牌 v1']);
    expect((await json(join(workspace, 'schema-badge-v1.json'))).fields[2].ref).toEqual({ name: '场次', version: 2 });
    expect(await readFile(join(workspace, 'schema-meeting-v1.json'), 'utf8')).toBe(Buffer.from(before['schema-meeting-v1.json']!, 'base64').toString('utf8'));
  });

  it('写入失败时撤回本次写入，工作区保持原状', async () => {
    // 工作区里已有一个不是数据定义的同名文件：快照中也有，所以指纹不变；写到胸牌时排他创建失败。
    const workspace = await workspaceCopy({ 'schema-badge-v1.json': { note: '占位，不是数据定义' } });
    const dir = await round({ workspace });
    await approved(dir);
    const before = await contents(workspace);
    const result = await applyAgentRound({ roundDir: dir });
    expect([codes(result.problems), result.problems[0]!.message]).toEqual([['apply.failed'], expect.stringContaining('提交目标状态变化')]);
    expect(await contents(workspace)).toEqual(before);
    expect(await readdir(dir)).not.toContain('applied.json');
  });
});

describe('命令行', () => {
  async function cli(args: string[], signal?: AbortSignal, onStdout?: (text: string) => void) {
    const stdout: string[] = [], stderr: string[] = [];
    const code = await runCli(['agent', ...args], {
      stdout: (text) => { stdout.push(text); onStdout?.(text); }, stderr: (text) => stderr.push(text), ...(signal ? { signal } : {}),
    });
    return { code, stdout: stdout.join(''), stderr: stderr.join('') };
  }

  it('agent apply：用法错误为 2；未审核、工作区已变化为 1；--overwrite 后为 0', async () => {
    const workspace = await workspaceCopy();
    const dir = await round({ workspace });
    for (const args of [['apply'], ['apply', dir, dir], ['apply', dir, '--force'], ['apply', dir, '--workspace', '']]) {
      expect((await cli(args)).code).toBe(2);
    }
    const unreviewed = await cli(['apply', dir]);
    expect([unreviewed.code, unreviewed.stderr]).toEqual([1, expect.stringContaining('[严重] review.notApproved')]);

    await approved(dir);
    await writeFile(join(workspace, 'schema-meeting-v1.json'), JSON.stringify({ ...SESSION, version: 1 }));
    const changed = await cli(['apply', dir]);
    expect(changed.code).toBe(1);
    expect(changed.stderr).toContain('同名数据定义已发布新版本：场次 （快照中没有） → v1');
    expect(changed.stderr).toContain('新增：schema-meeting-v1.json');
    const overwritten = await cli(['apply', dir, '--overwrite']);
    expect(overwritten.code).toBe(0);
    expect(JSON.parse(overwritten.stdout)).toMatchObject({ workspace, overwrite: true, published: [{ name: '场次', version: 2 }, { name: '问候', version: 2 }, { name: '胸牌', version: 1 }] });

    // 本轮没有工作区：必须指定 --workspace。
    const bare = await round();
    await approved(bare);
    expect(await cli(['apply', bare])).toMatchObject({ code: 2, stderr: expect.stringContaining('用 --workspace 指定') });
    const target = join(base, 'fresh-workspace');
    await mkdir(target);
    expect((await cli(['apply', bare, '--workspace', target])).code).toBe(0);
    expect((await readdir(target)).sort()).toEqual(['compiled-badge-v1.schema.json', 'compiled-greeting-v1.schema.json', 'compiled-session-v1.schema.json',
      'schema-badge-v1.json', 'schema-greeting-v1.json', 'schema-session-v1.json']);
  });

  it('agent review：打印本机地址，审核页服务读写审核结果、给出示例图，Ctrl+C 后结束', async () => {
    const dir = await round({ workspace: await workspaceCopy() });
    expect((await cli(['review', join(base, 'no-such-round'), '--no-open'])).code).toBe(1);
    expect((await cli(['review', dir, '--port', 'x'])).code).toBe(2);

    const controller = new AbortController();
    let resolveUrl!: (url: string) => void;
    const started = new Promise<string>((done) => { resolveUrl = done; });
    const running = cli(['review', dir, '--port', '0', '--no-open'], controller.signal, (text) => resolveUrl(text.trim()));
    const url = await started;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const page = await fetch(url);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('textContent');
    const state = await (await fetch(`${url}api/review`)).json() as { view: ReviewView };
    expect(state.view.pending).toHaveLength(3);
    expect(Buffer.from(await (await fetch(`${url}sample`)).arrayBuffer())).toEqual(await readFile(join(dir, 'agent/sample.png')));

    const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${url}api/review`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const decided = await post({ type: 'decide', item: 2, action: 'empty' });
    expect(decided.status).toBe(200);
    expect(((await decided.json()) as { view: ReviewView }).view.pending[1]!.decision).toMatchObject({ action: 'empty' });
    expect((await json(join(dir, 'review.json'))).decisions).toHaveLength(1);
    expect((await post({ type: 'approve' })).status).toBe(409);
    expect((await post({ type: 'confirmRest', confirmed: true }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await fetch(`${url}api/review`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"type":"reopen"}' })).status).toBe(415);
    // 非 UTF-8 的请求体（Windows 命令行按本地代码页发出的中文）拒绝，不把乱码存进 review.json。
    const gbk = Buffer.concat([Buffer.from('{"type":"reject","comment":"'), Buffer.from([0xb5, 0xd8, 0xb1, 0xea]), Buffer.from('"}')]);
    const garbled = await fetch(`${url}api/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: gbk });
    expect([garbled.status, ((await garbled.json()) as { error: string }).error]).toEqual([400, expect.stringContaining('不是有效的 UTF-8')]);
    const rebound = await new Promise<number>((done, fail) => {
      const request = httpRequest(`${url}api/review`, { headers: { host: 'attacker.example' } }, (response) => { response.resume(); done(response.statusCode!); });
      request.on('error', fail);
      request.end();
    });
    expect(rebound).toBe(403);
    expect((await json(join(dir, 'review.json'))).restConfirmed).toBe(false);

    controller.abort();
    expect((await running).code).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('审核页服务可单独启动，关闭后端口释放', async () => {
    const dir = await round();
    const server = await startReviewServer({ roundDir: dir });
    expect((await fetch(`${server.url}api/review`)).status).toBe(200);
    expect((await fetch(`${server.url}nothing`)).status).toBe(404);
    await server.close();
    await expect(fetch(server.url)).rejects.toThrow();
  });
});
