/** 显式开启的有界修复。每次模型调用仍走原有隔离轮次；不审批或应用成果。 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseDesignCheckPlan } from './design-verification.js';
import { canonical } from './diff.js';
import { resourceFingerprint } from './handoff.js';
import { readPreviousRound } from './review.js';
import { AgentUsageError, exists, sha256, workspaceFingerprint } from './round-files.js';
import { runAgentTask, type AgentRunOptions, type AgentRunResult } from './run.js';

export interface RepairRunSummary {
  readonly format: 'renderweave-repair-run/1';
  readonly maxRounds: number;
  readonly reason: 'complete' | 'budget' | 'runtimeStopped' | 'checksUnavailable' | 'pendingReview' | 'inputsChanged';
  readonly rounds: readonly { readonly dir: string; readonly fingerprint?: string; readonly stop: boolean; readonly wallMs: number; readonly peakInputTokens: number | null }[];
}

export async function runAgentRepair(options: AgentRunOptions, maxRounds: number): Promise<AgentRunResult & { repairRun: RepairRunSummary }> {
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 4) throw new AgentUsageError('--repair-rounds 必须是 1–4 的整数');
  const previous = options.from ? await readPreviousRound(options.from) : undefined;
  const task = previous?.record.task ?? options.task;
  const checksFile = previous?.record.inputs.checks ? join(previous.dir, 'design-checks.json') : options.checks;
  const workspace = previous?.record.inputs.workspace.source ?? options.workspace;
  const resources = previous?.resources ?? options.resources;
  const sample = previous ? join(previous.dir, previous.record.inputs.sample.file) : options.sample;
  const fixedFiles = [
    previous ? join(previous.dir, 'agent/docs/brief.md') : options.brief,
    previous?.record.inputs.request ? join(previous.dir, 'request.json') : options.request,
    previous?.record.inputs.requirement ? join(previous.dir, 'requirement.md') : options.requirement,
    options.feedback,
  ].filter((file): file is string => file !== undefined);
  if (!['template-design', 'template-revision'].includes(task ?? '') || !checksFile || !workspace || !resources || !sample) {
    throw new AgentUsageError('--repair-rounds 需要模板任务、工作区、资源与带核准修复策略的 --checks');
  }
  try {
    if (!parseDesignCheckPlan(JSON.parse(await readFile(checksFile, 'utf8'))).repair) throw new Error('缺少 repair');
  } catch (error) { throw new AgentUsageError(`无法开启修复：${error instanceof Error ? error.message : String(error)}`); }
  const binding = async () => JSON.stringify([await workspaceFingerprint(workspace), await resourceFingerprint(resources),
    sha256(await readFile(sample)), sha256(await readFile(checksFile)),
    await Promise.all(fixedFiles.map(async file => [file, sha256(await readFile(file))]))]);
  const initial = await binding(), root = resolve(options.out);
  const completed: AgentRunResult[] = [];
  const unchanged = async () => {
    try {
      if (await binding() !== initial) return false;
      for (const round of completed) if (!await inheritedInputsMatch(round)) return false;
      return true;
    }
    catch { return false; } // 输入被删除/变得不可读也属于漂移，不能携带旧反馈继续。
  };
  try { await mkdir(root); } catch (error) { throw new AgentUsageError(`修复输出目录必须不存在：${error instanceof Error ? error.message : String(error)}`); }
  const rounds: RepairRunSummary['rounds'][number][] = [];
  let result: AgentRunResult | undefined;
  let reason: RepairRunSummary['reason'] = 'budget';
  for (let index = 1; index <= maxRounds; index++) {
    if (!await unchanged()) { reason = 'inputsChanged'; break; }
    const out = join(root, `round-${index}`);
    if (!result) result = await runAgentTask({ ...options, out });
    else {
      const feedback = join(root, `feedback-${index}.md`);
      await writeFile(feedback, result.check.assessment.repair!.feedback + '\n', { flag: 'wx' });
      result = await runAgentTask({ out, from: result.roundDir, feedback, key: options.key, keyEnv: options.keyEnv,
        model: options.model, smallModel: options.smallModel, endpoint: options.endpoint, maxTurns: options.maxTurns,
        contextLimit: options.contextLimit, effort: options.effort, claude: options.claude, onStart: options.onStart });
    }
    completed.push(result);
    const decision = result.check.assessment.repair;
    rounds.push({ dir: result.roundDir, fingerprint: decision?.fingerprint, stop: decision?.stop ?? false,
      wallMs: result.record.run.wallMs, peakInputTokens: result.record.run.context?.peakInputTokens ?? null });
    reason = !await unchanged() ? 'inputsChanged'
      : result.record.run.error || result.record.run.exitCode !== 0 || result.record.run.endedBy !== 'success' ? 'runtimeStopped'
        : (result.outcome?.pending.length ?? 0) > 0 ? 'pendingReview' : !decision ? 'checksUnavailable' : decision.reason === 'pendingReview' ? 'pendingReview' : decision.stop ? 'complete' : 'budget';
    // 每轮决定先落盘再发起下一轮，预算终止不冒充完成。
    await writeFile(join(root, 'repair-run.json'), JSON.stringify({ format: 'renderweave-repair-run/1', maxRounds, reason, rounds }, null, 2) + '\n');
    if (reason !== 'budget') break;
  }
  if (!result) throw new AgentUsageError('修复输入在首次运行前变化；未发起模型调用');
  const repairRun: RepairRunSummary = { format: 'renderweave-repair-run/1', maxRounds, reason, rounds };
  await writeFile(join(root, 'repair-run.json'), JSON.stringify(repairRun, null, 2) + '\n');
  return { ...result, repairRun };
}

/** 下一轮实际读取的副本也须保持启动时内容；Agent 的 docs 并非只读。 */
async function inheritedInputsMatch(result: AgentRunResult): Promise<boolean> {
  const { roundDir: dir, record: { inputs } } = result;
  const files: [string, string][] = [
    [join(dir, inputs.sample.file), inputs.sample.sha256],
    [join(dir, 'agent/docs/brief.md'), inputs.brief.sha256],
  ];
  if (inputs.requirement) files.push([join(dir, inputs.requirement.file), inputs.requirement.sha256],
    [join(dir, 'agent/docs/requirement.md'), inputs.requirement.sha256]);
  if (inputs.feedback) files.push([join(dir, inputs.feedback.file), inputs.feedback.sha256],
    [join(dir, 'agent/docs/feedback.md'), inputs.feedback.sha256]);
  else if (await exists(join(dir, 'feedback.md')) || await exists(join(dir, 'agent/docs/feedback.md'))) return false;
  if (inputs.checks) files.push([join(dir, inputs.checks.file), inputs.checks.sha256]);
  for (const candidate of result.check.candidates) if (candidate.sha256) files.push(
    [join(dir, candidate.path), candidate.sha256], [join(dir, 'agent', candidate.path), candidate.sha256]);
  for (const [file, expected] of files) if (sha256(await readFile(file)) !== expected) return false;
  if (inputs.request) {
    const context = JSON.parse(await readFile(join(dir, 'logs/outcome-context.json'), 'utf8'));
    for (const file of [join(dir, inputs.request.file), join(dir, 'agent/docs/request.json')]) {
      if (canonical(JSON.parse(await readFile(file, 'utf8'))) !== canonical(context.request)) return false;
    }
  }
  return true;
}
