/** 独立解码最终 EAN/UPC 图片；严格检查格式和原始字节，不进行通用去零或数值转换。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { loadWorkspace, render } from '../dist/index.js';

const out = process.argv[2] ?? 'out/stage2/retail-windows';
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(await readFile(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))).buffer } });
const workspace = await loadWorkspace({ dir: 'docs/examples/retail-barcode-dsl', resourcesDir: 'fixtures/resources' });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {}, decoding = {};
for (const decoder of ['EAN13', 'EAN8', 'UPCA']) {
  const request = JSON.parse(await readFile(`docs/examples/retail-barcode-dsl/render-request-${decoder.toLowerCase()}.json`, 'utf8'));
  for (const showText of [false, true]) {
    const templates = structuredClone(workspace.templates);
    templates.find(template => template.name === request.template).document.artboard.children[0].showText = showText;
    for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
      const result = await render({ ...workspace, templates }, { ...request, output: { ...request.output, dpi, format } });
      assert.deepEqual(result.problems, []);
      assert(result.image);
      const codes = await readBarcodes(result.image.bytes, { formats: [decoder], tryHarder: true });
      assert.equal(codes.length, 1);
      assert.equal(codes[0].format, decoder);
      assert.equal(codes[0].isValid, true);
      // UPC-A 与首位为 0 的 EAN-13 符号等价；锁定 ZXing 对 UPCA 返回这个确切的 13 位表示。
      const expected = (decoder === 'UPCA' ? '0' : '') + request.parameters.productId;
      assert.equal(codes[0].text, expected);
      assert.deepEqual(Array.from(codes[0].bytes), Array.from(Buffer.from(expected, 'ascii')));
      const name = `${decoder}-${showText ? 'label' : 'plain'}-${dpi}.${format}`;
      await writeFile(join(out, name), result.image.bytes);
      hashes[name] = { image: hash(result.image.bytes), layout: hash(JSON.stringify(result.layout)) };
      decoding[name] = { requested: request.parameters.productId, format: codes[0].format, text: codes[0].text, bytes: Array.from(codes[0].bytes) };
    }
  }
}
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'decoding.json'), JSON.stringify(decoding, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`PASS: ${Object.keys(hashes).length} EAN/UPC images independently decoded with exact format and byte checks; hashes saved to ${out}`);
