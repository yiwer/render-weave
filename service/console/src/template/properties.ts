/**
 * 属性面板的生成规则（P1 票据 08，M205、M299）：给模板文档与元素路径，按 schemas/template.schema.json 里该元素类型的属性
 * 生成可编辑项；写回只改那一处，再修掉因它失效的相邻属性（如横排改竖排后不再合法的对齐）。纯函数，不碰页面与接口。
 * - 属性全部来自 Schema：Schema 加了属性，面板自动多一项；这里只有显示用的中文名称与分组，没写的落到"其他"；
 * - if/then 的收窄生效：竖排文字的对齐只列竖排合法的取值；变量绑定是 anyOf 的一个变体，所以任何"或变量"的属性都能绑定；
 * - 位置尺寸按父容器的排布取自由、堆叠或网格的那份；改排布方式时子元素的 place 跟着调整。
 * 参数与检查项走同一套规则（listItemPanel），只是列表项不是元素。
 */
import templateSchema from '../../../../schemas/template.schema.json' with { type: 'json' };
import { elementAt, isObject, type JsonObject } from './document.js';

type Schema = JsonObject;
export type FieldPath = readonly (string | number)[];

const DEFS = (templateSchema as unknown as { $defs: Record<string, Schema> }).$defs;

export type Editor =
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number; readonly exclusiveMin?: number; readonly integer?: boolean }
  | { readonly kind: 'text'; readonly pattern?: string; readonly minLength?: number; readonly suggest?: 'variable' | 'field' | 'font' | 'image' }
  | { readonly kind: 'color' }
  | { readonly kind: 'choice'; readonly options: readonly ChoiceOption[] }
  /**
   * anyOf：选一个变体，active 是当前值落在哪个变体上（-1 是没写）；变体有内容要填时 editor 是它的编辑器。
   * 有"绑定变量"这个变体且字面值类型说得清时带 bindable，页面画成值格（模板设计页票据 09）。
   */
  | { readonly kind: 'variants'; readonly variants: readonly Variant[]; readonly active: number; readonly editor?: Editor; readonly bindable?: Bindable }
  /** 对象：absent 表示还没写，有必填子项时要先"添加"，写入 initial。 */
  | { readonly kind: 'group'; readonly fields: readonly PropertyField[]; readonly absent: boolean; readonly initial: unknown }
  | { readonly kind: 'list'; readonly items: readonly PropertyField[]; readonly append: readonly ChoiceOption[]; readonly minItems: number }
  /** 键由人起名的对象（传入参数、状态样式的取值）；overrides 是每个键下可以覆盖的属性。 */
  | { readonly kind: 'map'; readonly entries: readonly PropertyField[]; readonly initial: unknown; readonly overrides?: readonly ChoiceOption[] }
  /** Schema 说不清的内容，直接写 JSON。 */
  | { readonly kind: 'json' };

export interface ChoiceOption { readonly label: string; readonly value: unknown }
export interface Variant { readonly label: string; readonly initial: unknown }

/** 属性要的变量类型，和模板静态检查的判断一致（M71）：只有完全相符才能绑定。 */
export type BindingType = 'number' | 'color' | 'boolean' | 'text' | 'image';
export interface Bindable {
  readonly type: BindingType;
  /** 字面值的编辑器：没写、断开绑定之后都用它。 */
  readonly literal: Editor;
  /** 这种字面值的初值，和 schema 一起决定断开时写什么。 */
  readonly initial: unknown;
  readonly schema: JsonObject;
}

export interface PropertyField {
  /** 从元素（或列表项）算起的路径，写回时原样交给 writeProperty。 */
  readonly path: FieldPath;
  /** path 用点连起来，页面与测试用它认字段。 */
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  readonly editor: Editor;
  /** Schema 上的说明。 */
  readonly description?: string;
  /** dependentRequired：这几个属性没写之前，这一项写了也不合法。 */
  readonly needs?: readonly string[];
  /** 没写时引擎用的值，页面淡色显示；不知道时没有这一项。 */
  readonly fallback?: unknown;
  /** 这一项不能绑定变量的原因（DSL 的能绑定表），只给人会想绑定的属性。 */
  readonly noBinding?: string;
}

export const PROPERTY_GROUPS = ['基本', '绑定', '位置尺寸', '布局', '文字', '图片', '形状', '码', '颜色', '适配', '条件显示', '状态样式', '其他'] as const;
export type PropertyGroup = (typeof PROPERTY_GROUPS)[number];

export interface PropertyPanel {
  /** 元素类型；画板是 artboard。 */
  readonly type: string;
  readonly groups: readonly { readonly name: PropertyGroup; readonly fields: readonly PropertyField[] }[];
}

export const ELEMENT_TYPES: Readonly<Record<string, string>> = {
  artboard: '画板', container: '容器', loop: '循环容器', call: '子模板调用', text: '文字', image: '图片', qrcode: '二维码', barcode: '条码',
  rect: '矩形', ellipse: '椭圆', line: '线条', polygon: '多边形', path: '路径',
};

