/**
 * 绘制：排版的第四步。只按布局记录的绘制指令执行，不再做任何排版决定。
 * 画布按 DPI 缩放，指令中的坐标、尺寸与字号都是毫米。
 */
import type { CanvasKit, Canvas, Paint } from 'canvaskit-wasm';
import { setJpegDpi, setPngDpi } from './image-metadata.js';
import type { DrawOp, Radii } from './layout/index.js';
import type { RenderRequest } from './request.js';
import type { ShapeStroke } from './template/model.js';
import type { ImageStore } from './images.js';
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

export function draw(
  ck: CanvasKit,
  resources: { readonly fonts: FontStore; readonly images: ImageStore },
  ops: readonly DrawOp[],
  output: RenderRequest['output'],
): EncodedImage {
  const widthPx = mmToPx(output.width, output.dpi);
  const heightPx = mmToPx(output.height, output.dpi);
  const surface = ck.MakeSurface(widthPx, heightPx);
  if (!surface) throw new Error(`无法创建 ${widthPx} × ${heightPx} 像素的画布`);
  const canvas = surface.getCanvas();
  const painter = new Painter(ck, resources.fonts, resources.images, canvas);
  try {
    // JPEG 没有透明通道，未填充的区域按白色输出。
    canvas.clear(output.format === 'jpeg' ? ck.WHITE : ck.TRANSPARENT);
    canvas.scale(pxPerMm(output.dpi), pxPerMm(output.dpi));
    for (const op of ops) painter.run(op);

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
    painter.delete();
    // MakeSurface 的像素缓冲区由 JS 包装层分配，当前 CanvasKit 的 delete() 不会释放它。
    surface.dispose();
  }
}

class Painter {
  private readonly paint: Paint;

  constructor(
    private readonly ck: CanvasKit,
    private readonly fonts: FontStore,
    private readonly images: ImageStore,
    private readonly canvas: Canvas,
  ) {
    this.paint = new ck.Paint();
    this.paint.setAntiAlias(true);
  }

  delete(): void {
    this.paint.delete();
  }

  run(op: DrawOp): void {
    switch (op.op) {
      case 'barcode':
        return this.barcode(op);
      case 'qrcode':
        return this.qrcode(op);
      case 'save':
        return this.save(op);
      case 'restore':
        this.canvas.restore();
        return;
      case 'rect':
        return this.rect(op);
      case 'ellipse':
        return this.ellipse(op);
      case 'path':
        return this.path(op);
      case 'image':
        return this.image(op);
      case 'glyphs':
        return this.glyphs(op);
    }
  }

  private barcode(op: Extract<DrawOp, { op: 'barcode' }>): void {
    this.paint.setAntiAlias(false);
    try {
      const { drawn, symbol } = op;
      this.useFill(op.background);
      this.canvas.drawRect(this.ck.XYWHRect(drawn.x, drawn.y, drawn.width, drawn.height), this.paint);
      this.useFill(op.foreground);
      let x = symbol.x;
      op.widths.forEach((modules, index) => {
        const width = modules * op.moduleSize;
        if (index % 2 === 0) this.canvas.drawRect(this.ck.XYWHRect(x, symbol.y, width, symbol.height), this.paint);
        x += width;
      });
    } finally {
      this.paint.setAntiAlias(true);
    }
  }

  /** 码区和四模块留白已按最终 DPI 排好；关闭抗锯齿，避免模块接缝。 */
  private qrcode(op: Extract<DrawOp, { op: 'qrcode' }>): void {
    const { x, y, modules, moduleSize: size } = op;
    this.paint.setAntiAlias(false);
    try {
      this.useFill(op.background);
      this.canvas.drawRect(this.ck.XYWHRect(x, y, (modules + 8) * size, (modules + 8) * size), this.paint);
      this.useFill(op.foreground);
      for (let row = 0; row < modules; row++) {
        for (let column = 0; column < modules; column++) {
          if (op.data[row * modules + column]) {
            this.canvas.drawRect(this.ck.XYWHRect(x + (column + 4) * size, y + (row + 4) * size, size, size), this.paint);
          }
        }
      }
    } finally {
      this.paint.setAntiAlias(true);
    }
  }

  /** 按记录的源区域与目标区域绘制；线性插值加多级纹理，缩小时不起锯齿。 */
  private image(op: Extract<DrawOp, { op: 'image' }>): void {
    const loaded = this.images.get(op.image);
    if (!loaded?.image) return;
    this.paint.setStyle(this.ck.PaintStyle.Fill);
    this.paint.setColor(this.ck.BLACK);
    this.canvas.drawImageRectOptions(
      loaded.image,
      this.ck.XYWHRect(op.src.x, op.src.y, op.src.width, op.src.height),
      this.ck.XYWHRect(op.dst.x, op.dst.y, op.dst.width, op.dst.height),
      this.ck.FilterMode.Linear,
      this.ck.MipmapMode.Linear,
      this.paint,
    );
  }

  private save(op: Extract<DrawOp, { op: 'save' }>): void {
    if (op.opacity !== undefined) {
      const layerPaint = new this.ck.Paint();
      layerPaint.setAlphaf(op.opacity);
      this.canvas.saveLayer(layerPaint);
      layerPaint.delete();
    } else {
      this.canvas.save();
    }
    if (op.rotation) this.canvas.rotate(op.rotation.degrees, op.rotation.cx, op.rotation.cy);
    if (op.clip) {
      const { x, y, width, height, radii } = op.clip;
      this.canvas.clipRRect(rrect(x, y, width, height, radii), this.ck.ClipOp.Intersect, true);
    }
  }

