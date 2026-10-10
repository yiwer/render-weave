/**
 * 文本元素的测量与记录。元素框由所在容器决定；文字在框内（扣除内边距）排列，
 * 竖排的适配见 text/vertical.ts（M109）。
 *
 * 横排：各片段按自己的字体与字号逐字排在同一条基线上；行框取有字的片段中基线以上、以下的最大值（M115）。
 * 倾斜以基线为轴错切：片段的行框变成平行四边形，文字宽取所有片段的平行四边形与前进宽度的总范围，
 * 所以倾斜带来的外扩计入测量与布局摘要，左对齐时倾斜后的左下角贴着框边（M117）。
 */
import { formatElementPath } from '../element-path.js';
import { fragmentsText, type EvaluatedFragment, type ResolvedStyle } from '../evaluate.js';
import { ProblemCodes, type Problem } from '../problems.js';
import type { TextElementModel } from '../template/model.js';
import type { FontStore } from '../text/fonts.js';
import { measureText, type MeasuredGlyph, type MeasuredText } from '../text/shape.js';
import { layoutVertical, verticalOverflows } from '../text/vertical.js';
import { roundMm } from '../units.js';
import { EPSILON, type Box, type DrawOp, type Size, type TextSummary } from './types.js';

/** 一个片段的字形。 */
interface MeasuredRun {
  readonly fragment: EvaluatedFragment;
  readonly glyphs: readonly MeasuredGlyph[];
  /** 该片段字体与字号下的行框，毫米。 */
  readonly ascent: number;
  readonly descent: number;
  /** 前进宽度之和，毫米。 */
  readonly advance: number;
  /** 横排时片段基线起点相对首个片段起点的位置，毫米。 */
  readonly x: number;
}

/** 字体没有加载成功（问题已在加载时报告）的文本不排版，只按字号占位。 */
export type TextMeasure = MeasuredLines | { readonly unavailable: true; readonly intrinsic: Size };

export interface MeasuredLines {
  readonly runs: readonly MeasuredRun[];
  /** 行框：基线以上与以下，毫米。 */
  readonly ascent: number;
  readonly descent: number;
  /** 文字占用的宽与高（不计内边距），毫米；横排的宽包含倾斜外扩，竖排的高按字格相接计。 */
  readonly width: number;
  readonly height: number;
  /** 横排：首个片段的基线起点距文字左边的距离（左倾或下伸部分向左倾出的量），毫米。 */
  readonly lead: number;
  /** 竖排：全部字形合成的一列。 */
  readonly column?: MeasuredText;
  /** 随内容时元素框的尺寸（含内边距）。 */
  readonly intrinsic: Size;
}

export function measureTextNode(model: TextElementModel, fragments: readonly EvaluatedFragment[], fonts: FontStore): TextMeasure {
  const { padding } = model;
  if ([model.font, ...fragments.map((fragment) => fragment.style.font)].some((id) => !fonts.get(id))) {
    return { unavailable: true, intrinsic: { width: padding.left + padding.right, height: model.fontSize + padding.top + padding.bottom } };
  }
  const measure = model.writingMode === 'vertical' ? measureVertical(model, fragments, fonts) : measureHorizontal(model, fragments, fonts);
  return {
    ...measure,
    intrinsic: { width: measure.width + padding.left + padding.right, height: measure.height + padding.top + padding.bottom },
  };
}

function measureRun(fragment: EvaluatedFragment, fonts: FontStore, x: number): MeasuredRun {
  const measured = measureText(fonts, fonts.get(fragment.style.font)!, fragment.text, fragment.style.fontSize);
  const advance = measured.glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
  return { fragment, glyphs: measured.glyphs, ascent: measured.ascent, descent: measured.descent, advance, x };
}

/** 元素自身字体与字号的行框。 */
function ownLine(model: TextElementModel, fonts: FontStore): { ascent: number; descent: number } {
  const font = fonts.get(model.font)!;
  return { ascent: font.ascender * model.fontSize, descent: font.descender * model.fontSize };
}

function measureHorizontal(model: TextElementModel, fragments: readonly EvaluatedFragment[], fonts: FontStore): Omit<MeasuredLines, 'intrinsic'> {
  const runs: MeasuredRun[] = [];
  let x = 0;
  for (const fragment of fragments) {
    const run = measureRun(fragment, fonts, x);
    runs.push(run);
    x += run.advance;
  }
  const inked = runs.filter((run) => run.glyphs.length > 0);
  // 没有字的片段不撑高行框；整段都没有字时按元素自身的字体与字号。
  const { ascent, descent } =
    inked.length > 0
      ? { ascent: Math.max(...inked.map((run) => run.ascent)), descent: Math.max(...inked.map((run) => run.descent)) }
      : ownLine(model, fonts);
  let left = 0;
  let right = x;
  for (const run of inked) {
    const skew = slantSkew(run.fragment.style.slant);
    left = Math.min(left, run.x + Math.min(-skew * run.descent, skew * run.ascent));
    right = Math.max(right, run.x + run.advance + Math.max(skew * run.ascent, -skew * run.descent));
  }
  return { runs, ascent, descent, width: right - left, height: ascent + descent, lead: -left };
}

