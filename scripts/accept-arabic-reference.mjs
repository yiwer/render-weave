/** 原图标注后的离线诊断：保持旧候选原样，只在内存干预字号。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareReference, loadWorkspace } from '../src/index.ts';
import { startMcp } from '../test/support/mcp-client.ts';

const root = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-20');
const referenceDirectory = resolve(process.argv[3] ?? 'out/agent-reference-annotation');
const output = resolve(process.argv[4] ?? 'out/arabic-reference-comparison');
const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const baseline = await json(join(referenceDirectory, 'reference.json'));
const sample = { path: join(root, 'r3-template/agent/sample.png'), sha256: baseline.sampleSha256 };
const workspace = await loadWorkspace({ dir: join(root, 'workspace'), resourcesDir: join(root, 'resources') });
const request = await json(join(root, 'request-template.json'));
const directory = join(root, 'r3-template/agent/candidates');
const candidates = await Promise.all((await readdir(directory)).filter((f) => f.endsWith('.json')).map(async (f) => {
  const path = join(directory, f), bytes = await readFile(path), document = JSON.parse(bytes.toString());
  return { name: document.name, document, source: path, sha256: createHash('sha256').update(bytes).digest('hex') };
}));
const visit = (value, fn) => { if (!value || typeof value !== 'object') return; fn(value); for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach((c) => visit(c, fn)); else if (child && typeof child === 'object') visit(child, fn); } };
await mkdir(output, { recursive: true });
const summary = [];
for (const scenario of [{ id: 'original' }, { id: 'arabic-double', double: true }, { id: 'dpi-100', dpi: 100 }]) {
  const templates = structuredClone(candidates);
  if (scenario.double) templates.forEach((t) => visit(t.document, (v) => {
    if (v.type === 'text' && v.name === '站点阿文名') {
      v.fontSize *= 2;
      // 状态覆盖是独立字号；一起同比干预，避免只改默认值后误报“所有状态已改”。
      for (const state of Object.values(v.states?.cases ?? {})) if (state && typeof state === 'object' && typeof state.fontSize === 'number') state.fontSize *= 2;
    }
  }));
  const result = await compareReference({ workspace: { ...workspace, templates }, request: { ...request, output: { ...request.output, dpi: scenario.dpi ?? request.output.dpi } },
    baseline, sample, regions: ['stop-1-ar', 'stop-6-ar', 'stop-16-ar'], includeImages: true });
  assert.ok(result.report); assert.equal(result.report.status, 'needsWork'); assert.equal(result.report.coverage.approvedRegionsMatched, baseline.approvedRegions.length);
  const arabic = result.report.regions.filter((r) => /^stop-\d+-ar$/.test(r.id));
  assert.equal(arabic.length, 16); assert.ok(arabic.every((r) => r.instances.length === 1));
  const heights = arabic.map((r) => ({ id: r.id, state: r.state, actualFontSizeMm: r.instances[0].fontSizeMm, referenceInkHeightMm: r.referenceBoxMm.height,
    candidateInkHeightMm: r.instances[0].box?.height, heightRatio: r.instances[0].sizeRatio?.height, source: r.instances[0].sourceLocation }));
  const count = {};
  for (const anomaly of result.report.anomalies) count[anomaly.kind] = (count[anomaly.kind] ?? 0) + 1;
  const folder = join(output, scenario.id); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'report.json'), JSON.stringify(result.report, null, 2));
  await writeFile(join(folder, 'problems.json'), JSON.stringify(result.render.problems, null, 2));
  await writeFile(join(folder, 'content.png'), result.render.evidence.image.bytes);
  for (const panel of result.panels) await writeFile(join(folder, `${panel.regionId}.png`), panel.bytes);
  summary.push({ id: scenario.id, reportId: result.report.reportId, coverage: result.report.coverage, counts: count, heights,
    severeCodes: [...new Set(result.render.problems.filter((p) => p.level === 'severe').map((p) => p.code))] });
}
assert.deepEqual(summary[0].heights, summary[2].heights, 'DPI 不得改变物理诊断');
assert.ok(summary[0].heights.every((h) => h.heightRatio < 0.8), '本次旧候选16个站名均小于原图墨迹高度80%');
assert.ok(summary[1].heights.find((h) => h.id === 'stop-1-ar').heightRatio > summary[0].heights.find((h) => h.id === 'stop-1-ar').heightRatio);
for (const entry of candidates) assert.equal(createHash('sha256').update(await readFile(entry.source)).digest('hex'), entry.sha256, '旧候选不得改写');
const agentDir = join(output, 'mcp-agent'); await mkdir(join(agentDir, 'candidates'), { recursive: true });
const paths = [];
for (const [index, entry] of candidates.entries()) { const path = `candidates/template-${index}.json`; paths.push(path); await copyFile(entry.source, join(agentDir, path)); }
await writeFile(join(agentDir, 'outcome.json'), JSON.stringify({ candidates: paths, pending: [], notes: '只读离线验证原候选' }));
const context = join(output, 'mcp-context.json'); await writeFile(context, JSON.stringify({ task: 'template-design', request, baseline, referenceImage: sample }));
const session = startMcp(['--workspace', join(root, 'workspace'), '--resources', join(root, 'resources'), '--root', agentDir, '--outcome-context', context]);
const mcp = [];
const catalog = [];
try {
  await session.request('initialize', { protocolVersion: '2025-06-18' });
  for (const name of ['compare_reference', 'check_outcome']) {
    const result = await session.call(name), text = result.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    mcp.push({ name, isError: result.isError, chars: text.length, images: result.content.filter((c) => c.type === 'image').length });
    await writeFile(join(output, `${name}.json`), text);
    assert.equal(result.isError, false, `${name}: ${text}`); assert.ok(text.length <= 40000);
  }
  let offset = 0;
  while (offset !== null) {
    const page = await session.callJson('compare_reference', { regionOffset: offset });
    assert.ok(JSON.stringify(page).length <= 40000);
    assert.equal(page.coverage.approvedRegionsMatched, 86);
    assert.ok(page.regionCatalog.length > 0);
    assert.equal(page.panels[0].regionId, page.regionCatalog[0].id);
    catalog.push(...page.regionCatalog.map((region) => region.id));
    if (page.nextRegionOffset !== null) assert.ok(page.nextRegionOffset > offset);
    offset = page.nextRegionOffset;
  }
  assert.deepEqual(catalog, baseline.approvedRegions.map((region) => region.id), '模型必须能逐页发现全部参考ID');
} finally { await session.close(); }
await writeFile(join(output, 'summary.json'), JSON.stringify({ inputCandidates: candidates.map(({ document, ...entry }) => entry), summary,
  mcp, catalog,
  limits: ['字号翻倍是因果干预，非确认11mm正确', '阿拉伯文塑形仍受阻，无法整体视觉通过', '参考来自独立原图标注，尚非客户审核', '颜色精确差异仅作诊断，未校准感知阈值'] }, null, 2));
console.log(JSON.stringify(summary.map(({ heights, ...rest }) => ({ ...rest, inkHeightRatios: heights.map((h) => Number(h.heightRatio?.toFixed(3))) })), null, 2));
