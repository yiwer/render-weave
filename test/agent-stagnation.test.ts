/** 从公开 CLI 与真实 MCP 观察修复周期，不访问私有计数器。 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, readPreviousRound, runAgentTask } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'rw-stagnation-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function run(name: string, actions: unknown[], extra: string[] = []) {
  const dir = join(root, name), preset = join(dir, 'preset'), out = join(dir, 'round');
  await mkdir(join(preset, 'candidates'), { recursive: true });
  await writeFile(join(dir, 'brief.md'), '从图中提取线路字段');
  await writeFile(join(dir, 'facts.json'), JSON.stringify({ name: '核准字段', items: ['number', 'title', 'station'].map(field => ({ id: field, label: field, definition: '线路', field })) }));
  await writeFile(join(preset, 'actions.json'), JSON.stringify(actions));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/schema.json'], pending: [], notes: '提取线路字段' }));
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), 'agent', 'run', '--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png'),
    '--brief', join(dir, 'brief.md'), '--resources', resourcesDir, '--content-baseline', join(dir, 'facts.json'), '--out', out,
    '--key-env', 'RW_STAGNATION_KEY', '--timeout-ms', '8000', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-stagnation.mjs'), preset]), ...extra],
  { cwd: repoRoot, env: { ...process.env, RW_STAGNATION_KEY: 'offline' }, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = ''; child.stdout!.on('data', bytes => stdout += bytes); child.stderr!.on('data', bytes => stderr += bytes);
  const [code] = await once(child, 'close');
  return { out, code, result: stdout ? JSON.parse(stdout) : undefined, stderr };
}
it('核准必修问题在两次完整写入和复测后仍相同，停止并保留可接续检查点', async () => {
  const job = await run('same-candidate', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
  ]);
  expect(job.code, job.stderr).toBe(1);
  expect(job.result?.stopped).toMatchObject({ reason: 'stagnation', threshold: 2 });
  const review = await readReview(job.out);
  expect(review.execution?.status).toBe('stopped');
  expect(review.view?.round.source).toBe('hostRecovery');
  expect(review.checkpoint?.check.coverageVerification?.missingItems).toEqual(['title', 'station']);
  expect((await readPreviousRound(job.out)).checkpoint?.id).toBe(review.checkpoint?.id);
  expect(JSON.parse(await readFile(join(job.out, 'round.json'), 'utf8')).verdict).toBe('unqualified');
});
it('显式阈值一只需一个完整修复周期，生效值显示并固定在轮次记录', async () => {
  const job = await run('threshold-one', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'stagnation', threshold: 1 });
  expect(job.stderr).toContain('停滞阈值 1');
  const review = await readReview(job.out);
  expect(review.execution?.start?.runtime).toMatchObject({ stagnationThreshold: 1 });
  expect(JSON.parse(await readFile(join(job.out, 'round.json'), 'utf8')).runtime).toMatchObject({ stagnationThreshold: 1 });
});
it.each([0, -1, 1.5, NaN, Infinity])('非法停滞阈值 %s 在执行器启动前拒绝', async threshold => {
  await expect(runAgentTask({ out: join(root, 'invalid'), key: 'offline', keyEnv: 'RW_STAGNATION_KEY', stagnationThreshold: threshold }))
    .rejects.toThrow(/stagnation-threshold.*正整数/);
});
