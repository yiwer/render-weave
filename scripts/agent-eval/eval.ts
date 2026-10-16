/**
 * 评估的编排（第三阶段票据 08、验收 A10）：经产品路径（renderweave agent 与 renderweave mcp）发起各场景的轮次，
 * 评分并与通过线对照；每个场景连续 consecutivePasses 次达线才算通过。报告只存摘要，不存图片与日志。
 *
 * 366 场景要两轮：数据定义提取之后，模拟审核人全部采纳待确认项、审核通过并应用到场景自己的工作区，再做数据集提取。
 * 这只是评估中的模拟，产品本身不自动审核、不自动应用。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { AGENT_TASKS, applyAgentRound, changeReview, readReview, type AgentTaskId, type RoundOutcome, type RoundRecord } from '../../src/index.js';
import { MCP_CONTRACT_VERSION } from '../../src/mcp/tools.js';
import { REPO, repoPath, type EvalConfig, type Scenario } from './scenarios.js';
import {
  CONVENTIONS, scoreDefinitions, scoreTemplates, scoreTranscription, stopsOf,
  type ConventionId, type DefinitionScore, type TemplateScore, type TranscriptionScore, type TruthStop,
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
}

/** 发起一轮：结束后轮次目录里有 round.json，结构合格时另有 outcome.json。用法错误时抛出。 */
export type Launcher = (spec: RoundSpec) => Promise<void>;

export interface RuntimeOptions {
  readonly model?: string;
  readonly smallModel?: string;
  readonly endpoint?: string;
  readonly keyEnv?: string;
  readonly maxTurns?: number;
}

/** 缺省的发起方式：调用构建好的命令行 node dist/bin.js agent run，key 由命令行从环境变量读取。输出写在轮次目录旁的 .log。 */
export function cliLauncher(runtime: RuntimeOptions = {}): Launcher {
  return async (spec) => {
    const flag = (name: string, value: string | number | undefined) => (value === undefined ? [] : [`--${name}`, String(value)]);
    const args = [
      join(REPO, 'dist/bin.js'), 'agent', 'run', '--task', spec.task, '--sample', spec.sample, '--brief', spec.brief,
      '--resources', spec.resources, '--out', spec.out, ...flag('domain', spec.domain), ...flag('workspace', spec.workspace),
      ...flag('definition', spec.definition), ...flag('dataset', spec.dataset), ...flag('request', spec.request),
      ...flag('model', runtime.model), ...flag('small-model', runtime.smallModel), ...flag('endpoint', runtime.endpoint),
      ...flag('key-env', runtime.keyEnv), ...flag('max-turns', runtime.maxTurns),
    ];
    const result = await execute(process.execPath, args);
    await writeFile(`${spec.out}.log`, `${result.stdout}\n${result.stderr}`);
    if (result.code !== 0 && result.code !== 1) throw new Error(`发起${AGENT_TASKS[spec.task].name}失败（退出码 ${String(result.code)}）：${result.stderr.trim()}`);
  };
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
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly endedBy?: string;
  readonly pending?: number;
  readonly toolCalls?: number;
  readonly toolErrors?: number;
  /** 执行器无法启动或模型服务报错（如额度用完）。 */
  readonly error?: string;
}

export interface ScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly repetition: number;
  readonly pass: boolean;
  /** 没达线的原因，逐条。 */
  readonly failures: readonly string[];
  readonly rounds: readonly RoundSummary[];
  readonly checks: {
    readonly definition?: DefinitionScore;
    readonly template?: TemplateScore;
    readonly transcription?: TranscriptionScore;
  };
}

/** 发起阶段的失败（发起命令报错、审核或应用不成），写在场景目录里。 */
export const LAUNCH_FAILURES = 'launch-failures.json';

/** 一个场景在 outDir 下的目录：run-<第几次>/<场景>/，其中是各轮的轮次目录与场景自己的工作区。 */
export function unitDir(outDir: string, scenario: Scenario, repetition: number): string {
  return join(outDir, `run-${repetition}`, scenario.id);
}

