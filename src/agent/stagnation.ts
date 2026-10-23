/** 只有已交付检查、完成的候选写入和下一完整检查才能组成修复机会。 */
import { relative, resolve, sep } from 'node:path';
import { readCheckpoint, type CheckpointCheck, type CheckpointView } from './checkpoints.js';
import { compareCandidates, type ComparisonBasis } from './candidate-comparison.js';
import { canonical } from './diff.js';

export interface RepairEvidence { readonly toolCallId: string; readonly path: string }
export interface StagnationCycle {
  readonly before: string; readonly after: string; readonly beforeIdentity: string; readonly afterIdentity: string;
  readonly repairs: readonly RepairEvidence[]; readonly required: readonly string[];
}
export interface StagnationStop {
  readonly reason: 'stagnation'; readonly threshold: number; readonly basis: ComparisonBasis;
  readonly cycles: readonly StagnationCycle[];
}
interface Call { name: string; input: Record<string, unknown>; after?: string }
export function stagnationController(options: { roundDir: string; agentDir: string; stop(reason: StagnationStop): void }) {
  const calls = new Map<string, Call>(), completedChecks = new Set<string>();
  let previous: CheckpointView | undefined, repairs: RepairEvidence[] = [], cycles: StagnationCycle[] = [];
  let pending: Promise<void> = Promise.resolve();
  const reset = () => { previous = undefined; repairs = []; cycles = []; };
  const accept = async (event: Record<string, any>) => {
    if (!Array.isArray(event.message?.content)) return;
    for (const block of event.message.content) {
      if (event.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
        if (calls.has(block.id)) { reset(); continue; }
        calls.set(block.id, { name: block.name, input: block.input ?? {}, after: previous?.id });
      }
      if (event.type !== 'user' || block.type !== 'tool_result') continue;
      const call = calls.get(block.tool_use_id); calls.delete(block.tool_use_id);
      if (!call || block.is_error) continue;
      if (['Write', 'Edit'].includes(call.name) && call.after === previous?.id && previous && typeof call.input.file_path === 'string') {
        const path = relative(options.agentDir, resolve(options.agentDir, call.input.file_path)).split(sep).join('/');
        if (path.startsWith('candidates/') && !path.split('/').includes('..') && path.endsWith('.json')) repairs.push({ toolCallId: block.tool_use_id, path });
      }
      if (call.name !== 'mcp__rw__check_outcome') continue;
      const texts = typeof block.content === 'string' ? [block.content] : Array.isArray(block.content) ? block.content.flatMap((item: any) => item.type === 'text' ? [item.text] : []) : [];
      let delivered: any;
      for (const text of texts) { try { const value = JSON.parse(text); if (value.checkpoint) delivered = value; } catch { /* 未收到完整结果不能证明机会。 */ } }
      if (delivered?.checkpoint?.status !== 'saved' || !completedChecks.delete(delivered.checkpoint.id) || truncated(delivered)) { reset(); continue; }
      const { checkpoint } = await readCheckpoint(options.roundDir, delivered.checkpoint.id);
      if (!checkpoint || checkpoint.contentIdentity !== delivered.checkpoint.contentIdentity) { reset(); continue; }
      const required = checkpoint.check.coverageVerification?.status !== 'notChecked'
        ? checkpoint.check.coverageVerification?.missingItems.map(item => `coverage.missing:${item}`) ?? [] : [];
      if (previous && repairs.length && required.length) {
        const comparison = compareCandidates(previous, checkpoint);
        if (comparison.status === 'incomparable' || comparison.improved.length || comparison.unknownAdded.length) cycles = [];
        else {
          cycles.push({ before: previous.id, after: checkpoint.id, beforeIdentity: previous.contentIdentity, afterIdentity: checkpoint.contentIdentity, repairs, required });
          if (cycles.length >= 2 && checkpoint.comparisonBasis) options.stop({ reason: 'stagnation', threshold: 2, basis: checkpoint.comparisonBasis, cycles });
        }
      } else if (!required.length || (previous && canonical(previous.comparisonBasis) !== canonical(checkpoint.comparisonBasis))) cycles = [];
      previous = checkpoint; repairs = [];
    }
  };
  return {
    checked(value: CheckpointCheck) { if (value.checkpoint.status === 'saved') completedChecks.add(value.checkpoint.id); },
    accept(event: Record<string, any>) { pending = pending.then(() => accept(event)).catch(() => reset()); },
    async idle() { await pending; },
  };
}
function truncated(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (!Array.isArray(value) && (value as Record<string, unknown>).truncated === true) return true;
  return Object.values(value).some(truncated);
}
