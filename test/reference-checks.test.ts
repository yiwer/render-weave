import { beforeAll, describe, expect, it } from 'vitest';
import { createLayoutReference, checkLayoutReference } from '../scripts/agent-eval/reference-checks.js';
import { repairStopDecision } from '../scripts/agent-eval/repair-policy.js';
import { loadWorkspace, render, type Workspace, type LayoutSummary } from '../src/index.js';
import { m402Dir, resourcesDir, withTemplate } from './support/fixtures.js';
let ws: Workspace, good: LayoutSummary;
const request = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 50, format: 'png' }, mode: 'final' };
const operator = '标准线路单边/顶栏/运营方';
const find = (n: any, name: string): any => n.name === name ? n : n.children?.map((c: any) => find(c, name)).find(Boolean);
beforeAll(async () => { ws = await loadWorkspace({ dir: m402Dir, resourcesDir }); good = (await render(ws, request)).layout!; });
describe('修正参考测量语义（公开真实渲染）', () => {
  it('完整正例全通过，100 DPI 不改变毫米判断', async () => {
    const ref = createLayoutReference(good, '受控参考');
    expect(checkLayoutReference(good, ref).every(c => c.pass)).toBe(true);
    const high = (await render(ws, { ...request, output: { ...request.output, dpi: 100 } })).layout!;
    expect(checkLayoutReference(high, ref).every(c => c.pass)).toBe(true);
  });
  it('混合片段中一个字号减小会失败，父字号保持8不能掩盖', async () => {
    const changed = withTemplate(ws, '标准线路单边', d => { find(d.artboard, '运营方').content = [{ text: '巴士', fontSize: 5 }, { text: '集团' }]; });
    const actual = (await render(changed, request)).layout!;
    expect(find(actual.root, '运营方').text.fontSize).toBe(8);
    const cs = checkLayoutReference(actual, createLayoutReference(good, '明确片段字号'));
    expect(cs.find(c => c.id === operator + ':content')?.pass).toBe(true);
    expect(cs.find(c => c.id === operator + ':font')).toMatchObject({ pass: false, status: 'measured' });
  });
  it('缺失元素、空画板、没有布局都不能通过；空参考不合法', async () => {
    const ref = createLayoutReference(good, '受控参考');
    const empty = (await render(withTemplate(ws, '标准线路单边', d => { d.artboard.children = []; }), request)).layout!;
    const cs = checkLayoutReference(empty, ref);
    expect(cs.find(c => c.id === operator + ':content')).toMatchObject({ pass: false, status: 'missing' });
    expect(cs.find(c => c.id === operator + ':content')).not.toHaveProperty('path');
    expect(repairStopDecision(checkLayoutReference(good, ref).map(c => c.id), cs, true).stop).toBe(false);
    expect(checkLayoutReference(undefined, ref).every(c => !c.pass)).toBe(true);
    expect(() => createLayoutReference(empty, '空参考')).toThrow();
  });
  it('参考框带留白不推字号；未核准片段字号返回未知', () => {
    const ref = createLayoutReference(good, '仅位置框'); const e = ref.elements.find(e => e.path === operator)!;
    e.box.width = 50; e.box.height = 20; delete e.characters;
    const check = checkLayoutReference(good, ref).find(c => c.id === operator + ':font')!;
    expect(check).toMatchObject({ pass: false, status: 'unknown' });
    expect(check.detail).toContain('不从框推字号');
  });
  it('墨迹框不与布局框直接比较；已核准布局位置偏移会检出', () => {
    const ref = createLayoutReference(good, '已核准位置'); const e = ref.elements.find(e => e.path === operator)!;
    e.boxKind = 'ink';
    expect(checkLayoutReference(good, ref).find(c => c.id === operator + ':position')).toMatchObject({ pass: false, status: 'unknown' });
    e.boxKind = 'layout'; e.box.x -= 100;
    expect(checkLayoutReference(good, ref).find(c => c.id === operator + ':position')).toMatchObject({ pass: false, status: 'measured' });
  });
  it('重复路径、额外文字、一个元素严重偏差不会靠平均通过', () => {
    const ref = createLayoutReference(good, '逐元素'); const changed = structuredClone(good);
    find(changed.root, '运营方').x -= 5;
    expect(checkLayoutReference(changed, ref).filter(c => !c.pass).map(c => c.id)).toContain(operator + ':position');
    const extra = structuredClone(find(changed.root, '运营方')); extra.path += '-extra';
    (changed.root.children as any[]).push(extra);
    expect(checkLayoutReference(changed, ref)[0]?.pass).toBe(false);
    extra.path = operator;
    expect(checkLayoutReference(changed, ref)[0]).toMatchObject({ pass: false, status: 'unknown' });
  });
  it('状态未知即使错误带pass=true也不能让停止条件通过', () => {
    const check = checkLayoutReference(good, createLayoutReference(good, '受控参考'))[0]!;
    expect(repairStopDecision([check.id], [{ ...check, pass: true, status: 'unknown' }], true).stop).toBe(false);
  });
});
