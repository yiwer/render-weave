/**
 * 命令行：
 * - render：对一个工作区执行渲染请求，把图片、问题清单与布局摘要写到输出目录。
 *   退出码：0 已出图；1 未出图（正式出图有严重问题，或请求、模板、数据集找不到）；2 用法错误或请求文件无法读取。
 * - publish：把数据定义发布为下一个版本的静态数据定义，写出带版本号的 DSL 与编译产物。
 *   退出码：0 已发布；1 有问题未发布；2 用法错误或文件无法读取。
 * - deliver：批量正式交付或草稿预览到新批次目录，逐项进度写到标准错误流，汇总写到标准输出。
 *   退出码：0 全部项已交付（草稿为全部已预览，可能仍有严重问题）；1 整批拒绝、部分失败或未执行、汇总未写出；2 用法错误或请求/选项无法读取；130 已取消。
 * - batch-read：辨认批次目录。退出码：0 batch.json 已发布，运行已结束；1 运行未完成（没有 batch.json）或目录无法读取；2 用法错误。
 * - record-read、replay：完整读取一项出图记录，或按确切构建重新渲染并比对。退出码：0 完整读取或重放一致；1 完整性、构建、渲染或文件失败；2 用法错误。
 * - resources-init、resources-import、resources-list、resources-get、resources-check、resources-apply：资源版本仓库维护。
 *   退出码：0 成功；1 仓库、内容、检查、冲突或文件失败；2 用法错误。
 * - mcp：在标准输入输出上提供只读的 MCP 工具服务（src/mcp/），读完标准输入后结束。退出码：0 正常结束；2 用法错误或目录无法打开。
 * - agent run：发起一轮业务 Agent 任务（src/agent/），或带 --from 发起下一轮；在新轮次目录中写出 round.json、check.json，结构合格时另有 outcome.json 与候选文件。
 *   退出码：0 成果合格；1 成果不合格（没有交回、结构不合格或候选有严重问题），问题清单见 check.json；2 用法错误、输入无法读取或任务顺序不对。
 * - agent review：在 127.0.0.1 上打开一轮的审核页，审核结果写入轮次目录的 review.json；Ctrl+C 结束。
 *   退出码：0 正常结束；1 轮次无法审核（没有 outcome.json、候选被改动）或端口被占用；2 用法错误。
 * - agent apply：把审核通过的一轮应用到工作区：数据定义发布为下一个版本，数据集与新模板保存为新文件，模板的工作副本替换已保存的模板。
 *   退出码：0 已应用；1 拒绝或失败（未审核、未通过、已应用过、工作区已变化、发布或写入失败），工作区保持原状；2 用法错误或工作区无法读取。
 * - push：把本地工作区与资源版本仓库推送到出图服务上的一个租户（src/push.ts）；代建令牌只经环境变量传入。
 *   退出码：0 已推送（只看差异时为没有冲突）；1 有冲突整体拒绝、本地有严重问题、连不上服务或请求被拒绝；2 用法错误或缺少令牌。
 * - template-revisions：列出服务端一个模板的修订，或把当前修订指向某一修订。退出码：0 成功；1 模板或修订不存在、请求被拒绝；2 用法错误或缺少令牌。
 */
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ProblemCodes, type Problem } from './problems.js';
import { render, type RenderOptions } from './render.js';
import { deliverBatch, readOutputRecord, replayOutputRecord } from './output-records.js';
import { readBatch } from './batch-read.js';
import { publishStaticSchema } from './schema/publish.js';
import { publishedFileNames, writeExclusiveJsonFiles } from './schema/publish-files.js';
import { AGENT_EFFORTS, AgentUsageError, DEFAULT_KEY_ENV, runAgentTask, type AgentEffort } from './agent/run.js';
import { applyAgentRound, readReview } from './agent/review.js';
import { startReviewServer } from './agent/review-server.js';
import { parseOutcomeTarget, type OutcomeTarget } from './agent/outcome.js';
import { AGENT_TASKS, findAgentTask } from './agent/tasks.js';
import { WorkingDirectory } from './mcp/files.js';
import { serveMcp } from './mcp/server.js';
import { MCP_CONTRACT_VERSION, createTools } from './mcp/tools.js';
import { describeError } from './util.js';
import { loadWorkspace, loadWorkspaceDocuments, parseJsonKeepingPrecision } from './workspace.js';
import { initializeResourceStore, importResources, openVersionedResourceStore, checkResourceReplacement, applyResourceReplacement } from './versioned-resources.js';
import { DEFAULT_TOKEN_ENV, pushWorkspace, templateRevisions, type PushDiff, type PushTarget, type ReportedProblem } from './push.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** deliver 的取消信号；bin 在收到 Ctrl+C（SIGINT）时触发。 */
  readonly signal?: AbortSignal;
  /** mcp 读取协议消息的输入流；bin 传入进程的标准输入。 */
  readonly stdin?: NodeJS.ReadableStream;
}

export const ExitCodes = { ok: 0, failed: 1, usage: 2, cancelled: 130 } as const;

