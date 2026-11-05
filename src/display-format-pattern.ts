/**
 * 展示格式的写法（M116）：解析模式，判断能用于哪种类型。没有任何依赖：控制台也用这一份，页面上不等出图就能查（模板设计页票据 10）。
 * 按格式输出取值在 display-format.ts。
 */

/** 能放进文字插槽的取值种类。 */
export type DisplayKind = 'text' | 'number' | 'date' | 'time' | 'datetime';

export type DisplayFormat = NumberFormat | DatetimeFormat;

export interface NumberFormat {
  readonly kind: 'number';
  readonly pattern: string;
  /** 整数部分至少几位，不足补 0。 */
  readonly minInteger: number;
  /** 小数部分至少、至多几位；超出至多位数的四舍五入，不足至少位数的补 0。 */
  readonly minFraction: number;
  readonly maxFraction: number;
}

export interface DatetimeFormat {
  readonly kind: 'datetime';
  readonly pattern: string;
  readonly parts: readonly DatetimePart[];
  /** 用到了年月日或时分秒，决定能用于哪些类型。 */
  readonly usesDate: boolean;
  readonly usesTime: boolean;
}

type DateToken = 'yyyy' | 'MM' | 'M' | 'dd' | 'd';
type TimeToken = 'HH' | 'H' | 'mm' | 'ss';
export type DatetimePart = { readonly literal: string } | { readonly token: DateToken | TimeToken };

const DATE_TOKENS: readonly string[] = ['yyyy', 'MM', 'M', 'dd', 'd'];
const TIME_TOKENS: readonly string[] = ['HH', 'H', 'mm', 'ss'];

export const KIND_LABELS: Record<DisplayKind, string> = {
  text: '文本',
  number: '数值',
  date: '日期',
  time: '时刻',
  datetime: '时间',
};

/** 解析展示格式；写法不对时返回说明。 */
export function parseDisplayFormat(pattern: string): DisplayFormat | string {
  if (/^[0#.]+$/.test(pattern)) return parseNumberFormat(pattern);
  return parseDatetimeFormat(pattern);
}

function parseNumberFormat(pattern: string): NumberFormat | string {
  const match = /^#*(0+)(?:\.(0*)(#*))?$/.exec(pattern);
  if (!match || (pattern.includes('.') && match[2] === '' && match[3] === '')) {
    return `数值格式"${pattern}"写法不对：整数部分写若干个 0（前面可加 #），小数部分写若干个 0 再接若干个 #，如 0、0.##、0.00`;
  }
  const minFraction = match[2]?.length ?? 0;
  return { kind: 'number', pattern, minInteger: match[1]!.length, minFraction, maxFraction: minFraction + (match[3]?.length ?? 0) };
}

function parseDatetimeFormat(pattern: string): DatetimeFormat | string {
  const parts: DatetimePart[] = [];
  let literal = '';
  for (let i = 0; i < pattern.length; ) {
    const char = pattern[i]!;
    if (!/[A-Za-z]/.test(char)) {
      literal += char;
      i++;
      continue;
    }
    let end = i;
    while (pattern[end] === char) end++;
    const token = pattern.slice(i, end);
    if (!DATE_TOKENS.includes(token) && !TIME_TOKENS.includes(token)) {
      return `展示格式"${pattern}"中的 ${token} 不是可用的格式符：日期用 yyyy、MM、M、dd、d，时刻用 HH、H、mm、ss，数值用 0 与 #`;
    }
    if (literal) parts.push({ literal });
    literal = '';
    parts.push({ token: token as DateToken | TimeToken });
    i = end;
  }
  if (literal) parts.push({ literal });
  const tokens = parts.flatMap((part) => ('token' in part ? [part.token] : []));
  if (tokens.length === 0) {
    return `展示格式"${pattern}"里没有格式符：日期用 yyyy、MM、M、dd、d，时刻用 HH、H、mm、ss，数值用 0 与 #`;
  }
  return {
    kind: 'datetime',
    pattern,
    parts,
    usesDate: tokens.some((token) => DATE_TOKENS.includes(token)),
    usesTime: tokens.some((token) => TIME_TOKENS.includes(token)),
  };
}

/** 展示格式能否用于该类型；不能时返回说明。 */
export function formatMismatch(format: DisplayFormat, kind: DisplayKind): string | undefined {
  const label = KIND_LABELS[kind];
  if (format.kind === 'number') {
    return kind === 'number' ? undefined : `数值格式"${format.pattern}"不能用于${label}`;
  }
  if (format.usesDate && kind !== 'date' && kind !== 'datetime') {
    return `展示格式"${format.pattern}"含年月日，只能用于日期或时间，不能用于${label}`;
  }
  if (format.usesTime && kind !== 'time' && kind !== 'datetime') {
    return `展示格式"${format.pattern}"含时分秒，只能用于时刻或时间，不能用于${label}`;
  }
  return undefined;
}
