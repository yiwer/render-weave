/** 从运行时事件观测上下文；不把轮次累计计费 token 当作单请求占用。 */
import { isRecord } from '../util.js';

export interface ContextStop {
  readonly reason: 'contextLimit';
  readonly limit: number;
  readonly observedInputTokens: number;
}
interface RequestUsage {
  readonly id: string;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens?: number;
  readonly effectiveInputTokens?: number;
}
export interface ContextReport {
  readonly format: 'renderweave-context/1';
  readonly source: 'runtime-events';
  readonly limit: number | null;
  readonly peakInputTokens: number | null;
  readonly requests: readonly RequestUsage[];
  readonly compactions: readonly { readonly beforeTokens?: number }[];
  readonly tools: { readonly calls: number; readonly results: number; readonly textChars: number; readonly images: number; readonly encodedImageChars: number };
  readonly runtime: { readonly skills: readonly string[]; readonly plugins: readonly string[]; readonly tools: readonly string[] };
  readonly stopped?: ContextStop;
}

const numeric = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** 同一 assistant message 可能按内容块重复发出，usage 与工具 ID 均去重。 */
export function observeContext(limit: number | undefined, stop: (reason: ContextStop) => void) {
  const requests = new Map<string, RequestUsage>();
  const calls = new Set<string>(), results = new Set<string>();
  const compactions: { beforeTokens?: number }[] = [];
  let textChars = 0, images = 0, encodedImageChars = 0, stopped: ContextStop | undefined;
  let runtime: ContextReport['runtime'] = { skills: [], plugins: [], tools: [] };
  const contentSize = (content: unknown): void => {
    if (typeof content === 'string') { textChars += content.length; return; }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'text' && typeof block['text'] === 'string') textChars += block['text'].length;
      if (block['type'] === 'image') {
        images++;
        if (isRecord(block['source']) && typeof block['source']['data'] === 'string') encodedImageChars += block['source']['data'].length;
      }
    }
  };
  const accept = (event: unknown): void => {
    if (!isRecord(event)) return;
    if (event['type'] === 'system' && event['subtype'] === 'init') {
      runtime = { skills: strings(event['skills']), tools: strings(event['tools']),
        plugins: Array.isArray(event['plugins']) ? event['plugins'].flatMap((p) => isRecord(p) && typeof p['name'] === 'string' ? [p['name']] : []) : [] };
    }
    if (event['type'] === 'system' && event['subtype'] === 'compact_boundary') {
      const beforeTokens = isRecord(event['compact_metadata']) ? numeric(event['compact_metadata']['pre_tokens']) : undefined;
      compactions.push(beforeTokens === undefined ? {} : { beforeTokens });
    }
    const message = event['message'];
    if (!isRecord(message)) return;
    if (Array.isArray(message['content'])) for (const block of message['content']) {
      if (!isRecord(block)) continue;
      if (block['type'] === 'tool_use' && typeof block['id'] === 'string') calls.add(block['id']);
      if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string' && !results.has(block['tool_use_id'])) {
        results.add(block['tool_use_id']); contentSize(block['content']);
      }
    }
    if (event['type'] !== 'assistant' || typeof message['id'] !== 'string' || !isRecord(message['usage'])) return;
    const id = message['id'], usage = message['usage'], previous = requests.get(id);
    const inputTokens = numeric(usage['input_tokens']) ?? previous?.inputTokens;
    const cacheReadTokens = numeric(usage['cache_read_input_tokens']) ?? previous?.cacheReadTokens;
    const cacheCreationTokens = numeric(usage['cache_creation_input_tokens']) ?? previous?.cacheCreationTokens;
    const outputTokens = numeric(usage['output_tokens']) ?? previous?.outputTokens;
    const effectiveInputTokens = inputTokens === undefined ? undefined : inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
    requests.set(id, { id, ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }), ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }), ...(effectiveInputTokens === undefined ? {} : { effectiveInputTokens }) });
    if (!stopped && limit !== undefined && effectiveInputTokens !== undefined && effectiveInputTokens >= limit) {
      stopped = { reason: 'contextLimit', limit, observedInputTokens: effectiveInputTokens }; stop(stopped);
    }
  };
  const report = (): ContextReport => {
    const values = [...requests.values()], known = values.flatMap((v) => v.effectiveInputTokens === undefined ? [] : [v.effectiveInputTokens]);
    return { format: 'renderweave-context/1', source: 'runtime-events', limit: limit ?? null, peakInputTokens: known.length ? Math.max(...known) : null,
      requests: values, compactions, tools: { calls: calls.size, results: results.size, textChars, images, encodedImageChars }, runtime,
      ...(stopped ? { stopped } : {}) };
  };
  return { accept, report };
}
