import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyAgentRound, applyResourceReplacement, changeReview, checkResourceReplacement, importResources, initializeResourceStore, loadWorkspace, readReview, render, runAgentTask, localResourceBackend } from '../src/index.js';
import { copyWorkspaceFixture, resourcesDir, singleTextDir } from './support/fixtures.js';


const fake = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
const controlled = fileURLToPath(new URL('./support/controlled-claude.mjs', import.meta.url));
async function cli(args: string[]) {
  return new Promise<{ code: number | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url)), fileURLToPath(new URL('../src/bin.ts', import.meta.url)), ...args], { windowsHide: true });
    let text = ''; child.stdout.on('data', bytes => { text += bytes; }); child.stderr.on('data', bytes => { text += bytes; });
    child.on('error', reject); child.on('close', code => resolve({ code, text }));
  });
}
let base: string, sequence = 0;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-concurrent-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const request = { template: '固定图片', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 80, height: 40, dpi: 50, format: 'png' }, mode: 'final' };
const template = { dslVersion: 'renderweave-template/1', name: '固定图片', base: { name: '问候', version: 1 }, artboard: {
  sizeRange: { width: { min: 20, max: 100 }, height: { min: 20, max: 100 } }, layout: { mode: 'free' }, children: [
    { type: 'image', name: '图', source: 'res:picture', fit: 'fill', place: { left: 0, top: 0, width: { fixed: 80 }, height: { fixed: 40 } } },
  ],
} };
async function setup(versioned = true, candidate: unknown = template, additions: Record<string, { kind: 'image' | 'font'; path?: string; text?: string }> = {}) {
  const dir = join(base, String(++sequence)), source = join(dir, 'source'), workspace = join(dir, 'workspace'), resources = join(dir, 'resources');
  await mkdir(source, { recursive: true });
  await copyWorkspaceFixture(singleTextDir, workspace);
  await cp(join(resourcesDir, 'images/test/quadrants.png'), join(source, 'picture.png'));
  const manifest = [{ id: 'picture', kind: 'image', file: 'picture.png' }];
  for (const [id, resource] of Object.entries(additions)) {
    const file = `${id}.bin`; manifest.push({ id, kind: resource.kind, file });
    if (resource.path) await cp(resource.path, join(source, file)); else await writeFile(join(source, file), resource.text!);
  }
  await writeFile(join(source, 'resources.json'), JSON.stringify({ resources: manifest }));
  if (versioned) {
    expect((await initializeResourceStore(resources)).problems).toEqual([]);
    expect((await importResources({ sourceDir: source, dir: resources })).problems).toEqual([]);
  }
  await writeFile(join(dir, 'brief.md'), '图片应按核准资源出图');
  await writeFile(join(dir, 'request.json'), JSON.stringify(request));
  const preset = join(dir, 'preset'); await mkdir(join(preset, 'candidates'), { recursive: true });
  await writeFile(join(preset, 'candidates/template-picture.json'), JSON.stringify(candidate));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/template-picture.json'], pending: [], notes: '按给定图片设计' }));
  const run = await runAgentTask({ task: 'template-design', sample: join(source, 'picture.png'), brief: join(dir, 'brief.md'), workspace,
    resources: versioned ? resources : source, dataset: 'ds-greeting', request: join(dir, 'request.json'), out: join(dir, 'round'), key: 'test', keyEnv: 'TEST',
    claude: { command: process.execPath, args: [fake, preset] } });
  expect(run.check.verdict).toBe('qualified');
  return { dir, source, workspace, resources: versioned ? resources : source, run, round: run.roundDir };
}
async function approve(round: string) {
  expect((await changeReview(round, { type: 'confirmRest', confirmed: true })).problems).toEqual([]);
  const result = await changeReview(round, { type: 'approve' }); expect(result.problems).toEqual([]); return result.view!;
}

