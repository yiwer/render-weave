/**
 * 发起一轮业务 Agent 任务（ADR-0015、第三阶段 PRD 第 8、9 条）：
 * 在独占的轮次目录里组装三层资料、DSL 参考、示例图与工作区快照，按受限模式启动一次 Claude Code 无头运行，
 * 只连本仓库的 `renderweave mcp`；结束后校验 Agent 交回的 outcome.json，写出轮次记录、成果与校验结果。
 *
 * 子进程环境从空白开始，只放系统必需变量与模型配置，不继承宿主的 CLAUDE_*、ANTHROPIC_* 变量；key 只经环境变量传入，不写任何文件。
 * 模型缺省为 OpenCode Go 上的 Claude Haiku 5.5；选 Gemini 时在本进程起转换代理，Claude Code 只拿到本轮令牌（M232）。
 *
 * 多轮（M58）：带 from 发起下一轮时，沿用上一轮的任务、素材、基准、出图请求与修改要求，工作区重新取快照；
 * 上一轮成果（含审核时的修改）放进 candidates/ 作为起点，原样记录放进 previous/，反馈放进 docs/feedback.md。
 * 模板辅助修改：把主模板调用树中已保存的模板复制进 candidates/ 作为工作副本（M49），并记录各自所基于的保存内容（M51）。
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dslDocumentKind } from '../dsl.js';
import { parseRenderRequest } from '../request.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, loadWorkspace, loadWorkspaceDocuments, parseJsonKeepingPrecision, sameStaticSchema, type StaticSchemaRef } from '../workspace.js';
import { templateCallTree } from './diff.js';
import { locate } from './locations.js';
import { isGoogleModel, startModelProxy } from './model-proxy.js';
import { DRAFT_FILE, OUTCOME_FILE, checkAgentOutcome, normalizeCandidatePath, type FieldLocation, type OutcomeCheck, type OutcomeContext, type OutcomeTarget, type PendingItem, type SubmittedOutcome } from './outcome.js';
import { runtimeQuota, type QuotaStop } from './quota.js';
import { readPreviousRound, type PreviousRound } from './review.js';
import { AgentUsageError, exists, isDirectory, isFile, sha256, workspaceFingerprint } from './round-files.js';
import { AGENT_TASKS, type AgentTask, type AgentTaskId, type CandidateKind } from './tasks.js';
import { writeTemplateDomain, writeTemplateReference } from './materials.js';
import { observeContext, type ContextStop } from './context-usage.js';
import { materialFingerprint, resourceFingerprint, restoreHandoff, saveHandoff } from './handoff.js';

export { AgentUsageError, workspaceFingerprint } from './round-files.js';

/** 缺省用 OpenCode Go 上的 Claude Haiku 5.5（M232）。 */
export const DEFAULT_ENDPOINT = 'https://opencode.ai/inference/go/anthropic';
export const DEFAULT_MODEL = 'claude-haiku-5-5';
/** Claude Code 的轻量任务（如生成标题）用的模型，不看图。 */
export const DEFAULT_SMALL_MODEL = 'claude-haiku-5-5';
export const DEFAULT_KEY_ENV = 'OPEN_CODE_API_KEY';
/** Gemini 只提供 Google 接口，经本机转换代理连这个端点；轻量任务模型缺省与模型相同（M232）。 */
export const DEFAULT_GOOGLE_ENDPOINT = 'https://opencode.ai/inference/go/google/v1beta';
const AGENT_MATERIALS = fileURLToPath(new URL('../../agent/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin.js', import.meta.url));
/** 子进程只继承这些系统变量。 */
const SYSTEM_VARIABLES = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles', 'USERNAME', 'USER',
  'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG'];

export interface AgentRunOptions {
  /** 任务类型、示例图、项目说明与资源仓库：带 from 时沿用上一轮，不能再给。 */
  readonly task?: AgentTaskId;
  readonly sample?: string;
  readonly brief?: string;
  readonly resources?: string;
  /** 新的轮次目录：不存在或为空。 */
  readonly out: string;
  readonly domain?: string;
  readonly workspace?: string;
  /** 数据集提取所基于的静态数据定义：名称，或"名称@版本"，只写名称时取工作区中的最新版本。 */
  readonly definition?: string;
  /** 模板辅助设计所基于的已保存数据集 id。 */
  readonly dataset?: string;
  /** 示例图对应的出图请求文件：主模板名、参数与输出尺寸；审核页按它重新渲染预览（M52）。模板辅助修改时，主模板就是要修改的已保存模板。 */
  readonly request?: string;
  /** 模板辅助修改的修改要求（Markdown）；反引号里以模板名开头的元素路径必须存在。 */
  readonly requirement?: string;
  /** 上一轮的轮次目录：下一轮沿用它的输入，拿到它的成果（含审核时的修改）与反馈（M58）。 */
  readonly from?: string;
  /** 给下一轮的反馈（Markdown）；带 from 时必须给。 */
  readonly feedback?: string;
  /** key 的值只在内存中传给子进程；keyEnv 是它所在的环境变量名，只用于记录。 */
  readonly key: string;
  readonly keyEnv: string;
  readonly model?: string;
  readonly smallModel?: string;
  readonly endpoint?: string;
  readonly maxTurns?: number;
  /** 单请求有效输入达到此观测阈值后停止并交接；缺省仅观测，不是请求前 token 限额。 */
  readonly contextLimit?: number;
  /** 推理力度：传给 Claude Code 的 --effort；不给时不传，用 Claude Code 的缺省（票据 23）。 */
  readonly effort?: AgentEffort;
  /** Claude Code 可执行文件与前置参数；测试用假执行器代替。 */
  readonly claude?: { readonly command: string; readonly args?: readonly string[] };
  /** 输入全部校验通过、创建轮次目录之前调用；命令行在这里打印"开始……"（票据 28）。 */
  readonly onStart?: (roundDir: string) => void;
}

/** Claude Code 的 --effort 取值。自适应思考的模型（如 Haiku 5.5）只认它，不认 MAX_THINKING_TOKENS（票据 23）。 */
export const AGENT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentEffort = (typeof AGENT_EFFORTS)[number];

