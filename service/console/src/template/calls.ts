/**
 * 循环与调用的表单（模板设计页票据 15，方案第 7 节）：传入参数、每项排布与它们的互斥。纯函数，给元素回答新元素；原元素不变。
 * DSL 的规矩（docs/dsl/template.md「循环」「调用」）：
 * - 横向写每项宽（widths），纵向写每项高（heights）；
 * - 折行不能配等分，也不能配合并相邻；合并相邻只能配等分，并且 spanBy 写 groupSize；
 * - 循环信息（序号、是否首项……）只能经 args 传给被调模板，被调模板要有同名的对外参数接收。
 */
import { isObject, type JsonObject } from './document.js';

export type Direction = 'row' | 'column';
export type ItemSize = 'equal' | 'content' | { readonly fixed: number };

export const LOOP_INFOS: readonly (readonly [string, string])[] = [['index', '循环序号'], ['isFirst', '是否首项'], ['isLast', '是否末项'], ['count', '总项数'], ['groupSize', '组内项数']];
/** 循环信息的类型：被调模板接收它的参数要是这个类型。 */
export const LOOP_INFO_TYPES: Readonly<Record<string, string>> = { index: 'number', isFirst: 'boolean', isLast: 'boolean', count: 'number', groupSize: 'number' };

const layoutOf = (element: JsonObject): JsonObject => (isObject(element['itemLayout']) ? element['itemLayout'] : {});
export const directionOf = (element: JsonObject): Direction => (layoutOf(element)['direction'] === 'column' ? 'column' : 'row');
const sizeKey = (direction: Direction) => (direction === 'column' ? 'heights' : 'widths');
export const itemSizeOf = (element: JsonObject): ItemSize | undefined => layoutOf(element)[sizeKey(directionOf(element))] as ItemSize | undefined;
export const wrapOf = (element: JsonObject) => layoutOf(element)['wrap'] === true;
export const mergeOf = (element: JsonObject) => (typeof element['mergeBy'] === 'string' ? element['mergeBy'] : undefined);

const withLayout = (element: JsonObject, layout: JsonObject): JsonObject => ({ ...element, itemLayout: layout });

/** 换方向：每项尺寸跟着从 widths 换到 heights（或反过来），值不变。 */
export function setDirection(element: JsonObject, direction: Direction): JsonObject {
  const layout = layoutOf(element), from = sizeKey(directionOf(element)), to = sizeKey(direction);
  const { [from]: size, ...rest } = layout;
  return withLayout(element, { ...rest, direction, [to]: size ?? 'equal' });
}

/** 为什么这种每项尺寸现在不能选；能选时 undefined。 */
export function sizeBlocked(element: JsonObject, size: 'equal' | 'content' | 'fixed'): string | undefined {
  if (size === 'equal' && wrapOf(element)) return '折行不能配等分';
  if (size !== 'equal' && mergeOf(element)) return '合并相邻只能配等分';
  return undefined;
}
export const wrapBlocked = (element: JsonObject): string | undefined => (mergeOf(element) ? '折行不能配合并相邻' : itemSizeOf(element) === 'equal' ? '折行不能配等分：先把每项尺寸换成随内容或固定' : undefined);
export const mergeBlocked = (element: JsonObject): string | undefined => (wrapOf(element) ? '合并相邻不能配折行' : undefined);

export function setItemSize(element: JsonObject, size: ItemSize): JsonObject | { readonly problem: string } {
  const kind = typeof size === 'string' ? size : 'fixed', problem = sizeBlocked(element, kind);
  if (problem) return { problem };
  return withLayout(element, { ...layoutOf(element), [sizeKey(directionOf(element))]: size });
}

/** 折行：开了才有换行间距；关掉时换行间距一起去掉。 */
export function setWrap(element: JsonObject, on: boolean): JsonObject | { readonly problem: string } {
  if (on) { const problem = wrapBlocked(element); if (problem) return { problem }; }
  const { wrap: _wrap, crossGap: _crossGap, ...rest } = layoutOf(element);
  return withLayout(element, on ? { ...rest, wrap: true } : rest);
}

