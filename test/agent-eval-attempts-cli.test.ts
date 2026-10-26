import {afterAll, beforeAll, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readReview} from '../src/index.js';
import {repoRoot, resourcesDir} from './support/fixtures.js';

let root: string, args: string[];
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'rw-attempts-cli-'));
  const preset = join(root, 'preset'); await mkdir(join(preset, 'candidates'), {recursive: true});
  for (const name of ['route', 'stop']) await writeFile(join(preset, `candidates/${name}.json`), await readFile(join(repoRoot, `fixtures/agent-eval/definitions/des-gd1/${name}.json`)));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({candidates: ['candidates/route.json', 'candidates/stop.json'], pending: [], notes: 'CLI机制验证'}));
  const config = JSON.parse(await readFile(join(repoRoot, 'scripts/agent-eval/config.json'), 'utf8'));
  config.resources = resourcesDir;
  const configFile = join(root, 'config.json'); await writeFile(configFile, JSON.stringify(config));
  const usage = JSON.stringify({input_tokens: 11, output_tokens: 222, output_tokens_details: {thinking_tokens: 150}, cache_read_input_tokens: 33, cache_creation_input_tokens: 44});
  args = ['scripts/agent-eval/run.ts', '--config', configFile, '--scenarios', 'm402-definition', '--repeat', '2', '--jobs', '2',
    '--out', join(root, 'out'), '--reports', join(root, 'reports'), '--label', 'attempts-cli', '--key-env', 'RW_ATTEMPTS_KEY',
    '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-usage-claude.mjs'), preset, usage])];
});
afterAll(async () => {await rm(root, {recursive: true, force: true});});
async function cli(selected = args, env: Record<string, string> = {}) {
  return new Promise<{code: number | null; stdout: string; stderr: string}>(done => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), ...selected], {
      cwd: repoRoot, windowsHide: true, env: {...process.env, RW_ATTEMPTS_KEY: 'offline-key', ...env}, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => {stdout += String(chunk);}); child.stderr.on('data', chunk => {stderr += String(chunk);});
    child.on('close', code => done({code, stdout, stderr}));
  });
}

it('并行CLI跨进程重复续跑不重复派发或计量，实际会话墙钟独立于各轮之和', async () => {
  const first = await cli(); expect(first.code, first.stdout + first.stderr).toBe(0);
  const firstFile = /^报告：(.+)$/m.exec(first.stdout)![1]!.trim();
  const firstBytes = await readFile(firstFile, 'utf8'), report = JSON.parse(firstBytes);
  expect(report.attempts).toHaveLength(2);
  expect(report.totals).toMatchObject({outputTokens: 444, thinkingTokens: 300, unknownUsageAttempts: 0});
  expect(report.timing).toMatchObject({sessions: 1, incompleteSessions: 0, actualWallMs: expect.any(Number), attemptsElapsedMs: expect.any(Number)});
  expect(report.timing.actualWallMs).toBeGreaterThan(0);
  expect(report.timing.actualWallMs).not.toBe(report.timing.attemptsElapsedMs);
  const second = await cli(); expect(second.code, second.stdout + second.stderr).toBe(0);
  const finalFile = /^报告：(.+)$/m.exec(second.stdout)![1]!.trim(), final = JSON.parse(await readFile(finalFile, 'utf8'));
  expect(final.attempts.map((attempt: {id: string}) => attempt.id)).toEqual(report.attempts.map((attempt: {id: string}) => attempt.id));
  expect(final.totals).toEqual(report.totals);
  expect(final.timing.sessions).toBe(2);
  expect(await readFile(firstFile, 'utf8')).toBe(firstBytes);
  expect(await readdir(join(root, 'reports'))).toHaveLength(2);
}, 60000);

