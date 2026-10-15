/**
 * 发起一轮业务 Agent 任务（ADR-0015、第三阶段 PRD 第 8、9 条）：
 * 在独占的轮次目录里组装三层资料、DSL 参考、示例图与工作区快照，按受限模式启动一次 Claude Code 无头运行，
 * 只连本仓库的 `renderweave mcp`；结束后校验 Agent 交回的 outcome.json，写出轮次记录、成果与校验结果。
 *
 * 子进程环境从空白开始，只放系统必需变量与模型配置，不继承宿主的 CLAUDE_*、ANTHROPIC_* 变量；key 只经环境变量传入，不写任何文件。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspaceDocuments } from '../workspace.js';
import { OUTCOME_FILE, checkAgentOutcome, normalizeCandidatePath, type FieldLocation, type OutcomeCheck, type PendingItem } from './outcome.js';
import { AGENT_TASKS, type AgentTaskId, type CandidateKind } from './tasks.js';

export const DEFAULT_ENDPOINT = 'https://token-plan.maas.qianwenaiapi.com/apps/anthropic';
export const DEFAULT_MODEL = 'qwen3.8-max';
/** Claude Code 的轻量任务（如生成标题）用的模型，不看图。 */
export const DEFAULT_SMALL_MODEL = 'qwen3.7-plus';
export const DEFAULT_KEY_ENV = 'QWEN_TOKEN_PLAN_API_KEY';
const AGENT_MATERIALS = fileURLToPath(new URL('../../agent/', import.meta.url));
const BIN = fileURLToPath(new URL('../bin.js', import.meta.url));
/** 子进程只继承这些系统变量。 */
const SYSTEM_VARIABLES = ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'Path', 'PATH', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles', 'USERNAME', 'USER',
  'USERDOMAIN', 'COMPUTERNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG'];

/** 参数、输入文件或任务顺序不对：命令行报用法错误，不创建轮次目录。 */
export class AgentUsageError extends Error {}

export interface AgentRunOptions {
  readonly task: AgentTaskId;
  readonly sample: string;
  readonly brief: string;
  readonly resources: string;
  /** 新的轮次目录：不存在或为空。 */
  readonly out: string;
  readonly domain?: string;
  readonly workspace?: string;
  /** 数据集提取与模板辅助设计所基于的静态数据定义（票据 06）；没有时提示先做数据定义提取。 */
  readonly definition?: string;
  /** key 的值只在内存中传给子进程；keyEnv 是它所在的环境变量名，只用于记录。 */
  readonly key: string;
  readonly keyEnv: string;
  readonly model?: string;
  readonly smallModel?: string;
  readonly endpoint?: string;
  readonly maxTurns?: number;
  /** Claude Code 可执行文件与前置参数；测试用假执行器代替。 */
  readonly claude?: { readonly command: string; readonly args?: readonly string[] };
}

export interface RoundUsage {
  readonly wallMs: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly servedModel?: string;
  readonly claudeCodeVersion?: string;
  /** Claude Code 的结束方式，如 success、error_max_turns。 */
  readonly endedBy?: string;
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
    readonly model: string; readonly smallModel: string; readonly endpoint: string; readonly maxTurns: number;
    readonly keyEnv: string; readonly tools: string; readonly mcpTools: readonly string[];
  };
  readonly run: RoundUsage & { readonly exitCode: number | null; readonly error?: string; readonly mcp?: readonly string[] };
  readonly verdict: OutcomeCheck['verdict'];
}

export interface RoundInputs {
  readonly sample: { readonly source: string; readonly file: string; readonly sha256: string };
  readonly brief: { readonly source: string; readonly sha256: string };
  readonly domain: string | null;
  readonly workspace: { readonly source: string | null; readonly fingerprint: string; readonly documents: number };
  readonly previous: null;
}

