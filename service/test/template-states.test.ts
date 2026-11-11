/**
 * 状态样式（模板设计页票据 17）：写回入口与取值按钮。覆盖后的合并结果由 checkDslDocument 判断。文档是 M402 站点模板：站名按站点状态换颜色。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractParameter } from '../console/src/template/binding.js';
import { elementAt, type JsonObject } from '../console/src/template/document.js';
import { stateOverridable } from '../console/src/template/properties.js';
import {
  carryOverride, knownValues, mergedDocument, mergedElement, normalizeValue, overriddenKeys, resetOverride, setStateBy, stateCandidates, stateChips, statesOf,
  unknownValueProblem, writeElementOverride, writeOverride,
} from '../console/src/template/states.js';
import { checkDslDocument, checkTemplateStatic, loadWorkspace, type Workspace } from '../src/engine.js';
import { M402_DIR, RESOURCES_DIR } from './seed.js';

const NAME = '站点/名称区/站名', MARKS = '站点/标识行';
const STOP_STATES = ['普通', '已过站', '本站', '未到站'];
let stop: JsonObject, m402: Workspace;
/** 引擎带变量表的静态检查：站点模板换成这一份，看主模板（它调用站点）报什么。 */
const staticCodes = (document: JsonObject) => checkTemplateStatic({ ...m402, templates: m402.templates.map((entry) => (entry.name === '站点' ? { ...entry, document } : entry)) }, '标准线路单边').problems.map((problem) => problem.code);
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const at = (document: JsonObject, path: string) => elementAt(document, path)!.element;
const casesOf = (document: JsonObject, path: string) => statesOf(at(document, path)).cases;
/** 合法：结构检查与引擎带变量表的静态检查都没有严重问题（覆盖的取值、类型都对得上）。 */
const valid = (document: JsonObject) => {
  expect(severe(document)).toEqual([]);
  expect(checkTemplateStatic({ ...m402, templates: m402.templates.map((entry) => (entry.name === '站点' ? { ...entry, document } : entry)) }, '标准线路单边').problems.filter((problem) => problem.level === 'severe')).toEqual([]);
  return document;
};

beforeAll(async () => {
  stop = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8')) as JsonObject;
  m402 = await loadWorkspace({ dir: M402_DIR, resourcesDir: RESOURCES_DIR });
});

describe('依据与取值', () => {
  it('列表与引用不能作为依据', () => {
    const variables = [{ name: 'stops', label: '站', kind: 'field' as const, type: 'list' }, { name: 'terminal', label: '终点', kind: 'field' as const, type: 'object' }, { name: 'stopState', label: '站点状态', kind: 'derived' as const, type: 'text' }];
    expect(stateCandidates(variables).map((variable) => variable.name)).toEqual(['stopState']);
  });

  it('按文档推出全部取值：条件分支的固定结果、布尔、参数的枚举约束；推不出时没有', () => {
    expect(knownValues(stop, [], 'stopState')).toEqual(STOP_STATES);
    expect(knownValues(stop, [], 'hasLandmark')).toEqual(['true', 'false']);
    const parameters = [...(stop['parameters'] as JsonObject[]), { name: 'tier', displayName: '档位', visibility: 'public', type: 'number', constraints: { enum: [1, 2.5] }, default: 1 }];
    expect(knownValues({ ...stop, parameters }, [], 'tier')).toEqual(['1', '2.5']);
    expect(knownValues(stop, [], 'currentIndex')).toBeUndefined();
  });

  it('不会出现的取值当场说明，和引擎报 template.unknownStateValue 的判断一致', () => {
    expect(unknownValueProblem('到站', STOP_STATES, 'text', 'stopState')).toBe('取值"到站"不会出现：stopState 只可能是 普通、已过站、本站、未到站');
    expect(unknownValueProblem('本站', STOP_STATES, 'text', 'stopState')).toBeUndefined();
    expect(unknownValueProblem('第一', undefined, 'number', 'currentIndex')).toBe('取值"第一"不会出现：currentIndex 是数值，取值要写成数字');
    expect(normalizeValue(' 1.50 ', 'number')).toBe('1.5');
    expect(staticCodes(stop)).not.toContain('template.unknownStateValue');
    expect(staticCodes(writeOverride(stop, NAME, '到站', ['fontSize'], 12))).toContain('template.unknownStateValue');
    // 换依据：原来的覆盖对不上布尔的取值，引擎同样报。
    const switched = setStateBy(stop, NAME, 'hasLandmark');
    expect(stateChips(at(switched, NAME), { known: knownValues(switched, [], 'hasLandmark')! }).filter((chip) => chip.problem).map((chip) => chip.value)).toEqual(['已过站', '本站']);
    expect(staticCodes(switched)).toContain('template.unknownStateValue');
  });

  it('取值按钮：全部取值加已写的覆盖与正在编辑的；带当前样例的命中数与第一处', () => {
    const instances = [{ path: 'a[0]', state: '已过站' }, { path: 'a[1]', state: '本站' }, { path: 'a[2]', state: '未到站' }, { path: 'a[3]', state: '未到站' }];
    const chips = stateChips(at(stop, NAME), { known: STOP_STATES, instances });
    expect(chips.map((chip) => [chip.value, chip.covered, chip.count, chip.first ?? null])).toEqual([
      ['普通', false, 0, null], ['已过站', true, 1, 'a[0]'], ['本站', true, 1, 'a[1]'], ['未到站', false, 2, 'a[2]'],
    ]);
    // 推不出取值时：已写的覆盖加正在编辑的；数值依据下不是数字的写明问题。
    const numbered = setStateBy(stop, NAME, 'currentIndex');
    const loose = stateChips(at(numbered, NAME), { type: 'number', current: '3' });
    expect(loose.map((chip) => chip.value)).toEqual(['已过站', '本站', '3']);
    expect(loose[0]!.problem).toContain('取值要写成数字');
    expect(loose[2]!.problem).toBeUndefined();
    expect(loose[0]!.count).toBeUndefined();
  });
});

