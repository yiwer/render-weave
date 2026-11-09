/**
 * 派生变量与检查项（模板设计页票据 16，方案第 6 节，ADR-0004）：不写表达式，每种运算一个表单。纯函数，给文档与名称，回答新文档；原文档不变。
 * - 派生变量是单步运算，按名组合；名称是身份，改名等于删一个、加一个，这里不改名；
 * - 结果类型按运算推：分支的结果是写死的取值，能改；取项随列表的项；拆取文本是文本；长度与算术是数值；
 * - 删除时不替人改绑定：还在用的留给问题清单报。
 */
import { elementVariables, isObject, variableClosure, type JsonObject } from './document.js';

export type DerivedOp = 'branch' | 'pickItem' | 'splitPart' | 'length' | 'add' | 'subtract' | 'multiply' | 'divide' | 'mod';
export const OPS: readonly { readonly op: DerivedOp; readonly label: string }[] = [
  { op: 'branch', label: '条件分支' }, { op: 'pickItem', label: '取列表的一项' }, { op: 'splitPart', label: '拆取文本' }, { op: 'length', label: '长度' },
  { op: 'add', label: '加' }, { op: 'subtract', label: '减' }, { op: 'multiply', label: '乘' }, { op: 'divide', label: '除' }, { op: 'mod', label: '取模' },
];
export const ARITHMETIC: readonly DerivedOp[] = ['add', 'subtract', 'multiply', 'divide', 'mod'];
export const COMPARES: readonly (readonly [string, string])[] = [['eq', '等于'], ['ne', '不等于'], ['lt', '小于'], ['le', '不大于'], ['gt', '大于'], ['ge', '不小于'], ['empty', '为空'], ['notEmpty', '不为空']];
export const UNARY = new Set(['empty', 'notEmpty']);
/** 分支的结果能写成固定值的类型。 */
export const BRANCH_TYPES: readonly (readonly [string, string])[] = [['text', '文本'], ['number', '数值'], ['boolean', '布尔'], ['color', '颜色'], ['date', '日期'], ['time', '时刻'], ['datetime', '时间']];

/** 每种类型写成固定值时的初值，合数据集的写法。 */
export const EMPTY_VALUE: Readonly<Record<string, string | number | boolean>> = { text: '', number: 0, boolean: false, color: '#000000', date: '2026-01-01', time: '00:00', datetime: '2026-01-01T00:00:00' };

/** 作用域里的变量：名字与类型（列表另有每一项的类型与数据定义）。 */
export interface Variable { readonly name: string; readonly type: string; readonly itemType?: string; readonly itemRef?: { readonly name: string; readonly version: number } }

export type Operand = { readonly var: string } | { readonly value: string | number | boolean };

const list = (document: JsonObject, key: 'derived' | 'checks'): readonly JsonObject[] => (Array.isArray(document[key]) ? (document[key] as unknown[]).filter(isObject) : []);
const typed = (variables: readonly Variable[], ...types: readonly string[]) => variables.filter((item) => types.includes(item.type));

/**
 * 一种运算的初值：必填项都有、合 Schema。要的变量作用域里没有时回答原因（取项要列表，拆取文本要文本）。
 */
export function newDerived(op: DerivedOp, name: string, displayName: string, variables: readonly Variable[]): JsonObject | { readonly problem: string } {
  const head = { name, displayName };
  switch (op) {
    case 'branch': {
      const first = variables[0];
      return { ...head, type: 'text', op, branches: [{ when: { left: first ? { var: first.name } : { value: '' }, op: 'notEmpty' }, then: { value: '' } }], otherwise: { value: '' } };
    }
    case 'pickItem': {
      const source = typed(variables, 'list')[0];
      if (!source) return { problem: '作用域里没有列表变量' };
      return { ...head, ...itemType(source), op, list: { var: source.name }, position: 'first' };
    }
    case 'splitPart': {
      const source = typed(variables, 'text', 'number', 'date', 'time', 'datetime')[0];
      if (!source) return { problem: '作用域里没有能拆的文本、数值或时间' };
      return { ...head, type: 'text', op, of: { var: source.name }, delimiter: ' ', position: 'first' };
    }
    case 'length': {
      const source = typed(variables, 'list', 'text')[0];
      if (!source) return { problem: '作用域里没有列表或文本变量' };
      return { ...head, type: 'number', op, of: { var: source.name } };
    }
    default: return { ...head, type: 'number', op, left: { value: 0 }, right: { value: 1 } };
  }
}

/** 取项的结果类型：列表项是引用时是 ref 并写明数据定义，是基本类型时就是那个类型。 */
export function itemType(source: Variable | undefined): { readonly type: string; readonly ref?: { readonly name: string; readonly version: number } } {
  if (source?.itemRef && source.itemType === 'ref') return { type: 'ref', ref: source.itemRef };
  return { type: source?.itemType ?? 'text' };
}

/** 结果类型能不能改：只有分支能（结果是写死的取值）；别的按运算推。 */
export const typeEditable = (definition: JsonObject) => definition['op'] === 'branch';

