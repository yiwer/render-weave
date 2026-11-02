/**
 * 待处理的发布申请（P1 票据 11，ADR-0021、ADR-0022）：数据定义发布记录页与发布模板修订页共用。
 * 列表不重核；选中一份才读详情，看现在还能不能批准、它改了什么。
 * 批准时服务端还会再重核一次，所以这里显示"能批准"之后，点下去仍可能过期：照实显示服务端的回答，再刷新。
 * 重核不符时不给"批准"，只给"标为过期"：接口上是同一个动作，服务端重核不符就标为过期。
 */
import { useState, type ReactNode } from 'react';
import { api } from '../api.js';
import { problemsOf, useLoad } from '../hooks.js';
import type { ApprovalScope, Problem, PublishRequest, PublishRequestDetail } from '../types.js';
import { ErrorBox, ProblemList } from './problems.js';

const time = (at: string) => new Date(at).toLocaleString('zh-CN');

/** 一份申请要做什么，写成一句话。 */
function requestTitle(request: PublishRequest): string {
  switch (request.kind) {
    case 'definitionPublish': return `发布 ${request.subject} v${request.version}${request.baseVersion === undefined ? '' : `（基于 v${request.baseVersion}）`}`;
    case 'templateSave': return `保存 ${request.subject}${request.baseRevision === undefined ? '（新模板）' : `（当前修订 ${request.baseRevision}）`}`;
    case 'templateSetCurrent': return `把 ${request.subject} 指回修订 ${request.revision}（当前修订 ${request.baseRevision}）`;
    case 'push': return `${request.requestedBy.label} 的一次推送`;
  }
}

const CHANGE: Readonly<Record<'added' | 'removed' | 'changed', string>> = { added: '+', removed: '−', changed: '~' };
const count = (request: PublishRequest) => {
  const { added, removed, changed } = request.diff;
  return [added ? `新增 ${added}` : '', changed ? `修改 ${changed}` : '', removed ? `删除 ${removed}` : ''].filter(Boolean).join(' · ') || '没有改动';
};

/** 差异摘要：审计记的那一份，路径是字段、元素或文档。接口只留前 50 项。 */
function DiffPaths(props: { readonly request: PublishRequest }) {
  const { paths, added, removed, changed } = props.request.diff;
  if (!paths.length) return <p className="muted">没有改动。</p>;
  return (
    <ul className="diff-list" data-testid="request-diff">
      {paths.map((item) => <li key={item.path} data-path={item.path} data-change={item.change}><span className={`diff-mark ${item.change}`}>{CHANGE[item.change]}</span><code>{item.path}</code></li>)}
      {added + removed + changed > paths.length && <li className="muted">只列前 {paths.length} 项，共 {added + removed + changed} 项。</li>}
    </ul>
  );
}

