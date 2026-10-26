/**
 * 上游错误的分类：transient 按轮次重试；quota 停止派发剩下的单元；host 是宿主没能确认本轮进程树已结束，不是模型的结果；
 * other（参数错误、缺 key、执行器无法启动）照旧算未达线。
 */
export type ErrorKind = 'transient' | 'quota' | 'host' | 'other';

const QUOTA = /\b429\b|rate[_ ]?limit|quota|usage limit/i;
const TRANSIENT = /\b(?:500|502|503|529)\b|overloaded|ECONNRESET|ETIMEDOUT|socket hang up/i;
const HOST = /本轮进程树清理未确认/;

/** 按 round.json 的 run.error 或发起失败的文字分类，大小写不敏感。两类字样都有时按额度算，不在关着的额度窗口上重试。 */
export function classifyError(text: string): ErrorKind {
  if (QUOTA.test(text)) return 'quota';
  if (TRANSIENT.test(text)) return 'transient';
  if (HOST.test(text)) return 'host';
  return 'other';
}