/** 分支改结果类型：类型对不上的固定值换成新类型的初值，变量照旧（不对时由问题清单说）。 */
export function withBranchType(definition: JsonObject, type: string): JsonObject {
  const fix = (operand: unknown): unknown => {
    if (!isObject(operand) || !('value' in operand)) return operand;
    const value = operand['value'];
    const fits = type === 'number' ? typeof value === 'number' : type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string';
    return fits ? operand : { value: EMPTY_VALUE[type] ?? '' };
  };
  const branches = Array.isArray(definition['branches']) ? (definition['branches'] as unknown[]).map((branch) => (isObject(branch) ? { ...branch, then: fix(branch['then']) } : branch)) : definition['branches'];
  return { ...definition, type, branches, otherwise: fix(definition['otherwise']) };
}

/** 换运算：保留名称与显示名称，其余按新运算的初值。 */
export function withOp(definition: JsonObject, op: DerivedOp, variables: readonly Variable[]): JsonObject | { readonly problem: string } {
  return newDerived(op, String(definition['name']), String(definition['displayName'] ?? definition['name']), variables);
}

// —— 分支的行 ——

export const newBranch = (definition: JsonObject, variables: readonly Variable[]): JsonObject => ({
  when: { left: variables[0] ? { var: variables[0].name } : { value: '' }, op: 'notEmpty' },
  then: { value: EMPTY_VALUE[String(definition['type'])] ?? '' },
});

const branchesOf = (definition: JsonObject): readonly unknown[] => (Array.isArray(definition['branches']) ? definition['branches'] as unknown[] : []);

export function addBranch(definition: JsonObject, variables: readonly Variable[]): JsonObject {
  return { ...definition, branches: [...branchesOf(definition), newBranch(definition, variables)] };
}

/** 去掉一支：至少要留一支（Schema 的 minItems）。 */
export function removeBranch(definition: JsonObject, index: number): JsonObject | undefined {
  const branches = branchesOf(definition);
  if (branches.length <= 1) return undefined;
  return { ...definition, branches: branches.filter((_, at) => at !== index) };
}

/** 调整顺序：分支按顺序取第一个成立的，顺序就是意思。 */
export function moveBranch(definition: JsonObject, index: number, step: -1 | 1): JsonObject | undefined {
  const branches = [...branchesOf(definition)], to = index + step;
  if (to < 0 || to >= branches.length) return undefined;
  [branches[index], branches[to]] = [branches[to], branches[index]];
  return { ...definition, branches };
}

/** 条件的三种写法互换：单个比较、全部成立、任一成立（单层分组）。 */
export function withConditionKind(when: unknown, kind: 'single' | 'all' | 'any'): JsonObject {
  const compares = isObject(when) && Array.isArray(when['all']) ? when['all'] as JsonObject[] : isObject(when) && Array.isArray(when['any']) ? when['any'] as JsonObject[] : isObject(when) ? [when] : [];
  const first = compares[0] ?? { left: { value: '' }, op: 'notEmpty' };
  return kind === 'single' ? first : { [kind]: compares.length ? compares : [first] };
}

/** 比较换了运算：为空、不为空只有左侧，别的要右侧。 */
export function withCompareOp(compare: JsonObject, op: string): JsonObject {
  const { right, ...rest } = compare;
  return UNARY.has(op) ? { ...rest, op } : { ...rest, op, right: isObject(right) ? right : { value: '' } };
}

// —— 文档里的增删 ——

export function setDerived(document: JsonObject, name: string, next: JsonObject): JsonObject {
  return { ...document, derived: list(document, 'derived').map((item) => (item['name'] === name ? next : item)) };
}

export function addDerived(document: JsonObject, definition: JsonObject): JsonObject {
  return { ...document, derived: [...list(document, 'derived'), definition] };
}

export function removeDerived(document: JsonObject, name: string): JsonObject {
  const kept = list(document, 'derived').filter((item) => item['name'] !== name);
  const { derived: _derived, ...rest } = document;
  return kept.length ? { ...rest, derived: kept } : rest;
}

/** 新检查项：作用域里有布尔变量就用它，没有先写"否"，条件成立时报提示级问题。 */
export function newCheck(name: string, displayName: string, variables: readonly Variable[]): JsonObject {
  const flag = typed(variables, 'boolean')[0];
  return { name, displayName, problemWhen: flag ? { var: flag.name } : { value: false }, level: 'hint', message: `${displayName}：请检查` };
}

export function addCheck(document: JsonObject, check: JsonObject): JsonObject {
  return { ...document, checks: [...list(document, 'checks'), check] };
}

export function removeCheck(document: JsonObject, name: string): JsonObject {
  const kept = list(document, 'checks').filter((item) => item['name'] !== name);
  const { checks: _checks, ...rest } = document;
  return kept.length ? { ...rest, checks: kept } : rest;
}

/** 循环引用（template.variableCycle）：这个派生变量经别的派生变量用到了自己。 */
export function cycleOf(document: JsonObject, name: string): boolean {
  const definition = list(document, 'derived').find((item) => item['name'] === name);
  if (!definition) return false;
  const direct = elementVariables(definition).map((variable) => variable.split('.')[0]!);
  return direct.includes(name) || [...variableClosure(document, direct.filter((item) => item !== name))].includes(name);
}

/** 谁用到了这个派生变量或检查项要的变量：派生变量与检查项（元素由 usesOfVariable 回答）。 */
export function definitionsUsing(document: JsonObject, name: string): readonly string[] {
  return [...list(document, 'derived'), ...list(document, 'checks')].filter((item) => item['name'] !== name && elementVariables(item).some((variable) => variable.split('.')[0] === name)).map((item) => String(item['name']));
}
