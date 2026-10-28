/**
 * 数据定义差异的公开入口（阶段 5 P1 票据 02、验收 A03）：出图服务发布前的字段级差异用它。
 * 输入是 docs/examples/m402-dsl/ 的两份数据定义，以及从它们构造的改动版本。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ProblemCodes, checkDslDocument, diffDefinition } from '../src/index.js';
import { m402Dir } from './support/fixtures.js';

let routeSign: any;
let stop: any;
let template: any;

beforeAll(async () => {
  const read = async (file: string) => JSON.parse(await readFile(join(m402Dir, file), 'utf8'));
  routeSign = await read('schema-route-sign-v1.json');
  stop = await read('schema-stop-v1.json');
  template = await read('template-route-sign.json');
});

/** 改一份线路牌的副本：按字段名称取到字段，没有这个字段就是写错了用例。 */
function modified(change: (fields: any[], document: any) => void): any {
  const document = structuredClone(routeSign);
  change(document.fields, document);
  return document;
}
const field = (fields: any[], name: string) => fields.find((candidate) => candidate.name === name)!;

describe('diffDefinition：没有改动', () => {
  it('同一份数据定义没有任何差异', () => {
    expect(diffDefinition(routeSign, structuredClone(routeSign))).toEqual({ problems: [], definition: [], fields: [] });
  });

  it('键的先后、版本号与没有语义的写法不算改动', () => {
    const reordered = {
      fields: routeSign.fields.map((entry: any) => ({ constraints: entry.constraints, type: entry.type, displayName: entry.displayName, name: entry.name, ...(entry.items ? { items: entry.items } : {}) })),
      displayName: routeSign.displayName, name: routeSign.name, dslVersion: routeSign.dslVersion,
    };
    expect(diffDefinition(routeSign, reordered)).toEqual({ problems: [], definition: [], fields: [] });

    // 版本号由发布分配，草案不写、基于的版本写 v1，对不上也不是改动。
    const draft = structuredClone(routeSign);
    delete draft.version;
    expect(diffDefinition(routeSign, draft)).toEqual({ problems: [], definition: [], fields: [] });

    // 可选约束写成缺省值：required: false 与不写相同，图片不写 allowedSources 与两种来源都写相同。
    const explicit = modified((fields) => {
      field(fields, 'fare').constraints.required = false;
      field(fields, 'serviceNote').constraints.required = false;
    });
    expect(diffDefinition(routeSign, explicit).fields).toEqual([]);
    const sources = modified((fields) => { field(fields, 'routeNoImage').constraints = { allowedSources: ['resource', 'url'] }; });
    const bare = modified((fields) => { delete field(fields, 'routeNoImage').constraints; });
    expect(diffDefinition(bare, sources).fields).toEqual([]);
  });
});

