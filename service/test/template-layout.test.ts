/**
 * 排布一块（模板设计页第三轮票据 03）：只经"给 `layout` 现在的值与点了什么、得到整项要写的值"这一入口，
 * 写回走 writeProperty，结果由引擎的 checkDslDocument 判断。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../console/src/template/document.js';
import { ALIGNS, alignmentOf, cellAxes, cellLabel, cellOn, flowOf, spreadOf, withCell, withFlow, withSpread, type Align, type Flow } from '../console/src/template/layout.js';
import { writeProperty } from '../console/src/template/properties.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE } from './seed.js';

const NAME = '全元素牌', CONTAINER = `${NAME}/容器`;
let original: JsonObject;
const fresh = (): JsonObject => JSON.parse(JSON.stringify(original)) as JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const elementOf = (document: JsonObject, path: string): JsonObject => {
  let node = document['artboard'] as JsonObject;
  for (const name of path.split('/').slice(1)) node = (node['children'] as JsonObject[]).find((child) => child['name'] === name)!;
  return node;
};
const childrenOf = (document: JsonObject, path: string) => (elementOf(document, path)['children'] ?? []) as JsonObject[];
/** 在页面上点方向图标：读现在的排布、算整项、写回。 */
const flowed = (document: JsonObject, path: string, flow: Flow): JsonObject =>
  writeProperty(document, path, ['layout'], withFlow(elementOf(document, path)['layout'], flow, childrenOf(document, path).length));
/** 在页面上点九宫格的一格。 */
const celled = (document: JsonObject, path: string, horizontal: Align, vertical: Align): JsonObject =>
  writeProperty(document, path, ['layout'], withCell(elementOf(document, path)['layout'], horizontal, vertical));

beforeAll(async () => {
  original = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(severe(original)).toEqual([]);
});

describe('现在是哪种排布', () => {
  it('没写是自由；堆叠按方向分横向、纵向；网格是网格', () => {
    expect(flowOf(undefined)).toBe('free');
    expect(flowOf({ mode: 'free' })).toBe('free');
    expect(flowOf({ mode: 'stack', direction: 'row' })).toBe('row');
    expect(flowOf({ mode: 'stack', direction: 'column' })).toBe('column');
    expect(flowOf({ mode: 'grid', rows: ['hug'], columns: ['hug'] })).toBe('grid');
    const document = fresh();
    expect(flowOf(elementOf(document, NAME)['layout'])).toBe('free');
    expect(flowOf(elementOf(document, CONTAINER)['layout'])).toBe('row');
  });
});

