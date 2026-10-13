import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { applyResourceReplacement, checkResourceReplacement, deliverBatch, importResources, initializeResourceStore, loadWorkspace,
  openVersionedResourceStore, readOutputRecord, render, replayOutputRecord, type VersionedResourceStore, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { greetingRequest, loadSingleText, m402Dir, resourcesDir, singleTextDir } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string, resources: string, store: VersionedResourceStore, m402: Workspace, greeting: Workspace, single: Record<string, any>;
let sequence = 0;
const target = () => join(root, `batch-${++sequence}`);
const pad = (index: number) => String(index).padStart(4, '0');
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** M402 本站渲染项；降到 30 DPI 只为缩短测试，本站高亮与末站规则与 DPI 无关。 */
const stop = (current: number, id = `m402-${String(current).padStart(2, '0')}`, output: Record<string, unknown> = {}): Record<string, any> =>
  ({ id, dataset: single.dataset, parameters: { currentIndex: current }, output: { ...single.output, dpi: 30, ...output } });
const m402Batch = (items: unknown[]) => ({ template: single.template, mode: 'final', items });
const direct = (workspace: Workspace, item: Record<string, any>) =>
  render(workspace, { template: single.template, mode: 'final', dataset: item.dataset, parameters: item.parameters, output: item.output });
const greetingBatch = (ids: string[], outputs: Record<number, unknown> = {}) => {
  const { template, mode, ...item } = greetingRequest();
  return { template, mode, items: ids.map((id, i) => ({ id, ...item, ...(outputs[i] ? { output: outputs[i] } : {}) })) };
};
/** 目录内全部文件的相对路径与哈希，用来证明旧成果一字未改。 */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); files[relative(dir, path)] = hash(await fs.readFile(path)); }
  }
  return files;
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-batch-'));
  resources = join(root, 'resources');
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: resources })).problems).toEqual([]);
  store = (await openVersionedResourceStore(resources)).store!;
  m402 = await loadWorkspace({ dir: m402Dir, resourcesDir: resources });
  greeting = await loadSingleText();
  single = await json(join(m402Dir, 'render-request-m402.json'));
});
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-batch-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('显式列出 M402 本站 1–35：全部交付，结果与进度按输入顺序，每项与单次渲染一致', async () => {
  const items = Array.from({ length: 35 }, (_, i) => stop(i + 1));
  const progress: [number, number, string][] = [];
  const out = target();
  const result = await deliverBatch({ workspace: m402, resources: store, request: m402Batch(items), outDir: out,
    onItem: (item, { completed, total }) => { progress.push([completed, total, item.id]); } });
  expect(result.problems).toEqual([]);
  expect(result.summary).toMatchObject({ previewed: 0, total: 35, delivered: 35, failed: 0, notRun: 0 });
  expect(progress).toEqual(items.map((item, i) => [i + 1, 35, item.id]));
  const images = new Set<string>();
  for (const [i, item] of result.items.entries()) {
    expect(item).toMatchObject({ index: i + 1, id: items[i]!.id, status: 'delivered', directory: join(out, pad(i + 1)), severe: 0,
      files: { image: 'image.png', problems: 'problems.json', layout: 'layout.json', record: 'record.json' } });
    const expected = await direct(m402, items[i]!), bytes = await fs.readFile(join(item.directory!, 'image.png'));
    expect(hash(bytes)).toBe(hash(expected.image!.bytes));
    expect(await json(join(item.directory!, 'layout.json'))).toEqual(expected.layout);
    expect(await json(join(item.directory!, 'problems.json'))).toEqual(expected.problems);
    images.add(hash(bytes));
  }
  expect(images.size).toBe(35); // 每项高亮各自的本站
  const manifest = await json(join(out, 'batch.json'));
  expect(manifest).toMatchObject({ format: 'renderweave-batch/1', template: single.template, mode: 'final', summary: result.summary, problems: [] });
  expect(manifest.build).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(manifest.items.map((e: any) => [e.index, e.id, e.status, e.directory])).toEqual(items.map((item, i) => [i + 1, item.id, 'delivered', pad(i + 1)]));
  expect(JSON.stringify(result)).not.toContain('"bytes"');
  expect((await readOutputRecord({ dir: join(out, '0035') })).record?.itemId).toBe('m402-35');
  expect((await replayOutputRecord({ dir: join(out, '0035'), outDir: target() })).replayed).toBeDefined();
}, 240_000);