  /** 矩形与容器的描边画在框内：按半个线宽内缩后以轮廓为中线描边（M110）。 */
  private rect(op: Extract<DrawOp, { op: 'rect' }>): void {
    if (op.fill) {
      this.useFill(op.fill);
      this.canvas.drawRRect(rrect(op.x, op.y, op.width, op.height, op.radii), this.paint);
    }
    const stroke = op.stroke;
    if (stroke) {
      const inset = stroke.width / 2;
      const inner: Radii = [op.radii[0] - inset, op.radii[1] - inset, op.radii[2] - inset, op.radii[3] - inset];
      this.withStroke(stroke, () =>
        this.canvas.drawRRect(rrect(op.x + inset, op.y + inset, op.width - stroke.width, op.height - stroke.width, inner), this.paint),
      );
    }
  }

  private ellipse(op: Extract<DrawOp, { op: 'ellipse' }>): void {
    if (op.fill) {
      this.useFill(op.fill);
      this.canvas.drawOval(this.ck.XYWHRect(op.x, op.y, op.width, op.height), this.paint);
    }
    const stroke = op.stroke;
    if (stroke) {
      const w = stroke.width;
      this.withStroke(stroke, () => this.canvas.drawOval(this.ck.XYWHRect(op.x + w / 2, op.y + w / 2, op.width - w, op.height - w), this.paint));
    }
  }

  private path(op: Extract<DrawOp, { op: 'path' }>): void {
    const raw = this.ck.Path.MakeFromSVGString(op.d);
    if (!raw) return;
    const path = op.transform
      ? (() => {
          const transformed = new this.ck.PathBuilder(raw)
            .transform(op.transform.sx, 0, op.transform.tx, 0, op.transform.sy, op.transform.ty, 0, 0, 1)
            .detachAndDelete();
          raw.delete();
          return transformed;
        })()
      : raw;
    try {
      path.setFillType(op.fillRule === 'evenodd' ? this.ck.FillType.EvenOdd : this.ck.FillType.Winding);
      this.canvas.save();
      this.canvas.translate(op.x, op.y);
      if (op.clip) {
        this.canvas.clipRect(this.ck.XYWHRect(0, 0, op.clip.width, op.clip.height), this.ck.ClipOp.Intersect, true);
      }
      if (op.fill) {
        this.useFill(op.fill);
        this.canvas.drawPath(path, this.paint);
      }
      if (op.stroke) this.withStroke(op.stroke, () => this.canvas.drawPath(path, this.paint));
      this.canvas.restore();
    } finally {
      path.delete();
    }
  }

  private glyphs(op: Extract<DrawOp, { op: 'glyphs' }>): void {
    const font = this.fonts.get(op.font);
    if (!font) return;
    // 纵向压缩用"字号乘 scaleY、横向放大 1/scaleY"表达，变换在生成字形轮廓时完成，
    // 描边作用在变换后的轮廓上，所以压缩后描边宽度不变。
    const skFont = this.fonts.makeFont(font, op.fontSize * op.scaleY);
    skFont.setScaleX(op.scaleX / op.scaleY);
    // Skia 的 skewX 与 y 轴同向（向下为正），向右倾时取负值；错切同样在生成轮廓时完成，描边随之倾斜。
    if (op.skew !== 0) skFont.setSkewX(-op.skew);
    try {
      const glyphs = op.glyphs as number[];
      const positions = op.positions as number[];
      if (op.stroke) {
        // 描边画在填充之下，画笔宽度取两倍，字形外侧可见的宽度即为 stroke.width（M108）。
        this.paint.setStyle(this.ck.PaintStyle.Stroke);
        this.paint.setStrokeWidth(op.stroke.width * 2);
        this.paint.setStrokeJoin(this.ck.StrokeJoin.Round);
        this.paint.setStrokeCap(this.ck.StrokeCap.Butt);
        this.setColor(op.stroke.color);
        this.canvas.drawGlyphs(glyphs, positions, 0, 0, skFont, this.paint);
      }
      if (op.color) {
        this.useFill(op.color);
        this.canvas.drawGlyphs(glyphs, positions, 0, 0, skFont, this.paint);
      }
    } finally {
      skFont.delete();
    }
  }

  private useFill(color: string): void {
    this.paint.setStyle(this.ck.PaintStyle.Fill);
    this.setColor(color);
  }

  private withStroke(stroke: ShapeStroke, draw: () => void): void {
    this.paint.setStyle(this.ck.PaintStyle.Stroke);
    this.paint.setStrokeWidth(stroke.width);
    this.paint.setStrokeJoin(this.ck.StrokeJoin.Miter);
    this.paint.setStrokeCap(
      stroke.cap === 'round' ? this.ck.StrokeCap.Round : stroke.cap === 'square' ? this.ck.StrokeCap.Square : this.ck.StrokeCap.Butt,
    );
    this.setColor(stroke.color);
    const dash = stroke.dash ? this.ck.PathEffect.MakeDash([...stroke.dash], 0) : null;
    this.paint.setPathEffect(dash);
    try {
      draw();
    } finally {
      this.paint.setPathEffect(null);
      dash?.delete();
    }
  }

  private setColor(hex: string): void {
    const value = Number.parseInt(hex.slice(1), 16);
    this.paint.setColor(this.ck.Color((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, (value & 0xff) / 255));
  }
}

/** 四角圆角矩形：左上、右上、右下、左下。负的圆角按 0 算；圆角超过边长一半时由 Skia 按比例缩小。 */
function rrect(x: number, y: number, width: number, height: number, radii: Radii): Float32Array {
  const [tl, tr, br, bl] = radii.map((r) => Math.max(0, r)) as [number, number, number, number];
  return Float32Array.of(x, y, x + Math.max(0, width), y + Math.max(0, height), tl, tl, tr, tr, br, br, bl, bl);
}
