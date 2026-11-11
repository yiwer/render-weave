/**
 * 四边一格（模板设计页第三轮票据 02，方案「检查器」）：内边距、外边距（`{ top, right, bottom, left }`）和圆角（四角）。
 * DSL 里这类值写一个数（或一个变量）表示各项都是它，或写一个对象只列其中几项，没列的是 0。
 * 这里只答"每一项现在是什么、改了其中一项整格写什么、收起来时怎么说"，不碰页面。
 */
import { isObject } from './document.js';

export interface EdgePart { readonly key: string; readonly label: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 一个数或一个变量：各项都是它。 */
const isWhole = (value: unknown) => typeof value === 'number' || (isObject(value) && typeof value['var'] === 'string');

/** 这组可选项怎么称呼：上右下左是"四边"，别的（圆角）是"四角"。 */
export const partsNoun = (keys: readonly string[]) => (keys.includes('top') ? '四边' : '四角');

/** 每一项现在的取值：写了一个数或变量时各项都是它；写成对象时只有列出来的几项，没列的是 undefined（引擎按 0）。 */
export function partValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (isWhole(value)) return Object.fromEntries(keys.map((key) => [key, value]));
  return isObject(value) ? Object.fromEntries(keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]]))) : {};
}

/**
 * 改了其中一项，整格写什么。只改这一项，别的项照现在的取值留着（原来是一个数时摊开成各项）；
 * 清空是去掉这一项；各项都写了又都一样时收回成一个数（或一个变量），一项都不剩时去掉整格。
 */
export function writePart(value: unknown, keys: readonly string[], key: string, next: unknown): unknown {
  const current = { ...partValues(value, keys), [key]: next };
  const written = keys.filter((item) => current[item] !== undefined);
  if (!written.length) return undefined;
  if (written.length === keys.length && written.every((item) => same(current[item], current[written[0]!]))) return current[written[0]!];
  return Object.fromEntries(written.map((item) => [item, current[item]]));
}

/** 页面上说和摆的先后：上下、左右连着说才顺口，四角两个一排正好和方位对上；和写回时上右下左的先后不一样。 */
const SPOKEN = ['top', 'bottom', 'left', 'right', 'topLeft', 'topRight', 'bottomLeft', 'bottomRight'];
export const inSpokenOrder = <Part extends { readonly key: string }>(parts: readonly Part[]): Part[] => [...parts].sort((a, b) => SPOKEN.indexOf(a.key) - SPOKEN.indexOf(b.key));

/**
 * 写成对象时收起来怎么说：取值一样的项并在一起，是 0 的不提（"上下 1 · 左右 2"、"下 2"）；全是 0 就说 0。
 * 绑定着变量的项写变量的显示名称。不是对象时是 undefined：一个数直接显示在框里。
 */
export function edgesSummary(value: unknown, parts: readonly EdgePart[], labelOfVariable: (name: string) => string = (name) => name): string | undefined {
  if (!isObject(value) || isWhole(value)) return undefined;
  const groups: { readonly value: unknown; readonly labels: string[] }[] = [];
  for (const part of inSpokenOrder(parts)) {
    const item = value[part.key];
    if (item === undefined || item === 0) continue;
    const group = groups.find((other) => same(other.value, item));
    if (group) group.labels.push(part.label);
    else groups.push({ value: item, labels: [part.label] });
  }
  if (!groups.length) return '0';
  const text = (item: unknown) => (isObject(item) && typeof item['var'] === 'string' ? labelOfVariable(item['var']) : String(item));
  // 单字的名称（上下左右）连着写，两个字的（左上、右下）用顿号隔开。
  return groups.map((group) => `${group.labels.join(group.labels.every((label) => label.length === 1) ? '' : '、')} ${text(group.value)}`).join(' · ');
}