function RequestDetail(props: { readonly id: string; readonly canDecide: boolean; readonly onDecided: (notice: string) => void; readonly onStale: () => void; readonly renderChanges?: ((request: PublishRequestDetail) => ReactNode) | undefined }) {
  const { id, canDecide } = props;
  const loaded = useLoad(() => api.publishRequest(id), id);
  const [rejecting, setRejecting] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const request = loaded.data;
  const decide = async (work: () => Promise<string>) => {
    setBusy(true);
    setProblems(undefined);
    try {
      props.onDecided(await work());
    } catch (error) {
      setProblems(problemsOf(error));
      props.onStale();
    } finally { setBusy(false); }
  };
  if (!request) return <ErrorBox problems={loaded.problems} title="读不到这份申请" />;
  const valid = request.recheck?.valid === true;
  return (
    <div data-testid="request-detail">
      {props.renderChanges?.(request) ?? <DiffPaths request={request} />}
      <p className="meta" data-testid="request-facts">
        <span>{request.requestedBy.label} 申请于 {time(request.requestedAt)}</span>
        <span>内容哈希 <code className="hash" title={request.sha256} data-sha256={request.sha256}>sha256:{request.sha256.slice(0, 12)}…</code></span>
        {request.overwrite && <span className="warn">申请时明确要盖过别人先保存的修订</span>}
      </p>
      {request.recheck && !valid && (
        <div className="impact-note" data-testid="request-stale">
          <strong>这份申请已经不能批准：</strong><span>{request.recheck.message}。要生效得重新发起。</span>
          {request.recheck.blockers && request.recheck.blockers.length > 0 && <ProblemList problems={request.recheck.blockers} />}
        </div>
      )}
      <ErrorBox problems={problems} title="没有完成" />
      {!canDecide && <p className="small muted">发布申请由客户管理员处理。</p>}
      {canDecide && !rejecting && (
        <div className="actions">
          {valid
            ? <button type="button" className="primary small" disabled={busy || loaded.loading} onClick={() => void decide(async () => { await api.approvePublishRequest(id); return `已批准并生效：${requestTitle(request)}`; })}>{busy ? '正在批准…' : '批准'}</button>
            : <button type="button" className="small" disabled={busy || loaded.loading} onClick={() => void decide(async () => {
              // 重核不符时批准答 409 并标为过期，这正是这个按钮要的结果；万一这时又能批准了，批准就是生效，照实说。
              try {
                await api.approvePublishRequest(id);
                return `已批准并生效：${requestTitle(request)}`;
              } catch (error) {
                if (problemsOf(error).some((item) => item.code === 'publishRequest.expired')) return `已标为过期：${requestTitle(request)}`;
                throw error;
              }
            })}>标为过期</button>}
          <button type="button" className="small quiet" disabled={busy} onClick={() => setRejecting(true)}>退回</button>
        </div>
      )}
      {canDecide && rejecting && (
        <div className="request-reject">
          <label htmlFor={`reject-${id}`}>退回的留言</label>
          <textarea id={`reject-${id}`} rows={2} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="说明为什么退回，申请人看得到" />
          <div className="actions">
            <button type="button" className="small" disabled={busy || !message.trim()} onClick={() => void decide(async () => { await api.rejectPublishRequest(id, message); return `已退回：${requestTitle(request)}`; })}>确认退回</button>
            <button type="button" className="small quiet" disabled={busy} onClick={() => setRejecting(false)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 一个范围的待处理申请；没有时什么也不显示。subject 只看这个名称的申请，推送碰到这个范围的也算。
 * renderChanges 让页面用自己的差异组件显示 changes；答 undefined 时用差异摘要。
 */
export function PendingRequests(props: {
  readonly scope: ApprovalScope;
  readonly subject?: string | undefined;
  readonly canDecide: boolean;
  readonly onDecided?: () => void;
  readonly renderChanges?: (request: PublishRequestDetail) => ReactNode;
}) {
  const { scope, subject } = props;
  const loaded = useLoad(() => api.publishRequests({ status: 'pending', scope }), `publish-requests:${scope}`);
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const requests = (loaded.data?.requests ?? []).filter((request) => subject === undefined || request.kind === 'push' || request.subject === subject);
  return (
    <>
      {notice && <p className="status" role="status" data-testid="request-notice">{notice}</p>}
      <ErrorBox problems={loaded.problems} title="读不到发布申请" />
      {requests.length > 0 && (
        <section className="card" data-testid="pending-requests">
          <h2>待批准 <span className="card-count">{requests.length} 份</span></h2>
          <table className="table record-table">
            <tbody>
              {requests.flatMap((request) => {
                const expanded = open === request.id;
                return [
                  <tr key={request.id} data-testid="request-row" data-id={request.id} data-kind={request.kind} data-subject={request.subject} className={expanded ? 'selected' : undefined}>
                    <td><button type="button" className="link-button" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : request.id)}>{requestTitle(request)}</button></td>
                    <td>{count(request)}</td>
                    <td className="muted">{request.requestedBy.label}</td>
                    <td className="muted">{time(request.requestedAt)}</td>
                    <td><span className="chip warn">待批准</span></td>
                  </tr>,
                  expanded && (
                    <tr key={`${request.id}-detail`} className="selected">
                      <td colSpan={5} className="field-detail">
                        <RequestDetail id={request.id} canDecide={props.canDecide} renderChanges={props.renderChanges}
                          onDecided={(text) => { setNotice(text); setOpen(undefined); loaded.reload(); props.onDecided?.(); }}
                          onStale={() => { loaded.reload(); props.onDecided?.(); }} />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}
