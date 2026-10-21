/**
 * MCP 服务的协议层：stdio 上按行分隔的 JSON-RPC 2.0（MCP 2025-06-18 的 stdio 传输）。
 * 只实现初始化、工具列表、工具调用与 ping；标准输出只写协议消息。
 * 工具输入先按各自的输入 Schema 校验；工具调用逐个执行，避免并发出图占满内存。
 * 文字结果超过 MAX_TEXT_CHARS 时不交给客户端（Claude Code 会把超过 50,000 字符的结果转存成文件），改为工具错误（票据 22）。
 */
import { createInterface } from 'node:readline';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { describeError, isRecord } from '../util.js';
import { ToolInputError } from './files.js';

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** 一次工具结果的文字字符数上限，给客户端 50,000 字符的转存阈值留余量（票据 22）。 */
export const MAX_TEXT_CHARS = 40_000;
/** 全部工具只读、不访问外部（tools/list 的 annotations）。 */
const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false } as const;

export type ContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly data: string; readonly mimeType: 'image/png' };

export interface ToolResult {
  readonly content: readonly ContentBlock[];
  readonly isError?: boolean;
  /** 只写入调用日志，不返回给客户端。 */
  readonly summary?: Record<string, unknown>;
}

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>): Promise<ToolResult>;
}

export interface McpServerOptions {
  readonly tools: readonly McpTool[];
  readonly version: string;
  readonly write: (line: string) => void;
  /** 每次工具调用一条记录。 */
  readonly log?: (entry: Record<string, unknown>) => Promise<void>;
}

const ErrorCodes = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

/** 读完输入流、处理完所有请求后结束。 */
export async function serveMcp(input: NodeJS.ReadableStream, options: McpServerOptions): Promise<void> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const tools = new Map(options.tools.map((tool) => [tool.name, { tool, validate: ajv.compile(tool.inputSchema) }]));
  const send = (message: Record<string, unknown>) => options.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  let queue: Promise<void> = Promise.resolve();

  const handle = async (message: Record<string, unknown>): Promise<void> => {
    const { id, method, params } = message;
    if (id === undefined) return; // 通知（如 notifications/initialized）不需要回复
    if (method === 'initialize') {
      const requested = isRecord(params) ? params['protocolVersion'] : undefined;
      const protocolVersion = PROTOCOL_VERSIONS.find((version) => version === requested) ?? PROTOCOL_VERSIONS[0];
      send({ id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'renderweave', version: options.version } } });
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else if (method === 'tools/list') {
      send({ id, result: { tools: [...tools.values()].map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: READ_ONLY_ANNOTATIONS })) } });
    } else if (method === 'tools/call') {
      const name = isRecord(params) ? params['name'] : undefined;
      const entry = typeof name === 'string' ? tools.get(name) : undefined;
      if (!entry) {
        send({ id, error: { code: ErrorCodes.invalidParams, message: `没有工具 ${String(name)}；可用：${[...tools.keys()].join('、')}` } });
        return;
      }
      const args = isRecord(params) && params['arguments'] !== undefined ? params['arguments'] : {};
      const started = Date.now();
      const result = await callTool(entry.tool, entry.validate, args);
      const chars = result.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
      const imageBytes = result.content.reduce((sum, block) => sum + (block.type === 'image' ? Math.floor((block.data.length * 3) / 4) : 0), 0);
      await options.log?.({ at: new Date().toISOString(), tool: entry.tool.name, arguments: args, ms: Date.now() - started,
        isError: result.isError === true, ...result.summary, chars, imageBytes });
      send({ id, result: { content: result.content, isError: result.isError === true } });
    } else {
      send({ id, error: { code: ErrorCodes.methodNotFound, message: `不支持的方法：${String(method)}` } });
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === '') continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: ErrorCodes.parse, message: '消息不是有效的 JSON' } });
      continue;
    }
    const reply = isRecord(message) && ('result' in message || 'error' in message);
    if (!isRecord(message) || message['jsonrpc'] !== '2.0' || (typeof message['method'] !== 'string' && !reply)) {
      const id = isRecord(message) && (typeof message['id'] === 'string' || typeof message['id'] === 'number') ? message['id'] : null;
      send({ id, error: { code: ErrorCodes.invalidRequest, message: '不是 JSON-RPC 2.0 请求' } });
      continue;
    }
    if (reply) continue; // 客户端的回复：本服务不发请求，忽略
    const current = message;
    queue = queue.then(() => handle(current)).catch((error) => {
      if (current['id'] !== undefined) send({ id: current['id'], error: { code: ErrorCodes.internal, message: describeError(error) } });
    });
  }
  await queue;
}

async function callTool(tool: McpTool, validate: ValidateFunction, args: unknown): Promise<ToolResult> {
  if (!validate(args)) {
    const text = `参数不合规：${(validate.errors ?? []).map(describeInputError).join('；')}`;
    return { content: [{ type: 'text', text }], isError: true, summary: { error: text } };
  }
  try {
    const result = await tool.call(args as Record<string, unknown>);
    const chars = result.content.reduce((sum, block) => sum + (block.type === 'text' ? block.text.length : 0), 0);
    if (chars <= MAX_TEXT_CHARS) return result;
    // 工具各自按预算截断后仍超出：不交出超长结果，提示缩小范围（票据 22）。
    const text = `结果有 ${chars} 字符，超过一次返回的上限 ${MAX_TEXT_CHARS}：请缩小范围再调用，例如只给一部分文件、用 pointer 只取一段，或用 elements 与 depth 只看一部分元素`;
    return { content: [{ type: 'text', text }], isError: true, summary: { error: text, oversizedChars: chars } };
  } catch (error) {
    const text = error instanceof ToolInputError ? error.message : `工具出错：${describeError(error)}`;
    return { content: [{ type: 'text', text }], isError: true, summary: { error: text } };
  }
}

function describeInputError(error: ErrorObject): string {
  const at = error.instancePath === '' ? '参数' : error.instancePath.slice(1).replaceAll('/', '.');
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required': return `${at} 缺少 ${String(params['missingProperty'])}`;
    case 'additionalProperties': return `${at} 不能有 ${String(params['additionalProperty'])}`;
    case 'type': return `${at} 应为 ${String(params['type'])}`;
    case 'enum': return `${at} 只能取 ${(params['allowedValues'] as unknown[]).map((value) => JSON.stringify(value)).join('、')}`;
    case 'minItems': return `${at} 至少要有 ${String(params['limit'])} 项`;
    case 'minLength': return `${at} 不能为空`;
    case 'minimum': case 'exclusiveMinimum': case 'maximum': return `${at} 应 ${String(params['comparison'])} ${String(params['limit'])}`;
    default: return `${at} ${error.message ?? '不合规'}`;
  }
}
