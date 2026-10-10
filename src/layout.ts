/**
 * 排版：测量、决定、记录（M99）。绘制是第四步，在 draw.ts 中只按这里的记录执行。
 *
 * - 测量：取每段文字的字形、前进宽度、墨迹边界与行框。
 * - 决定：按布局方式算出每个元素的位置与尺寸（毫米），文字的字距、压缩比与每个字形的位置；
 *   放不下时按 fit 的步骤处理，仍放不下记为问题。
 * - 记录：生成布局摘要与绘制指令；布局摘要在绘制前就已完整。
 */
import { formatElementPath } from './element-path.js';
import type { EvaluatedTemplate, EvaluatedText } from './evaluate.js';
import { ProblemCodes, type Problem } from './problems.js';
import type { RenderRequest } from './request.js';
import type { FreePlace, TextElementModel } from './template.js';
import type { FontStore } from './text/fonts.js';
import { measureText, type MeasuredText } from './text/shape.js';
import { layoutVertical, verticalOverflows } from './text/vertical.js';
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

export type DrawOp =
  | { readonly op: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly fill: string }
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

/** 浮点误差容差，毫米。 */
const EPSILON = 1e-6;

/** 字体须已由 FontStore 加载；加载失败的文本元素不画，只在布局摘要中记录框。 */
export function layout(evaluated: EvaluatedTemplate, output: RenderRequest['output'], fonts: FontStore): LayoutResult {
  const artboard = evaluated.template.artboard;
  const drawOps: DrawOp[] = [];
  const problems: Problem[] = [];
  if (artboard.fill) {
    drawOps.push({ op: 'rect', x: 0, y: 0, width: output.width, height: output.height, fill: artboard.fill });
  }

  const children = evaluated.children.map((child) => layoutText(child, output, fonts, drawOps, problems));
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
    problems,
  };
}

function layoutText(
  element: EvaluatedText,
  container: { width: number; height: number },
  fonts: FontStore,
  drawOps: DrawOp[],
  problems: Problem[],
): LayoutNode {
  const { model, text } = element;
  const path = formatElementPath(model.path);
  const node = (box: Box, summary?: TextSummary): LayoutNode => ({
    path,
    name: model.name,
    type: 'text',
    x: roundMm(box.x),
    y: roundMm(box.y),
    width: roundMm(box.width),
    height: roundMm(box.height),
    visible: true,
    ...(summary && { text: summary }),
  });

  // 测量
  const font = fonts.get(model.font);
  if (!font) return node(placeFree(model.place, container, { width: 0, height: model.fontSize }));
  const measured = measureText(fonts, font, text, model.fontSize);
  return model.writingMode === 'vertical'
    ? layoutVerticalText(model, text, measured, container, drawOps, problems, node)
    : layoutHorizontalText(model, text, measured, container, drawOps, problems, node);
}

function layoutHorizontalText(
  model: TextElementModel,
  text: string,
  measured: MeasuredText,
  container: { width: number; height: number },
  drawOps: DrawOp[],
  problems: Problem[],
  node: (box: Box, summary?: TextSummary) => LayoutNode,
): LayoutNode {
  const width = measured.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
  const height = measured.ascent + measured.descent;

  // 决定
  const box = placeFree(model.place, container, { width, height });
  const offsetX = model.horizontalAlign === 'start' ? 0 : model.horizontalAlign === 'center' ? (box.width - width) / 2 : box.width - width;
  const offsetY = model.verticalAlign === 'center' ? (box.height - height) / 2 : model.verticalAlign === 'bottom' ? box.height - height : 0;
  const overflow = width > box.width + EPSILON || height > box.height + EPSILON;
  if (overflow) {
    problems.push(
      overflowProblem(
        model,
        `文字"${text}"放不下：需要 ${fmt(width)} × ${fmt(height)} mm，元素框为 ${fmt(box.width)} × ${fmt(box.height)} mm`,
      ),
    );
  }

  // 记录
  const positions: number[] = [];
  let x = box.x + offsetX;
  const baseline = box.y + offsetY + measured.ascent;
  for (const glyph of measured.glyphs) {
    positions.push(x, baseline);
    x += glyph.advance;
  }
  pushGlyphs(drawOps, model, measured, positions, 1);
  return node(box, summarize(model, text, width, height, 0, 1, overflow));
}