const USAGE = `用法：
  renderweave deliver --workspace <目录> --resources <版本仓库> --request <批量请求.json> --out <新批次目录> [--options <字体配置.json>]
  renderweave batch-read --batch <批次目录>
  renderweave replay --record <记录目录> --out <新目录>
  renderweave record-read --record <记录目录>
  renderweave render --workspace <目录> --resources <目录> --request <文件> --out <目录>
  renderweave publish --definition <文件> --workspace <目录> --out <目录>
  renderweave resources-init --resources <新目录>
  renderweave resources-import --source <旧资源目录> --resources <版本仓库目录>
  renderweave resources-list --resources <版本仓库目录>
  renderweave resources-get --resources <目录> --id <资源ID> --version <内容版本>
  renderweave resources-check --resources <目录> --workspace <目录> --id <资源ID> --kind <image|font> --file <新内容文件> --out <检查报告.json> [--options <字体配置.json>]
  renderweave resources-apply --resources <目录> --workspace <目录> --file <新内容文件> --check <检查报告.json> [--options <字体配置.json>]
  renderweave mcp --workspace <目录> --resources <目录> --root <本轮工作目录> [--tools <工具,…>] [--log <调用日志.jsonl>] [--outcome-context <本轮任务.json>]
  renderweave agent run --task <任务类型> --sample <示例图> --brief <项目说明.md> --resources <目录> --out <新轮次目录> [--domain <领域>] [--workspace <目录>]
                        [--definition <名称[@版本]>] [--dataset <数据集ID>] [--request <出图请求.json>] [--requirement <修改要求.md>]
                        [--reference <核准参考.json>] [--content-baseline <内容事实.json>]
                        [--model <模型>] [--small-model <模型>] [--endpoint <地址>] [--key-env <环境变量名>] [--max-turns <轮数>] [--effort <力度>] [--claude <可执行文件>]
  renderweave agent run --from <上一轮目录> --feedback <反馈.md> --out <新轮次目录> [--model …] [--key-env …] [--max-turns …] [--effort …] [--claude …]
  renderweave agent review <轮次目录> [--port <端口>] [--no-open]
  renderweave agent apply <轮次目录> [--workspace <目录>] [--overwrite]
  renderweave push --server <服务地址> --tenant <租户ID> --workspace <目录> --resources <版本仓库> [--rounds <轮次目录>] [--dry-run] [--token-env <环境变量名>]
  renderweave template-revisions --server <服务地址> --tenant <租户ID> --template <模板名> [--current <修订号>] [--token-env <环境变量名>]

render
  --workspace   工作区目录：静态数据定义、编译产物、模板与数据集的 JSON 文件
  --resources   资源仓库目录（含 resources.json）
  --request     渲染请求 JSON 文件
  --out         输出目录：image.png 或 image.jpg、problems.json、layout.json
  --versions    可选，资源版本映射 JSON 文件，仅用于版本仓库

mcp（只读工具服务，stdio 上按行分隔的 JSON-RPC）
  --workspace   工作区目录，启动时读入为快照，之后不再读取
  --resources   资源仓库目录
  --root        本轮工作目录：工具只能读取其中的文件
  --tools       可选，只开放列出的工具，逗号分隔
  --log         可选，每次工具调用追加一行记录

agent run（一轮业务 Agent 任务，Claude Code 无头运行，只连 renderweave mcp）
  --task        数据定义提取、数据集提取、模板辅助设计或模板辅助修改
  --sample      示例图：PNG、JPEG 或 WebP
  --brief       项目说明（Markdown）：业务、尺寸、目标范围、客户说明
  --resources   资源仓库目录
  --out         新轮次目录，必须不存在或为空
  --domain      可选，领域约定包，取 agent/domains/<领域>.md，如 route-sign
  --workspace   工作区目录，复制为本轮的只读快照；数据集提取与模板辅助设计必须给
  --definition  数据集提取所基于的已发布数据定义：名称，或 名称@版本（只写名称时取最新版本）
  --dataset     模板辅助设计所基于的已保存数据集 id
  --request     示例图对应的出图请求（主模板名、参数与输出尺寸）：模板辅助设计与模板辅助修改必须给；数据集提取可选，用工作区已有的模板预览
                模板辅助修改时主模板就是要改的已保存模板，它调用的模板也可以改；数据集写在请求里或用 --dataset 指定
  --requirement 模板辅助修改的修改要求（Markdown）；反引号里以模板名开头的元素路径必须存在
  --reference   模板任务的人工核准区域、物理尺寸及测量类型 JSON；随本轮固定，未提供时视觉比较返回 notChecked
  --content-baseline 提取任务的本次内容事实 JSON；显式指定定义、字段、缺值或逐项数值，不从领域名推断
  --from        上一轮的轮次目录：下一轮沿用它的任务、素材、基准、出图请求与修改要求，拿到它的成果（含审核时的修改）
  --feedback    带 --from 时必须给：给下一轮的反馈（Markdown）
  --key-env     可选，key 所在的环境变量名，缺省 OPEN_CODE_API_KEY；key 只经环境变量传入，不写任何文件
  --model       可选，缺省 claude-haiku-5-5（OpenCode Go）；gemini 开头的模型经本机转换代理连接 Google 接口
  --small-model、--endpoint、--max-turns、--claude  可选，轻量任务模型（缺省同为 Haiku，选 Gemini 时与模型相同）、端点、轮数上限与 Claude Code 可执行文件
  --effort      可选，推理力度 low、medium、high、xhigh 或 max，传给 Claude Code 的 --effort；不给时用它的缺省

agent review（本地审核页，只绑定 127.0.0.1；Ctrl+C 结束）
  --port        可选，端口，缺省由系统分配
  --no-open     可选，不自动打开浏览器，只打印地址

agent apply（只接受审核通过的轮次；数据定义发布为下一个版本，数据集与新模板保存为新文件，模板的工作副本替换已保存的模板）
  --workspace   可选，写入的工作区，缺省为发起本轮时的 --workspace
  --overwrite   可选，工作区自成果生成后已变化时仍然应用：按当前工作区发布为下一个版本；要改的模板已被他人保存时用工作副本覆盖

push（代建推送：先列差异，有冲突整体拒绝，没有冲突在一个事务里提交）
  --server      出图服务地址，如 http://127.0.0.1:8080
  --tenant      目标租户 ID；代建令牌必须被指定给这个租户
  --workspace   本地工作区：静态数据定义、编译产物、模板与样例数据集；其他 JSON（如渲染请求）不推送
  --resources   资源版本仓库：全部资源及其内容版本
  --rounds      可选，这一单代建的轮次目录（含 round.json），或其下一层的各轮目录：各轮的 token 用量与推送一起记到该租户，只记不拦；同一轮只记一次
  --dry-run     可选，只列差异，不提交
  --token-env   可选，代建令牌所在的环境变量名，缺省 ${DEFAULT_TOKEN_ENV}；令牌只经环境变量传入，不写进参数与文件

template-revisions（服务端模板的修订：每次推送改了内容的模板记一个新修订）
  --template    模板名
  --current     可选，把当前修订指向这个修订号，可以指回旧修订
  --server、--tenant、--token-env  同 push

publish
  --definition  数据定义 DSL 文件（renderweave-schema/1）
  --workspace   已发布的静态数据定义所在的工作区：确定下一个版本号，并解析引用
  --out         输出目录：schema-<名称>-v<版本>.json 与 compiled-<名称>-v<版本>.schema.json
`;

