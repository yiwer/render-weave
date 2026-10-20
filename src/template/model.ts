/**
 * 模板模型：模板 DSL（renderweave-template/1）解析后的类型。长度单位一律为毫米。
 * 元素目录见 docs/model/template-elements.md；写法见 docs/examples/m402-dsl/README.md。
 */
import type { DisplayFormat } from '../display-format.js';
import type { ElementPath } from '../element-path.js';
import type { StaticSchemaRef } from '../workspace.js';
import type { BasicKind } from './types.js';

export interface Range {
  readonly min: number;
  readonly max: number;
}

/**
 * 解析后的模板。画板是静态读取的结果：绑定处为占位值，只用于检查与隐藏元素的定位；
 * 出图时按作用域重新读取画板文档（evaluate.ts），绑定与状态样式在那时取值。
 */
export interface TemplateModel {
  readonly name: string;
  readonly base: StaticSchemaRef;
  readonly parameters: readonly ParameterModel[];
  readonly derived: readonly DerivedModel[];
  readonly checks: readonly CheckModel[];
  readonly artboard: ArtboardModel;
  /** 画板文档原文，求值时重新读取。 */
  readonly artboardDocument: Record<string, unknown>;
  /** 静态读取时记下的变量引用：绑定、插槽与状态样式，供模板静态检查。 */
  readonly uses: readonly VariableUse[];
  /** 全部调用声明，包含隐藏元素与状态样式的各分支，供调用图检查。 */
  readonly calls: readonly (LoopModel | CallModel)[];
  /** 静态读取得到的元素模型，按元素文档查找；求值时隐藏的元素直接用它。 */
  readonly staticElements: WeakMap<object, ElementModel>;
}

// ---------- 模板变量 ----------

/** 模板参数（M15）：对外参数可由调用方填写，没有缺省值时必须提供；内部参数只由设计者设定，必须有缺省值。 */
export interface ParameterModel {
  readonly name: string;
  readonly displayName: string;
  readonly visibility: 'public' | 'internal';
  readonly type: BasicKind;
  readonly constraints: ParameterConstraints;
  /** 缺省值，已按类型规范化（颜色为 #RRGGBBAA）。 */
  readonly default?: string | number | boolean;
}

export interface ParameterConstraints {
  readonly integer?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly (string | number)[];
}

/** 派生变量（M3、M8、M23–M25、M78）：一个运算，结果类型必须声明；引用类型还要写明静态数据定义。 */
export interface DerivedModel {
  readonly name: string;
  readonly displayName: string;
  readonly type: BasicKind | 'ref';
  readonly ref?: StaticSchemaRef;
  readonly operation: Operation;
}

export type ArithmeticOp = 'add' | 'subtract' | 'multiply' | 'divide' | 'mod';
export type ItemPosition = 'first' | 'last' | { readonly index: Operand };

export type Operation =
  | {
      /** 条件分支：按序取首个命中的分支，都不命中取"否则"。 */
      readonly op: 'branch';
      readonly branches: readonly { readonly when: Condition; readonly then: Operand }[];
      readonly otherwise: Operand;
    }
  | {
      /** 取项：首项、末项或第 N 项（从 1 开始），超出范围得空值。 */
      readonly op: 'pickItem';
      readonly list: VarOperand;
      readonly position: ItemPosition;
    }
  | {
      /** 按分隔符拆取文本片段（M251）：首段、末段或第 N 段（从 1 开始），越界、缺值或分隔符未出现时返回空文本。 */
      readonly op: 'splitPart';
      readonly of: VarOperand;
      readonly format?: DisplayFormat;
      readonly delimiter: string | VarOperand;
      readonly position: ItemPosition;
    }
  | { readonly op: 'length'; readonly of: VarOperand }
  | { readonly op: ArithmeticOp; readonly left: Operand; readonly right: Operand };

export type CompareOp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge' | 'empty' | 'notEmpty';

/** 结构化比较（S11）：empty、notEmpty 只有左侧。 */
export interface Comparison {
  readonly left: Operand;
  readonly op: CompareOp;
  readonly right?: Operand;
}

/** 分支条件：单个比较，或单层 all（全部成立）/ any（任一成立）复合条件（M251）。 */
export type Condition =
  | Comparison
  | { readonly all: readonly Comparison[] }
  | { readonly any: readonly Comparison[] };

export function comparisonsOf(condition: Condition): readonly Comparison[] {
  if ('all' in condition) return condition.all;
  if ('any' in condition) return condition.any;
  return [condition];
}

export interface VarOperand {
  readonly var: string;
}

/** 运算数：变量（路径可经过单引用）或固定值。 */
export type Operand = VarOperand | { readonly value: string | number | boolean };

