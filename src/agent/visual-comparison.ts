/** 同一比较操作供 MCP、交回检查和宿主复核使用。 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadCanvasKit } from '../canvaskit.js';
import { rendererBuildId } from '../renderer-build.js';
import { render, type RenderResult } from '../render.js';
import { parseRenderRequest } from '../request.js';
import type { Workspace } from '../workspace.js';
import { ToolInputError } from '../mcp/files.js';
import { digest, hashCandidatesAndRequest, validateReferenceBaseline, verifyElementStyles, type ReferenceBaseline, type StyleVerificationRecord, type ReferenceBox } from './style-verification.js';

export interface ReferenceImage { readonly path: string; readonly sha256: string }
export interface VisualReport extends StyleVerificationRecord {
  readonly reportId: string;
  readonly provenance: { readonly algorithm: string; readonly engine: string; readonly workspace: string; readonly referenceImage: string | null; readonly resources: Readonly<Record<string, string>> };
  readonly sourceFiles: Readonly<Record<string, string>>;
}
export interface ComparisonPanel {
  readonly regionId: string; readonly bytes: Uint8Array;
  readonly transform: { readonly boardMm: ReferenceBox; readonly sourcePx: ReferenceBox; readonly candidatePx: ReferenceBox; readonly panelWidth: number; readonly panelHeight: number };
}
let engine: Promise<string> | undefined;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function compareReference(options: {
  readonly workspace: Workspace; readonly request: unknown; readonly baseline?: ReferenceBaseline;
  readonly sample?: ReferenceImage; readonly regions?: readonly string[]; readonly includeImages?: boolean;
}): Promise<{ readonly render: RenderResult; readonly report?: VisualReport; readonly panels: readonly ComparisonPanel[] }> {
  const { workspace, baseline } = options;
  if (baseline !== undefined && !validateReferenceBaseline(baseline)) throw new ToolInputError('参考基准格式无效');
  if (options.regions?.some((id) => !baseline?.approvedRegions.some((r) => r.id === id))) throw new ToolInputError('regions 包含参考清单中不存在的区域 ID');
  const parsed = parseRenderRequest(options.request);
  if (!parsed.request) return { render: { problems: parsed.problems }, panels: [] };
  const request = parsed.request;
  const reads = new Map<string, Promise<Uint8Array>>(), hashes: Record<string, string> = {};
  const resources = {
    get: (id: string) => workspace.resources.get(id), list: () => workspace.resources.list(),
    read: (id: string) => {
      let promise = reads.get(id);
      if (!promise) { promise = workspace.resources.read(id).then((bytes) => { const copy = Uint8Array.from(bytes); hashes[id] = sha(copy); return copy; }); reads.set(id, promise); }
      return promise;
    },
  };
  let reference: Uint8Array | undefined;
  if (options.sample) {
    reference = await readFile(options.sample.path);
    if (sha(reference) !== options.sample.sha256 || baseline?.sampleSha256 && baseline.sampleSha256 !== options.sample.sha256) throw new ToolInputError('参考图片内容已改变，旧基准不可使用');
    if (baseline) {
      const ck = await loadCanvasKit(), image = ck.MakeImageFromEncoded(reference);
      if (!image) throw new ToolInputError('参考图片无法解码');
      try { if (image.width() !== baseline.sampleWidthPx || image.height() !== baseline.sampleHeightPx) throw new ToolInputError('参考图片像素尺寸与核准基准不一致'); }
      finally { image.delete(); }
    }
  }
  const result = await render({ ...workspace, resources }, { ...request, mode: 'draft' }, { comparisonEvidence: true });
  const evidence = result.evidence;
  if (!evidence) return { render: result, panels: [] };
  const verification = verifyElementStyles({ layout: evidence.layout, baseline, evidence, resourceHashes: hashes,
    ...hashCandidatesAndRequest(workspace.templates, request), parameters: request.parameters });
  const provenance = { algorithm: 'reference-comparison/2', engine: await (engine ??= rendererBuildId()),
    workspace: digest({ templates: workspace.templates.map(({ name, document }) => ({ name, document })).sort((a, b) => a.name.localeCompare(b.name)),
      datasets: workspace.datasets.map(({ id, document }) => ({ id, document })).sort((a, b) => a.id.localeCompare(b.id)), schemas: workspace.staticSchemas, request }),
    referenceImage: reference ? sha(reference) : null, resources: Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b))) };
  const sourceFiles = Object.fromEntries(workspace.templates.filter((t) => t.source).map((t) => [t.name, t.source!]));
  const report: VisualReport = { ...verification, reportId: digest({ provenance, baseline, verification }), provenance, sourceFiles };
  const panels: ComparisonPanel[] = [];
  if (options.includeImages && reference && baseline && report.reason !== 'alignmentUnknown') {
    const selected = options.regions ?? [...new Set([...report.anomalies.map((a) => a.regionId), ...baseline.approvedRegions.map((r) => r.id)])];
    for (const id of selected.slice(0, 3)) {
      const region = report.regions.find((r) => r.id === id);
      if (region) panels.push(await makePanel(reference, evidence.image.bytes, region.referenceBoxMm, baseline, evidence.image.widthPx, evidence.image.heightPx, id));
    }
    if (!baseline.approvedRegions.length) panels.push(await makePanel(reference, evidence.image.bytes,
      { x: 0, y: 0, width: baseline.artboardWidthMm, height: baseline.artboardHeightMm }, baseline, evidence.image.widthPx, evidence.image.heightPx, 'overview'));
  }
  return { render: result, report, panels };
}

async function makePanel(reference: Uint8Array, candidate: Uint8Array, region: ReferenceBox, baseline: ReferenceBaseline, width: number, height: number, id: string): Promise<ComparisonPanel> {
  const ck = await loadCanvasKit(), ref = ck.MakeImageFromEncoded(reference), image = ck.MakeImageFromEncoded(candidate);
  if (!ref || !image) { ref?.delete(); image?.delete(); throw new ToolInputError('比较图片无法解码'); }
  const padding = Math.max(2, Math.min(region.width, region.height) * 0.2);
  const x = Math.max(0, region.x - padding), y = Math.max(0, region.y - padding);
  const crop = { x, y, width: Math.min(baseline.artboardWidthMm, region.x + region.width + padding) - x, height: Math.min(baseline.artboardHeightMm, region.y + region.height + padding) - y };
  const board = baseline.boardRegion ?? { x: 0, y: 0, width: ref.width(), height: ref.height() };
  const source = { x: board.x + crop.x * board.width / baseline.artboardWidthMm, y: board.y + crop.y * board.height / baseline.artboardHeightMm, width: crop.width * board.width / baseline.artboardWidthMm, height: crop.height * board.height / baseline.artboardHeightMm };
  const target = { x: crop.x * width / baseline.artboardWidthMm, y: crop.y * height / baseline.artboardHeightMm, width: crop.width * width / baseline.artboardWidthMm, height: crop.height * height / baseline.artboardHeightMm };
  const scale = Math.min(560 / crop.width, 560 / crop.height), w = Math.max(1, Math.round(crop.width * scale)), h = Math.max(1, Math.round(crop.height * scale));
  const surface = ck.MakeSurface(w * 3, h);
  if (!surface) { ref.delete(); image.delete(); throw new ToolInputError('比较图片无法创建'); }
  const paint = new ck.Paint();
  try {
    const canvas = surface.getCanvas(); canvas.clear(ck.WHITE);
    const rect = (b: ReferenceBox) => ck.XYWHRect(b.x, b.y, b.width, b.height);
    canvas.drawImageRectOptions(ref, rect(source), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    canvas.drawImageRectOptions(image, rect(target), ck.XYWHRect(w, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    canvas.drawImageRectOptions(ref, rect(source), ck.XYWHRect(w * 2, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    paint.setAlphaf(0.5);
    canvas.drawImageRectOptions(image, rect(target), ck.XYWHRect(w * 2, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    const snapshot = surface.makeImageSnapshot();
    try { const bytes = snapshot.encodeToBytes(); if (!bytes) throw new ToolInputError('比较图片编码失败'); return { regionId: id, bytes,
      transform: { boardMm: crop, sourcePx: source, candidatePx: target, panelWidth: w, panelHeight: h } }; }
    finally { snapshot.delete(); }
  } finally { paint.delete(); surface.dispose(); image.delete(); ref.delete(); }
}

/** 保持文字预算：完整报告由宿主保存；工具只返回摘要和可继续查询的区域。 */
export function visualRegionPage(regions: readonly Pick<ReferenceBaseline['approvedRegions'][number], 'id' | 'name' | 'state'>[], offset = 0) {
  const catalog = regions.slice(offset, offset + 20).map((r) => ({ id: r.id, name: r.name.slice(0, 120), ...(r.state ? { state: r.state } : {}) }));
  while (JSON.stringify(catalog).length > 3000 && catalog.length > 1) catalog.pop();
  return { regionCatalog: catalog, regionOffset: offset, nextRegionOffset: offset + catalog.length < regions.length ? offset + catalog.length : null };
}

