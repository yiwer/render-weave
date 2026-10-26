/**
 * Tool Runner 执行器（原型）：在轮次宿主进程内用 Anthropic SDK 的 Tool Runner 驱动 Agent 循环，不启动 Claude Code。
 * 模型请求只发往本轮本机代理并只带本轮令牌；领域工具经同一个受管 MCP（stdio）调用；
 * 内置文件工具 Read、Write、Edit、Glob 在宿主内实现，只能读写工作目录，输入沿用 Claude Code 的字段名。
 * 与 Claude Code 执行器的差别：系统提示词由本文件给出；没有上下文压缩与超长工具结果转存；先读后写的约束只在本轮内存中记。
 * 图片按 image-budget.ts 的上限进入对话，每次请求前再核对一遍。
 */
import Anthropic from '@anthropic-ai/sdk';
import { ToolError } from '@anthropic-ai/sdk/helpers/beta/toolsets';
import { VERSION as SDK_VERSION } from '@anthropic-ai/sdk/version';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { glob, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { credentialRedactor } from './credential-redaction.js';
import type { ExecutorRound, ExecutorResult } from './executor.js';
import { IMAGE_WITHHELD, fitImage, imageBudget, type ImageMediaType } from './image-budget.js';
import { runtimeQuota } from './quota.js';
import { usageCollector } from './usage.js';

type RunnerParams = Parameters<Anthropic['beta']['messages']['toolRunner']>[0];
type RunnableTool = Extract<RunnerParams['tools'][number], { parse: unknown }>;
type ResultBlock = Anthropic.Beta.BetaToolResultBlockParam['content'] extends infer C ? C extends readonly (infer B)[] ? B : never : never;
type ToolContent = string | ResultBlock[];

/**
 * 与 Claude Code 对同一模型发出的请求对齐（2026-10-26 用本机协议夹具抓取 Claude Code 对 claude-haiku-5-5 的请求）：
 * max_tokens 128000、自适应思考、没给 --effort 时 effort 为 medium。流式请求不受 SDK 的 10 分钟非流式限制。
 */
const MAX_OUTPUT_TOKENS = 128_000;
const DEFAULT_EFFORT = 'medium';
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINE_CHARS = 2000;
const GLOB_MAX_RESULTS = 100;
const IMAGE_TYPES: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
};

const SYSTEM_PROMPT = (cwd: string) => `你是 RenderWeave 的业务 Agent，在一个工作目录里独立完成用户消息给出的任务，中途没有人回答问题。

工作目录：${cwd}
- 用 Read、Write、Edit、Glob 读写工作目录内的文件；路径可以写相对工作目录的路径。修改已有文件前先用 Read 读过它。Read 也能看图片。
- 名称以 mcp__rw__ 开头的工具读取工作区快照与资源、校验、草稿预览、检查元素、查看图片、查 DSL 参考与核对成果，全部只读。
- 没有命令行与网络。一次可以并行调用多个互不依赖的工具。
- 按任务说明在工作目录里写出成果文件，交回前按说明核对；做完后用一两句话说明结果，然后结束。`;

