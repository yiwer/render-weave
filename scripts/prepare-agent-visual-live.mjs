/** 准备真实模型的受控纠偏输入；本脚本不调用模型。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareReference, loadWorkspace, render } from '../src/index.ts';

const out = resolve(process.argv[2] ?? 'out/agent-visual-live');
const dir = join(out, 'workspace');
await mkdir(dir, { recursive: true });
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + '\n');
const template = {
  dslVersion: 'renderweave-template/1', name: '中文对照', base: { name: '空数据定义', version: 1 },
  artboard: { fill: '#FFFFFF', sizeRange: { width: { min: 100, max: 100 }, height: { min: 60, max: 60 } }, layout: { mode: 'free' }, children: [
    { type: 'text', name: '站名', content: [{ text: '科技园' }], font: 'res:font-hei-medium', fontSize: 10, color: '#172B4D', place: { left: 10, top: 10, width: { fixed: 70 }, height: { fixed: 25 } } },
    { type: 'text', name: '页脚', content: [{ text: '公交站牌 · 16站' }], font: 'res:font-hei-regular', fontSize: 5, color: '#52657A', place: { left: 10, top: 42, width: { fixed: 70 }, height: { fixed: 10 } } },
  ] },
};
const dataset = { dataset: { id: 'ds-visual-live', name: '中文对照空数据', staticSchema: { name: '空数据定义', version: 1 }, origin: { kind: 'manual', note: '受控工具纠偏验收' } }, data: {} };
const request = { template: template.name, dataset: { id: dataset.dataset.id }, parameters: {}, output: { width: 100, height: 60, dpi: 100, format: 'png' }, mode: 'final' };
await save('workspace/dataset.json', dataset);
const empty = await loadWorkspace({ dir, resourcesDir: 'fixtures/resources' });
assert.deepEqual(empty.problems, []);
const overlay = (document) => ({ ...empty, templates: [{ name: template.name, document, source: 'template.json' }] });
const rendered = await render(overlay(template), { ...request, mode: 'draft' }, { comparisonEvidence: true });
assert.deepEqual(rendered.problems, []);
const image = rendered.evidence.image;
const sample = { path: join(out, 'sample.png'), sha256: createHash('sha256').update(image.bytes).digest('hex') };
await writeFile(sample.path, image.bytes);
const approvedRegions = template.artboard.children.map((node) => {
  const ink = rendered.evidence.nodes.find((entry) => entry.path === `${template.name}/${node.name}`).inkBounds;
  return { id: node.name === '站名' ? 'stop-name' : 'footer', name: node.name, targetPathPattern: `${template.name}/${node.name}`, boxKind: 'ink',
    sampleRegion: { x: ink.x * image.widthPx / 100, y: ink.y * image.heightPx / 60, width: ink.width * image.widthPx / 100, height: ink.height * image.heightPx / 60 },
    expectedFontSizeMm: node.fontSize, expectedText: node.content[0].text, expectedColor: node.color, state: 'normal', positionToleranceMm: 0.5 };
});
const reference = { sampleWidthPx: image.widthPx, sampleHeightPx: image.heightPx, artboardWidthMm: 100, artboardHeightMm: 60, sampleSha256: sample.sha256, complete: false, approvedRegions };
const initial = structuredClone(template), stop = initial.artboard.children[0];
stop.fontSize = 5; stop.place.left = 18; stop.color = '#FF0000'; stop.content[0].text = '科枝园';
await save('workspace/template.json', initial); await save('request.json', request); await save('reference.json', reference);
const before = await compareReference({ workspace: overlay(initial), request, baseline: reference, sample, includeImages: true });
await save('before.json', before.report);
assert.ok(['fontSizeTooSmall', 'positionDeviation', 'colorMismatch', 'textMismatch'].every((kind) => before.report.anomalies.some((a) => a.kind === kind)));
await writeFile(join(out, 'brief.md'), '这是工具闭环的合成中文样例，不是真实客户订单。画板100×60毫米，复原样例中的站名，保持页脚和其他结构。宿主已固定参考区域；以工具提供的分项证据核对，不需要整体相似度。\n');
await writeFile(join(out, 'requirement.md'), '仅修改 `中文对照/站名` 的文字、字号、横向位置和文字颜色，使其与示例图一致。保留元素名称、字体、纵向位置、框尺寸以及页脚和画板设置。修改前后调用 compare_reference，记录工具给出的差异和仍未核实的维度。交回前调用 check_outcome。\n');
await save('preparation.json', { kind: 'synthetic-live-correction', sampleSha256: sample.sha256, controls: ['站名文字', '站名字号', '站名横向位置', '站名颜色'], limits: ['真值来自预先定义的合成模板，不验证真实图标注质量', '单次模型试验不能证明成功率', '最终可见性仍需审核'] });
console.log(`已准备输入：${out}；后续经 agent run --task template-revision 运行真实模型`);
