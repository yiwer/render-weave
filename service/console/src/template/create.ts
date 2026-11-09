/**
 * 添加元素（模板设计页票据 14，方案第 13 节）：元素目录与从字段创建。纯函数，给文档、模板名与放在哪，回答新文档与新元素的路径。
 * - 新元素的必填项给合法的初值（文字的字体取模板里已在用的），名称在模板内唯一；
 * - 放下的位置决定写什么：堆叠是顺序，网格是行列，自由布局才是坐标；
 * - 字段映射：文本、数值、日期、时刻、时间变文字加插槽；图片变图片；布尔绑到选中元素的显示；单引用变子模板调用；列表变循环容器。
 *   列表与单引用要选被调模板，只列基准相符的（template.loopBaseMismatch、callBaseMismatch）。
 */
import { flatElements, isObject, type JsonObject } from './document.js';
import { firstFont, fitChildren } from './properties.js';
import type { Edited } from './structure.js';

export type NewKind = 'text' | 'image' | 'qrcode' | 'barcode' | 'rect' | 'ellipse' | 'line' | 'polygon' | 'path' | 'container' | 'loop' | 'call';

/** 元素目录：DSL 的全部元素类型。循环与调用要先选模板。 */
export const CATALOG: readonly { readonly kind: NewKind; readonly label: string; readonly needsTemplate?: true }[] = [
  { kind: 'text', label: '文字' }, { kind: 'image', label: '图片' }, { kind: 'qrcode', label: '二维码' }, { kind: 'barcode', label: '条码' },
  { kind: 'rect', label: '矩形' }, { kind: 'ellipse', label: '椭圆' }, { kind: 'line', label: '线条' }, { kind: 'polygon', label: '多边形' }, { kind: 'path', label: '路径' },
  { kind: 'container', label: '容器' }, { kind: 'loop', label: '循环容器', needsTemplate: true }, { kind: 'call', label: '子模板调用', needsTemplate: true },
];

/** 字体资源一个也没用过时的后备：页面传进来资源库里的第一种字体。 */
const FALLBACK_FONT = 'res:font-hei-medium';
const GREY = '#CCCCCC';

/** 新元素的默认尺寸（毫米）：形状与码给固定尺寸，文字随内容。 */
const SIZES: Readonly<Partial<Record<NewKind, readonly [number, number]>>> = {
  image: [20, 20], qrcode: [15, 15], barcode: [30, 10], rect: [20, 10], ellipse: [15, 15], container: [30, 20], loop: [60, 20], call: [40, 20],
};

export interface Bindings {
  /** 循环的列表变量。 */
  readonly list?: string;
  /** 循环与调用的被调模板。 */
  readonly template?: string;
  /** 调用的数据：不传、调用方的当前数据，或一个单引用字段。 */
  readonly data?: 'none' | 'current' | { readonly var: string };
  /** 资源库里的一种字体：模板里还没用过字体时给文字用。 */
  readonly font?: string;
}

/** 一种元素的初值：必填项都有，合 Schema。名称由 insertElement 起。 */
export function newElement(kind: NewKind, document: JsonObject, bindings: Bindings = {}): JsonObject {
  switch (kind) {
    case 'text': return { type: 'text', content: [{ text: '文字' }], font: firstFont(document) ?? bindings.font ?? FALLBACK_FONT, fontSize: 5 };
    case 'image': return { type: 'image' };
    case 'qrcode': return { type: 'qrcode', content: '二维码内容' };
    case 'barcode': return { type: 'barcode', content: '123456', format: 'CODE128' };
    case 'rect': return { type: 'rect', fill: GREY };
    case 'ellipse': return { type: 'ellipse', fill: GREY };
    case 'line': return { type: 'line', from: [0, 0], to: [20, 0], stroke: { color: '#000000', width: 0.3 } };
    case 'polygon': return { type: 'polygon', points: [[0, 10], [10, 0], [20, 10]], fill: GREY };
    case 'path': return { type: 'path', d: 'M0 10 L10 0 L20 10 Z', fill: GREY };
    case 'container': return { type: 'container', layout: { mode: 'stack', direction: 'column' } };
    case 'loop': return { type: 'loop', list: { var: bindings.list ?? '' }, template: bindings.template ?? '', itemLayout: { direction: 'row', widths: 'equal' } };
    case 'call': {
      const data = bindings.data ?? 'none';
      return { type: 'call', template: bindings.template ?? '', ...(data === 'none' ? {} : { data }) };
    }
  }
}

