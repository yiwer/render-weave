/**
 * 模板变量声明的解析：参数、派生变量与检查项的结构与写法（M90 S2、S11）。
 * 运算数的类型是否对得上要等知道基准数据定义之后，由模板静态检查（check.ts）完成。
 */
import { ProblemCodes, severe, type Problem, type ProblemCode, type ProblemLocation } from '../problems.js';
import { DATE_PATTERN, DATETIME_PATTERN, RESOURCE_REF_PATTERN, TIME_PATTERN, isValidDate, isValidDatetime } from '../schema/formats.js';
import { isRecord } from '../util.js';
import { parseStaticSchemaRef } from '../workspace.js';
import type { CheckModel, CompareOp, Condition, DerivedModel, Operand, Operation, ParameterConstraints, ParameterModel, VarOperand } from './model.js';
import { BASIC_KINDS, type BasicKind } from './types.js';

export interface Declarations {
  readonly parameters: ParameterModel[];
  readonly derived: DerivedModel[];
  readonly checks: CheckModel[];
}

const PARAMETER_KEYS = ['name', 'displayName', 'visibility', 'type', 'constraints', 'default'];
const CONSTRAINT_KEYS: Partial<Record<BasicKind, readonly string[]>> = {
  number: ['integer', 'min', 'max', 'enum'],
  text: ['minLength', 'maxLength', 'pattern', 'enum'],
};
const OPERATION_KEYS: Record<Operation['op'], readonly string[]> = {
  branch: ['branches', 'otherwise'],
  pickItem: ['list', 'position'],
  length: ['of'],
  add: ['left', 'right'],
  subtract: ['left', 'right'],
};
const COMPARE_OPS: readonly CompareOp[] = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'empty', 'notEmpty'];
const CHECK_KEYS = ['name', 'displayName', 'problemWhen', 'level', 'message'];

export function readDeclarations(templateName: string, document: Record<string, unknown>): { declarations: Declarations; problems: Problem[] } {
  const reader = new DeclarationReader(templateName);
  const declarations = {
    parameters: reader.list(document['parameters'], 'parameters', (value, index) => reader.parameter(value, index)),
    derived: reader.list(document['derived'], 'derived', (value, index) => reader.derived(value, index)),
    checks: reader.list(document['checks'], 'checks', (value, index) => reader.check(value, index)),
  };
  return { declarations, problems: reader.problems };
}

/** 变量名：非空，不含"."（路径用"."分隔，M90 S2）。 */
export function isVariableName(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !value.includes('.');
}

export function isVarOperand(value: unknown): value is { var: string } {
  return isRecord(value) && Object.keys(value).length === 1 && typeof value['var'] === 'string' && value['var'] !== '';
}

class DeclarationReader {
  readonly problems: Problem[] = [];

  constructor(private readonly template: string) {}

