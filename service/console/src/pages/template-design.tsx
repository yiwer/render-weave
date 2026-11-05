/**
 * 模板设计（P1 票据 08，M205、M299、M356，原型画板 10）：客户管理员不写 DSL 也能做小改。只给客户管理员，操作员看只读预览。
 * - 左边是工作副本的草稿预览：按布局摘要的元素框点选，按元素定位打开模板文档里的位置；元素在子模板里时切到子模板，预览仍是调用它的模板；
 * - 右边是属性、参数、结构、规则四页，都从模板文档与 Schema 生成（template/properties.ts）；只能填数，不做拖拽；
 * - 每次改动写回工作副本，再重渲染、刷新问题清单（template/session.ts）；撤销与重做只在这一页里；"保存"是立刻暂存，改了没点保存就离开要提醒（M383），"发布修订"去下一页；
 * - 正式模式：预览接口只出草稿，两种模式的问题清单相同（docs/render-modes.md），所以这里按问题清单说正式出图的结果：有严重问题时不出图。
 * "让 Agent 修改""留评论"在 P2、P4 接入前不显示。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { problemMarks } from '../components/preview-canvas.js';
import { defaultOutput, defaultParameters } from '../components/parameters.js';
import { countText, ErrorBox, ProblemList } from '../components/problems.js';
import { FieldRow, FieldRows, type FieldContext } from '../components/property-fields.js';
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import { go, guardNavigation, href, useLivePreview, useLoad, type LivePreview, type Route } from '../hooks.js';
import { documentInfo, elementAt, elementTree, elementVariables, flatElements, hitElement, isObject, parseTemplateText, relatedChecks, variableKind, type ElementNode, type JsonObject } from '../template/document.js';
import { ELEMENT_TYPES, fieldByKey, listItemPanel, propertyPanel, writeListItem, writeProperty, type FieldPath, type PropertyField } from '../template/properties.js';
import { createDesignSession, leaveQuestion, type DesignDoc, type DesignSession } from '../template/session.js';
import type { Identity, LayoutNode, PreviewReply, Problem } from '../types.js';
import { datasetRef, sameSchema } from './templates.js';
import { Loading } from '../components/motifs.js';

type Tab = 'properties' | 'parameters' | 'structure' | 'rules';
const TABS: readonly (readonly [Tab, string])[] = [['properties', '属性'], ['parameters', '参数'], ['structure', '结构'], ['rules', '规则']];
const ZOOMS = [0.5, 0.75, 1, 1.5, 2, 3, 4];
const STRESS = /压测|压力|stress/i;

/** 选中的元素：path 是它在模板文档里的路径，instance 是图上的那一个实例（带调用链与循环序号）。 */
interface Selection { readonly template: string; readonly path: string; readonly instance?: string }
interface MenuState { readonly x: number; readonly y: number; readonly template: string; readonly path: string; readonly instance?: string }

export function TemplateDesign(props: { readonly name: string; readonly root: string; readonly identity: Identity }) {
  if (props.identity.role !== 'admin') {
    return <section className="page"><p className="muted">模板设计只给客户管理员。<a href={href(['templates', props.name])}>看只读预览</a></p></section>;
  }
  return <Design name={props.name} root={props.root} />;
}

