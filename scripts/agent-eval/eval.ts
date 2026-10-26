import {classifyError, type ErrorKind} from '../../src/agent/execution-error.js';
export {classifyError, type ErrorKind} from '../../src/agent/execution-error.js';
import {readRoundMetrics as summarize, type RoundMetrics as RoundSummary} from '../../src/agent/round-metrics.js';
export {countPersisted} from '../../src/agent/round-metrics.js';
import { agentProvenance } from '../../src/agent/provenance.js';
import type { CleanupEvent } from '../../src/agent/execution.js';
/**
 * 评估的编排（第三阶段票据 08、验收 A10）：经产品路径（renderweave agent 与 renderweave mcp）发起各场景的轮次，
 * 评分并与通过线对照；每个场景预登记的全部次数达线才算通过。报告只存摘要，不存图片与日志。
 *
 * 366 场景要两轮：数据定义提取之后，模拟审核人全部采纳待确认项、审核通过并应用到场景自己的工作区，再做数据集提取。
 * 这只是评估中的模拟，产品本身不自动审核、不自动应用。
 *
 * 上游错误（票据 21）：模型服务的 500/529 与连接中断按轮次重试；额度窗口的 429 停止派发剩下的单元。
 * 宿主没能确认本轮进程树已结束、因而没有保存停止结果时，同样拿不到观测，不重试。
 * 仍拿不到有效结果的单元记为 invalid：它不是一次观测，既不算达线，也不算模型没做出来。
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AGENT_TASKS, applyAgentRound, changeReview, loadWorkspace, readReview, type AgentTaskId, type RoundOutcome, type RoundRecord } from '../../src/index.js';
import { MCP_CONTRACT_VERSION } from '../../src/mcp/tools.js';
import { REPO, repoPath, stageNames, type EvalConfig, type Scenario } from './scenarios.js';
import {evaluationTiming, executeAttempt, prepareAttempt, restoreAttempt, savedAttempts} from './attempts.js';
import {scoreFeedback, validateFeedbackScenario, type FeedbackScore} from './feedback.js';
import {withLocalAccess} from '../../src/local-access.js';
import {
  CONVENTIONS, scoreDefinitions, scoreRevision, scoreTemplates, scoreTranscription, stopsOf,
  type ConventionId, type DefinitionScore, type RevisionScore, type TemplateScore, type TranscriptionScore, type TruthStop,
} from './score.js';

export interface RoundSpec {
  readonly task: AgentTaskId;
  readonly from?: string;
  readonly feedback?: string;
  /** 新的轮次目录。 */
  readonly out: string;
  readonly sample: string;
  readonly brief: string;
  readonly resources: string;
  readonly domain?: string;
  readonly reference?: string;
  readonly contentBaseline?: string;
  readonly workspace?: string;
  readonly definition?: string;
  readonly dataset?: string;
  readonly request?: string;
  readonly requirement?: string;
}

/** 发起一轮：结束后轮次目录里有 round.json，结构合格时另有 outcome.json。用法错误时抛出。 */
export type Launcher = (spec: RoundSpec) => Promise<void>;

export interface RuntimeOptions {
  readonly contextPolicy?: 'full'|'on-demand';
  readonly claude?: { readonly command: string; readonly args?: readonly string[] };
  readonly model?: string;
  readonly smallModel?: string;
  readonly endpoint?: string;
  readonly keyEnv?: string;
  readonly maxTurns?: number;
  readonly roundTimeoutMs?: number;
  readonly stagnationThreshold?: number;
  /** 推理力度，透传给 agent run 的 --effort（票据 23）。 */
  readonly effort?: string;
}

