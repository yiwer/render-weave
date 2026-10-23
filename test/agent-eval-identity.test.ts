import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runAgentTask, readPngInfo } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';

let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-eval-identity-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
function cli(args: string[]) {
  return new Promise<{code: number | null; stdout: string; stderr: string}>((done) => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/agent-eval/run.ts', ...args],
      {cwd: repoRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, RW_IDENTITY_TEST_KEY: 'offline-fixture-key'}});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => done({code, stdout, stderr}));
  });
}
async function savedRound(out: string, state: 'pass' | 'fail' | 'invalid' = 'pass') {
  const preset = await mkdtemp(join(base, 'preset-'));
  await mkdir(join(preset, 'candidates'), {recursive: true});
  const candidates = ['route', 'stop'];
  for (const name of candidates) await writeFile(join(preset, 'candidates', name + '.json'),
    await readFile(join(repoRoot, 'fixtures/agent-eval/definitions/des-gd1', name + '.json')));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({candidates: candidates.map(name => 'candidates/' + name + '.json'), pending: [], notes: state === 'fail' ? '' : '独立存档夹具。'}));
  if (state === 'invalid') await writeFile(join(preset, '.api-error'), 'API Error: 429 usage limit reached');
  await runAgentTask({task: 'definition-extraction', sample: join(repoRoot, 'docs/examples/materials/m402-route-sign.jpg'),
    brief: join(repoRoot, 'scripts/agent-eval/scenarios/m402/brief-definition.md'), domain: 'route-sign',
    resources: resourcesDir, out, key: 'test-only-identity-key', keyEnv: 'RW_IDENTITY_TEST_KEY',
    claude: {command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset]}});
  return preset;
}
it('重新评分另存带来源的报告，原始实验清单和报告字节不变', async () => {
  const out = join(base, 'saved'), reports = join(base, 'reports');
  await savedRound(join(out, 'run-1/m402-definition/definition'));
  await savedRound(join(out, 'run-2/m402-definition/definition'));
  const manifest = JSON.stringify({label: 'preserve', startedAt: '2026-10-23T00:00:00Z', scenarios: ['m402-definition'], repeat: 2});
  await writeFile(join(out, 'eval.json'), manifest);
  await mkdir(reports);
  const original = JSON.stringify({label: 'preserve', originalVerdict: 'historical'});
  await writeFile(join(reports, 'preserve.json'), original);
  const result = await cli(['--rescore', out, '--reports', reports]);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(await readFile(join(reports, 'preserve.json'), 'utf8')).toBe(original);
  expect(await readFile(join(out, 'eval.json'), 'utf8')).toBe(manifest);
  const files = (await readdir(reports)).filter(name => name !== 'preserve.json');
  expect(files).toHaveLength(1);
  const report = await read(join(reports, files[0]!));
  expect(report.rescoring).toMatchObject({sourceLabel: 'preserve', sourceIdentity: null});
  expect(report.rescoring.scorer).toMatch(/^sha256:/);
  expect(report.rescoring.scoringIdentity.config).toMatch(/^sha256:/);
  expect(report.rescoring.scoringIdentity.inputs['m402-definition/sample']).toMatch(/^sha256:/);
  expect(report.rescoring.sourceRounds).toHaveLength(2);
  expect(report.rescoring.sourceRounds[0]).toMatchObject({dir: 'run-1/m402-definition/definition', files: {'round/round.json': expect.any(String), 'round/logs/prompt.md': expect.any(String)}, sha256: expect.stringMatching(/^sha256:/)});
  expect(report.gate.status).toBe('pass');
});

it('计划内有效失败优先于缺失，完整性独立报告，不用随后通过覆盖失败', async () => {
  const out = join(base, 'failed-plan'), reports = join(base, 'failed-reports');
  for (const [index, state] of (['fail', 'invalid', 'pass'] as const).entries()) {
    const unit = join(out, `run-${index + 1}/m402-definition`);
    await savedRound(join(unit, 'definition'), state);
    if (state === 'invalid') await writeFile(join(unit, 'upstream-errors.json'), JSON.stringify({retries: [], invalid: {kind: 'quota', task: 'definition-extraction', error: 'usage limit'}}));
  }
  await writeFile(join(out, 'eval.json'), JSON.stringify({label: 'failed-plan', startedAt: '2026-10-23T00:00:00Z', scenarios: ['m402-definition'], repeat: 3}));
  const result = await cli(['--rescore', out, '--reports', reports]);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const report = await read(join(reports, (await readdir(reports))[0]!));
  expect(report.gate).toMatchObject({status: 'fail', completeness: {planned: 3, pass: 1, fail: 1, invalid: 1, notRun: 0, complete: false}});
});

