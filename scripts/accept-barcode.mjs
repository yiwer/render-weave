/** 构建后运行：独立解码最终成品，记录 Windows/Linux 可比较的图片与布局哈希。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { loadWorkspace, render } from '../dist/index.js';

const out = process.argv[2] ?? 'out/stage2/code128-windows';
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const wasm = await readFile(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(wasm).buffer } });
const workspace = await loadWorkspace({ dir: 'docs/examples/barcode-dsl', resourcesDir: 'fixtures/resources' });
const request = JSON.parse(await readFile('docs/examples/barcode-dsl/render-request-asset.json', 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const showText of [false, true]) {
  const templates = structuredClone(workspace.templates);
  templates[0].document.artboard.children[0].showText = showText;
  for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
    const result = await render({ ...workspace, templates }, { ...request, output: { ...request.output, dpi, format } });
    assert.deepEqual(result.problems, []);
    assert(result.image);
    const decoded = await readBarcodes(result.image.bytes, { formats: ['Code128'], tryHarder: true });
    assert.deepEqual(decoded.map(code => code.text), [request.parameters.assetId]);
    const name = `code128-${showText ? 'label' : 'plain'}-${dpi}.${format}`;
    await writeFile(join(out, name), result.image.bytes);
    hashes[name] = { image: hash(result.image.bytes), layout: hash(JSON.stringify(result.layout)) };
  }
}
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`PASS: ${Object.keys(hashes).length} CODE128 images independently decoded; hashes saved to ${out}`);
