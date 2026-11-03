/**
 * 数据定义详情（P1 票据 06，M299，原型画板 07）：一张字段表，选中一行原地展开。草案能改，已发布的版本只读。
 * - 编辑只在这一行的表单里，点"保存字段"才写一次草案：保存就是一条审计（M347），不随打字保存；选另一行时先保存当前这行；
 * - 每次保存之后重新校验，问题定位到字段（M351：先存再校验）；校验、编译预览与会影响绑定都以服务端为准；
 * - 改字段名称或删字段前，按"谁在用"提示会影响的模板；字段名称是身份，改名等于删一个、加一个（ADR-0005）；
 * - 操作员只读：看得到草案与校验结果，没有任何写入口。
 * 只调开放 API。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ErrorBox, ProblemList } from '../components/problems.js';
import { canonical, constraintText, fieldChange, FIELD_TYPES, ITEM_TYPES, itemsOfType, isRequired, NEW_FIELD, problemsByField, typeText, withConstraint, withType } from '../form/definition.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { DefinitionDetail as Detail, DefinitionDocument, DefinitionDraft, DefinitionField, DefinitionItems, FieldType, Identity, Problem, SchemaRef, StaticSchemaSummary, TemplateBinding } from '../types.js';
import { canEditDefinitions, definitionPath, exportCompiled } from './definitions.js';

const time = (at: string) => new Date(at).toLocaleString('zh-CN');
const documentText = (document: DefinitionDocument) => `${JSON.stringify(document, null, 2)}\n`;
/** 还没写成字段列表的草案（接口上能存）：页面改不了，问题照样显示。 */
const fieldsOf = (document: DefinitionDocument): DefinitionField[] | undefined =>
  Array.isArray(document.fields) && document.fields.every((field) => typeof field === 'object' && field !== null) ? document.fields : undefined;

type UseMap = ReadonlyMap<string, readonly TemplateBinding[]>;
const useMapOf = (detail: Detail): UseMap => new Map(detail.fieldUses.map((use) => [use.field, use.templates]));

/** 路由入口：缺省看草案，没有草案看最新版本；地址里的 version 指定已发布的一版。 */
export function DefinitionDetail(props: { readonly name: string; readonly version?: string; readonly field?: string; readonly identity: Identity }) {
  const loaded = useLoad(() => api.definition(props.name), `definition:${props.name}`);
  const detail = loaded.data;
  const header = <nav className="crumbs" aria-label="位置"><a href={href(['definitions'])}>数据定义</a><span aria-hidden="true">/</span><span>{props.name}</span></nav>;
  if (!detail) {
    return (
      <section className="page">
        {header}
        <ErrorBox problems={loaded.problems} title="读不到这个数据定义" />
        {loaded.loading && <p className="muted">正在读取…</p>}
      </section>
    );
  }
  const version = props.version ? Number(props.version) : undefined;
  return (
    <section className="page">
      {header}
      {version === undefined && detail.draft
        ? <DraftView detail={detail} draft={detail.draft} field={props.field} canEdit={canEditDefinitions(props.identity)} onChanged={loaded.reload} />
        : <VersionView detail={detail} version={version ?? detail.versions.at(-1)?.version ?? 0} field={props.field} canEdit={canEditDefinitions(props.identity)} onChanged={loaded.reload} />}
    </section>
  );
}

/** 看哪一版：草案或已发布的版本。 */
function VersionPicker(props: { readonly detail: Detail; readonly value: number | 'draft' }) {
  const { detail } = props;
  return (
    <select aria-label="查看的版本" value={String(props.value)} onChange={(event) => go(definitionPath(detail.name), event.target.value === 'draft' ? {} : { version: event.target.value })}>
      {detail.draft && <option value="draft">草案（未发布）</option>}
      {[...detail.versions].reverse().map((item) => <option key={item.version} value={item.version}>v{item.version}{item === detail.versions.at(-1) ? ' · 当前' : ''}</option>)}
    </select>
  );
}

/** 谁在用：这个字段被哪些模板读到，可以点开模板。 */
function UsedBy(props: { readonly templates: readonly TemplateBinding[] | undefined }) {
  const templates = props.templates ?? [];
  if (!templates.length) return <>还没有模板读这个字段</>;
  return <>{templates.map((template, index) => <span key={template.name}>{index > 0 && '、'}<a href={href(['templates', template.name])}>{template.name}</a><span className="muted">（绑定 v{template.base.version}）</span></span>)}</>;
}