it('资源写入未完成时，应用与公开读取明确冲突；释放后完整应用', async () => {
  const f = await setup(); await approve(f.round);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const backend = localResourceBackend(f.resources);
  const writing = backend.commit([], { beforeCommit: async () => { entered(); await gate; } });
  await ready;
  try {
    const result = await applyAgentRound({ roundDir: f.round, overwrite: true });
    expect(result.applied).toBeUndefined();
    expect(result.problems.some(p => p.code === 'local.storeBusy')).toBe(true);
    const reading = await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources });
    expect(reading.problems.some(p => p.code === 'local.storeBusy')).toBe(true);
    const processResult = await cli(['agent', 'apply', f.round, '--overwrite']);
    expect(processResult.code).toBe(1); expect(processResult.text).toContain('local.storeBusy');
    expect(await readFile(join(f.workspace, 'template-picture.json')).then(() => true, () => false)).toBe(false);
  } finally { release(); }
  expect((await writing).problems).toEqual([]);
  expect((await applyAgentRound({ roundDir: f.round })).applied).toBeDefined();
});

it('模型仍在等待时资源替换能完成，交回的本轮仍使用启动前固定依据', async () => {
  const f = await setup();
  const ready = join(f.dir, 'model-ready'), release = join(f.dir, 'model-release');
  let settled = false;
  const pending = runAgentTask({ task: 'template-design', sample: join(f.source, 'picture.png'), brief: join(f.dir, 'brief.md'), workspace: f.workspace,
    resources: f.resources, dataset: 'ds-greeting', request: join(f.dir, 'request.json'), out: join(f.dir, 'slow-round'), key: 'test', keyEnv: 'TEST',
    claude: { command: process.execPath, args: [controlled, ready, release, join(f.dir, 'preset')] } }).finally(() => { settled = true; });
  try {
    const deadline = Date.now() + 10000;
    while (!await readFile(ready).then(() => true, () => false)) { if (Date.now() > deadline) throw new Error('假执行器未开始'); await delay(20); }
    const file = join(resourcesDir, 'images/test/quadrants.jpg');
    const checked = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, id: 'picture', kind: 'image' });
    expect((await applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, check: checked.check })).replaced?.version).toBe(2);
    expect(settled).toBe(false);
  } finally { await writeFile(release, 'continue'); }
  const completed = await pending;
  expect(completed.check.verdict).toBe('qualified');
  expect(completed.check.contentIdentity!.resources.find(item => item.id === 'picture')!.version).toBe(1);
  expect((await readReview(completed.roundDir)).view!.canApprove).toBe(false);
});

it.each(['picture', 'unused'])('资源%s替换与应用重复并发遵守一致先后，释放后合法对照仍成功', async id => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const f = await setup(true, template, { unused: { kind: 'image', path: join(resourcesDir, 'images/test/quadrants.png') } });
    const approved = await approve(f.round), file = join(resourcesDir, 'images/test/quadrants.jpg');
    const checked = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, id, kind: 'image' });
    const [applied, replaced] = await Promise.all([applyAgentRound({ roundDir: f.round, overwrite: true }),
      applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, check: checked.check })]);
    expect(!!applied.applied || !!replaced.replaced).toBe(true);
    if (applied.applied) expect(applied.applied.contentIdentity).toBe(approved.contentIdentity!.id);
    else {
      expect(applied.problems.every(p => ['local.storeBusy', 'apply.resourcesChanged', 'apply.concurrentChange'].includes(p.code))).toBe(true);
      expect((await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources })).templates.some(item => item.name === template.name)).toBe(false);
      const retry = await applyAgentRound({ roundDir: f.round, overwrite: true });
      if (id === 'unused' || !replaced.replaced) expect(retry.applied).toBeDefined();
      else expect(retry.problems.some(p => p.code === 'apply.resourcesChanged')).toBe(true);
    }
    if (!replaced.replaced) {
      expect(replaced.problems.every(p => ['resource.storeBusy', 'resource.replacementStale'].includes(p.code))).toBe(true);
      const fresh = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, id, kind: 'image' });
      expect((await applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, check: fresh.check })).replaced).toBeDefined();
    }
  }
});

