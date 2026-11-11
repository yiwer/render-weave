/**
 * 连接数据（模板设计页第三轮票据 07）：字段或变量连到已有元素上，只经 connectData 这一入口。
 * 写回结果由引擎的 checkDslDocument 判断；类型不合的拒绝并给原因，原文档不变。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { connectChoices, connectData, connectEffect, fieldDropKind, type DataSource } from '../console/src/template/connect.js';
import { elementAt, templateText, type JsonObject } from '../console/src/template/document.js';
import { checkDslDocument } from '../src/engine.js';
import { M402_DIR } from './seed.js';

const ROUTE = '标准线路单边';
let route: JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const at = (document: JsonObject, path: string) => elementAt(document, `${ROUTE}/${path}`)!.element;

beforeAll(async () => {
  route = JSON.parse(await readFile(`${M402_DIR}template-route-sign.json`, 'utf8')) as JsonObject;
});

const operator: DataSource = { name: 'operator', label: '运营方', type: 'text' };
const fare: DataSource = { name: 'fare', label: '票价', type: 'number' };
const routeNoImage: DataSource = { name: 'routeNoImage', label: '线路号图片', type: 'image' };
const hasFare: DataSource = { name: 'hasFare', label: '有票价', type: 'boolean' };
const stops: DataSource = { name: 'stops', label: '停靠站点', type: 'list' };
const terminal: DataSource = { name: 'terminal', label: '终点站', type: 'ref' };
const primaryColor: DataSource = { name: 'primaryColor', label: '主色', type: 'color' };

describe('连上：文字换插槽，图片换来源，布尔绑显示', () => {
  it('文字类的字段连到文字上：内容整个换成这个字段的插槽，别的属性不动', () => {
    const before = templateText(route);
    const result = connectData(route, ROUTE, `${ROUTE}/顶栏/票价框/票价`, fare);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effect).toBe('content');
    expect(at(result.document, '顶栏/票价框/票价')['content']).toEqual([{ slot: 'fare' }]);
    const { content: _was, ...kept } = at(route, '顶栏/票价框/票价'), { content: _now, ...after } = at(result.document, '顶栏/票价框/票价');
    expect(after).toEqual(kept);
    expect(result.summary).toBe('「票价」的内容换成了「票价」（fare）。');
    expect(severe(result.document)).toEqual([]);
    expect(templateText(route)).toBe(before);
  });

  it.each(['text', 'number', 'date', 'time', 'datetime'])('%s 类型能连到文字上', (type) => {
    expect(connectEffect('text', type)).toBe('content');
  });

  it('图片字段连到图片上：换来源', () => {
    const result = connectData(route, ROUTE, `${ROUTE}/底栏/下一站区/下一站地标`, routeNoImage);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effect).toBe('source');
    expect(at(result.document, '底栏/下一站区/下一站地标')['source']).toEqual({ var: 'routeNoImage' });
    expect(result.summary).toBe('「下一站地标」的图片来源换成了「线路号图片」（routeNoImage）。');
    expect(severe(result.document)).toEqual([]);
  });

  it.each(['顶栏/运营方', '顶栏/线路号图片', '顶栏/开往箭头', '顶栏/顶栏留白', '站点面板/站点列'])('布尔连到哪种元素上都是绑显示：%s', (path) => {
    const result = connectData(route, ROUTE, `${ROUTE}/${path}`, hasFare);
    if (!result.ok) throw new Error(result.reason);
    expect(result.effect).toBe('visible');
    expect(at(result.document, path)['visible']).toEqual({ var: 'hasFare' });
    expect(severe(result.document)).toEqual([]);
  });

  it('同一份数据连两次，写回逐字节相同；找不到的元素拒绝', () => {
    const once = connectData(route, ROUTE, `${ROUTE}/顶栏/终点站`, operator), twice = connectData(route, ROUTE, `${ROUTE}/顶栏/终点站`, operator);
    if (!once.ok || !twice.ok) throw new Error('应当连得上');
    expect(templateText(once.document)).toBe(templateText(twice.document));
    expect(connectData(route, ROUTE, `${ROUTE}/没有这个元素`, operator)).toEqual({ ok: false, reason: '找不到这个元素，可能刚被删掉。' });
  });
});

describe('类型不合的拒绝，并说明原因', () => {
  const rejected = (path: string, source: DataSource) => {
    const result = connectData(route, ROUTE, path === '' ? ROUTE : `${ROUTE}/${path}`, source);
    if (result.ok) throw new Error(`不该连上：${result.summary}`);
    return result.reason;
  };

  it('图片字段拖到文字上、文字字段拖到图片上', () => {
    expect(rejected('顶栏/运营方', routeNoImage)).toBe('「运营方」是文字，接不了图片类型的「线路号图片」：拖到图片上换来源，或拖到空白处建一个图片。');
    expect(rejected('顶栏/线路号图片', operator)).toBe('「线路号图片」是图片，接不了文本类型的「运营方」：拖到文字上换内容，或拖到空白处建一个文字。');
  });

  it('列表与引用连不到元素上：它们建的是循环容器与子模板调用', () => {
    expect(rejected('顶栏/运营方', stops)).toBe('「停靠站点」是列表，连不到「运营方」上：列表建的是循环容器，拖到空白处或容器里。');
    expect(rejected('顶栏/线路号图片', terminal)).toBe('「终点站」是引用，连不到「线路号图片」上：引用建的是子模板调用，拖到空白处或容器里。');
  });

  it('形状、容器、循环接不了文字与图片；颜色哪里都连不上', () => {
    expect(rejected('顶栏/开往箭头', operator)).toBe('「开往箭头」是路径，接不了文本类型的「运营方」：文字接文字类的数据，图片接图片，布尔绑显示。');
    expect(rejected('站点面板/站点列', routeNoImage)).toContain('「站点列」是循环容器');
    expect(rejected('顶栏/运营方', primaryColor)).toBe('「运营方」是文字，接不了颜色类型的「主色」。');
  });

  it('画板接不了数据；布尔拖到画板上说明画板没有显示条件', () => {
    expect(rejected('', operator)).toBe('画板接不了数据：拖到一个元素上，或拖到空白处建一个新元素。');
    expect(rejected('', hasFare)).toBe('布尔类型的「有票价」绑的是元素的显示，画板没有显示条件：拖到一个元素上。');
  });

  it('已经连着的不再写一次', () => {
    expect(rejected('顶栏/运营方', operator)).toBe('「运营方」已经连着「运营方」了。');
    expect(rejected('顶栏/线路号图片', routeNoImage)).toBe('「线路号图片」已经连着「线路号图片」了。');
    expect(rejected('顶栏/票价框', hasFare)).toBe('「票价框」已经连着「有票价」了。');
    // 插槽带着格式或样式、前后还有文字的，不算已经连着：连上会把内容整个换掉。
    expect(connectData(route, ROUTE, `${ROUTE}/底栏/服务时间内容/服务时间`, { name: 'firstDeparture', label: '首班', type: 'time' }).ok).toBe(true);
  });
});

describe('拖到元素上算什么', () => {
  it('文字与图片是连上，容器与画板是放进去，别的让给外层', () => {
    expect(fieldDropKind('text', false, 'text')).toBe('connect');
    expect(fieldDropKind('image', false, 'list')).toBe('connect');
    expect(fieldDropKind('container', false, 'text')).toBe('inside');
    expect(fieldDropKind(undefined, true, 'image')).toBe('inside');
    expect(fieldDropKind('rect', false, 'text')).toBe('pass');
    expect(fieldDropKind('loop', false, 'ref')).toBe('pass');
  });

  it('布尔拖到哪里都是连上：它不建元素', () => {
    for (const type of ['text', 'container', 'loop', 'rect']) expect(fieldDropKind(type, false, 'boolean')).toBe('connect');
    expect(fieldDropKind(undefined, true, 'boolean')).toBe('connect');
  });
});

describe('"连接数据…"里列哪些', () => {
  const variables = [operator, fare, routeNoImage, hasFare, stops, terminal, primaryColor];
  const names = (path: string) => connectChoices(route, ROUTE, `${ROUTE}/${path}`, variables).map((choice) => `${choice.source.name}:${choice.what}${choice.current ? ':已连' : ''}`);

  it('文字列文字类的与布尔，图片列图片与布尔，别的元素只列布尔', () => {
    expect(names('顶栏/运营方')).toEqual(['operator:换内容:已连', 'fare:换内容', 'hasFare:绑显示']);
    expect(names('顶栏/线路号图片')).toEqual(['routeNoImage:换来源:已连', 'hasFare:绑显示']);
    expect(names('顶栏/票价框')).toEqual(['hasFare:绑显示:已连']);
    expect(names('顶栏/开往箭头')).toEqual(['hasFare:绑显示']);
  });

  it('画板与找不到的元素没有可连的', () => {
    expect(connectChoices(route, ROUTE, ROUTE, variables)).toEqual([]);
    expect(connectChoices(route, ROUTE, `${ROUTE}/没有这个元素`, variables)).toEqual([]);
  });

  it('列出来的每一项选了都连得上（已连的除外），写回都合法', () => {
    for (const path of ['顶栏/运营方', '顶栏/线路号图片', '顶栏/票价框', '顶栏/开往箭头', '站点面板/站点列']) {
      for (const choice of connectChoices(route, ROUTE, `${ROUTE}/${path}`, variables)) {
        const result = connectData(route, ROUTE, `${ROUTE}/${path}`, choice.source);
        expect(result.ok).toBe(!choice.current);
        if (result.ok) {
          expect(result.effect).toBe(choice.effect);
          expect(severe(result.document)).toEqual([]);
        }
      }
    }
  });
});
