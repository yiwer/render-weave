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
  readonly children?: readonly LayoutNode[];
}

export interface TextSummary {
  readonly content: string;
  readonly font: string;
  readonly writingMode: TextElementModel['writingMode'];
  /** 最终字号，毫米。 */
  readonly fontSize: number;
  /** 文字实际占用的宽与高，毫米；竖排两端分布时高度是首字墨迹顶到末字墨迹底。 */
  readonly width: number;
  readonly height: number;
  /** 字距：相邻字格之间的空白，毫米。 */
  readonly spacing: number;
  /** 沿书写方向的压缩比，1 为不压缩。 */
  readonly compression: number;
  /** 按适配规则处理后仍放不下。 */
  readonly overflow: boolean;
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
      readonly op: 'glyphs';
      readonly path: string;
      readonly font: string;
      readonly fontSize: number;
      /** 字形的横向与纵向缩放；竖排压缩时 scaleY 小于 1。 */
      readonly scaleX: number;
      readonly scaleY: number;
      readonly color: string;
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
