/** node --import tsx scripts/accept-agent-visual.mjs [输出目录] [zh|en]：公开入口的受控验收，不调用模型。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareReference, loadWorkspace, render } from '../src/index.ts';

const out = resolve(process.argv[2] ?? 'out/agent-visual-acceptance');
const language = process.argv[3] ?? 'zh';
assert.ok(['zh', 'en'].includes(language), '语言只能为 zh 或 en');
const expectedText = language === 'en' ? 'Park 16' : '科技园';
const wrongText = language === 'en' ? 'Pork 16' : '科枝园';
await mkdir(out, { recursive: true });
const workspace = await loadWorkspace({ dir: 'docs/examples/m402-dsl', resourcesDir: 'fixtures/resources' });
assert.deepEqual(workspace.problems, []);
const template = (size = 10, left = 10, text = expectedText, color = '#000000') => ({ dslVersion: 'renderweave-template/1', name: '对照', base: { name: '空数据定义', version: 1 },
  artboard: { fill: '#FFFFFF', sizeRange: { width: { min: 10, max: 200 }, height: { min: 10, max: 200 } }, layout: { mode: 'free' }, children: [
    { type: 'text', name: '站名', content: [{ text }], font: 'res:font-hei-medium', fontSize: size, color,
      place: { left, top: 10, width: { fixed: 60 }, height: { fixed: 30 } } },
  ] } });
const overlay = (document) => ({ ...workspace, templates: [...workspace.templates, { name: '对照', document, source: 'candidate.json' }] });
const request = { template: '对照', dataset: { inline: { dataset: { staticSchema: { name: '空数据定义', version: 1 } }, data: {} } },
  parameters: {}, output: { width: 100, height: 60, dpi: 50, format: 'png' }, mode: 'draft' };
const truth = await render(overlay(template()), request, { comparisonEvidence: true });
assert.deepEqual(truth.problems, []);
const evidence = truth.evidence, ink = evidence.nodes.find((n) => n.path === '对照/站名').inkBounds;
const sample = { path: join(out, 'reference.png'), sha256: createHash('sha256').update(evidence.image.bytes).digest('hex') };
await writeFile(sample.path, evidence.image.bytes);
const sx = evidence.image.widthPx / 100, sy = evidence.image.heightPx / 60;
// 真值来自本脚本明确定义的合成样本；这不能证明任意真实站牌的标注或总体视觉质量正确。
const baseline = { sampleWidthPx: evidence.image.widthPx, sampleHeightPx: evidence.image.heightPx, artboardWidthMm: 100, artboardHeightMm: 60,
  sampleSha256: sample.sha256, complete: false, approvedRegions: [{ id: 'stop-name', name: '站名', targetPathPattern: '对照/站名', state: 'normal',
    sampleRegion: { x: ink.x * sx, y: ink.y * sy, width: ink.width * sx, height: ink.height * sy }, boxKind: 'ink', expectedFontSizeMm: 10, expectedText, expectedColor: '#000000' }] };
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');
await save(join(out, 'reference.json'), baseline); await save(join(out, 'request.json'), request);
const empty = template(); empty.artboard.children = [];
const cases = [
  ['baseline', template(), undefined], ['skeleton', empty, 'missingRegion'],
  ['small', template(5), 'fontSizeTooSmall'], ['moved', template(10, 16), 'positionDeviation'],
  ['typo', template(10, 10, wrongText), 'textMismatch'], ['color', template(10, 10, expectedText, '#FF0000'), 'colorMismatch'],
  ['corrected', template(), undefined], ['capability-blocked', template(10, 10, 'مرحبا'), 'textMismatch'],
];
const summary = [];
for (const [id, document, expected] of cases) {
  const directory = join(out, id); await mkdir(directory, { recursive: true });
  const result = await compareReference({ workspace: overlay(document), request, baseline, sample, includeImages: true });
  assert.ok(result.report);
  if (expected) assert.ok(result.report.anomalies.some((a) => a.kind === expected), id);
  else assert.deepEqual(result.report.anomalies, [], id);
  assert.equal(result.report.passed, false, '未测最终可见性，不能整体通过');
  if (id === 'skeleton') assert.deepEqual(result.render.problems, [], '骨架能渲染但必须报参考缺项');
  if (id === 'capability-blocked') {
    assert.ok(result.render.problems.some((p) => p.code === 'text.unshapedScript'));
    assert.equal((await render(overlay(document), { ...request, mode: 'final' })).image, undefined);
  }
  await save(join(directory, 'candidate.json'), document); await save(join(directory, 'report.json'), result.report);
  await save(join(directory, 'problems.json'), result.render.problems);
  await writeFile(join(directory, 'draft.png'), result.render.image.bytes);
  await writeFile(join(directory, 'content.png'), result.render.evidence.image.bytes);
  for (const panel of result.panels) await writeFile(join(directory, `${panel.regionId}.png`), panel.bytes);
  summary.push({ id, reportId: result.report.reportId, status: result.report.status, anomalies: result.report.anomalies.map((a) => a.kind) });
}
const low = await compareReference({ workspace: overlay(template(5)), request, baseline, sample });
const high = await compareReference({ workspace: overlay(template(5)), request: { ...request, output: { ...request.output, dpi: 100 } }, baseline, sample });
assert.deepEqual(low.report.anomalies, high.report.anomalies);
assert.notEqual(low.report.reportId, high.report.reportId);
assert.equal(summary[0].reportId, summary.find((s) => s.id === 'corrected').reportId, '同输入报告稳定');
await save(join(out, 'summary.json'), { command: 'node --import tsx scripts/accept-agent-visual.mjs', language, cases: summary, dpiInvariant: true,
  limitations: ['合成样本验证诊断方向，不证明真实模型任务成功率', '最终遮挡、对比度、复杂变换和未标注区域仍需审核', '未校准整体相似度或通过阈值'] });
console.log(`${language}：8 个场景及 DPI 对照通过：${out}`);
