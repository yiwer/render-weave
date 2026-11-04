/**
 * 静态数据定义（M360，参照旧 RenderWeave 的"数据结构资产"）：发布之后不可变的版本（ADR-0008），一个版本一张卡片。
 * - 列表可以搜索、排序；卡片上有字段数、引用深度、谁在用与发布时间，右键有导出编译产物、复制引用、复制为草案；
 * - 详情有字段树、字段表单、编译产物与数据定义 DSL 四种看法，右边是选中字段的只读信息；
 * - 要改就复制为草案：同一名称接着发下一版，换名称是一份新的数据定义。操作员只读。
 * 只调开放 API。发布记录在 definition-publish.tsx，同属这个模块。
 */
import { useEffect, useState, type MouseEvent } from 'react';
import { api, saveBlob } from '../api.js';
import { ContextMenu, type ContextMenuItem } from '../components/context-menu.js';
import { DefinitionTree, FieldFacts, FieldSummary, type UseMap } from '../components/definition-fields.js';
import { StaticSchemaTabs } from '../components/module-tabs.js';
import { ErrorBox } from '../components/problems.js';
import { fieldKinds, fieldsOf } from '../form/definition-session.js';
import { FIELD_TYPES } from '../form/definition.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { DefinitionDocument, FieldType, Identity, Problem, SchemaRef } from '../types.js';
import { documentText } from './definition-studio.js';
import { canEditDefinitions, copyReference, definitionPath, exportCompiled, openInNewTab, staticSchemaPath } from './definitions.js';
import { FieldGraph, Loading } from '../components/motifs.js';

const time = (at: string) => new Date(at).toLocaleString('zh-CN');
const number = (value: number) => value.toLocaleString('zh-CN');
const keyOf = (ref: SchemaRef) => `${ref.name}@${ref.version}`;
const typeName = (type: FieldType) => FIELD_TYPES.find((item) => item.type === type)?.label ?? type;

type Sort = 'newest' | 'oldest' | 'nameAsc' | 'nameDesc';
const SORTS: readonly (readonly [Sort, string])[] = [['newest', '最新发布'], ['oldest', '最早发布'], ['nameAsc', '名称 A–Z'], ['nameDesc', '名称 Z–A']];

/** 列表要的几份数据：版本与字段数、各版本谁在用、谁在何时发布（审计之前的版本没有时间）。 */
async function loadVersions() {
  const [schemas, definitions, publications] = await Promise.all([api.staticSchemas(), api.definitions(), api.definitionPublications()]);
  const uses = new Map(definitions.definitions.flatMap((definition) => definition.versions.map((version) => [keyOf({ name: definition.name, version: version.version }), version] as const)));
  const published = new Map(publications.publications.map((publication) => [keyOf(publication), publication]));
  const latest = new Map<string, number>();
  for (const schema of schemas.staticSchemas) latest.set(schema.name, Math.max(latest.get(schema.name) ?? 0, schema.version));
  const drafts = new Set(definitions.definitions.filter((definition) => definition.draft).map((definition) => definition.name));
  return schemas.staticSchemas.map((schema) => ({
    ...schema, uses: uses.get(keyOf(schema)), at: published.get(keyOf(schema))?.at, current: latest.get(schema.name) === schema.version, hasDraft: drafts.has(schema.name),
  }));
}
type VersionEntry = Awaited<ReturnType<typeof loadVersions>>[number];

