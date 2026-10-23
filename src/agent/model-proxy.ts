/**
 * 模型协议转换（M232）：Claude Code 只会发 Anthropic Messages 请求，Gemini 只提供 Google 的 generateContent 一类接口。
 * 发起 Gemini 的轮次时，agent run 在本进程里起这个转换代理，Claude Code 连它，它再连上游。
 *
 * - 只绑定 127.0.0.1，端口由系统分配，随本轮结束关闭。只接受带本轮令牌的请求：Claude Code 拿到的是令牌，
 *   上游 key 只在本进程内存里。Host 必须是本机地址加本端口（防 DNS 重绑定），拒绝带 Origin 的网页请求与非 JSON 请求。
 * - 上游走流式 streamGenerateContent（M287）：代理收齐各分块、合并成完整结果，再拼成 Anthropic 的流式事件；等待期间每 15 秒发一次 ping。
 *   上游失败按阶段（连接、状态码、流中）记日志并带底层原因；上游回 200 之前出错按上游状态码交回，之后在流里发 error 事件。
 * - 工具结果中的图片放在同一轮的 inlineData 里。
 * - Gemini 的 thoughtSignature 按工具调用 id 记在本代理里，下一次请求时补回对应的 functionCall（多轮工具调用必需）。
 * - 带稳定的 x-opencode-session（取 Claude Code 的会话头）。日志只记用时、状态、token、内容块类型与失败的阶段和原因，不记内容。
 *
 * 它与审核页一样是命令行附带的本机服务：只用 node:http，不是阶段 4 的 HTTP 服务外壳。
 */
