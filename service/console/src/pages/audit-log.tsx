/**
 * 管理页的审计日志（票据 14，M301；P1 票据 03，M347）：写操作与内部人员对本租户的操作，按时间倒序，一页 50 条。
 * - 代建写入另显示前后内容哈希与差异摘要：哈希只显示开头几位，悬停看全文；差异列出计数，路径展开看（至多 50 项，每项带前后哈希）；
 * - 按主体种类与日期筛选，日期按浏览器的本地时间，起止都含当日；筛选结果可以导出 CSV，由服务端按同样的筛选生成。
 */
import { useState } from 'react';
import { api, saveBlob } from '../api.js';
import { PagedFooter } from '../components/paged.js';
import { ErrorBox } from '../components/problems.js';
import { problemsOf, usePaged } from '../hooks.js';
import { ACTOR_KINDS, type ActorKind, type AuditDiff, type AuditEvent, type AuditQuery, type Problem } from '../types.js';
import { DATE, dayStart } from './records.js';

const time = (at: string) => new Date(at).toLocaleString('zh-CN');

/** 审计里的操作与对象，写成给人看的说法；不认识的照原样显示代码。 */
const ACTION: Readonly<Record<string, string>> = {
  'session.create': '登录', 'member.create': '开通成员', 'member.list': '查看成员', 'member.update': '修改成员', 'member.passwordReset': '重置密码',
  'apiKey.create': '创建 API 密钥', 'apiKey.revoke': '吊销 API 密钥', 'webhook.create': '注册 webhook', 'webhook.update': '修改 webhook',
  'dataset.create': '新建数据集', 'dataset.update': '修改数据集', 'dataset.copy': '复制数据集', 'resource.upload': '上传资源', 'resource.replace': '替换资源',
  'batch.create': '提交出图', 'batch.cancel': '取消出图', 'tenant.create': '开通租户', 'plan.update': '设置套餐', 'plan.read': '查看套餐', 'usage.read': '查看用量',
  'authoringToken.create': '签发代建令牌', 'authoringToken.revoke': '吊销代建令牌', 'authoring.access': '代建访问', 'authoring.read': '代建读取工作区',
  'authoring.preview': '代建预览', 'content.read': '代建读取内容', 'content.upload': '代建上传内容', 'push.plan': '代建推送前比对', 'push.commit': '代建推送',
  'push.reject': '代建推送被拒', 'template.setCurrent': '切换模板修订',
};
const OBJECT: Readonly<Record<string, string>> = {
  session: '会话', member: '成员', apiKey: 'API 密钥', webhook: 'webhook', dataset: '数据集', resource: '资源', batch: '批次', tenant: '租户',
  push: '推送', template: '模板', content: '内容', authoringToken: '代建令牌',
};
const ACTOR: Readonly<Record<ActorKind, string>> = { member: '成员', apiKey: 'API 密钥', authoringToken: '代建工程师', platformUser: '平台管理员', system: '系统' };
const CHANGE: Readonly<Record<AuditDiff['paths'][number]['change'], string>> = { added: '新增', removed: '删除', changed: '修改' };

interface Filters { readonly actorKind: '' | ActorKind; readonly from: string; readonly to: string }
const NO_FILTERS: Filters = { actorKind: '', from: '', to: '' };

const queryOf = (filters: Filters): AuditQuery => ({
  ...(filters.actorKind ? { actorKind: filters.actorKind } : {}),
  ...(DATE.test(filters.from) ? { from: dayStart(filters.from) } : {}), ...(DATE.test(filters.to) ? { to: dayStart(filters.to, 1) } : {}),
});

