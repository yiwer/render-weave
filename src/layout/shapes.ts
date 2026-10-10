/**
 * 图形元素：矩形、椭圆、线条、多边形与路径。
 * 线条、多边形与路径的坐标以毫米计、相对元素框左上角，框变化时不拉伸（M94）；
 * 随内容时的尺寸取图形坐标的最右与最下处。
 */
import type { Corners, ShapeModel } from '../template/model.js';
import type { Box, DrawOp, Radii, Size } from './types.js';

/** 路径的边界，毫米；路径数据不合法时为 undefined。 */
export type PathBounds = (d: string) => { readonly right: number; readonly bottom: number } | undefined;

export function shapeIntrinsic(model: ShapeModel, pathBounds: PathBounds): Size {
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
      drawOps.push({ op: 'path', x: box.x, y: box.y, d: polyline([model.from, model.to], false), fillRule: 'nonzero', ...stroke });
      return;
    case 'polygon':
      drawOps.push({ op: 'path', x: box.x, y: box.y, d: polyline(model.points, true), fillRule: 'nonzero', ...fill, ...stroke });
      return;
    case 'path':
      drawOps.push({ op: 'path', x: box.x, y: box.y, d: model.d, fillRule: model.fillRule, ...fill, ...stroke });
      return;
  }
}

export function radii(corners: Corners): Radii {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
}

function polyline(points: readonly (readonly [number, number])[], closed: boolean): string {
  const [first, ...rest] = points;
  if (!first) return '';
  return `M${first[0]} ${first[1]}${rest.map((point) => ` L${point[0]} ${point[1]}`).join('')}${closed ? ' Z' : ''}`;
}
