/**
 * Agent 评估（第三阶段票据 08、验收 A10）：评分函数用存档的历史成果离线校准，与当年的记录对照；
 * 编排用假执行器走完三种场景（数据定义、模板、366 的两轮），断言评分、判定、门槛、报告与重新评分。不调用模型。
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReport, formatReport, gate, judge, runScenario, scoreScenario, unitDir, type Launcher, type ScenarioResult } from '../scripts/agent-eval/eval.js';
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

let base: string, config: EvalConfig, count = 0;
const scenario = (id: string) => config.scenarios.find((item) => item.id === id)!;

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
      '366-transcription': { names: 57, landmarks: 14, facilities: 17 },
    });
    expect(judge(scenario('m402-definition'), {})).toEqual(['没有可评分的数据定义']);
  });

  it('每个场景要有连续两次达线，门槛才通过', () => {
    const result = (id: string, repetition: number, pass: boolean) => ({ id, name: id, repetition, pass, failures: [], rounds: [], checks: {} }) as ScenarioResult;
    const both = gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, true), result('m402-template', 2, true), result('m402-template', 1, true)]);
    expect(both).toEqual({ pass: true, scenarios: [
      { id: 'm402-definition', name: 'M402 数据定义', passes: [true, true], pass: true }, { id: 'm402-template', name: 'M402 模板', passes: [true, true], pass: true },
    ] });
    expect(gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, false)]).pass).toBe(false);
    expect(gate(config, [result('m402-definition', 1, false), result('m402-definition', 2, true), result('m402-definition', 3, true)]).pass).toBe(true);
    expect(gate(config, [result('m402-definition', 1, true), result('m402-definition', 2, false), result('m402-definition', 3, true)]).pass).toBe(false);
    expect(gate(config, []).pass).toBe(false);
  });
});

describe('编排：经产品路径发起轮次（假执行器）', () => {
  /** 按任务给出 Agent 交回的文件；轮次经 runAgentTask 发起，与命令行同一路径。 */
  function launcher(presets: Partial<Record<AgentTaskId, Record<string, unknown>>>, fail?: AgentTaskId): Launcher {
    return async (spec) => {
      if (spec.task === fail) throw new Error(`发起${spec.task}失败：模拟的用法错误`);
      const preset = join(base, `preset-${++count}`);
      await mkdir(join(preset, 'candidates'), { recursive: true });
      for (const [path, value] of Object.entries(presets[spec.task] ?? {})) await writeFile(join(preset, path), JSON.stringify(value, null, 2));
      await runAgentTask({ ...spec, key: KEY, keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [FAKE, preset] } });
    };
  }
  const definitionFiles = async (dir: string, pending: unknown[] = []) => ({
    'candidates/schema-route.json': await read(join(dir, 'route.json')), 'candidates/schema-stop.json': await read(join(dir, 'stop.json')),
    'outcome.json': { candidates: ['candidates/schema-route.json', 'candidates/schema-stop.json'], pending, notes: '评估夹具。' },
  });
  const templateFiles = async (set: string) => {
    const files = await readdir(join(FIXTURES, 'templates', set));
    return {
      ...Object.fromEntries(await Promise.all(files.map(async (file) => [`candidates/${file}`, await read(join(FIXTURES, 'templates', set, file))] as const))),
      'outcome.json': { candidates: files.map((file) => `candidates/${file}`), pending: [], notes: '评估夹具。' },
    };
  };

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
      format: 'renderweave-agent-eval/1', mcpContract: '0.3.0', consecutivePasses: 2,
      runtime: { model: 'qwen3.8-max', servedModels: ['qwen3.8-max'], claudeCodeVersions: ['fake-1'] },
      gate: { pass: false }, totals: { outputTokens: 222 * 4 },
    });
    expect(Object.keys(report.materials)).toEqual(expect.arrayContaining(['agent/guide.md', 'agent/domains/route-sign.md', 'agent/tasks/template-design.md']));
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/data:image|iVBORw0KGgo|"bytes"/);
    expect(text.length).toBeLessThan(40_000);
    expect(formatReport(report)).toContain('| M402 数据定义 | 未达线 | 未通过 |');

    // 重新评分只读轮次目录，结果与跑的时候相同。
    for (const result of results) expect(await scoreScenario(config, scenario(result.id), 1, outDir)).toEqual(result);
  });

  it('发起失败与成果不合格都记为未达线；重新评分时带上发起阶段的失败', async () => {
    const outDir = join(base, 'eval-2');
    const presets = { 'definition-extraction': await definitionFiles(join(FIXTURES, '366/des-366-zoom1')) };
    const failed = await runScenario(config, scenario('366-transcription'), 1, outDir, launcher(presets, 'dataset-extraction'));
    expect(failed.pass).toBe(false);
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
    expect(await read(join(reports, 'cli-test.json'))).toMatchObject({ label: 'cli-test', gate: { pass: true, scenarios: [{ id: 'm402-definition', passes: [true, true] }] } });

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

function tsx(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), ...args], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}