const LABELS: Readonly<Record<string, string>> = {
  name: '名称', left: '左', right: '右', top: '上', bottom: '下', width: '宽', height: '高', minWidth: '最小宽', maxWidth: '最大宽', minHeight: '最小高', maxHeight: '最大高',
  margin: '外边距', alignSelf: '自身对齐', justifySelf: '横向自身对齐', row: '第几行', column: '第几列', rowSpan: '跨行', columnSpan: '跨列',
  visible: '显示', opacity: '不透明度', rotation: '旋转（度）',
  layout: '排布', mode: '方式', direction: '方向', gap: '间距', wrap: '自动换行', crossGap: '换行间距', justifyContent: '主轴分布', alignItems: '交叉轴对齐',
  rows: '行', columns: '列', rowGap: '行间距', columnGap: '列间距', padding: '内边距', clip: '裁剪超出部分',
  fill: '填充色', stroke: '描边', color: '颜色', dash: '虚线', cap: '线端', cornerRadius: '圆角', topLeft: '左上', topRight: '右上', bottomRight: '右下', bottomLeft: '左下',
  list: '循环列表', reverse: '反序', slice: '只取一段', start: '从第几项', end: '到第几项', template: '模板', args: '传入参数', itemLayout: '每项排布',
  widths: '每项宽', heights: '每项高', spanBy: '跨度', mergeBy: '合并相邻同值项', data: '数据',
  content: '内容', text: '文字', slot: '字段', format: '显示格式', font: '字体', fontSize: '字号（mm）', letterSpacing: '字间距（mm）',
  writingMode: '书写方向', horizontalAlign: '水平对齐', verticalAlign: '垂直对齐', slant: '倾斜（度）',
  fit: '适配', steps: '适配顺序', compressMin: '字形压缩下限', minFontSize: '缩字下限（mm）', onFail: '放不下时', widthOverflow: '缩字组', shrinkGroup: '组名',
  source: '图片来源', tint: '单色重染', errorCorrectionLevel: '纠错等级', foreground: '前景色', background: '背景色', showText: '显示文字',
  from: '起点', to: '终点', points: '顶点', viewBox: '视图框', d: '路径数据', fillRule: '填充规则',
  states: '状态样式', by: '取决于变量', cases: '各取值的样式', sizeRange: '适用尺寸', size: '画板尺寸', min: '最小', max: '最大',
  displayName: '显示名称', visibility: '可见性', type: '类型', constraints: '约束', default: '缺省值', integer: '只能是整数', minLength: '最短字数', maxLength: '最多字数',
  pattern: '格式（正则）', enum: '可选值', problemWhen: '条件成立时报问题', level: '等级', message: '问题说明', value: '值', var: '变量', loop: '循环位置',
};

const ELEMENT_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  image: { fit: '适配方式' }, line: { fit: '随框缩放' }, polygon: { fit: '随框缩放' }, path: { fit: '随框缩放' },
  barcode: { format: '码制', content: '编码内容', fontSize: '文字字号（mm）', font: '文字字体' }, qrcode: { content: '编码内容' },
};

const GROUPS: Readonly<Record<string, PropertyGroup>> = {
  name: '基本', place: '位置尺寸', rotation: '位置尺寸', sizeRange: '位置尺寸', size: '位置尺寸',
  layout: '布局', padding: '布局', clip: '布局', itemLayout: '布局',
  list: '绑定', reverse: '绑定', slice: '绑定', template: '绑定', args: '绑定', mergeBy: '绑定', data: '绑定',
  content: '文字', font: '文字', fontSize: '文字', letterSpacing: '文字', writingMode: '文字', horizontalAlign: '文字', verticalAlign: '文字', slant: '文字',
  source: '图片', tint: '图片', d: '形状', points: '形状', from: '形状', to: '形状', viewBox: '形状', fillRule: '形状',
  errorCorrectionLevel: '码', format: '码', showText: '码',
  color: '颜色', fill: '颜色', stroke: '颜色', foreground: '颜色', background: '颜色', cornerRadius: '颜色', opacity: '颜色',
  fit: '适配', minFontSize: '适配', visible: '条件显示', states: '状态样式',
};

const ELEMENT_GROUPS: Readonly<Record<string, Readonly<Record<string, PropertyGroup>>>> = {
  image: { fit: '图片' }, line: { fit: '形状', stroke: '形状' }, polygon: { fit: '形状' }, path: { fit: '形状' },
  qrcode: { content: '绑定' }, barcode: { content: '绑定', font: '码', fontSize: '码' },
};

/** 枚举值的中文。同一个值在不同属性上意思不同时写 属性:值。 */
const ENUM_LABELS: Readonly<Record<string, string>> = {
  start: '开头', center: '居中', end: '末尾', distribute: '分散', spaceEvenly: '均分', spaceBetween: '两端', top: '上', bottom: '下',
  horizontal: '横排', vertical: '竖排', row: '横向', column: '纵向', hug: '随内容', fill: '撑满', equal: '等分', content: '随内容',
  contain: '完整显示', cover: '铺满裁切', 'fit:fill': '拉伸', severe: '严重', hint: '提示', public: '对外', internal: '内部',
  text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片', color: '颜色',
  butt: '平头', round: '圆头', square: '方头', nonzero: '非零', evenodd: '奇偶', current: '当前数据', none: '不传数据',
  free: '自由', stack: '堆叠', grid: '网格', index: '序号', isFirst: '是第一项', isLast: '是最后一项', count: '总项数', groupSize: '合并的项数', groupsize: '合并的项数',
  true: '是', false: '否',
};
const STEP_LABELS: Readonly<Record<string, string>> = { tightenSpacing: '收紧字距', compressGlyphs: '压缩字形', shrink: '缩字' };

const VARIANT_KEYS: Readonly<Record<string, string>> = { var: '绑定变量', fixed: '固定', fill: '按比例撑满', fraction: '按比例', value: '固定值', loop: '循环位置', text: '固定文字', slot: '字段', mode: '排布' };

