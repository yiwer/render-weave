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
 * - agent run：发起一轮业务 Agent 任务（src/agent/），在新轮次目录中写出 round.json、check.json，结构合格时另有 outcome.json 与候选文件。
 *   退出码：0 成果合格；1 成果不合格（没有交回、结构不合格或候选有严重问题），问题清单见 check.json；2 用法错误、输入无法读取或任务顺序不对。
 */
import { appendFile, mkdir, open, readFile, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ProblemCodes, type Problem } from './problems.js';
import { render, type RenderOptions } from './render.js';
import { deliverBatch, readOutputRecord, replayOutputRecord } from './output-records.js';
import { readBatch } from './batch-read.js';
import { publishStaticSchema } from './schema/publish.js';
import { AgentUsageError, DEFAULT_KEY_ENV, runAgentTask } from './agent/run.js';
import { AGENT_TASKS, findAgentTask } from './agent/tasks.js';
import { WorkingDirectory } from './mcp/files.js';
import { serveMcp } from './mcp/server.js';
import { MCP_CONTRACT_VERSION, createTools } from './mcp/tools.js';
import { describeError } from './util.js';
import { loadWorkspace, loadWorkspaceDocuments, parseJsonKeepingPrecision } from './workspace.js';
import { initializeResourceStore, importResources, openVersionedResourceStore, checkResourceReplacement, applyResourceReplacement } from './versioned-resources.js';

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
  renderweave mcp --workspace <目录> --resources <目录> --root <本轮工作目录> [--tools <工具,…>] [--log <调用日志.jsonl>]
  renderweave agent run --task <任务类型> --sample <示例图> --brief <项目说明.md> --resources <目录> --out <新轮次目录> [--domain <领域>] [--workspace <目录>] [--definition <数据定义>]
                        [--model <模型>] [--small-model <模型>] [--endpoint <地址>] [--key-env <环境变量名>] [--max-turns <轮数>] [--claude <可执行文件>]

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
  --task        数据定义提取（目前只支持这一种；数据集提取、模板辅助设计、模板辅助修改尚未实现）
  --sample      示例图：PNG、JPEG 或 WebP
  --brief       项目说明（Markdown）：业务、尺寸、目标范围、客户说明
  --resources   资源仓库目录
  --out         新轮次目录，必须不存在或为空
  --domain      可选，领域约定包，取 agent/domains/<领域>.md，如 route-sign
  --workspace   可选，工作区目录，复制为本轮的只读快照
  --key-env     可选，key 所在的环境变量名，缺省 QWEN_TOKEN_PLAN_API_KEY；key 只经环境变量传入，不写任何文件
  --model、--small-model、--endpoint、--max-turns、--claude  可选，模型、轻量任务模型、兼容端点、轮数上限与 Claude Code 可执行文件

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
  'agent run': ['task', 'sample', 'brief', 'resources', 'out'],
};
const AGENT_RUN_OPTIONAL = ['domain', 'workspace', 'definition', 'model', 'small-model', 'endpoint', 'key-env', 'max-turns', 'claude'];

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  // agent 带子命令：agent run。
  const [first, ...more] = argv;
  const command = first === 'agent' && more[0] !== undefined ? `agent ${more[0]}` : first;
  const rest = first === 'agent' ? more.slice(1) : more;
  const names = command && Object.hasOwn(COMMAND_OPTIONS, command) ? COMMAND_OPTIONS[command] : undefined;
  if (!names) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  let values: Options;
  const optional = command === 'render' ? ['versions'] : command === 'resources-check' || command === 'resources-apply' || command === 'deliver' ? ['options']
    : command === 'mcp' ? ['tools', 'log'] : command === 'agent run' ? AGENT_RUN_OPTIONAL : [];
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: Object.fromEntries([...names, ...optional].map((name) => [name, { type: 'string' as const }])),
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${describeError(error)}\n\n${USAGE}`);
    return ExitCodes.usage;
  }
  if (!names.every((name) => typeof values[name] === 'string' && values[name] !== '') ||
    optional.some((name) => values[name] !== undefined && values[name] === '')) {
    io.stderr(USAGE);
    return ExitCodes.usage;
  }
  const options = values as Record<string, string>;
  try {
    if (command === 'render') return await runRender(options, io);
    if (command === 'publish') return await runPublish(options, io);
    if (command === 'mcp') return await runMcp(options, io);
    if (command === 'agent run') return await runAgent(options, io);
    if (command === 'deliver' || command === 'batch-read' || command === 'replay' || command === 'record-read') return await runRecords(command, options, io);
    return await runResources(command!, options, io);
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
      await writePublishedFiles([{ path: options.out!, value: result.check }]);
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
  const task = findAgentTask(options.task!);
  if (!task) {
    io.stderr(`没有任务类型 ${options.task}；可用：${Object.values(AGENT_TASKS).map((item) => item.name).join('、')}\n`);
    return ExitCodes.usage;
  }
  const keyEnv = options['key-env'] ?? DEFAULT_KEY_ENV;
  const key = process.env[keyEnv];
  if (!key) {
    io.stderr(`缺少环境变量 ${keyEnv}：key 只经环境变量传入\n`);
    return ExitCodes.usage;
  }
  const maxTurns = options['max-turns'] === undefined ? undefined : Number(options['max-turns']);
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    io.stderr('--max-turns 必须是正整数\n');
    return ExitCodes.usage;
  }
  io.stderr(`开始${task.name}：轮次目录 ${options.out}\n`);
  try {
    const result = await runAgentTask({
      task: task.id, sample: options.sample!, brief: options.brief!, resources: options.resources!, out: options.out!, key, keyEnv,
      ...(options.domain !== undefined ? { domain: options.domain } : {}),
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      ...(options.definition !== undefined ? { definition: options.definition } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ...(options['small-model'] !== undefined ? { smallModel: options['small-model'] } : {}),
      ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(options.claude !== undefined ? { claude: { command: options.claude } } : {}),
    });
    const { check, record } = result;
    reportProblems([...check.problems, ...check.candidates.flatMap((candidate) => candidate.problems)], io);
    if (record.run.error) io.stderr(`${record.run.error}\n`);
    io.stdout(`${JSON.stringify({
      round: result.roundDir, verdict: check.verdict,
      candidates: check.candidates.map((candidate) => ({ path: candidate.path, ...(candidate.published ? { published: candidate.published } : {}) })),
      pending: result.outcome?.pending.length ?? null,
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
  // 工作区只在启动时读一次，作为本轮的只读快照；资源内容按需读取。
  const workspace = await loadWorkspace({ dir: options.workspace!, resourcesDir: options.resources! });
  const all = createTools({ workingDirectory, workspace, workspaceDir: resolve(options.workspace!), resourcesDir: resolve(options.resources!) });
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
  // 文件名沿用定义文件名：去掉 schema- 前缀与 -v<版本> 后缀，如 schema-route-sign-v1.json → route-sign。
  const stem = basename(definitionFile!, '.json').replace(/^schema-/, '').replace(/-v\d+$/, '');
  const version = published.ref.version;
  await mkdir(out!, { recursive: true });
  const schemaFile = join(out!, `schema-${stem}-v${version}.json`);
  const compiledFile = join(out!, `compiled-${stem}-v${version}.schema.json`);
  await writePublishedFiles([
    { path: schemaFile, value: published.definition },
    { path: compiledFile, value: published.compiled },
  ]);
  io.stdout(`已发布：${published.ref.name} v${version}\n  ${schemaFile}\n  ${compiledFile}\n`);
  return ExitCodes.ok;
}

/** 排他创建，绝不覆盖已有静态数据定义；可捕获的失败撤回本次创建的文件。 */
async function writePublishedFiles(files: readonly { path: string; value: unknown }[]): Promise<void> {
  const owned: { path: string; handle: FileHandle }[] = [];
  try {
    for (const file of files) owned.push({ path: file.path, handle: await open(file.path, 'wx') });
    for (let i = 0; i < files.length; i++) await owned[i]!.handle.writeFile(`${JSON.stringify(files[i]!.value, null, 2)}\n`);
  } catch (error) {
    // Windows 必须先关闭句柄才能撤回；只清理排他创建成功的文件。
    for (const file of owned) await file.handle.close();
    for (const file of owned) await rm(file.path, { force: true });
    throw error;
  } finally {
    for (const file of owned) await file.handle.close();
  }
}

function reportProblems(problems: readonly Problem[], io: CliIo): string {
  for (const problem of problems) {
    const where = Object.values(problem.location).slice(1).join(' / ');
    io.stderr(`[${problem.level === 'severe' ? '严重' : '提示'}] ${problem.code} ${where}：${problem.message}\n`);
  }
  const severeCount = problems.filter((problem) => problem.level === 'severe').length;
  return `问题 ${problems.length} 个（严重 ${severeCount}，提示 ${problems.length - severeCount}）`;
}
