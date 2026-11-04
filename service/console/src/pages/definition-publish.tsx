/**
 * 数据定义的发布与发布记录（P1 票据 06，M346、M355、M365，原型画板 08）。
 * - 发布：左边是字段级差异与预检结果（失配的数据集、未全部核对、仍绑定旧版的模板），右边一张确认卡写结论与发布按钮；
 * - 发布记录：谁在何时发布了哪一版、改动摘要、内容哈希；选中一行原地展开差异；操作员只读；
 * - 回退：用旧版本的内容覆盖草案，进编辑页看过再发布（ADR-0028）。
 * - 待处理：代建工程师的发布申请（P1 票据 11）。
 * 只调开放 API。
 */
import { useState } from 'react';
import { parseVersion, versionLabel } from '../form/schema-version.js';
import { api } from '../api.js';
import { StaticSchemaTabs } from '../components/module-tabs.js';
import { Icon, PUBLISH } from '../components/icon.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { PublishConfirm } from '../components/publish-confirm.js';
import { PendingRequests } from '../components/publish-requests.js';
import { constraintText, isRequired, propertyParts, typeText } from '../form/definition.js';
import { publishVerdict } from '../form/publish-verdict.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { DefinitionDiff, DefinitionFieldChange, DefinitionProperty, DefinitionPublication, DefinitionPublishCheck, Identity, Problem } from '../types.js';
import { restoreToDraft } from './definition-studio.js';
import { canEditDefinitions, definitionPath, exportCompiled, staticSchemaPath } from './definitions.js';
import { Loading } from '../components/motifs.js';

const number = (value: number) => value.toLocaleString('zh-CN');
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
/** 内容哈希只显示开头，悬停看全文。 */
const Hash = (props: { readonly value: string; readonly label?: string }) =>
  <code className="hash" title={props.value} data-sha256={props.value}>{props.label ?? 'sha256'}:{props.value.slice(0, 12)}…</code>;

const isSevere = (problem: Problem) => problem.level === 'severe';
const MARK: Readonly<Record<DefinitionFieldChange['change'], string>> = { added: '+', removed: '−', changed: '~' };

function changeText(change: DefinitionFieldChange): string {
  if (change.change === 'added' && change.after) {
    const constraints = constraintText(change.after);
    return `新增${isRequired(change.after) ? '必填' : ''}字段 ${change.after.displayName}，${typeText(change.after)}${constraints ? `，${constraints}` : ''}`;
  }
  return `删除字段 ${change.before?.displayName ?? change.path}`;
}

/** 一条属性改动：旧值划掉，新值加重。 */
function PropertyChange(props: { readonly property: DefinitionProperty }) {
  const { label, before, after } = propertyParts(props.property);
  return <span className="diff-property">{label} <span className="diff-old">{before}</span> → <strong className="diff-new">{after}</strong></span>;
}

/** 字段级差异：一行一个字段，符号、路径、说明各成一列。 */
function DiffList(props: { readonly diff: DefinitionDiff }) {
  const { diff } = props;
  if (!diff.definition.length && !diff.fields.length && !diff.order) return <p className="muted publish-sheet-note" data-testid="definition-diff">没有字段改动。</p>;
  return (
    <ul className="diff-list" data-testid="definition-diff">
      {diff.definition.map((property) => (
        <li key={property.key} data-path={`definition:${property.key}`} data-change="changed">
          <span className="diff-mark changed">~</span><span className="diff-path">数据定义</span>
          <span className="diff-text"><PropertyChange property={property} /></span>
        </li>
      ))}
      {diff.fields.map((change) => (
        <li key={change.path} data-path={change.path} data-change={change.change}>
          <span className={`diff-mark ${change.change}`}>{MARK[change.change]}</span><code className="diff-path" title={change.path}>{change.path}</code>
          <span className="diff-text">
            {change.change === 'changed'
              ? (change.properties ?? []).map((property) => <PropertyChange key={property.key} property={property} />)
              : <span>{changeText(change)}</span>}
            {change.change === 'removed' && change.affectsBindings && <small className="diff-warning">按这个名称写的模板绑定和数据集的键不再有对应</small>}
          </span>
        </li>
      ))}
      {diff.order && (
        <li data-path="definition:fieldOrder" data-change="changed">
          <span className="diff-mark changed">~</span><span className="diff-path">字段顺序</span><span className="diff-text">调整了字段顺序</span>
        </li>
      )}
    </ul>
  );
}

