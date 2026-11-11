/**
 * 改结构（模板设计页票据 12，方案第 5 节）：复制、删除、排序、移到别的容器、包进容器、拆开容器、重命名。纯函数，给文档、模板名与元素路径，
 * 回答新文档与操作之后该选中的路径；原文档不变。页面每个操作写回一次，所以一步撤销。
 * - 元素名在模板内唯一（DSL：名称非空，不含 /、[、]），复制时连子元素一起起新名；
 * - 换了父容器，place 只留新布局认识的键，网格补上行列（同 writeProperty 改排布方式时的 fitChildren）；
 * - 顺序就是 DSL 的顺序：后面的压在前面的上面，也是堆叠里的先后。
 */
import { flatElements, isObject, type JsonObject } from './document.js';
import { fitChildren } from './properties.js';

export interface Edited {
  readonly document: JsonObject;
  /** 操作之后选中的元素路径。 */
  readonly path: string;
}

const childrenOf = (node: JsonObject): unknown[] => (Array.isArray(node['children']) ? node['children'] as unknown[] : []);
const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/'));
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** 沿路径复制，改掉路径上的那一个元素；路径不存在时原样。 */
function update(document: JsonObject, path: string, change: (element: JsonObject) => JsonObject): JsonObject {
  if (!isObject(document['artboard'])) return document;
  const [, ...names] = path.split('/');
  const walk = (node: JsonObject, rest: readonly string[]): JsonObject => {
    if (rest.length === 0) return change(node);
    return { ...node, children: childrenOf(node).map((child) => (isObject(child) && child['name'] === rest[0] ? walk(child, rest.slice(1)) : child)) };
  };
  return { ...document, artboard: walk(document['artboard'], names) };
}

function find(document: JsonObject, path: string): JsonObject | undefined {
  if (!isObject(document['artboard'])) return undefined;
  let node: JsonObject | undefined = document['artboard'];
  for (const name of path.split('/').slice(1)) node = node && childrenOf(node).filter(isObject).find((child) => child['name'] === name);
  return node;
}

const takenNames = (document: JsonObject, template: string) => new Set(flatElements(document, template).filter((node) => node.path !== template).map((node) => node.name));

/** 名称合不合规；合规时是 undefined。path 是改名的元素自己，它现在的名字不算重名。 */
export function nameProblem(document: JsonObject, template: string, path: string, name: string): string | undefined {
  if (name.trim() === '') return '名称不能为空';
  if (/[/[\]]/u.test(name)) return '名称不能带 /、[ 或 ]：它们是元素路径的分隔';
  const own = nameOf(path);
  return name !== own && takenNames(document, template).has(name) ? `这个模板里已经有「${name}」：元素名在模板内唯一` : undefined;
}

/** 起一个模板里还没有的名字：先用原名，重了加序号。 */
function uniqueName(taken: Set<string>, base: string): string {
  let name = base;
  for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
  taken.add(name);
  return name;
}

/** 复制出来的一整枝都要新名字。 */
function renamedCopy(element: JsonObject, taken: Set<string>): JsonObject {
  const copy: JsonObject = { ...element, name: uniqueName(taken, String(element['name'] ?? '元素')) };
  if (Array.isArray(element['children'])) copy['children'] = (element['children'] as unknown[]).map((child) => (isObject(child) ? renamedCopy(child, taken) : child));
  return copy;
}

/** 能装子元素的：画板与容器。循环与调用的内容在被调模板里。 */
export const canHoldChildren = (element: JsonObject | undefined, isArtboard: boolean) => isArtboard || element?.['type'] === 'container';

/** 复制一份放在原件后面；自由布局里错开 2 mm，不然看不出多了一个。 */
export function duplicateElement(document: JsonObject, template: string, path: string): Edited | undefined {
  const element = find(document, path);
  if (!element || path === template) return undefined;
  const copy = renamedCopy(element, takenNames(document, template));
  const place = isObject(copy['place']) ? { ...copy['place'] } : undefined;
  if (place) {
    for (const key of ['left', 'top', 'right', 'bottom']) if (typeof place[key] === 'number') place[key] = (place[key] as number) + (key === 'left' || key === 'top' ? 2 : -2);
    copy['place'] = place;
  }
  const parent = parentOf(path);
  const next = update(document, parent, (node) => {
    const children = childrenOf(node), at = children.findIndex((child) => isObject(child) && child['name'] === nameOf(path));
    return { ...node, children: [...children.slice(0, at + 1), copy, ...children.slice(at + 1)] };
  });
  return { document: next, path: `${parent}/${String(copy['name'])}` };
}

export function deleteElement(document: JsonObject, template: string, path: string): Edited | undefined {
  if (path === template || !find(document, path)) return undefined;
  const parent = parentOf(path);
  return { document: update(document, parent, (node) => ({ ...node, children: childrenOf(node).filter((child) => !(isObject(child) && child['name'] === nameOf(path))) })), path: parent };
}

