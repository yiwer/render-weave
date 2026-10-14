/**
 * 编译 CLI 的码图线路牌验收：M402 共享 JSON 与扩展模板合成临时工作区，批量正式交付二维码与四类条形码，
 * 交付图与重放图都由独立解码器读回；错误校验位只使本项失败。再经检查与应用替换条形码字体，新批次用 v2，
 * 移走原工作区与仓库后旧记录仍按原字体重放。保留出图供人核对。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');
const { prepareZXingModule, readBarcodes } = await import(pathToFileURL(require.resolve('zxing-wasm/reader')).href);
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))).buffer } });
const { loadCanvasKit } = await import('../dist/canvaskit.js');
const ck = await loadCanvasKit();
/** 用 CanvasKit 把 PNG/JPEG 解成非预乘 RGBA，供 jsQR 读取。 */
function decodePixels(bytes) {
  const image = ck.MakeImageFromEncoded(bytes);
  assert(image, '无法解码图片');
  try {
    const width = image.width(), height = image.height();
    const data = image.readPixels(0, 0, { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    return { width, height, data };
  } finally { image.delete(); }
}

const out = resolve(process.argv[2] ?? 'out/stage2/coded-windows');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const origin = join(run, 'origin'), workspace = join(origin, 'workspace'), resources = join(origin, 'resources');
await mkdir(workspace, { recursive: true });
for (const file of await readdir('docs/examples/m402-dsl')) if (file.endsWith('.json')) await copyFile(join('docs/examples/m402-dsl', file), join(workspace, file));
await copyFile('docs/examples/coded-route-sign/template-coded-route-sign.json', join(workspace, 'template-coded-route-sign.json'));
const cli = (...args) => spawnSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8', windowsHide: true });
const ok = (...args) => { const r = cli(...args); assert.equal(r.status, 0, `${args[0]}: ${r.stderr}`); return r.stdout; };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
ok('resources-init', '--resources', resources);
ok('resources-import', '--source', 'fixtures/resources', '--resources', resources);
const zxing = { CODE128: 'Code128', 'EAN-13': 'EAN13', 'EAN-8': 'EAN8', 'UPC-A': 'UPCA' };
/** 从最终图片读回两种码，UPC-A 由锁定 ZXing 按补零的 13 位返回（M165）。 */
async function decode(file, parameters) {
  const bytes = await readFile(file), pixels = decodePixels(new Uint8Array(bytes));
  const qr = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
  const barcodes = (await readBarcodes(new Uint8Array(bytes), { formats: [zxing[parameters.assetFormat]], tryHarder: true })).map(code => code.text);
  assert.deepEqual({ qr, barcodes }, { qr: parameters.queryUrl, barcodes: [parameters.assetFormat === 'UPC-A' ? `0${parameters.assetNo}` : parameters.assetNo] }, file);
  return hash(bytes);
}
const evidence = { run };

// 一、批量交付：错误校验位一项失败，退出码 1，其余五项交付，交付图与重放图都读回原文。
const request = 'docs/examples/coded-route-sign/batch-request.json', items = (await json(request)).items, batchDir = join(origin, 'batch');
const delivered = cli('deliver', '--workspace', workspace, '--resources', resources, '--request', request, '--out', batchDir);
assert.equal(delivered.status, 1, delivered.stderr);
assert.match(delivered.stderr, /bad-ean13-checksum：失败[\s\S]*barcode\.checksumInvalid/);
const manifest = await json(join(batchDir, 'batch.json'));
assert.deepEqual(manifest.items.map(item => [item.id, item.status]), items.map(item => [item.id, item.id.startsWith('bad-') ? 'failed' : 'delivered']));
const images = {};
for (const [i, entry] of manifest.items.entries()) {
  if (entry.status !== 'delivered') continue;
  const dir = join(batchDir, entry.directory), replay = join(run, `replay-${entry.directory}`);
  images[entry.id] = await decode(join(dir, entry.files.image), items[i].parameters);
  ok('replay', '--record', dir, '--out', replay);
  assert.equal(await decode(join(replay, entry.files.image), items[i].parameters), images[entry.id]);
  assert.equal(JSON.parse(ok('record-read', '--record', dir)).resources.find(r => r.id === 'font-hei-regular').version, 1);
}
evidence.batch = { exit: delivered.status, summary: manifest.summary, images };

// 二、替换条形码字体：先归档第一项记录；检查报告列出模板中的条形码字体，按预期版本应用为 v2。
const archive = join(run, 'archived-coded-01');
await cp(join(batchDir, '0001'), archive, { recursive: true });
const heavy = 'fixtures/resources/fonts/SourceHanSansCN-Heavy.otf', report = join(run, 'replace-check.json');
const check = JSON.parse(ok('resources-check', '--resources', resources, '--workspace', workspace, '--id', 'font-hei-regular', '--kind', 'font', '--file', heavy, '--out', report));
assert(check.impact.references.some(ref => ref.kind === 'templateFixed' && ref.path === '/artboard/children/1/children/1/font'), JSON.stringify(check.impact.references));
assert.equal(JSON.parse(ok('resources-apply', '--resources', resources, '--workspace', workspace, '--file', heavy, '--check', report)).version, 2);
const nextRequest = join(run, 'coded-01-request.json'), next = join(origin, 'after-replace');
await writeFile(nextRequest, JSON.stringify({ ...(await json(request)), items: [items[0]] }));
ok('deliver', '--workspace', workspace, '--resources', resources, '--request', nextRequest, '--out', next);
assert.equal(JSON.parse(ok('record-read', '--record', join(next, '0001'))).resources.find(r => r.id === 'font-hei-regular').version, 2);
const replaced = await decode(join(next, '0001', 'image.png'), items[0].parameters);
assert.notEqual(replaced, images[items[0].id]);

// 三、移走原工作区、仓库与原批次后，归档的旧记录仍按 v1 字体重放，图片与原交付一致。
await rename(origin, join(run, 'unavailable-origin'));
const archivedReplay = join(run, 'archived-replay');
ok('replay', '--record', archive, '--out', archivedReplay);
assert.equal(await decode(join(archivedReplay, 'image.png'), items[0].parameters), images[items[0].id]);
evidence.replacement = { fontVersionAfter: 2, newImage: replaced, archivedReplayMatches: true };

await writeFile(join(out, 'hashes.json'), JSON.stringify(images, null, 2) + '\n');
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform }, null, 2) + '\n');
console.log(`PASS: 5 coded signs delivered and decoded (final and replay); bad checksum failed alone; font v2 used next; archived v1 record replayed; ${run}`);