it.each(['read', 'apply'])('多份候选提交时并发%s取得完整集合或明确冲突', async mode => {
  const f = await setup(); await approve(f.round);
  const preset = join(f.dir, 'other-preset'); await mkdir(join(preset, 'candidates'), { recursive: true });
  const names = Array.from({ length: 12 }, (_, index) => `other-${index}`);
  for (const name of names) await writeFile(join(preset, 'candidates', `${name}.json`), JSON.stringify({ ...template, name }));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: names.map(name => `candidates/${name}.json`), pending: [], notes: '成套图片模板' }));
  await writeFile(join(f.dir, 'other-request.json'), JSON.stringify({ ...request, template: names[0] }));
  const other = await runAgentTask({ task: 'template-design', sample: join(f.source, 'picture.png'), brief: join(f.dir, 'brief.md'), workspace: f.workspace,
    resources: f.resources, dataset: 'ds-greeting', request: join(f.dir, 'other-request.json'), out: join(f.dir, 'other-round'), key: 'test', keyEnv: 'TEST',
    claude: { command: process.execPath, args: [fake, preset] } });
  expect(other.check).toMatchObject({ verdict: 'qualified', problems: [] }); await approve(other.roundDir);
  if (mode === 'read') {
  let observe!: () => void;
  const observed = new Promise<void>(resolve => { observe = resolve; });
  let reading: ReturnType<typeof loadWorkspace> | undefined;
  const watcher = watch(f.workspace, (_, file) => {
    if (file?.startsWith('template-other-') && !reading) {
      reading = loadWorkspace({ dir: f.workspace, resourcesDir: f.resources }); observe();
    }
  });
  // 先让多文档提交完成，文件出现是公开输出；同步读取不能消费空文件或半套模板。
  const submitted = await applyAgentRound({ roundDir: other.roundDir });
  expect(submitted.applied).toBeDefined();
  await observed; watcher.close();
  const during = await reading!;
  if (!during.problems.some(p => p.code === 'local.storeBusy')) {
    expect(during.problems).toEqual([]);
    expect([0, names.length]).toContain(during.templates.filter(item => names.includes(item.name)).length);
  }
  const after = await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources });
  expect(after.templates.filter(item => names.includes(item.name))).toHaveLength(names.length);
  expect((await readReview(other.roundDir)).view?.applied).toBeDefined();
  return;
  }
  const results = await Promise.all([applyAgentRound({ roundDir: f.round }), applyAgentRound({ roundDir: other.roundDir })]);
  expect(results.filter(result => result.applied)).toHaveLength(1);
  expect(results.find(result => !result.applied)!.problems.some(p => ['local.storeBusy', 'apply.concurrentChange', 'apply.workspaceChanged'].includes(p.code)), JSON.stringify(results)).toBe(true);
  const actual = await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources });
  expect(actual.problems).toEqual([]);
  expect(actual.templates.filter(item => names.includes(item.name)).length).toBe(results[1]!.applied ? names.length : 0);
  expect(actual.templates.some(item => item.name === template.name)).toBe(!!results[0]!.applied);
});

it.each([true, false])('加载后计算只用不可变资源副本（版本仓库=%s），后续读取能看到更新', async versioned => {
  const f = await setup(versioned); await approve(f.round); await applyAgentRound({ roundDir: f.round });
  const saved = await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources });
  const before = await render(saved, request); expect(before.image).toBeDefined();
  const replacement = join(resourcesDir, 'images/test/quadrants.jpg');
  if (versioned) {
    const checked = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file: replacement, id: 'picture', kind: 'image' });
    expect((await applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file: replacement, check: checked.check })).replaced).toBeDefined();
  } else await cp(replacement, join(f.source, 'picture.png'));
  expect((await render(saved, request)).image!.bytes).toEqual(before.image!.bytes);
  expect((await render(await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources }), request)).image!.bytes).not.toEqual(before.image!.bytes);
});

it('耗时渲染等待资源时不占写锁，合法替换可先结束，旧计算保持原字节', async () => {
  const f = await setup(); const approved = await approve(f.round); await applyAgentRound({ roundDir: f.round });
  const workspace = await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources });
  const original = await render(workspace, request);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const slow = render({ ...workspace, resources: { ...workspace.resources, async read(id) { entered(); await gate; return workspace.resources.read(id); } } }, request);
  await ready;
  try {
    const file = join(resourcesDir, 'images/test/quadrants.jpg');
    const checked = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, id: 'picture', kind: 'image' });
    expect((await applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, check: checked.check })).replaced?.version).toBe(2);
    expect((await json(join(f.round, 'applied.json'))).contentIdentity).toBe(approved.contentIdentity!.id);
  } finally { release(); }
  expect((await slow).image!.bytes).toEqual(original.image!.bytes);
});
