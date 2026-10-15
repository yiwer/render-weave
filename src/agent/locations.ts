/**
 * 候选文件中的"位置"：待确认项、图上位置与审核处理结果的 path。省略 path 表示整份文件。
 * - 数据定义：字段名，如 role；
 * - 数据集：数据中的字段路径，列表序号从 1 开始，如 stations[3].name，与问题清单的写法一致；
 * - 模板：元素路径，从模板名开始，如 胸牌/姓名区/姓名（M101）。只指向模板文件里的元素，不带循环序号。
 */
import { isRecord } from '../util.js';
import type { CandidateKind } from './tasks.js';

/** 位置所在的容器与键：对象的键，或数组的下标（从 0 开始）。 */
export type Slot = { readonly parent: Record<string, unknown>; readonly key: string } | { readonly parent: unknown[]; readonly key: number };

/** 对某个位置的改动：设为新值，或删去。 */
export interface Change {
  readonly path: string;
  readonly action: 'set' | 'remove';
  readonly value?: unknown;
}

/** 在文档中找到位置。数据集的最后一段可以是还不存在的键（必填未提供时，值本来就没有）。 */
export function locate(kind: CandidateKind, document: unknown, path: string): { slot?: Slot; error?: string } {
  if (kind === 'definition') {
    const fields = isRecord(document) && Array.isArray(document['fields']) ? document['fields'] : undefined;
    const index = fields?.findIndex((field) => isRecord(field) && field['name'] === path) ?? -1;
    return index >= 0 ? { slot: { parent: fields!, key: index } } : { error: `数据定义中没有字段 ${path}` };
  }
  if (kind === 'dataset') return locateData(document, path);
  return locateElement(document, path);
}

export function read(slot: Slot): unknown {
  return Array.isArray(slot.parent) ? slot.parent[slot.key as number] : (slot.parent as Record<string, unknown>)[slot.key as string];
}

/** 两个位置是否重叠：相同，或一个在另一个之内。 */
export function overlaps(a: string, b: string): boolean {
  const inside = (outer: string, inner: string) => inner.startsWith(outer) && ['.', '[', '/'].includes(inner[outer.length] ?? '');
  return a === b || inside(a, b) || inside(b, a);
}

/** b 是否等于 a 或在 a 之内。 */
export function within(outer: string, inner: string): boolean {
  return inner === outer || (inner.startsWith(outer) && ['.', '[', '/'].includes(inner[outer.length] ?? ''));
}

/**
 * 在文档副本上做一组互不重叠的改动，返回新文档与找不到的位置。
 * 先按原文档定位全部改动，再设值，最后从后往前删数组项，前面的删除不会让后面的下标错位。
 */
export function applyChanges(kind: CandidateKind, document: unknown, changes: readonly Change[]): { document: unknown; errors: string[] } {
  const copy = structuredClone(document);
  const errors: string[] = [];
  const located: { change: Change; slot: Slot }[] = [];
  for (const change of changes) {
    const { slot, error } = locate(kind, copy, change.path);
    if (slot) located.push({ change, slot });
    else errors.push(error!);
  }
  for (const { change, slot } of located) {
    if (change.action !== 'set') continue;
    if (Array.isArray(slot.parent)) slot.parent[slot.key as number] = structuredClone(change.value);
    else (slot.parent as Record<string, unknown>)[slot.key as string] = structuredClone(change.value);
  }
  const removals = located.filter(({ change }) => change.action === 'remove').map(({ slot }) => slot);
  for (const slot of removals) if (!Array.isArray(slot.parent)) delete slot.parent[slot.key as string];
  for (const slot of removals.filter((item) => Array.isArray(item.parent)).sort((a, b) => (b.key as number) - (a.key as number))) {
    (slot.parent as unknown[]).splice(slot.key as number, 1);
  }
  return { document: copy, errors };
}

