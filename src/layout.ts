/**
 * 排版：测量、决定、记录（M99）。绘制是第四步，在 draw.ts 中只按这里的记录执行。
 *
 * - 测量：取每段文字的字形、前进宽度与行框。
 * - 决定：按布局方式算出每个元素的位置与尺寸（毫米），以及文字在框内的位置。
 * - 记录：生成布局摘要与绘制指令；布局摘要在绘制前就已完整。
 */
import { formatElementPath } from './element-path.js';
import type { EvaluatedTemplate, EvaluatedText } from './evaluate.js';
import type { RenderRequest } from './request.js';
import type { FreePlace } from './template.js';
import type { FontStore } from './text/fonts.js';
import { shapeLine, type ShapedLine } from './text/shape.js';
import { mmToPx, roundMm } from './units.js';

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

/** 布局摘要中的一个元素。位置是相对画板左上角的毫米数。 */
export interface LayoutNode {
  readonly path: string;
  readonly name: string;
  readonly type: 'artboard' | 'text';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly text?: {
    readonly content: string;
    readonly font: string;
    /** 最终字号，毫米。 */
    readonly fontSize: number;
    /** 文字实际占用的宽度，毫米。 */
    readonly width: number;
  };
  readonly children?: readonly LayoutNode[];
}

export type DrawOp =
  | { readonly op: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly fill: string }
  | {
      readonly op: 'glyphs';
      readonly path: string;
      readonly font: string;
      readonly fontSize: number;
      readonly color: string;
      /** 基线起点，毫米。 */
      readonly x: number;
      readonly y: number;
      readonly glyphs: readonly number[];
      /** 每个字形相对基线起点的位置，按 x、y 交替排列，毫米。 */
      readonly positions: readonly number[];
    };

export interface LayoutResult {
  readonly summary: LayoutSummary;
  readonly drawOps: readonly DrawOp[];
}

/** 字体须已由 FontStore 加载；加载失败的文本元素不画，只在布局摘要中记录框。 */
export function layout(evaluated: EvaluatedTemplate, output: RenderRequest['output'], fonts: FontStore): LayoutResult {
  const artboard = evaluated.template.artboard;
  const drawOps: DrawOp[] = [];
  if (artboard.fill) {
    drawOps.push({ op: 'rect', x: 0, y: 0, width: output.width, height: output.height, fill: artboard.fill });
  }

  const children = evaluated.children.map((child) => layoutText(child, output, fonts, drawOps));
  const root: LayoutNode = {
    path: formatElementPath(artboard.path),
    name: evaluated.template.name,
    type: 'artboard',
    x: 0,
    y: 0,
    width: roundMm(output.width),
    height: roundMm(output.height),
    visible: true,
    children,
  };
  return {
    summary: {
      template: evaluated.template.name,
      output: {
        width: output.width,
        height: output.height,
        dpi: output.dpi,
        widthPx: mmToPx(output.width, output.dpi),
        heightPx: mmToPx(output.height, output.dpi),
        format: output.format,
      },
      root,
    },
    drawOps,
  };
}

function layoutText(
  element: EvaluatedText,
  container: { width: number; height: number },
  fonts: FontStore,
  drawOps: DrawOp[],
): LayoutNode {
  const { model, text } = element;
  const path = formatElementPath(model.path);

  // 测量
  const font = fonts.get(model.font);
  const line: ShapedLine | undefined = font && shapeLine(fonts, font, text, model.fontSize);
  const naturalWidth = line?.width ?? 0;
  const naturalHeight = line ? line.ascent + line.descent : model.fontSize;

  // 决定
  const box = placeFree(model.place, container, { width: naturalWidth, height: naturalHeight });
  if (line && line.glyphs.length > 0) {
    const offsetX =
      model.horizontalAlign === 'start' ? 0 : model.horizontalAlign === 'center' ? (box.width - line.width) / 2 : box.width - line.width;
    const lineHeight = line.ascent + line.descent;
    const offsetY =
      model.verticalAlign === 'top' ? 0 : model.verticalAlign === 'center' ? (box.height - lineHeight) / 2 : box.height - lineHeight;

    // 记录
    drawOps.push({
      op: 'glyphs',
      path,
      font: model.font,
      fontSize: model.fontSize,
      color: model.color,
      x: box.x + offsetX,
      y: box.y + offsetY + line.ascent,
      glyphs: line.glyphs,
      positions: line.offsets.flatMap((offset) => [offset, 0]),
    });
  }

  return {
    path,
    name: model.name,
    type: 'text',
    x: roundMm(box.x),
    y: roundMm(box.y),
    width: roundMm(box.width),
    height: roundMm(box.height),
    visible: true,
    text: { content: text, font: `res:${model.font}`, fontSize: roundMm(model.fontSize), width: roundMm(naturalWidth) },
  };
}

/** 自由布局：宽高取固定值或内容尺寸；横向按距左或距右、纵向按距上或距下定位（M93）。 */
function placeFree(
  place: FreePlace,
  container: { width: number; height: number },
  content: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const width = place.width.kind === 'fixed' ? place.width.value : content.width;
  const height = place.height.kind === 'fixed' ? place.height.value : content.height;
  const x = place.horizontal.edge === 'left' ? place.horizontal.offset : container.width - place.horizontal.offset - width;
  const y = place.vertical.edge === 'top' ? place.vertical.offset : container.height - place.vertical.offset - height;
  return { x, y, width, height };
}
