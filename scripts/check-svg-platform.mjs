/** 先 npm run build，再分别在 Windows / Linux 运行；比较生成的 hashes.json。 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadWorkspace, render } from '../dist/index.js';

const output = process.argv[2];
if (!output) throw new Error('用法：node scripts/check-svg-platform.mjs <输出目录>');
await mkdir(output, { recursive: true });
const workspace = await loadWorkspace({ dir: 'fixtures/workspaces/m402-skeleton', resourcesDir: 'fixtures/resources' });
const text = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="180" height="40">
  <text x="2" y="28" font-family="Source Han Sans CN" font-size="24">深圳 SVG <tspan font-weight="700">清晰</tspan></text>
</svg>`);
const resources = workspace.resources;
const children = ['contain', 'cover', 'fill'].map((fit, i) => ({
  type: 'image', name: fit, source: 'res:test-vector-svg', fit,
  place: { left: 2 + i * 24, top: 2, width: { fixed: 20 }, height: { fixed: 20 } },
}));
children.push({ type: 'image', name: '资源字体', source: 'res:svg-text', fit: 'contain',
  place: { left: 2, top: 24, width: { fixed: 68 }, height: { fixed: 12 } } });
const lab = { ...workspace, resources: {
  get: (id) => id === 'svg-text' ? { id, kind: 'image' } : resources.get(id),
  read: (id) => id === 'svg-text' ? Promise.resolve(text) : resources.read(id),
}, templates: [{ name: 'SVG 平台验证', document: {
  dslVersion: 'renderweave-template/1', name: 'SVG 平台验证', base: { name: 'M402 骨架', version: 1 },
  artboard: { fill: '#FFFFFF', sizeRange: { width: { min: 72, max: 72 }, height: { min: 38, max: 38 } }, children },
} }] };
const hashes = {};
for (const dpi of [127, 508]) {
  for (const format of ['png', 'jpeg']) {
    const result = await render(lab, { template: 'SVG 平台验证', dataset: { id: 'ds-m402-skeleton' }, parameters: {},
      output: { width: 72, height: 38, dpi, format }, mode: 'final' });
    if (result.problems.length || !result.image) throw new Error(JSON.stringify(result.problems));
    const name = `svg-${dpi}.${format}`;
    await writeFile(join(output, name), result.image.bytes);
    hashes[name] = createHash('sha256').update(result.image.bytes).digest('hex');
  }
}
await writeFile(join(output, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(output, 'environment.json'), JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version }, null, 2) + '\n');
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version, hashes }, null, 2));
