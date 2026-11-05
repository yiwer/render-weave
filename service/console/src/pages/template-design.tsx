/**
 * 模板设计（方案 docs/template-design-page.md，票据 03 起；P1 票据 08，M205、M299、M356、M392）：客户管理员不写 DSL 也能改模板。只给客户管理员，操作员看只读预览。
 * - 舞台上是引擎出的真图：按布局摘要的元素框点选，按元素定位打开模板文档里的位置；元素在子模板里时切到子模板，预览仍是调用它的模板；
 * - 左面板是结构与变量，右边的检查器只显示选中的东西，都从模板文档与 Schema 生成（template/properties.ts）；
 * - 每次改动写回工作副本，再重渲染、刷新问题清单（template/session.ts）；撤销与重做只在这一页里；"保存"是立刻暂存，改了没点保存就离开要提醒（M383），"发布修订"去下一页；
 * - 预览接口只出草稿，两种模式的问题清单相同（docs/render-modes.md），所以样例带上常驻一句正式出图的结论，不设切换。
 * "让 Agent 修改""留评论"在 P2、P4 接入前不显示。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api.js';
import { defaultOutput, defaultParameters } from '../components/parameters.js';
import { countText, ErrorBox, ProblemList } from '../components/problems.js';
import { CHEVRON, CHEVRON_UP, CURSOR, HAND, Icon, PANEL_LEFT, PANEL_RIGHT, REDO, UNDO } from '../components/icon.js';
import { DesignInspector, DesignVariables } from '../design/panels.js';
import { DesignStructure, type TreeSource } from '../design/structure.js';
import { impactOf, instancesOf, ScopeBar } from '../design/scope.js';
import { DesignStage, FIT_VIEW, MAX_ZOOM, MIN_ZOOM, type Selection, type StageView } from '../design/stage.js';
import { go, guardNavigation, href, useLivePreview, useLoad, type Route } from '../hooks.js';
import { documentInfo, elementAt, elementVariables, isObject, parentInstance, parseTemplateText, variableKind } from '../template/document.js';
import { ELEMENT_TYPES } from '../template/properties.js';
import { createDesignSession, leaveQuestion, type DesignDoc, type DesignSession } from '../template/session.js';
import { calledTemplates } from '../template/tree.js';
import type { Identity, LayoutNode, PreviewReply, Problem } from '../types.js';
import { datasetRef, sameSchema } from './templates.js';
import { Loading } from '../components/motifs.js';
import { problemMarks } from '../components/preview-canvas.js';

type LeftTab = 'structure' | 'variables';
type TrayTab = 'samples' | 'problems';
const STRESS = /压测|压力|stress/i;
/**
 * 预览的分辨率：按屏幕需要往上取一档，不让连续缩放变成连续出图；上限 200 DPI，改一处不用等太久。
 * 长边至少 1400 像素：条形码按像素检查模块宽度，分辨率太低会报出正式图上没有的严重问题。
 */
const DPI_STEPS = [30, 50, 75, 100, 150, 200];
const MIN_LONG_EDGE_PX = 1400;
const PHYSICAL_DPI = 96;
const LEFT_WIDTH = 288, RIGHT_WIDTH = 340, PANEL_GAP = 22, NARROW = 900;

