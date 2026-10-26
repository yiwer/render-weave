/** 真实内容的诊断证据。不会改变绘制，也不声称布局存在就等于最终像素可见。 */
import { formatElementPath } from './element-path.js';
import type { EvaluatedNode } from './evaluate.js';
import type { EncodedImage } from './draw.js';
import type { LayoutSummary, DrawOp } from './layout/index.js';
import type { FontStore } from './text/fonts.js';

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface VisibilityEvidence {
  readonly status: 'invisible' | 'unknown';
  readonly reasons: readonly ('transparent' | 'clipped' | 'occluded')[];
  readonly cumulativeOpacity: number;
  readonly bounds?: Box;
  readonly clip?: Box;
  readonly occluders?: readonly { readonly path: string; readonly bounds: Box; readonly drawOrder: number }[];
}
export interface RenderEvidence {
  readonly image: EncodedImage;
  readonly layout: LayoutSummary;
  readonly nodes: readonly { readonly path: string; readonly source?: { readonly template: string; readonly path: string }; readonly inkBounds?: Box; readonly transformed: boolean; readonly visibility: VisibilityEvidence }[];
}
export function evidenceNodes(root: EvaluatedNode, ops: readonly DrawOp[], fonts: FontStore, layout: LayoutSummary): RenderEvidence['nodes'] {
  const nodes = new Map<string, { path: string; source?: { template: string; path: string }; inkBounds?: Box; transformed: boolean; visibility: VisibilityEvidence }>();
  const visit = (n: EvaluatedNode, transformed: boolean, inheritedOpacity: number) => {
    const complex = transformed || n.model.type !== 'artboard' && (n.model.rotation !== 0 || n.model.opacity !== 1 || 'clip' in n.model && !!n.model.clip);
    const cumulativeOpacity = inheritedOpacity * (n.model.type === 'artboard' ? 1 : n.model.opacity);
    nodes.set(formatElementPath(n.model.path), { path: formatElementPath(n.model.path), ...(n.source ? { source: n.source } : {}), transformed: complex,
      visibility: {status: cumulativeOpacity === 0 ? 'invisible' : 'unknown', reasons: cumulativeOpacity === 0 ? ['transparent'] : [], cumulativeOpacity} });
    n.children?.forEach((child) => visit(child, complex, cumulativeOpacity));
  }; visit(root, false, 1);
  for (const op of ops) {
    if (op.op !== 'glyphs') continue;
    const node = nodes.get(op.path), font = fonts.get(op.font);
    if (!node || !font) continue;
    if (op.rotated || op.skew !== 0) { node.transformed = true; continue; }
    for (let i = 0; i < op.glyphs.length; i++) {
      const ink = fonts.inkBounds(font, op.glyphs[i]!);
      if (!ink) continue;
      const stroke = op.stroke?.width ?? 0;
      const left = op.positions[i * 2]! + ink.left * op.fontSize * op.scaleX - stroke;
      const top = op.positions[i * 2 + 1]! + ink.top * op.fontSize * op.scaleY - stroke;
      const right = op.positions[i * 2]! + ink.right * op.fontSize * op.scaleX + stroke;
      const bottom = op.positions[i * 2 + 1]! + ink.bottom * op.fontSize * op.scaleY + stroke;
      const previous = node.inkBounds;
      const x = Math.min(previous?.x ?? left, left), y = Math.min(previous?.y ?? top, top);
      node.inkBounds = { x, y, width: Math.max(previous ? previous.x + previous.width : right, right) - x, height: Math.max(previous ? previous.y + previous.height : bottom, bottom) - y };
    }
  }
  let state = {clip: {x: 0, y: 0, width: layout.output.width, height: layout.output.height}, rotated: false, complexClip: false, opacity: 1};
  const stack: typeof state[] = [];
  const parts = new Map<string, {bounds?: Box; clip: Box; complex: boolean; drawOrder: number; opacity: number}[]>();
  const covers: {path: string; bounds: Box; drawOrder: number}[] = [];
  for (const [drawOrder, op] of ops.entries()) {
    if (op.op === 'save') {
      stack.push(state);
      state = {clip: op.clip ? intersection(state.clip, op.clip) : state.clip, rotated: state.rotated || !!op.rotation,
        complexClip: state.complexClip || !!op.clip?.radii.some(radius => radius !== 0), opacity: state.opacity * (op.opacity ?? 1)};
    } else if (op.op === 'restore') state = stack.pop() ?? state;
    else {
      const path = op.elementPath ?? ('path' in op ? op.path : undefined);
      const bounds: Box | undefined = op.op === 'glyphs' ? nodes.get(op.path)?.inkBounds : op.op === 'image' ? op.dst
        : op.op === 'rect' || op.op === 'ellipse' ? op : op.op === 'barcode' ? op.drawn
        : op.op === 'qrcode' ? {x: op.x, y: op.y, width: (op.modules + 8) * op.moduleSize, height: (op.modules + 8) * op.moduleSize} : undefined;
      const paintAlpha = op.op === 'glyphs' ? Math.max(alpha(op.color), alpha(op.stroke?.color))
        : op.op === 'rect' || op.op === 'ellipse' || op.op === 'path' ? Math.max(alpha(op.fill), alpha(op.stroke?.color))
        : op.op === 'image' ? op.tint ? alpha(op.tint) : 1 : Math.max(alpha(op.foreground), alpha(op.background));
      const complex = state.rotated || state.complexClip || op.op === 'glyphs' && (!!op.rotated || op.skew !== 0);
      if (path) {
        // 容器的全部子绘制共同决定可见性，不能只检查容器背景。
        let owner = path;
        while (owner) {
          if (nodes.has(owner)) {
            let owned = parts.get(owner);
            if (!owned) { owned = []; parts.set(owner, owned); }
            owned.push({bounds, clip: state.clip, complex, drawOrder, opacity: state.opacity * paintAlpha});
          }
          const end = owner.lastIndexOf('/'); owner = end < 0 ? '' : owner.slice(0, end);
        }
      }
      if (op.op === 'rect' && op.fill && alpha(op.fill) === 1 && state.opacity === 1 && !state.rotated && !state.complexClip && op.radii.every(radius => radius === 0)) {
        covers.push({path: path ?? '', bounds: intersection(op, state.clip), drawOrder});
      }
    }
  }
  for (const [path, items] of parts) {
    const node = nodes.get(path)!;
    if (node.visibility.status === 'invisible') continue;
    const active = items.filter(item => item.opacity !== 0);
    if (!active.length) {
      node.visibility = {...node.visibility, status: 'invisible', reasons: ['transparent']};
      continue;
    }
    const clipped = active.filter(item => !item.complex && item.bounds && empty(intersection(item.bounds, item.clip)));
    const remaining = active.filter(item => !clipped.includes(item));
    if (!remaining.length) {
      node.visibility = {...node.visibility, status: 'invisible', reasons: ['clipped'], bounds: active[0]!.bounds, clip: active[0]!.clip};
      continue;
    }
    const occluders = remaining.map(item => item.complex || !item.bounds ? undefined : covers.find(cover => cover.drawOrder > item.drawOrder && contains(cover.bounds, intersection(item.bounds!, item.clip))));
    if (occluders.every(cover => cover !== undefined)) {
      node.visibility = {...node.visibility, status: 'invisible', reasons: [...(clipped.length ? ['clipped' as const] : []), 'occluded'], bounds: active[0]!.bounds,
        occluders: [...new Map(occluders.map(cover => [cover!.drawOrder, cover!])).values()]};
    }
  }
  return [...nodes.values()];
}

function intersection(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return {x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y)};
}
function empty(box: Box): boolean { return box.width <= 0 || box.height <= 0; }
function contains(cover: Box, target: Box): boolean {
  return !empty(target) && cover.x <= target.x && cover.y <= target.y && cover.x + cover.width >= target.x + target.width && cover.y + cover.height >= target.y + target.height;
}
function alpha(color: string | undefined): number { return color === undefined ? 0 : color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1; }