type Options = Record<string, string | boolean | undefined>;

const COMMAND_OPTIONS: Record<string, readonly string[]> = {
  deliver: ['workspace', 'resources', 'request', 'out'],
  'batch-read': ['batch'],
  replay: ['record', 'out'],
  'record-read': ['record'],
  render: ['workspace', 'resources', 'request', 'out'],
  publish: ['definition', 'workspace', 'out'],
  'resources-init': ['resources'],
  'resources-import': ['source', 'resources'],
  'resources-list': ['resources'],
  'resources-get': ['resources', 'id', 'version'],
  'resources-check': ['resources', 'workspace', 'id', 'kind', 'file', 'out'],
  'resources-apply': ['resources', 'workspace', 'file', 'check'],
  mcp: ['workspace', 'resources', 'root'],
  'agent run': ['out'],
  'agent review': [],
  'agent apply': [],
  push: ['server', 'tenant', 'workspace', 'resources'],
  'template-revisions': ['server', 'tenant', 'template'],
};
/** 第 1 轮必须给 task、sample、brief、resources；带 --from 的下一轮沿用上一轮，不能再给。 */
const AGENT_RUN_OPTIONAL = ['task', 'sample', 'brief', 'resources', 'domain', 'workspace', 'definition', 'dataset', 'request', 'requirement', 'from', 'feedback',
  'model', 'small-model', 'endpoint', 'key-env', 'max-turns', 'effort', 'claude', 'claude-args', 'reference', 'content-baseline'];
/** 取一个位置参数（轮次目录）的命令，以及它们的开关。 */
const POSITIONAL_COMMANDS = new Set(['agent review', 'agent apply']);
const COMMAND_FLAGS: Record<string, readonly string[]> = { 'agent review': ['no-open'], 'agent apply': ['overwrite'], push: ['dry-run'] };

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // agent 带子命令：agent run、agent review、agent apply。
  const [first, ...more] = argv;
  const command = first === 'agent' && more[0] !== undefined ? `agent ${more[0]}` : first;
  const rest = first === 'agent' ? more.slice(1) : more;
  const names = command && Object.hasOwn(COMMAND_OPTIONS, command) ? COMMAND_OPTIONS[command] : undefined;
  if (!command || !names) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  let values: Options;
  const optional = command === 'render' ? ['versions'] : command === 'resources-check' || command === 'resources-apply' || command === 'deliver' ? ['options']
    : command === 'mcp' ? ['tools', 'log', 'outcome-context'] : command === 'agent run' ? AGENT_RUN_OPTIONAL
    : command === 'agent review' ? ['port'] : command === 'agent apply' ? ['workspace']
    : command === 'push' ? ['token-env', 'rounds'] : command === 'template-revisions' ? ['token-env', 'current'] : [];
  const flags = COMMAND_FLAGS[command] ?? [];
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...rest],
      options: Object.fromEntries([
        ...[...names, ...optional].map((name): [string, { type: 'string' | 'boolean' }] => [name, { type: 'string' }]),
        ...flags.map((name): [string, { type: 'string' | 'boolean' }] => [name, { type: 'boolean' }]),
      ]),
      strict: true,
      allowPositionals: POSITIONAL_COMMANDS.has(command),
    });
    values = parsed.values as Options;
    positionals = parsed.positionals;
  } catch (error) {
    io.stderr(`${describeError(error)}\n\n${USAGE}`);
    return ExitCodes.usage;
  }
  if (!names.every((name) => typeof values[name] === 'string' && values[name] !== '') ||
    optional.some((name) => values[name] !== undefined && values[name] === '') ||
    (POSITIONAL_COMMANDS.has(command) && (positionals.length !== 1 || positionals[0] === ''))) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  const options = values as Record<string, string>;
  try {
    if (command === 'agent review') return await runReview(positionals[0]!, options, values['no-open'] === true, io);
    if (command === 'agent apply') return await runApply(positionals[0]!, options, values['overwrite'] === true, io);
    if (command === 'render') return await runRender(options, io);
    if (command === 'publish') return await runPublish(options, io);
    if (command === 'mcp') return await runMcp(options, io);
    if (command === 'agent run') return await runAgent(options, io);
    if (command === 'deliver' || command === 'batch-read' || command === 'replay' || command === 'record-read') return await runRecords(command, options, io);
    if (command === 'push') return await runPush(options, values['dry-run'] === true, io);
    if (command === 'template-revisions') return await runTemplateRevisions(options, io);
    return await runResources(command, options, io);
  } catch (error) {
    io.stderr(`命令执行失败：${describeError(error)}\n`);
    return ExitCodes.failed;
  }
}