export async function toolRunnerExecutor(round: ExecutorRound): Promise<ExecutorResult> {
  const redactor = credentialRedactor(round.secrets);
  const log = createWriteStream(resolve(round.logsDir, 'stream.jsonl'));
  const usage = usageCollector();
  const emit = (event: Record<string, any>) => {
    const line = redactor.text(JSON.stringify(event));
    log.write(`${line}\n`);
    const safe = JSON.parse(line) as Record<string, any>;
    usage.accept(safe); round.onUsage(usage.read()); round.onEvent(safe);
    const quota = runtimeQuota(safe); if (quota) round.stop(quota);
  };
  const mcp = startMcpClient(round);
  let result: ExecutorResult = { exitCode: 0 };
  const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
  let turns = 0, finalText = '';
  try {
    await round.onSpawn(process.pid);
    const listed = await mcp.ready.catch((error: unknown) => { throw new Error(`受管 MCP 无法连接：${describe(error)}`); });
    const budget = imageBudget();
    const builtins = fileTools(round.cwd, round.tools.split(',').map((name) => name.trim()).filter(Boolean), budget);
    const tools: RunnableTool[] = [...builtins, ...listed.map((tool) => mcpTool(tool, mcp, budget))];
    emit({ type: 'system', subtype: 'init', executor: 'tool-runner', sdk_version: SDK_VERSION, model: round.model, cwd: round.cwd,
      tools: tools.map((tool) => tool.name), mcp_servers: [{ name: 'rw', status: 'connected' }] });

    // OpenCode Go 按会话路由，缺 x-opencode-session 的请求直接 400 MissingSessionID；本机代理原样转发这个头。
    const client = new Anthropic({ apiKey: round.proxy.token, baseURL: round.proxy.url, maxRetries: 4, timeout: 600_000,
      defaultHeaders: { 'x-opencode-session': randomUUID() } });
    const runner = client.beta.messages.toolRunner({
      model: round.model, max_tokens: MAX_OUTPUT_TOKENS, stream: true, max_iterations: round.maxTurns,
      system: SYSTEM_PROMPT(round.cwd), cache_control: { type: 'ephemeral' },
      thinking: { type: 'adaptive' }, output_config: { effort: round.effort ?? DEFAULT_EFFORT },
      tools, messages: [{ role: 'user', content: round.prompt }],
    }, { signal: round.signal });
    let last: Anthropic.Beta.BetaMessage | undefined;
    for await (const stream of runner) {
      const message = await stream.finalMessage();
      last = message; turns++;
      const used = message.usage as unknown as Record<string, any>;
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) totals[key] += Number(used[key] ?? 0);
      totals.thinking_tokens += Number(used['output_tokens_details']?.thinking_tokens ?? 0);
      emit({ type: 'assistant', message });
      // 用满轮数时 Tool Runner 仍执行这一轮的工具，只是不再发请求；照实记录，不假装没执行。
      const response = await runner.generateToolResponse(round.signal);
      if (response) emit({ type: 'user', message: response });
      // 请求前核对：循环体结束后 Runner 才把这条回复与工具结果放进 messages，再发下一次请求，所以这里按它们拼出将要发出的请求体。
      if (response && turns < round.maxTurns) {
        const { tools: _runnable, ...rest } = runner.params;
        const problems = budget.check({ ...rest, tools: tools.map(({ run: _run, parse: _parse, ...definition }) => definition),
          messages: [...runner.params.messages, { role: 'assistant', content: message.content }, response] });
        if (problems.length > 0) throw new Error(`请求前图片核对未通过，已停止本轮：${problems.join('；')}`);
      }
    }
    finalText = (last?.content ?? []).flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n').trim();
    const exhausted = last?.stop_reason === 'tool_use' && turns >= round.maxTurns;
    emit({ type: 'result', subtype: exhausted ? 'error_max_turns' : 'success', is_error: exhausted || last?.stop_reason === 'refusal', num_turns: turns,
      result: finalText, stop_reason: last?.stop_reason ?? null, usage: resultUsage(totals) });
  } catch (error) {
    const text = error instanceof Anthropic.APIError ? `API Error: ${error.status ?? ''} ${JSON.stringify(error.error ?? error.message)}` : describe(error);
    emit({ type: 'result', subtype: round.signal.aborted ? 'error_during_execution' : 'success', is_error: true, num_turns: turns, result: text, usage: resultUsage(totals) });
    result = round.signal.aborted ? { exitCode: null, error: '执行器已被停止' } : { exitCode: 1 };
  } finally {
    await mcp.close();
    await new Promise((done) => log.end(done));
  }
  return result.error ? { ...result, error: redactor.text(result.error) } : result;
}

function resultUsage(totals: Record<string, number>) {
  const { thinking_tokens: thinking, ...rest } = totals;
  return { ...rest, ...(thinking ? { output_tokens_details: { thinking_tokens: thinking } } : {}) };
}

interface ListedTool { readonly name: string; readonly description?: string; readonly inputSchema: Record<string, unknown> }
interface McpClient {
  readonly ready: Promise<ListedTool[]>;
  call(name: string, args: unknown): Promise<{ content: Record<string, any>[]; isError?: boolean }>;
  close(): Promise<void>;
}