/** 检查项（M25）：问题条件为真时，按等级与提示文字记入问题清单。 */
export interface CheckModel {
  readonly name: string;
  readonly problemWhen: Operand;
  readonly level: 'severe' | 'hint';
  readonly message: string;
}

/** 静态读取时记下的一处变量引用。 */
export type VariableUse =
  | {
      /** 绑定：属性取值交给变量，类型必须一致（M71）。 */
      readonly use: 'binding';
      readonly var: string;
      readonly expected: 'color' | 'number' | 'boolean' | 'image' | 'text';
      readonly element: ElementPath;
      readonly label: string;
    }
  | { readonly use: 'slot'; readonly var: string; readonly format?: DisplayFormat; readonly element: ElementPath }
  | {
      /** 状态样式：按变量取值选用的覆盖；keys 是列出的取值。 */
      readonly use: 'state';
      readonly var: string;
      readonly keys: readonly string[];
      readonly element: ElementPath;
    };

/** 画板：模板的根，与容器一样有布局方式与外观，另有适用尺寸范围。实际尺寸由渲染请求给出。 */
export interface ArtboardModel extends ContainerBody {
  readonly type: 'artboard';
  readonly name: string;
  readonly path: ElementPath;
  readonly sizeRange: { readonly width: Range; readonly height: Range };
}

export type ElementModel = ContainerModel | TextElementModel | ImageModel | QrCodeModel | BarcodeModel | ShapeModel | LoopModel | CallModel;
export type ShapeModel = RectModel | EllipseModel | LineModel | PolygonModel | PathModel;
export type NodeModel = ArtboardModel | ElementModel;

/** 所有元素共有的属性（元素目录第二节）。 */
export interface ElementBase {
  readonly name: string;
  readonly path: ElementPath;
  readonly place: Place;
  readonly visible: boolean;
  /** 0–1，作用于元素及其子元素整体。 */
  readonly opacity: number;
  /** 绕元素框中心顺时针旋转的角度；只影响绘制，不影响布局。 */
  readonly rotation: number;
}

/** 元素在所在容器中的位置与尺寸；哪些属性可用取决于容器的布局方式（元素目录第三节）。 */
export interface Place {
  /** 自由布局：横向距左或距右、纵向距上或距下（M93）。 */
  readonly horizontal: { readonly edge: 'left' | 'right'; readonly offset: number };
  readonly vertical: { readonly edge: 'top' | 'bottom'; readonly offset: number };
  /** 网格布局：所在行、列（从 1 编号，M90 S10）与跨行、跨列数。 */
  readonly row: number;
  readonly column: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  /** 未写时按容器取缺省：网格为填满，堆叠与自由为随内容。 */
  readonly width?: SizeSpec;
  readonly height?: SizeSpec;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly margin: Edges;
  /** 网格：格内水平位置。 */
  readonly justifySelf?: Align;
  /** 堆叠：交叉方向位置；网格：格内垂直位置。 */
  readonly alignSelf?: Align;
}

export type Align = 'start' | 'center' | 'end';

/** 固定、随内容或填满；填满时可带分配权重（堆叠主方向上生效）。 */
export type SizeSpec =
  | { readonly kind: 'fixed'; readonly value: number }
  | { readonly kind: 'hug' }
  | { readonly kind: 'fill'; readonly weight: number };

