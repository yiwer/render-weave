/** 经指定检出的公开入口核查票据 34；不修改该检出或其候选。 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, revision: { type: 'string' } }, strict: true });
if (!values.source || !values.out || !values.revision) throw new Error('需要 --source <归档源码目录> --revision <归档 commit> --out <新目录>');
const source = resolve(values.source), out = resolve(values.out);
const resources = resolve(import.meta.dirname, '../../fixtures/resources');
await mkdir(out);
const hash = s => createHash('sha256').update(s).digest('hex');
async function fingerprint(dir, prefix = '') {
  const result = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('归档不应含链接');
    if (entry.isDirectory()) result.push(...await fingerprint(join(dir, entry.name), prefix + entry.name + '/'));
    else result.push({ path: prefix + entry.name, sha256: hash(await readFile(join(dir, entry.name))) });
  }
  return result;
}
const sources = await fingerprint(join(source, 'src'));
const resourceHashes = await fingerprint(resources);
const api = await import(pathToFileURL(join(source, 'src/index.ts')).href);
const ws = await api.loadWorkspace({ dir: join(source, 'docs/examples/m402-dsl'), resourcesDir: resources });
const request = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 50, format: 'png' }, mode: 'final' };
const original = ws.templates.find(t => t.name === request.template).document;
const find = (n, name) => n.name === name ? n : n.children?.map(c => find(c, name)).find(Boolean);
async function renderVariant(name, mutate, dpi = 50) {
  const document = structuredClone(original); mutate(document);
  const actualRequest = { ...request, output: { ...request.output, dpi } };
  const result = await api.render({ ...ws, templates: ws.templates.map(t => t.name === request.template ? { ...t, document } : t) }, actualRequest);
  if (!result.image || result.problems.some(p => p.level === 'severe')) throw new Error('探针不能正常出图：' + name + JSON.stringify(result.problems));
  await writeFile(join(out, name + '.png'), result.image.bytes);
  return { document, request: actualRequest, layout: result.layout, operator: find(result.layout.root, '运营方') };
}
const good = await renderVariant('good', () => {});
const small = await renderVariant('small', d => { find(d.artboard, '运营方').fontSize = 4; });
const mixed = await renderVariant('mixed', d => { find(d.artboard, '运营方').content = [{ text: '巴士', fontSize: 5 }, { text: '集团' }]; });
const empty = await renderVariant('empty', d => { d.artboard.children = []; });
const highDpi = await renderVariant('good-100dpi', () => {}, 100);
const b = good.operator;
if (!b?.text || b.text.fontSize !== 8 || !mixed.operator.text.fragments.some(f => f.fontSize === 5)) throw new Error('探针未形成预定真实布局');
const baseline = { sampleWidthPx: good.layout.output.widthPx, sampleHeightPx: good.layout.output.heightPx, artboardWidthMm: 740, artboardHeightMm: 165,
  approvedRegions: [{ id: 'operator', name: '运营方', sampleRegion: { x: b.x * good.layout.output.widthPx / 740, y: b.y * good.layout.output.heightPx / 165,
    width: b.width * good.layout.output.widthPx / 740, height: b.height * good.layout.output.heightPx / 165 }, targetPathPattern: '*运营方', expectedFontSizeMm: 8 }] };
const verify = (v, base) => ({ request: v.request, ...api.verifyElementStyles({ layout: v.layout, baseline: base, ...api.hashCandidatesAndRequest([{ name: request.template, document: v.document }], v.request), parameters: v.request.parameters }) });
const summarize = (r) => r;
const missing = structuredClone(baseline); missing.approvedRegions[0].targetPathPattern = '*不存在的元素';
const boxOnly = structuredClone(baseline); delete boxOnly.approvedRegions[0].expectedFontSizeMm;
boxOnly.approvedRegions[0].sampleRegion.width = 50 * good.layout.output.widthPx / 740;
boxOnly.approvedRegions[0].sampleRegion.height = 20 * good.layout.output.heightPx / 165;
const shifted = structuredClone(baseline); shifted.approvedRegions[0].sampleRegion.x -= 100;
const rows = [
  { id: 'explicit-good', expectation: '明确 8 mm 基准，8 mm 应通过', ...summarize(verify(good, baseline)) },
  { id: 'explicit-small', expectation: '明确 8 mm 基准，4 mm 应检出', ...summarize(verify(small, baseline)) },
  { id: 'dpi-invariance', expectation: '相同毫米字号，100 DPI 不改变结论', ...summarize(verify(highDpi, baseline)) },
  { id: 'missing-target', expectation: '0 个参考区域匹配，不能宣称已核查通过', ...summarize(verify(good, missing)) },
  { id: 'mixed-fragments', expectation: '一个片段 5 mm、其他 8 mm，逐片段要求应检出', fragments: mixed.operator.text.fragments.map(f => ({ text: f.text, fontSize: f.fontSize })), ...summarize(verify(mixed, baseline)) },
  { id: 'box-is-not-font', expectation: '50×20 mm 标注框含留白，不能推断字号 19 mm', actualFontMm: 8, ...summarize(verify(good, boxOnly)) },
  { id: 'shifted-reference', expectation: '用于测量能力盘点：参考 x 变化应反映在位置诊断；当前接口未实现位置比较', ...summarize(verify(good, shifted)) },
  { id: 'empty-content', expectation: '空画板不得以 normal 状态已覆盖冒充文本/状态检查', ...summarize(verify(empty, baseline)) },
];
if (JSON.stringify(sources) !== JSON.stringify(await fingerprint(join(source, 'src')))) throw new Error('探针期间源码变化，结果无效');
if (JSON.stringify(resourceHashes) !== JSON.stringify(await fingerprint(resources))) throw new Error('探针期间资源变化，结果无效');
const report = { format: 'renderweave-style-baseline-probe/1', sourceCommit: values.revision, sources, resources: resourceHashes,
  moduleSha256: hash(await readFile(join(source, 'src/agent/style-verification.ts'))), baseline, rows,
  scope: '全部布局来自公开 render 的真实出图；反例用于核查代码判据，不是模型效果或人工盲评。原检出只读。' };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ sourceCommit: report.sourceCommit, rows: rows.map(r => ({ id: r.id, passed: r.passed, matched: r.coverage.approvedRegionsMatched, anomalies: r.anomalies.length, states: r.coverage.statesCovered })) }));
