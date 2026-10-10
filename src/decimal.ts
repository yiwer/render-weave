/**
 * 十进制数值：按十进制写法计算与输出，不经过浮点运算（M17、M112）。
 * 数值最多 15 位有效数字，String(数值) 得到的就是原始的十进制写法；加减在这串数字上用整数完成。
 */

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

/** 十进制加法（减法传入相反数）：两数按相同的小数位数化成整数相加，再按十进制写法转回数值。 */
export function addDecimal(a: number, b: number): number {
  const da = toDecimal(a);
  const db = toDecimal(b);
  const places = Math.max(da.fraction.length, db.fraction.length);
  const scaled = (d: Decimal) => (d.negative ? -1n : 1n) * BigInt(d.integer + d.fraction.padEnd(places, '0') || '0');
  const sum = scaled(da) + scaled(db);
  const digits = (sum < 0n ? -sum : sum).toString().padStart(places + 1, '0');
  const text = `${sum < 0n ? '-' : ''}${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places) || '0'}`;
  return Number(text);
}
