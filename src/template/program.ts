/** 收集并检查根模板可达的全部调用（包括隐藏元素与状态分支），在求值前阻止无法展开的调用图。 */
import { formatElementPath } from '../element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { findStaticSchema } from '../schema/builtins.js';
import { formatStaticSchemaRef, sameStaticSchema, type StaticSchemaRef, type Workspace } from '../workspace.js';
import { checkTemplate, literalProblem, type VariableTable } from './check.js';
import type { CallArgument, CallModel, LoopModel, TemplateModel } from './model.js';
import { parseTemplate } from './parse.js';
import { kindLabel, typeLabel, type BasicKind } from './types.js';

export interface PreparedTemplate {
  readonly template: TemplateModel;
  readonly table: VariableTable;
}
export type TemplateProgram = ReadonlyMap<string, PreparedTemplate>;

export function prepareTemplates(workspace: Workspace, root: TemplateModel, compiled: Record<string, unknown>): {
  program: TemplateProgram; problems: Problem[]; blocked: boolean;
} {
  const program = new Map<string, PreparedTemplate>();
  const problems: Problem[] = [];
  const visiting: string[] = [];
  let blocked = false;
  const report = (call: LoopModel | CallModel, code: ProblemCode, message: string, blocks = false) => {
    problems.push(severe(code, { kind: 'element', path: formatElementPath(call.path) }, message));
    blocked ||= blocks;
  };
  const visit = (template: TemplateModel, schema: Record<string, unknown>) => {
    const checked = checkTemplate(template, schema);
    problems.push(...checked.problems);
    program.set(template.name, { template, table: checked.table });
    visiting.push(template.name);
    for (const call of template.calls) {
      let target = program.get(call.template)?.template;
      if (!target) {
        const entry = workspace.templates.find((entry) => entry.name === call.template);
        if (!entry) {
          report(call, ProblemCodes.templateNotFound, `工作区中没有被调模板“${call.template}”`, true);
          continue;
        }
        const parsed = parseTemplate(entry.name, entry.document);
        problems.push(...parsed.problems);
        target = parsed.model;
        if (!target) { blocked = true; continue; }
      }
      const source = callSourceType(call, template, checked.table);
      if ('message' in source) report(call, source.code, source.message, true);
      else if (!sameStaticSchema(source.ref, target.base)) {
        report(call, call.type === 'loop' ? ProblemCodes.templateLoopBaseMismatch : ProblemCodes.templateCallBaseMismatch,
          `调用数据为“${formatStaticSchemaRef(source.ref)}”，模板“${target.name}”的基准为“${formatStaticSchemaRef(target.base)}”`, true);
      }
      for (const [name, argument] of Object.entries(call.args)) {
        const parameter = target.parameters.find((parameter) => parameter.name === name);
        if (!parameter) report(call, ProblemCodes.parameterUnknown, `模板“${target.name}”没有对外参数 ${name}`);
        else if (parameter.visibility === 'internal') report(call, ProblemCodes.parameterInternal, `模板“${target.name}”的 ${name} 是内部参数，不能填写`);
        else {
          const issue = argumentProblem(argument, parameter.type, checked.table);
          if (issue) report(call, ProblemCodes.templateTypeMismatch, `参数 ${name}：${issue}`);
        }
      }
      for (const parameter of target.parameters) {
        if (parameter.visibility === 'public' && parameter.default === undefined && !Object.hasOwn(call.args, parameter.name)) {
          report(call, ProblemCodes.parameterMissing, `模板“${target.name}”的对外参数 ${parameter.name} 没有缺省值，必须填写`);
        }
      }
      if (visiting.includes(target.name)) {
        report(call, ProblemCodes.templateCallCycle, `模板调用成环：${[...visiting.slice(visiting.indexOf(target.name)), target.name].join(' → ')}`, true);
        continue;
      }
      if (program.has(target.name)) continue;
      const targetSchema = findStaticSchema(workspace, target.base);
      if (!targetSchema?.compiled) {
        report(call, targetSchema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound,
          `被调模板“${target.name}”的基准“${formatStaticSchemaRef(target.base)}”没有可用的编译产物`, true);
        continue;
      }
      visit(target, targetSchema.compiled);
    }
    visiting.pop();
  };
  visit(root, compiled);
  const seen = new Set<string>();
  return { program, problems: problems.filter((problem) => {
    const key = JSON.stringify(problem);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }), blocked };
}

function callSourceType(call: LoopModel | CallModel, template: TemplateModel, table: VariableTable):
  { ref: StaticSchemaRef } | { code: ProblemCode; message: string } {
  if (call.type === 'call' && call.data === 'current') return { ref: template.base };
  if (call.type === 'call' && call.data === 'none') return { ref: { name: '空数据定义', version: 1 } };
  const path = call.type === 'loop' ? call.list.var : (call.data as { var: string }).var;
  const resolved = table.typeOf(path);
  if (!('type' in resolved)) return resolved;
  if (table.get(path.split('.')[0]!)?.source !== 'field') {
    return { code: ProblemCodes.templateTypeMismatch, message: `调用数据 ${path} 必须来自数据字段` };
  }
  const type = resolved.type;
  if (call.type === 'call' && type.kind === 'ref' && type.ref) return { ref: type.ref };
  if (call.type === 'loop' && type.kind === 'list') {
    if (type.items.kind === 'ref' && type.items.ref) return { ref: type.items.ref };
    if (type.items.kind !== 'ref' && type.items.kind !== 'list' && type.items.kind !== 'color') {
      return { ref: { name: `单值·${kindLabel(type.items.kind)}`, version: 1 } };
    }
  }
  return { code: ProblemCodes.templateTypeMismatch, message: `${path} 是${typeLabel(type)}，${call.type === 'loop' ? '循环需要列表字段' : '子模板数据需要单引用字段'}` };
}

/** 静态参数错误在调用声明处报告；求值时同样使用此规则，避免把类型错误的变量值传入。 */
export function argumentProblem(argument: CallArgument, expected: BasicKind, table: VariableTable): string | undefined {
  if ('value' in argument) return literalProblem(argument.value, { kind: expected });
  if ('loop' in argument) {
    const kind = argument.loop === 'isFirst' || argument.loop === 'isLast' ? 'boolean' : 'number';
    return kind === expected ? undefined : `循环信息 ${argument.loop} 是${kindLabel(kind)}，需要${kindLabel(expected)}`;
  }
  const actual = table.typeOf(argument.var);
  if (!('type' in actual)) return actual.message;
  return actual.type.kind === expected ? undefined : `${argument.var} 是${typeLabel(actual.type)}，需要${kindLabel(expected)}`;
}