function measureVertical(model: TextElementModel, fragments: readonly EvaluatedFragment[], fonts: FontStore): Omit<MeasuredLines, 'intrinsic'> {
  // 竖排片段只能单独设颜色，字体与字号都是元素自身的。
  const runs = fragments.map((fragment) => measureRun(fragment, fonts, 0));
  const { ascent, descent } = ownLine(model, fonts);
  const glyphs = runs.flatMap((run) => run.glyphs);
  return {
    runs,
    ascent,
    descent,
    width: model.fontSize,
    height: glyphs.length * (ascent + descent),
    lead: 0,
    column: { glyphs, ascent, descent },
  };
}

/** 在已决定的元素框内排列文字，记录绘制指令；返回布局摘要中的文字项。 */
export function recordText(
  model: TextElementModel,
  fragments: readonly EvaluatedFragment[],
  measure: TextMeasure,
  box: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): TextSummary | undefined {
  if ('unavailable' in measure) return undefined;
  const content: Box = {
    x: box.x + model.padding.left,
    y: box.y + model.padding.top,
    width: box.width - model.padding.left - model.padding.right,
    height: box.height - model.padding.top - model.padding.bottom,
  };
  const text = fragmentsText(fragments);
  const summary =
    model.writingMode === 'vertical' && measure.column
      ? recordVertical(model, text, measure, measure.column, content, drawOps, problems)
      : recordHorizontal(model, text, measure, content, drawOps, problems);
  return {
    ...summary,
    fragments: fragments.map((fragment) => ({
      text: fragment.text,
      font: `res:${fragment.style.font}`,
      fontSize: roundMm(fragment.style.fontSize),
      color: fragment.style.color,
      slant: fragment.style.slant,
    })),
  };
}

type Summary = Omit<TextSummary, 'fragments'>;

function recordHorizontal(
  model: TextElementModel,
  text: string,
  measure: MeasuredLines,
  content: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): Summary {
  const { width, height } = measure;
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
  const originX = content.x + offsetX + measure.lead;
  const baseline = content.y + offsetY + measure.ascent;
  const placed = measure.runs.map((run) => {
    const positions: number[] = [];
    let x = originX + run.x;
    for (const glyph of run.glyphs) {
      positions.push(x, baseline);
      x += glyph.advance;
    }
    return { style: run.fragment.style, glyphs: run.glyphs.map((glyph) => glyph.id), positions };
  });
  pushGlyphs(drawOps, model, placed, 1);
  return summarize(model, text, width, height, 0, 1, overflow);
}

function recordVertical(
  model: TextElementModel,
  text: string,
  measure: MeasuredLines,
  column: MeasuredText,
  content: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): Summary {
  const vertical = layoutVertical(column, {
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
  // 按片段把整列的字形位置分回去，各片段只是颜色不同。
  let index = 0;
  const placed = measure.runs.map((run) => {
    const origins = vertical.origins.slice(index, index + run.glyphs.length);
    index += run.glyphs.length;
    return {
      style: run.fragment.style,
      glyphs: run.glyphs.map((glyph) => glyph.id),
      positions: origins.flatMap((origin) => [content.x + origin.x, content.y + origin.y]),
    };
  });
  pushGlyphs(drawOps, model, placed, vertical.compression);
  return summarize(model, text, vertical.columnWidth, vertical.extent, vertical.spacing, vertical.compression, overflow);
}

interface PlacedRun {
  readonly style: ResolvedStyle;
  readonly glyphs: readonly number[];
  readonly positions: readonly number[];
}

/**
 * 记录字形绘制指令：相邻、样式相同的片段合成一条。
 * 有描边时先画全部片段的描边、再画全部填充（M108），免得后面片段的描边盖住前面的字。
 */
function pushGlyphs(drawOps: DrawOp[], model: TextElementModel, runs: readonly PlacedRun[], compressionY: number): void {
  const merged: { style: ResolvedStyle; glyphs: number[]; positions: number[] }[] = [];
  for (const run of runs) {
    if (run.glyphs.length === 0) continue;
    const last = merged.at(-1);
    if (last && sameStyle(last.style, run.style)) {
      last.glyphs.push(...run.glyphs);
      last.positions.push(...run.positions);
    } else {
      merged.push({ style: run.style, glyphs: [...run.glyphs], positions: [...run.positions] });
    }
  }
  const op = (run: (typeof merged)[number]) => ({
    op: 'glyphs' as const,
    path: formatElementPath(model.path),
    font: run.style.font,
    fontSize: run.style.fontSize,
    scaleX: 1,
    scaleY: compressionY,
    skew: slantSkew(run.style.slant),
    glyphs: run.glyphs,
    positions: run.positions,
  });
  if (model.stroke) {
    for (const run of merged) drawOps.push({ ...op(run), stroke: model.stroke });
  }
  for (const run of merged) drawOps.push({ ...op(run), color: run.style.color });
}

function sameStyle(a: ResolvedStyle, b: ResolvedStyle): boolean {
  return a.font === b.font && a.fontSize === b.fontSize && a.color === b.color && a.slant === b.slant;
}

/** 倾斜角度换成错切系数：正角度向右倾。 */
function slantSkew(degrees: number): number {
  return degrees === 0 ? 0 : Math.tan((degrees * Math.PI) / 180);
}

function summarize(
  model: TextElementModel,
  content: string,
  width: number,
  height: number,
  spacing: number,
  compression: number,
  overflow: boolean,
): Summary {
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
