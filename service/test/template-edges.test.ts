/**
 * 四边一格（模板设计页第三轮票据 02）：只经"给整格现在的值与改了哪一边、得到整格要写的值"这一入口，写回的结果由引擎的 checkDslDocument 判断。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractParameter } from '../console/src/template/binding.js';
import type { JsonObject } from '../console/src/template/document.js';
import { edgesSummary, inSpokenOrder, partsNoun, partValues, writePart } from '../console/src/template/edges.js';
import { fieldByKey, propertyPanel, writeProperty, type PropertyField } from '../console/src/template/properties.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE } from './seed.js';

const NAME = '全元素牌';
const at = (name: string) => `${NAME}/${name}`;
const SIDES = ['top', 'right', 'bottom', 'left'], CORNERS = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
const SIDE_PARTS = [{ key: 'top', label: '上' }, { key: 'right', label: '右' }, { key: 'bottom', label: '下' }, { key: 'left', label: '左' }];
let original: JsonObject;
const fresh = (): JsonObject => JSON.parse(JSON.stringify(original)) as JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const field = (document: JsonObject, path: string, key: string): PropertyField => {
  const found = fieldByKey(propertyPanel(document, path)!, key);
  if (!found) throw new Error(`${path} 没有 ${key}`);
  return found;
};
/** 这一格的各项：生成规则给的 parts。 */
const partsOf = (found: PropertyField) => {
  if (found.editor.kind !== 'variants' || !found.editor.parts) throw new Error(`${found.key} 不是四边一格`);
  return found.editor.parts;
};
const elementOf = (document: JsonObject, path: string): JsonObject => {
  let node = document['artboard'] as JsonObject;
  for (const name of path.split('/').slice(1)) node = (node['children'] as JsonObject[]).find((child) => child['name'] === name)!;
  return node;
};
/** 在页面上改一边：读这一格、算整格、写回。 */
const typed = (document: JsonObject, path: string, key: string, side: string, next: unknown): JsonObject => {
  const found = field(document, path, key);
  const keys = partsOf(found).map((part) => part.key.slice(found.key.length + 1));
  return writeProperty(document, path, found.path, writePart(found.value, keys, side, next));
};

beforeAll(async () => {
  original = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(severe(original)).toEqual([]);
});

describe('哪些格是四边一格', () => {
  it('内边距、外边距是四边，圆角是四角；每项是能绑定数值变量的值格，没写时是 0', () => {
    const document = fresh();
    for (const [path, key, keys, labels] of [
      [at('容器'), 'padding', SIDES, ['上', '右', '下', '左']],
      [at('容器/容器内文字'), 'place.margin', SIDES, ['上', '右', '下', '左']],
      [at('矩形'), 'cornerRadius', CORNERS, ['左上', '右上', '右下', '左下']],
    ] as const) {
      const found = field(document, path, key), parts = partsOf(found);
      expect(parts.map((part) => part.key)).toEqual(keys.map((item) => `${key}.${item}`));
      expect(parts.map((part) => part.label)).toEqual(labels);
      expect(parts.map((part) => part.path)).toEqual(keys.map((item) => [...found.path, item]));
      for (const part of parts) expect(part.editor).toMatchObject({ kind: 'variants', bindable: { type: 'number' } });
      expect(found.fallback).toBe(0);
    }
    // 页面上摆的先后：上下、左右；四角两个一排和方位对上。
    expect(inSpokenOrder(SIDES.map((key) => ({ key }))).map((part) => part.key)).toEqual(['top', 'bottom', 'left', 'right']);
    expect(inSpokenOrder(CORNERS.map((key) => ({ key }))).map((part) => part.key)).toEqual(['topLeft', 'topRight', 'bottomLeft', 'bottomRight']);
    expect(partsNoun(SIDES)).toBe('四边');
    expect(partsNoun(CORNERS)).toBe('四角');
    // 别的变体格（宽、字号、填充）不是。
    for (const [path, key] of [[at('矩形'), 'place.width'], [at('文字'), 'fontSize'], [at('矩形'), 'fill']] as const) {
      const editor = field(document, path, key).editor;
      expect(editor.kind === 'variants' ? editor.parts : undefined, key).toBeUndefined();
    }
  });
});