async function runRecords(command: string, options: Record<string, string>, io: CliIo): Promise<number> {
  if (command === 'deliver') {
    let request: unknown, renderOptions: RenderOptions | undefined;
    try {
      const precision: string[] = [];
      request = parseJsonKeepingPrecision(await readFile(options.request!, 'utf8'), precision);
      if (options.options) renderOptions = JSON.parse(await readFile(options.options, 'utf8'));
      if (precision.length) throw new Error(`请求数值超过 15 位有效数字：${precision.join('、')}`);
    } catch (error) { io.stderr(`请求或选项无法读取：${describeError(error)}\n`); return ExitCodes.usage; }
    const workspace = await loadWorkspaceDocuments(options.workspace!);
    const opened = await openVersionedResourceStore(options.resources!);
    reportProblems(opened.problems, io);
    if (!opened.store) return ExitCodes.failed;
    const labels = { delivered: '已交付', previewed: '已预览', failed: '失败', notRun: '未执行' } as const;
    const result = await deliverBatch({
      workspace, resources: opened.store, request, outDir: options.out!, renderOptions, signal: io.signal,
      onItem: (item, { completed, total }) => {
        io.stderr(`[${completed}/${total}] ${item.id}：${labels[item.status]}${item.directory ? ` ${item.directory}` : ''}（严重 ${item.severe}，提示 ${item.hints}）\n`);
        if (item.status === 'failed' || item.status === 'notRun' || item.severe > 0) reportProblems(item.problems, io);
      },
    });
    reportProblems(result.problems, io);
    const cancelled = result.problems.some((problem) => problem.code === ProblemCodes.deliveryCancelled);
    if (!result.directory) return cancelled ? ExitCodes.cancelled : ExitCodes.failed;
    const { summary, mode } = result;
    io.stdout(`${JSON.stringify({ directory: result.directory, manifest: 'batch.json', mode, summary }, null, 2)}\n`);
    if (cancelled) {
      io.stderr(`已取消：${summary.notRun} 项未执行，已结束的项保留在批次目录；未执行项可另组新批次交付\n`);
      return ExitCodes.cancelled;
    }
    if (mode === 'draft' && summary.severe > 0) io.stderr(`草稿预览含严重问题 ${summary.severe} 个，不是可交付成品；修正后以 final 模式交付\n`);
    // 0 只表示本模式的成果全部完整：草稿全部已预览，或正式全部已交付；部分失败、未执行或汇总未写出返回 1。
    const complete = mode === 'draft' ? summary.previewed : summary.delivered;
    return complete === summary.total && result.problems.length === 0 ? ExitCodes.ok : ExitCodes.failed;
  } else if (command === 'batch-read') {
    const result = await readBatch({ dir: options.batch! });
    reportProblems(result.problems, io);
    if (!result.batch) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.batch, null, 2)}\n`);
    if (result.batch.state === 'unfinished') {
      const done = result.batch.items.filter((item) => item.status !== 'incomplete').length;
      io.stderr(`未完成运行：没有 batch.json。${done} 项完成清单已发布；${result.batch.items.length - done} 个目录没有完成清单（失败或中断），不算交付。` +
        '重新运行时，把已完成标识以外的项另组新批次\n');
      return ExitCodes.failed;
    }
  } else if (command === 'replay') {
    const result = await replayOutputRecord({ dir: options.record!, outDir: options.out! });
    reportProblems(result.problems, io);
    if (!result.replayed) return ExitCodes.failed;
    io.stdout(`已重新渲染，图片、问题清单和布局摘要均一致：${result.replayed.directory}\n`);
  } else {
    const result = await readOutputRecord({ dir: options.record! });
    reportProblems(result.problems, io);
    if (!result.record) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.record, null, 2)}\n`);
  }
  return ExitCodes.ok;
}