/** 合并相邻同值项：写 mergeBy，每项尺寸换成等分并写 spanBy；去掉时 spanBy 一起去掉。 */
export function setMergeBy(element: JsonObject, field: string | undefined): JsonObject | { readonly problem: string } {
  const { spanBy: _spanBy, ...layout } = layoutOf(element);
  if (field === undefined) {
    const { mergeBy: _mergeBy, ...rest } = element;
    return withLayout(rest, layout);
  }
  const problem = mergeBlocked(element);
  if (problem) return { problem };
  return withLayout({ ...element, mergeBy: field }, { ...layout, [sizeKey(directionOf(element))]: 'equal', spanBy: 'groupSize' });
}

// —— 传入参数 ——

export interface ArgRow {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  readonly hasDefault: boolean;
  /** 现在传的：变量、固定值或循环信息；没传时 undefined。 */
  readonly value?: JsonObject;
  /** 没有缺省值又没传：被调模板拿不到值。 */
  readonly missing: boolean;
}

/** 被调模板的全部对外参数，一行一个；被调模板没有声明的 args（多传的）另列，删掉才合法。 */
export function argRows(element: JsonObject, called: JsonObject | undefined): { readonly rows: readonly ArgRow[]; readonly extra: readonly string[] } {
  const args = isObject(element['args']) ? element['args'] : {};
  const parameters = (Array.isArray(called?.['parameters']) ? called['parameters'] as unknown[] : []).filter(isObject).filter((item) => item['visibility'] === 'public');
  const rows = parameters.map((parameter): ArgRow => {
    const name = String(parameter['name']), value = isObject(args[name]) ? args[name] as JsonObject : undefined;
    return { name, label: String(parameter['displayName'] ?? name), type: String(parameter['type']), hasDefault: 'default' in parameter, ...(value ? { value } : {}), missing: !value && !('default' in parameter) };
  });
  return { rows, extra: Object.keys(args).filter((name) => !parameters.some((parameter) => parameter['name'] === name)) };
}

/** 改一个传入参数；undefined 是不传（用被调模板的缺省值）。args 空了就去掉这个键。 */
export function writeArg(element: JsonObject, name: string, value: JsonObject | undefined): JsonObject {
  const args = { ...(isObject(element['args']) ? element['args'] : {}) };
  if (value === undefined) delete args[name]; else args[name] = value;
  const { args: _args, ...rest } = element;
  return Object.keys(args).length ? { ...rest, args } : rest;
}

/** 循环信息只给循环用，调用没有循环信息。 */
export const canUseLoopInfo = (element: JsonObject) => element['type'] === 'loop';

/** 调用传什么数据：'current'、'none' 或单引用字段名。 */
export function dataOf(element: JsonObject): string {
  const data = element['data'];
  return data === 'current' ? 'current' : isObject(data) && typeof data['var'] === 'string' ? data['var'] : 'none';
}
export function setData(element: JsonObject, data: string): JsonObject {
  const { data: _data, ...rest } = element;
  return data === 'none' ? rest : { ...rest, data: data === 'current' ? 'current' : { var: data } };
}

/** 文档里换掉一个元素：沿路径复制，别的内容原样。 */
export function setElement(document: JsonObject, path: string, element: JsonObject): JsonObject {
  const [, ...names] = path.split('/');
  const walk = (node: JsonObject, rest: readonly string[]): JsonObject => (rest.length === 0 ? element
    : { ...node, children: (Array.isArray(node['children']) ? node['children'] as unknown[] : []).map((child) => (isObject(child) && child['name'] === rest[0] ? walk(child, rest.slice(1)) : child)) });
  return { ...document, artboard: walk(document['artboard'] as JsonObject, names) };
}