function layoutVerticalText(
  model: TextElementModel,
  text: string,
  measured: MeasuredText,
  container: { width: number; height: number },
  drawOps: DrawOp[],
  problems: Problem[],
  node: (box: Box, summary?: TextSummary) => LayoutNode,
): LayoutNode {
  // 决定：随内容时，宽为一个字格，高为各字格相接的总高。
  const naturalHeight = measured.glyphs.length * (measured.ascent + measured.descent);
  const box = placeFree(model.place, container, { width: model.fontSize, height: naturalHeight });
  const vertical = layoutVertical(measured, {
    fontSize: model.fontSize,
    boxWidth: box.width,
    boxHeight: box.height,
    horizontalAlign: model.horizontalAlign,
    verticalAlign: model.verticalAlign,
    compressGlyphs: model.fit.compressGlyphs,
    compressMin: model.fit.compressMin,
  });
  const overflow = verticalOverflows(vertical, box.width, box.height);
  if (overflow) {
    const reasons: string[] = [];
    if (vertical.extent > box.height + EPSILON) {
      const tried = model.fit.compressGlyphs ? `字距收到 0、字形压到 ${Math.round(model.fit.compressMin * 100)}% 后` : '字距收到 0 后';
      reasons.push(`${tried}仍需高 ${fmt(vertical.extent)} mm，元素框高 ${fmt(box.height)} mm`);
    }
    if (vertical.columnWidth > box.width + EPSILON) {
      reasons.push(`字号 ${fmt(model.fontSize)} mm 比元素框宽 ${fmt(box.width)} mm 更宽`);
    }
    problems.push(overflowProblem(model, `竖排文字"${text}"放不下：${reasons.join('；')}`));
  }

  // 记录
  const positions = vertical.origins.flatMap((origin) => [box.x + origin.x, box.y + origin.y]);
  pushGlyphs(drawOps, model, measured, positions, vertical.compression);
  return node(
    box,
    summarize(model, text, vertical.columnWidth, vertical.extent, vertical.spacing, vertical.compression, overflow),
  );
}

function pushGlyphs(
  drawOps: DrawOp[],
  model: TextElementModel,
  measured: MeasuredText,
  positions: number[],
  compressionY: number,
): void {
  if (measured.glyphs.length === 0) return;
  drawOps.push({
    op: 'glyphs',
    path: formatElementPath(model.path),
    font: model.font,
    fontSize: model.fontSize,
    scaleX: 1,
    scaleY: compressionY,
    color: model.color,
    ...(model.stroke && { stroke: model.stroke }),
    glyphs: measured.glyphs.map((glyph) => glyph.id),
    positions,
  });
}

function summarize(
  model: TextElementModel,
  content: string,
  width: number,
  height: number,
  spacing: number,
  compression: number,
  overflow: boolean,
): TextSummary {
  return {
    content,
    font: `res:${model.font}`,
    writingMode: model.writingMode,
    fontSize: roundMm(model.fontSize),
    width: roundMm(width),
    height: roundMm(height),
    spacing: roundMm(spacing),
    compression: roundMm(compression),
    overflow,
  };
}

function overflowProblem(model: TextElementModel, message: string): Problem {
  return {
    code: ProblemCodes.layoutTextOverflow,
    level: model.fit.onFail,
    location: { kind: 'element', path: formatElementPath(model.path) },
    message,
  };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 自由布局：宽高取固定值或内容尺寸；横向按距左或距右、纵向按距上或距下定位（M93）。 */
function placeFree(place: FreePlace, container: { width: number; height: number }, content: { width: number; height: number }): Box {
  const width = place.width.kind === 'fixed' ? place.width.value : content.width;
  const height = place.height.kind === 'fixed' ? place.height.value : content.height;
  const x = place.horizontal.edge === 'left' ? place.horizontal.offset : container.width - place.horizontal.offset - width;
  const y = place.vertical.edge === 'top' ? place.vertical.offset : container.height - place.vertical.offset - height;
  return { x, y, width, height };
}

function fmt(value: number): string {
  return String(roundMm(value));
}