  list<T>(value: unknown, key: string, read: (value: Record<string, unknown>, index: number) => T | undefined): T[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.report(ProblemCodes.templateInvalid, this.at(key), `模板的 ${key} 必须是列表`);
      return [];
    }
    const items: T[] = [];
    value.forEach((item, index) => {
      if (!isRecord(item)) {
        this.report(ProblemCodes.templateInvalid, this.at(`${key}[${index + 1}]`), `${key} 的每一项必须是对象`);
        return;
      }
      const read_ = read(item, index);
      if (read_ !== undefined) items.push(read_);
    });
    return items;
  }

  parameter(value: Record<string, unknown>, index: number): ParameterModel | undefined {
    const name = isVariableName(value['name']) ? value['name'] : undefined;
    const where = this.at(name ?? `parameters[${index + 1}]`);
    const errors = this.problems.length;
    if (!name) this.report(ProblemCodes.templateInvalid, where, '参数必须有名称 name，且不含"."');
    this.checkKeys(value, PARAMETER_KEYS, where, '参数');
    const displayName = this.displayName(value, where);
    const visibility = value['visibility'];
    if (visibility !== 'public' && visibility !== 'internal') {
      this.report(ProblemCodes.templateInvalid, where, '参数的 visibility 只能取 public（对外参数）或 internal（内部参数）');
    }
    const type = value['type'];
    if (!BASIC_KINDS.includes(type as BasicKind)) {
      this.report(ProblemCodes.templateInvalid, where, `参数的类型 type 只能取 ${BASIC_KINDS.join('、')}`);
      return undefined;
    }
    const constraints = this.constraints(value['constraints'], type as BasicKind, where);
    if (!constraints || this.problems.length > errors || !name || !displayName) return undefined;
    const parameter: ParameterModel = {
      name,
      displayName,
      visibility: visibility as ParameterModel['visibility'],
      type: type as BasicKind,
      constraints,
    };
    if (value['default'] === undefined) {
      if (parameter.visibility === 'internal') {
        this.report(ProblemCodes.templateInvalid, where, `内部参数"${displayName}"必须有缺省值 default（M15）`);
        return undefined;
      }
      return parameter;
    }
    const checked = checkParameterValue(parameter, value['default']);
    if (checked.problem) {
      this.report(ProblemCodes.templateInvalid, where, `参数"${displayName}"的缺省值${checked.problem}`);
      return undefined;
    }
    return { ...parameter, default: checked.value! };
  }

  private constraints(value: unknown, type: BasicKind, where: ProblemLocation): ParameterConstraints | undefined {
    if (value === undefined) return {};
    const allowed = CONSTRAINT_KEYS[type] ?? [];
    if (!isRecord(value)) {
      this.report(ProblemCodes.templateInvalid, where, '参数的约束 constraints 必须是对象');
      return undefined;
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.report(ProblemCodes.templateInvalid, where, `${kindName(type)}参数不能写约束 ${key}${allowed.length ? `，可写 ${allowed.join('、')}` : ''}`);
        return undefined;
      }
    }
    const { integer, min, max, minLength, maxLength, pattern, enum: values } = value;
    const bad = (message: string) => {
      this.report(ProblemCodes.templateInvalid, where, message);
      return undefined;
    };
    if (integer !== undefined && typeof integer !== 'boolean') return bad('约束 integer 必须是 true 或 false');
    for (const [key, bound] of [['min', min], ['max', max]] as const) {
      if (bound !== undefined && !(typeof bound === 'number' && Number.isFinite(bound))) return bad(`约束 ${key} 必须是数`);
    }
    for (const [key, length] of [['minLength', minLength], ['maxLength', maxLength]] as const) {
      if (length !== undefined && !(typeof length === 'number' && Number.isInteger(length) && length >= 0)) return bad(`约束 ${key} 必须是不小于 0 的整数`);
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) return bad('约束 min 不能大于 max');
    if (typeof minLength === 'number' && typeof maxLength === 'number' && minLength > maxLength) return bad('约束 minLength 不能大于 maxLength');
    if (pattern !== undefined) {
      if (typeof pattern !== 'string') return bad('约束 pattern 必须是正则表达式字符串');
      try {
        new RegExp(pattern, 'u');
      } catch {
        return bad(`约束 pattern 不是合法的正则表达式：${pattern}`);
      }
    }
    if (values !== undefined) {
      const itemType = type === 'number' ? 'number' : 'string';
      if (!Array.isArray(values) || values.length === 0 || !values.every((item) => typeof item === itemType)) {
        return bad(`约束 enum 必须是非空的${type === 'number' ? '数值' : '文本'}列表`);
      }
    }
    return {
      ...(integer !== undefined && { integer }),
      ...(typeof min === 'number' && { min }),
      ...(typeof max === 'number' && { max }),
      ...(typeof minLength === 'number' && { minLength }),
      ...(typeof maxLength === 'number' && { maxLength }),
      ...(typeof pattern === 'string' && { pattern }),
      ...(values !== undefined && { enum: values as (string | number)[] }),
    };
  }

  derived(value: Record<string, unknown>, index: number): DerivedModel | undefined {
    const name = isVariableName(value['name']) ? value['name'] : undefined;
    const where = this.at(name ?? `derived[${index + 1}]`);
    const errors = this.problems.length;
    if (!name) this.report(ProblemCodes.templateInvalid, where, '派生变量必须有名称 name，且不含"."');
    const displayName = this.displayName(value, where);
    const type = value['type'];
    if (type !== 'ref' && !BASIC_KINDS.includes(type as BasicKind)) {
      this.report(ProblemCodes.templateInvalid, where, `派生变量必须声明结果类型 type：${[...BASIC_KINDS, 'ref'].join('、')}（M23）`);
    }
    if (isRecord(value['ref'])) this.checkKeys(value['ref'], ['name', 'version'], where, '引用 ref');
    const ref = value['ref'] === undefined ? undefined : parseStaticSchemaRef(value['ref']);
    if (type === 'ref' && !ref) this.report(ProblemCodes.templateInvalid, where, '结果类型为 ref 时必须用 ref 写明静态数据定义的名称与版本号');
    if (type !== 'ref' && value['ref'] !== undefined) this.report(ProblemCodes.templateInvalid, where, '只有结果类型为 ref 时才写 ref');
    const op = value['op'];
    if (typeof op !== 'string' || !Object.hasOwn(OPERATION_KEYS, op)) {
      this.report(ProblemCodes.templateInvalid, where, `派生变量的运算 op 只能取 ${Object.keys(OPERATION_KEYS).join('、')}`);
      return undefined;
    }
    this.checkKeys(value, ['name', 'displayName', 'type', 'ref', 'op', ...OPERATION_KEYS[op as Operation['op']]], where, '派生变量');
    const operation = this.operation(op as Operation['op'], value, where);
    if (!operation || this.problems.length > errors || !name || !displayName) return undefined;
    return { name, displayName, type: type as DerivedModel['type'], ...(ref && { ref }), operation };
  }

  private operation(op: Operation['op'], value: Record<string, unknown>, where: ProblemLocation): Operation | undefined {
    switch (op) {
      case 'branch': {
        const branches = value['branches'];
        if (!Array.isArray(branches) || branches.length === 0) {
          this.report(ProblemCodes.templateInvalid, where, '条件分支的 branches 必须是非空列表，每项写成 { "when": 条件, "then": 结果 }');
          return undefined;
        }
        const read = branches.map((branch) => {
          if (!isRecord(branch)) {
            this.report(ProblemCodes.templateInvalid, where, '分支写成 { "when": 条件, "then": 结果 }');
            return undefined;
          }
          this.checkKeys(branch, ['when', 'then'], where, '分支');
          const when = this.condition(branch['when'], where);
          const then = this.operand(branch['then'], where, 'then');
          return when && then ? { when, then } : undefined;
        });
        if (value['otherwise'] === undefined) {
          this.report(ProblemCodes.templateInvalid, where, '条件分支必须有"否则" otherwise（M23）');
          return undefined;
        }
        const otherwise = this.operand(value['otherwise'], where, 'otherwise');
        if (!otherwise || read.some((branch) => !branch)) return undefined;
        return { op, branches: read as { when: Condition; then: Operand }[], otherwise };
      }
      case 'pickItem': {
        const list = this.varOperand(value['list'], where, 'list');
        const position = value['position'];
        let parsed: 'first' | 'last' | { index: Operand } | undefined;
        if (position === 'first' || position === 'last') parsed = position;
        else if (isRecord(position) && Object.keys(position).length === 1 && 'index' in position) {
          const index = this.operand(position['index'], where, 'position.index');
          parsed = index && { index };
        } else {
          this.report(ProblemCodes.templateInvalid, where, '取项的 position 写成 "first"、"last" 或 { "index": 序号 }（从 1 开始）');
        }
        return list && parsed ? { op, list, position: parsed } : undefined;
      }
      case 'length': {
        const of = this.varOperand(value['of'], where, 'of');
        return of && { op, of };
      }
      case 'add':
      case 'subtract': {
        const left = this.operand(value['left'], where, 'left');
        const right = this.operand(value['right'], where, 'right');
        return left && right ? { op, left, right } : undefined;
      }
    }
  }

  private condition(value: unknown, where: ProblemLocation): Condition | undefined {
    if (!isRecord(value) || !COMPARE_OPS.includes(value['op'] as CompareOp)) {
      this.report(
        ProblemCodes.templateInvalid,
        where,
        `条件写成 { "left": 运算数, "op": 比较, "right": 运算数 }，比较取 ${COMPARE_OPS.join('、')}（S11）`,
      );
      return undefined;
    }
    this.checkKeys(value, ['left', 'op', 'right'], where, '条件');
    const op = value['op'] as CompareOp;
    const left = this.operand(value['left'], where, 'left');
    const unary = op === 'empty' || op === 'notEmpty';
    if (unary && value['right'] !== undefined) {
      this.report(ProblemCodes.templateInvalid, where, `比较 ${op} 只有左侧，不写 right`);
      return undefined;
    }
    if (!unary && value['right'] === undefined) {
      this.report(ProblemCodes.templateInvalid, where, `比较 ${op} 必须有右侧 right`);
      return undefined;
    }
    const right = unary ? undefined : this.operand(value['right'], where, 'right');
    if (!left || (!unary && !right)) return undefined;
    return { left, op, ...(right && { right }) };
  }

  operand(value: unknown, where: ProblemLocation, label: string): Operand | undefined {
    if (isVarOperand(value)) return { var: value.var };
    if (isRecord(value) && Object.keys(value).length === 1 && 'value' in value) {
      const literal = value['value'];
      if (typeof literal === 'string' || typeof literal === 'boolean' || (typeof literal === 'number' && Number.isFinite(literal))) {
        return { value: literal };
      }
    }
    if (isRecord(value) && 'loop' in value) {
      this.report(ProblemCodes.templateUnsupported, where, `${label} 引用循环信息尚未支持`);
      return undefined;
    }
    this.report(ProblemCodes.templateInvalid, where, `${label} 写成 { "var": 变量路径 } 或 { "value": 文字、数值或布尔 }`);
    return undefined;
  }

  private varOperand(value: unknown, where: ProblemLocation, label: string): VarOperand | undefined {
    if (isVarOperand(value)) return { var: value.var };
    this.report(ProblemCodes.templateInvalid, where, `${label} 写成 { "var": 变量路径 }`);
    return undefined;
  }

  check(value: Record<string, unknown>, index: number): CheckModel | undefined {
    const name = typeof value['name'] === 'string' && value['name'] !== '' ? value['name'] : undefined;
    const where: ProblemLocation = { kind: 'check', template: this.template, name: name ?? `checks[${index + 1}]` };
    const errors = this.problems.length;
    if (!name) this.report(ProblemCodes.templateInvalid, where, '检查项必须有名称 name');
    this.checkKeys(value, CHECK_KEYS, where, '检查项');
    const displayName = value['displayName'];
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName === '')) {
      this.report(ProblemCodes.templateInvalid, where, '检查项的显示名称 displayName 必须是非空文本');
    }
    const problemWhen = this.operand(value['problemWhen'], where, 'problemWhen');
    const level = value['level'];
    if (level !== 'severe' && level !== 'hint') this.report(ProblemCodes.templateInvalid, where, '检查项的等级 level 只能取 severe 或 hint');
    const message = value['message'];
    if (typeof message !== 'string' || message === '') this.report(ProblemCodes.templateInvalid, where, '检查项必须有提示文字 message');
    if (!problemWhen || this.problems.length > errors || !name) return undefined;
    return { name, problemWhen, level: level as CheckModel['level'], message: message as string };
  }

  private displayName(value: Record<string, unknown>, where: ProblemLocation): string | undefined {
    const displayName = value['displayName'];
    if (typeof displayName === 'string' && displayName !== '') return displayName;
    this.report(ProblemCodes.templateInvalid, where, '必须有显示名称 displayName');
    return undefined;
  }

  private checkKeys(value: Record<string, unknown>, allowed: readonly string[], where: ProblemLocation, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.report(ProblemCodes.templateUnknownProperty, where, `${what}中有未定义或尚未支持的属性 ${key}`);
    }
  }

  private at(name: string): ProblemLocation {
    return { kind: 'variable', template: this.template, name };
  }

  private report(code: ProblemCode, location: ProblemLocation, message: string): void {
    this.problems.push(severe(code, location, message));
  }
}