/** 没写时的取值：和引擎读取时的缺省一致（src/template/parse.ts、docs/dsl/template.md），没把握的不列，页面写"缺省"。 */
const FALLBACKS: Readonly<Record<string, unknown>> = {
  visible: true, opacity: 1, rotation: 0, clip: false, reverse: false, showText: false, letterSpacing: 0, slant: 0, color: '#000000', foreground: '#000000',
  writingMode: 'horizontal', horizontalAlign: 'start', verticalAlign: 'top', errorCorrectionLevel: 'M', fillRule: 'nonzero',
  'layout.gap': 0, 'layout.rowGap': 0, 'layout.columnGap': 0, 'layout.wrap': false, 'itemLayout.gap': 0, 'itemLayout.wrap': false, 'fit.compressMin': 0.6,
};
const ELEMENT_FALLBACKS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  image: { fit: 'contain' }, line: { fit: 'fill' }, polygon: { fit: 'fill' }, path: { fit: 'fill' }, barcode: { fontSize: 3 },
};

// —— JSON Schema 的一小部分：模板 Schema 用到的关键字 ——

function resolved(node: Schema): Schema {
  let current = node;
  while (typeof current['$ref'] === 'string') current = DEFS[current['$ref'].slice('#/$defs/'.length)] ?? {};
  return current;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const typeOf = (value: unknown) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'object' ? 'object' : typeof value);

/** 值合不合这份 Schema：编辑时判断 if 分支与变体，写回时判断相邻属性是否失效。权威的检查仍是引擎。 */
export function matchesSchema(node: Schema, value: unknown): boolean {
  const schema = resolved(node);
  if (schema['type'] !== undefined) {
    const types = (Array.isArray(schema['type']) ? schema['type'] : [schema['type']]) as string[];
    const actual = typeOf(value);
    if (!types.some((type) => type === actual || (type === 'integer' && Number.isInteger(value)))) return false;
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((item) => same(item, value))) return false;
  if ('const' in schema && !same(schema['const'], value)) return false;
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) return false;
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) return false;
    if (typeof schema['exclusiveMinimum'] === 'number' && value <= schema['exclusiveMinimum']) return false;
  }
  if (typeof value === 'string') {
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) return false;
    if (typeof schema['pattern'] === 'string' && !new RegExp(schema['pattern'], 'u').test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return false;
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return false;
    const prefix = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] as Schema[] : [];
    if (!prefix.every((item, index) => index >= value.length || matchesSchema(item, value[index]))) return false;
    if (isObject(schema['items']) && !value.every((item) => matchesSchema(schema['items'] as Schema, item))) return false;
  }
  if (isObject(value)) {
    if (Array.isArray(schema['required']) && !(schema['required'] as string[]).every((key) => key in value)) return false;
    const properties = isObject(schema['properties']) ? schema['properties'] : {};
    for (const [key, item] of Object.entries(value)) {
      if (isObject(properties[key])) { if (!matchesSchema(properties[key], item)) return false; }
      else if (schema['additionalProperties'] === false) return false;
      else if (isObject(schema['additionalProperties']) && !matchesSchema(schema['additionalProperties'], item)) return false;
    }
    if (isObject(schema['propertyNames']) && !Object.keys(value).every((key) => matchesSchema(schema['propertyNames'] as Schema, key))) return false;
    if (typeof schema['minProperties'] === 'number' && Object.keys(value).length < schema['minProperties']) return false;
  }
  if (Array.isArray(schema['anyOf']) && !(schema['anyOf'] as Schema[]).some((item) => matchesSchema(item, value))) return false;
  if (Array.isArray(schema['oneOf']) && (schema['oneOf'] as Schema[]).filter((item) => matchesSchema(item, value)).length !== 1) return false;
  if (Array.isArray(schema['allOf']) && !(schema['allOf'] as Schema[]).every((item) => matchesSchema(item, value))) return false;
  if (isObject(schema['not']) && matchesSchema(schema['not'], value)) return false;
  if (isObject(schema['if'])) {
    const branch = matchesSchema(schema['if'], value) ? schema['then'] : schema['else'];
    if (isObject(branch) && !matchesSchema(branch, value)) return false;
  }
  return true;
}

/** 对这个值生效的全部 Schema 片段：展开引用与 allOf，if/then 只取成立的一边。 */
function applying(view: readonly Schema[], value: unknown): Schema[] {
  const result: Schema[] = [];
  const walk = (node: Schema) => {
    const schema = resolved(node);
    result.push(schema);
    for (const part of Array.isArray(schema['allOf']) ? schema['allOf'] as Schema[] : []) walk(part);
    if (isObject(schema['if'])) {
      const branch = matchesSchema(schema['if'], value) ? schema['then'] : schema['else'];
      if (isObject(branch)) walk(branch);
    }
  };
  view.forEach(walk);
  return result;
}

const propertyView = (fragments: readonly Schema[], key: string) =>
  fragments.flatMap((fragment) => (isObject(fragment['properties']) && isObject(fragment['properties'][key]) ? [fragment['properties'][key] as Schema] : []));
const requiredOf = (fragments: readonly Schema[]) => new Set(fragments.flatMap((fragment) => (Array.isArray(fragment['required']) ? fragment['required'] as string[] : [])));
const propertyKeys = (fragments: readonly Schema[]) => [...new Set(fragments.flatMap((fragment) => (isObject(fragment['properties']) ? Object.keys(fragment['properties']) : [])))];
/** 片段里后面的更窄（allOf 的收窄排在基础定义之后）。 */
const narrowest = <T>(fragments: readonly Schema[], read: (fragment: Schema) => T | undefined): T | undefined => {
  for (let index = fragments.length - 1; index >= 0; index--) {
    const found = read(fragments[index]!);
    if (found !== undefined) return found;
  }
  return undefined;
};
const alternativesOf = (fragments: readonly Schema[]) => narrowest(fragments, (fragment) => (Array.isArray(fragment['anyOf']) ? fragment['anyOf'] as Schema[] : Array.isArray(fragment['oneOf']) ? fragment['oneOf'] as Schema[] : undefined));
const numberOf = (fragments: readonly Schema[], key: string) => narrowest(fragments, (fragment) => (typeof fragment[key] === 'number' ? fragment[key] as number : undefined));

