/**
 * 模板静态检查：在求值之前，对照基准静态数据定义的编译产物检查模板（M102、M118）。
 *
 * - 变量名：数据字段、参数与派生变量共用一个命名空间，不能重名（M90 S3）；派生变量之间不能成环。
 * - 派生变量：运算数能找到、类型对得上，结果与声明的类型一致（M23、M78）；检查项的问题条件是布尔值。
 * - 引用：绑定、插槽与状态样式引用的变量能找到，路径只经过单引用（M21、M24），类型与用途一致（M71）。
 *
 * 检查覆盖全部元素（包括隐藏的）。结果中的变量表供求值时按类型取值与输出。
 */
import { formatMismatch } from '../display-format.js';
import { formatElementPath } from '../element-path.js';
import { plainNumber } from '../decimal.js';
import { ProblemCodes, severe, type Problem, type ProblemCode, type ProblemLocation } from '../problems.js';
import { checkParameterValue } from './declarations.js';
import type { CheckModel, Condition, DerivedModel, Operand, TemplateModel, VariableUse } from './model.js';
import { displayKind, kindLabel, sameType, typeFromCompiled, typeLabel, type ValueType } from './types.js';

export interface Variable {
  readonly name: string;
  readonly displayName: string;
  readonly source: 'field' | 'parameter' | 'derived';
  readonly type: ValueType;
}

export interface VariableTable {
  get(name: string): Variable | undefined;
  /** 沿"."分隔的路径求类型；路径只能经过单引用。 */
  typeOf(path: string): PathType;
  /** 状态样式可列出的取值；不能确定时为 undefined。 */
  knownValues(path: string): readonly string[] | undefined;
}

export type PathType = { readonly type: ValueType } | { readonly code: ProblemCode; readonly message: string };

export function checkTemplate(template: TemplateModel, compiled: Record<string, unknown>): { problems: Problem[]; table: VariableTable } {
  const checker = new Checker(template, compiled);
  checker.run();
  return { problems: checker.problems, table: checker };
}

class Checker implements VariableTable {
  readonly problems: Problem[] = [];
  private readonly variables = new Map<string, Variable | { derived: DerivedModel }>();
  private readonly derivedTypes = new Map<string, ValueType>();
  private readonly resolving = new Set<string>();

  constructor(
    private readonly template: TemplateModel,
    compiled: Record<string, unknown>,
  ) {
    const data = typeFromCompiled(compiled);
    if (data.kind === 'ref') {
      for (const [name, type] of data.fields) this.variables.set(name, { name, displayName: type.displayName ?? name, source: 'field', type });
    }
    for (const parameter of template.parameters) {
      if (this.claim(parameter.name, '参数')) {
        this.variables.set(parameter.name, {
          name: parameter.name,
          displayName: parameter.displayName,
          source: 'parameter',
          type: {
            kind: parameter.type,
            ...(parameter.constraints.enum && { enum: parameter.constraints.enum }),
          },
        });
      }
    }
    for (const derived of template.derived) {
      if (this.claim(derived.name, '派生变量')) this.variables.set(derived.name, { derived });
    }
  }

  run(): void {
    this.checkCycles();
    for (const derived of this.template.derived) this.checkDerived(derived);
    for (const check of this.template.checks) this.checkCheck(check);
    for (const use of this.template.uses) this.checkUse(use);
  }

  // ---------- 变量表 ----------

  get(name: string): Variable | undefined {
    const entry = this.variables.get(name);
    if (!entry || !('derived' in entry)) return entry;
    const type = this.derivedType(entry.derived);
    return type && { name, displayName: entry.derived.displayName, source: 'derived', type };
  }

  typeOf(path: string): PathType {
    const [head = '', ...rest] = path.split('.');
    const variable = this.get(head);
    if (!variable) {
      return {
        code: ProblemCodes.templateUnknownVariable,
        message: this.variables.has(head) ? `变量 ${head} 的类型无法确定` : `变量 ${head} 不存在：既不是数据字段，也不是参数或派生变量`,
      };
    }
    let type = variable.type;
    const walked = [head];
    for (const name of rest) {
      if (type.kind !== 'ref') {
        return { code: ProblemCodes.templateInvalidPath, message: `${walked.join('.')} 的类型是${typeLabel(type)}，路径只能经过单引用` };
      }
      const next = type.fields.get(name);
      if (!next) return { code: ProblemCodes.templateUnknownVariable, message: `${walked.join('.')} 中没有字段 ${name}` };
      walked.push(name);
      type = next;
    }
    return { type };
  }