function kindName(kind: BasicKind): string {
  return { text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片', color: '颜色' }[kind];
}

/**
 * 检查参数取值（缺省值与渲染请求填写的值）。类型不对时没有可用的值；
 * 违反约束时仍返回值（草稿预览照常用它出图），并给出说明。颜色规范化为 #RRGGBBAA。
 */
export function checkParameterValue(
  parameter: Pick<ParameterModel, 'type' | 'constraints'>,
  value: unknown,
): { value?: string | number | boolean; problem?: string } {
  const typeProblem = (expected: string) => ({ problem: `必须是${expected}` });
  const c = parameter.constraints;
  switch (parameter.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return typeProblem('数值');
      const violated =
        (c.integer && !Number.isInteger(value) && '必须是整数') ||
        (c.min !== undefined && value < c.min && `不能小于 ${c.min}`) ||
        (c.max !== undefined && value > c.max && `不能大于 ${c.max}`) ||
        (c.enum && !c.enum.includes(value) && `只能取 ${c.enum.join('、')}`);
      return { value, ...(violated && { problem: `${value} ${violated}` }) };
    }
    case 'text': {
      if (typeof value !== 'string') return typeProblem('文本');
      const length = Array.from(value).length;
      const violated =
        (c.minLength !== undefined && length < c.minLength && `至少 ${c.minLength} 个字`) ||
        (c.maxLength !== undefined && length > c.maxLength && `最多 ${c.maxLength} 个字`) ||
        (c.pattern !== undefined && !new RegExp(c.pattern, 'u').test(value) && `不符合格式 ${c.pattern}`) ||
        (c.enum && !c.enum.includes(value) && `只能取 ${c.enum.join('、')}`);
      return { value, ...(violated && { problem: `"${value}"${violated}` }) };
    }
    case 'boolean':
      return typeof value === 'boolean' ? { value } : typeProblem('true 或 false');
    case 'date':
      return typeof value === 'string' && isValidDate(value) ? { value } : typeProblem(`日期，如 2026-01-02（${DATE_PATTERN}）`);
    case 'time':
      return typeof value === 'string' && new RegExp(TIME_PATTERN).test(value) ? { value } : typeProblem('时刻，如 07:30 或 07:30:00');
    case 'datetime':
      return typeof value === 'string' && isValidDatetime(value) ? { value } : typeProblem(`时间，如 2025-01-02 09:08:12（${DATETIME_PATTERN}）`);
    case 'image':
      return typeof value === 'string' && new RegExp(RESOURCE_REF_PATTERN).test(value) ? { value } : typeProblem('图片资源引用 res:资源ID');
    case 'color': {
      const color = normalizeColor(value);
      return color ? { value: color } : typeProblem('#RRGGBB 或 #RRGGBBAA 形式的颜色');
    }
  }
}

/** 颜色统一为大写的 #RRGGBBAA；不是颜色时为 undefined。 */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value)) return undefined;
  return (value.length === 7 ? `${value}FF` : value).toUpperCase();
}
