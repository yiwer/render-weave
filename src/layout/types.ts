import type { Problem } from '../problems.js';
import type { RenderRequest } from '../request.js';
import type { NodeModel, ShapeStroke, TextElementModel } from '../template/model.js';

export interface LayoutSummary {
  readonly template: string;
  readonly output: {
    readonly width: number;
    readonly height: number;
    readonly dpi: number;
    readonly widthPx: number;
    readonly heightPx: number;
    readonly format: RenderRequest['output']['format'];
  };
  readonly root: LayoutNode;
}

/** 布局摘要中的一个元素。位置是相对画板左上角的毫米数（不计旋转）；隐藏的元素位置与尺寸为 0。 */
export interface LayoutNode {
  readonly path: string;
  readonly name: string;
  readonly type: NodeModel['type'];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly text?: TextSummary;
  readonly image?: ImageSummary;
  readonly children?: readonly LayoutNode[];
}

export interface ImageSummary {
  readonly source: string;
  readonly fit: 'contain' | 'cover' | 'fill';
  /** 图片的像素尺寸。 */
  readonly naturalWidth: number;
  readonly naturalHeight: number;
  /** 图片实际画出的区域，毫米；完整显示时可能小于元素框，铺满裁剪时等于元素框。 */
  readonly drawn: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface TextSummary {
  /** 有替代时为 true；未替代时省略。具体原字体与实际字体见 fragments。 */
  readonly fontFallback?: true;
  /** 一次出图内的缩字组名称；字号是全组统一重排后的值。 */
  readonly shrinkGroup?: string;
  readonly content: string;
  readonly font: string;
  readonly writingMode: TextElementModel['writingMode'];
  /** 最终字号，毫米。 */
  readonly fontSize: number;
  /** 文字实际占用的宽与高，毫米；横排的宽包含倾斜带来的外扩，竖排两端分布时高度是首字墨迹顶到末字墨迹底。 */
  readonly width: number;
  readonly height: number;
  /** 字距，毫米：横排分布是相邻墨迹的间隔（spaceEvenly 两侧也留同样间隔），竖排是相邻字格之间的空白。 */
  readonly spacing: number;
  /** 沿书写方向的压缩比，1 为不压缩。 */
  readonly compression: number;
  /** 按适配规则处理后仍放不下。 */
  readonly overflow: boolean;
  /** 各片段求值后的文字与合并后的样式。 */
  readonly fragments: readonly FragmentSummary[];
}

export interface FragmentSummary {
  /** 成功替代前的资源引用，font 为实际使用的后备字体。 */
  readonly sourceFont?: string;
  readonly text: string;
  readonly font: string;
  readonly fontSize: number;
  readonly color: string;
  /** 倾斜角度，度。 */
  readonly slant: number;
}

/** 四角圆角：左上、右上、右下、左下，毫米。 */
export type Radii = readonly [number, number, number, number];

/** 绘制指令：坐标与尺寸都是毫米，相对画板左上角；按顺序执行，后画的在上面（M72）。 */
export type DrawOp =
  | {
      readonly op: 'save';
      /** 小于 1 时把之后到 restore 为止的内容作为一个整体半透明。 */
      readonly opacity?: number;
      readonly rotation?: { readonly degrees: number; readonly cx: number; readonly cy: number };
      readonly clip?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radii: Radii };
    }
  | { readonly op: 'restore' }
  | {
      readonly op: 'rect';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly radii: Radii;
      readonly fill?: string;
      /** 画在框内。 */
      readonly stroke?: ShapeStroke;
    }
  | {
      readonly op: 'ellipse';
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly fill?: string;
      /** 画在框内。 */
      readonly stroke?: ShapeStroke;
    }
  | {
      readonly op: 'path';
      /** 路径坐标的原点：元素框左上角。 */
      readonly x: number;
      readonly y: number;
      readonly d: string;
      readonly fillRule: 'nonzero' | 'evenodd';
      readonly fill?: string;
      /** 以轮廓为中线。 */
      readonly stroke?: ShapeStroke;
    }
  | {
      readonly op: 'image';
      readonly path: string;
      /** 图片资源 ID。 */
      readonly image: string;
      /** 取图片中的哪一块，像素。 */
      readonly src: Box;
      /** 画到哪里，毫米，相对画板。 */
      readonly dst: Box;
    }
  | {
      readonly op: 'glyphs';
      readonly path: string;
      readonly font: string;
      readonly fontSize: number;
      /** 字形的横向与纵向缩放；沿书写方向压缩，另一方向保持 1。 */
      readonly scaleX: number;
      readonly scaleY: number;
      /** 以基线为轴的错切：基线以上每单位高度向右移 skew；横排为 tan θ × scaleX（M117）。 */
      readonly skew: number;
      /** 填充色；没有时只画描边。一个文本的描边全部画完再画填充，免得后面片段的描边盖住前面的字（M108）。 */
      readonly color?: string;
      readonly stroke?: { readonly color: string; readonly width: number };
      readonly glyphs: readonly number[];
      /** 每个字形的基线起点，按 x、y 交替排列，毫米，相对画板。 */
      readonly positions: readonly number[];
    };

export interface LayoutResult {
  readonly summary: LayoutSummary;
  readonly drawOps: readonly DrawOp[];
  readonly problems: readonly Problem[];
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** 浮点误差容差，毫米。 */
export const EPSILON = 1e-6;