/** 缺省的发起方式：调用构建好的命令行 node dist/bin.js agent run，key 由命令行从环境变量读取。输出写在轮次目录旁的 .log。 */
export function cliLauncher(runtime: RuntimeOptions = {}): Launcher {
  return async (spec) => {
    const flag = (name: string, value: string | number | undefined) => (value === undefined ? [] : [`--${name}`, String(value)]);
    const args = [
      join(REPO, 'dist/bin.js'), 'agent', 'run', '--out', spec.out, ...(spec.from ? ['--from', spec.from, '--feedback', spec.feedback!] : ['--task', spec.task, '--sample', spec.sample, '--brief', spec.brief,
      '--resources', spec.resources, ...flag('domain', spec.domain), ...flag('workspace', spec.workspace),
      ...flag('definition', spec.definition), ...flag('dataset', spec.dataset), ...flag('request', spec.request), ...flag('requirement', spec.requirement), ...flag('reference', spec.reference), ...flag('content-baseline', spec.contentBaseline)]),
      ...flag('model', runtime.model), ...flag('small-model', runtime.smallModel), ...flag('endpoint', runtime.endpoint),
      ...flag('key-env', runtime.keyEnv), ...flag('max-turns', runtime.maxTurns), ...flag('timeout-ms', runtime.roundTimeoutMs), ...flag('effort', runtime.effort),
      ...flag('stagnation-threshold', runtime.stagnationThreshold),
      ...flag('context-policy',runtime.contextPolicy),
      ...flag('claude', runtime.claude?.command), ...(runtime.claude?.args ? ['--claude-args', JSON.stringify(runtime.claude.args)] : []),
    ];
    const result = await execute(process.execPath, args);
    await writeFile(`${spec.out}.log`, `${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 && result.code !== 1) throw new Error(`发起${AGENT_TASKS[spec.task].name}失败（退出码 ${String(result.code)}）：${result.stderr.trim()}`);
    // 记录都没能写出时仍须保留宿主错误；否则硬额度会丢失、队列会继续派发。
    // 已保存成果或清理回执仍沿用 roundError 的既有分类与评分。
    if (result.code === 1 && !await exists(join(spec.out, 'round.json')) && !await exists(join(spec.out, 'cleanup.json')))
      throw new Error(result.stderr.trim() || `发起${AGENT_TASKS[spec.task].name}失败（退出码 1），没有轮次记录或清理回执`);
  };
}

/** 瞬时错误后每次重试前等多久；长度就是最多重试几次。Claude Code 自己已经重试过，外层两次就够。 */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 180_000];

/** 冻结条件失效必须终止实验，不能降为模型失败或触发重试。 */
export class EvaluationAborted extends Error {}

export interface RetryOptions {
  readonly beforeDispatch?: () => Promise<void>;
  /** 按 RETRY_DELAYS_MS 等待；离线测试注入，不真的等。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 进度输出（重试、跳过、额度熔断），缺省不输出。 */
  readonly log?: (message: string) => void;
}

/** 单元拿不到有效结果的原因。 */
export interface InvalidReason {
  /** transient：瞬时错误重试用完；quota：额度限制，不重试；host：停止后宿主进程树清理未确认，停止结果没有保存，不重试。 */
  readonly kind: 'transient' | 'quota' | 'host';
  readonly task: AgentTaskId;
  readonly error: string;
}

/** 上游错误的记录，写在场景目录里，重新评分时读回：每次重试的轮次与原因，拿不到有效结果时的 invalid 原因。 */
export const UPSTREAM_ERRORS = 'upstream-errors.json';

interface UpstreamRecord {
  readonly retries: { readonly task: AgentTaskId; readonly error: string }[];
  invalid?: InvalidReason;
}

export type {RoundMetrics as RoundSummary} from '../../src/agent/round-metrics.js';

/** 一个单元（场景的一次）的结论：达线、未达线，或因上游错误拿不到有效结果。 */
export type UnitStatus = 'pass' | 'fail' | 'invalid';

export interface ScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly repetition: number;
  readonly status: UnitStatus;
  /** status 为 pass。 */
  readonly pass: boolean;
  /** 上游瞬时错误的重试次数，各轮之和。 */
  readonly retries: number;
  /** status 为 invalid 时的原因。 */
  readonly invalid?: InvalidReason;
  /** 没达线的原因，逐条；invalid 时为空，原因在 invalid 里。 */
  readonly failures: readonly string[];
  readonly rounds: readonly RoundSummary[];
  readonly checks: {
    readonly definition?: DefinitionScore;
    readonly template?: TemplateScore;
    readonly revision?: RevisionScore;
    readonly transcription?: TranscriptionScore;
    readonly feedback?: FeedbackScore;
  };
}

/** 发起阶段的失败（发起命令报错、审核或应用不成），写在场景目录里。 */
export const LAUNCH_FAILURES = 'launch-failures.json';

/** 一个场景在 outDir 下的目录：run-<第几次>/<场景>/，其中是各轮的轮次目录与场景自己的工作区。 */
export function unitDir(outDir: string, scenario: Scenario, repetition: number): string {
  return join(outDir, `run-${repetition}`, scenario.id);
}

/**
 * 跑一个场景的一次：发起所需的轮次，然后评分。
 * 续跑 invalid 的单元时也用它：已有有效轮次记录的轮次不再发起，366 已应用的第一轮保留；重试次数累计。
 */
export async function runScenario(config: EvalConfig, scenario: Scenario, repetition: number, outDir: string, launch: Launcher, retry: RetryOptions = {}): Promise<ScenarioResult> {
  await retry.beforeDispatch?.();
  const unit = unitDir(outDir, scenario, repetition);
  await mkdir(unit, { recursive: true });
  const upstream: UpstreamRecord = { retries: (await readUpstream(unit)).retries };
  await rm(join(unit, LAUNCH_FAILURES), { force: true });
  const base = { ...(scenario.reference ? {reference: repoPath(scenario.reference)} : {}), ...(scenario.contentBaseline ? {contentBaseline: repoPath(scenario.contentBaseline)} : {}), sample: repoPath(scenario.sample), brief: repoPath(scenario.brief), resources: repoPath(config.resources), ...(scenario.domain ? { domain: scenario.domain } : {}) };
  const round = (spec: RoundSpec) => launchRound(spec, launch, { ...retry, upstream, unit, label: `${scenario.name} 第 ${repetition} 次` });
  const failures: string[] = [];
  try {
    if (scenario.kind === 'feedback') {
      await validateFeedbackScenario(scenario);
      await round({...base, task: scenario.task, from: repoPath(scenario.seedRound), feedback: repoPath(scenario.feedback), out: join(unit, 'feedback')});
    } else if (scenario.kind === 'definition') {
      await round({ ...base, task: 'definition-extraction', out: join(unit, 'definition') });
    } else if (scenario.kind === 'template' || scenario.kind === 'revision') {
      const workspace = join(unit, 'workspace');
      await mkdir(workspace, { recursive: true });
      for (const file of scenario.workspace.files) await copyFile(join(repoPath(scenario.workspace.from), file), join(workspace, file));
      if (scenario.kind === 'revision') {
        for (const file of scenario.savedTemplates.files) await copyFile(join(repoPath(scenario.savedTemplates.from), file), join(workspace, file));
        await round({ ...base, task: 'template-revision', out: join(unit, 'revision'), workspace, dataset: scenario.dataset,
          request: repoPath(scenario.request), requirement: repoPath(scenario.requirement) });
      } else {
        await round({ ...base, task: 'template-design', out: join(unit, 'template'), workspace, dataset: scenario.dataset, request: repoPath(scenario.request) });
      }
    } else {
      await round({ ...base, task: 'definition-extraction', out: join(unit, 'definition') });
      const definition = await approveDefinitions(join(unit, 'definition'), join(unit, 'workspace'));
      await round({ ...base, brief: repoPath(scenario.datasetBrief), task: 'dataset-extraction', out: join(unit, 'dataset'), workspace: join(unit, 'workspace'), definition });
    }
  } catch (error) {
    if (error instanceof EvaluationAborted) throw error;
    if (error instanceof InvalidUnit) {
      upstream.invalid = error.reason;
    } else {
      failures.push(error instanceof Error ? error.message : String(error));
      // 重新评分时要带上发起阶段的失败。
      await writeFile(join(unit, LAUNCH_FAILURES), `${JSON.stringify(failures, null, 2)}\n`);
    }
  }
  await writeUpstream(unit, upstream);
  return scoreScenario(config, scenario, repetition, outDir, failures);
}

/** 这个单元还要不要跑：没有目录，或上次是 invalid。同一个 --label 接着跑时，已有有效结果的单元跳过。 */
async function unitPending(outDir: string, scenario: Scenario, repetition: number): Promise<boolean> {
  const unit = unitDir(outDir, scenario, repetition);
  return !(await observedUnit(outDir, scenario, repetition)) || (await readUpstream(unit)).invalid !== undefined;
}

/** 目录存在本身不是观测；半写目录仍是 not-run，允许接续补齐。 */
export async function observedUnit(outDir: string, scenario: Scenario, repetition: number): Promise<boolean> {
  const unit = unitDir(outDir, scenario, repetition);
  if ((await readUpstream(unit)).invalid || await exists(join(unit, LAUNCH_FAILURES))) return true;
  const names = stageNames(scenario);
  return (await Promise.all(names.map(name => roundError(join(unit, name))))).every(value => value !== undefined);
}

export interface EvalUnit {
  readonly scenario: Scenario;
  readonly repetition: number;
}

export interface QueueResult {
  /** 本次跑过的单元。 */
  readonly results: readonly ScenarioResult[];
  /** 已有有效结果、没有再跑的单元。 */
  readonly skipped: readonly EvalUnit[];
  /** 遇到额度限制之后没有发起的单元。 */
  readonly held: readonly EvalUnit[];
}

/**
 * 按 jobs 并行跑各单元，单元内部的轮次按顺序；已有有效结果的单元跳过。
 * 某个单元遇到额度限制时不再发起队列里剩下的单元，已在跑的单元跑完：额度窗口是几个小时，退避等不到它恢复。
 */
export async function runUnits(config: EvalConfig, units: readonly EvalUnit[], outDir: string, launch: Launcher, options: RetryOptions & { readonly jobs?: number } = {}): Promise<QueueResult> {
  const queue = [...units];
  const results: ScenarioResult[] = [], skipped: EvalUnit[] = [];
  let stopped = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(options.jobs ?? 1, queue.length) }, async () => {
    try {
    while (!stopped) {
      const unit = queue.shift();
      if (!unit) return;
      const label = `${unit.scenario.name} 第 ${unit.repetition} 次`;
      if (!(await unitPending(outDir, unit.scenario, unit.repetition))) {
        skipped.push(unit);
        options.log?.(`${label}：已有结果，跳过`);
        continue;
      }
      const result = await runScenario(config, unit.scenario, unit.repetition, outDir, launch, options);
      results.push(result);
      options.log?.(`${label}：${result.status === 'pass' ? '达线' : result.status === 'fail' ? `未达线（${result.failures.join('；')}）` : `invalid（${invalidText(result.invalid!)}）`}`);
      if (result.invalid?.kind === 'quota' && !stopped) {
        stopped = true;
        options.log?.(`额度限制：队列中还没开始的 ${queue.length} 个单元不再发起，已在跑的单元跑完`);
      }
    }
    } catch (error) { stopped = true; throw error; }
  }));
  const failed = workers.find(worker => worker.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return { results, skipped, held: queue };
}

/** 发起一轮时抛出：上游错误使这个单元拿不到有效结果。 */
class InvalidUnit extends Error {
  constructor(readonly reason: InvalidReason) {
    super(reason.error);
  }
}

/**
 * 发起一轮。瞬时错误在新的唯一尝试目录再发起（先前原件不变），单元里已完成的轮次与已应用的工作区不动；
 * 重试用完或遇到额度限制时抛出 InvalidUnit。其他错误照旧：发起失败抛出原错误，轮次记录里的错误留给评分。
 * 续跑时这一轮已有有效轮次记录就不再发起。
 */
async function launchRound(spec: RoundSpec, launch: Launcher, context: RetryOptions & { upstream: UpstreamRecord; unit: string; label: string }): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    await context.beforeDispatch?.();
    let reserved;
    try {
      reserved = await withLocalAccess([context.unit], async () => {
        await restoreAttempt(spec, context.unit);
        return (await roundError(spec.out)) === null ? undefined : prepareAttempt(spec, context.unit);
      });
    } catch (error) {
      throw new EvaluationAborted(error instanceof Error ? error.message : String(error));
    }
    if (!reserved) return;
    let failure: { kind: ErrorKind; error: string } | null | undefined, thrown: unknown;
    try {
      await executeAttempt(spec, reserved, launch);
      failure = await roundError(spec.out);
    } catch (caught) {
      thrown = caught;
      const error = caught instanceof Error ? caught.message : String(caught);
      failure = { kind: classifyError(error), error };
    }
    const kind = failure?.kind, error = failure?.error;
    if (kind === 'transient' && attempt < RETRY_DELAYS_MS.length) {
      context.upstream.retries.push({ task: spec.task, error: error! });
      await writeUpstream(context.unit, context.upstream);
      context.log?.(`${context.label}${AGENT_TASKS[spec.task].name}：上游瞬时错误，${Math.round(RETRY_DELAYS_MS[attempt]! / 1000)} 秒后重试这一轮（${attempt + 1}/${RETRY_DELAYS_MS.length}）：${error!}`);
      await (context.sleep ?? wait)(RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    if (kind === 'transient' || kind === 'quota' || kind === 'host') throw new InvalidUnit({ kind, task: spec.task, error: error! });
    if (thrown !== undefined) throw thrown;
    return;
  }
}

/**
 * 一轮的上游错误：null 表示已有有效的轮次记录（成果合格，或没有错误，或是其他错误）；
 * undefined 表示没有轮次记录；否则给出类型与 run.error。硬额度先读结构化停止原因，旧记录才按文字分类。
 */
async function roundError(dir: string): Promise<{ kind: ErrorKind; error: string } | null | undefined> {
  let record: RoundRecord;
  try { record = JSON.parse(await readFile(join(dir, 'round.json'), 'utf8')) as RoundRecord; } catch { return cleanupError(dir); }
  if (!record || !record.run || !['qualified', 'unqualified'].includes(record.verdict)) return undefined;
  if (record.run.stopped?.reason === 'hardQuota') return { kind: 'quota', error: record.run.error ?? `硬额度耗尽（${record.run.stopped.limit}）` };
  const error = record.run.error;
  const kind = error !== undefined ? classifyError(error) : 'other';
  return error !== undefined && kind !== 'other' ? { kind, error } : null;
}

/** 停止时宿主进程树清理未确认：保存进程没有运行，没有轮次记录，按清理回执记宿主错误；硬额度停止仍按额度停止派发。 */
async function cleanupError(dir: string): Promise<{ kind: ErrorKind; error: string } | undefined> {
  let events: readonly CleanupEvent[];
  try { events = (JSON.parse(await readFile(join(dir, 'cleanup.json'), 'utf8')) as { events: CleanupEvent[] }).events; } catch { return undefined; }
  const stopped = Array.isArray(events) ? events.find(event => event.after === 'stop') : undefined;
  if (!stopped) return undefined;
  return { kind: stopped.stop?.reason === 'hardQuota' ? 'quota' : 'host', error: stopped.detail };
}

async function readUpstream(unit: string): Promise<UpstreamRecord> {
  try {
    const saved = JSON.parse(await readFile(join(unit, UPSTREAM_ERRORS), 'utf8')) as UpstreamRecord;
    return { retries: [...saved.retries], ...(saved.invalid ? { invalid: saved.invalid } : {}) };
  } catch {
    return { retries: [] };
  }
}

/** 没有重试也没有 invalid 时不留文件。 */
async function writeUpstream(unit: string, record: UpstreamRecord): Promise<void> {
  if (record.retries.length === 0 && !record.invalid) await rm(join(unit, UPSTREAM_ERRORS), { force: true });
  else await writeFile(join(unit, UPSTREAM_ERRORS), `${JSON.stringify(record, null, 2)}\n`);
}

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function invalidText(reason: InvalidReason): string {
  const cause = reason.kind === 'quota' ? '遇到额度限制' : reason.kind === 'host' ? '宿主进程树清理未确认' : '上游瞬时错误重试用完';
  return `${AGENT_TASKS[reason.task].name}一轮${cause}：${reason.error}`;
}

/** 按已有的轮次目录评分；重新评分（--rescore）也用它，发起阶段的失败从 launch-failures.json 读回，上游错误从 upstream-errors.json 读回。 */
export async function scoreScenario(config: EvalConfig, scenario: Scenario, repetition: number, outDir: string, earlier?: readonly string[]): Promise<ScenarioResult> {
  const unit = unitDir(outDir, scenario, repetition);
  let launched: readonly string[] = earlier ?? [];
  if (earlier === undefined) {
    try { launched = JSON.parse(await readFile(join(unit, LAUNCH_FAILURES), 'utf8')) as string[]; } catch { launched = []; }
  }
  const upstream = await readUpstream(unit);
  const failures = [...launched];
  const names = stageNames(scenario);
  const rounds: RoundSummary[] = [];
  for (const name of names) {
    const summary = await summarize(join(unit, name), outDir);
    if (summary) rounds.push(summary);
  }
  for (const round of rounds) {
    if (round.verdict !== 'qualified') failures.push(`${AGENT_TASKS[round.task].name}一轮的成果不合格${round.error ? `（${round.error}）` : ''}${await severeReasons(join(outDir, round.dir))}`);
  }
  if (scenario.kind === 'revision' && rounds.length === 0) failures.push('缺少模板辅助修改的轮次记录');
  const checks: ScenarioResult['checks'] = {};
  const definitionRound = join(unit, 'definition');
  if (scenario.kind === 'definition' || scenario.kind === 'transcription') {
    // 结构不合格时没有轮次成果：仍按 Agent 交回的原样文件评分，只作诊断，结论照样不合格。
    const documents = await exists(join(definitionRound, 'outcome.json'))
      ? (await candidates(definitionRound)).filter((entry) => entry.kind === 'definition').map((entry) => entry.document)
      : await submittedDefinitions(join(definitionRound, 'agent/candidates'));
    if (documents.length > 0) Object.assign(checks, { definition: scoreDefinitions(documents) });
  }
  if ((scenario.kind === 'template' || scenario.kind === 'revision') && await exists(join(unit, scenario.kind, 'outcome.json'))) {
    const request = JSON.parse(await readFile(join(unit, scenario.kind, 'request.json'), 'utf8')) as { template: string };
    let templates = (await candidates(join(unit, scenario.kind))).filter((entry) => entry.kind === 'template')
      .map((entry) => ({ name: String((entry.document as { name: unknown }).name), document: entry.document }));
    if (scenario.kind === 'revision') {
      const saved = (await loadWorkspace({ dir: join(unit, 'workspace'), resourcesDir: repoPath(config.resources) })).templates;
      Object.assign(checks, { revision: scoreRevision(saved, templates, scenario.allowedTemplates) });
      const names = new Set(templates.map((entry) => entry.name));
      templates = [...saved.filter((entry) => !names.has(entry.name)), ...templates];
    }
    Object.assign(checks, { template: await scoreTemplates({
      workspaceDir: join(unit, 'workspace'), resourcesDir: repoPath(config.resources), templates, mainTemplate: request.template,
      datasetId: scenario.dataset, sample: await readFile(repoPath(scenario.sample)),
    }) });
  }
  if (scenario.kind === 'transcription' && await exists(join(unit, 'dataset', 'outcome.json'))) {
    // 审核视图里的数据集已把还没处理的待确认项换成候选值（M46），按审核人全部采纳计。
    const view = (await readReview(join(unit, 'dataset'), {persistArtifacts: false})).view;
    const dataset = view?.candidates.find((candidate) => candidate.kind === 'dataset')?.document;
    const truth = (JSON.parse(await readFile(repoPath(scenario.truth), 'utf8')) as { stops: TruthStop[] }).stops;
    Object.assign(checks, { transcription: scoreTranscription(stopsOf(dataset), truth) });
  }
  if (scenario.kind === 'feedback') Object.assign(checks, {feedback: await scoreFeedback(scenario, join(unit, 'feedback'))});
  failures.push(...judge(scenario, checks));
  // invalid 时的成果不合格与缺评分都是上游错误的后果，不列为没达线的原因；各轮的结论与检查结果照样留作诊断。
  const status: UnitStatus = upstream.invalid ? 'invalid' : failures.length === 0 ? 'pass' : 'fail';
  return {
    id: scenario.id, name: scenario.name, repetition, status, pass: status === 'pass', retries: upstream.retries.length,
    ...(upstream.invalid ? { invalid: upstream.invalid } : {}), failures: status === 'invalid' ? [] : failures, rounds, checks,
  };
}

/** 与通过线对照，返回没达线的原因；缺少评分（没有成果）也算没达线。 */
export function judge(scenario: Scenario, checks: ScenarioResult['checks']): string[] {
  const failures: string[] = [];
  if (scenario.kind === 'feedback') {
    const score = checks.feedback;
    if (!score) return ['没有可评分的反馈接续'];
    return score.failures;
  } else if (scenario.kind === 'definition') {
    const score = checks.definition;
    if (!score) return ['没有可评分的数据定义'];
    if (score.conventionsPassed < scenario.pass.conventions) {
      const missed = (Object.keys(score.conventions) as ConventionId[]).filter((id) => !score.conventions[id]).map((id) => CONVENTIONS[id]);
      failures.push(`约定 ${score.conventionsPassed}/6，要求至少 ${scenario.pass.conventions}（未过：${missed.join('、')}）`);
    }
    if (score.expertFields.matched < scenario.pass.expertFields) {
      failures.push(`专家字段 ${score.expertFields.matched}/${score.expertFields.of}，要求至少 ${scenario.pass.expertFields}（缺：${score.expertFields.missing.join('、')}）`);
    }
  } else if (scenario.kind === 'template' || scenario.kind === 'revision') {
    if (scenario.kind === 'revision') {
      const scope = checks.revision;
      if (!scope) failures.push('没有可评分的模板修改范围');
      else if (scope.violations.length > scenario.pass.scopeViolations) {
        failures.push(`修改范围违例 ${scope.violations.length}，最多 ${scenario.pass.scopeViolations}（${scope.violations.join('、')}）`);
      }
    }
    const score = checks.template;
    if (!score) return [...failures, '没有可评分的模板'];
    if (score.stressPassed < scenario.pass.stress) {
      failures.push(`压测 ${score.stressPassed}/${score.stress.length}，要求至少 ${scenario.pass.stress}（有严重问题：${score.stress.filter((row) => row.severe > 0).map((row) => row.label).join('、')}）`);
    }
    if (score.layoutPassed < scenario.pass.layoutChecks) {
      const missed = [...(score.landmarkBaseline.pass ? [] : [`地标底线${score.landmarkBaseline.deltaMm === undefined ? `（${score.landmarkBaseline.reason ?? '找不到'}）` : ` ${score.landmarkBaseline.deltaMm} mm`}`]),
        ...(score.roadAlign.pass ? [] : [`道路名对齐 ${score.roadAlign.aligns.join('、') || '找不到'}`])];
      failures.push(`版面检查 ${score.layoutPassed}/2，要求至少 ${scenario.pass.layoutChecks}（未过：${missed.join('、')}）`);
    }
  } else {
    const score = checks.transcription;
    if (!score) return ['没有可评分的数据集'];
    const line = scenario.pass;
    if (score.requiresReview) failures.push(`对齐歧义 ${score.ambiguities.length} 处，需按报告中的候选/真值位置复核；不得自动通过`);
    for (const [key, label] of [['orderViolations', '顺序违例'], ['insertions', '真实插入'], ['duplicates', '超额重复'], ['landmarkExtra', '地标误报'], ['facilityExtra', '设施误报']] as const) {
      if (score.errors[key].length > line[key]) failures.push(`${label} ${score.errors[key].length}，最多 ${line[key]}`);
    }
    if (score.names < line.names) failures.push(`站名 ${score.names}/${score.stops.split('/')[1]}，要求至少 ${line.names}（缺：${score.missing.join('、')}）`);
    if (score.landmarks.matched < line.landmarks) failures.push(`地标 ${score.landmarks.matched}/${score.landmarks.of}，要求至少 ${line.landmarks}`);
    if (score.facilities.matched < line.facilities) failures.push(`设施图标 ${score.facilities.matched}/${score.facilities.of}，要求至少 ${line.facilities}`);
  }
  return failures;
}

/** 门槛结论：incomplete 表示没有有效失败但计划未完成。 */
export type GateStatus = 'pass' | 'fail' | 'incomplete';

/** 某一次的结果；not-run：计划内但没有跑（额度熔断后没发起，或分段跑还没到）。 */
export type RepetitionOutcome = UnitStatus | 'not-run';

export interface GateResult {
  readonly status: GateStatus;
  /** status 为 pass。 */
  readonly pass: boolean;
  /** 有效观测是否覆盖预登记计划，独立于质量结论。 */
  readonly completeness: { readonly planned: number; readonly pass: number; readonly fail: number; readonly invalid: number; readonly notRun: number; readonly complete: boolean };
  readonly scenarios: readonly {
    readonly id: string;
    readonly name: string;
    /** 从第 1 次起各次的结果。 */
    readonly outcomes: readonly RepetitionOutcome[];
    readonly status: GateStatus;
  }[];
}

/** 本次评估计划的场景与次数（评估清单）。 */
export interface GatePlan {
  readonly scenarios: readonly string[];
  readonly repetitions: number;
}

/**
 * 门槛：预登记计划中的有效失败不可被后续成功覆盖；全部计划达线才通过。
 * invalid 与没跑的次数不是有效观测，单独报告完整性。计划次数至少为 consecutivePasses。
 * 整体：有 fail 是 fail；否则有 incomplete（或一个场景都没有）是 incomplete；全部 pass 才是 pass。
 */
export function gate(config: EvalConfig, results: readonly ScenarioResult[], plan?: GatePlan): GateResult {
  const planned = (scenario: Scenario) => (plan ? plan.scenarios.includes(scenario.id) : results.some((result) => result.id === scenario.id));
  const scenarios = config.scenarios.filter(planned).map((scenario) => {
    const own = results.filter((result) => result.id === scenario.id);
    const count = Math.max(config.consecutivePasses, plan?.repetitions ?? 0, ...own.map((result) => result.repetition));
    const outcomes = Array.from({ length: count }, (_, index): RepetitionOutcome => own.find((result) => result.repetition === index + 1)?.status ?? 'not-run');
    const status: GateStatus = outcomes.includes('fail') ? 'fail' : outcomes.every(outcome => outcome === 'pass') ? 'pass' : 'incomplete';
    return { id: scenario.id, name: scenario.name, outcomes, status };
  });
  const status: GateStatus = scenarios.some((scenario) => scenario.status === 'fail') ? 'fail'
    : scenarios.length > 0 && scenarios.every((scenario) => scenario.status === 'pass') ? 'pass' : 'incomplete';
  const outcomes = scenarios.flatMap(scenario => scenario.outcomes);
  const count = (value: RepetitionOutcome) => outcomes.filter(outcome => outcome === value).length;
  return { status, pass: status === 'pass', scenarios, completeness: {
    planned: outcomes.length, pass: count('pass'), fail: count('fail'), invalid: count('invalid'), notRun: count('not-run'),
    complete: outcomes.length > 0 && !outcomes.includes('invalid') && !outcomes.includes('not-run'),
  } };
}

/** 门槛里 invalid 与没跑的次数；有的话返回用同一个 --label 续跑的命令，args 是要原样带上的其他选项。 */
export function resumeCommand(label: string, result: GateResult, args: readonly string[] = []): string | undefined {
  const open = result.scenarios.flatMap((scenario) => scenario.outcomes.flatMap((outcome, index) => (outcome === 'invalid' || outcome === 'not-run' ? [index + 1] : [])));
  if (open.length === 0) return undefined;
  const quote = (value: string) => /^[\w./:@,=+-]+$/.test(value) ? value : `'${value.replaceAll("'", process.platform === 'win32' ? "''" : "'\"'\"'")}'`;
  return ['npx tsx scripts/agent-eval/run.ts', ...['--label', label, '--repetitions', `${Math.min(...open)}-${Math.max(...open)}`, ...args].map(quote)].join(' ');
}

