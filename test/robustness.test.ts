import { describe, expect, it } from 'vitest';
import { ProblemCodes, render } from '../src/index.js';
import { greetingRequest, loadSingleText, withTemplate } from './support/fixtures.js';

describe('模板异常输入通过问题清单报告', () => {
  it.each(['constructor', 'toString', '__proto__'])('原型名称 %s 不能充当运算或元素类型', async (name) => {
    const source = await loadSingleText();
    for (const mode of ['draft', 'final']) {
      for (const target of ['operation', 'element']) {
        const workspace = withTemplate(source, '问候牌', (document) => {
          if (target === 'operation') document.derived = [{ name: 'bad', displayName: '错误运算', type: 'number', op: name }];
          else document.artboard.children = [{ name: '错误元素', type: name }];
        });
        const result = await render(workspace, greetingRequest({ mode }));
        expect(result.image).toBeUndefined();
        expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.templateInvalid, level: 'severe' }));
      }
    }
  });

  it.each(['constructor', 'toString', '__proto__'])('名称为 %s 的必填参数不能被原型属性冒充', async (name) => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document.parameters = [{ name, displayName: '必填参数', visibility: 'public', type: 'text' }];
    });
    const result = await render(workspace, greetingRequest());
    expect(result.image).toBeUndefined();
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.parameterMissing, location: { kind: 'parameter', name } }));
  });

  it.each([
    ['date', '2026-02-31'],
    ['datetime', '2026-02-31 12:00:00'],
  ])('派生变量的 %s 固定值也必须是真实日历日期', async (type, value) => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document.derived = [{ name: 'day', displayName: '日期', type, op: 'branch', branches: [{ when: { op: 'eq', left: { value: true }, right: { value: true } }, then: { value } }], otherwise: { value } }];
    });
    const result = await render(workspace, greetingRequest());
    expect(result.image).toBeUndefined();
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.templateTypeMismatch, level: 'severe' }));
  });

  it.each([[1e308, 1e308], [1, 1e-17]])('派生加法 %s + %s 不可表示时报告问题，链式运算安全取缺值', async (left, right) => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document.derived = [
        { name: 'sum', displayName: '合计', type: 'number', op: 'add', left: { value: left }, right: { value: right } },
        { name: 'next', displayName: '后续合计', type: 'number', op: 'add', left: { var: 'sum' }, right: { value: 1 } },
      ];
      document.artboard.children[0].content = [{ slot: 'next' }];
    });
    const final = await render(workspace, greetingRequest());
    const draft = await render(workspace, greetingRequest({ mode: 'draft' }));
    expect(final.image === undefined).toBe(true);
    expect(draft.image !== undefined).toBe(true);
    expect(final.problems).toEqual(draft.problems);
    expect(final.problems).toEqual([expect.objectContaining({ code: ProblemCodes.templateEvaluationInvalid,
      location: { kind: 'variable', template: '问候牌', name: 'sum' } })]);
    expect(draft.layout!.root.children![0]!.text!.content).toBe('〔后续合计〕');
  });

  it.each(['row', 'column', 'rowSpan', 'columnSpan'])('动态网格 %s 越界时隐藏元素，摘要不产生 NaN', async (key) => {
    const workspace = withTemplate(await loadSingleText(), '问候牌', (document) => {
      document.parameters = [{ name: 'position', displayName: '位置', type: 'number', visibility: 'public', default: 2 }];
      document.artboard.layout = { mode: 'grid', rows: [{ fraction: 1 }], columns: [{ fraction: 1 }] };
      document.artboard.children = [{ type: 'rect', name: '越界', fill: '#FF0000', place: { row: 1, column: 1, [key]: { var: 'position' } } }];
    });
    const final = await render(workspace, greetingRequest());
    const draft = await render(workspace, greetingRequest({ mode: 'draft' }));
    expect(final.image === undefined).toBe(true);
    expect(draft.image !== undefined).toBe(true);
    expect(final.problems).toEqual(draft.problems);
    expect(draft.layout!.root.children![0]).toMatchObject({ visible: false, width: 0, height: 0 });
    const visit = (value: unknown): void => {
      if (typeof value === 'number') expect(Number.isFinite(value)).toBe(true);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    visit(draft.layout);
  });

  it('同一子模板的运算错误定位到异常调用，正常调用仍显示结果', async () => {
    const source = await loadSingleText();
    const child = structuredClone(source.templates[0]!.document) as Record<string, any>;
    child.name = '求和';
    child.parameters = [{ name: 'x', displayName: '输入', type: 'number', visibility: 'public' }];
    child.derived = [{ name: 'sum', displayName: '合计', type: 'number', op: 'add', left: { var: 'x' }, right: { value: 1e308 } }];
    child.artboard.sizeRange = { width: { min: 1, max: 160 }, height: { min: 1, max: 40 } };
    child.artboard.children[0].content = [{ slot: 'sum' }];
    const parent = withTemplate(source, '问候牌', (document) => {
      document.artboard.children = ['异常', '正常'].map((name, index) => ({ type: 'call', name, template: '求和', data: 'current',
        args: { x: { value: index === 0 ? 1e308 : -1e308 } },
        place: { left: index * 80, top: 0, width: { fixed: 80 }, height: { fixed: 40 } } }));
    });
    const workspace = { ...parent, templates: [...parent.templates, { name: '求和', document: child }] };
    const final = await render(workspace, greetingRequest());
    const draft = await render(workspace, greetingRequest({ mode: 'draft' }));
    expect(final.image === undefined).toBe(true);
    expect(draft.image !== undefined).toBe(true);
    expect(final.problems).toEqual(draft.problems);
    expect(final.problems).toEqual([expect.objectContaining({ code: ProblemCodes.templateEvaluationInvalid,
      location: { kind: 'variable', template: '求和', name: 'sum', path: '问候牌/异常' } })]);
    expect(draft.layout!.root.children!.map((call) => call.children![0]!.text!.content)).toEqual(['〔合计〕', '0']);
  });
});
