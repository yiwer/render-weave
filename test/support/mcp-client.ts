/** 在进程内经 runCli 启动 `renderweave mcp`，用按行分隔的 JSON-RPC 直接驱动，不经模型。 */
import { PassThrough } from 'node:stream';
import { runCli } from '../../src/cli.js';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolCall { content: Content[]; isError: boolean }

export interface McpSession {
  /** 发送请求并等待同 id 的回复（完整的 JSON-RPC 消息）。 */
  request(method: string, params?: unknown): Promise<Record<string, any>>;
  call(name: string, args?: unknown): Promise<ToolCall>;
  /** 调用工具并把第一段文字按 JSON 解析；工具报错时抛出。 */
  callJson(name: string, args?: unknown): Promise<any>;
  /** 原样写一行，用于协议错误测试。 */
  sendRaw(line: string): void;
  /** 没有 id 可对应的回复（如解析错误）。 */
  readonly orphans: Record<string, any>[];
  readonly stderr: string[];
  /** 结束标准输入，等待命令返回退出码。 */
  close(): Promise<number>;
}

export function startMcp(args: readonly string[]): McpSession {
  const stdin = new PassThrough();
  const stderr: string[] = [];
  const orphans: Record<string, any>[] = [];
  const pending = new Map<number, (message: Record<string, any>) => void>();
  let buffer = '', nextId = 1;
  const exit = runCli(['mcp', ...args], {
    stdin,
    stderr: (text) => stderr.push(text),
    stdout: (text) => {
      buffer += text;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        const resolve = pending.get(message.id);
        if (resolve) { pending.delete(message.id); resolve(message); } else orphans.push(message);
      }
    },
  });
  const request = (method: string, params?: unknown) => new Promise<Record<string, any>>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
  });
  const call = async (name: string, args: unknown = {}): Promise<ToolCall> => {
    const reply = await request('tools/call', { name, arguments: args });
    if (reply.error) throw new Error(`协议错误 ${reply.error.code}：${reply.error.message}`);
    return reply.result;
  };
  return {
    request, call, orphans, stderr,
    async callJson(name, args) {
      const result = await call(name, args);
      const text = result.content.find((block) => block.type === 'text') as { text: string } | undefined;
      if (result.isError) throw new Error(`工具 ${name} 报错：${text?.text}`);
      return JSON.parse(text!.text);
    },
    sendRaw: (line) => { stdin.write(`${line}\n`); },
    async close() {
      stdin.end();
      return exit;
    },
  };
}