/** 数据集影响：会失配多少份、核对了多少份；发布不改动它们（ADR-0008）。 */
function DatasetImpact(props: { readonly check: DefinitionPublishCheck }) {
  const { check } = props, datasets = check.datasets!, base = check.baseVersion === undefined ? undefined : `${versionLabel(check.baseVersion)}`;
  return (
    <section className="publish-section" data-testid="dataset-impact">
      <h2>数据集</h2>
      {base === undefined ? <div className="publish-sheet"><p className="muted publish-sheet-note">这是首个版本，还没有数据集绑定。</p></div>
        : datasets.total === 0 ? <div className="publish-sheet"><p className="muted publish-sheet-note">没有数据集绑定 {base}。</p></div>
        : (
          <>
            {!datasets.complete && (
              <p className="impact-note" data-testid="datasets-incomplete">
                <strong>未全部核对：</strong>绑定 {base} 的数据集共 {number(datasets.total)} 份，这次只校验了前 {number(datasets.checked)} 份。下面的份数只算校验过的。
              </p>
            )}
            <p className="publish-section-lead" data-testid="datasets-verdict">
              {datasets.complete ? `绑定 ${base} 的 ${number(datasets.total)} 份数据集全部核对：` : '校验过的这些里，'}
              {datasets.mismatched > 0 ? <strong className="bad-text">{number(datasets.mismatched)} 份按新版会失配</strong> : '都能按新版通过校验'}。
            </p>
            <div className="publish-sheet">
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
              <p className="publish-sheet-foot">
                {datasets.mismatched > datasets.samples.length && `只列前 ${number(datasets.samples.length)} 份。`}
                发布不改动它们：这些数据集继续按 {base} 校验和出图，要用新版时再逐份改。
              </p>
            </div>
          </>
        )}
    </section>
  );
}

/** 模板影响：谁绑定着哪一版；发布不改动它们。 */
function TemplateImpact(props: { readonly check: DefinitionPublishCheck }) {
  const templates = props.check.templates!;
  return (
    <section className="publish-section" data-testid="template-impact">
      <h2>模板</h2>
      <div className="publish-sheet">
        {templates.length === 0 ? <p className="muted publish-sheet-note">还没有模板用这个数据定义。</p> : (
          <>
            <ul className="plain publish-sheet-rows">
              {templates.map((template) => <li key={template.name} data-name={template.name}><a href={href(['templates', template.name])}>{template.name}</a><span className="version-badge">绑定 {versionLabel(template.base.version)}</span></li>)}
            </ul>
            <p className="publish-sheet-foot">发布不改动它们，它们照旧绑定各自的版本。</p>
          </>
        )}
      </div>
    </section>
  );
}

