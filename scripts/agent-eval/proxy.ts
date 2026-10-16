/**
 * 评估用的协议转换代理：让 Claude Code（只会发 Anthropic Messages 请求）使用 OpenCode Go 上 OpenAI Chat Completions
 * 与 Google generateContent 格式的模型，如 Step 5 Preview、Gemini 4 Argon。只用于评估不同模型配合 Claude Code 的表现。
 *
 *   npx tsx scripts/agent-eval/proxy.ts [--port 47410] [--key-env OPEN_CODE_API_KEY] [--base https://opencode.ai/inference/go] [--log <文件>]
 *
 * - 只监听 127.0.0.1；上游 key 只从环境变量读进内存，不写文件、不打印。Claude Code 发来的认证头不转发。
 * - 模型名以 gemini 开头的走 Google 格式，其余走 OpenAI Chat Completions 格式。
 * - 上游一次性返回完整结果，代理再拼成 Anthropic 的流式事件；等待期间每 15 秒发一次 ping。
 * - 工具结果中的图片：OpenAI 格式放进紧随其后的用户消息；Google 格式放在同一轮的 inlineData 里。
 * - Gemini 的 thoughtSignature 按工具调用 id 记在内存里，下一次请求时补回对应的 functionCall（多轮工具调用必需）。
 * - 按 OpenCode Go 的要求带自己的 user-agent 与稳定的 x-opencode-session（取 Claude Code 的会话头）。
 */
import { appendFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseArgs } from 'node:util';

type Json = Record<string, unknown>;
type Block = Json & { type: string };
interface AnthropicRequest {
  model: string;
  system?: string | Block[];
  messages: { role: 'user' | 'assistant'; content: string | Block[] }[];
  tools?: { name: string; description?: string; input_schema?: Json }[];
  tool_choice?: { type: string; name?: string };
  max_tokens?: number;
  temperature?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
}
/** 转换后的统一结果：Anthropic 的内容块、结束原因与用量。 */
export interface Translated {
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
}

export interface ProxyOptions {
  readonly base: string;
  readonly key: string;
  readonly log?: string;
  /** 测试用：替换 fetch。 */
  readonly fetch?: typeof fetch;
}

const USER_AGENT = 'renderweave-eval-proxy/0.1';

/** Gemini 的 thoughtSignature：工具调用 id → 签名。 */
const signatures = new Map<string, string>();
let counter = 0;

export function startProxy(options: ProxyOptions & { port: number }): Promise<{ port: number; close: () => Promise<void> }> {
  let port = options.port;
  const server = createServer((request, response) => { void handle(request, response, options, port); });
  return new Promise((done) => server.listen(options.port, '127.0.0.1', () => {
    const address = server.address();
    port = typeof address === 'object' && address ? address.port : options.port;
    done({ port, close: () => new Promise((closed) => server.close(() => closed())) });
  }));
}

