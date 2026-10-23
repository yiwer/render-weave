/** 实验评分与有界反馈：不进入生产 MCP，不依据候选自述评价修复。 */
import type { FidelityMeasurement, RoleMeasurement } from './fidelity.js';

export interface RepairCheck { id: string; pass: boolean; role: string; dimension: 'content' | 'font' | 'position'; severity: number; detail: string; path?: string }
export const REPAIR_THRESHOLDS = { fontLog: Math.log(1.1), center: 0.005 } as const;
const complete = (r: RoleMeasurement) => r.matched === r.expected && !r.unexpected.length && !r.unassignedText.length && !(r.inversionRate && r.inversionRate > 0);
export function repairChecks(actual: FidelityMeasurement, reference: FidelityMeasurement, geometry = true): RepairCheck[] {
  const checks: RepairCheck[] = [{ id: 'route-number:content', role: 'route-number', dimension: 'content', pass: actual.routeNumber === true, severity: 1, detail: '参考线路号未匹配' }];
  for (const ref of reference.roles) {
    const role = actual.roles.find((r) => r.id === ref.id);
    checks.push({ id: ref.id + ':content', role: ref.id, dimension: 'content', pass: !!role && complete(role), severity: role ? Math.abs(role.expected - role.matched) + role.unexpected.length + role.unassignedText.length + (role.inversionRate ?? 0) : 1,
      detail: role ? `匹配 ${role.matched}/${role.expected}；未匹配 ${role.missingOrUnmatched.join('、') || '无'}；额外 ${role.unexpected.join('、') || '无'}；逆序比例 ${role.inversionRate ?? '不适用'}` : '没有布局证据',
      ...(role?.matches.find(Boolean)?.path ? { path: role.matches.find(Boolean)!.path } : {}) });
    if (!geometry || !ref.expected) continue;
    const available = !!role && role.geometry?.compared === ref.matched && ref.matched === ref.expected;
    const first = role?.matches.findIndex((m, i) => m !== null && ref.matches[i] != null) ?? -1;
    const center = (box: { x: number; y: number; width: number; height: number }) => [box.x + box.width / 2, box.y + box.height / 2].map((v) => Number(v.toFixed(5)));
    const location = first >= 0 ? `；首个匹配中心 ${JSON.stringify(center(role!.matches[first]!.box))}，参考 ${JSON.stringify(center(ref.matches[first]!.box))}` : '';
    if (ref.fontSizeMm) checks.push({ id: ref.id + ':font', role: ref.id, dimension: 'font', pass: available && role.geometry!.meanFontLogError !== null && role.geometry!.meanFontLogError <= REPAIR_THRESHOLDS.fontLog,
      severity: role?.geometry?.meanFontLogError ?? 1, detail: `字号中位数 ${role?.fontSizeMm?.median ?? '未知'} mm，参考 ${ref.fontSizeMm.median} mm；平均字号对数偏差 ${role?.geometry?.meanFontLogError ?? '未知'}`,
      ...(role?.matches.find(Boolean)?.path ? { path: role.matches.find(Boolean)!.path } : {}) });
    checks.push({ id: ref.id + ':position', role: ref.id, dimension: 'position', pass: available && role.geometry!.meanCenterError <= REPAIR_THRESHOLDS.center,
      severity: role?.geometry?.meanCenterError ?? 1, detail: `平均中心偏差 ${role?.geometry?.meanCenterError ?? '未知'}（分别按画板宽、高归一化；目标 ≤ ${REPAIR_THRESHOLDS.center}）${location}`,
      ...(first >= 0 ? { path: role!.matches[first]!.path } : {}) });
  }
  return checks;
}
/** 没有匹配实例时只提供角色和缺失值，不编造缺失元素的路径。 */
export function boundedRepairFeedback(checks: readonly RepairCheck[], groups: Readonly<Record<string, string>> = {}): string {
  const priority = { content: 0, font: 1, position: 2 };
  const failures = checks.filter((c) => !c.pass).toSorted((a, b) => priority[a.dimension] - priority[b.dimension] || b.severity - a.severity || a.id.localeCompare(b.id));
  const selected: RepairCheck[] = [];
  for (const check of failures) {
    if (!selected.some((c) => (groups[c.role] ?? c.role) === (groups[check.role] ?? check.role))) selected.push(check);
    if (selected.length === 2) break;
  }
  const items = selected.map((c) => ({ role: c.role, dimension: c.dimension, difference: c.detail.slice(0, 260), path: c.path?.slice(0, 180) ?? null }));
  const text = '宿主元素测量（仅覆盖布局证据；最多两项，未列出不表示没有问题）：\n' + JSON.stringify(items) + '\n参照示例图决定局部修改，不改变数据绑定；最终可见性仍需看图。';
  if (text.length > 1200) throw new Error('反馈超过预算');
  return text;
}
export function repairDelta(initial: readonly RepairCheck[], final: readonly RepairCheck[] | null, targets: readonly string[], qualified: boolean) {
  const byId = new Map(final?.map((c) => [c.id, c]));
  const repaired = targets.filter((id) => byId.get(id)?.pass);
  const added = final ? initial.filter((c) => c.pass && byId.get(c.id)?.pass !== true).map((c) => c.id) : null;
  return { targetCount: targets.length, repaired, addedFailures: added, cleanSuccess: qualified && repaired.length === targets.length && added?.length === 0 };
}
