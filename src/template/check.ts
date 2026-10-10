/**
 * 模板静态检查：在求值之前，对照基准静态数据定义的编译产物检查模板（M102、M118）。
 *
 * 本版本检查文本插槽：路径能在数据定义中找到、只经过单引用，取值能显示为文字，展示格式与字段类型相符。
 * 检查覆盖全部元素（包括隐藏的），结果供求值时按类型输出插槽。参数、派生变量与绑定的检查随票据 07 加入。
 */
import { KIND_LABELS, formatMismatch, type DisplayKind } from '../display-format.js';
import { formatElementPath } from '../element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { isRecord } from '../util.js';
import type { ArtboardModel, ElementModel, SlotModel, TemplateModel } from './model.js';

export interface CheckedTemplate {
  readonly problems: readonly Problem[];
  /** 通过检查的插槽及其取值类型；没有列出的插槽求值为空。 */
  readonly slotKinds: ReadonlyMap<SlotModel, DisplayKind>;
}

/** 编译产物中一个字段的取值种类。 */
type FieldKind = DisplayKind | 'boolean' | 'image' | 'list' | 'ref';

const FIELD_LABELS: Record<FieldKind, string> = {
  ...KIND_LABELS,
  boolean: '布尔',
  image: '图片',
  list: '列表',
  ref: '数据定义引用',
};

export function checkTemplate(template: TemplateModel, compiled: Record<string, unknown>): CheckedTemplate {
  const problems: Problem[] = [];
  const slotKinds = new Map<SlotModel, DisplayKind>();
  const visit = (node: ArtboardModel | ElementModel) => {
    if (node.type === 'text') {
      for (const item of node.content) {
        if (item.kind !== 'slot') continue;
        const result = checkSlot(item, compiled);
        if ('kind' in result) slotKinds.set(item, result.kind);
        else problems.push(severe(result.code, { kind: 'element', path: formatElementPath(node.path) }, result.message));
      }
    }
    if (node.type === 'artboard' || node.type === 'container') node.children.forEach(visit);
  };
  visit(template.artboard);
  return { problems, slotKinds };
}

type Outcome<T> = T | { readonly code: ProblemCode; readonly message: string };

function checkSlot(slot: SlotModel, compiled: Record<string, unknown>): Outcome<{ kind: DisplayKind }> {
  const field = resolveField(compiled, slot.path);
  if (!('kind' in field)) return field;
  const kind = field.kind;
  if (kind === 'boolean' || kind === 'image' || kind === 'list' || kind === 'ref') {
    const advice = kind === 'boolean' ? '，按真假显示不同文字请用条件显示或状态样式' : '';
    return {
      code: ProblemCodes.templateTypeMismatch,
      message: `插槽 ${slot.path} 是${FIELD_LABELS[kind]}字段，不能显示为文字${advice}`,
    };
  }
  if (slot.format) {
    const mismatch = kind === 'text' ? `文本字段不带展示格式"${slot.format.pattern}"` : formatMismatch(slot.format, kind);
    if (mismatch) return { code: ProblemCodes.templateTypeMismatch, message: `插槽 ${slot.path}：${mismatch}` };
  }
  return { kind };
}

/** 沿"."分隔的路径在编译产物中找到字段；路径只能经过单引用（M24）。 */
function resolveField(compiled: Record<string, unknown>, path: string): Outcome<{ kind: FieldKind }> {
  let node: Record<string, unknown> = compiled;
  const walked: string[] = [];
  for (const name of path.split('.')) {
    if (walked.length > 0) {
      const kind = fieldKind(node);
      if (kind !== 'ref') {
        return {
          code: ProblemCodes.templateInvalidPath,
          message: `插槽路径 ${path} 中的 ${walked.join('.')} 是${FIELD_LABELS[kind]}字段，路径只能经过单引用`,
        };
      }
    }
    const properties = node['properties'];
    const next = isRecord(properties) && Object.hasOwn(properties, name) ? properties[name] : undefined;
    if (!isRecord(next)) {
      const owner = walked.length === 0 ? '数据定义' : walked.join('.');
      return { code: ProblemCodes.templateUnknownVariable, message: `插槽 ${path} 引用的字段不存在：${owner}中没有 ${name}` };
    }
    walked.push(name);
    node = next;
  }
  return { kind: fieldKind(node) };
}

function fieldKind(schema: Record<string, unknown>): FieldKind {
  const special = schema['x-renderweave-type'];
  if (special === 'date' || special === 'time' || special === 'datetime' || special === 'image') return special;
  switch (schema['type']) {
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'list';
    case 'object':
      return 'ref';
    default:
      return 'text';
  }
}
