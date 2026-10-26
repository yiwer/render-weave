import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareReference, loadWorkspace, render, verifyElementStyles, type ReferenceBaseline, type Workspace, type RenderRequest } from '../src/index.js';
import { m402Dir, resourcesDir, textLab, textLabRequest } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

const template = (fontSize = 10, left = 10, text = '科技园') => ({ dslVersion: 'renderweave-template/1', name: '对照', base: { name: '空数据定义', version: 1 },
  artboard: { fill: '#FFFFFF', sizeRange: { width: { min: 10, max: 200 }, height: { min: 10, max: 200 } }, layout: { mode: 'free' }, children: [
    { type: 'text', name: '站名', content: [{ text }], font: 'res:font-hei-medium', fontSize, color: '#000000', place: { left, top: 10, width: { fixed: 60 }, height: { fixed: 30 } } },
  ] } });
const request: RenderRequest = { template: '对照', dataset: { inline: { dataset: { staticSchema: { name: '空数据定义', version: 1 } }, data: {} } }, parameters: {}, output: { width: 100, height: 60, dpi: 50, format: 'png' }, mode: 'draft' };
let workspace: Workspace, root: string, baseline: ReferenceBaseline, sample: { path: string; sha256: string };
const overlay = (document: unknown): Workspace => ({ ...workspace, templates: [...workspace.templates, { name: '对照', document, source: 'candidates/main.json' }] });