/** 发布这一步：先看后果，再发布为下一版本。有严重问题时只有问题，发布也会同样拒绝。 */
export function DefinitionPublish(props: { readonly name: string; readonly identity: Identity }) {
  const { name } = props;
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(async () => {
    if (!canEdit) return undefined;
    const [draft, detail] = await Promise.all([api.definitionDraft(name), api.definition(name)]);
    return { draft, taken: detail.versions.map((item) => item.version), check: await api.publishCheckDefinitionDraft(name, draft.sha256) };
  }, `publish-check:${name}`);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  /** 版本框里写的；没动过就是预检给的下一个编号。 */
  const [written, setWritten] = useState<string>();
  const [note, setNote] = useState('');
  const check = loaded.data?.check, draft = loaded.data?.draft;
  const text = written ?? (check?.version === undefined ? '' : versionLabel(check.version));
  const version = parseVersion(text), label = version === undefined ? undefined : versionLabel(version);
  const versionProblem = version === undefined ? '要以小写字母或数字开头，可以有点、下划线、连字符，最长 64 个字符'
    : loaded.data?.taken.includes(version) ? `已经发布过 ${label}，换一个` : undefined;
  const publish = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      const published = await api.publishDefinitionDraft(name, check!.sha256, { version: version!, ...(note.trim() ? { note: note.trim() } : {}) });
      go(['definition-publications'], { name, version: String(published.version) });
    } catch (error) {
      setProblems(problemsOf(error));
      // 草案刚被改过时重新预检：看到的一定是要发布的这一份。
      loaded.reload();
    } finally { setBusy(false); }
  };
  return (
    <section className="page publish-page">
      <nav className="crumbs" aria-label="位置">
        <a href={href(['definitions'])}>数据定义</a><span aria-hidden="true">/</span><a href={href(definitionPath(name))}>{name}</a><span aria-hidden="true">/</span><span>发布</span>
      </nav>
      <div className="title-row">
        <div>
          <h1>{check?.version && label ? `发布为 ${name} ${label}` : `发布 ${name}`}</h1>
          {check && (
            <p className="meta" data-testid="publish-meta">
              <span>{check.baseVersion === undefined ? '首个版本' : `基于 ${versionLabel(check.baseVersion)}`}</span>
              {draft && <span>{draft.updatedBy} 保存于 {time(draft.updatedAt)}</span>}
              <Hash value={check.sha256} />
            </p>
          )}
        </div>
      </div>
      {!canEdit && <p className="muted">发布由客户管理员完成。<a href={href(definitionPath(name))}>回到数据定义</a></p>}
      <ErrorBox problems={loaded.problems} title="读不到预检结果" />
      {loaded.loading && !check && canEdit && <Loading>正在预检：比较字段、核对绑定的数据集…</Loading>}
      {check && (
        <div className="publish-layout">
          <PublishConfirm verdict={publishVerdict(check, version)} busy={busy}
            {...(check.version === undefined ? {} : { steps: { from: check.baseVersion === undefined ? '草案' : `${versionLabel(check.baseVersion)}`, to: label ?? '？' } })}>
            <ErrorBox problems={problems} title="没有发布" />
            {check.version !== undefined
              ? (
                <>
                  <div className="field publish-field">
                    <label htmlFor="publish-version">版本</label>
                    <input id="publish-version" type="text" className="mono" spellCheck={false} maxLength={64} value={text} aria-invalid={Boolean(versionProblem)} aria-describedby="publish-version-hint" onChange={(event) => setWritten(event.target.value)} />
                    <span id="publish-version-hint" className={`hint${versionProblem ? ' bad-text' : ''}`} data-testid="publish-version-hint">{versionProblem ?? '缺省是下一个编号，也可以写 2026-08、v1.2 这样的字符串。'}</span>
                  </div>
                  <div className="field publish-field">
                    <label htmlFor="publish-note">发布说明（可选）</label>
                    <textarea id="publish-note" rows={2} maxLength={2000} value={note} onChange={(event) => setNote(event.target.value)} />
                  </div>
                  <button type="button" className="primary publish-button" disabled={busy || loaded.loading || Boolean(versionProblem)} onClick={() => void publish()}><Icon d={PUBLISH} />{busy ? '正在发布…' : label ? `发布为 ${label}` : '发布'}</button>
                  <a className="button quiet" href={href(definitionPath(name))}>回到草案</a>
                  <p className="publish-note">发布不影响数据定义，发布之后能接着改；已发布的版本不变。</p>
                </>
              )
              : <a className="button primary publish-button" href={href(definitionPath(name))}>回到草案改正</a>}
          </PublishConfirm>
          <div className="publish-details">
            {check.version === undefined
              ? (
                <section className="publish-section" role="alert" data-testid="publish-problems">
                  <h2>要先改正的问题</h2>
                  <div className="publish-sheet"><ProblemList problems={check.problems.filter(isSevere)} label="发布前要改正的问题" /></div>
                </section>
              )
              : (
                <>
                  <section className="publish-section" data-testid="publish-changes">
                    <h2>{check.baseVersion === undefined ? '字段' : `与 ${versionLabel(check.baseVersion)} 相比`}</h2>
                    <div className="publish-sheet"><DiffList diff={check.diff!} /></div>
                  </section>
                  <DatasetImpact check={check} />
                  <TemplateImpact check={check} />
                </>
              )}
            {check.problems.some((problem) => !isSevere(problem)) && (
              <section className="publish-section" data-testid="publish-hints">
                <h2>提示</h2>
                <div className="publish-sheet"><ProblemList problems={check.problems.filter((problem) => !isSevere(problem))} label="发布前的提示" /></div>
              </section>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** 改动摘要：一句话，展开看逐字段的差异。 */
function summaryText(publication: DefinitionPublication): string {
  const { diff, baseVersion } = publication;
  if (baseVersion === undefined) return `首个版本，${number(diff.fields.length)} 个字段`;
  if (!diff.fields.length && !diff.definition.length && !diff.order) return '没有改动';
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
  const data = loaded.data;
  // 字符串版本没有大小，最新的看发布的先后（ADR-0028）。
  const latest = new Map((data?.definitions ?? []).map((definition) => [definition.name, definition.versions.at(-1)?.version]));
  const hasDraft = (candidate: string) => (data?.definitions ?? []).some((definition) => definition.name === candidate && definition.draft);
  const restore = async (publication: DefinitionPublication) => {
    setBusy(true);
    setProblems(undefined);
    setConfirming(undefined);
    try { await restoreToDraft(publication.name, publication.version); } catch (error) {
      setProblems(problemsOf(error));
      loaded.reload();
    } finally { setBusy(false); }
  };
  return (
    <section className="page">
      <div className="title-row"><h1>静态数据定义</h1></div>
      <StaticSchemaTabs active="publications" />
      {name && <p className="small muted" data-testid="records-filter">只看 {name} 的发布记录。<a href={href(['definition-publications'])}>看全部</a> · <a href={href(definitionPath(name))}>回到这个数据定义</a></p>}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到发布记录" />
      {loaded.loading && !data && <Loading />}
      <PendingRequests scope="definitions" subject={name} canDecide={canEdit} onDecided={loaded.reload} refresh={data?.publications.length}
        renderChanges={(request) => (request.kind === 'definitionPublish' && request.changes ? <DiffList diff={request.changes as DefinitionDiff} /> : undefined)} />
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
                      <span className="muted"> {versionLabel(publication.version)}</span>
                    </td>
                    <td data-testid="publication-summary">{summaryText(publication)}</td>
                    <td data-testid="publication-actor">{publication.actor?.label ?? <span className="muted">没有记录</span>}</td>
                    <td>{publication.at ? time(publication.at) : <span className="muted">没有记录</span>}</td>
                    <td><span className={current ? 'chip ok' : 'chip'}>{current ? '当前版本' : '已发布'}</span></td>
                  </tr>,
                  expanded && (
                    <tr key={`${key}-detail`} className="selected">
                      <td colSpan={5} className="field-detail" data-testid="publication-detail">
                        {publication.note && <p className="publication-note" data-testid="publication-note">{publication.note}</p>}
                        <DiffList diff={publication.diff} />
                        <p className="meta" data-testid="publication-facts">
                          <span>{publication.baseVersion === undefined ? '首个版本' : `与 ${versionLabel(publication.baseVersion)} 比较`}</span>
                          {publication.source ? <span>来源：{SOURCE[publication.source]}</span> : <span>审计里没有这一版的记录，不知道谁在何时发布</span>}
                          <span>内容哈希 <Hash value={publication.sha256} /></span>
                          {publication.baseSha256 && <span>基准 <Hash value={publication.baseSha256} /></span>}
                        </p>
                        <div className="actions">
                          <a className="button small quiet" href={href(staticSchemaPath(publication.name, publication.version))}>打开这一版</a>
                          <button type="button" className="small quiet" onClick={() => void exportCompiled(publication).catch((error: unknown) => setProblems(problemsOf(error)))}>导出编译产物</button>
                          {canEdit && !current && confirming !== key && <button type="button" className="small" disabled={busy} onClick={() => setConfirming(key)}>{hasDraft(publication.name) ? '用这一版覆盖草案' : '从这一版另起草案'}</button>}
                        </div>
                        {canEdit && !current && confirming === key && (
                          <div className="impact-note" data-testid="restore-confirm">
                            <strong>{hasDraft(publication.name) ? `用 ${versionLabel(publication.version)} 的内容覆盖草案。` : `从 ${versionLabel(publication.version)} 另起草案。`}</strong>
                            <span>{hasDraft(publication.name) ? '草案现在的内容会被换掉，不能恢复；已发布的版本都不变。' : '已发布的版本都不变。'}进编辑页看过再发布。</span>
                            <div className="actions">
                              <button type="button" className="small" disabled={busy} onClick={() => void restore(publication)}>{busy ? '正在处理…' : hasDraft(publication.name) ? '确认覆盖草案' : '确认另起'}</button>
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
      <p className="table-note">每次发布产生一个新版本；要回退，就用旧版本的内容覆盖草案，再发布一次。</p>
    </section>
  );
}
