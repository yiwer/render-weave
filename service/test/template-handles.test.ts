/**
 * 舞台上的手柄（模板设计页票据 13，M392）：每种父布局、每种手柄配字面值与绑定两种情况；写回结果由 checkDslDocument 判断。
 * 文档：全部元素（自由布局）、会议胸牌（纵向堆叠）、M402 主模板（网格画板、横向堆叠的顶栏、循环）、M402 站点（状态样式）。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { setElement } from '../console/src/template/calls.js';
import { elementAt, type JsonObject } from '../console/src/template/document.js';
import { applyHandle, gridTracks, handlesOf, layoutContext, nudge, type Gesture, type HandleInput } from '../console/src/template/handles.js';
import type { LayoutNode } from '../console/src/types.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE, CONSOLE_BADGE_DIR, M402_DIR } from './seed.js';

const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
let all: JsonObject, badge: JsonObject, route: JsonObject, stop: JsonObject;
beforeAll(async () => {
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as JsonObject;
  all = await read(ALL_ELEMENTS_FILE);
  badge = await read(`${CONSOLE_BADGE_DIR}template-badge.json`);
  route = await read(`${M402_DIR}template-route-sign.json`);
  stop = await read(`${M402_DIR}template-stop.json`);
});

const box = (path: string, x: number, y: number, width: number, height: number, children?: LayoutNode[]): LayoutNode => ({ path, name: path.split('/').at(-1)!, type: 'container', x, y, width, height, visible: true, ...(children ? { children } : {}) });
const drag = (handle: Gesture['handle'], dx: number, dy: number, point = { x: 0, y: 0 }, fine = false): Gesture => ({ handle, dx, dy, point, ...(fine ? { fine } : {}) });
const placeOf = (document: JsonObject, path: string) => elementAt(document, path)!.element['place'];
const ids = (input: HandleInput) => handlesOf(input).handles.map((handle) => handle.id);
/** 写回合法：没有严重问题。 */
const valid = (result: ReturnType<typeof applyHandle>) => {
  expect(result).toBeDefined();
  expect(severe(result!.document)).toEqual([]);
  return result!;
};

