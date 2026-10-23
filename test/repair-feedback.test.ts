import { describe, expect, it } from 'vitest';
import { assessFidelity, type DisplayContract } from '../scripts/agent-eval/fidelity.js';
import { boundedRepairFeedback, repairChecks, repairDelta, type RepairCheck } from '../scripts/agent-eval/repair-feedback.js';
import type { LayoutNode, LayoutSummary } from '../src/index.js';

const contract: DisplayContract = { basis: '测试', routeNumber: { text: 'M402', region: { x: 0, y: 0, width: 1, height: 1 } },
  roles: [{ id: 'label', mode: 'text', expected: ['站名'], region: { x: 0, y: 0, width: 1, height: 1 } }] };
function layout(fontSize = 10, x = 0): LayoutSummary {
  const text = (content: string, at: number, size: number): LayoutNode => ({ path: content, name: content, type: 'text', visible: true, x: at, y: 0, width: 20, height: 20,
    text: { content, font: 'font', fontSize: size, writingMode: 'horizontal', width: 20, height: 20, spacing: 0, compression: 1, overflow: false,
      fragments: [{ text: content, font: 'font', fontSize: size, color: '#000000', slant: 0 }] } });
  return { template: 'fixture', output: { width: 100, height: 100, dpi: 50, widthPx: 197, heightPx: 197, format: 'png' },
    root: { path: 'root', name: 'root', type: 'artboard', visible: true, x: 0, y: 0, width: 100, height: 100,
      children: [text('站名', x, fontSize), text('M402', 30, 10)] } };
}
const check = (id: string, pass: boolean): RepairCheck => ({ id, pass, role: id.split(':')[0]!, dimension: 'content', severity: 1, detail: '差异' });
describe('受控修复评分', () => {
  it('正例所有检查通过；缩字与位置变化分别失败', () => {
    const ref = assessFidelity(layout(), contract);
    expect(repairChecks(assessFidelity(layout(), contract, ref), ref).every((c) => c.pass)).toBe(true);
    const changed = repairChecks(assessFidelity(layout(5, 2), contract, ref), ref);
    expect(changed.filter((c) => !c.pass).map((c) => c.id)).toEqual(['label:font', 'label:position']);
  });
  it('无布局不能利用缺少比较项通过', () => {
    const ref = assessFidelity(layout(), contract);
    expect(repairChecks(assessFidelity(undefined, contract), ref).every((c) => !c.pass)).toBe(true);
  });
  it('目标修好但原通过项退化，不记无副作用成功', () => {
    const delta = repairDelta([check('a', false), check('b', true)], [check('a', true), check('b', false)], ['a'], true);
    expect(delta).toEqual({ targetCount: 1, repaired: ['a'], addedFailures: ['b'], cleanSuccess: false });
  });
  it('无成果的新增项是未知；目标修复与合格交回分别记录', () => {
    expect(repairDelta([check('a', false)], null, ['a'], false).addedFailures).toBeNull();
    const delta = repairDelta([check('a', false)], [check('a', true)], ['a'], false);
    expect(delta.repaired).toEqual(['a']);
    expect(delta.cleanSuccess).toBe(false);
  });
  it('原通过项消失时，不能静默算成没有新增失败', () => {
    expect(repairDelta([check('a', true)], [], [], true).addedFailures).toEqual(['a']);
  });
  it('最多两项且每角色一项，缺失项不编造路径', () => {
    const feedback = boundedRepairFeedback([check('a:content', false), { ...check('a:font', false), dimension: 'font' }, check('b:content', false), check('c:content', false)]);
    const items = JSON.parse(feedback.split('\n')[1]!);
    expect(items.map((i: { role: string }) => i.role)).toEqual(['a', 'b']);
    expect(items[0].path).toBeNull();
    expect(feedback.length).toBeLessThanOrEqual(1200);
  });
  it('很长的差异和路径仍有界；通过项不会泄漏到反馈', () => {
    const feedback = boundedRepairFeedback([{ ...check('a:content', false), detail: '长'.repeat(5000), path: '路'.repeat(3000) }, check('b:content', true)]);
    expect(feedback.length).toBeLessThanOrEqual(1200);
    expect(JSON.parse(feedback.split('\n')[1]!)).toHaveLength(1);
  });
});