describe('每一边现在是什么', () => {
  it('一个数或一个变量是四边都是它；写成对象时只有列出来的几边；没写是都没有', () => {
    expect(partValues(3, SIDES)).toEqual({ top: 3, right: 3, bottom: 3, left: 3 });
    expect(partValues({ var: 'gap' }, SIDES)).toEqual({ top: { var: 'gap' }, right: { var: 'gap' }, bottom: { var: 'gap' }, left: { var: 'gap' } });
    expect(partValues({ bottom: 2, left: { var: 'gap' } }, SIDES)).toEqual({ bottom: 2, left: { var: 'gap' } });
    expect(partValues(undefined, SIDES)).toEqual({});
  });
});

describe('改一边，整格写什么', () => {
  it('没写时打一边：只写那一边', () => {
    expect(writePart(undefined, SIDES, 'bottom', 2)).toEqual({ bottom: 2 });
    const next = typed(fresh(), at('容器/容器内文字'), 'place.margin', 'bottom', 2);
    expect((elementOf(next, at('容器/容器内文字'))['place'] as JsonObject)['margin']).toEqual({ bottom: 2 });
    expect(severe(next)).toEqual([]);
  });

  it('原来是一个数：别的边照原来的数留着，按上右下左的先后写', () => {
    expect(writePart(1, SIDES, 'bottom', 2)).toEqual({ top: 1, right: 1, bottom: 2, left: 1 });
    expect(Object.keys(writePart(1, SIDES, 'bottom', 2) as object)).toEqual(SIDES);
    const next = typed(fresh(), at('容器'), 'padding', 'left', 4);
    expect(elementOf(next, at('容器'))['padding']).toEqual({ top: 1, right: 1, bottom: 1, left: 4 });
    expect(severe(next)).toEqual([]);
  });

  it('四边不同：一边一边改，互不影响', () => {
    let document = fresh();
    for (const [side, next] of [['top', 1], ['right', 2], ['bottom', 3], ['left', 4]] as const) document = typed(document, at('容器'), 'padding', side, next);
    expect(elementOf(document, at('容器'))['padding']).toEqual({ top: 1, right: 2, bottom: 3, left: 4 });
    expect(severe(document)).toEqual([]);
    // 清空一边是去掉那一边（引擎按 0）。
    document = typed(document, at('容器'), 'padding', 'right', undefined);
    expect(elementOf(document, at('容器'))['padding']).toEqual({ top: 1, bottom: 3, left: 4 });
    expect(severe(document)).toEqual([]);
  });

  it('四边都写了又都一样：收回成一个数；改回原来的数，内容和原来一样', () => {
    expect(writePart({ top: 2, right: 2, bottom: 2, left: 5 }, SIDES, 'left', 2)).toBe(2);
    // 只列了三边的不收：没列的那边是 0，不是 2。
    expect(writePart({ top: 2, right: 2, bottom: 5 }, SIDES, 'bottom', 2)).toEqual({ top: 2, right: 2, bottom: 2 });
    const changed = typed(fresh(), at('容器'), 'padding', 'left', 4);
    const back = typed(changed, at('容器'), 'padding', 'left', 1);
    expect(back).toEqual(original);
    expect(severe(back)).toEqual([]);
  });

  it('一边都不剩：去掉整格', () => {
    expect(writePart({ bottom: 2 }, SIDES, 'bottom', undefined)).toBeUndefined();
    const written = typed(fresh(), at('容器/容器内文字'), 'place.margin', 'bottom', 2);
    const cleared = typed(written, at('容器/容器内文字'), 'place.margin', 'bottom', undefined);
    expect(cleared).toEqual(original);
  });

  it('绑定变量：只绑一边，别的边留着；四边绑同一个变量时收回成一个变量', () => {
    const one = typed(fresh(), at('容器'), 'padding', 'top', { var: 'bandHeight' });
    expect(elementOf(one, at('容器'))['padding']).toEqual({ top: { var: 'bandHeight' }, right: 1, bottom: 1, left: 1 });
    expect(severe(one)).toEqual([]);
    let all = one;
    for (const side of ['right', 'bottom', 'left']) all = typed(all, at('容器'), 'padding', side, { var: 'bandHeight' });
    expect(elementOf(all, at('容器'))['padding']).toEqual({ var: 'bandHeight' });
    expect(severe(all)).toEqual([]);
  });

  it('把一边提取为参数：参数加上，整格写成只有那一边绑定', () => {
    const document = fresh(), found = field(document, at('容器'), 'padding');
    const written = writePart(found.value, SIDES, 'bottom', { var: 'paddingBottom' });
    const next = extractParameter(document, at('容器'), found.path, { name: 'paddingBottom', displayName: '容器内边距（下）', type: 'number', value: 1 }, written);
    expect(elementOf(next, at('容器'))['padding']).toEqual({ top: 1, right: 1, bottom: { var: 'paddingBottom' }, left: 1 });
    expect((next['parameters'] as JsonObject[]).at(-1)).toEqual({ name: 'paddingBottom', displayName: '容器内边距（下）', visibility: 'internal', type: 'number', default: 1 });
    expect(severe(next)).toEqual([]);
    // 没给整格写什么时照旧：整格绑定。
    const whole = extractParameter(document, at('容器'), found.path, { name: 'pad', displayName: '容器内边距', type: 'number', value: 1 });
    expect(elementOf(whole, at('容器'))['padding']).toEqual({ var: 'pad' });
  });

  it('圆角的四角同样', () => {
    const next = typed(fresh(), at('矩形'), 'cornerRadius', 'topLeft', 3);
    expect(elementOf(next, at('矩形'))['cornerRadius']).toEqual({ topLeft: 3, topRight: 1, bottomRight: 1, bottomLeft: 1 });
    expect(severe(next)).toEqual([]);
    expect(typed(next, at('矩形'), 'cornerRadius', 'topLeft', 1)).toEqual(original);
  });
});

