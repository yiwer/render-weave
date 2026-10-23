/** 完整与中断轮次共用的可证用量读取；未知不补零，thinking 属于 output。 */
import {readFile} from 'node:fs/promises';
import {join, relative} from 'node:path';
import type {AgentTaskId} from './tasks.js';
import type {RoundRecord, RoundOutcome} from './run.js';
export interface RoundMetrics {
  readonly task: AgentTaskId;
  /** 相对评估输出目录。 */
  readonly dir: string;
  /** missing：没有轮次记录（发起失败）。 */
  readonly verdict: RoundRecord['verdict'] | 'missing';
  readonly wallMs?: number;
  readonly turns?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thinkingTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly endedBy?: string;
  readonly stopped?: RoundRecord['run']['stopped'];
  readonly pending?: number;
  readonly toolCalls?: number;
  readonly toolErrors?: number;
  /** 被 Claude Code 转存（<persisted-output>）或因过大拒收的工具结果数（票据 22）。 */
  readonly persistedResults?: number;
  /** 第一次 check_templates 的问题数（票据 27）。 */
  readonly firstCheckProblems?: number;
  /** 执行器无法启动或模型服务报错（如额度用完）。 */
  readonly error?: string;
}

export async function readRoundMetrics(dir: string, outDir: string, task?: AgentTaskId): Promise<RoundMetrics | undefined> {
  const logs = await summarizeLogs(dir);
  let record: RoundRecord;
  try {
    record = JSON.parse(await readFile(join(dir, 'round.json'), 'utf8')) as RoundRecord;
  } catch {
    if (!task) return undefined;
    // 宿主强退可能只留下完整 result 行；只读取运行时给出的累计用量，不把逐条消息相加。
    let result: Record<string, any> | undefined;
    try {for (const line of (await readFile(join(dir, 'logs/stream.jsonl'), 'utf8')).split('\n')) {
      try {const message = JSON.parse(line); if (message.type === 'result') result = message;} catch { /* 未写完的行没有可信用量 */ }
    }} catch { /* 无日志则全部用量未知 */ }
    const usage = result?.usage, number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    return {task, dir: relative(outDir, dir).replaceAll('\\', '/'), verdict: 'missing', ...logs,
      inputTokens: number(usage?.input_tokens), outputTokens: number(usage?.output_tokens), thinkingTokens: number(usage?.output_tokens_details?.thinking_tokens),
      cacheReadTokens: number(usage?.cache_read_input_tokens), cacheCreationTokens: number(usage?.cache_creation_input_tokens),
      ...(result?.subtype ? {endedBy: String(result.subtype)} : {})};
  }
  if (!record?.run || !['qualified', 'unqualified'].includes(record.verdict)) return undefined;
  let outcome: RoundOutcome | undefined;
  try { outcome = JSON.parse(await readFile(join(dir, 'outcome.json'), 'utf8')) as RoundOutcome; } catch { outcome = undefined; }
  const run = record.run;
  const pick = <K extends keyof typeof run>(key: K) => (run[key] === undefined ? {} : { [key]: run[key] });
  return {
    task: record.task, dir: relative(outDir, dir).replaceAll('\\', '/'), verdict: record.verdict,
    ...pick('wallMs'), ...pick('turns'), ...pick('inputTokens'), ...pick('outputTokens'), ...pick('thinkingTokens'), ...pick('cacheReadTokens'), ...pick('cacheCreationTokens'), ...pick('endedBy'), ...pick('stopped'),
    ...(outcome ? { pending: outcome.pending.length } : {}), ...logs,
    ...(run.error ? { error: run.error } : {}),
  } as RoundMetrics;
}

/** 完整与中断轮次使用同一计数规则；末尾损坏的一行不抹去此前完整事件。 */
async function summarizeLogs(dir: string): Promise<Pick<RoundMetrics, 'toolCalls' | 'toolErrors' | 'firstCheckProblems' | 'persistedResults'>> {
  let toolCalls: number | undefined, toolErrors: number | undefined, firstCheckProblems: number | undefined;
  try {
    const calls: {tool: string; isError?: boolean; problems?: number}[] = [];
    for (const line of (await readFile(join(dir, 'logs/tools.jsonl'), 'utf8')).split('\n')) {
      try {const call = JSON.parse(line); if (call && typeof call.tool === 'string') calls.push(call);} catch { /* 未写完的行不计入 */ }
    }
    toolCalls = calls.length;
    toolErrors = calls.filter(call => call.isError === true).length;
    firstCheckProblems = calls.find(call => call.tool === 'check_templates' && !call.isError)?.problems;
  } catch { /* 没有日志时计数未知 */ }
  const persistedResults = await countPersisted(join(dir, 'logs/stream.jsonl'));
  return {...(toolCalls !== undefined ? {toolCalls, toolErrors} : {}), ...(persistedResults !== undefined ? {persistedResults} : {}),
    ...(firstCheckProblems !== undefined ? {firstCheckProblems} : {})};
}

/** 流式日志里被 Claude Code 转存成文件、或因过大被拒收的工具结果数；没有日志时为 undefined（票据 22）。 */
export async function countPersisted(file: string): Promise<number | undefined> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return undefined; }
  let count = 0;
  for (const line of text.split('\n')) {
    let message: { type?: string; message?: { content?: unknown } };
    try { message = JSON.parse(line) as typeof message; } catch { continue; }
    if (message.type !== 'user' || !Array.isArray(message.message?.content)) continue;
    for (const block of message.message.content as { type?: string; content?: unknown }[]) {
      if (block.type === 'tool_result' && /<persisted-output>|exceeds maximum allowed tokens/.test(JSON.stringify(block.content ?? ''))) count++;
    }
  }
  return count;
}

