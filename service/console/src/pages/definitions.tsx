/**
 * 数据定义列表（ADR-0030，M360，结构参照旧 RenderWeave 的"数据结构设计"）：每个数据定义一张卡片，点开就是编辑页。
 * - 发布只产出静态版本，卡片不因发布改变；客户管理员能发布、删除；
 * - 操作员只读，这些入口不显示（权限以开放 API 为准）；
 * - 每个版本的详情与发布记录在静态数据定义里（static-schemas.tsx）。
 * 只调开放 API。编辑页在 definition-studio.tsx，发布与发布记录在 definition-publish.tsx。
 */
import { useState } from 'react';
import { versionLabel } from '../form/schema-version.js';
import { api, saveBlob } from '../api.js';
import { CLOCK, Icon, PLUS, PUBLISH, TRASH } from '../components/icon.js';
import { Modal } from '../components/modal.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { Identity, Problem, SchemaRef } from '../types.js';
import { DraftSheets, Loading } from '../components/motifs.js';

export const canEditDefinitions = (identity: Identity) => identity.role === 'admin';
export const definitionPath = (name: string) => ['definitions', name];
export const staticSchemaPath = (name: string, version: number | string) => ['static-schemas', name, String(version)];

/** 导出一个静态版本的编译产物：写法与发布的产物相同（缩进两格、末尾换行）。 */
export async function exportCompiled(ref: SchemaRef): Promise<void> {
  const { compiled } = await api.staticSchema(ref.name, ref.version);
  saveBlob(new Blob([`${JSON.stringify(compiled, null, 2)}\n`], { type: 'application/schema+json' }), `${ref.name.replace(/[\\/:*?"<>|]/g, '_')}-${versionLabel(ref.version)}.schema.json`);
}

/** 复制引用：模板的基准、数据集的 staticSchema 与字段的 ref 都这样写。答复制的结果，给页面显示。 */
export async function copyReference(ref: SchemaRef): Promise<string> {
  try {
    await navigator.clipboard.writeText(JSON.stringify({ name: ref.name, version: ref.version }));
    return `已复制 ${ref.name} ${versionLabel(ref.version)} 的引用`;
  } catch {
    return `浏览器不让复制，请手动写：${JSON.stringify({ name: ref.name, version: ref.version })}`;
  }
}

/** 在新标签页打开：用 window.open 才会带上本标签页的会话（sessionStorage）；target=_blank 的链接带不上，会回到登录页。 */
export const openInNewTab = (path: readonly string[]) => { window.open(href(path), '_blank'); };

/** 卡片上的时间写到分钟，完整的放在悬停提示里。 */
const time = (at: string) => new Date(at).toLocaleString('zh-CN');
const shortTime = (at: string) => new Date(at).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
type Sort = 'updated' | 'oldest' | 'name';
const SORTS: readonly (readonly [Sort, string])[] = [['updated', '最近改动'], ['oldest', '最早改动'], ['name', '名称']];

const loadDefinitions = async () => (await api.definitions()).definitions;
type DefinitionEntry = Awaited<ReturnType<typeof loadDefinitions>>[number];
/** 最近一次改动：看保存。发布不改数据定义。 */
const changedAt = (definition: DefinitionEntry) => definition.updatedAt;

