/** 持久执行状态：从公开任务与审核入口观察等待、结束和强退，不调用状态机内部函数。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyAgentRound, changeReview, readPreviousRound, readReview, runAgentTask, type AgentRunOptions } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';

let base: string;
beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), 'rw-execution-'));
  await writeFile(join(base, 'brief.md'), '按图提取公交字段');
  await writeFile(join(base, 'executor.mjs'), `
    import { access, writeFile } from 'node:fs/promises';
    const [gate, started] = process.argv.slice(2);
    if (started === 'kill-host') { process.kill(process.ppid, 'SIGKILL'); process.exit(0); }
    if (started === 'exit-fast') process.exit(0);
    for await (const _ of process.stdin) {}
    await writeFile(started, String(process.pid));
    while (true) { try { await access(gate); break; } catch {} await new Promise(r => setTimeout(r, 15)); }
    console.log(JSON.stringify({type:'result',subtype:'success',num_turns:1}));
  `);
});

async function host(name: string, fault?: string) {
  const dir = join(base, name), gate = join(base, `${name}-gate`), started = join(base, `${name}-started`);
  const options: AgentRunOptions = { task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'),
    brief: join(base, 'brief.md'), resources: resourcesDir, out: dir, key: 'never-persist-this-credential', keyEnv: 'TEST_KEY',
    claude: { command: process.execPath, args: [join(base, 'executor.mjs'), gate,
      fault === 'kill-initialized' ? 'kill-host' : fault === 'delay-executing' ? 'exit-fast' : started] } };
  const file = join(base, `${name}.json`);
  await writeFile(file, JSON.stringify(options));
  const child = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'test/support/round-host.mjs'), file, fault ?? ''], { cwd: repoRoot, stdio: 'pipe', windowsHide: true });
  let errors = '';
  child.stderr.on('data', data => { errors += String(data); });
  const closed = once(child, 'close');
  return { child, closed, options, dir, gate, started, errors: () => errors };
}

it('初始化后强退宿主仍留固定输入，身份不能排除写入时拒绝接管', async () => {
  const job = await host('init-kill', 'kill-initialized');
  await job.closed;
  const result = await readReview(job.dir);
  expect(result.execution?.start?.inputs.sample.sha256, job.errors()).toMatch(/^[a-f0-9]{64}$/);
  expect(result.execution).toMatchObject({ committed: false });
  expect(['pendingRecovery', 'interrupted']).toContain(result.execution?.status);
  expect(result.view).toBeUndefined();
  const before = await readFile(join(job.dir, 'execution.json'));
  await expect(runAgentTask(job.options)).rejects.toThrow(/轮次目录|拥有者/);
  expect(await readFile(join(job.dir, 'execution.json'))).toEqual(before);
});

it('启动记录已发布而阶段更新尚未发布时强退，已保存的输入仍可读取', async () => {
  const job = await host('initial-publish-gap', 'block-initialized');
  try {
    await waitFor(join(job.dir, 'start-write-waiting'));
    job.child.kill('SIGKILL'); await job.closed;
    const result = await readReview(job.dir);
    expect(result.execution).toMatchObject({ phase: 'preparing', committed: false,
      start: { task: 'definition-extraction', inputs: { sample: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } } } });
    expect(result.view).toBeUndefined();
  } finally { job.child.kill('SIGKILL'); }
});

it('执行器立即退出且状态写入缓慢时，执行状态不倒退覆盖完成记录', async () => {
  const job = await host('quick-exit', 'delay-executing');
  await job.closed;
  expect((await readReview(job.dir)).execution, job.errors()).toMatchObject({ phase: 'completed', status: 'completed', committed: true });
});

it('宿主执行期间被强退：可读中断或待恢复状态，残留成果不可批准、应用或接续', async () => {
  const job = await host('active-kill');
  let pid: number | undefined;
  try {
    pid = Number(await waitFor(job.started));
    job.child.kill('SIGKILL'); await job.closed;
    const result = await readReview(job.dir);
    expect(result.execution).toMatchObject({ phase: 'executing', committed: false });
    expect(['pendingRecovery', 'interrupted']).toContain(result.execution?.status); // 有些宿主平台一并结束子进程。
    expect((await changeReview(job.dir, { type: 'approve' })).problems[0]?.message).toMatch(/尚未提交|残留/);
    expect((await applyAgentRound({ roundDir: job.dir })).problems[0]?.message).toMatch(/尚未提交|残留/);
    await expect(readPreviousRound(job.dir)).rejects.toThrow(/不能从残留候选接续/);
    const before = await readFile(join(job.dir, 'execution.json'));
    await expect(runAgentTask(job.options)).rejects.toThrow(/轮次目录|拥有者/);
    expect(await readFile(join(job.dir, 'execution.json'))).toEqual(before);
  } finally { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} job.child.kill('SIGKILL'); }
});

it('存活执行器或无法确认的跨机拥有者均保留待恢复，年龄不授权接管', async () => {
  const job = await host('uncertain-kill');
  let pid: number | undefined;
  try {
    pid = Number(await waitFor(job.started)); job.child.kill('SIGKILL'); await job.closed;
    // 旧轮次记录夹具：宿主已死，但执行器 PID 仍在本机存活；不需要也不会接管该进程。
    const state = JSON.parse(await readFile(join(job.dir, 'execution.json'), 'utf8'));
    state.executorPid = process.pid;
    state.owner.startedAt = '2000-01-01T00:00:00.000Z';
    await writeFile(join(job.dir, 'execution-owner.json'), JSON.stringify(state.owner));
    await writeFile(join(job.dir, 'execution.json'), JSON.stringify(state));
    expect((await readReview(job.dir)).execution?.status).toBe('pendingRecovery');
    await expect(runAgentTask(job.options)).rejects.toThrow(/轮次目录|拥有者/);
    state.owner.host = 'unreachable-host';
    await writeFile(join(job.dir, 'execution-owner.json'), JSON.stringify(state.owner));
    await writeFile(join(job.dir, 'execution.json'), JSON.stringify(state));
    expect((await readReview(job.dir)).execution?.status).toBe('pendingRecovery');
    await expect(runAgentTask(job.options)).rejects.toThrow(/轮次目录|拥有者/);
  } finally { if (pid) try { process.kill(pid, 'SIGKILL'); } catch {} job.child.kill('SIGKILL'); }
});

it('终检后最终记录提交被文件系统阻塞时强退，不将残留结果标成完成', async () => {
  const job = await host('final-kill', 'block-final');
  try {
    await waitFor(job.started); await writeFile(job.gate, 'finish');
    await waitFor(join(job.dir, 'final-write-waiting'));
    job.child.kill('SIGKILL'); await job.closed;
    const result = await readReview(job.dir);
    expect(result.execution).toMatchObject({ phase: 'finalizing', status: 'interrupted', committed: false });
    expect(result.execution?.events.at(-1)?.reason).toContain('成果检查已完成');
    expect(result.execution?.start?.inputs.sample.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.view).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('never-persist-this-credential');
  } finally { job.child.kill('SIGKILL'); }
});
afterAll(async () => { await rm(base, { recursive: true, force: true }); });

async function waitFor(file: string) {
  for (let i = 0; i < 400; i++) {
    try { return await readFile(file, 'utf8'); } catch { await new Promise(r => setTimeout(r, 15)); }
  }
  throw new Error(`没有等到 ${file}`);
}

it('执行器等待期间，审核入口可读固定输入和执行状态，结束不等于通过或批准', async () => {
  const dir = join(base, 'waiting'), gate = join(base, 'gate'), started = join(base, 'started');
  const running = runAgentTask({ task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'),
    brief: join(base, 'brief.md'), resources: resourcesDir, out: dir, key: 'must-not-be-recorded', keyEnv: 'TEST_KEY',
    claude: { command: process.execPath, args: [join(base, 'executor.mjs'), gate, started] } });
  try {
    await waitFor(started);
    const result = await readReview(dir);
    expect(result.execution).toMatchObject({ phase: 'executing', status: 'running', committed: false,
      start: { task: 'definition-extraction', inputs: { sample: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        files: { 'logs/prompt.md': expect.stringMatching(/^[a-f0-9]{64}$/), 'logs/provenance.json': expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(result.view).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('must-not-be-recorded');
  } finally { await writeFile(gate, 'finish'); await running; }
  const result = await readReview(dir);
  expect(result.execution).toMatchObject({ phase: 'completed', status: 'completed', committed: true });
  expect(result.execution?.events.map(event => event.phase)).toEqual(expect.arrayContaining(['preparing', 'executing', 'finalizing', 'completed']));
  expect(result.view).toBeUndefined(); // 没有候选，执行结束也不能审核。
});

it('agent review 能打开尚未交回成果的轮次状态页', async () => {
  const dir = join(base, 'status-page'), gate = join(base, 'page-gate'), started = join(base, 'page-started');
  const running = runAgentTask({ task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'),
    brief: join(base, 'brief.md'), resources: resourcesDir, out: dir, key: 'test', keyEnv: 'TEST_KEY',
    claude: { command: process.execPath, args: [join(base, 'executor.mjs'), gate, started] } });
  const controller = new AbortController();
  let response: Promise<Response> | undefined;
  try {
    await waitFor(started);
    const reviewing = runCli(['agent', 'review', dir, '--no-open'], {
      stdout: url => { response = fetch(`${url.trim()}api/review`); response.finally(() => controller.abort()); },
      stderr: () => {}, signal: controller.signal,
    });
    expect(await reviewing).toBe(0);
    expect(response).toBeDefined();
    const body = await (await response!).json() as { execution: unknown; view?: unknown };
    expect(body.execution).toMatchObject({ phase: 'executing', committed: false });
    expect(body.view).toBeUndefined();
  } finally { controller.abort(); await writeFile(gate, 'finish'); await running; }
});

async function finished(name: string, files: Record<string, unknown>, claude?: AgentRunOptions['claude']) {
  const preset = join(base, `${name}-preset`), out = join(base, name);
  await mkdir(preset, { recursive: true });
  for (const [file, value] of Object.entries(files)) {
    await mkdir(join(preset, file, '..'), { recursive: true });
    await writeFile(join(preset, file), typeof value === 'string' ? value : JSON.stringify(value));
  }
  return runAgentTask({ task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'),
    brief: join(base, 'brief.md'), resources: resourcesDir, out, key: 'test', keyEnv: 'TEST_KEY',
    claude: claude ?? { command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), preset] } });
}

it('执行器启动失败和轮数上限有明确的执行结论，不伪装成功', async () => {
  const failed = await finished('spawn-failed', {}, { command: join(base, 'no-such-executor') });
  expect((await readReview(failed.roundDir)).execution).toMatchObject({ phase: 'completed', status: 'failed', committed: true });
  const stopped = await finished('turns-stopped', { '.max-turns': '2' });
  const result = await readReview(stopped.roundDir);
  expect(result.execution).toMatchObject({ phase: 'completed', status: 'stopped', committed: true });
  expect(result.execution?.events.at(-1)?.reason).toContain('轮数上限');
});

const DEFINITION = { dslVersion: 'renderweave-schema/1', name: '线路', fields: [{ name: 'number', displayName: '线路号', type: 'text' }] };
const SUBMISSION = { candidates: ['candidates/route.json'], pending: [], notes: '示例线路号' };

it('执行完成保留技术与审核结论，宿主恢复草稿保持其来源且不能直接批准应用', async () => {
  const authored = await finished('authored', { 'outcome.json': SUBMISSION, 'candidates/route.json': DEFINITION });
  const result = await readReview(authored.roundDir);
  expect(result.execution).toMatchObject({ status: 'completed', committed: true });
  expect(result.view).toMatchObject({ round: { source: 'agent', verdict: 'qualified' }, review: { status: 'inProgress' }, canApprove: false });
  const recovered = await finished('recovered', { 'candidates/route.json': DEFINITION });
  const draft = await readReview(recovered.roundDir);
  expect(draft.execution).toMatchObject({ status: 'completed', committed: true });
  expect(draft.view).toMatchObject({ round: { source: 'hostRecovery' }, canApprove: false });
  expect((await changeReview(recovered.roundDir, { type: 'approve' })).problems.length).toBeGreaterThan(0);
  expect((await applyAgentRound({ roundDir: recovered.roundDir })).problems.length).toBeGreaterThan(0);
});

it('旧完整轮次保持可读及正常接续；格式损坏或关键身份缺失有定位诊断', async () => {
  const old = await finished('legacy', { 'outcome.json': SUBMISSION, 'candidates/route.json': DEFINITION });
  const record = { ...old.record };
  delete record.execution;
  for (const name of ['execution.json', 'execution-owner.json', 'round-start.json']) await rm(join(old.roundDir, name));
  await writeFile(join(old.roundDir, 'round.json'), JSON.stringify(record));
  const read = await readReview(old.roundDir);
  expect(read.view?.round.source).toBe('agent');
  expect(read.execution).toBeUndefined(); // 不替旧格式猜造执行事件。
  const feedback = join(base, 'legacy-feedback.md'); await writeFile(feedback, '保持已有字段');
  const next = await runAgentTask({ from: old.roundDir, feedback, out: join(base, 'legacy-next'), key: 'test', keyEnv: 'TEST_KEY',
    claude: { command: process.execPath, args: [join(repoRoot, 'test/support/fake-claude.mjs'), 'none'] } });
  expect(next.record.round).toBe(2);
  await writeFile(join(old.roundDir, 'round.json'), JSON.stringify({ ...record, format: 'broken' }));
  const malformed = await readReview(old.roundDir);
  expect(malformed.view).toBeUndefined();
  expect(malformed.problems[0]?.location).toMatchObject({ source: join(old.roundDir, 'round.json') });
  await writeFile(join(old.roundDir, 'round.json'), JSON.stringify({ ...record, inputs: { ...record.inputs, workspace: null } }));
  expect((await readReview(old.roundDir)).problems[0]?.location).toMatchObject({ source: join(old.roundDir, 'round.json') });
});

it('新状态的事件历史损坏时拒绝借用已存在成果，缺失启动身份也不回退为旧格式', async () => {
  const round = await finished('corrupt-state', { 'outcome.json': SUBMISSION, 'candidates/route.json': DEFINITION });
  const state = JSON.parse(await readFile(join(round.roundDir, 'execution.json'), 'utf8'));
  await writeFile(join(round.roundDir, 'execution.json'), JSON.stringify({ ...state, events: [] }));
  const badEvents = await readReview(round.roundDir);
  expect(badEvents.view).toBeUndefined();
  expect(badEvents.problems[0]?.location).toMatchObject({ source: join(round.roundDir, 'execution.json') });
  await writeFile(join(round.roundDir, 'execution.json'), JSON.stringify(state));
  const owner = await readFile(join(round.roundDir, 'execution-owner.json'));
  await rm(join(round.roundDir, 'execution-owner.json'));
  expect((await readReview(round.roundDir)).problems[0]?.location).toMatchObject({ source: join(round.roundDir, 'execution-owner.json') });
  await writeFile(join(round.roundDir, 'execution-owner.json'), owner);
  await rm(join(round.roundDir, 'round-start.json'));
  const missing = await readReview(round.roundDir);
  expect(missing.view).toBeUndefined();
  expect(missing.problems[0]?.location).toMatchObject({ source: join(round.roundDir, 'round-start.json') });
});

it('同一空轮次并发启动只有一个拥有者；状态更换期间记录始终是完整 JSON', async () => {
  const out = join(base, 'concurrent'), gate = join(base, 'concurrent-gate'), started = join(base, 'concurrent-started');
  const options: AgentRunOptions = { task: 'definition-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'),
    brief: join(base, 'brief.md'), resources: resourcesDir, out, key: 'test', keyEnv: 'TEST_KEY',
    claude: { command: process.execPath, args: [join(base, 'executor.mjs'), gate, started] } };
  const running = Promise.allSettled([runAgentTask(options), runAgentTask(options)]);
  await waitFor(started);
  const owner = await readFile(join(out, 'execution-owner.json'), 'utf8');
  await writeFile(gate, 'finish');
  for (let count = 0; count < 30; count++) {
    const state = JSON.parse(await readFile(join(out, 'execution.json'), 'utf8'));
    expect(state.owner.id).toBe(JSON.parse(owner).id);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const results = await running;
  expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((await readReview(out)).execution).toMatchObject({ status: 'completed', committed: true });
  expect(await readFile(join(out, 'execution-owner.json'), 'utf8')).toBe(owner);
});

it('最终记录丢失后显示待恢复诊断，不继续宣称可证完成', async () => {
  const round = await finished('missing-final', { 'outcome.json': SUBMISSION, 'candidates/route.json': DEFINITION });
  await rm(join(round.roundDir, 'round.json'));
  const result = await readReview(round.roundDir);
  expect(result.execution).toMatchObject({ status: 'pendingRecovery', committed: false });
  expect(result.view).toBeUndefined();
  expect(result.problems[0]?.location).toMatchObject({ source: join(round.roundDir, 'round.json') });
});
