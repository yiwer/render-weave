import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applyAgentRound, applyResourceReplacement, changeReview, checkResourceReplacement, importResources, initializeResourceStore, loadWorkspace, readReview, render, runAgentTask } from '../src/index.js';
import { copyWorkspaceFixture, resourcesDir, singleTextDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

const fake = fileURLToPath(new URL('./support/fake-claude.mjs', import.meta.url));
let base: string, sequence = 0;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-resource-identity-')); });
afterAll(async () => { await rm(base, { recursive: true, force: true }); });
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const request = { template: '固定图片', dataset: { id: 'ds-greeting' }, parameters: {}, output: { width: 80, height: 40, dpi: 50, format: 'png' }, mode: 'final' };
const template = { dslVersion: 'renderweave-template/1', name: '固定图片', base: { name: '问候', version: 1 }, artboard: {
  sizeRange: { width: { min: 20, max: 100 }, height: { min: 20, max: 100 } }, layout: { mode: 'free' }, children: [
    { type: 'image', name: '图', source: 'res:picture', fit: 'fill', place: { left: 0, top: 0, width: { fixed: 80 }, height: { fixed: 40 } } },
  ],
} };
async function setup(versioned = true, candidate: unknown = template, additions: Record<string, { kind: 'image' | 'font'; path?: string; text?: string }> = {},
  runtime: Pick<Parameters<typeof runAgentTask>[0], 'model' | 'effort'> = {}) {
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
    ...runtime, claude: { command: process.execPath, args: [fake, preset] } });
  expect(run.check.verdict).toBe('qualified');
  return { dir, source, workspace, resources: versioned ? resources : source, run, round: run.roundDir };
}
async function approve(round: string) {
  expect((await changeReview(round, { type: 'confirmRest', confirmed: true })).problems).toEqual([]);
  const result = await changeReview(round, { type: 'approve' }); expect(result.problems).toEqual([]); return result.view!;
}

it('审核后替换相关图片：旧图可复查，覆盖不能应用，重新核准后采用新图', async () => {
  const fixture = await setup();
  const before = await approve(fixture.round);
  const originalPreview = await readFile(join(fixture.round, before.preview!.image!));
  const replacement = join(resourcesDir, 'images/test/quadrants.jpg');
  const checked = await checkResourceReplacement({ dir: fixture.resources, workspaceDir: fixture.workspace, file: replacement, id: 'picture', kind: 'image' });
  expect((await applyResourceReplacement({ dir: fixture.resources, workspaceDir: fixture.workspace, file: replacement, check: checked.check })).problems).toEqual([]);
  await rm(join(fixture.round, before.preview!.image!));
  const read = (await readReview(fixture.round)).view!;
  expect(read.preview?.image).toBe(before.preview?.image);
  expect(await readFile(join(fixture.round, read.preview!.image!))).toEqual(originalPreview);
  expect(read.canApprove).toBe(false);
  expect((await applyAgentRound({ roundDir: fixture.round, overwrite: true })).problems.map(p => p.code)).toContain('apply.resourcesChanged');
  const reopened = await changeReview(fixture.round, { type: 'reopen' });
  expect(reopened.problems).toEqual([]);
  expect(reopened.view?.preview?.image).not.toBe(before.preview?.image);
  expect(reopened.view?.review.restConfirmed).toBe(false);
  await approve(fixture.round);
  expect((await applyAgentRound({ roundDir: fixture.round })).problems).toEqual([]);
});

it('已有候选的内容身份不包含模型配置，记录指向核准内容与应用依据', async () => {
  const f = await setup(false);
  const other = await setup(false, template, {}, { model: 'another-model', effort: 'high' });
  expect(other.run.record.runtime.model).not.toBe(f.run.record.runtime.model);
  expect(other.run.check.contentIdentity!.id).toBe(f.run.check.contentIdentity!.id);
  const view = await approve(other.round);
  expect(view.review.contentIdentity!.id).toBe(view.contentIdentity!.id);
  expect(view.contentIdentity).toMatchObject({ format: 'renderweave-content-identity/1', criteria: 'authoring-check/1', engine: expect.stringMatching(/^sha256:/),
    resources: [{ id: 'picture', kind: 'image', sha256: expect.stringMatching(/^[a-f0-9]{64}$/), file: 'picture.png' }] });
  const result = await applyAgentRound({ roundDir: other.round });
  expect(result.applied!.contentIdentity).toBe(view.contentIdentity!.id);
});

it('候选文件不变但提交清单新增待确认项时，MCP返回新检查身份', async () => {
  const f = await setup(false), config = await json(join(f.round, 'logs/mcp.json'));
  const session = startMcp(config.mcpServers.rw.args.slice(2));
  try {
    const first = await session.callJson('check_outcome');
    expect(first.contentIdentity.id).toBe(f.run.check.contentIdentity!.id);
    const submission = await json(join(f.round, 'agent/outcome.json'));
    submission.pending.push({ file: 'candidates/template-picture.json', path: '固定图片/图', reason: 'inferred', note: '资源对应关系需要确认' });
    await writeFile(join(f.round, 'agent/outcome.json'), JSON.stringify(submission));
    const next = await session.callJson('check_outcome');
    expect(next.verdict).toBe('qualified');
    expect(next.contentIdentity.id).not.toBe(first.contentIdentity.id);
  } finally { await session.close(); }
});

