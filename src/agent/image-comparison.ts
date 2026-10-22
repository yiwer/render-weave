/** 对齐后的局部像素诊断：RGB MAE 与 7×7 均匀窗口 SSIM；不充当设计合格判据。 */
import { loadCanvasKit } from '../canvaskit.js';
import type { LayoutNode } from '../layout/index.js';

export interface ImageRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface ImageDifference {
  readonly status: 'compared' | 'alignmentRequired';
  readonly note?: string;
  readonly width?: number;
  readonly height?: number;
  readonly rgbSimilarity?: number;
  readonly ssim?: number;
  readonly worstRegions?: readonly { readonly region: ImageRegion; readonly referenceRegion: ImageRegion;
    readonly rgbSimilarity: number; readonly ssim: number; readonly elements: readonly string[] }[];
}

/** region 是参考图上的画板区域；输出 region 与元素路径均采用候选画板毫米坐标。 */
export async function compareDesignImages(options: {
  readonly reference: Uint8Array; readonly actual: Uint8Array;
  readonly widthMm: number; readonly heightMm: number;
  readonly referenceRegion?: ImageRegion; readonly layout?: LayoutNode;
}): Promise<{ report: ImageDifference; heatmap?: Uint8Array }> {
  const ck = await loadCanvasKit();
  const reference = ck.MakeImageFromEncoded(options.reference), actual = ck.MakeImageFromEncoded(options.actual);
  try {
    if (!reference || !actual) throw new Error('参考图或候选图无法解码');
    const crop = options.referenceRegion ?? { x: 0, y: 0, width: reference.width(), height: reference.height() };
    if (![crop.x, crop.y, crop.width, crop.height, options.widthMm, options.heightMm].every(Number.isFinite) ||
      crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 || options.widthMm <= 0 || options.heightMm <= 0 ||
      crop.x + crop.width > reference.width() || crop.y + crop.height > reference.height()) throw new Error('参考区域或画板尺寸不合法');
    const ratio = options.widthMm / options.heightMm;
    if (Math.abs(crop.width / crop.height / ratio - 1) > 0.01 || Math.abs(actual.width() / actual.height() / ratio - 1) > 0.01) {
      return { report: { status: 'alignmentRequired', note: '参考画板、候选图与物理尺寸的比例偏差超过 1%；请核准裁切/透视，未强行拉伸比较。' } };
    }
    const scale = Math.min(1, 2048 / Math.max(crop.width, crop.height));
    const width = Math.max(8, Math.round(crop.width * scale)), height = Math.max(8, Math.round(crop.height * scale));
    const info = { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB };
    const sample = (image: NonNullable<typeof reference>, box: ImageRegion): Uint8Array => {
      const surface = ck.MakeSurface(width, height);
      if (!surface) throw new Error('无法创建比较画板');
      const paint = new ck.Paint();
      try {
        surface.getCanvas().clear(ck.WHITE);
        surface.getCanvas().drawImageRectOptions(image, ck.XYWHRect(box.x, box.y, box.width, box.height),
          ck.XYWHRect(0, 0, width, height), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
        const snapshot = surface.makeImageSnapshot();
        try {
          const pixels = snapshot.readPixels(0, 0, info);
          if (!(pixels instanceof Uint8Array)) throw new Error('无法读取比较像素');
          return pixels;
        } finally { snapshot.delete(); }
      } finally { paint.delete(); surface.delete(); }
    };
    const a = sample(reference, crop), b = sample(actual, { x: 0, y: 0, width: actual.width(), height: actual.height() });
    const size = width * height;
    const mae = new Float64Array(size), lumaA = new Float64Array(size), lumaB = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      const j = i * 4;
      mae[i] = (Math.abs(a[j]! - b[j]!) + Math.abs(a[j + 1]! - b[j + 1]!) + Math.abs(a[j + 2]! - b[j + 2]!)) / 765;
      lumaA[i] = 0.2126 * a[j]! + 0.7152 * a[j + 1]! + 0.0722 * a[j + 2]!;
      lumaB[i] = 0.2126 * b[j]! + 0.7152 * b[j + 1]! + 0.0722 * b[j + 2]!;
    }
    const ssim = localSsim(lumaA, lumaB, width, height);
    const scores = (x: number, y: number, w: number, h: number) => {
      let error = 0, similarity = 0;
      for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
        error += mae[py * width + px]!; similarity += ssim[py * width + px]!;
      }
      return { rgbSimilarity: 1 - error / (w * h), ssim: similarity / (w * h) };
    };
    const nodes: LayoutNode[] = [];
    const walk = (node: LayoutNode) => { if (!node.visible) return; nodes.push(node); node.children?.forEach(walk); };
    if (options.layout) walk(options.layout);
    const regions = [];
    const cols = Math.min(12, Math.max(1, Math.floor(width / 24))), rows = Math.min(4, Math.max(1, Math.floor(height / 24)));
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      const x = Math.floor(col * width / cols), y = Math.floor(row * height / rows);
      const w = Math.floor((col + 1) * width / cols) - x, h = Math.floor((row + 1) * height / rows) - y;
      const region = { x: x / width * options.widthMm, y: y / height * options.heightMm,
        width: w / width * options.widthMm, height: h / height * options.heightMm };
      const elements = nodes.filter((n) => !n.children?.length && n.x < region.x + region.width && n.x + n.width > region.x &&
        n.y < region.y + region.height && n.y + n.height > region.y).map((n) => n.path);
      regions.push({ region, referenceRegion: { x: crop.x + x / width * crop.width, y: crop.y + y / height * crop.height,
        width: w / width * crop.width, height: h / height * crop.height }, ...scores(x, y, w, h), elements: elements.slice(0, 12) });
    }
    // 红色越深表示局部结构差异越大；白底复合规则与采样一致。
    const pixels = new Uint8Array(size * 4);
    for (let i = 0; i < size; i++) {
      const intensity = Math.max(mae[i]!, (1 - ssim[i]!) / 2);
      pixels.set([255, Math.round(255 * (1 - intensity)), Math.round(255 * (1 - intensity)), 255], i * 4);
    }
    const heatmap = ck.MakeImage(info, pixels, width * 4);
    if (!heatmap) throw new Error('无法生成差异热图');
    try {
      return { report: { status: 'compared', width, height, ...scores(0, 0, width, height),
        worstRegions: regions.sort((a, b) => a.ssim - b.ssim || a.rgbSimilarity - b.rgbSimilarity).slice(0, 5) },
      heatmap: heatmap.encodeToBytes() ?? undefined };
    } finally { heatmap.delete(); }
  } finally { reference?.delete(); actual?.delete(); }
}