describe('点方向图标', () => {
  it('横向换纵向只改方向，间距、折行、对齐都留着', () => {
    const before = { mode: 'stack', direction: 'row', gap: 1, wrap: true, crossGap: 2, justifyContent: 'center', alignItems: 'end' };
    expect(withFlow(before, 'column')).toEqual({ ...before, direction: 'column' });
    expect(Object.keys(withFlow(before, 'column'))).toEqual(Object.keys(before));
    const document = flowed(fresh(), CONTAINER, 'column');
    expect(elementOf(document, CONTAINER)['layout']).toEqual({ mode: 'stack', direction: 'column', gap: 1 });
    expect(childrenOf(document, CONTAINER)[0]!['place']).toEqual({ height: 'fill' });
    expect(severe(document)).toEqual([]);
  });

  it('自由换堆叠：子元素的左上位置去掉，宽高留着', () => {
    const before = fresh(), document = flowed(before, NAME, 'column');
    expect(elementOf(document, NAME)['layout']).toEqual({ mode: 'stack', direction: 'column' });
    const kept = new Set(['width', 'height', 'margin', 'alignSelf']);
    childrenOf(document, NAME).forEach((child, index) => {
      const was = (childrenOf(before, NAME)[index]!['place'] ?? {}) as JsonObject;
      const expected = Object.fromEntries(Object.entries(was).filter(([key]) => kept.has(key)));
      expect(child['place'] ?? {}).toEqual(expected);
      expect(child['place'] ?? {}).not.toHaveProperty('left');
      expect(child['place'] ?? {}).not.toHaveProperty('top');
    });
    expect(severe(document)).toEqual([]);
  });

  it('堆叠换自由：只剩 mode，子元素认不得的键去掉', () => {
    const document = flowed(fresh(), CONTAINER, 'free');
    expect(elementOf(document, CONTAINER)['layout']).toEqual({ mode: 'free' });
    expect(childrenOf(document, CONTAINER)[0]!['place']).toEqual({ height: 'fill' });
    expect(severe(document)).toEqual([]);
  });

  it('横向堆叠换网格：一行、子元素几个就几列，间距成列间距，子元素一格一个', () => {
    expect(withFlow({ mode: 'stack', direction: 'row', gap: 1, crossGap: 2, alignItems: 'center' }, 'grid', 3)).toEqual({ mode: 'grid', rows: ['hug'], columns: ['hug', 'hug', 'hug'], columnGap: 1, rowGap: 2 });
    const document = flowed(fresh(), CONTAINER, 'grid');
    expect(elementOf(document, CONTAINER)['layout']).toEqual({ mode: 'grid', rows: ['hug'], columns: ['hug'], columnGap: 1 });
    expect(childrenOf(document, CONTAINER)[0]!['place']).toEqual({ height: 'fill', row: 1, column: 1 });
    expect(severe(document)).toEqual([]);
  });

  it('纵向堆叠与自由换网格：一列、子元素几个就几行；没有子元素也有一格', () => {
    expect(withFlow({ mode: 'stack', direction: 'column', gap: 1 }, 'grid', 2)).toEqual({ mode: 'grid', rows: ['hug', 'hug'], columns: ['hug'], rowGap: 1 });
    expect(withFlow(undefined, 'grid', 0)).toEqual({ mode: 'grid', rows: ['hug'], columns: ['hug'] });
    const before = fresh(), count = childrenOf(before, NAME).length, document = flowed(before, NAME, 'grid');
    const layout = elementOf(document, NAME)['layout'] as JsonObject;
    expect(layout).toEqual({ mode: 'grid', rows: Array.from({ length: count }, () => 'hug'), columns: ['hug'] });
    expect(childrenOf(document, NAME).map((child) => [(child['place'] as JsonObject)['row'], (child['place'] as JsonObject)['column']])).toEqual(Array.from({ length: count }, (_, index) => [index + 1, 1]));
    expect(severe(document)).toEqual([]);
  });

  it('网格换堆叠：主轴那一向的间距带过去；已经是网格再点网格不动', () => {
    const grid = { mode: 'grid', rows: ['hug', 'hug'], columns: ['hug', { fraction: 1 }], rowGap: 2, columnGap: 3 };
    expect(withFlow(grid, 'row')).toEqual({ mode: 'stack', direction: 'row', gap: 3 });
    expect(withFlow(grid, 'column')).toEqual({ mode: 'stack', direction: 'column', gap: 2 });
    expect(withFlow({ mode: 'grid', rows: ['hug'], columns: ['hug'] }, 'row')).toEqual({ mode: 'stack', direction: 'row' });
    expect(withFlow(grid, 'grid', 9)).toBe(grid);
    const document = flowed(flowed(fresh(), CONTAINER, 'grid'), CONTAINER, 'row');
    expect(elementOf(document, CONTAINER)['layout']).toEqual({ mode: 'stack', direction: 'row', gap: 1 });
    expect(childrenOf(document, CONTAINER)[0]!['place']).toEqual({ height: 'fill' });
    expect(severe(document)).toEqual([]);
  });

  it('换过去再换回来，内容和原来一样', () => {
    const before = fresh();
    for (const flow of ['column', 'grid', 'free'] as const) {
      const there = flowed(before, CONTAINER, flow);
      expect(severe(there)).toEqual([]);
      expect(flowed(there, CONTAINER, 'row')).toEqual(flow === 'free' ? writeProperty(before, CONTAINER, ['layout'], { mode: 'stack', direction: 'row' }) : before);
    }
    expect(before).toEqual(original);
  });
});

