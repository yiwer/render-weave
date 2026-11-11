/**
 * 状态样式（模板设计页票据 17，方案第 7 节，M28、S5）：按一个变量的取值覆盖元素自己的属性。纯函数。
 * - 依据只能是单值变量：列表与引用不能作为依据（引擎 src/template/check.ts 的 state 规则）；
 * - 覆盖是整项替换（src/template/parse.ts:450）：改嵌套的一格（place.width）时，先在"自身属性加覆盖"合并出的元素上改，
 *   再把改后的整项搬进覆盖；改回和自身属性一样的值就去掉这一项，取值下没有覆盖了就去掉这个取值；
 * - 取值的全集优先用引擎求值给的 known；没有时按文档推（布尔、参数的枚举约束、结果全是固定值的条件分支，同引擎 knownValues 的口径）。
 */
import type { ScopeVariable } from './binding.js';
import { setElement } from './calls.js';
import { elementAt, isObject, type JsonObject } from './document.js';
import { stateOverridable, writeProperty, type FieldPath } from './properties.js';

export interface StateInfo {
  readonly by?: string;
  readonly cases: Readonly<Record<string, JsonObject>>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function statesOf(element: JsonObject | undefined): StateInfo {
  const states = isObject(element?.['states']) ? element['states'] : undefined;
  const by = isObject(states?.['by']) && typeof states['by']['var'] === 'string' ? states['by']['var'] : undefined;
  const cases = isObject(states?.['cases']) ? Object.fromEntries(Object.entries(states['cases']).filter((entry): entry is [string, JsonObject] => isObject(entry[1]))) : {};
  return { ...(by ? { by } : {}), cases };
}

/** 能作为状态样式依据的变量：列表与引用不能。 */
export const stateCandidates = (variables: readonly ScopeVariable[]): readonly ScopeVariable[] => variables.filter((variable) => !['list', 'ref', 'object'].includes(variable.type));

/** 状态样式的取值写法：布尔为 true、false，数值为最短的十进制写法，其余为文字本身（引擎 stateKey）。 */
export function stateKey(value: string | number | boolean): string {
  if (typeof value !== 'number') return String(value);
  const text = String(value);
  // 科学计数法（1e-7）展开成普通小数，和引擎 plainNumber 一样。
  return /e/iu.test(text) ? value.toFixed(20).replace(/\.?0+$/u, '') : text;
}

/** 按文档推出的全部取值：布尔、参数的枚举约束、结果全是固定值的条件分支；推不出时 undefined。 */
export function knownValues(document: JsonObject, variables: readonly ScopeVariable[], by: string): readonly string[] | undefined {
  if (variables.find((variable) => variable.name === by)?.type === 'boolean') return ['true', 'false'];
  const named = (list: string) => (Array.isArray(document[list]) ? (document[list] as unknown[]).filter(isObject) : []).find((item) => item['name'] === by);
  const parameter = named('parameters'), derived = named('derived');
  if (parameter?.['type'] === 'boolean' || derived?.['type'] === 'boolean') return ['true', 'false'];
  const choices = isObject(parameter?.['constraints']) ? parameter['constraints']['enum'] : undefined;
  if (Array.isArray(choices)) return choices.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').map(stateKey);
  if (derived?.['op'] === 'branch' && Array.isArray(derived['branches'])) {
    const outcomes = [...(derived['branches'] as unknown[]).map((branch) => (isObject(branch) ? branch['then'] : undefined)), derived['otherwise']];
    if (outcomes.every((outcome) => isObject(outcome) && 'value' in outcome)) {
      return [...new Set(outcomes.map((outcome) => stateKey((outcome as { value: string | number | boolean }).value)))];
    }
  }
  return undefined;
}

/** 这个取值会不会出现；不会时说明为什么（引擎报 template.unknownStateValue 的同一个判断）。 */
export function unknownValueProblem(value: string, known: readonly string[] | undefined, type: string | undefined, by: string): string | undefined {
  if (known) return known.includes(value) ? undefined : `取值"${value}"不会出现：${by} 只可能是 ${known.join('、')}`;
  if (type === 'number' && !(value.trim() !== '' && Number.isFinite(Number(value)))) return `取值"${value}"不会出现：${by} 是数值，取值要写成数字`;
  return undefined;
}

/** 输入框里的取值换成状态样式的写法（数值 1.50 写成 1.5）。 */
export function normalizeValue(text: string, type: string | undefined): string {
  const trimmed = text.trim();
  return type === 'number' && trimmed !== '' && Number.isFinite(Number(trimmed)) ? stateKey(Number(trimmed)) : trimmed;
}

export interface StateChip {
  readonly value: string;
  /** 这个取值下写了覆盖。 */
  readonly covered: boolean;
  /** 当前样例里几处是这个取值；不知道时 undefined。 */
  readonly count?: number;
  /** 当前样例里第一处的实例路径。 */
  readonly first?: string;
  /** 不会出现时的说明。 */
  readonly problem?: string;
}

/** 取值按钮：全部取值（推得出来时），加上已写的覆盖、正在编辑的取值；带当前样例的命中数。 */
export function stateChips(element: JsonObject, options: {
  readonly known?: readonly string[]; readonly type?: string;
  readonly instances?: readonly { readonly path: string; readonly state?: string }[]; readonly current?: string;
}): readonly StateChip[] {
  const info = statesOf(element);
  if (!info.by) return [];
  const values = [...new Set([...(options.known ?? []), ...Object.keys(info.cases), ...(options.current !== undefined ? [options.current] : [])])];
  return values.map((value) => {
    const hits = options.instances?.filter((instance) => instance.state === value);
    const problem = unknownValueProblem(value, options.known, options.type, info.by!);
    return {
      value, covered: value in info.cases,
      ...(hits ? { count: hits.length } : {}), ...(hits?.[0] ? { first: hits[0].path } : {}), ...(problem ? { problem } : {}),
    };
  });
}

/** 换依据的变量：已写的覆盖留着（取值对不上时由按钮与问题清单说明）；undefined 是去掉状态样式。 */
export function setStateBy(document: JsonObject, path: string, by: string | undefined): JsonObject {
  const element = elementAt(document, path)?.element;
  if (!element) return document;
  if (by === undefined) {
    const { states: _states, ...rest } = element;
    return setElement(document, path, rest);
  }
  const states = isObject(element['states']) ? element['states'] : {};
  return setElement(document, path, { ...element, states: { ...states, by: { var: by }, cases: isObject(states['cases']) ? states['cases'] : {} } });
}

/** 这个取值下看到的元素：自身属性加上覆盖（整项替换）。 */
export function mergedElement(element: JsonObject, state: string): JsonObject {
  return { ...element, ...(statesOf(element).cases[state] ?? {}) };
}

export function mergedDocument(document: JsonObject, path: string, state: string): JsonObject {
  const element = elementAt(document, path)?.element;
  return element ? setElement(document, path, mergedElement(element, state)) : document;
}

/** 覆盖里的一项：undefined 或和自身属性一样就去掉；取值下没有覆盖了就去掉这个取值。 */
function setCaseKey(document: JsonObject, path: string, state: string, key: string, value: unknown): JsonObject {
  const element = elementAt(document, path)?.element;
  if (!element || !isObject(element['states'])) return document;
  const states = element['states'], cases = { ...(isObject(states['cases']) ? states['cases'] : {}) };
  const override = { ...(isObject(cases[state]) ? cases[state] : {}) };
  if (value === undefined || same(value, element[key])) delete override[key];
  else override[key] = value;
  if (Object.keys(override).length) cases[state] = override;
  else delete cases[state];
  return setElement(document, path, { ...element, states: { ...states, cases } });
}

/**
 * 在合并出的元素上做完一次编辑（written 是编辑后的整份文档），把 keys 这几项搬进覆盖。
 * 文档别处的改动（提成参数时新加的参数）保留，元素自身属性不变。
 */
export function carryOverride(document: JsonObject, path: string, state: string, written: JsonObject, keys: readonly string[]): JsonObject {
  const original = elementAt(document, path)?.element, changed = elementAt(written, path)?.element;
  if (!original || !changed) return document;
  const allowed = stateOverridable(document, path);
  let next = setElement(written, path, original);
  for (const key of keys) if (allowed.includes(key)) next = setCaseKey(next, path, state, key, changed[key]);
  return next;
}

/** 值格的编辑写进这个取值的覆盖：和自身属性一样的写回入口，只是落点不同。不能覆盖的项不写。 */
export function writeOverride(document: JsonObject, path: string, state: string, fieldPath: FieldPath, value: unknown): JsonObject {
  const key = String(fieldPath[0]);
  if (!stateOverridable(document, path).includes(key)) return document;
  return carryOverride(document, path, state, writeProperty(mergedDocument(document, path, state), path, fieldPath, value), [key]);
}

/** 表单写回整个元素（循环的每项排布、传入参数）：变了的、能覆盖的项搬进覆盖。 */
export function writeElementOverride(document: JsonObject, path: string, state: string, next: JsonObject): JsonObject {
  const element = elementAt(document, path)?.element;
  if (!element) return document;
  const merged = mergedElement(element, state);
  const keys = [...new Set([...Object.keys(next), ...Object.keys(merged)])].filter((key) => !same(next[key], merged[key]));
  return carryOverride(document, path, state, setElement(document, path, next), keys);
}

/** 重置：去掉这个取值下的这一项，回到自身属性。 */
export function resetOverride(document: JsonObject, path: string, state: string, key: string): JsonObject {
  return setCaseKey(document, path, state, key, undefined);
}

/** 这个取值下覆盖了哪几项。 */
export const overriddenKeys = (element: JsonObject | undefined, state: string): readonly string[] => Object.keys(statesOf(element).cases[state] ?? {});
