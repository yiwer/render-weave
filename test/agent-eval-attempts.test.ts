import {afterAll, beforeAll, expect, it} from 'vitest';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReport, runScenario, runUnits, unitDir, type Launcher} from '../scripts/agent-eval/eval.js';
import {readConfig, type EvalConfig} from '../scripts/agent-eval/scenarios.js';
import {runAgentTask} from '../src/index.js';
import {repoRoot} from './support/fixtures.js';

let root: string, preset: string, config: EvalConfig;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rw-attempts-')); preset = join(root, 'preset');
  await mkdir(join(preset, 'candidates'), {recursive: true});
  for (const name of ['route', 'stop']) await writeFile(join(preset, `candidates/${name}.json`), await readFile(join(repoRoot, `fixtures/agent-eval/definitions/des-gd1/${name}.json`)));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({candidates: ['candidates/route.json', 'candidates/stop.json'], pending: [], notes: '机制验证'}));
  config = await readConfig();
});
afterAll(async () => {await rm(root, {recursive: true, force: true});});
const scenario = () => config.scenarios.find(s => s.id === 'm402-definition')!;
const usage = (input: number, output: number, thinking: number, read: number, write: number) => ({input_tokens: input, output_tokens: output,
  output_tokens_details: {thinking_tokens: thinking}, cache_read_input_tokens: read, cache_creation_input_tokens: write});
const known = usage(11, 222, 150, 33, 44);
function launch(steps: {usage: unknown; error?: string}[]): Launcher {
  return async spec => {
    const step = steps.shift() ?? {usage: known};
    await runAgentTask({...spec, key: 'offline-key', keyEnv: 'RW_ATTEMPT_KEY', claude: {command: process.execPath,
      args: [join(repoRoot, 'test/support/fake-usage-claude.mjs'), step.error ? 'none' : preset,
        step.usage === 'unknown' ? 'unknown' : JSON.stringify(step.usage), ...(step.error ? [step.error] : [])]}});
  };
}

it('瞬时失败与成功各保留独立尝试原件，汇总全部已知用量且thinking不重复相加', async () => {
  const out = join(root, 'retry'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([{usage: usage(7, 13, 5, 2, 3), error: 'API Error: 503 unavailable'}, {usage: known}]), {sleep: async () => {}});
  expect(result.status).toBe('pass');
  const report = await buildReport({config, label: 'retry', startedAt, outDir: out, results: [result]});
  expect(report).toMatchObject({format: 'renderweave-agent-eval/4', totals: {inputTokens: 18, outputTokens: 235, thinkingTokens: 155,
    cacheReadTokens: 35, cacheCreationTokens: 47, unknownUsageAttempts: 0}, attempts: [expect.anything(), expect.anything()]});
  const saved = await readdir(join(unitDir(out, scenario(), 1), 'attempts'));
  expect(saved).toHaveLength(2);
  const records = await Promise.all(saved.map(id => readFile(join(unitDir(out, scenario(), 1), 'attempts', id, 'round/round.json'), 'utf8')));
  expect(records.some(value => value.includes('503 unavailable'))).toBe(true);
  expect(records.some(value => value.includes('"outputTokens": 222'))).toBe(true);
});

it('额度停止保留not-run，重启补无效与未运行单元，已有有效尝试及用量不重复', async () => {
  const out = join(root, 'quota'), startedAt = new Date().toISOString();
  const units = [1, 2, 3].map(repetition => ({scenario: scenario(), repetition}));
  const stopped = await runUnits(config, units, out, launch([{usage: usage(3, 4, 1, 0, 0), error: 'API Error: 429 quota exceeded'}]), {jobs: 1});
  const first = await buildReport({config, label: 'quota', startedAt, outDir: out, results: stopped.results, plan: {scenarios: [scenario().id], repetitions: 3}});
  expect(first.gate.scenarios[0]?.outcomes).toEqual(['invalid', 'not-run', 'not-run']);
  expect(first.attempts).toHaveLength(1);
  const snapshot = await readFile(join(out, first.attempts[0]!.dir, 'completed.json'), 'utf8');
  const resumed = await runUnits(config, units, out, launch([]), {jobs: 2});
  const final = await buildReport({config, label: 'quota', startedAt, outDir: out, results: resumed.results, plan: {scenarios: [scenario().id], repetitions: 3}});
  expect(final.attempts).toHaveLength(4);
  expect(final.totals).toMatchObject({inputTokens: 36, outputTokens: 670});
  expect(await readFile(join(out, first.attempts[0]!.dir, 'completed.json'), 'utf8')).toBe(snapshot);
  let calls = 0;
  const again = await runUnits(config, units, out, async () => {calls++;}, {jobs: 2});
  expect(again.skipped).toHaveLength(3); expect(calls).toBe(0);
  const repeated = await buildReport({config, label: 'quota', startedAt, outDir: out, results: resumed.results, plan: {scenarios: [scenario().id], repetitions: 3}});
  expect(repeated.totals).toEqual(final.totals);
});