export function DefinitionList(props: { readonly identity: Identity }) {
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(loadDefinitions, 'definitions');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('updated');
  const [removing, setRemoving] = useState<string>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const all = loaded.data;
  const query = search.trim().toLocaleLowerCase('zh-CN');
  const byName = (a: DefinitionEntry, b: DefinitionEntry) => (a.name < b.name ? -1 : 1);
  const definitions = (all ?? [])
    .filter((definition) => !query || [definition.name, definition.displayName].some((text) => text.toLocaleLowerCase('zh-CN').includes(query)))
    .sort((a, b) => {
      if (sort === 'name' || changedAt(a) === changedAt(b)) return byName(a, b);
      return (changedAt(a) < changedAt(b) ? 1 : -1) * (sort === 'updated' ? 1 : -1);
    });
  const remove = async (name: string) => {
    setProblems(undefined);
    try {
      await api.deleteDefinition(name);
      setRemoving(undefined);
      loaded.reload();
    } catch (error) { setProblems(problemsOf(error)); }
  };
  return (
    <section className="page">
      <div className="title-row">
        <h1>数据定义</h1>
        {canEdit && <button type="button" className="primary" aria-haspopup="dialog" onClick={() => setCreating(true)}><Icon d={PLUS} />新建数据定义</button>}
      </div>
      {creating && <NewDefinition onClose={() => setCreating(false)} />}
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
            <span className="small muted" data-testid="definition-count">{definitions.length} 个数据定义</span>
          </div>
          {definitions.length === 0 && (
            <div className="list-empty" data-testid="definitions-empty">
              <DraftSheets />
              <strong>{query ? '没有匹配的数据定义' : '还没有数据定义'}</strong>
              {!query && canEdit && <span>新建一份，发布之后模板和数据集就能用了。</span>}
            </div>
          )}
          <div className="schema-grid" aria-label="数据定义">
            {definitions.map((definition) => {
              const { name } = definition, latest = definition.versions.at(-1);
              return (
                <article key={name} className="schema-card" data-testid="definition-card" data-name={name}>
                  <a className="schema-card-body" href={href(definitionPath(name))}>
                    <span className="schema-card-head">
                      <span className="schema-card-title"><strong>{definition.displayName}</strong><code>{name}</code></span>
                      <span className="schema-pill" data-testid="definition-state"><span className={`dot ${latest ? 'ok' : 'accent'}`} aria-hidden="true" />{latest ? `已发布 ${versionLabel(latest.version)}` : '还没发布过'}</span>
                    </span>
                    <dl className="schema-facts draft-facts">
                      <div><dt>字段</dt><dd data-testid="definition-fields">{definition.fieldCount ?? '—'}</dd></div>
                      <div><dt>保存人</dt><dd title={definition.updatedBy}><span className="schema-fact-text">{definition.updatedBy}</span></dd></div>
                      <div><dt>最近保存</dt><dd title={time(definition.updatedAt)}><Icon d={CLOCK} /><span className="schema-fact-text">{shortTime(definition.updatedAt)}</span></dd></div>
                    </dl>
                  </a>
                  {canEdit && (
                    <footer className="schema-card-actions">
                      {removing === name
                        ? (
                          <>
                            <span className="small">{latest ? '删除这个数据定义？已发布的版本不受影响，这个名称不能再用。' : '删除这个数据定义？它还没发布过。'}</span>
                            <button type="button" className="small danger" onClick={() => void remove(name)}>确认删除</button>
                            <button type="button" className="small quiet" onClick={() => setRemoving(undefined)}>取消</button>
                          </>
                        )
                        : (
                          <>
                            <a className="button small quiet card-action publish" href={href([...definitionPath(name), 'publish'])}><Icon d={PUBLISH} />发布</a>
                            <button type="button" className="small quiet card-action remove" onClick={() => setRemoving(name)}><Icon d={TRASH} />删除</button>
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

/** 空白新建：名称是主键，建好就不能改，显示名称写给人看（M89 的中文写在显示名称里，数据定义的名称可以用中文）。 */
function NewDefinition(props: { readonly onClose: () => void }) {
  const [name, setName] = useState(''), [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const create = async () => {
    setBusy(true);
    setProblems(undefined);
    try {
      await api.createDefinition({ name: name.trim(), displayName: displayName.trim() || name.trim() });
      go(definitionPath(name.trim()));
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  return (
    <Modal title="新建数据定义" onClose={props.onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
        <div className="field">
          <label htmlFor="new-definition-name">名称</label>
          <input id="new-definition-name" type="text" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
          <span className="hint">名称是主键，建好就不能改；模板与数据集按名称和版本引用它。</span>
        </div>
        <div className="field">
          <label htmlFor="new-definition-display-name">显示名称</label>
          <input id="new-definition-display-name" type="text" maxLength={200} placeholder="不填就用名称" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        </div>
        <ErrorBox problems={problems} title="没有新建" />
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={props.onClose}>取消</button>
          <button type="submit" className="primary" disabled={!name.trim() || busy}>{busy ? '正在新建…' : '新建'}</button>
        </div>
      </form>
    </Modal>
  );
}