async function runResources(command: string, options: Record<string, string>, io: CliIo): Promise<number> {
  const dir = options.resources!;
  if (command === 'resources-check' || command === 'resources-apply') {
    const renderOptions: RenderOptions | undefined = options.options ? JSON.parse(await readFile(options.options, 'utf8')) : undefined;
    const context = { dir, workspaceDir: options.workspace!, file: options.file!, renderOptions };
    if (command === 'resources-check') {
      if (options.kind !== 'image' && options.kind !== 'font') { io.stderr('--kind 必须是 image 或 font\n'); return ExitCodes.usage; }
      if (resolve(dirname(options.out!)) === resolve(options.workspace!)) { io.stderr('检查报告请保存到工作区外，避免改变被检查的工作区\n'); return ExitCodes.usage; }
      const result = await checkResourceReplacement({ ...context, id: options.id!, kind: options.kind });
      reportProblems(result.problems, io);
      if (!result.check) return ExitCodes.failed;
      await mkdir(dirname(options.out!), { recursive: true });
      await writeExclusiveJsonFiles([{ path: options.out!, value: result.check }]);
      io.stdout(`${JSON.stringify(result.check, null, 2)}\n`);
    } else {
      const check: unknown = JSON.parse(await readFile(options.check!, 'utf8'));
      const result = await applyResourceReplacement({ ...context, check });
      reportProblems(result.problems, io);
      if (!result.replaced) return ExitCodes.failed;
      io.stdout(`${JSON.stringify(result.replaced, null, 2)}\n`);
    }
  } else if (command === 'resources-get') {
    const version = Number(options.version);
    if (!/^[1-9]\d*$/.test(options.version!) || !Number.isSafeInteger(version)) { io.stderr('--version 必须是正安全整数\n'); return ExitCodes.usage; }
    const opened = await openVersionedResourceStore(dir);
    reportProblems(opened.problems, io);
    if (!opened.store) return ExitCodes.failed;
    const info = opened.store.get(options.id!, version);
    if (!info) { io.stderr(`resource.versionNotFound：${options.id} v${version}\n`); return ExitCodes.failed; }
    io.stdout(`${JSON.stringify(info, null, 2)}\n`);
  } else if (command === 'resources-init') {
    const result = await initializeResourceStore(dir);
    reportProblems(result.problems, io);
    if (result.problems.some((item) => item.level === 'severe')) return ExitCodes.failed;
    io.stdout(`已准备资源版本仓库：${dir}\n`);
  } else if (command === 'resources-import') {
    const result = await importResources({ dir, sourceDir: options.source! });
    reportProblems(result.problems, io);
    if (result.problems.some((item) => item.level === 'severe')) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.imported, null, 2)}\n`);
  } else {
    const result = await openVersionedResourceStore(dir);
    reportProblems(result.problems, io);
    if (!result.store) return ExitCodes.failed;
    io.stdout(`${JSON.stringify(result.store.list(), null, 2)}\n`);
  }
  return ExitCodes.ok;
}

async function runAgent(options: Record<string, string>, io: CliIo): Promise<number> {
  if (options.from === undefined && !['task', 'sample', 'brief', 'resources'].every((name) => options[name] !== undefined)) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  const task = options.task === undefined ? undefined : findAgentTask(options.task);
  if (options.task !== undefined && !task) {
    io.stderr(`没有任务类型 ${options.task}；可用：${Object.values(AGENT_TASKS).map((item) => item.name).join('、')}\n`);
    return ExitCodes.usage;
  }
  const keyEnv = options['key-env'] ?? DEFAULT_KEY_ENV;
  const key = process.env[keyEnv];
  if (!key) {
    io.stderr(`缺少环境变量 ${keyEnv}：key 只经环境变量传入\n`);
    return ExitCodes.usage;
  }
  const effort = options.effort as AgentEffort | undefined;
  if (effort !== undefined && !AGENT_EFFORTS.includes(effort)) {
    io.stderr(`--effort 只能取 ${AGENT_EFFORTS.join('、')}\n`);
    return ExitCodes.usage;
  }
  const maxTurns = options['max-turns'] === undefined ? undefined : Number(options['max-turns']);
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    io.stderr('--max-turns 必须是正整数\n');
    return ExitCodes.usage;
  }
  try {
    const claudeArgs: unknown = options['claude-args'] === undefined ? undefined : JSON.parse(options['claude-args']);
    if (claudeArgs !== undefined && (!options.claude || !Array.isArray(claudeArgs) || !claudeArgs.every(value => typeof value === 'string'))) {
      throw new AgentUsageError('--claude-args 必须与 --claude 一起使用，并提供字符串 JSON 数组');
    }
    const result = await runAgentTask({
      out: options.out!, key, keyEnv,
      ...(task ? { task: task.id } : {}),
      ...(options.sample !== undefined ? { sample: options.sample } : {}),
      ...(options.brief !== undefined ? { brief: options.brief } : {}),
      ...(options.resources !== undefined ? { resources: options.resources } : {}),
      ...(options.requirement !== undefined ? { requirement: options.requirement } : {}),
      ...(options.from !== undefined ? { from: options.from } : {}),
      ...(options.feedback !== undefined ? { feedback: options.feedback } : {}),
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      ...(options.definition !== undefined ? { definition: options.definition } : {}),
      ...(options.dataset !== undefined ? { dataset: options.dataset } : {}),
      ...(options.request !== undefined ? { request: options.request } : {}),
      ...(options.reference !== undefined ? { reference: options.reference } : {}),
      ...(options['content-baseline'] !== undefined ? { contentBaseline: options['content-baseline'] } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options['small-model'] !== undefined ? { smallModel: options['small-model'] } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(options.claude !== undefined ? { claude: { command: options.claude, ...(claudeArgs ? {args: claudeArgs as string[]} : {}) } } : {}),
      // 输入校验通过后才打印，用法错误时第一行就是错误（票据 28）。
      onStart: () => io.stderr(`开始${task ? task.name : '下一轮'}：轮次目录 ${options.out}${options.from !== undefined ? `，上一轮 ${options.from}` : ''}\n`),
    });
    const { check, record } = result;
    reportProblems([...check.problems, ...check.candidates.flatMap((candidate) => candidate.problems), ...check.assessment.render.problems], io);
    if (record.run.error) io.stderr(`${record.run.error}\n`);
    if (result.draft) io.stderr(`已保存中断草稿 ${result.draft}：可用 agent review 查看，完成度未知，不能批准或应用\n`);
    io.stdout(`${JSON.stringify({
      round: result.roundDir, number: record.round, ...(record.inputs.previous ? { previous: record.inputs.previous.dir } : {}), verdict: check.verdict,
      candidates: check.candidates.map((candidate) => ({
        path: candidate.path, ...(candidate.published ? { published: candidate.published } : {}),
        ...(candidate.revision ? { revision: candidate.revision.status, changes: candidate.revision.changes.length } : {}),
      })),
      pending: result.outcome?.pending.length ?? null,
      ...(result.draft ? { draft: result.draft } : {}),
      assessment: check.assessment,
      ...(record.run.stopped ? { stopped: record.run.stopped } : {}),
      usage: { wallMs: record.run.wallMs, turns: record.run.turns ?? null, outputTokens: record.run.outputTokens ?? null, endedBy: record.run.endedBy ?? null },
    }, null, 2)}\n`);
    if (check.verdict === 'unqualified') io.stderr('成果不合格：问题清单见 check.json；是否带着问题重跑由你决定，不会自动重试\n');
    return check.verdict === 'qualified' ? ExitCodes.ok : ExitCodes.failed;
  } catch (error) {
    if (!(error instanceof AgentUsageError)) throw error;
    io.stderr(`${error.message}\n`);
    return ExitCodes.usage;
  }
}

async function runReview(roundDir: string, options: Record<string, string>, noOpen: boolean, io: CliIo): Promise<number> {
  const port = options.port === undefined ? 0 : Number(options.port);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    io.stderr('--port 必须是 0–65535 的整数\n');
    return ExitCodes.usage;
  }
  const { view, execution, problems } = await readReview(roundDir);
  if (!view && !execution) {
    reportProblems(problems, io);
    return ExitCodes.failed;
  }
  let server;
  try {
    server = await startReviewServer({ roundDir, port });
  } catch (error) {
    io.stderr(`审核页无法启动：${describeError(error)}\n`);
    return ExitCodes.failed;
  }
  const decided = view?.pending.filter((item) => item.decision).length ?? 0;
  io.stdout(`${server.url}\n`);
  io.stderr(view ? `审核页：${server.url}（${view.round.taskName}，待确认项 ${view.pending.length} 个，已处理 ${decided} 个）。审核结果随时保存到 review.json；按 Ctrl+C 结束\n`
    : `轮次状态页：${server.url}（${execution!.phase} / ${execution!.status}）。${execution!.diagnostics.join('；')}；按 Ctrl+C 结束\n`);
  if (!noOpen) openBrowser(server.url, io);
  if (io.signal && !io.signal.aborted) await new Promise((done) => io.signal!.addEventListener('abort', done, { once: true }));
  await server.close();
  return ExitCodes.ok;
}

async function runApply(roundDir: string, options: Record<string, string>, overwrite: boolean, io: CliIo): Promise<number> {
  let result;
  try {
    result = await applyAgentRound({ roundDir, ...(options.workspace !== undefined ? { workspace: options.workspace } : {}), overwrite });
  } catch (error) {
    if (!(error instanceof AgentUsageError)) throw error;
    io.stderr(`${error.message}\n`);
    return ExitCodes.usage;
  }
  reportProblems(result.problems, io);
  if (result.drift) {
    const { drift } = result;
    const lines = [
      ...drift.newerDefinitions.map((item) => `  同名数据定义已发布新版本：${item.name} ${item.snapshot === null ? '（快照中没有）' : `v${item.snapshot}`} → v${item.workspace}`),
      ...drift.added.map((file) => `  新增：${file}`), ...drift.removed.map((file) => `  删除：${file}`), ...drift.changed.map((file) => `  修改：${file}`),
      ...(drift.templates ?? []).flatMap((item) => [
        `  模板 ${item.name} 已被他人保存（${item.basis.file} → ${item.current ? item.current.file : '已删去'}），他人的改动 ${item.changes.length} 处：`,
        ...item.changes.map((change) => `    ${CHANGE_NAMES[change.change]} ${change.path}${change.properties ? `：${change.properties.map((property) => property.key).join('、')}` : ''}`),
      ]),
    ];
    io.stderr(`工作区相对本轮快照的差异（指纹 ${drift.expected} → ${drift.actual}）：\n${lines.join('\n')}\n`);
  }
  if (!result.applied) return ExitCodes.failed;
  io.stdout(`${JSON.stringify({
    workspace: result.applied.workspace, overwrite: result.applied.overwrite,
    published: result.applied.published.map((item) => ({
      kind: item.kind, name: item.name, ...(item.version !== undefined ? { version: item.version } : {}), files: item.files, ...(item.replaced ? { replaced: true } : {}),
    })),
    ...(result.applied.unchanged ? { unchanged: result.applied.unchanged } : {}),
  }, null, 2)}\n`);
  return ExitCodes.ok;
}

const CHANGE_NAMES = { added: '新增', removed: '删去', changed: '修改' } as const;

/** 用系统默认浏览器打开审核页；失败时只提示，不影响服务。 */
function openBrowser(url: string, io: CliIo): void {
  const [command, args] = process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => io.stderr(`无法自动打开浏览器，请手动打开 ${url}\n`));
    child.unref();
  } catch {
    io.stderr(`无法自动打开浏览器，请手动打开 ${url}\n`);
  }
}

async function runMcp(options: Record<string, string>, io: CliIo): Promise<number> {
  if (!io.stdin) { io.stderr('mcp 需要标准输入\n'); return ExitCodes.usage; }
  let workingDirectory: WorkingDirectory;
  try {
    if (!(await stat(options.workspace!)).isDirectory()) throw new Error(`不是目录：${options.workspace}`);
    workingDirectory = await WorkingDirectory.open(options.root!);
  } catch (error) {
    io.stderr(`目录无法打开：${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  let outcome: OutcomeTarget | undefined;
  if (options['outcome-context'] !== undefined) {
    let parsed: OutcomeTarget | string;
    try {
      parsed = parseOutcomeTarget(JSON.parse(await readFile(options['outcome-context'], 'utf8')));
    } catch (error) {
      parsed = describeError(error);
    }
    if (typeof parsed === 'string') {
      io.stderr(`成果核对的上下文无法使用：${options['outcome-context']}（${parsed}）\n`);
      return ExitCodes.usage;
    }
    outcome = parsed;
  }
  // 工作区只在启动时读一次，作为本轮的只读快照；资源内容按需读取。
  const workspace = await loadWorkspace({ dir: options.workspace!, resourcesDir: options.resources! });
  const all = createTools({
    workingDirectory, workspace, workspaceDir: resolve(options.workspace!), resourcesDir: resolve(options.resources!), ...(outcome ? { outcome } : {}),
  });
  const names = options.tools?.split(',').map((name) => name.trim());
  const unknown = names?.filter((name) => !all.some((tool) => tool.name === name)) ?? [];
  if (unknown.length > 0) {
    io.stderr(`没有工具：${unknown.join('、')}；可用：${all.map((tool) => tool.name).join('、')}\n`);
    return ExitCodes.usage;
  }
  const tools = names ? all.filter((tool) => names.includes(tool.name)) : all;
  reportProblems(workspace.problems, io);
  io.stderr(`renderweave mcp ${MCP_CONTRACT_VERSION}：工具 ${tools.length} 个，工作区快照中有模板 ${workspace.templates.length} 个、数据集 ${workspace.datasets.length} 个\n`);
  await serveMcp(io.stdin, {
    tools, version: MCP_CONTRACT_VERSION, write: io.stdout,
    ...(options.log ? { log: (entry: Record<string, unknown>) => appendFile(options.log!, `${JSON.stringify(entry)}\n`) } : {}),
  });
  return ExitCodes.ok;
}

