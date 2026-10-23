/** 可信反馈计划与局部修正核查。这里不以合成执行结果证明真实模型质量。 */
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {validateContentBaseline} from '../../src/agent/coverage-verification.js';
import type {OutcomeCheck, RoundRecord} from '../../src/index.js';
import {AGENT_TASKS} from '../../src/index.js';
import {repoPath, type EvalConfig, type Scenario, type FeedbackScenario} from './scenarios.js';
export async function feedbackPlan(config: EvalConfig, scenarios: readonly Scenario[]) {
  const units = [];
  for (const scenario of scenarios) {
    if (scenario.kind !== 'feedback') throw new Error('--plan 需要可信反馈场景');
    const missing: string[] = [];
    for (const key of ['sample', 'brief', 'seedRound', 'feedback', 'policy'] as const) {
      try {await stat(repoPath(scenario[key]));} catch {missing.push(key);}
    }
    const baseline = scenario.task.startsWith('template') ? scenario.reference : scenario.contentBaseline;
    if (!baseline) missing.push('approvedBaseline');
    else try {await readFile(repoPath(baseline));} catch {missing.push('approvedBaseline');}
    let validationError: string | undefined;
    if (!missing.length) try {await validateFeedbackScenario(scenario);} catch (error) {missing.push('validatedInputs'); validationError = error instanceof Error ? error.message : String(error);}
    for (let repetition = 1; repetition <= Math.max(2, config.consecutivePasses); repetition++) units.push({
      id: scenario.id, task: scenario.task, language: scenario.language, repetition, status: 'not-run', missing, ...(validationError ? {validationError} : {}),
      budget: {maxTurns: AGENT_TASKS[scenario.task].maxTurns}, seed: {source: 'controlled-initial-result', round: repoPath(scenario.seedRound)},
    });
  }
  return {format: 'renderweave-feedback-plan/1', evidence: config.evidence ?? 'mechanism', ready: units.every(unit => !unit.missing.length),
    realModelObservations: 0, missingRealModelObservations: units.length, units};
}

