import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deliverBatch, importResources, initializeResourceStore, loadWorkspace, openVersionedResourceStore, readOutputRecord, render,
  type VersionedResourceStore, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';

let root: string, resources: string, store: VersionedResourceStore, m402: Workspace, single: Record<string, any>, dataset: Record<string, any>;
let sequence = 0;
const target = () => join(root, `batch-${++sequence}`);
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stop = (current: number, id = `m402-${String(current).padStart(2, '0')}`): Record<string, any> =>
  ({ id, dataset: single.dataset, parameters: { currentIndex: current }, output: { ...single.output, dpi: 30 } });
const batchOf = (mode: string, items: unknown[]) => ({ template: single.template, mode, items });
const direct = (mode: 'draft' | 'final', item: Record<string, any>) =>
  render(m402, { template: single.template, mode, dataset: item.dataset, parameters: item.parameters, output: item.output });
/** 三类草稿项：合法、有严重问题但可展开（本站 36、第 2 站缺站名）、无法展开（数据集选错定义）。 */
const mixed = () => {
  const data = structuredClone(dataset.data);
  delete data.stops[1].name;
  return [stop(3), stop(36, 'stop-36'), { ...stop(4, 'no-stop-name'), dataset: { inline: { ...dataset, data } } },
    { ...stop(5, 'wrong-schema'), dataset: { inline: { dataset: { staticSchema: { name: '停靠站点', version: 1 } }, data: {} } } }];
};

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-draft-'));
  resources = join(root, 'resources');
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: resources })).problems).toEqual([]);
  store = (await openVersionedResourceStore(resources)).store!;
  m402 = await loadWorkspace({ dir: m402Dir, resourcesDir: resources });
  single = await json(join(m402Dir, 'render-request-m402.json'));
  dataset = await json(join(m402Dir, 'dataset-m402.json'));
});
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-draft-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('同一批输入分别以草稿和正式运行：三类项逐项明确，公共诊断一致；草稿保留预览但不生成出图记录', async () => {
  const items = mixed();
  const draft = await deliverBatch({ workspace: m402, resources: store, request: batchOf('draft', items), outDir: target() });
  const final = await deliverBatch({ workspace: m402, resources: store, request: batchOf('final', items), outDir: target() });
  expect([draft.mode, final.mode]).toEqual(['draft', 'final']);
  expect(draft.items.map((i) => [i.id, i.status])).toEqual([['m402-03', 'previewed'], ['stop-36', 'previewed'], ['no-stop-name', 'previewed'], ['wrong-schema', 'failed']]);
  expect(final.items.map((i) => i.status)).toEqual(['delivered', 'failed', 'failed', 'failed']);
  for (const [i, item] of draft.items.entries()) expect(item.problems).toEqual(final.items[i]!.problems);
  const codes = (index: number) => draft.items[index]!.problems.map((p) => p.code);
  expect(codes(0)).toEqual([]);
  expect(codes(1)).toContain('check.failed');
  expect(codes(2)).toContain('dataset.requiredMissing');
  expect(codes(3)).toContain('render.expansionBlocked');

  for (const [i, item] of draft.items.slice(0, 3).entries()) {
    expect(item.files).toEqual({ image: 'draft.png', problems: 'problems.json', layout: 'layout.json', preview: 'preview.json' });
    const expected = await direct('draft', items[i]!), bytes = await fs.readFile(join(item.directory!, 'draft.png'));
    expect(hash(bytes)).toBe(hash(expected.image!.bytes));
    expect(await json(join(item.directory!, 'layout.json'))).toEqual(expected.layout);
    expect(await json(join(item.directory!, 'problems.json'))).toEqual(expected.problems);
    const preview = await json(join(item.directory!, 'preview.json'));
    expect(preview).toMatchObject({ format: 'renderweave-preview/1', mode: 'draft', itemId: item.id, build: expect.stringMatching(/^sha256:/) });
    for (const file of preview.files) expect(hash(await fs.readFile(join(item.directory!, file.file)))).toBe(file.sha256);
    expect((await fs.readdir(item.directory!)).sort()).toEqual(['draft.png', 'layout.json', 'preview.json', 'problems.json']);
    expect((await readOutputRecord({ dir: item.directory! })).record).toBeUndefined();
  }
  // 草稿摘要是实际显示的占位布局；同一项的正式结果没有图片，只留真实内容布局与问题清单。
  expect(await fs.readFile(join(draft.items[2]!.directory!, 'layout.json'), 'utf8')).toContain('"placeholder": true');
  expect(final.items[2]!.files).toEqual({ problems: 'problems.json', layout: 'layout.json' });
  expect(draft.items[3]!.files).toEqual({ problems: 'problems.json' });

  const severe = draft.items.reduce((sum, item) => sum + item.severe, 0);
  expect(severe).toBeGreaterThan(0);
  expect(draft.summary).toMatchObject({ total: 4, delivered: 0, previewed: 3, failed: 1, notRun: 0, severe });
  const manifest = await json(join(draft.directory!, 'batch.json'));
  expect(manifest).toMatchObject({ format: 'renderweave-batch/1', mode: 'draft', summary: draft.summary });
  expect(manifest.items[1]).toMatchObject({ id: 'stop-36', status: 'previewed', directory: '0002', files: { image: 'draft.png', preview: 'preview.json' } });
}, 120_000);

