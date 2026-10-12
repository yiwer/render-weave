/**
 * 字体：从资源仓库按资源 ID 显式加载为 CanvasKit 字形（M99），不使用系统字体。
 * 每次渲染各用一个 FontStore，结束时释放；资源内容可变（M10），所以不跨渲染缓存。
 */
import type { CanvasKit, Font, Typeface } from 'canvaskit-wasm';
import { formatElementPath, type ElementPath } from '../element-path.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { ResourceReadError, type ResourceRepository } from '../resources.js';
import { readFontMetrics } from './opentype.js';

export interface LoadedFont {
  readonly id: string;
  readonly typeface: Typeface;
  /** 行框：基线以上与以下的高度，em 单位。 */
  readonly ascender: number;
  readonly descender: number;
  /** OS/2.usWeightClass；文件未提供可用值时按常规字重 400。 */
  readonly weight: number;
}

/** 字形墨迹的边界，em 单位，相对基线起点，y 向下为正。 */
export interface InkBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

type LoadOutcome = { font: LoadedFont } | { error: { code: Problem['code']; message: string } };

/** 求墨迹边界时使用的字号与二分次数：精度约为 4 × 256 / 2^32 em，远小于一个像素。 */
const INK_PROBE_SIZE = 256;
const INK_PROBE_STEPS = 32;

/** 引擎默认后备字体资源 ID；文件由 fetch-fonts 准备，模板不必引用。 */
export const DEFAULT_FALLBACK_FONTS: readonly string[] = [
  'font-hei-regular', 'font-hei-medium', 'font-hei-bold', 'font-hei-heavy',
];

export class FontStore {
  private readonly outcomes = new Map<string, LoadOutcome>();
  private readonly inkCache = new Map<string, InkBounds | null>();
  private fallbackFonts?: Promise<readonly LoadedFont[]>;

  constructor(
    private readonly ck: CanvasKit,
    private readonly repository: ResourceRepository,
    private readonly fallbackIds: readonly string[] = DEFAULT_FALLBACK_FONTS,
  ) {}

  /** 仅在遇到缺字时加载后备字体；缺档取最近字重，距离相同取较轻者。 */
  async fallbackFor(font: LoadedFont): Promise<LoadedFont | undefined> {
    // 原字体已经是配置中的思源黑体时不重复尝试，也不串换其他字重。
    if (this.fallbackIds.includes(font.id)) return undefined;
    this.fallbackFonts ??= this.loadFallbacks();
    const candidates = await this.fallbackFonts;
    return [...candidates].sort((a, b) =>
      Math.abs(a.weight - font.weight) - Math.abs(b.weight - font.weight) || a.weight - b.weight)[0];
  }

  private async loadFallbacks(): Promise<readonly LoadedFont[]> {
    const fonts: LoadedFont[] = [];
    for (const id of new Set(this.fallbackIds)) {
      let outcome = this.outcomes.get(id);
      if (!outcome) {
        outcome = await this.loadOutcome(id);
        this.outcomes.set(id, outcome);
      }
      if ('font' in outcome) fonts.push(outcome.font);
    }
    return fonts;
  }

  /** 与 measureText 相同的码点到字形映射；空格等无墨迹但有字形的字符不是缺字。 */
  glyphIds(font: LoadedFont, text: string): readonly number[] {
    const count = Array.from(text).length;
    if (!count) return [];
    const skFont = this.makeFont(font, 1);
    try { return Array.from(skFont.getGlyphIDs(text, count)); }
    finally { skFont.delete(); }
  }

  /** 加载字体；失败时返回定位到使用该字体的元素的问题。 */
  async load(id: string, usedBy: ElementPath): Promise<Problem | undefined> {
    let outcome = this.outcomes.get(id);
    if (!outcome) {
      outcome = await this.loadOutcome(id);
      this.outcomes.set(id, outcome);
    }
    if ('font' in outcome) return undefined;
    return severe(outcome.error.code, { kind: 'element', path: formatElementPath(usedBy) }, outcome.error.message);
  }

  get(id: string): LoadedFont | undefined {
    const outcome = this.outcomes.get(id);
    return outcome && 'font' in outcome ? outcome.font : undefined;
  }

