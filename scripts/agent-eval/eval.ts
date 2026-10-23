import { agentProvenance } from '../../src/agent/provenance.js';
/**
 * 评估的编排（第三阶段票据 08、验收 A10）：经产品路径（renderweave agent 与 renderweave mcp）发起各场景的轮次，
 * 评分并与通过线对照；每个场景连续 consecutivePasses 次达线才算通过。报告只存摘要，不存图片与日志。
 *
 * 366 场景要两轮：数据定义提取之后，模拟审核人全部采纳待确认项、审核通过并应用到场景自己的工作区，再做数据集提取。
 * 这只是评估中的模拟，产品本身不自动审核、不自动应用。
 *
 * 上游错误（票据 21）：模型服务的 500/529 与连接中断按轮次重试；额度窗口的 429 停止派发剩下的单元。
 * 仍拿不到有效结果的单元记为 invalid：它不是一次观测，既不算达线，也不算模型没做出来。
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AGENT_TASKS, applyAgentRound, changeReview, loadWorkspace, readReview, type AgentTaskId, type RoundOutcome, type RoundRecord } from '../../src/index.js';
import { MCP_CONTRACT_VERSION } from '../../src/mcp/tools.js';
import { REPO, repoPath, type EvalConfig, type Scenario } from './scenarios.js';
import {
  CONVENTIONS, scoreDefinitions, scoreRevision, scoreTemplates, scoreTranscription, stopsOf,
  type ConventionId, type DefinitionScore, type RevisionScore, type TemplateScore, type TranscriptionScore, type TruthStop,
} from './score.js';

export interface RoundSpec {
  readonly task: AgentTaskId;
  /** 新的轮次目录。 */
  readonly out: string;
  readonly sample: string;
  readonly brief: string;
  readonly resources: string;
  readonly domain?: string;
  readonly workspace?: string;
  readonly definition?: string;
  readonly dataset?: string;
  readonly request?: string;
  readonly requirement?: string;
}

/** 发起一轮：结束后轮次目录里有 round.json，结构合格时另有 outcome.json。用法错误时抛出。 */
export type Launcher = (spec: RoundSpec) => Promise<void>;

export interface RuntimeOptions {
  readonly model?: string;
  readonly smallModel?: string;
  readonly endpoint?: string;
  readonly keyEnv?: string;
  readonly maxTurns?: number;
  /** 推理力度，透传给 agent run 的 --effort（票据 23）。 */
  readonly effort?: string;
}

