/**
 * 绘制：排版的第四步。只按布局记录的绘制指令执行，不再做任何排版决定。
 * 画布按 DPI 缩放，指令中的坐标与字号都是毫米。
 */
import type { CanvasKit, Paint } from 'canvaskit-wasm';
import { setJpegDpi, setPngDpi } from './image-metadata.js';
import type { DrawOp } from './layout.js';
import type { RenderRequest } from './request.js';
import type { FontStore } from './text/fonts.js';
import { mmToPx, pxPerMm } from './units.js';

export interface EncodedImage {
  readonly format: RenderRequest['output']['format'];
  readonly bytes: Uint8Array;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly dpi: number;
}

const JPEG_QUALITY = 92;

export function draw(ck: CanvasKit, fonts: FontStore, ops: readonly DrawOp[], output: RenderRequest['output']): EncodedImage {
  const widthPx = mmToPx(output.width, output.dpi);
  const heightPx = mmToPx(output.height, output.dpi);
  const surface = ck.MakeSurface(widthPx, heightPx);
  if (!surface) throw new Error(`无法创建 ${widthPx} × ${heightPx} 像素的画布`);
  const paint = new ck.Paint();
  try {
    paint.setAntiAlias(true);
    const canvas = surface.getCanvas();
    // JPEG 没有透明通道，未填充的区域按白色输出。
    canvas.clear(output.format === 'jpeg' ? ck.WHITE : ck.TRANSPARENT);
    canvas.scale(pxPerMm(output.dpi), pxPerMm(output.dpi));

    for (const op of ops) {
      if (op.op === 'rect') {
        setColor(ck, paint, op.fill);
        canvas.drawRect(ck.XYWHRect(op.x, op.y, op.width, op.height), paint);
      } else {
        const font = fonts.get(op.font);
        if (!font) continue;
        // 纵向压缩用"字号乘 scaleY、横向放大 1/scaleY"表达，变换在生成字形轮廓时完成，
        // 描边作用在变换后的轮廓上，所以压缩后描边宽度不变。
        const skFont = fonts.makeFont(font, op.fontSize * op.scaleY);
        skFont.setScaleX(op.scaleX / op.scaleY);
        try {
          if (op.stroke) {
            // 描边画在填充之下，画笔宽度取两倍，字形外侧可见的宽度即为 stroke.width（M108）。
            paint.setStyle(ck.PaintStyle.Stroke);
            paint.setStrokeWidth(op.stroke.width * 2);
            paint.setStrokeJoin(ck.StrokeJoin.Round);
            setColor(ck, paint, op.stroke.color);
            canvas.drawGlyphs(op.glyphs as number[], op.positions as number[], 0, 0, skFont, paint);
            paint.setStyle(ck.PaintStyle.Fill);
          }
          setColor(ck, paint, op.color);
          canvas.drawGlyphs(op.glyphs as number[], op.positions as number[], 0, 0, skFont, paint);
        } finally {
          skFont.delete();
        }
      }
    }

    const image = surface.makeImageSnapshot();
    try {
      const format = output.format === 'png' ? ck.ImageFormat.PNG : ck.ImageFormat.JPEG;
      const encoded = image.encodeToBytes(format, output.format === 'png' ? 100 : JPEG_QUALITY);
      if (!encoded) throw new Error(`无法编码 ${output.format} 图片`);
      const bytes = output.format === 'png' ? setPngDpi(encoded, output.dpi) : setJpegDpi(encoded, output.dpi);
      return { format: output.format, bytes, widthPx, heightPx, dpi: output.dpi };
    } finally {
      image.delete();
    }
  } finally {
    paint.delete();
    surface.delete();
  }
}

function setColor(ck: CanvasKit, paint: Paint, hex: string): void {
  const value = Number.parseInt(hex.slice(1), 16);
  paint.setColor(ck.Color((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, (value & 0xff) / 255));
}