const childrenOf = (node: JsonObject): unknown[] => (Array.isArray(node['children']) ? node['children'] as unknown[] : []);
const modeOf = (node: JsonObject) => (isObject(node['layout']) && typeof node['layout']['mode'] === 'string' ? node['layout']['mode'] : 'free');

function find(document: JsonObject, path: string): JsonObject | undefined {
  if (!isObject(document['artboard'])) return undefined;
  let node: JsonObject | undefined = document['artboard'];
  for (const name of path.split('/').slice(1)) node = node && childrenOf(node).filter(isObject).find((child) => child['name'] === name);
  return node;
}

function update(document: JsonObject, path: string, change: (element: JsonObject) => JsonObject): JsonObject {
  const [, ...names] = path.split('/');
  const walk = (node: JsonObject, rest: readonly string[]): JsonObject => (rest.length === 0 ? change(node)
    : { ...node, children: childrenOf(node).map((child) => (isObject(child) && child['name'] === rest[0] ? walk(child, rest.slice(1)) : child)) });
  return { ...document, artboard: walk(document['artboard'] as JsonObject, names) };
}

/** 放在哪：堆叠里的第几位，网格的哪一格，自由布局里的坐标（毫米，相对容器左上角）。都不给时加在最后。 */
export interface Drop { readonly index?: number; readonly cell?: { readonly row: number; readonly column: number }; readonly point?: { readonly x: number; readonly y: number } }

const half = (value: number) => Math.round(value * 2) / 2;

/**
 * 把新元素放进 container：起不重的名字，按父容器的布局写 place，再按布局只留它认识的键（同改排布方式时）。
 * container 不是容器或画板时 undefined。
 */
export function insertElement(document: JsonObject, template: string, container: string, element: JsonObject, at: Drop = {}): Edited | undefined {
  const holder = find(document, container);
  if (!holder || (container !== template && holder['type'] !== 'container')) return undefined;
  const taken = new Set(flatElements(document, template).map((node) => node.name));
  const base = String(element['name'] ?? labelOf(String(element['type'])));
  let name = base;
  for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
  const kind = String(element['type']) as NewKind, size = SIZES[kind], mode = modeOf(holder);
  const sized = size ? { width: { fixed: size[0] }, height: { fixed: size[1] } } : {};
  const count = childrenOf(holder).length;
  const place: JsonObject = mode === 'free'
    ? { left: half(at.point?.x ?? 2 + (count % 10) * 2), top: half(at.point?.y ?? 2 + (count % 10) * 2), ...sized }
    : mode === 'grid' && at.cell ? { row: at.cell.row, column: at.cell.column, ...sized } : { ...sized };
  const placed: JsonObject = { ...element, name, ...(Object.keys(place).length ? { place } : {}) };
  const index = Math.max(0, Math.min(at.index ?? count, count));
  const next = update(document, container, (node) => fitChildren({ ...node, children: [...childrenOf(node).slice(0, index), placed, ...childrenOf(node).slice(index)] }));
  return { document: next, path: `${container}/${name}` };
}

const labelOf = (type: string) => CATALOG.find((item) => item.kind === type)?.label ?? '元素';