export function StaticSchemaList(props: { readonly identity: Identity }) {
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(loadVersions, 'static-schema-versions');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [menu, setMenu] = useState<{ readonly version: VersionEntry; readonly at: { readonly x: number; readonly y: number } }>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [notice, setNotice] = useState<string>();
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const order = (a: VersionEntry, b: VersionEntry) => {
    const byName = a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version;
    if (sort === 'nameAsc') return byName;
    if (sort === 'nameDesc') return -byName;
    // 审计之前的版本没有时间，总在最后。
    if ((a.at ?? '') === (b.at ?? '')) return byName;
    if (!a.at || !b.at) return a.at ? -1 : 1;
    return (a.at < b.at ? 1 : -1) * (sort === 'newest' ? 1 : -1);
  };
  const versions = (loaded.data ?? [])
    .filter((version) => !query || [version.name, version.displayName, `v${version.version}`].some((text) => text.toLocaleLowerCase('zh-CN').includes(query)))
    .sort(order);
  const attempt = async (action: () => Promise<void>) => {
    setProblems(undefined);
    setNotice(undefined);
    try { await action(); } catch (error) { setProblems(problemsOf(error)); }
  };
  const itemsOf = (version: VersionEntry): ContextMenuItem[] => {
    const ref = { name: version.name, version: version.version }, path = staticSchemaPath(version.name, version.version);
    return [
      { label: '打开', run: () => go(path) },
      { label: '在新标签页打开', run: () => openInNewTab(path) },
      { label: '查看发布记录', run: () => go(['definition-publications'], { name: version.name }) },
      { label: '导出编译产物 JSON Schema', run: () => void attempt(() => exportCompiled(ref)) },
      { label: '复制引用', run: () => void attempt(async () => setNotice(await copyReference(ref))) },
      ...(canEdit ? [{
        label: '复制为草案', hint: version.hasDraft ? '已有草案' : `v${version.version}`, disabled: version.hasDraft,
        run: () => void attempt(async () => {
          await api.createDefinitionDraft(version.name, { fromVersion: version.version });
          go(definitionPath(version.name));
        }),
      }] : []),
    ];
  };
  const openMenu = (event: MouseEvent, version: VersionEntry) => {
    event.preventDefault();
    setMenu({ version, at: { x: event.clientX, y: event.clientY } });
  };
  return (
    <section className="page">
      <div className="title-row"><h1>静态数据定义</h1></div>
      <StaticSchemaTabs active="versions" />
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到静态数据定义" />
      {notice && <p className="small muted" role="status">{notice}</p>}
      {loaded.loading && !loaded.data && <Loading />}
      {loaded.data && (
        <>
          <div className="list-toolbar">
            <input type="search" className="list-search" aria-label="搜索静态数据定义" placeholder="搜索名称、显示名称或版本" value={search} onChange={(event) => setSearch(event.target.value)} />
            <label className="list-sort">排序
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <span className="small muted" data-testid="version-count">{versions.length} 个版本</span>
          </div>
          {versions.length === 0 && (
            <div className="list-empty" data-testid="versions-empty"><FieldGraph /><strong>{query ? '没有匹配的版本' : '还没有已发布的版本'}</strong>{!query && <span>在<a href={href(['definitions'])}>数据定义</a>里发布一份草案，或者让代建工程师推送。</span>}</div>
          )}
          <div className="schema-grid" aria-label="静态数据定义的版本">
            {versions.map((version) => (
              <article key={keyOf(version)} className="schema-card" data-testid="version-card" data-name={version.name} data-version={version.version} onContextMenu={(event) => openMenu(event, version)}>
                <a className="schema-card-body" href={href(staticSchemaPath(version.name, version.version))}>
                  <span className="schema-card-states">
                    <span className="schema-pill"><span className={`dot${version.current ? ' ok' : ''}`} aria-hidden="true" />{version.current ? '当前版本' : '历史版本'}</span>
                    {version.hasDraft && version.current && <span className="schema-pill"><span className="dot accent" aria-hidden="true" />有草案</span>}
                  </span>
                  <span className="schema-card-title">
                    <span className="schema-card-name"><strong>{version.displayName}</strong><span className="version-badge" data-testid="version-badge">v{version.version}</span></span>
                    <code>{version.name}</code>
                  </span>
                  <dl className="schema-facts">
                    <div><dt>字段</dt><dd data-testid="version-fields">{version.fieldCount ?? '—'}</dd></div>
                    <div><dt>引用深度</dt><dd data-testid="version-depth">{version.referenceDepth ?? '—'}</dd></div>
                    <div><dt>谁在用</dt><dd data-testid="version-uses">{version.uses ? `${number(version.uses.templates)} 模板 · ${number(version.uses.datasets)} 数据集` : '—'}</dd></div>
                  </dl>
                  <span className="schema-card-foot">{version.at ? `发布于 ${time(version.at)}` : '审计里没有发布记录'}</span>
                </a>
                <button type="button" className="icon schema-card-more" aria-haspopup="menu" aria-label={`${version.displayName} v${version.version} 的更多操作`}
                  onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ version, at: { x: box.left, y: box.bottom + 4 } }); }}>⋯</button>
              </article>
            ))}
          </div>
        </>
      )}
      {menu && <ContextMenu label={`${menu.version.displayName} v${menu.version.version} 的操作`} at={menu.at} items={itemsOf(menu.version)} onClose={() => setMenu(undefined)} />}
      <p className="table-note">发布后的版本不可修改，模板与数据集都绑定到具体版本；要改就复制为草案，发布成下一版。</p>
    </section>
  );
}