it('同一实验固定派发条件，已有有效失败不重跑，模型或输入变化在派发前拒绝', async () => {
  const out = join(base, 'frozen'), reports = join(base, 'frozen-reports');
  const ledger = join(base, 'dispatches.txt'), executor = join(base, 'executor.mjs'), configFile = join(base, 'config.json');
  const fake = join(repoRoot, 'test/support/fake-claude.mjs');
  await writeFile(executor, `import {appendFile} from 'node:fs/promises';\nimport {pathToFileURL} from 'node:url';\nif (process.argv.includes('--version')) { console.log('fixture-executor/1'); } else {\nawait appendFile(${JSON.stringify(ledger)}, 'dispatch\\n');\nprocess.argv.splice(1, 1, ${JSON.stringify(fake)}, 'none');\nawait import(pathToFileURL(${JSON.stringify(fake)}).href);\n}\n`);
  const config = await read(join(repoRoot, 'scripts/agent-eval/config.json'));
  await writeFile(configFile, JSON.stringify(config));
  const args = ['--config', configFile, '--label', 'frozen', '--out', out, '--reports', reports, '--scenarios', 'm402-definition',
    '--repeat', '2', '--repetitions', '1-1', '--jobs', '1', '--key-env', 'RW_IDENTITY_TEST_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([executor])];
  const first = await cli(args);
  expect(first.stderr).not.toContain('ERR_PARSE_ARGS_UNKNOWN_OPTION');
  expect(first.stdout).toContain("--claude-args '[");
  expect(first.code, first.stdout + first.stderr).toBe(1);
  expect(await readFile(ledger, 'utf8')).toBe('dispatch\n');
  const manifest = await readFile(join(out, 'eval.json'), 'utf8');
  const saved = JSON.parse(manifest);
  expect(saved.identity.runtime).toMatchObject({model: 'claude-haiku-5-5', smallModel: 'claude-haiku-5-5'});
  expect(saved.identity.executor.version).toBe('fixture-executor/1');
  const resumed = await cli(args);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(1);
  expect(await readFile(ledger, 'utf8')).toBe('dispatch\n');
  expect(await readFile(join(out, 'eval.json'), 'utf8')).toBe(manifest);
  const changed = await cli([...args, '--model', 'claude-different-model']);
  expect(changed.code, changed.stdout + changed.stderr).toBe(2);
  expect(changed.stderr).toContain('runtime.model');
  config.scenarios[0].pass.expertFields = 1;
  await writeFile(configFile, JSON.stringify(config));
  const inputChanged = await cli(args);
  expect(inputChanged.code, inputChanged.stdout + inputChanged.stderr).toBe(2);
  expect(inputChanged.stderr).toContain('config');
  expect(await readFile(ledger, 'utf8')).toBe('dispatch\n');
  expect(await readFile(join(out, 'eval.json'), 'utf8')).toBe(manifest);
});

async function experiment(name: string, action = '') {
  const root = join(base, name), out = join(root, 'out'), reports = join(root, 'reports');
  await mkdir(root, {recursive: true});
  const configFile = join(root, 'config.json'), ledger = join(root, 'dispatches.txt'), executor = join(root, 'executor.mjs');
  await writeFile(configFile, await readFile(join(repoRoot, 'scripts/agent-eval/config.json')));
  const fake = join(repoRoot, 'test/support/fake-claude.mjs');
  await writeFile(executor, `import {appendFile, readFile, readdir} from 'node:fs/promises';
import {join, dirname} from 'node:path'; import {pathToFileURL} from 'node:url';
if (process.argv.includes('--version')) console.log('fixture-executor/1');
else {
const ledger = ${JSON.stringify(ledger)}, configFile = ${JSON.stringify(configFile)};
await appendFile(ledger, 'dispatch\\n');
${action}
process.argv.splice(1, 1, ${JSON.stringify(fake)}, typeof preset === 'string' ? preset : 'none');
await import(pathToFileURL(${JSON.stringify(fake)}).href);
}`);
  const args = ['--config', configFile, '--label', name, '--out', out, '--reports', reports, '--scenarios', 'm402-definition',
    '--repeat', '2', '--jobs', '1', '--key-env', 'RW_IDENTITY_TEST_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([executor])];
  return {root, out, reports, configFile, ledger, executor, args};
}

it('每次派发前核验冻结输入，运行中条件变化停止后续派发且不产出混合条件报告', async () => {
  const e = await experiment('mid-run-change', "await appendFile(configFile, ' ');");
  const result = await cli(e.args);
  expect(result.code, result.stdout + result.stderr).toBe(2);
  expect(result.stderr).toContain('config');
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\n');
  expect(await readdir(e.reports).catch(() => [])).toEqual([]);
  expect((await read(join(e.out, 'eval.json'))).identity.config).toMatch(/^sha256:/);
});

it('同身份续跑仅补 invalid 与半写单元，保留有效成功，允许普通运行调整并行数', async () => {
  const valid = await savedRound(join(base, 'pass-source'));
  const invalid = await savedRound(join(base, 'invalid-source'), 'invalid');
  await rm(join(invalid, 'outcome.json'));
  const state = join(base, 'resume-state.json');
  await writeFile(state, JSON.stringify({preset: invalid}));
  const e = await experiment('resume-plan', `const {preset} = JSON.parse(await readFile(${JSON.stringify(state)}, 'utf8'));`);
  const first = await cli(e.args);
  expect(first.code, first.stderr).toBe(3);
  expect((await read(join(e.reports, 'resume-plan.json'))).gate.completeness).toMatchObject({invalid: 1, notRun: 1, complete: false});
  const manifest = await readFile(join(e.out, 'eval.json'), 'utf8');
  await mkdir(join(e.out, 'run-2/m402-definition/definition'), {recursive: true});
  await writeFile(join(e.out, 'run-2/m402-definition/definition/round.json'), '{}');
  await writeFile(state, JSON.stringify({preset: valid}));
  const args = [...e.args]; args[args.indexOf('--jobs') + 1] = '2';
  const resumed = await cli(args);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  const round = await readFile(join(e.out, 'run-1/m402-definition/definition/round.json'), 'utf8');
  expect((await cli(args)).code).toBe(0);
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\ndispatch\ndispatch\n');
  expect(await readFile(join(e.out, 'run-1/m402-definition/definition/round.json'), 'utf8')).toBe(round);
  expect(await readFile(join(e.out, 'eval.json'), 'utf8')).toBe(manifest);
  const schedules = await Promise.all((await readdir(join(e.out, 'segments'))).filter(file => file.endsWith('.started.json')).map(file => read(join(e.out, 'segments', file))));
  expect(schedules.map(value => value.jobs).sort()).toEqual([1, 2, 2]);
});

it('每轮执行器启动前能读取提示词、实际资料与输入证据，服务模型变化独立显示', async () => {
  const evidence = join(base, 'dispatch-evidence.jsonl');
  const e = await experiment('dispatch-evidence', `
const logs = join(dirname(process.cwd()), 'logs');
const provenance = JSON.parse(await readFile(join(logs, 'provenance.json'), 'utf8'));
const prompt = await readFile(join(logs, 'prompt.md'), 'utf8');
const materials = await readdir(join(logs, 'materials'));
await appendFile(${JSON.stringify(evidence)}, JSON.stringify({provenance, promptPresent: prompt.length > 0, materials}) + '\\n');
process.env.ANTHROPIC_MODEL = (await readFile(ledger, 'utf8')).split('dispatch').length === 2 ? 'served-model-a' : 'served-model-b';`);
  const result = await cli(e.args);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const records = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.promptPresent).toBe(true);
    expect(record.materials.length).toBeGreaterThan(0);
    expect(record.provenance.inputs).toMatchObject({sample: {sha256: expect.any(String)}, resourceSnapshot: expect.any(Object)});
    expect(Object.keys(record.provenance.actualMaterials).length).toBeGreaterThan(0);
  }
  expect(records.every(record => typeof record.provenance.promptSha256 === 'string')).toBe(true);
  const report = await read(join(e.reports, 'dispatch-evidence.json'));
  expect(report.runtime).toMatchObject({servedModels: ['served-model-a', 'served-model-b'], servedModelChanged: true, requestedModelMismatch: true, providerRevision: null});
  expect(report.experimentIdentity.runtime).toMatchObject({model: 'claude-haiku-5-5', providerRevision: null});
});

