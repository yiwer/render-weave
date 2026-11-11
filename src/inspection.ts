/**
 * 元素实例的求值结果（模板设计页票据 02）：模板设计页要显示变量的当前值、命中的分支、每个实例的状态与参数的来源，
 * 这些只有引擎知道，页面不再实现一遍求值。展开时记下每个实例的作用域，展开完按元素路径回答；不改变图片、问题与布局摘要。
 */
import { isRecord } from './util.js';
import { stateKey, type VariableTable } from './template/check.js';
import type { LoopInfoKey } from './template/model.js';
import type { Scope } from './template/scope.js';

/** 变量取值的摘要：基本类型原样，列表只给项数，引用只给一层字段，文本超长时截断。 */
export type InspectedValue = string | number | boolean | null | { readonly list: number } | { readonly fields: Readonly<Record<string, string | number | boolean | null | { readonly list: number } | { readonly nested: true }>> };

/** 参数的值最终从哪来：沿调用链追到不是对外参数的那一层。 */
export type ParameterOrigin =
  | { readonly kind: 'request'; readonly template: string; readonly name: string }
  | { readonly kind: 'default'; readonly template: string; readonly name: string; readonly visibility: 'public' | 'internal' }
  | { readonly kind: 'field' | 'derived'; readonly template: string; readonly name: string; readonly call: string }
  | { readonly kind: 'value'; readonly template: string; readonly call: string }
  | { readonly kind: 'loop'; readonly template: string; readonly loop: LoopInfoKey; readonly call: string };

export interface InspectedVariable {
  readonly name: string;
  readonly displayName: string;
  readonly kind: 'field' | 'parameter' | 'derived';
  /** 字段类型或参数类型，如 text、number、list、ref。 */
  readonly type: string;
  readonly value: InspectedValue;
  /** 条件分支命中第几支，从 0 开始；-1 是"否则"。 */
  readonly branch?: number;
  readonly origin?: ParameterOrigin;
}

export interface ElementInspection {
  /** 问的元素实例。 */
  readonly path: string;
  /** 它所在的作用域：定义它的模板与它在模板文档里的路径。 */
  readonly template: string;
  readonly source: string;
  readonly variables: readonly InspectedVariable[];
  readonly checks: readonly { readonly name: string; readonly level: 'severe' | 'hint'; readonly failed: boolean }[];
  /** 这个定义的全部实例；隐藏的容器里的元素不展开，不在其中。元素有状态样式时带这个实例的取值。 */
  readonly instances: readonly { readonly path: string; readonly visible: boolean; readonly state?: string }[];
  /** 元素有状态样式时：按哪个变量，以及能确定的全部取值。 */
  readonly states?: { readonly by: string; readonly known?: readonly string[] };
}

interface ElementRecord { readonly path: string; readonly source: { readonly template: string; readonly path: string }; readonly scope: Scope; readonly visible: boolean }
interface CallRecord { readonly caller: Scope; readonly path: string; readonly args: Readonly<Record<string, unknown>> }

export interface ExpansionObserver {
  element(path: string, source: { readonly template: string; readonly path: string }, scope: Scope, visible: boolean): void;
  called(scope: Scope, caller: Scope, path: string, args: Readonly<Record<string, unknown>>): void;
}