/** 最小的 MCP stdio 客户端：初始化、列工具、调工具，按行分隔的 JSON-RPC。 */
function startMcpClient(round: ExecutorRound): McpClient {
  const child = spawn(round.mcp.command, [...round.mcp.args], { cwd: round.cwd, env: round.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 1, closed = false;
  const fail = (error: Error) => { closed = true; for (const entry of pending.values()) entry.reject(error); pending.clear(); };
  child.on('error', (error) => fail(error));
  child.on('close', () => fail(new Error('受管 MCP 已退出')));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    let message: Record<string, any>;
    try { message = JSON.parse(line); } catch { return; }
    const entry = typeof message['id'] === 'number' ? pending.get(message['id']) : undefined;
    if (!entry) return;
    pending.delete(message['id']);
    if (message['error']) entry.reject(new Error(String(message['error'].message ?? '受管 MCP 报错')));
    else entry.resolve(message['result']);
  });
  const request = (method: string, params: unknown) => new Promise<any>((done, reject) => {
    if (closed) { reject(new Error('受管 MCP 已退出')); return; }
    const id = next++;
    pending.set(id, { resolve: done, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const ready = (async () => {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'renderweave-tool-runner', version: '0' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return ((await request('tools/list', {})).tools ?? []) as ListedTool[];
  })();
  return {
    ready,
    call: (name, args) => request('tools/call', { name, arguments: args }),
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((done) => child.once('close', () => done()));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 5000);
      await exited; clearTimeout(timer);
    },
  };
}

function mcpTool(tool: ListedTool, client: McpClient, budget: ReturnType<typeof imageBudget>): RunnableTool {
  return {
    name: `mcp__rw__${tool.name}`, description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Beta.BetaTool['input_schema'],
    parse: (value: unknown) => value,
    async run(args: unknown) {
      const result = await client.call(tool.name, args ?? {});
      const content: ResultBlock[] = [];
      for (const block of result.content ?? []) {
        if (block['type'] === 'image') content.push(...await imageBlocks(Buffer.from(String(block['data']), 'base64'), block['mimeType'] as ImageMediaType, budget, false));
        else content.push({ type: 'text', text: String(block['text'] ?? '') } as ResultBlock);
      }
      if (result.isError) throw new ToolError(content);
      return content;
    },
  } as RunnableTool;
}

/**
 * 图片进入对话前缩到上限以内并记账；放不下时改用文字说明。
 * describe 为 true（Read）时总附原图与输出尺寸，便于按原图像素坐标调用 view_image；MCP 的图片只在被缩小时补一句。
 */
async function imageBlocks(bytes: Uint8Array, mediaType: ImageMediaType, budget: ReturnType<typeof imageBudget>, describe: boolean): Promise<ResultBlock[]> {
  const image = await fitImage(bytes, mediaType);
  if (!budget.admit(image)) return [{ type: 'text', text: IMAGE_WITHHELD } as ResultBlock];
  const scaled = image.width !== image.original.width || image.height !== image.original.height;
  const note = scaled
    ? `原图 ${image.original.width}×${image.original.height} 像素，缩小到 ${image.width}×${image.height} 返回（${(image.width / image.original.width).toFixed(3)} 倍）；要看局部细节，用 mcp__rw__view_image 按原图像素坐标放大。`
    : `图片 ${image.width}×${image.height} 像素。`;
  return [
    ...(describe || scaled ? [{ type: 'text', text: note } as ResultBlock] : []),
    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } } as ResultBlock,
  ];
}

