/** 树状图的几何（M364）：节点位置、拖到哪算第几个、适合窗口与缩放。 */
import { describe, expect, it } from 'vitest';
import { edgePath, fieldTop, fitView, MAP, mapSize, orderWhileDragging, rootTop, slotOf, zoomAt } from '../console/src/form/definition-map.js';

describe('树状图的几何', () => {
  it('根节点在字段那一列的竖直中间；有说明时图更宽；没有字段也放得下根节点', () => {
    const size = mapSize(5, false);
    expect(rootTop(size) + MAP.rootHeight / 2).toBeCloseTo((fieldTop(0) + fieldTop(4) + MAP.fieldHeight) / 2);
    expect(mapSize(5, true).width).toBeGreaterThan(size.width);
    expect(mapSize(0, false).height).toBeGreaterThanOrEqual(MAP.rootHeight);
  });

  it('拖到某个高度算第几个：就近，超出两头算第一个和最后一个', () => {
    expect(slotOf(fieldTop(2), 5)).toBe(2);
    expect(slotOf(fieldTop(2) + MAP.rowHeight * 0.6, 5)).toBe(3);
    expect(slotOf(-500, 5)).toBe(0);
    expect(slotOf(99999, 5)).toBe(4);
    expect(slotOf(0, 0)).toBe(0);
  });

  it('拖动时别的节点让开：挪动的落到目标位置，其余保持顺序', () => {
    expect(orderWhileDragging(4, 0, 2)).toEqual([1, 2, 0, 3]);
    expect(orderWhileDragging(4, 3, 0)).toEqual([3, 0, 1, 2]);
    expect(orderWhileDragging(3, 1, 1)).toEqual([0, 1, 2]);
  });

  it('适合窗口：整张图放进去并居中，不放大太多；太长时缩到下限，从上面开始', () => {
    const size = { width: 600, height: 400 };
    const small = fitView(size, { width: 300, height: 400 });
    expect(small.k).toBe(0.5);
    expect(small.x).toBe(0);
    expect(small.y).toBe(100);
    expect(fitView(size, { width: 6000, height: 4000 }).k).toBe(1.05);
    const tall = fitView({ width: 600, height: 5000 }, { width: 800, height: 400 });
    expect(tall.k).toBe(MAP.minZoom);
    expect(tall.y).toBe(0);
    expect(fitView(size, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, k: 1 });
  });

  it('缩放以指定的点为中心：那一点下面的内容不动；缩放有上下限', () => {
    const view = { x: 40, y: 20, k: 1 }, at = { x: 300, y: 200 };
    const zoomed = zoomAt(view, 1.2, at);
    expect((at.x - zoomed.x) / zoomed.k).toBeCloseTo((at.x - view.x) / view.k);
    expect((at.y - zoomed.y) / zoomed.k).toBeCloseTo((at.y - view.y) / view.k);
    expect(zoomAt(view, 100, at).k).toBe(MAP.maxZoom);
    expect(zoomAt(view, 0.001, at).k).toBe(MAP.minZoom);
  });

  it('连线从起点水平出去、水平进到终点', () => {
    expect(edgePath({ x: 0, y: 10 }, { x: 100, y: 50 })).toBe('M 0 10 C 50 10, 50 50, 100 50');
  });
});