/** /3 起要求全计划达线，完整性与质量分开；旧 /1、/2 只保留历史含义。 */
export interface EvalReport {
  readonly format: 'renderweave-agent-eval/4';
  readonly evidence?: {readonly kind: string; readonly realModelObservations: number; readonly note: string};
  readonly label: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  /** 实际运行的模型、端点与 Claude Code 版本，取自各轮的 round.json。 */
  readonly runtime: { readonly model?: string; readonly smallModel?: string; readonly endpoint?: string; readonly effort?: string | null; readonly servedModels: readonly string[]; readonly servedModelChanged: boolean; readonly requestedModelMismatch: boolean; readonly providerRevision: null; readonly claudeCodeVersions: readonly string[] };
  readonly mcpContract: string;
  /** agent/ 下各资料文件的 SHA-256（前 12 位），用来判断两次评估之间资料是否变了。 */
  readonly materials: Readonly<Record<string, string>>;
  readonly consecutivePasses: number;
  readonly passLines: Readonly<Record<string, unknown>>;
  readonly results: readonly ScenarioResult[];
  readonly gate: GateResult;
  readonly attempts: readonly AttemptSummary[];
  readonly timing: Awaited<ReturnType<typeof evaluationTiming>>;
  readonly totals: { readonly wallMs: number; readonly inputTokens: number; readonly outputTokens: number; readonly thinkingTokens: number; readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number; readonly persistedResults: number; readonly toolCalls: number; readonly unknownUsageAttempts: number;
    readonly unknownByMetric: Readonly<Record<string, number>>; readonly usageComplete: boolean; readonly legacyHistoryUnknown: boolean };
}

