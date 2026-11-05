/**
 * 树状图的几何（M380）：节点放在哪、连线怎么走、缩放与适合窗口、拖到哪算第几个。全是纯函数，页面只管画。
 * 坐标是"图上的"，页面用一个位移加缩放把它放进窗口。
 */
export interface MapView { readonly x: number; readonly y: number; readonly k: number }
export interface MapSize { readonly width: number; readonly height: number }
export interface MapPoint { readonly x: number; readonly y: number }

export const MAP = {
  pad: 32, rootX: 32, rootWidth: 216, rootHeight: 84,
  fieldX: 320, fieldWidth: 216, fieldHeight: 66, rowHeight: 80,
  detailX: 596, detailWidth: 176, detailHeight: 54,
  minZoom: 0.4, maxZoom: 1.3,
} as const;

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/** 第几个字段的上边。 */
export const fieldTop = (index: number) => MAP.pad + index * MAP.rowHeight;

/** 图的大小：有列表或引用时右边多一列说明。 */
export function mapSize(count: number, withDetail: boolean): MapSize {
  const right = withDetail ? MAP.detailX + MAP.detailWidth : MAP.fieldX + MAP.fieldWidth;
  return { width: right + MAP.pad, height: Math.max(MAP.pad * 2 + MAP.rootHeight, MAP.pad * 2 + count * MAP.rowHeight - (MAP.rowHeight - MAP.fieldHeight)) };
}

/** 根节点的上边：在字段那一列的竖直中间。 */
export const rootTop = (size: MapSize) => (size.height - MAP.rootHeight) / 2;

/** 拖到这个高度，算排到第几个。 */
export const slotOf = (top: number, count: number) => clamp(Math.round((top - MAP.pad) / MAP.rowHeight), 0, Math.max(0, count - 1));

/** 把第 from 个挪到第 to 个之后，各自排在第几：拖动时别的节点先让开。 */
export function orderWhileDragging(count: number, from: number, to: number): readonly number[] {
  const order = Array.from({ length: count }, (_, index) => index);
  const [moved] = order.splice(from, 1);
  if (moved !== undefined) order.splice(to, 0, moved);
  return order;
}

/** 适合窗口：整张图放进去并居中；太长时缩到下限，从上面开始看。 */
export function fitView(size: MapSize, box: MapSize): MapView {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0, k: 1 };
  const k = clamp(Math.min(box.width / size.width, box.height / size.height), MAP.minZoom, 1.05);
  const height = size.height * k;
  return { x: (box.width - size.width * k) / 2, y: height > box.height ? 0 : (box.height - height) / 2, k };
}

/** 以窗口里的某一点为中心缩放：那一点下面的内容不动。 */
export function zoomAt(view: MapView, factor: number, at: MapPoint): MapView {
  const k = clamp(view.k * factor, MAP.minZoom, MAP.maxZoom), ratio = k / view.k;
  return { x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio, k };
}

/** 连线：从一点水平出去，水平进到另一点。 */
export function edgePath(from: MapPoint, to: MapPoint): string {
  const bend = Math.max(36, (to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}
