/**
 * 文字内容的片段（模板设计页票据 10，方案第 7 节）：文字和插槽排成一行，打字是文字，插槽绑定字段。这里是片段的增删与展示格式的校验，纯函数。
 * 一个文字元素只排一行或一列（M339），所以片段就是一维的序列，没有段落。
 */
import { formatMismatch, parseDisplayFormat, type DisplayKind } from '../../../../src/display-format-pattern.js';
import { isObject, type JsonObject } from './document.js';

export type Fragment = JsonObject;

/** 片段可以单独写的样式（S23、M73）。竖排不能写 slant。 */
export const STYLE_KEYS = ['font', 'fontSize', 'color', 'slant'] as const;

/** 光标：在某段文字的第几个字，或两个插槽之间的空位。 */
export type Caret = { readonly index: number; readonly offset: number } | { readonly gap: number };

export const fragmentsOf = (value: unknown): readonly Fragment[] => (Array.isArray(value) ? (value as unknown[]).filter(isObject) : []);
export const isSlot = (fragment: Fragment | undefined): boolean => typeof fragment?.['slot'] === 'string';
export const isStyled = (fragment: Fragment): boolean => STYLE_KEYS.some((key) => key in fragment);
const isPlainText = (fragment: Fragment | undefined): boolean => typeof fragment?.['text'] === 'string' && !isStyled(fragment);

/** 删掉东西之后，相邻两段没有样式的文字合成一段：文档里不留没有意义的切分。 */
function merged(fragments: readonly Fragment[]): readonly Fragment[] {
  const result: Fragment[] = [];
  for (const fragment of fragments) {
    const last = result.at(-1);
    if (isPlainText(last) && isPlainText(fragment)) result[result.length - 1] = { text: `${String(last!['text'])}${String(fragment['text'])}` };
    else result.push(fragment);
  }
  return result;
}

/** 改一段文字。写空了就去掉这一段；带样式的留着，样式还在。 */
export function setText(fragments: readonly Fragment[], index: number, text: string): readonly Fragment[] {
  const fragment = fragments[index];
  if (!fragment) return fragments;
  if (text === '' && !isStyled(fragment)) return merged(fragments.filter((_, at) => at !== index));
  return fragments.map((item, at) => (at === index ? { ...item, text } : item));
}

/** 两个插槽之间（或开头、结尾）的空位打了字：多一段文字。 */
export const insertText = (fragments: readonly Fragment[], gap: number, text: string): readonly Fragment[] => [...fragments.slice(0, gap), { text }, ...fragments.slice(gap)];

/** 光标落在 position 这个位置时该落在哪：后面是文字就落进文字，否则落在空位上。 */
const caretAt = (fragments: readonly Fragment[], position: number): Caret => (typeof fragments[position]?.['text'] === 'string' ? { index: position, offset: 0 } : { gap: position });

/** 在光标处插入一个插槽；文字从光标处切开，两半各留样式。 */
export function insertSlot(fragments: readonly Fragment[], at: Caret, slot: string): { readonly fragments: readonly Fragment[]; readonly caret: Caret } {
  const piece: Fragment = { slot };
  if ('gap' in at) {
    const next = [...fragments.slice(0, at.gap), piece, ...fragments.slice(at.gap)];
    return { fragments: next, caret: caretAt(next, at.gap + 1) };
  }
  const current = fragments[at.index];
  const text = typeof current?.['text'] === 'string' ? current['text'] : '';
  const before = text.slice(0, at.offset), after = text.slice(at.offset), { text: _text, ...style } = current ?? {};
  const parts: Fragment[] = [...(before ? [{ ...style, text: before }] : []), piece, ...(after ? [{ ...style, text: after }] : [])];
  const next = [...fragments.slice(0, at.index), ...parts, ...fragments.slice(at.index + 1)];
  return { fragments: next, caret: caretAt(next, at.index + (before ? 2 : 1)) };
}

/** 去掉一段（Backspace 删插槽、"删除这个插槽"）；光标落回原处，前后的文字合起来。 */
export function removeFragment(fragments: readonly Fragment[], index: number): { readonly fragments: readonly Fragment[]; readonly caret: Caret } {
  const before = fragments[index - 1], rest = merged(fragments.filter((_, at) => at !== index));
  if (typeof before?.['text'] === 'string') return { fragments: rest, caret: { index: index - 1, offset: String(before['text']).length } };
  return { fragments: rest, caret: caretAt(rest, index) };
}

/** 能放进插槽的类型：布尔、图片、颜色、列表与引用都不能显示为文字（模板静态检查同样拒绝）。 */
const DISPLAY_KINDS: readonly string[] = ['text', 'number', 'date', 'time', 'datetime'];
export const canDisplay = (type: string): boolean => DISPLAY_KINDS.includes(type);

/** 常用的展示格式（M116），点一下填进去。文本不带格式。 */
export const FORMAT_PRESETS: Readonly<Record<string, readonly string[]>> = {
  number: ['0', '0.##', '0.00'], date: ['yyyy年M月d日', 'yyyy-MM-dd', 'M月d日'], time: ['HH:mm', 'HH:mm:ss'], datetime: ['yyyy-MM-dd HH:mm', 'M月d日 HH:mm'],
};

/** 展示格式的问题：写法不对，或和字段类型对不上。用引擎的同一套规则，不等出图才报。类型还不知道时只查写法。 */
export function formatProblem(pattern: string, type: string | undefined): string | undefined {
  const parsed = parseDisplayFormat(pattern);
  if (typeof parsed === 'string') return parsed;
  if (type === 'text') return '文本类型不带展示格式';
  return type !== undefined && canDisplay(type) ? formatMismatch(parsed, type as DisplayKind) : undefined;
}