  /** 按字号创建 Skia 字体对象：关闭微调、开启亚像素与线性度量，使度量与分辨率无关。调用方负责 delete。 */
  makeFont(font: LoadedFont, size: number): Font {
    const skFont = new this.ck.Font(font.typeface, size);
    skFont.setHinting(this.ck.FontHinting.None);
    skFont.setSubpixel(true);
    skFont.setLinearMetrics(true);
    skFont.setEdging(this.ck.FontEdging.AntiAlias);
    return skFont;
  }

  /**
   * 字形墨迹的精确边界（可带倾斜）；没有墨迹（如空格）时为 undefined。
   * 用 getGlyphIntercepts 对字形轮廓求交：左右边界直接得到，上下边界二分求得。
   * 不用 getGlyphBounds：它在规范化字号下取整，实测误差可达 1/64 em，小字号时更大。
   */
  inkBounds(font: LoadedFont, glyph: number, skew = 0): InkBounds | undefined {
    const key = `${font.id}#${glyph}#${skew}`;
    const cached = this.inkCache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const skFont = this.makeFont(font, INK_PROBE_SIZE);
    if (skew !== 0) skFont.setSkewX(-skew);
    try {
      const glyphs = [glyph];
      const origin = [0, 0];
      const far = INK_PROBE_SIZE * 4;
      const intercepts = (top: number, bottom: number) => skFont.getGlyphIntercepts(glyphs, origin, top, bottom);
      const all = intercepts(-far, far);
      if (all.length === 0) {
        this.inkCache.set(key, null);
        return undefined;
      }
      let left = Infinity;
      let right = -Infinity;
      for (let i = 0; i < all.length; i += 2) {
        left = Math.min(left, all[i]!);
        right = Math.max(right, all[i + 1]!);
      }
      // 墨迹顶：使 [-far, y] 有交点的最小 y；墨迹底：使 [y, far] 有交点的最大 y。
      let lo = -far;
      let hi = far;
      for (let i = 0; i < INK_PROBE_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (intercepts(-far, mid).length > 0) hi = mid;
        else lo = mid;
      }
      const top = hi;
      lo = -far;
      hi = far;
      for (let i = 0; i < INK_PROBE_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (intercepts(mid, far).length > 0) lo = mid;
        else hi = mid;
      }
      const bounds = {
        left: left / INK_PROBE_SIZE,
        top: top / INK_PROBE_SIZE,
        right: right / INK_PROBE_SIZE,
        bottom: lo / INK_PROBE_SIZE,
      };
      this.inkCache.set(key, bounds);
      return bounds;
    } finally {
      skFont.delete();
    }
  }

  dispose(): void {
    for (const outcome of this.outcomes.values()) {
      if ('font' in outcome) outcome.font.typeface.delete();
    }
    this.outcomes.clear();
    this.inkCache.clear();
  }

  private async loadOutcome(id: string): Promise<LoadOutcome> {
    const info = this.repository.get(id);
    if (!info) return { error: { code: ProblemCodes.resourceNotFound, message: `资源仓库中没有字体资源 res:${id}` } };
    if (info.kind !== 'font') {
      return { error: { code: ProblemCodes.resourceKindMismatch, message: `res:${id} 是${info.kind === 'image' ? '图片' : info.kind}资源，不能用作字体` } };
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.repository.read(id);
    } catch (error) {
      const message = error instanceof ResourceReadError ? error.message : `字体资源 res:${id} 无法读取`;
      return { error: { code: ProblemCodes.resourceUnreadable, message } };
    }
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const typeface = this.ck.Typeface.MakeTypefaceFromData(buffer);
    if (!typeface) return { error: { code: ProblemCodes.resourceUnreadable, message: `字体资源 res:${id} 不是可用的字体文件` } };

    let metrics = readFontMetrics(bytes);
    if (!metrics) {
      const probe = this.makeFont({ id, typeface, ascender: 0, descender: 0, weight: 400 }, 1);
      const skMetrics = probe.getMetrics();
      probe.delete();
      metrics = { unitsPerEm: 1, ascender: -skMetrics.ascent, descender: skMetrics.descent };
    }
    const weight = metrics.weightClass && metrics.weightClass >= 1 && metrics.weightClass <= 1000 ? metrics.weightClass : 400;
    return { font: { id, typeface, ascender: metrics.ascender, descender: metrics.descender, weight } };
  }
}
