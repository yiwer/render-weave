/**
 * 跨模板的结构树（模板设计页票据 05，方案第 5 节）：从根模板一路展开到循环模板与子模板，不用在模板之间切页。纯函数，给根模板名与读文档的函数。
 * 树里的一行有两个身份：key 是这条调用链上的位置（同一个模板被调两处是两行），template 与 path 是它在模板文档里的定义。
 */
import { isObject, type JsonObject } from './document.js';

export interface TreeNode {
  /** 调用链上的位置：元素路径去掉循环序号，同 ElementPath 的写法。 */
  readonly key: string;
  readonly template: string;
  readonly path: string;
  readonly name: string;
  /** 元素类型；画板是 artboard。 */
  readonly type: string;
  /** 容器与画板的排布：横、纵、网格、自由。 */
  readonly layout?: string;
  /** 条件显示绑定了变量。 */
  readonly conditional: boolean;
  readonly hasStates: boolean;
  /** 循环容器与子模板调用：被调模板的名称、基准、拿到什么数据（feed）与展开后的元素。 */
  readonly called?: { readonly template: string; readonly base?: string; readonly feed?: string; readonly state: 'ok' | 'missing' | 'cycle'; readonly children: readonly TreeNode[] };
  readonly children: readonly TreeNode[];
}

const baseOf = (document: JsonObject | undefined) => (document && isObject(document['base']) ? `${String(document['base']['name'])} v${String(document['base']['version'])}` : undefined);

/**
 * 被调模板拿到什么数据，说成人话（M394）：作用域不继承，进去之后手里只有这一份数据和传入的参数。
 * 循环是列表的每一项，调用看 data：不传、调用方的当前数据，或一个单引用字段。不是循环或调用时是 undefined。
 */
export function feedOf(node: JsonObject, documentOf: (template: string) => JsonObject | undefined): string | undefined {
  const target = typeof node['template'] === 'string' ? node['template'] : undefined;
  if (!target) return undefined;
  const base = baseOf(documentOf(target));
  if (node['type'] === 'loop') {
    const list = isObject(node['list']) && typeof node['list']['var'] === 'string' ? node['list']['var'] : undefined;
    return `每项的数据：${base ?? '（被调模板没写数据定义）'}${list ? `（${list} 的一项）` : ''}`;
  }
  const data = node['data'];
  if (data === 'current') return `数据：${base ?? ''}（调用方的当前数据）`;
  if (isObject(data) && typeof data['var'] === 'string') return `数据：${base ?? ''}（字段 ${data['var']}）`;
  return '不传数据';
}

const childrenOf = (node: JsonObject): JsonObject[] => (Array.isArray(node['children']) ? (node['children'] as unknown[]).filter(isObject) : []);

function layoutOf(node: JsonObject): string | undefined {
  const layout = node['layout'];
  if (!isObject(layout)) return Array.isArray(node['children']) ? '自由' : undefined;
  if (layout['mode'] === 'stack') return layout['direction'] === 'column' ? '纵' : '横';
  return layout['mode'] === 'grid' ? '网格' : '自由';
}

/** 被调模板没读到时回答 undefined：还没加载，或者不存在。 */
export function buildTree(root: string, documentOf: (template: string) => JsonObject | undefined): TreeNode | undefined {
  const rootDoc = documentOf(root);
  if (!rootDoc || !isObject(rootDoc['artboard'])) return undefined;
  const element = (node: JsonObject, template: string, path: string, key: string, chain: ReadonlySet<string>): TreeNode => {
    const target = typeof node['template'] === 'string' ? node['template'] : undefined;
    const isRoot = path === template;
    let called: TreeNode['called'];
    if (target) {
      const document = documentOf(target);
      const artboard = document && isObject(document['artboard']) ? document['artboard'] : undefined;
      const base = baseOf(document), feed = feedOf(node, documentOf);
      if (chain.has(target)) called = { template: target, state: 'cycle', children: [] };
      else if (!artboard) called = { template: target, state: 'missing', children: [] };
      else {
        const inner = new Set(chain).add(target);
        called = { template: target, ...(base ? { base } : {}), ...(feed ? { feed } : {}), state: 'ok', children: childrenOf(artboard).map((child) => element(child, target, `${target}/${String(child['name'])}`, `${key}/${String(child['name'])}`, inner)) };
      }
    }
    const layout = layoutOf(node);
    return {
      key, template, path, name: isRoot ? template : String(node['name'] ?? ''), type: isRoot ? 'artboard' : String(node['type'] ?? ''),
      ...(layout ? { layout } : {}),
      conditional: isObject(node['visible']),
      hasStates: isObject(node['states']),
      ...(called ? { called } : {}),
      children: childrenOf(node).map((child) => element(child, template, `${path}/${String(child['name'])}`, `${key}/${String(child['name'])}`, chain)),
    };
  };
  return element(rootDoc['artboard'], root, root, root, new Set([root]));
}

/** 树里用到的全部模板：页面据此读内容。 */
export function calledTemplates(root: string, documentOf: (template: string) => JsonObject | undefined): readonly string[] {
  const found = new Set<string>([root]);
  const queue = [root];
  while (queue.length) {
    const document = documentOf(queue.pop()!);
    if (!document || !isObject(document['artboard'])) continue;
    const walk = (node: JsonObject) => {
      if (typeof node['template'] === 'string' && !found.has(node['template'])) { found.add(node['template']); queue.push(node['template']); }
      childrenOf(node).forEach(walk);
    };
    walk(document['artboard']);
  }
  return [...found];
}

/** 元素路径去掉循环序号，就是树里这一行的 key。 */
export const treeKeyOf = (instance: string) => instance.replace(/\[\d+\]/g, '');

/** 展开到这个实例要打开哪些行。 */
export function ancestorKeys(instance: string): readonly string[] {
  const parts = treeKeyOf(instance).split('/');
  return parts.slice(1).map((_, index) => parts.slice(0, index + 1).join('/'));
}
