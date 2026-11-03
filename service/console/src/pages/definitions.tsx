/**
 * 数据定义列表（M360，参照旧 RenderWeave 的"数据结构设计"）：这里只有还在改的草案，一份草案一张卡片；发布之后在静态数据定义里（static-schemas.tsx）。
 * - 客户管理员能新建、发布、删除；操作员只读，这些入口不显示（权限以开放 API 为准）；
 * - 要改已发布的数据定义：到静态数据定义从那一版复制为草案（ADR-0008）。
 * 只调开放 API。编辑页在 definition-studio.tsx，发布与发布记录在 definition-publish.tsx。
 */
import { useState } from 'react';
import { api, saveBlob } from '../api.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { Definition, DefinitionDraft, Identity, Problem, SchemaRef } from '../types.js';
import { DraftSheets, Loading } from '../components/motifs.js';

export const canEditDefinitions = (identity: Identity) => identity.role === 'admin';
export const definitionPath = (name: string) => ['definitions', name];
export const staticSchemaPath = (name: string, version: number | string) => ['static-schemas', name, String(version)];

/** 导出一个静态版本的编译产物：写法与发布的产物相同（缩进两格、末尾换行）。 */
export async function exportCompiled(ref: SchemaRef): Promise<void> {
  const { compiled } = await api.staticSchema(ref.name, ref.version);
  saveBlob(new Blob([`${JSON.stringify(compiled, null, 2)}\n`], { type: 'application/schema+json' }), `${ref.name.replace(/[\\/:*?"<>|]/g, '_')}-v${ref.version}.schema.json`);
}

/** 复制引用：模板的基准、数据集的 staticSchema 与字段的 ref 都这样写。答复制的结果，给页面显示。 */
export async function copyReference(ref: SchemaRef): Promise<string> {
  try {
    await navigator.clipboard.writeText(JSON.stringify({ name: ref.name, version: ref.version }));
    return `已复制 ${ref.name} v${ref.version} 的引用`;
  } catch {
    return `浏览器不让复制，请手动写：${JSON.stringify({ name: ref.name, version: ref.version })}`;
  }
}

/** 在新标签页打开：用 window.open 才会带上本标签页的会话（sessionStorage）；target=_blank 的链接带不上，会回到登录页。 */
export const openInNewTab = (path: readonly string[]) => { window.open(href(path), '_blank'); };

const time = (at: string) => new Date(at).toLocaleString('zh-CN');
type Sort = 'updated' | 'oldest' | 'name';
const SORTS: readonly (readonly [Sort, string])[] = [['updated', '最近保存'], ['oldest', '最早保存'], ['name', '名称']];
type DraftEntry = Definition & { readonly draft: DefinitionDraft };

export function DefinitionList(props: { readonly identity: Identity }) {
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(() => api.definitions(), 'definitions');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [removing, setRemoving] = useState<string>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const all = loaded.data?.definitions;
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const drafts = (all ?? []).filter((definition): definition is DraftEntry => Boolean(definition.draft))
    .filter((definition) => !query || [definition.name, draftName(definition)].some((text) => text.toLocaleLowerCase('zh-CN').includes(query)))
    .sort((a, b) => (sort === 'name' ? (a.name < b.name ? -1 : 1) : (a.draft.updatedAt < b.draft.updatedAt ? 1 : -1) * (sort === 'updated' ? 1 : -1)));
  const remove = async (name: string) => {
    setProblems(undefined);
    try {
      await api.deleteDefinitionDraft(name);
      setRemoving(undefined);
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <section className="page">
      <div className="title-row">
        <h1>数据定义</h1>
        {canEdit && <button type="button" className="primary" aria-expanded={creating} onClick={() => setCreating(!creating)}>新建数据定义</button>}
      </div>
      {creating && <NewDefinition />}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到数据定义" />
      {loaded.loading && !all && <Loading />}
      {all && (
        <>
          <div className="list-toolbar">
            <input type="search" className="list-search" aria-label="搜索数据定义" placeholder="搜索名称或显示名称" value={search} onChange={(event) => setSearch(event.target.value)} />
            <label className="list-sort">排序
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <span className="small muted" data-testid="draft-count">{drafts.length} 份草案</span>
          </div>
          {drafts.length === 0 && (
            <div className="list-empty" data-testid="drafts-empty">
              <DraftSheets />
              <strong>{query ? '没有匹配的草案' : '还没有草案'}</strong>
              {!query && <span>新建一份，或者到<a href={href(['static-schemas'])}>静态数据定义</a>从某个版本复制为草案。</span>}
            </div>
          )}
          <div className="schema-grid" aria-label="数据定义草案">
            {drafts.map((definition) => {
              const { name, draft } = definition;
              return (
                <article key={name} className="schema-card" data-testid="draft-card" data-name={name}>
                  <a className="schema-card-body" href={href(definitionPath(name))}>
                    <span className="schema-card-head"><strong>{draftName(definition)}</strong><span className="chip accent">草案</span></span>
                    <code>{name}</code>
                    <dl className="schema-facts">
                      <div><dt>字段</dt><dd data-testid="draft-fields">{draft.fieldCount ?? '—'}</dd></div>
                      <div><dt>基于</dt><dd>{draft.baseVersion === undefined ? '还没发布过' : `v${draft.baseVersion}`}</dd></div>
                      <div><dt>最近保存</dt><dd>{time(draft.updatedAt)}</dd></div>
                    </dl>
                    <span className="small muted">{draft.updatedBy}</span>
                  </a>
                  {canEdit && (
                    <footer className="schema-card-actions">
                      {removing === name
                        ? (
                          <>
                            <span className="small">删除这份草案？</span>
                            <button type="button" className="small danger" onClick={() => void remove(name)}>确认删除</button>
                            <button type="button" className="small quiet" onClick={() => setRemoving(undefined)}>取消</button>
                          </>
                        )
                        : (
                          <>
                            <a className="button small quiet" href={href([...definitionPath(name), 'publish'])}>发布</a>
                            <button type="button" className="small quiet" onClick={() => setRemoving(name)}>删除</button>
                          </>
                        )}
                    </footer>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

const draftName = (definition: Definition) => definition.draft?.displayName || definition.displayName;

/** 空白新建：名称是身份，发布后不能改，显示名称写给人看（M89 的中文写在显示名称里，数据定义的名称可以用中文）。 */
function NewDefinition() {
  const [name, setName] = useState(''), [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const create = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      await api.createDefinitionDraft(name.trim(), { displayName: displayName.trim() || name.trim() });
      go(definitionPath(name.trim()));
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <form className="inline-form" aria-label="新建数据定义" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
        <div className="field">
          <label htmlFor="new-definition-name">名称</label>
          <input id="new-definition-name" type="text" autoFocus maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-definition-display-name">显示名称</label>
          <input id="new-definition-display-name" type="text" maxLength={200} placeholder="不填就用名称" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>
        <button type="submit" disabled={!name.trim() || busy}>{busy ? '正在新建…' : '新建草案'}</button>
        <span className="small muted">名称是身份，发布后不能改；模板与数据集按名称和版本引用它。</span>
      </form>
      <ErrorBox problems={problems} title="没有新建" />
    </>
  );
}
