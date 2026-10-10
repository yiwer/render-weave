/**
 * 生成图片资源夹具（票据 05），结果提交进 fixtures/resources/images/，平时不需要重跑。
 *
 *   npx tsx scripts/make-image-fixtures.ts
 *
 * - m402/route-no-m402.png：从 M402 设计稿裁出线路号"M402"，按已知的橙色底色反解出透明度。
 * - m402/landmark-1..4.png：用思源黑体的 ①–④ 字形绘制。
 * - m402/icon-metro.png、icon-hospital.png：示意图标，不是官方标志。
 * - test/quadrants.png/.jpg/.webp：四色测试图（左上红、右上绿、左下蓝、右下黄，外加 10 像素黑边），用于检查格式与适配方式。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CanvasKit, Image, Surface } from 'canvaskit-wasm';
import { loadCanvasKit } from '../src/canvaskit.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'fixtures', 'resources', 'images');
const ck = await loadCanvasKit();

function save(file: string, surface: Surface, format: 'png' | 'jpg' | 'webp' = 'png'): void {
  const image = surface.makeImageSnapshot();
  const encoded = image.encodeToBytes(
    format === 'png' ? ck.ImageFormat.PNG : format === 'jpg' ? ck.ImageFormat.JPEG : ck.ImageFormat.WEBP,
    95,
  );
  image.delete();
  if (!encoded) throw new Error(`无法编码 ${file}`);
  mkdirSync(dirname(join(out, file)), { recursive: true });
  writeFileSync(join(out, file), encoded);
  process.stdout.write(`${file}（${encoded.length} 字节）\n`);
}

function pixels(image: Image): Uint8Array {
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

/** 线路号：在顶栏左侧找出与橙色底色差别明显的像素范围，裁出后按底色反解透明度。 */
function routeNumber(): void {
  const design = ck.MakeImageFromEncoded(readFileSync(join(root, 'docs', 'examples', 'materials', 'm402-route-sign.jpg')))!;
  const data = pixels(design);
  const width = design.width();
  const orange = [255, 128, 0];
  const distance = (i: number) => Math.hypot(data[i]! - orange[0]!, data[i + 1]! - orange[1]!, data[i + 2]! - orange[2]!);
  // 线路号位于顶栏左侧：x 150–720、y 0–160 像素（120 DPI）。
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (let y = 0; y < 160; y++) {
    for (let x = 150; x < 720; x++) {
      if (distance((y * width + x) * 4) > 80) {
        left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
  }
  const margin = 4;
  left -= margin; top = Math.max(0, top - margin); right += margin; bottom += margin;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const rgba = new Uint8Array(w * h * 4);
  // 与底色的差别小于 t0 视为全透明，大于 t1 视为不透明；中间按比例，并把底色从混合色中除去。
  const t0 = 30, t1 = 140;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((top + y) * width + (left + x)) * 4;
      const alpha = Math.min(1, Math.max(0, (distance(i) - t0) / (t1 - t0)));
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        rgba[o + c] = alpha === 0 ? 0 : Math.round(Math.min(255, Math.max(0, (data[i + c]! - (1 - alpha) * orange[c]!) / alpha)));
      }
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  const image = ck.MakeImage(
    { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
    rgba,
    w * 4,
  )!;
  const surface = ck.MakeSurface(w, h)!;
  surface.getCanvas().clear(ck.TRANSPARENT);
  surface.getCanvas().drawImage(image, 0, 0, null);
  save('m402/route-no-m402.png', surface);
  process.stdout.write(`  裁自设计稿 x ${left}–${right}、y ${top}–${bottom} 像素\n`);
}

function withSurface(size: number, draw: (ck: CanvasKit, surface: Surface) => void): Surface {
  const surface = ck.MakeSurface(size, size)!;
  surface.getCanvas().clear(ck.TRANSPARENT);
  draw(ck, surface);
  return surface;
}

/** 地标 ①–④：思源黑体 Medium 的带圈数字，按墨迹居中，96 × 96 像素（8 mm 约 300 DPI）。 */
function landmarks(): void {
  const bytes = readFileSync(join(root, 'fixtures', 'resources', 'fonts', 'SourceHanSansCN-Medium.otf'));
  const typeface = ck.Typeface.MakeTypefaceFromData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)!;
  ['①', '②', '③', '④'].forEach((char, index) => {
    const surface = withSurface(96, (ck, s) => {
      const font = new ck.Font(typeface, 100);
      const glyphs = font.getGlyphIDs(char);
      const [l, t, r, b] = font.getGlyphBounds(glyphs) as unknown as [number, number, number, number];
      const scale = 90 / Math.max(r - l, b - t);
      font.setSize(100 * scale);
      const paint = new ck.Paint();
      paint.setAntiAlias(true);
      paint.setColor(ck.Color(34, 34, 34, 1));
      const x = 48 - ((l + r) / 2) * scale;
      const y = 48 - ((t + b) / 2) * scale;
      s.getCanvas().drawGlyphs(Array.from(glyphs), [0, 0], x, y, font, paint);
      paint.delete();
      font.delete();
    });
    save(`m402/landmark-${index + 1}.png`, surface);
  });
}

/** 示意图标：地铁为绿底白色"M"，医院为红底白色十字。 */
function icons(): void {
  const bytes = readFileSync(join(root, 'fixtures', 'resources', 'fonts', 'SourceHanSansCN-Heavy.otf'));
  const typeface = ck.Typeface.MakeTypefaceFromData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)!;
  const metro = withSurface(96, (ck, s) => {
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    paint.setColor(ck.Color(0, 150, 64, 1));
    s.getCanvas().drawCircle(48, 48, 46, paint);
    const font = new ck.Font(typeface, 60);
    const glyphs = font.getGlyphIDs('M');
    const [l, t, r, b] = font.getGlyphBounds(glyphs) as unknown as [number, number, number, number];
    paint.setColor(ck.WHITE);
    s.getCanvas().drawGlyphs(Array.from(glyphs), [0, 0], 48 - (l + r) / 2, 48 - (t + b) / 2, font, paint);
    font.delete();
    paint.delete();
  });
  save('m402/icon-metro.png', metro);
  const hospital = withSurface(96, (ck, s) => {
    const paint = new ck.Paint();
    paint.setAntiAlias(true);
    paint.setColor(ck.Color(230, 0, 18, 1));
    s.getCanvas().drawCircle(48, 48, 46, paint);
    paint.setColor(ck.WHITE);
    s.getCanvas().drawRect(ck.XYWHRect(38, 20, 20, 56), paint);
    s.getCanvas().drawRect(ck.XYWHRect(20, 38, 56, 20), paint);
    paint.delete();
  });
  save('m402/icon-hospital.png', hospital);
}

