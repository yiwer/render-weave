/**
 * 模板变量的类型：数据字段的类型来自编译产物，参数与派生变量的类型由模板声明。
 * 静态检查用它核对绑定、插槽与派生变量的运算数；求值用它决定取值的比较与输出方式。
 */
import type { DisplayKind } from '../display-format.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, parseStaticSchemaRef, type StaticSchemaRef } from '../workspace.js';

/** 基本类型：字段类型中的基本类型，另加颜色（参数与派生变量可用）。 */
export type BasicKind = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'boolean' | 'image' | 'color';

export type ValueType =
  | { readonly kind: BasicKind; readonly enum?: readonly (string | number)[] }
  | { readonly kind: 'list'; readonly items: ValueType }
  | { readonly kind: 'ref'; readonly ref?: StaticSchemaRef; readonly fields: ReadonlyMap<string, ValueType> };

export const BASIC_KINDS: readonly BasicKind[] = ['text', 'number', 'date', 'time', 'datetime', 'boolean', 'image', 'color'];

const KIND_LABELS: Record<ValueType['kind'], string> = {
  text: '文本',
  number: '数值',
  date: '日期',
  time: '时刻',
  datetime: '时间',
  boolean: '布尔',
  image: '图片',
  color: '颜色',
  list: '列表',
  ref: '数据定义引用',
};

export function typeLabel(type: ValueType): string {
  if (type.kind === 'list') return `列表[${typeLabel(type.items)}]`;
  if (type.kind === 'ref') return type.ref ? `${KIND_LABELS.ref}（${formatStaticSchemaRef(type.ref)}）` : KIND_LABELS.ref;
  return KIND_LABELS[type.kind];
}

export function kindLabel(kind: ValueType['kind']): string {
  return KIND_LABELS[kind];
}

/** 编译产物中一个属性的类型（M103：渲染只读编译产物）。 */
export function typeFromCompiled(schema: Record<string, unknown>): ValueType {
  const special = schema['x-renderweave-type'];
  if (special === 'date' || special === 'time' || special === 'datetime' || special === 'image') return { kind: special };
  const values = Array.isArray(schema['enum']) ? (schema['enum'] as (string | number)[]) : undefined;
  switch (schema['type']) {
    case 'number':
    case 'integer':
      return { kind: 'number', ...(values && { enum: values }) };
    case 'boolean':
      return { kind: 'boolean' };
    case 'array':
      return { kind: 'list', items: typeFromCompiled(isRecord(schema['items']) ? schema['items'] : {}) };
    case 'object': {
      const properties = isRecord(schema['properties']) ? schema['properties'] : {};
      const fields = new Map<string, ValueType>();
      for (const [name, property] of Object.entries(properties)) {
        if (isRecord(property)) fields.set(name, typeFromCompiled(property));
      }
      const ref = parseStaticSchemaRef(schema['x-renderweave-static-schema']);
      return { kind: 'ref', ...(ref && { ref }), fields };
    }
    default:
      return { kind: 'text', ...(values && { enum: values }) };
  }
}

/** 两个类型是否相同；引用类型比较所指的静态数据定义。 */
export function sameType(a: ValueType, b: ValueType): boolean {
  if (a.kind === 'list' || b.kind === 'list') return a.kind === 'list' && b.kind === 'list' && sameType(a.items, b.items);
  if (a.kind === 'ref' || b.kind === 'ref') {
    if (a.kind !== 'ref' || b.kind !== 'ref') return false;
    return !a.ref || !b.ref || (a.ref.name === b.ref.name && a.ref.version === b.ref.version);
  }
  return a.kind === b.kind;
}

/** 能放进文字插槽的类型。 */
export function displayKind(type: ValueType): DisplayKind | undefined {
  switch (type.kind) {
    case 'text':
    case 'number':
    case 'date':
    case 'time':
    case 'datetime':
      return type.kind;
    default:
      return undefined;
  }
}