/** 积分图求 7×7 局部总体矩；边界窗口截短，L=255、K1=.01、K2=.03。 */
function localSsim(a: Float64Array, b: Float64Array, width: number, height: number): Float64Array {
  const stride = width + 1;
  const integrals = Array.from({ length: 5 }, () => new Float64Array(stride * (height + 1)));
  for (let y = 0; y < height; y++) {
    const row = [0, 0, 0, 0, 0];
    for (let x = 0; x < width; x++) {
      const i = y * width + x, av = a[i]!, bv = b[i]!;
      const values = [av, bv, av * av, bv * bv, av * bv];
      for (let k = 0; k < 5; k++) {
        row[k] = row[k]! + values[k]!;
        integrals[k]![(y + 1) * stride + x + 1] = integrals[k]![y * stride + x + 1]! + row[k]!;
      }
    }
  }
  const result = new Float64Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const l = Math.max(0, x - 3), r = Math.min(width, x + 4), t = Math.max(0, y - 3), d = Math.min(height, y + 4);
    const n = (r - l) * (d - t);
    const means = integrals.map((v) => (v[d * stride + r]! - v[t * stride + r]! - v[d * stride + l]! + v[t * stride + l]!) / n);
    const [ma, mb, aa, bb, ab] = means as [number, number, number, number, number];
    const va = Math.max(0, aa - ma * ma), vb = Math.max(0, bb - mb * mb);
    const limit = Math.sqrt(va * vb), covariance = Math.max(-limit, Math.min(limit, ab - ma * mb));
    result[y * width + x] = Math.max(-1, Math.min(1, ((2 * ma * mb + 6.5025) * (2 * covariance + 58.5225)) /
      ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225))));
  }
  return result;
}