/** 嵌套的 anyOf 摊平（"非负数或变量"既是一个变体，又有自己的两个变体）；布尔摊成是与否两项。 */
function flatAlternatives(alternatives: readonly Schema[]): Schema[] {
  return alternatives.flatMap((alternative) => {
    const schema = resolved(alternative), nested = alternativesOf([schema]);
    if (nested) return flatAlternatives(nested);
    if (schema['type'] === 'boolean') return [{ const: true }, { const: false }];
    if (Array.isArray(schema['enum'])) return schema['enum'].map((value) => ({ const: value }));
    return [schema];
  });
}

/** 新写一个值：必填的都有、尽量合法；调用方在写回后仍可能看到问题清单，比如还没选的字体。 */
function initialOf(view: readonly Schema[]): unknown {
  const fragments = applying(view, undefined);
  const named = narrowest(fragments, (fragment) => (Array.isArray(fragment['enum']) ? fragment['enum'][0] as unknown : 'const' in fragment ? fragment['const'] : undefined));
  if (named !== undefined) return named;
  const alternatives = alternativesOf(fragments);
  if (alternatives) return initialOf([flatAlternatives(alternatives)[0]!]);
  switch (narrowest(fragments, (fragment) => (typeof fragment['type'] === 'string' ? fragment['type'] : undefined))) {
    case 'object': {
      const required = [...requiredOf(fragments)];
      // 至少要写一项又没有必填的（循环的切片）：写第一项。
      const keys = required.length || !numberOf(fragments, 'minProperties') ? required : propertyKeys(fragments).slice(0, 1);
      return Object.fromEntries(keys.map((key) => [key, initialOf(propertyView(fragments, key))]));
    }
    case 'array': {
      const prefix = narrowest(fragments, (fragment) => (Array.isArray(fragment['prefixItems']) ? fragment['prefixItems'] as Schema[] : undefined));
      if (prefix) return prefix.map((item) => initialOf([item]));
      const items = narrowest(fragments, (fragment) => (isObject(fragment['items']) ? fragment['items'] : undefined));
      return Array.from({ length: numberOf(fragments, 'minItems') ?? 0 }, () => initialOf(items ? [items] : []));
    }
    case 'number': case 'integer': {
      const exclusive = numberOf(fragments, 'exclusiveMinimum');
      return exclusive !== undefined ? exclusive + 1 : numberOf(fragments, 'minimum') ?? 0;
    }
    case 'boolean': return false;
    case 'string': {
      const pattern = narrowest(fragments, (fragment) => (typeof fragment['pattern'] === 'string' ? fragment['pattern'] : undefined));
      if (pattern === colorPattern()) return '#000000';
      if (pattern === resourcePattern()) return RESOURCE_PLACEHOLDER;
      return pattern || numberOf(fragments, 'minLength') ? '新建' : '';
    }
    default: return undefined;
  }
}

const RESOURCE_PLACEHOLDER = 'res:';
const colorPattern = () => DEFS['color']!['pattern'] as string;
const resourcePattern = () => DEFS['resourceRef']!['pattern'] as string;

// —— 生成可编辑项 ——

interface Context {
  /** 元素类型：同一个键在不同类型上名称不同（barcode 的 format 是码制）。 */
  readonly type: string;
  /** 元素自身的 Schema：状态样式里覆盖的属性按它生成。 */
  readonly fragments: readonly Schema[];
}

const lastName = (path: FieldPath) => [...path].reverse().find((part): part is string => typeof part === 'string') ?? '';

function labelOf(path: FieldPath, context: Context): string {
  const last = path.at(-1)!;
  if (typeof last === 'number') return `第 ${last + 1} 项`;
  return (path.length === 1 ? ELEMENT_LABELS[context.type]?.[last] : undefined) ?? LABELS[last] ?? last;
}

function enumLabel(path: FieldPath, value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.map((step) => STEP_LABELS[String(step)] ?? String(step)).join(' → ') : '不适配';
  const text = String(value);
  return ENUM_LABELS[`${lastName(path)}:${text}`] ?? ENUM_LABELS[text] ?? text;
}

function variantLabel(alternative: Schema, path: FieldPath): string {
  if ('const' in alternative) return enumLabel(path, alternative['const']);
  const required = Array.isArray(alternative['required']) ? alternative['required'] as string[] : [];
  const discriminator = required[0];
  if (discriminator === 'mode') return enumLabel(path, (alternative['properties'] as { mode: { const: unknown } }).mode.const);
  if (discriminator && VARIANT_KEYS[discriminator]) return VARIANT_KEYS[discriminator]!;
  if (alternative['type'] === 'number' || alternative['type'] === 'integer') return '数值';
  if (alternative['pattern'] === colorPattern()) return '颜色';
  if (alternative['pattern'] === resourcePattern()) return '资源';
  if (alternative['type'] === 'string') return '文字';
  return '分别设置';
}

/** 字面值变体对应的变量类型；对象形态的变体（分别设置、固定值）说不清，是 undefined。 */
function literalType(alternative: Schema): BindingType | undefined {
  if (typeof alternative['const'] === 'boolean') return 'boolean';
  if (alternative['type'] === 'number' || alternative['type'] === 'integer') return 'number';
  if (alternative['pattern'] === colorPattern()) return 'color';
  if (alternative['pattern'] === resourcePattern()) return 'image';
  return alternative['type'] === 'string' ? 'text' : undefined;
}

