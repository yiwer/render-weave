/** 供应商用量快照。结果汇总优先；中途停止仅保留已收到的消息，不推算未知值。 */
import type { RoundUsage } from './run.js';
type Usage = Omit<RoundUsage, 'wallMs'>;
export function usageCollector() {
  const messages = new Map<string, Record<string, any>>();
  let result: Record<string, any> | undefined;
  const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const fields: Record<string, (value: Record<string, any>) => unknown> = {
    inputTokens: value => value.input_tokens, outputTokens: value => value.output_tokens,
    thinkingTokens: value => value.output_tokens_details?.thinking_tokens,
    cacheReadTokens: value => value.cache_read_input_tokens, cacheCreationTokens: value => value.cache_creation_input_tokens,
  };
  return {
    accept(event: Record<string, any>) {
      if (event.type === 'result') result = event;
      if (event.type === 'assistant' && typeof event.message?.id === 'string' && event.message.usage) messages.set(event.message.id, event.message.usage);
    },
    read(): Usage {
      const values = result?.usage ? [result.usage] : [...messages.values()];
      const known = Object.fromEntries(Object.entries(fields).flatMap(([key, take]) => {
        const observations = values.map(value => finite(take(value))).filter(value => value !== undefined);
        return observations.length ? [[key, observations.reduce((sum, value) => sum + value, 0)]] : [];
      }));
      return { ...known, ...(values.length ? { usageSource: result?.usage ? 'result' : 'messages' } : {}),
        ...(finite(result?.num_turns) !== undefined ? { turns: result!.num_turns } : {}) };
    },
  };
}
