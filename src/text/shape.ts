/**
 * 文字测量：按码点取字形、前进宽度与墨迹边界，逐字排列。
 * 不做连字与字偶距调整，换来的是每个字形的位置都由引擎掌握，
 * 竖排、字形压缩、两端分布与逐字缺字替代都在这一层上进行（M106）。
 */
import type { FontStore, LoadedFont } from './fonts.js';

/**
 * 竖排中需顺时针旋转 90° 的常见方向性标点（全角/半角括号、破折号、省略号、波浪号、间隔号、冒号、分号等，M244）。
 * 已是 Unicode 竖排展示形式（U+FE10–U+FE19、U+FE30–U+FE4F）的字符不在其列。
 */
const VERTICAL_ROTATED_PUNCTUATION: ReadonlySet<string> = new Set([
  '（', '）', '(', ')',
  '〔', '〕', '【', '】', '〖', '〗', '〘', '〙', '〚', '〛',
  '《', '》', '〈', '〉', '「', '」', '『', '』',
  '［', '］', '[', ']', '｛', '｝', '{', '}', '｟', '｠',
  '—', '―', '–', '－', '-', 'ー',
  '…', '‥',
  '～', '〜', '〰', '~',
  '·', '・', '：', '；',
]);

export interface MeasuredGlyph {
  readonly id: number;
  /** 前进宽度，毫米。 */
  readonly advance: number;
  /** 该字形所属片段的行框：基线以上与以下，毫米（M244）。 */
  readonly ascent: number;
  readonly descent: number;
  /** 竖排方向性标点绕字格中心顺时针旋转 90° 绘制，ink 已按旋转后的边界换算（M244）。 */
  readonly rotated?: true;
  /** 墨迹相对基线起点的边界，毫米，y 向下为正（墨迹顶通常为负）。没有墨迹（如空格）时为 undefined。 */
  readonly ink?: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number };
}

export interface MeasuredText {
  readonly glyphs: readonly MeasuredGlyph[];
  /** 行框：基线以上与以下，毫米。 */
  readonly ascent: number;
  readonly descent: number;
}

/**
 * inkSkew 只用于墨迹求界，前进宽度保持不变；横排两端分布按倾斜后的墨迹排字。
 * vertical 为 true 时，方向性标点绕字格中心顺时针旋转 90°，墨迹边界同步换算（M244）。
 */
export function measureText(fonts: FontStore, font: LoadedFont, text: string, fontSize: number, inkSkew = 0, vertical = false): MeasuredText {
  const ascent = font.ascender * fontSize;
  const descent = font.descender * fontSize;
  const chars = Array.from(text);
  const codePoints = chars.length;
  if (codePoints === 0) return { glyphs: [], ascent, descent };
  const skFont = fonts.makeFont(font, fontSize);
  try {
    const ids = Array.from(skFont.getGlyphIDs(text, codePoints));
    const advances = skFont.getGlyphWidths(ids);
    const glyphs = ids.map((id, i): MeasuredGlyph => {
      const advance = advances[i]!;
      const rotated = vertical && id !== 0 && VERTICAL_ROTATED_PUNCTUATION.has(chars[i]!);
      const rawInk = fonts.inkBounds(font, id, inkSkew);
      const inkMm = rawInk && {
        left: rawInk.left * fontSize,
        top: rawInk.top * fontSize,
        right: rawInk.right * fontSize,
        bottom: rawInk.bottom * fontSize,
      };
      const ink =
        inkMm && rotated
          ? {
              left: (advance + descent - ascent) / 2 - inkMm.bottom,
              top: (descent - ascent - advance) / 2 + inkMm.left,
              right: (advance + descent - ascent) / 2 - inkMm.top,
              bottom: (descent - ascent - advance) / 2 + inkMm.right,
            }
          : inkMm;
      return {
        id,
        advance,
        ascent,
        descent,
        ...(rotated && { rotated: true as const }),
        ...(ink && { ink }),
      };
    });
    return { glyphs, ascent, descent };
  } finally {
    skFont.delete();
  }
}
