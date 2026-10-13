import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { deliverBatch, importResources, initializeResourceStore, openVersionedResourceStore, readBatch, readOutputRecord, replayOutputRecord,
  type BatchReading, type VersionedResourceStore, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { greetingRequest, loadSingleText, resourcesDir, singleTextDir } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

let root: string, resources: string, store: VersionedResourceStore, greeting: Workspace;
let sequence = 0;
const target = () => join(root, `batch-${++sequence}`);
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
/** 问候牌文字都在主字体内，不配后备字体：每条记录少复制约 25 MB，减少测试写盘。 */
const lean = { fallbackFonts: [], svgFonts: [] };
const batch = (ids: string[], mode = 'final') => {
  const { template, mode: _mode, ...item } = greetingRequest();
  return { template, mode, items: ids.map((id) => ({ id, ...item })) };
};
const codes = (problems: readonly { code: string }[]) => problems.map((p) => p.code);
const unfinished = (reading: BatchReading | undefined) => {
  expect(reading?.state).toBe('unfinished');
  return (reading as Extract<BatchReading, { state: 'unfinished' }>).items.map((item) => [item.index, item.status, item.id]);
};
/** 让指定发布点的 link 失败：磁盘状态与进程在该点被强退相同，内容已写完而完成清单没有发布。 */
async function failLinks(...targets: string[]) {
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).link;
  vi.mocked(fs.link).mockImplementation(async (from, to) => {
    if (targets.includes(String(to))) throw new Error('injected crash before publish');
    return original(from, to);
  });
}

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-cancel-'));
  resources = join(root, 'resources');
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: resources })).problems).toEqual([]);
  store = (await openVersionedResourceStore(resources)).store!;
  greeting = await loadSingleText();
});
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-cancel-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('开始前或固定输入期间已取消：不建目录，不执行任何项', async () => {
  const before = new AbortController(), out = target();
  before.abort();
  const early = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a']), outDir: out, signal: before.signal });
  expect(early).toMatchObject({ items: [], summary: { total: 0 } });
  expect(early.directory).toBeUndefined(); expect(codes(early.problems)).toEqual(['delivery.cancelled']);
  await expect(fs.stat(out)).rejects.toThrow();

  // 在读取固定资源字节时取消：仍在准备阶段，同样不建目录。
  const during = new AbortController();
  const reading: VersionedResourceStore = { list: () => store.list(), get: (id, version) => store.get(id, version), pin: (versions) => store.pin(versions),
    read: (id, version) => { during.abort(); return store.read(id, version); } };
  const frozen = await deliverBatch({ workspace: greeting, resources: reading, renderOptions: lean, request: batch(['a']), outDir: out, signal: during.signal });
  expect(frozen.directory).toBeUndefined(); expect(codes(frozen.problems)).toEqual(['delivery.cancelled']);
  await expect(fs.stat(out)).rejects.toThrow();
});

it('两项之间取消：已交付项保留，其余未执行，batch.json 照常发布并说明已取消', async () => {
  const controller = new AbortController(), out = target(), progress: string[] = [];
  const result = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b', 'c', 'd']), outDir: out, signal: controller.signal,
    onItem: (item) => { progress.push(`${item.id}:${item.status}`); if (item.id === 'b') controller.abort(); } });
  expect(result.items.map((i) => i.status)).toEqual(['delivered', 'delivered', 'notRun', 'notRun']);
  expect(progress).toEqual(['a:delivered', 'b:delivered', 'c:notRun', 'd:notRun']);
  expect(codes(result.problems)).toEqual(['delivery.cancelled']);
  expect(result.items[2]!.reason).toContain('已取消');
  expect(codes(result.items[3]!.problems)).toEqual(['delivery.notRun']);
  const manifest = await json(join(out, 'batch.json'));
  expect(manifest.summary).toMatchObject({ total: 4, delivered: 2, notRun: 2 });
  expect(codes(manifest.problems)).toEqual(['delivery.cancelled']);
  expect((await fs.readdir(out)).sort()).toEqual(['0001', '0002', 'batch.json']);
  expect((await readOutputRecord({ dir: join(out, '0002') })).record?.itemId).toBe('b');
  const read = await readBatch({ dir: out });
  expect(read.problems).toEqual([]);
  expect(read.batch).toMatchObject({ state: 'finished', directory: out, manifest: { summary: { delivered: 2, notRun: 2 } } });
});

it('当前项执行中取消：本项完成并提交后才停止，不中断正在写入的成果', async () => {
  const controller = new AbortController(), out = target();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(out, '0002', 'image.png')) controller.abort();
    return original(...args);
  });
  const result = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b', 'c']), outDir: out, signal: controller.signal });
  expect(result.items.map((i) => i.status)).toEqual(['delivered', 'delivered', 'notRun']);
  expect((await readOutputRecord({ dir: join(out, '0002') })).problems).toEqual([]);
});

it('取消请求到达时已没有待执行项：批次照常完成，不报取消', async () => {
  const controller = new AbortController();
  const result = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b']), outDir: target(), signal: controller.signal,
    onItem: (item) => { if (item.id === 'b') controller.abort(); } });
  expect(result.problems).toEqual([]);
  expect(result.summary).toMatchObject({ total: 2, delivered: 2, notRun: 0 });
});