function Design(props: { readonly name: string; readonly root: string }) {
  const { name, root } = props;
  const session = useMemo(createDesignSession, []);
  const state = useSyncExternalStore(session.subscribe, session.getState);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => { void session.open(root); }, [session, root]);
  useEffect(() => { void session.open(name); }, [session, name]);
  const rootDoc = state.docs.get(root), doc = state.docs.get(name);

  const [selection, setSelection] = useState<Selection>();
  const [tab, setTab] = useState<Tab>('properties');
  const [datasetId, setDatasetId] = useState<string>();
  const [finalMode, setFinalMode] = useState(false);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState<MenuState>();
  const [notice, setNotice] = useState<string>();
  const [locateTick, setLocateTick] = useState(0);
  const [openParameter, setOpenParameter] = useState<string>();

  const openTemplate = (template: string) => go(['templates', template, 'design'], template === root ? {} : { in: root });

  // 预览用暂存过的内容：改动写回之后才有新图，请求里的对外参数也取那一份。
  const rootInfo = useMemo(() => (rootDoc ? documentInfo(root, parseTemplateText(rootDoc.savedText)) : undefined), [root, rootDoc?.savedText]);
  const datasets = useLoad(() => api.datasets(), 'design-datasets');
  const samples = useMemo(() => (datasets.data?.datasets ?? []).filter((entry) => sameSchema(entry.staticSchema, rootInfo?.base)), [datasets.data, rootInfo?.base]);
  const chosen = datasetId ?? samples[0]?.id ?? '';
  const request = useMemo(() => {
    if (!rootInfo?.base || !rootInfo.sizeRange || !datasets.data) return undefined;
    const output = defaultOutput(rootInfo), longest = Math.max(output.width, output.height);
    // 图约 1400 像素，放大时跟着提高分辨率；上限 200 DPI，改一处不用等太久。
    const dpi = Math.min(200, Math.max(30, Math.round((1400 * zoom * 25.4) / longest)));
    return { template: root, dataset: datasetRef(rootInfo.base, chosen || undefined), parameters: defaultParameters(rootInfo), output: { ...output, dpi } };
  }, [root, rootInfo, chosen, zoom, datasets.data]);
  const preview = useLivePreview(request, 120, { workingCopies: true, version: String(state.stashes) });
  const reply = preview.reply;

  // 还没开工作副本时没有什么可比的（第一次写回才开）。
  const check = useLoad(() => (doc?.opened ? api.checkWorkingCopy(name) : Promise.resolve(undefined)), `${name}\n${doc?.opened ?? ''}\n${doc?.sha256 ?? ''}`);
  // 复制出来还没保存的新模板没有修订可比，整份都算未发布。
  const unpublished = doc && !doc.opened ? 0 : check.data && (check.data.changes.status === 'added' ? 1 : check.data.changes.changes.length);

  const locations = useMemo(() => new Map((reply?.elements ?? []).map((element) => [element.path, element.source])), [reply?.elements]);
  const select = (template: string, path: string, instance?: string) => {
    setSelection({ template, path, ...(instance ? { instance } : {}) });
    if (tab === 'parameters') setTab('properties');
    if (template !== name) openTemplate(template);
  };
  const pick = (instance: string) => {
    const source = locations.get(instance);
    if (source) select(source.template, source.path, instance);
  };
  const selected = selection?.template === name ? selection : undefined;

  const undo = () => { const template = session.undo(); if (template && template !== name) openTemplate(template); };
  const redo = () => { const template = session.redo(); if (template && template !== name) openTemplate(template); };
  const save = () => { void session.save(); };
  // 发布修订是往下走，改动都带过去，不用问。
  const leaving = useRef(false);
  const publish = async () => {
    await session.flush();
    leaving.current = true;
    go(['templates', name, 'publish'], root === name ? {} : { in: root });
  };

  // 快捷键：Ctrl+S、Ctrl+Z、Ctrl+Y；V、H 切工具，打字时不算。
  const keys = useRef({ undo, redo, save });
  keys.current = { undo, redo, save };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === 's') { event.preventDefault(); keys.current.save(); }
        else if (key === 'z' && event.shiftKey) { event.preventDefault(); keys.current.redo(); }
        else if (key === 'z') { event.preventDefault(); keys.current.undo(); }
        else if (key === 'y') { event.preventDefault(); keys.current.redo(); }
        return;
      }
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.isComposing || target?.closest('input, select, textarea')) return;
      if (key === 'v') setTool('select');
      if (key === 'h') setTool('pan');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // 改了没点保存就离开先问（M383）：换页、关窗口、退出登录。切子模板还在这个编辑会话里，不算离开。
  const latest = useRef(state);
  latest.current = state;
  const dirty = state.unsaved > 0 || state.unconfirmed > 0;
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    const staysHere = (target?: Route) => target?.path[0] === 'templates' && target.path[2] === 'design' && (target.query.get('in') ?? target.path[1]) === root;
    const release = guardNavigation((target) => leaving.current || staysHere(target) || window.confirm(leaveQuestion(latest.current)));
    return () => { window.removeEventListener('beforeunload', warn); release(); };
  }, [dirty, root]);

  const copyPath = async (text: string) => {
    setMenu(undefined);
    try { await navigator.clipboard.writeText(text); setNotice(`已复制元素路径 ${text}`); }
    catch { setNotice(`复制不了，路径是 ${text}`); }
  };

  const failures = [...state.docs.values()].filter((item) => item.failure);
  const groupedSamples = { normal: samples.filter((entry) => !STRESS.test(entry.name ?? entry.id)), stress: samples.filter((entry) => STRESS.test(entry.name ?? entry.id)) };
  const severe = reply?.problems.filter((problem) => problem.level === 'severe').length ?? 0;
  return (
    <section className="design" aria-label={`模板设计 ${name}`}>
      <div className="design-toolbar" role="toolbar" aria-label="模板设计">
        <nav className="crumbs" aria-label="位置">
          <a href={href(['templates'])}>模板</a><span aria-hidden="true">/</span>
          {root === name ? <strong>{name}</strong> : <><a href={href(['templates', root, 'design'])}>{root}</a><span aria-hidden="true">/</span><strong>{name}</strong></>}
        </nav>
        <span className={`chip ${dirty ? 'warn' : 'ok'}`} data-testid="unsaved-count">{state.unsaved ? `${state.unsaved} 处未保存` : state.saving ? '正在暂存…' : state.unconfirmed ? '已暂存，未保存' : '已保存'}</span>
        {unpublished !== undefined && <span className="chip" data-testid="unpublished-count">{check.data?.changes.status === 'added' ? '新模板，未发布' : `${unpublished} 处未发布`}</span>}
        {check.data?.conflict && <span className="chip warn" data-testid="base-changed">基准已变，发布时看两边差异</span>}
        <span className="toolbar-gap" />
        <button type="button" className="small quiet" disabled={!state.canUndo} onClick={undo} aria-keyshortcuts="Control+Z">撤销</button>
        <button type="button" className="small quiet" disabled={!state.canRedo} onClick={redo} aria-keyshortcuts="Control+Y">重做</button>
        <span className="segmented" role="group" aria-label="工具">
          <button type="button" className="small" aria-pressed={tool === 'select'} onClick={() => setTool('select')} aria-keyshortcuts="V">选择</button>
          <button type="button" className="small" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')} aria-keyshortcuts="H">平移</button>
        </span>
        <label className="visually-hidden" htmlFor="design-dataset">样例数据集</label>
        <select id="design-dataset" className="toolbar-select" value={chosen} onChange={(event) => setDatasetId(event.target.value)}>
          {groupedSamples.normal.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
          {groupedSamples.stress.length > 0 && (
            <optgroup label="压测数据">
              {groupedSamples.stress.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
            </optgroup>
          )}
          <option value="">空白数据（显示占位）</option>
        </select>
        <span className="segmented" role="group" aria-label="模式">
          <button type="button" className="small" aria-pressed={!finalMode} onClick={() => setFinalMode(false)}>草稿</button>
          <button type="button" className="small" aria-pressed={finalMode} onClick={() => setFinalMode(true)}>正式</button>
        </span>
        <button type="button" className="small" onClick={save} aria-keyshortcuts="Control+S" disabled={!dirty}>保存</button>
        <button type="button" className="small primary" disabled={!unpublished} title={unpublished ? undefined : '还没有改动'} onClick={() => void publish()}>发布修订</button>
      </div>
      {notice && <p className="notice design-notice" role="status">{notice}<button type="button" className="link" onClick={() => setNotice(undefined)}>知道了</button></p>}
      <ErrorBox problems={state.problems} title="打不开工作副本" />
      {failures.map((item) => <SaveFailure key={item.name} doc={item} session={session} />)}
      <div className="design-body">
        <div className="design-main">
          <DesignCanvas preview={preview} finalMode={finalMode} tool={tool} zoom={zoom} selected={selected} severe={severe} onPick={pick}
            onMenu={(x, y, instance) => {
              const source = locations.get(instance);
              if (!source) return;
              select(source.template, source.path, instance);
              setMenu({ x, y, template: source.template, path: source.path, instance });
            }} />
          <div className="design-foot">
            <span className="zoom" role="group" aria-label="缩放">
              <button type="button" className="small quiet" aria-label="缩小" disabled={zoom <= ZOOMS[0]!} onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)]!)}>−</button>
              <button type="button" className="small quiet" data-testid="zoom-level" title="恢复适应窗口" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
              <button type="button" className="small quiet" aria-label="放大" disabled={zoom >= ZOOMS.at(-1)!} onClick={() => setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)]!)}>+</button>
            </span>
            <span className="design-status" aria-live="polite" data-testid="design-status">
              {preview.waiting ? '预览太频繁，稍后自动重试…' : preview.loading ? '正在出草稿预览…' : reply
                ? `${finalMode ? '正式' : '草稿'}${reply.image ? ` · ${reply.image.dpi} DPI · ${reply.image.widthPx} × ${reply.image.heightPx} 像素` : ''} · ${countText(reply.problems)}` : ''}
            </span>
          </div>
          <div className="design-problems">
            <ErrorBox problems={preview.problems} title="预览失败" />
            {reply && <ProblemsOfPreview reply={reply} finalMode={finalMode} onPick={pick} />}
          </div>
        </div>
        <aside className="design-inspector" aria-label="检查器">
          <div className="tabs" role="tablist" aria-label="检查器">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : undefined} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          {doc ? (
            <Inspector tab={tab} doc={doc} session={session} selected={selected} reply={reply} locateTick={locateTick} openParameter={openParameter} onOpenParameter={setOpenParameter}
              onSelect={(path) => select(name, path)} onSelected={setSelection} onOpenTemplate={openTemplate}
              onMenu={(x, y, path) => { select(name, path); setMenu({ x, y, template: name, path }); }} />
          ) : <Loading>正在读取工作副本…</Loading>}
          <p className="table-note">属性按模板的 Schema 生成，只能填数；出图一直读当前修订，发布之后才生效。</p>
        </aside>
      </div>
      {menu && doc && (
        <ElementMenu menu={menu} doc={doc} onClose={() => setMenu(undefined)} onCopy={(text) => void copyPath(text)}
          onLocate={() => { setMenu(undefined); setTab('structure'); setLocateTick((value) => value + 1); }}
          onParameter={(parameter) => { setMenu(undefined); setOpenParameter(parameter); setTab('parameters'); }} />
      )}
    </section>
  );
}

