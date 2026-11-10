/**
 * 检查器显示哪些属性（模板设计页第三轮票据 05）：常用属性表、"+ 属性"里有什么、加一项与去掉一项的写回。
 * 写回的文档由引擎的 checkDslDocument 判断；文档是全元素牌（画板加十二种元素）与 M402 的站点模板（站名有状态样式）。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { elementAt, flatElements, type JsonObject } from '../console/src/template/document.js';
import { addedValue, COMMON_PROPERTIES, menuLabel, splitPanel, type PanelSplit } from '../console/src/template/optional.js';
import { ELEMENT_TYPES, propertyPanel, stateOverridable, writeProperty, type PropertyField, type PropertyPanel } from '../console/src/template/properties.js';
import { mergedDocument, resetOverride, statesOf, writeOverride } from '../console/src/template/states.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE, M402_DIR } from './seed.js';

const NAME = '全元素牌', STOP_NAME = '站点/名称区/站名';
let all: JsonObject, stop: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const panelOf = (document: JsonObject, path: string): PropertyPanel => propertyPanel(document, path)!;
const shownKeys = (split: PanelSplit) => split.groups.flatMap((group) => group.fields.map((field) => field.key));
const addableKeys = (split: PanelSplit) => split.addable.map((item) => item.field.key);
const typeOf = (document: JsonObject, path: string) => panelOf(document, path).type;
/** 全元素牌里每种类型取第一处；画板在最前。 */
const targets = (): readonly string[] => {
  const seen = new Set<string>();
  return [NAME, ...flatElements(all, NAME).map((node) => node.path).filter((path) => { const type = typeOf(all, path); if (path === NAME || seen.has(type)) return false; seen.add(type); return true; })];
};

beforeAll(async () => {
  all = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  stop = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8')) as JsonObject;
  expect(severe(all)).toEqual([]);
  expect(severe(stop)).toEqual([]);
});

describe('常用属性表', () => {
  it('画板与十二种元素各有一份', () => {
    expect(Object.keys(COMMON_PROPERTIES).sort()).toEqual(Object.keys(ELEMENT_TYPES).sort());
    expect(targets().map((path) => typeOf(all, path)).sort()).toEqual(Object.keys(ELEMENT_TYPES).sort());
  });

  it('表里的键都是 Schema 生成的字段（三种父排布合起来），没有写错的', () => {
    const child = (type: string) => ({ type, name: 'x' });
    const layouts: readonly unknown[] = [undefined, { mode: 'stack', direction: 'row' }, { mode: 'grid', rows: [{ fixed: 1 }], columns: [{ fixed: 1 }] }];
    for (const [type, keys] of Object.entries(COMMON_PROPERTIES)) {
      const panels = type === 'artboard'
        ? [panelOf({ name: 't', artboard: { name: 't', children: [] } }, 't')]
        : layouts.map((layout) => panelOf({ name: 't', artboard: { name: 't', ...(layout ? { layout } : {}), children: [child(type)] } }, 't/x'));
      const known = new Set(panels.flatMap((panel) => panel.groups.flatMap((group) => group.fields.map((field) => field.key))));
      expect(keys.filter((key) => !known.has(key)), type).toEqual([]);
    }
  });

  it('常用的、必填的与写了的显示，其余的在"+ 属性"里，两边不重不漏', () => {
    for (const path of targets()) {
      const panel = panelOf(all, path), split = splitPanel(panel), common = new Set(COMMON_PROPERTIES[panel.type]);
      const fields = panel.groups.flatMap((group) => group.fields), shown = new Set(shownKeys(split)), menu = new Set(addableKeys(split));
      for (const field of fields) {
        expect(shown.has(field.key) !== menu.has(field.key) || field.blocked !== undefined, `${path} ${field.key}`).toBe(true);
        if (field.required || common.has(field.key) || field.value !== undefined) expect(shown.has(field.key), `${path} ${field.key} 应该显示`).toBe(true);
        if (menu.has(field.key)) expect(field.value, `${path} ${field.key}`).toBeUndefined();
      }
      // 显示的顺序同面板，空的分组不留标题。
      expect(shownKeys(split)).toEqual(fields.filter((field) => shown.has(field.key)).map((field) => field.key));
      expect(split.groups.every((group) => group.fields.length > 0)).toBe(true);
      // 能去掉的只有写了的、不在常用表里的可选项。
      for (const key of split.removable) {
        const field = fields.find((item) => item.key === key)!;
        expect(field.required || common.has(key) || field.value === undefined, `${path} ${key}`).toBe(false);
      }
    }
  });

  it('原型 01 的几处：画板、容器、文字、图片、循环的"+ 属性"', () => {
    const menu = (type: string) => { const path = targets().find((item) => typeOf(all, item) === type)!; return splitPanel(panelOf(writeProperty(all, path, ['fill'], undefined), path)).addable.map((item) => item.label); };
    expect(menu('artboard')).toEqual(['填充色', '描边', '圆角', '裁剪超出部分']);
    expect(menu('container')).toEqual(expect.arrayContaining(['描边', '裁剪超出部分', '旋转']));
    expect(menu('container')).not.toContain('填充色');
    expect(menu('text')).toEqual(expect.arrayContaining(['描边', '旋转', '倾斜', '内边距']));
    expect(menu('image')).toEqual(expect.arrayContaining(['单色重染', '旋转']));
    expect(menu('loop')).toEqual(expect.arrayContaining(['反序', '只取一段']));
    // 状态样式有自己的一栏，不在菜单里。
    for (const path of targets()) expect(addableKeys(splitPanel(panelOf(all, path))), path).not.toContain('states');
  });

  it('表里没有的类型全部显示', () => {
    const panel = panelOf(all, `${NAME}/矩形`), fields = panel.groups.flatMap((group) => group.fields.map((field) => field.key));
    const split = splitPanel({ ...panel, type: '将来的类型' });
    expect(shownKeys(split)).toEqual(fields);
    expect(split.addable).toEqual([]);
    expect(split.removable.size).toBe(0);
  });
});