it('执行器强退且无usage仍保存尝试，报告区分未知和已知小计', async () => {
  const out = join(root, 'unknown'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([{usage: 'unknown'}]));
  const report = await buildReport({config, label: 'unknown', startedAt, outDir: out, results: [result]});
  expect(report.attempts).toHaveLength(1);
  expect(report.totals).toMatchObject({inputTokens: 0, outputTokens: 0, unknownUsageAttempts: 1, usageComplete: false,
    unknownByMetric: {inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1}});
});

it('重评分核对尝试原件，改写历史失败日志被拒绝，不能悄悄减少成本', async () => {
  const out = join(root, 'tamper'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([{usage: known}]));
  const report = await buildReport({config, label: 'tamper', startedAt, outDir: out, results: [result]});
  await writeFile(join(out, report.attempts[0]!.dir, 'round/logs/stream.jsonl'), '');
  await expect(buildReport({config, label: 'tamper', startedAt, outDir: out, results: [result]})).rejects.toThrow('尝试原件已改变');
});

it('已完成尝试的启动身份也受保护，修改开始时间不能重写历史', async () => {
  const out = join(root, 'metadata'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([{usage: known}]));
  const report = await buildReport({config, label: 'metadata', startedAt, outDir: out, results: [result]});
  const file = join(out, report.attempts[0]!.dir, 'started.json');
  const record = JSON.parse(await readFile(file, 'utf8')); record.startedAt = '2000-01-01T00:00:00Z';
  await writeFile(file, JSON.stringify(record));
  await expect(buildReport({config, label: 'metadata', startedAt, outDir: out, results: [result]})).rejects.toThrow('尝试原件已改变');
});

it('旧派发拥有者尚活时拒绝重派，完成后续跑不产生额外尝试', async () => {
  const out = join(root, 'live'), startedAt = new Date().toISOString();
  let release!: () => void, arrived!: () => void;
  const pending = new Promise<void>(done => {release = done;}), ready = new Promise<void>(done => {arrived = done;});
  const first = runScenario(config, scenario(), 1, out, async spec => {await launch([])(spec); arrived(); await pending;});
  await ready;
  try {await expect(runScenario(config, scenario(), 1, out, launch([]))).rejects.toThrow('尝试拥有者仍存活');}
  finally {release();}
  await first;
  const result = await runScenario(config, scenario(), 1, out, launch([]));
  const report = await buildReport({config, label: 'live', startedAt, outDir: out, results: [result]});
  expect(report.attempts).toHaveLength(1); expect(report.totals.outputTokens).toBe(222);
});

it('同时开始同一未派发单元只允许一个执行器，未落盘窗口不能重复派发', async () => {
  const out = join(root, 'race'); let calls = 0;
  let release!: () => void; const pending = new Promise<void>(done => {release = done;});
  const executor: Launcher = async spec => {calls++; await launch([])(spec); await pending;};
  const first = runScenario(config, scenario(), 1, out, executor), second = runScenario(config, scenario(), 1, out, executor);
  const finished = Promise.allSettled([first, second]);
  await new Promise(done => setTimeout(done, 1500)); release();
  const settled = await finished; expect(calls).toBe(1);
  expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(settled.find(result => result.status === 'fulfilled')).toMatchObject({value: {status: 'pass'}});
  expect(settled.find(result => result.status === 'rejected')).toMatchObject({reason: expect.objectContaining({message: expect.stringContaining('尝试拥有者仍存活')})});
  expect(await readdir(join(unitDir(out, scenario(), 1), 'attempts'))).toHaveLength(1);
});

it('完成封存已发布而兼容记录缺失时保留成本，公开续跑不重新派发', async () => {
  const out = join(root, 'completion-gap'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([]));
  const before = await buildReport({config, label: 'completion-gap', startedAt, outDir: out, results: [result]});
  // 模拟退出发生在封存发布之后、兼容完成记录发布之前。
  await rm(join(out, before.attempts[0]!.dir, 'completed.json'));
  let calls = 0;
  const resumed = await runScenario(config, scenario(), 1, out, async () => {calls++;});
  const after = await buildReport({config, label: 'completion-gap', startedAt, outDir: out, results: [resumed]});
  expect(calls).toBe(0);
  expect(after.attempts).toEqual(before.attempts);
  expect(after.totals).toEqual(before.totals);
});

it('完成元数据被改写时拒绝重评分，不能降低耗时或抹去错误', async () => {
  const out = join(root, 'completion'), startedAt = new Date().toISOString();
  const result = await runScenario(config, scenario(), 1, out, launch([]));
  const report = await buildReport({config, label: 'completion', startedAt, outDir: out, results: [result]});
  const file = join(out, report.attempts[0]!.dir, 'completed.json');
  const completion = JSON.parse(await readFile(file, 'utf8')); completion.elapsedMs = -1;
  await writeFile(file, JSON.stringify(completion));
  await expect(buildReport({config, label: 'completion', startedAt, outDir: out, results: [result]})).rejects.toThrow('尝试完成记录已改变');
});