describe('diffDefinition：增、删、改', () => {
  it('新增字段带原样内容，不标会影响绑定', () => {
    const added = { name: 'platform', displayName: '站台', type: 'text', constraints: { maxLength: 4 } };
    const after = modified((fields) => { fields.push(added); });
    const diff = diffDefinition(routeSign, after);
    expect(diff.problems).toEqual([]);
    expect(diff.fields).toEqual([{ path: 'platform', change: 'added', after: added }]);
    expect(diff.order).toBeUndefined();
  });

  it('删除字段带原样内容，标为会影响绑定', () => {
    const diff = diffDefinition(routeSign, modified((fields) => { fields.splice(fields.indexOf(field(fields, 'serviceNote')), 1); }));
    expect(diff.fields).toEqual([{ path: 'serviceNote', change: 'removed', before: field(routeSign.fields, 'serviceNote'), affectsBindings: true }]);
    expect(diff.order).toBeUndefined();
  });

  it('改字段名称是一删一增（字段名称是身份），删去的一条标为会影响绑定', () => {
    const diff = diffDefinition(routeSign, modified((fields) => { field(fields, 'fare').name = 'price'; }));
    expect(diff.fields.map((change) => [change.path, change.change, change.affectsBindings])).toEqual([
      ['price', 'added', undefined],
      ['fare', 'removed', true],
    ]);
    expect(diff.fields[0]!.after).toMatchObject({ name: 'price', displayName: '票价（元）', type: 'number' });
    // 不当作"改了名称"的修改，也不算顺序变化。
    expect(diff.fields.some((change) => change.change === 'changed')).toBe(false);
    expect(diff.order).toBeUndefined();
  });

  it('修改列出改了哪些属性键：显示名称、类型、约束、必填', () => {
    const after = modified((fields) => {
      const routeNo = field(fields, 'routeNo');
      routeNo.displayName = '路号';
      routeNo.constraints = { required: false, minLength: 1, maxLength: 10 };
      const fare = field(fields, 'fare');
      fare.type = 'text';
      fare.constraints = { maxLength: 6 };
      field(fields, 'operator').description = '运营该线路的公司';
    });
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields.map((change) => [change.path, change.change])).toEqual([['routeNo', 'changed'], ['fare', 'changed'], ['operator', 'changed']]);

    expect(diff.fields[0]!.properties).toEqual([
      { key: 'displayName', before: '线路号', after: '路号' },
      { key: 'required', before: true, after: false },
      { key: 'constraints.maxLength', before: 8, after: 10 },
    ]);
    // 类型换了，原类型的约束一并列出。
    expect(diff.fields[1]!.properties).toEqual([
      { key: 'type', before: 'number', after: 'text' },
      { key: 'constraints.min', before: 0 },
      { key: 'constraints.max', before: 100 },
      { key: 'constraints.maxLength', after: 6 },
    ]);
    expect(diff.fields[2]!.properties).toEqual([{ key: 'description', after: '运营该线路的公司' }]);
    // 只是修改，不会影响绑定的提示。
    expect(diff.fields.every((change) => change.affectsBindings === undefined)).toBe(true);
  });

  it('文本与数值的枚举、正则等各种约束都按约束键列出', () => {
    const before = modified((fields) => {
      field(fields, 'scheduleType').constraints = { enum: ['普通', '快线'], pattern: '^.+$' };
      field(fields, 'fare').constraints = { min: 0, max: 100, integer: true };
    });
    const after = modified((fields) => {
      field(fields, 'scheduleType').constraints = { enum: ['普通', '快线', '夜班'], maxLength: 10 };
      field(fields, 'fare').constraints = { min: 0, max: 100 };
    });
    const diff = diffDefinition(before, after);
    expect(diff.fields.find((change) => change.path === 'scheduleType')!.properties).toEqual([
      { key: 'constraints.pattern', before: '^.+$' },
      { key: 'constraints.enum', before: ['普通', '快线'], after: ['普通', '快线', '夜班'] },
      { key: 'constraints.maxLength', after: 10 },
    ]);
    expect(diff.fields.find((change) => change.path === 'fare')!.properties).toEqual([{ key: 'constraints.integer', before: true }]);
  });
});

