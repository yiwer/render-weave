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
  /** 横排字距为 0 时的原始字形跨度，毫米。 */
  readonly baseWidth?: number;
  /** 文字占用的宽与高（不计内边距），毫米；横排的宽包含倾斜外扩与常态字距，竖排的高按字格与常态字距计。 */
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

function measureRun(fragment: EvaluatedFragment, fonts: FontStore, x: number, inkSkew = 0, vertical = false): MeasuredRun {
  const measured = measureText(fonts, fonts.get(fragment.style.font)!, fragment.text, fragment.style.fontSize, inkSkew, vertical);
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
    const run = measureRun(fragment, fonts, x, distributesInk(model) ? slantSkew(fragment.style.slant) : 0);
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
  const count = runs.reduce((sum, run) => sum + run.glyphs.length, 0);
  const gaps = Math.max(0, count - 1);
  const baseWidth = distributesInk(model)
    ? runs.reduce((sum, run) => sum + run.glyphs.reduce((total, glyph) => {
      const ink = horizontalInk(glyph);
      return total + ink.right - ink.left;
    }, 0), 0)
    : right - left;
  const width = distributesInk(model) ? baseWidth : Math.max(0, baseWidth + gaps * model.letterSpacing);
  return { runs, ascent, descent, baseWidth, width, height: ascent + descent, lead: -left };
}