type View = 'tree' | 'form' | 'compiled' | 'definition';
const VIEWS: readonly (readonly [View, string])[] = [['tree', '字段树'], ['form', '字段表单'], ['compiled', '编译产物 JSON Schema'], ['definition', '数据定义 DSL']];

export function StaticSchemaPage(props: { readonly name: string; readonly version: string; readonly field?: string; readonly identity: Identity }) {
  const { name } = props, version = Number(props.version), canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(async () => {
    const [schema, detail, list, publications] = await Promise.all([api.staticSchema(name, version), api.definition(name), api.staticSchemas(), api.definitionPublications(name)]);
    return { schema, detail, summary: list.staticSchemas.find((item) => item.name === name && item.version === version), publication: publications.publications.find((item) => item.version === version) };
  }, `static-schema:${name}@${version}`);
  const [view, setView] = useState<View>('tree');
  const [selected, setSelected] = useState(0);
  const [copying, setCopying] = useState(false);
  const data = loaded.data;
  const fields = data ? fieldsOf(data.schema.definition) ?? [] : [];
  useEffect(() => {
    const index = fields.findIndex((field) => field.name === props.field);
    if (index >= 0) setSelected(index);
  }, [data, props.field]);
  const crumbs = <nav className="crumbs" aria-label="位置"><a href={href(['static-schemas'])}>静态数据定义</a><span aria-hidden="true">/</span><span>{name} v{props.version}</span></nav>;
  if (!data) {
    return (
      <section className="page">
        {crumbs}
        <ErrorBox problems={loaded.problems} title="读不到这个版本" />
        {loaded.loading && <Loading />}
      </section>
    );
  }
  const { schema, detail, summary, publication } = data, document = schema.definition;
  const uses: UseMap = new Map(detail.fieldUses.map((use) => [use.field, use.templates]));
  const entry = detail.versions.find((item) => item.version === version), latest = detail.versions.at(-1)?.version;
  const field = fields[selected];
  return (
    <section className="page">
      {crumbs}
      <div className="title-row">
        <div>
          <h1>{document.displayName ?? name} <span className="version-badge large">v{version}</span></h1>
          {document.description && <p className="small muted">{document.description}</p>}
        </div>
        <div className="actions">
          <a className="button primary" href={href(['datasets', 'new'], { schema: name, version: String(version) })}>新建数据集</a>
          <a className="button" href={href(['dataset-imports'], { schema: name, version: String(version) })}>智能导入数据集</a>
          <select aria-label="查看的版本" value={version} onChange={(event) => go(staticSchemaPath(name, event.target.value))}>
            {[...detail.versions].reverse().map((item) => <option key={item.version} value={item.version}>v{item.version}{item.version === latest ? ' · 当前' : ''}</option>)}
          </select>
          {canEdit && (detail.draft
            ? <a className="button" href={href(definitionPath(name))}>打开草案</a>
            : <button type="button" className="primary" aria-expanded={copying} onClick={() => setCopying(!copying)}>复制为草案</button>)}
        </div>
      </div>
      {copying && <CopyToDraft name={name} version={version} document={document} />}
      <dl className="static-facts" data-testid="static-facts">
        <div><dt>名称</dt><dd className="mono">{name}</dd></div>
        <div><dt>版本</dt><dd>v{version}{version === latest ? ' · 当前' : ''}</dd></div>
        <div><dt>字段</dt><dd data-testid="static-field-count">{fields.length}</dd></div>
        <div><dt>引用深度</dt><dd>{summary?.referenceDepth ?? '—'}</dd></div>
        <div><dt>谁在用</dt><dd>{entry ? `${number(entry.templates)} 模板 · ${number(entry.datasets)} 数据集` : '—'}</dd></div>
        <div><dt>发布</dt><dd>{publication?.at ? `${publication.actor?.label ?? ''} · ${time(publication.at)}` : <span className="muted">审计里没有记录</span>}</dd></div>
      </dl>
      <div className="tabs" role="tablist" aria-label="查看方式">
        {VIEWS.map(([value, label]) => <button key={value} type="button" role="tab" aria-selected={view === value} className={view === value ? 'active' : undefined} onClick={() => setView(value)}>{label}</button>)}
        <span className="small muted static-kinds">{fields.length} 个字段{fields.length ? ` · ${fieldKinds(fields, typeName)}` : ''}</span>
      </div>
      {view === 'compiled' && <CodePanel testid="compiled-json-schema" value={schema.compiled} file={`${name}-v${version}.schema.json`} type="application/schema+json" />}
      {view === 'definition' && <CodePanel testid="definition-dsl" value={document} file={`${name}-v${version}.json`} type="application/json" />}
      {(view === 'tree' || view === 'form') && (
        <div className="static-split">
          {view === 'tree'
            ? <DefinitionTree name={name} document={document} selected={field ? selected : undefined} onSelect={setSelected} />
            : (
              <div className="studio-rows" aria-label="字段">
                {fields.length === 0 && <p className="muted">这一版没有字段。</p>}
                {fields.map((item, index) => (
                  <article key={item.name} className={`studio-row${selected === index ? ' selected' : ''}`} data-testid="field-row" data-field={item.name}>
                    <button type="button" className="studio-row-main" aria-pressed={selected === index} aria-label={`查看字段 ${item.displayName || item.name}`} onClick={() => setSelected(index)}>
                      <FieldSummary field={item} index={index} />
                    </button>
                  </article>
                ))}
              </div>
            )}
          <aside className="static-inspector" aria-label="字段信息">
            {field
              ? <><header className="field-inspector-head"><h2>{field.displayName || field.name}</h2><code>/{field.name}</code></header><FieldFacts field={field} uses={uses} /></>
              : <p className="muted">这一版没有字段。</p>}
          </aside>
        </div>
      )}
      <p className="table-note"><a href={href(['definition-publications'], { name, version: String(version) })}>查看这一版的发布记录</a></p>
    </section>
  );
}

