/**
 * 变量插槽的展示格式（M116）：日期、时刻与时间按 `HH:mm`、`yyyy年M月d日` 一类的模式输出，
 * 数值按 `0.##`、`0.00` 一类的模式输出；未给格式时按类型的默认写法输出。
 *
 * 数值按十进制四舍五入，不经过浮点运算：数值最多 15 位有效数字（M112），
 * String(数值) 得到的就是原始的十进制写法，在这串数字上取舍即可（如 2.005 按 0.00 得到 2.01）。
 */
import { joinDecimal, plainNumber, toDecimal } from './decimal.js';
import type { DatetimeFormat, DisplayFormat, DisplayKind, NumberFormat } from './display-format-pattern.js';

export { formatMismatch, KIND_LABELS, parseDisplayFormat } from './display-format-pattern.js';
export type { DatetimeFormat, DisplayFormat, DisplayKind, NumberFormat } from './display-format-pattern.js';

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