function measureVertical(model: TextElementModel, fragments: readonly EvaluatedFragment[], fonts: FontStore): Omit<MeasuredLines, 'intrinsic'> {
  // 各片段按自身字体与字号算字格高度，整列宽度取有字片段中最大 fontSize（无字时取元素 fontSize）（M256）。
  const runs = fragments.map((fragment) => measureRun(fragment, fonts, 0, 0, true));
  const inked = runs.filter((run) => run.glyphs.length > 0);
  const { ascent, descent } = inked.length
    ? { ascent: Math.max(...inked.map((run) => run.ascent)), descent: Math.max(...inked.map((run) => run.descent)) }
    : ownLine(model, fonts);
  const width = inked.length ? Math.max(...inked.map((run) => run.fragment.style.fontSize)) : model.fontSize;
  const glyphs = runs.flatMap((run) => run.glyphs);
  const gaps = Math.max(0, glyphs.length - 1);
  const cellsHeight = glyphs.reduce((sum, glyph) => sum + glyph.ascent + glyph.descent, 0);
  const height = Math.max(0, cellsHeight + (model.verticalAlign === 'distribute' ? 0 : gaps * model.letterSpacing));
  return {
    runs,
    ascent,
    descent,
    width,
    height,
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
  const { fontScale = 1, ...publicSummary } = summary;
  return {
    ...publicSummary,
    ...(fragments.some((fragment) => fragment.sourceFont) && { fontFallback: true as const }),
    ...(model.fit.widthOverflow && { shrinkGroup: model.fit.widthOverflow.shrinkGroup }),
    fragments: fragments.map((fragment) => ({
      text: fragment.text,
      ...(fragment.placeholder && fragment.text !== '' && { placeholder: true as const }),
      font: `res:${fragment.style.font}`,
      ...(fragment.sourceFont && { sourceFont: `res:${fragment.sourceFont}` }),
      fontSize: roundMm(fragment.style.fontSize * fontScale),
      color: fragment.style.color,
      slant: fragment.style.slant,
    })),
  };
}

type Summary = Omit<TextSummary, 'fragments'> & { fontScale?: number };

function recordHorizontal(
  model: TextElementModel,
  text: string,
  measure: MeasuredLines,
  content: Box,
  drawOps: DrawOp[],
  problems: Problem[],
): Summary {
  const availableWidth = Math.max(0, content.width);
  const availableHeight = Math.max(0, content.height);
  const count = measure.runs.reduce((sum, run) => sum + run.glyphs.length, 0);
  const gaps = Math.max(0, count - 1);
  const distribute = distributesInk(model);
  const baseWidth = measure.baseWidth ?? measure.width;
  const initialSpacing = !distribute && count > 1 ? model.letterSpacing : 0;
  const initialWidth = distribute ? baseWidth : Math.max(0, baseWidth + gaps * initialSpacing);
  const fixedSpacing =
    !distribute && model.fit.tightenSpacing && initialSpacing > 0 && initialWidth > availableWidth
      ? Math.max(0, (availableWidth - baseWidth) / gaps)
      : initialSpacing;
  const widthAfterTighten = distribute ? baseWidth : Math.max(0, baseWidth + gaps * fixedSpacing);
  const availableForGlyphs = distribute ? availableWidth : Math.max(0, availableWidth - gaps * fixedSpacing);
  const compression = model.fit.compressGlyphs && widthAfterTighten > availableWidth && baseWidth > 0
    ? Math.max(model.fit.compressMin, Math.min(1, availableForGlyphs / baseWidth)) : 1;
  const sizes = measure.runs.filter((run) => run.glyphs.length > 0).map((run) => run.fragment.style.fontSize);
  const floor = Math.min(1, Math.max(...(sizes.length ? sizes : [model.fontSize]).map((size) => model.fit.minFontSize / size)));
  const fontScale = model.fit.shrink ? Math.max(floor, Math.min(1,
    widthAfterTighten > availableWidth && baseWidth > 0 ? availableForGlyphs / (baseWidth * compression) : 1,
    measure.height > 0 ? availableHeight / measure.height : 1)) : 1;
  const scaleX = compression * fontScale;
  const naturalWidth = baseWidth * scaleX;
  const height = measure.height * fontScale;
  const evenly = model.horizontalAlign === 'spaceEvenly';
  const intervals = evenly ? count + 1 : count - 1;
  const spacing = distribute ? (count > 0 && intervals > 0 ? Math.max(0, (availableWidth - naturalWidth) / intervals) : 0) : fixedSpacing;
  const width = distribute ? naturalWidth + spacing * gaps : Math.max(0, naturalWidth + spacing * gaps);
  const offsetX =
    evenly ? spacing : distribute ? (count === 1 ? Math.max(0, (content.width - width) / 2) : 0)
      : model.horizontalAlign === 'start' ? 0 : model.horizontalAlign === 'center' ? (content.width - width) / 2 : content.width - width;
  const offsetY =
    model.verticalAlign === 'center' ? (content.height - height) / 2 : model.verticalAlign === 'bottom' ? content.height - height : 0;
  const overflow = width > content.width + EPSILON || height > content.height + EPSILON;
  if (overflow) {
    problems.push(
      overflowProblem(
        model,
        `文字"${text}"放不下：需要 ${fmt(width)} × ${fmt(height)} mm，可用 ${fmt(content.width)} × ${fmt(content.height)} mm${shrinkFloorNote(model, floor, fontScale)}`,
      ),
    );
  }
  const originX = content.x + offsetX;
  const baseline = content.y + offsetY + measure.ascent * fontScale;
  let cursor = originX;
  let glyphIndex = 0;
  const placed = measure.runs.map((run) => {
    const positions: number[] = [];
    let x = originX + (measure.lead + run.x) * scaleX + glyphIndex * spacing;
    for (const glyph of run.glyphs) {
      if (distribute) {
        const ink = horizontalInk(glyph);
        positions.push(cursor - ink.left * scaleX, baseline);
        cursor += (ink.right - ink.left) * scaleX + spacing;
      } else {
        positions.push(x, baseline);
        x += glyph.advance * scaleX + spacing;
        glyphIndex++;
      }
    }
    return { style: { ...run.fragment.style, fontSize: run.fragment.style.fontSize * fontScale }, glyphs: run.glyphs.map((glyph) => glyph.id), positions };
  });
  pushGlyphs(drawOps, model, placed, 1, compression);
  return { ...summarize(model, text, width, height, spacing, compression, overflow), fontSize: roundMm(model.fontSize * fontScale), fontScale };
}

const FLOOR_SOURCES = { default: '缺省值，画板可写 minFontSize 调低', artboard: '画板 minFontSize', element: '元素 fit.minFontSize' } as const;

/** 缩字停在下限时说明下限与来源，免得以为缩字没起作用是别的原因（M238）。 */
function shrinkFloorNote(model: TextElementModel, floor: number, fontScale: number): string {
  if (!model.fit.shrink) return '';
  const limit = `最小字号 ${fmt(model.fit.minFontSize)} mm（${FLOOR_SOURCES[model.fit.minFontSizeSource]}）`;
  if (floor >= 1) return `；字号已不高于${limit}，没有缩字`;
  return fontScale <= floor + EPSILON ? `；已缩到${limit}` : '';
}

/** 两端分布测量时已按倾斜后的轮廓求墨迹边界；无墨迹字形用前进宽度占位。 */
function horizontalInk(glyph: MeasuredGlyph): { left: number; right: number } {
  return glyph.ink ?? { left: 0, right: glyph.advance };
}

function distributesInk(model: TextElementModel): boolean {
  return model.horizontalAlign === 'distribute' || model.horizontalAlign === 'spaceEvenly';
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
    fontSize: measure.width,
    boxWidth: content.width,
    boxHeight: content.height,
    horizontalAlign: model.horizontalAlign === 'distribute' || model.horizontalAlign === 'spaceEvenly' ? 'start' : model.horizontalAlign,
    verticalAlign: model.verticalAlign,
    letterSpacing: model.letterSpacing,
    tightenSpacing: model.fit.tightenSpacing,
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
      const group = model.fit.widthOverflow;
      const inkedSizes = measure.runs.filter((run) => run.glyphs.length > 0).map((run) => run.fragment.style.fontSize);
      const minSize = inkedSizes.length > 0 ? Math.min(...inkedSizes) : model.fontSize;
      const floored = group && minSize <= group.minFontSize + EPSILON ? `（缩字组 ${group.shrinkGroup} 已到最小字号 ${fmt(group.minFontSize)} mm）` : '';
      reasons.push(`字号 ${fmt(vertical.columnWidth)} mm 比可用宽 ${fmt(content.width)} mm 更宽${floored}`);
    }
    const level = model.fit.widthOverflow && vertical.columnWidth > content.width + EPSILON ? 'severe' : model.fit.onFail;
    problems.push(overflowProblem(model, `竖排文字"${text}"放不下：${reasons.join('；')}`, level));
  }
  // 按片段与标点是否旋转把整列的字形位置分回去；相邻同样式且同方向的字形在 pushGlyphs 中合并。
  let index = 0;
  const placed: PlacedRun[] = measure.runs.flatMap((run) => {
    const origins = vertical.origins.slice(index, index + run.glyphs.length);
    index += run.glyphs.length;
    return run.glyphs.map((glyph, i) => ({
      style: run.fragment.style,
      ...(glyph.rotated && { rotated: true as const }),
      glyphs: [glyph.id],
      positions: [content.x + origins[i]!.x, content.y + origins[i]!.y],
    }));
  });
  pushGlyphs(drawOps, model, placed, vertical.compression);
  return summarize(model, text, vertical.columnWidth, vertical.extent, vertical.spacing, vertical.compression, overflow);
}