/** 能不能绑定以 Schema 为准：有 { var } 变体，又有说得清类型的字面值变体。Schema 加属性时不用改这里。 */
function bindableOf(flat: readonly Schema[], path: FieldPath, context: Context): Bindable | undefined {
  const isVariable = (alternative: Schema) => Array.isArray(alternative['required']) && alternative['required'][0] === 'var';
  if (!flat.some(isVariable)) return undefined;
  const literal = flat.find((alternative) => !isVariable(alternative) && literalType(alternative));
  const type = literal && literalType(literal);
  if (!literal || !type) return undefined;
  if (type === 'boolean') return { type, literal: { kind: 'choice', options: [{ label: '是', value: true }, { label: '否', value: false }] }, initial: false, schema: { type: 'boolean' } };
  return { type, literal: editorOf([literal], undefined, path, context), initial: initialOf([literal]), schema: literal };
}

function editorOf(view: readonly Schema[], value: unknown, path: FieldPath, context: Context): Editor {
  const fragments = applying(view, value);
  const named = narrowest(fragments, (fragment) => (Array.isArray(fragment['enum']) ? fragment['enum'] as unknown[] : 'const' in fragment ? [fragment['const']] : undefined));
  if (named) {
    const options = named.some((item) => same(item, value)) || value === undefined ? named : [...named, value];
    return { kind: 'choice', options: options.map((item) => ({ label: enumLabel(path, item), value: item })) };
  }
  const alternatives = alternativesOf(fragments);
  if (alternatives) {
    const flat = flatAlternatives(alternatives), active = value === undefined ? -1 : flat.findIndex((alternative) => matchesSchema(alternative, value));
    const chosen = flat[active], bindable = bindableOf(flat, path, context);
    return {
      kind: 'variants', active,
      variants: flat.map((alternative) => ({ label: variantLabel(alternative, path), initial: initialOf([alternative]) })),
      ...(chosen && !('const' in chosen) ? { editor: editorOf([chosen], value, path, context) } : {}),
      ...(bindable ? { bindable } : {}),
    };
  }
  const type = narrowest(fragments, (fragment) => (typeof fragment['type'] === 'string' ? fragment['type'] : undefined));
  if (type === 'array') return arrayEditor(fragments, value, path, context);
  if (type === 'number' || type === 'integer') {
    const min = numberOf(fragments, 'minimum'), max = numberOf(fragments, 'maximum'), exclusiveMin = numberOf(fragments, 'exclusiveMinimum');
    return { kind: 'number', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(exclusiveMin !== undefined ? { exclusiveMin } : {}), ...(type === 'integer' ? { integer: true } : {}) };
  }
  if (type === 'boolean') return { kind: 'choice', options: [{ label: '是', value: true }, { label: '否', value: false }] };
  if (type === 'string') {
    const pattern = narrowest(fragments, (fragment) => (typeof fragment['pattern'] === 'string' ? fragment['pattern'] : undefined));
    if (pattern === colorPattern()) return { kind: 'color' };
    const minLength = numberOf(fragments, 'minLength'), last = lastName(path);
    const resource = last === 'font' ? 'font' : 'image';
    const suggest = pattern === resourcePattern() ? resource : last === 'var' ? 'variable' : last === 'slot' || last === 'mergeBy' ? 'field' : undefined;
    return { kind: 'text', ...(pattern ? { pattern } : {}), ...(minLength ? { minLength } : {}), ...(suggest ? { suggest } : {}) };
  }
  const keys = propertyKeys(fragments);
  if (keys.length) return groupEditor(fragments, keys, value, path, context);
  const additional = narrowest(fragments, (fragment) => (isObject(fragment['additionalProperties']) ? fragment['additionalProperties'] : undefined));
  if (additional) return mapEditor(additional, value, path, context);
  return { kind: 'json' };
}

function fieldOf(view: readonly Schema[], value: unknown, path: FieldPath, required: boolean, context: Context, needs?: readonly string[]): PropertyField {
  const description = narrowest(applying(view, value), (fragment) => (typeof fragment['description'] === 'string' ? fragment['description'] : undefined));
  const key = path.join('.'), label = labelOf(path, context), editor = editorOf(view, value, path, context);
  const fallback = ELEMENT_FALLBACKS[context.type]?.[key] ?? FALLBACKS[key], noBinding = noBindingReason(path, label, editor, context);
  return {
    path, key, label, required, value, editor,
    ...(description ? { description } : {}), ...(needs?.length ? { needs } : {}),
    ...(fallback !== undefined ? { fallback } : {}), ...(noBinding ? { noBinding } : {}),
  };
}

/** 元素的状态样式能覆盖哪些属性：不能绑定的属性，要按取值换就走这条路。 */
function overridableKeys(context: Context): readonly string[] {
  const states = propertyView(context.fragments, 'states').flatMap((schema) => propertyView([resolved(schema)], 'cases'));
  const additional = states.map((schema) => resolved(schema)['additionalProperties']).find(isObject);
  const names = additional?.['propertyNames'];
  return isObject(names) && Array.isArray(names['enum']) ? names['enum'] as string[] : [];
}

/** 顶层的单值属性没有绑定写法时说明原因；名称、合并字段这类本来就不是"值"的不提。 */
function noBindingReason(path: FieldPath, label: string, editor: Editor, context: Context): string | undefined {
  if (path.length !== 1 || !['choice', 'text', 'number', 'color'].includes(editor.kind)) return undefined;
  const key = String(path[0]);
  if (key === 'name' || key === 'mergeBy' || !overridableKeys(context).includes(key)) return undefined;
  return `${label.replace(/（.*）$/u, '')}不能绑定变量：要按取值换，用状态样式。`;
}