beforeAll(async () => {
  workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  root = await mkdtemp(join(tmpdir(), 'rw-visual-'));
  await mkdir(join(root, 'candidates'));
  const result = await render(overlay(template()), request, { comparisonEvidence: true });
  expect(result.problems).toEqual([]);
  const ink = result.evidence!.nodes.find((n) => n.path === '对照/站名')!.inkBounds!;
  const bytes = result.evidence!.image.bytes;
  sample = { path: join(root, 'reference.png'), sha256: createHash('sha256').update(bytes).digest('hex') };
  await writeFile(sample.path, bytes);
  const sx = result.image!.widthPx / request.output.width, sy = result.image!.heightPx / request.output.height;
  baseline = { sampleWidthPx: result.image!.widthPx, sampleHeightPx: result.image!.heightPx, artboardWidthMm: 100, artboardHeightMm: 60, sampleSha256: sample.sha256,
    approvedRegions: [{ id: 'stop-name', name: '站名', sampleRegion: { x: ink.x * sx, y: ink.y * sy, width: ink.width * sx, height: ink.height * sy },
      boxKind: 'ink', targetPathPattern: '对照/站名', expectedText: '科技园', expectedFontSizeMm: 10, expectedColor: '#000000', state: 'normal' }] };
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('参考比较的反例与闭环', () => {
  it('多区域视觉诊断与严重渲染问题共享输出预算，最终检查仍可读取', async () => {
    const dir = join(root, 'large'); await mkdir(join(dir, 'candidates'), { recursive: true });
    const many = template();
    many.artboard.children = Array.from({ length: 100 }, (_, i) => ({ ...template(5, 10, 'مرحبا').artboard.children[0]!, name: `站名-${i}` }));
    await writeFile(join(dir, 'candidates/main.json'), JSON.stringify(many));
    await writeFile(join(dir, 'outcome.json'), JSON.stringify({ candidates: ['candidates/main.json'], pending: [], notes: '大批量差异复现' }));
    const context = join(root, 'large-context.json');
    await writeFile(context, JSON.stringify({ task: 'template-design', request, baseline: { ...baseline, approvedRegions: Array.from({ length: 100 }, (_, i) => ({ ...baseline.approvedRegions[0], id: `stop-${i}`, targetPathPattern: `对照/站名-${i}` })) }, referenceImage: sample }));
    const session = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', dir, '--outcome-context', context]);
    try {
      await session.request('initialize', { protocolVersion: '2025-06-18' });
      const result = await session.call('check_outcome');
      expect(result.isError).toBe(false);
      const text = result.content.find((c) => c.type === 'text')! as { text: string };
      expect(text.text.length).toBeLessThanOrEqual(40000);
      const checked = JSON.parse(text.text);
      expect(checked.verdict).toBe('unqualified'); expect(checked.assessment.render.capabilityBlocked).toBe(true);
      expect(checked.assessment.visual.anomaliesTotal).toBeGreaterThan(100);
      expect(checked.problemsTruncated.total).toBeGreaterThan(checked.problems.length);
      expect(checked.assessment.render.problemsTruncated.byCode['text.unshapedScript']).toBe(100);
      const ids: string[] = [];
      let offset: number | null = 0;
      while (offset !== null) {
        const page = await session.callJson('compare_reference', { regionOffset: offset });
        expect(JSON.stringify(page).length).toBeLessThanOrEqual(40000);
        expect(page.reportId).toBe(checked.assessment.visual.reportId);
        expect(page.coverage.approvedRegionsTotal).toBe(100);
        expect(page.regionCatalog.length).toBeGreaterThan(0);
        expect(page.panels[0].regionId).toBe(page.regionCatalog[0].id);
        ids.push(...page.regionCatalog.map((region: { id: string }) => region.id));
        if (page.nextRegionOffset !== null) expect(page.nextRegionOffset).toBeGreaterThan(offset!);
        offset = page.nextRegionOffset;
      }
      expect(ids).toEqual(Array.from({ length: 100 }, (_, i) => `stop-${i}`));
      const last = await session.callJson('compare_reference', { regions: [ids.at(-1)] });
      expect(last.regions.map((region: { id: string }) => region.id)).toEqual(['stop-99']);
      expect((await session.call('compare_reference', { regionOffset: 20, regions: ['stop-99'] })).isError).toBe(true);
    } finally { await session.close(); }
  });
  it('目录因长ID压缩时，图片只取当前目录页内的区域', async () => {
    const dir = join(root, 'catalog'); await mkdir(join(dir, 'candidates'), { recursive: true });
    await writeFile(join(dir, 'candidates/main.json'), JSON.stringify(template(5)));
    const longRegions = Array.from({ length: 3 }, (_, index) => ({ ...baseline.approvedRegions[0]!, id: `${index}-${'x'.repeat(2050)}` }));
    const context = join(root, 'catalog-context.json');
    await writeFile(context, JSON.stringify({ task: 'template-design', request, baseline: { ...baseline, approvedRegions: longRegions }, referenceImage: sample }));
    const session = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', dir, '--outcome-context', context]);
    try {
      await session.request('initialize', { protocolVersion: '2025-06-18' });
      const page = await session.callJson('compare_reference', { templates: ['candidates/main.json'], regionOffset: 1 });
      expect(page.regionCatalog.map((r: { id: string }) => r.id)).toEqual([longRegions[1]!.id]);
      expect(page.panels.map((p: { regionId: string }) => p.regionId)).toEqual([longRegions[1]!.id]);
      expect(page.nextRegionOffset).toBe(2); expect(page.coverage.approvedRegionsTotal).toBe(3);
    } finally { await session.close(); }
  });
  it('无参考不通过；无匹配不通过；不从框高估计字号', async () => {
    const rendered = await render(overlay(template()), request);
    const plain = verifyElementStyles({ layout: rendered.layout!, candidatesHash: 'c', requestHash: 'r' });
    expect(plain.status).toBe('notChecked'); expect(plain.passed).toBe(false); expect(plain.coverage.statesCovered).toEqual([]);
    const uncalibrated = { ...baseline, approvedRegions: [{ id: 'untyped', name: '未知框', targetPathPattern: '对照/站名', sampleRegion: { x: 0, y: 0, width: 100, height: 100 } }] };
    const measured = await compareReference({ workspace: overlay(template()), request, baseline: uncalibrated });
    expect(measured.report?.anomalies).toEqual([]); expect(measured.report?.passed).toBe(false);
    expect(measured.report?.regions[0]?.status).toBe('unknown');
  });
  it('空骨架、字号减半、平移、错字都定位到对应区域', async () => {
    const empty = template(); empty.artboard.children = [];
    for (const [document, expected] of [[empty, 'missingRegion'], [template(5), 'fontSizeTooSmall'], [template(10, 16), 'positionDeviation'], [template(10, 10, '科枝园'), 'textMismatch']] as const) {
      const result = await compareReference({ workspace: overlay(document), request, baseline, sample });
      expect(result.report?.anomalies.some((a) => a.kind === expected && a.regionId === 'stop-name')).toBe(true);
      expect(result.report?.status).toBe('needsWork');
    }
    const normal = await compareReference({ workspace: overlay(template()), request, baseline, sample, includeImages: true });
    expect(normal.report?.anomalies).toEqual([]);
    expect(normal.report?.regions[0]?.instances[0]?.sourceLocation).toEqual({ template: '对照', path: '对照/站名' });
    expect(normal.report?.sourceFiles['对照']).toBe('candidates/main.json');
    expect(normal.panels).toHaveLength(1);
    expect(normal.panels[0]?.transform.panelWidth).toBeGreaterThan(0);
  });
  it('按实际文字片段字号比较，空锚点仍给未校准总览', async () => {
    const vertical = template();
    const node = { ...vertical.artboard.children[0]!, writingMode: 'vertical', content: [{ text: '科技园', fontSize: 5 }] };
    const small = await compareReference({ workspace: overlay({ ...vertical, artboard: { ...vertical.artboard, children: [node] } }), request, baseline, sample });
    expect(small.report?.anomalies.some((a) => a.kind === 'fontSizeTooSmall' && a.actualMm === 5)).toBe(true);
    expect(small.report?.regions[0]?.instances[0]?.fontSizeMm).toBe(5);
    const overview = await compareReference({ workspace: overlay(template()), request, baseline: { ...baseline, approvedRegions: [] }, sample, includeImages: true });
    expect(overview.report?.status).toBe('notChecked'); expect(overview.panels[0]?.regionId).toBe('overview');
    const color = template(); color.artboard.children[0]!.color = '#FF0000';
    expect((await compareReference({ workspace: overlay(color), request, baseline, sample })).report?.anomalies.some((a) => a.kind === 'colorMismatch')).toBe(true);
  });
  it('真实内容的文字证据排除草稿占位', async () => {
    const lab = await textLab([{ name: 'name', displayName: '站名', type: 'text', constraints: { required: true } }], { children: [
      { type: 'text', name: '站名', font: 'res:font-hei-regular', fontSize: 5, content: [{ slot: 'name' }], color: '#222222', place: { left: 5, top: 5, width: { fixed: 30 }, height: { fixed: 10 } } },
    ] });
    const result = await render(lab, { ...textLabRequest({}, 100, 60, 50), mode: 'draft' }, { comparisonEvidence: true });
    expect(JSON.stringify(result.layout)).toContain('〔站名〕');
    expect(JSON.stringify(result.evidence!.layout)).not.toContain('〔站名〕');
    expect(result.evidence!.nodes.every((n) => !n.inkBounds)).toBe(true);
  });
  it('DPI 不改变毫米诊断；报告绑定实际资源、数据、请求和参考', async () => {
    const first = await compareReference({ workspace: overlay(template(5)), request, baseline, sample });
    const again = await compareReference({ workspace: overlay(template(5)), request, baseline, sample });
    expect(again.report?.reportId).toBe(first.report?.reportId);
    const high = await compareReference({ workspace: overlay(template(5)), request: { ...request, output: { ...request.output, dpi: 100 } }, baseline, sample });
    expect(high.report?.anomalies).toEqual(first.report?.anomalies);
    expect(high.report?.reportId).not.toBe(first.report?.reportId);
    const changed = { ...overlay(template(5)), resources: { ...workspace.resources, get: workspace.resources.get.bind(workspace.resources), list: workspace.resources.list.bind(workspace.resources), read: (id: string) => workspace.resources.read(id === 'font-hei-medium' ? 'font-hei-bold' : id) } };
    const resourceChanged = await compareReference({ workspace: changed, request, baseline, sample });
    expect(resourceChanged.report?.provenance.resources['font-hei-medium']).not.toBe(first.report?.provenance.resources['font-hei-medium']);
    await expect(compareReference({ workspace: overlay(template()), request, baseline, sample: { ...sample, sha256: '0'.repeat(64) } })).rejects.toThrow('已改变');
    const aspect = await compareReference({ workspace: overlay(template()), request, baseline: { ...baseline, artboardWidthMm: 80 } });
    expect(aspect.report?.reason).toBe('alignmentUnknown');
  });
  it('真实内容证据不包含草稿边框，正式出图仍阻断已知能力问题', async () => {
    const broken = overlay(template(10, 10, 'مرحبا'));
    const draft = await render(broken, request, { comparisonEvidence: true });
    expect(draft.problems.some((p) => p.code === 'text.unshapedScript')).toBe(true);
    expect(Buffer.from(draft.evidence!.image.bytes).equals(Buffer.from(draft.image!.bytes))).toBe(false);
    const final = await render(broken, { ...request, mode: 'final' }, { comparisonEvidence: true });
    expect(final.image).toBeUndefined(); expect(final.evidence).toBeUndefined();
  });
  it('重复实例有实际源模板路径，但不能只凭数量声称状态样式已验证', async () => {
    const m402 = await render(workspace, { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 20, format: 'png' }, mode: 'draft' }, { comparisonEvidence: true });
    const repeated = m402.evidence!.nodes.filter((n) => /\[\d+\]/.test(n.path) && n.inkBounds);
    expect(repeated.length).toBeGreaterThan(30);
    expect(repeated.every((n) => n.source && !n.source.path.includes('['))).toBe(true);
    const v = verifyElementStyles({ layout: m402.layout!, candidatesHash: 'c', requestHash: 'r', parameters: { currentIndex: 5 } });
    expect(v.coverage.statesCovered).toEqual([]);
  });
  it('经 MCP 比较与 check_outcome 看到相同报告，改候选后复检有 resolved 反馈', async () => {
    await writeFile(join(root, 'candidates/main.json'), JSON.stringify(template(5)));
    await writeFile(join(root, 'outcome.json'), JSON.stringify({ candidates: ['candidates/main.json'], pending: [], notes: '初稿' }));
    const context = join(root, 'context.json');
    await writeFile(context, JSON.stringify({ task: 'template-design', request: { ...request, mode: 'final' }, baseline, referenceImage: sample }));
    const session = startMcp(['--workspace', m402Dir, '--resources', resourcesDir, '--root', root, '--outcome-context', context]);
    try {
      await session.request('initialize', { protocolVersion: '2025-06-18' });
      const compared = await session.callJson('compare_reference');
      const checked = await session.callJson('check_outcome');
      expect(compared.reportId).toBe(checked.assessment.visual.reportId);
      expect(checked.assessment.visual.status).toBe('needsWork');
      await writeFile(join(root, 'candidates/main.json'), JSON.stringify(template()));
      const fixed = await session.callJson('compare_reference', { regions: ['stop-name'] });
      expect(fixed.changes.resolved).toBeGreaterThan(0); expect(fixed.anomaliesTotal).toBe(0);
      expect(fixed.reportId).not.toBe(compared.reportId);
      expect((await session.call('compare_reference', { regions: ['fake'] })).isError).toBe(true);
    } finally { await session.close(); }
    expect(JSON.parse(await readFile(context, 'utf8')).baseline).toEqual(baseline);
  });
});