it('模式只能在批次上统一指定：渲染项带 mode 或批次模式不合法都整批拒绝；草稿同样不覆盖已有目标', async () => {
  for (const request of [batchOf('draft', [{ ...stop(1), mode: 'final' }]), batchOf('preview', [stop(1)])]) {
    const out = target(), result = await deliverBatch({ workspace: m402, resources: store, request, outDir: out });
    expect(result.directory).toBeUndefined(); expect(result.problems[0]?.code).toBe('request.invalid');
    await expect(fs.stat(out)).rejects.toThrow();
  }
  const out = target();
  expect((await deliverBatch({ workspace: m402, resources: store, request: batchOf('draft', [stop(1)]), outDir: out })).summary.previewed).toBe(1);
  const before = await fs.readFile(join(out, 'batch.json'));
  expect((await deliverBatch({ workspace: m402, resources: store, request: batchOf('draft', [stop(2)]), outDir: out })).directory).toBeUndefined();
  expect(await fs.readFile(join(out, 'batch.json'))).toEqual(before);
});

it('CLI 草稿：全部预览完整返回 0 但汇总与提示保留严重问题；有无法展开项返回 1', async () => {
  const request = join(root, 'draft-request.json'), stdout: string[] = [], stderr: string[] = [];
  const io = { stdout: (text: string) => { stdout.push(text); }, stderr: (text: string) => { stderr.push(text); } };
  const args = (dir: string) => ['deliver', '--workspace', m402Dir, '--resources', resources, '--request', request, '--out', dir];
  await fs.writeFile(request, JSON.stringify(batchOf('draft', mixed().slice(0, 3))));
  expect(await runCli(args(target()), io)).toBe(0);
  const printed = JSON.parse(stdout.join(''));
  expect(printed).toMatchObject({ mode: 'draft', summary: { total: 3, previewed: 3, delivered: 0, failed: 0 } });
  expect(printed.summary.severe).toBeGreaterThan(0);
  expect(stderr.join('')).toMatch(/\[2\/3\] stop-36：已预览[\s\S]*check\.failed[\s\S]*草稿预览含严重问题 \d+ 个，不是可交付成品/);

  await fs.writeFile(request, JSON.stringify(batchOf('draft', mixed())));
  stdout.length = 0; stderr.length = 0;
  expect(await runCli(args(target()), io)).toBe(1);
  expect(JSON.parse(stdout.join('')).summary).toMatchObject({ total: 4, previewed: 3, failed: 1 });
  expect(stderr.join('')).toMatch(/\[4\/4\] wrong-schema：失败[\s\S]*render\.expansionBlocked/);
}, 120_000);
