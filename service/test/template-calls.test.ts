/**
 * 循环与调用的表单（模板设计页票据 15）：写回由 checkDslDocument 判断。文档是 M402 主模板：站点列传三种参数，道路段列合并相邻。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { argRows, dataOf, directionOf, itemSizeOf, mergeBlocked, setData, setDirection, setElement, setItemSize, setMergeBy, setWrap, sizeBlocked, wrapBlocked, writeArg } from '../console/src/template/calls.js';
import { elementAt, type JsonObject } from '../console/src/template/document.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE, M402_DIR } from './seed.js';

const ROOT = '标准线路单边', STOPS = `${ROOT}/站点面板/站点列`, ROADS = `${ROOT}/道路带/道路段列`, TIMES = `${ROOT}/底栏/服务时间内容/班次说明/班次列`;
let route: JsonObject, stop: JsonObject, road: JsonObject, all: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const at = (path: string) => elementAt(route, path)!.element;
/** 改完一个元素，整份模板仍合法。 */
const valid = (path: string, next: JsonObject | { problem: string }) => {
  expect(next).not.toHaveProperty('problem');
  expect(severe(setElement(route, path, next as JsonObject))).toEqual([]);
  return next as JsonObject;
};

beforeAll(async () => {
  route = JSON.parse(await readFile(`${M402_DIR}template-route-sign.json`, 'utf8')) as JsonObject;
  stop = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8')) as JsonObject;
  road = JSON.parse(await readFile(`${M402_DIR}template-road-segment.json`, 'utf8')) as JsonObject;
  all = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(elementAt(route, TIMES), '班次列在底栏里').toBeDefined();
});

describe('每项排布', () => {
  it('换方向：每项尺寸从每项宽换到每项高，值不变', () => {
    const column = valid(STOPS, setDirection(at(STOPS), 'column'));
    expect(column['itemLayout']).toEqual({ direction: 'column', heights: 'equal' });
    expect(directionOf(column)).toBe('column');
    expect(valid(STOPS, setDirection(column, 'row'))['itemLayout']).toEqual({ direction: 'row', widths: 'equal' });
  });

  it('每项尺寸：等分、随内容、固定', () => {
    expect(itemSizeOf(valid(STOPS, setItemSize(at(STOPS), 'content') as JsonObject))).toBe('content');
    expect(itemSizeOf(valid(STOPS, setItemSize(at(STOPS), { fixed: 18 }) as JsonObject))).toEqual({ fixed: 18 });
  });

  it('折行不能配等分：先换成随内容，再开折行；关掉时换行间距一起去掉', () => {
    expect(wrapBlocked(at(STOPS))).toContain('不能配等分');
    expect(setWrap(at(STOPS), true)).toHaveProperty('problem');
    const content = setItemSize(at(STOPS), 'content') as JsonObject;
    const wrapped = valid(STOPS, setWrap(content, true));
    expect(sizeBlocked(wrapped, 'equal')).toContain('折行不能配等分');
    const crossed = { ...wrapped, itemLayout: { ...(wrapped['itemLayout'] as JsonObject), crossGap: 2 } };
    expect(valid(STOPS, setWrap(crossed, false))['itemLayout']).toEqual({ direction: 'row', widths: 'content' });
  });

  it('合并相邻：只能配等分，写 spanBy；去掉时一起去掉；不能配折行', () => {
    const merged = valid(ROADS, setMergeBy(at(ROADS), 'road'));
    expect(merged).toMatchObject({ mergeBy: 'road', itemLayout: { widths: 'equal', spanBy: 'groupSize' } });
    expect(sizeBlocked(merged, 'content')).toContain('只能配等分');
    expect(wrapBlocked(merged)).toContain('合并相邻');
    const unmerged = valid(ROADS, setMergeBy(at(ROADS), undefined));
    expect(unmerged).not.toHaveProperty('mergeBy');
    expect(unmerged['itemLayout']).not.toHaveProperty('spanBy');
    const timesWrapped = setWrap(at(TIMES), true) as JsonObject;
    expect(mergeBlocked(timesWrapped)).toContain('折行');
    expect(setMergeBy(timesWrapped, 'time')).toHaveProperty('problem');
  });
});

describe('传入参数', () => {
  it('列出被调模板的全部对外参数，标出现在传的和没缺省值又没传的', () => {
    const { rows, extra } = argRows(at(STOPS), stop);
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(['index', 'currentIndex', 'stopNameSize']));
    expect(rows.find((row) => row.name === 'index')).toMatchObject({ value: { loop: 'index' } });
    expect(extra).toEqual([]);
    const dropped = writeArg(at(STOPS), 'currentIndex', undefined);
    const missing = argRows(dropped, stop).rows.find((row) => row.name === 'currentIndex')!;
    expect(missing.missing).toBe(!missing.hasDefault);
  });

  it('来源换成固定值、变量、循环信息，写回都合法；args 空了就去掉', () => {
    let element = valid(STOPS, writeArg(at(STOPS), 'currentIndex', { value: 3 }));
    element = valid(STOPS, writeArg(element, 'currentIndex', { var: 'currentIndex' }));
    element = valid(STOPS, writeArg(element, 'index', { loop: 'index' }));
    const first = argRows(at(ROADS), road).rows.find((row) => row.name === 'isFirst')!;
    expect(first).toMatchObject({ type: 'boolean', value: { loop: 'isFirst' } });
    expect(writeArg(at(ROADS), 'isFirst', undefined)).not.toHaveProperty('args');
  });

  it('多传的（被调模板没有这个参数）另列出来', () => {
    const extra = writeArg(at(STOPS), 'nothing', { value: 1 });
    expect(argRows(extra, stop).extra).toEqual(['nothing']);
  });
});

describe('调用的数据', () => {
  it('不传、当前数据、单引用字段', () => {
    const call = elementAt(all, '全元素牌/调用')!.element;
    expect(dataOf(call)).toBe('mainSession');
    expect(setData(call, 'none')).not.toHaveProperty('data');
    expect(setData(call, 'current')).toMatchObject({ data: 'current' });
    expect(dataOf(setData(call, 'current'))).toBe('current');
    expect(severe(setElement(all, '全元素牌/调用', setData(call, 'mainSession')))).toEqual([]);
  });
});
