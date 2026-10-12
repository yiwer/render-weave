/** 连续同值项分组；不排序、不合并相隔的同值项，缺值各自成组。 */
import { isRecord } from '../util.js';

export interface LoopGroup {
  readonly data: unknown;
  /** 首项在原始列表中的序号，从 1 开始。 */
  readonly index: number;
  size: number;
}

export function groupLoopItems(items: readonly unknown[], mergeBy?: string): LoopGroup[] {
  const groups: LoopGroup[] = [];
  const fields = mergeBy?.split('.') ?? [];
  let previous: unknown;
  for (const [index, data] of items.entries()) {
    let key = data;
    for (const field of fields) key = isRecord(key) && Object.hasOwn(key, field) ? key[field] : undefined;
    const scalar = typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean';
    const last = groups.at(-1);
    if (mergeBy && scalar && key === previous && last) last.size++;
    else groups.push({ data, index: index + 1, size: 1 });
    previous = key;
  }
  return groups;
}
