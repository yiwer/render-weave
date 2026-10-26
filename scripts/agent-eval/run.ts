/**
 * Agent 评估命令（第三阶段票据 08）：经产品路径跑评估场景，与通过线对照，报告存档到 docs/agent-eval/reports/。
 *
 *   npm run build
 *   npx tsx scripts/agent-eval/run.ts [--config 配置文件] [--scenarios id,…] [--repeat 次数] [--jobs 并行数] [--label 名称] [--out 目录]
 *                                     [--model …] [--small-model …] [--endpoint …] [--key-env 变量名] [--max-turns 轮数] [--effort 力度]
 *                                     [--executor claude-code|tool-runner]
 *                                     [--candidate-binding <预登记候选计划目录>]
 *   npx tsx scripts/agent-eval/run.ts --rescore <评估输出目录>     只按已有的轮次目录重新评分，不调用模型
 *   npx tsx scripts/agent-eval/run.ts --behavior-policy <政策.json> --workspace <工作区> --resources <资源> --out <新目录>
 *     离线核查预登记的模板业务事实，不调用模型；用法见 docs/agent-template-behavior.md。
 *   分段跑（某个模型的额度窗口装不下一整遍）：用同一个 --label，先加 --repetitions 1-1，额度恢复后加 --repetitions 2-2；
 *   每段核验冻结身份，报告按预登记全计划判定门槛。
 *   同一个 --label 再跑时接着前一次：已有有效结果的单元跳过，invalid 的单元按轮次续跑。
 *   两种用法都可加 --reports <目录>：报告写到哪里，缺省 docs/agent-eval/reports/<名称>.json
 *
 * 上游错误（票据 21）：500/502/503/529、overloaded 与连接中断只重跑出错的那一轮，最多 2 次，间隔 60、180 秒；
 * 429 与额度字样停止派发队列中还没开始的单元，结束时打印续跑命令。拿不到有效结果的单元记为 invalid，执行完整性记为未完成。
 *
 * 模型缺省与 renderweave agent run 相同（OpenCode Go 上的 Claude Haiku 5.5）；--model gemini-… 时由 agent run 起本机转换代理。
 * 需要 key（缺省读环境变量 OPEN_CODE_API_KEY，由 renderweave agent run 读取，本命令不读取其值），耗时长、消耗额度，
 * 所以不进 npm test。退出码：0 门槛通过；1 门槛未通过；2 用法错误；3 门槛未完成（有 invalid 或没跑的次数，按打印的命令续跑）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  EvaluationAborted, buildReport, cliLauncher, formatReport, observedUnit, provenance, resumeCommand, runUnits, scoreScenario, type GateStatus, type Provenance, type ScenarioResult, type RuntimeOptions,
} from './eval.js';
import { CONFIG_FILE, REPO, readConfig, type Scenario } from './scenarios.js';
import { materialHashes } from '../../src/agent/provenance.js';
import { experimentIdentity, inputIdentity, resourceInputIdentity, verifyRoundIdentities, identityDifferences, scorerIdentity, sealEvaluationRound, sha256, type ExperimentIdentity } from './identity.js';
import {verifyCandidateBinding} from './candidate.js';

const MANIFEST = 'eval.json';

const { values } = parseArgs({
  options: {
    scenarios: { type: 'string' }, repeat: { type: 'string' }, jobs: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' },
    model: { type: 'string' }, 'small-model': { type: 'string' }, endpoint: { type: 'string' }, 'key-env': { type: 'string' }, 'max-turns': { type: 'string' }, effort: { type: 'string' }, executor: { type: 'string' },
    rescore: { type: 'string' }, reports: { type: 'string' }, repetitions: { type: 'string' }, 'timeout-ms': { type: 'string' }, 'stagnation-threshold': { type: 'string' },
    plan: { type: 'string' }, config: { type: 'string' }, claude: { type: 'string' }, 'claude-args': { type: 'string' }, paired: { type: 'boolean' },
    'behavior-policy': { type: 'string' }, workspace: { type: 'string' }, resources: { type: 'string' },
    'context-policy':{type:'string'},'context-pair':{type:'string'},'candidate-binding':{type:'string'},
  },
  strict: true,
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
if(values['candidate-binding']&&(values.rescore||values.plan||values['behavior-policy']))fail('--candidate-binding 只用于实际派发；离线模式不补造候选来源');
if (values['behavior-policy'] !== undefined) {
  if (['claude', 'claude-args', 'paired', 'config', 'rescore', 'scenarios', 'repeat', 'jobs', 'label', 'model', 'small-model', 'endpoint', 'key-env', 'max-turns', 'effort', 'executor', 'reports', 'repetitions', 'timeout-ms', 'context-policy', 'context-pair', 'stagnation-threshold'].some((key) => values[key as keyof typeof values] !== undefined)) fail('--behavior-policy 是独立离线模式，不能混用模型运行或重新评分选项');
  const workspace = values.workspace ?? fail('--behavior-policy 需要 --workspace');
  const resources = values.resources ?? fail('--behavior-policy 需要 --resources');
  const out = values.out ?? fail('--behavior-policy 需要 --out');
  try {
    const { runBehavior } = await import('./behavior.js');
    const report = await runBehavior({ policy: resolve(values['behavior-policy']), workspace: resolve(workspace), resources: resolve(resources), out: resolve(out) });
    console.log(`业务行为：${report.status}；报告：${join(resolve(out), 'behavior.json')}`);
    process.exitCode = report.status === 'pass' ? 0 : report.status === 'fail' ? 1 : 3;
  } catch (error) { fail(error instanceof Error ? error.message : String(error)); }
} else {
const configFile = values.config ? resolve(values.config) : CONFIG_FILE;
const config = await readConfig(configFile).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

if (values.plan !== undefined) {
  const {feedbackPlan} = await import('./feedback.js');
  const plan = await feedbackPlan(config, pick(values.scenarios), values.out ? {dir: resolve(values.out), configFile} : undefined);
  await writeFile(resolve(values.plan), JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'});
  console.log(`反馈计划：${resolve(values.plan)}；${plan.units.length} 个预登记单元，真实模型观测 0`);
  process.exit(plan.ready ? 0 : 3);
}

interface Manifest { label: string; startedAt: string; endedAt?: string; scenarios: string[]; repeat: number; provenance?: Provenance; identity?: ExperimentIdentity; candidateBinding?:{id:string;candidateId:string} }

const EXIT: Record<GateStatus, number> = { pass: 0, fail: 1, incomplete: 3 };

if (values.rescore !== undefined) {
  if (values['context-policy'] || values['context-pair']) fail('--rescore 只读取已有策略，不接受新的策略或配对计划');
  const outDir = resolve(values.rescore);
  const manifest = JSON.parse(await readFile(join(outDir, MANIFEST), 'utf8')) as Manifest;
  await finish(values.label ?? manifest.label, manifest, outDir, await scoreAll(outDir, manifest), manifest.endedAt);
}

const keyEnv = values['key-env'] ?? 'OPEN_CODE_API_KEY';
if (!process.env[keyEnv]) fail(`缺少环境变量 ${keyEnv}：key 只经环境变量传入`);
try { await stat(join(REPO, 'dist/bin.js')); } catch { fail('没有 dist/bin.js：先运行 npm run build'); }
const jobs = positive(values.jobs, 3, '--jobs');
const maxTurns = values['max-turns'] === undefined ? undefined : positive(values['max-turns'], 0, '--max-turns');
const stagnationThreshold = values['stagnation-threshold'] === undefined ? undefined : Number(values['stagnation-threshold']);
if (stagnationThreshold !== undefined && (!Number.isSafeInteger(stagnationThreshold) || stagnationThreshold < 1)) fail('--stagnation-threshold 必须是正整数');
const roundTimeoutMs = values['timeout-ms'] === undefined ? undefined : Number(values['timeout-ms']);
if (roundTimeoutMs !== undefined && (!Number.isFinite(roundTimeoutMs) || roundTimeoutMs <= 0)) fail('--timeout-ms 必须是有限正值');
const effort = values.effort;
if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('--effort 只能取 low、medium、high、xhigh、max');
const executor = values.executor;
if (executor !== undefined && !['claude-code', 'tool-runner'].includes(executor)) fail('--executor 只能取 claude-code、tool-runner');
const scenarios = pick(values.scenarios);
const segment = /^(\d+)(?:-(\d+))?$/.exec(values.repetitions ?? '');
if (values.repetitions !== undefined && (!segment || Number(segment[1]) < 1 || Number(segment[2] ?? segment[1]) < Number(segment[1]))) fail('--repetitions 写成 起-止，如 1-1 或 2-2');
const first = segment ? Number(segment[1]) : 1;
let repeat = positive(values.repeat, config.consecutivePasses, '--repeat');
const now = new Date().toISOString();
const label = values.label ?? now.slice(0, 16).replace('T', '-').replace(':', '');
if (!/^[\w.-]+$/.test(label) || label === '.' || label === '..') fail('--label 只能包含字母、数字、下划线、点和连字符');
const outDir = resolve(values.out ?? join(REPO, 'out/agent-eval', label));
await mkdir(outDir, { recursive: true });
// 同一个 --label 接着前一次（后一段或续跑）：沿用开始时间、场景与资料哈希。
let earlier: Manifest | undefined;
try { earlier = JSON.parse(await readFile(join(outDir, MANIFEST), 'utf8')) as Manifest; } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('评估清单损坏，不能覆盖原实验');
}
if (first > 1 && !earlier) fail(`从第 ${first} 次开始要接在同一个 --label 的前一段之后：${outDir} 中没有评估清单`);
if (earlier && earlier.scenarios.join(',') !== scenarios.map((scenario) => scenario.id).join(',')) fail(`同一个 --label 接着跑时场景要与前一次相同：${earlier.scenarios.join('、')}`);
if (earlier && !earlier.identity) fail('旧评估缺少预登记身份，只能 --rescore；请创建新实验');
if (earlier && earlier.label !== label) fail('同一评估目录不能改变实验名称');
if (earlier && values.repeat === undefined) repeat = earlier.repeat;
if (repeat < config.consecutivePasses) fail('--repeat 不得少于配置要求的计划次数');
const last = segment ? Number(segment[2] ?? segment[1]) : repeat;
if (last > repeat) fail('--repetitions 超出预登记 --repeat 计划，不能向同一实验追加观测');
let claudeArgs: string[] | undefined;
try {
  const parsed: unknown = values['claude-args'] === undefined ? undefined : JSON.parse(values['claude-args']);
  if (parsed !== undefined && (!values.claude || !Array.isArray(parsed) || !parsed.every(item => typeof item === 'string'))) fail('--claude-args 必须与 --claude 一起使用，且为字符串 JSON 数组');
  claudeArgs = parsed as string[] | undefined;
} catch { fail('--claude-args 必须为字符串 JSON 数组'); }
const runtime: RuntimeOptions = {
  ...((values['context-policy']!==undefined)?{contextPolicy:values['context-policy'] as 'full'|'on-demand'}:{}),
  ...(values.model ? { model: values.model } : {}), ...(values['small-model'] ? { smallModel: values['small-model'] } : {}),
  ...(values.endpoint ? { endpoint: values.endpoint } : {}), keyEnv, ...(maxTurns ? { maxTurns } : {}), ...(roundTimeoutMs !== undefined ? { roundTimeoutMs } : {}), ...(effort ? { effort } : {}),
  ...(executor === 'tool-runner' ? { executor } : {}),
  ...(stagnationThreshold !== undefined ? { stagnationThreshold } : {}),
  ...(values.claude ? {claude: {command: values.claude, args: claudeArgs}} : {}),
};
let identity: ExperimentIdentity;
try {
  identity = await experimentIdentity(config, configFile, scenarios, runtime, {
    scenarios: scenarios.map(scenario => scenario.id), repeat,
    pairedJobs: values.paired || earlier?.identity?.plan.pairedJobs !== null && earlier?.identity?.plan.pairedJobs !== undefined ? jobs : null,
  });
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
const candidateBinding=values['candidate-binding']?await verifyCandidateBinding(resolve(values['candidate-binding']),identity!).catch((error:unknown)=>fail(error instanceof Error?error.message:String(error))):undefined;
if(earlier&&identityDifferences(earlier.candidateBinding,candidateBinding).length)fail('续跑必须保留原候选计划绑定，旧实验不能补造来源');
if(values['context-pair']){
  try{
    const pair=JSON.parse(await readFile(resolve(values['context-pair']),'utf8'));
    const arm=pair.arms?.find((value:any)=>value.policy===identity!.contextPolicy.name);
    if(pair.format!=='renderweave-context-pair/1'||pair.ready!==true||!arm||arm.identityHash!==sha256(JSON.stringify(arm.identity)))throw new Error('配对计划未完成或身份无效');
    const changes=identityDifferences(arm.identity,identity!);
    if(changes.length)throw new Error(changes.join('、'));
  }catch(error){fail(`配对冻结条件变化，未派发：${error instanceof Error?error.message:String(error)}`);}
}
if (earlier) {
  const changes = identityDifferences(earlier.identity, identity!);
  if (changes.length > 0) fail(`实验条件变化，未派发；请使用新实验标识：\n${changes.map(path => `- ${path}`).join('\n')}`);
}
const startedAt = earlier?.startedAt ?? now;
const origin = earlier?.provenance ?? await provenance();
const manifest: Manifest = earlier ?? { label, startedAt, scenarios: scenarios.map((scenario) => scenario.id), repeat, provenance: origin, identity: identity!,...(candidateBinding?{candidateBinding}:{}) };
if (!earlier) await writeFile(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {flag: 'wx'});
const segmentId = randomUUID(), segments = join(outDir, 'segments');
const activeRounds = new Set<string>();
await mkdir(segments, {recursive: true});
await writeFile(join(segments, `${segmentId}.started.json`), JSON.stringify({startedAt: now, jobs, first, last, experiment: sha256(JSON.stringify(identity!))}), {flag: 'wx'});
const verifyIdentity = async () => {
  try {
    const current = await experimentIdentity(config, configFile, scenarios, runtime, identity!.plan);
    if(values['candidate-binding'])await verifyCandidateBinding(resolve(values['candidate-binding']),current);
    const changes = identityDifferences(identity!, current);
    await verifyRoundIdentities(identity!, outDir, scenarios, repeat, activeRounds);
    if (changes.length) throw new Error(`实验条件变化，已停止派发；请使用新实验标识：\n${changes.map(path => `- ${path}`).join('\n')}`);
  } catch (error) { throw new EvaluationAborted(error instanceof Error ? error.message : String(error)); }
};
await verifyIdentity().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
const executeRound = cliLauncher({...runtime, ...identity!.runtime, effort: effort, claude: {command: identity!.executor.command, args: identity!.executor.args}});
const launch: typeof executeRound = async spec => {
  activeRounds.add(spec.out);
  try { await executeRound(spec); }
  finally {
    try { await sealEvaluationRound(identity!, spec.out); }
    finally { activeRounds.delete(spec.out); }
  }
};

// 场景 × 次数，按 --jobs 并行；每个场景内部的轮次按顺序。
const units = Array.from({ length: last - first + 1 }, (_, index) => scenarios.map((scenario) => ({ scenario, repetition: first + index }))).flat();
console.error(`评估 ${label}：${scenarios.map((scenario) => scenario.name).join('、')}，第 ${first}–${last} 次，并行 ${jobs}；轮次目录 ${outDir}`);
try { await runUnits(config, units, outDir, launch, { jobs, beforeDispatch: verifyIdentity, log: (message) => console.error(message) }); }
catch (error) { fail(error instanceof Error ? error.message : String(error)); }
const endedAt = new Date().toISOString();
await writeFile(join(segments, `${segmentId}.completed.json`), JSON.stringify({endedAt}), {flag: 'wx'});
// 报告包括目录中已跑的全部次数（分段跑时含前一段）。
await finish(label, manifest, outDir, await scoreAll(outDir, manifest), endedAt);

/** 按评估清单重新评分目录中已跑的每一次；未跑次数在完整计划中列为 not-run。 */
async function scoreAll(dir: string, saved: Manifest): Promise<ScenarioResult[]> {
  const chosen = pick(saved.scenarios.join(','));
  const all: ScenarioResult[] = [];
  for (let repetition = 1; repetition <= saved.repeat; repetition++) {
    for (const scenario of chosen) {
      if (await observedUnit(dir, scenario, repetition)) all.push(await scoreScenario(config, scenario, repetition, dir));
    }
  }
  return all;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function finish(name: string, saved: Manifest, dir: string, all: ScenarioResult[], ended: string | undefined): Promise<never> {
  all.sort((a, b) => a.repetition - b.repetition || config.scenarios.findIndex((s) => s.id === a.id) - config.scenarios.findIndex((s) => s.id === b.id));
  const scored = await buildReport({
    config, label: name, startedAt: saved.startedAt, outDir: dir, results: all, plan: { scenarios: saved.scenarios, repetitions: saved.repeat },
    ...(saved.provenance ? { provenance: saved.provenance } : {}), ...(ended ? { endedAt: ended } : {}),
  });
  if (values.rescore === undefined) await verifyIdentity().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
  const reports = resolve(values.reports ?? join(REPO, 'docs/agent-eval/reports'));
  await mkdir(reports, { recursive: true });
  const identified = {...scored, experimentIdentity: saved.identity ?? null,...(saved.candidateBinding?{candidateBinding:saved.candidateBinding}:{})};
  const report = values.rescore === undefined ? identified : {
    ...identified,
    rescoring: {
      sourceLabel: saved.label, sourceIdentity: saved.identity ? sha256(JSON.stringify(saved.identity)) : null,
      sourceManifestSha256: sha256(await readFile(join(dir, MANIFEST))),
      sourceReportSha256: await readFile(join(reports, `${saved.label}.json`)).then(sha256, () => null),
      scoredAt: new Date().toISOString(), scorer: await scorerIdentity(),
      scoringIdentity: {config: sha256(await readFile(configFile)), scorer: await scorerIdentity(), inputs: await inputIdentity(pick(saved.scenarios.join(','))), resources: await resourceInputIdentity(resolve(REPO, config.resources))},
      sourceRounds: await Promise.all(all.flatMap(unit => unit.rounds.map(async round => {
        const files = await materialHashes(join(dir, round.dir), 'round');
        return {dir: round.dir, files, sha256: sha256(JSON.stringify(files))};
      }))),
      note: '旧记录缺少的实验身份保持未知；本报告是事后评分，不改写首次结论。',
    },
  };
  const original = join(reports, `${name}.json`);
  const file = values.rescore !== undefined ? join(reports, `${name}.rescore-${randomUUID()}.json`) : await exists(original) ? join(reports, `${name}.segment-${randomUUID()}.json`) : original;
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
  console.log(formatReport(report));
  console.log(`\n报告：${file}`);
  // 续跑命令带上本次的其他选项；重新评分时不知道原来的模型等选项，不打印。
  const passthrough = (['scenarios', 'jobs', 'out', 'reports', 'model', 'small-model', 'endpoint', 'key-env', 'max-turns', 'effort', 'executor', 'repeat', 'config', 'claude', 'claude-args', 'timeout-ms', 'context-policy', 'context-pair', 'stagnation-threshold','candidate-binding'] as const)
    .flatMap((option) => (values[option] === undefined ? [] : [`--${option}`, values[option]]));
  const resume = values.rescore === undefined ? resumeCommand(name, report.gate, passthrough) : undefined;
  if (resume) console.log(`\ninvalid 与没跑的次数还要补跑（遇到额度限制时等额度窗口恢复），已有有效结果的单元会跳过：\n${resume}`);
  process.exit(EXIT[report.gate.status]);
}

function pick(list: string | undefined): Scenario[] {
  if (list === undefined) return [...config.scenarios];
  const ids = list.split(',').map((id) => id.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !config.scenarios.some((scenario) => scenario.id === id));
  if (unknown.length > 0) fail(`没有场景 ${unknown.join('、')}；可用：${config.scenarios.map((scenario) => scenario.id).join('、')}`);
  return config.scenarios.filter((scenario) => ids.includes(scenario.id));
}

function positive(value: string | undefined, fallback: number, flag: string): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) fail(`${flag} 必须是正整数`);
  return number;
}
}