describe('九宫格对齐', () => {
  it('横向堆叠：左中右写 justifyContent，上中下写 alignItems', () => {
    const layout = { mode: 'stack', direction: 'row', gap: 1 };
    for (const horizontal of ALIGNS) for (const vertical of ALIGNS) {
      expect(cellAxes('row', horizontal, vertical)).toEqual({ main: horizontal, cross: vertical });
      const next = withCell(layout, horizontal, vertical);
      expect(next['justifyContent']).toBe(horizontal === 'start' ? undefined : horizontal);
      expect(next['alignItems']).toBe(vertical === 'start' ? undefined : vertical);
      expect(alignmentOf(next)).toEqual({ direction: 'row', main: horizontal, cross: vertical });
      for (const h of ALIGNS) for (const v of ALIGNS) expect(cellOn(alignmentOf(next)!, h, v)).toBe(h === horizontal && v === vertical);
    }
    expect(withCell(layout, 'end', 'center')).toEqual({ mode: 'stack', direction: 'row', gap: 1, alignItems: 'center', justifyContent: 'end' });
  });

  it('纵向堆叠：上中下写 justifyContent，左中右写 alignItems', () => {
    const layout = { mode: 'stack', direction: 'column' };
    for (const horizontal of ALIGNS) for (const vertical of ALIGNS) {
      expect(cellAxes('column', horizontal, vertical)).toEqual({ main: vertical, cross: horizontal });
      const next = withCell(layout, horizontal, vertical);
      expect(next['justifyContent']).toBe(vertical === 'start' ? undefined : vertical);
      expect(next['alignItems']).toBe(horizontal === 'start' ? undefined : horizontal);
      for (const h of ALIGNS) for (const v of ALIGNS) expect(cellOn(alignmentOf(next)!, h, v)).toBe(h === horizontal && v === vertical);
    }
    // 右上：纵向堆叠里"右"是交叉轴的末尾，"上"是主轴的开头（缺省，不写）。
    expect(withCell(layout, 'end', 'start')).toEqual({ mode: 'stack', direction: 'column', alignItems: 'end' });
    expect(withCell(layout, 'center', 'end')).toEqual({ mode: 'stack', direction: 'column', alignItems: 'center', justifyContent: 'end' });
  });

  it('缺省的 start 不写：点回左上是去掉两个键，别的键和先后不动', () => {
    const layout = { mode: 'stack', direction: 'row', justifyContent: 'center', gap: 1, alignItems: 'end', wrap: true };
    expect(withCell(layout, 'start', 'start')).toEqual({ mode: 'stack', direction: 'row', gap: 1, wrap: true });
    expect(Object.keys(withCell(layout, 'end', 'center'))).toEqual(Object.keys(layout));
    expect(alignmentOf({ mode: 'stack', direction: 'row' })).toEqual({ direction: 'row', main: 'start', cross: 'start' });
    expect(alignmentOf({ mode: 'free' })).toBeUndefined();
    expect(alignmentOf({ mode: 'grid', rows: ['hug'], columns: ['hug'] })).toBeUndefined();
    expect(alignmentOf(undefined)).toBeUndefined();
  });

  it('写进文档：九格每一格都过静态检查，点回原来的那格内容还原', () => {
    const before = fresh();
    for (const flow of ['row', 'column'] as const) {
      const base = flowed(before, CONTAINER, flow);
      for (const horizontal of ALIGNS) for (const vertical of ALIGNS) {
        const document = celled(base, CONTAINER, horizontal, vertical);
        expect(severe(document)).toEqual([]);
        expect(alignmentOf(elementOf(document, CONTAINER)['layout'])).toMatchObject(cellAxes(flow, horizontal, vertical));
        expect(childrenOf(document, CONTAINER)).toEqual(childrenOf(base, CONTAINER));
        expect(celled(document, CONTAINER, 'start', 'start')).toEqual(base);
      }
    }
  });

  it('换方向时两个键跟着轴走：横向的右中，换成纵向是下中', () => {
    const row = withCell({ mode: 'stack', direction: 'row' }, 'end', 'center');
    const column = alignmentOf(withFlow(row, 'column'))!;
    expect(cellOn(column, 'center', 'end')).toBe(true);
    expect(ALIGNS.flatMap((h) => ALIGNS.map((v) => cellOn(column, h, v))).filter(Boolean)).toHaveLength(1);
  });

  it('九格的叫法', () => {
    expect(ALIGNS.flatMap((vertical) => ALIGNS.map((horizontal) => cellLabel(horizontal, vertical)))).toEqual(['左上', '上中', '右上', '左中', '居中', '右中', '左下', '下中', '右下']);
  });
});