it('合法项之间夹入本站 36、错误数据版本、超大尺寸与缺失数据集：只有这些项失败；失败项另组新批次不覆盖旧成果', async () => {
  const wrongVersion = { ...stop(2, 'wrong-version'), dataset: { inline: { dataset: { staticSchema: { name: '线路牌', version: 2 } }, data: {} } } };
  const items = [stop(1), stop(36, 'stop-36'), stop(2), wrongVersion, stop(3), stop(4, 'too-large', { width: 5000, dpi: 120 }),
    { ...stop(5, 'no-dataset'), dataset: { id: 'ds-missing' } }, stop(35)];
  const out = target();
  const result = await deliverBatch({ workspace: m402, resources: store, request: m402Batch(items), outDir: out });
  expect(result.problems).toEqual([]);
  expect(result.items.map((i) => [i.index, i.id, i.status])).toEqual([[1, 'm402-01', 'delivered'], [2, 'stop-36', 'failed'], [3, 'm402-02', 'delivered'],
    [4, 'wrong-version', 'failed'], [5, 'm402-03', 'delivered'], [6, 'too-large', 'failed'], [7, 'no-dataset', 'failed'], [8, 'm402-35', 'delivered']]);
  expect(result.summary).toMatchObject({ previewed: 0, total: 8, delivered: 4, failed: 4, notRun: 0 });
  const codes = (id: string) => result.items.find((i) => i.id === id)!.problems.map((p) => p.code);
  expect(codes('stop-36')).toContain('check.failed');
  expect(codes('wrong-version')).toEqual(['record.invalid']);
  expect(codes('too-large')).toContain('request.outputTooLarge');
  expect(codes('no-dataset')).toEqual(['record.invalid']);
  for (const [i, item] of result.items.entries()) {
    expect(item.directory).toBe(join(out, pad(i + 1)));
    if (item.status === 'delivered') {
      expect(hash(await fs.readFile(join(item.directory!, 'image.png')))).toBe(hash((await direct(m402, items[i]!)).image!.bytes));
      continue;
    }
    expect(item.severe).toBeGreaterThan(0);
    expect(await json(join(item.directory!, 'problems.json'))).toEqual(item.problems);
    await expect(fs.stat(join(item.directory!, 'record.json'))).rejects.toThrow();
    await expect(fs.stat(join(item.directory!, 'image.png'))).rejects.toThrow();
  }

  const before = await snapshot(out);
  const retry = await deliverBatch({ workspace: m402, resources: store, request: m402Batch([stop(4, 'too-large'), stop(5, 'no-dataset')]), outDir: target() });
  expect(retry.summary).toMatchObject({ previewed: 0, total: 2, delivered: 2, failed: 0, notRun: 0 });
  const again = await deliverBatch({ workspace: m402, resources: store, request: m402Batch([stop(4, 'too-large')]), outDir: out });
  expect(again.directory).toBeUndefined(); expect(again.problems[0]?.code).toBe('delivery.writeFailed');
  expect(await snapshot(out)).toEqual(before);
}, 120_000);

it.each([
  ['根模板不存在', (request: any) => ({ ...request, template: '不存在的模板' })],
  ['渲染项不是对象', (request: any) => ({ ...request, items: [...request.items, 'item'] })],
] as const)('%s：执行前整批拒绝，不建目录、不出成功项', async (_name, change) => {
  const out = target();
  const result = await deliverBatch({ workspace: m402, resources: store, request: change(m402Batch([stop(1)])), outDir: out });
  expect(result.directory).toBeUndefined(); expect(result).toMatchObject({ items: [], summary: { total: 0, delivered: 0, previewed: 0, failed: 0, notRun: 0, severe: 0, hints: 0 } });
  expect(result.problems[0]?.level).toBe('severe');
  await expect(fs.stat(out)).rejects.toThrow();
});
it('工作区有严重读取问题时整批拒绝', async () => {
  const broken = { ...m402, problems: [...m402.problems, { code: 'input.unreadable' as const, level: 'severe' as const, location: { kind: 'input' as const, source: 'x.json' }, message: '坏文件' }] };
  const result = await deliverBatch({ workspace: broken, resources: store, request: m402Batch([stop(1)]), outDir: target() });
  expect(result.directory).toBeUndefined();
});