/** 复制为草案：同一名称接着发下一版；换名称是一份新的数据定义，字段照抄，身份换新。 */
function CopyToDraft(props: { readonly name: string; readonly version: number; readonly document: DefinitionDocument }) {
  const [name, setName] = useState(props.name), [displayName, setDisplayName] = useState(props.document.displayName ?? props.name);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const target = name.trim();
  const copy = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      if (target === props.name) await api.createDefinitionDraft(target, { fromVersion: props.version });
      else {
        const draft = await api.createDefinitionDraft(target, { displayName: displayName.trim() || target });
        const { version: _version, ...rest } = props.document as DefinitionDocument & { readonly version?: number };
        await api.saveDefinitionDraft(target, draft.sha256, documentText({ ...rest, name: target, displayName: displayName.trim() || target }));
      }
      go(definitionPath(target));
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <form className="inline-form" aria-label="复制为草案" onSubmit={(event) => { event.preventDefault(); if (target) void copy(); }}>
        <div className="field">
          <label htmlFor="copy-name">草案的名称</label>
          <input id="copy-name" type="text" autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        {target !== props.name && (
          <div className="field">
            <label htmlFor="copy-display-name">显示名称</label>
            <input id="copy-display-name" type="text" maxLength={200} value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </div>
        )}
        <button type="submit" disabled={!target || busy}>{busy ? '正在复制…' : '复制'}</button>
        <span className="small muted">{target === props.name ? `发布时成为 ${props.name} 的下一版。` : '这是一份新的数据定义，从 v1 开始。'}</span>
      </form>
      <ErrorBox problems={problems} title="没有复制" />
    </>
  );
}

/** 只读的代码块：可以复制、下载。 */
function CodePanel(props: { readonly testid: string; readonly value: unknown; readonly file: string; readonly type: string }) {
  const text = `${JSON.stringify(props.value, null, 2)}\n`;
  const [copied, setCopied] = useState<string>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('已复制');
    } catch { setCopied('浏览器不让复制，请手动选中'); }
  };
  return (
    <section className="code-panel">
      <div className="actions code-panel-tools">
        {copied && <span className="small muted" role="status">{copied}</span>}
        <button type="button" className="small quiet" onClick={() => void copy()}>复制</button>
        <button type="button" className="small quiet" onClick={() => saveBlob(new Blob([text], { type: props.type }), props.file.replace(/[\\/:*?"<>|]/g, '_'))}>下载</button>
      </div>
      <pre className="compiled" data-testid={props.testid} tabIndex={0}>{text}</pre>
    </section>
  );
}
