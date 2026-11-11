/**
 * 提取为子模板（模板设计页票据 19，方案第 5 节，ADR-0007）：选中的一块元素搬进新模板，原地换成子模板调用。纯函数。
 * 图要逐像素不变，所以：
 * - 新模板的画板是不加排布、没有内边距与样式的空板，里面只有这块元素本身；它的样式、状态样式、旋转、不透明度都跟着它走，
 *   位置只留尺寸（宽高与最小最大，撑满、固定、随内容照旧），在空板上从左上角排；
 * - 调用接过原来的位置（自由布局的锚点、堆叠与网格的边距、对齐与行列）和显示，分给新画板的框就是原来的元素框；
 *   调用的画板展开成容器时不加任何绘制（引擎 src/evaluate.ts 的 invoke），所以图不变；
 * - 基准与当前模板相同，调用传当前数据（current）；画板的缩字下限照抄（缩字组按所在模板的画板取下限，M238）；
 * - 用到的参数变成新模板的对外参数，由调用按同名变量传入；用到的派生变量连同它们依赖的复制过去，原模板里的不动。
 * 状态样式改了位置或显示的元素不能提取：调用只能按取值换位置与显示，元素自己的那份接不住。
 */
import { setElement } from './calls.js';
import { elementAt, isObject, variableClosure, elementVariables, type JsonObject } from './document.js';

export interface SizeRange { readonly width: { readonly min: number; readonly max: number }; readonly height: { readonly min: number; readonly max: number } }

export interface ExtractPlan {
  /** 建议的新模板名称：元素名，重了加序号。 */
  readonly name: string;
  /** 变成新模板对外参数、由调用传入的参数。 */
  readonly parameters: readonly string[];
  /** 复制过去的派生变量（含依赖），按原模板里的先后。 */
  readonly derived: readonly string[];
  /** 用到的数据字段（第一段）。 */
  readonly fields: readonly string[];
  /** 用到的数据都在同一个单引用字段下面：可以改成只传这个字段。 */
  readonly singleRef?: string;
  /** 适用尺寸范围：图上各处的实际尺寸，两头放宽。 */
  readonly sizeRange: SizeRange;
  /** 提取不了的原因。 */
  readonly problem?: string;
}