function SaveFailure(props: { readonly doc: DesignDoc; readonly session: DesignSession }) {
  const { doc, session } = props, failure = doc.failure!;
  return (
    <div className="error-box" role="alert" data-testid="save-failure">
      <strong>{doc.name} 的改动没有写回</strong>
      <ProblemList problems={failure.problems} />
      <div className="actions">
        {failure.stale && <button type="button" className="small danger" onClick={() => void session.overwrite(doc.name)}>用这里的盖过去</button>}
        {(failure.stale || failure.missing) && <button type="button" className="small" onClick={() => void session.reload(doc.name)}>{failure.missing ? '重新打开（这里的改动不要了）' : '读回最新内容（这里的改动不要了）'}</button>}
        {!failure.stale && !failure.missing && <button type="button" className="small" onClick={() => void session.flush()}>重试</button>}
      </div>
    </div>
  );
}

function ProblemsOfPreview(props: { readonly reply: PreviewReply; readonly finalMode: boolean; readonly onPick: (instance: string) => void }) {
  const { reply, finalMode } = props;
  const numbers = useMemo(() => new Map(problemMarks(reply).map((mark, index) => [mark.problem, index + 1])), [reply]);
  const [chosen, setChosen] = useState<Problem>();
  const severe = reply.problems.filter((problem) => problem.level === 'severe').length;
  return (
    <>
      {finalMode && <p className="small muted" data-testid="final-mode-note">{severe ? `正式出图时不出图：有 ${severe} 个严重问题。` : reply.problems.length ? '正式出图的图上没有问题边框，这里仍是草稿的图。' : '没有问题：这张图与正式出图相同。'}</p>}
      <ProblemList problems={reply.problems} numbers={finalMode ? new Map() : numbers} selected={chosen} label="预览的问题"
        onSelect={(problem) => { setChosen(problem); if (problem.location.kind === 'element') props.onPick(problem.location.path); }} />
    </>
  );
}

