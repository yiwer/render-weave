/** 模块里几页之间的页签（原型第 29 版的下划线页签）：出图模块里是出图记录与批次。 */
import { href } from '../hooks.js';

const DELIVER: readonly (readonly [string, string])[] = [['records', '出图记录'], ['batches', '批次']];

export function DeliverTabs(props: { readonly active: 'records' | 'batches' }) {
  return (
    <nav className="module-tabs" aria-label="出图">
      {DELIVER.map(([name, label]) => (
        <a key={name} href={href([name])} aria-current={props.active === name ? 'page' : undefined}>{label}</a>
      ))}
    </nav>
  );
}