describe('收起来怎么说', () => {
  it('取值一样的边并在一起，是 0 和没写的不提；全是 0 说 0', () => {
    expect(edgesSummary({ top: 1, bottom: 2 }, SIDE_PARTS)).toBe('上 1 · 下 2');
    expect(edgesSummary({ bottom: 2 }, SIDE_PARTS)).toBe('下 2');
    expect(edgesSummary({ top: 1, right: 2, bottom: 1, left: 2 }, SIDE_PARTS)).toBe('上下 1 · 左右 2');
    expect(edgesSummary({ top: 0, right: 0.5 }, SIDE_PARTS)).toBe('右 0.5');
    expect(edgesSummary({ top: 0 }, SIDE_PARTS)).toBe('0');
    expect(edgesSummary({}, SIDE_PARTS)).toBe('0');
  });

  it('绑定着变量的边写变量的显示名称；两个字的名称用顿号隔开', () => {
    expect(edgesSummary({ top: { var: 'bandHeight' }, right: 1, bottom: 1, left: 1 }, SIDE_PARTS, () => '色带高度')).toBe('上 色带高度 · 下左右 1');
    const corners = [{ key: 'topLeft', label: '左上' }, { key: 'topRight', label: '右上' }, { key: 'bottomRight', label: '右下' }, { key: 'bottomLeft', label: '左下' }];
    expect(edgesSummary({ topLeft: 2, topRight: 2 }, corners)).toBe('左上、右上 2');
  });

  it('一个数、一个变量、没写：不用摘要，框里直接是它', () => {
    expect(edgesSummary(3, SIDE_PARTS)).toBeUndefined();
    expect(edgesSummary({ var: 'gap' }, SIDE_PARTS)).toBeUndefined();
    expect(edgesSummary(undefined, SIDE_PARTS)).toBeUndefined();
  });
});
