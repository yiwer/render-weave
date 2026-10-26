/** 整个 CLI、假执行器与外部渲染边界；不以 Promise 超时替代进程退出验收。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, readPreviousRound, runAgentTask } from '../src/index.js';
import { copyWorkspaceFixture, greetingRequest, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-budget-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
it('启动前显示默认 60 分钟及任务轮数，生效预算进入固定启动资料', async () => {
  const { runCli } = await import('../dist/cli.js'), f = await prepared('default-budget');
  process.env.RW_BUDGET_TEST_KEY = 'test-key'; let errors = '';
  try {
    expect(await runCli(f.args, { stdout: () => {}, stderr: (value: string) => { errors += value; } })).toBe(0);
    expect(errors).toContain('3600000 毫秒'); expect(errors).toContain('80 轮');
    const start = JSON.parse(await readFile(join(f.out, 'round-start.json'), 'utf8'));
    expect(start.runtime).toMatchObject({ maxTurns: 80, roundTimeoutMs: 3600000 });
    const record = JSON.parse(await readFile(join(f.out, 'round.json'), 'utf8'));
    expect(record.runtime).toMatchObject(start.runtime);
  } finally { delete process.env.RW_BUDGET_TEST_KEY; }
});
it.each([0, -1, NaN, Infinity])('非法时间预算 %s 在创建执行器前拒绝', async value => {
  await expect(runAgentTask({ out: join(base, 'invalid'), key: 'key', keyEnv: 'KEY', roundTimeoutMs: value })).rejects.toThrow(/timeout-ms/);
});
it('无法执行的硬 token 和费用限制，以及非法轮数，在启动前明确拒绝', async () => {
  const options = { out: join(base, 'unsupported'), key: 'key', keyEnv: 'KEY' };
  await expect(runAgentTask({ ...options, maxTokens: 1 } as any)).rejects.toThrow(/不支持.*硬.*token/);
  await expect(runAgentTask({ ...options, maxCostUsd: 1 } as any)).rejects.toThrow(/不支持.*硬.*费用/);
  await expect(runAgentTask({ ...options, maxTurns: 1.5 })).rejects.toThrow(/max-turns/);
});
async function waitFile(path: string) {
  for (let i = 0; i < 500; i++) { try { return await readFile(path, 'utf8'); } catch { await delay(20); } }
  throw new Error(`没有等到 ${path}`);
}
async function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await once(killer, 'close'); }
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
async function prepared(name: string) {
  const dir = join(base, name), out = join(dir, 'round'), preset = join(dir, 'preset'), workspace = join(dir, 'workspace');
  await copyWorkspaceFixture(singleTextDir, workspace);
  await mkdir(join(preset, 'candidates'), { recursive: true });
  await writeFile(join(dir, 'brief.md'), '制作问候牌');
  await writeFile(join(dir, 'request.json'), JSON.stringify(greetingRequest({ template: '预算牌' })));
  await writeFile(join(preset, 'candidates/template.json'), JSON.stringify({ dslVersion: 'renderweave-template/1', name: '预算牌', base: { name: '问候', version: 1 },
    artboard: { sizeRange: { width: { min: 10, max: 500 }, height: { min: 10, max: 200 } }, fill: '#FF0000', layout: { mode: 'free' }, children: [] } }));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/template.json'], pending: [], notes: '红底' }));
  const args = ['agent', 'run', '--task', 'template-design', '--sample', join(resourcesDir, 'images/test/quadrants.png'), '--brief', join(dir, 'brief.md'),
    '--resources', resourcesDir, '--workspace', workspace, '--dataset', 'ds-greeting', '--request', join(dir, 'request.json'), '--out', out,
    '--key-env', 'RW_BUDGET_TEST_KEY', '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-claude.mjs'), preset])];
  return { dir, out, preset, args };
}
it.each(['final', 'tool'])('%s 同步检查阻塞仍按整轮预算结束，保留超时诊断而非完成成果', async mode => {
  const f = await prepared(`${mode}-render`), marker = join(f.dir, 'renderer-blocked');
  if (mode === 'tool') f.args[f.args.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/fake-checkpoint.mjs'), f.preset]);
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(repoRoot, 'test/support/budget-fault.mjs')).href, join(repoRoot, 'dist/bin.js'), ...f.args, '--timeout-ms', '1500'],
    { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key', RW_BUDGET_FAULT_MARKER: marker }, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
  let output = '', errors = ''; child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
  const closed = once(child, 'close'), started = Date.now();
  try {
    const result = await Promise.race([closed, delay(10000).then(() => undefined)]);
    expect(result, errors).toBeDefined();
    expect(await readFile(marker, 'utf8').catch(() => `${errors}\n${output}`)).toMatch(/^\d+$/);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(result![0]).toBe(1);
    expect(JSON.parse(output).stopped).toMatchObject({ reason: 'timeout', roundTimeoutMs: 1500 });
    const review = await readReview(f.out);
    expect(review.execution?.status).toBe('stopped');
    expect(review.view?.round.source).not.toBe('agent');
    await expect(readPreviousRound(f.out)).rejects.toThrow(/没有可核对的完整检查点/);
  } finally { await terminate(child); await closed; }
});

it('保存宽限最多 30 秒，保存挂起仍返回停止原因和已知用量，诊断不冒充完成', async () => {
  const f = await prepared('save-grace'), marker = join(f.dir, 'save-blocked');
  f.args[f.args.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/budget-checkpoint-claude.mjs'), f.preset]);
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(repoRoot, 'test/support/budget-save-fault.mjs')).href, join(repoRoot, 'dist/bin.js'), ...f.args, '--timeout-ms', '4000'],
    { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key', RW_BUDGET_FAULT_MARKER: marker }, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
  let output = '', errors = ''; child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
  const closed = once(child, 'close'), started = Date.now();
  try {
    const observed = JSON.parse(await waitFile(join(f.out, 'agent/checkpoint-observed.json')));
    const checkpoint = JSON.parse(observed.reply.result.content[0].text).checkpoint.id;
    await writeFile(join(f.out, 'agent/candidates/template.json'), '{"unfinished":');
    const result = await Promise.race([closed, delay(39000).then(() => undefined)]);
    expect(result, errors).toBeDefined(); expect(result![0]).toBe(1);
    expect(await readFile(marker, 'utf8')).toMatch(/^\d+$/);
    expect(Date.now() - started).toBeLessThan(39000);
    expect(JSON.parse(output)).toMatchObject({ stopped: { reason: 'timeout' }, save: 'incomplete', usage: { outputTokens: 12 } });
    const review = await readReview(f.out);
    expect(review.execution).toMatchObject({ status: 'stopped', committed: false, stop: { reason: { reason: 'timeout' }, usage: { outputTokens: 12 }, save: 'incomplete' } });
    expect(review.view).toBeUndefined();
    expect((await readPreviousRound(f.out)).checkpoint?.id).toBe(checkpoint);
  } finally { await terminate(child); await closed; }
}, 45000);

it.each(['result', 'partial', 'sparse'])('模型等待超时终止本轮执行器及后代，保留 %s 用量，无关工具仍存活', async mode => {
  const f = await prepared(`model-wait-${mode}`), args = [...f.args];
  args[args.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/budget-claude.mjs'), mode]);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), ...args, '--timeout-ms', '1000'],
    { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key' }, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
  const closed = once(child, 'close'); let output = '', errors = '';
  child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
  try {
    expect(await Promise.race([closed, delay(10000).then(() => undefined)]), errors).toBeDefined();
    expect(JSON.parse(output)).toMatchObject({ stopped: { reason: 'timeout' }, usage: { outputTokens: mode === 'result' ? 45 : 12 } });
    const record = JSON.parse(await readFile(join(f.out, 'round.json'), 'utf8'));
    expect(record.run).toMatchObject(mode === 'result' ? { inputTokens: 123, outputTokens: 45 } : { inputTokens: mode === 'sparse' ? 31 : 30, outputTokens: 12, usageSource: 'messages' });
    expect(record.run.thinkingTokens).toBeUndefined();
    const heartbeat = join(f.out, 'agent/descendant-heartbeat'), last = await readFile(heartbeat, 'utf8');
    await delay(150); expect(await readFile(heartbeat, 'utf8')).toBe(last);
    expect(unrelated.exitCode).toBeNull(); expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
  } finally { await terminate(child); await closed; unrelated.kill('SIGKILL'); }
});

it('取消只停止本轮，最后完整检查点仍可从新轮次接续，未检查残片不能替代', async () => {
  const { runCli } = await import('../dist/cli.js');
  const a = await prepared('cancel-a'), b = await prepared('cancel-b'), controller = new AbortController();
  const args = (f: Awaited<ReturnType<typeof prepared>>) => {
    const values = [...f.args]; values[values.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/fake-checkpoint.mjs'), f.preset]);
    // 本例检查取消隔离；B 轮需等 A 轮取消、保存及接续完成，不能先因夹具的短预算超时。
    return [...values, '--timeout-ms', '30000'];
  };
  let output = '', errors = '', secondOutput = '';
  process.env.RW_BUDGET_TEST_KEY = 'test-key';
  const first = runCli(args(a), { signal: controller.signal, stdout: (value: string) => { output += value; }, stderr: (value: string) => { errors += value; } });
  const second = runCli(args(b), { stdout: (value: string) => { secondOutput += value; }, stderr: () => {} });
  try {
    const observed = JSON.parse(await waitFile(join(a.out, 'agent/checkpoint-observed.json')));
    const id = JSON.parse(observed.reply.result.content[0].text).checkpoint.id;
    await waitFile(join(b.out, 'agent/checkpoint-observed.json'));
    await writeFile(join(a.out, 'agent/candidates/template.json'), '{"unfinished":');
    controller.abort();
    expect(await first, errors).toBe(1);
    expect(JSON.parse(output).stopped.reason).toBe('cancelled');
    expect((await readReview(a.out)).checkpoint?.id).toBe(id);
    expect((await readPreviousRound(a.out)).checkpoint?.id).toBe(id);
    const old = await readFile(join(a.out, 'round.json'));
    await writeFile(join(a.dir, 'feedback.md'), '沿用已检查的红底模板');
    let nextOutput = '';
    expect(await runCli(['agent', 'run', '--from', a.out, '--feedback', join(a.dir, 'feedback.md'), '--out', join(a.dir, 'next'), '--key-env', 'RW_BUDGET_TEST_KEY',
      '--claude', process.execPath, '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-claude.mjs'), a.preset])], { stdout: (value: string) => { nextOutput += value; }, stderr: () => {} })).toBe(0);
    expect(JSON.parse(nextOutput).verdict).toBe('qualified');
    expect(await readFile(join(a.out, 'round.json'))).toEqual(old);
    await writeFile(join(b.out, 'agent/continue'), '');
    const secondCode = await second;
    expect(secondCode, secondOutput).toBe(0);
  } finally {
    controller.abort(); await writeFile(join(b.out, 'agent/continue'), '').catch(() => undefined);
    await Promise.allSettled([first, second]); delete process.env.RW_BUDGET_TEST_KEY;
  }
});

it.skipIf(process.platform === 'win32')('CLI SIGTERM 是用户取消，终止本轮所属树', async () => {
  const f = await prepared('signal');
  f.args[f.args.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/budget-claude.mjs')]);
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), ...f.args], { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key' }, detached: true, stdio: 'pipe' });
  const closed = once(child, 'close'); let output = ''; child.stdout!.on('data', value => { output += value; }); child.stderr!.resume();
  try {
    await waitFile(join(f.out, 'agent/budget-processes.json')); child.kill('SIGTERM');
    expect(await Promise.race([closed, delay(10000).then(() => undefined)])).toBeDefined();
    expect(JSON.parse(output).stopped.reason).toBe('cancelled');
  } finally { await terminate(child); await closed; }
});

async function slowCleanup(name: string, delayMs: string) {
  const f = await prepared(name);
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(repoRoot, 'test/support/slow-taskkill.mjs')).href, join(repoRoot, 'dist/bin.js'), ...f.args],
    { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key', RW_SLOW_TASKKILL_MS: delayMs }, windowsHide: true, stdio: 'pipe' });
  let output = '', errors = ''; child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
  return { f, child, closed: once(child, 'close'), output: () => output, errors: () => errors };
}
it.skipIf(process.platform !== 'win32')('清理回执发布失败不能拒交已提交成果，返回及 stderr 明确回执未保存', async () => {
  const f = await prepared('cleanup-receipt-failure');
  const child = spawn(process.execPath, ['--import', pathToFileURL(join(repoRoot, 'test/support/cleanup-receipt-fault.mjs')).href, join(repoRoot, 'dist/bin.js'), ...f.args],
    { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key' }, windowsHide: true, stdio: 'pipe' });
  let output = '', errors = ''; child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { errors += bytes; });
  const closed = once(child, 'close');
  try {
    const result = await Promise.race([closed, delay(20000).then(() => undefined)]);
    expect(result, errors).toBeDefined();
    const review = await readReview(f.out, { persistArtifacts: false });
    expect(review.execution).toMatchObject({ status: 'completed', committed: true });
    expect(review.view?.round.source).toBe('agent');
    expect(result![0], errors).toBe(0);
    const value = JSON.parse(output);
    expect(value).toMatchObject({ verdict: 'qualified', cleanup: { confirmed: false, receiptPersisted: false } });
    expect(value.cleanup.detail).toContain('taskkill 退出码 1');
    expect(value.cleanup.detail).toContain('清理回执未保存');
    expect(value.cleanup.detail).toContain('[REDACTED]'); expect(output + errors).not.toContain('test-key');
    expect(errors).toContain('清理回执未保存'); expect(errors).not.toContain('告警见 cleanup.json');
    await expect(readFile(join(f.out, 'cleanup.json'))).rejects.toThrow();
  } finally { await terminate(child); await closed; }
}, 30000);
it.skipIf(process.platform !== 'win32')('taskkill 8 秒才确认时，已提交的成功轮次照常交回，不记清理告警', async () => {
  const run = await slowCleanup('slow-cleanup', '8000');
  try {
    const result = await Promise.race([run.closed, delay(40000).then(() => undefined)]);
    expect(result, run.errors()).toBeDefined(); expect(result![0], run.errors()).toBe(0);
    const output = JSON.parse(run.output());
    expect(output.verdict).toBe('qualified'); expect(output.cleanup).toBeUndefined();
    await expect(readFile(join(run.f.out, 'cleanup.json'))).rejects.toThrow();
  } finally { await terminate(run.child); await run.closed; }
}, 50000);
it.skipIf(process.platform !== 'win32')('taskkill 一直不返回时，成功轮次保留成果并记清理告警，命令有界退出', async () => {
  const run = await slowCleanup('hung-cleanup', 'hang'), started = Date.now();
  try {
    const result = await Promise.race([run.closed, delay(70000).then(() => undefined)]);
    expect(result, run.errors()).toBeDefined(); expect(result![0], run.errors()).toBe(0);
    expect(Date.now() - started).toBeLessThan(70000);
    const output = JSON.parse(run.output());
    expect(output).toMatchObject({ verdict: 'qualified', cleanup: { confirmed: false } });
    expect(run.errors()).toContain('本轮进程树清理未确认');
    const receipt = JSON.parse(await readFile(join(run.f.out, 'cleanup.json'), 'utf8'));
    expect(receipt).toMatchObject({ format: 'renderweave-cleanup/1', events: [{ after: 'result' }] });
    const review = await readReview(run.f.out);
    expect(review.execution).toMatchObject({ status: 'completed', committed: true });
    expect(review.execution?.diagnostics.join('\n')).toContain('本轮进程树清理未确认');
    expect(review.view?.round.source).toBe('agent');
  } finally { await terminate(run.child); await run.closed; }
}, 80000);

it('业务宿主被外部强退时明确诊断，不冒充已清理或完成', async () => {
  const f = await prepared('unexpected-host');
  f.args[f.args.indexOf('--claude-args') + 1] = JSON.stringify([join(repoRoot, 'test/support/budget-claude.mjs'), 'crash-host']);
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), ...f.args], { cwd: repoRoot, env: { ...process.env, RW_BUDGET_TEST_KEY: 'test-key' }, detached: process.platform !== 'win32', stdio: 'pipe' });
  const closed = once(child, 'close'); let errors = ''; child.stdout!.resume(); child.stderr!.on('data', value => { errors += value; });
  try {
    const result = await Promise.race([closed, delay(10000).then(() => undefined)]);
    expect(result, errors).toBeDefined(); expect(result![0]).toBe(1); expect(errors).toContain('后代可写性须按执行状态核对');
    const review = await readReview(f.out); expect(review.execution?.committed).toBe(false);
    expect(['pendingRecovery', 'interrupted']).toContain(review.execution?.status);
  } finally {
    const pids = JSON.parse(await readFile(join(f.out, 'agent/budget-processes.json'), 'utf8').catch(() => '{}'));
    for (const pid of [pids.child, pids.executor]) if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    await terminate(child); await closed;
  }
});