/** 字段表：显示名称、字段名称、类型、约束、必填与谁在用；选中的一行下面接一行展开内容。 */
function FieldTable(props: {
  readonly rows: readonly { readonly field: DefinitionField; readonly index: number; readonly tag?: 'added' | 'changed' | undefined; readonly problems?: readonly Problem[] | undefined }[];
  readonly uses: UseMap;
  readonly open: number | undefined;
  readonly onToggle: (index: number) => void;
  readonly detail: (index: number) => ReactNode;
  readonly empty: string;
}) {
  return (
    <div className="card">
      <table className="table field-table">
        <thead><tr><th>显示名称</th><th>字段名称</th><th>类型</th><th>约束</th><th>必填</th><th>谁在用</th></tr></thead>
        <tbody>
          {props.rows.length === 0 && <tr><td colSpan={6} className="muted">{props.empty}</td></tr>}
          {props.rows.flatMap(({ field, index, tag, problems }) => {
            const expanded = props.open === index, used = props.uses.get(field.name) ?? [];
            return [
              <tr key={index} data-testid="field-row" data-field={field.name} className={expanded ? 'selected' : undefined}>
                <td>
                  <button type="button" className="link-button" aria-expanded={expanded} onClick={() => props.onToggle(index)}>{field.displayName || '（还没有显示名称）'}</button>
                  {tag === 'added' && <span className="chip ok field-tag">新增</span>}
                  {tag === 'changed' && <span className="chip warn field-tag">已修改</span>}
                  {problems && <ul className="field-problems" data-testid="field-problems">{problems.map((problem, at) => <li key={at} className={problem.level}>{problem.message}</li>)}</ul>}
                </td>
                <td className="mono">{field.name}</td>
                <td data-testid="field-type">{typeText(field)}</td>
                <td data-testid="field-constraints">{constraintText(field) || <span className="muted">—</span>}</td>
                <td data-testid="field-required">{isRequired(field) ? '是' : '否'}</td>
                <td data-testid="field-uses">{used.length ? (used.length > 2 ? `${used.slice(0, 2).map((item) => item.name).join('、')} 等 ${used.length} 个模板` : used.map((item) => item.name).join('、')) : <span className="muted">—</span>}</td>
              </tr>,
              expanded && <tr key={`${index}-detail`} className="selected"><td colSpan={6} className="field-detail" data-testid="field-detail">{props.detail(index)}</td></tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 只读展开：操作员，或已发布的版本。 */
function FieldFacts(props: { readonly field: DefinitionField; readonly uses: UseMap }) {
  const { field } = props;
  return (
    <dl className="facts">
      <dt>类型</dt><dd>{typeText(field)}</dd>
      <dt>约束</dt><dd>{constraintText(field) || '没有'}</dd>
      <dt>必填</dt><dd>{isRequired(field) ? '是' : '否'}</dd>
      {field.description && <><dt>说明</dt><dd>{field.description}</dd></>}
      <dt>谁在用</dt><dd data-testid="field-used-by"><UsedBy templates={props.uses.get(field.name)} /></dd>
    </dl>
  );
}

/** 编译产物：只读预览，折叠着。 */
function CompiledPreview(props: { readonly compiled: unknown }) {
  return <pre className="compiled" data-testid="compiled-preview" tabIndex={0}>{JSON.stringify(props.compiled, null, 2)}</pre>;
}

/** 已发布的一版：不再改变，只读；客户管理员可以从它另起草案。 */
function VersionView(props: { readonly detail: Detail; readonly version: number; readonly field: string | undefined; readonly canEdit: boolean; readonly onChanged: () => void }) {
  const { detail, version, canEdit } = props, name = detail.name;
  const loaded = useLoad(() => api.staticSchema(name, version), `static-schema:${name}@${version}`);
  const [open, setOpen] = useState<number>();
  const [showCompiled, setShowCompiled] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const uses = useMapOf(detail), entry = detail.versions.find((item) => item.version === version), schema = loaded.data, current = detail.versions.at(-1)?.version === version;
  const branch = async () => {
    setProblems(undefined);
    try {
      await api.createDefinitionDraft(name, { fromVersion: version });
      props.onChanged();
      go(definitionPath(name));
    } catch (error) { setProblems(problemsOf(error)); }
  };
  const fields = schema ? fieldsOf(schema.definition) ?? [] : [];
  // 地址里写了字段（设计页"打开绑定的字段"）：读到这一版之后展开那一行。
  useEffect(() => {
    const index = schema ? (fieldsOf(schema.definition) ?? []).findIndex((field) => field.name === props.field) : -1;
    if (index >= 0) setOpen(index);
  }, [schema, props.field]);
  return (
    <>
      <div className="title-row">
        <div>
          <h1>{entry?.displayName ?? name}</h1>
          <p className="meta" data-testid="definition-meta">
            <span>v{version}{current ? ' · 当前版本' : ''}，已发布，不再改变</span>
            {entry && <span>{entry.templates.toLocaleString('zh-CN')} 个模板 · {entry.datasets.toLocaleString('zh-CN')} 份数据集绑定这一版</span>}
          </p>
          {schema?.description && <p className="lede">{schema.description}</p>}
        </div>
        <div className="actions">
          <VersionPicker detail={detail} value={version} />
          {canEdit && !detail.draft && <button type="button" className="primary" onClick={() => void branch()}>从这一版另起草案</button>}
          {detail.draft && <a className="button" href={href(definitionPath(name))}>打开草案</a>}
        </div>
      </div>
      <ErrorBox problems={problems} title="没有另起草案" />
      <ErrorBox problems={loaded.problems} title="读不到这一版" />
      {loaded.loading && !schema && <p className="muted">正在读取…</p>}
      {schema && (
        <>
          <FieldTable rows={fields.map((field, index) => ({ field, index }))} uses={uses} open={open} empty="这一版没有字段。"
            onToggle={(index) => setOpen(open === index ? undefined : index)} detail={(index) => <FieldFacts field={fields[index]!} uses={uses} />} />
          <div className="check-bar">
            <a className="small" href={href(['definition-publications'], { name, version: String(version) })}>查看这一版的发布记录</a>
            <span className="actions">
              <button type="button" className="small quiet" aria-expanded={showCompiled} onClick={() => setShowCompiled(!showCompiled)}>预览编译产物</button>
              <button type="button" className="small quiet" onClick={() => void exportCompiled({ name, version }).catch((error: unknown) => setProblems(problemsOf(error)))}>导出 JSON Schema</button>
            </span>
          </div>
          {showCompiled && <CompiledPreview compiled={schema.compiled} />}
        </>
      )}
    </>
  );
}

interface Editing {
  /** 字段表里的第几行；新加的一行在最后。 */
  readonly index: number;
  readonly value: DefinitionField;
  readonly isNew: boolean;
}

/** 草案：字段表原地展开编辑，保存之后校验。 */
function DraftView(props: { readonly detail: Detail; readonly draft: DefinitionDraft; readonly field: string | undefined; readonly canEdit: boolean; readonly onChanged: () => void }) {
  const { detail, canEdit } = props, name = detail.name;
  const loaded = useLoad(async () => {
    const reply = await api.definitionDraft(name);
    return { info: reply as DefinitionDraft, document: JSON.parse(reply.content) as DefinitionDocument };
  }, `draft:${name}`);
  const [saved, setSaved] = useState<{ readonly info: DefinitionDraft; readonly document: DefinitionDocument }>();
  const current = saved ?? loaded.data;
  const sha256 = current?.info.sha256;
  const check = useLoad(() => api.checkDefinitionDraft(name), `draft-check:${name}:${sha256 ?? ''}`);
  const baseVersion = props.draft.baseVersion;
  const base = useLoad(async () => (baseVersion === undefined ? undefined : api.staticSchema(name, baseVersion)), `draft-base:${name}@${baseVersion ?? ''}`);
  const schemas = useLoad(() => api.staticSchemas(), 'static-schemas');
  const [editing, setEditing] = useState<Editing>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [stale, setStale] = useState(false);
  const [showCompiled, setShowCompiled] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  /** 整份保存，带预期哈希；别人先保存了就停下，读回最新内容再改。 */
  const save = async (document: DefinitionDocument): Promise<boolean> => {
    setBusy(true);
    setProblems(undefined);
    try {
      const info = await api.saveDefinitionDraft(name, current!.info.sha256, documentText(document));
      setSaved({ info, document });
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.body?.['currentSha256']) setStale(true);
      setProblems(problemsOf(error));
      return false;
    } finally { setBusy(false); }
  };
  const reread = () => {
    setSaved(undefined);
    setStale(false);
    setEditing(undefined);
    setProblems(undefined);
    loaded.reload();
    check.reload();
  };

  const fields = current ? fieldsOf(current.document) : undefined;
  const baseFields = base.data ? fieldsOf(base.data.definition) : undefined;
  // 地址里写了字段（设计页"打开绑定的字段"）：读到草案之后展开那一行。
  useEffect(() => {
    const read = loaded.data ? fieldsOf(loaded.data.document) ?? [] : [], index = read.findIndex((field) => field.name === props.field);
    if (index >= 0) setEditing({ index, value: read[index]!, isNew: false });
  }, [loaded.data, props.field]);
  const dirty = editing !== undefined && (editing.isNew ? canonical(editing.value) !== canonical(NEW_FIELD) : canonical(editing.value) !== canonical(fields?.[editing.index]));

  /** 把正在改的这一行写进草案：没有改动不写；新加的一行什么都没填就当没加。 */
  const commit = async (): Promise<boolean> => {
    if (!editing || !dirty || !current || !fields) return true;
    const next = editing.isNew ? [...fields, editing.value] : fields.map((field, index) => (index === editing.index ? editing.value : field));
    return save({ ...current.document, fields: next });
  };
  const toggle = async (index: number) => {
    const closing = editing?.index === index;
    if (!(await commit())) return;
    setEditing(closing || !fields?.[index] ? undefined : { index, value: fields[index]!, isNew: false });
  };
  const addField = async () => {
    if (!(await commit())) return;
    // commit 之后下一次渲染才有新字段：行号算到最后，保存时按新字段追加。
    setEditing({ index: Number.MAX_SAFE_INTEGER, value: NEW_FIELD, isNew: true });
  };
  const remove = async (index: number) => {
    if (!current || !fields) return;
    if (await save({ ...current.document, fields: fields.filter((_field, at) => at !== index) })) setEditing(undefined);
  };
  const move = async (index: number, by: -1 | 1) => {
    if (!current || !fields || !editing) return;
    const target = index + by, next = [...fields];
    if (target < 0 || target >= next.length) return;
    next[index] = editing.value;
    [next[index], next[target]] = [next[target]!, next[index]!];
    if (await save({ ...current.document, fields: next })) setEditing({ index: target, value: editing.value, isNew: false });
  };
  const publish = async () => {
    if (await commit()) go([...definitionPath(name), 'publish']);
  };
  const discard = async () => {
    setProblems(undefined);
    try {
      await api.deleteDefinitionDraft(name);
      props.onChanged();
      go(detail.versions.length ? definitionPath(name) : ['definitions']);
    } catch (error) { setProblems(problemsOf(error)); }
  };

  const verdict = check.data && check.data.sha256 === sha256 ? check.data : undefined;
  const located = verdict && fields ? problemsByField(verdict.problems, fields) : undefined;
  const severe = verdict ? verdict.problems.filter((problem) => problem.level === 'severe').length : 0;
  const uses = useMapOf(detail);
  const changes = fields && baseFields ? {
    added: fields.filter((field) => fieldChange(field, baseFields) === 'added').length,
    changed: fields.filter((field) => fieldChange(field, baseFields) === 'changed').length,
    removed: baseFields.filter((field) => !fields.some((candidate) => candidate.name === field.name)).length,
  } : undefined;
  const rows = (fields ?? []).map((field, index) => ({
    field: editing?.index === index ? editing.value : field, index, tag: fieldChange(field, baseFields), problems: located?.byIndex.get(index),
  }));
  if (editing?.isNew) rows.push({ field: editing.value, index: editing.index, tag: 'added', problems: undefined });
  const refs: readonly StaticSchemaSummary[] = schemas.data?.staticSchemas ?? [];
  const firstRef: SchemaRef | undefined = refs[0] && { name: refs[0].name, version: refs[0].version };

  return (
    <>
      <div className="title-row">
        <div>
          <h1>{current?.document.displayName || name}</h1>
          <p className="meta" data-testid="definition-meta">
            <span>草案 · {baseVersion === undefined ? '还没发布过' : `基于 v${baseVersion}`}</span>
            {changes && <span data-testid="draft-changes">新增 {changes.added}、修改 {changes.changed}、删除 {changes.removed}</span>}
            {current && <span>{current.info.updatedBy} 保存于 {time(current.info.updatedAt)}</span>}
          </p>
          {current?.document.description && <p className="lede">{current.document.description}</p>}
        </div>
        <div className="actions">
          <VersionPicker detail={detail} value="draft" />
          {canEdit && (
            <button type="button" className="primary" disabled={!verdict || severe > 0 || busy} onClick={() => void publish()}
              title={severe ? '有严重问题，改正之后才能发布' : undefined}>{verdict?.version ? `发布为 v${verdict.version}` : '发布'}</button>
          )}
        </div>
      </div>
      {canEdit && current && (
        <div className="draft-tools">
          <button type="button" className="link" aria-expanded={renaming} onClick={() => setRenaming(!renaming)}>改显示名称与说明</button>
          {discarding
            ? <span className="confirm">删除这份草案？已发布的版本不受影响。<button type="button" className="small danger" onClick={() => void discard()}>确认删除草案</button><button type="button" className="small quiet" onClick={() => setDiscarding(false)}>取消</button></span>
            : <button type="button" className="link danger" onClick={() => setDiscarding(true)}>删除草案</button>}
        </div>
      )}
      {renaming && current && (
        <DefinitionProperties document={current.document} busy={busy}
          onSave={async (document) => { if (await save(document)) setRenaming(false); }} onCancel={() => setRenaming(false)} />
      )}
      {!canEdit && <p className="small muted" role="note">你可以查看草案，改动与发布由客户管理员完成。</p>}
      {stale && (
        <div className="impact-note" role="alert">
          <strong>别人刚保存过这份草案，你的改动没有写入。</strong>
          <div className="actions"><button type="button" className="small" onClick={reread}>读回最新内容</button></div>
        </div>
      )}
      <ErrorBox problems={stale ? undefined : problems} title="没有保存" />
      <ErrorBox problems={loaded.problems} title="读不到草案" />
      {loaded.loading && !current && <p className="muted">正在读取…</p>}
      {current && !fields && <p className="muted">这份草案还没写成字段列表，页面改不了；问题见下面，或用接口改。</p>}
      {current && fields && (
        <FieldTable rows={rows} uses={uses} open={editing?.index} empty={canEdit ? '还没有字段，添加第一个。' : '还没有字段。'}
          onToggle={(index) => {
            if (!canEdit) { setEditing(editing?.index === index ? undefined : { index, value: fields[index]!, isNew: false }); return; }
            if (editing?.isNew && index === editing.index) { setEditing(undefined); return; }
            void toggle(index);
          }}
          detail={() => (!canEdit
            ? <FieldFacts field={editing!.value} uses={uses} />
            : <FieldEditor key={editing!.isNew ? 'new' : editing!.index} editing={editing!} original={editing!.isNew ? undefined : fields[editing!.index]} inBase={(field) => Boolean(baseFields?.some((item) => item.name === field))}
                uses={uses} refs={refs} firstRef={firstRef} busy={busy} dirty={dirty} isFirst={editing!.index === 0} isLast={editing!.index === fields.length - 1}
                onChange={(value) => setEditing({ ...editing!, value })}
                onSave={async () => { if (await commit()) setEditing(undefined); }}
                onCancel={() => setEditing(undefined)}
                onDelete={() => void remove(editing!.index)}
                onMove={(by) => void move(editing!.index, by)} />)} />
      )}
      {verdict && verdict.affectedBindings.length > 0 && (
        <section className="card" data-testid="affected-bindings">
          <h2>会影响绑定</h2>
          <p className="small muted">与 v{baseVersion} 相比这些字段没有了，改字段名称等于删一个、加一个。下面的模板读这些字段；它们照旧绑定各自的版本，升到新版时要改绑定。</p>
          <ul className="plain impact">
            {verdict.affectedBindings.map((item) => <li key={item.field} data-field={item.field}><code>{item.field}</code>：<UsedBy templates={item.templates} /></li>)}
          </ul>
        </section>
      )}
      <div className="check-bar">
        <span>{canEdit && fields && !editing?.isNew && <button type="button" className="small" disabled={busy} onClick={() => void addField()}>添加字段</button>}</span>
        <span className="actions">
          <span role="status" data-testid="check-status">
            {busy ? <span className="chip">正在保存…</span>
              : !verdict ? <span className="chip">{check.problems ? '没有校验' : '正在校验…'}</span>
              : severe > 0 ? <span className="chip bad">{severe} 个严重问题</span>
              : <span className="chip ok">校验通过</span>}
          </span>
          <button type="button" className="small quiet" disabled={check.loading} onClick={check.reload}>校验</button>
          <button type="button" className="small quiet" aria-expanded={showCompiled} disabled={!verdict?.compiled} onClick={() => setShowCompiled(!showCompiled)}
            title={verdict?.compiled ? undefined : '改正严重问题之后才有编译产物'}>预览编译产物</button>
        </span>
      </div>
      <ErrorBox problems={check.problems} title="校验没有完成" />
      {located && verdict && verdict.problems.length > 0 && (
        <section className="card" aria-label="校验问题">
          <ProblemList problems={verdict.problems} label="校验问题" onSelect={(problem) => {
            const index = [...located.byIndex].find(([, list]) => list.includes(problem))?.[0];
            if (index !== undefined && editing?.index !== index) void toggle(index);
          }} />
        </section>
      )}
      {showCompiled && verdict?.compiled && <CompiledPreview compiled={verdict.compiled} />}
    </>
  );
}

function DefinitionProperties(props: { readonly document: DefinitionDocument; readonly busy: boolean; readonly onSave: (document: DefinitionDocument) => Promise<void>; readonly onCancel: () => void }) {
  const [displayName, setDisplayName] = useState(props.document.displayName ?? '');
  const [description, setDescription] = useState(props.document.description ?? '');
  const save = () => {
    const { description: _old, ...rest } = props.document;
    void props.onSave({ ...rest, displayName, ...(description ? { description } : {}) });
  };
  return (
    <form className="inline-form" aria-label="显示名称与说明" onSubmit={(event) => { event.preventDefault(); save(); }}>
      <div className="field">
        <label htmlFor="definition-display-name">数据定义的显示名称</label>
        <input id="definition-display-name" type="text" autoFocus value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div className="field grow">
        <label htmlFor="definition-description">数据定义的说明</label>
        <input id="definition-description" type="text" value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <button type="submit" className="small" disabled={props.busy}>保存</button>
      <button type="button" className="small quiet" onClick={props.onCancel}>取消</button>
    </form>
  );
}

/** 改名或删字段的影响：字段名称是身份（ADR-0005）。 */
function BindingImpact(props: { readonly kind: 'rename' | 'remove'; readonly field: string; readonly published: boolean; readonly templates: readonly TemplateBinding[] | undefined; readonly children?: ReactNode }) {
  const used = Boolean(props.templates?.length);
  return (
    <div className="impact-note" role="note" data-testid={props.kind === 'rename' ? 'rename-impact' : 'remove-impact'}>
      <strong>{props.kind === 'rename' ? `改字段名称等于删掉 ${props.field}、再加一个新字段。` : `删掉字段 ${props.field}。`}</strong>
      <span>{used ? <>会影响这些模板的绑定：<UsedBy templates={props.templates} />。它们照旧绑定各自的版本，升到新版时要改绑定。</> : '现在没有模板读这个字段。'}</span>
      {props.published ? <span>按这个名称填写的数据集，按新版校验时这个键不再有对应。</span> : <span>这个字段还没发布过，没有数据集用它。</span>}
      {props.children}
    </div>
  );
}

/** 选中的一行原地展开：字段自己的属性，加这种类型能写的约束（docs/dsl/data-definition.md）。 */
function FieldEditor(props: {
  readonly editing: Editing;
  readonly original: DefinitionField | undefined;
  readonly inBase: (field: string) => boolean;
  readonly uses: UseMap;
  readonly refs: readonly StaticSchemaSummary[];
  readonly firstRef: SchemaRef | undefined;
  readonly busy: boolean;
  readonly dirty: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onChange: (value: DefinitionField) => void;
  readonly onSave: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onMove: (by: -1 | 1) => void;
}) {
  const { editing, original, onChange } = props, value = editing.value;
  const [removing, setRemoving] = useState(false);
  const renamed = original && original.name !== value.name && (props.inBase(original.name) || (props.uses.get(original.name)?.length ?? 0) > 0);
  const set = <K extends keyof DefinitionField>(key: K, part: DefinitionField[K] | undefined) => {
    const next: Record<string, unknown> = { ...value };
    if (part === undefined) delete next[key];
    else next[key] = part;
    onChange(next as unknown as DefinitionField);
  };
  return (
    <form className="field-editor" aria-label="编辑字段" onSubmit={(event) => { event.preventDefault(); void props.onSave(); }}>
      <div className="fields">
        <div className="field">
          <label htmlFor="field-display-name">显示名称</label>
          <input id="field-display-name" type="text" autoFocus={editing.isNew} value={value.displayName} onChange={(event) => set('displayName', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="field-name">字段名称</label>
          <input id="field-name" type="text" className="mono" spellCheck={false} placeholder="英文字母开头，如 operator" value={value.name} onChange={(event) => set('name', event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="field-type">类型</label>
          <select id="field-type" value={value.type} onChange={(event) => onChange(withType(value, event.target.value as FieldType, props.firstRef))}>
            {FIELD_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
          </select>
        </div>
        <label className="check-field"><input type="checkbox" checked={isRequired(value)} onChange={(event) => onChange(withConstraint(value, 'required', event.target.checked))} />必填</label>
        <div className="field wide">
          <label htmlFor="field-description">说明</label>
          <input id="field-description" type="text" value={value.description ?? ''} onChange={(event) => set('description', event.target.value || undefined)} />
        </div>
        <TypeFields owner={value} prefix="field" onChange={onChange} refs={props.refs} />
        {value.type === 'list' && (
          <>
            <div className="field">
              <label htmlFor="item-type">元素类型</label>
              <select id="item-type" value={value.items?.type ?? 'text'} onChange={(event) => onChange({ ...value, items: itemsOfType(event.target.value as FieldType, props.firstRef) })}>
                {ITEM_TYPES.map((item) => <option key={item.type} value={item.type}>{item.label}</option>)}
              </select>
            </div>
            <TypeFields owner={value.items ?? { type: 'text' }} prefix="item" label="元素" onChange={(items: DefinitionItems) => onChange({ ...value, items })} refs={props.refs} />
          </>
        )}
      </div>
      {!editing.isNew && <p className="field-used small"><span className="muted">谁在用：</span><span data-testid="field-used-by"><UsedBy templates={props.uses.get(original?.name ?? value.name)} /></span></p>}
      {renamed && <BindingImpact kind="rename" field={original.name} published={props.inBase(original.name)} templates={props.uses.get(original.name)} />}
      {removing && original && (
        <BindingImpact kind="remove" field={original.name} published={props.inBase(original.name)} templates={props.uses.get(original.name)}>
          <div className="actions">
            <button type="button" className="small danger" disabled={props.busy} onClick={props.onDelete}>确认删除字段</button>
            <button type="button" className="small quiet" onClick={() => setRemoving(false)}>留着</button>
          </div>
        </BindingImpact>
      )}
      <div className="actions field-actions">
        <button type="submit" className="small" disabled={props.busy || !props.dirty}>{editing.isNew ? '加入草案' : '保存字段'}</button>
        <button type="button" className="small quiet" onClick={props.onCancel}>{editing.isNew ? '不加了' : '取消改动'}</button>
        {!editing.isNew && (
          <>
            <button type="button" className="small quiet" disabled={props.busy || props.isFirst} onClick={() => props.onMove(-1)}>上移</button>
            <button type="button" className="small quiet" disabled={props.busy || props.isLast} onClick={() => props.onMove(1)}>下移</button>
            <span className="field-actions-gap" />
            <button type="button" className="link danger" onClick={() => setRemoving(true)}>删除字段</button>
          </>
        )}
      </div>
    </form>
  );
}

/** 这种类型能写的约束：字段与列表元素用同一份。label 写在标签前面，元素的约束读作"元素最长（字）"。 */
function TypeFields<T extends DefinitionItems>(props: { readonly owner: T; readonly prefix: string; readonly label?: string; readonly onChange: (owner: T) => void; readonly refs: readonly StaticSchemaSummary[] }) {
  const { owner, prefix, onChange, refs } = props, tag = props.label ?? '', c = owner.constraints ?? {};
  const set = (key: string, value: unknown) => onChange(withConstraint(owner, key, value));
  const number = (key: string, label: string, whole = true) => (
    <NumberField key={key} id={`${prefix}-${key}`} label={`${tag}${label}`} value={c[key] as number | undefined} whole={whole} onChange={(value) => set(key, value)} />
  );
  switch (owner.type) {
    case 'text':
      return (
        <>
          {number('minLength', '最短（字）')}
          {number('maxLength', '最长（字）')}
          <div className="field">
            <label htmlFor={`${prefix}-pattern`}>{tag}正则</label>
            <input id={`${prefix}-pattern`} type="text" className="mono" spellCheck={false} value={typeof c['pattern'] === 'string' ? c['pattern'] : ''} onChange={(event) => set('pattern', event.target.value || undefined)} />
          </div>
          <EnumField id={`${prefix}-enum`} label={`${tag}可选值（一行一个）`} value={c['enum']} numeric={false} onChange={(value) => set('enum', value)} />
        </>
      );
    case 'number':
      return (
        <>
          {number('min', '下限', false)}
          {number('max', '上限', false)}
          <label className="check-field"><input type="checkbox" checked={c['integer'] === true} onChange={(event) => set('integer', event.target.checked ? true : undefined)} />{tag}只能是整数</label>
          <EnumField id={`${prefix}-enum`} label={`${tag}可选值（一行一个）`} value={c['enum']} numeric onChange={(value) => set('enum', value)} />
        </>
      );
    case 'image': {
      // 省略表示两种来源都允许；只取一种时才写。
      const sources = Array.isArray(c['allowedSources']) ? c['allowedSources'] as string[] : ['resource', 'url'];
      const toggle = (source: string, on: boolean) => {
        const next = ['resource', 'url'].filter((item) => (item === source ? on : sources.includes(item)));
        set('allowedSources', next.length === 2 ? undefined : next);
      };
      return (
        <fieldset className="tenant-picks wide">
          <legend>{tag}图片来源</legend>
          <label className="check"><input type="checkbox" checked={sources.includes('resource')} onChange={(event) => toggle('resource', event.target.checked)} />资源仓库</label>
          <label className="check"><input type="checkbox" checked={sources.includes('url')} onChange={(event) => toggle('url', event.target.checked)} />网址</label>
        </fieldset>
      );
    }
    case 'list':
      return <>{number('minItems', '最少项数')}{number('maxItems', '最多项数')}</>;
    case 'ref':
      return <RefField id={`${prefix}-ref`} label={`${tag}引用的数据定义`} value={owner.ref} refs={refs} onChange={(ref) => onChange({ ...owner, ref })} />;
    default:
      return <p className="small muted wide">这种类型没有{tag}约束。</p>;
  }
}

/** 数值输入：自己留着正在打的字（"1."、"-"），写回去的是数值；清空就是没有这条约束。 */
function NumberField(props: { readonly id: string; readonly label: string; readonly value: number | undefined; readonly whole: boolean; readonly onChange: (value: number | undefined) => void }) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <input id={props.id} type="number" step={props.whole ? 1 : 'any'} {...(props.whole ? { min: 0 } : {})} value={text}
        onChange={(event) => { setText(event.target.value); props.onChange(event.target.value === '' ? undefined : Number(event.target.value)); }} />
    </div>
  );
}

/** 枚举：一行一个。数值枚举读不成数的原样写回，由服务端报问题。 */
function EnumField(props: { readonly id: string; readonly label: string; readonly value: unknown; readonly numeric: boolean; readonly onChange: (value: unknown) => void }) {
  const [text, setText] = useState(Array.isArray(props.value) ? props.value.join('\n') : '');
  const change = (next: string) => {
    setText(next);
    const lines = next.split('\n').map((line) => line.trim()).filter(Boolean);
    props.onChange(lines.length ? (props.numeric ? lines.map((line) => (Number.isNaN(Number(line)) ? line : Number(line))) : lines) : undefined);
  };
  return (
    <div className="field wide">
      <label htmlFor={props.id}>{props.label}</label>
      <textarea id={props.id} rows={3} value={text} onChange={(event) => change(event.target.value)} />
    </div>
  );
}

/** 引用：选已发布的确切版本；当前写的版本不在列表里也留着，由服务端报问题。 */
function RefField(props: { readonly id: string; readonly label: string; readonly value: SchemaRef | undefined; readonly refs: readonly StaticSchemaSummary[]; readonly onChange: (ref: SchemaRef) => void }) {
  const key = (ref: SchemaRef) => `${ref.name}@${ref.version}`;
  const missing = props.value && !props.refs.some((ref) => key(ref) === key(props.value!));
  if (!props.refs.length && !props.value) return <p className="small muted wide">还没有已发布的数据定义可以引用。</p>;
  return (
    <div className="field">
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value ? key(props.value) : ''} onChange={(event) => {
        const at = event.target.value.lastIndexOf('@');
        props.onChange({ name: event.target.value.slice(0, at), version: Number(event.target.value.slice(at + 1)) });
      }}>
        {!props.value && <option value="">选一个版本</option>}
        {missing && <option value={key(props.value!)}>{props.value!.name} v{props.value!.version}（不存在）</option>}
        {props.refs.map((ref) => <option key={key(ref)} value={key(ref)}>{ref.displayName === ref.name ? ref.name : `${ref.displayName}（${ref.name}）`} v{ref.version}</option>)}
      </select>
    </div>
  );
}
