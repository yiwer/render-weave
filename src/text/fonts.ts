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
}

type LoadOutcome = { font: LoadedFont } | { error: { code: Problem['code']; message: string } };

export class FontStore {
  private readonly outcomes = new Map<string, LoadOutcome>();

  constructor(
    private readonly ck: CanvasKit,
    private readonly repository: ResourceRepository,
  ) {}

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

  dispose(): void {
    for (const outcome of this.outcomes.values()) {
      if ('font' in outcome) outcome.font.typeface.delete();
    }
    this.outcomes.clear();
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
      const probe = this.makeFont({ id, typeface, ascender: 0, descender: 0 }, 1);
      const skMetrics = probe.getMetrics();
      probe.delete();
      metrics = { unitsPerEm: 1, ascender: -skMetrics.ascent, descender: skMetrics.descent };
    }
    return { font: { id, typeface, ascender: metrics.ascender, descender: metrics.descender } };
  }
}