const textTemplate = (font: string, text: string) => ({ ...template, artboard: { ...template.artboard, children: [
  { type: 'text', name: '文字', font: `res:${font}`, content: [{ text }], fontSize: 10, color: '#000000',
    place: { left: 0, top: 0, width: { fixed: 80 }, height: { fixed: 40 } } },
] } });

it.each([true, false])('版本仓库=%s：直接字体、后备字体、SVG字体的相关更新均废弃批准，未使用资源允许应用', async (versioned) => {
  for (const kind of ['direct', 'fallback', 'svg'] as const) {
    const id = kind === 'direct' ? 'direct' : 'font-hei-regular';
    const additions: Parameters<typeof setup>[2] = {
      [id]: { kind: 'font', path: join(resourcesDir, 'fonts/SourceHanSansCN-Regular.otf') },
      unused: { kind: 'image', path: join(resourcesDir, 'images/test/quadrants.png') },
      ...(kind === 'fallback' ? { subset: { kind: 'font' as const, path: join(resourcesDir, 'font-subsets/TestSubset-Regular.otf') } } : {}),
      ...(kind === 'svg' ? { svg: { kind: 'image' as const, text: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><text x="5" y="70" font-size="50">深圳</text></svg>' } } : {}),
    };
    const candidate = kind === 'svg' ? { ...template, artboard: { ...template.artboard, children: [{ ...template.artboard.children[0], source: 'res:svg' }] } }
      : textTemplate(kind === 'direct' ? id : 'subset', 'A深田圳B');
    const f = await setup(versioned, candidate, additions);
    const before = await approve(f.round);
    expect(before.contentIdentity!.resources.map(resource => resource.id)).toContain(id);
    expect(f.run.check.contentIdentity!.resources.map(resource => resource.id)).toContain(id);
    const replace = async (resourceId: string, file: string, resourceKind: 'image' | 'font') => {
      if (!versioned) await cp(file, join(f.source, `${resourceId}.bin`));
      else {
        const checked = await checkResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, id: resourceId, kind: resourceKind });
        expect(checked.problems).toEqual([]);
        expect((await applyResourceReplacement({ dir: f.resources, workspaceDir: f.workspace, file, check: checked.check })).problems).toEqual([]);
      }
    };
    await replace('unused', join(resourcesDir, 'images/test/quadrants.jpg'), 'image');
    await writeFile(join(f.resources, 'unrelated.txt'), '不影响出图');
    expect((await readReview(f.round)).view!.canApprove).toBe(true);
    await replace(id, join(resourcesDir, 'fonts/SourceHanSansCN-Bold.otf'), 'font');
    const changed = await applyAgentRound({ roundDir: f.round, overwrite: true });
    expect(changed.problems.some(p => p.code === 'apply.resourcesChanged' && p.message.includes(id))).toBe(true);
    const old = (await readReview(f.round)).view!;
    expect(await readFile(join(f.round, old.preview!.image!))).toEqual(await readFile(join(f.round, before.preview!.image!)));
    expect((await changeReview(f.round, { type: 'reopen' })).problems).toEqual([]);
    const after = await approve(f.round);
    expect(after.contentIdentity!.id).not.toBe(before.contentIdentity!.id);
    expect(after.preview!.image).not.toBe(before.preview!.image);
    expect((await applyAgentRound({ roundDir: f.round })).problems).toEqual([]);
    const first = await render(await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources }), request);
    expect(first.image).toBeDefined();
    // 应用以后继续采用活资源引用；本轮固定没有永久改变模板中的 res: 引用。
    await replace(id, join(resourcesDir, 'fonts/SourceHanSansCN-Heavy.otf'), 'font');
    const later = await render(await loadWorkspace({ dir: f.workspace, resourcesDir: f.resources }), request);
    expect(later.image).toBeDefined(); expect(later.image!.bytes).not.toEqual(first.image!.bytes);
  }
});

