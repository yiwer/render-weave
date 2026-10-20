/**
 * 竖排文字的排版计算（纯数学，不依赖 CanvasKit）。
 *
 * 每个字占一个字格：宽为字号，高为行框（思源黑体即 em 框）。字在字格内水平居中，字与字之间的空白是"字距"。
 *
 * 两端分布（M82）：首字墨迹贴顶、末字墨迹贴底，各字格等距排开。
 * 放不下时先收紧字距到 0，再沿书写方向压缩字形：字格与墨迹一起按比例 k 变矮，字号与字宽不变，
 * k 不低于 compressMin（M88）。仍放不下时以 k = compressMin 从顶端排起，并报告所需高度。
 * 上、中、下对齐时字距为 0，字格依次相接，整段按行框对齐；放不下时同样压缩。
 *
 * 参照 design-layout-draw `canvaskit/src/drawCore/V4/text/vertical.ts:84-228`（两端分布与 scaleY），
 * 墨迹改用字形轮廓边界而不是像素扫描，并补上收紧字距、压缩下限与问题上报。
 */
import type { MeasuredText } from './shape.js';

export interface VerticalOptions {
  readonly fontSize: number;
  readonly boxWidth: number;
  readonly boxHeight: number;
  readonly horizontalAlign: 'start' | 'center' | 'end';
  readonly verticalAlign: 'top' | 'center' | 'bottom' | 'distribute';
  readonly letterSpacing?: number;
  readonly tightenSpacing?: boolean;
  readonly compressGlyphs: boolean;
  readonly compressMin: number;
}

export interface VerticalLayout {
  /** 每个字形基线起点相对元素框左上角的位置，毫米。 */
  readonly origins: readonly { readonly x: number; readonly y: number }[];
  /** 相邻字格之间的空白，毫米。 */
  readonly spacing: number;
  /** 沿书写方向的压缩比，1 为不压缩。 */
  readonly compression: number;
  /** 整列的宽与高（两端分布时为首字墨迹顶到末字墨迹底），毫米，已计入压缩。 */
  readonly columnWidth: number;
  readonly extent: number;
  /** 不压缩时需要的高度，毫米。 */
  readonly naturalExtent: number;
}

/** 浮点误差容差，毫米。 */
const EPSILON = 1e-6;

export function layoutVertical(text: MeasuredText, options: VerticalOptions): VerticalLayout {
  const { fontSize, boxWidth, boxHeight } = options;
  const n = text.glyphs.length;
  const cell = text.ascent + text.descent;
  const columnWidth = fontSize;
  const columnX =
    options.horizontalAlign === 'start' ? 0 : options.horizontalAlign === 'center' ? (boxWidth - columnWidth) / 2 : boxWidth - columnWidth;
  if (n === 0) {
    return { origins: [], spacing: 0, compression: 1, columnWidth, extent: 0, naturalExtent: 0 };
  }

  // 首字墨迹顶、末字墨迹底在各自字格中的位置（从字格顶量起）；没有墨迹的字按整个字格算。
  const first = text.glyphs[0]!;
  const last = text.glyphs[n - 1]!;
  const inkTop = first.ink ? text.ascent + first.ink.top : 0;
  const inkBottom = last.ink ? text.ascent + last.ink.bottom : cell;

  let spacing = 0;
  let compression = 1;
  let firstCellTop: number;
  let naturalExtent: number;
  let extent: number;

  const compressTo = (needed: number) => {
    const k = options.compressGlyphs ? Math.max(boxHeight / needed, options.compressMin) : 1;
    return Math.min(1, k);
  };

  if (options.verticalAlign === 'distribute') {
    // 墨迹总高 = 首字墨迹顶到末字墨迹底，字距为 0、不压缩时。
    naturalExtent = (n - 1) * cell + inkBottom - inkTop;
    if (n === 1) {
      compression = naturalExtent > boxHeight + EPSILON ? compressTo(naturalExtent) : 1;
      extent = naturalExtent * compression;
      // 单字放在正中；放不下时从顶端排起。
      firstCellTop = (extent <= boxHeight + EPSILON ? (boxHeight - extent) / 2 : 0) - inkTop * compression;
    } else if (naturalExtent <= boxHeight + EPSILON) {
      spacing = Math.max(0, (boxHeight - naturalExtent) / (n - 1));
      extent = naturalExtent + spacing * (n - 1);
      firstCellTop = -inkTop;
    } else {
      compression = compressTo(naturalExtent);
      extent = naturalExtent * compression;
      firstCellTop = -inkTop * compression;
    }
  } else {
    const gaps = Math.max(0, n - 1);
    const cellsExtent = n * cell;
    const initialSpacing = n > 1 ? (options.letterSpacing ?? 0) : 0;
    naturalExtent = Math.max(0, cellsExtent + gaps * initialSpacing);
    spacing =
      options.tightenSpacing && initialSpacing > 0 && naturalExtent > boxHeight + EPSILON
        ? Math.max(0, (boxHeight - cellsExtent) / gaps)
        : initialSpacing;
    const extentAfterTighten = Math.max(0, cellsExtent + gaps * spacing);
    const availableForCells = Math.max(0, boxHeight - gaps * spacing);
    compression =
      extentAfterTighten > boxHeight + EPSILON && options.compressGlyphs
        ? Math.min(1, Math.max(availableForCells / cellsExtent, options.compressMin))
        : 1;
    extent = Math.max(0, cellsExtent * compression + gaps * spacing);
    const free = boxHeight - extent;
    firstCellTop = options.verticalAlign === 'top' || free < 0 ? 0 : options.verticalAlign === 'center' ? free / 2 : free;
  }

  const pitch = cell * compression + spacing;
  const origins = text.glyphs.map((glyph, i) => ({
    x: columnX + (columnWidth - glyph.advance) / 2,
    y: firstCellTop + i * pitch + text.ascent * compression,
  }));
  return { origins, spacing, compression, columnWidth, extent, naturalExtent };
}

export function verticalOverflows(layout: VerticalLayout, boxWidth: number, boxHeight: number): boolean {
  return layout.extent > boxHeight + EPSILON || layout.columnWidth > boxWidth + EPSILON;
}
