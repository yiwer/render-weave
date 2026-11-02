/**
 * 模板读到了哪些字段（阶段 5 P1 票据 04）：出图服务在数据定义草案删字段、改字段名称时，列出用到它们的模板。
 *
 * 读的是模板静态检查用的同一份模型：绑定、插槽与状态样式（`uses`），派生变量与检查项的运算数，调用的数据与实参。
 * 路径沿单引用往下走，`nextStop.landmark` 记在 nextStop 声明的静态数据定义上；循环的 `mergeBy` 按列表元素的数据定义读。
 * 只算模板自己的读取：子模板各有基准数据定义，各算各的（ADR-0007）。
 */
import { ProblemCodes, severe, type Problem } from '../problems.js';
import type { ValueModel, DefinitionModel } from '../schema/model.js';
import { parseDefinition } from '../schema/parse.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, type StaticSchemaEntry, type StaticSchemaRef } from '../workspace.js';
import { comparisonsOf, type CallArgument, type DerivedModel, type ItemPosition, type Operand } from './model.js';
import { parseTemplate } from './parse.js';

export interface TemplateFieldUse {
  /** 字段所在的静态数据定义：模板的基准，或路径经过的引用指向的那一份。 */
  readonly schema: StaticSchemaRef;
  readonly field: string;
}

/** 读一份模板文档；读不了时没有字段，问题清单说明原因。staticSchemas 用来沿引用往下走，缺的那一份走到它为止。 */
export function templateFieldUses(document: unknown, staticSchemas: readonly StaticSchemaEntry[]): { uses: readonly TemplateFieldUse[]; problems: Problem[] } {
  const name = isRecord(document) ? document['name'] : undefined;
  if (typeof name !== 'string' || name === '') {
    return { uses: [], problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: 'template' }, '模板缺少名称')] };
  }
  const { model, problems } = parseTemplate(name, document);
  if (!model) return { uses: [], problems };

  const found = new Map<string, TemplateFieldUse>();
  const definitionOf = definitionLookup(staticSchemas);
  const parameters = new Set(model.parameters.map((parameter) => parameter.name));
  const derived = new Map(model.derived.map((variable) => [variable.name, variable]));

  /** 从一份数据定义沿路径往下走，记下经过的每个字段；答最后一个字段的取值。 */
  const walk = (schema: StaticSchemaRef, path: readonly string[]): ValueModel | undefined => {
    let current = schema, value: ValueModel | undefined;
    for (const field of path) {
      found.set(`${formatStaticSchemaRef(current)}\u0000${field}`, { schema: current, field });
      value = definitionOf(current)?.fields.find((candidate) => candidate.name === field)?.value;
      if (value?.type === 'ref') current = value.ref;
      else if (field !== path.at(-1)) return undefined;
    }
    return value;
  };
  /** 一处变量引用：路径开头是参数时不读字段，是派生变量时从它声明的引用往下走，其余是基准数据定义的字段。 */
  const read = (path: string): ValueModel | undefined => {
    const [head = '', ...rest] = path.split('.');
    if (parameters.has(head)) return undefined;
    const variable = derived.get(head);
    if (!variable) return walk(model.base, [head, ...rest]);
    return variable.ref && rest.length > 0 ? walk(variable.ref, rest) : undefined;
  };
  const operand = (value: Operand | CallArgument) => { if ('var' in value) read(value.var); };
  const position = (value: ItemPosition) => { if (typeof value === 'object') operand(value.index); };

  for (const use of model.uses) read(use.var);
  for (const variable of model.derived) readOperation(variable, operand, position);
  for (const check of model.checks) operand(check.problemWhen);
  for (const call of model.calls) {
    Object.values(call.args).forEach(operand);
    if (call.type === 'call') {
      if (typeof call.data === 'object') read(call.data.var);
      continue;
    }
    const list = read(call.list.var);
    if (call.mergeBy && list?.type === 'list' && list.items.type === 'ref') walk(list.items.ref, call.mergeBy.split('.'));
  }
  return { uses: [...found.values()], problems };
}

function readOperation(variable: DerivedModel, operand: (value: Operand) => void, position: (value: ItemPosition) => void): void {
  const operation = variable.operation;
  switch (operation.op) {
    case 'branch':
      for (const branch of operation.branches) {
        for (const comparison of comparisonsOf(branch.when)) {
          operand(comparison.left);
          if (comparison.right) operand(comparison.right);
        }
        operand(branch.then);
      }
      operand(operation.otherwise);
      return;
    case 'pickItem':
      operand(operation.list);
      position(operation.position);
      return;
    case 'splitPart':
      operand(operation.of);
      if (typeof operation.delimiter === 'object') operand(operation.delimiter);
      position(operation.position);
      return;
    case 'length':
      operand(operation.of);
      return;
    default:
      operand(operation.left);
      operand(operation.right);
  }
}

/** 按引用取数据定义的模型，每份只解析一次；没有原文或读不了的答 undefined。 */
function definitionLookup(staticSchemas: readonly StaticSchemaEntry[]): (ref: StaticSchemaRef) => DefinitionModel | undefined {
  const models = new Map<string, DefinitionModel | undefined>();
  return (ref) => {
    const key = formatStaticSchemaRef(ref);
    if (!models.has(key)) {
      const entry = staticSchemas.find((candidate) => formatStaticSchemaRef(candidate.ref) === key);
      models.set(key, entry?.definition === undefined ? undefined : parseDefinition(entry.definition).model);
    }
    return models.get(key);
  };
}
