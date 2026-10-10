/**
 * 图片：从资源仓库按资源 ID 加载并解码，支持 PNG、JPEG、WebP（M74；SVG 见票据 13）。
 * 每次渲染各用一个 ImageStore，结束时释放；资源内容可变（M10），所以不跨渲染缓存。
 */
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { formatElementPath, type ElementPath } from './element-path.js';
import { readJpegDpi, readPngInfo } from './image-metadata.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import { ResourceReadError, type ResourceRepository } from './resources.js';

export interface LoadedImage {
  readonly id: string;
  readonly image: Image;
  /** 像素尺寸。 */
  readonly width: number;
  readonly height: number;
  /** 文件中记录的 DPI；没有记录时为 undefined。 */
  readonly dpi?: number;
}

type LoadOutcome = { image: LoadedImage } | { error: { code: Problem['code']; message: string } };

export class ImageStore {
  private readonly outcomes = new Map<string, LoadOutcome>();

  constructor(
    private readonly ck: CanvasKit,
    private readonly repository: ResourceRepository,
  ) {}

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
    const outcome = this.outcomes.get(id);
    return outcome && 'image' in outcome ? outcome.image : undefined;
  }

  dispose(): void {
    for (const outcome of this.outcomes.values()) {
      if ('image' in outcome) outcome.image.image.delete();
    }
    this.outcomes.clear();
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
      const hint = looksLikeSvg(bytes) ? 'SVG 图片尚未支持' : '只支持 PNG、JPEG、WebP';
      return { error: { code: ProblemCodes.resourceUnsupportedFormat, message: `图片资源 res:${id} 的格式不受支持：${hint}` } };
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
  return new TextDecoder().decode(bytes.subarray(0, 512)).includes('<svg');
}
