/**
 * 求值：把模板与数据集求值为一棵静态元素树，变量插槽换成实际文字。
 * 缺值时结果为空，不回退到设计时的占位内容（M16）。
 */
import type { ContentItem, TemplateModel, TextElementModel } from './template.js';
import { isRecord } from './util.js';

export interface EvaluatedText {
  readonly model: TextElementModel;
  readonly text: string;
}

export interface EvaluatedTemplate {
  readonly template: TemplateModel;
  readonly children: readonly EvaluatedText[];
}

export function evaluate(template: TemplateModel, data: unknown): EvaluatedTemplate {
  return {
    template,
    children: template.artboard.children.map((model) => ({ model, text: renderContent(model.content, data) })),
  };
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