export interface RoundUsage {
  readonly wallMs: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** 输出 token 中的思考部分（结果消息的 output_tokens_details.thinking_tokens，票据 23）。 */
  readonly thinkingTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly servedModel?: string;
  readonly claudeCodeVersion?: string;
  /** Claude Code 的结束方式，如 success、error_max_turns。 */
  readonly endedBy?: string;
  readonly context?: { readonly requests: number; readonly peakInputTokens: number | null; readonly compactions: number };
}

/** 轮次记录 round.json：无论成果是否合格都写出。 */
export interface RoundRecord {
  readonly format: 'renderweave-round/1';
  readonly task: AgentTaskId;
  readonly round: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly inputs: RoundInputs;
  readonly runtime: {
    /** google：模型只提供 Google 接口，本轮经本机转换代理连接 endpoint（M232）。 */
    readonly model: string; readonly smallModel: string; readonly protocol: 'anthropic' | 'google'; readonly endpoint: string; readonly maxTurns: number;
    /** 推理力度；没设为 null（票据 23）。 */
    readonly effort: AgentEffort | null;
    readonly contextLimit?: number | null;
    readonly skills?: 'disabled';
    readonly keyEnv: string; readonly tools: string; readonly mcpTools: readonly string[];
  };
  readonly run: RoundUsage & { readonly exitCode: number | null; readonly error?: string; readonly mcp?: readonly string[]; readonly stopped?: QuotaStop;
    readonly contextStopped?: ContextStop; readonly handoffSha256?: string };
  readonly verdict: OutcomeCheck['verdict'];
}

export interface RoundInputs {
  readonly sample: { readonly source: string; readonly file: string; readonly sha256: string };
  readonly brief: { readonly source: string; readonly sha256: string };
  readonly domain: string | null;
  readonly workspace: { readonly source: string | null; readonly fingerprint: string; readonly documents: number };
  /** 资源仓库目录；审核时重新渲染预览要用。 */
  readonly resources?: string;
  /** 本轮所基于的数据定义（数据集提取、模板辅助设计）。 */
  readonly definition?: StaticSchemaRef | null;
  /** 本轮所基于的数据集（模板辅助设计、模板辅助修改）。 */
  readonly dataset?: string | null;
  /** 示例图对应的出图请求：原文件与规范化后存在轮次目录的 request.json。 */
  readonly request?: { readonly source: string; readonly file: 'request.json'; readonly template: string } | null;
  /** 模板辅助修改可以改的已保存模板（主模板的调用树），以及各自所基于的保存内容：工作区中的文件名与内容哈希（M51）。 */
  readonly templates?: readonly TemplateBasis[];
  /** 模板辅助修改的修改要求，存在轮次目录的 requirement.md。 */
  readonly requirement?: { readonly source: string; readonly file: 'requirement.md'; readonly sha256: string } | null;
  /** 下一轮的反馈，存在轮次目录的 feedback.md。 */
  readonly feedback?: { readonly source: string; readonly file: 'feedback.md'; readonly sha256: string } | null;
  /** 上一轮；第 1 轮为 null。 */
  readonly previous: PreviousRef | null;
}

export interface TemplateBasis {
  readonly name: string;
  readonly file: string;
  readonly sha256: string;
}

/** 轮次链上的上一环：沿 previous.dir 可以一直追到第 1 轮。 */
export interface PreviousRef {
  readonly dir: string;
  readonly round: number;
  /** 上一轮成果的哈希；结构不合格、没有成果时为 null。 */
  readonly outcomeSha256: string | null;
  readonly reviewSha256: string | null;
  readonly reviewStatus: 'inProgress' | 'approved' | 'rejected' | null;
  /** 模板辅助修改：已保存的模板在上一轮之后被改过，本轮从最新保存的内容重新开始。 */
  readonly basisChanged?: boolean;
}

/** 轮次成果 outcome.json（M48）：Agent 交回的内容加上 RenderWeave 记录的输入与用量；结构合格时才写出。 */
export interface RoundOutcome {
  readonly format: 'renderweave-outcome/1';
  readonly task: AgentTaskId;
  readonly round: number;
  readonly inputs: {
    readonly sampleSha256: string; readonly workspaceFingerprint: string;
    readonly previous: { readonly dir: string; readonly round: number; readonly outcomeSha256: string | null; readonly reviewSha256: string | null } | null;
    readonly feedbackSha256?: string;
  };
  readonly candidates: readonly { readonly path: string; readonly kind: CandidateKind; readonly name?: string; readonly sha256: string;
    readonly published?: { readonly name: string; readonly version: number };
    /** 模板辅助修改的工作副本所基于的保存内容（M51）；新增的模板没有。 */
    readonly revises?: { readonly file: string; readonly sha256: string } }[];
  /** 字段在示例图上的位置，来自 Agent，没有时为空列表。 */
  readonly locations: readonly FieldLocation[];
  readonly pending: readonly PendingItem[];
  readonly notes: string;
  readonly usage: RoundUsage;
}

export interface AgentRunResult {
  readonly roundDir: string;
  readonly record: RoundRecord;
  readonly check: OutcomeCheck;
  readonly outcome?: RoundOutcome;
  /** 宿主恢复草稿，相对轮次目录；不作为正式 outcome 返回。 */
  readonly draft?: string;
}

/** 下一轮的候选从哪里开始：写进提示词。 */
const SEED_NOTES = {
  previous: 'candidates/ 中已放好上一轮的成果（含审核时的修改），在它的基础上按反馈修改，不要从头重做。',
  unqualified: 'candidates/ 中已放好上一轮交回的文件。上一轮的成果结构不合格，没有经过审核：按 previous/check.json 的问题与反馈修改。',
  applied: '上一轮的成果已经应用：candidates/ 中放的是应用后最新保存的模板，已含上一轮的修改，在它的基础上按反馈修改。',
  rebased: '已保存的模板在上一轮之后被人改过：candidates/ 中放的是最新保存的模板，previous/candidates/ 中上一轮的工作副本只作参考，在最新内容上按修改要求与反馈重新修改。',
};

