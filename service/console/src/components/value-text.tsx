/** 变量的当前值与类型标记：变量面板、值格与绑定弹层共用。取值都来自元素求值。 */
import type { InspectedValue } from '../types.js';

export const TYPE_GLYPHS: Readonly<Record<string, string>> = { text: 'T', number: '#', date: '日', time: '时', datetime: '刻', boolean: '?', image: '图', color: '色', list: '≡', ref: '{}' };

export function ValueText(props: { readonly value: InspectedValue | undefined; readonly type?: string }) {
  const { value } = props;
  if (value === undefined || value === null) return <span className="value-text faint">空</span>;
  if (typeof value === 'object') {
    if ('list' in value) return <span className="value-text">{value.list} 项</span>;
    const name = value.fields['name'] ?? value.fields['title'];
    return <span className="value-text">{typeof name === 'string' ? `{ ${name} }` : '{…}'}</span>;
  }
  if (typeof value === 'boolean') return <span className="value-text">{value ? '是' : '否'}</span>;
  if (value === '') return <span className="value-text faint">空文本</span>;
  if (props.type === 'color') return <span className="value-text"><i className="value-swatch" style={{ background: String(value) }} aria-hidden="true" />{String(value).replace(/^(#[0-9A-Fa-f]{6})[Ff]{2}$/u, '$1')}</span>;
  const text = String(value);
  return <span className="value-text" title={text}>{text.startsWith('res:') ? text.slice(4) : text}</span>;
}
