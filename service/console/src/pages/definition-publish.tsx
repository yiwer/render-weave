/**
 * 数据定义的发布与发布记录（P1 票据 06，M346、M355，原型画板 08）。
 * - 发布：先看字段级差异与预检结果（失配的数据集、未全部核对、仍绑定旧版的模板），确认后发布为下一版本；
 * - 发布记录：谁在何时发布了哪一版、改动摘要、内容哈希；选中一行原地展开差异；操作员只读；
 * - 以某一版另发：页面上一键，接口上是两步——从旧版另起草案，再发布成新版本（ADR-0008、M346）。
 * - 待处理：还没发布的草案，以及代建工程师的发布申请（P1 票据 11）。
 * 只调开放 API。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { StaticSchemaTabs } from '../components/module-tabs.js';
import { ErrorBox } from '../components/problems.js';
import { PendingRequests } from '../components/publish-requests.js';
import { constraintText, isRequired, propertyText, typeText } from '../form/definition.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { DefinitionDiff, DefinitionFieldChange, DefinitionPublication, DefinitionPublishCheck, Identity, Problem } from '../types.js';
import { canEditDefinitions, definitionPath, exportCompiled, staticSchemaPath } from './definitions.js';

const number = (value: number) => value.toLocaleString('zh-CN');
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
/** 内容哈希只显示开头，悬停看全文。 */
const Hash = (props: { readonly value: string; readonly label?: string }) =>
  <code className="hash" title={props.value} data-sha256={props.value}>{props.label ?? 'sha256'}:{props.value.slice(0, 12)}…</code>;

const MARK: Readonly<Record<DefinitionFieldChange['change'], string>> = { added: '+', removed: '−', changed: '~' };

function changeText(change: DefinitionFieldChange): string {
  if (change.change === 'added' && change.after) {
    const constraints = constraintText(change.after);
    return `新增${isRequired(change.after) ? '必填' : ''}字段 ${change.after.displayName}，${typeText(change.after)}${constraints ? `，${constraints}` : ''}`;
  }
  if (change.change === 'removed') return `删除字段 ${change.before?.displayName ?? change.path}${change.affectsBindings ? '；按这个名称写的模板绑定和数据集的键不再有对应' : ''}`;
  return (change.properties ?? []).map(propertyText).join('；');
}

/** 字段级差异：一行一个字段，增删改用符号。 */
function DiffList(props: { readonly diff: DefinitionDiff }) {
  const { diff } = props;
  if (!diff.definition.length && !diff.fields.length && !diff.order) return <p className="muted" data-testid="definition-diff">没有字段改动。</p>;
  return (
    <ul className="diff-list" data-testid="definition-diff">
      {diff.definition.map((property) => <li key={property.key} data-path={`definition:${property.key}`} data-change="changed"><span className="diff-mark">~</span><span>数据定义的{propertyText(property)}</span></li>)}
      {diff.fields.map((change) => (
        <li key={change.path} data-path={change.path} data-change={change.change}>
          <span className={`diff-mark ${change.change}`}>{MARK[change.change]}</span><code>{change.path}</code><span>{changeText(change)}</span>
        </li>
      ))}
      {diff.order && <li data-path="definition:fieldOrder" data-change="changed"><span className="diff-mark">~</span><span>调整了字段顺序</span></li>}
    </ul>
  );
}

