/** 构建后运行；从最终图片独立解码，并保存跨平台可比较的图片及摘要哈希。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import jsQR from 'jsqr';
import { loadWorkspace, render } from '../dist/index.js';

const out = process.argv[2] ?? 'out/stage2/qr-windows';
await mkdir(out, { recursive: true });
const workspace = await loadWorkspace({ dir: 'docs/examples/qrcode-dsl', resourcesDir: 'fixtures/resources' });
const request = JSON.parse(await readFile('docs/examples/qrcode-dsl/render-request-query.json', 'utf8'));
const require = createRequire(import.meta.url);
const { default: init } = await import('canvaskit-wasm/full');
const ck = await init({ locateFile: () => require.resolve('canvaskit-wasm/bin/full/canvaskit.wasm') });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = {};
for (const errorCorrectionLevel of ['L', 'M', 'Q', 'H']) {
  const templates = structuredClone(workspace.templates);
  templates[0].document.artboard.children[0].errorCorrectionLevel = errorCorrectionLevel;
  for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
    const result = await render({ ...workspace, templates }, { ...request, output: { ...request.output, dpi, format } });
    assert.deepEqual(result.problems, []);
    assert(result.image);
    const image = ck.MakeImageFromEncoded(result.image.bytes);
    assert(image);
    try {
      const width = image.width(), height = image.height();
      const pixels = image.readPixels(0, 0, { width, height, colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
      assert.equal(jsQR(new Uint8ClampedArray(pixels), width, height)?.data, request.parameters.queryUrl);
    } finally {
      image.delete();
    }
    const name = `qrcode-${errorCorrectionLevel}-${dpi}.${format}`;
    await writeFile(join(out, name), result.image.bytes);
    hashes[name] = { image: hash(result.image.bytes), layout: hash(JSON.stringify(result.layout)) };
  }
}
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`PASS: ${Object.keys(hashes).length} QR images independently decoded; hashes saved to ${out}`);