  knownValues(path: string): readonly string[] | undefined {
    const resolved = this.typeOf(path);
    if (!('type' in resolved)) return undefined;
    if (resolved.type.kind === 'boolean') return ['true', 'false'];
    if (resolved.type.kind !== 'list' && resolved.type.kind !== 'ref' && resolved.type.enum) {
      return resolved.type.enum.map((value) => (typeof value === 'number' ? plainNumber(value) : value));
    }
    // 结果全是固定值的条件分支：取值就是这些固定值（如站点状态）。
    const entry = path.includes('.') ? undefined : this.variables.get(path);
    if (entry && 'derived' in entry && entry.derived.operation.op === 'branch') {
      const operation = entry.derived.operation;
      const outcomes = [...operation.branches.map((branch) => branch.then), operation.otherwise];
      if (outcomes.every((operand) => 'value' in operand)) {
        return [...new Set(outcomes.map((operand) => stateKey((operand as { value: string | number | boolean }).value)))];
      }
    }
    return undefined;
  }

  private claim(name: string, what: string): boolean {
    const existing = this.variables.get(name);
    if (!existing) return true;
    const owner = 'derived' in existing ? '派生变量' : { field: '数据字段', parameter: '参数', derived: '派生变量' }[existing.source];
    this.report(
      ProblemCodes.templateDuplicateVariable,
      this.at(name),
      `${what} ${name} 与${owner}重名：数据字段、参数与派生变量共用一个命名空间（M90 S3）`,
    );
    return false;
  }

  /** 派生变量的类型：声明的类型；引用类型的字段取自运算数（取项的列表元素，或分支结果中的引用）。 */
  private derivedType(derived: DerivedModel): ValueType | undefined {
    const cached = this.derivedTypes.get(derived.name);
    if (cached) return cached;
    if (derived.type !== 'ref') {
      const type: ValueType = { kind: derived.type };
      this.derivedTypes.set(derived.name, type);
      return type;
    }
    if (this.resolving.has(derived.name)) return undefined;
    this.resolving.add(derived.name);
    try {
      const operation = derived.operation;
      const sources: Operand[] =
        operation.op === 'pickItem'
          ? [operation.list]
          : operation.op === 'branch'
            ? [...operation.branches.map((branch) => branch.then), operation.otherwise]
            : [];
      for (const source of sources) {
        if (!('var' in source)) continue;
        const resolved = this.typeOf(source.var);
        if (!('type' in resolved)) continue;
        const candidate = operation.op === 'pickItem' && resolved.type.kind === 'list' ? resolved.type.items : resolved.type;
        if (candidate.kind === 'ref') {
          this.derivedTypes.set(derived.name, candidate);
          return candidate;
        }
      }
      const declared: ValueType = { kind: 'ref', ...(derived.ref && { ref: derived.ref }), fields: new Map() };
      this.derivedTypes.set(derived.name, declared);
      return declared;
    } finally {
      this.resolving.delete(derived.name);
    }
  }

  // ---------- 派生变量与检查项 ----------

  private checkCycles(): void {
    const derivedNames = new Set(this.template.derived.map((derived) => derived.name));
    const edges = new Map(this.template.derived.map((derived) => [derived.name, operandsOf(derived).filter((name) => derivedNames.has(name))]));
    const state = new Map<string, 'visiting' | 'done'>();
    const stack: string[] = [];
    const reported = new Set<string>();
    const visit = (name: string) => {
      if (state.get(name) === 'done') return;
      if (state.get(name) === 'visiting') {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        if (!reported.has(name)) {
          cycle.forEach((member) => reported.add(member));
          this.report(ProblemCodes.templateVariableCycle, this.at(name), `派生变量之间的引用成环：${cycle.join(' → ')}`);
        }
        return;
      }
      state.set(name, 'visiting');
      stack.push(name);
      for (const next of edges.get(name) ?? []) visit(next);
      stack.pop();
      state.set(name, 'done');
    };
    for (const name of edges.keys()) visit(name);
  }