/** 跑一个场景的一次：发起所需的轮次，然后评分。 */
export async function runScenario(config: EvalConfig, scenario: Scenario, repetition: number, outDir: string, launch: Launcher): Promise<ScenarioResult> {
  const unit = unitDir(outDir, scenario, repetition);
  await mkdir(unit, { recursive: true });
  const base = { sample: repoPath(scenario.sample), brief: repoPath(scenario.brief), resources: repoPath(config.resources), ...(scenario.domain ? { domain: scenario.domain } : {}) };
  const failures: string[] = [];
  try {
    if (scenario.kind === 'definition') {
      await launch({ ...base, task: 'definition-extraction', out: join(unit, 'definition') });
    } else if (scenario.kind === 'template') {
      const workspace = join(unit, 'workspace');
      await mkdir(workspace, { recursive: true });
      for (const file of scenario.workspace.files) await copyFile(join(repoPath(scenario.workspace.from), file), join(workspace, file));
      await launch({ ...base, task: 'template-design', out: join(unit, 'template'), workspace, dataset: scenario.dataset, request: repoPath(scenario.request) });
    } else {
      await launch({ ...base, task: 'definition-extraction', out: join(unit, 'definition') });
      const definition = await approveDefinitions(join(unit, 'definition'), join(unit, 'workspace'));
      await launch({ ...base, brief: repoPath(scenario.datasetBrief), task: 'dataset-extraction', out: join(unit, 'dataset'), workspace: join(unit, 'workspace'), definition });
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    // 重新评分时要带上发起阶段的失败。
    await writeFile(join(unit, LAUNCH_FAILURES), `${JSON.stringify(failures, null, 2)}\n`);
  }
  return scoreScenario(config, scenario, repetition, outDir, failures);
}

/** 按已有的轮次目录评分；重新评分（--rescore）也用它，发起阶段的失败从 launch-failures.json 读回。 */
export async function scoreScenario(config: EvalConfig, scenario: Scenario, repetition: number, outDir: string, earlier?: readonly string[]): Promise<ScenarioResult> {
  const unit = unitDir(outDir, scenario, repetition);
  let launched: readonly string[] = earlier ?? [];
  if (earlier === undefined) {
    try { launched = JSON.parse(await readFile(join(unit, LAUNCH_FAILURES), 'utf8')) as string[]; } catch { launched = []; }
  }
  const failures = [...launched];
  const names = scenario.kind === 'definition' ? ['definition'] : scenario.kind === 'template' ? ['template'] : ['definition', 'dataset'];
  const rounds: RoundSummary[] = [];
  for (const name of names) {
    const summary = await summarize(join(unit, name), outDir);
    if (summary) rounds.push(summary);
  }
  for (const round of rounds) {
    if (round.verdict !== 'qualified') failures.push(`${AGENT_TASKS[round.task].name}一轮的成果不合格${round.error ? `（${round.error}）` : ''}${await severeReasons(join(outDir, round.dir))}`);
  }
  const checks: ScenarioResult['checks'] = {};
  const definitionRound = join(unit, 'definition');
  if (scenario.kind !== 'template') {
    // 结构不合格时没有轮次成果：仍按 Agent 交回的原样文件评分，只作诊断，结论照样不合格。
    const documents = await exists(join(definitionRound, 'outcome.json'))
      ? (await candidates(definitionRound)).filter((entry) => entry.kind === 'definition').map((entry) => entry.document)
      : await submittedDefinitions(join(definitionRound, 'agent/candidates'));
    if (documents.length > 0) Object.assign(checks, { definition: scoreDefinitions(documents) });
  }
  if (scenario.kind === 'template' && await exists(join(unit, 'template', 'outcome.json'))) {
    const request = JSON.parse(await readFile(join(unit, 'template', 'request.json'), 'utf8')) as { template: string };
    const templates = (await candidates(join(unit, 'template'))).filter((entry) => entry.kind === 'template')
      .map((entry) => ({ name: String((entry.document as { name: unknown }).name), document: entry.document }));
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
  return { id: scenario.id, name: scenario.name, repetition, pass: failures.length === 0, failures, rounds, checks };
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
  } else if (scenario.kind === 'template') {
    const score = checks.template;
    if (!score) return ['没有可评分的模板'];
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

export interface GateResult {
  readonly pass: boolean;
  readonly scenarios: readonly { readonly id: string; readonly name: string; readonly passes: readonly boolean[]; readonly pass: boolean }[];
}

/** 门槛：每个场景在本次评估中有连续 consecutive 次达线。 */
export function gate(config: EvalConfig, results: readonly ScenarioResult[]): GateResult {
  const scenarios = config.scenarios.filter((scenario) => results.some((result) => result.id === scenario.id)).map((scenario) => {
    const passes = results.filter((result) => result.id === scenario.id).sort((a, b) => a.repetition - b.repetition).map((result) => result.pass);
    let streak = 0, best = 0;
    for (const pass of passes) { streak = pass ? streak + 1 : 0; best = Math.max(best, streak); }
    return { id: scenario.id, name: scenario.name, passes, pass: best >= config.consecutivePasses };
  });
  return { pass: scenarios.length > 0 && scenarios.every((scenario) => scenario.pass), scenarios };
}

export interface EvalReport {
  readonly format: 'renderweave-agent-eval/1';
  readonly label: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly git: { readonly commit: string; readonly dirty: boolean };
  /** 实际运行的模型、端点与 Claude Code 版本，取自各轮的 round.json。 */
  readonly runtime: { readonly model?: string; readonly smallModel?: string; readonly endpoint?: string; readonly servedModels: readonly string[]; readonly claudeCodeVersions: readonly string[] };
  readonly mcpContract: string;
  /** agent/ 下各资料文件的 SHA-256（前 12 位），用来判断两次评估之间资料是否变了。 */
  readonly materials: Readonly<Record<string, string>>;
  readonly consecutivePasses: number;
  readonly passLines: Readonly<Record<string, unknown>>;
  readonly results: readonly ScenarioResult[];
  readonly gate: GateResult;
  readonly totals: { readonly wallMs: number; readonly inputTokens: number; readonly outputTokens: number; readonly cacheReadTokens: number };
}

/** 评估开始时的状态：提交与资料哈希。记进评估清单，重新评分时沿用，不按评分时的工作区算。 */
export interface Provenance {
  readonly git: EvalReport['git'];
  readonly materials: EvalReport['materials'];
}

export async function provenance(): Promise<Provenance> {
  return { git: await gitState(), materials: await materialHashes() };
}

export async function buildReport(options: {
  readonly config: EvalConfig; readonly label: string; readonly startedAt: string; readonly outDir: string; readonly results: readonly ScenarioResult[];
  /** 缺省按现在的工作区算。 */
  readonly provenance?: Provenance;
  /** 跑完的时间；重新评分时沿用评估清单中的，缺省为现在。 */
  readonly endedAt?: string;
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
    format: 'renderweave-agent-eval/1', label: options.label, startedAt: options.startedAt, endedAt: options.endedAt ?? new Date().toISOString(),
    git: origin.git,
    runtime: {
      ...(runtime ? { model: runtime.model, smallModel: runtime.smallModel, endpoint: runtime.endpoint } : {}),
      servedModels: unique(records.map((record) => record.run.servedModel)), claudeCodeVersions: unique(records.map((record) => record.run.claudeCodeVersion)),
    },
    mcpContract: MCP_CONTRACT_VERSION,
    materials: origin.materials,
    consecutivePasses: options.config.consecutivePasses,
    passLines: Object.fromEntries(options.config.scenarios.map((scenario) => [scenario.id, scenario.pass])),
    results: options.results,
    gate: gate(options.config, options.results),
    totals: { wallMs: sum((round) => round.wallMs), inputTokens: sum((round) => round.inputTokens), outputTokens: sum((round) => round.outputTokens), cacheReadTokens: sum((round) => round.cacheReadTokens) },
  };
}

/** 报告的文字摘要：门槛结论、各场景每次的结果与原因、用量。 */
export function formatReport(report: EvalReport): string {
  const lines = [
    `# Agent 评估 ${report.label}：门槛${report.gate.pass ? '通过' : '未通过'}`,
    '',
    `模型 ${report.runtime.model ?? '?'}（服务端 ${report.runtime.servedModels.join('、') || '?'}），Claude Code ${report.runtime.claudeCodeVersions.join('、') || '?'}，MCP 合同 ${report.mcpContract}，提交 ${report.git.commit}${report.git.dirty ? '（有未提交改动）' : ''}。`,
    '',
    '| 场景 | 各次结果 | 门槛 |',
    '|---|---|---|',
    ...report.gate.scenarios.map((scenario) => `| ${scenario.name} | ${scenario.passes.map((pass) => (pass ? '达线' : '未达线')).join('、')} | ${scenario.pass ? '通过' : '未通过'} |`),
    '',
  ];
  for (const result of report.results) {
    const usage = result.rounds.map((round) => `${AGENT_TASKS[round.task].name} ${((round.wallMs ?? 0) / 60000).toFixed(1)} 分钟 / ${round.turns ?? '?'} 轮 / 输出 ${round.outputTokens ?? '?'}`).join('；');
    lines.push(`- ${result.name} 第 ${result.repetition} 次：${result.pass ? '达线' : '未达线'}。${usage}`);
    for (const failure of result.failures) lines.push(`  - ${failure}`);
  }
  lines.push('', `合计 ${(report.totals.wallMs / 60000).toFixed(1)} 分钟（各轮之和），输出 ${report.totals.outputTokens} tokens。`);
  return lines.join('\n');
}

/** 评估中模拟审核人：待确认项全部采纳、整体确认、通过，并应用到 workspace。返回主数据定义（含站点列表的那份）的名称。 */
async function approveDefinitions(roundDir: string, workspace: string): Promise<string> {
  await mkdir(workspace, { recursive: true });
  const opened = await readReview(roundDir);
  if (!opened.view) throw new Error(`数据定义一轮没有可审核的成果，不能接着做数据集提取：${opened.problems.map((problem) => problem.message).join('；')}`);
  for (const item of opened.view.pending) await changeReview(roundDir, { type: 'decide', item: item.item, action: 'adopt' });
  await changeReview(roundDir, { type: 'confirmRest', confirmed: true });
  const approved = await changeReview(roundDir, { type: 'approve', comment: '评估：待确认项全部采纳' });
  if (approved.problems.length > 0) throw new Error(`数据定义审核不能通过：${approved.problems.map((problem) => problem.message).join('；')}`);
  const applied = await applyAgentRound({ roundDir, workspace });
  if (!applied.applied) throw new Error(`数据定义应用失败：${applied.problems.map((problem) => problem.message).join('；')}`);
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
  let toolCalls: number | undefined, toolErrors: number | undefined;
  try {
    const calls = (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { isError?: boolean });
    toolCalls = calls.length;
    toolErrors = calls.filter((call) => call.isError).length;
  } catch { /* 没有工具调用日志 */ }
  const run = record.run;
  const pick = <K extends keyof typeof run>(key: K) => (run[key] === undefined ? {} : { [key]: run[key] });
  return {
    task: record.task, dir: relative(outDir, dir).replaceAll('\\', '/'), verdict: record.verdict,
    ...pick('wallMs'), ...pick('turns'), ...pick('inputTokens'), ...pick('outputTokens'), ...pick('cacheReadTokens'), ...pick('cacheCreationTokens'), ...pick('endedBy'),
    ...(outcome ? { pending: outcome.pending.length } : {}), ...(toolCalls !== undefined ? { toolCalls, toolErrors } : {}), ...(run.error ? { error: run.error } : {}),
  } as RoundSummary;
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

async function materialHashes(): Promise<Record<string, string>> {
  const root = join(REPO, 'agent');
  const files = (await readdir(root, { recursive: true })).map(String).filter((file) => file.endsWith('.md')).sort();
  const hashes: Record<string, string> = {};
  for (const file of files) hashes[`agent/${file.replaceAll('\\', '/')}`] = createHash('sha256').update(await readFile(join(root, file))).digest('hex').slice(0, 12);
  return hashes;
}

async function gitState(): Promise<{ commit: string; dirty: boolean }> {
  const commit = (await execute('git', ['rev-parse', '--short', 'HEAD'], REPO)).stdout.trim();
  const status = (await execute('git', ['status', '--porcelain'], REPO)).stdout.trim();
  return { commit: commit || 'unknown', dirty: status !== '' };
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
