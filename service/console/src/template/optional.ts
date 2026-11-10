/**
 * 检查器显示哪些属性（模板设计页第三轮票据 05，M396）：每种元素一份"常用属性"表，常用的、必填的与写了的总是显示，
 * 其余的收进"+ 属性"，加一项写它的初值，去掉一项删掉这个键。纯函数，不碰页面与接口。
 * 字段仍由 properties.ts 按 Schema 生成，这里只决定显示哪些：Schema 加了属性，它自动出现在"+ 属性"里；
 * 要它一直显示，就把键加进下面的表。
 */
import type { PropertyField, PropertyPanel } from './properties.js';

/** 位置与尺寸：父容器是哪种排布，就只会出现其中那几项。自身对齐、最小最大宽高与旋转不常用。 */
const PLACE = [
  'place.left', 'place.right', 'place.top', 'place.bottom', 'place.width', 'place.height', 'place.margin',
  'place.row', 'place.column', 'place.rowSpan', 'place.columnSpan',
];
const SHOWN = ['visible', 'opacity'];
/** 状态样式有自己的一栏（票据 17），不从"+ 属性"加。 */
const element = (...keys: readonly string[]): readonly string[] => ['name', ...keys, ...PLACE, ...SHOWN, 'states'];

/**
 * 常用属性：键是元素类型（画板是 artboard），值是字段的 key。表里没有的类型全部显示。
 * 没法给初值的项（列表、传入参数、要人挑的变量）不进"+ 属性"，写不写在表里都一直显示。
 */
export const COMMON_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  artboard: ['sizeRange', 'size', 'minFontSize', 'layout', 'padding'],
  container: element('layout', 'padding', 'fill'),
  loop: element('list', 'template', 'mergeBy', 'args', 'itemLayout'),
  call: element('template', 'data', 'args'),
  text: element('content', 'font', 'fontSize', 'letterSpacing', 'color', 'writingMode', 'horizontalAlign', 'verticalAlign', 'fit'),
  image: element('source', 'fit'),
  qrcode: element('content', 'errorCorrectionLevel', 'foreground'),
  barcode: element('content', 'format', 'showText', 'font', 'fontSize', 'foreground'),
  rect: element('fill', 'stroke', 'cornerRadius'),
  ellipse: element('fill', 'stroke'),
  line: element('from', 'to', 'stroke'),
  polygon: element('points', 'fill', 'stroke'),
  path: element('d', 'fill', 'stroke'),
};

/** 加上时不照 Schema 初值写的项：填充与背景从白色起，免得一加就把整块涂黑。 */
const INITIALS: Readonly<Record<string, unknown>> = { fill: '#FFFFFF', background: '#FFFFFF' };

const isSwitch = (field: PropertyField): boolean => {
  const { editor } = field;
  if (editor.kind === 'variants') return editor.bindable?.type === 'boolean';
  return editor.kind === 'choice' && editor.options.length > 0 && editor.options.every((option) => typeof option.value === 'boolean');
};

/** 这一处在图上的实际尺寸（mm）。 */
export interface MeasuredBox { readonly width: number; readonly height: number }

/** 最小、最大宽高从这一处的实际尺寸起（最小往下取、最大往上取到 0.01），加上之后画面不变；写 0 的话最大宽高会把元素压没。 */
const LIMITS: Readonly<Record<string, readonly ['width' | 'height', 'floor' | 'ceil']>> = {
  'place.minWidth': ['width', 'floor'], 'place.maxWidth': ['width', 'ceil'], 'place.minHeight': ['height', 'floor'], 'place.maxHeight': ['height', 'ceil'],
};

/**
 * 从"+ 属性"加这一项时写的值；说不出初值的（文字、列表、键值表）是 undefined，这种项不进菜单。
 * 开关写成和缺省相反（加"裁剪"就是打开）；别的有缺省值就写缺省值，画面不变，由人接着改。
 */
