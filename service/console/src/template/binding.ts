/**
 * 值格背后的规则（模板设计页票据 09，方案第 7 节）：作用域里有哪些变量、哪些能绑到这一格、断开时写什么、提取为参数、值从哪来。
 * 纯函数，不碰页面与接口。绑定就是把值写成 { var }（M71），写回走 properties.ts 的同一个入口；取值都来自元素求值，这里不求值。
 */
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import type { ElementInspection, InspectedValue, ParameterOrigin, StaticSchemaDetail } from '../types.js';
import { isObject, type JsonObject } from './document.js';
import { matchesSchema, writeProperty, type Bindable, type BindingType, type FieldPath, type PropertyField } from './properties.js';

export type ScopeVariableKind = 'field' | 'parameter' | 'derived';
export interface ScopeVariable {
  /** 写进 { var } 的名称；引用的字段带一层路径，如 terminal.name。 */
  readonly name: string;
  readonly label: string;
  readonly kind: ScopeVariableKind;
  readonly type: string;
  readonly value?: InspectedValue;
  readonly origin?: ParameterOrigin;
  /** 列表每一项的类型；是引用时 itemRef 写明数据定义（派生变量的取项按它推结果类型）。 */
  readonly itemType?: string;
  readonly itemRef?: { readonly name: string; readonly version: number };
}

/** 数据定义里的一个字段。object 是单引用，fields 是它的下一层（路径只经过单引用，M21）。 */
export interface BaseField {
  readonly name: string; readonly label: string; readonly type: string; readonly fields?: readonly BaseField[];
  readonly itemType?: string; readonly itemRef?: { readonly name: string; readonly version: number };
}

/** 静态数据定义的字段：类型取编译产物，列表的项另从数据定义文档读（编译产物里引用已内联，读不出指向哪个数据定义）。 */
export function baseFieldsOf(detail: StaticSchemaDetail | undefined): readonly BaseField[] {
  if (!detail) return [];
  const items = new Map((detail.definition?.fields ?? []).filter((field) => field.type === 'list' && field.items).map((field) => [field.name, field.items!]));
  return formOf(detail.compiled as FormObject).fields.map((field) => {
    const item = items.get(field.name);
    return {
      name: field.name, label: field.spec.title || field.name, type: field.spec.kind === 'object' ? 'ref' : field.spec.kind,
      ...(field.spec.kind === 'object' ? { fields: field.spec.fields.map((inner) => ({ name: inner.name, label: inner.spec.title || inner.name, type: inner.spec.kind })) } : {}),
      ...(item ? { itemType: item.type, ...(item.ref ? { itemRef: { name: item.ref.name, version: Number(item.ref.version) } } : {}) } : {}),
    };
  });
}

const namedList = (document: JsonObject, list: string): readonly JsonObject[] => (Array.isArray(document[list]) ? (document[list] as unknown[]).filter(isObject) : []);

/**
 * 这个模板作用域里的全部变量。名单以文档为准（刚提取的参数不用等下一次求值），取值来自元素求值；
 * inspection 不是这个模板的（还没问到）时只是没有取值。
 */
export function scopeVariables(document: JsonObject, fields: readonly BaseField[], inspection: ElementInspection | undefined): readonly ScopeVariable[] {
  const known = new Map((inspection?.variables ?? []).map((item) => [item.name, item]));
  const entry = (name: string, label: string, kind: ScopeVariableKind, declared: string): ScopeVariable => {
    const found = known.get(name);
    return { name, label, kind, type: found?.type ?? declared, ...(found ? { value: found.value } : {}), ...(found?.origin ? { origin: found.origin } : {}) };
  };
  // 内置的单值数据定义没有静态版本，字段名单只能从求值结果来。
  const base = fields.length > 0 ? fields : [...known.values()].filter((item) => item.kind === 'field').map((item): BaseField => ({ name: item.name, label: item.displayName, type: item.type }));
  const fieldRows = base.flatMap((field) => {
    const parent = known.get(field.name)?.value, inner = isObject(parent) && 'fields' in parent ? parent.fields as Readonly<Record<string, unknown>> : undefined;
    return [
      { ...entry(field.name, field.label, 'field', field.type), ...(field.itemType ? { itemType: field.itemType } : {}), ...(field.itemRef ? { itemRef: field.itemRef } : {}) },
      ...(field.fields ?? []).map((child): ScopeVariable => {
        const value = inner?.[child.name];
        return { name: `${field.name}.${child.name}`, label: `${field.label} · ${child.label}`, kind: 'field', type: child.type, ...(value === undefined || typeof value === 'object' ? {} : { value: value as InspectedValue }) };
      }),
    ];
  });
  const declared = (list: string, kind: ScopeVariableKind) => namedList(document, list).map((item) => entry(String(item['name']), String(item['displayName'] ?? item['name']), kind, String(item['type'])));
  return [...fieldRows, ...declared('parameters', 'parameter'), ...declared('derived', 'derived')];
}

/** 能绑到这一格的变量：类型完全相符才列，模板静态检查也是这么判断的（M71）。 */
export const bindingCandidates = (variables: readonly ScopeVariable[], type: BindingType): readonly ScopeVariable[] => variables.filter((item) => item.type === type);

export const boundName = (value: unknown): string | undefined => (isObject(value) && typeof value['var'] === 'string' ? value['var'] : undefined);