export function summarizeVisual(report: VisualReport, regionIds?: readonly string[], catalogOffset?: number) {
  const page = catalogOffset === undefined ? undefined : visualRegionPage(report.regions, catalogOffset);
  const selectedIds = regionIds ?? page?.regionCatalog.map((r) => r.id);
  const selected = report.regions.filter((r) => !selectedIds || selectedIds.includes(r.id));
  const anomalies = report.anomalies.filter((a) => !selectedIds || selectedIds.includes(a.regionId));
  const regions = selected.slice(0, 20).map((r) => ({ ...r, instancesTotal: r.instances.length, instances: r.instances.slice(0, 3).map((i) => ({ ...i, text: i.text?.slice(0, 120) })) }));
  const result = { reportId: report.reportId, status: report.status, reason: report.reason, coverage: report.coverage,
    anomalies: anomalies.slice(0, 20), anomaliesTotal: report.anomalies.length,
    regions, regionsTotal: report.regions.length, sourceFiles: Object.fromEntries(Object.entries(report.sourceFiles).filter(([name]) => regions.some((r) => r.instances.some((i) => i.sourceLocation?.template === name)))), partialDetails: anomalies.length > 20 || selected.length > regions.length || selected.some((r) => r.instances.length > 3),
    scope: regionIds ?? 'all', ...page,
    note: '数值仅描述核准范围；最终可见性和内容仍需审核。局部图从左到右为参考、候选、半透明叠图。' };
  while (JSON.stringify(result).length > 10000 && (result.regions.length || result.anomalies.length)) {
    result.partialDetails = true;
    if (result.regions.length) result.regions.pop(); else result.anomalies.pop();
    for (const name of Object.keys(result.sourceFiles)) if (!result.regions.some((r) => r.instances.some((i) => i.sourceLocation?.template === name))) delete result.sourceFiles[name];
  }
  return result;
}