/** 缺省的发起方式：调用构建好的命令行 node dist/bin.js agent run，key 由命令行从环境变量读取。输出写在轮次目录旁的 .log。 */
export function cliLauncher(runtime: RuntimeOptions = {}): Launcher {
  return async (spec) => {
    const flag = (name: string, value: string | number | undefined) => (value === undefined ? [] : [`--${name}`, String(value)]);
    const args = [
      join(REPO, 'dist/bin.js'), 'agent', 'run', '--task', spec.task, '--sample', spec.sample, '--brief', spec.brief,
      '--resources', spec.resources, '--out', spec.out, ...flag('domain', spec.domain), ...flag('workspace', spec.workspace),
      ...flag('definition', spec.definition), ...flag('dataset', spec.dataset), ...flag('request', spec.request), ...flag('requirement', spec.requirement),
      ...flag('model', runtime.model), ...flag('small-model', runtime.smallModel), ...flag('endpoint', runtime.endpoint),
      ...flag('key-env', runtime.keyEnv), ...flag('max-turns', runtime.maxTurns), ...flag('effort', runtime.effort),
    ];
    const result = await execute(process.execPath, args);
    await writeFile(`${spec.out}.log`, `${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 && result.code !== 1) throw new Error(`发起${AGENT_TASKS[spec.task].name}失败（退出码 ${String(result.code)}）：${result.stderr.trim()}`);
  };
}

/** 上游错误的分类：transient 按轮次重试；quota 停止派发剩下的单元；other（参数错误、缺 key、执行器无法启动）照旧算未达线。 */
export type ErrorKind = 'transient' | 'quota' | 'other';

const QUOTA = /\b429\b|rate[_ ]?limit|quota|usage limit/i;
const TRANSIENT = /\b(?:500|502|503|529)\b|overloaded|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** 按 round.json 的 run.error 或发起失败的文字分类，大小写不敏感。两类字样都有时按额度算，不在关着的额度窗口上重试。 */
export function classifyError(text: string): ErrorKind {
  if (QUOTA.test(text)) return 'quota';
  if (TRANSIENT.test(text)) return 'transient';
  return 'other';
}

/** 瞬时错误后每次重试前等多久；长度就是最多重试几次。Claude Code 自己已经重试过，外层两次就够。 */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 180_000];

export interface RetryOptions {
  /** 按 RETRY_DELAYS_MS 等待；离线测试注入，不真的等。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 进度输出（重试、跳过、额度熔断），缺省不输出。 */
  readonly log?: (message: string) => void;
}

/** 单元拿不到有效结果的原因。 */
export interface InvalidReason {
  /** transient：瞬时错误重试用完；quota：额度限制，不重试。 */
  readonly kind: 'transient' | 'quota';
  readonly task: AgentTaskId;
  readonly error: string;
}

/** 上游错误的记录，写在场景目录里，重新评分时读回：每次重试的轮次与原因，拿不到有效结果时的 invalid 原因。 */
export const UPSTREAM_ERRORS = 'upstream-errors.json';

interface UpstreamRecord {
  readonly retries: { readonly task: AgentTaskId; readonly error: string }[];
  invalid?: InvalidReason;
}

export interface RoundSummary {
  readonly task: AgentTaskId;
  /** 相对评估输出目录。 */
  readonly dir: string;
  /** missing：没有轮次记录（发起失败）。 */
  readonly verdict: RoundRecord['verdict'] | 'missing';
  readonly wallMs?: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thinkingTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly endedBy?: string;
  readonly pending?: number;
  readonly toolCalls?: number;
  readonly toolErrors?: number;
  /** 被 Claude Code 转存（<persisted-output>）或因过大拒收的工具结果数（票据 22）。 */
  readonly persistedResults?: number;
  /** 第一次 check_templates 的问题数（票据 27）。 */
  readonly firstCheckProblems?: number;
  /** 执行器无法启动或模型服务报错（如额度用完）。 */
  readonly error?: string;
}

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
  const unit = unitDir(outDir, scenario, repetition);
  await mkdir(unit, { recursive: true });
  const upstream: UpstreamRecord = { retries: (await readUpstream(unit)).retries };
  await rm(join(unit, LAUNCH_FAILURES), { force: true });
  const base = { sample: repoPath(scenario.sample), brief: repoPath(scenario.brief), resources: repoPath(config.resources), ...(scenario.domain ? { domain: scenario.domain } : {}) };
  const round = (spec: RoundSpec) => launchRound(spec, launch, { ...retry, upstream, unit, label: `${scenario.name} 第 ${repetition} 次` });
  const failures: string[] = [];
  try {
    if (scenario.kind === 'definition') {
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
  return !(await exists(unit)) || (await readUpstream(unit)).invalid !== undefined;
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
  await Promise.all(Array.from({ length: Math.min(options.jobs ?? 1, queue.length) }, async () => {
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
  }));
  return { results, skipped, held: queue };
}

/** 发起一轮时抛出：上游错误使这个单元拿不到有效结果。 */
class InvalidUnit extends Error {
  constructor(readonly reason: InvalidReason) {
    super(reason.error);
  }
}

/**
 * 发起一轮。瞬时错误只删掉这一个轮次目录再发起（agent run 要求目录为空），单元里已完成的轮次与已应用的工作区不动；
 * 重试用完或遇到额度限制时抛出 InvalidUnit。其他错误照旧：发起失败抛出原错误，轮次记录里的错误留给评分。
 * 续跑时这一轮已有有效轮次记录就不再发起。
 */
async function launchRound(spec: RoundSpec, launch: Launcher, context: RetryOptions & { upstream: UpstreamRecord; unit: string; label: string }): Promise<void> {
  if ((await roundError(spec.out)) === null) return;
  for (let attempt = 0; ; attempt++) {
    await rm(spec.out, { recursive: true, force: true });
    let failure: { kind: ErrorKind; error: string } | null | undefined, thrown: unknown;
    try {
      await launch(spec);
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
    if (kind === 'transient' || kind === 'quota') throw new InvalidUnit({ kind, task: spec.task, error: error! });
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
  try { record = JSON.parse(await readFile(join(dir, 'round.json'), 'utf8')) as RoundRecord; } catch { return undefined; }
  if (record.run.stopped?.reason === 'hardQuota') return { kind: 'quota', error: record.run.error ?? `硬额度耗尽（${record.run.stopped.limit}）` };
  const error = record.verdict === 'qualified' ? undefined : record.run.error;
  const kind = error !== undefined ? classifyError(error) : 'other';
  return error !== undefined && kind !== 'other' ? { kind, error } : null;
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
  return `${AGENT_TASKS[reason.task].name}一轮${reason.kind === 'quota' ? '遇到额度限制' : '上游瞬时错误重试用完'}：${reason.error}`;
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
  const names = scenario.kind === 'transcription' ? ['definition', 'dataset'] : [scenario.kind];
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
    const view = (await readReview(join(unit, 'dataset'))).view;
    const dataset = view?.candidates.find((candidate) => candidate.kind === 'dataset')?.document;
    const truth = (JSON.parse(await readFile(repoPath(scenario.truth), 'utf8')) as { stops: TruthStop[] }).stops;
    Object.assign(checks, { transcription: scoreTranscription(stopsOf(dataset), truth) });
  }
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
  if (scenario.kind === 'definition') {
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
    if (score.names < line.names) failures.push(`站名 ${score.names}/${score.stops.split('/')[1]}，要求至少 ${line.names}（缺：${score.missing.join('、')}）`);
    if (score.landmarks.matched < line.landmarks) failures.push(`地标 ${score.landmarks.matched}/${score.landmarks.of}，要求至少 ${line.landmarks}`);
    if (score.facilities.matched < line.facilities) failures.push(`设施图标 ${score.facilities.matched}/${score.facilities.of}，要求至少 ${line.facilities}`);
  }
  return failures;
}

/** 门槛结论：incomplete 表示有效次数还凑不出结论，补跑 invalid 与没跑的次数后才知道。 */
export type GateStatus = 'pass' | 'fail' | 'incomplete';

/** 某一次的结果；not-run：计划内但没有跑（额度熔断后没发起，或分段跑还没到）。 */
export type RepetitionOutcome = UnitStatus | 'not-run';

export interface GateResult {
  readonly status: GateStatus;
  /** status 为 pass。 */
  readonly pass: boolean;
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
 * 门槛：每个场景在本次评估中有连续 consecutivePasses 次达线。
 * invalid 与没跑的次数不是观测，算连续时跳过，不打断也不延长连续。没有连续达线时，把它们都当作达线也凑不出来的是 fail，
 * 凑得出来的是 incomplete。计划的次数至少是 consecutivePasses；缺省按结果中出现的场景与次数算。
 * 整体：有 fail 是 fail；否则有 incomplete（或一个场景都没有）是 incomplete；全部 pass 才是 pass。
 */
export function gate(config: EvalConfig, results: readonly ScenarioResult[], plan?: GatePlan): GateResult {
  const planned = (scenario: Scenario) => (plan ? plan.scenarios.includes(scenario.id) : results.some((result) => result.id === scenario.id));
  const scenarios = config.scenarios.filter(planned).map((scenario) => {
    const own = results.filter((result) => result.id === scenario.id);
    const count = Math.max(config.consecutivePasses, plan?.repetitions ?? 0, ...own.map((result) => result.repetition));
    const outcomes = Array.from({ length: count }, (_, index): RepetitionOutcome => own.find((result) => result.repetition === index + 1)?.status ?? 'not-run');
    const longest = (unknownPasses: boolean) => {
      let streak = 0, best = 0;
      for (const outcome of outcomes) {
        if (outcome === 'fail') streak = 0;
        else if (outcome === 'pass' || unknownPasses) streak += 1;
        best = Math.max(best, streak);
      }
      return best;
    };
    const status: GateStatus = longest(false) >= config.consecutivePasses ? 'pass' : longest(true) >= config.consecutivePasses ? 'incomplete' : 'fail';
    return { id: scenario.id, name: scenario.name, outcomes, status };
  });
  const status: GateStatus = scenarios.some((scenario) => scenario.status === 'fail') ? 'fail'
    : scenarios.length > 0 && scenarios.every((scenario) => scenario.status === 'pass') ? 'pass' : 'incomplete';
  return { status, pass: status === 'pass', scenarios };
}

/** 门槛里 invalid 与没跑的次数；有的话返回用同一个 --label 续跑的命令，args 是要原样带上的其他选项。 */
export function resumeCommand(label: string, result: GateResult, args: readonly string[] = []): string | undefined {
  const open = result.scenarios.flatMap((scenario) => scenario.outcomes.flatMap((outcome, index) => (outcome === 'invalid' || outcome === 'not-run' ? [index + 1] : [])));
  if (open.length === 0) return undefined;
  const quote = (value: string) => (/^[\w./:@,=+-]+$/.test(value) ? value : `"${value}"`);
  return ['npx tsx scripts/agent-eval/run.ts', ...['--label', label, '--repetitions', `${Math.min(...open)}-${Math.max(...open)}`, ...args].map(quote)].join(' ');
}

/** 报告格式。/2 起（票据 21）每个单元有 status 与重试次数，门槛有 incomplete，各次结果是 outcomes 而不是 /1 的 passes。 */
export interface EvalReport {
  readonly format: 'renderweave-agent-eval/2';
  readonly label: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  /** 实际运行的模型、端点与 Claude Code 版本，取自各轮的 round.json。 */
  readonly runtime: { readonly model?: string; readonly smallModel?: string; readonly endpoint?: string; readonly effort?: string | null; readonly servedModels: readonly string[]; readonly claudeCodeVersions: readonly string[] };
  readonly mcpContract: string;
  /** agent/ 下各资料文件的 SHA-256（前 12 位），用来判断两次评估之间资料是否变了。 */
  readonly materials: Readonly<Record<string, string>>;
  readonly consecutivePasses: number;
  readonly passLines: Readonly<Record<string, unknown>>;
  readonly results: readonly ScenarioResult[];
  readonly gate: GateResult;
  readonly totals: { readonly wallMs: number; readonly inputTokens: number; readonly outputTokens: number; readonly thinkingTokens: number; readonly cacheReadTokens: number; readonly persistedResults: number };
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
  const rounds = options.results.flatMap((result) => result.rounds);
  const sum = (pick: (round: RoundSummary) => number | undefined) => rounds.reduce((total, round) => total + (pick(round) ?? 0), 0);
  const runtime = records[0]?.runtime;
  return {
    format: 'renderweave-agent-eval/2', label: options.label, startedAt: options.startedAt, endedAt: options.endedAt ?? new Date().toISOString(),
    git: origin.git,
    runtime: {
      ...(runtime ? { model: runtime.model, smallModel: runtime.smallModel, endpoint: runtime.endpoint, effort: runtime.effort ?? null } : {}),
      servedModels: unique(records.map((record) => record.run.servedModel)), claudeCodeVersions: unique(records.map((record) => record.run.claudeCodeVersion)),
    },
    mcpContract: MCP_CONTRACT_VERSION,
    materials: origin.materials,
    consecutivePasses: options.config.consecutivePasses,
    passLines: Object.fromEntries(options.config.scenarios.map((scenario) => [scenario.id, scenario.pass])),
    results: options.results,
    gate: gate(options.config, options.results, options.plan),
    totals: { wallMs: sum((round) => round.wallMs), inputTokens: sum((round) => round.inputTokens), outputTokens: sum((round) => round.outputTokens),
      thinkingTokens: sum((round) => round.thinkingTokens), cacheReadTokens: sum((round) => round.cacheReadTokens),
      persistedResults: sum((round) => round.persistedResults) },
  };
}

const GATE_TEXT: Record<GateStatus, string> = { pass: '通过', fail: '未通过', incomplete: '未完成' };
const OUTCOME_TEXT: Record<RepetitionOutcome, string> = { pass: '达线', fail: '未达线', invalid: 'invalid', 'not-run': '未跑' };

/** 报告的文字摘要：门槛结论、各场景每次的结果与原因、用量。 */
export function formatReport(report: EvalReport): string {
  const lines = [
    `# Agent 评估 ${report.label}：门槛${GATE_TEXT[report.gate.status]}`,
    '',
    `模型 ${report.runtime.model ?? '?'}（服务端 ${report.runtime.servedModels.join('、') || '?'}），Claude Code ${report.runtime.claudeCodeVersions.join('、') || '?'}，MCP 合同 ${report.mcpContract}，提交 ${report.git.commit}${report.git.dirty ? '（有未提交改动）' : ''}。`,
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
    if (result.invalid) lines.push(`  - ${invalidText(result.invalid)}`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }
  lines.push('', `合计 ${(report.totals.wallMs / 60000).toFixed(1)} 分钟（各轮之和），输出 ${report.totals.outputTokens} tokens，其中思考 ${report.totals.thinkingTokens}。`);
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

async function summarize(dir: string, outDir: string): Promise<RoundSummary | undefined> {
  let record: RoundRecord;
  try {
    record = JSON.parse(await readFile(join(dir, 'round.json'), 'utf8')) as RoundRecord;
  } catch {
    return undefined;
  }
  let outcome: RoundOutcome | undefined;
  try { outcome = JSON.parse(await readFile(join(dir, 'outcome.json'), 'utf8')) as RoundOutcome; } catch { outcome = undefined; }
  let toolCalls: number | undefined, toolErrors: number | undefined, firstCheckProblems: number | undefined;
  try {
    const calls = (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { tool?: string; isError?: boolean; problems?: number });
    toolCalls = calls.length;
    toolErrors = calls.filter((call) => call.isError).length;
    firstCheckProblems = calls.find((call) => call.tool === 'check_templates' && !call.isError)?.problems;
  } catch { /* 没有工具调用日志 */ }
  const persistedResults = await countPersisted(join(dir, 'logs/stream.jsonl'));
  const run = record.run;
  const pick = <K extends keyof typeof run>(key: K) => (run[key] === undefined ? {} : { [key]: run[key] });
  return {
    task: record.task, dir: relative(outDir, dir).replaceAll('\\', '/'), verdict: record.verdict,
    ...pick('wallMs'), ...pick('turns'), ...pick('inputTokens'), ...pick('outputTokens'), ...pick('thinkingTokens'), ...pick('cacheReadTokens'), ...pick('cacheCreationTokens'), ...pick('endedBy'),
    ...(outcome ? { pending: outcome.pending.length } : {}), ...(toolCalls !== undefined ? { toolCalls, toolErrors } : {}),
    ...(persistedResults !== undefined ? { persistedResults } : {}), ...(firstCheckProblems !== undefined ? { firstCheckProblems } : {}),
    ...(run.error ? { error: run.error } : {}),
  } as RoundSummary;
}

/** 流式日志里被 Claude Code 转存成文件、或因过大被拒收的工具结果数；没有日志时为 undefined（票据 22）。 */
export async function countPersisted(file: string): Promise<number | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  let count = 0;
  for (const line of text.split('\n')) {
    let message: { type?: string; message?: { content?: unknown } };
    try { message = JSON.parse(line) as typeof message; } catch { continue; }
    if (message.type !== 'user' || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content as { type?: string; content?: unknown }[]) {
      if (block.type === 'tool_result' && /<persisted-output>|exceeds maximum allowed tokens/.test(JSON.stringify(block.content ?? ''))) count++;
    }
  }
  return count;
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