it('评估宿主被强退后保留已退出尝试，补跑保留此前用量与未知墙钟', async () => {
  const marker = join(root, 'held.json'), out = join(root, 'killed'), reports = join(root, 'killed-reports');
  const selected = [...args];
  selected[selected.indexOf('--out') + 1] = out;
  selected[selected.indexOf('--reports') + 1] = reports;
  selected[selected.indexOf('--label') + 1] = 'killed';
  selected[selected.indexOf('--jobs') + 1] = '1';
  const commandIndex = selected.indexOf('--claude-args') + 1;
  selected[commandIndex] = JSON.stringify([...JSON.parse(selected[commandIndex]!), '', 'hold:' + marker]);
  const child = spawn(process.execPath, ['--import', 'tsx', ...selected], {cwd: repoRoot, windowsHide: true,
    env: {...process.env, RW_ATTEMPTS_KEY: 'offline-key'}, stdio: 'ignore'});
  const closed = new Promise<void>(done => child.on('close', () => done()));
  const waitUntil = async (test: () => Promise<boolean>) => {
    const deadline = Date.now() + 20000;
    while (!await test()) {if (Date.now() > deadline) throw new Error('等待公开执行结果超时'); await new Promise(done => setTimeout(done, 50));}
  };
  const exists = async (file: string) => readFile(file).then(() => true, () => false);
  let held: {pid: number; host: number} | undefined;
  try {
    await waitUntil(() => exists(marker)); held = JSON.parse(await readFile(marker, 'utf8'));
    child.kill('SIGKILL'); await closed;
    const attemptRoot = join(out, 'run-1/m402-definition/attempts');
    const firstId = (await readdir(attemptRoot))[0]!;
    const original = join(attemptRoot, firstId, 'round');
    try {process.kill(held!.pid, 'SIGKILL');} catch { /* 父进程退出已触发执行器清理 */ }
    try {process.kill(held!.host, 'SIGKILL');} catch { /* 宿主已结束 */ }
    await waitUntil(async () => {const state = (await readReview(original)).execution; return state?.status === 'interrupted' || !!state?.committed;});
    const stream = await readFile(join(original, 'logs/stream.jsonl'));
    const resumed = await cli(selected); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    const file = /^报告：(.+)$/m.exec(resumed.stdout)![1]!.trim(), report = JSON.parse(await readFile(file, 'utf8'));
    expect(report.attempts).toHaveLength(3);
    expect(report.totals).toMatchObject({inputTokens: 33, outputTokens: 666, thinkingTokens: 450, toolCalls: 3, persistedResults: 3, unknownUsageAttempts: 0});
    expect(report.timing).toMatchObject({incompleteSessions: 1, actualWallMs: null, unknownAttemptDurations: 1});
    expect(await readFile(join(original, 'logs/stream.jsonl'))).toEqual(stream);
    expect(report.attempts.find((attempt: {id: string}) => attempt.id === firstId).error).toContain('原派发中断或缺少实验封存');
  } finally {
    child.kill('SIGKILL');
    for (const pid of held ? [held.pid, held.host] : []) {try {process.kill(pid, 'SIGKILL');} catch { /* 已退出 */ }}
    await closed;
  }
}, 90000);

it.skipIf(process.platform !== 'win32')('停止后宿主进程树清理未确认：单元记 invalid（host），不算模型未达线', async () => {
  const selected = [...args];
  for (const [flag, value] of [['--out', join(root, 'cleanup')], ['--reports', join(root, 'cleanup-reports')], ['--label', 'cleanup'], ['--jobs', '1']] as const)
    selected[selected.indexOf(flag) + 1] = value;
  const commandIndex = selected.indexOf('--claude-args') + 1;
  selected[commandIndex] = JSON.stringify([...JSON.parse(selected[commandIndex]!), '', 'hold:' + join(root, 'cleanup-held.json')]);
  const result = await cli([...selected, '--repetitions', '1-1', '--timeout-ms', '1500'], {
    NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'test/support/slow-taskkill.mjs')).href}`, RW_SLOW_TASKKILL_MS: 'hang'});
  expect(result.code, result.stdout + result.stderr).toBe(3);
  const report = JSON.parse(await readFile(/^报告：(.+)$/m.exec(result.stdout)![1]!.trim(), 'utf8'));
  expect(report.gate.status).toBe('incomplete');
  const first = report.results.find((unit: {repetition: number}) => unit.repetition === 1);
  expect(first).toMatchObject({status: 'invalid', failures: [], invalid: {kind: 'host', task: 'definition-extraction'}});
  expect(first.invalid.error).toContain('本轮进程树清理未确认');
}, 90000);
