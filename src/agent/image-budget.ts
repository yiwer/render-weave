/**
 * Tool Runner 执行器的图片预算：图片进入对话前统一缩到上限以内，数量或请求体积到上限后改用文字说明，
 * 每次请求前再按将要发出的完整对话核对一遍，核对不过就停止本轮并说明原因，不把请求交给上游再收 400。
 * 上限取自 Claude API 视觉文档「Request limits」（2026-10-26 查阅）：一次请求超过 20 张图时，每张图两边都不超过 2000 像素才能在各平台通过；
 * 单张 base64 在 Claude API 上不超过 10 MB、Bedrock 上 5 MB；上下文 200k 的模型每次请求最多 100 张、其余 600 张；请求体不超过 32 MB。
 * 上游渠道（如 OpenCode Go）转发到哪个平台不明，所以都取较严的值。
 */
import { loadCanvasKit } from '../canvaskit.js';

export const IMAGE_MAX_SIDE = 2000;
export const IMAGE_MAX_BASE64 = 5 * 1024 * 1024;
export const REQUEST_MAX_IMAGES = 100;
/** 32 MB 的请求体上限留出余量。 */
export const REQUEST_MAX_BYTES = 30 * 1024 * 1024;

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface FittedImage {
  readonly data: string;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly original: { readonly width: number; readonly height: number };
}

/** 长边超过 maxSide 或 base64 超过单张上限时等比缩小并重新编码为 PNG；否则原样返回。 */
export async function fitImage(bytes: Uint8Array, mediaType: ImageMediaType, maxSide = IMAGE_MAX_SIDE): Promise<FittedImage> {
  const ck = await loadCanvasKit();
  const image = ck.MakeImageFromEncoded(bytes);
  if (!image) throw new Error('图片无法解码');
  try {
    const original = { width: image.width(), height: image.height() };
    const data = Buffer.from(bytes).toString('base64');
    if (Math.max(original.width, original.height) <= maxSide && data.length <= IMAGE_MAX_BASE64) return { data, mediaType, ...original, original };
    let scale = Math.min(1, maxSide / Math.max(original.width, original.height));
    for (let attempt = 0; attempt < 8; attempt++, scale *= 0.75) {
      const width = Math.max(1, Math.round(original.width * scale)), height = Math.max(1, Math.round(original.height * scale));
      const surface = ck.MakeSurface(width, height);
      if (!surface) throw new Error('无法创建绘图表面');
      const paint = new ck.Paint();
      try {
        surface.getCanvas().drawImageRectOptions(image, ck.XYWHRect(0, 0, original.width, original.height), ck.XYWHRect(0, 0, width, height), ck.FilterMode.Linear, ck.MipmapMode.Linear, paint);
        const snapshot = surface.makeImageSnapshot();
        const encoded = snapshot.encodeToBytes();
        snapshot.delete();
        if (!encoded) throw new Error('无法编码 PNG');
        const scaled = Buffer.from(encoded).toString('base64');
        if (scaled.length <= IMAGE_MAX_BASE64) return { data: scaled, mediaType: 'image/png', width, height, original };
      } finally {
        paint.delete(); surface.delete();
      }
    }
    throw new Error('图片缩小后仍超过单张大小上限');
  } finally {
    image.delete();
  }
}

/** 一轮对话的图片账：admit 决定图片能否再进入对话，check 在每次请求前核对将要发出的内容。 */
export function imageBudget() {
  const admitted = new Map<string, { width: number; height: number }>();
  let images = 0, pendingBytes = 0, lastPayload = 0;
  return {
    /** 能放进对话就计入并返回 true；数量或体积到上限时返回 false，由调用方改用文字说明。 */
    admit(image: FittedImage): boolean {
      if (Math.max(image.width, image.height) > IMAGE_MAX_SIDE || image.data.length > IMAGE_MAX_BASE64) return false;
      if (images + 1 > REQUEST_MAX_IMAGES || lastPayload + pendingBytes + image.data.length > REQUEST_MAX_BYTES) return false;
      images++; pendingBytes += image.data.length;
      admitted.set(image.data, { width: image.width, height: image.height });
      return true;
    },
    /** 按将要发出的请求体核对：图片数、每张图是否经过 admit、尺寸与体积。返回问题，空表示可以发。 */
    check(request: unknown): string[] {
      const problems: string[] = [];
      let count = 0;
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { for (const item of value) visit(item); return; }
        if (!value || typeof value !== 'object') return;
        const block = value as Record<string, any>;
        if (block['type'] === 'image' && block['source']?.['type'] === 'base64') {
          count++;
          const size = admitted.get(String(block['source']['data']));
          if (!size) problems.push(`第 ${count} 张图没有经过尺寸核对`);
          else if (Math.max(size.width, size.height) > IMAGE_MAX_SIDE) problems.push(`第 ${count} 张图 ${size.width}×${size.height} 超过 ${IMAGE_MAX_SIDE} 像素`);
          return;
        }
        for (const child of Object.values(block)) visit(child);
      };
      visit(request);
      if (count > REQUEST_MAX_IMAGES) problems.push(`图片 ${count} 张，超过 ${REQUEST_MAX_IMAGES} 张`);
      const bytes = JSON.stringify(request).length;
      if (bytes > REQUEST_MAX_BYTES) problems.push(`请求体约 ${Math.round(bytes / 1024 / 1024)} MB，超过 ${REQUEST_MAX_BYTES / 1024 / 1024} MB`);
      lastPayload = bytes; pendingBytes = 0;
      return problems;
    },
  };
}

/** 图片没能放进对话时交给模型的说明。 */
export const IMAGE_WITHHELD = '（这张图没有返回：本轮对话中的图片已到数量或体积上限。请根据文字结果继续，或结束本轮。）';
