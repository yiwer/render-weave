/**
 * 求值：把模板与数据集求值为一棵静态元素树，变量插槽按展示格式换成实际文字，片段样式合并上文本元素的设置。
 * 缺值时结果为空，不回退到设计时的占位内容（M16）。
 */
import { displayValue } from './display-format.js';
import type { CheckedTemplate } from './template/check.js';
import type { ArtboardModel, Color, ElementModel, TemplateModel, TextElementModel } from './template/model.js';
import { isRecord } from './util.js';

export interface EvaluatedNode {
  readonly model: ArtboardModel | ElementModel;
  /** 文本元素求值后的片段，样式已合并上文本元素的设置。 */
  readonly fragments?: readonly EvaluatedFragment[];
  readonly children?: readonly EvaluatedNode[];
}

export interface EvaluatedFragment {
  readonly text: string;
  readonly style: ResolvedStyle;
}

export interface ResolvedStyle {
  /** 字体资源 ID。 */
  readonly font: string;
  readonly fontSize: number;
  readonly color: Color;
  /** 倾斜角度，度。 */
  readonly slant: number;
}

export interface EvaluatedTemplate {
  readonly template: TemplateModel;
  readonly root: EvaluatedNode;
}

export function evaluate(template: TemplateModel, data: unknown, checked: CheckedTemplate): EvaluatedTemplate {
  const evaluateNode = (model: ArtboardModel | ElementModel): EvaluatedNode => {
    switch (model.type) {
      case 'artboard':
      case 'container':
        return { model, children: model.children.map(evaluateNode) };
      case 'text':
        return { model, fragments: evaluateContent(model, data, checked) };
      default:
        return { model };
    }
  };
  return { template, root: evaluateNode(template.artboard) };
}

/** 先序遍历求值树中会显示的节点：隐藏的元素连同其子元素都跳过（M27）。 */
export function* walkVisible(node: EvaluatedNode): Generator<EvaluatedNode> {
  if (node.model.type !== 'artboard' && !node.model.visible) return;
  yield node;
  for (const child of node.children ?? []) yield* walkVisible(child);
}

/** 文字的全部内容。 */
export function fragmentsText(fragments: readonly EvaluatedFragment[]): string {
  return fragments.map((fragment) => fragment.text).join('');
}

function evaluateContent(model: TextElementModel, data: unknown, checked: CheckedTemplate): EvaluatedFragment[] {
  return model.content.map((item) => {
    const style: ResolvedStyle = {
      font: item.style.font ?? model.font,
      fontSize: item.style.fontSize ?? model.fontSize,
      color: item.style.color ?? model.color,
      slant: item.style.slant ?? model.slant,
    };
    if (item.kind === 'text') return { text: item.text, style };
    // 没有通过静态检查的插槽（模板检查已报问题）求值为空。
    const kind = checked.slotKinds.get(item);
    return { text: kind ? displayValue(resolvePath(data, item.path), kind, item.format) : '', style };
  });
}

/** 按 "." 分隔的路径取值；路径上任何一级缺失都得到 undefined。 */
function resolvePath(data: unknown, path: string): unknown {
  let current = data;
  for (const name of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, name)) return undefined;
    current = current[name];
  }
  return current;
}