interface MenuState { readonly x: number; readonly y: number; readonly template: string; readonly path: string; readonly instance?: string; readonly stack?: readonly LayoutNode[] }

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
  // 结构树要读调用树里的全部模板；只读，不开工作副本（票据 01）。
  const documentOf = (template: string) => state.docs.get(template)?.document;
  const called = calledTemplates(root, documentOf).join('\n');
  useEffect(() => { for (const template of called.split('\n')) if (template !== root && template !== name) void session.open(template, { quiet: true }); }, [session, called, root, name]);
  const [treeHover, setTreeHover] = useState<TreeSource>();

  const [selection, setSelection] = useState<Selection>();
  const [leftTab, setLeftTab] = useState<LeftTab>('structure');
  const [trayTab, setTrayTab] = useState<TrayTab>('samples');
  const [trayOpen, setTrayOpen] = useState(true);
  const narrow = window.innerWidth <= NARROW;
  const [panels, setPanels] = useState({ left: !narrow, right: !narrow });
  const [datasetId, setDatasetId] = useState<string>();
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [view, setView] = useState<StageView>(FIT_VIEW);
  const [fit, setFit] = useState(800);
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
  const outputSize = rootInfo?.sizeRange ? defaultOutput(rootInfo) : { width: 100, height: 100 };
  const outputWidth = outputSize.width;
  const needed = Math.max((fit * view.zoom * window.devicePixelRatio * 25.4) / outputWidth, (MIN_LONG_EDGE_PX * 25.4) / Math.max(outputSize.width, outputSize.height));
  const dpi = DPI_STEPS.find((step) => step >= needed) ?? DPI_STEPS.at(-1)!;
  const request = useMemo(() => {
    if (!rootInfo?.base || !rootInfo.sizeRange || !datasets.data) return undefined;
    return { template: root, dataset: datasetRef(rootInfo.base, chosen || undefined), parameters: defaultParameters(rootInfo), output: { ...defaultOutput(rootInfo), dpi } };
  }, [root, rootInfo, chosen, dpi, datasets.data]);
  const preview = useLivePreview(request, 120, { workingCopies: true, version: String(state.stashes) });
  const reply = preview.reply;

  // 还没开工作副本时没有什么可比的（第一次写回才开）。
  const check = useLoad(() => (doc?.opened ? api.checkWorkingCopy(name) : Promise.resolve(undefined)), `${name}\n${doc?.opened ?? ''}\n${doc?.sha256 ?? ''}`);
  // 复制出来还没保存的新模板没有修订可比，整份都算未发布。
  const unpublished = doc && !doc.opened ? 0 : check.data && (check.data.changes.status === 'added' ? 1 : check.data.changes.changes.length);

  const locations = useMemo(() => new Map((reply?.elements ?? []).map((element) => [element.path, element.source])), [reply?.elements]);
  const select = (template: string, path: string, instance?: string) => {
    setSelection({ template, path, ...(instance ? { instance } : {}) });
    if (template !== name) openTemplate(template);
  };
  const pick = (instance: string) => {
    const source = locations.get(instance);
    if (source) select(source.template, source.path, instance);
  };
  /** 点选：最深的元素；按着 Alt 沿层叠往下穿透。 */
  const pickFrom = (stack: readonly string[], through: boolean) => {
    const at = through && selection?.instance ? stack.indexOf(selection.instance) : -1;
    pick(through ? stack[(at + 1) % stack.length]! : stack[0]!);
  };
  const selected = selection?.template === name ? selection : undefined;
  const instances = instancesOf(reply, selected);
  /** Esc、Enter：上一层、下一层。上一层到头就取消选中，检查器回到画板。 */
  const climb = () => {
    const from = selection?.instance ?? instancesOf(reply, selection)[0];
    if (!from) { setSelection(undefined); return; }
    let parent = parentInstance(from);
    while (parent && !locations.has(parent)) parent = parentInstance(parent);
    if (parent) pick(parent); else setSelection(undefined);
  };
  const descend = () => {
    const from = selection?.instance ?? instancesOf(reply, selection)[0];
    if (!from || !reply?.layout) return;
    const find = (node: LayoutNode): LayoutNode | undefined => (node.path === from ? node : (node.children ?? []).map(find).find(Boolean));
    const child = find(reply.layout.root)?.children?.find((node) => node.visible && locations.has(node.path));
    if (child) pick(child.path);
  };

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

  const zoomBy = (factor: number) => setView((now) => ({ ...now, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now.zoom * factor)) }));
  const fitView = () => setView(FIT_VIEW);

  // 快捷键：Ctrl+S、Ctrl+Z、Ctrl+Y、Ctrl+0、Ctrl+1、Ctrl+\\；V、H 切工具，打字时不算。
  const keys = useRef({ undo, redo, save, fitView, climb, descend, physical: () => {}, togglePanels: () => {} });
  keys.current = {
    undo, redo, save, fitView, climb, descend,
    physical: () => setView({ zoom: ((outputWidth / 25.4) * PHYSICAL_DPI) / fit, x: 0, y: 0 }),
    togglePanels: () => setPanels((now) => { const open = !(now.left || now.right); return { left: open, right: open }; }),
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        if (key === 's') { event.preventDefault(); keys.current.save(); }
        else if (key === 'z' && event.shiftKey) { event.preventDefault(); keys.current.redo(); }
        else if (key === 'z') { event.preventDefault(); keys.current.undo(); }
        else if (key === 'y') { event.preventDefault(); keys.current.redo(); }
        else if (key === '0') { event.preventDefault(); keys.current.fitView(); }
        else if (key === '1') { event.preventDefault(); keys.current.physical(); }
        else if (key === '\\') { event.preventDefault(); keys.current.togglePanels(); }
        return;
      }
      const target = event.target as HTMLElement | null;
      if (event.altKey || event.isComposing || target?.closest('input, select, textarea')) return;
      if (key === 'v') setTool('select');
      if (key === 'h') setTool('pan');
      if (key === 'escape') keys.current.climb();
      if (key === 'enter' && target?.tagName !== 'BUTTON' && target?.tagName !== 'A') keys.current.descend();
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
  const insets = { left: panels.left && !narrow ? LEFT_WIDTH + PANEL_GAP : 14, right: panels.right && !narrow ? RIGHT_WIDTH + PANEL_GAP : 14 };
  const sizeRange = rootInfo?.sizeRange;
  return (
    <section className="design" aria-label={`模板设计 ${name}`}>
      <div className="design-toolbar" role="toolbar" aria-label="模板设计">
        <nav className="crumbs" aria-label="位置">
          <a href={href(['templates'])}>模板</a><span aria-hidden="true">/</span>
          {root === name ? <strong>{name}</strong> : <><a href={href(['templates', root, 'design'])}>{root}</a><span aria-hidden="true">/</span><strong>{name}</strong></>}
        </nav>
        {rootInfo?.base && sizeRange && <span className="small faint design-facts">{rootInfo.base.name} v{String(rootInfo.base.version)} · {rangeText(sizeRange.width)} × {rangeText(sizeRange.height)} mm</span>}
        <span className="toolbar-gap" />
        <button type="button" className="small quiet icon-only" aria-label="撤销" title="撤销 Ctrl+Z" disabled={!state.canUndo} onClick={undo} aria-keyshortcuts="Control+Z"><Icon d={UNDO} /></button>
        <button type="button" className="small quiet icon-only" aria-label="重做" title="重做 Ctrl+Y" disabled={!state.canRedo} onClick={redo} aria-keyshortcuts="Control+Y"><Icon d={REDO} /></button>
        <span className={`design-state${dirty ? ' warn' : ''}`} data-testid="unsaved-count" aria-live="polite"><span className="status-dot" aria-hidden="true" />{state.unsaved ? `${state.unsaved} 处未保存` : state.saving ? '正在暂存…' : state.unconfirmed ? '已暂存，未保存' : '已保存'}</span>
        {unpublished !== undefined && <span className="small muted" data-testid="unpublished-count">{check.data?.changes.status === 'added' ? '新模板，未发布' : `${unpublished} 处未发布`}</span>}
        {check.data?.conflict && <span className="chip warn" data-testid="base-changed">基准已变，发布时看两边差异</span>}
        <button type="button" className="small" onClick={save} aria-keyshortcuts="Control+S" disabled={!dirty}>保存</button>
        <button type="button" className="small primary" disabled={!unpublished} title={unpublished ? undefined : '还没有改动'} onClick={() => void publish()}>发布修订</button>
      </div>
      {notice && <p className="notice design-notice" role="status">{notice}<button type="button" className="link" onClick={() => setNotice(undefined)}>知道了</button></p>}
      <ErrorBox problems={state.problems} title="打不开模板" />
      {failures.map((item) => <SaveFailure key={item.name} doc={item} session={session} />)}
      <div className="design-body">
        <DesignStage preview={preview} tool={tool} view={view} insets={insets} selected={selected} {...(treeHover ? { hover: treeHover } : {})} onView={setView} onFit={setFit} onPick={pickFrom} onClear={() => setSelection(undefined)}
          onMenu={(x, y, stack) => {
            const instance = stack[0]!.path, source = locations.get(instance);
            if (!source) return;
            select(source.template, source.path, instance);
            setMenu({ x, y, template: source.template, path: source.path, instance, stack });
          }} />
        <ScopeBar root={root} name={name} selected={selected} reply={reply} left={insets.left} right={insets.right} onPick={pick} />
        {panels.left && (
          <aside className="design-panel left" aria-label="结构与变量">
            <div className="tabs" role="tablist" aria-label="结构与变量">
              {([['structure', '结构'], ['variables', '变量']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={leftTab === id} className={leftTab === id ? 'active' : undefined} onClick={() => setLeftTab(id)}>{label}</button>
              ))}
            </div>
            <div className="design-panel-body">
              {doc ? (leftTab === 'structure'
                ? <DesignStructure root={root} documentOf={documentOf} {...(selected ? { selection: selected } : {})} {...(reply ? { reply } : {})} locateTick={locateTick} onSelect={(template, path) => select(template, path)} onHover={setTreeHover}
                  onMenu={(x, y, template, path) => { select(template, path); setMenu({ x, y, template, path }); }} />
                : <DesignVariables doc={doc} session={session} open={openParameter} onOpen={setOpenParameter} />) : <Loading>正在读取模板…</Loading>}
            </div>
          </aside>
        )}
        {panels.right && (
          <aside className="design-panel right" aria-label="检查器">
            <div className="design-panel-body">
              {doc ? <DesignInspector doc={doc} session={session} selected={selected} reply={reply} impact={impactOf(root, selected, instances.length)} onSelect={(path) => select(name, path)} onSelected={setSelection} onOpenTemplate={openTemplate} /> : <Loading>正在读取模板…</Loading>}
            </div>
          </aside>
        )}
        <div className="design-dock">
          <span className="dock-group" role="group" aria-label="工具">
            <button type="button" aria-label="选择" title="选择 V" aria-pressed={tool === 'select'} onClick={() => setTool('select')} aria-keyshortcuts="V"><Icon d={CURSOR} /></button>
            <button type="button" aria-label="平移" title="平移 H，或按住空格" aria-pressed={tool === 'pan'} onClick={() => setTool('pan')} aria-keyshortcuts="H"><Icon d={HAND} /></button>
          </span>
          <span className="dock-sep" aria-hidden="true" />
          <span className="dock-group" role="group" aria-label="缩放">
            <button type="button" aria-label="缩小" disabled={view.zoom <= MIN_ZOOM} onClick={() => zoomBy(1 / 1.25)}>−</button>
            <button type="button" className="dock-zoom" data-testid="zoom-level" title="恢复适应窗口 Ctrl+0" onClick={fitView}>{Math.round(view.zoom * 100)}%</button>
            <button type="button" aria-label="放大" disabled={view.zoom >= MAX_ZOOM} onClick={() => zoomBy(1.25)}>+</button>
          </span>
          <span className="dock-sep" aria-hidden="true" />
          <span className="dock-group" role="group" aria-label="面板">
            <button type="button" aria-label="结构与变量面板" title="结构与变量 Ctrl+\\" aria-pressed={panels.left} onClick={() => setPanels((now) => ({ ...now, left: !now.left }))}><Icon d={PANEL_LEFT} /></button>
            <button type="button" aria-label="检查器面板" title="检查器 Ctrl+\\" aria-pressed={panels.right} onClick={() => setPanels((now) => ({ ...now, right: !now.right }))}><Icon d={PANEL_RIGHT} /></button>
          </span>
        </div>
      </div>
      <section className="design-tray" aria-label="样例带">
        <div className="design-tray-head">
          <div className="tabs" role="tablist" aria-label="样例带">
            <button type="button" role="tab" aria-selected={trayOpen && trayTab === 'samples'} className={trayOpen && trayTab === 'samples' ? 'active' : undefined} onClick={() => { setTrayTab('samples'); setTrayOpen(true); }}>样例</button>
            <button type="button" role="tab" aria-selected={trayOpen && trayTab === 'problems'} className={trayOpen && trayTab === 'problems' ? 'active' : undefined} onClick={() => { setTrayTab('problems'); setTrayOpen(true); }}>问题{reply?.problems.length ? <span className={`tab-count${severe ? ' bad' : ''}`}>{reply.problems.length}</span> : null}</button>
          </div>
          <span className="toolbar-gap" />
          {reply && <Verdict reply={reply} />}
          <span className="design-status small muted" aria-live="polite" data-testid="design-status">
            {preview.waiting ? '预览太频繁，稍后自动重试…' : preview.loading ? '正在出草稿预览…' : reply?.image ? `草稿 ${reply.image.dpi} DPI · ${reply.image.widthPx} × ${reply.image.heightPx} 像素 · ${countText(reply.problems)}` : ''}
          </span>
          <button type="button" className="small quiet icon-only" aria-label={trayOpen ? '收起样例带' : '展开样例带'} aria-expanded={trayOpen} onClick={() => setTrayOpen(!trayOpen)}><Icon d={trayOpen ? CHEVRON : CHEVRON_UP} /></button>
        </div>
        {trayOpen && (
          <div className="design-tray-body">
            {trayTab === 'samples' && (
              <div className="tray-samples">
                <label className="small muted" htmlFor="design-dataset">样例数据集</label>
                <select id="design-dataset" className="toolbar-select" value={chosen} onChange={(event) => setDatasetId(event.target.value)}>
                  {groupedSamples.normal.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
                  {groupedSamples.stress.length > 0 && (
                    <optgroup label="压测数据">
                      {groupedSamples.stress.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.id}</option>)}
                    </optgroup>
                  )}
                  <option value="">空白数据（显示占位）</option>
                </select>
              </div>
            )}
            {trayTab === 'problems' && (
              <div className="tray-problems">
                <ErrorBox problems={preview.problems} title="预览失败" />
                {reply && <ProblemsOfPreview reply={reply} onPick={pick} />}
              </div>
            )}
          </div>
        )}
      </section>
      {menu && doc && (
        <ElementMenu menu={menu} doc={doc} onClose={() => setMenu(undefined)} onCopy={(text) => void copyPath(text)} onPick={(instance) => { setMenu(undefined); pick(instance); }}
          onLocate={() => { setMenu(undefined); setPanels((now) => ({ ...now, left: true })); setLeftTab('structure'); setLocateTick((value) => value + 1); }}
          onParameter={(parameter) => { setMenu(undefined); setPanels((now) => ({ ...now, left: true })); setOpenParameter(parameter); setLeftTab('variables'); }} />
      )}
    </section>
  );
}

