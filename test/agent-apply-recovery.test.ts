import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyAgentRound, changeReview, initializeResourceStore, loadWorkspace, localResourceBackend, readReview, render, runAgentTask } from '../src/index.js';
import { copyWorkspaceFixture, greetingRequest, resourcesDir, singleTextDir } from './support/fixtures.js';

let base: string, sequence = 0;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-apply-recovery-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const fake = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
async function setup(count = 2, kind: 'definition' | 'dataset' | 'template' = 'definition', resources = resourcesDir) {
  const dir = join(base, String(++sequence)), workspace = join(dir, 'workspace'), preset = join(dir, 'preset');
  await copyWorkspaceFixture(singleTextDir, workspace);
  await mkdir(join(preset, 'candidates'), { recursive: true });
  const candidates: string[] = [];
  for (let i = 0; i < count; i++) {
    const path = `candidates/${kind === 'definition' ? 'schema' : kind}-recovery-${i}.json`; candidates.push(path);
    const template = { dslVersion: 'renderweave-template/1', name: `恢复模板${i}`, base: { name: '问候', version: 1 },
      artboard: { sizeRange: { width: { min: 20, max: 500 }, height: { min: 20, max: 200 } }, fill: '#FF0000', layout: { mode: 'free' },
        children: i === 0 ? Array.from({ length: count - 1 }, (_, j) => ({ type: 'call', name: `区${j}`, template: `恢复模板${j + 1}`, data: 'current',
          place: { left: (j % 8) * 20, top: Math.floor(j / 8) * 20, width: { fixed: 20 }, height: { fixed: 20 } } })) : [] } };
    if (kind === 'template') await writeFile(join(workspace, `template-recovery-${i}.json`), JSON.stringify({ ...template, artboard: { ...template.artboard, fill: '#0000FF' } }));
    await writeFile(join(preset, path), JSON.stringify(kind === 'definition'
      ? { dslVersion: 'renderweave-schema/1', name: `恢复定义${i}`, fields: [{ name: 'message', displayName: '文字', type: 'text' }] }
      : kind === 'template' ? template : { dataset: { id: `recovery-${i}`, name: `恢复数据${i}`, staticSchema: { name: '问候', version: 1 } }, data: { message: `恢复内容${i}` } }));
  }
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates, pending: [], notes: '恢复后定义版本唯一' }));
  await writeFile(join(dir, 'brief.md'), '提取数据定义');
  await writeFile(join(dir, 'request.json'), JSON.stringify(greetingRequest({ template: '恢复模板0' })));
  await writeFile(join(dir, 'requirement.md'), '将全部恢复模板的背景改为红色');
  const run = await runAgentTask({ task: kind === 'definition' ? 'definition-extraction' : kind === 'template' ? 'template-revision' : 'dataset-extraction', sample: join(resourcesDir, 'images/test/quadrants.png'), brief: join(dir, 'brief.md'),
    ...(kind === 'template' ? { request: join(dir, 'request.json'), requirement: join(dir, 'requirement.md') } : {}),
    ...(kind === 'dataset' ? { definition: '问候@1' } : {}), workspace, resources, out: join(dir, 'round'), key: 'test', keyEnv: 'TEST', claude: { command: process.execPath, args: [fake, preset] } });
  expect(run.check.verdict, JSON.stringify(run.check.problems)).toBe('qualified');
  expect((await changeReview(run.roundDir, { type: 'confirmRest', confirmed: true })).problems).toEqual([]);
  expect((await changeReview(run.roundDir, { type: 'approve' })).problems).toEqual([]);
  return { dir, workspace, round: run.roundDir, count, kind };
}
async function documents(dir: string) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort();
  return Promise.all(files.map(async f => [f, (await readFile(join(dir, f))).toString('base64')]));
}

it('同一成功应用的重试返回已有结果，数据定义不发布第二个版本，另一个目标仍被拒绝', async () => {
  const f = await setup(), first = await applyAgentRound({ roundDir: f.round });
  expect(first.problems).toEqual([]); expect(first.applied?.published.map(p => p.version)).toEqual([1, 1]);
  const before = await documents(f.workspace);
  const retry = await applyAgentRound({ roundDir: f.round, overwrite: true });
  expect(retry.problems).toEqual([]); expect(retry.applied).toEqual(first.applied);
  expect(retry.reused).toBe(true);
  expect(await documents(f.workspace)).toEqual(before);
  expect((await applyAgentRound({ roundDir: f.round, workspace: singleTextDir })).applied).toBeUndefined();
});

async function killDuringApply(f: Awaited<ReturnType<typeof setup>>) {
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/bin.ts', import.meta.url)), 'agent', 'apply', f.round], { windowsHide: true });
  let killed = false, output = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const watcher = watch(f.workspace, (_, name) => { if (!killed && name?.startsWith(`${f.kind === 'definition' ? 'schema' : f.kind}-recovery-`) && name.endsWith('.json')) { killed = child.kill('SIGKILL'); } });
  try { await new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); }); }
  finally { watcher.close(); }
  expect(killed, output).toBe(true);
}

