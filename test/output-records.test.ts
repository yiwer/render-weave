import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { deliverBatch, readOutputRecord, replayOutputRecord, initializeResourceStore, importResources, openVersionedResourceStore,
  render, type VersionedResourceStore, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { greetingRequest, loadSingleText, resourcesDir, singleTextDir, withTemplate } from './support/fixtures.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link) };
});
let root: string, baseline: string, dir: string, out: string, workspace: Workspace, store: VersionedResourceStore;
let counter = 0;
const options = { fallbackFonts: ['font-hei-medium', 'missing-fallback'], svgFonts: [] };
const batch = (): { template: unknown; mode: unknown; items: Record<string, any>[] } => { const { template, mode, ...item } = greetingRequest(); return { template, mode, items: [{ id: '../../不作路径', ...item }] }; };
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function manifestEdit(edit: (manifest: any) => void) {
  const file = join(dir, 'record.json'), value = await json(file); edit(value); await fs.writeFile(file, JSON.stringify(value));
}
async function deliver(extra = {}) { return deliverBatch({ workspace, resources: store, request: batch(), outDir: out, renderOptions: options, ...extra }); }
async function rejected() { const result = await replayOutputRecord({ dir, outDir: out }); expect(result.replayed).toBeUndefined(); expect(result.problems[0]?.level).toBe('severe'); return result; }
beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-records-'));
  const target = join(root, 'resources');
  expect((await initializeResourceStore(target)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: target })).problems).toEqual([]);
  store = (await openVersionedResourceStore(target)).store!;
  workspace = await loadSingleText();
  baseline = join(root, 'baseline');
  const result = await deliverBatch({ workspace, resources: store, request: batch(), outDir: baseline, renderOptions: options });
  expect(result.problems).toEqual([]); expect(result.delivered).toBeDefined();
});
beforeEach(async () => { dir = join(root, `copy-${++counter}`); out = join(root, `output-${counter}`); await fs.cp(baseline, dir, { recursive: true }); });
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); });
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-records-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('独立复制后公开入口重放，图片、问题和摘要完全一致；缺失后备状态保留', async () => {
  const read = await readOutputRecord({ dir }); expect(read.problems).toEqual([]);
  expect(read.record?.itemId).toBe('../../不作路径');
  expect(read.record?.resources).toContainEqual({ id: 'missing-fallback', state: 'missing' });
  const result = await replayOutputRecord({ dir, outDir: out }); expect(result.problems).toEqual([]); expect(result.replayed).toBeDefined();
  for (const file of ['image.png', 'layout.json', 'problems.json']) expect(await fs.readFile(join(out, file))).toEqual(await fs.readFile(join(dir, file)));
  expect((await json(join(out, 'replay.json'))).matched).toBe(true);
});

it('归档包含实际数据集、静态定义原文及编译产物；与原 render 相同', async () => {
  const saved = await json(join(dir, 'input.json'));
  expect(saved.documents.staticSchemas[0].definition).toEqual(workspace.staticSchemas[0]?.definition);
  expect(saved.documents.staticSchemas[0].compiled).toEqual(workspace.staticSchemas[0]?.compiled);
  expect(saved.documents.datasets[0].document).toEqual(workspace.datasets[0]?.document);
  const result = await render(workspace, greetingRequest(), options);
  expect(hash(result.image!.bytes)).toBe(hash(await fs.readFile(join(dir, 'image.png'))));
});

it('内联数据、参数和 JPEG 走相同合同', async () => {
  const request = batch();
  request.items[0]!.dataset = { inline: workspace.datasets[0]!.document };
  request.items[0]!.output = { width: 160, height: 40, dpi: 120, format: 'jpeg' };
  const result = await deliver({ request }); expect(result.problems).toEqual([]); expect(result.delivered?.image).toBe('image.jpg');
  expect((await replayOutputRecord({ dir: out, outDir: join(root, 'jpeg-replay') })).replayed).toBeDefined();
});
it('图形及对外参数随记录保存并重放', async () => {
  const modified = withTemplate(workspace, '问候牌', (document) => {
    document.parameters = [{ name: 'label', displayName: '标题', visibility: 'public', type: 'text' }];
    document.artboard.children[0].content = [{ slot: 'label' }];
    document.artboard.children.unshift({ type: 'rect', name: '色块', fill: '#0099CC', place: { left: 0, top: 0, width: { fixed: 160 }, height: { fixed: 5 } } });
  });
  const request = batch(); request.items[0]!.parameters = { label: '独立交付' };
  const result = await deliver({ workspace: modified, request }); expect(result.problems).toEqual([]); expect(result.delivered).toBeDefined();
  expect((await json(join(out, 'input.json'))).batch.items[0].parameters).toEqual({ label: '独立交付' });
  expect((await replayOutputRecord({ dir: out, outDir: join(root, 'shape-replay') })).replayed).toBeDefined();
});
it('固定版本的字体字节损坏时不开始交付', async () => {
  const result = await deliver({ resources: { ...store, get: store.get.bind(store), read: async () => new Uint8Array([1, 2]) } });
  expect(result.delivered).toBeUndefined(); expect(result.problems[0]?.code).toBe('record.integrityMismatch');
});

