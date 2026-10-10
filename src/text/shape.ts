/**
 * 横排文字的测量：按码点取字形与前进宽度，逐字排列。
 * 不做连字与字偶距调整，换来的是每个字形的位置都由引擎掌握，
 * 后续的竖排、字形压缩、两端分布与逐字缺字替代都在这一层上进行（M98"必要时按字形逐个排版"）。
 */
import type { FontStore, LoadedFont } from './fonts.js';

export interface ShapedLine {
  readonly glyphs: readonly number[];
  /** 每个字形相对行首的横向位置，毫米。 */
  readonly offsets: readonly number[];
  /** 前进宽度之和，毫米。 */
  readonly width: number;
  /** 行框：基线以上与以下，毫米。 */
  readonly ascent: number;
  readonly descent: number;
}

export function shapeLine(fonts: FontStore, font: LoadedFont, text: string, fontSize: number): ShapedLine {
  const codePoints = Array.from(text).length;
  const skFont = fonts.makeFont(font, fontSize);
  try {
    const glyphs = codePoints === 0 ? [] : Array.from(skFont.getGlyphIDs(text, codePoints));
    const advances = glyphs.length === 0 ? [] : Array.from(skFont.getGlyphWidths(glyphs));
    const offsets: number[] = [];
    let x = 0;
    for (const advance of advances) {
      offsets.push(x);
      x += advance;
    }
    return {
      glyphs,
      offsets,
      width: x,
      ascent: font.ascender * fontSize,
      descent: font.descender * fontSize,
    };
  } finally {
    skFont.delete();
  }
}
