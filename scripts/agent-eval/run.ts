/**
 * Agent 评估命令（第三阶段票据 08）：经产品路径跑评估场景，与通过线对照，报告存档到 docs/agent-eval/reports/。
 *
 *   npm run build
 *   npx tsx scripts/agent-eval/run.ts [--scenarios id,…] [--repeat 次数] [--jobs 并行数] [--label 名称] [--out 目录]
 *                                     [--model …] [--small-model …] [--endpoint …] [--key-env 变量名] [--max-turns 轮数] [--effort 力度]
 *   npx tsx scripts/agent-eval/run.ts --rescore <评估输出目录>     只按已有的轮次目录重新评分，不调用模型
 *   分段跑（某个模型的额度窗口装不下一整遍）：用同一个 --label，先加 --repetitions 1-1，额度恢复后加 --repetitions 2-2；
 *   后一段沿用前一段的开始时间与资料哈希，报告按目录中已跑的全部次数判定门槛。
 *   同一个 --label 再跑时接着前一次：已有有效结果的单元跳过，invalid 的单元按轮次续跑。
 *   两种用法都可加 --reports <目录>：报告写到哪里，缺省 docs/agent-eval/reports/<名称>.json
 *
 * 上游错误（票据 21）：500/502/503/529、overloaded 与连接中断只重跑出错的那一轮，最多 2 次，间隔 60、180 秒；
 * 429 与额度字样停止派发队列中还没开始的单元，结束时打印续跑命令。拿不到有效结果的单元记为 invalid，不计入连续达线。
 *
 * 模型缺省与 renderweave agent run 相同（OpenCode Go 上的 Claude Haiku 5.5）；--model gemini-… 时由 agent run 起本机转换代理。
 * 需要 key（缺省读环境变量 OPEN_CODE_API_KEY，由 renderweave agent run 读取，本命令不读取其值），耗时长、消耗额度，
 * 所以不进 npm test。退出码：0 门槛通过；1 门槛未通过；2 用法错误；3 门槛未完成（有 invalid 或没跑的次数，按打印的命令续跑）。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  buildReport, cliLauncher, formatReport, provenance, resumeCommand, runUnits, scoreScenario, unitDir, type GateStatus, type Provenance, type ScenarioResult,
} from './eval.js';
import { REPO, readConfig, type Scenario } from './scenarios.js';

const MANIFEST = 'eval.json';

const { values } = parseArgs({
  options: {
    scenarios: { type: 'string' }, repeat: { type: 'string' }, jobs: { type: 'string' }, label: { type: 'string' }, out: { type: 'string' },
    model: { type: 'string' }, 'small-model': { type: 'string' }, endpoint: { type: 'string' }, 'key-env': { type: 'string' }, 'max-turns': { type: 'string' }, effort: { type: 'string' },
    rescore: { type: 'string' }, reports: { type: 'string' }, repetitions: { type: 'string' },
  },
  strict: true,
});
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};
const config = await readConfig();

interface Manifest { label: string; startedAt: string; endedAt?: string; scenarios: string[]; repeat: number; provenance?: Provenance }

const EXIT: Record<GateStatus, number> = { pass: 0, fail: 1, incomplete: 3 };

if (values.rescore !== undefined) {
  const outDir = resolve(values.rescore);
  const manifest = JSON.parse(await readFile(join(outDir, MANIFEST), 'utf8')) as Manifest;
  await finish(values.label ?? manifest.label, manifest, outDir, await scoreAll(outDir, manifest), manifest.endedAt);
}

const keyEnv = values['key-env'] ?? 'OPEN_CODE_API_KEY';
if (!process.env[keyEnv]) fail(`缺少环境变量 ${keyEnv}：key 只经环境变量传入`);
try { await stat(join(REPO, 'dist/bin.js')); } catch { fail('没有 dist/bin.js：先运行 npm run build'); }
const jobs = positive(values.jobs, 3, '--jobs');
const maxTurns = values['max-turns'] === undefined ? undefined : positive(values['max-turns'], 0, '--max-turns');
const effort = values.effort;
if (effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) fail('--effort 只能取 low、medium、high、xhigh、max');
const scenarios = pick(values.scenarios);
const segment = /^(\d+)(?:-(\d+))?$/.exec(values.repetitions ?? '');
if (values.repetitions !== undefined && (!segment || Number(segment[1]) < 1 || Number(segment[2] ?? segment[1]) < Number(segment[1]))) fail('--repetitions 写成 起-止，如 1-1 或 2-2');
const first = segment ? Number(segment[1]) : 1;
const repeat = segment ? Number(segment[2] ?? segment[1]) : positive(values.repeat, config.consecutivePasses, '--repeat');
const now = new Date().toISOString();
const label = values.label ?? now.slice(0, 16).replace('T', '-').replace(':', '');
const outDir = resolve(values.out ?? join(REPO, 'out/agent-eval', label));
await mkdir(outDir, { recursive: true });
// 同一个 --label 接着前一次（后一段或续跑）：沿用开始时间、场景与资料哈希。
let earlier: Manifest | undefined;
try { earlier = JSON.parse(await readFile(join(outDir, MANIFEST), 'utf8')) as Manifest; } catch { earlier = undefined; }
if (first > 1 && !earlier) fail(`从第 ${first} 次开始要接在同一个 --label 的前一段之后：${outDir} 中没有评估清单`);
if (earlier && earlier.scenarios.join(',') !== scenarios.map((scenario) => scenario.id).join(',')) fail(`同一个 --label 接着跑时场景要与前一次相同：${earlier.scenarios.join('、')}`);
const startedAt = earlier?.startedAt ?? now;
const origin = earlier?.provenance ?? await provenance();
const manifest: Manifest = { label, startedAt, scenarios: scenarios.map((scenario) => scenario.id), repeat: Math.max(repeat, earlier?.repeat ?? 0), provenance: origin };
await writeFile(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
const launch = cliLauncher({
  ...(values.model ? { model: values.model } : {}), ...(values['small-model'] ? { smallModel: values['small-model'] } : {}),
  ...(values.endpoint ? { endpoint: values.endpoint } : {}), keyEnv, ...(maxTurns ? { maxTurns } : {}), ...(effort ? { effort } : {}),
});

// 场景 × 次数，按 --jobs 并行；每个场景内部的轮次按顺序。
const units = Array.from({ length: repeat - first + 1 }, (_, index) => scenarios.map((scenario) => ({ scenario, repetition: first + index }))).flat();
console.error(`评估 ${label}：${scenarios.map((scenario) => scenario.name).join('、')}，第 ${first}–${repeat} 次，并行 ${jobs}；轮次目录 ${outDir}`);
await runUnits(config, units, outDir, launch, { jobs, log: (message) => console.error(message) });
const endedAt = new Date().toISOString();
await writeFile(join(outDir, MANIFEST), `${JSON.stringify({ ...manifest, endedAt }, null, 2)}\n`);
// 报告包括目录中已跑的全部次数（分段跑时含前一段）。
await finish(label, manifest, outDir, await scoreAll(outDir, manifest), endedAt);

/** 按评估清单重新评分目录中已跑的每一次；还没跑的次数（分段跑的后一段）不计入。 */
async function scoreAll(dir: string, saved: Manifest): Promise<ScenarioResult[]> {
  const chosen = pick(saved.scenarios.join(','));
  const all: ScenarioResult[] = [];
  for (let repetition = 1; repetition <= saved.repeat; repetition++) {
    for (const scenario of chosen) {
      if (await exists(unitDir(dir, scenario, repetition))) all.push(await scoreScenario(config, scenario, repetition, dir));
    }
  }
  return all;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function finish(name: string, saved: Manifest, dir: string, all: ScenarioResult[], ended: string | undefined): Promise<never> {
  all.sort((a, b) => a.repetition - b.repetition || config.scenarios.findIndex((s) => s.id === a.id) - config.scenarios.findIndex((s) => s.id === b.id));
  const report = await buildReport({
    config, label: name, startedAt: saved.startedAt, outDir: dir, results: all, plan: { scenarios: saved.scenarios, repetitions: saved.repeat },
    ...(saved.provenance ? { provenance: saved.provenance } : {}), ...(ended ? { endedAt: ended } : {}),
  });
  const reports = resolve(values.reports ?? join(REPO, 'docs/agent-eval/reports'));
  await mkdir(reports, { recursive: true });
  const file = join(reports, `${name}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(formatReport(report));
  console.log(`\n报告：${file}`);
  // 续跑命令带上本次的其他选项；重新评分时不知道原来的模型等选项，不打印。
  const passthrough = (['scenarios', 'jobs', 'out', 'reports', 'model', 'small-model', 'endpoint', 'key-env', 'max-turns', 'effort'] as const)
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
