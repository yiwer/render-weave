/**
 * 模板模型：模板 DSL（renderweave-template/1）解析后的类型。长度单位一律为毫米。
 * 元素目录见 docs/model/template-elements.md；写法见 docs/examples/m402-dsl/README.md。
 */
import type { DisplayFormat } from '../display-format.js';
import type { ElementPath } from '../element-path.js';
import type { StaticSchemaRef } from '../workspace.js';

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface TemplateModel {
  readonly name: string;
  readonly base: StaticSchemaRef;
  readonly artboard: ArtboardModel;
}

/** 画板：模板的根，与容器一样有布局方式与外观，另有适用尺寸范围。实际尺寸由渲染请求给出。 */
export interface ArtboardModel extends ContainerBody {
  readonly type: 'artboard';
  readonly name: string;
  readonly path: ElementPath;
  readonly sizeRange: { readonly width: Range; readonly height: Range };
}

export type ElementModel = ContainerModel | TextElementModel | ImageModel | ShapeModel;
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

export interface TextElementModel extends ElementBase {
  readonly type: 'text';
  readonly content: readonly ContentItem[];
  /** 字体资源 ID。字重随字体资源：一个字体资源是一个字重的字体文件，换字重即换字体资源（M115）。 */
  readonly font: string;
  /** 字号，毫米（em 框的高度）。 */
  readonly fontSize: number;
  readonly color: Color;
  /** 倾斜角度，度；正值向右倾，以错切变换模拟（M80、M117）。只用于横排。 */
  readonly slant: number;
  readonly writingMode: 'horizontal' | 'vertical';
  /** 横排时是文字在框内的水平位置；竖排时是整列在框内的水平位置。 */
  readonly horizontalAlign: Align;
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
  readonly style: FragmentStyle;
}

/** 变量插槽：本版本只绑定数据字段，路径用"."经过单引用（M90 S2）；参数与派生变量见票据 07。 */
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

/** 文字放不下时的处理（M82、M88、M109）。 */
export interface TextFit {
  /** 收紧字距：字距最小收到 0。两端分布时字距由框高决定、本来就不小于 0，这一步记录的是"压缩之前先收字距"的顺序。 */
  readonly tightenSpacing: boolean;
  /** 压缩字形：沿书写方向压缩，不低于 compressMin。 */
  readonly compressGlyphs: boolean;
  readonly compressMin: number;
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

/**
 * 图片：来源为资源引用（M10）；适配方式为完整显示（contain）、铺满裁剪（cover）或拉伸（fill），
 * 前两者在元素框内居中。没有来源时不画内容。
 */
export interface ImageModel extends ElementBase {
  readonly type: 'image';
  /** 图片资源 ID。 */
  readonly source?: string;
  readonly fit: 'contain' | 'cover' | 'fill';
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

/** 线条的起点与终点，毫米，相对元素框左上角。 */
export interface LineModel extends ElementBase {
  readonly type: 'line';
  readonly from: Point;
  readonly to: Point;
  readonly stroke: ShapeStroke;
}

/** 多边形的顶点，毫米，相对元素框左上角；框变化时不拉伸（M94）。 */
export interface PolygonModel extends ElementBase {
  readonly type: 'polygon';
  readonly points: readonly Point[];
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
}

/** 路径数据为 SVG 路径语法，毫米，相对元素框左上角；框变化时不拉伸（M76、M94）。 */
export interface PathModel extends ElementBase {
  readonly type: 'path';
  readonly d: string;
  readonly fill?: Color;
  readonly stroke?: ShapeStroke;
  readonly fillRule: 'nonzero' | 'evenodd';
}

export type Point = readonly [number, number];
