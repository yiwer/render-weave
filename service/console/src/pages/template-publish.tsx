/**
 * 发布模板修订（P1 票据 09，M265、M299、M352、M381，原型画板 12）：保存前看后果，保存后随时能回去。
 * - 版式同数据定义的发布页：左边是要同意的内容，右边一张确认卡写结论与发布按钮；
 * - 对比：当前修订与工作副本用同一份样例数据集各渲染一张；工作副本的预览换上全部工作副本，改子模板时看的是调用它的模板；
 * - 改动：当前修订到工作副本的结构化差异，按元素路径列出；
 * - 基准已变：显示两边差异，明确选择覆盖才保存（口径同 agent apply --overwrite）；
 * - 修订历史：修订号、主体、时间与来源，指回前确认；操作员只读。
 * 多份数据集的改动影响是 P3，接入前这一段不显示。
 */
import { useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { defaultOutput, defaultParameters } from '../components/parameters.js';
import { Icon, PUBLISH } from '../components/icon.js';
import { countText, ErrorBox, ProblemList } from '../components/problems.js';
import { PublishConfirm } from '../components/publish-confirm.js';
import { PendingRequests } from '../components/publish-requests.js';
import { changesSummary, RevisionChanges } from '../components/revision-changes.js';
import { templatePublishVerdict } from '../form/publish-verdict.js';
import { href, problemsOf, useLivePreview, useLoad, type LivePreview } from '../hooks.js';
import { documentInfo, parseTemplateText } from '../template/document.js';
import { calledTemplates } from '../template/tree.js';
import type { RevisionDiff, DatasetEntry, Identity, Problem, RevisionConflict, TemplateInfo, TemplateRevisions, WorkingCopyCheck } from '../types.js';
import { datasetRef, sameSchema } from './templates.js';
import { Loading } from '../components/motifs.js';

const AUDITED = '审计已记下主体与前后内容哈希。';
const SOURCE: Readonly<Record<string, string>> = { push: '推送', web: '网页' };
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
const shortSha = (sha256: string) => sha256.slice(0, 12);

/** 没有这个对象（没开工作副本、复制出来还没保存）时是 undefined，别的错误照常抛出。 */
const orMissing = async <T,>(request: Promise<T>): Promise<T | undefined> => {
  try { return await request; } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
};

/** 这一页要的全部内容：root 是渲染的模板，改子模板时它是调用子模板的模板，只有这样才有数据可看。 */
async function loadPublish(name: string, root: string) {
  const [copy, revisions, check, current, rootCopy, datasets, copies] = await Promise.all([
    orMissing(api.workingCopy(name)), orMissing(api.templateRevisions(name)), orMissing(api.checkWorkingCopy(name)),
    orMissing(api.template(root)), root === name ? Promise.resolve(undefined) : orMissing(api.workingCopy(root)), api.datasets(), api.workingCopies(),
  ]);
  const rootText = root === name ? copy?.content : rootCopy?.content;
  const workingInfo = rootText === undefined ? current : documentInfo(root, parseTemplateText(rootText));
  const base = workingInfo?.base ?? current?.base;
  // 调用的模板里还没发布的新模板（只有工作副本、没有修订）：检查只叠加这一个工作副本，它们算"没有"，要先发布。
  let document: ReturnType<typeof parseTemplateText> | undefined;
  try { document = copy ? parseTemplateText(copy.content) : undefined; } catch { document = undefined; }
  const fresh = new Set(copies.workingCopies.filter((item) => item.baseRevision === undefined).map((item) => item.name));
  const unpublished = document ? calledTemplates(name, (template) => (template === name ? document : undefined)).filter((template) => template !== name && fresh.has(template)) : [];
  return { copy, revisions, check, current, workingInfo, unpublished, datasets: datasets.datasets.filter((entry) => sameSchema(entry.staticSchema, base)) };
}

export function TemplatePublish(props: { readonly name: string; readonly root?: string; readonly identity: Identity }) {
  const { name, identity } = props, root = props.root ?? name, canPublish = identity.role === 'admin';
  const loaded = useLoad(() => loadPublish(name, root), `${name}\n${root}`);
  const [notice, setNotice] = useState<string>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [conflict, setConflict] = useState<RevisionConflict>();
  const [busy, setBusy] = useState(false);
  const { data } = loaded;
  const design = href(['templates', name, 'design'], { in: props.root });

  /** 保存模板：有冲突时停在这里，把两边差异摆出来，由人选择覆盖。 */
  const publish = async (overwrite: boolean) => {
    if (!data?.check) return;
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    try {
      const saved = await api.saveWorkingCopy(name, data.check.sha256, overwrite);
      setConflict(undefined);
      setNotice(saved.status === 'saved'
        ? `已保存为修订 ${saved.revision}，工作副本已删除。${AUDITED}`
        : `内容与当前修订 ${saved.revision} 相同，没有记新修订，工作副本已删除。${AUDITED}`);
      loaded.reload();
    } catch (error) {
      const reply = error instanceof ApiError ? error.body?.['conflict'] as RevisionConflict | undefined : undefined;
      if (reply) { setConflict(reply); loaded.reload(); } else setProblems(problemsOf(error));
    } finally { setBusy(false); }
  };
  const pointBack = async (revision: number) => {
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    try {
      await api.setCurrentTemplate(name, revision);
      setNotice(`当前修订已指回修订 ${revision}，出图从现在起读它。${AUDITED}`);
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const discard = async () => {
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    try {
      await api.discardWorkingCopy(name);
      setConflict(undefined);
      setNotice('工作副本已丢弃，当前修订不受影响。');
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };

  const check = data?.check, shownConflict = conflict ?? check?.conflict;
  const severe = check?.problems.filter((problem) => problem.level === 'severe').length ?? 0;
  const nextRevision = data?.revisions ? Math.max(...data.revisions.revisions.map((revision) => revision.revision)) + 1 : 1;
  const unchanged = check?.changes.status === 'unchanged';
  const history = data?.revisions && <History key={String(Boolean(check))} revisions={data.revisions} open={!check} canPublish={canPublish} busy={busy} onPointBack={(revision) => void pointBack(revision)} />;
  return (
    <section className="page publish-page">
      <nav className="crumbs" aria-label="位置">
        <a href={href(['templates'])}>模板</a><span aria-hidden="true">/</span>
        <a href={href(['templates', name])}>{name}</a><span aria-hidden="true">/</span>
        <span>{check ? '发布修订' : '修订历史'}</span>
      </nav>
      <div className="title-row">
        <div>
          <h1>{check ? `发布修订 ${nextRevision}` : '修订历史'}</h1>
          {data && (
            <div className="meta">
              {data.revisions && <span data-testid="current-revision">当前修订 {data.revisions.currentRevision}</span>}
              {check && <span>工作副本基于修订 {check.baseRevision ?? '（无，新模板）'}</span>}
              {data.copy && <span>最后暂存 {data.copy.updatedBy} · {time(data.copy.updatedAt)}</span>}
              {!data.copy && <span>没有工作副本</span>}
            </div>
          )}
        </div>
        {canPublish && !check && <div className="actions"><a className="button quiet" href={design}>打开设计</a></div>}
      </div>
      {notice && <p className="notice" role="status">{notice}<a className="notice-link" href={href(['admin', 'audit'])}>看审计日志</a></p>}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到模板" />
      {loaded.loading && !data && <Loading />}
      <PendingRequests scope="templates" subject={name} canDecide={canPublish} onDecided={loaded.reload} refresh={`${data?.revisions?.currentRevision ?? ''}:${check?.sha256 ?? ''}`}
        renderChanges={(request) => (request.kind !== 'push' && request.changes ? <RevisionChanges diff={request.changes as RevisionDiff} label="这份申请的改动" empty="内容与当前修订相同。" /> : undefined)} />
      {check
        ? (
          <div className="publish-layout">
            <PublishConfirm busy={busy}
              verdict={templatePublishVerdict({
                severe, hints: check.problems.length - severe, status: check.changes.status, summary: changesSummary(check.changes), next: nextRevision,
                ...(shownConflict ? { conflict: shownConflict } : {}),
              })}
              {...(severe || shownConflict ? {} : { steps: { from: data?.revisions ? `修订 ${data.revisions.currentRevision}` : '新模板', to: `修订 ${nextRevision}` } })}>
              {canPublish && (
                <>
                  {!shownConflict && (
                    <button type="button" className="primary publish-button" disabled={busy || severe > 0 || unchanged} onClick={() => void publish(false)}>
                      <Icon d={PUBLISH} />{busy ? '正在保存…' : `发布为修订 ${nextRevision}`}
                    </button>
                  )}
                  <a className="button quiet" href={design}>回到设计</a>
                  <DiscardCopy busy={busy} onDiscard={() => void discard()} />
                  <p className="publish-note">发布后模板可以随时指回任一旧修订。</p>
                </>
              )}
            </PublishConfirm>
            <div className="publish-details">
              {data?.workingInfo && (
                <Compare key={`${root}\n${data.current?.currentRevision ?? 0}`} root={root} current={data.current} working={data.workingInfo}
                  datasets={data.datasets} currentRevision={data.revisions?.currentRevision} version={check.sha256} />
              )}
              <Changes check={check} unpublished={data?.unpublished ?? []} />
              {shownConflict && <Conflict conflict={shownConflict} canPublish={canPublish} busy={busy || severe > 0} onOverwrite={() => void publish(true)} />}
              {history}
            </div>
          </div>
        )
        : history}
      {data && !data.revisions && !check && <p className="muted">这个模板还没有修订。</p>}
    </section>
  );
}

/** 一张对比图：图片加一行说明；问题清单在页面下方，这里只说多少个。 */
function CompareFigure(props: { readonly testid: string; readonly title: string; readonly preview: LivePreview }) {
  const { preview } = props, { reply, loading, waiting } = preview, image = reply?.image;
  return (
    <figure className="revision-figure" data-testid={props.testid} aria-busy={loading}>
      <div className={`thumbnail${loading ? ' busy' : ''}`}>
        {image ? <img src={`data:image/${image.format};base64,${image.base64}`} alt={`${props.title}的草稿预览`} />
          : <span className="muted">{waiting ? '预览太频繁，稍后自动重试…' : loading ? '正在出草稿预览…' : reply ? '无法展开，没有图片' : '还没有预览'}</span>}
      </div>
      <figcaption><strong>{props.title}</strong>{reply && <span className="muted"> · {countText(reply.problems)}</span>}</figcaption>
      <ErrorBox problems={preview.problems} title="预览失败" />
    </figure>
  );
}

function Compare(props: {
  readonly root: string; readonly current?: TemplateInfo; readonly working: TemplateInfo; readonly datasets: readonly DatasetEntry[];
  readonly currentRevision?: number; readonly version: string;
}) {
  const { root, current, working, datasets } = props;
  const [datasetId, setDatasetId] = useState(datasets[0]?.id ?? '');
  const requestOf = (template: TemplateInfo) => (template.base
    ? { template: root, dataset: datasetRef(template.base, datasetId || undefined), parameters: defaultParameters(template), output: defaultOutput(template) } : undefined);
  const currentRequest = useMemo(() => (current ? requestOf(current) : undefined), [current, datasetId]);
  const workingRequest = useMemo(() => requestOf(working), [working, datasetId]);
  const before = useLivePreview(currentRequest, 200);
  const after = useLivePreview(workingRequest, 200, { workingCopies: true, version: props.version });
  return (
    <section className="publish-section">
      <div className="card-head">
        <h2>改前改后</h2>
        <div className="field inline-field">
          <label htmlFor="publish-dataset">样例数据集</label>
          <select id="publish-dataset" value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
            {datasets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ? `${entry.name}（${entry.id}）` : entry.id}</option>)}
            <option value="">空白数据（显示占位）</option>
          </select>
        </div>
      </div>
      <div className="revision-compare">
        {current && <CompareFigure testid="compare-current" title={props.currentRevision === undefined ? '当前修订' : `修订 ${props.currentRevision} · 当前`} preview={before} />}
        <CompareFigure testid="compare-working-copy" title="工作副本" preview={after} />
      </div>
    </section>
  );
}

/** 丢弃工作副本要确认一次：丢了就没了。 */
function DiscardCopy(props: { readonly busy: boolean; readonly onDiscard: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming
    ? <span className="confirm publish-discard">丢弃后这些改动就没了。<button type="button" className="small danger" disabled={props.busy} onClick={props.onDiscard}>确认丢弃</button><button type="button" className="small quiet" onClick={() => setConfirming(false)}>取消</button></span>
    : <button type="button" className="link publish-discard" onClick={() => setConfirming(true)}>丢弃工作副本</button>;
}

function Changes(props: { readonly check: WorkingCopyCheck; readonly unpublished: readonly string[] }) {
  const { check, unpublished } = props;
  const missing = unpublished.length > 0 && check.problems.some((problem) => problem.code === 'input.templateNotFound');
  return (
    <>
      <section className="publish-section">
        <h2>改动 <span className="card-count" data-testid="changes-summary">{changesSummary(check.changes)}</span></h2>
        <div className="publish-sheet"><RevisionChanges diff={check.changes} label="当前修订到工作副本的改动" empty="工作副本与当前修订没有差别，不用发布。" /></div>
      </section>
      {check.problems.length > 0 && (
        <section className="publish-section">
          <h2>静态检查</h2>
          <div className="publish-sheet"><ProblemList problems={check.problems} label="模板静态检查的问题" /></div>
          {missing && (
            <p className="hint" data-testid="publish-callees-first">
              {unpublished.map((template, index) => <span key={template}>{index > 0 && '、'}<a href={href(['templates', template, 'publish'])}>「{template}」</a></span>)}
              是这里调用的新模板，还没发布：发布时只认已发布的被调模板，先发布{unpublished.length > 1 ? '它们' : '它'}，再回来发布这个模板。
            </p>
          )}
          {check.problems.some((problem) => problem.level === 'severe' && !(missing && problem.code === 'input.templateNotFound')) && <p className="hint">有严重问题，改好之后才能发布。</p>}
        </section>
      )}
    </>
  );
}

/** 基准已变：别人先保存了新修订。两边差异并排摆出来，勾选之后才给覆盖按钮。 */
function Conflict(props: { readonly conflict: RevisionConflict; readonly canPublish: boolean; readonly busy: boolean; readonly onOverwrite: () => void }) {
  const { conflict } = props;
  const [understood, setUnderstood] = useState(false);
  return (
    <div className="publish-section conflict" data-testid="revision-conflict" role="group" aria-label="基准已变">
      <div className="card-head">
        <h2>基准已变</h2>
        <span className="chip warn">工作副本基于修订 {conflict.baseRevision ?? '（无）'}，当前修订已是 {conflict.currentRevision}</span>
      </div>
      <div className="conflict-sides">
        <div data-testid="conflict-ours">
          <h3 className="subhead">这边改的（基准到工作副本）</h3>
          <div className="publish-sheet"><RevisionChanges diff={conflict.ours} label="这边改的" /></div>
        </div>
        <div data-testid="conflict-theirs">
          <h3 className="subhead">别人改的（基准到修订 {conflict.currentRevision}）</h3>
          <div className="publish-sheet"><RevisionChanges diff={conflict.theirs} label="别人改的" /></div>
        </div>
      </div>
      {props.canPublish && (
        <div className="actions">
          <label className="check-line">
            <input type="checkbox" checked={understood} onChange={(event) => setUnderstood(event.target.checked)} />
            看过两边差异，用工作副本盖过别人的改动
          </label>
          <button type="button" className="danger" disabled={!understood || props.busy} onClick={props.onOverwrite}>覆盖并发布</button>
        </div>
      )}
    </div>
  );
}

function History(props: { readonly revisions: TemplateRevisions; readonly open: boolean; readonly canPublish: boolean; readonly busy: boolean; readonly onPointBack: (revision: number) => void }) {
  const { revisions } = props;
  const [confirming, setConfirming] = useState<number>();
  const rows = [...revisions.revisions].reverse();
  return (
    <details className="card history" open={props.open} data-testid="revision-history">
      <summary><h2>修订历史</h2><span className="card-count">模板可以随时指回任一旧修订</span></summary>
      <div className="publish-sheet">
      <table className="table">
        <thead><tr><th>修订</th><th>主体</th><th>时间</th><th>来源</th><th>内容哈希</th><th><span className="visually-hidden">操作</span></th></tr></thead>
        <tbody>
          {rows.map((revision) => {
            const isCurrent = revision.revision === revisions.currentRevision;
            return (
              <tr key={revision.revision} data-testid="revision-row" data-revision={revision.revision} data-current={isCurrent}>
                <td>
                  修订 {revision.revision}
                  {isCurrent && <span className="chip ok current-chip">当前</span>}
                  {isCurrent && revisions.current?.action === 'setCurrent' && <div className="small muted">{revisions.current.by} 于 {time(revisions.current.at)} 指回</div>}
                </td>
                <td>{revision.pushedBy}</td>
                <td>{time(revision.createdAt)}</td>
                <td>{SOURCE[revision.source] ?? revision.source}</td>
                <td className="mono" title={revision.sha256}>{shortSha(revision.sha256)}</td>
                <td className="row-actions">
                  {props.canPublish && !isCurrent && (confirming === revision.revision
                    ? <><button type="button" className="small danger" disabled={props.busy} onClick={() => { setConfirming(undefined); props.onPointBack(revision.revision); }}>确认指回</button><button type="button" className="small quiet" onClick={() => setConfirming(undefined)}>取消</button></>
                    : <button type="button" className="small quiet" onClick={() => setConfirming(revision.revision)}>指回</button>)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </details>
  );
}