interface AttemptSummary {
  readonly id: string; readonly unit: string; readonly stage: string; readonly dir: string; readonly startedAt: string | null; readonly endedAt: string | null;
  readonly elapsedMs: number | null; readonly experiment: string | null; readonly state: 'completed' | 'unresolved' | 'legacy';
  readonly error?: string; readonly usage?: RoundSummary;
}

/** 评估开始时的状态：提交与资料哈希。记进评估清单，重新评分时沿用，不按评分时的工作区算。 */
export interface Provenance {
  readonly git: EvalReport['git'];
  readonly materials: EvalReport['materials'];
}

export async function provenance(): Promise<Provenance> {
  return agentProvenance();
}

export async function buildReport(options: {
  readonly config: EvalConfig; readonly label: string; readonly startedAt: string; readonly outDir: string; readonly results: readonly ScenarioResult[];
  /** 缺省按现在的工作区算。 */
  readonly provenance?: Provenance;
  /** 跑完的时间；重新评分时沿用评估清单中的，缺省为现在。 */
  readonly endedAt?: string;
  /** 评估清单中的场景与次数；缺省按结果算。 */
  readonly plan?: GatePlan;
}): Promise<EvalReport> {
  const origin = options.provenance ?? await provenance();
  const records: RoundRecord[] = [];
  for (const result of options.results) {
    for (const round of result.rounds) {
      try { records.push(JSON.parse(await readFile(join(options.outDir, round.dir, 'round.json'), 'utf8')) as RoundRecord); } catch { /* 没有轮次记录 */ }
    }
  }
  const unique = (values: (string | undefined)[]) => [...new Set(values.filter((value): value is string => value !== undefined))].sort();
  const attempts: AttemptSummary[] = [];
  const planned = options.plan ? options.config.scenarios.filter(scenario => options.plan!.scenarios.includes(scenario.id))
    .flatMap(scenario => Array.from({length: options.plan!.repetitions}, (_, index) => ({id: scenario.id, repetition: index + 1}))) : options.results;
  for (const item of planned) {
    const result = options.results.find(result => result.id === item.id && result.repetition === item.repetition);
    const unit = unitDir(options.outDir, {id: item.id} as Scenario, item.repetition);
    const stored = await savedAttempts(unit);
    for (const attempt of stored) {
      const usage = await summarize(join(attempt.dir, 'round'), options.outDir, attempt.record.task);
      try {const record = JSON.parse(await readFile(join(attempt.dir, 'round/round.json'), 'utf8')); if (record?.run && record?.runtime) records.push(record);} catch { /* 中断没有完整轮次 */ }
      attempts.push({id: attempt.record.id, unit: relative(options.outDir, unit).replaceAll('\\', '/'), stage: attempt.record.stage,
        dir: relative(options.outDir, attempt.dir).replaceAll('\\', '/'), startedAt: attempt.record.startedAt, endedAt: attempt.completion?.endedAt ?? null,
        elapsedMs: attempt.completion?.elapsedMs ?? null, experiment: attempt.record.experiment,
        state: attempt.record.legacy ? 'legacy' : attempt.completion ? 'completed' : 'unresolved',
        ...(attempt.completion?.error ? {error: attempt.completion.error} : {}), ...(usage ? {usage} : {})});
    }
    for (const round of result?.rounds ?? []) if (!stored.some(attempt => attempt.record.stage === round.dir.split('/').at(-1))) {
      attempts.push({id: `legacy:${round.dir}`, unit: relative(options.outDir, unit).replaceAll('\\', '/'), stage: round.dir.split('/').at(-1)!,
        dir: round.dir, startedAt: null, endedAt: null, elapsedMs: null, experiment: null, state: 'legacy', usage: round});
    }
  }
  const metrics = ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheCreationTokens', 'toolCalls', 'persistedResults', 'wallMs'] as const;
  const unknownByMetric = Object.fromEntries(metrics.map(key => [key, attempts.filter(attempt => attempt.usage?.[key] === undefined).length]));
  const unknownUsageAttempts = attempts.filter(attempt => ['inputTokens', 'outputTokens', 'thinkingTokens', 'cacheReadTokens', 'cacheCreationTokens'].some(key => attempt.usage?.[key as keyof RoundSummary] === undefined)).length;
  const sum = (key: typeof metrics[number]) => attempts.reduce((total, attempt) => total + (attempt.usage?.[key] ?? 0), 0);
  const runtime = records[0]?.runtime;
  return {
    evidence: {kind: options.config.evidence ?? 'unverified', realModelObservations: 0, note: '机制结果不计入真实模型验收；真实观测另需冻结候选与执行来源核验'},
    format: 'renderweave-agent-eval/4', label: options.label, startedAt: options.startedAt, endedAt: options.endedAt ?? new Date().toISOString(),
    git: origin.git,
    runtime: {
      ...(runtime ? { model: runtime.model, smallModel: runtime.smallModel, endpoint: runtime.endpoint, effort: runtime.effort ?? null } : {}),
      servedModels: unique(records.map((record) => record.run.servedModel)),
      servedModelChanged: unique(records.map(record => record.run.servedModel)).length > 1,
      requestedModelMismatch: records.some(record => record.run.servedModel !== undefined && record.run.servedModel !== record.runtime.model), providerRevision: null,
      claudeCodeVersions: unique(records.map((record) => record.run.claudeCodeVersion)),
    },
    mcpContract: MCP_CONTRACT_VERSION,
    materials: origin.materials,
    consecutivePasses: options.config.consecutivePasses,
    passLines: Object.fromEntries(options.config.scenarios.map((scenario) => [scenario.id, scenario.pass])),
    results: options.results,
    attempts,
    timing: await evaluationTiming(options.outDir, attempts),
    gate: gate(options.config, options.results, options.plan),
    totals: { wallMs: sum('wallMs'), inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), thinkingTokens: sum('thinkingTokens'),
      cacheReadTokens: sum('cacheReadTokens'), cacheCreationTokens: sum('cacheCreationTokens'), toolCalls: sum('toolCalls'), persistedResults: sum('persistedResults'),
      unknownUsageAttempts, unknownByMetric, usageComplete: unknownUsageAttempts === 0 && attempts.every(attempt => attempt.state === 'completed'), legacyHistoryUnknown: attempts.some(attempt => attempt.state === 'legacy') },
  };
}

