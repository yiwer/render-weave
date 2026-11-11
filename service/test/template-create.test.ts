/**
 * 添加元素（模板设计页票据 14）：只经"给文档、模板名与放在哪，得到新文档与新元素路径"这一入口。
 * 每种元素、每种字段类型配自由、堆叠、网格三种父布局，写回结果由引擎的 checkDslDocument 判断。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { CATALOG, INSERT_BAR, SHAPE_KINDS, fieldInfo, insertElement, insertionLabel, insertionPoint, insertKey, matchingTemplates, newElement, planFromField, type FieldInfo } from '../console/src/template/create.js';
import { elementAt, flatElements, templateText, type JsonObject } from '../console/src/template/document.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE, M402_DIR } from './seed.js';

const ALL = '全元素牌', ROUTE = '标准线路单边';
let all: JsonObject, route: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const placeOf = (document: JsonObject, path: string) => elementAt(document, path)?.element['place'] as Record<string, unknown> | undefined;

beforeAll(async () => {
  all = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  route = JSON.parse(await readFile(`${M402_DIR}template-route-sign.json`, 'utf8')) as JsonObject;
});

// 三种父布局：全元素牌的画板是自由布局，M402 的顶栏是横向堆叠，M402 主模板的画板是四行网格。
const PARENTS = () => [
  { layout: '自由', document: all, template: ALL, container: ALL },
  { layout: '堆叠', document: route, template: ROUTE, container: `${ROUTE}/顶栏` },
  { layout: '网格', document: route, template: ROUTE, container: ROUTE },
] as const;

describe.each(['自由', '堆叠', '网格'] as const)('放进%s布局', (layout) => {
  const parent = () => PARENTS().find((item) => item.layout === layout)!;

  it.each(CATALOG.filter((item) => !item.needsTemplate).map((item) => [item.label, item.kind] as const))('%s：必填项有合法初值，名称不重，模板仍合法', (_label, kind) => {
    const { document, template, container } = parent();
    const added = insertElement(document, template, container, newElement(kind, document))!;
    expect(severe(added.document)).toEqual([]);
    const names = flatElements(added.document, template).map((node) => node.name);
    expect(new Set(names).size).toBe(names.length);
    expect(elementAt(added.document, added.path)?.element['type']).toBe(kind);
  });

  it('循环容器与子模板调用：选了模板之后合法', () => {
    const { document, template, container } = parent();
    const loop = insertElement(document, template, container, newElement('loop', document, { list: 'stops', template: '站点' }))!;
    expect(severe(loop.document)).toEqual([]);
    const call = insertElement(document, template, container, newElement('call', document, { template: '站点', data: 'current' }))!;
    expect(severe(call.document)).toEqual([]);
  });
});

describe('放下的位置决定写什么', () => {
  it('自由布局写坐标：放在哪就是哪，半毫米对齐', () => {
    const added = insertElement(all, ALL, ALL, newElement('rect', all), { point: { x: 31.3, y: 12.8 } })!;
    expect(placeOf(added.document, added.path)).toMatchObject({ left: 31.5, top: 13, width: { fixed: 20 }, height: { fixed: 10 } });
  });

  it('堆叠写顺序：放在第几位，place 只留堆叠认识的键', () => {
    const top = `${ROUTE}/顶栏`;
    const added = insertElement(route, ROUTE, top, newElement('rect', route), { index: 1, point: { x: 5, y: 5 } })!;
    const kids = (elementAt(added.document, top)!.element['children'] as JsonObject[]).map((child) => child['name']);
    expect(kids[1]).toBe(added.path.split('/').at(-1));
    expect(Object.keys(placeOf(added.document, added.path)!)).toEqual(['width', 'height']);
  });

  it('网格写行列：放进哪一格', () => {
    const added = insertElement(route, ROUTE, ROUTE, newElement('text', route), { cell: { row: 3, column: 1 } })!;
    expect(placeOf(added.document, added.path)).toMatchObject({ row: 3, column: 1 });
    expect(severe(added.document)).toEqual([]);
  });

  it('只能放进容器与画板', () => {
    expect(insertElement(all, ALL, `${ALL}/矩形`, newElement('rect', all))).toBeUndefined();
    expect(insertElement(all, ALL, `${ALL}/循环`, newElement('rect', all))).toBeUndefined();
  });

  it('加到哪：选中容器放进去加在最后，选中别的元素放在它后面，没选中放进画板', () => {
    expect(insertionPoint(route, ROUTE, `${ROUTE}/顶栏`)).toEqual({ container: `${ROUTE}/顶栏`, index: (elementAt(route, `${ROUTE}/顶栏`)!.element['children'] as unknown[]).length });
    const first = (elementAt(route, `${ROUTE}/顶栏`)!.element['children'] as JsonObject[])[0]!['name'];
    expect(insertionPoint(route, ROUTE, `${ROUTE}/顶栏/${String(first)}`)).toEqual({ container: `${ROUTE}/顶栏`, index: 1 });
    expect(insertionPoint(route, ROUTE, undefined)).toEqual({ container: ROUTE, index: 4 });
  });

  it('文字的字体取模板里已在用的', () => {
    expect(newElement('text', route)['font']).toBe('res:font-hei-heavy');
    expect(newElement('text', { artboard: {} }, { font: 'res:x' })['font']).toBe('res:x');
  });
});

describe('底部工具栏（第三轮票据 06）', () => {
  it('直接摆出来的加上形状里的就是元素目录，不重不漏；顺序是文字、图片、形状、容器、循环、调用', () => {
    expect(INSERT_BAR.map((item) => item.label)).toEqual(['文字', '图片', '形状', '容器', '循环', '调用']);
    const kinds = [...INSERT_BAR.map((item) => item.tool).filter((tool) => tool !== 'shape'), ...SHAPE_KINDS];
    expect([...kinds].sort()).toEqual(CATALOG.map((item) => item.kind).sort());
    expect(SHAPE_KINDS.map((kind) => CATALOG.find((item) => item.kind === kind)!.label)).toEqual(['矩形', '椭圆', '线条', '多边形', '路径', '二维码', '条码']);
    expect(SHAPE_KINDS.some((kind) => CATALOG.find((item) => item.kind === kind)!.needsTemplate), '形状里的点一下就能加').toBe(false);
  });

  it('快捷键：T 加文字，F 加容器，不分大小写；别的键与要先选模板的不认', () => {
    expect([insertKey('t'), insertKey('T'), insertKey('f'), insertKey('F')]).toEqual(['text', 'text', 'container', 'container']);
    expect(['v', 'h', 'l', 'c', 's', '', 'tt'].map(insertKey)).toEqual(Array(7).fill(undefined));
  });

  it('加到哪说给人听：选中容器是它的最后，选中别的是放在它后面，没选中或选中的不在了是画板的最后', () => {
    const top = `${ROUTE}/顶栏`, first = String((elementAt(route, top)!.element['children'] as JsonObject[])[0]!['name']);
    expect(insertionLabel(route, ROUTE, top)).toBe('「顶栏」的最后');
    expect(insertionLabel(route, ROUTE, `${top}/${first}`)).toBe(`「顶栏」，放在「${first}」后面`);
    expect(insertionLabel(route, ROUTE, undefined)).toBe(`画板「${ROUTE}」的最后`);
    expect(insertionLabel(route, ROUTE, ROUTE)).toBe(`画板「${ROUTE}」的最后`);
    expect(insertionLabel(route, ROUTE, `${ROUTE}/没有这个`)).toBe(`画板「${ROUTE}」的最后`);
    const direct = String((elementAt(all, ALL)!.element['children'] as JsonObject[]).find((child) => child['type'] !== 'container')!['name']);
    expect(insertionLabel(all, ALL, `${ALL}/${direct}`)).toBe(`画板「${ALL}」，放在「${direct}」后面`);
  });

  it('同一个选中、同一种元素，写回只有一种：文本逐字节相同，位置就是 insertionPoint 说的', () => {
    const top = `${ROUTE}/顶栏`, first = String((elementAt(route, top)!.element['children'] as JsonObject[])[0]!['name']);
    for (const selected of [undefined, top, `${top}/${first}`]) {
      for (const kind of CATALOG.map((item) => item.kind)) {
        const element = () => newElement(kind, route, { list: 'stops', template: '站点', data: 'current' });
        const point = insertionPoint(route, ROUTE, selected);
        const once = insertElement(route, ROUTE, point.container, element(), { index: point.index })!, again = insertElement(route, ROUTE, point.container, element(), { index: point.index })!;
        expect(templateText(once.document)).toBe(templateText(again.document));
        const kids = elementAt(once.document, point.container)!.element['children'] as JsonObject[];
        expect(kids[point.index]!['name'], `${kind} @ ${selected}`).toBe(once.path.split('/').at(-1));
        expect(severe(once.document), `${kind} @ ${selected}`).toEqual([]);
      }
    }
  });
});

describe('从字段创建', () => {
  const fields: Record<string, FieldInfo> = {
    routeNo: { name: 'routeNo', label: '线路号', type: 'text' },
    fare: { name: 'fare', label: '票价', type: 'number' },
    firstBus: { name: 'firstBus', label: '首班', type: 'time' },
    routeImage: { name: 'routeImage', label: '线路号图片', type: 'image' },
    express: { name: 'express', label: '快线', type: 'boolean' },
  };

  it.each(['自由', '堆叠', '网格'] as const)('文本、数值、时刻变文字加插槽，图片变图片：放进%s布局都合法', (layout) => {
    const { document, template, container } = PARENTS().find((item) => item.layout === layout)!;
    for (const field of [fields['routeNo']!, fields['fare']!, fields['firstBus']!, fields['routeImage']!]) {
      const plan = planFromField(field, document);
      expect(plan.kind).toBe('element');
      const added = insertElement(document, template, container, (plan as { element: JsonObject }).element)!;
      expect(severe(added.document), field.name).toEqual([]);
      expect(added.path.split('/').at(-1), '名字取显示名称').toMatch(new RegExp(`^${field.label}\\d*$`));
    }
    const text = (planFromField(fields['fare']!, document) as { element: JsonObject }).element;
    expect(text['content']).toEqual([{ slot: 'fare' }]);
    expect((planFromField(fields['routeImage']!, document) as { element: JsonObject }).element['source']).toEqual({ var: 'routeImage' });
  });

  it('布尔绑到选中元素的显示', () => {
    expect(planFromField(fields['express']!, route)).toEqual({ kind: 'visible', variable: 'express' });
  });

  it('列表变循环、单引用变调用：先选基准相符的模板；基本类型的列表用单值数据定义', () => {
    const stops = fieldInfo({ name: 'stops', displayName: '停靠站点', type: 'list', items: { type: 'ref', ref: { name: '停靠站点', version: 1 } } });
    expect(stops.target).toEqual({ name: '停靠站点', version: 1 });
    const plan = planFromField(stops, route);
    expect(plan.kind).toBe('template');
    if (plan.kind !== 'template') return;
    const loop = insertElement(route, ROUTE, `${ROUTE}/站点面板`, plan.element('站点'))!;
    expect(severe(loop.document)).toEqual([]);
    expect(elementAt(loop.document, loop.path)!.element).toMatchObject({ type: 'loop', list: { var: 'stops' }, template: '站点' });
    expect(fieldInfo({ name: 'tags', type: 'list', items: { type: 'text' } }).target).toEqual({ name: '单值·文本', version: 1 });
    const terminal = planFromField(fieldInfo({ name: 'terminal', displayName: '终点站', type: 'ref', ref: { name: '停靠站点', version: 1 } }), route);
    expect(terminal.kind === 'template' && terminal.element('站点')).toMatchObject({ type: 'call', template: '站点', data: { var: 'terminal' } });
    const templates = [{ name: '站点', base: { name: '停靠站点', version: 1 } }, { name: '标准线路单边', base: { name: '线路牌', version: 1 } }, { name: '旧站点', base: { name: '停靠站点', version: 2 } }];
    expect(matchingTemplates(templates, { name: '停靠站点', version: 1 })).toEqual(['站点']);
  });
});
