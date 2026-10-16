/**
 * 模板辅助修改用到的两件事（M49、M51）：
 * - 调用树：出图请求的主模板及它直接、间接调用的模板，是本轮可以修改的范围；
 * - 结构化差异：工作副本相对已保存内容的改动。元素按元素路径比对自身的属性，子元素各自比对；
 *   模板层比对画板以外的键，参数、派生变量与检查项按名称逐项比对。
 */
import { isRecord } from '../util.js';
import { flattenElements } from './locations.js';

export interface TemplateChange {
  /** 元素路径，从模板名开始，画板就是模板名；模板层的改动写键名，如 parameters。 */
  readonly path: string;
  readonly target: 'element' | 'template';
  readonly change: 'added' | 'removed' | 'changed';
  /** 改动的属性；参数、派生变量与检查项以名称为键。 */
  readonly properties?: readonly PropertyChange[];
  /** 新增或删去的元素（不含子元素，子元素各有一条），或模板层整个键的值。 */
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface PropertyChange {
  readonly key: string;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** 按名称逐项比对的模板层列表。 */
const NAMED_LISTS = ['parameters', 'derived', 'checks'];

/** 主模板及它调用的模板，按调用顺序广度优先；不在列表里的模板名（未保存的被调模板）跳过。 */
export function templateCallTree(templates: readonly { readonly name: string; readonly document: unknown }[], main: string): string[] {
  const byName = new Map(templates.map((entry) => [entry.name, entry.document]));
  const order: string[] = [];
  const queue = [main];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (order.includes(name) || !byName.has(name)) continue;
    order.push(name);
    for (const { element } of flattenElements(byName.get(name))) {
      if (typeof element['template'] === 'string') queue.push(element['template']);
    }
  }
  return order;
}

/** 工作副本相对已保存内容的差异；没有改动时为空列表。 */
export function diffTemplate(before: unknown, after: unknown): TemplateChange[] {
  const changes: TemplateChange[] = [];
  const left = isRecord(before) ? before : {}, right = isRecord(after) ? after : {};
  for (const key of unionKeys(left, right)) {
    if (key === 'artboard') continue;
    const a = left[key], b = right[key];
    if (canonical(a) === canonical(b)) continue;
    const change = a === undefined ? 'added' : b === undefined ? 'removed' : 'changed';
    if (NAMED_LISTS.includes(key) && (a === undefined || Array.isArray(a)) && (b === undefined || Array.isArray(b))) {
      changes.push({ path: key, target: 'template', change, properties: namedListChanges(a ?? [], b ?? []) });
    } else changes.push({ path: key, target: 'template', change, ...(a !== undefined ? { before: a } : {}), ...(b !== undefined ? { after: b } : {}) });
  }

  // 画板与元素：按元素路径配对，路径相同即为同一元素。
  const name = typeof right['name'] === 'string' ? right['name'] : typeof left['name'] === 'string' ? left['name'] : '';
  const nodes = (document: Record<string, unknown>) => new Map<string, Record<string, unknown>>([
    ...(isRecord(document['artboard']) ? [[name, document['artboard']] as const] : []),
    ...flattenElements({ ...document, name }).map(({ path, element }) => [path, element] as const),
  ]);
  const was = nodes(left), now = nodes(right);
  for (const [path, element] of now) {
    const old = was.get(path);
    if (!old) {
      changes.push({ path, target: 'element', change: 'added', after: own(element) });
      continue;
    }
    const properties = [
      ...unionKeys(own(old), own(element)).filter((key) => canonical(old[key]) !== canonical(element[key]))
        .map((key) => ({ key, ...(old[key] !== undefined ? { before: old[key] } : {}), ...(element[key] !== undefined ? { after: element[key] } : {}) })),
      ...childOrderChange(old, element),
    ];
    if (properties.length > 0) changes.push({ path, target: 'element', change: 'changed', properties });
  }
  for (const [path, element] of was) {
    if (!now.has(path)) changes.push({ path, target: 'element', change: 'removed', before: own(element) });
  }
  return changes;
}

/** 键排序后的 JSON，用来比较两个值是否相同。 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** 元素自身的属性：去掉子元素。 */
function own(element: Record<string, unknown>): Record<string, unknown> {
  const { children: _children, ...rest } = element;
  return rest;
}

/** 两边都有的子元素换了先后次序：排布流中的次序决定位置，单独列出。 */
function childOrderChange(old: Record<string, unknown>, element: Record<string, unknown>): PropertyChange[] {
  const names = (node: Record<string, unknown>) => (Array.isArray(node['children']) ? node['children'] : []).filter(isRecord).map((child) => String(child['name']));
  const before = names(old), after = names(element);
  const common = (list: string[], other: string[]) => list.filter((item) => other.includes(item));
  return canonical(common(before, after)) === canonical(common(after, before)) ? [] : [{ key: 'children', before, after }];
}

function namedListChanges(before: unknown[], after: unknown[]): PropertyChange[] {
  const named = (list: unknown[]) => new Map(list.map((item, index) => [isRecord(item) && typeof item['name'] === 'string' ? item['name'] : `#${index + 1}`, item]));
  const a = named(before), b = named(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => canonical(a.get(key)) !== canonical(b.get(key)))
    .map((key) => ({ key, ...(a.has(key) ? { before: a.get(key) } : {}), ...(b.has(key) ? { after: b.get(key) } : {}) }));
}

function unionKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/** 一份模板候选在模板辅助修改中的地位：改动了已保存的模板、与已保存的相同，或是新增的模板。 */
export interface RevisionDiff {
  readonly status: 'modified' | 'unchanged' | 'added';
  /** 相对已保存内容的差异；新增的模板没有。 */
  readonly changes: readonly TemplateChange[];
}

/** saved 是同名的已保存模板，没有时候选是新增的模板。 */
export function revisionDiff(saved: unknown, document: unknown): RevisionDiff {
  if (saved === undefined) return { status: 'added', changes: [] };
  const changes = diffTemplate(saved, document);
  return { status: changes.length === 0 ? 'unchanged' : 'modified', changes };
}
