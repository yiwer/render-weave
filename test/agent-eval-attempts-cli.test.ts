import {afterAll, beforeAll, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
async function cli() {
  return new Promise<{code: number | null; stdout: string; stderr: string}>(done => {
    const child = spawn(process.execPath, [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), ...args], {
      cwd: repoRoot, windowsHide: true, env: {...process.env, RW_ATTEMPTS_KEY: 'offline-key'}, stdio: ['ignore', 'pipe', 'pipe']});
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
