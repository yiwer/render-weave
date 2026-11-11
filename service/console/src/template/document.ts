/**
 * 模板文档的读取（P1 票据 08、09）：页面拿到的是工作副本原文，这里从文档里读出页面要的东西。
 * 不校验：还没写完的工作副本也能打开，问题由服务端的问题清单说明。元素路径与引擎相同：从模板名开始，画板就是模板名。
 */
import type { LayoutNode, TemplateInfo, TemplateParameter } from '../types.js';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 工作副本原文解析成文档；服务端在暂存时核对过是 JSON 对象。 */
export function parseTemplateText(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  return isObject(parsed) ? parsed : {};
}

/** 与服务端写文档的格式相同（两格缩进、末尾换行）。 */
export const templateText = (document: unknown) => `${JSON.stringify(document, null, 2)}\n`;

/**
 * 文档里的模板信息，与 GET /v1/templates/{name} 同样的形状：工作副本的适用尺寸、基准与对外参数可能已经改了，
 * 复制出来还没保存的新模板也只有文档。
 */
export function documentInfo(name: string, document: JsonObject): TemplateInfo {
  const artboard = isObject(document['artboard']) ? document['artboard'] : {};
  const sizeRange = artboard['sizeRange'] as TemplateInfo['sizeRange'];
  const parameters = Array.isArray(document['parameters']) ? document['parameters'] as (TemplateParameter & { readonly visibility?: string })[] : [];
  return {
    name, currentRevision: 0,
    ...(isObject(document['base']) ? { base: document['base'] as unknown as NonNullable<TemplateInfo['base']> } : {}),
    ...(sizeRange ? { sizeRange } : {}),
    parameters: parameters.filter((parameter) => parameter.visibility === 'public'),
  };
}

const childrenOf = (node: JsonObject): JsonObject[] => (Array.isArray(node['children']) ? (node['children'] as unknown[]).filter(isObject) : []);

/** 按元素路径找元素：路径第一段是模板名，只有一段时是画板（没有父元素）。 */
export function elementAt(document: unknown, path: string): { readonly element: JsonObject; readonly parent?: JsonObject } | undefined {
  if (!isObject(document) || !isObject(document['artboard'])) return undefined;
  const [, ...names] = path.split('/');
  let element: JsonObject = document['artboard'], parent: JsonObject | undefined;
  for (const name of names) {
    const child = childrenOf(element).find((candidate) => candidate['name'] === name);
    if (!child) return undefined;
    parent = element;
    element = child;
  }
  return parent ? { element, parent } : { element };
}

export interface ElementNode {
  readonly path: string;
  readonly name: string;
  /** 元素类型；画板是 artboard。 */
  readonly type: string;
  /** 循环容器与子模板调用用的模板。 */
  readonly template?: string;
  readonly children: readonly ElementNode[];
}

/** 结构页的元素树。 */
export function elementTree(document: JsonObject, name: string): ElementNode {
  const walk = (node: JsonObject, path: string): ElementNode => ({
    path, name: path.split('/').at(-1)!, type: path === name ? 'artboard' : String(node['type'] ?? ''),
    ...(typeof node['template'] === 'string' ? { template: node['template'] } : {}),
    children: childrenOf(node).map((child) => walk(child, `${path}/${String(child['name'])}`)),
  });
  return walk(isObject(document['artboard']) ? document['artboard'] : {}, name);
}

/** 文档里全部元素，含画板。 */
export function flatElements(document: JsonObject, name: string): readonly ElementNode[] {
  const walk = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(walk)];
  return walk(elementTree(document, name));
}

/** 元素用到的变量：插槽与 { var }（不含子元素），用来找相关的检查项与绑定的字段。 */
export function elementVariables(element: JsonObject): readonly string[] {
  const found = new Set<string>();
  const walk = (value: unknown, key?: string) => {
    if (Array.isArray(value)) { value.forEach((item) => walk(item)); return; }
    if (!isObject(value)) return;
    if (typeof value['var'] === 'string') found.add(value['var']);
    if (typeof value['slot'] === 'string') found.add(value['slot']);
    for (const [name, item] of Object.entries(value)) if (name !== 'children' || key !== undefined) walk(item, name);
  };
  walk(element);
  return [...found];
}

