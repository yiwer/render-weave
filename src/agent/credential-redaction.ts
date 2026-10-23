/** 已知凭据只在内存中登记；在进入持久日志前脱敏，兼容跨分块与 UTF-8 边界。 */
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
export function credentialRedactor(values: readonly string[]) {
  const secrets = [...new Set(values.filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  const redact = (text: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]'), text);
  return {
    text: redact,
    stream() {
      const decoder = new StringDecoder('utf8');
      let pending = '';
      // 仅保留可能是凭据开头的尾段，正常 JSONL 事件无需等待额外一块。
      const take = (final: boolean) => {
        let offset = 0, output = '';
        while (offset < pending.length) {
          const match = secrets.find(secret => pending.startsWith(secret, offset));
          if (match) { output += '[REDACTED]'; offset += match.length; continue; }
          if (!final && secrets.some(secret => secret.startsWith(pending.slice(offset)))) break;
          output += pending[offset++];
        }
        pending = pending.slice(offset); return output;      };
      return new Transform({
        transform(chunk, _encoding, done) { pending += decoder.write(chunk); this.push(take(false)); done(); },
        flush(done) { pending += decoder.end(); this.push(take(true)); done(); },
      });
    },
  };
}