describe('自由布局', () => {
  const TEXT = '全部元素/文字';
  const input = (document = all, extra: Partial<HandleInput> = {}): HandleInput => ({ document, template: '全部元素', path: TEXT, node: box(TEXT, 2, 42, 60, 10), ...extra });
  const withPlace = (place: JsonObject, more: JsonObject = {}) => setElement(all, TEXT, { ...elementAt(all, TEXT)!.element, place, ...more });

  it('移动写距左、距上，吸到 0.5 mm；按住 Shift 吸到 0.1 mm；八个手柄都有', () => {
    expect(ids(input())).toEqual(['move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    expect(handlesOf(input()).can).toContain('拖八个手柄改宽高');
    const moved = valid(applyHandle(input(), drag('move', 3.3, -1.2)));
    expect(placeOf(moved.document, TEXT)).toEqual({ left: 5.5, top: 41, width: { fixed: 60 }, height: { fixed: 10 } });
    expect(moved.ghost).toEqual({ x: 5.5, y: 41, width: 60, height: 10 });
    expect(moved.readout).toBe('距左 5.5 · 距上 41 mm');
    expect(placeOf(valid(applyHandle(input(), drag('move', 3.33, 0, undefined, true))).document, TEXT)).toMatchObject({ left: 5.3, top: 42 });
    // 没动到下一格：不写回。
    expect(applyHandle(input(), drag('move', 0.2, 0.1))).toBeUndefined();
  });

  it('左上角：距左、距上跟着动，右边与下边不动', () => {
    const result = valid(applyHandle(input(), drag('nw', 1, 1)));
    expect(placeOf(result.document, TEXT)).toEqual({ left: 3, top: 43, width: { fixed: 59 }, height: { fixed: 9 } });
    expect(result.ghost).toEqual({ x: 3, y: 43, width: 59, height: 9 });
    expect(result.readout).toBe('宽 59 × 高 9 mm');
    // 拖过头：尺寸不小于 0.1 mm。
    expect(placeOf(valid(applyHandle(input(), drag('e', -80, 0))).document, TEXT)).toMatchObject({ width: { fixed: 0.1 } });
  });

  it('原来写的是距右：保持距右，移动与右边改距右，左边只改宽', () => {
    const document = withPlace({ right: 38, top: 42, width: { fixed: 60 }, height: { fixed: 10 } });
    const moved = valid(applyHandle(input(document), drag('move', 2, 0)));
    expect(placeOf(moved.document, TEXT)).toEqual({ right: 36, top: 42, width: { fixed: 60 }, height: { fixed: 10 } });
    expect(moved.readout).toBe('距右 36 · 距上 42 mm');
    const east = valid(applyHandle(input(document), drag('e', 2, 0)));
    expect(placeOf(east.document, TEXT)).toMatchObject({ right: 36, width: { fixed: 62 } });
    expect(east.ghost).toEqual({ x: 2, y: 42, width: 62, height: 10 });
    const west = valid(applyHandle(input(document), drag('w', 2, 0)));
    expect(placeOf(west.document, TEXT)).toMatchObject({ right: 38, width: { fixed: 58 } });
    expect(west.ghost).toEqual({ x: 4, y: 42, width: 58, height: 10 });
  });

  it('距左绑定了变量：不能横着拖，右边仍能改宽；竖着照常', () => {
    const document = withPlace({ left: { var: 'bandHeight' }, top: 42, width: { fixed: 60 }, height: { fixed: 10 } });
    expect(severe(document)).toEqual([]);
    const set = handlesOf(input(document));
    expect(set.handles.map((handle) => handle.id)).toEqual(['move', 'n', 'ne', 'e', 'se', 's']);
    expect(set.notes).toContain('距左绑定了变量 bandHeight，不能横着拖。');
    const moved = valid(applyHandle(input(document), drag('move', 5, 2)));
    expect(placeOf(moved.document, TEXT)).toEqual({ left: { var: 'bandHeight' }, top: 44, width: { fixed: 60 }, height: { fixed: 10 } });
    expect(applyHandle(input(document), drag('w', 1, 0))).toBeUndefined();
  });

  it('宽是随内容、高绑定了变量：没有尺寸手柄，写明怎么改；都没写距左时移动补上 left', () => {
    const document = withPlace({ top: 42, height: { fixed: { var: 'nameSize' } } });
    expect(severe(document)).toEqual([]);
    const set = handlesOf(input(document));
    expect(set.handles.map((handle) => handle.id)).toEqual(['move']);
    expect(set.notes).toEqual(['宽是随内容，没有手柄：先在检查器的位置与尺寸里切成固定。', '高绑定了变量 nameSize，没有手柄：在检查器里换成固定值再拖。']);
    expect(placeOf(valid(applyHandle(input(document), drag('move', 4, 0))).document, TEXT)).toEqual({ top: 42, height: { fixed: { var: 'nameSize' } }, left: 4 });
  });

  it('旋转的元素只给移动', () => {
    const document = withPlace({ left: 2, top: 42, width: { fixed: 60 }, height: { fixed: 10 } }, { rotation: 15 });
    const set = handlesOf(input(document));
    expect(set.handles.map((handle) => handle.id)).toEqual(['move']);
    expect(set.notes).toContain('旋转的元素只能移动：框不计旋转，尺寸在检查器里填。');
    expect(applyHandle(input(document), drag('se', 2, 2))).toBeUndefined();
  });

  it('方向键：步长 0.5 mm，Shift 0.1 mm，不吸附', () => {
    const document = withPlace({ left: 3.3, top: 42, width: { fixed: 60 }, height: { fixed: 10 } });
    expect(placeOf(valid(nudge(input(document), 'ArrowRight', false)).document, TEXT)).toMatchObject({ left: 3.8 });
    expect(placeOf(valid(nudge(input(document), 'ArrowUp', true)).document, TEXT)).toMatchObject({ top: 41.9 });
  });

  it('子模板里的元素：读数写明图上几处一起变', () => {
    expect(applyHandle(input(all, { count: 35 }), drag('move', 1, 0))!.readout).toBe('距左 3 · 距上 42 mm；图上 35 处一起变');
  });
});

describe('堆叠', () => {
  // 胸牌：画板纵向堆叠，间距 1.5。
  const kids = [box('胸牌/页眉', 0, 0, 100, 10), box('胸牌/照片', 38, 11.5, 24, 24), box('胸牌/姓名', 25, 37, 50, 6), box('胸牌/单位', 0, 44.5, 100, 5), box('胸牌/身份', 45, 51, 10, 5)];
  const parent = box('胸牌', 0, 0, 100, 160, kids);
  const input = (path: string, extra: Partial<HandleInput> = {}): HandleInput => ({ document: badge, template: '胸牌', path, node: kids.find((kid) => kid.path === path)!, parent, ...extra });
  const order = (document: JsonObject) => (elementAt(document, '胸牌')!.element['children'] as JsonObject[]).map((child) => child['name']);

  it('固定的尺寸才有手柄：相框宽高都固定，右边、下边、右下角', () => {
    expect(ids(input('胸牌/照片'))).toEqual(['move', 'e', 's', 'se']);
    const taller = valid(applyHandle(input('胸牌/照片'), drag('s', 0, 2.2)));
    expect(placeOf(taller.document, '胸牌/照片')).toEqual({ width: { fixed: 24 }, height: { fixed: 26 } });
    expect(taller.readout).toBe('宽 24 × 高 26 mm');
    expect(taller.ghost).toEqual({ x: 38, y: 11.5, width: 24, height: 26 });
  });

  it('随内容与撑满的尺寸没有手柄，写明怎么改', () => {
    expect(ids(input('胸牌/姓名'))).toEqual(['move', 'e']);
    expect(handlesOf(input('胸牌/姓名')).notes).toEqual(['高是随内容，没有手柄：先在检查器的位置与尺寸里切成固定。']);
    expect(handlesOf(input('胸牌/单位')).notes[0]).toBe('宽是撑满，没有手柄：先在检查器的位置与尺寸里切成固定。');
  });

  it('沿主轴拖动改顺序：越过姓名的中线就排到它后面，读数写明叠放', () => {
    const result = valid(applyHandle(input('胸牌/照片'), drag('move', 0, 20, { x: 50, y: 44 })));
    expect(order(result.document).slice(0, 4)).toEqual(['页眉', '姓名', '照片', '单位']);
    expect(result.readout).toBe('放到第 3 位（共 8 位）；堆叠里的先后也是叠放的先后，后面的压在前面上');
    expect(result.line).toEqual({ x: 25, y: 43, width: 50, height: 0 });
    // 没越过相邻的中线：顺序不变，不写回。
    expect(applyHandle(input('胸牌/照片'), drag('move', 0, 2, { x: 50, y: 30 }))).toBeUndefined();
    // 拖到最前。
    expect(order(valid(applyHandle(input('胸牌/照片'), drag('move', 0, -20, { x: 50, y: 2 }))).document)[0]).toBe('照片');
  });

  it('方向键沿主轴和前后换位；横着按不动', () => {
    expect(order(valid(nudge(input('胸牌/照片'), 'ArrowDown', false)).document).slice(0, 3)).toEqual(['页眉', '姓名', '照片']);
    expect(order(valid(nudge(input('胸牌/照片'), 'ArrowUp', false)).document).slice(0, 2)).toEqual(['照片', '页眉']);
    expect(nudge(input('胸牌/照片'), 'ArrowRight', false)).toBeUndefined();
  });

  it('状态样式选中一个取值：写进这个取值的覆盖，整份 place，原来的不动', () => {
    const MARK = '站点/名称区/地标';
    const marks = { document: stop, template: '站点', path: MARK, node: box(MARK, 6, 14, 8, 8), parent: box('站点/名称区', 0, 8, 20, 16, [box('站点/名称区/站名', 2, 8, 16, 5), box(MARK, 6, 14, 8, 8)]) };
    const result = valid(applyHandle({ ...marks, state: '已过站' }, drag('s', 0, 1)));
    const element = elementAt(result.document, MARK)!.element;
    expect(element['place']).toEqual({ width: { fixed: 8 }, height: { fixed: 8 }, margin: { top: 1 } });
    expect(element['states']).toEqual({ by: { var: 'stopState' }, cases: { 已过站: { opacity: 0.35, place: { width: { fixed: 8 }, height: { fixed: 9 }, margin: { top: 1 } } } } });
    // 再拖一次，从覆盖里的值接着算。
    const again = valid(applyHandle({ ...marks, document: result.document, state: '已过站' }, drag('s', 0, 1)));
    expect((elementAt(again.document, MARK)!.element['states'] as { cases: { 已过站: { place: unknown } } }).cases.已过站.place).toMatchObject({ height: { fixed: 10 } });
    // 还没有覆盖的取值：新写一条。
    const fresh = valid(applyHandle({ ...marks, state: '本站' }, drag('e', 1, 0)));
    expect((elementAt(fresh.document, MARK)!.element['states'] as { cases: JsonObject }).cases['本站']).toEqual({ place: { width: { fixed: 9 }, height: { fixed: 8 }, margin: { top: 1 } } });
  });
});

describe('网格', () => {
  // M402 主模板：画板四行（34、1 份、10、21），一列。
  const kids = [box('标准线路单边/顶栏', 0, 0, 740, 34), box('标准线路单边/站点面板', 0, 34, 740, 100), box('标准线路单边/道路带', 0, 134, 740, 10), box('标准线路单边/底栏', 0, 144, 740, 21)];
  const board = box('标准线路单边', 0, 0, 740, 165, kids);
  const input = (path: string, document = route, extra: Partial<HandleInput> = {}): HandleInput => ({ document, template: '标准线路单边', path, node: kids.find((kid) => kid.path === path) ?? board, parent: board, ...extra });

  it('轨道位置：固定取定值，按比例的分剩余', () => {
    expect(gridTracks(elementAt(route, '标准线路单边')!.element, board)!.rows.map((row) => [row.start, row.size, row.kind])).toEqual([[0, 34, 'fixed'], [34, 100, 'fraction'], [134, 10, 'fixed'], [144, 21, 'fixed']]);
  });

  it('吸到格子写行列；下边改跨度，不超出轨道数；只有一列时没有右边的手柄', () => {
    expect(ids(input('标准线路单边/道路带'))).toEqual(['move', 's']);
    expect(handlesOf(input('标准线路单边/道路带')).can).toBe('图上可以拖到别的格子、拖下边改跨几行；方向键挪一格。');
    const moved = valid(applyHandle(input('标准线路单边/道路带'), drag('move', 0, 20, { x: 300, y: 150 })));
    expect(placeOf(moved.document, '标准线路单边/道路带')).toEqual({ row: 4, column: 1 });
    expect(moved.readout).toBe('第 4 行第 1 列');
    expect(moved.ghost).toEqual({ x: 0, y: 144, width: 740, height: 21 });
    const spanned = valid(applyHandle(input('标准线路单边/站点面板'), drag('s', 0, 40, { x: 300, y: 160 })));
    expect(placeOf(spanned.document, '标准线路单边/站点面板')).toEqual({ row: 2, column: 1, rowSpan: 3 });
    expect(spanned.readout).toBe('跨 3 行 1 列');
    // 只有一列：往右拖不出跨度。
    expect(applyHandle(input('标准线路单边/站点面板'), drag('e', 500, 0, { x: 900, y: 60 }))).toBeUndefined();
    // 跨了三行再吸格子：往下行号不让它出去，往上照常。
    expect(applyHandle(input('标准线路单边/站点面板', spanned.document), drag('move', 0, 100, { x: 300, y: 160 }))).toBeUndefined();
    const high = valid(applyHandle(input('标准线路单边/站点面板', spanned.document), drag('move', 0, -40, { x: 300, y: 10 })));
    expect(placeOf(high.document, '标准线路单边/站点面板')).toEqual({ row: 1, column: 1, rowSpan: 3 });
  });

  it('行号绑定了变量：不能换格子，写明原因', () => {
    const element = elementAt(route, '标准线路单边/道路带')!.element;
    const set = handlesOf(input('标准线路单边/道路带', setElement(route, '标准线路单边/道路带', { ...element, place: { row: { var: 'roadRow' }, column: 1 } })));
    expect(set.handles.map((handle) => handle.id)).toEqual(['s']);
    expect(set.notes).toEqual(['行号绑定了变量 roadRow，不能吸到别的格子。']);
  });

  it('两列的网格：右边拖到第二列跨两列', () => {
    // 胸牌的信息：三行随内容，两列各 1 份，列间距 2。
    const INFO = '会议胸牌/信息', cells = [box(`${INFO}/证件号`, 0, 60, 49, 4), box(`${INFO}/座位`, 51, 60, 49, 4), box(`${INFO}/会议日期`, 0, 65, 49, 4), box(`${INFO}/发证时间`, 51, 65, 49, 4), box(`${INFO}/主场次`, 0, 70, 49, 4), box(`${INFO}/贵宾通道`, 51, 70, 49, 4)];
    const cell: HandleInput = { document: badge, template: '会议胸牌', path: `${INFO}/证件号`, node: cells[0]!, parent: box(INFO, 0, 60, 100, 14, cells) };
    expect(ids(cell)).toEqual(['move', 'e', 's', 'se']);
    expect(gridTracks(elementAt(badge, INFO)!.element, cell.parent!)!.columns.map((column) => [column.start, column.size])).toEqual([[0, 49], [51, 49]]);
    const wide = valid(applyHandle(cell, drag('e', 40, 0, { x: 80, y: 62 })));
    expect(placeOf(wide.document, `${INFO}/证件号`)).toEqual({ row: 1, column: 1, columnSpan: 2 });
    expect(wide.ghost).toEqual({ x: 0, y: 60, width: 100, height: 4 });
  });

  it('方向键挪一格', () => {
    expect(placeOf(valid(nudge(input('标准线路单边/道路带'), 'ArrowUp', false)).document, '标准线路单边/道路带')).toEqual({ row: 2, column: 1 });
    expect(nudge(input('标准线路单边/道路带'), 'ArrowLeft', false)).toBeUndefined();
  });

  it('选中网格画板：固定轨道的线写 rows[i].fixed；按比例的没有手柄；画板本身不能拖', () => {
    const set = handlesOf(input('标准线路单边'));
    expect(set.handles.map((handle) => handle.id)).toEqual(['rows:0', 'rows:2', 'rows:3']);
    expect(set.notes).toEqual(['画板不能拖：实际尺寸是出图参数，在样例带里调。', '按比例或随内容的轨道没有手柄：在检查器的排布里改。']);
    expect(set.can).toBe('图上可以拖轨道线改固定轨道。');
    const result = valid(applyHandle(input('标准线路单边'), drag('rows:0', 0, 2.2)));
    expect((elementAt(result.document, '标准线路单边')!.element['layout'] as JsonObject)['rows']).toEqual([{ fixed: 36 }, { fraction: 1 }, { fixed: 10 }, { fixed: 21 }]);
    expect(result.readout).toBe('第 1 行 36 mm');
    expect(result.line).toEqual({ x: 0, y: 36, width: 740, height: 0 });
  });
});

describe('选中堆叠或循环：间距条', () => {
  const TOP = '标准线路单边/顶栏';
  const kids = [box(`${TOP}/线路号图片`, 22, 4, 60, 26), box(`${TOP}/线路号`, 90, 8, 30, 18), box(`${TOP}/开往箭头`, 128, 11, 14, 12)];
  const input = (document = route): HandleInput => ({ document, template: '标准线路单边', path: TOP, node: box(TOP, 0, 0, 740, 34, kids), parent: box('标准线路单边', 0, 0, 740, 165) });

  it('顶栏的间距：每个空隙一个条，写 layout.gap', () => {
    const set = handlesOf(input());
    expect(set.handles.filter((handle) => handle.id.startsWith('gap')).map((handle) => handle.bar)).toEqual([{ x: 82, y: 0, width: 8, height: 34 }, { x: 120, y: 0, width: 8, height: 34 }]);
    const result = valid(applyHandle(input(), drag('gap:1', 1.7, 0)));
    expect((elementAt(result.document, TOP)!.element['layout'] as JsonObject)['gap']).toBe(9.5);
    expect(result.readout).toBe('间距 9.5 mm');
    expect(result.line).toEqual({ x: 120, y: 0, width: 9.5, height: 34 });
    // 不小于 0。
    expect((elementAt(valid(applyHandle(input(), drag('gap:0', -20, 0))).document, TOP)!.element['layout'] as JsonObject)['gap']).toBe(0);
  });

  it('两端对齐或间距绑定了变量：没有间距条，写明原因', () => {
    const element = elementAt(route, TOP)!.element, layout = element['layout'] as JsonObject;
    const spread = setElement(route, TOP, { ...element, layout: { ...layout, justifyContent: 'spaceBetween' } });
    expect(handlesOf(input(spread)).handles.filter((handle) => handle.id.startsWith('gap'))).toEqual([]);
    expect(handlesOf(input(spread)).notes).toContain('主轴两端对齐时空隙是分出来的，没有间距条：间距在检查器的排布里填。');
    const bound = setElement(route, TOP, { ...element, layout: { ...layout, gap: { var: 'gapSize' } } });
    expect(handlesOf(input(bound)).notes).toContain('间距绑定了变量 gapSize，没有间距条。');
  });

  it('循环的项间距写 itemLayout.gap', () => {
    const LOOP = '标准线路单边/站点面板/站点列';
    const items = [box(`${LOOP}[0]`, 0, 34, 20, 100), box(`${LOOP}[1]`, 20, 34, 20, 100)];
    const loopInput: HandleInput = { document: route, template: '标准线路单边', path: LOOP, node: box(LOOP, 0, 34, 740, 100, items), parent: box('标准线路单边/站点面板', 0, 34, 740, 100) };
    expect(handlesOf(loopInput).handles.map((handle) => handle.id)).toContain('gap:0');
    // 项挨着项（间距 0）：条是 0 宽，拖开就有。
    const result = valid(applyHandle(loopInput, drag('gap:0', 1, 0)));
    expect((elementAt(result.document, LOOP)!.element['itemLayout'] as JsonObject)['gap']).toBe(1);
  });
});

describe('画板与循环项', () => {
  it('循环项、子模板的画板、主模板的画板都不能拖，各自写明在哪改', () => {
    const node = box('站点', 0, 0, 20, 100);
    const loop = elementAt(route, '标准线路单边/站点面板/站点列')!.element;
    expect(handlesOf({ document: stop, template: '站点', path: '站点', node, host: loop }).notes[0]).toBe('循环项不能拖：项由数据决定，排布在循环容器「站点列」上改。');
    expect(handlesOf({ document: stop, template: '站点', path: '站点', node, host: { type: 'call', name: '线路号' } }).notes[0]).toBe('子模板的画板不能拖：位置与尺寸在调用它的「线路号」上改。');
    expect(applyHandle({ document: stop, template: '站点', path: '站点', node, host: loop }, drag('move', 3, 3))).toBeUndefined();
    expect(nudge({ document: stop, template: '站点', path: '站点', node, host: loop }, 'ArrowRight', false)).toBeUndefined();
  });

  it('布局摘要里找一处实例与它的父容器', () => {
    const inner = box('a/b/c', 1, 1, 1, 1), middle = box('a/b', 0, 0, 5, 5, [inner]), root = box('a', 0, 0, 10, 10, [middle]);
    expect(layoutContext(root, 'a/b/c')).toEqual({ node: inner, parent: middle });
    expect(layoutContext(root, 'a')).toEqual({ node: root });
    expect(layoutContext(root, 'x')).toBeUndefined();
  });
});