it('续跑逐项拒绝实际构建、评分器、资料、输入、资源与运行选项变化，原实验字节不变', async () => {
  const e = await experiment('identity-matrix');
  const args = [...e.args, '--repetitions', '1-1'];
  args[args.indexOf('--scenarios') + 1] = 'm402-definition,366-transcription';
  expect((await cli(args)).code).toBe(1);
  const manifest = await readFile(join(e.out, 'eval.json'), 'utf8');
  const dispatches = await readFile(e.ledger, 'utf8');
  for (const [flag, value, difference] of [['--effort', 'high', 'runtime.effort'], ['--max-turns', '9', 'budgets.maxTurns'], ['--small-model', 'other-small', 'runtime.smallModel'], ['--endpoint', 'https://fixture.invalid', 'runtime.endpoint']] as const) {
    const changed = await cli([...args, flag, value]);
    expect(changed.code, changed.stderr).toBe(2);
    expect(changed.stderr).toContain(difference);
  }
  for (const [file, difference] of [
    ['dist/bin.js', 'build'], ['agent/guide.md', 'materials'], ['scripts/agent-eval/behavior.ts', 'scorer'],
    ['scripts/agent-eval/scenarios/m402/brief-definition.md', 'inputs'], ['scripts/agent-eval/scenarios/366/truth.json', 'inputs'],
    ['docs/examples/materials/m402-route-sign.jpg', 'inputs'], ['fixtures/resources/resources.json', 'resources'],
  ]) {
    const path = join(repoRoot, file!), original = await readFile(path);
    try {
      await writeFile(path, Buffer.concat([original, Buffer.from('\n')]));
      const changed = await cli(args);
      expect(changed.code, `${file}: ${changed.stderr}`).toBe(2);
      expect(changed.stderr).toContain(difference);
    } finally { await writeFile(path, original); }
  }
  expect(await readFile(e.ledger, 'utf8')).toBe(dispatches);
  expect(await readFile(join(e.out, 'eval.json'), 'utf8')).toBe(manifest);
});