function flatten(node: LayoutNode | undefined, into = new Map<string, LayoutNode>()): Map<string, LayoutNode> {
  if (!node) return into;
  into.set(node.path, node);
  (node.children ?? []).forEach((child) => flatten(child, into));
  return into;
}

function DesignCanvas(props: {
  readonly preview: LivePreview; readonly finalMode: boolean; readonly tool: 'select' | 'pan'; readonly zoom: number; readonly selected?: Selection; readonly severe: number;
  readonly onPick: (instance: string) => void; readonly onMenu: (x: number, y: number, instance: string) => void;
}) {
  const { preview, finalMode, tool, zoom, selected } = props, reply = preview.reply, image = reply?.image, layout = reply?.layout;
  const stage = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(640);
  const aspect = layout ? layout.output.width / layout.output.height : 1;
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = () => setFit(Math.max(120, Math.min(element.clientWidth - 64, (element.clientHeight - 64) * aspect)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [aspect]);

  const nodes = useMemo(() => flatten(layout?.root), [layout]);
  const percent = (node: LayoutNode) => (layout ? { left: `${(node.x / layout.output.width) * 100}%`, top: `${(node.y / layout.output.height) * 100}%`, width: `${(node.width / layout.output.width) * 100}%`, height: `${(node.height / layout.output.height) * 100}%` } : {});
  const instances = useMemo(() => (selected ? (reply?.elements ?? []).filter((element) => element.source.template === selected.template && element.source.path === selected.path).map((element) => element.path) : []), [reply?.elements, selected]);
  const main = selected?.instance && instances.includes(selected.instance) ? selected.instance : instances[0];
  const marks = useMemo(() => (reply && !finalMode ? problemMarks(reply) : []), [reply, finalMode]);

  const hit = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!layout) return undefined;
    const box = event.currentTarget.getBoundingClientRect();
    return hitElement(layout.root, ((event.clientX - box.left) / box.width) * layout.output.width, ((event.clientY - box.top) / box.height) * layout.output.height);
  };
  // 平移：按住拖动滚动台面。
  const drag = useRef<{ readonly x: number; readonly y: number; readonly left: number; readonly top: number } | undefined>(undefined);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tool !== 'pan' || !stage.current) return;
    drag.current = { x: event.clientX, y: event.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !stage.current) return;
    stage.current.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
    stage.current.scrollTop = drag.current.top - (event.clientY - drag.current.y);
  };
  const blocked = finalMode && props.severe > 0;
  return (
    <div className={`design-stage tool-${tool}${preview.loading ? ' busy' : ''}`} ref={stage} data-testid="design-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}>
      {image && layout && !blocked ? (
        <div className="design-canvas" data-testid="design-canvas" style={{ width: fit * zoom }}
          onClick={(event) => { if (tool !== 'select') return; const node = hit(event); if (node) props.onPick(node.path); }}
          onContextMenu={(event) => { const node = hit(event); if (!node) return; event.preventDefault(); props.onMenu(event.clientX, event.clientY, node.path); }}>
          <img data-testid="preview-image" src={`data:image/${image.format};base64,${image.base64}`} alt="工作副本的草稿预览" draggable={false} />
          {marks.map((mark, index) => (
            <span key={index} className={`mark ${mark.problem.level}`} data-testid="problem-mark" style={{ left: `${mark.box.left}%`, top: `${mark.box.top}%`, width: `${mark.box.width}%`, height: `${mark.box.height}%` }} title={mark.problem.message}>
              <span className="marker-number">{index + 1}</span>
            </span>
          ))}
          {instances.filter((path) => path !== main).map((path) => { const node = nodes.get(path); return node ? <span key={path} className="select-box other" style={percent(node)} /> : null; })}
          {main && nodes.get(main) && (
            <span className="select-box" data-testid="select-box" data-path={main} style={percent(nodes.get(main)!)}><span className="select-tag" data-testid="select-tag">{main}</span></span>
          )}
        </div>
      ) : (
        <div className="stage-empty">{blocked ? `正式模式不出图：有 ${props.severe} 个严重问题，见下方清单` : reply ? '没有图片：问题见下方清单' : preview.problems ? '预览失败' : '正在出草稿预览…'}</div>
      )}
    </div>
  );
}

