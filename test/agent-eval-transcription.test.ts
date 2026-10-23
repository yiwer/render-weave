/** 转录评分经评估 CLI 留下证据；假执行器只负责交回独立真值及最小变体，不调用模型。 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runScenario, type RoundSpec } from '../scripts/agent-eval/eval.js';
import { readConfig, type EvalConfig, type TranscriptionScenario } from '../scripts/agent-eval/scenarios.js';
import { runAgentTask } from '../src/index.js';
import { repoRoot } from './support/fixtures.js';

let base: string, config: EvalConfig, scenario: TranscriptionScenario, sequence = 0;
let truth: { name: string; landmark?: number; facilities?: string[] }[];
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const source = join(repoRoot, 'fixtures/agent-eval/366/des-366-zoom1');
const candidateStops = () => truth.map(({ landmark, ...stop }) => ({ ...stop, ...(landmark === undefined ? {} : { landmark: `res:landmark-${landmark}` }) }));

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-transcription-'));
  config = await readConfig();
  scenario = config.scenarios.find((entry) => entry.kind === 'transcription') as TranscriptionScenario;
  truth = (await json(join(repoRoot, scenario.truth))).stops;
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

async function evaluate(stops: Record<string, unknown>[], approvedTruth?: typeof truth, nameTolerance = 0) {
  const label = `case-${++sequence}`, out = join(base, label), reports = join(base, 'reports');
  const preset = join(base, `${label}-preset`);
  const configFile = join(base, `${label}-config.json`);
  let selected = scenario;
  if (approvedTruth) {
    const truthFile = join(base, `${label}-truth.json`);
    await writeFile(truthFile, JSON.stringify({ stops: approvedTruth }));
    selected = { ...scenario, truth: truthFile, pass: { ...scenario.pass, names: approvedTruth.length - nameTolerance,
      landmarks: approvedTruth.filter((stop) => stop.landmark !== undefined).length,
      facilities: approvedTruth.filter((stop) => stop.facilities?.length).length } };
  }
  const selectedConfig = { ...config, scenarios: [selected] };
  await writeFile(configFile, JSON.stringify(selectedConfig));
  await mkdir(join(preset, 'candidates'), { recursive: true });
  const dataset = await json(join(source, 'dataset.json'));
  dataset.data.stops = stops.map((stop) => ({ road: '测试路', ...stop }));
  const launch = async (spec: RoundSpec) => {
    const files = spec.task === 'definition-extraction'
      ? { 'schema-route.json': await json(join(source, 'route.json')), 'schema-stop.json': await json(join(source, 'stop.json')) }
      : { 'dataset.json': dataset };
    for (const [name, value] of Object.entries(files)) await writeFile(join(preset, 'candidates', name), JSON.stringify(value));
    await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: Object.keys(files).map((name) => `candidates/${name}`), pending: [], notes: '受控转录评分样例。' }));
    await runAgentTask({ ...spec, key: 'controlled-test-only', keyEnv: 'RW_TEST_KEY', claude: { command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset] } });
  };
  for (const repetition of [1, 2]) await runScenario(selectedConfig, selected, repetition, out, launch);
  await writeFile(join(out, 'eval.json'), JSON.stringify({ label, startedAt: '2026-10-23T00:00:00Z', scenarios: [scenario.id], repeat: 2 }));
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/agent-eval/run.ts', '--rescore', out, '--reports', reports, '--config', configFile],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
  return { ...result, report: await json(join(reports, `${label}.json`)) };
}

describe('有序转录评分的公开 CLI', () => {
  it.each(['policy', 'truth', 'legacy'] as const)('缺少核准 %s 时拒绝评分，不制造完成结论', async (missing) => {
    const broken = JSON.parse(JSON.stringify(config));
    broken.scenarios = [broken.scenarios.find((entry: { kind: string }) => entry.kind === 'transcription')];
    if (missing === 'legacy') broken.format = 'renderweave-agent-eval-config/1';
    else if (missing === 'policy') delete broken.scenarios[0].pass.insertions;
    else broken.scenarios[0].truth = join(base, 'no-approved-truth.json');
    const file = join(base, `missing-${missing}.json`);
    await writeFile(file, JSON.stringify(broken));
    const result = await new Promise<{ code: number | null; stderr: string }>((done) => {
      const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/agent-eval/run.ts', '--config', file, '--rescore', join(base, 'not-started')],
        { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('close', (code) => done({ code, stderr }));
    });
    expect(result.code, result.stderr).toBe(2);
    expect(result.stderr).toContain(missing === 'truth' ? '核准真值' : '核准评分政策');
    expect(result.stderr).toContain('未完成');
  });
  it('用多余同名项替掉一站不能藏进单字容错', async () => {
    const result = await evaluate([{ name: 'A' }, { name: 'A' }, { name: 'A' }, { name: 'C' }],
      [{ name: 'A' }, { name: 'B' }, { name: 'A' }, { name: 'C' }], 1);
    expect(result.code, result.stdout).toBe(1);
    const score = result.report.results[0].checks.transcription;
    expect(score.errors.duplicates).toHaveLength(1);
    expect(score.requiresReview).toBe(true);
  });
  it('同名项的地标与设施串位分别列出，不能在另一处抵消', async () => {
    const approved = [{ name: 'A', landmark: 1, facilities: ['地铁'] }, { name: 'B' },
      { name: 'A', landmark: 2, facilities: ['医院'] }, { name: 'C' }];
    const result = await evaluate([{ name: 'A', landmark: 'res:landmark-2', facilities: ['医院'] }, { name: 'B' },
      { name: 'A', landmark: 'res:landmark-1', facilities: ['地铁'] }, { name: 'C' }], approved);
    expect(result.code, result.stdout).toBe(1);
    const score = result.report.results[0].checks.transcription;
    expect(score.requiresReview).toBe(false);
    expect(score.errors.landmarkExtra).toEqual([{ candidatePosition: 1, truthPosition: 1, value: 2 }, { candidatePosition: 3, truthPosition: 3, value: 1 }]);
    expect(score.errors.facilityExtra).toEqual([{ candidatePosition: 1, truthPosition: 1, value: '医院' }, { candidatePosition: 3, truthPosition: 3, value: '地铁' }]);
  });
  it('同站多报同一设施也算误报；仅漏一处地标设施仍遵守核准容错', async () => {
    const duplicated = candidateStops();
    duplicated[0] = { ...duplicated[0]!, facilities: ['地铁', '地铁'] };
    const extra = await evaluate(duplicated);
    expect(extra.code, extra.stdout).toBe(1);
    expect(extra.report.results[0].checks.transcription.errors.facilityExtra).toEqual([{ candidatePosition: 1, truthPosition: 1, value: '地铁' }]);
    const omitted = candidateStops();
    omitted.splice(2, 1);
    const missing = await evaluate(omitted);
    expect(missing.code, missing.stdout).toBe(0);
    expect(missing.report.results[0].checks.transcription).toMatchObject({ names: 58, landmarks: { matched: 14, of: 15, extra: 0 }, facilities: { matched: 17, of: 18, extra: 0 } });
  });
  it('替换与漏项加插入同样可解释时要求复核，不能选有利对齐通过', async () => {
    const stops = candidateStops();
    stops[10] = { ...stops[10]!, name: '完全不同的名字' };
    const result = await evaluate(stops);
    expect(result.code, result.stdout).toBe(1);
    const score = result.report.results[0].checks.transcription;
    expect(score.requiresReview).toBe(true);
    expect(score.ambiguities).toContainEqual({ candidatePosition: 11, possibleTruthPositions: [11, null] });
    expect(score.scorer).toMatchObject({ version: 'renderweave-transcription/2', matchingPolicy: { id: 'ordered-occurrences/1', exact: 0, singleCharacterEdit: 1, otherSubstitution: 2, insertion: 1, omission: 1 } });
    expect(result.stdout).toContain('对齐歧义');
    expect(result.stdout).toContain('复核');
  });
  it('同名项漏一处时暴露出现位置歧义，不按更有利的地标选择', async () => {
    const result = await evaluate([{ name: 'A', landmark: 'res:landmark-1' }, { name: 'B' }],
      [{ name: 'A', landmark: 1 }, { name: 'A', landmark: 2 }, { name: 'B' }]);
    expect(result.code, result.stdout).toBe(1);
    const score = result.report.results[0].checks.transcription;
    expect(score.requiresReview).toBe(true);
    expect(score.ambiguities).toContainEqual({ candidatePosition: 1, possibleTruthPositions: [1, 2] });
  });
  it.each(['wrong-landmark', 'wrong-facility', 'additional-facility', 'additional-landmark'] as const)('%s 即使命中数仍达旧门槛也不能通过', async (variant) => {
    const stops = candidateStops();
    if (variant === 'wrong-landmark') stops[1] = { ...stops[1]!, landmark: 'res:landmark-2' };
    if (variant === 'wrong-facility') stops[0] = { ...stops[0]!, facilities: ['医院'] };
    if (variant === 'additional-facility') stops[0] = { ...stops[0]!, facilities: ['地铁', '医院'] };
    if (variant === 'additional-landmark') stops[3] = { ...stops[3]!, landmark: 'res:landmark-1' };
    const result = await evaluate(stops);
    expect(result.code, result.stdout).toBe(1);
    const score = result.report.results[0].checks.transcription;
    if (variant.includes('landmark')) {
      expect(score.landmarks.matched).toBeGreaterThanOrEqual(14);
      expect(score.errors.landmarkExtra).toEqual([{ candidatePosition: variant === 'wrong-landmark' ? 2 : 4, truthPosition: variant === 'wrong-landmark' ? 2 : 4, value: variant === 'wrong-landmark' ? 2 : 1 }]);
      if (variant === 'wrong-landmark') expect(score.errors.landmarkMissing).toEqual([{ candidatePosition: 2, truthPosition: 2, value: 1 }]);
    } else {
      expect(score.facilities.matched).toBeGreaterThanOrEqual(17);
      expect(score.errors.facilityExtra).toEqual([{ candidatePosition: 1, truthPosition: 1, value: '医院' }]);
      if (variant === 'wrong-facility') expect(score.errors.facilityMissing).toEqual([{ candidatePosition: 1, truthPosition: 1, value: '地铁' }]);
    }
  });
  it('合法同名停靠站点 A→B→A→C 按各次出现核对地标和设施', async () => {
    const approved = [{ name: 'A', landmark: 1, facilities: ['地铁'] }, { name: 'B' },
      { name: 'A', landmark: 2, facilities: ['医院'] }, { name: 'C' }];
    const stops = [{ name: 'A', landmark: 'res:landmark-1', facilities: ['地铁'] }, { name: 'B' },
      { name: 'A', landmark: 'res:landmark-2', facilities: ['医院'] }, { name: 'C' }];
    const result = await evaluate(stops, approved);
    expect(result.code, result.stdout).toBe(0);
    const score = result.report.results[0].checks.transcription;
    expect(score).toMatchObject({ names: 4, landmarks: { matched: 2, of: 2, extra: 0 }, facilities: { matched: 2, of: 2, extra: 0 } });
    expect(score.alignment.map((entry: { candidatePosition: number; truthPosition: number }) => [entry.candidatePosition, entry.truthPosition])).toEqual([[1, 1], [2, 2], [3, 3], [4, 4]]);
  });
  it.each(['substitution', 'omission'] as const)('%s 使用位置容错，不令后续站点错位', async (variant) => {
    const stops = candidateStops();
    if (variant === 'substitution') stops[10] = { ...stops[10]!, name: '宝安北路' };
    else stops.splice(35, 1);
    const result = await evaluate(stops);
    expect(result.code, result.stdout).toBe(0);
    const score = result.report.results[0].checks.transcription;
    expect(score.names).toBe(58);
    expect(score.errors.insertions).toEqual([]);
    expect(score.errors.orderViolations).toEqual([]);
    if (variant === 'substitution') expect(score.errors.substitutions).toEqual([
      { candidatePosition: 11, truthPosition: 11, candidateName: '宝安北路', truthName: '宝安北路南' },
    ]);
    else {
      expect(score.errors.omissions).toEqual([{ truthPosition: 36, truthName: '油社居民小组' }]);
      expect(score.alignment).toContainEqual({ kind: 'match', candidatePosition: 36, truthPosition: 37, candidateName: '碧桂园凤凰公馆', truthName: '碧桂园凤凰公馆' });
    }
  });
  it.each(['insertion', 'duplicate', 'swap'] as const)('%s 被拒绝并保留各自错误分类', async (variant) => {
    const stops = candidateStops();
    if (variant === 'insertion') stops.splice(5, 0, { name: '虚构站点' });
    if (variant === 'duplicate') stops.splice(5, 0, { ...stops[4]! });
    if (variant === 'swap') [stops[5], stops[6]] = [stops[6]!, stops[5]!];
    const result = await evaluate(stops);
    expect(result.code, result.stdout).toBe(1);
    const errors = result.report.results[0].checks.transcription.errors;
    if (variant === 'insertion') expect(errors.insertions).toEqual([{ candidatePosition: 6, candidateName: '虚构站点' }]);
    if (variant === 'duplicate') expect(errors.duplicates).toEqual([{ candidatePosition: 6, candidateName: '爱华南天桥', truthPositions: [5] }]);
    if (variant === 'swap') expect(errors.orderViolations).toEqual([
      { candidatePosition: 6, truthPosition: 7 }, { candidatePosition: 7, truthPosition: 6 },
    ]);
  });
  it('原序对照通过；全部反序拒绝并报告候选与真值位置', async () => {
    const control = await evaluate(candidateStops());
    expect(control.code, control.stdout + control.stderr).toBe(0);
    expect(control.report.results[0].checks.transcription.names).toBe(59);
    const reversed = await evaluate(candidateStops().reverse());
    expect(reversed.code).toBe(1);
    const score = reversed.report.results[0].checks.transcription;
    expect(score.errors.orderViolations.length).toBeGreaterThan(0);
    expect(score.names).toBe(59);
    expect([score.errors.substitutions, score.errors.insertions, score.errors.duplicates, score.errors.omissions]).toEqual([[], [], [], []]);
    expect(score.errors.orderViolations[0]).toMatchObject({ candidatePosition: expect.any(Number), truthPosition: expect.any(Number) });
    expect(reversed.stdout).toContain('顺序违例');
  });
});