/** 轮次成果 outcome.json（M48）：Agent 交回的内容加上 RenderWeave 记录的输入与用量；结构合格时才写出。 */
export interface RoundOutcome {
  readonly format: 'renderweave-outcome/1';
  readonly task: AgentTaskId;
  readonly round: number;
  readonly inputs: { readonly sampleSha256: string; readonly workspaceFingerprint: string; readonly previous: null };
  readonly candidates: readonly { readonly path: string; readonly kind: CandidateKind; readonly name?: string; readonly sha256: string;
    readonly published?: { readonly name: string; readonly version: number } }[];
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
}

export async function runAgentTask(options: AgentRunOptions): Promise<AgentRunResult> {
  const task = AGENT_TASKS[options.task];
  if ((options.task === 'dataset-extraction' || options.task === 'template-design') && options.definition === undefined) {
    throw new AgentUsageError(`只给了示例图，没有指定数据定义：先做数据定义提取并发布（M43），例如 renderweave agent run --task 数据定义提取 …`);
  }
  if (!task.implemented) throw new AgentUsageError(`任务类型"${task.name}"尚未实现，目前只支持数据定义提取`);
  await requireFile(options.sample, '示例图');
  // 按文件头定扩展名：文件名与内容不符时，Claude Code 会按扩展名声明错误的图片类型。
  const extension = imageExtension(await readFile(options.sample));
  if (!extension) throw new AgentUsageError(`示例图不是 PNG、JPEG 或 WebP：${options.sample}`);
  await requireFile(options.brief, '项目说明');
  const domainFile = options.domain === undefined ? undefined : join(AGENT_MATERIALS, 'domains', `${options.domain}.md`);
  if (domainFile) {
    try { await requireFile(domainFile, '领域约定'); } catch {
      const known = (await readdir(join(AGENT_MATERIALS, 'domains'))).filter((file) => file.endsWith('.md')).map((file) => file.slice(0, -3));
      throw new AgentUsageError(`没有领域约定包 ${options.domain}；可用：${known.join('、')}`);
    }
  }
  if (options.workspace !== undefined && !(await isDirectory(options.workspace))) throw new AgentUsageError(`工作区目录无法读取：${options.workspace}`);
  if (!(await isFile(join(options.resources, 'resources.json')))) throw new AgentUsageError(`资源仓库缺少 resources.json：${options.resources}`);
  if (options.key === '') throw new AgentUsageError(`环境变量 ${options.keyEnv} 为空`);
  const roundDir = resolve(options.out);
  if (await exists(roundDir) && (!(await isDirectory(roundDir)) || (await readdir(roundDir)).length > 0)) {
    throw new AgentUsageError(`轮次目录必须不存在或为空：${options.out}`);
  }

  const startedAt = new Date().toISOString();
  const agentDir = join(roundDir, 'agent'), snapshotDir = join(roundDir, 'snapshot'), logsDir = join(roundDir, 'logs');
  for (const dir of [join(agentDir, 'docs'), join(agentDir, 'candidates'), join(agentDir, 'scratch'), snapshotDir, logsDir]) await mkdir(dir, { recursive: true });

  // 资料：项目说明 > 领域约定 > 通用做法；DSL 参考与成果格式随任务而定。
  const sampleFile = `sample${extension}`;
  await copyFile(options.sample, join(agentDir, sampleFile));
  await copyFile(options.brief, join(agentDir, 'docs/brief.md'));
  await copyFile(join(AGENT_MATERIALS, 'guide.md'), join(agentDir, 'docs/guide.md'));
  if (domainFile) await copyFile(domainFile, join(agentDir, `docs/domain-${options.domain}.md`));
  for (const reference of task.references) await copyFile(join(AGENT_MATERIALS, 'reference', `${reference}.md`), join(agentDir, `docs/${reference === 'outcome' ? 'outcome' : 'dsl-reference'}.md`));
  const prompt = (await readFile(join(AGENT_MATERIALS, 'tasks', `${task.id}.md`), 'utf8')).replaceAll('{sample}', sampleFile);

  // 工作区快照：只复制工作区读取的顶层 JSON 文件；服务启动时读入，Agent 只能经工具读取。
  let documents = 0;
  if (options.workspace !== undefined) {
    for (const file of (await readdir(options.workspace)).filter((name) => name.endsWith('.json')).sort()) {
      await copyFile(join(options.workspace, file), join(snapshotDir, file));
      documents++;
    }
  }
  const inputs: RoundInputs = {
    sample: { source: resolve(options.sample), file: `agent/${sampleFile}`, sha256: await sha256File(options.sample) },
    brief: { source: resolve(options.brief), sha256: await sha256File(options.brief) },
    domain: options.domain ?? null,
    workspace: { source: options.workspace === undefined ? null : resolve(options.workspace), fingerprint: await workspaceFingerprint(snapshotDir), documents },
    previous: null,
  };

  const model = options.model ?? DEFAULT_MODEL, smallModel = options.smallModel ?? DEFAULT_SMALL_MODEL;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT, maxTurns = options.maxTurns ?? task.maxTurns;
  const mcpConfig = join(logsDir, 'mcp.json');
  await writeFile(mcpConfig, `${JSON.stringify({ mcpServers: { rw: { type: 'stdio', command: process.execPath, args: [
    BIN, 'mcp', '--workspace', snapshotDir, '--resources', resolve(options.resources), '--root', agentDir,
    '--log', join(logsDir, 'tools.jsonl'), '--tools', task.mcpTools.join(','),
  ] } } }, null, 2)}\n`);
  const env: Record<string, string> = Object.fromEntries(SYSTEM_VARIABLES.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  if (process.platform !== 'win32') env['HOME'] = join(logsDir, 'home');
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: join(logsDir, 'claude-config'),
    ANTHROPIC_BASE_URL: endpoint, ANTHROPIC_AUTH_TOKEN: options.key, ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel,
    CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '600000',
  });
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--restricted', '--tools', task.tools,
    '--mcp-config', mcpConfig, '--strict-mcp-config', '--allowedTools', 'mcp__rw', '--permission-mode', 'acceptEdits',
    '--max-turns', String(maxTurns), '--no-session-persistence'];

  const started = Date.now();
  const executed = await execute(options.claude ?? { command: 'claude' }, args, { cwd: agentDir, env, prompt, logsDir });
  const { mcp, ...streamUsage } = await readUsage(join(logsDir, 'stream.jsonl'));
  const usage: RoundUsage = { wallMs: Date.now() - started, ...streamUsage };

  const { staticSchemas } = await loadWorkspaceDocuments(snapshotDir);
  const check = await checkAgentOutcome({ task: task.id, agentDir, staticSchemas });
  let outcome: RoundOutcome | undefined;
  if (check.submission) {
    // 候选文件复制到轮次目录，成为本轮成果；之后审核与应用都读这里。
    for (const candidate of check.candidates) {
      await mkdir(dirname(join(roundDir, candidate.path)), { recursive: true });
      await copyFile(join(agentDir, candidate.path), join(roundDir, candidate.path));
    }
    outcome = {
      format: 'renderweave-outcome/1', task: task.id, round: 1,
      inputs: { sampleSha256: inputs.sample.sha256, workspaceFingerprint: inputs.workspace.fingerprint, previous: null },
      candidates: check.candidates.map((candidate) => ({ path: candidate.path, kind: candidate.kind!, ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        sha256: candidate.sha256!, ...(candidate.published ? { published: candidate.published } : {}) })),
      locations: (check.submission.locations ?? []).map((item) => ({ ...item, file: normalizeCandidatePath(item.file) })),
      pending: check.submission.pending.map((item) => ({ ...item, file: normalizeCandidatePath(item.file) })),
      notes: check.submission.notes,
      usage,
    };
    await writeFile(join(roundDir, OUTCOME_FILE), `${JSON.stringify(outcome, null, 2)}\n`);
  }
  const { submission: _submission, ...checkRecord } = check;
  await writeFile(join(roundDir, 'check.json'), `${JSON.stringify(checkRecord, null, 2)}\n`);
  const record: RoundRecord = {
    format: 'renderweave-round/1', task: task.id, round: 1, startedAt, endedAt: new Date().toISOString(), inputs,
    runtime: { model, smallModel, endpoint, maxTurns, keyEnv: options.keyEnv, tools: task.tools, mcpTools: task.mcpTools },
    run: { ...usage, exitCode: executed.exitCode, ...(executed.error ? { error: executed.error } : {}), ...(mcp ? { mcp } : {}) },
    verdict: check.verdict,
  };
  await writeFile(join(roundDir, 'round.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { roundDir, record, check, ...(outcome ? { outcome } : {}) };
}

/** 工作区指纹：按文件名排序的 JSON 文件名与内容哈希，再整体取哈希；应用时据此判断工作区是否已变（M51）。 */
export async function workspaceFingerprint(dir: string): Promise<string> {
  const hash = createHash('sha256');
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    hash.update(`${file}\0${createHash('sha256').update(await readFile(join(dir, file))).digest('hex')}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function execute(claude: NonNullable<AgentRunOptions['claude']>, args: readonly string[],
  context: { cwd: string; env: Record<string, string>; prompt: string; logsDir: string }): Promise<{ exitCode: number | null; error?: string }> {
  const log = createWriteStream(join(context.logsDir, 'stream.jsonl'));
  const errors = createWriteStream(join(context.logsDir, 'stderr.txt'));
  const result = await new Promise<{ exitCode: number | null; error?: string }>((done) => {
    const child = spawn(claude.command, [...(claude.args ?? []), ...args], { cwd: context.cwd, env: context.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.on('error', (error) => done({ exitCode: null, error: `无法启动 ${claude.command}：${error.message}` }));
    child.stdout.pipe(log);
    child.stderr.pipe(errors);
    child.stdin.on('error', () => {});
    child.stdin.end(context.prompt);
    child.on('close', (code) => done({ exitCode: code }));
  });
  await Promise.all([new Promise((done) => log.end(done)), new Promise((done) => errors.end(done))]);
  return result;
}

/** 从 Claude Code 的流式输出中取用量：初始化消息给出模型、版本与 MCP 状态，结果消息给出轮数与 token。 */
async function readUsage(file: string): Promise<Omit<RoundUsage, 'wallMs'> & { mcp?: string[] }> {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  const messages = text.split('\n').flatMap((line) => { try { return [JSON.parse(line) as Record<string, any>]; } catch { return []; } });
  const init = messages.find((message) => message['type'] === 'system' && message['subtype'] === 'init');
  const result = messages.find((message) => message['type'] === 'result');
  const usage = result?.['usage'] as Record<string, number> | undefined;
  const number = (value: unknown) => (typeof value === 'number' ? value : undefined);
  const fields = {
    turns: number(result?.['num_turns']), inputTokens: number(usage?.['input_tokens']), outputTokens: number(usage?.['output_tokens']),
    cacheReadTokens: number(usage?.['cache_read_input_tokens']), cacheCreationTokens: number(usage?.['cache_creation_input_tokens']),
    servedModel: typeof init?.['model'] === 'string' ? init['model'] : undefined,
    claudeCodeVersion: typeof init?.['claude_code_version'] === 'string' ? init['claude_code_version'] : undefined,
    endedBy: typeof result?.['subtype'] === 'string' ? result['subtype'] : undefined,
    mcp: Array.isArray(init?.['mcp_servers']) ? init['mcp_servers'].map((server: Record<string, unknown>) => `${String(server['name'])}:${String(server['status'])}`) : undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function imageExtension(bytes: Uint8Array): string | undefined {
  const ascii = (start: number, end: number) => Buffer.from(bytes.subarray(start, end)).toString('latin1');
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return '.webp';
  return undefined;
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function requireFile(file: string, label: string): Promise<void> {
  if (!(await isFile(file))) throw new AgentUsageError(`${label}无法读取：${file}`);
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