import { randomBytes } from 'node:crypto';
import { credentialRedactor } from './credential-redaction.js';
import { appendFile } from 'node:fs/promises';
import { Agent as HttpAgent, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { hardQuota, type QuotaStop } from './quota.js';

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
/** 上游失败的阶段：连接（含等响应头）、状态码、流中。 */
type Phase = 'connect' | 'status' | 'stream';
/** 一次上游调用的进度，供日志区分失败阶段与流中的停顿。 */
interface Trace { phase: Phase; events: number; lastDataAt: number; maxGapMs: number }
interface Translated {
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
}

export interface ModelProxyOptions {
  /** 上游的 Google API 基址，如 https://opencode.ai/inference/go/google/v1beta；请求发到 <基址>/models/<模型>:streamGenerateContent?alt=sse。 */
  readonly upstream: string;
  readonly key: string;
  /** 调用日志（JSON Lines），只记用时、状态、token、内容块类型与失败的阶段和原因，不记内容。 */
  readonly log?: string;
  readonly onHardQuota?: (stop: QuotaStop) => void;
}

export interface ModelProxy {
  /** 给 Claude Code 的 ANTHROPIC_BASE_URL。 */
  readonly url: string;
  /** 给 Claude Code 的 ANTHROPIC_AUTH_TOKEN：本轮随机生成，只在本代理有效。 */
  readonly token: string;
  close(): Promise<void>;
}

const USER_AGENT = 'renderweave-model-proxy/1';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const UPSTREAM_IDLE_MS = 600_000;

/** 只提供 Google 接口、要经转换代理连接的模型。 */
export function isGoogleModel(model: string): boolean {
  return model.startsWith('gemini');
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const token = randomBytes(24).toString('hex');
  const safe = credentialRedactor([options.key, token]);
  /** Gemini 的 thoughtSignature：工具调用 id → 签名。 */
  const signatures = new Map<string, string>();
  let counter = 0;
  let port = 0;
  let stopped: QuotaStop | undefined;
  // 上游连接由本代理自己的连接池持有，随本轮关闭。
  const https = new URL(options.upstream).protocol === 'https:';
  const agent = https ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });

  const server = createServer((request, response) => { void handle(request, response); });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return json(response, 403, error('permission_error', '只接受本机地址的请求'));
    if (request.headers.origin !== undefined) return json(response, 403, error('permission_error', '不接受浏览器网页发来的请求'));
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
    if (bearer !== token && request.headers['x-api-key'] !== token) return json(response, 401, error('authentication_error', '本轮令牌不对'));
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/models') return json(response, 200, { data: [], has_more: false });
    if (request.method !== 'POST' || !url.pathname.startsWith('/v1/messages')) return json(response, 404, error('not_found_error', `不支持 ${request.method} ${url.pathname}`));
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(response, 415, error('invalid_request_error', '请求必须是 application/json'));
    let body: AnthropicRequest;
    try {
      body = JSON.parse(await readBody(request)) as AnthropicRequest;
    } catch {
      return json(response, 400, error('invalid_request_error', '请求体不是 JSON，或超过大小上限'));
    }
    if (url.pathname === '/v1/messages/count_tokens') return json(response, 200, { input_tokens: Math.ceil(JSON.stringify(body).length / 4) });
    if (typeof body.model !== 'string' || !/^[\w.-]+$/.test(body.model)) return json(response, 400, error('invalid_request_error', '模型名不合法'));
    if (stopped) return json(response, 429, error('rate_limit_error', `硬额度已耗尽（${stopped.limit}），本轮已停止上游调用`));

    const session = String(request.headers['x-claude-code-session-id'] ?? body.metadata?.user_id ?? 'renderweave');
    const started = Date.now();
    const trace: Trace = { phase: 'connect', events: 0, lastDataAt: started, maxGapMs: 0 };
    // 流式请求的响应头等上游回了 200 才发，最迟到第一次 ping（15 秒）。在此之前出错（连不上、上游非 200），按上游的状态码交回，
    // Claude Code 照 HTTP 状态退避重试、仍走流式；之后出错（流中断）只能发 SSE error 事件，Claude Code 随即改发非流式请求重试（票据 25 实测）。
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    };
    const heartbeat = body.stream ? setInterval(() => { open(); sse(response, 'ping', { type: 'ping' }); }, 15_000) : undefined;
    try {
      const result = JSON.parse(safe.text(JSON.stringify(await callUpstream(body, session, trace, () => { if (body.stream) open(); })))) as Translated;
      await log({ model: body.model, ms: Date.now() - started, status: 200, events: trace.events, maxGapMs: trace.maxGapMs,
        ...result.usage, stop: result.stopReason, blocks: result.content.map((block) => block.type) });
      if (body.stream) {
        open();
        streamMessage(response, body.model, result);
        response.end();
      } else {
        json(response, 200, { id: `msg_rw_${++counter}`, type: 'message', role: 'assistant', model: body.model, content: result.content,
          stop_reason: result.stopReason, stop_sequence: null, usage: result.usage });
      }
    } catch (failure) {
      const upstream = failure instanceof UpstreamError ? failure : undefined;
      const status = upstream?.status ?? 502;
      const kind = status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : status === 401 || status === 403 ? 'authentication_error' : 'api_error';
      const message = safe.text(failure instanceof Error ? failure.message : String(failure));
      const rawCause = upstream ? upstream.reason : causeOf(failure);
      const cause = rawCause ? { ...rawCause, message: safe.text(rawCause.message) } : undefined;
      if (upstream?.quota && !stopped) stopped = upstream.quota;
      // 日志分清失败在哪个阶段、底层原因，以及失败前多久没收到上游的数据。
      await log({ model: body.model, ms: Date.now() - started, status, phase: upstream?.phase ?? trace.phase, error: message.slice(0, 300),
        ...(cause ? { cause } : {}), ...(upstream?.quota ? { stopped: upstream.quota } : {}), events: trace.events, idleMs: Date.now() - trace.lastDataAt });
      if (opened) {
        sse(response, 'error', error(kind, message));
        response.end();
      } else json(response, status, error(kind, message));
      if (upstream?.quota) options.onHardQuota?.(upstream.quota);
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * 上游走流式（票据 25，M287）：streamGenerateContent?alt=sse，按顺序收集各分块的 parts，用量与结束原因取最后出现的值，
   * 合并后交给 fromGoogle。用 node:http(s) 而不是全局 fetch：fetch 的响应头与响应体各有固定的 300 秒超时，改不了。
   */
  async function callUpstream(body: AnthropicRequest, session: string, trace: Trace, streaming: () => void): Promise<Translated> {
    const url = new URL(`${options.upstream.replace(/\/+$/, '')}/models/${body.model}:streamGenerateContent?alt=sse`);
    const payload = Buffer.from(JSON.stringify(toGoogle(body)));
    const send = https ? httpsRequest : httpRequest;
    const request = send(url, { method: 'POST', agent, headers: {
      'content-type': 'application/json', 'content-length': payload.length, accept: 'text/event-stream', 'accept-encoding': 'identity',
      'user-agent': USER_AGENT, 'x-opencode-session': session, 'x-goog-api-key': options.key,
    } });
    // 套接字上 UPSTREAM_IDLE_MS 没有任何数据就放弃：连接、等响应头与流中的停顿都算。
    let idle = false;
    request.setTimeout(UPSTREAM_IDLE_MS, () => { idle = true; request.destroy(); });
    const failed = (cause: unknown) => idle
      ? new UpstreamError(502, trace.phase, `上游 ${UPSTREAM_IDLE_MS / 1000} 秒没有数据`, { code: 'IDLE_TIMEOUT', message: `${UPSTREAM_IDLE_MS} ms` })
      : new UpstreamError(502, trace.phase, trace.phase === 'stream' ? '上游的流中途断开' : '没有收到上游的响应', causeOf(cause));
    const response = await new Promise<IncomingMessage>((done, fail) => {
      request.once('response', done);
      // 收到响应之后的套接字错误由读响应体的一侧报出，这里只吞掉，避免没有监听者的 error 事件。
      request.on('error', (cause) => fail(failed(cause)));
      request.end(payload);
    });
    trace.lastDataAt = Date.now();
    if (response.statusCode !== 200) {
      trace.phase = 'status';
      const status = response.statusCode ?? 502;
      let text = '';
      try {
        text = await readText(response, 4096);
      } catch { /* 状态码已经够用，读不完正文不影响 */ }
      throw new UpstreamError(status, 'status', `上游 ${status}：${text.slice(0, 500)}`, undefined, hardQuota(text));
    }
    trace.phase = 'stream';
    streaming();
    const merged: { parts: Json[]; finishReason?: string; usage?: Json } = { parts: [] };
    const take = (data: string) => {
      let chunk: Json;
      try {
        chunk = JSON.parse(data) as Json;
      } catch {
        throw new UpstreamError(502, 'stream', `上游的流里有不完整的分块（${data.length} 字符）`);
      }
      const upstreamError = chunk['error'] as Json | undefined;
      if (upstreamError) {
        const code = Number(upstreamError['code']);
        throw new UpstreamError(code >= 400 && code < 600 ? code : 502, 'stream', `上游在流中报错：${String(upstreamError['message'] ?? JSON.stringify(upstreamError)).slice(0, 500)}`, undefined, hardQuota(chunk));
      }
      trace.events++;
      const candidate = (chunk['candidates'] as Json[] | undefined)?.[0];
      merged.parts.push(...((((candidate?.['content'] ?? {}) as Json)['parts'] as Json[] | undefined) ?? []));
      if (typeof candidate?.['finishReason'] === 'string') merged.finishReason = candidate['finishReason'];
      // 提示词被拦下时没有候选，也不会再有结束原因。
      else if (typeof (chunk['promptFeedback'] as Json | undefined)?.['blockReason'] === 'string') merged.finishReason ??= 'OTHER';
      if (chunk['usageMetadata']) merged.usage = chunk['usageMetadata'] as Json;
    };
    try {
      await readSse(response, take, () => {
        const now = Date.now();
        trace.maxGapMs = Math.max(trace.maxGapMs, now - trace.lastDataAt);
        trace.lastDataAt = now;
      });
    } catch (cause) {
      throw cause instanceof UpstreamError ? cause : failed(cause);
    }
    if (idle) throw failed(undefined);
    if (merged.finishReason === undefined) throw new UpstreamError(502, 'stream', '上游的流在给出结束原因之前结束');
    return fromGoogle({ candidates: [{ content: { parts: merged.parts }, finishReason: merged.finishReason }], usageMetadata: merged.usage ?? {} });
  }

  function toGoogle(body: AnthropicRequest): Json {
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
          const id = String(block['tool_use_id']);
          const { text, images } = toolResult(block);
          parts.push({ functionResponse: { name: names.get(id) ?? 'tool', response: { content: text } } }, ...images.map((image) => ({ inlineData: image })));
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
        // 思考摘要随流送达，上游链路在长思考时也有数据；fromGoogle 照旧丢掉思考部分（票据 25）。
        thinkingConfig: { includeThoughts: true },
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.stop_sequences?.length ? { stopSequences: body.stop_sequences } : {}),
      },
    };
  }

  function fromGoogle(response: Json): Translated {
    const candidate = (response['candidates'] as Json[] | undefined)?.[0] ?? {};
    const parts = (((candidate['content'] ?? {}) as Json)['parts'] as Json[] | undefined) ?? [];
    const content: Translated['content'] = [];
    for (const part of parts) {
      // 思考部分不转给 Claude Code。
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

  async function log(entry: Json): Promise<void> {
    if (options.log) await appendFile(options.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  }

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done());
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
      agent.destroy();
    }),
  };
}

