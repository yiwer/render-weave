/** 模块里几页之间的页签（原型第 29 版的下划线页签）：出图模块里是出图记录与批次，静态数据定义模块里是全部版本与发布记录。 */
import { href } from '../hooks.js';

const DELIVER: readonly (readonly [string, string])[] = [['records', '出图记录'], ['batches', '批次']];

export function StaticSchemaTabs(props: { readonly active: 'versions' | 'publications' }) {
  return (
    <nav className="module-tabs" aria-label="静态数据定义">
      <a href={href(['static-schemas'])} aria-current={props.active === 'versions' ? 'page' : undefined}>全部版本</a>
      <a href={href(['definition-publications'])} aria-current={props.active === 'publications' ? 'page' : undefined}>发布记录</a>
    </nav>
  );
}

export function DeliverTabs(props: { readonly active: 'records' | 'batches' }) {
  return (
    <nav className="module-tabs" aria-label="出图">
      {DELIVER.map(([name, label]) => (
        <a key={name} href={href([name])} aria-current={props.active === name ? 'page' : undefined}>{label}</a>
      ))}
    </nav>
  );
}