interface PlacedRun {
  readonly style: ResolvedStyle;
  readonly rotated?: true;
  readonly glyphs: readonly number[];
  readonly positions: readonly number[];
}

/**
 * 记录字形绘制指令：相邻、样式相同的片段合成一条。
 * 有描边时先画全部片段的描边、再画全部填充（M108），免得后面片段的描边盖住前面的字。
 */
function pushGlyphs(drawOps: DrawOp[], model: TextElementModel, runs: readonly PlacedRun[], compressionY: number, compressionX = 1): void {
  const merged: { style: ResolvedStyle; rotated?: true; glyphs: number[]; positions: number[] }[] = [];
  for (const run of runs) {
    if (run.glyphs.length === 0) continue;
    const last = merged.at(-1);
    if (last && sameStyle(last.style, run.style) && last.rotated === run.rotated) {
      last.glyphs.push(...run.glyphs);
      last.positions.push(...run.positions);
    } else {
      merged.push({ style: run.style, ...(run.rotated && { rotated: true as const }), glyphs: [...run.glyphs], positions: [...run.positions] });
    }
  }
  const op = (run: (typeof merged)[number]) => ({
    op: 'glyphs' as const,
    path: formatElementPath(model.path),
    font: run.style.font,
    fontSize: run.style.fontSize,
    scaleX: run.rotated ? compressionY : compressionX,
    scaleY: run.rotated ? compressionX : compressionY,
    skew: slantSkew(run.style.slant) * compressionX,
    ...(run.rotated && { rotated: true as const }),
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

function overflowProblem(model: TextElementModel, message: string, level = model.fit.onFail): Problem {
  return {
    code: ProblemCodes.layoutTextOverflow,
    level,
    location: { kind: 'element', path: formatElementPath(model.path) },
    message,
  };
}

function fmt(value: number): string {
  return String(roundMm(value));
}