describe('diffDefinition：列表与引用', () => {
  it('列表元素引用的版本变了：键带 items. 作父路径，列表自己的约束另列', () => {
    const after = modified((fields) => {
      const stops = field(fields, 'stops');
      stops.items.ref.version = 2;
      stops.constraints.maxItems = 80;
    });
    const diff = diffDefinition(routeSign, after);
    expect(diff.problems).toEqual([]);
    expect(diff.fields).toEqual([{
      path: 'stops',
      change: 'changed',
      properties: [
        { key: 'constraints.maxItems', before: 50, after: 80 },
        { key: 'items.ref.version', before: 1, after: 2 },
      ],
    }]);
  });

  it('引用其他数据定义：换了被引用的名称或版本', () => {
    const withRef = (name: string, version: number) => modified((fields) => {
      fields.push({ name: 'terminus', displayName: '终点站', type: 'ref', ref: { name, version } });
    });
    const diff = diffDefinition(withRef('停靠站点', 1), withRef('停靠站点', 3));
    expect(diff.fields).toEqual([{ path: 'terminus', change: 'changed', properties: [{ key: 'ref.version', before: 1, after: 3 }] }]);
    expect(diffDefinition(withRef('停靠站点', 1), withRef('换乘站点', 1)).fields[0]!.properties).toEqual([{ key: 'ref.name', before: '停靠站点', after: '换乘站点' }]);
  });

  it('列表元素类型与约束的改动：基本类型列表与枚举元素', () => {
    const after = modified((fields) => {
      field(fields, 'departureTimes').items = { type: 'text', constraints: { maxLength: 5 } };
    });
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields).toEqual([{
      path: 'departureTimes',
      change: 'changed',
      properties: [{ key: 'items.type', before: 'time', after: 'text' }, { key: 'items.constraints.maxLength', after: 5 }],
    }]);

    // 站点的 badges 是枚举元素的列表。
    const badges = structuredClone(stop);
    badges.fields.find((entry: any) => entry.name === 'badges').items.constraints.enum = ['地铁', '医院', '机场'];
    expect(diffDefinition(stop, badges).fields).toEqual([{
      path: 'badges',
      change: 'changed',
      properties: [{ key: 'items.constraints.enum', before: ['地铁', '医院'], after: ['地铁', '医院', '机场'] }],
    }]);
  });

  it('字段在列表与引用之间换类型：新旧两边的键都列出', () => {
    const after = modified((fields) => {
      const lastDeparture = field(fields, 'lastDeparture');
      lastDeparture.type = 'list';
      lastDeparture.items = { type: 'ref', ref: { name: '停靠站点', version: 1 } };
    });
    expect(diffDefinition(routeSign, after).fields).toEqual([{
      path: 'lastDeparture',
      change: 'changed',
      properties: [
        { key: 'type', before: 'time', after: 'list' },
        { key: 'items.type', after: 'ref' },
        { key: 'items.ref.name', after: '停靠站点' },
        { key: 'items.ref.version', after: 1 },
      ],
    }]);
  });
});

describe('diffDefinition：字段顺序', () => {
  it('只换顺序：单独标出，不算增删也不算修改', () => {
    const after = modified((fields) => { fields.reverse(); });
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields).toEqual([]);
    expect(diff.order?.before).toEqual(routeSign.fields.map((entry: any) => entry.name));
    expect(diff.order?.after).toEqual(routeSign.fields.map((entry: any) => entry.name).reverse());
  });

  it('顺序只比两边都有的字段：增删造成的位移不算顺序变化', () => {
    const after = modified((fields) => {
      fields.unshift({ name: 'platform', displayName: '站台', type: 'text' });
      fields.splice(fields.indexOf(field(fields, 'fare')), 1);
    });
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields.map((change) => [change.path, change.change])).toEqual([['platform', 'added'], ['fare', 'removed']]);
    expect(diff.order).toBeUndefined();
  });

  it('顺序、增删与修改同时发生时各自列出', () => {
    const after = modified((fields) => {
      const [moved] = fields.splice(fields.indexOf(field(fields, 'operator')), 1);
      fields.unshift(moved);
      field(fields, 'fare').displayName = '票价';
      fields.push({ name: 'platform', displayName: '站台', type: 'text' });
    });
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields.map((change) => [change.path, change.change])).toEqual([['fare', 'changed'], ['platform', 'added']]);
    expect(diff.order?.after[0]).toBe('operator');
    expect(diff.order?.after).not.toContain('platform');
  });
});

