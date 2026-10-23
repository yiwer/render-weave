import { describe, expect, it } from 'vitest';
import type { LayoutNode, LayoutSummary } from '../src/index.js';
import { assessFidelity, type DisplayContract } from '../scripts/agent-eval/fidelity.js';

const region = { x: 0, y: 0, width: 1, height: 1 };
const text = (content: string, x: number, visible = true): LayoutNode => ({
  path: `/${content}/${x}`, name: content, type: 'text', x, y: 0, width: 5, height: 10, visible,
  text: { content, font: 'font', writingMode: 'horizontal', fontSize: 5, width: 5, height: 10,
    spacing: 0, compression: 1, overflow: false,
    fragments: [{ text: content, font: 'font', fontSize: 5, color: '#000000', slant: 0 }] },
});
const layout = (children: LayoutNode[]): LayoutSummary => ({
  template: 'fixture', output: { width: 100, height: 100, dpi: 100, widthPx: 394, heightPx: 394, format: 'png' },
  root: { path: '/', name: 'root', type: 'artboard', x: 0, y: 0, width: 100, height: 100, visible: true, children },
});
const contract = (expected = ['甲', '乙']): DisplayContract => ({ basis: '测试显示契约', routeNumber: { text: 'M402', region },
  roles: [{ id: 'stops', expected, region, mode: 'text', ordered: true }] });

describe('离线还原评判公开入口', () => {
  it('没有布局证据时返回未知', () => {
    expect(assessFidelity(undefined, contract()).content).toBe('unknown');
  });
  it('重名站点按出现次数核对，静态标签不充当第二个站点', () => {
    const result = assessFidelity(layout([text('M402', 0), text('甲', 10), text('说明甲', 20)]), contract(['甲', '甲']));
    expect(result.roles[0]).toMatchObject({ matched: 1, missingOrUnmatched: ['甲'] });
    expect(result.content).toBe('mismatch');
  });
  it('内容齐全仍可发现倒序；隐藏节点不计入匹配', () => {
    const result = assessFidelity(layout([text('M402', 0), text('乙', 10), text('甲', 20), text('甲', 30, false)]), contract());
    expect(result.roles[0]).toMatchObject({ matched: 2, inversionRate: 1, unexpected: [] });
    expect(result.diagnostics.map((d) => d.code)).toContain('content.order');
  });
  it('包含匹配优先较长名称，避免建设路总站被当成建设路', () => {
    const c: DisplayContract = { ...contract(), roles: [{ id: 'next', region, mode: 'contains', expected: ['建设路'], vocabulary: ['建设路', '建设路总站'] }] };
    const result = assessFidelity(layout([text('M402', 0), text('下一站：建设路总站', 20)]), c);
    expect(result.roles[0]).toMatchObject({ matched: 0, unexpected: ['建设路总站'] });
  });
  it('合法时间的补零和全角写法等价，错误时间不蒙混过关', () => {
    const c: DisplayContract = { ...contract(), roles: [{ id: 'times', region, mode: 'time', expected: ['07:30', '22:30'] }] };
    expect(assessFidelity(layout([text('M402', 0), text('７：３０—22:30', 20)]), c).content).toBe('matched');
    expect(assessFidelity(layout([text('M402', 0), text('27:30—22:30', 20)]), c).roles[0]?.matched).toBe(1);
  });
  it('重复词表不复制文本实例，同一个节点内的独立重复会计数', () => {
    const c: DisplayContract = { ...contract(), roles: [{ id: 'next', region, mode: 'contains', expected: ['甲', '甲'], vocabulary: ['甲', '甲'] }] };
    expect(assessFidelity(layout([text('M402', 0), text('下一站甲', 20)]), c).roles[0]?.matched).toBe(1);
    expect(assessFidelity(layout([text('M402', 0), text('甲 / 甲', 20)]), c).roles[0]?.matched).toBe(2);
    const one = { ...c, roles: [{ ...c.roles[0]!, expected: ['甲'] }] };
    expect(assessFidelity(layout([text('M402', 0), text('下一站甲', 20)]), one).content).toBe('matched');
  });
  it('独占标签区域的陌生文字保留证据并标成未知', () => {
    const c: DisplayContract = { ...contract(), roles: [{ ...contract().roles[0]!, region: { x: 0.1, y: 0, width: 0.9, height: 1 }, exclusiveText: true }] };
    const result = assessFidelity(layout([text('M402', 0), text('甲', 10), text('乙', 20), text('虚构站', 30)]), c);
    expect(result.roles[0]?.matched).toBe(2);
    expect(result.roles[0]?.unassignedText.map((e) => e.value)).toEqual(['虚构站']);
    expect(result.content).toBe('unknown');
  });
  it('线路号要求完整编号，且匹配只证明有限布局证据', () => {
    expect(assessFidelity(layout([text('XM4029', 0)]), contract([])).routeNumber).toBe(false);
    const result = assessFidelity(layout([text('线路M402', 0)]), contract([]));
    expect(result.content).toBe('matched');
    expect(result.scope).toBe('layout-evidence-only');
    expect(result.unknown.join(' ')).toContain('遮挡');
  });
  it('没有参考布局不提供结构分数；参考存在时偏移可定位到角色', () => {
    const first = assessFidelity(layout([text('M402', 0), text('甲', 10), text('乙', 20)]), contract());
    const moved = assessFidelity(layout([text('M402', 0), text('甲', 20), text('乙', 30)]), contract(), first);
    expect(first.roles[0]?.geometry).toBeNull();
    expect(moved.roles[0]?.geometry?.meanCenterError).toBeCloseTo(0.1);
    expect(moved.content).toBe('matched');
  });
  it('独特业务内容跨越粗分区仍可匹配，不把位置变化误报缺失', () => {
    const c: DisplayContract = { ...contract(), roles: [{ id: 'times', region: { x: 0, y: 0.8, width: 1, height: 0.2 }, mode: 'time', expected: ['07:30'] }] };
    expect(assessFidelity(layout([text('M402', 0), text('07:30', 20)]), c).content).toBe('matched');
  });
  it('相同站名和路名一对一归属，位置变化不生成多余站名', () => {
    const c: DisplayContract = { ...contract(), roles: [
      { id: 'stops', region: { x: 0, y: 0.2, width: 1, height: 0.5 }, mode: 'text', expected: ['建设路'], exclusiveText: true },
      { id: 'roads', region: { x: 0, y: 0.8, width: 1, height: 0.1 }, mode: 'text', expected: ['建设路'], exclusiveText: true },
    ] };
    const result = assessFidelity(layout([text('M402', 0), { ...text('建设路', 10), y: 35 }, { ...text('建设路', 10), y: 65 }]), c);
    expect(result.content).toBe('matched');
    expect(result.roles.map((r) => [r.matched, r.unexpected.length])).toEqual([[1, 0], [1, 0]]);
  });
});