export async function runAgentTask(given: AgentRunOptions): Promise<AgentRunResult> {
  if (given.contextLimit !== undefined && (!Number.isSafeInteger(given.contextLimit) || given.contextLimit < 1)) throw new AgentUsageError('--context-limit 必须是正整数');
  if (given.from === undefined && given.feedback !== undefined) throw new AgentUsageError('--feedback 只用于带 --from 发起的下一轮');
  if (given.from !== undefined) checkNextRound(given);
  const previous = given.from === undefined ? undefined : await readPreviousRound(given.from);
  const options = previous ? inherit(given, previous) : given;
  if (options.task === undefined || options.sample === undefined || options.brief === undefined || options.resources === undefined) {
    throw new AgentUsageError('发起第 1 轮要给出任务类型、示例图、项目说明与资源仓库');
  }
  const task = AGENT_TASKS[options.task];
  const templateTask = task.candidateKinds.includes('template');
  if (!task.implemented) throw new AgentUsageError(`任务类型"${task.name}"尚未实现`);
  checkTaskOrder(task, options);
  await requireFile(options.sample, '示例图');
  // 按文件头定扩展名：文件名与内容不符时，Claude Code 会按扩展名声明错误的图片类型。
  const extension = imageExtension(await readFile(options.sample));
  if (!extension) throw new AgentUsageError(`示例图不是 PNG、JPEG 或 WebP：${options.sample}`);
  await requireFile(options.brief, '项目说明');
  const domainFile = options.domain === undefined ? undefined : join(AGENT_MATERIALS, 'domains', `${options.domain}.md`);
  if (domainFile) {
    // 以 _ 开头的是给维护者的模板（如 _template.md），不是领域约定包。
    try { if (options.domain!.startsWith('_')) throw new Error(); await requireFile(domainFile, '领域约定'); } catch {
      const known = (await readdir(join(AGENT_MATERIALS, 'domains'))).filter((file) => file.endsWith('.md') && !file.startsWith('_')).map((file) => file.slice(0, -3));
      throw new AgentUsageError(`没有领域约定包 ${options.domain}；可用：${known.join('、')}`);
    }
  }
  if (options.workspace !== undefined && !(await isDirectory(options.workspace))) throw new AgentUsageError(`工作区目录无法读取：${options.workspace}`);
  if (task.requires !== 'none' && options.workspace === undefined) throw new AgentUsageError(`${task.name}要用 --workspace 指定已发布的数据定义与已保存的数据集、模板所在的工作区`);
  if (!(await isFile(join(options.resources, 'resources.json')))) throw new AgentUsageError(`资源仓库缺少 resources.json：${options.resources}`);
  const basis = task.requires === 'definition' || task.requires === 'dataset' ? await resolveBasis(task.requires, options) : { definition: null, dataset: null };
  const request = options.request === undefined ? null : await readRequest(options.request, task.id, basis, options.workspace!, options.dataset);
  const dataset = request?.dataset ?? basis.dataset;
  const revision = task.id === 'template-revision' ? await revisableTemplates(options.workspace!, request!.template) : undefined;
  // 元素路径只在第 1 轮核对：沿用到下一轮时，上一轮可能已经把那些元素改名或移走并应用了。
  if (revision) await checkRequirement(options.requirement!, previous ? [] : revision);
  if (options.feedback !== undefined) await requireFile(options.feedback, '反馈');
  if (options.key === '') throw new AgentUsageError(`环境变量 ${options.keyEnv} 为空`);
  const model = options.model ?? DEFAULT_MODEL;
  const google = isGoogleModel(model);
  const smallModel = options.smallModel ?? (google ? model : DEFAULT_SMALL_MODEL);
  if (isGoogleModel(smallModel) !== google) {
    throw new AgentUsageError('模型与轻量任务模型要同为 Gemini，或同为 Anthropic 接口的模型：Gemini 经本机转换代理连接，两者共用一个端点');
  }
  const endpoint = options.endpoint ?? (google ? DEFAULT_GOOGLE_ENDPOINT : DEFAULT_ENDPOINT);
  const roundDir = resolve(options.out);
  if (await exists(roundDir) && (!(await isDirectory(roundDir)) || (await readdir(roundDir)).length > 0)) {
    throw new AgentUsageError(`轮次目录必须不存在或为空：${options.out}`);
  }
  options.onStart?.(roundDir);

  const startedAt = new Date().toISOString();
  const round = previous ? previous.round + 1 : 1;
  const agentDir = join(roundDir, 'agent'), snapshotDir = join(roundDir, 'snapshot'), logsDir = join(roundDir, 'logs');
  for (const dir of [join(agentDir, 'docs'), join(agentDir, 'candidates'), join(agentDir, 'scratch'), snapshotDir, logsDir]) await mkdir(dir, { recursive: true });

  // 资料：反馈 > 修改要求 > 项目说明 > 领域约定 > 通用做法；DSL 参考与成果格式随任务而定。
  const sampleFile = `sample${extension}`;
  await copyFile(options.sample, join(agentDir, sampleFile));
  await copyFile(options.brief, join(agentDir, 'docs/brief.md'));
  if (templateTask) {
    await copyFile(join(AGENT_MATERIALS, 'template-core.md'), join(agentDir, 'docs/core.md'));
    await copyFile(join(AGENT_MATERIALS, 'reference/template-outcome.md'), join(agentDir, 'docs/outcome.md'));
    await writeTemplateReference(AGENT_MATERIALS, join(agentDir, 'docs'));
    if (domainFile) await writeTemplateDomain(domainFile, join(agentDir, `docs/domain-${options.domain}.md`));
  } else {
    await copyFile(join(AGENT_MATERIALS, 'guide.md'), join(agentDir, 'docs/guide.md'));
    if (domainFile) await copyFile(domainFile, join(agentDir, `docs/domain-${options.domain}.md`));
    for (const reference of task.references) await copyFile(join(AGENT_MATERIALS, 'reference', `${reference}.md`), join(agentDir, `docs/${reference === 'outcome' ? 'outcome' : 'dsl-reference'}.md`));
  }
  if (request) {
    await writeFile(join(agentDir, 'docs/request.json'), `${JSON.stringify(request.document, null, 2)}\n`);
    await writeFile(join(roundDir, 'request.json'), `${JSON.stringify(request.document, null, 2)}\n`);
  }
  for (const [file, name] of [[options.requirement, 'requirement.md'], [options.feedback, 'feedback.md']] as const) {
    if (file === undefined) continue;
    await copyFile(file, join(agentDir, 'docs', name));
    await copyFile(file, join(roundDir, name));
  }

  // 候选的起点：模板辅助修改从已保存的模板开始（工作副本，M49）；下一轮从上一轮成果（含审核时的修改）继续。
  const seeds = new Map((revision ?? []).map((entry) => [`candidates/${entry.file}`, entry.bytes] as [string, Uint8Array]));
  let seedNote = '', basisChanged: boolean | undefined;
  if (previous) {
    for (const file of previous.files) await writeAt(join(agentDir, 'previous', file.name), file.bytes);
    for (const candidate of previous.candidates) await writeAt(join(agentDir, 'previous', candidate.path), candidate.bytes);
    basisChanged = revision ? (previous.record.inputs.templates ?? []).some((entry) => revision.find((item) => item.name === entry.name)?.sha256 !== entry.sha256) : undefined;
    if (!basisChanged) {
      for (const candidate of previous.candidates) {
        const name = templateName(candidate.bytes);
        for (const [path, bytes] of seeds) if (name !== undefined && templateName(bytes) === name) seeds.delete(path);
        seeds.set(candidate.path, candidate.bytes);
      }
    }
    seedNote = basisChanged ? (previous.applied ? SEED_NOTES.applied : SEED_NOTES.rebased) : previous.outcomeSha256 === null ? SEED_NOTES.unqualified : SEED_NOTES.previous;
  }
  for (const [path, bytes] of seeds) await writeAt(join(agentDir, path), bytes);

  let prompt = (await readFile(join(AGENT_MATERIALS, 'tasks', `${task.id}.md`), 'utf8')).replaceAll('{sample}', sampleFile)
    .replaceAll('{definition}', basis.definition ? formatStaticSchemaRef(basis.definition) : '')
    .replaceAll('{dataset}', dataset ?? '').replaceAll('{template}', request?.template ?? '')
    .replaceAll('{templates}', (revision ?? []).map((entry) => `${entry.name}（candidates/${entry.file}）`).join('、'));
  if (previous) {
    prompt += `\n${(await readFile(join(AGENT_MATERIALS, 'tasks', templateTask ? 'template-next-round.md' : 'next-round.md'), 'utf8')).replaceAll('{round}', String(round)).replaceAll('{seeds}', seedNote)}`;
  }

  // 工作区快照：只复制工作区读取的顶层 JSON 文件；服务启动时读入，Agent 只能经工具读取。
  let documents = 0;
  if (options.workspace !== undefined) {
    for (const file of (await readdir(options.workspace)).filter((name) => name.endsWith('.json')).sort()) {
      await copyFile(join(options.workspace, file), join(snapshotDir, file));
      documents++;
    }
  }
  const textInput = async <T extends 'requirement.md' | 'feedback.md'>(file: string | undefined, name: T) =>
    (file === undefined ? null : { source: resolve(file), file: name, sha256: sha256(await readFile(file)) });
  const requirement = await textInput(options.requirement, 'requirement.md');
  const feedback = await textInput(options.feedback, 'feedback.md');
  const inputs: RoundInputs = {
    sample: { source: resolve(options.sample), file: `agent/${sampleFile}`, sha256: sha256(await readFile(options.sample)) },
    brief: { source: resolve(options.brief), sha256: sha256(await readFile(options.brief)) },
    domain: options.domain ?? null,
    workspace: { source: options.workspace === undefined ? null : resolve(options.workspace), fingerprint: await workspaceFingerprint(snapshotDir), documents },
    resources: resolve(options.resources),
    definition: basis.definition, dataset,
    request: request ? { source: resolve(options.request!), file: 'request.json', template: request.template } : null,
    ...(revision ? { templates: revision.map(({ name, file, sha256: digest }) => ({ name, file, sha256: digest })), requirement } : {}),
    ...(previous ? { feedback } : {}),
    previous: previous ? {
      dir: previous.dir, round: previous.round, outcomeSha256: previous.outcomeSha256, reviewSha256: previous.reviewSha256, reviewStatus: previous.reviewStatus,
      ...(basisChanged !== undefined ? { basisChanged } : {}),
    } : null,
  };

  const binding = templateTask ? sha256(JSON.stringify({ workspace: inputs.workspace.fingerprint, sample: inputs.sample.sha256,
    materials: await materialFingerprint(join(agentDir, 'docs')), resources: await resourceFingerprint(options.resources) })) : '';
  if (previous && templateTask) await restoreHandoff(previous.dir, previous.record.run.handoffSha256, binding, seeds, join(agentDir, 'docs/handoff.md'));
  await writeFile(join(logsDir, 'prompt.md'), prompt);

  // 交回后的成果校验与交回前的 check_outcome 用同一份上下文；它放在 Agent 工作目录之外，Agent 改不了。
  const context: OutcomeContext = {
    ...(task.id === 'dataset-extraction' && basis.definition ? { definition: basis.definition } : {}),
    ...(request ? { request: { ...request.document, template: request.template } } : {}),
    ...(revision ? { revision: { templates: revision.map((entry) => entry.name) } } : {}),
  };
  const outcomeContext = join(logsDir, 'outcome-context.json');
  await writeFile(outcomeContext, `${JSON.stringify({ task: task.id, ...context } satisfies OutcomeTarget, null, 2)}\n`);
  const maxTurns = options.maxTurns ?? task.maxTurns;
  const mcpConfig = join(logsDir, 'mcp.json');
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { rw: { type: 'stdio', command: process.execPath, args: [
    BIN, 'mcp', '--workspace', snapshotDir, '--resources', resolve(options.resources), '--root', agentDir, '--outcome-context', outcomeContext,
    '--log', join(logsDir, 'tools.jsonl'), '--tools', task.mcpTools.join(','),
  ] } } }, null, 2)}\n`);
  const env: Record<string, string> = Object.fromEntries(SYSTEM_VARIABLES.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  if (process.platform !== 'win32') env['HOME'] = join(logsDir, 'home');
  // Gemini：Claude Code 连本机转换代理，拿到的是本轮令牌；上游 key 只留在本进程。
  const controller = new AbortController();
  let stopped: QuotaStop | undefined;
  let contextStopped: ContextStop | undefined;
  const stop = (reason: QuotaStop) => { stopped ??= reason; controller.abort(); };
  const observer = observeContext(options.contextLimit, (reason) => { contextStopped ??= reason; controller.abort(); });
  const proxy = google ? await startModelProxy({ upstream: endpoint, key: options.key, log: join(logsDir, 'model-proxy.jsonl'), onHardQuota: stop }) : undefined;
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(logsDir, 'claude-config'),
    ANTHROPIC_BASE_URL: proxy?.url ?? endpoint, ANTHROPIC_AUTH_TOKEN: proxy?.token ?? options.key, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '600000',
  });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--restricted', '--tools', task.tools,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__rw', '--permission-mode', 'acceptEdits',
    '--max-turns', String(maxTurns), '--no-session-persistence', '--disable-slash-commands', ...(options.effort ? ['--effort', options.effort] : [])];

  const started = Date.now();
  let executed: Awaited<ReturnType<typeof execute>>;
  try {
    executed = await execute(options.claude ?? { command: 'claude' }, args, { cwd: agentDir, env, prompt, logsDir, signal: controller.signal, stop, observe: observer.accept });
  } finally {
    await proxy?.close();
  }
  const { mcp, apiError, ...streamUsage } = await readUsage(join(logsDir, 'stream.jsonl'));
  const contextReport = observer.report();
  await writeFile(join(roundDir, 'context.json'), `${JSON.stringify(contextReport, null, 2)}\n`);
  const usage: RoundUsage = { wallMs: Date.now() - started, ...streamUsage,
    context: { requests: contextReport.requests.length, peakInputTokens: contextReport.peakInputTokens, compactions: contextReport.compactions.length } };

  const snapshot = await loadWorkspace({ dir: snapshotDir, resourcesDir: options.resources });
  const checked = await checkAgentOutcome({ task: task.id, agentDir, workspace: snapshot, context });
  const check = stopped || contextStopped ? { ...checked, verdict: 'unqualified' as const } : checked;
  const recovered = check.submission ? undefined : await recoverCandidates(agentDir, task);
  const draftCheck = recovered ? await checkAgentOutcome({ task: task.id, agentDir, workspace: snapshot, context, recovered }) : undefined;
  const deliverable = draftCheck ?? check;
  const submission = recovered ?? check.submission;
  let outcome: RoundOutcome | undefined;
  if (submission && deliverable.candidates.length > 0) {
    // 候选文件复制到轮次目录，成为本轮成果；之后审核与应用都读这里。
    for (const candidate of deliverable.candidates) {
      await mkdir(dirname(join(roundDir, candidate.path)), { recursive: true });
      await copyFile(join(agentDir, candidate.path), join(roundDir, candidate.path));
    }
    outcome = {
      format: 'renderweave-outcome/1', task: task.id, round,
      inputs: {
        sampleSha256: inputs.sample.sha256, workspaceFingerprint: inputs.workspace.fingerprint,
        previous: previous ? { dir: previous.dir, round: previous.round, outcomeSha256: previous.outcomeSha256, reviewSha256: previous.reviewSha256 } : null,
        ...(feedback ? { feedbackSha256: feedback.sha256 } : {}),
      },
      candidates: deliverable.candidates.map((candidate) => {
        const basisOf = candidate.kind === 'template' ? revision?.find((entry) => entry.name === candidate.name) : undefined;
        return {
          path: candidate.path, kind: candidate.kind!, ...(candidate.name !== undefined ? { name: candidate.name } : {}),
          sha256: candidate.sha256!, ...(candidate.published ? { published: candidate.published } : {}),
          ...(basisOf ? { revises: { file: basisOf.file, sha256: basisOf.sha256 } } : {}),
        };
      }),
      locations: (submission.locations ?? []).map((item) => ({ ...item, file: normalizeCandidatePath(item.file) })),
      pending: submission.pending.map((item) => ({ ...item, file: normalizeCandidatePath(item.file) })),
      notes: submission.notes,
      usage,
    };
    if (recovered) {
      const { submission: _recovered, ...assessment } = deliverable;
      await writeFile(join(roundDir, DRAFT_FILE), `${JSON.stringify({ format: 'renderweave-draft/1', source: 'hostRecovery', outcome, check: assessment }, null, 2)}\n`);
      outcome = undefined;
    } else await writeFile(join(roundDir, OUTCOME_FILE), `${JSON.stringify(outcome, null, 2)}\n`);
  }
  const { submission: _submission, ...checkRecord } = check;
  await writeFile(join(roundDir, 'check.json'), `${JSON.stringify(checkRecord, null, 2)}\n`);
  const handoffSha256 = templateTask ? await saveHandoff(roundDir, { binding, source: outcome ? 'agent' : recovered ? 'hostRecovery' : 'none',
    reason: contextStopped ? 'contextLimit' : 'roundEnd',
    candidates: deliverable.candidates.flatMap((c) => c.sha256 ? [{ path: c.path, sha256: c.sha256 }] : []) }) : undefined;
  const record: RoundRecord = {
    format: 'renderweave-round/1', task: task.id, round, startedAt, endedAt: new Date().toISOString(), inputs,
    runtime: { model, smallModel, protocol: google ? 'google' : 'anthropic', endpoint, maxTurns, effort: options.effort ?? null, contextLimit: options.contextLimit ?? null, skills: 'disabled',
      keyEnv: options.keyEnv, tools: task.tools, mcpTools: task.mcpTools },
    run: { ...usage, exitCode: executed.exitCode, ...(contextStopped ? { contextStopped } : {}), ...(handoffSha256 ? { handoffSha256 } : {}),
      ...(stopped ? { stopped, error: `硬额度耗尽（${stopped.limit}），已停止本轮。额度恢复后用 --from "${roundDir}" --feedback <反馈文件> 续跑` }
        : contextStopped ? { error: `有效输入达到交接阈值 ${contextStopped.limit}（观测 ${contextStopped.observedInputTokens}）。已保存本轮；用 --from "${roundDir}" --feedback ${templateTask ? `"${join(roundDir, 'handoff-feedback.md')}"` : '<反馈文件>'} --out <新轮次目录> 续跑；新一轮预算需显式指定。` }
          : executed.error ?? apiError ? { error: executed.error ?? apiError } : {}), ...(mcp ? { mcp } : {}) },
    verdict: check.verdict,
  };
  await writeFile(join(roundDir, 'round.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { roundDir, record, check, ...(outcome ? { outcome } : {}), ...(recovered && deliverable.candidates.length > 0 ? { draft: DRAFT_FILE } : {}) };
}

/** 任务顺序（M43）与各任务需要的输入：--definition、--dataset 只接受该任务用得上的那些。 */
function checkTaskOrder(task: AgentTask, options: AgentRunOptions): void {
  if (task.requires === 'none') {
    const given = (['definition', 'dataset'] as const).filter((name) => options[name] !== undefined);
    if (given.length > 0) throw new AgentUsageError(`${task.name}不用 ${given.map((name) => `--${name}`).join('、')}：它从示例图提取新的数据定义，不基于已有的数据定义或数据集`);
  }
  if (task.requires === 'definition') {
    if (options.dataset !== undefined) throw new AgentUsageError(`${task.name}不用 --dataset：它基于已发布的数据定义提取新的数据集，用 --definition 指定数据定义`);
    if (options.definition === undefined) {
      throw new AgentUsageError(`只给了示例图，没有指定数据定义：先做数据定义提取并发布（M43），例如 renderweave agent run --task 数据定义提取 …`);
    }
  }
  if (task.requires === 'dataset' && options.dataset === undefined) {
    throw new AgentUsageError(`${task.name}要基于已保存的数据集：先做数据集提取并应用（M43），再用 --dataset 指定数据集 id`);
  }
  if (task.requires === 'template') {
    if (options.definition !== undefined) throw new AgentUsageError(`${task.name}不用 --definition：数据定义取主模板的基准`);
    if (options.request === undefined) {
      throw new AgentUsageError(`${task.name}要用 --request 给出出图请求：其中的主模板就是要修改的已保存模板，审核时按它渲染修改前后的预览`);
    }
    if (options.requirement === undefined) throw new AgentUsageError(`${task.name}要用 --requirement 给出修改要求（Markdown，可以写元素路径）`);
  } else if (options.requirement !== undefined) throw new AgentUsageError('只有模板辅助修改用 --requirement');
  if (task.request === 'none' && options.request !== undefined) throw new AgentUsageError(`${task.name}不用出图请求，去掉 --request`);
  if (task.request === 'required' && options.request === undefined) {
    throw new AgentUsageError(`${task.name}要用 --request 给出示例图对应的出图请求（主模板名、参数与输出尺寸），审核时按它重新渲染预览`);
  }
}

/** 下一轮只给反馈与运行参数：任务、素材、基准、出图请求与修改要求都沿用上一轮。 */
function checkNextRound(given: AgentRunOptions): void {
  const fixed = ['task', 'sample', 'brief', 'resources', 'domain', 'workspace', 'definition', 'dataset', 'request', 'requirement'] as const;
  const repeated = fixed.filter((name) => given[name] !== undefined);
  if (repeated.length > 0) {
    throw new AgentUsageError(`带 --from 发起下一轮时沿用上一轮的输入，不能再给 ${repeated.map((name) => `--${name}`).join('、')}；要换输入就重新发起第 1 轮`);
  }
  if (given.feedback === undefined) throw new AgentUsageError('带 --from 发起下一轮时要用 --feedback 给出反馈');
}

/** 下一轮沿用上一轮的任务、素材、基准、出图请求与修改要求；工作区与资源仓库沿用上一轮的来源，工作区重新取快照。 */
function inherit(given: AgentRunOptions, previous: PreviousRound): AgentRunOptions {
  const { dir, record: { task, inputs } } = previous;
  return {
    ...given, task, sample: join(dir, inputs.sample.file), brief: join(dir, 'agent/docs/brief.md'),
    ...(previous.resources !== undefined ? { resources: previous.resources } : {}),
    ...(inputs.domain !== null ? { domain: inputs.domain } : {}),
    ...(inputs.workspace.source !== null ? { workspace: inputs.workspace.source } : {}),
    ...(task === 'dataset-extraction' && inputs.definition ? { definition: `${inputs.definition.name}@${inputs.definition.version}` } : {}),
    ...(task !== 'dataset-extraction' && inputs.dataset ? { dataset: inputs.dataset } : {}),
    ...(inputs.request ? { request: join(dir, 'request.json') } : {}),
    ...(inputs.requirement ? { requirement: join(dir, 'requirement.md') } : {}),
  };
}

/** 数据集提取按 --definition 找已发布的数据定义；模板辅助设计按 --dataset 找已保存的数据集，数据定义取它选定的那一份。 */
async function resolveBasis(requires: 'definition' | 'dataset', options: AgentRunOptions): Promise<{ definition: StaticSchemaRef; dataset: string | null }> {
  const workspace = await loadWorkspaceDocuments(options.workspace!);
  const published = workspace.staticSchemas.filter((entry) => entry.compiled !== undefined);
  const list = (names: string[]) => (names.length === 0 ? '工作区中没有' : `可用：${[...names].sort().join('、')}`);
  let definition: StaticSchemaRef | undefined;
  if (options.definition !== undefined) {
    const match = /^(.+?)(?:@([1-9]\d*))?$/.exec(options.definition);
    const name = match?.[1] ?? options.definition, version = match?.[2] === undefined ? undefined : Number(match[2]);
    const versions = published.filter((entry) => entry.ref.name === name).map((entry) => entry.ref.version);
    const chosen = version ?? (versions.length > 0 ? Math.max(...versions) : undefined);
    if (chosen === undefined || !versions.includes(chosen)) {
      throw new AgentUsageError(`工作区中没有已发布的数据定义 ${options.definition}：先做数据定义提取并发布（M43）。${list(published.map((entry) => `${entry.ref.name}@${entry.ref.version}`))}`);
    }
    definition = { name, version: chosen };
  }
  if (requires === 'definition') {
    // checkTaskOrder 已要求数据集提取给出 --definition；走到这里说明校验漏了，不能带着空的基准往下走。
    if (definition === undefined) throw new Error('数据集提取没有所基于的数据定义：--definition 的校验被绕过了');
    return { definition, dataset: null };
  }
  const entry = workspace.datasets.find((item) => item.id === options.dataset);
  if (!entry) throw new AgentUsageError(`工作区中没有数据集 ${options.dataset}：先做数据集提取并应用（M43）。${list(workspace.datasets.map((item) => item.id))}`);
  const ref = entry.document.dataset.staticSchema;
  if (!published.some((item) => sameStaticSchema(item.ref, ref))) throw new AgentUsageError(`数据集 ${entry.id} 选定的数据定义 ${formatStaticSchemaRef(ref)} 没有发布在工作区中`);
  if (definition && !sameStaticSchema(definition, ref)) {
    throw new AgentUsageError(`数据集 ${entry.id} 选定的是 ${formatStaticSchemaRef(ref)}，与 --definition ${options.definition} 不一致`);
  }
  return { definition: ref, dataset: entry.id };
}

/**
 * 读出图请求并规范化：
 * - 模板辅助设计：数据集固定为 --dataset；
 * - 模板辅助修改：数据集取 --dataset 或请求中的已保存数据集，主模板必须已在工作区中；
 * - 数据集提取：去掉数据集，预览时换成候选，且主模板必须已在工作区中、基准是所选数据定义。
 */
async function readRequest(file: string, task: AgentTaskId, basis: { definition: StaticSchemaRef | null; dataset: string | null }, workspaceDir: string,
  datasetOption: string | undefined): Promise<{ document: Record<string, unknown>; template: string; dataset?: string }> {
  let value: unknown;
  const tooPrecise: string[] = [];
  try {
    value = parseJsonKeepingPrecision(await readFile(file, 'utf8'), tooPrecise);
  } catch (error) {
    throw new AgentUsageError(`出图请求无法读取：${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (!isRecord(value)) throw new AgentUsageError(`出图请求必须是 JSON 对象：${file}`);
  if (tooPrecise.length > 0) throw new AgentUsageError(`出图请求中的数值超过 15 位有效数字：${tooPrecise.join('、')}`);
  const document: Record<string, unknown> = { ...value };
  const given = document['dataset'];
  const savedId = isRecord(given) && Object.keys(given).length === 1 && typeof given['id'] === 'string' ? given['id'] : undefined;
  let dataset: string | undefined;
  if (task === 'template-design' || task === 'template-revision') {
    dataset = task === 'template-design' ? basis.dataset! : datasetOption ?? savedId;
    if (dataset === undefined) throw new AgentUsageError('模板辅助修改的出图请求要用已保存的数据集：写成 {"dataset": {"id": …}}，或用 --dataset 指定');
    if (given !== undefined && savedId !== dataset) throw new AgentUsageError(`出图请求的数据集要写成 {"id": "${dataset}"}，或省略`);
    document['dataset'] = { id: dataset };
  } else delete document['dataset'];
  const parsed = parseRenderRequest({ ...document, dataset: document['dataset'] ?? { id: '候选数据集' } });
  if (!parsed.request) throw new AgentUsageError(`出图请求不合格：${parsed.problems.map((problem) => problem.message).join('；')}`);
  const template = parsed.request.template;
  if (task === 'dataset-extraction' || task === 'template-revision') {
    const workspace = await loadWorkspaceDocuments(workspaceDir);
    const saved = workspace.templates.find((entry) => entry.name === template);
    if (!saved) throw new AgentUsageError(`出图请求的模板 ${template} 不在工作区中：${task === 'dataset-extraction' ? '数据集提取的预览要用已保存的模板' : '模板辅助修改要基于已保存的模板'}`);
    if (task === 'template-revision' && !workspace.datasets.some((entry) => entry.id === dataset)) {
      throw new AgentUsageError(`工作区中没有数据集 ${dataset}：模板辅助修改按出图请求渲染修改前后的预览，要用已保存的数据集`);
    }
    const base = isRecord(saved.document) ? saved.document['base'] : undefined;
    if (task === 'dataset-extraction' && (!isRecord(base) || !sameStaticSchema({ name: String(base['name']), version: Number(base['version']) }, basis.definition!))) {
      throw new AgentUsageError(`出图请求的模板 ${template} 的基准不是 ${formatStaticSchemaRef(basis.definition!)}`);
    }
  }
  return { document, template, ...(dataset !== undefined ? { dataset } : {}) };
}

