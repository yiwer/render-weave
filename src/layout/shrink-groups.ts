/** 一次出图内的缩字组：首轮收集实际内容宽，次轮统一字号后重新测量与排布。 */
import { formatElementPath } from '../element-path.js';
import type { EvaluatedFragment, EvaluatedNode } from '../evaluate.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import type { TextElementModel } from '../template/model.js';
import type { Box } from './types.js';

export class ShrinkGroups {
  private readonly members = new Map<TextElementModel, { width: number; maxFontSize: number; minFontSize: number }>();

  observe(model: TextElementModel, fragments: readonly EvaluatedFragment[], box: Box): void {
    if (!model.fit.widthOverflow) return;
    const inkedSizes = fragments.filter((fragment) => fragment.text.length > 0).map((fragment) => fragment.style.fontSize);
    const maxFontSize = inkedSizes.length > 0 ? Math.max(...inkedSizes) : model.fontSize;
    const minFontSize = inkedSizes.length > 0 ? Math.min(...inkedSizes) : model.fontSize;
    this.members.set(model, {
      width: Math.max(0, box.width - model.padding.left - model.padding.right),
      maxFontSize,
      minFontSize,
    });
  }

  resolve(root: EvaluatedNode): { root: EvaluatedNode; problems: Problem[] } | undefined {
    if (!this.members.size) return undefined;
    const groups = new Map<string, { size: number; floor: number; original: number }>();
    for (const [model, { width, maxFontSize, minFontSize }] of this.members) {
      const rule = model.fit.widthOverflow!;
      const previous = groups.get(rule.shrinkGroup);
      groups.set(rule.shrinkGroup, {
        size: Math.min(previous?.size ?? Infinity, maxFontSize, width),
        // 各成员的下限已按所在模板的画板取缺省（M238），全组取最高的。
        floor: Math.max(previous?.floor ?? 0, rule.minFontSize),
        original: Math.min(previous?.original ?? Infinity, minFontSize),
      });
    }
    const problems: Problem[] = [];
    const rewrite = (node: EvaluatedNode): EvaluatedNode => {
      if (node.model.type === 'text' && this.members.has(node.model)) {
        const model = node.model;
        const { maxFontSize, minFontSize } = this.members.get(model)!;
        const rule = model.fit.widthOverflow!;
        const group = groups.get(rule.shrinkGroup)!;
        if (group.floor > group.original) problems.push(severe(ProblemCodes.templateInvalid,
          { kind: 'element', path: formatElementPath(model.path) },
          `缩字组 ${rule.shrinkGroup} 的最小字号 ${group.floor} mm 超过组内原始最小字号 ${group.original} mm`));
        const memberFloor = minFontSize > 0 ? (group.floor * maxFontSize) / minFontSize : group.floor;
        const targetMax = Math.max(memberFloor, Math.min(maxFontSize, group.size));
        const scale = maxFontSize > 0 ? targetMax / maxFontSize : 1;
        const fontSize = model.fontSize * scale;
        // 次轮的成员带上全组下限，放不下时的说明按全组写；各片段字号按比例同步缩放（M256）。
        return { ...node, model: { ...model, fontSize, fit: { ...model.fit, widthOverflow: { ...rule, minFontSize: group.floor } } },
          fragments: node.fragments?.map((fragment) => ({
            ...fragment,
            style: { ...fragment.style, fontSize: fragment.style.fontSize * scale },
          })) };
      }
      return node.children ? { ...node, children: node.children.map(rewrite) } : node;
    };
    return { root: rewrite(root), problems };
  }
}

/** 隐藏分支不参与缩字，也不使其祖先的随内容宽度受缩字约束。 */
export function containsShrinkGroup(node: EvaluatedNode): boolean {
  if (node.model.type !== 'artboard' && !node.model.visible) return false;
  return node.model.type === 'text' ? !!node.model.fit.widthOverflow : (node.children ?? []).some(containsShrinkGroup);
}