it('旧目录图片字节、清单映射和种类变化均拒绝旧批准；无关文件与未使用资源允许应用', async () => {
  for (const mutation of ['bytes', 'mapping', 'kind', 'unrelated'] as const) {
    const f = await setup(false, template, { unused: { kind: 'image', path: join(resourcesDir, 'images/test/quadrants.png') } });
    await approve(f.round);
    if (mutation === 'bytes') await cp(join(resourcesDir, 'images/test/quadrants.jpg'), join(f.source, 'picture.png'));
    if (mutation === 'mapping' || mutation === 'kind') {
      const manifest = await json(join(f.source, 'resources.json'));
      if (mutation === 'mapping') { await cp(join(f.source, 'picture.png'), join(f.source, 'other.png')); manifest.resources[0].file = 'other.png'; }
      else manifest.resources[0].kind = 'font';
      await writeFile(join(f.source, 'resources.json'), JSON.stringify(manifest));
    }
    if (mutation === 'unrelated') {
      await writeFile(join(f.source, 'note.txt'), '无关文件');
      await cp(join(resourcesDir, 'images/test/quadrants.jpg'), join(f.source, 'unused.bin'));
    }
    const result = await applyAgentRound({ roundDir: f.round, overwrite: true });
    expect(result.problems.some(p => p.code === 'apply.resourcesChanged')).toBe(mutation !== 'unrelated');
    expect(!!result.applied).toBe(mutation === 'unrelated');
  }
});

it('历史轮次没有资源身份时保留旧事实，当前重新检查与核准后才能应用', async () => {
  const f = await setup(false); await approve(f.round);
  const oldRound = await json(join(f.round, 'round.json')), oldReview = await json(join(f.round, 'review.json'));
  delete oldRound.inputs.resourceSnapshot; delete oldReview.contentIdentity; delete oldRound.execution;
  for (const name of ['execution.json', 'execution-owner.json', 'round-start.json']) await rm(join(f.round, name));
  const roundBytes = JSON.stringify(oldRound), reviewBytes = JSON.stringify(oldReview);
  await writeFile(join(f.round, 'round.json'), roundBytes); await writeFile(join(f.round, 'review.json'), reviewBytes);
  expect((await readReview(f.round)).view!.problems.some(p => p.message.includes('历史轮次'))).toBe(true);
  expect((await applyAgentRound({ roundDir: f.round })).problems.some(p => p.message.includes('历史批准'))).toBe(true);
  expect(await readFile(join(f.round, 'round.json'), 'utf8')).toBe(roundBytes);
  expect(await readFile(join(f.round, 'review.json'), 'utf8')).toBe(reviewBytes);
  expect((await changeReview(f.round, { type: 'reopen' })).problems).toEqual([]);
  await approve(f.round);
  expect((await applyAgentRound({ roundDir: f.round })).problems).toEqual([]);
  expect(await readFile(join(f.round, 'round.json'), 'utf8')).toBe(roundBytes);
});

it.each(['pinned-corrupt', 'pinned-missing', 'source-corrupt', 'source-missing'] as const)('%s：相关资源无法核对时拒绝，已有缓存不能遮住损坏', async (failure) => {
  const f = await setup(); const approved = await approve(f.round);
  const oldImage = await readFile(join(f.round, approved.preview!.image!));
  const oldCheck = await readFile(join(f.round, 'checks', `${approved.contentIdentity!.id}.json`));
  const manifest = await json(join(f.resources, 'resources.json'));
  const resourceFile = failure.startsWith('pinned') ? join(f.round, f.run.record.inputs.resourceSnapshot!.directory, 'picture.bin')
    : join(f.resources, manifest.resources[0].versions[0].file);
  if (failure.endsWith('missing')) await rm(resourceFile); else await writeFile(resourceFile, '损坏');
  const view = (await readReview(f.round)).view!;
  expect(await readFile(join(f.round, approved.preview!.image!))).toEqual(oldImage);
  expect(await readFile(join(f.round, 'checks', `${approved.contentIdentity!.id}.json`))).toEqual(oldCheck);
  expect(view.canApprove).toBe(false);
  expect([...view.problems, ...(view.preview?.problems ?? [])].some(p => p.message.includes('picture'))).toBe(true);
  const result = await applyAgentRound({ roundDir: f.round, overwrite: true });
  expect(result.applied).toBeUndefined(); expect(result.problems.length).toBeGreaterThan(0);
  expect(approved.preview?.image).toBeDefined();
});

it('核准后示例图、快照文档或同名请求被改，拒绝旧身份；不把缓存当成新输入证据', async () => {
  for (const part of ['sample', 'workspace', 'request'] as const) {
    const f = await setup(false); await approve(f.round);
    const path = part === 'sample' ? join(f.round, f.run.record.inputs.sample.file) : part === 'workspace' ? join(f.round, 'snapshot/dataset-greeting.json') : join(f.round, 'request.json');
    if (part === 'sample') await cp(join(resourcesDir, 'images/test/quadrants.jpg'), path);
    else if (part === 'request') await writeFile(path, JSON.stringify({ ...request, output: { ...request.output, width: 90 } }));
    else await writeFile(path, (await readFile(path, 'utf8')).replace('欢迎乘坐 M402 路', '内容已变'));
    const result = await applyAgentRound({ roundDir: f.round });
    expect(result.applied).toBeUndefined();
    expect(result.problems.some(p => p.message.includes('已改变') || p.message.includes('身份'))).toBe(true);
  }
});
