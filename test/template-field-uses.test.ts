/**
 * 模板读到的字段（阶段 5 P1 票据 04、验收 A02）：删字段、改字段名称时，列出用到它们的模板。
 * 输入是 docs/examples/m402-dsl/ 的数据定义与模板，以及从线路牌模板构造的改动版本。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { templateFieldUses, type StaticSchemaEntry } from '../src/index.js';
import { m402Dir, singleTextDir } from './support/fixtures.js';

const ROUTE_SIGN = { name: '线路牌', version: 1 };
const STOP = { name: '停靠站点', version: 1 };
let schemas: StaticSchemaEntry[];
let routeSign: any;
let stop: any;

beforeAll(async () => {
  const read = async (file: string) => JSON.parse(await readFile(join(m402Dir, file), 'utf8'));
  schemas = [
    { ref: ROUTE_SIGN, definition: await read('schema-route-sign-v1.json') },
    { ref: STOP, definition: await read('schema-stop-v1.json') },
  ];
  routeSign = await read('template-route-sign.json');
  stop = await read('template-stop.json');
});

const fieldsOf = (document: unknown, schema: { name: string; version: number }, entries = schemas) =>
  templateFieldUses(document, entries).uses.filter((use) => use.schema.name === schema.name && use.schema.version === schema.version).map((use) => use.field).sort();

describe('templateFieldUses', () => {
  it('线路牌模板：绑定、插槽、派生变量与循环读到的基准字段都在，没用到的不在，参数与派生变量不算字段', () => {
    const fields = fieldsOf(routeSign, ROUTE_SIGN);
    for (const field of ['routeNo', 'routeNoImage', 'fare', 'stops', 'serviceNote', 'departureTimes']) expect(fields).toContain(field);
    const declared = schemas[0]!.definition as { fields: { name: string }[] };
    expect(fields.filter((field) => !declared.fields.some((candidate) => candidate.name === field))).toEqual([]);
    for (const parameter of ['currentIndex', 'primaryColor', 'stopNameSize']) expect(fields).not.toContain(parameter);
    for (const variable of ['nextStop', 'stopCount', 'hasFare']) expect(fields).not.toContain(variable);
  });

  it('路径经过引用时，记在引用指向的数据定义上：派生变量 nextStop.landmark，循环的 mergeBy', () => {
    const fields = fieldsOf(routeSign, STOP);
    expect(fields).toContain('landmark');
    expect(fields).toContain('road');
  });

  it('基准字段经单引用往下读：记下引用字段，也记下引用指向的那份数据定义里的字段', async () => {
    const greeting = await readFile(join(singleTextDir, 'template-greeting.json'), 'utf8');
    const holder = { name: '带引用', version: 1 };
    const template = JSON.parse(greeting.replace('"slot": "message"', '"slot": "info.landmark"'));
    template.base = holder;
    const entries: StaticSchemaEntry[] = [...schemas, { ref: holder, definition: {
      dslVersion: 'renderweave-schema/1', name: '带引用', version: 1, displayName: '带引用',
      fields: [{ name: 'info', displayName: '站点', type: 'ref', ref: STOP }],
    } }];
    expect(fieldsOf(template, holder, entries)).toEqual(['info']);
    expect(fieldsOf(template, STOP, entries)).toEqual(['landmark']);
  });

  it('子模板各算各的：停靠站点模板的字段记在自己的基准上，线路牌模板不因调用它就算读到', () => {
    const own = fieldsOf(stop, STOP);
    expect(own).toContain('badges');
    expect(fieldsOf(routeSign, STOP)).not.toContain('badges');
  });

  it('删掉绑定后不再算用到；只在检查项里读到的字段也算', () => {
    const edited = structuredClone(routeSign);
    edited.parameters = [...edited.parameters];
    edited.derived = [{ name: 'noOperator', displayName: '没有运营方', type: 'boolean', op: 'branch',
      branches: [{ when: { left: { var: 'operator' }, op: 'empty' }, then: { value: true } }], otherwise: { value: false } }];
    edited.checks = [{ name: '运营方', problemWhen: { var: 'noOperator' }, level: 'hint', message: '缺运营方' }];
    edited.artboard = { ...edited.artboard, children: [] };
    expect(fieldsOf(edited, ROUTE_SIGN)).toEqual(['operator']);
  });

  it('静态数据定义缺原文时走到引用为止，基准字段照记；模板读不了时答问题清单', () => {
    const fields = fieldsOf(routeSign, ROUTE_SIGN, []);
    expect(fields).toContain('routeNo');
    expect(fields).toContain('stops');
    expect(fieldsOf(routeSign, STOP, [])).toContain('landmark');
    expect(fieldsOf(routeSign, STOP, [])).not.toContain('road');
    expect(templateFieldUses({ dslVersion: 'renderweave-template/1' }, schemas)).toMatchObject({ uses: [], problems: [{ level: 'severe' }] });
    const broken = templateFieldUses({ ...routeSign, base: 'x' }, schemas);
    expect(broken.uses).toEqual([]);
    expect(broken.problems.some((problem) => problem.level === 'severe')).toBe(true);
  });
});
