/**
 * 宽高一格（模板设计页第三轮票据 01）：只经"给字段与输入、得到要写的值"这一入口，写回的结果由引擎的 checkDslDocument 判断。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../console/src/template/document.js';
import { fieldByKey, propertyPanel, writeProperty, type PropertyField } from '../console/src/template/properties.js';
import { chosenSize, itemSizeModel, sizeModel, typedSize, type SizeModel } from '../console/src/template/size.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE } from './seed.js';

const NAME = '全元素牌';
const at = (name: string) => `${NAME}/${name}`;
let original: JsonObject;
const fresh = (): JsonObject => JSON.parse(JSON.stringify(original)) as JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const field = (document: JsonObject, path: string, key: string): PropertyField => {
  const found = fieldByKey(propertyPanel(document, path)!, key);
  if (!found) throw new Error(`${path} 没有 ${key}`);
  return found;
};
const model = (document: JsonObject, path: string, key: string): SizeModel => {
  const found = sizeModel(field(document, path, key));
  if (!found) throw new Error(`${path} 的 ${key} 不是尺寸`);
  return found;
};
const elementOf = (document: JsonObject, path: string): JsonObject => {
  let node = document['artboard'] as JsonObject;
  for (const name of path.split('/').slice(1)) node = (node['children'] as JsonObject[]).find((child) => child['name'] === name)!;
  return node;
};
const value = (result: { value: unknown } | { problem: string }) => {
  if ('problem' in result) throw new Error(result.problem);
  return result.value;
};

beforeAll(async () => {
  original = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(severe(original)).toEqual([]);
});

describe('现在是什么', () => {
  it('元素的宽高：固定在最前，没写时的缺省按父布局（堆叠与自由随内容，网格撑满）', () => {
    const document = fresh();
    // 自由布局里的矩形：固定 22。
    expect(model(document, at('矩形'), 'place.width')).toMatchObject({ kind: 'fixed', fixed: 22, positive: false });
    expect(model(document, at('矩形'), 'place.width').options.map((option) => option.label)).toEqual(['固定', '随内容', '撑满', '按比例撑满']);
    // 堆叠里的文字：高撑满，宽没写，缺省随内容。
    expect(model(document, at('容器/容器内文字'), 'place.height')).toMatchObject({ kind: 'fill' });
    expect(model(document, at('容器/容器内文字'), 'place.width').kind).toBeUndefined();
    expect(field(document, at('容器/容器内文字'), 'place.width').fallback).toBe('hug');
    // 网格里：没写宽高时撑满。
    const grid = writeProperty(document, at('容器'), ['layout'], { mode: 'grid', rows: ['hug'], columns: [{ fraction: 1 }] });
    expect(field(grid, at('容器/容器内文字'), 'place.width').fallback).toBe('fill');
    // 不是尺寸的变体（外边距）不画成这一格。
    expect(sizeModel(field(document, at('容器/容器内文字'), 'place.margin'))).toBeUndefined();
  });

  it('绑定变量的固定值、按比例的权重都认得', () => {
    const document = fresh(), path = at('矩形');
    const bound = writeProperty(document, path, ['place', 'width'], { fixed: { var: 'boxWidth' } });
    expect(model(bound, path, 'place.width')).toMatchObject({ kind: 'fixed', bound: 'boxWidth' });
    const ratio = writeProperty(document, path, ['place', 'width'], { fill: 2 });
    expect(model(ratio, path, 'place.width')).toMatchObject({ kind: 'ratio', ratio: 2 });
  });

  it('循环的每项尺寸：固定、等分、随内容，固定要是正数', () => {
    expect(itemSizeModel('equal')).toMatchObject({ kind: 'equal', positive: true });
    expect(itemSizeModel({ fixed: 9 })).toMatchObject({ kind: 'fixed', fixed: 9 });
    expect(itemSizeModel({ fixed: { var: 'itemWidth' } })).toMatchObject({ kind: 'fixed', bound: 'itemWidth' });
    expect(itemSizeModel(undefined).options.map((option) => option.label)).toEqual(['固定', '等分', '随内容']);
  });
});

describe('打一个数、选一种方式写什么', () => {
  it('打数就是固定；按比例时改权重；清空是去掉；不合法的答原因', () => {
    const hug: SizeModel = { options: [], kind: 'hug', positive: false };
    expect(typedSize(hug, '9')).toEqual({ value: { fixed: 9 } });
    expect(typedSize(hug, '0')).toEqual({ value: { fixed: 0 } });
    expect(typedSize(hug, ' ')).toEqual({ value: undefined });
    expect(typedSize(hug, '-1')).toEqual({ problem: '不能小于 0' });
    expect(typedSize(hug, 'abc')).toEqual({ problem: '要填数字' });
    expect(typedSize({ options: [], kind: 'ratio', ratio: 1, positive: false }, '2')).toEqual({ value: { fill: 2 } });
    expect(typedSize({ options: [], kind: 'ratio', ratio: 1, positive: false }, '0')).toEqual({ problem: '比例要大于 0' });
    expect(typedSize(itemSizeModel('equal'), '0')).toEqual({ problem: '要大于 0' });
  });

  it('换成固定取实际尺寸；固定换固定不动；按比例保留权重；别的写常量', () => {
    const hug: SizeModel = { options: [], kind: 'hug', positive: false };
    expect(chosenSize(hug, 'fixed', 10.04)).toEqual({ fixed: 10 });
    expect(chosenSize(hug, 'fixed')).toEqual({ fixed: 10 });
    expect(chosenSize({ options: [], kind: 'fixed', bound: 'w', positive: false }, 'fixed', 3)).toEqual({ fixed: { var: 'w' } });
    expect(chosenSize(hug, 'ratio')).toEqual({ fill: 1 });
    expect(chosenSize({ options: [], kind: 'ratio', ratio: 3, positive: false }, 'ratio')).toEqual({ fill: 3 });
    expect(chosenSize(hug, 'fill')).toBe('fill');
    expect(chosenSize(hug, '')).toBeUndefined();
    expect(chosenSize(itemSizeModel('equal'), 'fixed', 0)).toEqual({ fixed: 10 });
  });
});

describe('写回之后仍是合法的模板，写回原值内容还原', () => {
  const grid = (document: JsonObject) => writeProperty(document, at('容器'), ['layout'], { mode: 'grid', rows: ['hug'], columns: [{ fraction: 1 }] });
  const cases: readonly (readonly [string, (document: JsonObject) => JsonObject, string, string])[] = [
    ['自由', (document) => document, at('矩形'), 'width'],
    ['堆叠', (document) => document, at('容器/容器内文字'), 'width'],
    ['网格', grid, at('容器/容器内文字'), 'height'],
  ];
  for (const [layout, prepare, path, axis] of cases) {
    it(`${layout}：打数、随内容、撑满、按比例、清空`, () => {
      const base = prepare(fresh()), before = JSON.stringify(base), key = `place.${axis}`;
      const original = (elementOf(base, path)['place'] as JsonObject | undefined)?.[axis];
      const writes = [
        value(typedSize(model(base, path, key), '12.5')),
        chosenSize(model(base, path, key), 'hug'),
        chosenSize(model(base, path, key), 'fill'),
        chosenSize(model(base, path, key), 'ratio'),
        chosenSize(model(base, path, key), 'fixed', 7.26),
        value(typedSize(model(base, path, key), '')),
      ];
      for (const write of writes) {
        const written = writeProperty(base, path, ['place', axis], write);
        expect(severe(written), `${layout} ${JSON.stringify(write)}`).toEqual([]);
        expect((elementOf(written, path)['place'] as JsonObject | undefined)?.[axis]).toEqual(write);
        expect(writeProperty(written, path, ['place', axis], original), '写回原值，内容还原（逐字节由编辑会话的撤销负责）').toEqual(JSON.parse(before));
      }
    });
  }

  it('循环的每项尺寸：打数是固定，换等分、随内容都合法', () => {
    const document = fresh(), path = at('循环'), before = JSON.stringify(document);
    const layout = elementOf(document, path)['itemLayout'] as JsonObject;
    const axis = layout['direction'] === 'column' ? 'heights' : 'widths', original = layout[axis];
    for (const write of [value(typedSize(itemSizeModel(original), '4')), chosenSize(itemSizeModel(original), 'equal'), chosenSize(itemSizeModel(original), 'content')]) {
      const written = writeProperty(document, path, ['itemLayout', axis], write);
      expect(severe(written), JSON.stringify(write)).toEqual([]);
      expect(writeProperty(written, path, ['itemLayout', axis], original)).toEqual(JSON.parse(before));
    }
  });
});