it('公开 CLI 多文件提交中真实强退后，读取恢复全部定义和结果，正式出图一致且重试唯一', async () => {
  const f = await setup(20);
  const original = await render(await loadWorkspace({ dir: f.workspace, resourcesDir }), greetingRequest());
  await killDuringApply(f);
  const partial = (await readdir(f.workspace)).filter(name => /^(schema|compiled)-recovery-/.test(name));
  expect(partial.length).toBeGreaterThan(0); expect(partial.length).toBeLessThan(40);
  const loaded = await loadWorkspace({ dir: f.workspace, resourcesDir });
  expect(loaded.problems).toEqual([]);
  expect(loaded.staticSchemas.filter(s => s.ref.name.startsWith('恢复定义')).map(s => s.ref.version)).toEqual(Array(20).fill(1));
  const view = await readReview(f.round); expect(view.problems).toEqual([]); expect(view.view?.applied?.published).toHaveLength(20);
  const retry = await applyAgentRound({ roundDir: f.round }); expect(retry.applied).toEqual(view.view!.applied); expect(retry.problems).toEqual([]);
  const output = await render(loaded, greetingRequest()); expect(output.problems).toEqual(original.problems); expect(output.image).toEqual(original.image);
}, 30000);

it('恢复发现外部第三种内容时公开读取、审核、应用都列出冲突并保留修改，冲突解除后收敛', async () => {
  const f = await setup(20); await killDuringApply(f);
  const changed = join(f.workspace, (await readdir(f.workspace)).find(name => name.startsWith('schema-recovery-'))!);
  const original = await readFile(changed), external = '{"external":"用户在强退后写入"}';
  await writeFile(changed, external);
  const load = await loadWorkspace({ dir: f.workspace, resourcesDir });
  expect(load.problems.some(p => p.code === 'apply.recoveryRequired' && p.message.includes(basename(changed)))).toBe(true); expect(load.staticSchemas).toHaveLength(0);
  const review = await readReview(f.round); expect(review.problems.some(p => p.code === 'apply.recoveryRequired')).toBe(true); expect(review.view).toBeUndefined();
  const retry = await applyAgentRound({ roundDir: f.round, overwrite: true }); expect(retry.problems.some(p => p.code === 'apply.recoveryRequired')).toBe(true);
  expect(await readFile(changed, 'utf8')).toBe(external);
  await writeFile(changed, original);
  expect((await applyAgentRound({ roundDir: f.round })).applied?.published).toHaveLength(20);
}, 30000);

it('两个恢复者与重复应用并发时结果唯一，重复读取不会再次提交', async () => {
  const f = await setup(20); await killDuringApply(f);
  const results = await Promise.all([applyAgentRound({ roundDir: f.round }), applyAgentRound({ roundDir: f.round }), readReview(f.round)]);
  expect(results.every(result => result.problems.length === 0)).toBe(true);
  expect(results[0]!.applied).toEqual(results[1]!.applied);
  expect(results[2]!.view!.applied).toEqual(results[0]!.applied);
  const before = await documents(f.workspace);
  expect((await applyAgentRound({ roundDir: f.round })).applied).toEqual(results[0]!.applied);
  expect(await documents(f.workspace)).toEqual(before);
}, 30000);

it('新成功记录缺少可核对的提交凭据时不能被当作已成功，旧成功记录仍只按已有事实读取', async () => {
  const f = await setup(), result = await applyAgentRound({ roundDir: f.round });
  const record = result.applied!;
  await writeFile(join(f.round, 'applied.json'), JSON.stringify({ ...record, commitId: '不存在的提交' }));
  expect((await applyAgentRound({ roundDir: f.round })).applied).toBeUndefined();
  const { commitId, ...old } = record;
  await writeFile(join(f.round, 'applied.json'), JSON.stringify({ ...old, format: 'renderweave-applied/1' }));
  const before = await documents(f.workspace);
  expect((await readReview(f.round)).view?.applied?.format).toBe('renderweave-applied/1');
  expect((await applyAgentRound({ roundDir: f.round })).applied?.format).toBe('renderweave-applied/1');
  expect(await documents(f.workspace)).toEqual(before);
});

it('数据集多文件提交真实强退后恢复完整候选并能正式渲染', async () => {
  const f = await setup(20, 'dataset'); await killDuringApply(f);
  const loaded = await loadWorkspace({ dir: f.workspace, resourcesDir });
  expect(loaded.problems).toEqual([]);
  expect(loaded.datasets.filter(data => data.id.startsWith('recovery-'))).toHaveLength(20);
  const rendered = await render(loaded, greetingRequest({ dataset: { id: 'recovery-0' } }));
  expect(rendered.image).toBeDefined(); expect(rendered.problems).toEqual([]);
  expect((await applyAgentRound({ roundDir: f.round })).applied?.published).toHaveLength(20);
}, 30000);