/** 数据集影响：会失配多少份、核对了多少份；发布不改动它们（ADR-0008）。 */
function DatasetImpact(props: { readonly check: DefinitionPublishCheck }) {
  const { check } = props, datasets = check.datasets!, base = check.baseVersion === undefined ? undefined : `v${check.baseVersion}`;
  return (
    <section className="card" data-testid="dataset-impact">
      <h2>数据集</h2>
      {base === undefined ? <p className="muted">这是首个版本，还没有数据集绑定。</p>
        : datasets.total === 0 ? <p className="muted">没有数据集绑定 {base}。</p>
        : (
          <>
            {!datasets.complete && (
              <p className="impact-note" data-testid="datasets-incomplete">
                <strong>未全部核对：</strong>绑定 {base} 的数据集共 {number(datasets.total)} 份，这次只校验了前 {number(datasets.checked)} 份。下面的份数只算校验过的。
              </p>
            )}
            <p data-testid="datasets-verdict">
              {datasets.complete ? `绑定 ${base} 的 ${number(datasets.total)} 份数据集全部核对：` : '校验过的这些里，'}
              {datasets.mismatched > 0 ? <strong className="bad-text">{number(datasets.mismatched)} 份按新版会失配</strong> : '都能按新版通过校验'}。
            </p>
            {datasets.samples.length > 0 && (
              <table className="table" data-testid="dataset-samples">
                <thead><tr><th>数据集</th><th>严重问题</th><th>比如</th></tr></thead>
                <tbody>
                  {datasets.samples.map((sample) => (
                    <tr key={sample.id} data-id={sample.id}>
                      <td className="mono"><a href={href(['datasets', sample.id])}>{sample.id}</a></td>
                      <td>{number(sample.problemCount)} 个</td>
                      <td>{sample.problems[0]?.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {datasets.mismatched > datasets.samples.length && <p className="table-note">只列前 {number(datasets.samples.length)} 份。</p>}
            <p className="small muted">发布不改动它们：这些数据集继续按 {base} 校验和出图，要用新版时再逐份改。</p>
          </>
        )}
    </section>
  );
}

/** 发布这一步：先看后果，再发布为下一版本。有严重问题时只有问题，发布也会同样拒绝。 */
export function DefinitionPublish(props: { readonly name: string; readonly identity: Identity }) {
  const { name } = props;
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(async () => {
    if (!canEdit) return undefined;
    const draft = await api.definitionDraft(name);
    return { draft, check: await api.publishCheckDefinitionDraft(name, draft.sha256) };
  }, `publish-check:${name}`);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const check = loaded.data?.check;
  const publish = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const published = await api.publishDefinitionDraft(name, check!.sha256);
      go(['definition-publications'], { name, version: String(published.version) });
    } catch (error) {
      setProblems(problemsOf(error));
      // 草案刚被改过时重新预检：看到的一定是要发布的这一份。
      loaded.reload();
    } finally { setBusy(false); }
  };
  return (
    <section className="page">
      <nav className="crumbs" aria-label="位置">
        <a href={href(['definitions'])}>数据定义</a><span aria-hidden="true">/</span><a href={href(definitionPath(name))}>{name}</a><span aria-hidden="true">/</span><span>发布</span>
      </nav>
      <div className="title-row">
        <div>
          <h1>{check?.version ? `发布为 ${name} v${check.version}` : `发布 ${name}`}</h1>
          {check && (
            <p className="meta" data-testid="publish-meta">
              <span>{check.baseVersion === undefined ? '首个版本' : `基于 v${check.baseVersion}`}</span>
              <Hash value={check.sha256} />
            </p>
          )}
        </div>
        {check?.version && (
          <div className="actions">
            <a className="button quiet" href={href(definitionPath(name))}>回到草案</a>
            <button type="button" className="primary" disabled={busy || loaded.loading} onClick={() => void publish()}>{busy ? '正在发布…' : `发布为 v${check.version}`}</button>
          </div>
        )}
      </div>
      {!canEdit && <p className="muted">发布由客户管理员完成。<a href={href(definitionPath(name))}>回到数据定义</a></p>}
      <ErrorBox problems={problems} title="没有发布" />
      <ErrorBox problems={loaded.problems} title="读不到预检结果" />
      {loaded.loading && !check && canEdit && <p className="muted">正在预检：比较字段、核对绑定的数据集…</p>}
      {check && !check.version && (
        <>
          <ErrorBox problems={check.problems} title="有严重问题，不能发布" />
          <p><a href={href(definitionPath(name))}>回到草案改正</a></p>
        </>
      )}
      {check?.version && (
        <>
          <section className="card">
            <h2>{check.baseVersion === undefined ? '字段' : `与 v${check.baseVersion} 相比`}</h2>
            <DiffList diff={check.diff!} />
          </section>
          <DatasetImpact check={check} />
          <section className="card" data-testid="template-impact">
            <h2>模板</h2>
            {check.templates!.length === 0 ? <p className="muted">还没有模板用这个数据定义。</p> : (
              <>
                <ul className="plain impact">
                  {check.templates!.map((template) => <li key={template.name} data-name={template.name}><a href={href(['templates', template.name])}>{template.name}</a><span className="muted">（绑定 v{template.base.version}）</span></li>)}
                </ul>
                <p className="small muted">发布不改动它们，它们照旧绑定各自的版本。</p>
              </>
            )}
          </section>
        </>
      )}
      <p className="table-note">每次发布产生一个新版本，旧版本不变；要回退，就在发布记录里把旧版本再发布一次。</p>
    </section>
  );
}

/** 改动摘要：一句话，展开看逐字段的差异。 */
function summaryText(publication: DefinitionPublication): string {
  const { diff, baseVersion, version } = publication;
  if (baseVersion === undefined) return `首个版本，${number(diff.fields.length)} 个字段`;
  if (!diff.fields.length && !diff.definition.length && !diff.order) return baseVersion === version - 1 ? '没有改动' : `以 v${baseVersion} 的内容另发`;
  const names = (change: DefinitionFieldChange['change']) => diff.fields.filter((field) => field.change === change).map((field) => field.path);
  const part = (label: string, list: readonly string[]) => (list.length ? `${label} ${list.slice(0, 3).join('、')}${list.length > 3 ? ` 等 ${list.length} 个` : ''}` : undefined);
  return [
    part('新增', names('added')), part('修改', names('changed')), part('删除', names('removed')),
    diff.definition.length ? '改数据定义的属性' : undefined, diff.order ? '调整字段顺序' : undefined,
  ].filter(Boolean).join(' · ');
}

const SOURCE: Readonly<Record<NonNullable<DefinitionPublication['source']>, string>> = { web: '网页与接口', push: '推送' };

/** 发布记录。地址里的 name 只看一个名称，version 打开时展开那一版。 */
export function DefinitionRecords(props: { readonly identity: Identity; readonly query: URLSearchParams }) {
  const canEdit = canEditDefinitions(props.identity);
  const name = props.query.get('name') ?? undefined, version = props.query.get('version') ?? undefined;
  const loaded = useLoad(async () => {
    const [publications, definitions] = await Promise.all([api.definitionPublications(name), api.definitions()]);
    return { publications: publications.publications, definitions: definitions.definitions };
  }, `definition-publications:${name ?? ''}`);
  const [open, setOpen] = useState(name && version ? `${name}@${version}` : undefined);
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [notice, setNotice] = useState<string>();
  const data = loaded.data;
  const latest = new Map<string, number>();
  for (const item of data?.publications ?? []) latest.set(item.name, Math.max(latest.get(item.name) ?? 0, item.version));
  const drafts = (data?.definitions ?? []).filter((definition) => definition.draft && (!name || definition.name === name));
  const republish = async (publication: DefinitionPublication) => {
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    setConfirming(undefined);
    try {
      const draft = await api.createDefinitionDraft(publication.name, { fromVersion: publication.version });
      const published = await api.publishDefinitionDraft(publication.name, draft.sha256);
      setNotice(`已把 ${publication.name} v${publication.version} 的内容发布为 v${published.version}`);
      setOpen(`${publication.name}@${published.version}`);
      loaded.reload();
    } catch (error) {
      setProblems(problemsOf(error));
      loaded.reload();
    } finally { setBusy(false); }
  };
  return (
    <section className="page">
      <div className="title-row"><h1>静态数据定义</h1></div>
      <StaticSchemaTabs active="publications" />
      {name && <p className="small muted" data-testid="records-filter">只看 {name} 的发布记录。<a href={href(['definition-publications'])}>看全部</a></p>}
      {notice && <p className="status" role="status">{notice}</p>}
      <ErrorBox problems={problems} title="没有另发" />
      <ErrorBox problems={loaded.problems} title="读不到发布记录" />
      {loaded.loading && !data && <p className="muted">正在读取…</p>}
      <PendingRequests scope="definitions" subject={name} canDecide={canEdit} onDecided={loaded.reload} refresh={data?.publications.length}
        renderChanges={(request) => (request.kind === 'definitionPublish' && request.changes ? <DiffList diff={request.changes as DefinitionDiff} /> : undefined)} />
      {drafts.length > 0 && (
        <section className="card">
          <h2>还没发布的草案</h2>
          <table className="table record-table">
            <tbody>
              {drafts.map((definition) => (
                <tr key={definition.name} data-testid="draft-row" data-name={definition.name}>
                  <td><a className="row-link" href={href(definitionPath(definition.name))}>{definition.displayName}</a></td>
                  <td>{definition.draft!.baseVersion ? `基于 v${definition.draft!.baseVersion}` : '还没发布过'}</td>
                  <td className="muted">{definition.draft!.updatedBy} 保存于 {time(definition.draft!.updatedAt)}</td>
                  <td><span className="chip accent">草案</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data && (
        <section className="card">
          <h2>已发布</h2>
          <table className="table record-table">
            <thead><tr><th>版本</th><th>改动摘要</th><th>谁</th><th>时间</th><th>状态</th></tr></thead>
            <tbody>
              {data.publications.length === 0 && <tr><td colSpan={5} className="muted">还没有发布记录。</td></tr>}
              {data.publications.flatMap((publication) => {
                const key = `${publication.name}@${publication.version}`, expanded = open === key, current = latest.get(publication.name) === publication.version;
                return [
                  <tr key={key} data-testid="publication-row" data-name={publication.name} data-version={publication.version} className={expanded ? 'selected' : undefined}>
                    <td>
                      <button type="button" className="link-button" aria-expanded={expanded} onClick={() => { setOpen(expanded ? undefined : key); setConfirming(undefined); }}>{publication.displayName}</button>
                      <span className="muted"> v{publication.version}</span>
                    </td>
                    <td data-testid="publication-summary">{summaryText(publication)}</td>
                    <td data-testid="publication-actor">{publication.actor?.label ?? <span className="muted">没有记录</span>}</td>
                    <td>{publication.at ? time(publication.at) : <span className="muted">没有记录</span>}</td>
                    <td><span className={current ? 'chip ok' : 'chip'}>{current ? '当前版本' : '已发布'}</span></td>
                  </tr>,
                  expanded && (
                    <tr key={`${key}-detail`} className="selected">
                      <td colSpan={5} className="field-detail" data-testid="publication-detail">
                        <DiffList diff={publication.diff} />
                        <p className="meta" data-testid="publication-facts">
                          <span>{publication.baseVersion === undefined ? '首个版本' : `与 v${publication.baseVersion} 比较`}</span>
                          {publication.source ? <span>来源：{SOURCE[publication.source]}</span> : <span>审计里没有这一版的记录，不知道谁在何时发布</span>}
                          <span>内容哈希 <Hash value={publication.sha256} /></span>
                          {publication.baseSha256 && <span>基准 <Hash value={publication.baseSha256} /></span>}
                        </p>
                        <div className="actions">
                          <a className="button small quiet" href={href(staticSchemaPath(publication.name, publication.version))}>打开这一版</a>
                          <button type="button" className="small quiet" onClick={() => void exportCompiled(publication).catch((error: unknown) => setProblems(problemsOf(error)))}>导出编译产物</button>
                          {canEdit && !current && confirming !== key && <button type="button" className="small" disabled={busy} onClick={() => setConfirming(key)}>以这一版另发新版本</button>}
                        </div>
                        {canEdit && !current && confirming === key && (
                          <div className="impact-note" data-testid="republish-confirm">
                            <strong>把 v{publication.version} 的内容发布为新版本。</strong>
                            <span>旧版本都保持不变，模板与数据集照旧绑定各自的版本。{drafts.some((definition) => definition.name === publication.name) ? '这个名称已有草案，要先发布或删除它。' : ''}</span>
                            <div className="actions">
                              <button type="button" className="small" disabled={busy} onClick={() => void republish(publication)}>{busy ? '正在另发…' : `确认以 v${publication.version} 另发`}</button>
                              <button type="button" className="small quiet" onClick={() => setConfirming(undefined)}>取消</button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="table-note">每次发布产生一个新版本；要回退，就把旧版本的内容再发布一次。</p>
    </section>
  );
}
