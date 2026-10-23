/** 仅供受控实验：人工登记的参考区域，不推断候选父节点就是错误根因。 */
import type { RepairCheck } from './repair-feedback.js';
export const REPAIR_REGIONS: Readonly<Record<string, string>> = {
  badges: 'station-panel', stations: 'station-panel',
  'next-stop': 'next-stop-panel', 'next-landmark': 'next-stop-panel',
};

/** 全部预登记检查都已测量且通过才允许停止；技术 qualified 不能代替视觉检查。 */
export function repairStopDecision(expectedIds: readonly string[], checks: readonly RepairCheck[] | null, qualified: boolean) {
  const actual = new Map(checks?.map(c => [c.id, c]));
  const missing = expectedIds.filter(id => !actual.has(id));
  const failed = checks?.filter(c => c.pass !== true || c.status !== undefined && c.status !== 'measured').map(c => c.id) ?? [];
  const unexpected = checks?.filter(c => !expectedIds.includes(c.id)).map(c => c.id) ?? [];
  const complete = expectedIds.length > 0 && new Set(expectedIds).size === expectedIds.length &&
    checks !== null && actual.size === checks.length && missing.length === 0 && unexpected.length === 0;
  return { stop: qualified && complete && failed.length === 0, qualified, complete, missing, failed, unexpected,
    scope: '仅表示预登记的布局检查与绑定回归通过；不证明最终墨迹可见或人工视觉认可。' };
}
