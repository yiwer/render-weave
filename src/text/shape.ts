/**
 * 文字测量：按码点取字形、前进宽度与墨迹边界，逐字排列。
 * 不做连字与字偶距调整，换来的是每个字形的位置都由引擎掌握，
 * 竖排、字形压缩、两端分布与逐字缺字替代都在这一层上进行（M106）。
 */
import type { FontStore, LoadedFont } from './fonts.js';

export interface MeasuredGlyph {
  readonly id: number;
  /** 前进宽度，毫米。 */
  readonly advance: number;
  /** 墨迹相对基线起点的边界，毫米，y 向下为正（墨迹顶通常为负）。没有墨迹（如空格）时为 undefined。 */
  readonly ink?: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

export interface MeasuredText {
  readonly glyphs: readonly MeasuredGlyph[];
  /** 行框：基线以上与以下，毫米。 */
  readonly ascent: number;
  readonly descent: number;
}

/** inkSkew 只用于墨迹求界，前进宽度保持不变；横排两端分布按倾斜后的墨迹排字。 */
export function measureText(fonts: FontStore, font: LoadedFont, text: string, fontSize: number, inkSkew = 0): MeasuredText {
  const ascent = font.ascender * fontSize;
  const descent = font.descender * fontSize;
  const codePoints = Array.from(text).length;
  if (codePoints === 0) return { glyphs: [], ascent, descent };
  const skFont = fonts.makeFont(font, fontSize);
  try {
    const ids = Array.from(skFont.getGlyphIDs(text, codePoints));
    const advances = skFont.getGlyphWidths(ids);
    const glyphs = ids.map((id, i): MeasuredGlyph => {
      const ink = fonts.inkBounds(font, id, inkSkew);
      return {
        id,
        advance: advances[i]!,
        ...(ink && { ink: { left: ink.left * fontSize, top: ink.top * fontSize, right: ink.right * fontSize, bottom: ink.bottom * fontSize } }),
      };
    });
    return { glyphs, ascent, descent };
  } finally {
    skFont.delete();
  }
}