/** 加到哪：选中的是容器或画板就放进去，加在最后；选中的是别的元素就放在它后面。 */
export function insertionPoint(document: JsonObject, template: string, selected: string | undefined): { readonly container: string; readonly index: number } {
  const path = selected && find(document, selected) ? selected : template;
  const node = find(document, path)!;
  if (path === template || node['type'] === 'container') return { container: path, index: childrenOf(node).length };
  const container = path.slice(0, path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/') + 1);
  const siblings = childrenOf(find(document, container)!);
  return { container, index: siblings.findIndex((child) => isObject(child) && child['name'] === name) + 1 };
}

// —— 从字段创建 ——

export interface SchemaRef { readonly name: string; readonly version: number }

/** 数据定义里的一个字段：类型；单引用与列表另有指向的数据定义。 */
export interface FieldInfo {
  readonly name: string;
  readonly label: string;
  readonly type: string;
  /** 单引用指向的数据定义；列表是每一项的数据定义（基本类型的列表用对应的单值数据定义）。 */
  readonly target?: SchemaRef;
}

const SINGLE_LABELS: Readonly<Record<string, string>> = { text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片' };

/** 数据定义文档里的字段换成 FieldInfo：列表的项是引用时指向它，是基本类型时指向单值数据定义（DSL：被调模板的基准必须是列表元素的数据定义）。 */
export function fieldInfo(field: { readonly name: string; readonly displayName?: string; readonly type: string; readonly ref?: SchemaRef; readonly items?: { readonly type: string; readonly ref?: SchemaRef } }): FieldInfo {
  const label = field.displayName || field.name;
  if (field.type === 'ref' && field.ref) return { name: field.name, label, type: 'ref', target: field.ref };
  if (field.type === 'list' && field.items) {
    const target = field.items.type === 'ref' && field.items.ref ? field.items.ref : SINGLE_LABELS[field.items.type] ? { name: `单值·${SINGLE_LABELS[field.items.type]!}`, version: 1 } : undefined;
    return { name: field.name, label, type: 'list', ...(target ? { target } : {}) };
  }
  return { name: field.name, label, type: field.type };
}

export type FieldPlan =
  /** 直接加一个绑定好的元素。 */
  | { readonly kind: 'element'; readonly element: JsonObject }
  /** 布尔：绑到选中元素的显示。 */
  | { readonly kind: 'visible'; readonly variable: string }
  /** 列表与单引用：先选基准是 base 的模板。 */
  | { readonly kind: 'template'; readonly base: SchemaRef; readonly element: (template: string) => JsonObject }
  | { readonly kind: 'none'; readonly reason: string };

/** 一个字段能生成什么。元素名取字段的显示名称（重名时 insertElement 加序号）。 */
export function planFromField(field: FieldInfo, document: JsonObject, bindings: Bindings = {}): FieldPlan {
  const named = (element: JsonObject): JsonObject => ({ ...element, name: field.label });
  switch (field.type) {
    case 'text': case 'number': case 'date': case 'time': case 'datetime':
      return { kind: 'element', element: named({ ...newElement('text', document, bindings), content: [{ slot: field.name }] }) };
    case 'image': return { kind: 'element', element: named({ type: 'image', source: { var: field.name } }) };
    case 'boolean': return { kind: 'visible', variable: field.name };
    case 'ref':
      return field.target ? { kind: 'template', base: field.target, element: (template) => named(newElement('call', document, { template, data: { var: field.name } })) } : { kind: 'none', reason: '读不到这个引用指向的数据定义' };
    case 'list':
      return field.target ? { kind: 'template', base: field.target, element: (template) => named(newElement('loop', document, { list: field.name, template })) } : { kind: 'none', reason: '读不到列表每一项的数据定义' };
    default: return { kind: 'none', reason: `${field.type} 类型的字段不能直接生成元素` };
  }
}

/** 基准相符的模板：列表的项与单引用指向的数据定义同名同版本。 */
export const matchingTemplates = (templates: readonly { readonly name: string; readonly base?: SchemaRef }[], base: SchemaRef) =>
  templates.filter((template) => template.base?.name === base.name && template.base.version === base.version).map((template) => template.name);