describe('加一项、去掉一项', () => {
  it('画板与十二种元素：菜单里每一项加上都合法、加了就显示并且能去掉，去掉回到原样', () => {
    let count = 0;
    for (const path of targets()) {
      const split = splitPanel(panelOf(all, path));
      expect(split.addable.length, `${path} 至少有一项可加`).toBeGreaterThan(0);
      for (const item of split.addable) {
        // 缺前置属性的（随框缩放要先有视图框）先加前置。
        const needs = split.addable.filter((other) => item.needs && (item.field.needs ?? []).includes(String(other.field.path.at(-1))));
        expect(needs.length, `${path} ${item.field.key} 的前置也在菜单里`).toBe(item.field.needs?.length ?? 0);
        const base = needs.reduce((document, other) => writeProperty(document, path, other.field.path, other.value), all);
        const added = writeProperty(base, path, item.field.path, item.value);
        expect(severe(added), `${path} 加 ${item.field.key}`).toEqual([]);
        const after = splitPanel(panelOf(added, path));
        expect(shownKeys(after), `${path} ${item.field.key}`).toContain(item.field.key);
        expect(addableKeys(after)).not.toContain(item.field.key);
        expect(after.removable.has(item.field.key)).toBe(true);
        // 只多了这一个键。
        const before = elementAt(base, path)!.element, now = elementAt(added, path)!.element, top = String(item.field.path[0]);
        expect(Object.keys(now).filter((key) => JSON.stringify(now[key]) !== JSON.stringify(before[key]))).toEqual([top]);
        const removed = writeProperty(added, path, item.field.path, undefined);
        expect(removed).toEqual(base);
        expect(JSON.stringify(removed)).toBe(JSON.stringify(base));
        expect(addableKeys(splitPanel(panelOf(removed, path)))).toContain(item.field.key);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(60);
  });

  it('初值：开关加上就是打开，填充与背景从白色起，别的有缺省值就写缺省值', () => {
    const item = (path: string, key: string) => splitPanel(panelOf(all, path)).addable.find((entry) => entry.field.key === key)!;
    expect(item(`${NAME}/容器`, 'clip').value).toBe(true);
    expect(item(`${NAME}/循环`, 'reverse').value).toBe(true);
    expect(item(`${NAME}/循环`, 'fill').value).toBe('#FFFFFF');
    expect(item(`${NAME}/二维码`, 'background').value).toBe('#FFFFFF');
    expect(item(`${NAME}/文字`, 'rotation').value).toBe(0);
    expect(item(`${NAME}/文字`, 'slant').value).toBe(0);
    expect(item(`${NAME}/文字`, 'stroke').value).toEqual({ color: '#000000', width: 1 });
    expect(item(`${NAME}/路径`, 'fillRule').value).toBe('nonzero');
    expect(item(`${NAME}/线条`, 'viewBox').value).toEqual([0, 0, 1, 1]);
    expect(item(`${NAME}/线条`, 'fit')).toMatchObject({ value: 'fill', needs: ['视图框'] });
    expect(menuLabel({ label: '旋转（度）' } as PropertyField)).toBe('旋转');
    // 说不出初值的不进菜单。
    expect(addedValue({ key: 'x', path: ['x'], editor: { kind: 'text' } } as unknown as PropertyField)).toBeUndefined();
  });

  it('最小、最大宽高从这一处的实际尺寸起：最小往下取，最大往上取', () => {
    const path = `${NAME}/矩形`, box = { width: 12.3456, height: 8 };
    const values = Object.fromEntries(splitPanel(panelOf(all, path), { box }).addable.map((item) => [item.field.key, item.value]));
    expect(values).toMatchObject({ 'place.minWidth': 12.34, 'place.maxWidth': 12.35, 'place.minHeight': 8, 'place.maxHeight': 8 });
    const exact = Object.fromEntries(splitPanel(panelOf(all, path), { box: { width: 12.340000001, height: 7.999999999 } }).addable.map((item) => [item.field.key, item.value]));
    expect(exact).toMatchObject({ 'place.minWidth': 12.34, 'place.maxWidth': 12.34, 'place.minHeight': 8, 'place.maxHeight': 8 });
    for (const key of ['place.minWidth', 'place.maxWidth', 'place.minHeight', 'place.maxHeight']) {
      expect(severe(writeProperty(all, path, key.split('.'), values[key])), key).toEqual([]);
    }
    // 没量到尺寸时照 Schema 的初值。
    expect(splitPanel(panelOf(all, path)).addable.find((item) => item.field.key === 'place.maxWidth')!.value).toBe(0);
  });

  it('人刚清空的项先留着：还显示、能去掉、不回菜单', () => {
    const path = `${NAME}/文字`, split = splitPanel(panelOf(all, path), { pinned: new Set(['rotation']) });
    expect(shownKeys(split)).toContain('rotation');
    expect(split.removable.has('rotation')).toBe(true);
    expect(addableKeys(split)).not.toContain('rotation');
    // 常用的项钉不钉都显示，也不会变成能去掉。
    expect(splitPanel(panelOf(all, path), { pinned: new Set(['color']) }).removable.has('color')).toBe(false);
  });

  it('当前写法下不可用的项不在菜单里：竖排文字的倾斜', () => {
    const path = `${NAME}/文字`, vertical = writeProperty(all, path, ['writingMode'], 'vertical');
    expect(addableKeys(splitPanel(panelOf(all, path)))).toContain('slant');
    const split = splitPanel(panelOf(vertical, path));
    expect(addableKeys(split)).not.toContain('slant');
    expect(shownKeys(split)).not.toContain('slant');
  });
});

describe('状态样式模式', () => {
  const STATE = '本站';
  const stateSplit = (document: JsonObject) => splitPanel(panelOf(mergedDocument(document, STOP_NAME, STATE), STOP_NAME), { overridable: stateOverridable(document, STOP_NAME) });

  it('被覆盖的项总是显示；能加的都是可覆盖的；去掉改由重置', () => {
    const overridable = stateOverridable(stop, STOP_NAME), split = stateSplit(stop);
    const covered = Object.keys(statesOf(elementAt(stop, STOP_NAME)!.element).cases[STATE] ?? {});
    expect(covered.length).toBeGreaterThan(0);
    for (const key of covered) expect(shownKeys(split).some((shown) => shown.split('.')[0] === key), key).toBe(true);
    expect(split.addable.length).toBeGreaterThan(0);
    for (const item of split.addable) expect(overridable, item.field.key).toContain(String(item.field.path[0]));
    expect(split.removable.size).toBe(0);
    // 自身属性模式下菜单不比它少。
    const own = addableKeys(splitPanel(panelOf(stop, STOP_NAME)));
    for (const key of addableKeys(split)) expect(own).toContain(key);
  });

  it('从菜单加一项写进这个取值的覆盖，加了就显示；重置回到原样', () => {
    const split = stateSplit(stop);
    for (const item of split.addable) {
      const added = writeOverride(stop, STOP_NAME, STATE, item.field.path, item.value), top = String(item.field.path[0]);
      expect(severe(added), item.field.key).toEqual([]);
      const element = elementAt(added, STOP_NAME)!.element, before = elementAt(stop, STOP_NAME)!.element;
      // 自身属性没动，覆盖里多了这一个键。
      expect({ ...element, states: undefined }).toEqual({ ...before, states: undefined });
      expect(Object.keys(statesOf(element).cases[STATE]!)).toContain(top);
      const after = stateSplit(added);
      expect(shownKeys(after), item.field.key).toContain(item.field.key);
      expect(addableKeys(after)).not.toContain(item.field.key);
      expect(resetOverride(added, STOP_NAME, STATE, top)).toEqual(stop);
    }
  });
});