/** Claude Code 同名内置工具的最小实现：只在工作目录内，修改已有文件前要先读过。 */
function fileTools(cwd: string, names: readonly string[], budget: ReturnType<typeof imageBudget>): RunnableTool[] {
  const read = new Set<string>();
  const inside = async (path: unknown): Promise<string> => {
    if (typeof path !== 'string' || path === '') throw new ToolError('file_path 必须是非空字符串');
    const full = resolve(cwd, path);
    const rel = relative(cwd, full);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new ToolError(`只能访问工作目录内的文件：${path}`);
    // 已存在的路径按真实位置再核一次，防止经链接跳出工作目录。
    const real = await realpath(full).catch(() => undefined);
    if (real !== undefined) {
      const realRel = relative(await realpath(cwd), real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) throw new ToolError(`只能访问工作目录内的文件：${path}`);
    }
    return full;
  };
  const exists = (path: string) => stat(path).then((info) => info.isFile(), () => false);
  const all: Record<string, RunnableTool> = {
    Read: tool('Read', '读取工作目录内的文件。文本按行号返回（行号<TAB>内容），可用 offset（从 1 开始的行号）与 limit 只读一段；PNG、JPEG、WebP、GIF 图片按图片返回，长边超过 2000 像素时缩小并说明原图尺寸。', {
      type: 'object', additionalProperties: false, required: ['file_path'],
      properties: { file_path: { type: 'string', description: '文件路径，绝对路径或相对工作目录' }, offset: { type: 'number' }, limit: { type: 'number' } },
    }, async (input) => {
      const path = await inside(input['file_path']);
      if (!(await exists(path))) throw new ToolError(`文件不存在：${String(input['file_path'])}`);
      const bytes = await readFile(path);
      read.add(path);
      const media = IMAGE_TYPES[extname(path).toLowerCase()];
      if (media) return imageBlocks(bytes, media, budget, true);
      const lines = bytes.toString('utf8').split(/\r?\n/);
      const start = Math.max(1, Math.floor(Number(input['offset'] ?? 1)));
      const count = Math.max(1, Math.floor(Number(input['limit'] ?? READ_DEFAULT_LINES)));
      const shown = lines.slice(start - 1, start - 1 + count).map((line, index) =>
        `${String(start + index).padStart(6)}\t${line.length > READ_MAX_LINE_CHARS ? `${line.slice(0, READ_MAX_LINE_CHARS)}…` : line}`);
      const rest = lines.length - (start - 1 + shown.length);
      return shown.join('\n') + (rest > 0 ? `\n（还有 ${rest} 行；用 offset 与 limit 接着读）` : '') || '（空文件）';
    }),
    Write: tool('Write', '把内容整份写入工作目录内的文件，没有的目录会创建。覆盖已有文件前先用 Read 读过它。', {
      type: 'object', additionalProperties: false, required: ['file_path', 'content'],
      properties: { file_path: { type: 'string' }, content: { type: 'string' } },
    }, async (input) => {
      const path = await inside(input['file_path']);
      const existed = await exists(path);
      if (existed && !read.has(path)) throw new ToolError('覆盖已有文件前要先用 Read 读过它');
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, String(input['content']));
      read.add(path);
      return existed ? `已更新：${String(input['file_path'])}` : `已创建：${String(input['file_path'])}`;
    }),
    Edit: tool('Edit', '在工作目录内的文件中把 old_string 换成 new_string。old_string 必须在文件中唯一出现，除非 replace_all 为 true。修改前先用 Read 读过它。', {
      type: 'object', additionalProperties: false, required: ['file_path', 'old_string', 'new_string'],
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
    }, async (input) => {
      const path = await inside(input['file_path']);
      if (!(await exists(path))) throw new ToolError(`文件不存在：${String(input['file_path'])}`);
      if (!read.has(path)) throw new ToolError('修改前要先用 Read 读过这个文件');
      const text = await readFile(path, 'utf8');
      const from = String(input['old_string']), to = String(input['new_string']);
      if (from === '' || from === to) throw new ToolError('old_string 不能为空，也不能与 new_string 相同');
      const count = text.split(from).length - 1;
      if (count === 0) throw new ToolError('文件中没有 old_string');
      if (count > 1 && input['replace_all'] !== true) throw new ToolError(`old_string 出现了 ${count} 次：加上下文使它唯一，或设 replace_all`);
      await writeFile(path, input['replace_all'] === true ? text.split(from).join(to) : text.replace(from, () => to));
      return `已修改：${String(input['file_path'])}（${input['replace_all'] === true ? count : 1} 处）`;
    }),
    Glob: tool('Glob', '按 glob 模式（如 candidates/**/*.json）列出工作目录内的文件，最多 100 个。', {
      type: 'object', additionalProperties: false, required: ['pattern'],
      properties: { pattern: { type: 'string' }, path: { type: 'string', description: '在哪个子目录下找，缺省为工作目录' } },
    }, async (input) => {
      const base = input['path'] === undefined ? cwd : await inside(input['path']);
      const pattern = String(input['pattern']);
      if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..')) throw new ToolError('pattern 只能是相对路径，不能含 ..');
      const found: string[] = [];
      for await (const entry of glob(pattern, { cwd: base })) {
        const full = resolve(base, entry);
        if (await exists(full)) found.push(relative(cwd, full).split(sep).join('/'));
      }
      found.sort();
      return found.length === 0 ? '没有匹配的文件' : found.slice(0, GLOB_MAX_RESULTS).join('\n') + (found.length > GLOB_MAX_RESULTS ? `\n（共 ${found.length} 个，只列出前 ${GLOB_MAX_RESULTS} 个）` : '');
    }),
  };
  const unknown = names.filter((name) => !all[name]);
  if (unknown.length > 0) throw new Error(`Tool Runner 执行器没有内置工具：${unknown.join('、')}`);
  return names.map((name) => all[name]!);
}

function tool(name: string, description: string, schema: Record<string, unknown>, run: (input: Record<string, unknown>) => Promise<ToolContent>): RunnableTool {
  return { name, description, input_schema: schema as Anthropic.Beta.BetaTool['input_schema'], parse: (value: unknown) => value,
    run: (input: unknown) => run((input ?? {}) as Record<string, unknown>) } as RunnableTool;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
