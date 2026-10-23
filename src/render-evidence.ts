/** 真实内容的诊断证据。不会改变绘制，也不声称布局存在就等于最终像素可见。 */
import { formatElementPath } from './element-path.js';
import type { EvaluatedNode } from './evaluate.js';
import type { EncodedImage } from './draw.js';
import type { LayoutSummary, DrawOp } from './layout/index.js';
import type { FontStore } from './text/fonts.js';

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface RenderEvidence {
  readonly image: EncodedImage;
  readonly layout: LayoutSummary;
  readonly nodes: readonly { readonly path: string; readonly source?: { readonly template: string; readonly path: string }; readonly inkBounds?: Box; readonly transformed: boolean }[];
}
export function evidenceNodes(root: EvaluatedNode, ops: readonly DrawOp[], fonts: FontStore): RenderEvidence['nodes'] {
  const nodes = new Map<string, { path: string; source?: { template: string; path: string }; inkBounds?: Box; transformed: boolean }>();
  const visit = (n: EvaluatedNode, transformed: boolean) => {
    const complex = transformed || n.model.type !== 'artboard' && (n.model.rotation !== 0 || n.model.opacity !== 1 || 'clip' in n.model && !!n.model.clip);
    nodes.set(formatElementPath(n.model.path), { path: formatElementPath(n.model.path), ...(n.source ? { source: n.source } : {}), transformed: complex });
    n.children?.forEach((child) => visit(child, complex));
  }; visit(root, false);
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
  return [...nodes.values()];
}
