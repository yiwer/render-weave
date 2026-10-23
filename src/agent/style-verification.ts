/** 核准参考与候选布局的多维测量；未测量不能当作通过。 */
import { createHash } from 'node:crypto';
import type { LayoutNode, LayoutSummary } from '../layout/index.js';
import type { RenderRequest } from '../request.js';
import type { RenderEvidence } from '../render.js';
import { isRecord } from '../util.js';

export interface ReferenceBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type BusinessState = 'normal' | 'current' | 'passed' | 'terminal' | 'longestText';
export interface ApprovedRegion {
  readonly id: string; readonly name: string; readonly sampleRegion: ReferenceBox;
  readonly targetPathPattern?: string; readonly targetText?: string; readonly role?: string;
  /** 不指定框类型时不比较几何；字号只接受显式核准值。 */
  readonly boxKind?: 'layout' | 'ink';
  readonly expectedFontSizeMm?: number; readonly expectedText?: string; readonly expectedColor?: string;
  /** 操作者核准的图片资源原始内容摘要，不从候选或资源名称生成预期值。 */
  readonly expectedImageSha256?: string;
  readonly toleranceRatio?: { readonly min?: number; readonly max?: number };
  readonly positionToleranceMm?: number;
  /** 同一独立样式的重复项只比尺寸，不把每个实例拉到代表项位置。 */
  readonly repeat?: boolean;
  readonly state?: BusinessState;
}
export interface ReferenceBaseline {
  readonly sampleWidthPx: number; readonly sampleHeightPx: number;
  readonly artboardWidthMm: number; readonly artboardHeightMm: number;
  readonly boardRegion?: ReferenceBox;
  readonly sampleSha256?: string;
  readonly complete?: boolean;
  readonly approvedRegions: readonly ApprovedRegion[];
}
export interface StyleAnomaly {
  readonly kind: 'fontSizeTooSmall' | 'fontSizeTooLarge' | 'missingRegion' | 'sizeDeviation' | 'positionDeviation' | 'textMismatch' | 'colorMismatch' | 'contentInvisible' | 'imageContentMismatch';
  readonly path: string; readonly regionId: string; readonly elementRole?: string;
  readonly actualMm?: number; readonly expectedMm?: number; readonly ratio?: number; readonly message: string;
}
export interface RegionMeasurement {
  readonly id: string; readonly name: string; readonly state?: BusinessState;
  readonly status: 'measured' | 'missing' | 'ambiguous' | 'unknown';
  readonly referenceBoxMm: ReferenceBox;
  readonly instances: readonly {
    readonly path: string; readonly sourceLocation?: { readonly template: string; readonly path: string };
    readonly fontSizeMm?: number; readonly fontSizesMm?: readonly number[]; readonly text?: string; readonly colors?: readonly string[];
    readonly box?: ReferenceBox; readonly deltaMm?: { readonly x: number; readonly y: number };
    readonly sizeRatio?: { readonly width: number; readonly height: number };
    readonly visibility?: RenderEvidence['nodes'][number]['visibility'];
    readonly imageContent?: { readonly status: 'matches' | 'mismatch' | 'notChecked'; readonly sha256?: string };
    readonly unknown: readonly string[];
  }[];
}
export interface StyleVerificationRecord {
  readonly format: 'renderweave-style-verification/3';
  readonly candidatesHash: string; readonly requestHash: string; readonly baselineHash: string; readonly valid: boolean;
  readonly status: 'notChecked' | 'needsWork' | 'needsReview'; readonly reason?: string;
  readonly physicalScale: { readonly pxPerMmh: number; readonly pxPerMmv: number };
  readonly coverage: { readonly approvedRegionsTotal: number; readonly approvedRegionsMatched: number;
    readonly repeatedInstancesScanned: number; readonly statesCovered: readonly BusinessState[]; readonly statesMeasured: readonly BusinessState[]; readonly unknownRegions: number; readonly complete: boolean };
  readonly regions: readonly RegionMeasurement[]; readonly anomalies: readonly StyleAnomaly[]; readonly passed: boolean;
}
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function hashCandidatesAndRequest(candidates: readonly { readonly name?: string; readonly document: unknown }[], request: RenderRequest) {
  return { candidatesHash: digest(candidates.map((c) => ({ name: c.name, doc: c.document })).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))), requestHash: digest(request) };
}
export function isVerificationValid(record: StyleVerificationRecord, candidatesHash: string, requestHash: string, baselineHash?: string): boolean {
  return record.valid && record.candidatesHash === candidatesHash && record.requestHash === requestHash && record.baselineHash === baselineHash;
}
export function matchPath(pattern: string, path: string): boolean {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(path);
}
function box(value: unknown): value is ReferenceBox {
  return isRecord(value) && ['x', 'y', 'width', 'height'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k])) &&
    Number(value['x']) >= 0 && Number(value['y']) >= 0 && Number(value['width']) > 0 && Number(value['height']) > 0;
}
export function validateReferenceBaseline(value: unknown): value is ReferenceBaseline {
  if (!isRecord(value) || !['sampleWidthPx', 'sampleHeightPx', 'artboardWidthMm', 'artboardHeightMm'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k]) && Number(value[k]) > 0) || !Array.isArray(value['approvedRegions'])) return false;
  if (value['sampleSha256'] !== undefined && (typeof value['sampleSha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(value['sampleSha256']))) return false;
  if (value['complete'] !== undefined && typeof value['complete'] !== 'boolean') return false;
  if (value['boardRegion'] !== undefined && !box(value['boardRegion'])) return false;
  const board = (value['boardRegion'] ?? { x: 0, y: 0, width: value['sampleWidthPx'], height: value['sampleHeightPx'] }) as ReferenceBox;
  if (board.x + board.width > Number(value['sampleWidthPx']) || board.y + board.height > Number(value['sampleHeightPx'])) return false;
  const ids = new Set<string>();
  return value['approvedRegions'].every((r: unknown) => {
    if (!isRecord(r) || typeof r['id'] !== 'string' || !r['id'] || ids.has(r['id']) || typeof r['name'] !== 'string' || !box(r['sampleRegion'])) return false;
    ids.add(r['id']);
    if (['targetPathPattern', 'targetText', 'expectedText', 'role'].some((k) => r[k] !== undefined && (typeof r[k] !== 'string' || String(r[k]).length > 1000))) return false;
    if (r['boxKind'] !== undefined && !['layout', 'ink'].includes(String(r['boxKind']))) return false;
    if (r['state'] !== undefined && !['normal', 'current', 'passed', 'terminal', 'longestText'].includes(String(r['state']))) return false;
    if (r['repeat'] !== undefined && typeof r['repeat'] !== 'boolean') return false;
    if (r['expectedColor'] !== undefined && (typeof r['expectedColor'] !== 'string' || !/^#[a-f\d]{6}([a-f\d]{2})?$/i.test(r['expectedColor']))) return false;
    if (r['expectedImageSha256'] !== undefined && (typeof r['expectedImageSha256'] !== 'string' || !/^[a-f\d]{64}$/.test(r['expectedImageSha256']))) return false;
    if (r['expectedFontSizeMm'] !== undefined && !(typeof r['expectedFontSizeMm'] === 'number' && Number.isFinite(r['expectedFontSizeMm']) && r['expectedFontSizeMm'] > 0)) return false;
    if (r['positionToleranceMm'] !== undefined && !(typeof r['positionToleranceMm'] === 'number' && Number.isFinite(r['positionToleranceMm']) && r['positionToleranceMm'] >= 0)) return false;
    const tolerance = r['toleranceRatio'];
    if (tolerance !== undefined && (!isRecord(tolerance) || ['min', 'max'].some((k) => tolerance[k] !== undefined && !(typeof tolerance[k] === 'number' && Number.isFinite(tolerance[k]) && Number(tolerance[k]) > 0)) || Number(tolerance['min'] ?? 0.8) > Number(tolerance['max'] ?? 1.2))) return false;
    const b = r['sampleRegion'];
    return b.x >= board.x && b.y >= board.y && b.x + b.width <= board.x + board.width && b.y + b.height <= board.y + board.height;
  });
}

export function verifyElementStyles(options: {
  readonly layout: LayoutSummary; readonly baseline?: ReferenceBaseline;
  readonly candidatesHash: string; readonly requestHash: string;
  readonly parameters?: Record<string, unknown>; readonly evidence?: RenderEvidence;
  readonly resourceHashes?: Readonly<Record<string, string>>;
}): StyleVerificationRecord {
  const { layout, baseline, candidatesHash, requestHash, evidence } = options;
  const b = baseline?.boardRegion ?? { x: 0, y: 0, width: baseline?.sampleWidthPx ?? layout.output.widthPx, height: baseline?.sampleHeightPx ?? layout.output.heightPx };
  const sx = b.width / (baseline?.artboardWidthMm ?? layout.output.width), sy = b.height / (baseline?.artboardHeightMm ?? layout.output.height);
  const misaligned = baseline && (Math.abs(baseline.artboardWidthMm - layout.output.width) > 0.001 || Math.abs(baseline.artboardHeightMm - layout.output.height) > 0.001 || Math.abs(sx / sy - 1) > 2 / Math.min(b.width, b.height));
  const nodes: LayoutNode[] = [];
  const visit = (n: LayoutNode) => { if (!n.visible) return; nodes.push(n); n.children?.forEach(visit); }; visit(layout.root);
  const anomalies: StyleAnomaly[] = [], regions: RegionMeasurement[] = [];
  for (const region of misaligned ? [] : baseline?.approvedRegions ?? []) {
    const ref = { x: (region.sampleRegion.x - b.x) / sx, y: (region.sampleRegion.y - b.y) / sy, width: region.sampleRegion.width / sx, height: region.sampleRegion.height / sy };
    const selected = nodes.filter((n) => (region.targetPathPattern ? matchPath(region.targetPathPattern, n.path) : region.targetText !== undefined) && (region.targetText === undefined || n.text?.content === region.targetText));
    if (!region.targetPathPattern && region.targetText === undefined) { regions.push({ id: region.id, name: region.name, status: 'unknown', referenceBoxMm: ref, instances: [] }); continue; }
    if (!selected.length) anomalies.push({ kind: 'missingRegion', regionId: region.id, path: region.targetPathPattern ?? '', message: `参考项“${region.name}”没有匹配到可见布局元素` });
    if (selected.length > 1 && !region.repeat) { regions.push({ id: region.id, name: region.name, status: 'ambiguous', referenceBoxMm: ref, instances: [] }); continue; }
    const instances = selected.map((node) => {
      const trace = evidence?.nodes.find((n) => n.path === node.path);
      const unknown: string[] = [];
      const add = (kind: StyleAnomaly['kind'], message: string, values = {}) => anomalies.push({ kind, regionId: region.id, path: node.path, message, ...values });
      if (trace?.visibility.status === 'invisible') add('contentInvisible', `${region.name}：实际绘制内容完全不可见（${trace.visibility.reasons.join('、')}）`);
      const imageHash = node.image ? options.resourceHashes?.[node.image.source.replace(/^res:/, '')] : undefined;
      const imageContent: RegionMeasurement['instances'][number]['imageContent'] = node.image || region.expectedImageSha256 ? {
        status: !region.expectedImageSha256 || !imageHash ? 'notChecked' : region.expectedImageSha256 === imageHash ? 'matches' : 'mismatch',
        ...(imageHash ? {sha256: imageHash} : {}),
      } : undefined;
      if (imageContent?.status === 'mismatch') add('imageContentMismatch', `${region.name}：实际图片资源内容与核准摘要不同`);
      if (imageContent?.status === 'notChecked') unknown.push('图片内容缺少核准事实或实际资源证据');
      const ratio = (actual: number, expected: number, kind: StyleAnomaly['kind']) => {
        const r = actual / expected;
        if (r < (region.toleranceRatio?.min ?? 0.8) || r > (region.toleranceRatio?.max ?? 1.2)) add(kind, `${region.name}：实际 ${actual.toFixed(3)} mm，参考 ${expected.toFixed(3)} mm，比值 ${r.toFixed(3)}`, { actualMm: actual, expectedMm: expected, ratio: r });
      };
      const fontSizes = node.text ? [...new Set(node.text.fragments.filter((f) => f.text.length > 0).map((f) => f.fontSize))] : [];
      if (region.expectedFontSizeMm !== undefined) {
        if (!fontSizes.length) unknown.push('没有实际文字字号');
        else for (const size of fontSizes) ratio(size, region.expectedFontSizeMm, size < region.expectedFontSizeMm ? 'fontSizeTooSmall' : 'fontSizeTooLarge');
      }
      if (region.expectedText !== undefined && node.text?.content !== region.expectedText) add('textMismatch', `${region.name}：文字与核准内容不同`);
      const colors = node.text ? [...new Set(node.text.fragments.map((f) => f.color.toUpperCase()))] : undefined;
      if (region.expectedColor) {
        const expected = region.expectedColor.toUpperCase().padEnd(9, 'F');
        if (!colors) unknown.push('未测量该元素颜色');
        else if (colors.some((c) => c.padEnd(9, 'F') !== expected)) add('colorMismatch', `${region.name}：解析后的文字颜色与参考 ${expected} 不同`);
      }
      const actual = region.boxKind === 'layout' ? node : region.boxKind === 'ink' ? trace?.inkBounds : undefined;
      if (region.boxKind && (!actual || trace?.transformed)) unknown.push('旋转/裁切或墨迹测量不可用');
      unknown.push('部分遮挡、复杂变换、低对比与感知可读性未核查');
      if (!region.boxKind && region.expectedFontSizeMm === undefined && region.expectedText === undefined && !region.expectedColor && !region.expectedImageSha256) unknown.push('没有同口径的核准测量');
      const measuredBox = actual && !trace?.transformed ? { x: actual.x, y: actual.y, width: actual.width, height: actual.height } : undefined;
      if (measuredBox) {
        ratio(measuredBox.width, ref.width, 'sizeDeviation'); ratio(measuredBox.height, ref.height, 'sizeDeviation');
        if (!region.repeat && (Math.abs(measuredBox.x - ref.x) > (region.positionToleranceMm ?? 1) || Math.abs(measuredBox.y - ref.y) > (region.positionToleranceMm ?? 1))) add('positionDeviation', `${region.name}：位置偏移 Δx=${(measuredBox.x - ref.x).toFixed(3)}、Δy=${(measuredBox.y - ref.y).toFixed(3)} mm`);
      }
      return { path: node.path, ...(imageContent ? {imageContent} : {}), ...(trace?.visibility ? { visibility: trace.visibility } : {}), ...(trace?.source ? { sourceLocation: trace.source } : {}), ...(node.text ? { ...(fontSizes.length === 1 ? { fontSizeMm: fontSizes[0]! } : {}), fontSizesMm: fontSizes, text: node.text.content, colors } : {}),
        ...(measuredBox ? { box: measuredBox, deltaMm: { x: measuredBox.x - ref.x, y: measuredBox.y - ref.y }, sizeRatio: { width: measuredBox.width / ref.width, height: measuredBox.height / ref.height } } : {}), unknown };
    });
    regions.push({ id: region.id, name: region.name, ...(region.state ? { state: region.state } : {}), status: !selected.length ? 'missing' : instances.some((i) => i.unknown.length) ? 'unknown' : 'measured', referenceBoxMm: ref, instances });
  }
  const unknown = regions.filter((r) => r.status === 'unknown' || r.status === 'ambiguous').length;
  return { format: 'renderweave-style-verification/3', candidatesHash, requestHash, baselineHash: baseline ? digest(baseline) : '', valid: true,
    status: !baseline?.approvedRegions.length || misaligned ? 'notChecked' : anomalies.length ? 'needsWork' : 'needsReview',
    ...(misaligned ? { reason: 'alignmentUnknown' } : !baseline?.approvedRegions.length ? { reason: 'referenceUnavailable' } : {}),
    physicalScale: { pxPerMmh: sx, pxPerMmv: sy }, coverage: { approvedRegionsTotal: baseline?.approvedRegions.length ?? 0,
      approvedRegionsMatched: regions.filter((r) => r.instances.length).length, repeatedInstancesScanned: regions.reduce((n, r) => n + r.instances.length, 0),
      statesCovered: [...new Set(regions.filter((r) => r.status === 'measured' && r.state && !anomalies.some((a) => a.regionId === r.id)).map((r) => r.state!))],
      statesMeasured: [...new Set(regions.filter((r) => r.state && r.instances.length && r.instances.every((i) => i.unknown.every((u) => u === '部分遮挡、复杂变换、低对比与感知可读性未核查'))).map((r) => r.state!))],
      unknownRegions: unknown, complete: baseline?.complete === true },
    regions, anomalies, passed: !!baseline?.approvedRegions.length && !misaligned && !unknown && !anomalies.length && regions.every((r) => r.status === 'measured') };
}
