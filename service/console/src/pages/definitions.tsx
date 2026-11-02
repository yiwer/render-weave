/**
 * 数据定义列表（P1 票据 06，M299，原型画板 06）：每个名称一行，当前版本、草案状态与引用数；新建与右键菜单。
 * - 客户管理员能新建、另起草案；操作员只读，这些入口不显示（权限以开放 API 为准）；
 * - "从示例图提取""从数据集提取"在 P2 接入前不显示，导入 JSON Schema 另排。
 * 只调开放 API。详情在 definition-detail.tsx，发布与发布记录在 definition-publish.tsx。
 */
import { useState, type MouseEvent } from 'react';
import { api, saveBlob } from '../api.js';
import { ContextMenu, type ContextMenuItem } from '../components/context-menu.js';
import { DefinitionTabs } from '../components/module-tabs.js';
import { ErrorBox } from '../components/problems.js';
import { go, href, problemsOf, useLoad } from '../hooks.js';
import type { Definition, Identity, Problem, SchemaRef } from '../types.js';

export const canEditDefinitions = (identity: Identity) => identity.role === 'admin';
export const definitionPath = (name: string) => ['definitions', name];

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

const usesText = (definition: Definition) => {
  const templates = definition.versions.reduce((sum, version) => sum + version.templates, 0), datasets = definition.versions.reduce((sum, version) => sum + version.datasets, 0);
  return templates + datasets === 0 ? undefined : `${templates.toLocaleString('zh-CN')} 个模板 · ${datasets.toLocaleString('zh-CN')} 份数据集`;
};

function DefinitionStatus(props: { readonly definition: Definition }) {
  const { definition } = props;
  if (definition.draft) return <span className="chip accent" data-testid="definition-status">有草案</span>;
  return usesText(definition) ? <span className="chip ok" data-testid="definition-status">已发布</span> : <span className="chip" data-testid="definition-status">未被使用</span>;
}

export function DefinitionList(props: { readonly identity: Identity }) {
  const canEdit = canEditDefinitions(props.identity);
  const loaded = useLoad(() => api.definitions(), 'definitions');
  const [creating, setCreating] = useState(false);
  const [menu, setMenu] = useState<{ readonly definition: Definition; readonly at: { readonly x: number; readonly y: number } }>();
  const [problems, setProblems] = useState<readonly Problem[]>();
  const [notice, setNotice] = useState<string>();
  const definitions = loaded.data?.definitions;
  /** 菜单的动作：失败时显示问题，不离开这一页。 */
  const attempt = async (action: () => Promise<void>) => {
    setProblems(undefined);
    setNotice(undefined);
    try { await action(); } catch (error) { setProblems(problemsOf(error)); }
  };
  const itemsOf = (definition: Definition): ContextMenuItem[] => {
    const latest = definition.versions.at(-1), ref = latest && { name: definition.name, version: latest.version };
    const hint = latest && `v${latest.version}`;
    return [
      { label: '打开', run: () => go(definitionPath(definition.name)) },
      { label: '在新标签页打开', run: () => openInNewTab(definitionPath(definition.name)) },
      { label: '查看发布记录', run: () => go(['definition-publications'], { name: definition.name }) },
      ...(ref ? [
        { label: '导出编译产物 JSON Schema', hint: hint!, run: () => void attempt(() => exportCompiled(ref)) },
        { label: '复制引用', hint: hint!, run: () => void attempt(async () => setNotice(await copyReference(ref))) },
      ] : []),
      ...(ref && canEdit ? [{
        label: '从这一版另起草案', hint: definition.draft ? '已有草案' : hint!, disabled: Boolean(definition.draft),
        run: () => void attempt(async () => {
          await api.createDefinitionDraft(definition.name, { fromVersion: ref.version });
          go(definitionPath(definition.name));
        }),
      }] : []),
    ];
  };
  const openMenu = (event: MouseEvent, definition: Definition) => {
    event.preventDefault();
    setMenu({ definition, at: { x: event.clientX, y: event.clientY } });
  };
  return (
    <section className="page">
      <div className="title-row">
        <h1>数据定义</h1>
        {canEdit && <button type="button" className="primary" aria-expanded={creating} onClick={() => setCreating(!creating)}>新建数据定义</button>}
      </div>
      <DefinitionTabs active="all" />
      {creating && <NewDefinition />}
      <ErrorBox problems={problems} title="没有完成" />
      <ErrorBox problems={loaded.problems} title="读不到数据定义" />
      {notice && <p className="small muted" role="status">{notice}</p>}
      {loaded.loading && !definitions && <p className="muted">正在读取…</p>}
      {definitions && (
        <div className="card">
          <table className="table definition-table">
            <thead><tr><th>名称</th><th>版本</th><th>谁在用</th><th>状态</th><th><span className="visually-hidden">操作</span></th></tr></thead>
            <tbody>
              {definitions.length === 0 && <tr><td colSpan={5} className="muted">还没有数据定义。{canEdit ? '新建一个，或者让代建工程师推送。' : '客户管理员新建或代建工程师推送之后，这里就有了。'}</td></tr>}
              {definitions.map((definition) => {
                const latest = definition.versions.at(-1), uses = usesText(definition);
                return (
                  <tr key={definition.name} data-testid="definition-row" data-name={definition.name} onContextMenu={(event) => openMenu(event, definition)}
                    onClick={(event) => { if (!(event.target as HTMLElement).closest('a, button')) go(definitionPath(definition.name)); }}>
                    <td>
                      <a className="row-link" href={href(definitionPath(definition.name))}>{definition.displayName}</a>
                      {definition.displayName !== definition.name && <div className="mono muted">{definition.name}</div>}
                    </td>
                    <td data-testid="definition-version">
                      {latest ? <strong>v{latest.version}</strong> : <span className="muted">还没发布</span>}
                      {definition.draft && <div className="small muted">草案{definition.draft.baseVersion ? ` · 基于 v${definition.draft.baseVersion}` : ''}</div>}
                    </td>
                    <td data-testid="definition-uses">{uses ?? <span className="muted">还没有模板或数据集在用</span>}</td>
                    <td><DefinitionStatus definition={definition} /></td>
                    <td className="row-tools">
                      <button type="button" className="icon" aria-haspopup="menu" aria-label={`${definition.displayName} 的更多操作`}
                        onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); setMenu({ definition, at: { x: box.left, y: box.bottom + 4 } }); }}>⋯</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {menu && <ContextMenu label={`${menu.definition.displayName} 的操作`} at={menu.at} items={itemsOf(menu.definition)} onClose={() => setMenu(undefined)} />}
      <p className="table-note">发布后的版本不可修改，模板与数据集都绑定到具体版本。右键一行查看更多操作。</p>
    </section>
  );
}

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
