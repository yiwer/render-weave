import {afterAll, beforeAll, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {repoRoot, resourcesDir} from './support/fixtures.js';
let root: string;
beforeAll(async () => {root = await mkdtemp(join(tmpdir(), 'rw-feedback-cli-'));});
afterAll(async () => {await rm(root, {recursive: true, force: true});});
async function cli(args: string[], key = false) {
  return new Promise<{code: number | null; stdout: string; stderr: string}>(done => {
    const child = spawn(process.execPath, ['--import', 'tsx', ...args], {cwd: repoRoot, windowsHide: true,
      env: {...process.env, RW_FEEDBACK_KEY: key ? 'offline-key' : ''}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = ''; child.stdout.on('data', value => {stdout += value;}); child.stderr.on('data', value => {stderr += value;});
    child.on('close', code => done({code, stdout, stderr}));
  });
}
it('公开评估入口无需凭据可列出双语四任务的16个未运行单元及缺失材料，不用其他场景填补', async () => {
  const tasks = ['definition-extraction', 'dataset-extraction', 'template-design', 'template-revision'];
  const config = {format: 'renderweave-agent-eval-config/2', consecutivePasses: 2, resources: resourcesDir, evidence: 'mechanism',
    scenarios: ['zh', 'en'].flatMap(language => tasks.map(task => ({id: `${language}-${task}`, name: `${language}-${task}`, kind: 'feedback', language, task,
      sample: join(root, 'missing.png'), brief: join(root, 'missing.md'), seedRound: join(root, 'missing-seed'), feedback: join(root, 'feedback.md'),
      policy: join(root, 'policy.json'), pass: {targetCorrection: true, nonTargetPreservation: true, unknownRetained: true}})))};
  const file = join(root, 'missing.json'); await writeFile(file, JSON.stringify(config));
  const out = join(root, 'plan.json');
  const result = await cli(['scripts/agent-eval/run.ts', '--config', file, '--plan', out, '--key-env', 'RW_FEEDBACK_KEY']);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const plan = JSON.parse(await readFile(out, 'utf8'));
  expect(plan.units).toHaveLength(16);
  expect(plan.units.every((unit: any) => unit.status === 'not-run' && unit.missing.includes('sample') && unit.missing.includes('approvedBaseline'))).toBe(true);
  expect(plan.realModelObservations).toBe(0);
  expect(plan.missingRealModelObservations).toBe(16);
}, 30000);

it('公开评估CLI沿已知缺陷轮次接续，绑定核准事实并分别判定目标、保留和未知', async () => {
  const {mkdir} = await import('node:fs/promises');
  const {runAgentTask} = await import('../src/index.js');
  const dir = join(root, 'definition'); await mkdir(dir);
  const definition = {dslVersion: 'renderweave-schema/1', name: 'calibration', version: 1, displayName: '校准站名', fields: [
    {name: 'routeNo', displayName: '线路号', type: 'text'}, {name: 'stpoName', displayName: '站名', type: 'text'}]};
  const preset = join(dir, 'initial'); await mkdir(join(preset, 'candidates'), {recursive: true});
  await writeFile(join(preset, 'candidates/definition.json'), JSON.stringify(definition));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({candidates: ['candidates/definition.json'], pending: [], notes: '受控初始缺陷'}));
  const sample = join(repoRoot, 'docs/examples/materials/m402-route-sign.jpg'), brief = join(dir, 'brief.md'), baseline = join(dir, 'baseline.json');
  await writeFile(brief, '校准：线路号与站名。');
  await writeFile(baseline, JSON.stringify({name: 'calibration-zh', items: [{id: 'stop', label: '站名', definition: 'calibration', field: 'stopName'}, {id: 'unknown', label: '未核准语义'}]}));
  const seed = join(dir, 'seed');
  await runAgentTask({task: 'definition-extraction', sample, brief, resources: resourcesDir, contentBaseline: baseline, out: seed,
    key: 'offline-key', keyEnv: 'RW_FEEDBACK_KEY', claude: {command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset]}});
  const feedback = join(dir, 'feedback.md'), policy = join(dir, 'policy.json');
  await writeFile(feedback, '仅把 stpoName 改为 stopName，保留其他内容；未核准语义保持未知。交回前调用 check_outcome。');
  await writeFile(policy, JSON.stringify({format: 'renderweave-feedback-policy/1', candidate: 'candidates/definition.json',
    corrections: [{pointer: '/fields/1/name', before: 'stpoName', after: 'stopName'}], unknownIds: ['unknown']}));
  const corrected = join(dir, 'corrected'); await mkdir(join(corrected, 'candidates'), {recursive: true});
  definition.fields[1]!.name = 'stopName';
  await writeFile(join(corrected, 'candidates/definition.json'), JSON.stringify(definition));
  await writeFile(join(corrected, 'outcome.json'), JSON.stringify({candidates: ['candidates/definition.json'], pending: [], notes: '机制验证'}));
  const config = {format: 'renderweave-agent-eval-config/2', consecutivePasses: 2, resources: resourcesDir, evidence: 'mechanism', scenarios: [
    {id: 'zh-definition', name: '中文定义纠偏', kind: 'feedback', language: 'zh', task: 'definition-extraction', sample, brief,
      contentBaseline: baseline, seedRound: seed, feedback, policy, pass: {targetCorrection: true, nonTargetPreservation: true, unknownRetained: true}}]};
  const file = join(dir, 'config.json'); await writeFile(file, JSON.stringify(config));
  const result = await cli(['scripts/agent-eval/run.ts', '--config', file, '--out', join(dir, 'eval'), '--reports', join(dir, 'reports'),
    '--label', 'definition-feedback', '--jobs', '1', '--repetitions', '1-1', '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), corrected])], true);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const report = JSON.parse(await readFile(join(dir, 'reports/definition-feedback.json'), 'utf8'));
  expect(report.results[0].status).toBe('pass');
  expect(report.results[0].checks.feedback).toMatchObject({targetCorrection: true, nonTargetPreservation: true, unknownRetained: true, finalCheckMatches: true});
  expect(report.gate.completeness).toMatchObject({planned: 2, pass: 1, notRun: 1});
  expect(report.evidence).toMatchObject({kind: 'mechanism', realModelObservations: 0});
  expect(report.attempts).toHaveLength(1);
}, 60000);

it('准备命令生成八类可冻结输入，真实MCP从后续页读到第22区缺陷并完成双语四任务纠偏', async () => {
  const dir = await preparedMatrix();
  const config = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  expect(config.scenarios).toHaveLength(8);
  const planned = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--plan', join(dir, 'plan.json')]);
  expect(planned.code, planned.stdout + planned.stderr).toBe(0);
  const run = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--out', join(dir, 'eval'), '--reports', join(dir, 'reports'),
    '--label', 'matrix', '--jobs', '2', '--repetitions', '1-1', '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'calibration'])], true);
  expect(run.code, run.stdout + run.stderr).toBe(3);
  const report = JSON.parse(await readFile(join(dir, 'reports/matrix.json'), 'utf8'));
  expect(report.results.map((result: any) => [result.id, result.status])).toEqual(config.scenarios.map((scenario: any) => [scenario.id, 'pass']));
  expect(report.gate.completeness).toMatchObject({planned: 16, pass: 8, notRun: 8});
  for (const result of report.results) {
    expect(result.checks.feedback).toMatchObject({targetCorrection: true, nonTargetPreservation: true, unknownRetained: true, finalCheckMatches: true, pagination: true});
    if (result.id.includes('template')) {
      expect(result.checks.feedback.before.visual.anomaliesTotal).toBe(6);
      expect(result.checks.feedback.after.visual.anomaliesTotal).toBe(0);
      expect(result.checks.feedback.after.visual.coverage.unknownRegions).toBe(24);
    }
  }
}, 180000);

let matrixPreparation: Promise<string> | undefined;
function preparedMatrix() {
  return matrixPreparation ??= (async () => {
    const dir = join(root, 'matrix');
    const prepared = await cli(['scripts/agent-eval/prepare-feedback.ts', '--out', dir, '--resources', resourcesDir]);
    expect(prepared.code, prepared.stdout + prepared.stderr).toBe(0);
    return dir;
  })();
}
it('离线计划拒绝无效核准事实及与初始轮次不一致的替代基准', async () => {
  const dir = await preparedMatrix();
  const original = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  const baseline = join(root, 'invalid-baseline.json'); await writeFile(baseline, JSON.stringify({name: '无事实'}));
  const scenario = original.scenarios[0];
  const config = {...original, scenarios: [{...scenario, contentBaseline: baseline}]};
  const file = join(root, 'invalid-config.json'); await writeFile(file, JSON.stringify(config));
  const result = await cli(['scripts/agent-eval/run.ts', '--config', file, '--plan', join(root, 'invalid-plan.json')]);
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const plan = JSON.parse(await readFile(join(root, 'invalid-plan.json'), 'utf8'));
  expect(plan.units[0].missing).toContain('validatedInputs');
  expect(plan.units[0].validationError).toContain('基准');
}, 60000);

it('目标修正不能掩盖越界改动，检查后再次修改使旧检查身份失效', async () => {
  const dir = await preparedMatrix();
  for (const mode of ['collateral', 'stale']) {
    const result = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--scenarios', 'zh-definition-extraction',
      '--out', join(root, mode), '--reports', join(root, mode + '-reports'), '--label', mode, '--jobs', '1', '--repetitions', '1-1',
      '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), mode])], true);
    expect(result.code, result.stdout + result.stderr).toBe(1);
    const report = JSON.parse(await readFile(join(root, mode + '-reports', mode + '.json'), 'utf8'));
    expect(report.results[0].checks.feedback).toMatchObject({targetCorrection: true, nonTargetPreservation: false});
    if (mode === 'stale') expect(report.results[0].checks.feedback.finalCheckMatches).toBe(false);
  }
}, 90000);
it('受控pass/fail/invalid/not-run共存且保留16个计划单元，假执行器不计真实模型观测', async () => {
  const dir = await preparedMatrix();
  const result = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--out', join(root, 'mixed'), '--reports', join(root, 'mixed-reports'),
    '--label', 'mixed', '--jobs', '1', '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'mixed'])], true);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const report = JSON.parse(await readFile(join(root, 'mixed-reports/mixed.json'), 'utf8'));
  expect(report.gate.completeness, JSON.stringify(report.results.map((r: any) => ({id: r.id, failures: r.failures, rounds: r.rounds})), null, 2)).toEqual({planned: 16, pass: 1, fail: 1, invalid: 1, notRun: 13, complete: false});
  expect(report.attempts).toHaveLength(3);
  expect(report.evidence.realModelObservations).toBe(0);
}, 90000);

it('离线计划只引用完整身份相容的已有轮次，条件变化不把旧观测补入缺失单元', async () => {
  const dir = await preparedMatrix(), configFile = join(dir, 'config.json'), out = join(root, 'referenced');
  const run = await cli(['scripts/agent-eval/run.ts', '--config', configFile, '--scenarios', 'zh-definition-extraction', '--out', out,
    '--reports', join(root, 'referenced-reports'), '--label', 'referenced', '--jobs', '1', '--repetitions', '1-1', '--key-env', 'RW_FEEDBACK_KEY',
    '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'calibration'])], true);
  expect(run.code, run.stdout + run.stderr).toBe(3);
  const planFile = join(root, 'referenced-plan.json');
  const plan = await cli(['scripts/agent-eval/run.ts', '--config', configFile, '--scenarios', 'zh-definition-extraction', '--out', out, '--plan', planFile]);
  expect(plan.code, plan.stdout + plan.stderr).toBe(0);
  const reference = JSON.parse(await readFile(planFile, 'utf8'));
  expect(reference.source).toMatchObject({compatible: true, identity: expect.stringMatching(/^sha256:/)});
  expect(reference.units.map((unit: any) => unit.status)).toEqual(['pass', 'not-run']);
  expect(reference.realModelObservations).toBe(0);
  const changed = JSON.parse(await readFile(configFile, 'utf8')); changed.scenarios[0].name += ' 改变配置';
  const changedFile = join(root, 'changed-config.json'); await writeFile(changedFile, JSON.stringify(changed));
  const incompatibleFile = join(root, 'incompatible-plan.json');
  const incompatible = await cli(['scripts/agent-eval/run.ts', '--config', changedFile, '--scenarios', 'zh-definition-extraction', '--out', out, '--plan', incompatibleFile]);
  expect(incompatible.code, incompatible.stdout + incompatible.stderr).toBe(3);
  const rejected = JSON.parse(await readFile(incompatibleFile, 'utf8'));
  expect(rejected.source).toMatchObject({compatible: false});
  expect(rejected.units.every((unit: any) => unit.status === 'not-run')).toBe(true);
}, 90000);

it('待确认候选覆盖了已核准的目标值时不能只凭原始JSON判定纠偏成功', async () => {
  const dir = await preparedMatrix();
  const result = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--scenarios', 'zh-dataset-extraction',
    '--out', join(root, 'pending'), '--reports', join(root, 'pending-reports'), '--label', 'pending', '--jobs', '1', '--repetitions', '1-1',
    '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'pending'])], true);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const report = JSON.parse(await readFile(join(root, 'pending-reports/pending.json'), 'utf8'));
  expect(report.results[0].checks.feedback.targetCorrection).toBe(false);
}, 60000);


it('目标text路径被slot替代仍拒绝越界，并独立核对未知、后续页和终检身份', async () => {
  const dir = await preparedMatrix();
  const result = await cli(['scripts/agent-eval/run.ts', '--config', join(dir, 'config.json'), '--scenarios', 'zh-template-design',
    '--out', join(root, 'slot-target'), '--reports', join(root, 'slot-target-reports'), '--label', 'slot-target', '--jobs', '1', '--repetitions', '1-1',
    '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'slot-target'])], true);
  expect(result.code, result.stdout + result.stderr).toBe(1);
  const report = JSON.parse(await readFile(join(root, 'slot-target-reports/slot-target.json'), 'utf8'));
  expect(report.results[0].status).toBe('fail');
  expect(report.results[0].checks.feedback).toMatchObject({targetCorrection: false, nonTargetPreservation: false,
    unknownRetained: true, finalCheckMatches: true, pagination: true});
  expect(report.results[0].checks.feedback.failures).toEqual(['目标修正未通过', '非目标保留未通过']);
}, 90000);


it('历史工具记录缺失与实际未调用分开诊断，重新评分另存且不改旧报告', async () => {
  const {mkdir, readdir} = await import('node:fs/promises');
  const dir = await preparedMatrix();
  const configFile = join(dir, 'config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const scenario = config.scenarios.find((value: any) => value.id === 'zh-template-design');
  const out = join(root, 'legacy-feedback'), round = join(out, 'run-1/zh-template-design/feedback'), reports = join(root, 'legacy-reports');
  const completed = await cli(['dist/bin.js', 'agent', 'run', '--from', scenario.seedRound, '--feedback', scenario.feedback, '--out', round,
    '--key-env', 'RW_FEEDBACK_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-feedback-claude.mjs'), 'calibration'])], true);
  expect(completed.code, completed.stdout + completed.stderr).toBe(0);
  const manifest = JSON.stringify({label: 'legacy-feedback', startedAt: '2026-10-23T00:00:00Z', scenarios: ['zh-template-design'], repeat: 2});
  await writeFile(join(out, 'eval.json'), manifest); await mkdir(reports);
  const original = JSON.stringify({label: 'legacy-feedback', originalVerdict: 'historical'});
  await writeFile(join(reports, 'legacy-feedback.json'), original);
  // 受控历史副本缺工具记录；不是修改真实封存尝试，也不制造模型观测。
  await rm(join(round, 'logs/tools.jsonl'));
  const rescored = await cli(['scripts/agent-eval/run.ts', '--config', configFile, '--rescore', out, '--reports', reports]);
  expect(rescored.code, rescored.stdout + rescored.stderr).toBe(1);
  const files = (await readdir(reports)).filter(name => name.includes('.rescore-'));
  expect(files).toHaveLength(1);
  const report = JSON.parse(await readFile(join(reports, files[0]!), 'utf8'));
  const feedback = report.results[0].checks.feedback;
  expect(feedback).toMatchObject({format: 'renderweave-feedback-score/2', targetCorrection: true, nonTargetPreservation: true,
    unknownRetained: true, finalCheckMatches: null, pagination: null});
  expect(feedback.unchecked).toMatchObject({finalCheckMatches: expect.any(String), pagination: expect.any(String)});
  expect(feedback.failures).toHaveLength(2);
  expect(feedback.failures.every((reason: string) => reason.includes('未核查'))).toBe(true);
  expect(report.rescoring.scoringIdentity.scorer).toMatch(/^sha256:/);
  expect(report.rescoring.sourceReportSha256).toMatch(/^sha256:/);
  expect(await readFile(join(reports, 'legacy-feedback.json'), 'utf8')).toBe(original);
  expect(await readFile(join(out, 'eval.json'), 'utf8')).toBe(manifest);
  await writeFile(join(round, 'logs/tools.jsonl'), '');
  const empty = await cli(['scripts/agent-eval/run.ts', '--config', configFile, '--rescore', out, '--reports', reports]);
  expect(empty.code, empty.stdout + empty.stderr).toBe(1);
  const second = (await readdir(reports)).find(name => name.includes('.rescore-') && !files.includes(name))!;
  const withoutCalls = JSON.parse(await readFile(join(reports, second), 'utf8')).results[0].checks.feedback;
  expect(withoutCalls).toMatchObject({finalCheckMatches: false, pagination: false, unknownRetained: true, unchecked: {}});
}, 90000);