it('batch.json 未发布：按各项完成清单辨认，已完成项可读取和重放，未完成项不读成成功', async () => {
  const out = target();
  await failLinks(join(out, '0002', 'record.json'), join(out, 'batch.json'));
  const result = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b', 'c']), outDir: out });
  expect(codes(result.problems)).toEqual(['delivery.writeFailed']);
  // 第 2 项内容文件已写完，只是没有完成清单。
  expect((await fs.readdir(join(out, '0002'))).sort()).toContain('image.png');
  const read = await readBatch({ dir: out });
  expect(read.problems).toEqual([]);
  expect(unfinished(read.batch)).toEqual([[1, 'delivered', 'a'], [2, 'incomplete', undefined], [3, 'delivered', 'c']]);
  expect((read.batch as any).items[0].directory).toBe(join(out, '0001'));
  expect(codes((await readOutputRecord({ dir: join(out, '0002') })).problems)).toEqual(['record.invalid']);
  expect((await replayOutputRecord({ dir: join(out, '0003'), outDir: target() })).replayed).toBeDefined();
});

it('草稿批次同样按 preview.json 辨认未完成运行', async () => {
  const out = target();
  await failLinks(join(out, 'batch.json'));
  await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b'], 'draft'), outDir: out });
  expect(unfinished((await readBatch({ dir: out })).batch)).toEqual([[1, 'previewed', 'a'], [2, 'previewed', 'b']]);
});

it('写入失败项留下的残留目录不影响已结束批次的辨认', async () => {
  const out = target();
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(out, '0002', 'image.png')) throw new Error('injected disk error');
    return original(...args);
  });
  const result = await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b', 'c']), outDir: out });
  expect(result.items[1]).toMatchObject({ status: 'failed' }); expect(result.items[1]!.directory).toBeUndefined();
  vi.mocked(fs.open).mockImplementation(original);
  const read = await readBatch({ dir: out });
  expect(read.problems).toEqual([]); expect(read.batch?.state).toBe('finished');
});

it('拒绝不是批次的目录、清单被改与项目录缺完成清单', async () => {
  expect(codes((await readBatch({ dir: singleTextDir })).problems)).toEqual(['record.invalid']);
  expect(codes((await readBatch({ dir: join(root, 'missing') })).problems)).toEqual(['record.invalid']);
  const out = target();
  expect((await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a', 'b']), outDir: out })).problems).toEqual([]);

  const changed = target();
  await fs.cp(out, changed, { recursive: true });
  const manifest = await json(join(changed, 'batch.json'));
  manifest.items[1].status = 'failed';
  await fs.writeFile(join(changed, 'batch.json'), JSON.stringify(manifest));
  expect((await readBatch({ dir: changed })).problems[0]?.message).toContain('不一致');

  const missing = target();
  await fs.cp(out, missing, { recursive: true });
  await fs.rm(join(missing, '0001', 'record.json'));
  expect((await readBatch({ dir: missing })).problems[0]?.message).toContain('不一致');

  const extra = target();
  await fs.cp(out, extra, { recursive: true });
  await fs.writeFile(join(extra, 'notes.txt'), '');
  expect((await readBatch({ dir: extra })).problems[0]?.message).toContain('非受控条目');
});

it('CLI：取消返回 130 并给出汇总；batch-read 已结束返回 0、未完成返回 1、用法错误 2', async () => {
  const request = join(root, 'cli-cancel.json'), options = join(root, 'cli-options.json'), stdout: string[] = [], stderr: string[] = [];
  await fs.writeFile(request, JSON.stringify(batch(['a', 'b', 'c'])));
  await fs.writeFile(options, JSON.stringify(lean));
  const controller = new AbortController();
  const io = { stdout: (text: string) => { stdout.push(text); },
    stderr: (text: string) => { stderr.push(text); if (text.startsWith('[1/3]')) controller.abort(); }, signal: controller.signal };
  const deliverArgs = (dir: string) => ['deliver', '--workspace', singleTextDir, '--resources', resources, '--request', request, '--options', options, '--out', dir];
  const out = target();
  expect(await runCli(deliverArgs(out), io)).toBe(130);
  expect(JSON.parse(stdout.join('')).summary).toMatchObject({ total: 3, delivered: 1, notRun: 2 });
  expect(stderr.join('')).toMatch(/delivery\.cancelled[\s\S]*已取消：2 项未执行/);

  const aborted = new AbortController();
  aborted.abort();
  const never = target();
  expect(await runCli(deliverArgs(never), { ...io, signal: aborted.signal })).toBe(130);
  await expect(fs.stat(never)).rejects.toThrow();

  stdout.length = 0; stderr.length = 0;
  expect(await runCli(['batch-read', '--batch', out], io)).toBe(0);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ state: 'finished', manifest: { summary: { delivered: 1, notRun: 2 } } });

  const broken = target();
  await failLinks(join(broken, 'batch.json'));
  await deliverBatch({ workspace: greeting, resources: store, renderOptions: lean, request: batch(['a']), outDir: broken });
  stdout.length = 0; stderr.length = 0;
  expect(await runCli(['batch-read', '--batch', broken], io)).toBe(1);
  expect(JSON.parse(stdout.join(''))).toMatchObject({ state: 'unfinished', items: [{ index: 1, status: 'delivered', id: 'a' }] });
  expect(stderr.join('')).toContain('未完成运行');
  expect(await runCli(['batch-read'], io)).toBe(2);
});
