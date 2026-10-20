/** 连续同值项分组；不排序、不合并相隔的同值项，缺值各自成组。 */
import type { LoopSlice } from './model.js';
import { isRecord } from '../util.js';

export interface LoopGroup {
  readonly data: unknown;
  /** 首项在原始列表中的序号，从 1 开始。 */
  readonly index: number;
  /** 首项在本次循环排列顺序（切片、反序后，合并前）中的序号，从 1 开始。 */
  readonly start: number;
  size: number;
}

export interface LoopOptions {
  readonly slice?: LoopSlice;
  readonly reverse?: boolean;
  readonly mergeBy?: string;
}

export function groupLoopItems(items: readonly unknown[], options: LoopOptions = {}): { readonly count: number; readonly groups: LoopGroup[] } {
  const indexed = items.map((data, i) => ({ data, index: i + 1 }));
  const sliceStart = options.slice?.start ?? 1;
  const sliceEnd = options.slice?.end ?? items.length;
  const sliced = sliceStart > items.length ? [] : indexed.slice(sliceStart - 1, Math.min(sliceEnd, items.length));
  const ordered = options.reverse ? [...sliced].reverse() : sliced;
  const groups: LoopGroup[] = [];
  const fields = options.mergeBy?.split('.') ?? [];
  let previous: unknown;
  for (const [orderIndex, entry] of ordered.entries()) {
    let key = entry.data;
    for (const field of fields) key = isRecord(key) && Object.hasOwn(key, field) ? key[field] : undefined;
    const scalar = typeof key === 'string' || typeof key === 'number' || typeof key === 'boolean';
    const last = groups.at(-1);
    if (options.mergeBy && scalar && key === previous && last) last.size++;
    else groups.push({ data: entry.data, index: entry.index, start: orderIndex + 1, size: 1 });
    previous = key;
  }
  return { count: ordered.length, groups };
}