it('启动时固定文档、渲染项与资源版本：运行中替换资源、改写输入都不混入本批，下一批才用新内容', async () => {
  const dir = join(root, 'live-resources');
  expect((await initializeResourceStore(dir)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir })).problems).toEqual([]);
  // 模拟能看到最新版本的仓库：每次替换后重新打开，get 返回当时的当前版本。
  let live = (await openVersionedResourceStore(dir)).store!;
  const liveStore: VersionedResourceStore = { list: () => live.list(), get: (id, version) => live.get(id, version), read: (id, version) => live.read(id, version), pin: (versions) => live.pin(versions) };
  const workspace: Workspace = { ...m402, templates: m402.templates.map((t) => ({ ...t, document: structuredClone(t.document) })) };
  const items = [stop(1), stop(2), stop(3)], request = m402Batch(items.map((item) => structuredClone(item)));
  const expected = await Promise.all(items.map((item) => direct(m402, item)));
  const replacement = join(resourcesDir, 'images/test/quadrants.png');
  let replaced = false;
  const result = await deliverBatch({ workspace, resources: liveStore, request, outDir: target(), onItem: async () => {
    if (replaced) return;
    replaced = true;
    const check = await checkResourceReplacement({ dir, workspaceDir: m402Dir, id: 'route-no-m402', kind: 'image', file: replacement });
    expect((await applyResourceReplacement({ dir, workspaceDir: m402Dir, file: replacement, check: check.check })).replaced?.version).toBe(2);
    live = (await openVersionedResourceStore(dir)).store!;
    expect(liveStore.get('route-no-m402')?.version).toBe(2);
    for (const template of workspace.templates) (template.document as any).artboard.fill = '#FF0000';
    (request.items[1] as any).parameters.currentIndex = 30;
  } });
  expect(result.summary.delivered).toBe(3);
  for (const [i, item] of result.items.entries()) {
    expect(hash(await fs.readFile(join(item.directory!, 'image.png')))).toBe(hash(expected[i]!.image!.bytes));
    const record = (await readOutputRecord({ dir: item.directory! })).record!;
    expect(record.resources.find((r) => r.id === 'route-no-m402')).toMatchObject({ state: 'available', version: 1 });
  }
  const next = await deliverBatch({ workspace: m402, resources: liveStore, request: m402Batch([stop(1)]), outDir: target() });
  expect(next.items[0]?.status).toBe('delivered');
  expect((await readOutputRecord({ dir: next.items[0]!.directory! })).record!.resources.find((r) => r.id === 'route-no-m402')).toMatchObject({ version: 2 });
  expect(hash(await fs.readFile(join(next.items[0]!.directory!, 'image.png')))).not.toBe(hash(expected[0]!.image!.bytes));
}, 120_000);

