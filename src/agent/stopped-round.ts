/** 停止后的独立本地保存；只复用已提交的完整检查，不重新启动渲染。 */
import { dirname, join } from 'node:path';
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dslDocumentKind } from '../dsl.js';
import { WorkingDirectory } from '../mcp/files.js';
import { readCheckpoint } from './checkpoints.js';
import { finishStoppedExecution, writeAtomicJson, writeStopReceipt } from './execution.js';
import { readUsage, type AgentRunResult, type RoundOutcome, type RoundRecord, type RoundUsage } from './run.js';
import { AGENT_TASKS, type CandidateKind } from './tasks.js';
import { sha256 } from './round-files.js';
import type { OutcomeCheck } from './outcome.js';
import type { PreparedRound, RoundStop } from './supervision.js';

export function stoppedMessage(reason: RoundStop): string {
  return reason.reason === 'timeout' ? `整轮墙钟超过 ${reason.roundTimeoutMs} 毫秒，已停止本轮`
    : reason.reason === 'stagnation' ? `连续 ${reason.threshold} 次完整修复机会没有核准进展，已停止本轮`
    : reason.reason === 'cancelled' ? '用户取消，已停止本轮' : `硬额度耗尽（${reason.limit}），已停止本轮`;
}
export function stoppedResult(prepared: PreparedRound, reason: RoundStop, usage: RoundUsage, save: 'complete' | 'incomplete', detail: string): AgentRunResult {
  const check: OutcomeCheck = { verdict: 'unqualified', problems: [], candidates: [], assessment: { structure: 'invalid', candidates: 'notChecked', content: 'needsReview',
    render: { status: 'notChecked', problems: [], hasImage: false, capabilityBlocked: false, blocking: false } } };
  return { roundDir: prepared.roundDir, save, check, record: { ...prepared.record, format: 'renderweave-round/1', execution: 'renderweave-execution/1',
    endedAt: new Date().toISOString(), run: { ...usage, exitCode: null, stopped: reason, error: `${stoppedMessage(reason)}；${detail}` }, verdict: 'unqualified' } };
}
export async function saveStoppedRound(options: { prepared: PreparedRound; reason: RoundStop; usage: RoundUsage; ownerPid: number }): Promise<AgentRunResult> {
  const { prepared: { roundDir }, reason } = options;
  // 首先发布停止原因和已知用量。后续任何保存阻塞，都不会把原因退化为无说明的强退。
  await writeStopReceipt(roundDir, reason, options.usage, options.ownerPid);
  const { mcp, apiError: _apiError, ...streamUsage } = await readUsage(join(roundDir, 'logs/stream.jsonl'));
  const usage = streamUsage.usageSource === 'result' || !options.usage.usageSource ? { ...options.usage, ...streamUsage } : { ...streamUsage, ...options.usage };
  const saved = await readCheckpoint(roundDir);
  const check: OutcomeCheck = saved.checkpoint ? { ...saved.checkpoint.check, verdict: 'unqualified' } : {
    verdict: 'unqualified', problems: saved.problems, candidates: [], assessment: { structure: 'invalid', candidates: 'notChecked', content: 'needsReview',
      render: { status: 'notChecked', problems: [], hasImage: false, capabilityBlocked: false, blocking: false } },
  };
  const result = stoppedResult(options.prepared, reason, usage, 'complete', saved.checkpoint ? '已有完整检查点可用 --from 带反馈接续' : '没有可核对的完整检查点，仅可查看诊断');
  const record: RoundRecord = { ...result.record, run: { ...result.record.run, ...(mcp ? { mcp } : {}) } };
  // 终检过程中可能已经复制过部分成果；停止后只发布明确标记的恢复草稿。
  await rm(join(roundDir, 'outcome.json'), { force: true });
  const draft = await saveDraft(roundDir, record, check, saved.checkpoint?.id);
  await writeAtomicJson(join(roundDir, 'check.json'), check);
  await writeAtomicJson(join(roundDir, 'round.json'), record);
  await finishStoppedExecution(roundDir, record, options.ownerPid);
  return { roundDir, record, check, save: 'complete', ...(draft ? { draft } : {}) };
}

/** 只读 JSON 字节与种类，不运行检查或渲染；零散候选只供诊断，不成为检查点。 */
async function saveDraft(roundDir: string, record: RoundRecord, check: OutcomeCheck, checkpoint?: string): Promise<string | undefined> {
  const root = checkpoint ? join(roundDir, 'checkpoints', checkpoint, 'agent') : join(roundDir, 'agent');
  const safe = await WorkingDirectory.open(root), paths: string[] = [];
  const walk = async (path: string): Promise<void> => {
    if (!(await lstat(join(root, path))).isDirectory()) return;
    for (const entry of await readdir(join(root, path), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) paths.push(child);
    }
  };
  if (checkpoint) paths.push(...check.candidates.map(candidate => candidate.path));
  else await walk('candidates');
  const candidates: RoundOutcome['candidates'][number][] = [];
  for (const path of paths.sort()) {
    try {
      const bytes = await safe.readBytes(path), document = JSON.parse(Buffer.from(bytes).toString('utf8')), kind = dslDocumentKind(document) as CandidateKind;
      if (!AGENT_TASKS[record.task].candidateKinds.includes(kind)) continue;
      await mkdir(dirname(join(roundDir, path)), { recursive: true }); await writeFile(join(roundDir, path), bytes);
      candidates.push({ path, kind, sha256: sha256(bytes), ...(typeof document.name === 'string' ? { name: document.name } : {}) });
    } catch { /* 半写、越界、无法读取的文件仍只留在工作副本。 */ }
  }
  if (!candidates.length) return undefined;
  const outcome: RoundOutcome = { format: 'renderweave-outcome/1', task: record.task, round: record.round,
    inputs: { sampleSha256: record.inputs.sample.sha256, workspaceFingerprint: record.inputs.workspace.fingerprint, previous: record.inputs.previous ?? null },
    candidates, locations: [], pending: [], usage: record.run,
    notes: checkpoint ? '来自最后完整检查点的恢复草稿，未获人工批准。' : '停止时保留的可读 JSON；未经完整集合检查，完成度未知，仅供诊断。' };
  await writeAtomicJson(join(roundDir, 'draft.json'), { format: 'renderweave-draft/1', source: 'hostRecovery', outcome, check });
  return 'draft.json';
}
