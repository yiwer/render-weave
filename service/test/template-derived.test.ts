/**
 * 派生变量与检查项（模板设计页票据 16）：每种运算的写回由 checkDslDocument 判断；分支的行增删移动、条件三种写法、循环引用、删除时谁在用。
 * 文档是 M402 的站点模板（stopState 是四支的分支）。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../console/src/template/document.js';
import { addBranch, addCheck, addDerived, cycleOf, definitionsUsing, moveBranch, newCheck, newDerived, OPS, removeBranch, removeCheck, removeDerived, setDerived, withBranchType, withCompareOp, withConditionKind, type Variable } from '../console/src/template/derived.js';
import { checkDslDocument } from '../src/engine.js';
import { M402_DIR } from './seed.js';

let stop: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const VARIABLES: readonly Variable[] = [
  { name: 'name', type: 'text' }, { name: 'index', type: 'number' }, { name: 'currentIndex', type: 'number' }, { name: 'landmark', type: 'image' },
  { name: 'marks', type: 'list', itemType: 'ref', itemRef: { name: '站名标识', version: 1 } }, { name: 'tags', type: 'list', itemType: 'text' }, { name: 'express', type: 'boolean' },
];
const stopState = () => (stop['derived'] as JsonObject[]).find((item) => item['name'] === 'stopState')!;

beforeAll(async () => {
  stop = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8')) as JsonObject;
  expect(severe(stop)).toEqual([]);
});

describe('新建派生变量', () => {
  it.each(OPS.map((item) => [item.label, item.op] as const))('%s：初值合 Schema，加进文档仍合法', (_label, op) => {
    const definition = newDerived(op, `new${op}`, '新变量', VARIABLES) as JsonObject;
    expect(definition).not.toHaveProperty('problem');
    const next = addDerived(stop, definition);
    expect(severe(next)).toEqual([]);
  });

  it('结果类型按运算推：取项随列表的项，长度与算术是数值，拆取文本是文本', () => {
    expect(newDerived('pickItem', 'a', 'a', VARIABLES)).toMatchObject({ type: 'ref', ref: { name: '站名标识', version: 1 } });
    expect(newDerived('pickItem', 'a', 'a', [{ name: 'tags', type: 'list', itemType: 'text' }])).toMatchObject({ type: 'text' });
    expect(newDerived('length', 'a', 'a', VARIABLES)).toMatchObject({ type: 'number' });
    expect(newDerived('divide', 'a', 'a', VARIABLES)).toMatchObject({ type: 'number', right: { value: 1 } });
    expect(newDerived('splitPart', 'a', 'a', VARIABLES)).toMatchObject({ type: 'text', delimiter: ' ' });
  });

  it('要的变量作用域里没有时说明，不造一个坏的', () => {
    expect(newDerived('pickItem', 'a', 'a', [{ name: 'name', type: 'text' }])).toEqual({ problem: '作用域里没有列表变量' });
    expect(newDerived('splitPart', 'a', 'a', [{ name: 'flag', type: 'boolean' }])).toHaveProperty('problem');
  });
});

describe('分支编辑器', () => {
  it('加一支、去一支、调整顺序；至少留一支', () => {
    const added = addBranch(stopState(), VARIABLES);
    expect((added['branches'] as unknown[]).length).toBe(4);
    expect(severe(setDerived(stop, 'stopState', added))).toEqual([]);
    const moved = moveBranch(stopState(), 0, 1)!;
    expect((moved['branches'] as JsonObject[])[1]).toEqual((stopState()['branches'] as JsonObject[])[0]);
    expect(moveBranch(stopState(), 0, -1)).toBeUndefined();
    let one: JsonObject = stopState();
    while ((one['branches'] as unknown[]).length > 1) one = removeBranch(one, 0)!;
    expect(removeBranch(one, 0)).toBeUndefined();
    expect(severe(setDerived(stop, 'stopState', one))).toEqual([]);
  });

  it('条件三种写法互换：单个、全部成立、任一成立；为空只有左侧', () => {
    const when = (stopState()['branches'] as JsonObject[])[1]!['when'];
    const all = withConditionKind(when, 'all');
    expect(all).toEqual({ all: [when] });
    expect(withConditionKind(all, 'any')).toEqual({ any: [when] });
    expect(withConditionKind(all, 'single')).toEqual(when);
    const empty = withCompareOp(when as JsonObject, 'empty');
    expect(empty).not.toHaveProperty('right');
    expect(withCompareOp(empty, 'eq')).toMatchObject({ right: { value: '' } });
    const branches = [...(stopState()['branches'] as JsonObject[])];
    branches[1] = { ...branches[1]!, when: all };
    expect(severe(setDerived(stop, 'stopState', { ...stopState(), branches }))).toEqual([]);
  });

  it('改结果类型：对不上的固定值换成新类型的初值', () => {
    const numeric = withBranchType(stopState(), 'number');
    expect(numeric['otherwise']).toEqual({ value: 0 });
    expect(((numeric['branches'] as JsonObject[])[0]!['then'])).toEqual({ value: 0 });
    expect(withBranchType(stopState(), 'text')['otherwise']).toEqual({ value: '未到站' });
  });
});

describe('检查项', () => {
  it('新建用作用域里的布尔变量，没有时先写"否"；加进与删掉都合法', () => {
    expect(newCheck('c', '检查', VARIABLES)).toMatchObject({ problemWhen: { var: 'express' }, level: 'hint' });
    const check = newCheck('noLandmark', '没有地标', []);
    expect(check).toMatchObject({ problemWhen: { value: false } });
    const added = addCheck(stop, check);
    expect(severe(added)).toEqual([]);
    expect(removeCheck(added, 'noLandmark')).not.toHaveProperty('checks');
  });
});

describe('删除与循环引用', () => {
  it('删派生变量：其余不动；最后一个删完不留空数组', () => {
    const removed = removeDerived(stop, 'hasLandmark');
    expect((removed['derived'] as JsonObject[]).map((item) => item['name'])).toEqual(['stopState']);
    expect(removeDerived(removeDerived(stop, 'hasLandmark'), 'stopState')).not.toHaveProperty('derived');
  });

  it('谁在用：派生变量与检查项', () => {
    const extra = addDerived(stop, { name: 'isCurrent', displayName: '是本站', type: 'boolean', op: 'branch', branches: [{ when: { left: { var: 'stopState' }, op: 'eq', right: { value: '本站' } }, then: { value: true } }], otherwise: { value: false } });
    expect(definitionsUsing(extra, 'stopState')).toEqual(['isCurrent']);
  });

  it('经别的派生变量用到自己：循环引用', () => {
    const a = { name: 'a', displayName: 'a', type: 'number', op: 'add', left: { var: 'b' }, right: { value: 1 } };
    const b = { name: 'b', displayName: 'b', type: 'number', op: 'add', left: { var: 'a' }, right: { value: 1 } };
    const looped = addDerived(addDerived(stop, a), b);
    expect(cycleOf(looped, 'a')).toBe(true);
    expect(cycleOf(stop, 'stopState')).toBe(false);
  });
});