/** 右键菜单：复制元素路径、在结构中定位、打开绑定的字段。 */
function ElementMenu(props: {
  readonly menu: MenuState; readonly doc: DesignDoc; readonly onClose: () => void; readonly onCopy: (text: string) => void; readonly onLocate: () => void; readonly onParameter: (name: string) => void;
}) {
  const { menu, doc } = props, root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) props.onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key); };
  }, []);
  const element = elementAt(doc.document, menu.path)?.element;
  const variables = element ? elementVariables(element) : [];
  const base = isObject(doc.document['base']) ? String(doc.document['base']['name']) : undefined;
  const bound = variables.filter((name) => variableKind(doc.document, name.split('.')[0]!) !== 'derived');
  return (
    <div className="menu element-menu" role="menu" aria-label="元素" ref={root} data-testid="element-menu" style={{ left: menu.x, top: menu.y }}>
      <button type="button" role="menuitem" onClick={() => props.onCopy(menu.instance ?? menu.path)}>复制元素路径</button>
      <button type="button" role="menuitem" onClick={props.onLocate}>在结构中定位</button>
      {bound.map((name) => (variableKind(doc.document, name.split('.')[0]!) === 'parameter'
        ? <button key={name} type="button" role="menuitem" onClick={() => props.onParameter(name)}>打开绑定的参数 {name}</button>
        : <a key={name} role="menuitem" href={href(['definitions', base ?? ''], { field: name })} onClick={props.onClose}>打开绑定的字段 {name}</a>))}
      {bound.length === 0 && <span className="menu-empty small muted">没有绑定的字段</span>}
    </div>
  );
}

