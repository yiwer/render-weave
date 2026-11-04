/**
 * 数据定义文档的纯函数（P1 票据 06，docs/dsl/data-definition.md）：字段表显示什么、改类型时留下什么、问题落在哪个字段。
 * 页面只改字段这一层，文档里别的键与字段上不认识的键原样带回；校验一律以服务端的问题清单为准（M351），这里不判断对错。
 */
import type { DefinitionField, DefinitionItems, DefinitionProperty, FieldType, Problem, SchemaRef } from '../types.js';

export const FIELD_TYPES: readonly { readonly type: FieldType; readonly label: string }[] = [
  { type: 'text', label: '文本' }, { type: 'number', label: '数值' }, { type: 'date', label: '日期' }, { type: 'time', label: '时刻' }, { type: 'datetime', label: '时间' },
  { type: 'boolean', label: '布尔' }, { type: 'image', label: '图片' }, { type: 'list', label: '列表' }, { type: 'ref', label: '数据定义引用' },
];
/** 列表的元素不能又是列表（M33）。 */
export const ITEM_TYPES = FIELD_TYPES.filter(({ type }) => type !== 'list');

const typeLabel = (type: string) => FIELD_TYPES.find((item) => item.type === type)?.label ?? type;
const refText = (ref: SchemaRef | undefined) => (ref ? `${ref.name} v${ref.version}` : '没选');

/** 类型一列：列表写元素类型，引用写被引用的版本。 */
export function typeText(field: Pick<DefinitionField, 'type' | 'items' | 'ref'>): string {
  if (field.type === 'list') return `${typeLabel('list')} · ${field.items ? typeText(field.items) : '没选元素类型'}`;
  if (field.type === 'ref') return `${typeLabel('ref')} · ${refText(field.ref)}`;
  return typeLabel(field.type);
}

const IMAGE_SOURCES: Readonly<Record<string, string>> = { resource: '资源仓库', url: '网址' };

function rangeText(min: unknown, max: unknown, unit: string, atLeast: string, atMost: string): string | undefined {
  if (min !== undefined && max !== undefined) return `${String(min)}–${String(max)}${unit && ` ${unit}`}`;
  if (max !== undefined) return `${atMost} ${String(max)}${unit && ` ${unit}`}`;
  return min !== undefined ? `${atLeast} ${String(min)}${unit && ` ${unit}`}` : undefined;
}

function enumText(values: unknown): string | undefined {
  if (!Array.isArray(values)) return undefined;
  return `可选 ${values.slice(0, 3).join('、')}${values.length > 3 ? ` 等 ${values.length} 项` : ''}`;
}

/** 约束一列：给人看的一句话，没有约束时是空的。 */
export function constraintText(field: Pick<DefinitionField, 'type' | 'constraints' | 'items'>): string {
  const c = field.constraints ?? {}, parts: (string | undefined)[] = [];
  switch (field.type) {
    case 'text':
      parts.push(rangeText(c['minLength'], c['maxLength'], '字', '至少', '最多'), c['pattern'] ? '有正则' : undefined, enumText(c['enum']));
      break;
    case 'number':
      parts.push(rangeText(c['min'], c['max'], '', '不小于', '不大于'), c['integer'] === true ? '整数' : undefined, enumText(c['enum']));
      break;
    case 'image':
      parts.push(Array.isArray(c['allowedSources']) ? (c['allowedSources'] as string[]).map((source) => IMAGE_SOURCES[source] ?? source).join('、') : '资源仓库或网址');
      break;
    case 'list':
      parts.push(rangeText(c['minItems'], c['maxItems'], '项', '至少', '最多'), field.items ? constraintText(field.items) || undefined : undefined);
      break;
    default:
  }
  return parts.filter(Boolean).join('，');
}

export const isRequired = (field: Pick<DefinitionField, 'constraints'>) => field.constraints?.['required'] === true;

/** 改一条约束：undefined 与 required 的 false 都是去掉这条，约束空了就去掉 constraints（DSL 不写 null，M223）。 */
export function withConstraint<T extends { readonly constraints?: Readonly<Record<string, unknown>> }>(owner: T, key: string, value: unknown): T {
  const { constraints: _old, ...rest } = owner;
  const next = { ...owner.constraints };
  if (value === undefined || (key === 'required' && value === false)) delete next[key];
  else next[key] = value;
  return (Object.keys(next).length ? { ...rest, constraints: next } : rest) as T;
}

