/**
 * 文本元素的测量与记录。元素框由所在容器决定；文字在框内（扣除内边距）排列，
 * 竖排的适配见 text/vertical.ts（M109）。
 */
import { formatElementPath } from '../element-path.js';
import { ProblemCodes, type Problem } from '../problems.js';
import type { TextElementModel } from '../template/model.js';
import type { FontStore } from '../text/fonts.js';
import { measureText, type MeasuredText } from '../text/shape.js';
import { layoutVertical, verticalOverflows } from '../text/vertical.js';
import { roundMm } from '../units.js';
import { EPSILON, type Box, type DrawOp, type Size, type TextSummary } from './types.js';

export interface TextMeasure {
  readonly measured?: MeasuredText;
  /** 随内容时元素框的尺寸（含内边距）。 */
  readonly intrinsic: Size;
}

export function measureTextNode(model: TextElementModel, text: string, fonts: FontStore): TextMeasure {
  const { padding } = model;
  const font = fonts.get(model.font);
  if (!font) return { intrinsic: { width: padding.left + padding.right, height: model.fontSize + padding.top + padding.bottom } };
  const measured = measureText(fonts, font, text, model.fontSize);
  const cell = measured.ascent + measured.descent;
  const content =
    model.writingMode === 'vertical'
      ? { width: model.fontSize, height: measured.glyphs.length * cell }
      : { width: measured.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0), height: cell };
  return {
    measured,
    intrinsic: { width: content.width + padding.left + padding.right, height: content.height + padding.top + padding.bottom },
  };
}

/** 在已决定的元素框内排列文字，记录绘制指令；返回布局摘要中的文字项。 */
export function recordText(
  model: TextElementModel,
  text: string,
  measure: TextMeasure,
  box: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): TextSummary | undefined {
  const measured = measure.measured;
  if (!measured) return undefined;
  const content: Box = {
    x: box.x + model.padding.left,
    y: box.y + model.padding.top,
    width: box.width - model.padding.left - model.padding.right,
    height: box.height - model.padding.top - model.padding.bottom,
  };
  return model.writingMode === 'vertical'
    ? recordVertical(model, text, measured, content, drawOps, problems)
    : recordHorizontal(model, text, measured, content, drawOps, problems);
}

function recordHorizontal(
  model: TextElementModel,
  text: string,
  measured: MeasuredText,
  content: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): TextSummary {
  const width = measured.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
  const height = measured.ascent + measured.descent;
  const offsetX =
    model.horizontalAlign === 'start' ? 0 : model.horizontalAlign === 'center' ? (content.width - width) / 2 : content.width - width;
  const offsetY =
    model.verticalAlign === 'center' ? (content.height - height) / 2 : model.verticalAlign === 'bottom' ? content.height - height : 0;
  const overflow = width > content.width + EPSILON || height > content.height + EPSILON;
  if (overflow) {
    problems.push(
      overflowProblem(
        model,
        `文字"${text}"放不下：需要 ${fmt(width)} × ${fmt(height)} mm，可用 ${fmt(content.width)} × ${fmt(content.height)} mm`,
      ),
    );
  }
  const positions: number[] = [];
  let x = content.x + offsetX;
  const baseline = content.y + offsetY + measured.ascent;
  for (const glyph of measured.glyphs) {
    positions.push(x, baseline);
    x += glyph.advance;
  }
  pushGlyphs(drawOps, model, measured, positions, 1);
  return summarize(model, text, width, height, 0, 1, overflow);
}

function recordVertical(
  model: TextElementModel,
  text: string,
  measured: MeasuredText,
  content: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): TextSummary {
  const vertical = layoutVertical(measured, {
    fontSize: model.fontSize,
    boxWidth: content.width,
    boxHeight: content.height,
    horizontalAlign: model.horizontalAlign,
    verticalAlign: model.verticalAlign,
    compressGlyphs: model.fit.compressGlyphs,
    compressMin: model.fit.compressMin,
  });
  const overflow = verticalOverflows(vertical, content.width, content.height);
  if (overflow) {
    const reasons: string[] = [];
    if (vertical.extent > content.height + EPSILON) {
      const tried = model.fit.compressGlyphs ? `字距收到 0、字形压到 ${Math.round(model.fit.compressMin * 100)}% 后` : '字距收到 0 后';
      reasons.push(`${tried}仍需高 ${fmt(vertical.extent)} mm，可用高 ${fmt(content.height)} mm`);
    }
    if (vertical.columnWidth > content.width + EPSILON) {
      reasons.push(`字号 ${fmt(model.fontSize)} mm 比可用宽 ${fmt(content.width)} mm 更宽`);
    }
    problems.push(overflowProblem(model, `竖排文字"${text}"放不下：${reasons.join('；')}`));
  }
  const positions = vertical.origins.flatMap((origin) => [content.x + origin.x, content.y + origin.y]);
  pushGlyphs(drawOps, model, measured, positions, vertical.compression);
  return summarize(model, text, vertical.columnWidth, vertical.extent, vertical.spacing, vertical.compression, overflow);
}

function pushGlyphs(drawOps: DrawOp[], model: TextElementModel, measured: MeasuredText, positions: number[], compressionY: number): void {
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

function fmt(value: number): string {
  return String(roundMm(value));
}