describe('diffDefinition：数据定义自身', () => {
  it('显示名称与说明的改动单独列出', () => {
    const after = structuredClone(routeSign);
    after.displayName = '线路牌（新）';
    after.description = '一块线路牌';
    const diff = diffDefinition(routeSign, after);
    expect(diff.fields).toEqual([]);
    expect(diff.definition).toEqual([
      { key: 'displayName', before: '线路牌（单线路单方向）', after: '线路牌（新）' },
      { key: 'description', after: '一块线路牌' },
    ]);
  });

  it('M402 的两份数据定义整个不同：名称改了，字段全删全增', () => {
    const diff = diffDefinition(routeSign, stop);
    expect(diff.problems).toEqual([]);
    expect(diff.definition.map((property) => property.key)).toEqual(['name', 'displayName', 'description']);
    const routeNames = routeSign.fields.map((entry: any) => entry.name);
    expect(diff.fields.filter((change) => change.change === 'removed').map((change) => change.path)).toEqual(routeNames);
    expect(diff.fields.filter((change) => change.change === 'added').map((change) => change.path)).toEqual(['name', 'landmark', 'road', 'badges']);
  });
});

describe('diffDefinition：读不了的输入', () => {
  it('不是数据定义：回答问题清单，问题码与 checkDslDocument 相同，说明是哪一边', () => {
    const diff = diffDefinition(template, routeSign);
    expect(diff.fields).toEqual([]);
    expect(diff.definition).toEqual([]);
    expect(diff.problems).toHaveLength(1);
    expect(diff.problems[0]).toMatchObject({ code: ProblemCodes.inputUnreadable, level: 'severe', location: { kind: 'input', source: '改前' } });

    const unknown = diffDefinition(routeSign, { hello: 'world' });
    expect(unknown.problems.map((problem) => [problem.code, problem.location])).toEqual([[ProblemCodes.inputUnreadable, { kind: 'input', source: '改后' }]]);
    expect(unknown.problems[0]!.code).toBe(checkDslDocument({ hello: 'world' }).problems[0]!.code);

    for (const value of [null, undefined, 'text', 3, []]) {
      expect(diffDefinition(routeSign, value).problems.map((problem) => problem.code)).toEqual([ProblemCodes.inputUnreadable]);
    }
  });

  it('数据定义本身有问题：沿用 checkDslDocument 的问题，消息带改前或改后', () => {
    const broken = modified((fields) => { fields.push({ ...field(fields, 'fare') }); });
    const expected = checkDslDocument(broken).problems;
    expect(expected.length).toBeGreaterThan(0);

    const diff = diffDefinition(routeSign, broken);
    expect(diff.fields).toEqual([]);
    expect(diff.problems.map((problem) => [problem.code, problem.level, problem.location])).toEqual(expected.map((problem) => [problem.code, problem.level, problem.location]));
    expect(diff.problems.every((problem) => problem.message.startsWith('改后的数据定义：'))).toBe(true);
    expect(diffDefinition(broken, routeSign).problems.every((problem) => problem.message.startsWith('改前的数据定义：'))).toBe(true);
  });

  it('两边都读不了时两边的问题都回答', () => {
    const conflict = modified((fields) => { field(fields, 'routeNo').constraints = { minLength: 9, maxLength: 2 }; });
    const diff = diffDefinition(conflict, { dslVersion: 'renderweave-schema/1', name: '空', fields: 'x' });
    expect(diff.problems.map((problem) => [problem.code, problem.message.slice(0, 5)])).toEqual([
      [ProblemCodes.definitionConstraintConflict, '改前的数据'],
      [ProblemCodes.definitionInvalid, '改后的数据'],
    ]);
  });
});

describe('diffDefinition：纯函数', () => {
  it('不改输入，重复调用结果相同，结果可以序列化', () => {
    const after = modified((fields) => {
      field(fields, 'stops').items.ref.version = 2;
      fields.reverse();
      fields.push({ name: 'platform', displayName: '站台', type: 'text' });
    });
    const frozenBefore = structuredClone(routeSign), frozenAfter = structuredClone(after);
    const first = diffDefinition(routeSign, after);
    expect(routeSign).toEqual(frozenBefore);
    expect(after).toEqual(frozenAfter);
    expect(diffDefinition(routeSign, after)).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });
});
