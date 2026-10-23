import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runAgentTask } from '../src/index.js';
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
