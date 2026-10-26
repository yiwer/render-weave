/**
 * 执行一轮的接缝：轮次宿主准备好工作目录、提示词、受管 MCP 与本机模型代理后，交给执行器跑完 Agent 循环。
 * 执行器按 Claude Code stream-json 的事件形状（system/init、assistant、user、result）写 logs/stream.jsonl，
 * 并把同样的事件交给 onEvent；用量、停滞控制、额度停止与评估指标只读这些事件，不区分执行器。
 * 内置文件工具沿用 Claude Code 的名称与输入（Read、Write、Edit、Glob），领域工具名写成 mcp__rw__<名称>。
 */
import type { QuotaStop } from './quota.js';
import type { AgentEffort, RoundUsage } from './run.js';

/** claude-code：受限模式的 Claude Code 无头运行（ADR-0015）；tool-runner：宿主进程内用 Anthropic SDK 的 Tool Runner 驱动循环。 */
export const AGENT_EXECUTORS = ['claude-code', 'tool-runner'] as const;
export type AgentExecutor = (typeof AGENT_EXECUTORS)[number];

export interface ExecutorRound {
  /** Agent 工作目录：内置文件工具只在这里读写。 */
  readonly cwd: string;
  readonly prompt: string;
  readonly logsDir: string;
  readonly model: string;
  readonly smallModel: string;
  readonly maxTurns: number;
  readonly effort?: AgentEffort;
  /** 内置文件工具，Claude Code 的 --tools 写法，如 Read,Write,Edit,Glob。 */
  readonly tools: string;
  /** 受管 MCP 的 stdio 启动方式；令牌与检查能力不在这里。 */
  readonly mcp: { readonly command: string; readonly args: readonly string[] };
  /** 本轮本机模型代理与令牌；上游 key 不进执行器。 */
  readonly proxy: { readonly url: string; readonly token: string };
  /** 子进程环境：只含系统变量。 */
  readonly env: Readonly<Record<string, string>>;
  /** 写日志前要脱敏的值。 */
  readonly secrets: readonly string[];
  readonly signal: AbortSignal;
  stop(reason: QuotaStop): void;
  /** 执行器已启动：Claude Code 记子进程，Tool Runner 记宿主自己。 */
  onSpawn(pid: number): Promise<void>;
  onUsage(usage: Omit<RoundUsage, 'wallMs'>): void;
  onEvent(event: Record<string, any>): void;
}

export interface ExecutorResult {
  readonly exitCode: number | null;
  readonly error?: string;
}

export type RoundExecutor = (round: ExecutorRound) => Promise<ExecutorResult>;