/** 数据集的叶子值：对象逐键展开，对象列表逐项展开；基本类型列表与空列表、空对象作为一个值。 */
export function flattenData(value: unknown, prefix = ''): { path: string; value: unknown }[] {
  if (isRecord(value) && Object.keys(value).length > 0) {
    return Object.entries(value).flatMap(([key, item]) => flattenData(item, prefix === '' ? key : `${prefix}.${key}`));
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isRecord)) {
    return value.flatMap((item, index) => flattenData(item, `${prefix}[${index + 1}]`));
  }
  return prefix === '' ? [] : [{ path: prefix, value }];
}

/** 模板中的全部元素，按文档顺序，带元素路径。 */
export function flattenElements(document: unknown): { path: string; element: Record<string, unknown> }[] {
  if (!isRecord(document) || typeof document['name'] !== 'string' || !isRecord(document['artboard'])) return [];
  const result: { path: string; element: Record<string, unknown> }[] = [];
  const walk = (container: Record<string, unknown>, prefix: string) => {
    for (const child of Array.isArray(container['children']) ? container['children'] : []) {
      if (!isRecord(child)) continue;
      const path = `${prefix}/${String(child['name'])}`;
      result.push({ path, element: child });
      walk(child, path);
    }
  };
  walk(document['artboard'], document['name']);
  return result;
}

type Token = { readonly name: string } | { readonly index: number };

/** 字段路径：name、name[3]、a.b[2].c；序号从 1 开始。 */
function parseDataPath(path: string): Token[] | undefined {
  const tokens: Token[] = [];
  for (const part of path.split('.')) {
    const match = /^([A-Za-z][A-Za-z0-9_]*)((?:\[[1-9]\d*\])*)$/.exec(part);
    if (!match) return undefined;
    tokens.push({ name: match[1]! });
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g)) tokens.push({ index: Number(index[1]) });
  }
  return tokens;
}

function locateData(document: unknown, path: string): { slot?: Slot; error?: string } {
  const tokens = parseDataPath(path);
  if (!tokens) return { error: `字段路径写法不对：${path}（如 stations[3].name，序号从 1 开始）` };
  let current: unknown = isRecord(document) ? document['data'] : undefined;
  for (const [position, token] of tokens.entries()) {
    const last = position === tokens.length - 1;
    if ('name' in token) {
      if (!isRecord(current)) return { error: `数据集中 ${path} 的上一级不是对象` };
      if (last) return { slot: { parent: current, key: token.name } };
      if (!(token.name in current)) return { error: `数据集中没有 ${path}` };
      current = current[token.name];
    } else {
      if (!Array.isArray(current)) return { error: `数据集中 ${path} 的上一级不是列表` };
      if (token.index > current.length) return { error: `数据集中没有 ${path}：列表只有 ${current.length} 项` };
      if (last) return { slot: { parent: current, key: token.index - 1 } };
      current = current[token.index - 1];
    }
  }
  return { error: `字段路径写法不对：${path}` };
}

/** 模板中的元素路径统一为从模板名开始的写法：file 已经指明模板，省略模板名的写法也接受。 */
export function fullElementPath(document: unknown, path: string): string {
  const name = isRecord(document) && typeof document['name'] === 'string' ? document['name'] : undefined;
  return name === undefined || path.startsWith(`${name}/`) ? path : `${name}/${path}`;
}

function locateElement(document: unknown, given: string): { slot?: Slot; error?: string } {
  const path = fullElementPath(document, given);
  const segments = path.split('/');
  if (!isRecord(document) || segments.length < 2 || path.includes('[')) {
    return { error: `元素路径写法不对，不带循环序号，如 元素名/子元素名：${given}` };
  }
  let container: unknown = document['artboard'];
  for (const [position, name] of segments.slice(1).entries()) {
    const children = isRecord(container) && Array.isArray(container['children']) ? container['children'] : [];
    const index = children.findIndex((child) => isRecord(child) && child['name'] === name);
    if (index < 0 && isRecord(container) && typeof container['template'] === 'string') {
      return { error: `元素路径进入了被调模板 ${container['template']}：file 写被调模板的文件，path 写元素在它里面的路径：${given}` };
    }
    if (index < 0) return { error: `模板中没有元素 ${path}` };
    if (position === segments.length - 2) return { slot: { parent: children, key: index } };
    container = children[index];
  }
  return { error: `模板中没有元素 ${path}` };
}