/** 当前分支不许写的键（横排的 widthOverflow、竖排的 minFontSize）：不列出来。 */
const prohibited = (fragments: readonly Schema[]) => new Set(fragments.flatMap((fragment) => (isObject(fragment['not']) && Array.isArray(fragment['not']['required']) ? fragment['not']['required'] as string[] : [])));

function groupEditor(fragments: readonly Schema[], keys: readonly string[], value: unknown, path: FieldPath, context: Context): Editor {
  const current = isObject(value) ? value : {}, required = requiredOf(fragments), hidden = prohibited(fragments);
  return {
    kind: 'group', absent: value === undefined, initial: initialOf([{ type: 'object' }, ...fragments]),
    fields: keys.filter((key) => !hidden.has(key)).map((key) => fieldOf(propertyView(fragments, key), current[key], [...path, key], required.has(key), context)),
  };
}

function arrayEditor(fragments: readonly Schema[], value: unknown, path: FieldPath, context: Context): Editor {
  const current = Array.isArray(value) ? value as unknown[] : [];
  const prefix = narrowest(fragments, (fragment) => (Array.isArray(fragment['prefixItems']) ? fragment['prefixItems'] as Schema[] : undefined));
  const items = narrowest(fragments, (fragment) => (isObject(fragment['items']) ? fragment['items'] : undefined));
  const minItems = numberOf(fragments, 'minItems') ?? 0, maxItems = numberOf(fragments, 'maxItems');
  // 定长的数组（点、视图框）一格一项，不能增删。
  if (prefix || (minItems > 0 && minItems === maxItems)) {
    const views = prefix ?? Array.from({ length: minItems }, () => items ?? {});
    return {
      kind: 'group', absent: value === undefined, initial: views.map((item) => initialOf([item])),
      fields: views.map((item, index) => fieldOf([item], current[index], [...path, index], true, context)),
    };
  }
  const alternatives = items ? alternativesOf(applying([items], undefined)) : undefined;
  return {
    kind: 'list', minItems,
    items: current.map((item, index) => fieldOf(items ? [items] : [], item, [...path, index], true, context)),
    append: alternatives
      ? flatAlternatives(alternatives).map((alternative) => ({ label: variantLabel(alternative, path), value: initialOf([alternative]) }))
      : [{ label: '一项', value: initialOf(items ? [items] : []) }],
  };
}

function mapEditor(additional: Schema, value: unknown, path: FieldPath, context: Context): Editor {
  const current = isObject(value) ? value : {};
  const allowed = Array.isArray((additional['propertyNames'] as Schema | undefined)?.['enum']) ? (additional['propertyNames'] as { enum: string[] }).enum : undefined;
  if (!allowed) {
    return { kind: 'map', initial: initialOf([additional]), entries: Object.keys(current).map((key) => fieldOf([additional], current[key], [...path, key], false, context)) };
  }
  // 状态样式的一个取值：列出写了的覆盖项，编辑器按元素自身的属性生成；没写的留在"添加"里。
  return {
    kind: 'map', initial: {},
    overrides: allowed.map((key) => ({ label: ELEMENT_LABELS[context.type]?.[key] ?? LABELS[key] ?? key, value: { key, initial: initialOf(propertyView(context.fragments, key)) } })),
    entries: Object.keys(current).map((name) => {
      const overrides = isObject(current[name]) ? current[name] : {}, entryPath = [...path, name];
      return {
        path: entryPath, key: entryPath.join('.'), label: name, required: false, value: current[name],
        editor: {
          kind: 'group', absent: false, initial: {},
          fields: allowed.filter((key) => key in overrides).map((key) => fieldOf(propertyView(context.fragments, key), overrides[key], [...entryPath, key], false, { ...context })),
        },
      };
    }),
  };
}

// —— 面板 ——

const PLACE: Readonly<Record<string, string>> = { free: 'placeInFree', stack: 'placeInStack', grid: 'placeInGrid' };
const TYPE_DEFS: Readonly<Record<string, string>> = {
  artboard: 'artboard', container: 'containerElement', loop: 'loopElement', call: 'callElement', text: 'textElement', image: 'imageElement', qrcode: 'qrcodeElement',
  barcode: 'barcodeElement', rect: 'rectElement', ellipse: 'ellipseElement', line: 'lineElement', polygon: 'polygonElement', path: 'pathElement',
};

const modeOf = (container: JsonObject | undefined) => (isObject(container?.['layout']) && typeof container['layout']['mode'] === 'string' ? container['layout']['mode'] : 'free');
const placeSchema = (mode: string): Schema => ({ properties: { place: { $ref: `#/$defs/${PLACE[mode] ?? 'placeInFree'}` } } });

/** 元素的 Schema：类型定义，加上按父容器排布取的 place。 */
function elementView(document: unknown, path: string): { readonly type: string; readonly element: JsonObject; readonly view: readonly Schema[] } | undefined {
  const located = elementAt(document, path);
  if (!located) return undefined;
  const { element, parent } = located, type = parent ? String(element['type'] ?? '') : 'artboard', definition = DEFS[TYPE_DEFS[type] ?? ''];
  if (!definition) return undefined;
  return { type, element, view: parent ? [definition, placeSchema(modeOf(parent))] : [definition] };
}