/** 模板辅助修改可以改的已保存模板：主模板及它调用的模板，连同文件内容（工作副本的起点与 M51 的基准）。 */
async function revisableTemplates(workspaceDir: string, main: string): Promise<(TemplateBasis & { document: unknown; bytes: Uint8Array })[]> {
  const workspace = await loadWorkspaceDocuments(workspaceDir);
  const result: (TemplateBasis & { document: unknown; bytes: Uint8Array })[] = [];
  for (const name of templateCallTree(workspace.templates, main)) {
    const entry = workspace.templates.find((item) => item.name === name)!;
    const bytes = await readFile(entry.source!);
    result.push({ name, file: basename(entry.source!), sha256: sha256(bytes), document: entry.document, bytes });
  }
  return result;
}

/** 修改要求不能为空；反引号里以 templates 中模板名开头的元素路径必须找得到。 */
async function checkRequirement(file: string, templates: readonly { readonly name: string; readonly document: unknown }[]): Promise<void> {
  await requireFile(file, '修改要求');
  const text = await readFile(file, 'utf8');
  if (text.trim() === '') throw new AgentUsageError(`修改要求是空的：${file}`);
  const missing: string[] = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const path = match[1]!.trim();
    const template = templates.find((entry) => path.startsWith(`${entry.name}/`));
    const error = template ? locate('template', template.document, path).error : undefined;
    if (error) missing.push(`${path}（${error}）`);
  }
  if (missing.length > 0) {
    throw new AgentUsageError(`修改要求中的元素路径在已保存的模板中找不到：${missing.join('；')}。元素路径从模板名开始，用 / 分隔，不带循环序号`);
  }
}