export function AuditLog() {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [exportProblems, setExportProblems] = useState<readonly Problem[]>();
  const [exporting, setExporting] = useState(false);
  const reversed = DATE.test(filters.from) && DATE.test(filters.to) && filters.to < filters.from;
  const events = usePaged((before) => (reversed ? Promise.resolve({ items: [] }) : api.auditEvents({ ...queryOf(filters), ...(before ? { before } : {}) })),
    `audit ${JSON.stringify(filters)}`);
  const filtered = filters.actorKind !== '' || filters.from !== '' || filters.to !== '';
  const set = (name: keyof Filters, value: string) => setDraft((previous) => ({ ...previous, [name]: value }));

  const exportCsv = async () => {
    setExportProblems(undefined);
    setExporting(true);
    try { saveBlob(await api.auditExport(queryOf(filters)), `audit-events-${new Date().toISOString().slice(0, 10)}.csv`); }
    catch (error) { setExportProblems(problemsOf(error)); }
    finally { setExporting(false); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>审计日志</h2>
        <span className="small muted">写操作与我们内部人员（平台管理员、代建工程师）对本租户的操作，按时间倒序；代建写入另记前后内容哈希与差异摘要。不记业务内容与密钥。</span>
      </div>
      <form className="filters" role="search" aria-label="筛选审计日志" style={{ padding: '0 0 12px' }}
        onSubmit={(event) => { event.preventDefault(); setFilters(draft); }}>
        <div className="field">
          <label htmlFor="audit-actor">主体</label>
          <select id="audit-actor" value={draft.actorKind} onChange={(event) => set('actorKind', event.target.value)}>
            <option value="">全部主体</option>
            {ACTOR_KINDS.map((kind) => <option key={kind} value={kind}>{ACTOR[kind]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-from">起始日期</label>
          <input id="audit-from" type="date" value={draft.from} onChange={(event) => set('from', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="audit-to">截止日期</label>
          <input id="audit-to" type="date" value={draft.to} onChange={(event) => set('to', event.target.value)} />
        </div>
        <div className="actions">
          <button type="submit" className="primary">查询</button>
          {filtered && <button type="button" className="quiet" onClick={() => { setDraft(NO_FILTERS); setFilters(NO_FILTERS); }}>清除筛选</button>}
          <button type="button" className="quiet" disabled={exporting || reversed} onClick={() => void exportCsv()}>{exporting ? '正在导出…' : '导出 CSV'}</button>
        </div>
      </form>
      {reversed && <p className="field-problems" role="alert"><span style={{ color: 'var(--bad)' }}>截止日期不能早于起始日期</span></p>}
      <ErrorBox problems={events.problems} title="读不到审计日志" />
      <ErrorBox problems={exportProblems} title="导出失败" />
      <table className="table">
        <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>内容</th></tr></thead>
        <tbody>
          {events.items.map((event) => (
            <tr key={event.id} data-testid="audit-row" data-id={event.id} data-action={event.action} data-actor-kind={event.actor.kind}>
              <td>{time(event.at)}</td>
              <td>
                {event.actor.label}
                <div className="small muted">{ACTOR[event.actor.kind as ActorKind] ?? event.actor.kind}{event.crossTenant && <span className="chip warn" style={{ marginLeft: 6 }}>跨租户</span>}</div>
              </td>
              <td>{ACTION[event.action] ?? event.action}<div className="mono muted">{event.action}</div></td>
              <td>{OBJECT[event.object.type] ?? event.object.type}<div className="mono muted" style={{ wordBreak: 'break-all' }}>{event.object.id}</div></td>
              <td data-testid="audit-content"><Content event={event} /></td>
            </tr>
          ))}
          {!events.loading && !events.problems && events.items.length === 0 && (
            <tr><td colSpan={5} className="muted">{filtered ? '没有符合条件的审计事件。' : '还没有审计事件。'}</td></tr>
          )}
        </tbody>
      </table>
      <PagedFooter paged={events} />
    </div>
  );
}

/** 内容哈希只显示开头 8 位，悬停看全文。 */
function Hash(props: { readonly sha256?: string }) {
  return props.sha256 ? <span className="mono" title={props.sha256} data-sha256={props.sha256}>{props.sha256.slice(0, 8)}</span> : <span className="muted">无</span>;
}

/** 代建写入的前后内容哈希、差异摘要、轮次与理由；别的事件没有内容，显示一条短横。 */
function Content(props: { readonly event: AuditEvent }) {
  const { beforeSha256, afterSha256, diff, round, reason } = props.event;
  if (!beforeSha256 && !afterSha256 && !diff && !round && !reason) return <span className="muted">—</span>;
  const unlisted = diff ? diff.added + diff.removed + diff.changed - diff.paths.length : 0;
  return (
    <div className="small">
      {(beforeSha256 || afterSha256) && <div>前 <Hash {...(beforeSha256 ? { sha256: beforeSha256 } : {})} /> → 后 <Hash {...(afterSha256 ? { sha256: afterSha256 } : {})} /></div>}
      {diff && (
        <details data-testid="audit-diff">
          <summary>新增 {diff.added} · 修改 {diff.changed} · 删除 {diff.removed}</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {diff.paths.map((item) => (
              <li key={`${item.change} ${item.path}`} data-path={item.path}>
                {CHANGE[item.change]} <span className="mono" style={{ wordBreak: 'break-all' }}>{item.path}</span>
                <div className="muted"><Hash {...(item.beforeSha256 ? { sha256: item.beforeSha256 } : {})} /> → <Hash {...(item.afterSha256 ? { sha256: item.afterSha256 } : {})} /></div>
              </li>
            ))}
          </ul>
          {unlisted > 0 && <div className="muted">另有 {unlisted} 项没有列出，导出 CSV 也只有前 {diff.paths.length} 项。</div>}
        </details>
      )}
      {round && <div className="muted">轮次 <span className="mono">{round}</span></div>}
      {reason && <div className="muted">理由：{reason}</div>}
    </div>
  );
}
