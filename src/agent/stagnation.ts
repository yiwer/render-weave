/** 只有已交付检查、完成的候选写入和下一完整检查才能组成修复机会。 */
import { relative, resolve, sep } from 'node:path';
import { readCheckpoint, type CheckpointCheck, type CheckpointView } from './checkpoints.js';
import { approvedObservations, compareCandidates, type ComparisonBasis } from './candidate-comparison.js';
import { canonical } from './diff.js';

export interface RepairEvidence { readonly toolCallId: string; readonly path: string }
interface FeedbackEvidence {
  readonly checkToolCallId: string; readonly reportId?: string;
  readonly pages: readonly { readonly toolCallId: string; readonly offset: number; readonly nextOffset: number | null }[];
}
export interface StagnationCycle {
  readonly before: string; readonly after: string; readonly beforeIdentity: string; readonly afterIdentity: string;
  readonly repairs: readonly RepairEvidence[]; readonly required: readonly string[];
  readonly feedback: { readonly before: FeedbackEvidence; readonly after: FeedbackEvidence };
}
export interface StagnationStop {
  readonly reason: 'stagnation'; readonly threshold: number; readonly basis: ComparisonBasis;
  readonly cycles: readonly StagnationCycle[];
  readonly continuedBy: RepairEvidence & { readonly after: string };
}
interface Call { name: string; input: Record<string, unknown>; after?: string; overlappingWrite?: boolean }
interface PendingReport { checkpoint: CheckpointView; evidence: FeedbackEvidence; total: number; next: number; groupBy?: string }
export const DEFAULT_STAGNATION_THRESHOLD = 2;
export function stagnationController(options: { roundDir: string; agentDir: string; threshold: number; stop(reason: StagnationStop): void }) {
  const calls = new Map<string, Call>(), completedChecks = new Set<string>();
  let previous: CheckpointView | undefined, repairs: RepairEvidence[] = [], cycles: StagnationCycle[] = [];
  let pending: Promise<void> = Promise.resolve();
  let submitted = false, stopped = false;
  let report: PendingReport | undefined, previousFeedback: FeedbackEvidence | undefined;
  const reset = () => { previous = undefined; repairs = []; cycles = []; report = undefined; previousFeedback = undefined; };
  const delivered = (checkpoint: CheckpointView, feedback: FeedbackEvidence) => {
    repairs = repairs.filter(repair => previous?.files[`agent/${repair.path}`] || checkpoint.files[`agent/${repair.path}`]);
    // 已检查字节改变却没有完整写入事件，旧周期已断裂；不能把观测缺失当作无进展。
    if (previous && !repairs.length && previous.contentIdentity !== checkpoint.contentIdentity) cycles = [];
    const required = requiredProblems(checkpoint);
    if (previous && previousFeedback && requiredProblems(previous).length && repairs.length && required.length) {
      const comparison = compareCandidates(previous, checkpoint);
      const before = approvedObservations(previous), after = approvedObservations(checkpoint);
      const sameBasis = previous.comparisonBasis && checkpoint.comparisonBasis && canonical(previous.comparisonBasis) === canonical(checkpoint.comparisonBasis);
      const progress = requiredProblems(previous).some(problem => !required.includes(problem)) || comparison.improved.some(change =>
        change.dimension !== 'coverage.anomaly' || JSON.parse(change.item).level === 'severe');
      if (!sameBasis || progress || [...after.unknown].some(value => !before.unknown.has(value))) cycles = [];
      else cycles.push({ before: previous.id, after: checkpoint.id, beforeIdentity: previous.contentIdentity, afterIdentity: checkpoint.contentIdentity,
        repairs, required, feedback: { before: previousFeedback, after: feedback } });
    } else if (!required.length || (previous && canonical(previous.comparisonBasis) !== canonical(checkpoint.comparisonBasis))) cycles = [];
    previous = checkpoint; previousFeedback = feedback; repairs = []; report = undefined;
  };
  const accept = async (event: Record<string, any>) => {
    if (!Array.isArray(event.message?.content)) return;
    for (const block of event.message.content) {
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        if (calls.has(block.id)) { reset(); continue; }
        if (report && ['Write', 'Edit', 'mcp__rw__check_outcome'].includes(block.name)) reset();
        if (['Write', 'Edit'].includes(block.name)) for (const call of calls.values()) if (call.name === 'mcp__rw__check_outcome') call.overlappingWrite = true;
        calls.set(block.id, { name: block.name, input: block.input ?? {}, after: previous?.id,
          overlappingWrite: block.name === 'mcp__rw__check_outcome' && [...calls.values()].some(call => ['Write', 'Edit'].includes(call.name)) });
      }
      if (event.type !== 'user' || block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
      if (!call || block.is_error) continue;
      if (call.name === 'mcp__rw__outcome_feedback' && report) {
        const page = resultObject(block.content, 'reportId');
        const count = Array.isArray(page?.groups) ? page.groups.reduce((sum: number, group: any) => sum + (Array.isArray(group.items) ? group.items.length : 0), 0) : 0;
        const next = report.next + count, end = next === report.total;
        if (!page || call.input.reportId !== report.evidence.reportId || page.reportId !== report.evidence.reportId
          || page.contentIdentity !== report.checkpoint.contentIdentity || page.currentBytesChecked !== false || page.total !== report.total
          || page.offset !== report.next || Number(call.input.offset ?? 0) !== report.next || !count
          || page.groupBy !== (call.input.groupBy ?? 'code') || (report.groupBy && page.groupBy !== report.groupBy)
          || page.nextOffset !== (end ? null : next) || page.truncated !== !end) { reset(); continue; }
        report.evidence = { ...report.evidence, pages: [...report.evidence.pages, { toolCallId: block.tool_use_id, offset: page.offset, nextOffset: page.nextOffset }] };
        report.next = next; report.groupBy = page.groupBy;
        if (end) delivered(report.checkpoint, report.evidence);
        continue;
      }
      if (['Write', 'Edit'].includes(call.name) && call.after === previous?.id && previous && typeof call.input.file_path === 'string') {
        const path = relative(options.agentDir, resolve(options.agentDir, call.input.file_path)).split(sep).join('/');
        if (path.startsWith('candidates/') && !path.split('/').includes('..') && path.endsWith('.json')) {
          const repair = { toolCallId: block.tool_use_id, path };
          repairs.push(repair);
          // 最后的自检可以直接交回；只有已完成下一次候选写入才证明仍在循环。
          if (!submitted && !stopped && cycles.length >= options.threshold && previous.comparisonBasis && previous.files[`agent/${path}`]
            && ![...calls.values()].some(active => ['Write', 'Edit'].includes(active.name))) {
            stopped = true;
            options.stop({ reason: 'stagnation', threshold: options.threshold, basis: previous.comparisonBasis, cycles, continuedBy: { ...repair, after: previous.id } });
          }
        }
      }
      if (call.name !== 'mcp__rw__check_outcome') continue;
      if (call.overlappingWrite) { reset(); continue; }
      const value = resultObject(block.content, 'checkpoint');
      if (value?.checkpoint?.status !== 'saved' || !completedChecks.delete(value.checkpoint.id)) { reset(); continue; }
      const { checkpoint } = await readCheckpoint(options.roundDir, value.checkpoint.id);
      if (!checkpoint || checkpoint.contentIdentity !== value.checkpoint.contentIdentity) { reset(); continue; }
      const evidence: FeedbackEvidence = { checkToolCallId: block.tool_use_id, ...(typeof value.feedback?.reportId === 'string' ? { reportId: value.feedback.reportId } : {}), pages: [] };
      if (truncated(value)) {
        if (!evidence.reportId || !Number.isSafeInteger(value.feedback?.total) || value.feedback.total < 1) { reset(); continue; }
        report = { checkpoint, evidence, total: value.feedback.total, next: 0 };
      } else delivered(checkpoint, evidence);
    }
  };
  return {
    checked(value: CheckpointCheck) { if (value.checkpoint.status === 'saved') completedChecks.add(value.checkpoint.id); },
    accept(event: Record<string, any>) {
      // result 是执行器的交回边界；已排队的异步读取不能在交回后新作停止决定。
      if (event.type === 'result') submitted = true;
      pending = pending.then(() => accept(event)).catch(() => reset());
    },
    async idle() { await pending; },
  };
}
function resultObject(content: any, key: string): any {
  const texts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((item: any) => item.type === 'text' ? [item.text] : []) : [];
  for (const text of texts) { try { const value = JSON.parse(text); if (value?.[key]) return value; } catch { /* 未收到完整结果不能证明机会。 */ } }
}
function requiredProblems(record: CheckpointView): string[] {
  const check = record.check;
  const technical = [...check.problems, ...check.candidates.flatMap(candidate => candidate.problems),
    ...(check.assessment.render.blocking ? check.assessment.render.problems : [])]
    .filter(problem => problem.level === 'severe').map(problem => `technical:${canonical({ code: problem.code, location: problem.location })}`);
  const missing = check.coverageVerification?.status !== 'notChecked'
    ? check.coverageVerification?.missingItems.map(item => `coverage.missing:${item}`) ?? [] : [];
  const style = [...approvedObservations(record).metrics.values()].filter(metric => metric.dimension.startsWith('style.') && metric.value > 0)
    .map(metric => `${metric.dimension}:${metric.item}`);
  return [...new Set([...technical, ...missing, ...style])].sort();
}
function truncated(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Object.entries(value).some(([key, flag]) => /truncated$/i.test(key) && !!flag)) return true;
  return Object.values(value).some(truncated);
}
