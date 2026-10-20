/**
 * 十进制数值：按十进制写法计算与输出，不经过浮点运算（M17、M112）。
 * 数值最多 15 位有效数字，String(数值) 得到的就是原始的十进制写法；加减在这串数字上用整数完成。
 */
import { significantDigits } from './schema/formats.js';
import { MAX_SIGNIFICANT_DIGITS } from './schema/model.js';

export interface Decimal {
  readonly negative: boolean;
  /** 整数部分与小数部分的数字。 */
  readonly integer: string;
  readonly fraction: string;
}

/** 数值的十进制写法，展开指数记法。 */
export function toDecimal(value: number): Decimal {
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

export function joinDecimal(negative: boolean, integer: string, fraction: string, minInteger: number): string {
  const int = integer.replace(/^0+/, '').padStart(minInteger, '0');
  const zero = !/[1-9]/.test(int + fraction);
  return (negative && !zero ? '-' : '') + int + (fraction ? `.${fraction}` : '');
}

/** 最短的十进制写法，不用指数记法。 */
export function plainNumber(value: number): string {
  const { negative, integer, fraction } = toDecimal(value);
  return joinDecimal(negative, integer, fraction.replace(/0+$/, ''), 1);
}

function validOperands(a: number, b: number): boolean {
  return [a, b].every((value) => Number.isFinite(value) && significantDigits(String(value)) <= MAX_SIGNIFICANT_DIGITS);
}

function fromScaledInt(value: bigint, places: number): number | undefined {
  const digits = (value < 0n ? -value : value).toString().padStart(places + 1, '0');
  const text = `${value < 0n ? '-' : ''}${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places) || '0'}`;
  const result = Number(text);
  // 在转回 Number 前检查精度，避免 1 + 1e-17 被舍入成 1 后再也看不出失真。
  return Number.isFinite(result) && (value === 0n || result !== 0) && significantDigits(text) <= MAX_SIGNIFICANT_DIGITS ? result : undefined;
}

function alignScaled(a: number, b: number): { readonly left: bigint; readonly right: bigint; readonly places: number } {
  const da = toDecimal(a);
  const db = toDecimal(b);
  const places = Math.max(da.fraction.length, db.fraction.length);
  const scaled = (d: Decimal) => (d.negative ? -1n : 1n) * BigInt(d.integer + d.fraction.padEnd(places, '0') || '0');
  return { left: scaled(da), right: scaled(db), places };
}

/** 十进制加法（减法传入相反数）：两数按相同的小数位数化成整数相加，再按十进制写法转回数值。 */
export function addDecimal(a: number, b: number): number | undefined {
  if (!validOperands(a, b)) return undefined;
  const { left, right, places } = alignScaled(a, b);
  return fromScaledInt(left + right, places);
}

/** 十进制乘法：按精确十进制整数缩放相乘，结果须有限且不超过 15 位有效数字（M251）。 */
export function multiplyDecimal(a: number, b: number): number | undefined {
  if (!validOperands(a, b)) return undefined;
  const da = toDecimal(a);
  const db = toDecimal(b);
  const places = da.fraction.length + db.fraction.length;
  const unscaled = (d: Decimal) => (d.negative ? -1n : 1n) * BigInt(d.integer + d.fraction || '0');
  return fromScaledInt(unscaled(da) * unscaled(db), places);
}

/** 十进制取模：按相同小数位数化成整数求余；除数为 0 或结果超过 15 位有效数字时返回 undefined（M251）。 */
export function modDecimal(a: number, b: number): number | undefined {
  if (!validOperands(a, b) || b === 0) return undefined;
  const { left, right, places } = alignScaled(a, b);
  return right === 0n ? undefined : fromScaledInt(left % right, places);
}

function parseScaled(value: number): { readonly coeff: bigint; readonly exp: number } {
  const [mantissa = '0', expPart = '0'] = String(Math.abs(value)).split(/[eE]/);
  const [intPart = '0', fracPart = ''] = mantissa.split('.');
  const raw = (intPart + fracPart).replace(/^0+/, '');
  return raw === '' ? { coeff: 0n, exp: 0 } : { coeff: BigInt(raw), exp: Number(expPart) - fracPart.length };
}

/** 十进制除法：除数非 0 时按十进制四舍五入（远离零）保留最多 15 位有效数字，去除尾随 0（M251）。 */
export function divideDecimal(a: number, b: number): number | undefined {
  if (!validOperands(a, b) || b === 0) return undefined;
  if (a === 0) return 0;
  const sa = parseScaled(a);
  const sb = parseScaled(b);
  const k = MAX_SIGNIFICANT_DIGITS + 2 + sb.coeff.toString().length - sa.coeff.toString().length;
  const scaledN = sa.coeff * 10n ** BigInt(k);
  const qLen = (scaledN / sb.coeff).toString().length;
  const drop = qLen - MAX_SIGNIFICANT_DIGITS;
  const divisor = sb.coeff * 10n ** BigInt(drop);
  let sig = scaledN / divisor;
  const rem = scaledN % divisor;
  if (rem * 2n >= divisor) sig += 1n;
  const finalExp = sa.exp - sb.exp - k + drop;
  const negative = (a < 0) !== (b < 0);
  const result = Number(`${negative ? '-' : ''}${sig}e${finalExp}`);
  return Number.isFinite(result) && result !== 0 && significantDigits(String(result)) <= MAX_SIGNIFICANT_DIGITS ? result : undefined;
}
