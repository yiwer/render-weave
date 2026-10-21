/**
 * 由编译产物生成表单（M248）：编译产物是 JSON Schema 2020-12，title 是显示名称，
 * x-renderweave-type 标明日期、时刻、时间与图片（ADR-0006）；数据定义引用已内联成对象，列表的元素不会再是列表。
 * 这里只把结构读成表单字段，不做校验：校验以服务端的问题清单为准，前端不另写一套规则。
 */

export type JsonObject = { readonly [key: string]: unknown };

interface FieldBase {
  /** 显示名称；列表的元素没有自己的显示名称，取列表的。 */
  readonly title: string;
  readonly required: boolean;
}

export interface TextField extends FieldBase { readonly kind: 'text'; readonly maxLength?: number; readonly enum?: readonly string[] }
export interface NumberField extends FieldBase { readonly kind: 'number'; readonly integer: boolean; readonly minimum?: number; readonly maximum?: number; readonly enum?: readonly number[] }
export interface DateField extends FieldBase { readonly kind: 'date' }
export interface TimeField extends FieldBase { readonly kind: 'time' }
export interface DateTimeField extends FieldBase { readonly kind: 'datetime' }
export interface BooleanField extends FieldBase { readonly kind: 'boolean' }
/** 图片：资源引用 res:ID，或 http(s) 地址；sources 是编译产物允许的来源。 */
export interface ImageField extends FieldBase { readonly kind: 'image'; readonly sources: readonly ('resource' | 'url')[] }
export interface ListField extends FieldBase { readonly kind: 'list'; readonly items: ScalarField | ObjectField; readonly minItems?: number; readonly maxItems?: number }
/** 数据定义引用（一对一），以及数据集的根。 */
export interface ObjectField extends FieldBase { readonly kind: 'object'; readonly fields: readonly NamedField[] }

export type ScalarField = TextField | NumberField | DateField | TimeField | DateTimeField | BooleanField | ImageField;
export type FieldSpec = ScalarField | ListField | ObjectField;
export interface NamedField { readonly name: string; readonly spec: FieldSpec }

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown) => (typeof value === 'number' ? value : undefined);

/** 数据集根的表单：编译产物的顶层对象。 */
export function formOf(compiled: JsonObject): ObjectField {
  return objectField(compiled, typeof compiled['title'] === 'string' ? compiled['title'] : '数据', true);
}

function objectField(schema: JsonObject, title: string, required: boolean): ObjectField {
  const properties = isObject(schema['properties']) ? schema['properties'] : {};
  const requiredNames = Array.isArray(schema['required']) ? schema['required'] : [];
  return {
    kind: 'object', title, required,
    fields: Object.entries(properties).map(([name, property]) => {
      const node = isObject(property) ? property : {};
      return { name, spec: fieldOf(node, typeof node['title'] === 'string' ? node['title'] : name, requiredNames.includes(name)) };
    }),
  };
}

function fieldOf(schema: JsonObject, title: string, required: boolean): FieldSpec {
  const marked = schema['x-renderweave-type'];
  if (marked === 'date' || marked === 'time' || marked === 'datetime') return { kind: marked, title, required };
  if (marked === 'image') return { kind: 'image', title, required, sources: imageSources(schema['pattern']) };
  switch (schema['type']) {
    case 'number':
    case 'integer':
      return {
        kind: 'number', title, required, integer: schema['type'] === 'integer',
        ...(num(schema['minimum']) === undefined ? {} : { minimum: num(schema['minimum'])! }),
        ...(num(schema['maximum']) === undefined ? {} : { maximum: num(schema['maximum'])! }),
        ...(Array.isArray(schema['enum']) ? { enum: schema['enum'].filter((v): v is number => typeof v === 'number') } : {}),
      };
    case 'boolean':
      return { kind: 'boolean', title, required };
    case 'array': {
      const items = isObject(schema['items']) ? schema['items'] : {};
      const item = fieldOf(items, title, true);
      return {
        kind: 'list', title, required, items: item.kind === 'list' ? { kind: 'text', title, required: true } : item,
        ...(num(schema['minItems']) === undefined ? {} : { minItems: num(schema['minItems'])! }),
        ...(num(schema['maxItems']) === undefined ? {} : { maxItems: num(schema['maxItems'])! }),
      };
    }
    case 'object':
      return objectField(schema, title, required);
    default:
      return {
        kind: 'text', title, required,
        ...(num(schema['maxLength']) === undefined ? {} : { maxLength: num(schema['maxLength'])! }),
        ...(Array.isArray(schema['enum']) ? { enum: schema['enum'].filter((v): v is string => typeof v === 'string') } : {}),
      };
  }
}

/** 编译产物用正则区分图片的来源：只许资源引用、只许地址，或两者都许（M9）。 */
function imageSources(pattern: unknown): readonly ('resource' | 'url')[] {
  if (typeof pattern !== 'string') return ['resource', 'url'];
  const resource = pattern.includes('res:'), url = pattern.includes('https?');
  return resource && !url ? ['resource'] : url && !resource ? ['url'] : ['resource', 'url'];
}

/** 字段在问题清单里的路径：与引擎相同，对象用"."，列表项写 [序号]，序号从 1 开始。 */
export const childPath = (parent: string, name: string) => (parent === '' ? name : `${parent}.${name}`);
export const itemPath = (parent: string, index: number) => `${parent}[${index + 1}]`;

/** 按路径写出给人看的位置，如"参会场次 › 第 2 项 › 开始时刻"；路径对不上表单时原样返回。 */
export function fieldLabel(root: ObjectField, path: string): string {
  const labels: string[] = [];
  let spec: FieldSpec = root;
  for (const token of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (token.startsWith('[')) {
      if (spec.kind !== 'list') return path;
      labels.push(`第 ${token.slice(1, -1)} 项`);
      spec = spec.items;
    } else {
      if (spec.kind !== 'object') return path;
      const field: NamedField | undefined = spec.fields.find((candidate) => candidate.name === token);
      if (!field) return path;
      labels.push(field.spec.title);
      spec = field.spec;
    }
  }
  return labels.length ? labels.join(' › ') : path;
}
