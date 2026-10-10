/**
 * 图片元素的测量与记录（M114）。
 * 适配方式：完整显示（contain）按比例缩放到放得下并居中；铺满裁剪（cover）按比例缩放到铺满元素框、
 * 居中裁去多余部分；拉伸（fill）不保持比例。裁剪与缩放在这里决定，绘制只按记录执行。
 */
import { formatElementPath } from '../element-path.js';
import type { LoadedImage } from '../images.js';
import type { ImageModel } from '../template/model.js';
import { MM_PER_INCH, roundMm } from '../units.js';
import type { Box, DrawOp, ImageSummary, Size } from './types.js';

/** 文件中没有记录 DPI 时，按 96 像素每英寸换算图片的天然尺寸。 */
export const DEFAULT_IMAGE_DPI = 96;

/**
 * 随内容时的尺寸：只有一边是固定值时，另一边按图片比例算；否则取图片的天然尺寸（像素按 DPI 换算为毫米）。
 * 没有图片时为 0。
 */
export function imageIntrinsic(model: ImageModel, image: LoadedImage | undefined): Size {
  if (!image || image.width === 0 || image.height === 0) return { width: 0, height: 0 };
  const ratio = image.height / image.width;
  const { width, height } = model.place;
  if (width?.kind === 'fixed' && height?.kind !== 'fixed') return { width: width.value, height: width.value * ratio };
  if (height?.kind === 'fixed' && width?.kind !== 'fixed') return { width: height.value / ratio, height: height.value };
  const dpi = image.dpi ?? DEFAULT_IMAGE_DPI;
  return { width: (image.width / dpi) * MM_PER_INCH, height: (image.height / dpi) * MM_PER_INCH };
}

export function recordImage(model: ImageModel, box: Box, image: LoadedImage | undefined, drawOps: DrawOp[]): ImageSummary | undefined {
  if (!image || !model.source || box.width <= 0 || box.height <= 0) return undefined;
  const { width: iw, height: ih } = image;
  let src: Box = { x: 0, y: 0, width: iw, height: ih };
  let dst: Box = box;
  if (model.fit === 'contain') {
    const scale = Math.min(box.width / iw, box.height / ih);
    const width = iw * scale;
    const height = ih * scale;
    dst = { x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height };
  } else if (model.fit === 'cover') {
    const scale = Math.max(box.width / iw, box.height / ih);
    const width = box.width / scale;
    const height = box.height / scale;
    src = { x: (iw - width) / 2, y: (ih - height) / 2, width, height };
  }
  drawOps.push({ op: 'image', path: formatElementPath(model.path), image: model.source, src, dst });
  return {
    source: `res:${model.source}`,
    fit: model.fit,
    naturalWidth: iw,
    naturalHeight: ih,
    drawn: { x: roundMm(dst.x), y: roundMm(dst.y), width: roundMm(dst.width), height: roundMm(dst.height) },
  };
}