async function handle(request: IncomingMessage, response: ServerResponse, options: ProxyOptions, port: number): Promise<void> {
  // 代理替请求方花额度，只接受本机命令行发来的请求：Host 必须是本机地址加本端口（防 DNS 重绑定）；
  // 带 Origin 的是浏览器网页；POST 必须是 application/json，否则网页能用不预检的"简单请求"借代理调用模型。
  const host = request.headers.host ?? '';
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(response, 403, error('permission_error', '只接受本机地址的请求'));
  if (request.headers.origin !== undefined) return json(response, 403, error('permission_error', '不接受浏览器网页发来的请求'));
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/models') return json(response, 200, { data: [], has_more: false });
  if (request.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) return json(response, 404, error('not_found_error', `不支持 ${request.method} ${url.pathname}`));
  if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(response, 415, error('invalid_request_error', '请求必须是 application/json'));
  let body: AnthropicRequest;
  try {
    body = JSON.parse(await readBody(request)) as AnthropicRequest;
  } catch {
    return json(response, 400, error('invalid_request_error', '请求体不是 JSON'));
  }
  if (url.pathname === '/v1/messages/count_tokens') return json(response, 200, { input_tokens: Math.ceil(JSON.stringify(body).length / 4) });

  const session = String(request.headers['x-claude-code-session-id'] ?? body.metadata?.user_id ?? 'renderweave-eval');
  const started = Date.now();
  let heartbeat: NodeJS.Timeout | undefined;
  if (body.stream) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    heartbeat = setInterval(() => sse(response, 'ping', { type: 'ping' }), 15_000);
  }
  try {
    const result = await callUpstream(body, session, options);
    if (heartbeat) clearInterval(heartbeat);
    await log(options, { model: body.model, ms: Date.now() - started, status: 200, ...result.usage, stop: result.stopReason, blocks: result.content.map((block) => block.type) });
    if (body.stream) {
      streamMessage(response, body.model, result);
      response.end();
    } else {
      json(response, 200, { id: `msg_rw_${++counter}`, type: 'message', role: 'assistant', model: body.model, content: result.content,
        stop_reason: result.stopReason, stop_sequence: null, usage: result.usage });
    }
  } catch (failure) {
    if (heartbeat) clearInterval(heartbeat);
    const status = failure instanceof UpstreamError ? failure.status : 502;
    const kind = status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : status === 401 ? 'authentication_error' : 'api_error';
    const message = failure instanceof Error ? failure.message : String(failure);
    await log(options, { model: body.model, ms: Date.now() - started, status, error: message.slice(0, 300) });
    if (body.stream) {
      sse(response, 'error', error(kind, message));
      response.end();
    } else json(response, status, error(kind, message));
  }
}

class UpstreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function callUpstream(body: AnthropicRequest, session: string, options: ProxyOptions): Promise<Translated> {
  const google = body.model.startsWith('gemini');
  const url = google ? `${options.base}/google/v1beta/models/${body.model}:generateContent` : `${options.base}/openai/v1/chat/completions`;
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-opencode-session': session,
    ...(google ? { 'x-goog-api-key': options.key } : { authorization: `Bearer ${options.key}` }),
  };
  const payload = google ? toGoogle(body) : toOpenAi(body);
  const response = await (options.fetch ?? fetch)(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(900_000) });
  const text = await response.text();
  if (!response.ok) throw new UpstreamError(response.status, `上游 ${response.status}：${text.slice(0, 500)}`);
  const parsed = JSON.parse(text) as Json;
  return google ? fromGoogle(parsed) : fromOpenAi(parsed);
}

// ---------- Anthropic → OpenAI Chat Completions ----------