/** 属性面板：这个元素的全部可编辑项，按分组；路径不存在或类型不认识时是 undefined。 */
export function propertyPanel(document: unknown, path: string): PropertyPanel | undefined {
  const target = elementView(document, path);
  if (!target) return undefined;
  const { type, element, view } = target, fragments = applying(view, element), required = requiredOf(fragments);
  const context: Context = { type, fragments };
  const dependent = Object.assign({}, ...fragments.map((fragment) => (isObject(fragment['dependentRequired']) ? fragment['dependentRequired'] : {}))) as Record<string, string[]>;
  const groups = new Map<PropertyGroup, PropertyField[]>();
  const add = (group: PropertyGroup, field: PropertyField) => groups.set(group, [...(groups.get(group) ?? []), field]);
  for (const key of propertyKeys(fragments)) {
    if (key === 'type' || key === 'children') continue;
    const missing = (dependent[key] ?? []).filter((name) => !(name in element));
    const field = fieldOf(propertyView(fragments, key), element[key], [key], required.has(key), context, missing);
    const group = ELEMENT_GROUPS[type]?.[key] ?? GROUPS[key] ?? '其他';
    // 位置尺寸摊开放进分组，不再套一层。
    if (key === 'place' && field.editor.kind === 'group') field.editor.fields.forEach((inner) => add(group, inner));
    else add(group, field);
  }
  return { type, groups: PROPERTY_GROUPS.flatMap((name) => (groups.has(name) ? [{ name, fields: groups.get(name)! }] : [])) };
}

/** 面板里按 key 找一项，嵌套的也算。 */
export function fieldByKey(panel: PropertyPanel, key: string): PropertyField | undefined {
  const inner = (editor: Editor | undefined): readonly PropertyField[] => {
    switch (editor?.kind) {
      case 'group': return editor.fields;
      case 'variants': return inner(editor.editor);
      case 'list': return editor.items;
      case 'map': return editor.entries;
      default: return [];
    }
  };
  const search = (fields: readonly PropertyField[]): PropertyField | undefined => {
    for (const field of fields) {
      const found = field.key === key ? field : search(inner(field.editor));
      if (found) return found;
    }
    return undefined;
  };
  return search(panel.groups.flatMap((group) => group.fields));
}

/** 模板层的列表：参数与检查项。名称是身份，改名等于删一个、加一个，不在这里改。 */
const LISTS = { parameters: 'parameter', checks: 'check' } as const;
export type TemplateList = keyof typeof LISTS;

const listOf = (document: unknown, list: TemplateList): unknown[] => (isObject(document) && Array.isArray(document[list]) ? document[list] as unknown[] : []);

export function listItemPanel(document: unknown, list: TemplateList, index: number): readonly PropertyField[] {
  const item = listOf(document, list)[index], view = [DEFS[LISTS[list]]!], fragments = applying(view, item), required = requiredOf(fragments);
  const context: Context = { type: list, fragments };
  return propertyKeys(fragments).filter((key) => key !== 'name').map((key) => fieldOf(propertyView(fragments, key), isObject(item) ? item[key] : undefined, [key], required.has(key), context));
}

// —— 写回 ——

/** 值里互斥的键（place 的 left 与 right）：写了一边就去掉另一边。 */
function excludedBy(fragments: readonly Schema[], current: JsonObject, written: string | number | undefined): string[] {
  const sets = fragments.flatMap((fragment) => {
    const not = isObject(fragment['not']) ? fragment['not'] : undefined;
    if (!not) return [];
    return [...(Array.isArray(not['required']) ? [not['required'] as string[]] : []), ...(Array.isArray(not['anyOf']) ? (not['anyOf'] as Schema[]).flatMap((part) => (Array.isArray(part['required']) ? [part['required'] as string[]] : [])) : [])];
  });
  return sets.flatMap((set) => (set.every((key) => key in current) ? set.filter((key) => key !== written) : []));
}

/**
 * 写了 written 之后修相邻的值：原来合法、现在不合法的去掉（先往里修）；变成必填又没写的补上。
 * 只动因这次写入才失效的：顶层比对改前改后，本来就不合法的留给问题清单。往里修时（inner）外层已经判断过，不再比对。
 */
function reconcile(view: readonly Schema[], before: unknown, after: JsonObject, written: string | number | undefined, inner = false): JsonObject {
  const fragments = applying(view, after), beforeFragments = applying(view, before), result: JsonObject = { ...after };
  for (const key of excludedBy(fragments, result, written)) delete result[key];
  for (const key of Object.keys(result)) {
    // 子元素的 place 由 fitChildren 按排布方式调整。
    if (key === written || key === 'children') continue;
    const childView = propertyView(fragments, key), value = result[key];
    if (!childView.length || childView.every((schema) => matchesSchema(schema, value))) continue;
    const previous = isObject(before) ? before[key] : undefined, beforeView = propertyView(beforeFragments, key);
    if (!inner && (beforeView.length === 0 || !beforeView.every((schema) => matchesSchema(schema, previous)))) continue;
    const repaired = repair(childView, previous, value);
    if (childView.every((schema) => matchesSchema(schema, repaired))) result[key] = repaired;
    else delete result[key];
  }
  for (const key of requiredOf(fragments)) {
    if (key in result) continue;
    const initial = initialOf(propertyView(fragments, key));
    if (initial !== undefined) result[key] = initial;
  }
  return result;
}

function repair(view: readonly Schema[], before: unknown, value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = narrowest(applying(view, value), (fragment) => (isObject(fragment['items']) ? fragment['items'] : undefined));
    return value.map((item, index) => {
      if (!isObject(item)) return item;
      // 列表项的 Schema 分散在各片段的 items 里（基础定义加收窄）。
      const views = applying(view, value).flatMap((fragment) => (isObject(fragment['items']) ? [fragment['items']] : []));
      return reconcile(views.length ? views : items ? [items] : [], Array.isArray(before) ? before[index] : undefined, item, undefined, true);
    });
  }
  return isObject(value) ? reconcile(view, before, value, undefined, true) : value;
}