it('配对实验固定并行数，最后一轮运行后变化也不能签发报告', async () => {
  const e = await experiment('paired-jobs');
  const args = [...e.args, '--paired', '--repetitions', '1-1'];
  expect((await cli(args)).code).toBe(1);
  const changedArgs = [...args]; changedArgs[changedArgs.indexOf('--jobs') + 1] = '2';
  const changed = await cli(changedArgs);
  expect(changed.code, changed.stderr).toBe(2);
  expect(changed.stderr).toContain('plan.pairedJobs');
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\n');
  const late = await experiment('last-round-change', "await appendFile(configFile, ' ');");
  const finished = await cli([...late.args, '--repetitions', '1-1']);
  expect(finished.code, finished.stderr).toBe(2);
  expect(await readdir(late.reports).catch(() => [])).toEqual([]);
});

it('核准参考与内容基准传入实际轮次并固定内容身份', async () => {
  const e = await experiment('baseline-inputs');
  const reference = join(e.root, 'reference.json'), content = join(e.root, 'content.json');
  const sample = join(resourcesDir, 'images/test/quadrants.png');
  const dimensions = readPngInfo(await readFile(sample));
  await writeFile(reference, JSON.stringify({sampleWidthPx: dimensions.width, sampleHeightPx: dimensions.height, artboardWidthMm: 200, artboardHeightMm: 50, approvedRegions: []}));
  await writeFile(content, JSON.stringify({name: '核准字段事实', items: [{id: 'route', label: '线路号'}]}));
  const config = await read(e.configFile);
  config.scenarios[0].contentBaseline = content;
  config.scenarios[1].reference = reference;
  config.scenarios[1].sample = sample;
  await writeFile(e.configFile, JSON.stringify(config));
  const args = [...e.args, '--repetitions', '1-1']; args[args.indexOf('--scenarios') + 1] = 'm402-definition,m402-template';
  const result = await cli(args);
  expect(result.code, result.stderr).toBe(1);
  expect((await read(join(e.out, 'run-1/m402-definition/definition/round.json'))).inputs.contentBaseline).toMatchObject({sha256: expect.any(String)});
  expect((await read(join(e.out, 'run-1/m402-template/template/round.json'))).inputs.reference).toMatchObject({sha256: expect.any(String)});
  const dispatches = await readFile(e.ledger, 'utf8');
  for (const file of [reference, content]) {
    const original = await readFile(file);
    try {
      await writeFile(file, Buffer.concat([original, Buffer.from(' ')]));
      const changed = await cli(args);
      expect(changed.code, changed.stderr).toBe(2);
      expect(changed.stderr).toContain('inputs');
    } finally { await writeFile(file, original); }
  }
  expect(await readFile(e.ledger, 'utf8')).toBe(dispatches);
});