  private checkDerived(derived: DerivedModel): void {
    const where = this.at(derived.name);
    const declared = this.get(derived.name)?.type;
    if (!declared) return;
    const operation = derived.operation;
    switch (operation.op) {
      case 'branch':
        for (const branch of operation.branches) this.checkCondition(branch.when, where);
        for (const [index, outcome] of [...operation.branches.map((branch) => branch.then), operation.otherwise].entries()) {
          const label = index < operation.branches.length ? `第 ${index + 1} 个分支的结果` : '"否则"的结果';
          this.expectOperand(outcome, declared, where, label);
        }
        return;
      case 'pickItem': {
        const list = this.operandType(operation.list, where);
        if (list && list.kind !== 'list') {
          this.report(ProblemCodes.templateTypeMismatch, where, `取项的 list ${operation.list.var} 的类型是${typeLabel(list)}，必须是列表`);
        } else if (list && !sameType(list.items, declared)) {
          this.report(
            ProblemCodes.templateTypeMismatch,
            where,
            `派生变量声明为${typeLabel(declared)}，取项得到的是${typeLabel(list.items)}`,
          );
        }
        if (typeof operation.position === 'object') this.expectOperand(operation.position.index, { kind: 'number' }, where, '取项的序号');
        return;
      }
      case 'length': {
        const of = this.operandType(operation.of, where);
        if (of && of.kind !== 'text' && of.kind !== 'list') {
          this.report(ProblemCodes.templateTypeMismatch, where, `长度只用于文本或列表，${operation.of.var} 的类型是${typeLabel(of)}`);
        }
        this.expectResult(declared, 'number', where, '长度');
        return;
      }
      case 'add':
      case 'subtract':
        this.expectOperand(operation.left, { kind: 'number' }, where, 'left');
        this.expectOperand(operation.right, { kind: 'number' }, where, 'right');
        this.expectResult(declared, 'number', where, operation.op === 'add' ? '加法' : '减法');
        return;
    }
  }

  private expectResult(declared: ValueType, kind: 'number', where: ProblemLocation, what: string): void {
    if (declared.kind !== kind) {
      this.report(ProblemCodes.templateTypeMismatch, where, `${what}的结果是${kindLabel(kind)}，派生变量却声明为${typeLabel(declared)}`);
    }
  }

  private checkCondition(condition: Condition, where: ProblemLocation): void {
    const left = this.operandType(condition.left, where);
    if (condition.op === 'empty' || condition.op === 'notEmpty' || !condition.right) return;
    const right = this.operandType(condition.right, where);
    const ordered = condition.op !== 'eq' && condition.op !== 'ne';
    const comparable = (type: ValueType) =>
      ordered ? ['number', 'date', 'time', 'datetime'].includes(type.kind) : type.kind !== 'list' && type.kind !== 'ref';
    // 固定值跟随另一侧的类型（如与时刻比较的 "07:30"）。
    const target = 'var' in condition.left ? left : 'var' in condition.right ? right : left;
    if (!target) return;
    if (!comparable(target)) {
      const allowed = ordered ? '数值、日期、时刻或时间' : '基本类型';
      this.report(ProblemCodes.templateTypeMismatch, where, `比较 ${condition.op} 只用于${allowed}，这里是${typeLabel(target)}`);
      return;
    }
    for (const side of [condition.left, condition.right]) this.expectOperand(side, target, where, `比较 ${condition.op} 的运算数`);
  }

  private checkCheck(check: CheckModel): void {
    const where: ProblemLocation = { kind: 'check', template: this.template.name, name: check.name };
    this.expectOperand(check.problemWhen, { kind: 'boolean' }, where, '问题条件 problemWhen');
  }

  /** 运算数的类型；变量找不到时报问题并返回 undefined。固定值按其 JSON 类型。 */
  private operandType(operand: Operand, where: ProblemLocation): ValueType | undefined {
    if ('value' in operand) {
      return { kind: typeof operand.value === 'number' ? 'number' : typeof operand.value === 'boolean' ? 'boolean' : 'text' };
    }
    const resolved = this.typeOf(operand.var);
    if ('type' in resolved) return resolved.type;
    this.report(resolved.code, where, `${operand.var}：${resolved.message}`);
    return undefined;
  }

  private expectOperand(operand: Operand, expected: ValueType, where: ProblemLocation, label: string): void {
    if ('value' in operand) {
      const problem = literalProblem(operand.value, expected);
      if (problem) this.report(ProblemCodes.templateTypeMismatch, where, `${label}：${problem}`);
      return;
    }
    const actual = this.operandType(operand, where);
    if (actual && !sameType(actual, expected)) {
      this.report(ProblemCodes.templateTypeMismatch, where, `${label} ${operand.var} 的类型是${typeLabel(actual)}，需要${typeLabel(expected)}`);
    }
  }

