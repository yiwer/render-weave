/**
 * 数据定义的编辑页（M360，参照旧 RenderWeave 的 Schema Studio）：左边是字段，表单与树状图两种看法；右边的检查器改选中的字段。
 * - 改动先留在页面的编辑会话里（form/definition-session.ts），可以撤销、重做、回到已保存；点"保存"（Ctrl+S）才写一次草案，保存就是一条审计（M347）；
 * - 每次保存之后重新校验，问题定位到字段（M351：先存再校验）；校验、编译预览与会影响绑定都以服务端为准；
 * - 改字段名称或删字段前，按"谁在用"提示会影响的模板；字段名称是身份，改名等于删一个、加一个（ADR-0005）；
 * - 有没保存的改动时，换页与关窗口都先问；操作员只读：看得到草案与校验结果，没有任何写入口。
 * 这个名称没有草案时去静态数据定义（static-schemas.tsx）。只调开放 API。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { versionLabel } from '../form/schema-version.js';
import { api, ApiError } from '../api.js';
import { CodePanel } from '../components/code-panel.js';
import { BindingImpact, FieldFacts, FieldSummary, fieldLabel, hasConstraints, TreeRoot, TypeFields, UsedBy, type UseMap } from '../components/definition-fields.js';
import { DefinitionMap } from '../components/definition-map.js';
import { Modal } from '../components/modal.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { fieldChange, FIELD_TYPES, ITEM_TYPES, itemsOfType, isRequired, problemsByField, withConstraint, withType } from '../form/definition.js';
import { appendField, copyField, fieldKinds, fieldsOf, isDirty, moveField, moveFieldTo, openSession, removeField, replaceField, sessionReducer } from '../form/definition-session.js';
import { go, guardNavigation, href, problemsOf, useLoad } from '../hooks.js';
import type { DefinitionDetail as Detail, DefinitionDocument, DefinitionDraft, DefinitionField, DefinitionItems, FieldType, Identity, Problem, SchemaRef, StaticSchemaSummary, SchemaVersion } from '../types.js';
import { canEditDefinitions, definitionPath, staticSchemaPath } from './definitions.js';
import { Loading, Seal, ThreadOrbit } from '../components/motifs.js';

const time = (at: string) => new Date(at).toLocaleString('zh-CN');
export const documentText = (document: DefinitionDocument) => `${JSON.stringify(document, null, 2)}\n`;

/**
 * 回退（ADR-0028）：把草案的内容换成某个静态版本的，进编辑页看过再发布。草案一直在，所以不是另起一份；
 * 没有草案（只经推送发布过）时才从这一版另起。草案现在的内容会被换掉，页面上要先确认。
 */
export async function restoreToDraft(name: string, version: SchemaVersion): Promise<void> {
  const detail = await api.definition(name);
  if (detail.draft) {
    const { definition } = await api.staticSchema(name, version);
    const { version: _version, ...rest } = definition;
    await api.saveDefinitionDraft(name, detail.draft.sha256, documentText(rest));
  } else await api.createDefinitionDraft(name, { fromVersion: version });
  go(definitionPath(name));
}
const typeName = (type: FieldType) => FIELD_TYPES.find((item) => item.type === type)?.label ?? type;

/** 编辑页的四种看法（M380）：两种改字段，两种看文档。 */
type StudioView = 'form' | 'tree' | 'dsl' | 'compiled';
const STUDIO_VIEWS: readonly (readonly [StudioView, string])[] = [['form', '表单'], ['tree', '树状图'], ['dsl', '数据定义 DSL'], ['compiled', '编译产物']];

/** 路由入口：有草案就编辑草案，没有就去最新的静态版本；地址里的 field 选中那个字段。 */
export function DefinitionDetail(props: { readonly name: string; readonly version?: string; readonly field?: string; readonly identity: Identity }) {
  const loaded = useLoad(() => api.definition(props.name), `definition:${props.name}`);
  const detail = loaded.data;
  const target = detail && (props.version ?? (detail.draft ? undefined : detail.versions.at(-1)?.version));
  useEffect(() => {
    // 换地址不留历史：后退回到来的地方，不会又被转过来。
    if (target !== undefined) location.replace(href(staticSchemaPath(props.name, target), { field: props.field }));
  }, [target, props.name, props.field]);
  if (detail?.draft && target === undefined) return <Studio key={detail.draft.createdAt} detail={detail} draft={detail.draft} field={props.field} canEdit={canEditDefinitions(props.identity)} onChanged={loaded.reload} />;
  return (
    <section className="page">
      <nav className="crumbs" aria-label="位置"><a href={href(['definitions'])}>数据定义</a><span aria-hidden="true">/</span><span>{props.name}</span></nav>
      <ErrorBox problems={loaded.problems} title="读不到这个数据定义" />
      {loaded.loading && <Loading />}
    </section>
  );
}

