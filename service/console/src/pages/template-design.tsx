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
import { ErrorBox, ProblemList } from '../components/problems.js';
import { CHEVRON, CHEVRON_UP, CURSOR, HAND, Icon, PANEL_LEFT, PANEL_RIGHT, REDO, UNDO } from '../components/icon.js';
import { DesignInspector, InlineTextEditor } from '../design/panels.js';
import { callersOf, deleteElement, dropTarget, duplicateElement, moveElement, moveElementTo, renameElement, unwrapContainer, wrapInContainer, type DropZone, type Edited } from '../template/structure.js';
import { usesOfVariable, useInspection, VariablesPanel, type VariableSelection } from '../design/variables.js';
import { DesignStructure, type TreeSource } from '../design/structure.js';
import { AddPanel, canDropInto, currentAdd, isAddDrag } from '../design/add-panel.js';
import { insertElement, insertionPoint, type Drop } from '../template/create.js';
import { writeProperty } from '../template/properties.js';
import { NO_TRIAL, readStored, SampleCards, SampleKnobs, useSampleThumbs, writeStored, type Sample, type Trial } from '../design/tray.js';
import { CodePanel } from '../components/code-panel.js';
import { RevisionChanges } from '../components/revision-changes.js';
import { impactOf, instancesOf, ScopeBar } from '../design/scope.js';
import { DEFAULT_LAYERS, type LayerName, type Layers } from '../design/overlays.js';
import { DesignStage, FIT_VIEW, MAX_ZOOM, MIN_ZOOM, type Selection, type StageView } from '../design/stage.js';
import { go, guardNavigation, href, useLivePreview, useLoad, type Route } from '../hooks.js';
import { documentInfo, elementAt, elementVariables, isObject, parentInstance, parseTemplateText, variableKind, type JsonObject } from '../template/document.js';
import { ELEMENT_TYPES } from '../template/properties.js';
import { createDesignSession, leaveQuestion, type DesignDoc, type DesignSession } from '../template/session.js';
import { calledTemplates } from '../template/tree.js';
import type { Identity, LayoutNode, PreviewReply, Problem } from '../types.js';
import { datasetRef, sameSchema } from './templates.js';
import { Loading } from '../components/motifs.js';
import { problemMarks } from '../components/preview-canvas.js';