const TEXT_LIMIT = 500;
const primitive = (value: unknown): string | number | boolean | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}…` : value;
  return typeof value === 'number' || typeof value === 'boolean' ? value : undefined;
};
function summarize(value: unknown): InspectedValue {
  const simple = primitive(value);
  if (simple !== undefined) return simple;
  if (Array.isArray(value)) return { list: value.length };
  if (!isRecord(value)) return null;
  const fields: Record<string, string | number | boolean | null | { readonly list: number } | { readonly nested: true }> = {};
  for (const [key, item] of Object.entries(value)) fields[key] = primitive(item) ?? (Array.isArray(item) ? { list: item.length } : { nested: true });
  return { fields };
}

/** 模板文档里元素的状态样式变量：model 求值时已经合并掉了，所以读原文档。路径第一段是模板名。 */
export type StateVariableOf = (template: string, path: string) => string | undefined;

export function createInspector(target: string, requested: Readonly<Record<string, unknown>>, stateVariableOf: StateVariableOf): { readonly observer: ExpansionObserver; result(): ElementInspection | undefined } {
  const elements: ElementRecord[] = [];
  const calls = new Map<Scope, CallRecord>();
  const originOf = (scope: Scope, name: string): ParameterOrigin => {
    const template = scope.template.name, parameter = scope.template.parameters.find((item) => item.name === name);
    if (parameter?.visibility === 'internal') return { kind: 'default', template, name, visibility: 'internal' };
    const call = calls.get(scope);
    if (!call) return Object.hasOwn(requested, name) ? { kind: 'request', template, name } : { kind: 'default', template, name, visibility: 'public' };
    const argument = call.args[name] as { readonly var?: string; readonly loop?: LoopInfoKey } | undefined;
    if (!argument) return { kind: 'default', template, name, visibility: 'public' };
    const callerName = call.caller.template.name;
    if (argument.loop !== undefined) return { kind: 'loop', template: callerName, loop: argument.loop, call: call.path };
    if (argument.var === undefined) return { kind: 'value', template: callerName, call: call.path };
    const head = argument.var.split('.')[0]!, source = call.caller.table.get(head)?.source;
    if (source === 'parameter') return originOf(call.caller, head);
    return { kind: source === 'derived' ? 'derived' : 'field', template: callerName, name: argument.var, call: call.path };
  };
  const variables = (scope: Scope, table: VariableTable): InspectedVariable[] => table.names().flatMap((name): InspectedVariable[] => {
    const variable = table.get(name);
    if (!variable) return [];
    const branch = variable.source === 'derived' ? scope.branchHit(name) : undefined;
    return [{
      name, displayName: variable.displayName, kind: variable.source, type: variable.type.kind, value: summarize(scope.value(name)),
      ...(branch === undefined ? {} : { branch }),
      ...(variable.source === 'parameter' ? { origin: originOf(scope, name) } : {}),
    }];
  });
  return {
    observer: {
      element: (path, source, scope, visible) => { elements.push({ path, source, scope, visible }); },
      called: (scope, caller, path, args) => { calls.set(scope, { caller, path, args }); },
    },
    result() {
      const found = elements.find((element) => element.path === target);
      if (!found) return undefined;
      const { scope, source } = found, by = stateVariableOf(source.template, source.path), known = by === undefined ? undefined : scope.table.knownValues(by);
      return {
        path: found.path, template: source.template, source: source.path,
        variables: variables(scope, scope.table),
        checks: scope.template.checks.map((check) => ({ name: check.name, level: check.level, failed: scope.checkFailed(check) })),
        instances: elements.filter((element) => element.source.template === source.template && element.source.path === source.path).map((element) => {
          const state = by === undefined ? undefined : element.scope.value(by);
          return { path: element.path, visible: element.visible, ...(typeof state === 'string' || typeof state === 'number' || typeof state === 'boolean' ? { state: stateKey(state) } : {}) };
        }),
        ...(by === undefined ? {} : { states: { by, ...(known ? { known } : {}) } }),
      };
    },
  };
}

/** 从模板文档读元素的状态样式变量。 */
export function stateVariableReader(templates: readonly { readonly name: string; readonly document: unknown }[]): StateVariableOf {
  return (template, path) => {
    const document = templates.find((candidate) => candidate.name === template)?.document;
    if (!isRecord(document) || !isRecord(document['artboard'])) return undefined;
    let element: Record<string, unknown> = document['artboard'];
    for (const name of path.split('/').slice(1)) {
      const children: unknown = element['children'];
      const child: unknown = Array.isArray(children) ? children.find((item) => isRecord(item) && item['name'] === name) : undefined;
      if (!isRecord(child)) return undefined;
      element = child;
    }
    const states = element['states'];
    const by = isRecord(states) && isRecord(states['by']) ? states['by']['var'] : undefined;
    return typeof by === 'string' ? by : undefined;
  };
}
