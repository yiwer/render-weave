import { describe, expect, it } from 'vitest';
import { boundedRepairFeedback, type RepairCheck } from '../scripts/agent-eval/repair-feedback.js';
import { REPAIR_REGIONS, repairStopDecision } from '../scripts/agent-eval/repair-policy.js';
const check = (role: string, severity = 1, pass = false): RepairCheck => ({ id: role + ':position', role, dimension: 'position', pass, severity, detail: '差异' });
const items = (text: string) => JSON.parse(text.split('\n')[1]!) as { role: string }[];
describe('区域反馈与全检查停止', () => {
  it('同样两项预算覆盖两个区域，未登记角色仍各自独立', () => {
    const checks = [check('badges', 4), check('stations', 3), check('next-landmark', 2), check('next-stop', 1)];
    expect(items(boundedRepairFeedback(checks)).map(c => c.role)).toEqual(['badges', 'stations']);
    expect(items(boundedRepairFeedback(checks, REPAIR_REGIONS)).map(c => c.role)).toEqual(['badges', 'next-landmark']);
    expect(items(boundedRepairFeedback([check('x'), check('y')], REPAIR_REGIONS))).toHaveLength(2);
  });
  it('仍优先内容再字号再位置，不让区域选择颠倒优先级', () => {
    const checks = [check('stations', 9), { ...check('badges'), dimension: 'content' as const }, { ...check('operator'), dimension: 'font' as const }];
    expect(items(boundedRepairFeedback(checks, REPAIR_REGIONS)).map(c => c.role)).toEqual(['badges', 'operator']);
  });
  it('全部固定检查通过且技术交回有效才能停止', () => {
    const checks = [check('a', 0, true), check('b', 0, true)];
    const ids = checks.map(c => c.id);
    expect(repairStopDecision(ids, checks, true).stop).toBe(true);
    expect(repairStopDecision(ids, checks, false).stop).toBe(false);
    expect(repairStopDecision(ids, [checks[0]!, check('b')], true).stop).toBe(false);
  });
  it('未覆盖、未知、空清单、重复与额外项都不能误停', () => {
    const a = check('a', 0, true), b = check('b', 0, true);
    for (const actual of [null, [], [a], [a, a], [a, b, check('x', 0, true)]]) expect(repairStopDecision([a.id, b.id], actual, true).stop).toBe(false);
    expect(repairStopDecision([], [], true).stop).toBe(false);
    expect(repairStopDecision([a.id, a.id], [a], true).stop).toBe(false);
  });
});