export function toOpenAi(body: AnthropicRequest): Json {
  const messages: Json[] = [];
  const system = systemText(body.system);
  if (system) messages.push({ role: 'system', content: system });
  for (const message of body.messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as Block] : message.content;
    if (message.role === 'assistant') {
      const text = blocks.filter((block) => block.type === 'text').map((block) => String(block['text'])).join('');
      const calls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({
        id: String(block['id']), type: 'function', function: { name: String(block['name']), arguments: JSON.stringify(block['input'] ?? {}) },
      }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
      continue;
    }
    // 工具结果先作为 tool 消息紧跟在调用之后；其中的图片与其余内容放进随后的一条用户消息。
    const parts: Json[] = [];
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        const { text, images } = toolResult(block);
        messages.push({ role: 'tool', tool_call_id: String(block['tool_use_id']), content: images.length > 0 ? `${text}\n（结果中的 ${images.length} 张图片附在下一条消息里）` : text });
        for (const image of images) parts.push({ type: 'image_url', image_url: { url: image } });
      } else if (block.type === 'text') parts.push({ type: 'text', text: String(block['text']) });
      else if (block.type === 'image') {
        const image = imageUrl(block);
        if (image) parts.push({ type: 'image_url', image_url: { url: image } });
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const choice = body.tool_choice;
  return {
    model: body.model, messages, max_tokens: body.max_tokens ?? 8192,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.stop_sequences?.length ? { stop: body.stop_sequences } : {}),
    ...(body.tools?.length ? { tools: body.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object' } } })) } : {}),
    ...(choice ? { tool_choice: choice.type === 'any' ? 'required' : choice.type === 'tool' ? { type: 'function', function: { name: choice.name } } : choice.type } : {}),
  };
}

export function fromOpenAi(response: Json): Translated {
  const choice = (response['choices'] as Json[] | undefined)?.[0] ?? {};
  const message = (choice['message'] ?? {}) as Json;
  const content: Translated['content'] = [];
  if (typeof message['content'] === 'string' && message['content'] !== '') content.push({ type: 'text', text: message['content'] });
  for (const call of (message['tool_calls'] as Json[] | undefined) ?? []) {
    const fn = call['function'] as Json;
    content.push({ type: 'tool_use', id: String(call['id'] ?? `toolu_rw_${++counter}`), name: String(fn['name']), input: parseArguments(fn['arguments']) });
  }
  const usage = (response['usage'] ?? {}) as Json;
  const cached = Number(((usage['prompt_tokens_details'] ?? {}) as Json)['cached_tokens'] ?? 0);
  const reason = String(choice['finish_reason'] ?? 'stop');
  return {
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stopReason: content.some((block) => block.type === 'tool_use') || reason === 'tool_calls' ? 'tool_use' : reason === 'length' ? 'max_tokens' : 'end_turn',
    usage: { input_tokens: Number(usage['prompt_tokens'] ?? 0) - cached, output_tokens: Number(usage['completion_tokens'] ?? 0), cache_read_input_tokens: cached },
  };
}

// ---------- Anthropic → Google generateContent ----------

export function toGoogle(body: AnthropicRequest): Json {
  const names = new Map<string, string>();
  const contents: { role: 'user' | 'model'; parts: Json[] }[] = [];
  const push = (role: 'user' | 'model', parts: Json[]) => {
    if (parts.length === 0) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of body.messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content } as Block] : message.content;
    const parts: Json[] = [];
    for (const block of blocks) {
      if (block.type === 'text' && String(block['text']) !== '') parts.push({ text: String(block['text']) });
      else if (block.type === 'image') {
        const inline = inlineData(block);
        if (inline) parts.push({ inlineData: inline });
      } else if (block.type === 'tool_use') {
        const id = String(block['id']);
        names.set(id, String(block['name']));
        const signature = signatures.get(id);
        parts.push({ functionCall: { name: String(block['name']), args: block['input'] ?? {} }, ...(signature ? { thoughtSignature: signature } : {}) });
      } else if (block.type === 'tool_result') {
        const { text, images } = toolResult(block);
        const id = String(block['tool_use_id']);
        parts.push({ functionResponse: { name: names.get(id) ?? 'tool', response: { content: text } } });
        for (const image of images) {
          const [, mimeType, data] = /^data:([^;]+);base64,(.*)$/s.exec(image) ?? [];
          if (mimeType && data) parts.push({ inlineData: { mimeType, data } });
        }
      }
    }
    push(message.role === 'assistant' ? 'model' : 'user', parts);
  }
  const system = systemText(body.system);
  const choice = body.tool_choice;
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(body.tools?.length ? { tools: [{ functionDeclarations: body.tools.map((tool) => ({ name: tool.name, description: tool.description ?? '', parametersJsonSchema: tool.input_schema ?? { type: 'object' } })) }] } : {}),
    ...(choice ? { toolConfig: { functionCallingConfig: choice.type === 'any' || choice.type === 'tool'
      ? { mode: 'ANY', ...(choice.type === 'tool' ? { allowedFunctionNames: [choice.name] } : {}) } : { mode: choice.type === 'none' ? 'NONE' : 'AUTO' } } } : {}),
    generationConfig: {
      maxOutputTokens: body.max_tokens ?? 8192,
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
    },
  };
}