it('整体资源提交仍持有边界时终止应用宿主，业务提交尚未开始，读取仍是旧状态', async () => {
  const store = join(base, 'precommit-resources'); expect((await initializeResourceStore(store)).problems).toEqual([]);
  const f = await setup(2, 'definition', store), before = await documents(f.workspace);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const writing = localResourceBackend(store).commit([], { beforeCommit: async () => { entered(); await gate; } }); await ready;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./support/apply-response.mjs', import.meta.url)), f.round, 'before'], { windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', () => { child.kill('SIGKILL'); }); child.once('close', () => resolve()); });
    expect(await documents(f.workspace)).toEqual(before);
  } finally { release(); await writing; }
  expect((await readReview(f.round)).view?.applied).toBeUndefined();
  expect((await applyAgentRound({ roundDir: f.round })).applied).toBeDefined();
});

it('成功提交后回应尚未送达就强退，重试返回持久结果且不增加定义版本', async () => {
  const f = await setup();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./support/apply-response.mjs', import.meta.url)), f.round, 'after'], { windowsHide: true });
  let signal = '';
  await new Promise<void>((resolve, reject) => { child.once('error', reject); child.stdout.once('data', bytes => { signal += bytes; child.kill('SIGKILL'); }); child.once('close', () => resolve()); });
  expect(signal).toContain('committed');
  const before = await documents(f.workspace), recorded = JSON.parse(await readFile(join(f.round, 'applied.json'), 'utf8'));
  expect((await applyAgentRound({ roundDir: f.round })).applied).toEqual(recorded); expect(await documents(f.workspace)).toEqual(before);
});

it('复制另一轮的成功凭据不能把当前未应用轮次误认为已提交', async () => {
  const a = await setup(), b = await setup();
  const result = await applyAgentRound({ roundDir: a.round });
  await cp(join(a.round, '.apply-transactions'), join(b.round, '.apply-transactions'), { recursive: true });
  await cp(join(a.round, 'applied.json'), join(b.round, 'applied.json'));
  const retry = await applyAgentRound({ roundDir: b.round, workspace: result.applied!.workspace });
  expect(retry.applied).toBeUndefined(); expect(retry.problems.some(p => p.message.includes('属于另一轮次'))).toBe(true);
});

it('模板工作副本替换中强退后恢复所有模板，正式出图就是核准的新图', async () => {
  const f = await setup(16, 'template'), request = greetingRequest({ template: '恢复模板0' });
  const workspace = await loadWorkspace({ dir: f.workspace, resourcesDir }), approved = (await readReview(f.round)).view!;
  const before = await render(workspace, request);
  const expected = await render({ ...workspace, templates: workspace.templates.map(entry => ({ ...entry,
    document: approved.candidates.find(candidate => candidate.name === entry.name)?.document ?? entry.document })) }, request);
  await killDuringApply(f);
  const loaded = await loadWorkspace({ dir: f.workspace, resourcesDir }); expect(loaded.problems).toEqual([]);
  const after = await render(loaded, request); expect(after.image).toBeDefined(); expect(after.image).not.toEqual(before.image);
  const applied = await applyAgentRound({ roundDir: f.round }); expect(applied.problems).toEqual([]);
  expect(applied.applied?.published).toHaveLength(16); expect(applied.applied?.published.every(item => item.replaced)).toBe(true);
  for (let i = 0; i < 16; i++) expect(JSON.parse(await readFile(join(f.workspace, `template-recovery-${i}.json`), 'utf8')).artboard.fill).toBe('#FF0000');
  expect(after.image).toEqual(expected.image);
}, 30000);

it('恢复宿主再次强退后两个 CLI 恢复者仍收敛于一个成功提交', async () => {
  const f = await setup(30); await killDuringApply(f); await killDuringApply(f);
  const invoke = () => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/bin.ts', import.meta.url)), 'agent', 'apply', f.round], { windowsHide: true });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', code => resolve({ code, output }));
  });
  const [a, b] = await Promise.all([invoke(), invoke()]);
  expect(a.code, a.output).toBe(0); expect(b.code, b.output).toBe(0);
  expect(JSON.parse(a.output).commitId).toBe(JSON.parse(b.output).commitId);
  expect((await applyAgentRound({ roundDir: f.round })).applied?.published).toHaveLength(30);
}, 30000);

it('旧版无拥有者空锁保守阻断，人工确认并解除后才继续', async () => {
  const f = await setup(); await mkdir(join(f.workspace, '.write-lock'));
  try { expect((await loadWorkspace({ dir: f.workspace, resourcesDir })).problems.some(p => p.code === 'local.storeBusy')).toBe(true); }
  finally { await rm(join(f.workspace, '.write-lock'), { recursive: true }); }
  expect((await applyAgentRound({ roundDir: f.round })).applied).toBeDefined();
});
