/**
 * 表单里的数据：与数据集的 data 同形的 JSON 树，只是用户填写的数值存成原文（NumberText）。
 * 保存与校验时按原文写进 JSON：服务端按原文检查有效数字（M112），不会因为前端按双精度读写而失真；
 * 不是合法数值的原文写成文本，由服务端报类型不符。可选字段没有值时直接省略该键，不写 null。
 */

/** 用户填写的数值原文。 */
export class NumberText {
  constructor(readonly text: string) {}
}

export type Segment = string | number;

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof NumberText);

/** 从服务端读回的数据集：数值改成原文，便于在输入框里原样编辑。 */
export function fromJson(value: unknown): unknown {
  if (typeof value === 'number') return new NumberText(String(value));
  if (Array.isArray(value)) return value.map(fromJson);
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromJson(item)]));
  return value;
}

/** 写成缩进 2 格的 JSON；值为 undefined 的键省略。 */
export function toJsonText(value: unknown, depth = 0): string {
  const pad = '  '.repeat(depth + 1), end = '  '.repeat(depth);
  if (value instanceof NumberText) {
    const text = value.text.trim();
    return JSON_NUMBER.test(text) ? text : JSON.stringify(value.text);
  }
  if (Array.isArray(value)) {
    return value.length ? `[\n${value.map((item) => `${pad}${toJsonText(item ?? '', depth + 1)}`).join(',\n')}\n${end}]` : '[]';
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    return entries.length ? `{\n${entries.map(([key, item]) => `${pad}${JSON.stringify(key)}: ${toJsonText(item, depth + 1)}`).join(',\n')}\n${end}}` : '{}';
  }
  return JSON.stringify(value ?? null);
}

/** 判断有没有修改用的规范写法：对象的键按名称排序，与键的先后无关（清空再填回同一个值不算修改）。 */
export function canonicalText(value: unknown): string {
  if (value instanceof NumberText) return toJsonText(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalText(item ?? '')).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalText(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 不改原值，返回把 path 处换成 value 的新树；value 为 undefined 时删去对象里的这个键。 */
export function setIn(root: unknown, path: readonly Segment[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [Segment, ...Segment[]];
  if (typeof head === 'number') {
    const list = Array.isArray(root) ? [...root] : [];
    list[head] = setIn(list[head], rest, value);
    return list;
  }
  const object: Record<string, unknown> = isPlainObject(root) ? { ...root } : {};
  const next = setIn(object[head], rest, value);
  if (next === undefined) delete object[head];
  else object[head] = next;
  return object;
}

export function getIn(root: unknown, path: readonly Segment[]): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === 'number') current = Array.isArray(current) ? current[segment] : undefined;
    else current = isPlainObject(current) ? current[segment] : undefined;
  }
  return current;
}

/** 日期时间：数据集写 "2026-01-02 08:30:00"，浏览器的 datetime-local 输入框用 "2026-01-02T08:30"，秒为 0 时省略。 */
export const toDateTimeInput = (value: string) => value.replace(' ', 'T');
export function fromDateTimeInput(input: string): string | undefined {
  if (input === '') return undefined;
  const value = input.replace('T', ' ');
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
}

/** 对外参数里填写的数值：是合法数值就按数值传，否则原样传，由服务端报问题。 */
export function parameterNumber(text: string): number | string | undefined {
  if (text.trim() === '') return undefined;
  return JSON_NUMBER.test(text.trim()) ? Number(text.trim()) : text;
}
