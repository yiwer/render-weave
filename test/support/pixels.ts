import { loadCanvasKit } from '../../src/canvaskit.js';

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA，非预乘。 */
  readonly data: Uint8Array;
}

export async function decodePixels(png: Uint8Array): Promise<Pixels> {
  const ck = await loadCanvasKit();
  const image = ck.MakeImageFromEncoded(png);
  if (!image) throw new Error('无法解码 PNG');
  try {
    const width = image.width();
    const height = image.height();
    const data = image.readPixels(0, 0, {
      width,
      height,
      colorType: ck.ColorType.RGBA_8888,
      alphaType: ck.AlphaType.Unpremul,
      colorSpace: ck.ColorSpace.SRGB,
    });
    if (!(data instanceof Uint8Array)) throw new Error('无法读取像素');
    return { width, height, data };
  } finally {
    image.delete();
  }
}

export function pixelAt(pixels: Pixels, x: number, y: number): [number, number, number, number] {
  const i = (y * pixels.width + x) * 4;
  return [pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!, pixels.data[i + 3]!];
}

/** 有内容（不是白色背景）的最上与最下一行。 */
export function inkRows(pixels: Pixels, isBackground: (rgba: [number, number, number, number]) => boolean): { top: number; bottom: number } {
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < pixels.height; y++) {
    for (let x = 0; x < pixels.width; x++) {
      if (!isBackground(pixelAt(pixels, x, y))) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  return { top, bottom };
}

/** 沿一列从上往下，返回连续满足条件的像素段（起点与长度）。 */
export function runsInColumn(pixels: Pixels, x: number, match: (rgba: [number, number, number, number]) => boolean): { start: number; length: number }[] {
  const runs: { start: number; length: number }[] = [];
  let start = -1;
  for (let y = 0; y <= pixels.height; y++) {
    const inside = y < pixels.height && match(pixelAt(pixels, x, y));
    if (inside && start < 0) start = y;
    if (!inside && start >= 0) {
      runs.push({ start, length: y - start });
      start = -1;
    }
  }
  return runs;
}
