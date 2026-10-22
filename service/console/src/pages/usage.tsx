/**
 * 用量（票据 14，M300）：一个计费周期（按 UTC+8 切分的自然月）的出图张数——限额、已用、预占与剩余，以及套餐与代建 token 的合计。
 * 客户管理员与操作员都能看合计（GET /v1/usage）；用量明细（GET /v1/usage/events）只给客户管理员，操作员的页面不请求它。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { PagedFooter } from '../components/paged.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, useLoad, usePaged } from '../hooks.js';
import type { Identity, TokenKind, Usage, UsageEvent, UsageKind } from '../types.js';

const KIND: Readonly<Record<UsageKind, string>> = {
  image: '出图张数', inputTokens: '输入 token', outputTokens: '输出 token', cacheReadTokens: '缓存读 token', cacheCreationTokens: '缓存写 token',
};
const TOKENS: readonly TokenKind[] = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
const number = (value: number) => value.toLocaleString('zh-CN');
const periodTitle = (period: string) => `${period.slice(0, 4)} 年 ${Number(period.slice(5, 7))} 月`;
/** 周期的起止按 UTC+8 显示：end 是下个月的第一天零点，显示成本月最后一天。 */
const day = (at: string, minusDay = false) => new Date(Date.parse(at) + 8 * 3_600_000 - (minusDay ? 86_400_000 : 0)).toISOString().slice(0, 10);

export function UsagePage(props: { readonly identity: Identity; readonly period?: string }) {
  const loaded = useLoad(() => api.usage(props.period), props.period ?? '');
  const usage = loaded.data;
  return (
    <section className="page">
      <div className="title-row">
        <div>
          <h1>用量</h1>
          <p className="lede">正式交付成功一张计一张；失败、取消、草稿预览与重放都不计。提交一批时先预占这一批的张数，交付完退回没用上的。每月按北京时间的自然月计，不结转。</p>
        </div>
        <form className="actions" onSubmit={(event) => event.preventDefault()}>
          <label htmlFor="usage-period">计费周期</label>
          <input id="usage-period" type="month" value={usage?.period ?? props.period ?? ''} onChange={(event) => { if (event.target.value) go(['usage'], { period: event.target.value }); }} />
          {props.period && <a className="button small quiet" href={href(['usage'])}>回到本月</a>}
        </form>
      </div>
      <ErrorBox problems={loaded.problems} title="读不到用量" />
      {loaded.loading && !usage && <p className="muted">正在读取…</p>}
      {usage && <Summary usage={usage} />}
      {usage && (props.identity.role === 'admin'
        ? <Events period={usage.period} />
        : <p className="muted card" style={{ marginTop: 24 }}>用量明细只给客户管理员查看。</p>)}
    </section>
  );
}

function Summary(props: { readonly usage: Usage }) {
  const { usage } = props, { images } = usage, total = Math.max(images.limit, images.used + images.reserved, 1);
  const stat = (name: keyof Usage['images'], label: string, note?: string) => (
    <div>
      <dt>{label}</dt>
      <dd><span className="big-number" data-testid={`usage-${name}`}>{number(images[name])}</span> <span className="muted">张</span></dd>
      {note && <dd className="small muted">{note}</dd>}
    </div>
  );
  return (
    <section className="card" aria-labelledby="usage-title">
      <div className="card-head">
        <h2 id="usage-title">{periodTitle(usage.period)}</h2>
        <span className="muted small">{day(usage.start)} 至 {day(usage.end, true)}（北京时间）</span>
      </div>
      <dl className="summary stats">
        {stat('limit', '限额')}
        {stat('used', '已用', '交付成功的张数')}
        {stat('reserved', '预占', '进行中的批次还没交付的张数')}
        {stat('remaining', '剩余', '限额 − 已用 − 预占')}
      </dl>
      <div className="progress" role="img" aria-label={`已用 ${number(images.used)} 张，预占 ${number(images.reserved)} 张，限额 ${number(images.limit)} 张`} style={{ marginTop: 16 }}>
        <div className="done" style={{ width: `${(images.used / total) * 100}%` }} />
        <div className="reserved" style={{ width: `${(images.reserved / total) * 100}%` }} />
      </div>
      <div className="legend" style={{ marginTop: 10 }}>
        <span><span className="swatch" style={{ background: 'var(--ok)' }} />已用</span>
        <span><span className="swatch" style={{ background: 'var(--mark)' }} />预占</span>
        <span><span className="swatch" style={{ background: 'var(--sunken)', border: '1px solid var(--field)' }} />剩余</span>
      </div>
      <dl className="facts" style={{ marginTop: 20 }}>
        <dt>套餐</dt>
        <dd>每月 {number(usage.plan.monthlyImages)} 张；单张最多 {number(usage.plan.maxPixels)} 像素；预览与重放各最多同时 {usage.plan.concurrency} 个</dd>
        <dt>代建 token</dt>
        <dd>{TOKENS.map((kind) => `${KIND[kind]} ${number(usage.tokens[kind])}`).join('，')}<span className="muted">（只记不拦）</span></dd>
      </dl>
    </section>
  );
}

/** 用量明细（只给客户管理员）：按 ID 倒序，可按种类筛选，"加载更多"接着翻。 */
function Events(props: { readonly period: string }) {
  const [kind, setKind] = useState<UsageKind | ''>('');
  const events = usePaged((before) => api.usageEvents({ period: props.period, ...(kind ? { kind } : {}), ...(before ? { before } : {}) }), `${props.period}:${kind}`);
  return (
    <section className="card" style={{ marginTop: 24 }} aria-labelledby="usage-events">
      <div className="card-head">
        <h2 id="usage-events">用量明细</h2>
        <label className="actions small">
          种类
          <select value={kind} onChange={(event) => setKind(event.target.value as UsageKind | '')}>
            <option value="">全部</option>
            {(Object.keys(KIND) as UsageKind[]).map((value) => <option key={value} value={value}>{KIND[value]}</option>)}
          </select>
        </label>
      </div>
      <ErrorBox problems={events.problems} title="读不到用量明细" />
      <table className="table">
        <thead><tr><th>时间</th><th>种类</th><th>数量</th><th>出处</th></tr></thead>
        <tbody>
          {events.items.map((event) => (
            <tr key={event.id} data-testid="usage-event" data-id={event.id}>
              <td>{new Date(event.at).toLocaleString('zh-CN')}</td>
              <td>{KIND[event.kind] ?? event.kind}</td>
              <td>{number(event.quantity)}</td>
              <td><Origin event={event} /></td>
            </tr>
          ))}
          {!events.loading && !events.problems && events.items.length === 0 && <tr><td colSpan={4} className="muted">这个周期还没有用量。</td></tr>}
        </tbody>
      </table>
      <PagedFooter paged={events} />
    </section>
  );
}

function Origin(props: { readonly event: UsageEvent }) {
  const { event } = props;
  if (event.batchId) return <a href={href(['batches', event.batchId])}>批次 <span className="mono">{event.batchId.slice(0, 8)}</span> 第 {event.index} 项</a>;
  if (event.round) return <span>代建 {event.round.task} 第 {event.round.round} 轮</span>;
  return <span className="muted">—</span>;
}