export function addedValue(field: PropertyField, box?: MeasuredBox): unknown {
  if (field.key in INITIALS) return INITIALS[field.key];
  const limit = LIMITS[field.key];
  if (limit && box) {
    // 1e-6：量出来的 12.340000001 不该往上取成 12.35。
    const [axis, round] = limit, scaled = box[axis] * 100;
    return Math.max(0, round === 'ceil' ? Math.ceil(scaled - 1e-6) : Math.floor(scaled + 1e-6)) / 100;
  }
  const { editor } = field;
  if (isSwitch(field)) return field.fallback !== true;
  switch (editor.kind) {
    case 'group': return editor.initial;
    case 'variants': return field.fallback ?? (editor.bindable ? editor.bindable.initial : editor.variants[0]?.initial);
    case 'choice': return field.fallback ?? editor.options[0]?.value;
    case 'number': return field.fallback ?? (editor.exclusiveMin !== undefined ? editor.exclusiveMin + 1 : editor.min ?? 0);
    case 'color': return field.fallback ?? '#000000';
    default: return undefined;
  }
}

/** 菜单上的名称：去掉单位（"旋转（度）"写成"旋转"）。 */
export const menuLabel = (field: PropertyField): string => field.label.replace(/（[^（）]*）$/u, '');

export interface AddableProperty {
  readonly field: PropertyField;
  readonly label: string;
  /** 加上时写的值。 */
  readonly value: unknown;
  /** 还缺这几个属性（dependentRequired），先加它们；值是显示名称。 */
  readonly needs?: readonly string[];
}

export interface PanelSplit {
  /** 显示的分组与字段，顺序同面板；一项都不显示的分组不在里面。 */
  readonly groups: PropertyPanel['groups'];
  /** "+ 属性"里的项，顺序同面板。 */
  readonly addable: readonly AddableProperty[];
  /** 行尾可以"去掉"的字段 key：从菜单来的、现在显示着的。 */
  readonly removable: ReadonlySet<string>;
}

export interface SplitOptions {
  /** 状态样式模式：这个取值下能覆盖的顶层键。给了就只有它们能加，去掉改由"重置为自身属性"。 */
  readonly overridable?: readonly string[];
  /** 人刚清空、还在改的项：值没了也先留着这一行。 */
  readonly pinned?: ReadonlySet<string>;
  /** 这一处的实际尺寸：最小、最大宽高的初值从它起。 */
  readonly box?: MeasuredBox;
}

/** 这一项会不会收进"+ 属性"：可选、不在常用表里、当前写法下可用、说得出初值。 */
function optional(field: PropertyField, common: ReadonlySet<string>): boolean {
  return !field.required && !common.has(field.key) && field.blocked === undefined && addedValue(field) !== undefined;
}

/** 把面板分成显示的与收进"+ 属性"的。 */
export function splitPanel(panel: PropertyPanel, options: SplitOptions = {}): PanelSplit {
  const table = COMMON_PROPERTIES[panel.type];
  if (!table) return { groups: panel.groups, addable: [], removable: new Set() };
  const common = new Set(table), labels = new Map(panel.groups.flatMap((group) => group.fields.map((field) => [String(field.path.at(-1)), menuLabel(field)] as const)));
  const addable: AddableProperty[] = [], removable = new Set<string>();
  const groups = panel.groups.flatMap((group) => {
    const fields = group.fields.filter((field) => {
      const written = field.value !== undefined;
      if (!optional(field, common)) return written || field.blocked === undefined;
      if (written || options.pinned?.has(field.key)) {
        if (!options.overridable) removable.add(field.key);
        return true;
      }
      if (!options.overridable || options.overridable.includes(String(field.path[0]))) {
        addable.push({ field, label: menuLabel(field), value: addedValue(field, options.box),...(field.needs?.length ? { needs: field.needs.map((key) => labels.get(key) ?? key) } : {}) });
      }
      return false;
    });
    return fields.length ? [{ name: group.name, fields }] : [];
  });
  return { groups, addable, removable };
}