function Studio(props: { readonly detail: Detail; readonly draft: DefinitionDraft; readonly field: string | undefined; readonly canEdit: boolean; readonly onChanged: () => void }) {
  const loaded = useLoad(async () => {
    const reply = await api.definitionDraft(props.detail.name);
    return { info: reply as DefinitionDraft, document: JSON.parse(reply.content) as DefinitionDocument };
  }, `draft:${props.detail.name}`);
  if (!loaded.data) {
    return (
      <section className="page">
        <ErrorBox problems={loaded.problems} title="读不到草案" />
        {loaded.loading && <Loading />}
      </section>
    );
  }
  return <StudioEditor {...props} info={loaded.data.info} document={loaded.data.document} onReread={loaded.reload} />;
}

function StudioEditor(props: { readonly detail: Detail; readonly info: DefinitionDraft; readonly document: DefinitionDocument; readonly field: string | undefined; readonly canEdit: boolean; readonly onChanged: () => void; readonly onReread: () => void }) {
  const { detail, canEdit } = props, name = detail.name;
  const initial = fieldsOf(props.document)?.findIndex((field) => field.name === props.field) ?? -1;
  const [session, dispatch] = useReducer(sessionReducer, openSession(props.document, initial >= 0 ? initial : 0));
  const [info, setInfo] = useState(props.info);
  const check = useLoad(() => api.checkDefinitionDraft(name), `draft-check:${name}:${info.sha256}`);
  const baseVersion = info.baseVersion;
  const base = useLoad(async () => (baseVersion === undefined ? undefined : api.staticSchema(name, baseVersion)), `draft-base:${name}@${baseVersion ?? ''}`);
  const schemas = useLoad(() => api.staticSchemas(), 'static-schemas');
  const [view, setView] = useState<StudioView>('form');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [stale, setStale] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [discarding, setDiscarding] = useState(false);
  const [removing, setRemoving] = useState<number>();

  const document = session.document, fields = fieldsOf(document), dirty = isDirty(session);
  const baseFields = base.data ? fieldsOf(base.data.definition) : undefined;
  // 校验读的是存下来的内容：有没保存的改动时，它说的是上一次保存的样子。
  const verdict = check.data && check.data.sha256 === info.sha256 ? check.data : undefined;
  const located = verdict && !dirty && fields ? problemsByField(verdict.problems, fields) : undefined;
  const severe = verdict ? verdict.problems.filter((problem) => problem.level === 'severe').length : 0;
  const uses: UseMap = useMemo(() => new Map(detail.fieldUses.map((use) => [use.field, use.templates])), [detail.fieldUses]);
  const refs: readonly StaticSchemaSummary[] = schemas.data?.staticSchemas ?? [];
  const firstRef: SchemaRef | undefined = refs[0] && { name: refs[0].name, version: refs[0].version };
  const changes = fields && baseFields ? {
    added: fields.filter((field) => fieldChange(field, baseFields) === 'added').length,
    changed: fields.filter((field) => fieldChange(field, baseFields) === 'changed').length,
    removed: baseFields.filter((field) => !fields.some((candidate) => candidate.name === field.name)).length,
  } : undefined;

  /** 整份保存，带预期哈希；别人先保存了就停下，读回最新内容再改。 */
  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setBusy(true);
    setProblems(undefined);
    setNotice(undefined);
    try {
      const saved = await api.saveDefinitionDraft(name, info.sha256, documentText(document));
      setInfo(saved);
      dispatch({ type: 'saved', document });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.body?.['currentSha256']) setStale(true);
      setProblems(problemsOf(error));
      return false;
    } finally { setBusy(false); }
  };
  /** 保存之后再校验一次：有严重问题就留在这里看问题，没有才去发布页看后果。 */
  const publish = async () => {
    if (!(await save())) return;
    try {
      const fresh = await api.checkDefinitionDraft(name);
      if (fresh.problems.some((problem) => problem.level === 'severe')) {
        check.reload();
        setNotice('有严重问题，改正之后才能发布。');
        return;
      }
      leaving.current = true;
      go([...definitionPath(name), 'publish']);
    } catch (error) { setProblems(problemsOf(error)); }
  };
  const discard = async () => {
    setProblems(undefined);
    try {
      await api.deleteDefinitionDraft(name);
      leaving.current = true;
      props.onChanged();
      go(['definitions']);
    } catch (error) { setProblems(problemsOf(error)); }
  };
  const reread = () => {
    setStale(false);
    setProblems(undefined);
    props.onReread();
  };
  // 读回的内容到了：从头开始，没写入的改动不留。
  const opened = useRef(props.document);
  useEffect(() => {
    if (opened.current === props.document) return;
    opened.current = props.document;
    setInfo(props.info);
    dispatch({ type: 'load', document: props.document });
  }, [props.document, props.info]);

  // 有没保存的改动时，换页与关窗口都先问。保存、删除之后走开不用问。
  const leaving = useRef(false);
  useEffect(() => {
    if (!dirty) return undefined;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', unload);
    const release = guardNavigation(() => leaving.current || window.confirm('这份草案有没保存的改动，离开就丢了。确定离开？'));
    return () => { window.removeEventListener('beforeunload', unload); release(); };
  }, [dirty]);
  // 快捷键：Ctrl+S 随时能按；Ctrl+Z、Ctrl+Y 在输入框里留给输入框自己。
  const keys = useRef({ save, canEdit });
  keys.current = { save, canEdit };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !keys.current.canEdit) return;
      const key = event.key.toLowerCase(), editingText = (event.target as HTMLElement | null)?.closest?.('input, textarea, select');
      if (key === 's') { event.preventDefault(); void keys.current.save(); }
      else if (editingText) return;
      else if (key === 'z' && !event.shiftKey) { event.preventDefault(); dispatch({ type: 'undo' }); }
      else if (key === 'y' || (key === 'z' && event.shiftKey)) { event.preventDefault(); dispatch({ type: 'redo' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const edit = (next: DefinitionDocument, key?: string, selected?: number | undefined) =>
    dispatch({ type: 'edit', document: next, ...(key ? { key } : {}), ...(selected === undefined ? {} : { selected }) });
  const setProperty = (key: 'displayName' | 'description', value: string) => {
    const next: Record<string, unknown> = { ...document };
    if (value || key === 'displayName') next[key] = value;
    else delete next[key];
    edit(next as unknown as DefinitionDocument, `document:${key}`);
  };
  const selected = session.selected !== undefined && fields?.[session.selected] ? session.selected : undefined;
  /** 删字段（M379）：只有发布过或被模板读着才有后果，要先问；别的直接删，撤销就回来。 */
  const hasImpact = (fieldName: string) => Boolean(baseFields?.some((item) => item.name === fieldName)) || (uses.get(fieldName)?.length ?? 0) > 0;
  const removeAt = (index: number) => {
    setRemoving(undefined);
    const count = (fields?.length ?? 1) - 1;
    edit(removeField(document, index), undefined, count ? Math.min(index, count - 1) : undefined);
  };
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const visible = (fields ?? []).map((field, index) => ({ field, index }))
    .filter(({ field }) => !query || [field.name, field.displayName, field.description ?? '', typeName(field.type)].some((text) => text.toLocaleLowerCase('zh-CN').includes(query)));

  return (
    <section className="studio" aria-label={`数据定义 ${name}`}>
      <div className="studio-main">
        <nav className="crumbs" aria-label="位置"><a href={href(['definitions'])}>数据定义</a><span aria-hidden="true">/</span><span>{name}</span></nav>
        <div className="title-row">
          <div>
            <h1>{document.displayName || name}</h1>
            <p className="meta" data-testid="definition-meta">
              <span>草案 · {baseVersion === undefined ? '还没发布过' : <a href={href(staticSchemaPath(name, baseVersion))}>基于 {versionLabel(baseVersion)}</a>}</span>
              {changes && <span data-testid="draft-changes">新增 {changes.added}、修改 {changes.changed}、删除 {changes.removed}</span>}
              <span>{info.updatedBy} 保存于 {time(info.updatedAt)}</span>
            </p>
          </div>
          <div className="actions">
            <span role="status" data-testid="check-status">
              {dirty ? <span className="chip">保存之后校验</span>
                : !verdict ? (check.problems ? <span className="chip">没有校验</span> : <span className="loading small muted"><ThreadOrbit size={16} />正在校验…</span>)
                : severe > 0 ? <span className="chip bad">{severe} 个严重问题</span>
                : <span className="seal-status"><Seal />校验通过</span>}
            </span>
            {canEdit && <>
              <span className={dirty ? 'chip warn' : 'chip ok'} data-testid="save-status" role="status">{busy ? '正在保存…' : dirty ? '有没保存的改动' : '已保存'}</span>
              <button type="button" disabled={!dirty || busy} onClick={() => void save()} aria-keyshortcuts="Control+S">保存</button>
              <button type="button" className="primary" disabled={busy || (!dirty && (!verdict || severe > 0))} onClick={() => void publish()} title={!dirty && severe ? '有严重问题，改正之后才能发布' : undefined}>
                {dirty ? '保存并发布' : verdict?.version ? `发布为 ${versionLabel(verdict.version)}` : '发布'}
              </button>
            </>}
          </div>
        </div>
        {!canEdit && <p className="small muted" role="note">你可以查看草案，改动与发布由客户管理员完成。</p>}
        {stale && (
          <div className="impact-note" role="alert">
            <strong>别人刚保存过这份草案，你的改动没有写入。</strong>
            <div className="actions"><button type="button" className="small" onClick={reread}>读回最新内容</button></div>
          </div>
        )}
        {notice && <p className="impact-note" role="status">{notice}</p>}
        <ErrorBox problems={stale ? undefined : problems} title="没有保存" />

        {view === 'form' && <div className="studio-identity">
          <div className="field">
            <label htmlFor="definition-name">名称</label>
            <input id="definition-name" type="text" className="mono" value={name} readOnly />
          </div>
          <div className="field">
            <label htmlFor="definition-display-name">显示名称</label>
            <input id="definition-display-name" type="text" readOnly={!canEdit} value={document.displayName ?? ''} onChange={(event) => setProperty('displayName', event.target.value)} />
          </div>
          <div className="field wide">
            <label htmlFor="definition-description">说明</label>
            <input id="definition-description" type="text" readOnly={!canEdit} value={document.description ?? ''} onChange={(event) => setProperty('description', event.target.value)} />
          </div>
        </div>}

        {!fields && <p className="muted">这份草案还没写成字段列表，页面改不了；问题见下面，或用接口改。</p>}
        {fields && (
          <>
            <div className="studio-toolbar">
              <span className="segmented" role="group" aria-label="看法">
                {STUDIO_VIEWS.map(([value, label]) => <button key={value} type="button" className="small" aria-pressed={view === value} onClick={() => setView(value)}>{label}</button>)}
              </span>
              {canEdit && (
                <span className="studio-history" role="group" aria-label="编辑历史">
                  <button type="button" className="small quiet" disabled={!session.undo.length} onClick={() => dispatch({ type: 'undo' })} aria-keyshortcuts="Control+Z">撤销</button>
                  <button type="button" className="small quiet" disabled={!session.redo.length} onClick={() => dispatch({ type: 'redo' })} aria-keyshortcuts="Control+Y">重做</button>
                  <button type="button" className="small quiet" disabled={!dirty} onClick={() => dispatch({ type: 'restore' })}>回到已保存</button>
                </span>
              )}
              {(view === 'form' || view === 'tree') && <input type="search" className="studio-search" aria-label="搜索字段" placeholder="搜索字段、说明或类型" value={search} onChange={(event) => setSearch(event.target.value)} />}
              <span className="small muted studio-kinds" data-testid="field-kinds">{fields.length} 个字段{fields.length ? ` · ${fieldKinds(fields, typeName)}` : ''}</span>
            </div>
            {view === 'tree' && (
              <DefinitionMap name={name} document={document} selected={selected} onSelect={(index) => dispatch({ type: 'select', index })} visible={query ? new Set(visible.map(({ index }) => index)) : undefined}
                tagOf={(field) => fieldChange(field, baseFields)} problemsOf={(index) => located?.byIndex.get(index)}
                {...(canEdit ? {
                  onMove: (from: number, to: number) => { const next = moveFieldTo(document, from, to); if (next) edit(next, undefined, to); },
                  onAdd: () => edit(appendField(document), undefined, fields.length),
                } : {})} />
            )}
            {view === 'dsl' && (
              <>
                <p className="small muted studio-view-note">这是页面上现在的内容{dirty ? '，还有没保存的改动' : ''}。</p>
                <CodePanel testid="definition-dsl" value={document} file={`${name}-草案.json`} type="application/json" />
              </>
            )}
            {view === 'compiled' && (
              verdict?.compiled && !dirty
                ? <CodePanel testid="compiled-preview" value={verdict.compiled} file={`${name}-草案.schema.json`} type="application/schema+json" />
                : <p className="muted studio-view-note" role="status" data-testid="compiled-unavailable">{dirty ? '有没保存的改动：编译产物按存下来的内容算，保存之后才能看。' : verdict ? '改正严重问题之后才有编译产物。' : '正在编译…'}</p>
            )}
            {view === 'form' && (
              <section className="definition-tree" aria-label="字段">
                <TreeRoot name={name} document={document} />
                {visible.length === 0 && <p className="muted tree-empty">{fields.length ? '没有匹配的字段。' : canEdit ? '还没有字段，添加第一个。' : '还没有字段。'}</p>}
                <ol className="tree-branches">
                  {visible.map(({ field, index }) => (
                    <li key={index}>
                    <FieldRow field={field} index={index} total={fields.length} selected={selected === index} canEdit={canEdit} tag={fieldChange(field, baseFields)} problems={located?.byIndex.get(index)} checked={Boolean(located)}
                      onSelect={() => dispatch({ type: 'select', index })}
                      onRequired={(required) => edit(replaceField(document, index, withConstraint(field, 'required', required)))}
                      onCopy={() => edit(copyField(document, index), undefined, index + 1)}
                      onRemove={() => {
                        if (!hasImpact(field.name)) { removeAt(index); return; }
                        dispatch({ type: 'select', index });
                        setRemoving(index);
                      }}
                      onMove={(by) => { const next = moveField(document, index, by); if (next) edit(next, undefined, index + by); }} />
                    </li>
                  ))}
                </ol>
              </section>
            )}
            {canEdit && view === 'form' && <button type="button" className="studio-add" onClick={() => edit(appendField(document), undefined, fields.length)}>＋ 添加字段</button>}
          </>
        )}

        {verdict && !dirty && verdict.affectedBindings.length > 0 && (
          <section className="card" data-testid="affected-bindings">
            <h2>会影响绑定</h2>
            <p className="small muted">与 {versionLabel(baseVersion!)} 相比这些字段没有了，改字段名称等于删一个、加一个。下面的模板读这些字段；它们照旧绑定各自的版本，升到新版时要改绑定。</p>
            <ul className="plain impact">
              {verdict.affectedBindings.map((item) => <li key={item.field} data-field={item.field}><code>{item.field}</code>：<UsedBy templates={item.templates} /></li>)}
            </ul>
          </section>
        )}
        <div className="check-bar">
          <span className="actions">
            <button type="button" className="small quiet" disabled={check.loading || dirty} onClick={check.reload}>校验</button>
          </span>
          {canEdit && (discarding
            ? <span className="confirm small">删除这份草案？已发布的版本不受影响。<button type="button" className="small danger" onClick={() => void discard()}>确认删除草案</button><button type="button" className="small quiet" onClick={() => setDiscarding(false)}>取消</button></span>
            : <button type="button" className="link danger" onClick={() => setDiscarding(true)}>删除草案</button>)}
        </div>
        <ErrorBox problems={check.problems} title="校验没有完成" />
        {located && verdict && verdict.problems.length > 0 && (
          <section className="card" aria-label="校验问题">
            <ProblemList problems={verdict.problems} label="校验问题" onSelect={(problem) => {
              const index = [...located.byIndex].find(([, list]) => list.includes(problem))?.[0];
              if (index !== undefined) { setView('form'); dispatch({ type: 'select', index }); }
            }} />
          </section>
        )}
      </div>

      <aside className="studio-inspector" aria-label="字段检查器">
        {selected === undefined || !fields
          ? <p className="muted field-inspector-empty">选一个字段，在这里看它的详情。</p>
          : canEdit
            ? <FieldInspector key={`${selected}:${session.generation}`} field={fields[selected]!} index={selected} total={fields.length} baseFields={baseFields} uses={uses} refs={refs} firstRef={firstRef}
                removing={removing === selected}
                onChange={(field, key) => edit(replaceField(document, selected, field), `field:${selected}:${key}`)}
                onCopy={() => edit(copyField(document, selected), undefined, selected + 1)}
                hasImpact={hasImpact} onAskRemove={() => setRemoving(selected)} onKeep={() => setRemoving(undefined)} onRemove={() => removeAt(selected)} />
            : (
              <>
                <header className="field-inspector-head"><h2>{fieldLabel(fields[selected]!, selected)}</h2><code>/{fields[selected]!.name}</code></header>
                <FieldFacts field={fields[selected]!} uses={uses} />
              </>
            )}
      </aside>
    </section>
  );
}

/** 表单看法的一行：摘要加必填开关与几个小动作；只读时只有摘要。 */
function FieldRow(props: {
  readonly field: DefinitionField; readonly index: number; readonly total: number; readonly selected: boolean; readonly canEdit: boolean;
  readonly tag: 'added' | 'changed' | undefined; readonly problems: readonly Problem[] | undefined; readonly checked: boolean;
  readonly onSelect: () => void; readonly onRequired: (required: boolean) => void; readonly onCopy: () => void; readonly onRemove: () => void; readonly onMove: (by: -1 | 1) => void;
}) {
  const { field, index, selected, canEdit, problems } = props, label = fieldLabel(field, index), required = isRequired(field);
  return (
    <article className={`studio-row${selected ? ' selected' : ''}`} data-testid="field-row" data-field={field.name}>
      <button type="button" className="studio-row-main" aria-pressed={selected} aria-label={`${canEdit ? '编辑' : '查看'}字段 ${label}`} onClick={props.onSelect}>
        <span className="tree-number">{String(index + 1).padStart(2, '0')}</span>
        <FieldSummary field={field} index={index} tag={props.tag}
          status={<span className="field-status" data-testid="field-status">{problems?.length ? <span className="bad-text">{problems.length} 个问题</span> : props.checked ? <span className="muted">有效</span> : null}</span>} />
      </button>
      {canEdit
        ? <button type="button" className={`required-toggle${required ? ' on' : ''}`} data-testid="field-required" aria-pressed={required} aria-label={`${label} ${required ? '必填' : '可选'}`} onClick={() => props.onRequired(!required)}>{required ? '必填' : '可选'}</button>
        : <span className={required ? 'chip ok' : 'chip'} data-testid="field-required">{required ? '必填' : '可选'}</span>}
      {canEdit && (
        <span className="studio-row-tools">
          <button type="button" className="icon" aria-label={`复制字段 ${label}`} title="复制" onClick={props.onCopy}>⧉</button>
          <button type="button" className="icon" aria-label={`删除字段 ${label}`} title="删除" onClick={props.onRemove}>✕</button>
          <button type="button" className="icon" aria-label={`上移字段 ${label}`} title="上移" disabled={index === 0} onClick={() => props.onMove(-1)}>↑</button>
          <button type="button" className="icon" aria-label={`下移字段 ${label}`} title="下移" disabled={index === props.total - 1} onClick={() => props.onMove(1)}>↓</button>
        </span>
      )}
      {problems && problems.length > 0 && <ul className="field-problems" data-testid="field-problems">{problems.map((problem, at) => <li key={at} className={problem.level}>{problem.message}</li>)}</ul>}
    </article>
  );
}

/** 检查器：选中字段的属性，加这种类型能写的约束（docs/dsl/data-definition.md）。 */
function FieldInspector(props: {
  readonly field: DefinitionField; readonly index: number; readonly total: number; readonly baseFields: readonly DefinitionField[] | undefined; readonly uses: UseMap;
  readonly refs: readonly StaticSchemaSummary[]; readonly firstRef: SchemaRef | undefined; readonly removing: boolean; readonly hasImpact: (name: string) => boolean;
  readonly onChange: (field: DefinitionField, key: string) => void; readonly onCopy: () => void; readonly onAskRemove: () => void; readonly onKeep: () => void; readonly onRemove: () => void;
}) {
  const { field: value, index, baseFields, uses, refs, firstRef, onChange } = props;
  // 打开这个字段时的名称：改名的提示跟它比。
  const [opened] = useState(value.name);
  const inBase = (name: string) => Boolean(baseFields?.some((item) => item.name === name));
  const renamed = opened && opened !== value.name && (inBase(opened) || (uses.get(opened)?.length ?? 0) > 0);
  const set = <K extends keyof DefinitionField>(key: K, part: DefinitionField[K] | undefined) => {
    const next: Record<string, unknown> = { ...value };
    if (part === undefined) delete next[key];
    else next[key] = part;
    onChange(next as unknown as DefinitionField, key);
  };
  return (
    <form className="field-editor" aria-label="编辑字段" onSubmit={(event) => event.preventDefault()}>
      <header className="field-inspector-head">
        <h2>{fieldLabel(value, index)}</h2>
        <code>/{value.name}</code>
        <span className="field-inspector-tools">
          <button type="button" className="link" onClick={props.onCopy}>复制</button>
          <button type="button" className="link danger" onClick={() => { if (props.hasImpact(opened || value.name)) props.onAskRemove(); else props.onRemove(); }}>删除字段</button>
        </span>
      </header>
      <div className="fields">
        <div className="field wide">
          <label htmlFor="field-name">字段名称</label>
          <input id="field-name" type="text" className="mono" spellCheck={false} placeholder="英文字母开头，如 operator" value={value.name} onChange={(event) => set('name', event.target.value)} />
        </div>
        <div className="field wide">
          <label htmlFor="field-display-name">显示名称</label>
          <input id="field-display-name" type="text" value={value.displayName} onChange={(event) => set('displayName', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="field-type">类型</label>
          <select id="field-type" value={value.type} onChange={(event) => onChange(withType(value, event.target.value as FieldType, firstRef), 'type')}>
            {FIELD_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
          </select>
        </div>
        <div className="field">
          <span className="field-label" id="field-required-label">必填状态</span>
          <span className="segmented" role="group" aria-labelledby="field-required-label">
            <button type="button" className="small" aria-pressed={!isRequired(value)} onClick={() => onChange(withConstraint(value, 'required', false), 'required')}>可选</button>
            <button type="button" className="small" aria-pressed={isRequired(value)} onClick={() => onChange(withConstraint(value, 'required', true), 'required')}>必填</button>
          </span>
        </div>
        <div className="field wide">
          <label htmlFor="field-description">说明</label>
          <textarea id="field-description" rows={2} value={value.description ?? ''} onChange={(event) => set('description', event.target.value || undefined)} />
        </div>
      </div>
      <h3 className="field-inspector-section"><span>{value.type === 'ref' ? '引用' : `${typeName(value.type)}约束`}</span>{hasConstraints(value.type) && <small>可选约束</small>}</h3>
      <div className="fields">
        <TypeFields owner={value} prefix="field" onChange={(owner) => onChange(owner, 'constraints')} refs={refs} />
        {value.type === 'list' && (
          <>
            <div className="field wide">
              <label htmlFor="item-type">元素类型</label>
              <select id="item-type" value={value.items?.type ?? 'text'} onChange={(event) => onChange({ ...value, items: itemsOfType(event.target.value as FieldType, firstRef) }, 'items')}>
                {ITEM_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
              </select>
            </div>
            <TypeFields owner={value.items ?? { type: 'text' }} prefix="item" label="元素" onChange={(items: DefinitionItems) => onChange({ ...value, items }, 'items')} refs={refs} />
          </>
        )}
      </div>
      <p className="field-used small"><span className="muted">谁在用：</span><span data-testid="field-used-by"><UsedBy templates={uses.get(opened || value.name)} /></span></p>
      {renamed && <BindingImpact kind="rename" field={opened} published={inBase(opened)} templates={uses.get(opened)} />}
      {props.removing && (
        <Modal title="删除字段" onClose={props.onKeep}>
          <BindingImpact kind="remove" field={opened || value.name || fieldLabel(value, index)} published={inBase(opened || value.name)} templates={uses.get(opened || value.name)} />
          <div className="modal-actions">
            <button type="button" className="quiet" onClick={props.onKeep}>留着</button>
            <button type="button" className="danger" onClick={props.onRemove}>确认删除字段</button>
          </div>
        </Modal>
      )}
    </form>
  );
}
