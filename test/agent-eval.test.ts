/**
 * Agent 评估（第三阶段票据 08、验收 A10）：评分函数用存档的历史成果离线校准，与当年的记录对照；
 * 编排用假执行器走完四种场景（数据定义、模板、模板辅助修改、366 的两轮），断言评分、判定、门槛、报告与重新评分。
 * 上游错误（票据 21）用假执行器模拟模型服务报错与发起失败：分类、按轮次重试、额度熔断与续跑、invalid 的门槛语义。不调用模型。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildReport, classifyError, countPersisted, formatReport, gate, judge, resumeCommand, runScenario, runUnits, scoreScenario, unitDir,
  type Launcher, type RoundSpec, type ScenarioResult, type UnitStatus,
} from '../scripts/agent-eval/eval.js';
import { readConfig, type EvalConfig, type Scenario } from '../scripts/agent-eval/scenarios.js';
import { scoreDefinitions, scoreTemplates, scoreTranscription, stopsOf, type TruthStop } from '../scripts/agent-eval/score.js';
import { runAgentTask, type AgentTaskId } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';

const FAKE = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const FIXTURES = join(repoRoot, 'fixtures/agent-eval');
const KEY = `rw-test-key-${Math.random().toString(36).slice(2)}`;
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as unknown;
const folder = async (dir: string) => Promise.all((await readdir(dir)).sort().map((file) => read(join(dir, file))));
const templatesOf = async (set: string) => (await folder(join(FIXTURES, 'templates', set))).map((document) => ({ name: String((document as { name: string }).name), document }));
/** 真实出现过的 500 原文（out/agent-eval/2026-10-18-check-outcome-366.interrupted-500.log）：Claude Code 自己重试之后才报出来。 */
const SERVER_500 = 'API Error: 500 status code (no body). This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (opencode.ai).';
const QUOTA_429 = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"5-hour usage limit reached"}}';

let base: string, config: EvalConfig, count = 0;
const scenario = (id: string) => config.scenarios.find((item) => item.id === id)!;

/** 经 runAgentTask 发起一轮，与命令行同一路径。files 是 Agent 交回的文件；apiError 时假执行器模拟模型服务报错。 */
async function fakeRound(spec: RoundSpec, files: Record<string, unknown>, apiError?: string): Promise<void> {
  const preset = join(base, `preset-${++count}`);
  await mkdir(join(preset, 'candidates'), { recursive: true });
  for (const [path, value] of Object.entries(files)) await writeFile(join(preset, path), JSON.stringify(value, null, 2));
  if (apiError !== undefined) await writeFile(join(preset, '.api-error'), apiError);
  await runAgentTask({ ...spec, key: KEY, keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] } });
}

/** 按任务给出 Agent 交回的文件。 */
function launcher(presets: Partial<Record<AgentTaskId, Record<string, unknown>>>, fail?: AgentTaskId): Launcher {
  return async (spec) => {
    if (spec.task === fail) throw new Error(`发起${spec.task}失败：模拟的用法错误`);
    await fakeRound(spec, presets[spec.task] ?? {});
  };
}

type Step = { readonly api: string } | { readonly throws: string };

/** 每个任务依次取一步：api 是模型服务报错（进 round.json 的 run.error），throws 是发起失败；步骤用完后照 presets 交回。calls 记下每次发起的任务。 */
function flaky(presets: Partial<Record<AgentTaskId, Record<string, unknown>>>, steps: Partial<Record<AgentTaskId, Step[]>>, calls: AgentTaskId[] = []): Launcher {
  return async (spec) => {
    calls.push(spec.task);
    const step = steps[spec.task]?.shift();
    if (step && 'throws' in step) throw new Error(step.throws);
    await fakeRound(spec, step ? {} : presets[spec.task] ?? {}, step?.api);
  };
}