it.each(['template', 'dataset', 'compiled', 'definition'])('删除记录的 %s 后即使更新文件哈希也拒绝', async (part) => {
  const file = join(dir, 'input.json'), saved = await json(file);
  if (part === 'template') saved.documents.templates = [];
  if (part === 'dataset') saved.documents.datasets = [];
  if (part === 'compiled' || part === 'definition') delete saved.documents.staticSchemas[0][part];
  const bytes = Buffer.from(JSON.stringify(saved)); await fs.writeFile(file, bytes);
  await manifestEdit((m) => Object.assign(m.files.find((f: any) => f.file === 'input.json'), { sha256: hash(bytes), byteLength: bytes.length }));
  await rejected();
});

it.each(['input.json', 'font-000001.bin', 'image.png', 'problems.json', 'layout.json'])('删除 %s 不补入外部内容', async (file) => {
  await fs.unlink(join(dir, file)); await rejected(); expect((await readOutputRecord({ dir })).record).toBeUndefined();
});
it.each(['input.json', 'font-000001.bin', 'image.png', 'problems.json', 'layout.json'])('篡改 %s 按哈希拒绝', async (file) => {
  await fs.appendFile(join(dir, file), 'bad'); expect((await rejected()).problems[0]?.code).toBe('record.integrityMismatch');
});
it.each(['../outside.bin', 'F:/outside.bin', 'font-000001.bin:stream', '\\outside', 'https://example.org/font'])('非法文件引用 %s 拒绝', async (file) => {
  await manifestEdit((m) => m.files[0].file = file); await rejected();
});
it('资源文件被目录替代时拒绝', async () => { await fs.unlink(join(dir, 'font-000001.bin')); await fs.mkdir(join(dir, 'font-000001.bin')); await rejected(); });
it('记录目录 junction 指向外部目录时拒绝', async () => {
  const link = join(root, `junction-${counter}`); await fs.symlink(dir, link, 'junction');
  expect((await readOutputRecord({ dir: link })).record).toBeUndefined();
});
it('不支持的版本与构建不符分别拒绝', async () => {
  await manifestEdit((m) => m.format = 'renderweave-output-record/99'); expect((await rejected()).problems[0]?.code).toBe('record.invalid');
  await manifestEdit((m) => { m.format = 'renderweave-output-record/1'; m.build = `sha256:${'0'.repeat(64)}`; });
  expect((await rejected()).problems[0]?.code).toBe('record.buildMismatch');
});
it('替换归档图片并同步伪造哈希仍因实际重新渲染不一致而拒绝', async () => {
  const bytes = Buffer.from('a saved image is not replay'); await fs.writeFile(join(dir, 'image.png'), bytes);
  await manifestEdit((m) => Object.assign(m.files.find((f: any) => f.file === 'image.png'), { sha256: hash(bytes), byteLength: bytes.length }));
  expect((await rejected()).problems[0]?.code).toBe('record.replayMismatch');
});
it('漏掉缺失字体状态、重复文件及遗漏成果条目均拒绝', async () => {
  const original = await fs.readFile(join(dir, 'record.json'));
  for (const change of [(m: any) => m.resources.pop(), (m: any) => m.files.push(m.files[0]), (m: any) => m.files.pop()]) {
    await fs.writeFile(join(dir, 'record.json'), original); await manifestEdit(change); await rejected();
  }
});
it.each([{ items: [] }, { items: [{ id: 'x' }, { id: 'x' }] }])('空列表或多项明确拒绝', async ({ items }) => {
  const result = await deliver({ request: { ...batch(), items } }); expect(result.delivered).toBeUndefined(); expect(result.problems[0]?.code).toBe('delivery.unsupported');
});
it('草稿、未知属性、无标识、非法选项拒绝；严重渲染问题无记录', async () => {
  for (const request of [{ ...batch(), mode: 'draft' }, { ...batch(), extra: true }, { ...batch(), items: [{ ...batch().items[0], id: '' }] }]) expect((await deliver({ request })).delivered).toBeUndefined();
  expect((await deliver({ renderOptions: { fallbackFonts: null } })).delivered).toBeUndefined();
  const request = batch(); request.items[0]!.dataset = { inline: { dataset: { staticSchema: { name: '问候', version: 1 } }, data: { message: '' } } };
  expect((await deliver({ request })).delivered).toBeUndefined();
  await expect(fs.stat(out)).rejects.toThrow();
});
it.each(['call', 'loop', 'qrcode', 'barcode'])('无效调用或未覆盖的 %s 元素不能生成成功记录', async (type) => {
  const modified = withTemplate(workspace, '问候牌', (document) => document.artboard.children.push({ type, name: 'unsupported' }));
  expect((await deliver({ workspace: modified })).delivered).toBeUndefined();
});
it('冻结前复制请求和文档，字体只读固定版本一次；调用中修改输入不影响记录', async () => {
  const copy = withTemplate(workspace, '问候牌', () => undefined), request = batch();
  const read = vi.fn(async (id: string, version: number) => {
    request.items[0]!.id = 'changed'; (copy.templates[0]!.document as any).artboard.fill = '#000000';
    return store.read(id, version);
  });
  const result = await deliver({ workspace: copy, request, resources: { ...store, get: store.get.bind(store), read } });
  expect(result.delivered?.id).toBe('../../不作路径'); expect(read).toHaveBeenCalledTimes(1);
  expect(await fs.readFile(join(out, 'image.png'))).toEqual(await fs.readFile(join(baseline, 'image.png')));
});
it('目标存在及并发竞争均不覆盖，恰好一个交付成功', async () => {
  const results = await Promise.all([deliver(), deliver()]); expect(results.filter((r) => r.delivered)).toHaveLength(1);
  const before = await fs.readFile(join(out, 'record.json')); expect((await deliver()).delivered).toBeUndefined();
  expect(await fs.readFile(join(out, 'record.json'))).toEqual(before);
  expect((await replayOutputRecord({ dir, outDir: out })).replayed).toBeUndefined();
});
it.each(['image.png', 'input.json', '.complete.tmp'])('%s 写入失败不发布完成清单', async (file) => {
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === join(out, file)) throw new Error('injected disk error');
    return original(...args);
  });
  const result = await deliver(); expect(result.delivered).toBeUndefined(); expect(result.problems[0]?.code).toBe('delivery.writeFailed');
  expect((await readOutputRecord({ dir: out })).record).toBeUndefined();
});
it('完成清单发布失败留下的全套内容也不能读取为成功', async () => {
  vi.mocked(fs.link).mockRejectedValueOnce(new Error('injected commit failure'));
  expect((await deliver()).delivered).toBeUndefined();
  expect((await readOutputRecord({ dir: out })).record).toBeUndefined();
  await expect(fs.stat(join(out, 'image.png'))).resolves.toBeDefined();
});
it('实际写入一部分后失败关闭句柄，残留内容没有完成清单', async () => {
  const original = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await original(...args);
    if (String(args[0]) === join(out, 'image.png')) {
      const write = handle.writeFile.bind(handle);
      vi.spyOn(handle, 'writeFile').mockImplementation(async () => { await write('partial'); throw new Error('disk full after partial write'); });
    }
    return handle;
  });
  expect((await deliver()).delivered).toBeUndefined();
  expect(await fs.readFile(join(out, 'image.png'), 'utf8')).toBe('partial');
  expect((await readOutputRecord({ dir: out })).record).toBeUndefined();
  // Windows 可删除文件证明失败路径已关闭句柄。
  await fs.unlink(join(out, 'image.png'));
});
it('CLI 正式交付、读取、复制重放、目标保护及用法错误', async () => {
  const request = join(root, 'batch.json'), config = join(root, 'options.json');
  await fs.writeFile(request, JSON.stringify(batch())); await fs.writeFile(config, JSON.stringify(options));
  const io = { stdout: vi.fn(), stderr: vi.fn() };
  expect(await runCli(['deliver', '--workspace', singleTextDir, '--resources', join(root, 'resources'), '--request', request, '--options', config, '--out', out], io)).toBe(0);
  expect(await runCli(['record-read', '--record', out], io)).toBe(0);
  expect(await runCli(['replay', '--record', dir, '--out', join(root, 'cli-replay')], io)).toBe(0);
  expect(await runCli(['replay', '--record', dir, '--out', out], io)).toBe(1);
  expect(await runCli(['replay', '--record', dir], io)).toBe(2);
  await fs.writeFile(request, '{');
  expect(await runCli(['deliver', '--workspace', singleTextDir, '--resources', join(root, 'resources'), '--request', request, '--out', out], io)).toBe(2);
});