/** 建议项：变量、字段与资源。内置的数据定义（单值文本）没有静态版本，只是少几条建议。 */
function useFieldLists(doc: DesignDoc): { readonly lists: FieldContext['lists']; readonly element: ReactNode } {
  const base = isObject(doc.document['base']) ? doc.document['base'] as { name: string; version: number } : undefined;
  const compiled = useLoad(() => (base ? api.staticSchema(base.name, base.version).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${base?.name}@${base?.version}`);
  const resources = useLoad(() => api.resources(), 'design-resources');
  const fields = useMemo(() => {
    if (!compiled.data) return [];
    const names: string[] = [];
    for (const field of formOf(compiled.data.compiled as FormObject).fields) {
      names.push(field.name);
      if (field.spec.kind === 'object') for (const inner of field.spec.fields) names.push(`${field.name}.${inner.name}`);
    }
    return names;
  }, [compiled.data]);
  const named = (list: string) => (Array.isArray(doc.document[list]) ? (doc.document[list] as unknown[]).flatMap((item) => (isObject(item) && typeof item['name'] === 'string' ? [item['name']] : [])) : []);
  const variables = [...named('parameters'), ...named('derived'), ...fields];
  const refs = (kind: 'font' | 'image') => (resources.data?.resources ?? []).filter((resource) => resource.kind === kind).map((resource) => `res:${resource.id}`);
  const options = (id: string, values: readonly string[]) => <datalist id={id}>{values.map((value) => <option key={value} value={value} />)}</datalist>;
  return {
    lists: { variable: 'design-variables', field: 'design-fields', font: 'design-fonts', image: 'design-images' },
    element: <>{options('design-variables', variables)}{options('design-fields', fields)}{options('design-fonts', refs('font'))}{options('design-images', refs('image'))}</>,
  };
}

function Inspector(props: {
  readonly tab: Tab; readonly doc: DesignDoc; readonly session: DesignSession; readonly selected?: Selection; readonly reply?: PreviewReply; readonly locateTick: number;
  readonly openParameter?: string; readonly onOpenParameter: (name: string | undefined) => void;
  readonly onSelect: (path: string) => void; readonly onSelected: (selection: Selection) => void; readonly onOpenTemplate: (template: string) => void; readonly onMenu: (x: number, y: number, path: string) => void;
}) {
  const { tab, doc, session, selected } = props;
  const { lists, element } = useFieldLists(doc);
  const edit = (document: JsonObject, key: string) => session.edit(doc.name, document, key);
  return (
    <>
      {element}
      {tab === 'properties' && (
        <PropertiesTab key={`${doc.name}\n${selected?.path ?? ''}`} doc={doc} selected={selected} reply={props.reply} lists={lists} onEdit={edit} onSelect={props.onSelect} onSelected={props.onSelected} onOpenTemplate={props.onOpenTemplate} />
      )}
      {tab === 'parameters' && <ParametersTab key={doc.name} doc={doc} lists={lists} open={props.openParameter} onOpen={props.onOpenParameter} onEdit={edit} />}
      {tab === 'structure' && <StructureTab doc={doc} selected={selected} locateTick={props.locateTick} onSelect={props.onSelect} onOpenTemplate={props.onOpenTemplate} onMenu={props.onMenu} />}
      {tab === 'rules' && <RulesTab key={`${doc.name}\n${selected?.path ?? ''}`} doc={doc} selected={selected} reply={props.reply} lists={lists} onEdit={edit} onSelect={props.onSelect} />}
    </>
  );
}

function PropertiesTab(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly reply?: PreviewReply; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void;
  readonly onSelect: (path: string) => void; readonly onSelected: (selection: Selection) => void; readonly onOpenTemplate: (template: string) => void;
}) {
  const { doc, selected, reply } = props;
  const path = selected?.path, panel = path ? propertyPanel(doc.document, path) : undefined;
  if (!path || !panel) {
    return (
      <div className="inspector-empty">
        <p className="muted">在图上点选一个元素，或者到结构页里选。</p>
        <button type="button" className="small quiet" onClick={() => props.onSelect(doc.name)}>选中画板</button>
      </div>
    );
  }
  const segments = path.split('/'), element = elementAt(doc.document, path)?.element;
  const shown = !reply?.elements || reply.elements.some((item) => item.source.template === doc.name && item.source.path === path);
  const context: FieldContext = {
    lists: props.lists,
    onWrite: (fieldPath: FieldPath, value: unknown) => {
      props.onEdit(writeProperty(doc.document, path, fieldPath, value), `${path}:${fieldPath.join('.')}`);
      // 改名之后元素路径跟着变，选中不丢。
      if (fieldPath.length === 1 && fieldPath[0] === 'name' && typeof value === 'string') props.onSelected({ template: doc.name, path: [...segments.slice(0, -1), value].join('/') });
    },
  };
  const template = typeof element?.['template'] === 'string' ? element['template'] : undefined;
  return (
    <div data-testid="properties" data-path={path} data-type={panel.type}>
      <div className="inspector-head">
        <h2>{segments.at(-1)}</h2>
        <span className="small muted">{ELEMENT_TYPES[panel.type] ?? panel.type}</span>
      </div>
      <nav className="element-path" aria-label="元素路径" data-testid="selected-path">
        {segments.map((segment, index) => {
          const prefix = segments.slice(0, index + 1).join('/');
          return <span key={prefix}>{index > 0 && <span aria-hidden="true">/</span>}{index === segments.length - 1 ? <code>{segment}</code> : <button type="button" className="link mono" onClick={() => props.onSelect(prefix)}>{segment}</button>}</span>;
        })}
      </nav>
      {!shown && <p className="small muted">当前数据下这个元素不显示，图上没有框。</p>}
      {template && <p className="small"><button type="button" className="link" onClick={() => props.onOpenTemplate(template)}>打开子模板 {template}</button></p>}
      {panel.groups.map((group) => (
        <section key={group.name} className="prop-section" aria-label={group.name}>
          <h3>{group.name}</h3>
          <FieldRows fields={group.fields} context={context} />
        </section>
      ))}
    </div>
  );
}

const PARAMETER_TYPES: Readonly<Record<string, string>> = { text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片', color: '颜色' };

function ParametersTab(props: {
  readonly doc: DesignDoc; readonly lists: FieldContext['lists']; readonly open?: string; readonly onOpen: (name: string | undefined) => void; readonly onEdit: (document: JsonObject, key: string) => void;
}) {
  const { doc, open } = props;
  const [name, setName] = useState('');
  const parameters = Array.isArray(doc.document['parameters']) ? (doc.document['parameters'] as unknown[]).filter(isObject) : [];
  const trimmed = name.trim(), taken = parameters.some((item) => item['name'] === trimmed), valid = trimmed !== '' && !trimmed.includes('.') && !taken;
  const add = () => {
    props.onEdit({ ...doc.document, parameters: [...parameters, { name: trimmed, displayName: trimmed, visibility: 'public', type: 'text', default: '' }] }, `parameters:add:${trimmed}`);
    props.onOpen(trimmed);
    setName('');
  };
  const section = (title: string, visibility: string) => {
    const shown = parameters.filter((item) => item['visibility'] === visibility);
    return (
      <section className="prop-section" aria-label={title}>
        <h3>{title}</h3>
        {shown.length === 0 && <p className="small muted">没有。</p>}
        {shown.map((parameter) => {
          const parameterName = String(parameter['name']), index = parameters.indexOf(parameter), expanded = open === parameterName;
          const context: FieldContext = {
            lists: props.lists,
            onWrite: (path, value) => props.onEdit(writeListItem(doc.document, 'parameters', index, path, value), `parameters:${parameterName}:${path.join('.')}`),
          };
          return (
            <div key={parameterName} className={`list-row${expanded ? ' selected' : ''}`} data-testid="parameter-row" data-name={parameterName}>
              <button type="button" className="list-row-button" aria-expanded={expanded} onClick={() => props.onOpen(expanded ? undefined : parameterName)}>
                <span>{String(parameter['displayName'] ?? parameterName)}</span>
                <span className="small muted mono">{parameterName} · {PARAMETER_TYPES[String(parameter['type'])] ?? String(parameter['type'])}</span>
              </button>
              {expanded && (
                <div className="list-row-body">
                  {listItemPanel(doc.document, 'parameters', index).map((field) => <FieldRow key={field.key} field={field} context={context} />)}
                  <button type="button" className="link danger" onClick={() => { props.onEdit({ ...doc.document, parameters: parameters.filter((item) => item !== parameter) }, `parameters:delete:${parameterName}`); props.onOpen(undefined); }}>删除这个参数</button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    );
  };
  return (
    <div data-testid="parameters">
      {section('对外参数', 'public')}
      {section('内部参数', 'internal')}
      <form className="prop-actions" aria-label="添加参数" onSubmit={(event) => { event.preventDefault(); if (valid) add(); }}>
        <input type="text" aria-label="新参数的名称" placeholder="新参数的名称，一般用英文" value={name} onChange={(event) => setName(event.target.value)} aria-invalid={taken ? true : undefined} />
        <button type="submit" className="small quiet" disabled={!valid}>添加参数</button>
      </form>
    </div>
  );
}

function StructureTab(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly locateTick: number; readonly onSelect: (path: string) => void; readonly onOpenTemplate: (template: string) => void; readonly onMenu: (x: number, y: number, path: string) => void;
}) {
  const { doc, selected } = props, tree = useMemo(() => elementTree(doc.document, doc.name), [doc.document, doc.name]);
  const root = useRef<HTMLUListElement>(null);
  // 预览上选中了、或右键"在结构中定位"：滚到这一行。
  useEffect(() => {
    root.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.path, props.locateTick]);
  const row = (node: ElementNode) => (
    <li key={node.path}>
      <div className="tree-row" data-testid="structure-row" data-path={node.path} data-selected={selected?.path === node.path}
        onContextMenu={(event) => { event.preventDefault(); props.onMenu(event.clientX, event.clientY, node.path); }}>
        <button type="button" className="tree-button" aria-current={selected?.path === node.path ? 'true' : undefined} onClick={() => props.onSelect(node.path)}>
          <span>{node.name}</span><span className="small muted">{ELEMENT_TYPES[node.type] ?? node.type}</span>
        </button>
        {node.template && <button type="button" className="link small" onClick={() => props.onOpenTemplate(node.template!)}>打开 {node.template}</button>}
      </div>
      {node.children.length > 0 && <ul>{node.children.map(row)}</ul>}
    </li>
  );
  return <ul className="tree" ref={root} data-testid="structure">{row(tree)}</ul>;
}

function RulesTab(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly reply?: PreviewReply; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void; readonly onSelect: (path: string) => void;
}) {
  const { doc, selected, reply } = props;
  const [openCheck, setOpenCheck] = useState<number>();
  const path = selected?.path, located = path ? elementAt(doc.document, path) : undefined, element = located?.element;
  const panel = path ? propertyPanel(doc.document, path) : undefined;
  const context: FieldContext = { lists: props.lists, onWrite: (fieldPath, value) => { if (path) props.onEdit(writeProperty(doc.document, path, fieldPath, value), `${path}:${fieldPath.join('.')}`); } };
  const artboard = isObject(doc.document['artboard']) ? doc.document['artboard'] : {};
  const boardMinimum = typeof artboard['minFontSize'] === 'number' ? artboard['minFontSize'] : 5;
  const isText = panel?.type === 'text', isBoard = panel?.type === 'artboard';
  const fitField = (key: string): PropertyField | undefined => (panel ? fieldByKey(panel, key) : undefined);
  const fitOf = (node: JsonObject | undefined) => (isObject(node?.['fit']) ? node['fit'] : undefined);
  const group = fitOf(element)?.['widthOverflow'], groupName = isObject(group) ? group['shrinkGroup'] : undefined;
  const members = typeof groupName === 'string'
    ? flatElements(doc.document, doc.name).filter((node) => { const other = fitOf(elementAt(doc.document, node.path)?.element)?.['widthOverflow']; return isObject(other) && other['shrinkGroup'] === groupName; }).map((node) => node.name)
    : [];
  const checks = Array.isArray(doc.document['checks']) ? doc.document['checks'] as unknown[] : [];
  const related = relatedChecks(doc.document, element);
  const here = (reply?.problems ?? []).filter((problem) => problem.location.kind === 'element' && reply?.elements?.some((item) => item.path === (problem.location as { path: string }).path && item.source.template === doc.name && item.source.path === path));
  return (
    <div data-testid="rules">
      {path ? (
        <section className="prop-section" aria-label="适配规则">
          <h3>{segmentsLast(path)} 的适配</h3>
          {isText && (
            <>
              {['fit.steps', 'fit.compressMin', 'fit.minFontSize', 'fit.onFail', 'fit.widthOverflow'].flatMap((key) => { const field = fitField(key); return field ? [<FieldRow key={key} field={field} context={context} />] : []; })}
              <p className="hint" data-testid="fit-hint">压缩下限缺省 0.6；缩字下限缺省取画板的 {boardMinimum} mm，不能低于它。</p>
              {members.length > 0 && <p className="small" data-testid="shrink-group">缩字组 {String(groupName)}：{members.join('、')}，放不下时一起缩到同一字号。</p>}
            </>
          )}
          {isBoard && fitField('minFontSize') && <><FieldRow field={fitField('minFontSize')!} context={context} /><p className="hint">这个模板文字缩字的最低字号，不写时 5 mm。</p></>}
          {!isText && !isBoard && <p className="small muted">这个元素没有适配规则：适配只对文字起作用。</p>}
        </section>
      ) : <p className="muted small">选中一个元素，看它的适配规则与相关的检查项。</p>}
      <section className="prop-section" aria-label="检查项">
        <h3>{element ? '相关的检查项' : '全部检查项'}</h3>
        {related.length === 0 && <p className="small muted">{element ? '没有用到这个元素的变量的检查项。' : '这个模板没有检查项。'}</p>}
        {related.map((index) => {
          const check = checks[index], name = isObject(check) ? String(check['name']) : `#${index + 1}`, expanded = openCheck === index;
          const checkContext: FieldContext = { lists: props.lists, onWrite: (fieldPath, value) => props.onEdit(writeListItem(doc.document, 'checks', index, fieldPath, value), `checks:${name}:${fieldPath.join('.')}`) };
          return (
            <div key={index} className={`list-row${expanded ? ' selected' : ''}`} data-testid="check-row" data-name={name}>
              <button type="button" className="list-row-button" aria-expanded={expanded} onClick={() => setOpenCheck(expanded ? undefined : index)}>
                <span>{isObject(check) && typeof check['displayName'] === 'string' ? check['displayName'] : name}</span>
                <span className="small muted">{isObject(check) ? (check['level'] === 'severe' ? '严重' : '提示') : ''}</span>
              </button>
              {expanded && <div className="list-row-body">{listItemPanel(doc.document, 'checks', index).map((field) => <FieldRow key={field.key} field={field} context={checkContext} />)}</div>}
            </div>
          );
        })}
      </section>
      {here.length > 0 && (
        <section className="prop-section" aria-label="这个元素的问题">
          <h3>这个元素的问题</h3>
          <ProblemList problems={here} label="这个元素的问题" />
        </section>
      )}
    </div>
  );
}

const segmentsLast = (path: string) => path.split('/').at(-1);