/** 换元素类型：约束随类型定，换了就不留。 */
export function itemsOfType(type: FieldType, ref: SchemaRef | undefined): DefinitionItems {
  return { type, ...(type === 'ref' && ref ? { ref } : {}) };
}

/** 换字段类型：只留名称、说明与必填；原类型的约束、元素与引用不留，新类型要的给缺省（M33：列表缺省是文本列表）。 */
export function withType(field: DefinitionField, type: FieldType, ref: SchemaRef | undefined): DefinitionField {
  const { constraints: _constraints, items: _items, ref: _ref, ...rest } = field;
  return {
    ...rest, type, ...(isRequired(field) ? { constraints: { required: true } } : {}),
    ...(type === 'list' ? { items: { type: 'text' } } : {}), ...(type === 'ref' && ref ? { ref } : {}),
  };
}

export const NEW_FIELD: DefinitionField = { name: '', displayName: '', type: 'text' };

/** 规范化 JSON：键排序，required 的 false 与不写相同，与 diffDefinition 的比较一致；只用来标"已修改"，以服务端的差异为准。 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const entries = Object.entries(item).filter(([key, part]) => !(key === 'required' && part === false)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  });
}

/** 这个字段与基于的版本相比：新增、修改，或没变。 */
export function fieldChange(field: DefinitionField, base: readonly DefinitionField[] | undefined): 'added' | 'changed' | undefined {
  if (!base) return undefined;
  const same = base.find((candidate) => candidate.name === field.name);
  if (!same) return 'added';
  return canonical(same) === canonical(field) ? undefined : 'changed';
}

/**
 * 校验问题落在哪一行：位置是"字段名称"或"字段名称.constraints"，名称写错时是"fields[序号]"（从 1 数）。
 * 字段名称重复时落在后一个，通常是刚加的那行；落不到字段上的放在 general。
 */
export function problemsByField(problems: readonly Problem[], fields: readonly DefinitionField[]): { readonly byIndex: ReadonlyMap<number, readonly Problem[]>; readonly general: readonly Problem[] } {
  const byIndex = new Map<number, Problem[]>(), general: Problem[] = [];
  for (const problem of problems) {
    const path = problem.location.kind === 'definition' ? problem.location.path : '';
    const numbered = /^fields\[(\d+)\]/.exec(path), head = path.split('.')[0]!;
    let index = numbered ? Number(numbered[1]) - 1 : -1;
    if (!numbered && head) for (let at = fields.length - 1; at >= 0 && index < 0; at--) if (fields[at]!.name === head) index = at;
    if (index >= 0 && index < fields.length) byIndex.set(index, [...(byIndex.get(index) ?? []), problem]);
    else general.push(problem);
  }
  return { byIndex, general };
}

const CONSTRAINT_LABELS: Readonly<Record<string, string>> = {
  required: '必填', minLength: '最短', maxLength: '最长', pattern: '正则', enum: '可选值', min: '下限', max: '上限', integer: '整数', allowedSources: '图片来源', minItems: '最少项数', maxItems: '最多项数',
};

/** diffDefinition 的属性键写成给人看的说法：constraints.maxLength 是"最长"，items.type 是"元素类型"。 */
function propertyLabel(key: string): string {
  if (key === 'displayName') return '显示名称';
  if (key === 'description') return '说明';
  if (key === 'name') return '名称';
  if (key === 'type') return '类型';
  if (key === 'ref.name') return '引用的名称';
  if (key === 'ref.version') return '引用的版本';
  if (key.startsWith('items.')) return `元素的${propertyLabel(key.slice('items.'.length))}`;
  const last = key.split('.').at(-1)!;
  return CONSTRAINT_LABELS[last] ?? key;
}

function propertyValue(key: string, value: unknown): string {
  if (value === undefined) return '没有';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (key.endsWith('type') && typeof value === 'string') return typeLabel(value);
  return Array.isArray(value) ? value.join('、') : String(value);
}

/** 一条属性改动，如"最长 10 → 100"。 */
export const propertyText = (property: DefinitionProperty) =>
  `${propertyLabel(property.key)} ${propertyValue(property.key, property.before)} → ${propertyValue(property.key, property.after)}`;
