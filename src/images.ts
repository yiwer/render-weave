/**
 * 图片：从资源仓库按资源 ID 加载，位图直接解码，SVG 在排版后按显示尺寸栅格化。
 * 每次渲染各用一个 ImageStore，结束时释放；资源内容可变（M10），所以不跨渲染缓存。
 */
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { formatElementPath, type ElementPath } from './element-path.js';
import { readJpegDpi, readPngInfo } from './image-metadata.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { ResourceReadError, type ResourceRepository } from './resources.js';
import { rasterizeSvg, SvgLoader, type SvgSource } from './svg.js';
import { DEFAULT_FALLBACK_FONTS } from './text/fonts.js';
import type { DrawOp } from './layout/types.js';
import { MAX_SIDE_PX, MAX_TOTAL_PX } from './request.js';

export interface LoadedImage {
  readonly id: string;
  readonly image?: Image;
  readonly svg?: SvgSource;
  /** 像素尺寸。 */
  readonly width: number;
  readonly height: number;
  /** 文件中记录的 DPI；没有记录时为 undefined。 */
  readonly dpi?: number;
}

type LoadOutcome = { image: LoadedImage } | { error: { code: Problem['code']; message: string } };

export class ImageStore {
  private readonly outcomes = new Map<string, LoadOutcome>();
  private readonly rasters = new Map<string, LoadedImage>();
  private readonly svgLoader: SvgLoader;

  constructor(
    private readonly ck: CanvasKit,
    private readonly repository: ResourceRepository,
    svgFonts: readonly string[] = DEFAULT_FALLBACK_FONTS,
  ) { this.svgLoader = new SvgLoader(repository, svgFonts, ck); }

  /** 加载图片；失败时返回定位到使用该图片的元素的问题。 */
  async load(id: string, usedBy: ElementPath): Promise<Problem | undefined> {
    let outcome = this.outcomes.get(id);
    if (!outcome) {
      outcome = await this.loadOutcome(id);
      this.outcomes.set(id, outcome);
    }
    if ('image' in outcome) return undefined;
    return severe(outcome.error.code, { kind: 'element', path: formatElementPath(usedBy) }, outcome.error.message);
  }

  get(id: string): LoadedImage | undefined {
    if (this.rasters.has(id)) return this.rasters.get(id);
    const outcome = this.outcomes.get(id);
    return outcome && 'image' in outcome ? outcome.image : undefined;
  }

  dispose(): void {
    for (const outcome of this.outcomes.values()) {
      if ('image' in outcome) outcome.image.image?.delete();
    }
    for (const raster of this.rasters.values()) raster.image?.delete();
    this.rasters.clear();
    this.outcomes.clear();
  }

  /** 按最终布局及 DPI 生成 SVG 位图，同时把自然坐标映射到实际栅格坐标。 */
  prepare(ops: readonly DrawOp[], dpi: number): { drawOps: DrawOp[]; problems: Problem[] } {
    const drawOps: DrawOp[] = [];
    const problems: Problem[] = [];
    for (const op of ops) {
      const source = op.op === 'image' ? this.get(op.image)?.svg : undefined;
      if (op.op !== 'image' || !source) { drawOps.push(op); continue; }
      if (op.dst.width <= 0 || op.dst.height <= 0) continue;
      try {
        // cover 按裁剪前整图取样；fill 按两轴中更高的像素密度取样，避免任一方向放大位图。
        const scale = Math.max(op.dst.width / op.src.width, op.dst.height / op.src.height) * dpi / 25.4;
        const width = Math.max(1, Math.ceil(source.width * scale));
        const height = Math.max(1, Math.ceil(source.height * width / source.width));
        if (!Number.isFinite(width + height) || width > MAX_SIDE_PX || height > MAX_SIDE_PX || width * height > MAX_TOTAL_PX) {
          throw new Error(`SVG 栅格尺寸 ${width} × ${height} 超出上限`);
        }
        const key = `${op.image}@${width}`;
        let raster = this.rasters.get(key);
        if (!raster) {
          const decoded = this.ck.MakeImageFromEncoded(rasterizeSvg(source, width));
          if (!decoded) throw new Error('SVG 栅格结果无法解码');
          const image = decoded.makeCopyWithDefaultMipmaps();
          decoded.delete();
          raster = { id: key, image, width: image.width(), height: image.height() };
          this.rasters.set(key, raster);
        }
        const sx = raster.width / source.width;
        const sy = raster.height / source.height;
        drawOps.push({ ...op, image: key, src: {
          x: op.src.x * sx, y: op.src.y * sy, width: op.src.width * sx, height: op.src.height * sy,
        } });
      } catch (error) {
        problems.push(severe(ProblemCodes.resourceUnreadable, { kind: 'element', path: op.path },
          `图片资源 res:${op.image} 无法栅格化：${error instanceof Error ? error.message : String(error)}`));
      }
    }
    return { drawOps, problems };
  }

  private async loadOutcome(id: string): Promise<LoadOutcome> {
    const info = this.repository.get(id);
    if (!info) return { error: { code: ProblemCodes.resourceNotFound, message: `资源仓库中没有图片资源 res:${id}` } };
    if (info.kind !== 'image') {
      return { error: { code: ProblemCodes.resourceKindMismatch, message: `res:${id} 是字体资源，不能用作图片` } };
    }
    let bytes: Uint8Array;
    try {
      bytes = await this.repository.read(id);
    } catch (error) {
      const message = error instanceof ResourceReadError ? error.message : `图片资源 res:${id} 无法读取`;
      return { error: { code: ProblemCodes.resourceUnreadable, message } };
    }
    const format = detectFormat(bytes);
    if (!format) {
      if (looksLikeSvg(bytes)) {
        try {
          const svg = await this.svgLoader.load(bytes);
          return { image: { id, svg, width: svg.width, height: svg.height } };
        } catch (error) {
          return { error: { code: ProblemCodes.resourceUnreadable,
            message: `图片资源 res:${id} 的 SVG 无法解析：${error instanceof Error ? error.message : String(error)}` } };
        }
      }
      return { error: { code: ProblemCodes.resourceUnsupportedFormat, message: `图片资源 res:${id} 的格式不受支持：只支持 PNG、JPEG、WebP、SVG` } };
    }
    const decoded = this.ck.MakeImageFromEncoded(bytes);
    if (!decoded) return { error: { code: ProblemCodes.resourceUnreadable, message: `图片资源 res:${id} 无法解码` } };
    // 生成多级纹理，缩小绘制时按 MipmapMode.Linear 取样。
    const image = decoded.makeCopyWithDefaultMipmaps();
    decoded.delete();
    const dpi = format === 'png' ? readPngInfo(bytes).dpi : format === 'jpeg' ? readJpegDpi(bytes) : undefined;
    return { image: { id, image, width: image.width(), height: image.height(), ...(dpi && { dpi }) } };
  }
}

function detectFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | undefined {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  return undefined;
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  return /^\s*</.test(new TextDecoder().decode(bytes));
}
