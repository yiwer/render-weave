/** 草稿显示层：占位独立重排，问题边框最后叠加；不改变真实内容的诊断。 */
import { formatElementPath } from './element-path.js';
import type { EvaluatedNode } from './evaluate.js';
import type { DrawOp, LayoutNode, LayoutSummary } from './layout/index.js';
import type { Problem } from './problems.js';

export function withDraftPlaceholders(root: EvaluatedNode): { root: EvaluatedNode; changed: boolean } {
  let changed = false;
  const visit = (node: EvaluatedNode): EvaluatedNode => {
    if (node.model.type !== 'artboard' && !node.model.visible) return node;
    if (node.fragments?.some((fragment) => fragment.placeholder)) {
      changed = true;
      return { ...node, previewProblem: true, fragments: node.fragments.map((fragment) =>
        fragment.placeholder ? { ...fragment, text: fragment.placeholder } : fragment) };
    }
    return node.children ? { ...node, children: node.children.map(visit) } : node;
  };
  const result = visit(root);
  return { root: result, changed };
}

/** 边框绕每一级元素框中心旋转，但不继承透明度与裁剪，也不会被后画的业务元素盖住。 */
export function draftBorders(root: EvaluatedNode, summary: LayoutSummary, problems: readonly Problem[]): DrawOp[] {
  const nodes = new Map<string, EvaluatedNode>();
  const collect = (node: EvaluatedNode) => {
    nodes.set(formatElementPath(node.model.path), node);
    node.children?.forEach(collect);
  };
  collect(root);
  const paths = new Set(problems.flatMap((problem) => {
    const location = problem.location;
    return location.kind === 'element' || ((location.kind === 'parameter' || location.kind === 'check') && location.path)
      ? [location.path!] : [];
  }));
  const ops: DrawOp[] = [];
  const visit = (box: LayoutNode, parents: readonly Extract<DrawOp, { op: 'save' }>[]) => {
    if (!box.visible) return;
    const node = nodes.get(box.path);
    const model = node?.model;
    const rotations = model && model.type !== 'artboard' && model.rotation !== 0
      ? [...parents, { op: 'save' as const, rotation: { degrees: model.rotation, cx: box.x + box.width / 2, cy: box.y + box.height / 2 } }] : parents;
    if (paths.has(box.path) || node?.previewProblem) {
      // hug 缺值可为零宽/高，至少画 2 mm 标记；边框画在框内，画板边缘仍可见。
      const rect = { op: 'rect' as const, x: box.x, y: box.y, width: Math.max(2, box.width), height: Math.max(2, box.height),
        radii: [0, 0, 0, 0] as const };
      ops.push(...rotations, { ...rect, stroke: { color: '#FFFFFFFF', width: 1.2, cap: 'butt' } },
        { ...rect, stroke: { color: '#E60012FF', width: 0.6, cap: 'butt' } }, ...rotations.map(() => ({ op: 'restore' as const })));
    }
    box.children?.forEach((child) => visit(child, rotations));
  };
  visit(summary.root, []);
  return ops;
}