export interface FeedbackPolicy {
  readonly format: 'renderweave-feedback-policy/1';
  readonly candidate: string;
  readonly corrections: readonly {readonly pointer: string; readonly before: unknown; readonly after: unknown}[];
  readonly unknownIds: readonly string[];
  readonly requiredLaterPageRegion?: string;
}
const json = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
async function policyOf(scenario: FeedbackScenario): Promise<FeedbackPolicy> {
  const policy = await json(repoPath(scenario.policy));
  if (policy?.format !== 'renderweave-feedback-policy/1' || !/^candidates\/[\w.-]+\.json$/.test(policy.candidate)
    || !Array.isArray(policy.corrections) || !policy.corrections.length || !Array.isArray(policy.unknownIds)
    || !policy.unknownIds.length || !policy.unknownIds.every((id: unknown) => typeof id === 'string')
    || policy.corrections.some((item: any) => !item || typeof item.pointer !== 'string' || !item.pointer.startsWith('/')
      || /(?:__proto__|constructor|prototype)/.test(item.pointer) || !('before' in item) || !('after' in item) || isDeepStrictEqual(item.before, item.after))) {
    throw new Error('缺少完整核准的纠偏政策：需要候选、明确前后值、允许路径和未知范围');
  }
  return policy;
}
function pointer(document: any, path: string): {parent: any; key: string; value: unknown} {
  const tokens = path.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = document;
  for (const token of tokens.slice(0, -1)) {if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, token)) throw new Error('纠偏目标路径不存在'); parent = parent[token];}
  const key = tokens.at(-1)!;
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('纠偏目标路径不存在');
  return {parent, key, value: parent[key]};
}
export async function validateFeedbackScenario(scenario: FeedbackScenario): Promise<void> {
  const policy = await policyOf(scenario), seed = repoPath(scenario.seedRound);
  const record: RoundRecord = await json(join(seed, 'round.json'));
  if (record.task !== scenario.task) throw new Error('初始成果与反馈任务不一致');
  for (const [key, path] of [['sample', scenario.sample], ['brief', scenario.brief]] as const) {
    if (digest(await readFile(repoPath(path))) !== record.inputs[key].sha256) throw new Error(`反馈场景${key}与初始成果身份不一致`);
  }
  const visual = scenario.task.startsWith('template');
  const baselinePath = visual ? scenario.reference : scenario.contentBaseline;
  const baselineInput = visual ? record.inputs.reference : record.inputs.contentBaseline;
  if (!baselinePath || !baselineInput) throw new Error('反馈场景缺少本次核准基准');
  const bytes = await readFile(repoPath(baselinePath));
  if (!isDeepStrictEqual(JSON.parse(bytes.toString('utf8')), await json(join(seed, baselineInput.file)))) throw new Error('反馈场景核准基准与初始成果不一致');
  const baseline = JSON.parse(bytes.toString('utf8'));
  if (!visual && !validateContentBaseline(baseline)) throw new Error('无效的核准内容事实');
  if (visual && (!Array.isArray(baseline.approvedRegions) || !baseline.approvedRegions.length)) throw new Error('缺少核准参考区域');
  const initial = await json(join(seed, 'agent', policy.candidate));
  for (const change of policy.corrections) if (!isDeepStrictEqual(pointer(initial, change.pointer).value, change.before)) throw new Error('初始成果不包含预登记的已知缺陷');
}
export interface FeedbackScore {
  readonly targetCorrection: boolean; readonly nonTargetPreservation: boolean; readonly unknownRetained: boolean;
  readonly finalCheckMatches: boolean; readonly pagination: boolean; readonly failures: string[];
  readonly before?: unknown; readonly after?: unknown;
}
export async function scoreFeedback(scenario: FeedbackScenario, dir: string): Promise<FeedbackScore> {
  const failures: string[] = [];
  let targetCorrection = false, nonTargetPreservation = false, unknownRetained = false, finalCheckMatches = false, pagination = false;
  let before: OutcomeCheck | undefined, after: OutcomeCheck | undefined;
  try {
    await validateFeedbackScenario(scenario);
    const policy = await policyOf(scenario), seed = repoPath(scenario.seedRound);
    before = await json(join(seed, 'check.json')); after = await json(join(dir, 'check.json'));
    if (!before || !after) throw new Error('缺少初始或反馈终检');
    const initial = await json(join(seed, 'agent', policy.candidate)), current = await json(join(dir, 'agent', policy.candidate));
    targetCorrection = policy.corrections.every(change => isDeepStrictEqual(pointer(current, change.pointer).value, change.after));
    const masked = structuredClone(current);
    for (const change of policy.corrections) {const target = pointer(masked, change.pointer); target.parent[target.key] = change.before;}
    nonTargetPreservation = isDeepStrictEqual(initial, masked);
    const initialCandidates = before.candidates.map(candidate => candidate.path).sort(), finalCandidates = after.candidates.map(candidate => candidate.path).sort();
    nonTargetPreservation &&= isDeepStrictEqual(initialCandidates, finalCandidates);
    for (const candidate of initialCandidates.filter(candidate => candidate !== policy.candidate)) {
      nonTargetPreservation &&= (await readFile(join(seed, 'agent', candidate))).equals(await readFile(join(dir, 'agent', candidate)));
    }
    const log = (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const check = log.filter(entry => entry.tool === 'check_outcome' && !entry.isError).at(-1);
    finalCheckMatches = !!after.contentIdentity?.id && check?.contentIdentity === after.contentIdentity.id;
    if (scenario.task.startsWith('template')) {
      const last = log.filter(entry => entry.tool === 'compare_reference' && !entry.isError).at(-1);
      finalCheckMatches &&= !!after.assessment.visual?.reportId && last?.reportId === after.assessment.visual.reportId;
      unknownRetained = (after.assessment.visual?.coverage.unknownRegions ?? 0) > 0 && after.assessment.visual?.status === 'needsReview';
      pagination = !policy.requiredLaterPageRegion || log.some(entry => entry.tool === 'compare_reference' && !entry.isError
        && entry.regionOffset >= 20 && entry.regionCatalog?.some((region: {id: string}) => region.id === policy.requiredLaterPageRegion) && entry.regionIssues?.includes(policy.requiredLaterPageRegion));
    } else {
      unknownRetained = policy.unknownIds.every(id => before!.assessment.coverage?.unknownItems.includes(id) && after!.assessment.coverage?.unknownItems.includes(id)) && after.assessment.coverage?.passed === false;
      pagination = true;
    }
  } catch (error) {failures.push(error instanceof Error ? error.message : String(error));}
  for (const [passed, label] of [[targetCorrection, '目标修正'], [nonTargetPreservation, '非目标保留'], [unknownRetained, '未知范围保留'],
    [finalCheckMatches, '最后工具检查与宿主终检身份'], [pagination, '后续页实际取得']] as const) if (!passed) failures.push(`${label}未通过`);
  return {targetCorrection, nonTargetPreservation, unknownRetained, finalCheckMatches, pagination, failures,
    before: before?.assessment, after: after?.assessment};
}