it('执行器版本变化拒绝续跑，端点凭据不会写入或打印', async () => {
  const e = await experiment('executor-version'), version = join(e.root, 'version.txt');
  await writeFile(version, 'fixture-executor/1');
  await writeFile(e.executor, (await readFile(e.executor, 'utf8')).replace("console.log('fixture-executor/1')", `console.log(await readFile(${JSON.stringify(version)}, 'utf8'))`));
  const args = [...e.args, '--repetitions', '1-1'];
  expect((await cli(args)).code).toBe(1);
  await writeFile(version, 'fixture-executor/2');
  const changed = await cli(args);
  expect(changed.code, changed.stderr).toBe(2);
  expect(changed.stderr).toContain('executor.version');
  const denied = await cli([...args, '--endpoint', 'https://identity-secret:token@fixture.invalid?api_key=identity-secret']);
  expect(denied.code).toBe(2);
  expect(denied.stderr).toContain('没有凭据');
  expect(denied.stderr + denied.stdout + await readFile(join(e.out, 'eval.json'), 'utf8')).not.toContain('identity-secret');
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\n');
});

it('有效通过加无效观测保持未完成，退出码为 3', async () => {
  const out = join(base, 'pass-invalid'), reports = join(base, 'pass-invalid-reports');
  await savedRound(join(out, 'run-1/m402-definition/definition'));
  await savedRound(join(out, 'run-2/m402-definition/definition'), 'invalid');
  await writeFile(join(out, 'run-2/m402-definition/upstream-errors.json'), JSON.stringify({retries: [], invalid: {kind: 'quota', task: 'definition-extraction', error: 'usage limit'}}));
  await writeFile(join(out, 'eval.json'), JSON.stringify({label: 'pass-invalid', startedAt: '2026-10-23T00:00:00Z', scenarios: ['m402-definition'], repeat: 2}));
  const result = await cli(['--rescore', out, '--reports', reports]);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const report = await read(join(reports, (await readdir(reports))[0]!));
  expect(report.gate).toMatchObject({status: 'incomplete', completeness: {planned: 2, pass: 1, fail: 0, invalid: 1, notRun: 0, complete: false}});
});

