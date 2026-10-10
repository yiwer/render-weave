/**
 * 日期、时刻、时间与图片取值的写法（M6、M9），编译产物与数据集校验共用。
 * 都不带时区，所以不用 JSON Schema 标准的 time、date-time 格式（ADR-0006）。
 */

/** 日期：2026-01-02。 */
export const DATE_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$';
/** 时刻：HH:mm，秒可选。 */
export const TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$';
/** 时间：2025-01-02 09:08:12，空格分隔、带秒。 */
export const DATETIME_PATTERN = '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01]) ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$';

export const RESOURCE_REF_PATTERN = '^res:[A-Za-z0-9][A-Za-z0-9_-]*$';
const URL_BODY = 'https?://[^\\s]+';
export const URL_PATTERN = `^${URL_BODY}$`;
export const RESOURCE_OR_URL_PATTERN = `^(res:[A-Za-z0-9][A-Za-z0-9_-]*|${URL_BODY})$`;

/** 年月日是否是真实存在的日期（如 2026-02-30 不是）。 */
export function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidDate(value: string): boolean {
  if (!new RegExp(DATE_PATTERN).test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return isCalendarDate(year, month, day);
}

export function isValidDatetime(value: string): boolean {
  if (!new RegExp(DATETIME_PATTERN).test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  return isCalendarDate(year, month, day);
}

/**
 * 数值文字的有效数字位数：去掉符号、指数与小数点后，再去掉首尾的零（末尾的零只表示数量级）。
 * 如 "2.50" 为 2 位，"1200" 为 2 位，"0.0012" 为 2 位，"1.000000000000000000001" 为 22 位。
 */
export function significantDigits(text: string): number {
  const mantissa = text.replace(/^[-+]/, '').split(/[eE]/)[0] ?? '';
  const digits = mantissa.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  return Math.max(1, digits.length);
}