function setAt(view: readonly Schema[], current: unknown, path: FieldPath, value: unknown): unknown {
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (typeof key === 'number') {
    const list = Array.isArray(current) ? [...current] as unknown[] : [];
    const items = applying(view, current).flatMap((fragment) => (isObject(fragment['items']) ? [fragment['items']] : Array.isArray(fragment['prefixItems']) ? [(fragment['prefixItems'] as Schema[])[key] ?? {}] : []));
    const next = setAt(items, list[key], rest, value);
    if (next === undefined) list.splice(key, 1); else list[key] = next;
    return list;
  }
  const base = isObject(current) ? current : {}, fragments = applying(view, base);
  const child = setAt(propertyView(fragments, key).length ? propertyView(fragments, key) : additionalView(fragments), base[key], rest, value);
  const next: JsonObject = { ...base };
  if (child === undefined) delete next[key]; else next[key] = child;
  const fixed = reconcile(view, current, next, key);
  // 写空了的可选对象一并去掉，文档里不留 {}。
  return Object.keys(fixed).length === 0 && rest.length + 1 >= 1 && value === undefined ? undefined : fixed;
}

const additionalView = (fragments: readonly Schema[]) => fragments.flatMap((fragment) => (isObject(fragment['additionalProperties']) ? [fragment['additionalProperties']] : []));

/** 文档改一个元素：沿路径复制，别的内容原样。 */
function replaceElement(document: JsonObject, located: NonNullable<ReturnType<typeof elementAt>>, next: JsonObject): JsonObject {
  const replaceIn = (node: JsonObject): JsonObject => {
    if (node === located.element) return next;
    if (!Array.isArray(node['children'])) return node;
    const children = node['children'] as unknown[];
    const mapped = children.map((child) => (isObject(child) ? replaceIn(child) : child));
    return mapped.every((child, index) => child === children[index]) ? node : { ...node, children: mapped };
  };
  return { ...document, artboard: replaceIn(document['artboard'] as JsonObject) };
}

/** 改了排布方式之后，子元素的 place 只留新方式认识的键；网格要的行列按顺序补上。 */
function fitChildren(element: JsonObject): JsonObject {
  if (!Array.isArray(element['children'])) return element;
  const mode = modeOf(element), schema = resolved({ $ref: `#/$defs/${PLACE[mode] ?? 'placeInFree'}` }), keys = Object.keys(schema['properties'] as object);
  const columns = isObject(element['layout']) && Array.isArray(element['layout']['columns']) ? Math.max(1, element['layout']['columns'].length) : 1;
  return {
    ...element,
    children: (element['children'] as unknown[]).map((child, index) => {
      if (!isObject(child)) return child;
      const place = isObject(child['place']) ? child['place'] : {};
      const kept = Object.fromEntries(Object.entries(place).filter(([key]) => keys.includes(key)));
      if (mode === 'grid') { kept['row'] ??= Math.floor(index / columns) + 1; kept['column'] ??= (index % columns) + 1; }
      const { place: _place, ...rest } = child;
      return Object.keys(kept).length ? { ...rest, place: kept } : rest;
    }),
  };
}

/**
 * 写回：把元素的 fieldPath 改成 value（undefined 是去掉），返回新文档，原文档不变。
 * 只改这一处和因它失效的相邻属性；值合不合法由页面按 Editor 的限制拦下，问题清单由服务端说明。
 */
export function writeProperty(document: JsonObject, path: string, fieldPath: FieldPath, value: unknown): JsonObject {
  const target = elementView(document, path), located = elementAt(document, path);
  if (!target || !located) return document;
  let next = setAt(target.view, target.element, fieldPath, value) as JsonObject;
  if (fieldPath[0] === 'layout') next = fitChildren(next);
  // 变成必填的字体（条码显示文字）没有合法的缺省值：取模板里已经在用的字体，没有时留给问题清单。
  if (next['font'] === RESOURCE_PLACEHOLDER) {
    const font = firstFont(document);
    if (font) next = { ...next, font };
  }
  return replaceElement(document, located, next);
}

function firstFont(document: JsonObject): string | undefined {
  const walk = (node: unknown): string | undefined => {
    if (!isObject(node)) return undefined;
    if (typeof node['font'] === 'string' && node['font'] !== RESOURCE_PLACEHOLDER) return node['font'];
    for (const child of Array.isArray(node['children']) ? node['children'] : []) {
      const found = walk(child);
      if (found) return found;
    }
    return undefined;
  };
  return walk(document['artboard']);
}

/** 约束之外的数字缺省值（补上的 0、改小的上限）收进范围。 */
function fitDefault(parameter: unknown): unknown {
  if (!isObject(parameter) || parameter['type'] !== 'number' || typeof parameter['default'] !== 'number' || !isObject(parameter['constraints'])) return parameter;
  const { min, max } = parameter['constraints'];
  let value = parameter['default'];
  if (typeof min === 'number' && value < min) value = min;
  if (typeof max === 'number' && value > max) value = max;
  return value === parameter['default'] ? parameter : { ...parameter, default: value };
}

export function writeListItem(document: JsonObject, list: TemplateList, index: number, fieldPath: FieldPath, value: unknown): JsonObject {
  const items = [...listOf(document, list)];
  const next = setAt([DEFS[LISTS[list]]!], items[index], fieldPath, value);
  items[index] = fieldPath[0] === 'default' ? next : fitDefault(next);
  return { ...document, [list]: items };
}