const rangeText = (range: { readonly min: number; readonly max: number }) => (range.min === range.max ? String(range.min) : `${range.min}–${range.max}`);

/** 正式出图的结论：预览接口只出草稿，两种模式的问题清单相同（docs/render-modes.md）。 */
function Verdict(props: { readonly reply: PreviewReply }) {
  const severe = props.reply.problems.filter((problem) => problem.level === 'severe').length;
  const hints = props.reply.problems.length - severe;
  return (
    <span className="design-verdict small" data-testid="final-mode-note">
      <span className={`status-dot${severe ? ' bad' : hints ? ' warn' : ' ok'}`} aria-hidden="true" />
      {severe ? `正式出图时不出图：有 ${severe} 个严重问题` : hints ? '正式出图的图上没有问题边框，这里仍是草稿的图' : '没有问题：这张图与正式出图相同'}
    </span>
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

function ProblemsOfPreview(props: { readonly reply: PreviewReply; readonly onPick: (instance: string) => void }) {
  const { reply } = props;
  const numbers = useMemo(() => new Map(problemMarks(reply).map((mark, index) => [mark.problem, index + 1])), [reply]);
  const [chosen, setChosen] = useState<Problem>();
  return reply.problems.length
    ? <ProblemList problems={reply.problems} numbers={numbers} selected={chosen} label="预览的问题" onSelect={(problem) => { setChosen(problem); if (problem.location.kind === 'element') props.onPick(problem.location.path); }} />
    : <p className="small muted">这份样例没有问题。</p>;
}

/** 右键菜单：复制元素路径、在结构中定位、打开绑定的字段。 */
function ElementMenu(props: {
  readonly menu: MenuState; readonly doc: DesignDoc; readonly onClose: () => void; readonly onCopy: (text: string) => void; readonly onPick: (instance: string) => void; readonly onLocate: () => void; readonly onParameter: (name: string) => void;
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
    <div className="menu element-menu" role="menu" aria-label="元素" ref={root} data-testid="element-menu" style={{ left: menu.x, top: Math.min(menu.y, window.innerHeight - 340) }}>
      {(menu.stack?.length ?? 0) > 1 && (
        <>
          <span className="menu-title small faint">这里的元素</span>
          {menu.stack!.slice(0, 7).map((node) => (
            <button key={node.path} type="button" role="menuitem" data-testid="stack-item" aria-current={node.path === menu.instance ? 'true' : undefined} onClick={() => props.onPick(node.path)}>
              <span>{node.name}</span><span className="small faint">{ELEMENT_TYPES[node.type] ?? node.type}</span>
            </button>
          ))}
          <hr className="menu-rule" />
        </>
      )}
      <button type="button" role="menuitem" onClick={() => props.onCopy(menu.instance ?? menu.path)}>复制元素路径</button>
      <button type="button" role="menuitem" onClick={props.onLocate}>在结构中定位</button>
      {bound.map((name) => (variableKind(doc.document, name.split('.')[0]!) === 'parameter'
        ? <button key={name} type="button" role="menuitem" onClick={() => props.onParameter(name)}>打开绑定的参数 {name}</button>
        : <a key={name} role="menuitem" href={href(['definitions', base ?? ''], { field: name })} onClick={props.onClose}>打开绑定的字段 {name}</a>))}
      {bound.length === 0 && <span className="menu-empty small muted">没有绑定的字段</span>}
    </div>
  );
}