type LeftTab = 'structure' | 'variables' | 'add';
type TrayTab = 'samples' | 'problems' | 'changes' | 'dsl';
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
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);

  const [selection, setSelection] = useState<Selection>();
  const [leftTab, setLeftTab] = useState<LeftTab>('structure');
  const [trayTab, setTrayTab] = useState<TrayTab>('samples');
  const [trayOpen, setTrayOpen] = useState(true);
  const narrow = window.innerWidth <= NARROW;
  const [panels, setPanels] = useState({ left: !narrow, right: !narrow });
  const stored = useMemo(() => readStored(root), [root]);
  const [datasetId, setDatasetId] = useState<string | undefined>(stored.datasetId);
  const [trial, setTrial] = useState<Trial>(stored.trial ?? NO_TRIAL);
  const [compare, setCompare] = useState(false);
  const [dslWhole, setDslWhole] = useState(false);
  const [tool, setTool] = useState<'select' | 'pan'>('select');
  const [view, setView] = useState<StageView>(FIT_VIEW);
  const [fit, setFit] = useState(800);
  const [menu, setMenu] = useState<MenuState>();
  const [notice, setNotice] = useState<string>();
  const [locateTick, setLocateTick] = useState(0);
  const [variable, setVariable] = useState<VariableSelection>();
  const [hoverVariable, setHoverVariable] = useState<{ readonly template: string; readonly name: string }>();
  const [inlineText, setInlineText] = useState<string>();
  const [renaming, setRenaming] = useState<{ readonly template: string; readonly path: string }>();

  const openTemplate = (template: string) => go(['templates', template, 'design'], template === root ? {} : { in: root });

  // 预览用暂存过的内容：改动写回之后才有新图，请求里的对外参数也取那一份。
  const rootInfo = useMemo(() => (rootDoc ? documentInfo(root, parseTemplateText(rootDoc.savedText)) : undefined), [root, rootDoc?.savedText]);
  const datasets = useLoad(() => api.datasets(), 'design-datasets');
  const samples = useMemo(() => (datasets.data?.datasets ?? []).filter((entry) => sameSchema(entry.staticSchema, rootInfo?.base)), [datasets.data, rootInfo?.base]);
  const sampleList = useMemo<readonly Sample[]>(() => [...samples.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id, stress: STRESS.test(entry.name ?? entry.id) })), { id: '', name: '空白数据（显示占位）', stress: false }], [samples]);
  // 记住的数据集可能已经没了：回到第一份。
  const chosen = datasetId !== undefined && sampleList.some((sample) => sample.id === datasetId) ? datasetId : samples[0]?.id ?? '';
  const defaults = useMemo(() => (rootInfo ? defaultParameters(rootInfo) : {}), [rootInfo]);
  const baseOutput = rootInfo?.sizeRange ? defaultOutput(rootInfo) : { width: 100, height: 100, dpi: 120, format: 'png' as const };
  const clamp = (value: number | undefined, range: { readonly min: number; readonly max: number } | undefined, fallback: number) => (value === undefined || !range ? fallback : Math.min(range.max, Math.max(range.min, value)));
  const output = { ...baseOutput, width: clamp(trial.width, rootInfo?.sizeRange?.width, baseOutput.width), height: clamp(trial.height, rootInfo?.sizeRange?.height, baseOutput.height) };
  const outputWidth = output.width;
  const needed = Math.max((fit * view.zoom * window.devicePixelRatio * 25.4) / outputWidth, (MIN_LONG_EDGE_PX * 25.4) / Math.max(output.width, output.height));
  const dpi = DPI_STEPS.find((step) => step >= needed) ?? DPI_STEPS.at(-1)!;
  const requestFor = (id: string) => (rootInfo?.base ? { template: root, dataset: datasetRef(rootInfo.base, id || undefined), parameters: { ...defaults, ...trial.parameters }, output: { ...output, dpi } } : undefined);
  const request = useMemo(() => (rootInfo?.base && rootInfo.sizeRange && datasets.data ? requestFor(chosen) : undefined), [root, rootInfo, chosen, dpi, datasets.data, trial, output.width, output.height]);
  const preview = useLivePreview(request, 120, { workingCopies: true, version: String(state.stashes) });
  const reply = preview.reply;
  const version = `${state.stashes}\n${JSON.stringify(trial)}`;
  const thumbs = useSampleThumbs(sampleList, chosen, reply, version, requestFor);
  useEffect(() => { writeStored(root, { ...(datasetId === undefined ? {} : { datasetId }), trial }); }, [root, datasetId, trial]);
  // 在图上对比：同一个请求，不用工作副本，就是当前修订的图。
  const currentRevision = useLivePreview(compare ? request : undefined, 120);
  const compareImage = compare && currentRevision.reply?.image ? `data:image/${currentRevision.reply.image.format};base64,${currentRevision.reply.image.base64}` : undefined;

  // 还没开工作副本时没有什么可比的（第一次写回才开）。
  const check = useLoad(() => (doc?.opened ? api.checkWorkingCopy(name) : Promise.resolve(undefined)), `${name}\n${doc?.opened ?? ''}\n${doc?.sha256 ?? ''}`);
  // 复制出来还没保存的新模板没有修订可比，整份都算未发布。
  const unpublished = doc && !doc.opened ? 0 : check.data && (check.data.changes.status === 'added' ? 1 : check.data.changes.changes.length);

  const locations = useMemo(() => new Map((reply?.elements ?? []).map((element) => [element.path, element.source])), [reply?.elements]);
  const select = (template: string, path: string, instance?: string) => {
    setVariable(undefined);
    setSelection({ template, path, ...(instance ? { instance } : {}) });
    if (template !== name) openTemplate(template);
  };
  const pick = (instance: string) => {
    const source = locations.get(instance);
    if (source) select(source.template, source.path, instance);
  };
  /** 问题定位：元素选中它，字段、参数与检查项打开变量页。 */
  const onProblem = (problem: Problem) => {
    const location = problem.location;
    if (location.kind === 'element') { pick(location.path); return; }
    const chosen: VariableSelection | undefined = location.kind === 'check' ? { template: location.template, name: location.name, kind: 'check' }
      : location.kind === 'variable' ? { template: location.template, name: location.name, kind: 'derived' }
      : location.kind === 'parameter' ? { template: name, name: location.name, kind: 'parameter' }
      : location.kind === 'field' ? { template: root, name: location.path.split(/[.[]/)[0]!, kind: 'field' } : undefined;
    if (!chosen) return;
    openVariable(chosen);
  };
  const openVariable = (chosen: VariableSelection) => {
    setPanels((now) => ({ ...now, left: true, right: true }));
    setLeftTab('variables');
    setVariable(chosen);
    if (chosen.template !== name) openTemplate(chosen.template);
  };
  /** 点选：最深的元素；按着 Alt 沿层叠往下穿透。 */
  const pickFrom = (stack: readonly string[], through: boolean) => {
    const at = through && selection?.instance ? stack.indexOf(selection.instance) : -1;
    pick(through ? stack[(at + 1) % stack.length]! : stack[0]!);
  };
  /** 双击图上的文字：选中最深的元素，就地打开内容编辑。不是文字就只是选中。 */
  const editText = (stack: readonly string[]) => {
    const instance = stack[0]!;
    pick(instance);
    if (elementOf(instance)?.['type'] === 'text') setInlineText(instance);
  };
  const selected = selection?.template === name ? selection : undefined;
  const instances = instancesOf(reply, selected);
  // 变量的当前值：选中实例所在的作用域；没选中时取这个模板的第一处。
  const scopeInstance = selected?.instance ?? instances[0] ?? (name === root ? root : (reply?.elements ?? []).find((element) => element.source.template === name)?.path);
  const inspection = useInspection(request, scopeInstance, String(state.stashes));
  const usedBy = useMemo(() => {
    const document = hoverVariable && documentOf(hoverVariable.template);
    return document ? new Set(usesOfVariable(document, hoverVariable.template, hoverVariable.name).elements.map((element) => `${hoverVariable.template}\n${element.path}`)) : undefined;
  }, [hoverVariable, state.stashes]);
  /** 实例对应的模板文档里的元素。 */
  const elementOf = (instance: string) => { const source = locations.get(instance), document = source && documentOf(source.template); return document ? elementAt(document, source.path)?.element : undefined; };
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

  // 换了选中（点别处、Esc 上一层）就地编辑器跟着收起。
  useEffect(() => { if (selection?.instance !== inlineText) setInlineText(undefined); }, [selection?.instance]);
  const inlineEditor = inlineText && doc && selected?.instance === inlineText
    ? { instance: inlineText, editor: <InlineTextEditor doc={doc} session={session} selected={selected} {...(inspection ? { inspection } : {})} documentOf={documentOf} onVariable={openVariable} onSelected={setSelection} onClose={() => setInlineText(undefined)} /> }
    : undefined;

  // —— 改结构（票据 12）：每个操作写回一次，所以一步撤销；之后选中操作的结果。 ——
  /** 被多处调用的子模板里删改元素，先说清会影响到哪。 */
  const confirmShared = (template: string, path: string, verb: string) => {
    if (template === root) return true;
    const callers = callersOf(template, [...state.docs.values()].map((item) => ({ name: item.name, document: item.document })));
    const count = (reply?.elements ?? []).filter((element) => element.source.template === template && element.source.path === path).length;
    if (callers.length <= 1 && count <= 1) return true;
    return window.confirm(`「${path.split('/').at(-1)!}」在模板「${template}」里，这个模板被 ${callers.length} 处调用（${callers.join('、')}），图上 ${count} 处。${verb}会影响全部，确定？`);
  };
  const applyStructure = (template: string, edited: Edited | undefined, what: string) => {
    if (!edited) return false;
    // 每次操作一个新键：不和前后的改动合成一步撤销。
    session.edit(template, edited.document, `structure:${what}:${Date.now()}`);
    void session.flush();
    select(template, edited.path);
    return true;
  };
  type StructureOp = 'duplicate' | 'delete' | 'up' | 'down' | 'wrap' | 'unwrap';
  const structure = (op: StructureOp, target: { readonly template: string; readonly path: string } | undefined = selection) => {
    setMenu(undefined);
    const document = target && documentOf(target.template);
    if (!target || !document) return;
    const { template, path } = target;
    if (path === template) { setNotice('画板不能复制、删除或移动。'); return; }
    if (op === 'delete' && !confirmShared(template, path, '删除')) return;
    const edited = op === 'duplicate' ? duplicateElement(document, template, path) : op === 'delete' ? deleteElement(document, template, path)
      : op === 'up' ? moveElement(document, template, path, -1) : op === 'down' ? moveElement(document, template, path, 1)
      : op === 'wrap' ? wrapInContainer(document, template, path) : unwrapContainer(document, template, path);
    if (!applyStructure(template, edited, op)) setNotice(op === 'up' ? '已经在最前面了。' : op === 'down' ? '已经在最后面了。' : op === 'unwrap' ? '只有容器能拆开。' : '这个操作对它不适用。');
  };
  const rename = (template: string, path: string, name: string): string | undefined => {
    const document = documentOf(template), result = document && renameElement(document, template, path, name);
    if (!result) return undefined;
    if ('problem' in result) return result.problem;
    if (!confirmShared(template, path, '改名')) { setRenaming(undefined); return undefined; }
    setRenaming(undefined);
    applyStructure(template, result, 'rename');
    return undefined;
  };
  const startRename = (target: { readonly template: string; readonly path: string } | undefined = selection) => {
    setMenu(undefined);
    if (!target || target.path === target.template) return;
    setPanels((now) => ({ ...now, left: true }));
    setLeftTab('structure');
    setRenaming({ template: target.template, path: target.path });
  };
  // —— 添加元素（票据 14）：点一下加到选中的位置；拖到结构树或图上放在那里。 ——
  const addTargetLabel = (document: JsonObject) => {
    const point = insertionPoint(document, name, selected?.path), container = point.container === name ? `画板「${name}」` : `「${point.container.split('/').at(-1)!}」`;
    return selected && selected.path !== name && point.container !== selected.path ? `${container}，放在「${selected.path.split('/').at(-1)!}」后面` : `${container}的最后`;
  };
  const addElement = (element: JsonObject) => {
    if (!doc) return;
    const point = insertionPoint(doc.document, name, selected?.path);
    if (!applyStructure(name, insertElement(doc.document, name, point.container, element, { index: point.index }), 'add')) setNotice('这里放不进元素。');
  };
  const bindVisible = (variable: string) => {
    if (!doc || !selected || selected.path === name) { setNotice('先选中一个元素，再把布尔字段绑到它的显示。'); return; }
    session.edit(name, writeProperty(doc.document, selected.path, ['visible'], { var: variable }), `structure:visible:${Date.now()}`);
    void session.flush();
    setNotice(`「${selected.path.split('/').at(-1)!}」按 ${variable} 决定显示。`);
  };
  const addOnTree = (template: string, over: string, zone: DropZone) => {
    const payload = currentAdd(), document = documentOf(template), place = document && dropTarget(document, template, over, zone);
    if (!payload || !document || !place || !canDropInto(payload, template)) return;
    applyStructure(template, insertElement(document, template, place.target, payload.element, { index: place.index }), 'add');
  };
  /** 拖到图上：从最深处往外找第一个能放的容器；自由布局写落点坐标，堆叠按落点算第几位，网格取落点所在那一格。 */
  const addOnStage = (stack: readonly LayoutNode[], point: { readonly x: number; readonly y: number }) => {
    const payload = currentAdd();
    if (!payload) return;
    for (const node of stack) {
      const source = locations.get(node.path), element = elementOf(node.path), document = source && documentOf(source.template);
      if (!source || !document || !element || !(source.path === source.template || element['type'] === 'container') || !canDropInto(payload, source.template)) continue;
      const layout = isObject(element['layout']) ? element['layout'] : {}, mode = typeof layout['mode'] === 'string' ? layout['mode'] : 'free';
      const kids = (node.children ?? []).filter((child) => child.visible);
      let at: Drop = {};
      if (mode === 'free') at = { point: { x: point.x - node.x, y: point.y - node.y } };
      else if (mode === 'stack') {
        const row = layout['direction'] !== 'column';
        at = { index: kids.filter((child) => (row ? child.x + child.width / 2 < point.x : child.y + child.height / 2 < point.y)).length };
      } else {
        const inside = kids.find((child) => point.x >= child.x && point.x <= child.x + child.width && point.y >= child.y && point.y <= child.y + child.height);
        const place = inside && elementOf(inside.path)?.['place'];
        if (isObject(place) && typeof place['row'] === 'number' && typeof place['column'] === 'number') at = { cell: { row: place['row'], column: place['column'] } };
      }
      applyStructure(source.template, insertElement(document, source.template, source.path, payload.element, at), 'add');
      return;
    }
    setNotice(payload.fromField ? '字段只能放进这个模板自己的容器里。' : '这里没有能放元素的容器。');
  };
  const dropOnTree = (template: string, path: string, over: string, zone: DropZone) => {
    const document = documentOf(template), place = document && dropTarget(document, template, over, zone);
    if (!document || !place) return;
    applyStructure(template, moveElementTo(document, template, path, place.target, place.index), 'move');
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
  const keys = useRef({ undo, redo, save, fitView, climb, descend, structure, startRename, physical: () => {}, togglePanels: () => {} });
  keys.current = {
    undo, redo, save, fitView, climb, descend, structure, startRename,
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
        else if (key === 'd' && !(event.target as HTMLElement | null)?.closest('input, select, textarea')) { event.preventDefault(); keys.current.structure('duplicate'); }
        return;
      }
      const target = event.target as HTMLElement | null;
      if (event.isComposing || target?.closest('input, select, textarea')) return;
      // 改结构：Alt+↑、Alt+↓ 上移下移，Del 删除，F2 改名。打字时不算。
      if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); keys.current.structure(event.key === 'ArrowUp' ? 'up' : 'down'); return; }
      if (event.altKey) return;
      if (event.key === 'Delete') { event.preventDefault(); keys.current.structure('delete'); return; }
      if (event.key === 'F2') { event.preventDefault(); keys.current.startRename(); return; }
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
        <DesignStage preview={preview} tool={tool} view={view} insets={insets} selected={selected} {...(treeHover ? { hover: treeHover } : {})} layers={layers} {...(usedBy ? { usedBy } : {})} elementOf={elementOf} {...(compareImage ? { compare: compareImage } : {})} onView={setView} onFit={setFit} onPick={pickFrom} onEditText={editText} onDropAdd={addOnStage} {...(inlineEditor ? { inline: inlineEditor } : {})} onClear={() => setSelection(undefined)}
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
              {([['structure', '结构'], ['variables', '变量'], ['add', '添加']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={leftTab === id} className={leftTab === id ? 'active' : undefined} onClick={() => setLeftTab(id)}
                  onDragEnter={(event) => { if (isAddDrag(event) && leftTab !== id) setLeftTab(id); }}>{label}</button>
              ))}
            </div>
            <div className="design-panel-body">
              {doc ? (leftTab === 'structure'
                ? <DesignStructure root={root} documentOf={documentOf} {...(selected ? { selection: selected } : {})} {...(reply ? { reply } : {})} locateTick={locateTick} onSelect={(template, path) => select(template, path)} onHover={setTreeHover}
                  onMenu={(x, y, template, path) => { select(template, path); setMenu({ x, y, template, path }); }}
                  {...(renaming ? { renaming } : {})} onRename={rename} onRenameDone={() => setRenaming(undefined)} onDrop={dropOnTree} onAddDrop={addOnTree} />
                : leftTab === 'variables'
                  ? <VariablesPanel doc={doc} session={session} {...(inspection ? { inspection } : {})} {...(variable ? { selected: variable } : {})} onSelect={openVariable} onHover={setHoverVariable} />
                  : <AddPanel template={name} document={doc.document} targetLabel={addTargetLabel(doc.document)} {...(selected && selected.path !== name ? { selectionLabel: selected.path.split('/').at(-1)! } : {})} onAdd={addElement} onBindVisible={bindVisible} />) : <Loading>正在读取模板…</Loading>}
            </div>
          </aside>
        )}
        {panels.right && (
          <aside className="design-panel right" aria-label="检查器">
            <div className="design-panel-body">
              {doc ? <DesignInspector doc={doc} session={session} documentOf={documentOf} selected={selected} reply={reply} impact={impactOf(root, selected, instances.length)} {...(variable?.template === name ? { variable } : {})} {...(inspection ? { inspection } : {})} onVariable={(next) => { if (next) openVariable(next); else setVariable(undefined); }} onSelect={(path) => select(name, path)} onSelected={setSelection} onOpenTemplate={openTemplate} /> : <Loading>正在读取模板…</Loading>}
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
          <span className="dock-group" role="group" aria-label="叠加层">
            {(([['problems', '问题'], ['structure', '结构'], ['fit', '适配'], ['data', '数据']] as const) satisfies readonly (readonly [LayerName, string])[]).map(([layer, label]) => (
              <button key={layer} type="button" aria-pressed={layers[layer]} onClick={() => setLayers((now) => ({ ...now, [layer]: !now[layer] }))}>{label}</button>
            ))}
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
            {(([['samples', '样例', undefined], ['problems', '问题', reply?.problems.length], ['changes', '改动', unpublished], ['dsl', 'DSL', undefined]] as const)).map(([id, label, count]) => (
              <button key={id} type="button" role="tab" aria-selected={trayOpen && trayTab === id} className={trayOpen && trayTab === id ? 'active' : undefined} onClick={() => { if (trayOpen && trayTab === id) setTrayOpen(false); else { setTrayTab(id); setTrayOpen(true); } }}>
                {label}{count ? <span className={`tab-count${id === 'problems' && severe ? ' bad' : ''}`}>{count}</span> : null}
              </button>
            ))}
          </div>
          <span className="toolbar-gap" />
          {reply && <Verdict reply={reply} />}
          <span className="design-status small muted" aria-live="polite" data-testid="design-status">
            {preview.waiting ? '预览太频繁，稍后自动重试…' : preview.loading ? '正在出草稿预览…' : reply?.image ? `草稿 ${reply.image.dpi} DPI · ${reply.image.widthPx} × ${reply.image.heightPx} 像素` : ''}
          </span>
          <button type="button" className="small quiet icon-only" aria-label={trayOpen ? '收起样例带' : '展开样例带'} aria-expanded={trayOpen} onClick={() => setTrayOpen(!trayOpen)}><Icon d={trayOpen ? CHEVRON : CHEVRON_UP} /></button>
        </div>
        {trayOpen && (
          <div className="design-tray-body">
            {trayTab === 'samples' && (
              <div className="tray-samples">
                {rootInfo && <SampleKnobs info={rootInfo} defaults={defaults} output={output} trial={trial} onTrial={setTrial} />}
                <SampleCards samples={sampleList} current={chosen} thumbs={thumbs} version={version} onChoose={setDatasetId} />
              </div>
            )}
            {trayTab === 'problems' && (
              <div className="tray-problems">
                <ErrorBox problems={preview.problems} title="预览失败" />
                {reply && <ProblemsOfPreview reply={reply} onPick={onProblem} />}
              </div>
            )}
            {trayTab === 'changes' && (
              <div className="tray-changes" data-testid="tray-changes">
                {doc?.opened && check.data
                  ? <>
                    <div className="tray-changes-tools">
                      <span className="small muted">和当前修订比。改动已在工作副本，出图仍读当前修订，发布之后才生效。</span>
                      {check.data.changes.status !== 'added' && <button type="button" className={`small${compare ? ' primary' : ''}`} aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? '关掉对比' : '在图上对比'}</button>}
                    </div>
                    <RevisionChanges diff={check.data.changes} label="和当前修订的差异" />
                  </>
                  : <p className="small muted">还没有改动。</p>}
              </div>
            )}
            {trayTab === 'dsl' && doc && (
              <div className="tray-dsl" data-testid="tray-dsl">
                <span className="segmented" role="group" aria-label="DSL 的范围">
                  <button type="button" className="small" aria-pressed={!dslWhole} onClick={() => setDslWhole(false)}>选中的元素</button>
                  <button type="button" className="small" aria-pressed={dslWhole} onClick={() => setDslWhole(true)}>整份模板</button>
                </span>
                <CodePanel testid="design-dsl" value={dslWhole ? doc.document : (elementAt(doc.document, selected?.path ?? name)?.element ?? doc.document)} file={`${dslWhole || !selected ? name : selected.path}.json`} type="application/json" />
              </div>
            )}
          </div>
        )}
      </section>
      {menu && doc && (
        <ElementMenu menu={menu} doc={doc} onClose={() => setMenu(undefined)} onCopy={(text) => void copyPath(text)} onPick={(instance) => { setMenu(undefined); pick(instance); }}
          onLocate={() => { setMenu(undefined); setPanels((now) => ({ ...now, left: true })); setLeftTab('structure'); setLocateTick((value) => value + 1); }}
          onParameter={(parameter) => { setMenu(undefined); openVariable({ template: name, name: parameter, kind: 'parameter' }); }}
          onStructure={(op) => structure(op, { template: menu.template, path: menu.path })} onRename={() => startRename({ template: menu.template, path: menu.path })} />
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

function ProblemsOfPreview(props: { readonly reply: PreviewReply; readonly onPick: (problem: Problem) => void }) {
  const { reply } = props;
  const numbers = useMemo(() => new Map(problemMarks(reply).map((mark, index) => [mark.problem, index + 1])), [reply]);
  const [chosen, setChosen] = useState<Problem>();
  return reply.problems.length
    ? <ProblemList problems={reply.problems} numbers={numbers} selected={chosen} label="预览的问题" onSelect={(problem) => { setChosen(problem); props.onPick(problem); }} />
    : <p className="small muted">这份样例没有问题。</p>;
}

/** 右键菜单：这里的元素、改结构（票据 12）、复制元素路径、在结构中定位、打开绑定的字段。 */
function ElementMenu(props: {
  readonly menu: MenuState; readonly doc: DesignDoc; readonly onClose: () => void; readonly onCopy: (text: string) => void; readonly onPick: (instance: string) => void; readonly onLocate: () => void; readonly onParameter: (name: string) => void;
  readonly onStructure: (op: 'duplicate' | 'delete' | 'up' | 'down' | 'wrap' | 'unwrap') => void; readonly onRename: () => void;
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
      {menu.path !== menu.template && (
        <>
          <button type="button" role="menuitem" onClick={() => props.onStructure('duplicate')}><span>复制一份</span><kbd>Ctrl+D</kbd></button>
          <button type="button" role="menuitem" onClick={() => props.onStructure('up')}><span>上移</span><kbd>Alt+↑</kbd></button>
          <button type="button" role="menuitem" onClick={() => props.onStructure('down')}><span>下移</span><kbd>Alt+↓</kbd></button>
          <button type="button" role="menuitem" onClick={() => props.onStructure('wrap')}>包进容器</button>
          {element?.['type'] === 'container' && <button type="button" role="menuitem" onClick={() => props.onStructure('unwrap')}>拆开容器</button>}
          <button type="button" role="menuitem" onClick={props.onRename}><span>重命名</span><kbd>F2</kbd></button>
          <button type="button" role="menuitem" className="danger" onClick={() => props.onStructure('delete')}><span>删除</span><kbd>Del</kbd></button>
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
