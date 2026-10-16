/**
 * 模型协议转换（M232）：Claude Code 只会发 Anthropic Messages 请求，Gemini 只提供 Google generateContent 接口。
 * 发起 Gemini 的轮次时，agent run 在本进程里起这个转换代理，Claude Code 连它，它再连上游。
 *
 * - 只绑定 127.0.0.1，端口由系统分配，随本轮结束关闭。只接受带本轮令牌的请求：Claude Code 拿到的是令牌，
 *   上游 key 只在本进程内存里。Host 必须是本机地址加本端口（防 DNS 重绑定），拒绝带 Origin 的网页请求与非 JSON 请求。
 * - 上游一次性返回完整结果，代理再拼成 Anthropic 的流式事件；等待期间每 15 秒发一次 ping。
 * - 工具结果中的图片放在同一轮的 inlineData 里。
 * - Gemini 的 thoughtSignature 按工具调用 id 记在本代理里，下一次请求时补回对应的 functionCall（多轮工具调用必需）。
 * - 带稳定的 x-opencode-session（取 Claude Code 的会话头）。日志只记用时、状态、token 与内容块类型，不记内容。
 *
 * 它与审核页一样是命令行附带的本机服务：只用 node:http，不是阶段 4 的 HTTP 服务外壳。
 */
import { randomBytes } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

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
interface Translated {
  content: ({ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown })[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
}

export interface ModelProxyOptions {
  /** 上游的 Google API 基址，如 https://opencode.ai/inference/go/google/v1beta；请求发到 <基址>/models/<模型>:generateContent。 */
  readonly upstream: string;
  readonly key: string;
  /** 调用日志（JSON Lines），只记用时、状态、token 与内容块类型。 */
  readonly log?: string;
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
const UPSTREAM_TIMEOUT_MS = 600_000;

/** 只提供 Google 接口、要经转换代理连接的模型。 */
export function isGoogleModel(model: string): boolean {
  return model.startsWith('gemini');
}

export async function startModelProxy(options: ModelProxyOptions): Promise<ModelProxy> {
  const token = randomBytes(24).toString('hex');
  /** Gemini 的 thoughtSignature：工具调用 id → 签名。 */
  const signatures = new Map<string, string>();
  let counter = 0;
  let port = 0;

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

    const session = String(request.headers['x-claude-code-session-id'] ?? body.metadata?.user_id ?? 'renderweave');
    const started = Date.now();
    let heartbeat: NodeJS.Timeout | undefined;
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      heartbeat = setInterval(() => sse(response, 'ping', { type: 'ping' }), 15_000);
    }
    try {
      const result = await callUpstream(body, session);
      await log({ model: body.model, ms: Date.now() - started, status: 200, ...result.usage, stop: result.stopReason, blocks: result.content.map((block) => block.type) });
      if (body.stream) {
        streamMessage(response, body.model, result);
        response.end();
      } else {
        json(response, 200, { id: `msg_rw_${++counter}`, type: 'message', role: 'assistant', model: body.model, content: result.content,
          stop_reason: result.stopReason, stop_sequence: null, usage: result.usage });
      }
    } catch (failure) {
      const status = failure instanceof UpstreamError ? failure.status : 502;
      const kind = status === 429 ? 'rate_limit_error' : status === 400 ? 'invalid_request_error' : status === 401 || status === 403 ? 'authentication_error' : 'api_error';
      const message = failure instanceof Error ? failure.message : String(failure);
      await log({ model: body.model, ms: Date.now() - started, status, error: message.slice(0, 300) });
      if (body.stream) {
        sse(response, 'error', error(kind, message));
        response.end();
      } else json(response, status, error(kind, message));
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  async function callUpstream(body: AnthropicRequest, session: string): Promise<Translated> {
    const response = await fetch(`${options.upstream.replace(/\/+$/, '')}/models/${body.model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'x-opencode-session': session, 'x-goog-api-key': options.key },
      body: JSON.stringify(toGoogle(body)),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) throw new UpstreamError(response.status, `上游 ${response.status}：${text.slice(0, 500)}`);
    return fromGoogle(JSON.parse(text) as Json);
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
    }),
  };
}

class UpstreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
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