async function execute(claude: NonNullable<AgentRunOptions['claude']>, args: readonly string[],
  context: { cwd: string; env: Record<string, string>; prompt: string; logsDir: string; signal: AbortSignal; stop: (reason: QuotaStop) => void; observe: (event: unknown) => void }): Promise<{ exitCode: number | null; error?: string }> {
  const log = createWriteStream(join(context.logsDir, 'stream.jsonl'));
  const errors = createWriteStream(join(context.logsDir, 'stderr.txt'));
  const result = await new Promise<{ exitCode: number | null; error?: string }>((done) => {
    const child = spawn(claude.command, [...(claude.args ?? []), ...args], { cwd: context.cwd, env: context.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    const stop = () => {
      if (!child.pid) return;
      // 只终止本轮的进程树，连同它启动的 MCP；不碰其他 Claude Code 会话。
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', (code) => { if (code !== 0) child.kill(); });
      } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    };
    context.signal.addEventListener('abort', stop, { once: true });
    if (context.signal.aborted) stop();
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const event: unknown = JSON.parse(line); context.observe(event); const quota = runtimeQuota(event); if (quota) context.stop(quota); } catch { /* 不是完整事件 */ }
      }
    });
    child.on('error', (error) => done({ exitCode: null, error: `无法启动 ${claude.command}：${error.message}` }));
    child.stdout.pipe(log);
    child.stderr.pipe(errors);
    child.stdin.on('error', () => {});
    child.stdin.end(context.prompt);
    child.on('close', (code) => { context.signal.removeEventListener('abort', stop); done({ exitCode: code }); });
  });
  await Promise.all([new Promise((done) => log.end(done)), new Promise((done) => errors.end(done))]);
  return result;
}