describe('两端与均分', () => {
  it('写进 justifyContent；这时九宫格只管交叉轴，对上的一排三格都亮', () => {
    const row = withSpread({ mode: 'stack', direction: 'row', gap: 1 }, 'spaceBetween');
    expect(row).toEqual({ mode: 'stack', direction: 'row', gap: 1, justifyContent: 'spaceBetween' });
    expect(spreadOf(alignmentOf(row))).toBe('spaceBetween');
    expect(ALIGNS.map((h) => cellOn(alignmentOf(row)!, h, 'start'))).toEqual([true, true, true]);
    expect(ALIGNS.map((h) => cellOn(alignmentOf(row)!, h, 'center'))).toEqual([false, false, false]);
    // 横向：点哪一列都一样，只写上中下。
    expect(withCell(row, 'end', 'center')).toEqual({ mode: 'stack', direction: 'row', gap: 1, justifyContent: 'spaceBetween', alignItems: 'center' });
    // 纵向：亮的是一列，点了只写左中右。
    const column = withSpread({ mode: 'stack', direction: 'column' }, 'spaceEvenly');
    expect(ALIGNS.map((v) => cellOn(alignmentOf(column)!, 'start', v))).toEqual([true, true, true]);
    expect(withCell(column, 'end', 'center')).toEqual({ mode: 'stack', direction: 'column', justifyContent: 'spaceEvenly', alignItems: 'end' });
  });

  it('两端换均分是改值；选回挨着排是去掉，主轴回到开头，交叉轴留着', () => {
    const between = withSpread({ mode: 'stack', direction: 'row', alignItems: 'center' }, 'spaceBetween');
    expect(withSpread(between, 'spaceEvenly')).toEqual({ mode: 'stack', direction: 'row', alignItems: 'center', justifyContent: 'spaceEvenly' });
    expect(withSpread(between, undefined)).toEqual({ mode: 'stack', direction: 'row', alignItems: 'center' });
    expect(spreadOf(alignmentOf(withSpread(between, undefined)))).toBeUndefined();
    // 本来就靠某一边：选"挨着排"不动。
    const packed = { mode: 'stack', direction: 'row', justifyContent: 'end' };
    expect(withSpread(packed, undefined)).toBe(packed);
    expect(spreadOf(alignmentOf(packed))).toBeUndefined();
  });

  it('不是堆叠时原样返回；写进文档过静态检查', () => {
    const grid = { mode: 'grid', rows: ['hug'], columns: ['hug'] };
    expect(withSpread(grid, 'spaceBetween')).toBe(grid);
    expect(withCell(grid, 'end', 'end')).toBe(grid);
    expect(withCell(undefined, 'end', 'end')).toEqual({ mode: 'free' });
    for (const spread of ['spaceBetween', 'spaceEvenly'] as const) {
      const before = fresh();
      const document = writeProperty(before, CONTAINER, ['layout'], withSpread(elementOf(before, CONTAINER)['layout'], spread));
      expect(elementOf(document, CONTAINER)['layout']).toEqual({ mode: 'stack', direction: 'row', gap: 1, justifyContent: spread });
      expect(severe(document)).toEqual([]);
      expect(writeProperty(document, CONTAINER, ['layout'], withSpread(elementOf(document, CONTAINER)['layout'], undefined))).toEqual(before);
    }
  });
});
