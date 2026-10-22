/** 翻页列表的页脚（出图记录、用量明细、审计日志、投递记录）：正在读取、显示了几条、"加载更多"。 */
import type { Paged } from '../hooks.js';

export function PagedFooter(props: { readonly paged: Paged<unknown> }) {
  const { paged } = props;
  return (
    <div className="actions" style={{ marginTop: 12 }}>
      <span className="muted small">{paged.loading ? '正在读取…' : `显示 ${paged.items.length.toLocaleString('zh-CN')} 条${paged.next ? '，还有更多' : ''}`}</span>
      {paged.next && !paged.loading && <button type="button" className="small quiet" onClick={paged.more}>加载更多</button>}
    </div>
  );
}
