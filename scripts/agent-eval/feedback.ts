/** 可信反馈计划与局部修正核查。这里不以合成执行结果证明真实模型质量。 */
import {readFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {validateContentBaseline} from '../../src/agent/coverage-verification.js';
import type {OutcomeCheck, RoundRecord} from '../../src/index.js';
import {AGENT_TASKS, readReview} from '../../src/index.js';
import {repoPath, type EvalConfig, type Scenario, type FeedbackScenario} from './scenarios.js';
export async function feedbackPlan(config: EvalConfig, scenarios: readonly Scenario[], sourceOptions?: {dir: string; configFile: string}) {
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
  let source: {compatible: boolean; directory: string; identity?: string; reason?: string} | undefined;
  if (sourceOptions) {
    try {
      const {experimentIdentity, identityDifferences, verifyRoundIdentities, sha256} = await import('./identity.js');
      const saved = await json(join(sourceOptions.dir, 'eval.json'));
      if (!saved.identity || saved.repeat !== Math.max(2, config.consecutivePasses)
        || !isDeepStrictEqual(saved.scenarios, scenarios.map(scenario => scenario.id))) throw new Error('缺少完整来源身份或预登记计划不相容');
      const identity: import('./identity.js').ExperimentIdentity = saved.identity;
      const budgets = [...new Set(Object.values(identity.budgets.maxTurns))];
      const current = await experimentIdentity(config, sourceOptions.configFile, scenarios, {
        contextPolicy:identity.contextPolicy?.name,
        ...identity.runtime, effort: identity.runtime.effort ?? undefined,
        claude: {command: identity.executor.command, args: identity.executor.args}, ...(budgets.length === 1 ? {maxTurns: budgets[0]} : {}),
        ...(identity.budgets.roundTimeoutMs !== null ? {roundTimeoutMs:identity.budgets.roundTimeoutMs} : {}),
        ...(identity.budgets.stagnation != null ? {stagnationThreshold:identity.budgets.stagnation} : {}),
      }, identity.plan);
      const changed = identityDifferences(identity, current);
      if (changed.length) throw new Error(`来源条件不相容：${changed.join('、')}`);
      await verifyRoundIdentities(identity, sourceOptions.dir, scenarios, saved.repeat);
      const {observedUnit, scoreScenario} = await import('./eval.js');
      for (const unit of units) {
        unit.budget.maxTurns = identity.budgets.maxTurns[unit.task]!;
        const scenario = scenarios.find(scenario => scenario.id === unit.id)!;
        if (await observedUnit(sourceOptions.dir, scenario, unit.repetition)) unit.status = (await scoreScenario(config, scenario, unit.repetition, sourceOptions.dir)).status;
      }
      source = {compatible: true, directory: sourceOptions.dir, identity: sha256(JSON.stringify(identity))};
    } catch (error) {source = {compatible: false, directory: sourceOptions.dir, reason: error instanceof Error ? error.message : String(error)};}
  }
  return {format: 'renderweave-feedback-plan/1', evidence: config.evidence ?? 'mechanism', ready: units.every(unit => !unit.missing.length) && source?.compatible !== false,
    realModelObservations: 0, missingRealModelObservations: units.length, ...(source ? {source} : {}), units};
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
function findPointer(document: any, path: string): {parent: any; key: string; value: unknown} | undefined {
  const tokens = path.slice(1).split('/').map(token => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  let parent = document;
  for (const token of tokens.slice(0, -1)) {if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, token)) return undefined; parent = parent[token];}
  const key = tokens.at(-1)!;
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return undefined;
  return {parent, key, value: parent[key]};
}
function pointer(document: any, path: string) {
  const target = findPointer(document, path);
  if (!target) throw new Error('纠偏目标路径不存在');
  return target;
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
const feedbackLabels = {
  targetCorrection: '目标修正', nonTargetPreservation: '非目标保留', unknownRetained: '未知范围保留',
  finalCheckMatches: '最后工具检查与宿主终检身份', pagination: '后续页实际取得',
} as const;
type FeedbackGuard = keyof typeof feedbackLabels;
export interface FeedbackScore {
  readonly format: 'renderweave-feedback-score/2';
  /** true/false 是已核查结论；null 只表示证据不可用，具体原因见 unchecked。 */
  readonly targetCorrection: boolean | null; readonly nonTargetPreservation: boolean | null; readonly unknownRetained: boolean | null;
  readonly finalCheckMatches: boolean | null; readonly pagination: boolean | null;
  readonly unchecked: Readonly<Partial<Record<FeedbackGuard, string>>>; readonly failures: string[];
  readonly before?: unknown; readonly after?: unknown;
}
type FeedbackEvidence<T> = {value: T} | {error: string};
async function evidence<T>(read: () => Promise<T>): Promise<FeedbackEvidence<T>> {
  try {return {value: await read()};} catch (error) {return {error: error instanceof Error ? error.message : String(error)};}
}
function required<T>(item: FeedbackEvidence<T>): T {
  if ('error' in item) throw new Error(item.error);
  return item.value;
}
export async function scoreFeedback(scenario: FeedbackScenario, dir: string): Promise<FeedbackScore> {
  const scores: Record<FeedbackGuard, boolean | null> = {
    targetCorrection: null, nonTargetPreservation: null, unknownRetained: null, finalCheckMatches: null, pagination: null,
  };
  const unchecked: Partial<Record<FeedbackGuard, string>> = {};
  let before: OutcomeCheck | undefined, after: OutcomeCheck | undefined;
  const inspect = async (guard: FeedbackGuard, check: () => boolean | Promise<boolean>) => {
    try {scores[guard] = await check();} catch (error) {unchecked[guard] = error instanceof Error ? error.message : String(error);}
  };
  try {
    // 核准政策及种子身份是全部评分的共同前提；各守卫仅依赖自己需要的后续证据。
    await validateFeedbackScenario(scenario);
    const policy = await policyOf(scenario), seed = repoPath(scenario.seedRound);
    const [initialCheck, finalCheck, initialCandidate, currentCandidate, toolLog] = await Promise.all([
      evidence<OutcomeCheck>(() => json(join(seed, 'check.json'))),
      evidence<OutcomeCheck>(() => json(join(dir, 'check.json'))),
      evidence(() => json(join(seed, 'agent', policy.candidate))),
      evidence(async () => {
        // 与宿主审核预览相同的有效候选包含尚未审核的 pending.candidate。
        const reviewed = await readReview(dir, {persistArtifacts: false});
        const current = reviewed.view?.candidates.find(candidate => candidate.path === policy.candidate)?.document;
        if (!current) throw new Error('没有可评分的有效候选');
        return current;
      }),
      evidence(async () => (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))),
    ]);
    if ('value' in initialCheck) before = initialCheck.value;
    if ('value' in finalCheck) after = finalCheck.value;
    await inspect('targetCorrection', () => {
      const current = required(currentCandidate);
      return policy.corrections.every(change => {
        const target = findPointer(current, change.pointer);
        return !!target && isDeepStrictEqual(target.value, change.after);
      });
    });
    await inspect('nonTargetPreservation', async () => {
      const masked = structuredClone(required(currentCandidate));
      for (const change of policy.corrections) {
        const target = findPointer(masked, change.pointer);
        // 严格属性政策不接受 text 被 slot 等结构替代；可核实的路径缺失是失败。
        if (!target) return false;
        target.parent[target.key] = change.before;
      }
      if (!isDeepStrictEqual(required(initialCandidate), masked)) return false;
      const initialCandidates = required(initialCheck).candidates.map(candidate => candidate.path).sort();
      const finalCandidates = required(finalCheck).candidates.map(candidate => candidate.path).sort();
      if (!isDeepStrictEqual(initialCandidates, finalCandidates)) return false;
      for (const candidate of initialCandidates.filter(candidate => candidate !== policy.candidate)) {
        if (!(await readFile(join(seed, 'agent', candidate))).equals(await readFile(join(dir, 'agent', candidate)))) return false;
      }
      return true;
    });
    await inspect('unknownRetained', () => {
      const checked = required(finalCheck);
      if (scenario.task.startsWith('template')) {
        const visual = checked.assessment.visual;
        if (!visual) throw new Error('宿主终检缺少视觉核查');
        return visual.coverage.unknownRegions > 0 && visual.status === 'needsReview';
      }
      const initial = required(initialCheck).assessment.coverage, final = checked.assessment.coverage;
      if (!initial || !final) throw new Error('缺少初始或最终内容核查');
      return policy.unknownIds.every(id => initial.unknownItems.includes(id) && final.unknownItems.includes(id)) && final.passed === false;
    });
    await inspect('finalCheckMatches', () => {
      const checked = required(finalCheck), log = required(toolLog);
      if (!checked.contentIdentity?.id) throw new Error('宿主终检缺少内容身份');
      const check = log.filter(entry => entry.tool === 'check_outcome' && !entry.isError).at(-1);
      if (check?.contentIdentity !== checked.contentIdentity.id) return false;
      if (!scenario.task.startsWith('template')) return true;
      if (!checked.assessment.visual?.reportId) throw new Error('宿主终检缺少视觉报告身份');
      return log.filter(entry => entry.tool === 'compare_reference' && !entry.isError).at(-1)?.reportId === checked.assessment.visual.reportId;
    });
    await inspect('pagination', () => !scenario.task.startsWith('template') || !policy.requiredLaterPageRegion || required(toolLog).some(entry =>
      entry.tool === 'compare_reference' && !entry.isError && entry.regionOffset >= 20
      && entry.regionCatalog?.some((region: {id: string}) => region.id === policy.requiredLaterPageRegion) && entry.regionIssues?.includes(policy.requiredLaterPageRegion)));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    for (const guard of Object.keys(scores) as FeedbackGuard[]) unchecked[guard] = reason;
  }
  const failures = (Object.keys(scores) as FeedbackGuard[]).flatMap(guard => scores[guard] === true ? [] : [
    scores[guard] === false ? feedbackLabels[guard] + '未通过' : feedbackLabels[guard] + '未核查：' + unchecked[guard],
  ]);
  return {format: 'renderweave-feedback-score/2', ...scores, unchecked, failures, before: before?.assessment, after: after?.assessment};
}
