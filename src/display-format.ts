/**
 * 变量插槽的展示格式（M116）：日期、时刻与时间按 `HH:mm`、`yyyy年M月d日` 一类的模式输出，
 * 数值按 `0.##`、`0.00` 一类的模式输出；未给格式时按类型的默认写法输出。
 *
 * 数值按十进制四舍五入，不经过浮点运算：数值最多 15 位有效数字（M112），
 * String(数值) 得到的就是原始的十进制写法，在这串数字上取舍即可（如 2.005 按 0.00 得到 2.01）。
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
type DatetimePart = { readonly literal: string } | { readonly token: DateToken | TimeToken };

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

/**
 * 按类型与展示格式输出取值。缺值，或取值与类型不符（数据集校验已报问题）时结果为空，
 * 不回退到占位内容（M16；草稿预览的占位见票据 12）。
 */
export function displayValue(value: unknown, kind: DisplayKind, format?: DisplayFormat): string {
  switch (kind) {
    case 'text':
      return typeof value === 'string' ? value : '';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      return format?.kind === 'number' ? formatNumber(value, format) : plainNumber(value);
    case 'date':
    case 'time':
    case 'datetime': {
      if (typeof value !== 'string') return '';
      const parts = parseDatetimeValue(value, kind);
      if (!parts) return '';
      return format?.kind === 'datetime' ? formatDatetime(parts, format) : value;
    }
  }
}

interface Decimal {
  readonly negative: boolean;
  /** 整数部分与小数部分的数字。 */
  readonly integer: string;
  readonly fraction: string;
}

/** 数值的十进制写法，展开指数记法。 */
function toDecimal(value: number): Decimal {
  const [mantissa = '0', exponentText = '0'] = String(Math.abs(value)).split('e');
  const [integer = '0', fraction = ''] = mantissa.split('.');
  let digits = integer + fraction;
  let point = integer.length + Number(exponentText);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits += '0'.repeat(point - digits.length);
  return { negative: value < 0, integer: digits.slice(0, point), fraction: digits.slice(point) };
}

function joinDecimal(negative: boolean, integer: string, fraction: string, minInteger: number): string {
  const int = integer.replace(/^0+/, '').padStart(minInteger, '0');
  const zero = !/[1-9]/.test(int + fraction);
  return (negative && !zero ? '-' : '') + int + (fraction ? `.${fraction}` : '');
}

/** 未给格式时的数值：最短的十进制写法，不用指数记法。 */
function plainNumber(value: number): string {
  const { negative, integer, fraction } = toDecimal(value);
  return joinDecimal(negative, integer, fraction.replace(/0+$/, ''), 1);
}

function formatNumber(value: number, format: NumberFormat): string {
  const decimal = toDecimal(value);
  let integer = decimal.integer;
  let fraction = decimal.fraction;
  if (fraction.length > format.maxFraction) {
    const roundUp = fraction[format.maxFraction]! >= '5';
    fraction = fraction.slice(0, format.maxFraction);
    if (roundUp) {
      const sum = incrementDigits(integer + fraction);
      integer = sum.slice(0, sum.length - fraction.length);
      fraction = sum.slice(sum.length - fraction.length);
    }
  }
  fraction = fraction.replace(/0+$/, '').padEnd(format.minFraction, '0');
  return joinDecimal(decimal.negative, integer, fraction, format.minInteger);
}

/** 十进制数字串加 1（末位进位），如 "199" → "200"、"99" → "100"。 */
function incrementDigits(digits: string): string {
  const chars = digits.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] === '9') {
      chars[i] = '0';
    } else {
      chars[i] = String(Number(chars[i]) + 1);
      return chars.join('');
    }
  }
  return `1${chars.join('')}`;
}

interface DatetimeParts {
  readonly year?: number;
  readonly month?: number;
  readonly day?: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

function parseDatetimeValue(value: string, kind: 'date' | 'time' | 'datetime'): DatetimeParts | undefined {
  const date = '(\\d{4})-(\\d{2})-(\\d{2})';
  const time = '(\\d{2}):(\\d{2})(?::(\\d{2}))?';
  const source = kind === 'date' ? date : kind === 'time' ? time : `${date} ${time}`;
  const match = new RegExp(`^${source}$`).exec(value);
  if (!match) return undefined;
  const numbers = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (kind === 'date') return { year: numbers[0], month: numbers[1], day: numbers[2] };
  if (kind === 'time') return { hour: numbers[0], minute: numbers[1], second: numbers[2] };
  return { year: numbers[0], month: numbers[1], day: numbers[2], hour: numbers[3], minute: numbers[4], second: numbers[5] };
}

function formatDatetime(parts: DatetimeParts, format: DatetimeFormat): string {
  const two = (n = 0) => String(n).padStart(2, '0');
  return format.parts
    .map((part) => {
      if ('literal' in part) return part.literal;
      switch (part.token) {
        case 'yyyy':
          return String(parts.year ?? 0).padStart(4, '0');
        case 'MM':
          return two(parts.month);
        case 'M':
          return String(parts.month ?? 0);
        case 'dd':
          return two(parts.day);
        case 'd':
          return String(parts.day ?? 0);
        case 'HH':
          return two(parts.hour);
        case 'H':
          return String(parts.hour ?? 0);
        case 'mm':
          return two(parts.minute);
        case 'ss':
          return two(parts.second);
      }
    })
    .join('');
}