/** 四色测试图：200 × 100 像素，左上红、右上绿、左下蓝、右下黄，外加 10 像素黑边，便于看出哪些边被裁掉。 */
function quadrants(): void {
  const surface = ck.MakeSurface(200, 100)!;
  const canvas = surface.getCanvas();
  const paint = new ck.Paint();
  const fills: [number, number, number, number, [number, number, number]][] = [
    [0, 0, 100, 50, [255, 0, 0]],
    [100, 0, 100, 50, [0, 200, 0]],
    [0, 50, 100, 50, [0, 0, 255]],
    [100, 50, 100, 50, [255, 220, 0]],
  ];
  for (const [x, y, w, h, [r, g, b]] of fills) {
    paint.setColor(ck.Color(r, g, b, 1));
    canvas.drawRect(ck.XYWHRect(x, y, w, h), paint);
  }
  paint.setColor(ck.BLACK);
  paint.setStyle(ck.PaintStyle.Stroke);
  paint.setStrokeWidth(20);
  canvas.drawRect(ck.XYWHRect(0, 0, 200, 100), paint);
  paint.delete();
  save('test/quadrants.png', surface);
  save('test/quadrants.jpg', surface, 'jpg');
  save('test/quadrants.webp', surface, 'webp');
}

routeNumber();
landmarks();
icons();
quadrants();