const SIZE_KEYS = ['width', 'height', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const;
const namedList = (document: JsonObject, list: string): readonly JsonObject[] => (Array.isArray(document[list]) ? (document[list] as unknown[]).filter(isObject) : []);
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').at(-1)!;
const modeOf = (element: JsonObject | undefined) => (isObject(element?.['layout']) && typeof element['layout']['mode'] === 'string' ? element['layout']['mode'] : 'free');

/** 一块元素（含全部子元素）用到的变量与插槽。 */
export function subtreeVariables(element: JsonObject): readonly string[] {
  const found = new Set<string>();
  const walk = (node: JsonObject) => {
    for (const name of elementVariables(node)) found.add(name);
    for (const child of Array.isArray(node['children']) ? node['children'] : []) if (isObject(child)) walk(child);
  };
  walk(element);
  return [...found];
}

/** 状态样式改了位置或显示：调用接不住。 */
function statesBlock(element: JsonObject): string | undefined {
  const cases = isObject(element['states']) && isObject(element['states']['cases']) ? element['states']['cases'] : {};
  const keys = new Set(Object.values(cases).flatMap((item) => (isObject(item) ? Object.keys(item) : [])));
  const moved = ['place', 'visible'].filter((key) => keys.has(key));
  return moved.length ? `状态样式按取值改了${moved.map((key) => (key === 'place' ? '位置与尺寸' : '显示')).join('与')}，提取后调用接不住：先去掉这几项覆盖再提取。` : undefined;
}

/** 范围两头放宽：最小取一半，最大取两倍，留一位小数。 */
function roomy(sizes: readonly number[]): { readonly min: number; readonly max: number } {
  const usable = sizes.filter((size) => Number.isFinite(size) && size > 0);
  if (!usable.length) return { min: 1, max: 2000 };
  return { min: Math.max(0.1, Math.floor(Math.min(...usable) * 5) / 10), max: Math.ceil(Math.max(...usable) * 20) / 10 };
}

/** 提取前先看：会带走哪些参数与派生变量、建议的名称与尺寸范围、能不能提取。boxes 是这块元素在图上各处的实际尺寸。 */
export function planExtract(document: JsonObject, template: string, path: string, boxes: readonly { readonly width: number; readonly height: number }[], taken: ReadonlySet<string>): ExtractPlan {
  const element = elementAt(document, path)?.element;
  const sizeRange = { width: roomy(boxes.map((box) => box.width)), height: roomy(boxes.map((box) => box.height)) };
  const base = nameOf(path);
  let name = base;
  for (let index = 2; taken.has(name) || name === template; index++) name = `${base}${index}`;
  const empty = { name, parameters: [], derived: [], fields: [], sizeRange };
  if (!element || path === template) return { ...empty, problem: '画板不能提取：选中画板里的一块元素。' };
  const blocked = statesBlock(element);
  if (blocked) return { ...empty, problem: blocked };
  const closure = variableClosure(document, subtreeVariables(element).map((variable) => variable.split('.')[0]!));
  const parameters = namedList(document, 'parameters').map((item) => String(item['name'])).filter((item) => closure.has(item));
  const derived = namedList(document, 'derived').map((item) => String(item['name'])).filter((item) => closure.has(item));
  const declared = new Set([...parameters, ...derived]);
  const fields = [...closure].filter((item) => !declared.has(item));
  // 只用到某个单引用字段下面的值（terminal.name、terminal.code）：提示可以改成只传它。
  const used = [...variableClosure(document, subtreeVariables(element))].filter((item) => !declared.has(item.split('.')[0]!));
  const heads = new Set(used.map((item) => item.split('.')[0]!));
  const singleRef = heads.size === 1 && used.every((item) => item.includes('.')) ? [...heads][0] : undefined;
  return { name, parameters, derived, fields, ...(singleRef ? { singleRef } : {}), sizeRange };
}

/**
 * 提取：callee 是新模板的整份文档，caller 是原模板换成调用之后的文档。
 * 新模板的名称由调用方定（页面先建好空白工作副本），尺寸范围可改。
 */
export function extractTemplate(document: JsonObject, template: string, path: string, options: { readonly name: string; readonly sizeRange: SizeRange }):
  { readonly caller: JsonObject; readonly callee: JsonObject } | { readonly problem: string } {
  const located = elementAt(document, path);
  const element = located?.element;
  if (!element || path === template) return { problem: '画板不能提取：选中画板里的一块元素。' };
  const blocked = statesBlock(element);
  if (blocked) return { problem: blocked };
  const plan = planExtract(document, template, path, [], new Set());
  const parent = elementAt(document, parentPath(path))?.element;
  const place = isObject(element['place']) ? element['place'] : {};
  // 网格里没写宽高就是撑满格子；在空板上要写明撑满，框才一样大。
  const fallback = modeOf(parent) === 'grid' ? 'fill' : undefined;
  const inner: JsonObject = {};
  for (const key of SIZE_KEYS) {
    const value = place[key] ?? ((key === 'width' || key === 'height') ? fallback : undefined);
    if (value !== undefined) inner[key] = value;
  }
  const { place: _place, visible, ...rest } = element;
  const moved: JsonObject = { ...rest, ...(Object.keys(inner).length ? { place: inner } : {}) };
  const parameters = namedList(document, 'parameters').filter((item) => plan.parameters.includes(String(item['name']))).map((item) => ({ ...item, visibility: 'public' }));
  const derived = namedList(document, 'derived').filter((item) => plan.derived.includes(String(item['name'])));
  const board = isObject(document['artboard']) ? document['artboard'] : {};
  const callee: JsonObject = {
    dslVersion: document['dslVersion'], name: options.name, base: document['base'],
    ...(parameters.length ? { parameters } : {}), ...(derived.length ? { derived } : {}),
    artboard: { sizeRange: options.sizeRange, ...(typeof board['minFontSize'] === 'number' ? { minFontSize: board['minFontSize'] } : {}), children: [moved] },
  };
  const call: JsonObject = {
    type: 'call', name: element['name'],
    ...(Object.keys(place).length ? { place } : {}), ...(visible !== undefined ? { visible } : {}),
    template: options.name, data: 'current',
    ...(plan.parameters.length ? { args: Object.fromEntries(plan.parameters.map((item) => [item, { var: item }])) } : {}),
  };
  return { caller: setElement(document, path, call), callee };
}