/** 抢救已写完整的候选 JSON；不跟随符号链接，不补写 Agent 自述的成果。 */
async function recoverCandidates(agentDir: string, task: AgentTask): Promise<SubmittedOutcome | undefined> {
  const candidates: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(join(agentDir, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        try {
          const kind = dslDocumentKind(JSON.parse(await readFile(join(agentDir, child), 'utf8')));
          if (task.candidateKinds.includes(kind as CandidateKind)) candidates.push(child);
        } catch { /* 半写文件保留在 agent/candidates，不当作可读候选 */ }
      }
    }
  };
  await walk('candidates');
  return candidates.length ? { candidates: candidates.sort(), pending: [], notes: '宿主抢救的中断草稿：Agent 未交回有效成果；内容、待确认项与完成度未知。只能查看，不能批准或应用；请带反馈续跑。' } : undefined;
}

/** 从 Claude Code 的流式输出中取用量：初始化消息给出模型、版本与 MCP 状态，结果消息给出轮数与 token。 */
async function readUsage(file: string): Promise<Omit<RoundUsage, 'wallMs'> & { mcp?: string[]; apiError?: string }> {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  const messages = text.split('\n').flatMap((line) => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
  const init = messages.find((message) => message['type'] === 'system' && message['subtype'] === 'init');
  const result = messages.find((message) => message['type'] === 'result');
  const usage = result?.['usage'] as Record<string, number> | undefined;
  const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
  const fields = {
    turns: number(result?.['num_turns']), inputTokens: number(usage?.['input_tokens']), outputTokens: number(usage?.['output_tokens']),
    thinkingTokens: number((usage?.['output_tokens_details'] as Record<string, unknown> | undefined)?.['thinking_tokens']),
    cacheReadTokens: number(usage?.['cache_read_input_tokens']), cacheCreationTokens: number(usage?.['cache_creation_input_tokens']),
    servedModel: typeof init?.['model'] === 'string' ? init['model'] : undefined,
    claudeCodeVersion: typeof init?.['claude_code_version'] === 'string' ? init['claude_code_version'] : undefined,
    endedBy: typeof result?.['subtype'] === 'string' ? result['subtype'] : undefined,
    mcp: Array.isArray(init?.['mcp_servers']) ? init['mcp_servers'].map((server: Record<string, unknown>) => `${String(server['name'])}:${String(server['status'])}`) : undefined,
    // 模型服务报错（如额度用完的 429）时，Claude Code 的结束方式仍是 success，只另带 is_error；
    // 用满轮数时 is_error 也为真，但没有报错文字（票据 28）。
    apiError: result?.['is_error'] === true ? resultError(result) : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function resultError(result: Record<string, any>): string {
  const text = String(result['result'] ?? '').trim();
  if (result['subtype'] === 'error_max_turns') {
    return `用满了轮数上限（${String(result['num_turns'] ?? '?')} 轮）${text ? `：${text.slice(0, 300)}` : ''}；没有交回成果时，可以用 --from 带反馈接着做`;
  }
  return text ? `模型服务报错：${text.slice(0, 300)}` : `Claude Code 以 ${String(result['subtype'] ?? '错误')} 结束，没有给出原因`;
}

function imageExtension(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  return undefined;
}

async function requireFile(file: string, label: string): Promise<void> {
  if (!(await isFile(file))) throw new AgentUsageError(`${label}无法读取：${file}`);
}

async function writeAt(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

/** 模板文件的名称；不是模板或无法解析时没有。 */
function templateName(bytes: Uint8Array): string | undefined {
  try {
    const document: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'));
    return isRecord(document) && typeof document['dslVersion'] === 'string' && document['dslVersion'].startsWith('renderweave-template/') &&
      typeof document['name'] === 'string' ? document['name'] : undefined;
  } catch {
    return undefined;
  }
}