/** 一个变量经派生变量连带用到的全部变量（含自己）。 */
export function variableClosure(document: JsonObject, variables: readonly string[]): ReadonlySet<string> {
  const derived = new Map((Array.isArray(document['derived']) ? (document['derived'] as unknown[]).filter(isObject) : []).map((item) => [String(item['name']), item]));
  const seen = new Set<string>(), queue = [...variables];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const definition = derived.get(name);
    if (definition) queue.push(...elementVariables(definition));
  }
  return seen;
}

/** 这个元素相关的检查项：检查项用到的变量（连带派生变量）与元素用到的有交集。返回检查项在 checks 里的序号。 */
export function relatedChecks(document: JsonObject, element: JsonObject | undefined): readonly number[] {
  const checks = Array.isArray(document['checks']) ? document['checks'] as unknown[] : [];
  const indexes = checks.map((_, index) => index);
  if (!element) return indexes;
  const mine = variableClosure(document, elementVariables(element));
  return indexes.filter((index) => {
    const check = checks[index];
    return isObject(check) && [...variableClosure(document, elementVariables(check))].some((name) => mine.has(name));
  });
}

/** 变量是数据定义的字段，还是模板自己的参数或派生变量。 */
export function variableKind(document: JsonObject, name: string): 'parameter' | 'derived' | 'field' {
  const has = (list: string) => Array.isArray(document[list]) && (document[list] as unknown[]).some((item) => isObject(item) && item['name'] === name);
  return has('parameters') ? 'parameter' : has('derived') ? 'derived' : 'field';
}

/** 两份文档有几处不同：逐个叶子比；元素里加减一整段算一处。 */
export function changeCount(before: unknown, after: unknown): number {
  if (JSON.stringify(before) === JSON.stringify(after)) return 0;
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].reduce((sum, key) => sum + changeCount(before[key], after[key]), 0);
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    return before.reduce<number>((sum, item, index) => sum + changeCount(item, after[index]), 0);
  }
  return 1;
}

/** 这个位置上的全部元素（毫米，不计旋转），只算会显示的：第一个是最深、最后画的，最后一个是画板。 */
export function hitStack(root: LayoutNode, x: number, y: number): readonly LayoutNode[] {
  const found: LayoutNode[] = [];
  const visit = (node: LayoutNode) => {
    if (!node.visible) return;
    for (const child of [...(node.children ?? [])].reverse()) visit(child);
    if (x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height) found.push(node);
  };
  visit(root);
  return found;
}

/** 元素路径的上一层：循环项的上一层是循环容器本身，其他元素是路径的上一段。 */
export function parentInstance(path: string): string | undefined {
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (/\[\d+\]$/.test(last)) return path.replace(/\[\d+\]$/, '');
  const slash = path.lastIndexOf('/');
  return slash < 0 ? undefined : path.slice(0, slash);
}

/** 这个元素为什么不显示：自身的条件显示，或者上面有一层不显示。 */
export function hiddenReason(document: JsonObject, path: string): string {
  const segments = path.split('/');
  for (let end = segments.length; end > 1; end--) {
    const visible = elementAt(document, segments.slice(0, end).join('/'))?.element['visible'];
    const own = end === segments.length, who = own ? '这个元素' : `上一层「${segments[end - 1]!}」`;
    if (visible === false) return `${who}的显示设为否，隐藏的元素不占位。`;
    if (isObject(visible) && typeof visible['var'] === 'string') return `${who}按变量 ${visible['var']} 决定显示，当前数据下不显示，隐藏的元素不占位。`;
  }
  return '当前数据下这个元素不显示，图上没有框。';
}
