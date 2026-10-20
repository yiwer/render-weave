/**
 * 图形元素：矩形、椭圆、线条、多边形与路径。
 * 未声明 viewBox 时，线条、多边形与路径的坐标以毫米计、相对元素框左上角，框变化时不拉伸（M94），随内容尺寸取坐标最右与最下处；
 * 声明 viewBox 时，随内容尺寸取 viewBox 宽高（contain/cover 且单边固定时按宽高比换算），绘制时按 fit 映射变换路径顶点（M242）。
 */
import type { Corners, ShapeModel } from '../template/model.js';
import type { Box, DrawOp, Radii, Size } from './types.js';

/** 路径的边界，毫米；路径数据不合法时为 undefined。 */
export type PathBounds = (d: string) => { readonly right: number; readonly bottom: number } | undefined;

export function shapeIntrinsic(model: ShapeModel, pathBounds: PathBounds): Size {
  if (model.type !== 'rect' && model.type !== 'ellipse' && model.viewBox) {
    const [, , vw, vh] = model.viewBox;
    if (model.fit !== 'fill') {
      const ratio = vh / vw;
      const { width, height } = model.place;
      if (width?.kind === 'fixed' && height?.kind !== 'fixed') return { width: width.value, height: width.value * ratio };
      if (height?.kind === 'fixed' && width?.kind !== 'fixed') return { width: height.value / ratio, height: height.value };
    }
    return { width: vw, height: vh };
  }
  switch (model.type) {
    case 'rect':
    case 'ellipse':
      return { width: 0, height: 0 };
    case 'line':
      return { width: Math.max(0, model.from[0], model.to[0]), height: Math.max(0, model.from[1], model.to[1]) };
    case 'polygon':
      return {
        width: Math.max(0, ...model.points.map((point) => point[0])),
        height: Math.max(0, ...model.points.map((point) => point[1])),
      };
    case 'path': {
      const bounds = pathBounds(model.d);
      return { width: Math.max(0, bounds?.right ?? 0), height: Math.max(0, bounds?.bottom ?? 0) };
    }
  }
}

export function recordShape(model: ShapeModel, box: Box, drawOps: DrawOp[]): void {
  const stroke = model.stroke && { stroke: model.stroke };
  const fill = model.type !== 'line' && model.fill ? { fill: model.fill } : {};
  switch (model.type) {
    case 'rect':
      drawOps.push({ op: 'rect', ...box, radii: radii(model.cornerRadius), ...fill, ...stroke });
      return;
    case 'ellipse':
      drawOps.push({ op: 'ellipse', ...box, ...fill, ...stroke });
      return;
    case 'line':
    case 'polygon':
    case 'path': {
      if (model.viewBox && (box.width <= 0 || box.height <= 0)) return;
      const d =
        model.type === 'line'
          ? polyline([model.from, model.to], false)
          : model.type === 'polygon'
            ? polyline(model.points, true)
            : model.d;
      const fillRule = model.type === 'path' ? model.fillRule : 'nonzero';
      const scaling = model.viewBox ? viewBoxTransform(model.viewBox, model.fit, box) : {};
      drawOps.push({ op: 'path', x: box.x, y: box.y, d, fillRule, ...fill, ...stroke, ...scaling });
      return;
    }
  }
}

function viewBoxTransform(
  viewBox: readonly [number, number, number, number],
  fit: 'fill' | 'contain' | 'cover',
  box: Box,
): Pick<Extract<DrawOp, { op: 'path' }>, 'transform' | 'clip'> {
  const [minX, minY, vw, vh] = viewBox;
  if (fit === 'fill') {
    const sx = box.width / vw;
    const sy = box.height / vh;
    return { transform: { sx, sy, tx: -minX * sx, ty: -minY * sy } };
  }
  const scale = fit === 'contain' ? Math.min(box.width / vw, box.height / vh) : Math.max(box.width / vw, box.height / vh);
  const tx = (box.width - vw * scale) / 2 - minX * scale;
  const ty = (box.height - vh * scale) / 2 - minY * scale;
  return {
    transform: { sx: scale, sy: scale, tx, ty },
    ...(fit === 'cover' && { clip: { width: box.width, height: box.height } }),
  };
}

export function radii(corners: Corners): Radii {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
}

function polyline(points: readonly (readonly [number, number])[], closed: boolean): string {
  const [first, ...rest] = points;
  if (!first) return '';
  return `M${first[0]} ${first[1]}${rest.map((point) => ` L${point[0]} ${point[1]}`).join('')}${closed ? ' Z' : ''}`;
}