const definitionFiles = async (dir: string, pending: unknown[] = []) => ({
  'candidates/schema-route.json': await read(join(dir, 'route.json')), 'candidates/schema-stop.json': await read(join(dir, 'stop.json')),
  'outcome.json': { candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'], pending, notes: '评估夹具。' },
});

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-agent08-'));
  config = await readConfig();
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('评分：用存档的历史成果校准', () => {
  it('数据定义：专家字段与 6 项约定，与 M211–M217 的记录一致', async () => {
    const scores = Object.fromEntries(await Promise.all(['des-gd1', 'hints1', 'hints2', 'des-g1', 't04', 'run1'].map(async (run) =>
      [run, scoreDefinitions(await folder(join(FIXTURES, 'definitions', run)))] as const)));
    const summary = Object.fromEntries(Object.entries(scores).map(([run, score]) => [run, [score.expertFields.matched, score.expertFields.missing, score.conventionsPassed]]));
    expect(summary).toEqual({
      // 通用指南 + 线路牌约定：15 个专家字段全部对上，6 项约定全过（M216）。
      'des-gd1': [15, [], 6],
      // 旧版约定文档两次：各 14（M213）。
      hints1: [14, ['班车类型'], 6],
      hints2: [14, ['运营方'], 6],
      // 只给通用指南：13，地标没建、设了终点站字段（M216）。
      'des-g1': [13, ['班车类型', '地标'], 4],
      // 票据 04 的产品命令实跑：人工对照为 13，缺运营方与班车类型。
      t04: [13, ['运营方', '班车类型'], 6],
      // 只有 DSL 参考的首轮：约定 0–1 项（M211）。
      run1: [10, ['票制', '票价', '班车类型', '站名上方的标识', '地标'], 1],
    });
    expect(scores['des-g1']!.conventions).toMatchObject({ landmark: false, noTerminalField: false });
    expect(scores['run1']!.conventions).toEqual({ landmark: false, badges: false, fareIsNumber: false, noTerminalField: false, noCurrentStop: false, routeNoText: true });
    expect(scores['des-gd1']!.expertFields.mapping).toMatchObject({ operator: '公交线路牌.operator', scheduleType: '公交线路牌.serviceMode', serviceNote: '公交线路牌.operationNote', badges: '站点.facilities' });

    // 一个候选字段只对应一个专家字段：把运营备注与发车方式并成一个"班车类型说明"，只算运营说明。
    const [route, stop] = (await folder(join(FIXTURES, 'definitions/des-gd1'))) as { fields: { name: string }[] }[];
    const merged = { ...route, fields: [...route!.fields.filter((field) => !['operationNote', 'serviceMode'].includes(field.name)),
      { name: 'serviceText', displayName: '班车类型说明', type: 'text' }] };
    expect(scoreDefinitions([merged, stop]).expertFields).toMatchObject({ matched: 14, missing: ['班车类型'] });
  });

  it('366 转录：带局部放大的一次站名 58、地标 15/15、设施 18/18（M217）；没有放大的一次漏站、多标', async () => {
    const truth = ((await read(join(repoRoot, 'scripts/agent-eval/scenarios/366/truth.json'))) as { stops: TruthStop[] }).stops;
    const zoom = scoreTranscription(stopsOf(await read(join(FIXTURES, '366/des-366-zoom1/dataset.json'))), truth);
    expect(zoom).toMatchObject({ stops: '59/59', names: 58, missing: ['宝安北路南'], unexpected: ['宝安北路'],
      landmarks: { matched: 15, of: 15, extra: 0 }, facilities: { matched: 18, of: 18, extra: 0 } });
    const plain = scoreTranscription(stopsOf(await read(join(FIXTURES, '366/des-366-gd/dataset.json'))), truth);
    expect(plain).toMatchObject({ stops: '58/59', names: 57, landmarks: { matched: 11, extra: 3 }, facilities: { matched: 14, extra: 1 } });
    expect(plain.missing).toContain('油社居民小组');
    // 设施写成英文时按中文类别比较。
    const english = stopsOf(await read(join(FIXTURES, '366/des-366-zoom1/dataset.json')))
      .map((stop) => ({ ...stop, facilities: Array.isArray(stop['facilities']) ? stop['facilities'].map((value) => (value === '地铁' ? 'metro' : value === '医院' ? 'hospital' : value)) : stop['facilities'] }));
    expect(scoreTranscription(english, truth).facilities.matched).toBe(18);
  });

  it('模板：首测模板压测 6/10、两项版面检查都不过；票据 07 修改两轮后 10/10、都通过', async () => {
    const options = { workspaceDir: join(repoRoot, 'docs/examples/m402-dsl'), resourcesDir, mainTemplate: '线路牌主模板', datasetId: 'ds-m402-wanguocheng',
      sample: await readFile(join(repoRoot, 'docs/examples/materials/m402-route-sign.jpg')) };
    const first = await scoreTemplates({ ...options, templates: await templatesOf('first-test') });
    expect(first.stress.filter((row) => row.severe > 0).map((row) => row.label)).toEqual(['本站 0', '2 站', '50 站 1500', '35 站 1500']);
    expect(first).toMatchObject({ stressPassed: 6, layoutPassed: 0, landmarkBaseline: { found: true, deltaMm: -12, pass: false }, roadAlign: { aligns: ['distribute'], pass: false },
      sample: { severe: 0, hint: 0, similarity: 0.9088 } });
    const revised = await scoreTemplates({ ...options, templates: await templatesOf('t07-round2') });
    expect(revised).toMatchObject({ stressPassed: 10, layoutPassed: 2, landmarkBaseline: { deltaMm: 0, pass: true }, roadAlign: { aligns: ['spaceEvenly'], pass: true } });
  });
});

describe('判定与门槛', () => {
  it('通过线写在配置里：M402 数据定义 6 项约定与 14/15，模板 10/10 与两项版面检查，366 站名 57、地标 14、图标 17；连续两次', () => {
    expect(config.consecutivePasses).toBe(2);
    expect(Object.fromEntries(config.scenarios.map((item) => [item.id, item.pass]))).toEqual({
      'm402-definition': { conventions: 6, expertFields: 14 },
      'm402-template': { stress: 10, layoutChecks: 2 },
      'm402-revision': { stress: 6, layoutChecks: 2, scopeViolations: 0 },
      '366-transcription': { names: 57, landmarks: 14, facilities: 17 },
    });
    expect(judge(scenario('m402-definition'), {})).toEqual(['没有可评分的数据定义']);
  });

  const result = (id: string, repetition: number, status: UnitStatus | boolean) => {
    const settled = typeof status === 'boolean' ? (status ? 'pass' : 'fail') : status;
    return { id, name: id, repetition, status: settled, pass: settled === 'pass', retries: 0, failures: [], rounds: [], checks: {} } as ScenarioResult;
  };
  const statusOf = (...outcomes: UnitStatus[]) => gate(config, outcomes.map((outcome, index) => result('m402-definition', index + 1, outcome))).status;

  it('每个场景要有连续两次达线，门槛才通过', () => {
    const both = gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, true), result('m402-template', 2, true), result('m402-template', 1, true)]);
    expect(both).toEqual({ status: 'pass', pass: true, scenarios: [
      { id: 'm402-definition', name: 'M402 数据定义', outcomes: ['pass', 'pass'], status: 'pass' }, { id: 'm402-template', name: 'M402 模板', outcomes: ['pass', 'pass'], status: 'pass' },
    ] });
    expect(gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, false)]).pass).toBe(false);
    expect(gate(config, [result('m402-definition', 1, false), result('m402-definition', 2, true), result('m402-definition', 3, true)]).pass).toBe(true);
    expect(gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, false), result('m402-definition', 3, true)]).status).toBe('fail');
    expect(gate(config, [])).toEqual({ status: 'incomplete', pass: false, scenarios: [] });
  });

  it('invalid 不是观测：跳过它算连续；有效次数凑不出结论又没注定不过时是 incomplete（票据 21）', () => {
    // 验收：1 次达线加 1 次 invalid 是 incomplete；2 次达线加 1 次 invalid 是通过，invalid 不打断连续。
    expect(statusOf('pass', 'invalid')).toBe('incomplete');
    expect(statusOf('pass', 'invalid', 'pass')).toBe('pass');
    expect(statusOf('invalid', 'pass', 'pass')).toBe('pass');
    expect(statusOf('invalid', 'invalid')).toBe('incomplete');
    // 把 invalid 都当作达线也凑不出连续两次：注定不过。
    expect(statusOf('fail', 'invalid')).toBe('fail');
    expect(statusOf('invalid', 'fail')).toBe('fail');
    // invalid 也不延长连续：达线、invalid、未达线只有 1 次连续，补跑第 2 次达线才有 2 次。
    expect(statusOf('pass', 'invalid', 'fail')).toBe('incomplete');
    expect(statusOf('fail', 'pass', 'invalid')).toBe('incomplete');

    // 按评估清单：计划内没跑的次数（额度熔断后没发起、分段跑还没到）同样是 incomplete；只跑 1 次也凑不出结论。
    const plan = { scenarios: ['m402-definition', 'm402-template', '366-transcription'], repetitions: 2 };
    const planned = gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, true), result('m402-template', 1, true)], plan);
    expect(planned).toEqual({ status: 'incomplete', pass: false, scenarios: [
      { id: 'm402-definition', name: 'M402 数据定义', outcomes: ['pass', 'pass'], status: 'pass' },
      { id: 'm402-template', name: 'M402 模板', outcomes: ['pass', 'not-run'], status: 'incomplete' },
      { id: '366-transcription', name: '366 数据定义与转录', outcomes: ['not-run', 'not-run'], status: 'incomplete' },
    ] });
    expect(statusOf('pass')).toBe('incomplete');
    // 一个场景注定不过，整体就是未通过，补跑别的场景也改变不了。
    expect(gate(config, [result('m402-definition', 1, true), result('m402-template', 1, false), result('m402-template', 2, false)], plan).status).toBe('fail');
    expect(resumeCommand('label', planned, ['--model', 'gemini-4-argon-contributor', '--out', 'F:\\eval out']))
      .toBe('npx tsx scripts/agent-eval/run.ts --label label --repetitions 1-2 --model gemini-4-argon-contributor --out "F:\\eval out"');
    expect(resumeCommand('label', gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, true)]))).toBeUndefined();
  });
});