const opaque = (value: unknown) => (typeof value === 'string' && /^#[0-9A-Fa-f]{6}[Ff]{2}$/.test(value) ? value.slice(0, 7) : value);

/** 断开绑定时写什么：当前值合这种字面值就留下它（图不变），否则（空值、URL 图片）用初值。 */
export function unboundValue(bindable: Bindable, current: unknown): unknown {
  const value = opaque(current);
  return value !== undefined && value !== null && matchesSchema(bindable.schema, value) ? value : bindable.initial;
}

const PLACEHOLDER_REF = 'res:';

/**
 * 这一格现在的值能不能存成参数的缺省值。绑定着的取当前样例的值，没写的取缺省；
 * 写成对象（分别设置）或还没选图时没有单个的值，是 undefined，页面把提取关掉。
 */
export function currentLiteral(field: PropertyField, bindable: Bindable, current: unknown): unknown {
  const value = boundName(field.value) !== undefined
    ? unboundValue(bindable, current)
    : field.value === undefined ? field.fallback ?? bindable.initial
    : matchesSchema(bindable.schema, field.value) ? field.value : undefined;
  return value === PLACEHOLDER_REF ? undefined : value;
}

const lastString = (path: FieldPath) => [...path].reverse().find((part): part is string => typeof part === 'string' && part !== 'fixed' && part !== 'value') ?? 'value';

/** 变量共用一个命名空间（S3）：字段、参数、派生都不能同名。 */
export function takenNames(document: JsonObject, variables: readonly ScopeVariable[]): ReadonlySet<string> {
  return new Set([...variables.map((item) => item.name), ...namedList(document, 'parameters').map((item) => String(item['name'])), ...namedList(document, 'derived').map((item) => String(item['name']))]);
}

/** 提取时给的名字：名称沿用属性的英文键（M89），显示名称是"元素 + 属性"，都能改。 */
export function suggestParameter(document: JsonObject, variables: readonly ScopeVariable[], elementName: string, field: PropertyField): { readonly name: string; readonly displayName: string } {
  const taken = takenNames(document, variables), base = lastString(field.path);
  let name = base;
  for (let index = 2; taken.has(name); index++) name = `${base}${index}`;
  return { name, displayName: `${elementName}${field.label.replace(/（.*）$/u, '')}` };
}

/** 名称不合法或重名时的说明；合法时是 undefined。结果最后仍由 checkDslDocument 判断。 */
export function parameterNameProblem(name: string, taken: ReadonlySet<string>): string | undefined {
  if (name === '') return '要起个名称';
  if (name.includes('.')) return '名称不能带点：点是路径';
  return taken.has(name) ? '这个作用域里已经有这个名称' : undefined;
}

export interface ExtractedParameter { readonly name: string; readonly displayName: string; readonly type: BindingType; readonly value: unknown }

/** 提取为参数（M208）：把当前值存成内部参数的缺省值，并把这一格绑定它。一次写回，所以一步撤销。 */
export function extractParameter(document: JsonObject, path: string, fieldPath: FieldPath, parameter: ExtractedParameter): JsonObject {
  const { name, displayName, type, value } = parameter;
  const withParameter: JsonObject = { ...document, parameters: [...namedList(document, 'parameters'), { name, displayName, visibility: 'internal', type, default: value }] };
  return writeProperty(withParameter, path, fieldPath, { var: name });
}

const LOOP_LABELS: Readonly<Record<string, string>> = { index: '循环序号', isFirst: '是否第一项', isLast: '是否最后一项', count: '循环总项数', groupSize: '合并的项数' };

export interface OriginLink { readonly template: string; readonly name: string; readonly kind: ScopeVariableKind; readonly label: string }
export interface OriginText { readonly before: string; readonly link?: OriginLink; readonly after: string }

const callName = (call: string) => (call.split('/').at(-1) ?? call).replace(/\[\d+\]$/u, '');

/**
 * 来源链：作用域不继承的代价由这一行抵消（方案第 7 节）。参数经调用一层层传进来，真正的值在哪由引擎追到（ParameterOrigin），
 * 这里只负责说成人话，并给出能跳过去的那一处。
 */
export function describeOrigin(origin: ParameterOrigin, template: string, documentOf: (template: string) => JsonObject | undefined): OriginText {
  const where = origin.template === template ? '本模板' : origin.template;
  const displayName = (name: string) => {
    const found = namedList(documentOf(origin.template) ?? {}, 'parameters').find((item) => item['name'] === name);
    return typeof found?.['displayName'] === 'string' ? found['displayName'] : name;
  };
  switch (origin.kind) {
    case 'request': return { before: '来自 ', link: { template: origin.template, name: origin.name, kind: 'parameter', label: `${where}「${displayName(origin.name)}」` }, after: '（对外参数，出图时由渲染请求给值）' };
    case 'default': return { before: '来自 ', link: { template: origin.template, name: origin.name, kind: 'parameter', label: `${where}「${displayName(origin.name)}」` }, after: origin.visibility === 'internal' ? '（内部参数）' : '（对外参数的缺省值）' };
    case 'field': return { before: '来自 ', link: { template: origin.template, name: origin.name.split('.')[0]!, kind: 'field', label: `${where}的字段 ${origin.name}` }, after: `（调用 ${callName(origin.call)} 传入）` };
    case 'derived': return { before: '来自 ', link: { template: origin.template, name: origin.name, kind: 'derived', label: `${where}的派生变量 ${origin.name}` }, after: `（调用 ${callName(origin.call)} 传入）` };
    case 'value': return { before: `调用 ${callName(origin.call)} 写的固定值`, after: '' };
    case 'loop': return { before: `${LOOP_LABELS[origin.loop] ?? origin.loop}，由循环 ${callName(origin.call)} 传入`, after: '' };
  }
}
