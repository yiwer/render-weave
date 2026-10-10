/**
 * 作用域：一次模板调用中可读取的变量取值（ADR-0007：作用域不继承调用方）。
 * 数据字段来自数据集，参数来自渲染请求或缺省值，派生变量按需计算并缓存。
 * 缺值统一为 undefined；取项超出范围、路径上任何一级缺失都得到空值，不报错（M16、S12）。
 */
import { addDecimal } from '../decimal.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { isRecord } from '../util.js';
import type { VariableTable } from './check.js';
import { checkParameterValue, normalizeColor } from './declarations.js';
import type { CheckModel, Condition, DerivedModel, Operand, TemplateModel } from './model.js';
import type { ValueType } from './types.js';

export type ParameterValues = ReadonlyMap<string, string | number | boolean>;

/**
 * 渲染请求填写的参数（M15）：只能填写对外参数；对外参数没有缺省值时必须提供；取值按类型与约束检查。
 * 类型不对的值不用，按未填写处理；违反约束的值仍然使用（草稿预览可以照常出图），问题为严重。
 */
export function resolveParameters(template: TemplateModel, requested: Readonly<Record<string, unknown>>): { values: ParameterValues; problems: Problem[] } {
  const problems: Problem[] = [];
  const values = new Map<string, string | number | boolean>();
  const declared = new Map(template.parameters.map((parameter) => [parameter.name, parameter]));
  for (const [name, value] of Object.entries(requested)) {
    const parameter = declared.get(name);
    const location = { kind: 'parameter', name } as const;
    if (!parameter) {
      problems.push(severe(ProblemCodes.parameterUnknown, location, `模板"${template.name}"没有对外参数 ${name}`));
      continue;
    }
    if (parameter.visibility === 'internal') {
      problems.push(severe(ProblemCodes.parameterInternal, location, `"${parameter.displayName}"（${name}）是内部参数，只由模板设计者设定，调用方不能填写（M15）`));
      continue;
    }
    const checked = checkParameterValue(parameter, value);
    if (checked.problem) {
      problems.push(severe(ProblemCodes.parameterInvalid, location, `对外参数"${parameter.displayName}"（${name}）${checked.problem}`));
    }
    if (checked.value !== undefined) values.set(name, checked.value);
  }
  for (const parameter of template.parameters) {
    if (values.has(parameter.name)) continue;
    if (parameter.default !== undefined) {
      values.set(parameter.name, parameter.default);
    } else if (!(parameter.name in requested)) {
      problems.push(
        severe(
          ProblemCodes.parameterMissing,
          { kind: 'parameter', name: parameter.name },
          `必须提供对外参数"${parameter.displayName}"（${parameter.name}）：它没有缺省值`,
        ),
      );
    }
  }
  return { values, problems };
}

export class Scope {
  private readonly derived: ReadonlyMap<string, DerivedModel>;
  private readonly computed = new Map<string, unknown>();
  private readonly computing = new Set<string>();

  constructor(
    readonly template: TemplateModel,
    readonly table: VariableTable,
    private readonly data: unknown,
    private readonly parameters: ParameterValues,
  ) {
    this.derived = new Map(template.derived.map((derived) => [derived.name, derived]));
  }

  /** 按"."分隔的路径取值；第一段是变量名，其后经过单引用的字段。 */
  value(path: string): unknown {
    const [head = '', ...rest] = path.split('.');
    let current = this.variable(head);
    for (const name of rest) {
      if (!isRecord(current) || !Object.hasOwn(current, name)) return undefined;
      current = current[name];
    }
    return current ?? undefined;
  }

  /** 检查项（M25）：问题条件为真时，按其等级与提示文字记入问题清单。 */
  runChecks(): Problem[] {
    return this.template.checks.flatMap((check: CheckModel) =>
      this.operand(check.problemWhen) === true
        ? [{ code: ProblemCodes.checkFailed, level: check.level, location: { kind: 'check', template: this.template.name, name: check.name }, message: check.message } as Problem]
        : [],
    );
  }

