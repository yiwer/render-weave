/** 只识别明确的硬额度错误；普通 429、5xx 和含糊的 rate_limit 不能据此终止。 */
import { isRecord } from '../util.js';

export interface QuotaStop {
  readonly reason: 'hardQuota';
  readonly type: string;
  readonly limit: string;
}

export function hardQuota(value: unknown): QuotaStop | undefined {
  if (typeof value === 'string') {
    // Claude Code 的 API 错误会在 JSON 前加 "API Error: 429"。
    const start = value.indexOf('{');
    if (start < 0) return undefined;
    try { return hardQuota(JSON.parse(value.slice(start))); } catch { return undefined; }
  }
  if (!isRecord(value)) return undefined;
  const error = isRecord(value['error']) ? value['error'] : value;
  const type = error['type'] ?? error['code'];
  if (type !== 'GoUsageLimitError' && type !== 'insufficient_quota' && type !== 'credit_balance_too_low') return undefined;
  const metadata = isRecord(value['metadata']) ? value['metadata'] : {};
  const limit = metadata['limitName'];
  return { reason: 'hardQuota', type, limit: typeof limit === 'string' && /^[\w-]{1,40}$/.test(limit) ? limit : 'unknown' };
}

/** 只看运行时报告的错误，不扫描助手正文或工具内容，避免被普通文本误触发。 */
export function runtimeQuota(value: unknown): QuotaStop | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] === 'result' && value['is_error'] === true) return hardQuota(value['result']);
  if (value['type'] === 'system' && value['subtype'] === 'api_retry') return hardQuota(value['error']);
  if (value['type'] === 'error') return hardQuota(value);
  return undefined;
}
