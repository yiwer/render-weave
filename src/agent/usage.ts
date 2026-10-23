/** 供应商用量快照。结果汇总优先；中途停止仅保留已收到的消息，不推算未知值。 */
import type { RoundUsage } from './run.js';
type Usage = Omit<RoundUsage, 'wallMs'>;
export function usageCollector() {
  const messages = new Map<string, Record<string, number>>();
  let result: Record<string, number> = {}, turns: number | undefined;
  const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const fields: Record<string, (value: Record<string, any>) => unknown> = {
    inputTokens: value => value.input_tokens, outputTokens: value => value.output_tokens,
    thinkingTokens: value => value.output_tokens_details?.thinking_tokens,
    cacheReadTokens: value => value.cache_read_input_tokens, cacheCreationTokens: value => value.cache_creation_input_tokens,
  };
  const known = (value: Record<string, any> = {}): Record<string, number> => Object.fromEntries(Object.entries(fields).flatMap(([key, take]) => {
    const number = finite(take(value)); return number === undefined ? [] : [[key, number]];
  }));
  return {
    accept(event: Record<string, any>) {
      if (event.type === 'result') { result = { ...result, ...known(event.usage ?? {}) }; turns = finite(event.num_turns) ?? turns; }
      if (event.type === 'assistant' && typeof event.message?.id === 'string' && event.message.usage)
        messages.set(event.message.id, { ...messages.get(event.message.id), ...known(event.message.usage) });
    },
    read(): Usage {
      let partial = false;
      const metrics = Object.fromEntries(Object.keys(fields).flatMap(key => {
        if (result[key] !== undefined) return [[key, result[key]]];
        const observations = [...messages.values()].map(value => value[key]).filter(value => value !== undefined);
        if (!observations.length) return [];
        partial = true; return [[key, observations.reduce((sum, value) => sum + value, 0)]];
      }));
      return { ...metrics, ...(Object.keys(metrics).length ? { usageSource: partial ? 'messages' : 'result' } : {}),
        ...(turns !== undefined ? { turns } : {}) };
    },
  };
}