it('串联定义与数据集轮次允许动态提示词变化并保留实际上游身份', async () => {
  const e = await experiment('chained-rounds'), evidence = join(e.root, 'evidence.jsonl');
  const definition = join(e.root, 'definition-preset'), dataset = join(e.root, 'dataset-preset');
  for (const preset of [definition, dataset]) await mkdir(join(preset, 'candidates'), {recursive: true});
  for (const name of ['route', 'stop']) await writeFile(join(definition, 'candidates', name + '.json'), await readFile(join(repoRoot, 'fixtures/agent-eval/366/des-366-zoom1', name + '.json')));
  await writeFile(join(definition, 'outcome.json'), JSON.stringify({candidates: ['candidates/route.json', 'candidates/stop.json'], pending: [], notes: '串联定义夹具。'}));
  await writeFile(join(dataset, 'candidates/dataset.json'), await readFile(join(repoRoot, 'fixtures/agent-eval/366/des-366-zoom1/dataset.json')));
  await writeFile(join(dataset, 'outcome.json'), JSON.stringify({candidates: ['candidates/dataset.json'], pending: [], notes: '串联数据集夹具。'}));
  const source = await readFile(e.executor, 'utf8');
  await writeFile(e.executor, source.replace("process.argv.splice", `
const provenance = JSON.parse(await readFile(join(dirname(process.cwd()), 'logs/provenance.json'), 'utf8'));
await appendFile(${JSON.stringify(evidence)}, JSON.stringify(provenance) + '\\n');
const preset = dirname(process.cwd()).endsWith('dataset') ? ${JSON.stringify(dataset)} : ${JSON.stringify(definition)};
process.argv.splice`));
  const args = [...e.args, '--repetitions', '1-1']; args[args.indexOf('--scenarios') + 1] = '366-transcription';
  const result = await cli(args);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const records = (await readFile(evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records).toHaveLength(2);
  expect(records[0].promptSha256).not.toBe(records[1].promptSha256);
  expect(records[1].inputs.workspace).toMatchObject({fingerprint: expect.any(String)});
  expect(records[1].inputs.definition).toMatchObject({name: '公交线路牌', version: 1});
});

it('同目录中的有效观测若来自其他模型条件，续跑拒绝混用并保留原报告', async () => {
  const e = await experiment('mixed-results'), args = [...e.args, '--repetitions', '1-1'];
  expect((await cli(args)).code).toBe(1);
  const file = join(e.out, 'run-1/m402-definition/definition/round.json');
  const record = await read(file); record.runtime.model = 'other-experiment-model';
  await writeFile(file, JSON.stringify(record));
  const original = await readFile(join(e.reports, 'mixed-results.json'), 'utf8');
  const mixed = await cli(args);
  expect(mixed.code, mixed.stdout + mixed.stderr).toBe(2);
  expect(mixed.stderr).toContain('runtime.model');
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\n');
  expect(await readFile(join(e.reports, 'mixed-results.json'), 'utf8')).toBe(original);
  expect(await readdir(e.reports)).toHaveLength(1);
});

it('相同模型下复制来自不同核准事实的轮次，不能并入已冻结实验', async () => {
  const target = await experiment('foreign-target'), source = await experiment('foreign-source');
  const baseline = join(source.root, 'facts.json');
  await writeFile(baseline, JSON.stringify({name: '另一实验的事实', items: [{id: 'route', label: '线路号'}]}));
  const config = await read(source.configFile); config.scenarios[0].contentBaseline = baseline;
  await writeFile(source.configFile, JSON.stringify(config));
  for (const e of [target, source]) expect((await cli([...e.args, '--repetitions', '1-1'])).code).toBe(1);
  const report = await readFile(join(target.reports, 'foreign-target.json'));
  await cp(join(source.out, 'run-1/m402-definition/definition'), join(target.out, 'run-1/m402-definition/definition'), {recursive: true, force: true});
  const resumed = await cli([...target.args, '--repetitions', '1-1']);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(2);
  expect(resumed.stderr).toContain('观测条件与原实验不符');
  expect(await readFile(target.ledger, 'utf8')).toBe('dispatch\n');
  expect(await readFile(join(target.reports, 'foreign-target.json'))).toEqual(report);
  expect(await readdir(target.reports)).toHaveLength(1);
});

it('旧资源目录经链接读取的实际字节变化同样拒绝续跑', async () => {
  const e = await experiment('linked-resource'), assets = join(e.root, 'assets'), resources = join(e.root, 'resources');
  await mkdir(assets); await mkdir(resources);
  const image = join(assets, 'picture.png');
  await cp(join(resourcesDir, 'images/test/quadrants.png'), image);
  await symlink(assets, join(resources, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(resources, 'resources.json'), JSON.stringify({resources: [{id: 'picture', kind: 'image', file: 'linked/picture.png'}]}));
  const config = await read(e.configFile); config.resources = resources; await writeFile(e.configFile, JSON.stringify(config));
  const args = [...e.args, '--repetitions', '1-1'];
  expect((await cli(args)).code).toBe(1);
  const manifest = await readFile(join(e.out, 'eval.json'));
  await cp(join(resourcesDir, 'images/test/quadrants.jpg'), image);
  const resumed = await cli(args);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(2);
  expect(resumed.stderr).toContain('resources');
  expect(await readFile(e.ledger, 'utf8')).toBe('dispatch\n');
  expect(await readFile(join(e.out, 'eval.json'))).toEqual(manifest);
});
