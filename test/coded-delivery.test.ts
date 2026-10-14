import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes, type ReadInputBarcodeFormat } from 'zxing-wasm/reader';
import { applyResourceReplacement, checkResourceReplacement, deliverBatch, importResources, initializeResourceStore, loadWorkspace,
  openVersionedResourceStore, readOutputRecord, replayOutputRecord, type BatchItemResult, type VersionedResourceStore, type Workspace } from '../src/index.js';
import { m402Dir, repoRoot, resourcesDir } from './support/fixtures.js';
import { decodePixels } from './support/pixels.js';

const require = createRequire(import.meta.url);
// jsQR 的 CommonJS 导出是函数，声明文件则使用 default；显式按其声明导入运行时函数。
const jsQR = require('jsqr') as typeof import('jsqr').default;
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))).buffer } });

const sampleDir = join(repoRoot, 'docs', 'examples', 'coded-route-sign');
const zxingFormat: Record<string, ReadInputBarcodeFormat> = { CODE128: 'Code128', 'EAN-13': 'EAN13', 'EAN-8': 'EAN8', 'UPC-A': 'UPCA' };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
let root: string, batch: { template: string; mode: string; items: Record<string, any>[] };

/** M402 共享 JSON 与扩展模板合成一个磁盘工作区，配一个独立版本仓库；替换资源只影响本组。 */
async function prepare(name: string): Promise<{ workspaceDir: string; resources: string; store: VersionedResourceStore; workspace: Workspace }> {
  const workspaceDir = join(root, `${name}-workspace`), resources = join(root, `${name}-resources`);
  await fs.mkdir(workspaceDir);
  for (const file of await fs.readdir(m402Dir)) if (file.endsWith('.json')) await fs.copyFile(join(m402Dir, file), join(workspaceDir, file));
  await fs.copyFile(join(sampleDir, 'template-coded-route-sign.json'), join(workspaceDir, 'template-coded-route-sign.json'));
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({ sourceDir: resourcesDir, dir: resources })).problems).toEqual([]);
  return { workspaceDir, resources, store: (await openVersionedResourceStore(resources)).store!, workspace: await loadWorkspace({ dir: workspaceDir, resourcesDir: resources }) };
}
/** 从最终图片独立读回二维码与资产码；UPC-A 由锁定的 ZXing 按补零的 13 位返回（M165）。 */
async function decodeItem(file: string, parameters: Record<string, string>) {
  const bytes = new Uint8Array(await fs.readFile(file)), pixels = await decodePixels(bytes);
  const qr = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
  const barcodes = (await readBarcodes(bytes, { formats: [zxingFormat[parameters.assetFormat!]!], tryHarder: true })).map((code) => code.text);
  expect({ qr, barcodes }).toEqual({ qr: parameters.queryUrl, barcodes: [parameters.assetFormat === 'UPC-A' ? `0${parameters.assetNo}` : parameters.assetNo] });
  return hash(bytes);
}
const imageOf = (item: BatchItemResult) => join(item.directory!, item.files!.image!);

beforeAll(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'renderweave-coded-'));
  batch = JSON.parse(await fs.readFile(join(sampleDir, 'batch-request.json'), 'utf8'));
});
afterAll(async () => {
  if (!resolve(root).startsWith(join(resolve(tmpdir()), 'renderweave-coded-'))) throw new Error('测试清理路径越界');
  await fs.rm(root, { recursive: true, force: true });
});

it('码图线路牌批量正式交付：二维码与四类条形码的交付图和重放图都独立解码；错误校验位只使本项失败', async () => {
  const { store, workspace } = await prepare('batch');
  const result = await deliverBatch({ workspace, resources: store, request: batch, outDir: join(root, 'batch') });
  expect(result.problems).toEqual([]);
  expect(result.items.map((item) => [item.id, item.status])).toEqual(batch.items.map((item) => [item.id, item.id.startsWith('bad-') ? 'failed' : 'delivered']));
  expect(result.items[2]!.problems.map((p) => p.code)).toContain('barcode.checksumInvalid');
  await expect(fs.stat(join(result.items[2]!.directory!, 'record.json'))).rejects.toThrow();
  for (const [i, item] of result.items.entries()) {
    if (item.status !== 'delivered') continue;
    const parameters = batch.items[i]!.parameters;
    const delivered = await decodeItem(imageOf(item), parameters);
    const record = (await readOutputRecord({ dir: item.directory! })).record!;
    // 条形码下方文字的字体随记录固定；二维码不引入资源。
    expect(record.resources.find((r) => r.id === 'font-hei-regular')).toMatchObject({ state: 'available', kind: 'font', version: 1 });
    const replayDir = join(root, `replay-${item.index}`);
    const replayed = await replayOutputRecord({ dir: item.directory!, outDir: replayDir });
    expect(replayed.problems).toEqual([]);
    expect(await decodeItem(join(replayDir, replayed.replayed!.image), parameters)).toBe(delivered);
  }
}, 240_000);

it('经影响检查与预期版本替换条形码字体：新批次用 v2，旧记录脱离工作区与仓库仍按原字体重放', async () => {
  const { workspaceDir, resources, store, workspace } = await prepare('replace');
  const first = batch.items[0]!, request = { ...batch, items: [first] };
  const before = await deliverBatch({ workspace, resources: store, request, outDir: join(root, 'before') });
  const archive = join(root, 'archived-record');
  await fs.cp(before.items[0]!.directory!, archive, { recursive: true });
  const oldImage = await decodeItem(imageOf(before.items[0]!), first.parameters);

  const heavy = join(resourcesDir, 'fonts', 'SourceHanSansCN-Heavy.otf');
  const check = await checkResourceReplacement({ dir: resources, workspaceDir, id: 'font-hei-regular', kind: 'font', file: heavy });
  expect(check.problems).toEqual([]);
  expect(check.check!.impact.references).toContainEqual(expect.objectContaining({ kind: 'templateFixed', path: '/artboard/children/1/children/1/font' }));
  expect((await applyResourceReplacement({ dir: resources, workspaceDir, file: heavy, check: check.check })).replaced?.version).toBe(2);

  const reopened = (await openVersionedResourceStore(resources)).store!;
  const after = await deliverBatch({ workspace, resources: reopened, request, outDir: join(root, 'after') });
  expect(after.items[0]!.status).toBe('delivered');
  expect((await readOutputRecord({ dir: after.items[0]!.directory! })).record!.resources.find((r) => r.id === 'font-hei-regular')).toMatchObject({ version: 2 });
  expect(await decodeItem(imageOf(after.items[0]!), first.parameters)).not.toBe(oldImage);

  await fs.rm(workspaceDir, { recursive: true });
  await fs.rm(resources, { recursive: true });
  const replayDir = join(root, 'archived-replay');
  const replayed = await replayOutputRecord({ dir: archive, outDir: replayDir });
  expect(replayed.problems).toEqual([]);
  expect(await decodeItem(join(replayDir, replayed.replayed!.image), first.parameters)).toBe(oldImage);
}, 240_000);
