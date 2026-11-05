/**
 * 舞台的叠加层（模板设计页票据 06）：适配的压力、内容的来源、排布参考线。纯函数，入口与页面用的相同。
 */
import { describe, expect, it } from 'vitest';
import { contentKind, fitSummary, layoutGuides, fitResult } from '../console/src/design/overlays.js';
import type { LayoutNode } from '../console/src/types.js';

const node = (name: string, x: number, y: number, width: number, height: number, extra: Partial<LayoutNode> = {}): LayoutNode => ({ path: name, name, type: 'container', x, y, width, height, visible: true, ...extra });
const text = (compression: number, overflow = false): LayoutNode['text'] => ({ content: '字', font: 'res:f', writingMode: 'vertical', fontSize: 10, width: 10, height: 10, spacing: 0, compression, overflow, fragments: [] });

describe('fitSummary', () => {
  it('只数会显示的文字；放不下的另算', () => {
    const root = node('牌', 0, 0, 100, 100, { children: [
      node('甲', 0, 0, 10, 10, { text: text(1) }),
      node('乙', 0, 0, 10, 10, { text: text(0.74) }),
      node('丙', 0, 0, 10, 10, { text: text(0.6, true) }),
      node('丁', 0, 0, 0, 0, { text: text(0.5), visible: false }),
    ] });
    expect(fitSummary(root)).toEqual({ compressed: 2, lowest: 0.6, overflow: 1 });
    expect(fitSummary(node('空', 0, 0, 1, 1))).toEqual({ compressed: 0, overflow: 0 });
  });
});

describe('contentKind', () => {
  it('有插槽或绑定的是数据驱动，写死的是固定内容，容器与图形不算', () => {
    expect(contentKind({ type: 'text', content: [{ text: '开往' }, { slot: 'terminal.name' }] })).toBe('data');
    expect(contentKind({ type: 'text', content: [{ text: '开往' }] })).toBe('fixed');
    expect(contentKind({ type: 'image', source: { var: 'photo' } })).toBe('data');
    expect(contentKind({ type: 'image', source: 'res:logo' })).toBe('fixed');
    expect(contentKind({ type: 'qrcode', content: { var: 'no' } })).toBe('data');
    expect(contentKind({ type: 'barcode', content: 'SP0001' })).toBe('fixed');
    expect(contentKind({ type: 'container' })).toBeUndefined();
    expect(contentKind(undefined)).toBeUndefined();
  });
});

describe('layoutGuides', () => {
  it('横向堆叠：相邻子元素之间的空隙与内边距；隐藏的子元素不算', () => {
    const element = { layout: { mode: 'stack', direction: 'row', gap: 8 }, padding: { left: 22, right: 18 } };
    const parent = node('顶栏', 0, 0, 200, 34, { children: [node('甲', 22, 0, 40, 34), node('藏', 0, 0, 0, 0, { visible: false }), node('乙', 70, 0, 50, 34)] });
    const guides = layoutGuides(element, parent);
    expect(guides.gaps).toEqual([{ x: 62, y: 0, width: 8, height: 34 }]);
    expect(guides.padding).toEqual([{ x: 0, y: 0, width: 22, height: 34 }, { x: 182, y: 0, width: 18, height: 34 }]);
    expect(guides.tracks).toEqual([]);
  });

  it('纵向堆叠与循环的项间距', () => {
    const column = node('列', 0, 0, 50, 100, { children: [node('甲', 0, 0, 50, 20), node('乙', 0, 24, 50, 20)] });
    expect(layoutGuides({ layout: { mode: 'stack', direction: 'column', gap: 4 } }, column).gaps).toEqual([{ x: 0, y: 20, width: 50, height: 4 }]);
    const row = node('循环', 0, 0, 100, 20, { type: 'loop', children: [node('甲', 0, 0, 40, 20), node('乙', 45, 0, 40, 20)] });
    expect(layoutGuides({ type: 'loop', itemLayout: { gap: 5 } }, row).gaps).toEqual([{ x: 40, y: 0, width: 5, height: 20 }]);
  });

  it('网格：轨道的分隔线与尺寸标注，跨行的元素不用来定轨道', () => {
    const element = {
      layout: { mode: 'grid', rows: [{ fixed: 34 }, { fraction: 1 }, 'hug'], columns: [{ fraction: 1 }] },
      children: [{ name: '顶', place: { row: 1, column: 1 } }, { name: '跨', place: { row: 2, column: 1, rowSpan: 2 } }, { name: '中', place: { row: 2, column: 1 } }, { name: '底', place: { row: 3, column: 1 } }],
    };
    const parent = node('牌', 0, 0, 740, 165, { children: [node('顶', 0, 0, 740, 34), node('跨', 0, 34, 740, 131), node('中', 0, 34, 740, 100), node('底', 0, 134, 740, 31)] });
    const guides = layoutGuides(element, parent);
    expect(guides.tracks.filter((track) => track.axis === 'row').map((track) => track.at)).toEqual([34, 134]);
    expect(guides.tracks.filter((track) => track.axis === 'column')).toEqual([]);
    expect(guides.labels.map((label) => label.text)).toEqual(['34 mm', '1 份', '随内容', '1 份']);
  });

  it('没有排布的元素只有内边距；没有元素或实例时什么也没有', () => {
    expect(layoutGuides({ padding: 2 }, node('框', 0, 0, 10, 10)).padding).toHaveLength(4);
    expect(layoutGuides(undefined, undefined)).toEqual({ gaps: [], padding: [], tracks: [], labels: [] });
  });
});

describe('这一处实例的适配结果', () => {
  const text = (over: Partial<{ compression: number; fontSize: number; spacing: number; overflow: boolean }>) => ({ font: 'res:a', writingMode: 'horizontal', width: 10, height: 3, fragments: [], fontSize: 10, spacing: 0, compression: 1, overflow: false, ...over });
  it('压缩了写压到多少，字号与字距照布局摘要', () => {
    expect(fitResult(text({ compression: 0.74 }))).toBe('压到 74%，字号 10 mm，字距 0 mm');
    expect(fitResult(text({ fontSize: 7.456, spacing: 0.3 }))).toBe('没有压缩，字号 7.46 mm，字距 0.3 mm');
    expect(fitResult(text({ compression: 0.6, overflow: true }))).toBe('压到 60%，字号 10 mm，字距 0 mm，仍放不下');
  });
});