/** 上移、下移一位：到头时 undefined。 */
export function moveElement(document: JsonObject, template: string, path: string, step: -1 | 1): Edited | undefined {
  if (path === template) return undefined;
  const parent = find(document, parentOf(path));
  if (!parent) return undefined;
  const children = childrenOf(parent), at = children.findIndex((child) => isObject(child) && child['name'] === nameOf(path)), to = at + step;
  if (at < 0 || to < 0 || to >= children.length) return undefined;
  const reordered = [...children];
  [reordered[at], reordered[to]] = [reordered[to], reordered[at]];
  return { document: update(document, parentOf(path), (node) => fitChildren({ ...node, children: reordered })), path };
}

/**
 * 拖到别处：放进 target 这个容器的第 index 位（按放之前的子元素数）。不能放进自己或自己的子孙，也不能放进循环与调用。
 * 换了父容器时 place 按新布局调整。
 */
export function moveElementTo(document: JsonObject, template: string, path: string, target: string, index: number): Edited | undefined {
  const element = find(document, path), holder = find(document, target);
  if (!element || path === template || !canHoldChildren(holder, target === template)) return undefined;
  if (target === path || target.startsWith(`${path}/`)) return undefined;
  const from = parentOf(path);
  const siblings = childrenOf(find(document, from)!), at = siblings.findIndex((child) => isObject(child) && child['name'] === nameOf(path));
  // 同一个容器里往后挪：拿走自己之后，后面的位置都前移一位。
  const insertAt = from === target && at < index ? index - 1 : index;
  if (from === target && insertAt === at) return undefined;
  const removed = update(document, from, (node) => ({ ...node, children: childrenOf(node).filter((child) => child !== siblings[at]) }));
  const next = update(removed, target, (node) => {
    const children = childrenOf(node);
    const placed = Math.max(0, Math.min(insertAt, children.length));
    return fitChildren({ ...node, children: [...children.slice(0, placed), element, ...children.slice(placed)] });
  });
  return { document: next, path: `${target}/${nameOf(path)}` };
}

/**
 * 包进容器：新容器占原来的位置（拿走 place），纵向堆叠；原元素在里面只留堆叠认识的尺寸。这样图看起来不变。
 */
export function wrapInContainer(document: JsonObject, template: string, path: string): Edited | undefined {
  const element = find(document, path);
  if (!element || path === template) return undefined;
  const name = uniqueName(takenNames(document, template), '容器');
  const { place, ...rest } = element;
  const inner: JsonObject = isObject(place) ? { ...rest, place } : rest;
  const container = fitChildren({ type: 'container', name, layout: { mode: 'stack', direction: 'column' }, ...(isObject(place) ? { place } : {}), children: [inner] });
  const parent = parentOf(path);
  const next = update(document, parent, (node) => ({ ...node, children: childrenOf(node).map((child) => (isObject(child) && child['name'] === nameOf(path) ? container : child)) }));
  return { document: next, path: `${parent}/${name}` };
}

/** 拆开容器：子元素按原来的顺序放回容器所在的位置，place 按外层的布局调整。容器自己的外观随之去掉。 */
export function unwrapContainer(document: JsonObject, template: string, path: string): Edited | undefined {
  const element = find(document, path);
  if (!element || path === template || element['type'] !== 'container') return undefined;
  const inner = childrenOf(element), parent = parentOf(path);
  const next = update(document, parent, (node) => fitChildren({ ...node, children: childrenOf(node).flatMap((child) => (isObject(child) && child['name'] === nameOf(path) ? inner : [child])) }));
  const first = inner.find(isObject);
  return { document: next, path: first ? `${parent}/${String(first['name'])}` : parent };
}

/** 重命名；名称不合规时回答问题，不改。 */
export function renameElement(document: JsonObject, template: string, path: string, name: string): Edited | { readonly problem: string } | undefined {
  if (path === template || !find(document, path)) return undefined;
  const problem = nameProblem(document, template, path, name);
  if (problem) return { problem };
  return { document: update(document, path, (node) => ({ ...node, name })), path: `${parentOf(path)}/${name}` };
}

export type DropZone = 'before' | 'after' | 'inside';

/**
 * 拖到树上某一行的上半、下半或里面：换算成放进哪个容器的第几位。放不进去时 undefined（画板之外的地方、循环与调用的里面）。
 */
export function dropTarget(document: JsonObject, template: string, over: string, zone: DropZone): { readonly target: string; readonly index: number } | undefined {
  const node = find(document, over);
  if (!node) return undefined;
  if (zone === 'inside') return canHoldChildren(node, over === template) ? { target: over, index: childrenOf(node).length } : undefined;
  if (over === template) return undefined;
  const parent = parentOf(over), siblings = childrenOf(find(document, parent)!);
  const at = siblings.findIndex((child) => isObject(child) && child['name'] === nameOf(over));
  return { target: parent, index: zone === 'before' ? at : at + 1 };
}

/** 调用这个模板的地方：循环与调用的元素路径。删改被多处调用的子模板前先列出来。 */
export function callersOf(template: string, documents: readonly { readonly name: string; readonly document: JsonObject }[]): readonly string[] {
  return documents.flatMap(({ name, document }) => flatElements(document, name).filter((node) => node.template === template).map((node) => node.path));
}