export function fromGoogle(response: Json): Translated {
  const candidate = (response['candidates'] as Json[] | undefined)?.[0] ?? {};
  const parts = (((candidate['content'] ?? {}) as Json)['parts'] as Json[] | undefined) ?? [];
  const content: Translated['content'] = [];
  for (const part of parts) {
    if (part['thought'] === true) continue;
    if (typeof part['text'] === 'string' && part['text'] !== '') {
      const last = content.at(-1);
      if (last?.type === 'text') last.text += part['text'];
      else content.push({ type: 'text', text: part['text'] });
    } else if (part['functionCall']) {
      const call = part['functionCall'] as Json;
      const id = `toolu_rw_${++counter}`;
      if (typeof part['thoughtSignature'] === 'string') signatures.set(id, part['thoughtSignature']);
      content.push({ type: 'tool_use', id, name: String(call['name']), input: call['args'] ?? {} });
    }
  }
  const usage = (response['usageMetadata'] ?? {}) as Json;
  const cached = Number(usage['cachedContentTokenCount'] ?? 0);
  const reason = String(candidate['finishReason'] ?? 'STOP');
  return {
    content: content.length > 0 ? content : [{ type: 'text', text: '' }],
    stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : reason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    usage: {
      input_tokens: Number(usage['promptTokenCount'] ?? 0) - cached,
      output_tokens: Number(usage['candidatesTokenCount'] ?? 0) + Number(usage['thoughtsTokenCount'] ?? 0),
      cache_read_input_tokens: cached,
    },
  };
}

// ---------- 公共 ----------

/** Anthropic 流式事件：先 message_start，再逐个内容块，最后 message_delta 与 message_stop。 */
function streamMessage(response: ServerResponse, model: string, result: Translated): void {
  sse(response, 'message_start', { type: 'message_start', message: {
    id: `msg_rw_${++counter}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: result.usage.input_tokens, output_tokens: 0, cache_read_input_tokens: result.usage.cache_read_input_tokens, cache_creation_input_tokens: 0 },
  } });
  result.content.forEach((block, index) => {
    if (block.type === 'text') {
      sse(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      if (block.text) sse(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      sse(response, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      sse(response, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    }
    sse(response, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(response, 'message_delta', { type: 'message_delta', delta: { stop_reason: result.stopReason, stop_sequence: null }, usage: { output_tokens: result.usage.output_tokens } });
  sse(response, 'message_stop', { type: 'message_stop' });
}

function systemText(system: AnthropicRequest['system']): string {
  if (system === undefined) return '';
  return typeof system === 'string' ? system : system.filter((block) => block.type === 'text').map((block) => String(block['text'])).join('\n\n');
}

/** 工具结果：文字合并，图片转成 data URL；出错的结果标明。 */
function toolResult(block: Block): { text: string; images: string[] } {
  const raw = block['content'];
  const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw } as Block] : Array.isArray(raw) ? (raw as Block[]) : [];
  const text = blocks.filter((item) => item.type === 'text').map((item) => String(item['text'])).join('\n');
  const images = blocks.filter((item) => item.type === 'image').map(imageUrl).filter((url): url is string => url !== undefined);
  return { text: `${block['is_error'] === true ? '错误：' : ''}${text}`, images };
}

function imageUrl(block: Block): string | undefined {
  const source = block['source'] as Json | undefined;
  if (source?.['type'] === 'base64') return `data:${String(source['media_type'])};base64,${String(source['data'])}`;
  if (source?.['type'] === 'url') return String(source['url']);
  return undefined;
}

function inlineData(block: Block): Json | undefined {
  const source = block['source'] as Json | undefined;
  return source?.['type'] === 'base64' ? { mimeType: String(source['media_type']), data: String(source['data']) } : undefined;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value) as unknown; } catch { return { raw: value }; }
}

function error(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

function sse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    request.on('error', fail);
  });
}

async function log(options: ProxyOptions, entry: Json): Promise<void> {
  if (options.log) await appendFile(options.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

if (process.argv[1] && import.meta.filename && process.argv[1].replaceAll('\\', '/').endsWith('scripts/agent-eval/proxy.ts')) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, 'key-env': { type: 'string' }, base: { type: 'string' }, log: { type: 'string' } }, strict: true });
  const keyEnv = values['key-env'] ?? 'OPEN_CODE_API_KEY';
  const key = process.env[keyEnv];
  if (!key) {
    console.error(`缺少环境变量 ${keyEnv}`);
    process.exit(2);
  }
  const proxy = await startProxy({ port: Number(values.port ?? 47410), key, base: values.base ?? 'https://opencode.ai/inference/go', ...(values.log ? { log: values.log } : {}) });
  console.error(`转换代理：http://127.0.0.1:${proxy.port}（上游 ${values.base ?? 'https://opencode.ai/inference/go'}）`);
}
