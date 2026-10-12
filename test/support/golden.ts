/**
 * golden 图片对比：按像素差阈值比较，失败时在 test-output/golden/ 生成"预期、实际、差异"三联图
 * （参照 busbox-render-engine 的做法）。
 *
 * - golden 图片放在 test/golden/<名称>.png。
 * - 设置 UPDATE_GOLDEN=1 时用本次结果覆盖 golden。
 * - golden 不存在时：本地自动写入；CI 环境（CI 变量非空）直接失败。
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { loadCanvasKit } from '../../src/canvaskit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const goldenDir = join(root, 'test', 'golden');
export const goldenOutputDir = join(root, 'test-output', 'golden');

export interface GoldenTolerance {
  /** 单个通道相差不超过此值的像素视为相同。 */
  readonly channelTolerance: number;
  /** 不同像素占全部像素的比例上限。 */
  readonly maxDiffRatio: number;
}

export const defaultTolerance: GoldenTolerance = { channelTolerance: 2, maxDiffRatio: 0.001 };

export interface Comparison {
  readonly sameSize: boolean;
  readonly diffPixels: number;
  readonly diffRatio: number;
  readonly passed: boolean;
  /** 未通过时的三联图 PNG。 */
  readonly triptych?: Uint8Array;
}

export async function comparePng(
  expected: Uint8Array,
  actual: Uint8Array,
  tolerance: GoldenTolerance = defaultTolerance,
): Promise<Comparison> {
  const ck = await loadCanvasKit();
  const expectedImage = decode(ck, expected);
  const actualImage = decode(ck, actual);
  try {
    const width = expectedImage.width();
    const height = expectedImage.height();
    const sameSize = width === actualImage.width() && height === actualImage.height();
    if (!sameSize) {
      return { sameSize, diffPixels: Number.NaN, diffRatio: 1, passed: false, triptych: triptych(ck, expectedImage, actualImage) };
    }
    const a = pixels(ck, expectedImage);
    const b = pixels(ck, actualImage);
    const diff = new Uint8Array(a.length);
    let diffPixels = 0;
    for (let i = 0; i < a.length; i += 4) {
      const differs =
        Math.abs(a[i]! - b[i]!) > tolerance.channelTolerance ||
        Math.abs(a[i + 1]! - b[i + 1]!) > tolerance.channelTolerance ||
        Math.abs(a[i + 2]! - b[i + 2]!) > tolerance.channelTolerance ||
        Math.abs(a[i + 3]! - b[i + 3]!) > tolerance.channelTolerance;
      if (differs) {
        diffPixels++;
        diff.set([255, 0, 0, 255], i);
      } else {
        // 相同的像素以浅灰显示预期图，突出红色差异。
        const luminance = (a[i]! * 0.299 + a[i + 1]! * 0.587 + a[i + 2]! * 0.114) * (a[i + 3]! / 255) + 255 * (1 - a[i + 3]! / 255);
        const gray = Math.round(255 - (255 - luminance) * 0.25);
        diff.set([gray, gray, gray, 255], i);
      }
    }
    const diffRatio = diffPixels / (width * height);
    const passed = diffRatio <= tolerance.maxDiffRatio;
    if (passed) return { sameSize, diffPixels, diffRatio, passed };
    const diffImage = ck.MakeImage(
      { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
      diff,
      width * 4,
    );
    if (!diffImage) throw new Error('无法生成差异图');
    try {
      return { sameSize, diffPixels, diffRatio, passed, triptych: triptych(ck, expectedImage, actualImage, diffImage) };
    } finally {
      diffImage.delete();
    }
  } finally {
    expectedImage.delete();
    actualImage.delete();
  }
}

/** 与 test/golden/<name>.png 比较；不一致时抛出错误并写出三联图。 */
export async function expectMatchesGolden(
  name: string,
  actual: Uint8Array,
  tolerance: GoldenTolerance = defaultTolerance,
): Promise<void> {
  const goldenFile = join(goldenDir, `${name}.png`);
  if (process.env['UPDATE_GOLDEN'] === '1' || (!existsSync(goldenFile) && !process.env['CI'])) {
    await mkdir(goldenDir, { recursive: true });
    await writeFile(goldenFile, actual);
    return;
  }
  if (!existsSync(goldenFile)) throw new Error(`缺少 golden 图片 ${goldenFile}；本地运行 UPDATE_GOLDEN=1 npm test 生成`);

  const comparison = await comparePng(new Uint8Array(await readFile(goldenFile)), actual, tolerance);
  if (comparison.passed) return;
  await mkdir(goldenOutputDir, { recursive: true });
  const actualFile = join(goldenOutputDir, `${name}.actual.png`);
  const triptychFile = join(goldenOutputDir, `${name}.triptych.png`);
  await writeFile(actualFile, actual);
  if (comparison.triptych) await writeFile(triptychFile, comparison.triptych);
  const detail = comparison.sameSize
    ? `差异像素 ${comparison.diffPixels}（${(comparison.diffRatio * 100).toFixed(3)}%，上限 ${(tolerance.maxDiffRatio * 100).toFixed(3)}%）`
    : '尺寸不同';
  throw new Error(`与 golden 图片 ${name} 不一致：${detail}。实际图 ${actualFile}，三联图（预期、实际、差异）${triptychFile}`);
}

function decode(ck: CanvasKit, bytes: Uint8Array): Image {
  const image = ck.MakeImageFromEncoded(bytes);
  if (!image) throw new Error('无法解码 PNG');
  return image;
}

function pixels(ck: CanvasKit, image: Image): Uint8Array {
  const data = image.readPixels(0, 0, {
    width: image.width(),
    height: image.height(),
    colorType: ck.ColorType.RGBA_8888,
    alphaType: ck.AlphaType.Unpremul,
    colorSpace: ck.ColorSpace.SRGB,
  });
  if (!(data instanceof Uint8Array)) throw new Error('无法读取像素');
  return data;
}

/** 预期、实际、差异三张图并排，中间留 8 像素的间隔。 */
function triptych(ck: CanvasKit, ...images: Image[]): Uint8Array {
  const gap = 8;
  const width = images.reduce((sum, image) => sum + image.width(), 0) + gap * (images.length - 1);
  const height = Math.max(...images.map((image) => image.height()));
  const surface = ck.MakeSurface(width, height);
  if (!surface) throw new Error('无法创建三联图画布');
  try {
    const canvas = surface.getCanvas();
    canvas.clear(ck.Color(255, 0, 255, 1));
    let x = 0;
    for (const image of images) {
      canvas.drawImage(image, x, 0, null);
      x += image.width() + gap;
    }
    const snapshot = surface.makeImageSnapshot();
    try {
      const bytes = snapshot.encodeToBytes(ck.ImageFormat.PNG, 100);
      if (!bytes) throw new Error('无法编码三联图');
      return bytes;
    } finally {
      snapshot.delete();
    }
  } finally {
    surface.dispose();
  }
}