  // ---------- 元素上的引用 ----------

  private checkUse(use: VariableUse): void {
    const where: ProblemLocation = { kind: 'element', path: formatElementPath(use.element) };
    const prefix = use.use === 'binding' ? `${use.label} 绑定的 ${use.var}` : use.use === 'slot' ? `插槽 ${use.var}` : `状态样式按 ${use.var}`;
    const resolved = this.typeOf(use.var);
    if (!('type' in resolved)) {
      this.report(resolved.code, where, `${prefix}：${resolved.message}`);
      return;
    }
    const type = resolved.type;
    switch (use.use) {
      case 'binding':
        if (type.kind !== use.expected) {
          this.report(ProblemCodes.templateTypeMismatch, where, `${prefix} 的类型是${typeLabel(type)}，${use.label} 需要${kindLabel(use.expected)}（M71）`);
        }
        return;
      case 'slot': {
        const kind = displayKind(type);
        if (!kind) {
          const advice = type.kind === 'boolean' ? '，按真假显示不同文字请用条件显示或状态样式' : '';
          this.report(ProblemCodes.templateTypeMismatch, where, `${prefix} 的类型是${typeLabel(type)}，不能显示为文字${advice}`);
          return;
        }
        if (use.format) {
          const mismatch = kind === 'text' ? `文本类型不带展示格式"${use.format.pattern}"` : formatMismatch(use.format, kind);
          if (mismatch) this.report(ProblemCodes.templateTypeMismatch, where, `${prefix}：${mismatch}`);
        }
        return;
      }
      case 'state': {
        if (type.kind === 'list' || type.kind === 'ref') {
          this.report(ProblemCodes.templateTypeMismatch, where, `${prefix}：${typeLabel(type)}不能作为状态样式的依据`);
          return;
        }
        const known = this.knownValues(use.var);
        const unknown = use.keys.filter((key) =>
          known ? !known.includes(key) : type.kind === 'number' && !(key.trim() !== '' && Number.isFinite(Number(key))),
        );
        if (unknown.length > 0) {
          const hint = known ? `，${use.var} 只可能是 ${known.join('、')}` : '，数值取值要写成数字';
          this.report(ProblemCodes.templateUnknownStateValue, where, `${prefix}：列出的取值 ${unknown.map((key) => `"${key}"`).join('、')} 不会出现${hint}`);
        }
        return;
      }
    }
  }

  private at(name: string): ProblemLocation {
    return { kind: 'variable', template: this.template.name, name };
  }

  private report(code: ProblemCode, location: ProblemLocation, message: string): void {
    this.problems.push(severe(code, location, message));
  }
}

/** 派生变量引用的变量名（路径的第一段）。 */
function operandsOf(derived: DerivedModel): string[] {
  const operation = derived.operation;
  const operands: Operand[] = [];
  switch (operation.op) {
    case 'branch':
      for (const branch of operation.branches) {
        operands.push(branch.when.left, branch.then);
        if (branch.when.right) operands.push(branch.when.right);
      }
      operands.push(operation.otherwise);
      break;
    case 'pickItem':
      operands.push(operation.list);
      if (typeof operation.position === 'object') operands.push(operation.position.index);
      break;
    case 'length':
      operands.push(operation.of);
      break;
    case 'add':
    case 'subtract':
      operands.push(operation.left, operation.right);
      break;
  }
  return operands.flatMap((operand) => ('var' in operand ? [operand.var.split('.')[0]!] : []));
}

/** 固定值能否当作该类型使用；不能时返回说明。 */
export function literalProblem(value: string | number | boolean, expected: ValueType): string | undefined {
  const label = typeLabel(expected);
  if (expected.kind === 'list' || expected.kind === 'ref') return `${label}不能写成固定值`;
  if (!checkParameterValue({ type: expected.kind, constraints: {} }, value).problem) return undefined;
  const expectedLabel = expected.kind === 'boolean' ? '布尔值' : expected.kind === 'color' ? '颜色（#RRGGBB 或 #RRGGBBAA）' : label;
  return `固定值 ${JSON.stringify(value)} 不是${expectedLabel}`;
}

/** 状态样式的取值：布尔为 true、false，数值为最短的十进制写法，其余为文字本身（M90 S5）。 */
export function stateKey(value: string | number | boolean): string {
  return typeof value === 'number' ? plainNumber(value) : String(value);
}
