/**
 * 求值：把模板与数据集求值为一棵静态元素树，变量插槽换成实际文字。
 * 缺值时结果为空，不回退到设计时的占位内容（M16）。
 */
import type { ArtboardModel, ContentItem, ElementModel, TemplateModel } from './template/model.js';
import { isRecord } from './util.js';

export interface EvaluatedNode {
  readonly model: ArtboardModel | ElementModel;
  /** 文本元素求值后的文字。 */
  readonly text?: string;
  readonly children?: readonly EvaluatedNode[];
}

export interface EvaluatedTemplate {
  readonly template: TemplateModel;
  readonly root: EvaluatedNode;
}

export function evaluate(template: TemplateModel, data: unknown): EvaluatedTemplate {
  return { template, root: evaluateNode(template.artboard, data) };
}

function evaluateNode(model: ArtboardModel | ElementModel, data: unknown): EvaluatedNode {
  switch (model.type) {
    case 'artboard':
    case 'container':
      return { model, children: model.children.map((child) => evaluateNode(child, data)) };
    case 'text':
      return { model, text: renderContent(model.content, data) };
    default:
      return { model };
  }
}

/** 遍历求值树中的所有节点（先序）。 */
export function* walkEvaluated(node: EvaluatedNode): Generator<EvaluatedNode> {
  yield node;
  for (const child of node.children ?? []) yield* walkEvaluated(child);
}

function renderContent(content: readonly ContentItem[], data: unknown): string {
  return content.map((item) => (item.kind === 'text' ? item.text : display(resolvePath(data, item.path)))).join('');
}

/** 按 "." 分隔的路径取值；路径上任何一级缺失都得到 undefined。 */
function resolvePath(data: unknown, path: string): unknown {
  let current = data;
  for (const name of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[name];
  }
  return current;
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}