async function runRender(options: Record<string, string>, io: CliIo): Promise<number> {
  const { workspace: workspaceDir, resources, request: requestFile, out } = options as Record<string, string>;
  await mkdir(out!, { recursive: true });
  // 一次调用开始即清除旧成果，文件读取失败也不能留下看似本次成功的图片。
  await Promise.all(['image.png', 'image.jpg', 'layout.json', 'problems.json'].map((file) => rm(join(out!, file), { force: true })));
  let request: unknown;
  const tooPrecise: string[] = [];
  try {
    request = parseJsonKeepingPrecision(await readFile(requestFile!, 'utf8'), tooPrecise);
  } catch (error) {
    io.stderr(`渲染请求无法读取：${requestFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  if (tooPrecise.length > 0) {
    io.stderr(`渲染请求中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}\n`);
    return ExitCodes.usage;
  }

  let workspace = await loadWorkspace({ dir: workspaceDir!, resourcesDir: resources! });
  if (options.versions) {
    const opened = await openVersionedResourceStore(resources!);
    if (!opened.store) { reportProblems(opened.problems, io); return ExitCodes.failed; }
    const pinned = opened.store.pin(JSON.parse(await readFile(options.versions, 'utf8')));
    if (!pinned.repository) { reportProblems(pinned.problems, io); return ExitCodes.failed; }
    workspace = { ...workspace, resources: pinned.repository };
  }
  const result = await render(workspace, request);

  await writeFile(join(out!, 'problems.json'), `${JSON.stringify(result.problems, null, 2)}\n`);
  if (result.layout) await writeFile(join(out!, 'layout.json'), `${JSON.stringify(result.layout, null, 2)}\n`);

  const summary = reportProblems(result.problems, io);
  if (!result.image) {
    io.stdout(`未出图；${summary}。详见 ${join(out!, 'problems.json')}\n`);
    return ExitCodes.failed;
  }
  const imageFile = join(out!, result.image.format === 'png' ? 'image.png' : 'image.jpg');
  await writeFile(imageFile, result.image.bytes);
  io.stdout(`已出图：${imageFile}（${result.image.widthPx} × ${result.image.heightPx} 像素，${result.image.dpi} DPI）；${summary}\n`);
  return ExitCodes.ok;
}

async function runPublish(options: Record<string, string>, io: CliIo): Promise<number> {
  const { definition: definitionFile, workspace: workspaceDir, out } = options as Record<string, string>;
  let definition: unknown;
  const tooPrecise: string[] = [];
  try {
    definition = parseJsonKeepingPrecision(await readFile(definitionFile!, 'utf8'), tooPrecise);
  } catch (error) {
    io.stderr(`数据定义无法读取：${definitionFile}\n  ${describeError(error)}\n`);
    return ExitCodes.usage;
  }
  if (tooPrecise.length > 0) {
    io.stderr(`数据定义中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}\n`);
    return ExitCodes.usage;
  }
  // 发布只需要已发布的静态数据定义，不读资源仓库。
  const workspace = await loadWorkspaceDocuments(workspaceDir!);
  if (workspace.problems.some((problem) => problem.level === 'severe')) {
    io.stdout(`未发布；${reportProblems(workspace.problems, io)}\n`);
    return ExitCodes.failed;
  }
  const { published, problems } = publishStaticSchema(definition, workspace.staticSchemas);
  const summary = reportProblems(problems, io);
  if (!published) {
    io.stdout(`未发布；${summary}\n`);
    return ExitCodes.failed;
  }
  const version = published.ref.version;
  const names = publishedFileNames(definitionFile!, version);
  await mkdir(out!, { recursive: true });
  const schemaFile = join(out!, names.schema);
  const compiledFile = join(out!, names.compiled);
  await writeExclusiveJsonFiles([
    { path: schemaFile, value: published.definition },
    { path: compiledFile, value: published.compiled },
  ]);
  io.stdout(`已发布：${published.ref.name} v${version}\n  ${schemaFile}\n  ${compiledFile}\n`);
  return ExitCodes.ok;
}

/** 服务地址与令牌：令牌只从环境变量读取，缺少时是用法错误。 */
function pushTarget(options: Record<string, string>, io: CliIo): PushTarget | undefined {
  let url: URL | undefined;
  try { url = new URL(options.server!); } catch { url = undefined; }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    io.stderr('--server 必须是 http 或 https 地址\n');
    return undefined;
  }
  const env = options['token-env'] ?? DEFAULT_TOKEN_ENV;
  const token = process.env[env];
  if (!token) {
    io.stderr(`缺少环境变量 ${env}：代建令牌只经环境变量传入，不写进参数与文件\n`);
    return undefined;
  }
  return { server: options.server!, tenant: options.tenant!, token };
}

const KIND_NAMES: Record<string, string> = { definition: '静态数据定义', compiled: '编译产物', template: '模板', dataset: '数据集', image: '图片', font: '字体' };
const STATUS_NAMES: Record<string, string> = { added: '新增', updated: '更新', unchanged: '不变', conflict: '冲突' };

/** 差异逐条写到标准错误流：新增、更新与冲突，以及服务端已有更新内容版本的资源。 */
function reportDiff(diff: PushDiff, io: CliIo): void {
  for (const item of diff.documents) {
    if (item.status === 'unchanged') continue;
    const revision = item.kind !== 'template' ? '' : item.revision !== undefined
      ? `（修订 ${item.currentRevision !== undefined ? `${item.currentRevision} → ` : ''}${item.revision}）`
      : item.currentRevision !== undefined ? `（当前修订 ${item.currentRevision}）` : '';
    io.stderr(`${STATUS_NAMES[item.status] ?? item.status} ${KIND_NAMES[item.kind] ?? item.kind} ${item.key}${revision}${item.reason ? `：${item.reason}` : ''}\n`);
  }
  for (const item of diff.resources) {
    if (item.status === 'unchanged') {
      if (item.serverVersion !== undefined && item.serverVersion > item.localVersion) {
        io.stderr(`不变 资源 ${item.id}：服务端已有 v${item.serverVersion}，本地只到 v${item.localVersion}，不覆盖\n`);
      }
      continue;
    }
    const versions = item.status === 'conflict' ? `本地 v${item.localVersion}，服务端 v${item.serverVersion}`
      : item.serverVersion === undefined ? (item.localVersion === 1 ? 'v1' : `v1–v${item.localVersion}`) : `v${item.serverVersion} → v${item.localVersion}`;
    io.stderr(`${STATUS_NAMES[item.status] ?? item.status} 资源 ${item.id}（${KIND_NAMES[item.kind] ?? item.kind}，${versions}）${item.reason ? `：${item.reason}` : ''}\n`);
  }
  const { added, updated, unchanged, conflicts } = diff.summary;
  io.stderr(`差异：新增 ${added}，更新 ${updated}，不变 ${unchanged}，冲突 ${conflicts}\n`);
}

async function runPush(options: Record<string, string>, dryRun: boolean, io: CliIo): Promise<number> {
  const target = pushTarget(options, io);
  if (!target) return ExitCodes.usage;
  const outcome = await pushWorkspace({ ...target, workspace: options.workspace!, resources: options.resources!, dryRun, ...(options.rounds === undefined ? {} : { rounds: options.rounds }) });
  if (outcome.diff) reportDiff(outcome.diff, io);
  reportProblems(outcome.problems, io);
  if (outcome.diff) {
    const { summary, documents, resources, pushId, usage } = outcome.diff;
    io.stdout(`${JSON.stringify({ tenant: target.tenant, dryRun, pushed: outcome.pushed, ...(pushId ? { pushId } : {}), summary, documents, resources, skipped: outcome.skipped,
      ...(usage ? { usage } : {}) }, null, 2)}\n`);
    if (usage?.rounds) io.stderr(`代建 token：附 ${usage.rounds} 轮，新记 ${usage.recorded} 轮${usage.recorded < usage.rounds ? '（其余已记过）' : ''}\n`);
  }
  const conflicts = outcome.diff?.summary.conflicts ?? 0;
  if (outcome.pushed) io.stderr(`已推送到租户 ${target.tenant}\n`);
  else if (conflicts > 0) io.stderr(dryRun ? '有冲突：推送时会整体拒绝\n' : '有冲突，整体拒绝，服务端保持原样\n');
  else if (dryRun && outcome.diff) io.stderr('只列差异，没有提交\n');
  return outcome.pushed || (dryRun && outcome.diff && conflicts === 0) ? ExitCodes.ok : ExitCodes.failed;
}

async function runTemplateRevisions(options: Record<string, string>, io: CliIo): Promise<number> {
  const current = options.current === undefined ? undefined : Number(options.current);
  if (current !== undefined && (!/^[1-9]\d*$/.test(options.current!) || !Number.isSafeInteger(current))) {
    io.stderr('--current 必须是正整数\n');
    return ExitCodes.usage;
  }
  const target = pushTarget(options, io);
  if (!target) return ExitCodes.usage;
  const result = await templateRevisions({ ...target, template: options.template!, ...(current !== undefined ? { current } : {}) });
  reportProblems(result.problems, io);
  if (!result.template) return ExitCodes.failed;
  io.stdout(`${JSON.stringify(result.template, null, 2)}\n`);
  return ExitCodes.ok;
}

function reportProblems(problems: readonly (Problem | ReportedProblem)[], io: CliIo): string {
  for (const problem of problems) {
    const where = Object.values(problem.location).slice(1).join(' / ');
    io.stderr(`[${problem.level === 'severe' ? '严重' : '提示'}] ${problem.code} ${where}：${problem.message}\n`);
  }
  const severeCount = problems.filter((problem) => problem.level === 'severe').length;
  return `问题 ${problems.length} 个（严重 ${severeCount}，提示 ${problems.length - severeCount}）`;
}