class UpstreamError extends Error {
  constructor(readonly status: number, readonly phase: Phase, message: string, readonly reason?: { code?: string; message: string }, readonly quota?: QuotaStop) { super(message); }
}

/** 底层原因：node:http 的错误自带 code（ECONNRESET、ENOTFOUND、证书错误等）；包了一层的取 cause。 */
function causeOf(failure: unknown): { code?: string; message: string } {
  const inner = failure instanceof Error && failure.cause instanceof Error ? failure.cause : failure;
  if (!(inner instanceof Error)) return { message: String(inner) };
  const code = (inner as NodeJS.ErrnoException).code;
  return { ...(code ? { code } : {}), message: inner.message.slice(0, 200) };
}

/** 读 SSE：网络分块可能截断在行中间；data 行按事件合并（空行结束一个事件），其他字段与注释行忽略。 */
async function readSse(response: IncomingMessage, onEvent: (data: string) => void, onData: () => void): Promise<void> {
  response.setEncoding('utf8');
  let buffer = '';
  let data: string[] = [];
  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) onEvent(data.join('\n'));
      data = [];
    } else if (text.startsWith('data:')) data.push(text.slice(text.startsWith('data: ') ? 6 : 5));
  };
  for await (const chunk of response) {
    onData();
    buffer += chunk as string;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      line(buffer.slice(0, end).replace(/\r$/, ''));
      buffer = buffer.slice(end + 1);
    }
  }
  // 最后一个事件后面没有空行时也交出去；不完整的 JSON 由调用方按流中断处理。
  line(buffer.replace(/\r$/, ''));
  line('');
}

async function readText(response: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= limit) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function systemText(system: AnthropicRequest['system']): string {
  if (system === undefined) return '';
  return typeof system === 'string' ? system : system.filter((block) => block.type === 'text').map((block) => String(block['text'])).join('\n\n');
}

/** 工具结果：文字合并，图片转成 inlineData；出错的结果标明。 */
function toolResult(block: Block): { text: string; images: Json[] } {
  const raw = block['content'];
  const blocks = typeof raw === 'string' ? [{ type: 'text', text: raw } as Block] : Array.isArray(raw) ? (raw as Block[]) : [];
  const text = blocks.filter((item) => item.type === 'text').map((item) => String(item['text'])).join('\n');
  const images = blocks.filter((item) => item.type === 'image').map(inlineData).filter((image): image is Json => image !== undefined);
  return { text: `${block['is_error'] === true ? '错误：' : ''}${text}`, images };
}

function inlineData(block: Block): Json | undefined {
  const source = block['source'] as Json | undefined;
  return source?.['type'] === 'base64' ? { mimeType: String(source['media_type']), data: String(source['data']) } : undefined;
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