  private variable(name: string): unknown {
    if (this.parameters.has(name)) return this.parameters.get(name);
    const derived = this.derived.get(name);
    if (derived) return this.derivedValue(derived);
    // 参数、派生变量以外的名称都是数据字段（静态检查已报告不存在的变量）。
    return isRecord(this.data) && Object.hasOwn(this.data, name) ? this.data[name] : undefined;
  }

  private derivedValue(derived: DerivedModel): unknown {
    if (this.computed.has(derived.name)) return this.computed.get(derived.name);
    // 成环时（静态检查已报告）取空值。
    if (this.computing.has(derived.name)) return undefined;
    this.computing.add(derived.name);
    const value = this.compute(derived);
    this.computing.delete(derived.name);
    this.computed.set(derived.name, value);
    return value;
  }

  private compute(derived: DerivedModel): unknown {
    const operation = derived.operation;
    switch (operation.op) {
      case 'branch': {
        const hit = operation.branches.find((branch) => this.condition(branch.when));
        return this.operand(hit ? hit.then : operation.otherwise);
      }
      case 'pickItem': {
        const list = this.value(operation.list.var);
        if (!Array.isArray(list)) return undefined;
        if (operation.position === 'first') return list[0];
        if (operation.position === 'last') return list.at(-1);
        const index = this.operand(operation.position.index);
        // 序号从 1 开始；超出范围得空值（S12）。
        return typeof index === 'number' && Number.isInteger(index) && index >= 1 ? list[index - 1] : undefined;
      }
      case 'length': {
        const value = this.value(operation.of.var);
        if (typeof value === 'string') return Array.from(value).length;
        if (Array.isArray(value)) return value.length;
        return 0;
      }
      case 'add':
      case 'subtract': {
        const left = this.operand(operation.left);
        const right = this.operand(operation.right);
        if (typeof left !== 'number' || typeof right !== 'number') return undefined;
        return addDecimal(left, operation.op === 'add' ? right : -right);
      }
    }
  }

  private operand(operand: Operand): unknown {
    return 'value' in operand ? operand.value : this.value(operand.var);
  }

  /**
   * 结构化比较（S11）。empty：缺值、空文本或空列表；数值 0 不算空。
   * 有一侧缺值时：eq 只在两侧都缺值时成立，ne 取反，大小比较都不成立。
   */
  private condition(condition: Condition): boolean {
    const left = this.operand(condition.left);
    if (condition.op === 'empty') return isEmpty(left);
    if (condition.op === 'notEmpty') return !isEmpty(left);
    const right = condition.right ? this.operand(condition.right) : undefined;
    const type = this.comparisonType(condition);
    const a = comparable(left, type);
    const b = comparable(right, type);
    if (condition.op === 'eq') return a === b;
    if (condition.op === 'ne') return a !== b;
    if (a === undefined || b === undefined) return false;
    switch (condition.op) {
      case 'lt':
        return a < b;
      case 'le':
        return a <= b;
      case 'gt':
        return a > b;
      case 'ge':
        return a >= b;
    }
  }

  private comparisonType(condition: Condition): ValueType | undefined {
    for (const side of [condition.left, condition.right]) {
      if (side && 'var' in side) {
        const resolved = this.table.typeOf(side.var);
        if ('type' in resolved) return resolved.type;
      }
    }
    return undefined;
  }
}

export function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/** 比较用的规范形式：时刻补齐秒，颜色统一大小写与透明度；类型不对或缺值时为 undefined。 */
function comparable(value: unknown, type: ValueType | undefined): string | number | boolean | undefined {
  if (value === undefined || value === null) return undefined;
  switch (type?.kind) {
    case 'number':
      return typeof value === 'number' ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'time':
      return typeof value === 'string' ? (value.length === 5 ? `${value}:00` : value) : undefined;
    case 'color':
      return normalizeColor(value);
    default:
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
  }
}
