/**
 * 舞台的叠加层（模板设计页票据 06，方案第 4 节）：都从布局摘要与模板文档算，不重新出图。纯函数。
 */
import { isObject, type JsonObject } from '../template/document.js';
import type { LayoutNode } from '../types.js';

export type LayerName = 'problems' | 'structure' | 'fit' | 'data';
export type Layers = Readonly<Record<LayerName, boolean>>;
export const DEFAULT_LAYERS: Layers = { problems: true, structure: false, fit: false, data: false };

export const flatNodes = (node: LayoutNode): readonly LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatNodes)];

export interface FitSummary { readonly compressed: number; readonly lowest?: number; readonly overflow: number }

/** 适配的压力：被压缩的文字处数、最低压缩比、放不下的处数。 */
export function fitSummary(root: LayoutNode): FitSummary {
  const texts = flatNodes(root).filter((node) => node.visible && node.text);
  const compressed = texts.filter((node) => node.text!.compression < 0.999);
  return {
    compressed: compressed.length,
    ...(compressed.length ? { lowest: Math.min(...compressed.map((node) => node.text!.compression)) } : {}),
    overflow: texts.filter((node) => node.text!.overflow).length,
  };
}

/** 这一处实例的适配结果（方案第 7 节）："压到 74%，字号 10 mm，字距 0 mm"。 */
export function fitResult(text: NonNullable<LayoutNode['text']>): string {
  const round = (value: number) => Math.round(value * 100) / 100;
  const compressed = text.compression < 0.999 ? `压到 ${Math.round(text.compression * 100)}%` : '没有压缩';
  return `${compressed}，字号 ${round(text.fontSize)} mm，字距 ${round(text.spacing)} mm${text.overflow ? '，仍放不下' : ''}`;
}

/** 元素的内容从哪来：有插槽或绑定的是数据驱动，其余是固定内容；不是内容元素时 undefined。 */
export function contentKind(element: JsonObject | undefined): 'data' | 'fixed' | undefined {
  if (!element) return undefined;
  switch (element['type']) {
    case 'text': return Array.isArray(element['content']) && element['content'].some((part) => isObject(part) && typeof part['slot'] === 'string') ? 'data' : 'fixed';
    case 'image': return isObject(element['source']) ? 'data' : 'fixed';
    case 'qrcode':
    case 'barcode': return isObject(element['content']) ? 'data' : 'fixed';
    default: return undefined;
  }
}

export interface GuideBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface GuideTrack { readonly axis: 'row' | 'column'; readonly at: number; readonly from: number; readonly to: number; readonly label: string }
export interface Guides { readonly gaps: readonly GuideBox[]; readonly padding: readonly GuideBox[]; readonly tracks: readonly GuideTrack[]; readonly labels: readonly { readonly x: number; readonly y: number; readonly text: string }[] }
const NO_GUIDES: Guides = { gaps: [], padding: [], tracks: [], labels: [] };

function trackLabel(track: unknown): string {
  if (track === 'hug') return '随内容';
  if (isObject(track) && typeof track['fixed'] === 'number') return `${track['fixed']} mm`;
  if (isObject(track) && typeof track['fraction'] === 'number') return `${track['fraction']} 份`;
  return '绑定';
}

function paddingBoxes(padding: unknown, node: LayoutNode): readonly GuideBox[] {
  const side = (key: string) => {
    if (typeof padding === 'number') return padding;
    return isObject(padding) && typeof padding[key] === 'number' ? padding[key] : 0;
  };
  const top = side('top'), right = side('right'), bottom = side('bottom'), left = side('left');
  return [
    ...(top ? [{ x: node.x, y: node.y, width: node.width, height: top }] : []),
    ...(bottom ? [{ x: node.x, y: node.y + node.height - bottom, width: node.width, height: bottom }] : []),
    ...(left ? [{ x: node.x, y: node.y, width: left, height: node.height }] : []),
    ...(right ? [{ x: node.x + node.width - right, y: node.y, width: right, height: node.height }] : []),
  ];
}

/** 选中容器时的排布参考：堆叠与循环的间距、内边距、网格的轨道线与尺寸。 */
export function layoutGuides(element: JsonObject | undefined, node: LayoutNode | undefined): Guides {
  if (!element || !node) return NO_GUIDES;
  const kids = (node.children ?? []).filter((child) => child.visible);
  const padding = paddingBoxes(element['padding'], node);
  const layout = isObject(element['layout']) ? element['layout'] : undefined;
  const direction = layout?.['mode'] === 'stack' ? layout['direction'] : isObject(element['itemLayout']) ? element['itemLayout']['direction'] ?? 'row' : undefined;
  if (direction !== undefined) {
    const gaps: GuideBox[] = [];
    for (let index = 0; index + 1 < kids.length; index++) {
      const a = kids[index]!, b = kids[index + 1]!;
      if (direction === 'column') { const start = a.y + a.height, size = b.y - start; if (size > 0.05) gaps.push({ x: node.x, y: start, width: node.width, height: size }); }
      else { const start = a.x + a.width, size = b.x - start; if (size > 0.05) gaps.push({ x: start, y: node.y, width: size, height: node.height }); }
    }
    return { gaps, padding, tracks: [], labels: [] };
  }
  if (layout?.['mode'] !== 'grid') return { ...NO_GUIDES, padding };
  const children = Array.isArray(element['children']) ? (element['children'] as unknown[]).filter(isObject) : [];
  const edges = (tracks: readonly unknown[], key: string, span: string, position: (kid: LayoutNode) => [number, number], base: number) => {
    const found: ([number, number] | undefined)[] = tracks.map((_, index) => {
      const child = children.find((item) => isObject(item['place']) && item['place'][key] === index + 1 && ((item['place'][span] as number | undefined) ?? 1) === 1);
      const kid = child && kids.find((item) => item.name === child['name']);
      return kid ? position(kid) : undefined;
    });
    let cursor = base;
    return tracks.map((track, index) => {
      const range = found[index] ?? [cursor, cursor + (isObject(track) && typeof track['fixed'] === 'number' ? track['fixed'] : 0)] as [number, number];
      cursor = range[1];
      return range;
    });
  };
  const rows = Array.isArray(layout['rows']) ? layout['rows'] as unknown[] : [], columns = Array.isArray(layout['columns']) ? layout['columns'] as unknown[] : [];
  const rowEdges = edges(rows, 'row', 'rowSpan', (kid) => [kid.y, kid.y + kid.height], node.y);
  const columnEdges = edges(columns, 'column', 'columnSpan', (kid) => [kid.x, kid.x + kid.width], node.x);
  return {
    gaps: [], padding,
    tracks: [
      ...rowEdges.slice(0, -1).map(([, end]) => ({ axis: 'row' as const, at: end, from: node.x, to: node.x + node.width, label: '' })),
      ...columnEdges.slice(0, -1).map(([, end]) => ({ axis: 'column' as const, at: end, from: node.y, to: node.y + node.height, label: '' })),
    ],
    labels: [
      ...rowEdges.map(([start, end], index) => ({ x: node.x, y: (start + end) / 2, text: trackLabel(rows[index]) })),
      ...columnEdges.map(([start, end], index) => ({ x: (start + end) / 2, y: node.y, text: trackLabel(columns[index]) })),
    ],
  };
}