export interface Edges {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface Corners {
  readonly topLeft: number;
  readonly topRight: number;
  readonly bottomRight: number;
  readonly bottomLeft: number;
}

/** 颜色统一为 `#RRGGBBAA`。 */
export type Color = string;

/** 图形与容器的描边。矩形、椭圆与容器的描边画在框内；线条、多边形与路径的描边以轮廓为中线（M110）。 */
export interface ShapeStroke {
  readonly color: Color;
  readonly width: number;
  /** 虚线的实、空长度交替，毫米；不写为实线。 */
  readonly dash?: readonly number[];
  readonly cap: 'butt' | 'round' | 'square';
}

export type Layout =
  | { readonly mode: 'free' }
  | {
      readonly mode: 'stack';
      readonly direction: 'row' | 'column';
      readonly gap: number;
      readonly wrap: boolean;
      readonly crossGap: number;
      /** 主方向分布：靠前、居中、靠后、两端、均分。 */
      readonly justifyContent: 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceEvenly';
      /** 交叉方向对齐。 */
      readonly alignItems: Align;
    }
  | {
      readonly mode: 'grid';
      readonly rows: readonly Track[];
      readonly columns: readonly Track[];
      readonly rowGap: number;
      readonly columnGap: number;
    };

/** 网格的行或列：固定毫米、按比例分剩余空间，或随内容。 */
export type Track =
  | { readonly kind: 'fixed'; readonly value: number }
  | { readonly kind: 'fraction'; readonly value: number }
  | { readonly kind: 'hug' };

export interface ContainerBody {
  readonly layout: Layout;
  readonly padding: Edges;
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
  readonly cornerRadius: Corners;
  /** 是否裁剪超出容器框的内容。 */
  readonly clip: boolean;
  readonly children: readonly ElementModel[];
}

export interface ContainerModel extends ElementBase, ContainerBody {
  readonly type: 'container';
}

export type LoopInfoKey = 'index' | 'isFirst' | 'isLast' | 'count' | 'groupSize';
export type CallArgument = Operand | { readonly loop: LoopInfoKey };
export type CallData = VarOperand | 'current' | 'none';

export interface CallModel extends ElementBase {
  readonly type: 'call';
  readonly template: string;
  readonly data: CallData;
  readonly args: Readonly<Record<string, CallArgument>>;
}

export interface LoopSlice {
  readonly start?: number;
  readonly end?: number;
}

export interface LoopModel extends ElementBase, Omit<ContainerBody, 'children' | 'layout'> {
  readonly type: 'loop';
  readonly list: VarOperand;
  /** 是否反序排列（缺省 false，M252）。 */
  readonly reverse: boolean;
  /** 1-based 闭区间切片（M252）。 */
  readonly slice?: LoopSlice;
  /** 列表项中的基本类型字段路径，连续同值项合并，以首项作为被调模板的数据。 */
  readonly mergeBy?: string;
  readonly template: string;
  readonly args: Readonly<Record<string, CallArgument>>;
  /** 横向用 widths 定每项宽度、高度填满（wrap 为 true 时取自然尺寸）；纵向用 heights 定每项高度、宽度填满（M236、M252、M253）。 */
  readonly itemLayout: {
    readonly direction: 'row';
    readonly widths: LoopItemSize;
    readonly gap: number;
    readonly wrap: boolean;
    readonly crossGap: number;
    readonly spanBy?: 'groupSize';
  } | {
    readonly direction: 'column';
    readonly heights: LoopItemSize;
    readonly gap: number;
    readonly wrap: boolean;
    readonly crossGap: number;
    readonly spanBy?: 'groupSize';
  };
}

export type LoopItemSize = 'equal' | 'content' | { readonly fixed: number };

export interface TextElementModel extends ElementBase {
  readonly type: 'text';
  readonly content: readonly ContentItem[];
  /** 字体资源 ID。字重随字体资源：一个字体资源是一个字重的字体文件，换字重即换字体资源（M115）。 */
  readonly font: string;
  /** 字号，毫米（em 框的高度）。 */
  readonly fontSize: number;
  /** 常态字间距，毫米，可正可负，缺省 0（M255）。 */
  readonly letterSpacing: number;
  readonly color: Color;
  /** 倾斜角度，度；正值向右倾，以错切变换模拟（M80、M117）。只用于横排。 */
  readonly slant: number;
  readonly writingMode: 'horizontal' | 'vertical';
  /** 横排可按墨迹两端分布（distribute）或同间隔分布（spaceEvenly，含两侧留白）；竖排只取 Align。 */
  readonly horizontalAlign: Align | 'distribute' | 'spaceEvenly';
  /** distribute（两端分布）只用于竖排：首字墨迹贴顶、末字墨迹贴底、中间均分。 */
  readonly verticalAlign: 'top' | 'center' | 'bottom' | 'distribute';
  readonly fit: TextFit;
  readonly stroke?: TextStroke;
  /** 文字在元素框内的留白。 */
  readonly padding: Edges;
}

/** 文本内容片段：文字，或绑定变量的插槽；可单独设样式，未设的沿用文本元素的设置（M73）。 */
export type ContentItem = TextFragmentModel | SlotModel;

export interface TextFragmentModel {
  readonly kind: 'text';
  readonly text: string;
  /** 求值时记录的草稿占位，正式内容始终取 text；不属于 DSL。 */
  readonly placeholder?: string;
  readonly style: FragmentStyle;
}

/** 变量插槽：绑定数据字段、参数或派生变量，路径用"."经过单引用（M90 S2）。 */
export interface SlotModel {
  readonly kind: 'slot';
  readonly path: string;
  /** 展示格式；不写时按类型的默认写法输出。 */
  readonly format?: DisplayFormat;
  readonly style: FragmentStyle;
}

/** 片段单独设的样式；竖排文字的片段只能设颜色。 */
export interface FragmentStyle {
  readonly font?: string;
  readonly fontSize?: number;
  readonly color?: Color;
  readonly slant?: number;
}

/** 倾斜角度的上限，度。 */
export const MAX_SLANT = 45;

/** 文字放不下时的处理（M82、M84、M88、M109）。 */
export interface TextFit {
  /** 收紧字距：字距最小收到 0。两端分布时字距由框高决定、本来就不小于 0，这一步记录的是"压缩之前先收字距"的顺序。 */
  readonly tightenSpacing: boolean;
  /** 压缩字形：沿书写方向压缩，不低于 compressMin。 */
  readonly compressGlyphs: boolean;
  readonly compressMin: number;
  /** 横排完成压缩后，宽或高仍放不下时同比缩小本元素全部片段的字号。 */
  readonly shrink: boolean;
  /** 缩字下限：元素写了用元素的，否则用所在模板画板的，画板也没写时为 5 mm（M86、M238）。 */
  readonly minFontSize: number;
  readonly minFontSizeSource: 'default' | 'artboard' | 'element';
  /** 竖排按可用列宽缩字；组名在一次出图内共用，跨模板调用。 */
  readonly widthOverflow?: { readonly shrinkGroup: string; readonly minFontSize: number };
  /** 仍放不下时的问题等级。 */
  readonly onFail: 'severe' | 'hint';
}

/** 文字描边：画在填充之下，width 是字形外侧可见的宽度，毫米（M108）。 */
export interface TextStroke {
  readonly color: Color;
  readonly width: number;
}

/** 字形压缩的下限，模板只能设得更高（M88）。 */
export const MIN_COMPRESSION = 0.6;
/** 画板没写 minFontSize 时的缩字下限（M86）。 */
export const DEFAULT_MIN_FONT_SIZE = 5;
/** 画板 minFontSize 的最低值：八号字约 1.76 mm，再小的印刷文字基本读不了（M238）。 */
export const MIN_READABLE_FONT_SIZE = 1.5;

/**
 * 图片：来源为资源引用（M10）；适配方式为完整显示（contain）、铺满裁剪（cover）或拉伸（fill），
 * 前两者在元素框内居中。没有来源时不画内容。
 */
export interface ImageModel extends ElementBase {
  readonly type: 'image';
  /** 图片资源 ID。 */
  readonly source?: string;
  readonly fit: 'contain' | 'cover' | 'fill';
  /** 单色重染颜色（#RRGGBBAA，M257）。 */
  readonly tint?: Color;
}

/** 二维码使用 UTF-8 文本，码区保留四模块留白；尺寸由布局决定，不提供自然尺寸。 */
export interface QrCodeModel extends ElementBase {
  readonly type: 'qrcode';
  readonly content: string;
  readonly errorCorrectionLevel: 'L' | 'M' | 'Q' | 'H';
  readonly foreground: Color;
  readonly background: Color;
}

/** 与锁定编码器一致的输入上限，避免无界编码和文字测量；不是符号标准容量。 */
export const MAX_CODE128_LENGTH = 500;

export const BARCODE_FORMATS = ['CODE128', 'EAN-13', 'EAN-8', 'UPC-A'] as const;
export type BarcodeFormat = typeof BARCODE_FORMATS[number];

/** 条形码内容始终为原始文本；字体只用于独立的下方文字区域。 */
export interface BarcodeModel extends ElementBase {
  readonly type: 'barcode';
  readonly format: BarcodeFormat;
  readonly content: string;
  readonly foreground: Color;
  readonly background: Color;
  readonly showText: boolean;
  readonly font?: string;
  readonly fontSize: number;
}

export interface RectModel extends ElementBase {
  readonly type: 'rect';
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
  readonly cornerRadius: Corners;
}

export interface EllipseModel extends ElementBase {
  readonly type: 'ellipse';
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
}

export type ViewBox = readonly [number, number, number, number];
export type ShapeFit = 'fill' | 'contain' | 'cover';

/** 线条的起点与终点，毫米，相对元素框左上角；声明 viewBox 时随元素框缩放（M254）。 */
export interface LineModel extends ElementBase {
  readonly type: 'line';
  readonly from: Point;
  readonly to: Point;
  readonly stroke: ShapeStroke;
  readonly viewBox?: ViewBox;
  readonly fit: ShapeFit;
}

/** 多边形的顶点，毫米，相对元素框左上角；未声明 viewBox 时框变化不拉伸（M94），声明 viewBox 时随元素框缩放（M254）。 */
export interface PolygonModel extends ElementBase {
  readonly type: 'polygon';
  readonly points: readonly Point[];
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
  readonly viewBox?: ViewBox;
  readonly fit: ShapeFit;
}

/** 路径数据为 SVG 路径语法，毫米，相对元素框左上角；未声明 viewBox 时框变化不拉伸（M76、M94），声明 viewBox 时随元素框缩放（M254）。 */
export interface PathModel extends ElementBase {
  readonly type: 'path';
  readonly d: string;
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
  readonly fillRule: 'nonzero' | 'evenodd';
  readonly viewBox?: ViewBox;
  readonly fit: ShapeFit;
}

export type Point = readonly [number, number];