const GATE_TEXT: Record<GateStatus, string> = { pass: '通过', fail: '未通过', incomplete: '未完成' };
const OUTCOME_TEXT: Record<RepetitionOutcome, string> = { pass: '达线', fail: '未达线', invalid: 'invalid', 'not-run': '未跑' };

/** 报告的文字摘要：门槛结论、各场景每次的结果与原因、用量。 */
export function formatReport(report: EvalReport): string {
  const lines = [
    `# Agent 评估 ${report.label}：门槛${GATE_TEXT[report.gate.status]}`,
    `证据类别：${report.evidence?.kind === 'mechanism' ? '机制验证' : '模型来源尚需独立核准'}；已核准真实模型观测 ${report.evidence?.realModelObservations ?? 0}。`,
    '',
    `计划 ${report.gate.completeness.planned} 次：通过 ${report.gate.completeness.pass}、失败 ${report.gate.completeness.fail}、无效 ${report.gate.completeness.invalid}、未运行 ${report.gate.completeness.notRun}；执行${report.gate.completeness.complete ? '完整' : '未完成'}。`,
    '',
    `模型 ${report.runtime.model ?? '?'}（服务端 ${report.runtime.servedModels.join('、') || '?'}），Claude Code ${report.runtime.claudeCodeVersions.join('、') || '?'}，MCP 合同 ${report.mcpContract}，提交 ${report.git.commit}${report.git.dirty ? '（有未提交改动）' : ''}。`,
    '',
    `供应商修订未知；服务模型${report.runtime.servedModelChanged ? '在观测间发生变化' : '未观测到变化'}${report.runtime.requestedModelMismatch ? '；实际服务模型与请求模型不同' : ''}。`,
    '',
    '| 场景 | 各次结果 | 门槛 |',
    '|---|---|---|',
    ...report.gate.scenarios.map((scenario) => `| ${scenario.name} | ${scenario.outcomes.map((outcome) => OUTCOME_TEXT[outcome]).join('、')} | ${GATE_TEXT[scenario.status]} |`),
    '',
  ];
  for (const result of report.results) {
    const usage = result.rounds.map((round) => `${AGENT_TASKS[round.task].name} ${((round.wallMs ?? 0) / 60000).toFixed(1)} 分钟 / ${round.turns ?? '?'} 轮 / 输出 ${round.outputTokens ?? '?'}` +
      `${round.firstCheckProblems !== undefined ? ` / 首次模板检查 ${round.firstCheckProblems} 个问题` : ''}${round.persistedResults ? ` / 转存 ${round.persistedResults} 次` : ''}`).join('；');
    lines.push(`- ${result.name} 第 ${result.repetition} 次：${OUTCOME_TEXT[result.status]}${result.retries > 0 ? `（重试 ${result.retries} 次）` : ''}。${usage}`);
    if (result.checks.revision && result.checks.template) {
      const { revision, template } = result.checks;
      lines.push(`  - 压测 ${template.stressPassed}/${template.stress.length}；版面 ${template.layoutPassed}/2；修改范围违例 ${revision.violations.length}；改动元素 ${revision.changedElements}`);
    }
    if (result.checks.transcription) {
      const score = result.checks.transcription;
      lines.push(`  - 转录评分器 ${score.scorer.version}，匹配政策 ${score.scorer.matchingPolicy.id}；站名 ${score.names}/${score.stops.split('/')[1]}，地标 ${score.landmarks.matched}/${score.landmarks.of}，设施 ${score.facilities.matched}/${score.facilities.of}；逐次出现的对齐与错误位置见报告 checks.transcription`);
    }
    if (result.invalid) lines.push(`  - ${invalidText(result.invalid)}`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }
  lines.push('', `全部尝试已知小计 ${(report.totals.wallMs / 60000).toFixed(1)} 分钟（各轮之和），输入 ${report.totals.inputTokens}、输出 ${report.totals.outputTokens} tokens，其中思考 ${report.totals.thinkingTokens}（不再加到输出）；缓存读/写 ${report.totals.cacheReadTokens}/${report.totals.cacheCreationTokens}。`,
    `用量有未知字段的已保存尝试 ${report.totals.unknownUsageAttempts} 个；${report.totals.usageComplete ? '已保存尝试的token用量完整' : '不能把已知小计当成完整成本'}${report.totals.legacyHistoryUnknown ? '；历史已删除尝试的数量和用量未知' : ''}。`);
  lines.push(`实际派发会话墙钟 ${report.timing.actualWallMs === null ? '未知' : (report.timing.actualWallMs / 60000).toFixed(1) + ' 分钟'}；尝试耗时已知求和 ${(report.timing.attemptsElapsedMs / 60000).toFixed(1)} 分钟，${report.timing.unknownAttemptDurations} 个尝试耗时未知。`);
  if (report.totals.persistedResults) lines.push(`有 ${report.totals.persistedResults} 次工具结果超过 Claude Code 的上限被转存或拒收：MCP 工具的输出应在 40,000 字符以内（票据 22）。`);
  return lines.join('\n');
}

/**
 * 评估中模拟审核人：待确认项全部采纳、整体确认、通过，并应用到 workspace。返回主数据定义（含站点列表的那份）的名称。
 * 续跑时这一轮已经应用过（第二轮因上游错误 invalid），不再审核与应用。
 */
async function approveDefinitions(roundDir: string, workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  const opened = await readReview(roundDir);
  if (!opened.view) throw new Error(`数据定义一轮没有可审核的成果，不能接着做数据集提取：${opened.problems.map((problem) => problem.message).join('；')}`);
  if (!opened.view.applied) {
    for (const item of opened.view.pending) await changeReview(roundDir, { type: 'decide', item: item.item, action: 'adopt' });
    await changeReview(roundDir, { type: 'confirmRest', confirmed: true });
    const approved = await changeReview(roundDir, { type: 'approve', comment: '评估：待确认项全部采纳' });
    if (approved.problems.length > 0) throw new Error(`数据定义审核不能通过：${approved.problems.map((problem) => problem.message).join('；')}`);
    const applied = await applyAgentRound({ roundDir, workspace });
    if (!applied.applied) throw new Error(`数据定义应用失败：${applied.problems.map((problem) => problem.message).join('；')}`);
  }
  const route = opened.view.candidates.find((candidate) => candidate.kind === 'definition' && hasListOfRef(candidate.document));
  const name = route?.published?.name ?? route?.name;
  if (!name) throw new Error('成果中没有含站点列表的数据定义');
  return name;
}

async function candidates(roundDir: string): Promise<{ kind: string; document: unknown }[]> {
  const outcome = JSON.parse(await readFile(join(roundDir, 'outcome.json'), 'utf8')) as RoundOutcome;
  return Promise.all(outcome.candidates.map(async (candidate) => ({ kind: candidate.kind, document: JSON.parse(await readFile(join(roundDir, candidate.path), 'utf8')) as unknown })));
}

/** check.json 中的严重问题，取前两条写进没达线的原因。 */
async function severeReasons(roundDir: string): Promise<string> {
  try {
    const check = JSON.parse(await readFile(join(roundDir, 'check.json'), 'utf8')) as { problems: { level: string; message: string }[]; candidates: { problems: { level: string; message: string }[] }[] };
    const messages = [...check.problems, ...check.candidates.flatMap((candidate) => candidate.problems)].filter((problem) => problem.level === 'severe').map((problem) => problem.message);
    return messages.length === 0 ? '' : `：${messages.slice(0, 2).join('；')}${messages.length > 2 ? ` 等 ${messages.length} 条` : ''}`;
  } catch {
    return '';
  }
}

/** Agent 工作目录 candidates/ 下的数据定义（结构不合格、没有轮次成果时用）。 */
async function submittedDefinitions(dir: string): Promise<unknown[]> {
  let files: string[];
  try { files = (await readdir(dir, { recursive: true })).map(String).filter((file) => file.endsWith('.json')).sort(); } catch { return []; }
  const documents: unknown[] = [];
  for (const file of files) {
    try {
      const document = JSON.parse(await readFile(join(dir, file), 'utf8')) as { dslVersion?: unknown };
      if (String(document.dslVersion ?? '').startsWith('renderweave-schema/')) documents.push(document);
    } catch { /* 不是有效的 JSON，跳过 */ }
  }
  return documents;
}

function hasListOfRef(document: unknown): boolean {
  const fields = (document as { fields?: { type?: string; items?: { type?: string } }[] } | undefined)?.fields;
  return Array.isArray(fields) && fields.some((field) => field.type === 'list' && field.items?.type === 'ref');
}

function execute(command: string, args: readonly string[], cwd = REPO): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}