describe('写进覆盖', () => {
  it('值格的编辑写进这个取值；自身属性不动', () => {
    const next = valid(writeOverride(stop, NAME, '本站', ['fontSize'], 12));
    expect(casesOf(next, NAME)['本站']).toEqual({ color: { var: 'currentTextColor' }, fontSize: 12 });
    expect(at(next, NAME)['fontSize']).toEqual({ var: 'stopNameSize' });
    expect(mergedElement(at(next, NAME), '本站')['fontSize']).toBe(12);
    expect(overriddenKeys(at(next, NAME), '本站')).toEqual(['color', 'fontSize']);
  });

  it('改嵌套的一格：合并后的整项搬进覆盖', () => {
    const next = valid(writeOverride(stop, NAME, '未到站', ['place', 'width'], { fixed: 10 }));
    expect(casesOf(next, NAME)['未到站']).toEqual({ place: { width: { fixed: 10 }, height: 'fill' } });
    expect(at(next, NAME)['place']).toEqual({ width: 'hug', height: 'fill' });
    // 已经覆盖了 place 的取值：从覆盖里的值接着改。
    const again = valid(writeOverride(next, NAME, '未到站', ['place', 'height'], { fixed: 30 }));
    expect(casesOf(again, NAME)['未到站']).toEqual({ place: { width: { fixed: 10 }, height: { fixed: 30 } } });
  });

  it('改回和自身属性一样就去掉这一项；取值下没有覆盖了就去掉这个取值；重置同理', () => {
    const back = valid(writeOverride(stop, NAME, '本站', ['color'], { var: 'nameColor' }));
    expect(Object.keys(casesOf(back, NAME))).toEqual(['已过站']);
    const reset = valid(resetOverride(stop, NAME, '已过站', 'color'));
    expect(Object.keys(casesOf(reset, NAME))).toEqual(['本站']);
  });

  it('名称、类型、子元素、模板不能覆盖：不写', () => {
    expect(stateOverridable(stop, NAME)).not.toContain('name');
    expect(stateOverridable(stop, NAME)).toContain('content');
    expect(writeOverride(stop, NAME, '本站', ['name'], '站名二')).toBe(stop);
    expect(stateOverridable(stop, '站点')).toEqual([]);
  });

  it('提成参数：新参数留在文档里，绑定写进覆盖', () => {
    const merged = mergedDocument(stop, NAME, '本站');
    const extracted = extractParameter(merged, NAME, ['fontSize'], { name: 'currentNameSize', displayName: '本站字号', type: 'number', value: 12 });
    const next = valid(carryOverride(stop, NAME, '本站', extracted, ['fontSize']));
    expect((next['parameters'] as JsonObject[]).map((parameter) => parameter['name'])).toContain('currentNameSize');
    expect(casesOf(next, NAME)['本站']).toMatchObject({ fontSize: { var: 'currentNameSize' } });
    expect(at(next, NAME)['fontSize']).toEqual({ var: 'stopNameSize' });
  });
});

describe('选依据与表单', () => {
  it('没有状态样式的元素：选了依据就有空的覆盖表；去掉依据就整个去掉', () => {
    const chosen = valid(setStateBy(stop, MARKS, 'stopState'));
    expect(at(chosen, MARKS)['states']).toEqual({ by: { var: 'stopState' }, cases: {} });
    const hidden = valid(writeOverride(chosen, MARKS, '已过站', ['visible'], false));
    expect(casesOf(hidden, MARKS)).toEqual({ 已过站: { visible: false } });
    // 换依据：覆盖留着。
    expect(statesOf(at(setStateBy(hidden, MARKS, 'hasLandmark'), MARKS))).toEqual({ by: 'hasLandmark', cases: { 已过站: { visible: false } } });
    expect(at(setStateBy(hidden, MARKS, undefined), MARKS)).not.toHaveProperty('states');
  });

  it('循环的表单写回整个元素：变了的、能覆盖的项进覆盖，模板这类不能覆盖的丢掉', () => {
    const chosen = setStateBy(stop, MARKS, 'stopState');
    const merged = mergedElement(at(chosen, MARKS), '本站');
    const next = valid(writeElementOverride(chosen, MARKS, '本站', { ...merged, itemLayout: { ...(merged['itemLayout'] as JsonObject), gap: 2 }, template: '别的模板' }));
    expect(Object.keys(casesOf(next, MARKS)['本站']!)).toEqual(['itemLayout']);
    expect(at(next, MARKS)['template']).toBe(at(stop, MARKS)['template']);
  });
});