it('项标识只作数据；单项写入失败而存储仍可写时继续交付其他项', async () => {
  const out = target();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(out, '0002', 'image.png')) throw new Error('injected disk error');
    return original(...args);
  });
  const result = await deliverBatch({ workspace: greeting, resources: store, request: greetingBatch(['../../a', 'CON', 'x/y:z']), outDir: out });
  expect(result.items.map((i) => [i.id, i.status])).toEqual([['../../a', 'delivered'], ['CON', 'failed'], ['x/y:z', 'delivered']]);
  expect(result.items[1]!.directory).toBeUndefined(); expect(result.items[1]!.reason).toContain('injected disk error');
  expect(result.items[1]!.problems.map((p) => p.code)).toContain('delivery.writeFailed');
  expect(result.problems).toEqual([]);
  expect((await fs.readdir(out)).sort()).toEqual(['0001', '0002', '0003', 'batch.json']);
  expect((await json(join(out, 'batch.json'))).summary).toMatchObject({ previewed: 0, total: 3, delivered: 2, failed: 1, notRun: 0 });
  expect((await readOutputRecord({ dir: join(out, '0002') })).record).toBeUndefined();
  expect((await readOutputRecord({ dir: join(out, '0003') })).record?.itemId).toBe('x/y:z');
});
it('写入失败后探测到批次目录不可写即停止，后续项标为未执行', async () => {
  const out = target();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const path = String(args[0]);
    if (path.startsWith(out) && !path.startsWith(join(out, '0001'))) throw new Error('injected storage loss');
    return original(...args);
  });
  const progress: string[] = [];
  const result = await deliverBatch({ workspace: greeting, resources: store, request: greetingBatch(['a', 'b', 'c', 'd']), outDir: out,
    onItem: (item) => { progress.push(item.status); } });
  expect(result.items.map((i) => i.status)).toEqual(['delivered', 'failed', 'notRun', 'notRun']);
  expect(progress).toEqual(['delivered', 'failed', 'notRun', 'notRun']);
  expect(result.summary).toMatchObject({ previewed: 0, total: 4, delivered: 1, failed: 1, notRun: 2 });
  expect(result.items[2]!.problems.map((p) => p.code)).toEqual(['delivery.notRun']);
  expect(result.items[3]!.reason).toContain('停止调度');
  // 汇总清单同样写不出去：批次问题如实说明，不虚报完整交付。
  expect(result.problems.map((p) => p.code)).toEqual(['delivery.storageUnavailable', 'delivery.writeFailed']);
  expect((await readOutputRecord({ dir: join(out, '0001') })).record?.itemId).toBe('a');
});
it('进度回调抛错时停止调度，已交付项保留，汇总照常发布', async () => {
  const out = target();
  const result = await deliverBatch({ workspace: greeting, resources: store, request: greetingBatch(['a', 'b', 'c']), outDir: out,
    onItem: () => { throw new Error('consumer gone'); } });
  expect(result.items.map((i) => i.status)).toEqual(['delivered', 'notRun', 'notRun']);
  expect(result.problems.map((p) => p.code)).toEqual(['delivery.stopped']);
  expect((await json(join(out, 'batch.json'))).summary).toMatchObject({ previewed: 0, total: 3, delivered: 1, failed: 0, notRun: 2 });
});

it('CLI：逐项进度写标准错误流，汇总写标准输出；全部成功 0，部分失败或目标已存在 1，请求读取错误 2', async () => {
  const request = join(root, 'cli-batch.json'), out = target(), stdout: string[] = [], stderr: string[] = [];
  const io = { stdout: (text: string) => { stdout.push(text); }, stderr: (text: string) => { stderr.push(text); } };
  const args = (file: string, dir: string) => ['deliver', '--workspace', singleTextDir, '--resources', resources, '--request', file, '--out', dir];
  await fs.writeFile(request, JSON.stringify(greetingBatch(['a', 'b'])));
  expect(await runCli(args(request, out), io)).toBe(0);
  expect(stderr.join('')).toMatch(/\[1\/2\] a：已交付[\s\S]*\[2\/2\] b：已交付/);
  expect(JSON.parse(stdout.join(''))).toEqual({ directory: out, manifest: 'batch.json', mode: 'final', summary: { total: 2, delivered: 2, previewed: 0, failed: 0, notRun: 0, severe: 0, hints: 0 } });
  expect(await runCli(args(request, out), io)).toBe(1);

  const { output } = greetingRequest() as { output: Record<string, unknown> };
  await fs.writeFile(request, JSON.stringify(greetingBatch(['ok', 'huge'], { 1: { ...output, width: 5000 } })));
  stderr.length = 0; stdout.length = 0;
  expect(await runCli(args(request, target()), io)).toBe(1);
  expect(stderr.join('')).toMatch(/\[2\/2\] huge：失败[\s\S]*request\.outputTooLarge/);
  expect(JSON.parse(stdout.join('')).summary).toMatchObject({ previewed: 0, total: 2, delivered: 1, failed: 1, notRun: 0 });

  await fs.writeFile(request, '{');
  expect(await runCli(args(request, target()), io)).toBe(2);
});