describe('编排：经产品路径发起轮次（假执行器）', () => {
  const templateFiles = async (set: string, selected?: readonly string[]) => {
    const files = (await readdir(join(FIXTURES, 'templates', set))).filter((file) => selected === undefined || selected.includes(file));
    return {
      ...Object.fromEntries(await Promise.all(files.map(async (file) => [`candidates/${file}`, await read(join(FIXTURES, 'templates', set, file))] as const))),
      'outcome.json': { candidates: files.map((file) => `candidates/${file}`), pending: [], notes: '评估夹具。' },
    };
  };

  it('模板辅助修改：只交回站点格与道路段，叠加首测已保存模板，一轮合格且版面达线，可重新评分', async () => {
    const outDir = join(base, 'eval-revision');
    const files = await templateFiles('t07-round2', ['template-stop-cell.json', 'template-road-segment.json']);
    const result = await runScenario(config, scenario('m402-revision'), 1, outDir, launcher({ 'template-revision': files }));
    expect(result).toMatchObject({ status: 'pass', failures: [],
      rounds: [{ task: 'template-revision', verdict: 'qualified', dir: 'run-1/m402-revision/revision' }],
      checks: { template: { stressPassed: 7, layoutPassed: 2, landmarkBaseline: { deltaMm: 0 }, roadAlign: { aligns: ['spaceEvenly'] } },
        revision: { violations: [], changedElements: 11, templates: [
          { name: '站点标识', status: 'unchanged' }, { name: '道路段', status: 'modified' }, { name: '线路牌主模板', status: 'unchanged' },
          { name: '站点格', status: 'modified' }, { name: '时刻项', status: 'unchanged' },
        ] } },
    });
    expect(result.rounds).toHaveLength(1);
    expect(await scoreScenario(config, scenario('m402-revision'), 1, outDir)).toEqual(result);
    const second = await runScenario(config, scenario('m402-revision'), 2, outDir, launcher({ 'template-revision': files }));
    const report = await buildReport({ config, label: 'revision', startedAt: '2026-10-20T00:00:00.000Z', outDir, results: [result, second] });
    expect(report.gate).toMatchObject({ status: 'pass', scenarios: [{ id: 'm402-revision', outcomes: ['pass', 'pass'] }] });
    expect(report.totals).toMatchObject({ inputTokens: 22, outputTokens: 444 });
    expect(formatReport(report)).toContain('压测 7/10；版面 2/2；修改范围违例 0；改动元素 11');
    await rm(join(unitDir(outDir, scenario('m402-revision'), 1), 'revision/round.json'));
    const missingRound = await scoreScenario(config, scenario('m402-revision'), 1, outDir);
    expect(missingRound).toMatchObject({ status: 'fail', failures: ['缺少模板辅助修改的轮次记录'] });
  });

  it('模板辅助修改：完整第二轮成果虽版面与压测全过，但改动主模板超出要求，不能达线', async () => {
    const outDir = join(base, 'eval-revision-scope');
    const result = await runScenario(config, scenario('m402-revision'), 1, outDir, launcher({ 'template-revision': await templateFiles('t07-round2') }));
    expect(result).toMatchObject({ status: 'fail', failures: ['修改范围违例 1，最多 0（线路牌主模板）'],
      checks: { template: { stressPassed: 10, layoutPassed: 2 }, revision: { violations: ['线路牌主模板'], changedElements: 14 } },
    });
    expect(await scoreScenario(config, scenario('m402-revision'), 1, outDir)).toEqual(result);
  });

  it('模板辅助修改：原样交回首测模板时轮次合格、范围未越界，但两项版面都不过', async () => {
    const result = await runScenario(config, scenario('m402-revision'), 1, join(base, 'eval-revision-unchanged'),
      launcher({ 'template-revision': await templateFiles('first-test') }));
    expect(result).toMatchObject({ status: 'fail', rounds: [{ verdict: 'qualified' }],
      checks: { template: { stressPassed: 6, layoutPassed: 0 }, revision: { violations: [], changedElements: 0 } },
    });
    expect(result.failures).toEqual([expect.stringContaining('版面检查 0/2，要求至少 2')]);
  });

  it('模板辅助修改：只改时刻项，范围违例与版面未达线分别报告；缺少评分也不能达线', async () => {
    const document = await read(join(FIXTURES, 'templates/first-test/template-time-item.json')) as { artboard: { children: { color: string }[] } };
    document.artboard.children[0]!.color = '#1B1B1B';
    const result = await runScenario(config, scenario('m402-revision'), 1, join(base, 'eval-revision-time'), launcher({
      'template-revision': { 'candidates/time.json': document, 'outcome.json': { candidates: ['candidates/time.json'], pending: [], notes: '只改时刻项文字颜色。' } },
    }));
    expect(result).toMatchObject({ status: 'fail', rounds: [{ verdict: 'qualified' }],
      checks: { template: { stressPassed: 6, layoutPassed: 0, roadAlign: { aligns: ['distribute'] } }, revision: { violations: ['时刻项'], changedElements: 1 } },
    });
    expect(result.failures).toEqual(['修改范围违例 1，最多 0（时刻项）', expect.stringContaining('版面检查 0/2')]);
    expect(judge(scenario('m402-revision'), { template: result.checks.template })).toContain('没有可评分的模板修改范围');
    expect(judge(scenario('m402-revision'), { revision: result.checks.revision })).toContain('没有可评分的模板');
    expect(judge(scenario('m402-revision'), { ...result.checks, template: { ...result.checks.template!, stressPassed: 5 } }))
      .toEqual(expect.arrayContaining([expect.stringContaining('压测 5/10，要求至少 6')]));
  });

  it('三种场景各跑一次：数据定义按专家字段判为未达线；模板与 366（两轮）达线；报告只存摘要，可重新评分', async () => {
    const outDir = join(base, 'eval-1');
    const presets = {
      'definition-extraction': await definitionFiles(join(FIXTURES, '366/des-366-zoom1'),
        [{ file: 'candidates/schema-route.json', path: 'stops', reason: 'inferred', note: '站数上限按目标范围推测' }]),
      'dataset-extraction': {
        'candidates/dataset-366.json': await read(join(FIXTURES, '366/des-366-zoom1/dataset.json')),
        'outcome.json': { candidates: ['candidates/dataset-366.json'], pending: [], notes: '评估夹具。' },
      },
      'template-design': await templateFiles('t07-round2'),
    } as const;
    const m402 = await runScenario(config, scenario('m402-definition'), 1, outDir, launcher({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/t04')) }));
    expect(m402).toMatchObject({ pass: false, failures: ['专家字段 13/15，要求至少 14（缺：运营方、班车类型）'], rounds: [{ task: 'definition-extraction', dir: 'run-1/m402-definition/definition', verdict: 'qualified', pending: 0 }] });
    expect(m402.checks.definition!.conventionsPassed).toBe(6);

    const template = await runScenario(config, scenario('m402-template'), 1, outDir, launcher(presets));
    expect(template).toMatchObject({ pass: true, failures: [], checks: { template: { stressPassed: 10, layoutPassed: 2 } } });
    // 场景的工作区只有专家版数据定义与数据集，没有专家模板。
    expect((await readdir(join(unitDir(outDir, scenario('m402-template'), 1), 'workspace'))).sort()).toEqual([...(scenario('m402-template') as Extract<Scenario, { kind: 'template' }>).workspace.files].sort());

    const transcription = await runScenario(config, scenario('366-transcription'), 1, outDir, launcher(presets));
    expect(transcription).toMatchObject({ pass: true, failures: [], checks: { transcription: { names: 58, landmarks: { matched: 15 }, facilities: { matched: 18 } } } });
    expect(transcription.rounds.map((round) => [round.task, round.verdict])).toEqual([['definition-extraction', 'qualified'], ['dataset-extraction', 'qualified']]);
    // 第一轮由评估模拟审核：待确认项全部采纳、通过，应用到场景自己的工作区，第二轮基于它做数据集提取。
    const unit = unitDir(outDir, scenario('366-transcription'), 1);
    expect(await read(join(unit, 'definition/review.json'))).toMatchObject({ status: 'approved', decisions: [{ item: 1, action: 'adopt' }] });
    expect((await readdir(join(unit, 'workspace'))).sort()).toEqual(['compiled-route-v1.schema.json', 'compiled-stop-v1.schema.json', 'schema-route-v1.json', 'schema-stop-v1.json']);
    expect(await read(join(unit, 'dataset/round.json'))).toMatchObject({ inputs: { definition: { name: '公交线路牌', version: 1 } } });

    const results = [m402, template, transcription];
    const report = await buildReport({ config, label: 'test', startedAt: '2026-10-15T00:00:00.000Z', outDir, results });
    expect(report).toMatchObject({
      format: 'renderweave-agent-eval/2', mcpContract: '0.9.0', consecutivePasses: 2,
      runtime: { model: 'claude-haiku-5-5', servedModels: ['claude-haiku-5-5'], claudeCodeVersions: ['fake-1'] },
      results: [{ status: 'fail', retries: 0 }, { status: 'pass', retries: 0 }, { status: 'pass', retries: 0 }],
      gate: { status: 'fail', pass: false }, totals: { outputTokens: 222 * 4, thinkingTokens: 150 * 4, persistedResults: 0 },
    });
    expect(report.results.flatMap((result) => result.rounds).every((round) => round.persistedResults === 0)).toBe(true);
    expect(formatReport(report)).not.toContain('转存');
    expect(Object.keys(report.materials)).toEqual(expect.arrayContaining(['agent/guide.md', 'agent/domains/route-sign.md', 'agent/tasks/template-design.md']));
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/data:image|iVBORw0KGgo|"bytes"/);
    expect(text.length).toBeLessThan(40_000);
    // 只跑了 1 次：第 2 次未跑，M402 数据定义已注定不过，另两个场景还没有结论。
    expect(formatReport(report)).toContain('| M402 数据定义 | 未达线、未跑 | 未通过 |');
    expect(formatReport(report)).toContain('| M402 模板 | 达线、未跑 | 未完成 |');

    // 重新评分只读轮次目录，结果与跑的时候相同。
    for (const result of results) expect(await scoreScenario(config, scenario(result.id), 1, outDir)).toEqual(result);
  });

  it('发起失败与成果不合格都记为未达线；重新评分时带上发起阶段的失败', async () => {
    const outDir = join(base, 'eval-2');
    const presets = { 'definition-extraction': await definitionFiles(join(FIXTURES, '366/des-366-zoom1')) };
    const failed = await runScenario(config, scenario('366-transcription'), 1, outDir, launcher(presets, 'dataset-extraction'));
    expect(failed).toMatchObject({ status: 'fail', pass: false, retries: 0 });
    expect(failed.failures).toEqual(['发起dataset-extraction失败：模拟的用法错误', '没有可评分的数据集']);
    expect(await scoreScenario(config, scenario('366-transcription'), 1, outDir)).toEqual(failed);

    // Agent 没有交回 outcome.json：结构不合格，原因写进失败；也没有可评分的数据定义。
    const empty = await runScenario(config, scenario('m402-definition'), 2, outDir, launcher({}));
    expect(empty).toMatchObject({ pass: false, rounds: [{ verdict: 'unqualified' }] });
    expect(empty.failures).toEqual([expect.stringMatching(/^数据定义提取一轮的成果不合格：没有交回可读的 outcome\.json/), '没有可评分的数据定义']);

    // 评估实跑中出现过：数据定义本身没问题，待确认项却写成了数据集的位置。结构不合格，原样的数据定义照常评分，只作诊断。
    const misplaced = await runScenario(config, scenario('m402-definition'), 3, outDir, launcher({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1'),
      [{ file: 'candidates/schema-stop.json', path: 'stations[9].facilities', candidate: ['医院'], reason: 'unreadable', note: '第 9 站的图标看不清' }]) }));
    expect(misplaced.failures).toEqual(['数据定义提取一轮的成果不合格：数据定义"站点"中没有字段 stations[9].facilities']);
    expect(misplaced.checks.definition).toMatchObject({ expertFields: { matched: 15 }, conventionsPassed: 6 });
  });

  it('命令行：用法错误退出码 2；--rescore 按轮次目录重新评分并写报告', async () => {
    const outDir = join(base, 'eval-3');
    await runScenario(config, scenario('m402-definition'), 1, outDir, launcher({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1')) }));
    await runScenario(config, scenario('m402-definition'), 2, outDir, launcher({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/hints1')) }));
    await writeFile(join(outDir, 'eval.json'), JSON.stringify({ label: 'cli-test', startedAt: '2026-10-15T00:00:00.000Z', scenarios: ['m402-definition'], repeat: 2 }));
    const reports = join(base, 'reports');
    const rescored = await tsx(['scripts/agent-eval/run.ts', '--rescore', outDir, '--reports', reports]);
    expect(rescored.code).toBe(0);
    expect(rescored.stdout).toContain('门槛通过');
    expect(await read(join(reports, 'cli-test.json'))).toMatchObject({ label: 'cli-test', gate: { status: 'pass', pass: true, scenarios: [{ id: 'm402-definition', outcomes: ['pass', 'pass'] }] } });

    expect(await tsx(['scripts/agent-eval/run.ts', '--key-env', 'RW_EVAL_NO_SUCH_KEY'])).toMatchObject({ code: 2, stderr: expect.stringContaining('缺少环境变量 RW_EVAL_NO_SUCH_KEY') });
    process.env['RW_EVAL_TEST_KEY'] = KEY;
    try {
      expect(await tsx(['scripts/agent-eval/run.ts', '--key-env', 'RW_EVAL_TEST_KEY', '--scenarios', 'm402-definition,price-tag']))
        .toMatchObject({ code: 2, stderr: expect.stringContaining('没有场景 price-tag') });
    } finally {
      delete process.env['RW_EVAL_TEST_KEY'];
    }
  }, 60_000);
});

describe('转存的工具结果计数（票据 22）', () => {
  it('数出被 Claude Code 转存或因过大拒收的工具结果；没有日志时为 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rw-persisted-'));
    const result = (content: unknown) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
    await writeFile(join(dir, 'stream.jsonl'), [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      result('<persisted-output>\nOutput too large (86.5KB). Full output saved to …\n</persisted-output>'),
      result([{ type: 'text', text: 'Error: result (121,601 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to …' }]),
      result([{ type: 'text', text: '{"problems":[]}' }]),
      '不是 JSON',
    ].join('\n'));
    expect(await countPersisted(join(dir, 'stream.jsonl'))).toBe(2);
    expect(await countPersisted(join(dir, 'nope.jsonl'))).toBeUndefined();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('上游错误：按轮次重试、额度熔断与 invalid（票据 21）', () => {
  const noWait = (slept: number[] = []) => ({ sleep: async (ms: number) => { slept.push(ms); } });

  it('分类：瞬时、额度与其他，大小写不敏感；含真实出现过的 500 原文', () => {
    const transient = [`模型服务报错：${SERVER_500}`, 'API Error: 502 Bad Gateway', 'API Error: 503 Service Unavailable',
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'OVERLOADED', 'read ECONNRESET', 'connect etimedout 10.0.0.1:443', 'Socket Hang Up'];
    const quota = [`模型服务报错：${QUOTA_429}`, 'API Error: 429 Too Many Requests', '{"type":"Rate_Limit_Error"}', 'Quota exceeded', 'You have reached your usage limit'];
    const other = ['模型服务报错：API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"input_invalid"}}',
      '缺少环境变量 OPEN_CODE_API_KEY：key 只经环境变量传入', '无法启动 claude：spawn claude ENOENT', '输出 1500 tokens，用时 4290 ms', ''];
    expect(transient.map(classifyError)).toEqual(transient.map(() => 'transient'));
    expect(quota.map(classifyError)).toEqual(quota.map(() => 'quota'));
    expect(other.map(classifyError)).toEqual(other.map(() => 'other'));
  });

  it('第一次 500、第二次成功：只删出错的轮次目录再发起，留下一个有效轮次目录，单元达线并记重试次数', async () => {
    const outDir = join(base, 'eval-retry');
    const calls: AgentTaskId[] = [], slept: number[] = [], logs: string[] = [];
    const launch = flaky({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1')) }, { 'definition-extraction': [{ api: SERVER_500 }] }, calls);
    const result = await runScenario(config, scenario('m402-definition'), 1, outDir, launch, { ...noWait(slept), log: (message) => logs.push(message) });
    expect(result).toMatchObject({ status: 'pass', pass: true, retries: 1, failures: [], rounds: [{ dir: 'run-1/m402-definition/definition', verdict: 'qualified' }] });
    expect(result.invalid).toBeUndefined();
    expect(calls).toEqual(['definition-extraction', 'definition-extraction']);
    expect(slept).toEqual([60_000]);
    expect(logs).toEqual([expect.stringContaining('M402 数据定义 第 1 次数据定义提取：上游瞬时错误，60 秒后重试这一轮（1/2）：模型服务报错：API Error: 500')]);
    const unit = unitDir(outDir, scenario('m402-definition'), 1);
    expect((await readdir(unit)).sort()).toEqual(['definition', 'upstream-errors.json']);
    expect(await read(join(unit, 'upstream-errors.json'))).toEqual({ retries: [{ task: 'definition-extraction', error: `模型服务报错：${SERVER_500}` }] });
    // 重新评分读回重试次数。
    expect(await scoreScenario(config, scenario('m402-definition'), 1, outDir)).toEqual(result);

    // 发起失败（连接中断）同样重试。
    const thrown = await runScenario(config, scenario('m402-definition'), 2, outDir,
      flaky({ 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1')) }, { 'definition-extraction': [{ throws: 'socket hang up' }] }), noWait());
    expect(thrown).toMatchObject({ status: 'pass', retries: 1 });
  });

  it('366 两轮：第二轮 500 时只重跑第二轮，第一轮目录与已应用的工作区不动', async () => {
    const outDir = join(base, 'eval-retry-366');
    const unit = unitDir(outDir, scenario('366-transcription'), 1);
    const presets = {
      'definition-extraction': await definitionFiles(join(FIXTURES, '366/des-366-zoom1')),
      'dataset-extraction': {
        'candidates/dataset-366.json': await read(join(FIXTURES, '366/des-366-zoom1/dataset.json')),
        'outcome.json': { candidates: ['candidates/dataset-366.json'], pending: [], notes: '评估夹具。' },
      },
    };
    const calls: AgentTaskId[] = [], before: string[] = [];
    const inner = flaky(presets, { 'dataset-extraction': [{ api: SERVER_500 }] }, calls);
    const launch: Launcher = async (spec) => {
      if (spec.task === 'dataset-extraction') before.push(await tree(join(unit, 'definition'), join(unit, 'workspace')));
      await inner(spec);
    };
    const result = await runScenario(config, scenario('366-transcription'), 1, outDir, launch, noWait());
    expect(result).toMatchObject({ status: 'pass', retries: 1, checks: { transcription: { names: 58 } } });
    expect(result.rounds.map((round) => [round.dir, round.verdict])).toEqual([['run-1/366-transcription/definition', 'qualified'], ['run-1/366-transcription/dataset', 'qualified']]);
    expect(calls).toEqual(['definition-extraction', 'dataset-extraction', 'dataset-extraction']);
    // 两次发起数据集提取之前，第一轮目录（含审核与应用记录）与工作区逐个文件的内容和修改时间都相同。
    expect(before).toHaveLength(2);
    expect(before[1]).toBe(before[0]);
    expect(before[0]).toMatch(/definition[\\/]applied\.json/);
    expect(before[0]).toMatch(/workspace[\\/]schema-route-v1\.json/);
  });

  it('瞬时错误重试用完记 invalid：不列为没达线，间隔 60 秒、180 秒', async () => {
    const outDir = join(base, 'eval-exhausted');
    const calls: AgentTaskId[] = [], slept: number[] = [];
    const steps = { 'definition-extraction': [{ api: SERVER_500 }, { api: 'API Error: 503 Service Unavailable' }, { throws: 'read ECONNRESET' }] };
    const result = await runScenario(config, scenario('m402-definition'), 1, outDir, flaky({}, steps, calls), noWait(slept));
    expect(result).toMatchObject({ status: 'invalid', pass: false, retries: 2, failures: [], invalid: { kind: 'transient', task: 'definition-extraction', error: 'read ECONNRESET' } });
    expect(calls).toHaveLength(3);
    expect(slept).toEqual([60_000, 180_000]);
    expect(await scoreScenario(config, scenario('m402-definition'), 1, outDir)).toEqual(result);
  });

  it('非瞬时错误不重试，仍算未达线', async () => {
    const outDir = join(base, 'eval-other');
    const calls: AgentTaskId[] = [], slept: number[] = [];
    const badRequest = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"input_invalid"}}';
    const api = await runScenario(config, scenario('m402-definition'), 1, outDir, flaky({}, { 'definition-extraction': [{ api: badRequest }] }, calls), noWait(slept));
    expect(api).toMatchObject({ status: 'fail', retries: 0, failures: [expect.stringContaining('API Error: 400'), '没有可评分的数据定义'] });
    expect(api.invalid).toBeUndefined();
    const thrown = await runScenario(config, scenario('m402-definition'), 2, outDir, flaky({}, { 'definition-extraction': [{ throws: '无法启动 claude：spawn claude ENOENT' }] }, calls), noWait(slept));
    expect(thrown).toMatchObject({ status: 'fail', retries: 0, failures: ['无法启动 claude：spawn claude ENOENT', '没有可评分的数据定义'] });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([]);
  });

  it('宿主硬额度停止记录让评估队列立即停止派发，不依赖错误文本语言', async () => {
    const calls: AgentTaskId[] = [];
    const launch: Launcher = async (spec) => {
      calls.push(spec.task);
      await fakeRound(spec, {}, 'API Error: 429 {"type":"error","error":{"type":"GoUsageLimitError","message":"Go usage limit exceeded"},"metadata":{"limitName":"weekly"}}');
    };
    const units = [1, 2, 3].map((repetition) => ({ scenario: scenario('m402-definition'), repetition }));
    const queue = await runUnits(config, units, join(base, 'eval-hard-quota'), launch, { jobs: 1 });
    expect(calls).toEqual(['definition-extraction']);
    expect(queue.results).toHaveLength(1);
    expect(queue.results[0]).toMatchObject({ status: 'invalid', retries: 0, invalid: { kind: 'quota', error: expect.stringContaining('硬额度耗尽') } });
    expect(queue.held.map((unit) => unit.repetition)).toEqual([2, 3]);
  });

  it('429：该单元 invalid、不重试；队列中还没开始的单元不再发起，已在跑的跑完；同一个 --label 续跑时跳过已有有效结果的单元', async () => {
    const outDir = join(base, 'eval-quota');
    const files = { 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1')) };
    const units = [1, 2, 3, 4].map((repetition) => ({ scenario: scenario('m402-definition'), repetition }));
    const repetitionOf = (spec: RoundSpec) => Number(/run-(\d+)/.exec(spec.out)![1]);
    let release!: () => void;
    const stopped = new Promise<void>((done) => { release = done; });
    const calls: number[] = [], slept: number[] = [], logs: string[] = [];
    const launch: Launcher = async (spec) => {
      calls.push(repetitionOf(spec));
      if (repetitionOf(spec) === 1) return fakeRound(spec, {}, QUOTA_429);
      // 第 2 次已经在跑：等第 1 次熔断之后才交回。
      await stopped;
      await fakeRound(spec, files['definition-extraction']);
    };
    const log = (message: string) => { logs.push(message); if (message.startsWith('额度限制')) release(); };
    const queue = await runUnits(config, units, outDir, launch, { jobs: 2, ...noWait(slept), log });
    expect(calls.sort()).toEqual([1, 2]);
    expect(slept).toEqual([]);
    expect(queue.results.map((result) => [result.repetition, result.status])).toEqual([[1, 'invalid'], [2, 'pass']]);
    expect(queue.results[0]).toMatchObject({ retries: 0, failures: [], invalid: { kind: 'quota', task: 'definition-extraction', error: `模型服务报错：${QUOTA_429}` } });
    expect(queue.held.map((unit) => unit.repetition)).toEqual([3, 4]);
    expect(logs).toContain('额度限制：队列中还没开始的 2 个单元不再发起，已在跑的单元跑完');

    const plan = { scenarios: ['m402-definition'], repetitions: 4 };
    const report = await buildReport({ config, label: 'quota', startedAt: '2026-10-19T00:00:00.000Z', outDir, results: queue.results, plan });
    expect(report.gate).toEqual({ status: 'incomplete', pass: false, scenarios: [{ id: 'm402-definition', name: 'M402 数据定义', outcomes: ['invalid', 'pass', 'not-run', 'not-run'], status: 'incomplete' }] });
    const text = formatReport(report);
    expect(text).toContain('门槛未完成');
    expect(text).toContain('| M402 数据定义 | invalid、达线、未跑、未跑 | 未完成 |');
    expect(text).toContain(`  - 数据定义提取一轮遇到额度限制：模型服务报错：${QUOTA_429}`);
    expect(resumeCommand('quota', report.gate, ['--model', 'gemini-4-argon-contributor'])).toBe('npx tsx scripts/agent-eval/run.ts --label quota --repetitions 1-4 --model gemini-4-argon-contributor');

    // 额度恢复后续跑：第 2 次已有有效结果，跳过；第 1 次删掉出错的轮次重跑，invalid 记录清掉。
    const resumed = await runUnits(config, units, outDir, launcher(files), { jobs: 2, ...noWait(slept) });
    expect(resumed.skipped.map((unit) => unit.repetition)).toEqual([2]);
    expect(resumed.results.map((result) => [result.repetition, result.status]).sort()).toEqual([[1, 'pass'], [3, 'pass'], [4, 'pass']]);
    expect(resumed.held).toEqual([]);
    expect(await readdir(unitDir(outDir, scenario('m402-definition'), 1))).toEqual(['definition']);
    const all = await Promise.all([1, 2, 3, 4].map((repetition) => scoreScenario(config, scenario('m402-definition'), repetition, outDir)));
    expect(gate(config, all, plan).status).toBe('pass');
  });

  it('命令行：1 次达线加 1 次 invalid 时门槛未完成、退出码 3；2 次达线加 1 次 invalid 时门槛通过', async () => {
    const outDir = join(base, 'eval-incomplete');
    const files = { 'definition-extraction': await definitionFiles(join(FIXTURES, 'definitions/des-gd1')) };
    await runScenario(config, scenario('m402-definition'), 1, outDir, launcher(files));
    await runScenario(config, scenario('m402-definition'), 2, outDir, flaky({}, { 'definition-extraction': [{ api: QUOTA_429 }] }));
    const manifest = (repeat: number) => writeFile(join(outDir, 'eval.json'), JSON.stringify({ label: 'incomplete', startedAt: '2026-10-19T00:00:00.000Z', scenarios: ['m402-definition'], repeat }));
    const reports = join(base, 'reports-incomplete');

    await manifest(2);
    const incomplete = await tsx(['scripts/agent-eval/run.ts', '--rescore', outDir, '--reports', reports]);
    expect(incomplete.code).toBe(3);
    expect(incomplete.stdout).toContain('门槛未完成');
    expect(incomplete.stdout).toContain('| M402 数据定义 | 达线、invalid | 未完成 |');
    expect(await read(join(reports, 'incomplete.json'))).toMatchObject({
      format: 'renderweave-agent-eval/2', gate: { status: 'incomplete', pass: false },
      results: [{ repetition: 1, status: 'pass', retries: 0 }, { repetition: 2, status: 'invalid', retries: 0, failures: [], invalid: { kind: 'quota' } }],
    });

    await runScenario(config, scenario('m402-definition'), 3, outDir, launcher(files));
    await manifest(3);
    const passed = await tsx(['scripts/agent-eval/run.ts', '--rescore', outDir, '--reports', reports]);
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain('| M402 数据定义 | 达线、invalid、达线 | 通过 |');
  }, 60_000);
});

/** 目录下每个文件的相对路径、内容哈希与修改时间，用来确认没被动过。 */
async function tree(...dirs: string[]): Promise<string> {
  const lines: string[] = [];
  for (const dir of dirs) {
    for (const file of (await readdir(dir, { recursive: true })).map(String).sort()) {
      const path = join(dir, file);
      const info = await stat(path);
      if (info.isFile()) lines.push(`${relative(base, path)} ${createHash('sha256').update(await readFile(path)).digest('hex')} ${info.mtimeMs}`);
    }
  }
  return lines.join('\n');
}

function tsx(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
