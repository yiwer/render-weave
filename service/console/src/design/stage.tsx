/**
 * 舞台（模板设计页票据 03，方案第 2、4 节）：放画板的工作区。图一直是引擎出的真图，框与标注画在图上方的屏幕空间。
 * 面板浮在舞台上：适应按两个面板之间的空隙算，放大后图从面板底下穿过去。缩放以适应窗口为 100%；图不用 transform 缩放，
 * 所以框的线宽在任何缩放下都一样。
 */
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { problemMarks } from '../components/preview-canvas.js';
import type { LivePreview } from '../hooks.js';
import { hitStack } from '../template/document.js';
import type { JsonObject } from '../template/document.js';
import type { LayoutNode } from '../types.js';
import { contentKind, fitSummary, flatNodes, layoutGuides, type Layers } from './overlays.js';

export interface StageView { readonly zoom: number; readonly x: number; readonly y: number }
export const FIT_VIEW: StageView = { zoom: 1, x: 0, y: 0 };
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 16;

/** 选中的元素：path 是它在模板文档里的路径，instance 是图上的那一个实例（带调用链与循环序号）。 */
export interface Selection { readonly template: string; readonly path: string; readonly instance?: string }

/** 两边留给浮动面板的宽度，放范围条与操作条的上下留白。 */
export interface StageInsets { readonly left: number; readonly right: number }
const TOP = 52, BOTTOM = 56, MIN_FIT = 120;

const round = (value: number) => Math.round(value * 10) / 10;

function flatten(node: LayoutNode | undefined, into = new Map<string, LayoutNode>()): Map<string, LayoutNode> {
  if (!node) return into;
  into.set(node.path, node);
  (node.children ?? []).forEach((child) => flatten(child, into));
  return into;
}

export function DesignStage(props: {
  readonly preview: LivePreview; readonly tool: 'select' | 'pan'; readonly view: StageView; readonly insets: StageInsets; readonly selected?: Selection;
  /** 结构树上悬停的定义：图上标出它的全部实例。 */
  readonly hover?: { readonly template: string; readonly path: string };
  readonly layers: Layers;
  /** 用到悬停的变量的元素定义：写成"模板\n路径"。 */
  readonly usedBy?: ReadonlySet<string>;
  /** 在图上和当前修订对比：图是当前修订，拖分割线。 */
  readonly compare?: string;
  /** 实例对应的模板文档里的元素：叠加层要看它的内容来源、排布与旋转。 */
  readonly elementOf: (instance: string) => JsonObject | undefined;
  readonly onView: (view: StageView) => void; readonly onFit: (width: number) => void;
  /** stack 是这个位置的全部元素，第一个最深；through 是按着 Alt 穿透。 */
  readonly onPick: (stack: readonly string[], through: boolean) => void; readonly onMenu: (x: number, y: number, stack: readonly LayoutNode[]) => void; readonly onClear: () => void;
}) {
  const { preview, tool, view, insets, selected } = props, reply = preview.reply, image = reply?.image, layout = reply?.layout;
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 600 });
  const aspect = layout ? layout.output.width / layout.output.height : 1;
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const room = { width: Math.max(MIN_FIT, size.width - insets.left - insets.right), height: Math.max(MIN_FIT / 2, size.height - TOP - BOTTOM) };
  const fit = Math.max(MIN_FIT, Math.min(room.width, room.height * aspect));
  useEffect(() => { props.onFit(fit); }, [fit]);
  const width = fit * view.zoom, height = width / aspect;
  const left = insets.left + (room.width - width) / 2 + view.x, top = TOP + (room.height - height) / 2 + view.y;

  // 滚轮以光标为锚缩放；要阻止页面滚动，只能自己挂非被动的监听。
  const latest = useRef({ view, fit, left, top, width, height });
  latest.current = { view, fit, left, top, width, height };
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const now = latest.current;
      if (event.shiftKey) { props.onView({ ...now.view, x: now.view.x - event.deltaY - event.deltaX, y: now.view.y }); return; }
      const box = element.getBoundingClientRect();
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, now.view.zoom * Math.exp(-event.deltaY * 0.0016)));
      const scale = nextZoom / now.view.zoom;
      const cx = event.clientX - box.left - (now.left + now.width / 2), cy = event.clientY - box.top - (now.top + now.height / 2);
      props.onView({ zoom: nextZoom, x: now.view.x - cx * (scale - 1), y: now.view.y - cy * (scale - 1) });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  // 平移：平移工具、按住空格，或者拖舞台空白处。
  const [space, setSpace] = useState(false);
  useEffect(() => {
    const typing = (event: KeyboardEvent) => (event.target as HTMLElement | null)?.closest?.('input, select, textarea');
    const down = (event: KeyboardEvent) => { if (event.code === 'Space' && !typing(event) && !event.repeat) { event.preventDefault(); setSpace(true); } };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') setSpace(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
  const drag = useRef<{ readonly x: number; readonly y: number; readonly view: StageView; moved: boolean } | undefined>(undefined);
  const panning = tool === 'pan' || space;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const onBoard = (event.target as HTMLElement).closest('[data-testid="design-canvas"]');
    if (!panning && onBoard && event.button !== 1) return;
    drag.current = { x: event.clientX, y: event.clientY, view, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    if (!now) return;
    const dx = event.clientX - now.x, dy = event.clientY - now.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) now.moved = true;
    props.onView({ ...now.view, x: now.view.x + dx, y: now.view.y + dy });
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    drag.current = undefined;
    // 点舞台空白处（没拖动）：取消选中，检查器回到画板。
    if (now && !now.moved && !panning && !(event.target as HTMLElement).closest('[data-testid="design-canvas"]')) props.onClear();
  };

  const nodes = useMemo(() => flatten(layout?.root), [layout]);
  const percent = (node: LayoutNode) => (layout ? { left: `${(node.x / layout.output.width) * 100}%`, top: `${(node.y / layout.output.height) * 100}%`, width: `${(node.width / layout.output.width) * 100}%`, height: `${(node.height / layout.output.height) * 100}%` } : {});
  const instances = useMemo(() => (selected ? (reply?.elements ?? []).filter((element) => element.source.template === selected.template && element.source.path === selected.path).map((element) => element.path) : []), [reply?.elements, selected]);
  const main = selected?.instance && instances.includes(selected.instance) ? selected.instance : instances[0];
  const marks = useMemo(() => (reply ? problemMarks(reply) : []), [reply]);
  const hovered = useMemo(() => (props.hover ? (reply?.elements ?? []).filter((element) => element.source.template === props.hover!.template && element.source.path === props.hover!.path).map((element) => element.path) : []), [reply?.elements, props.hover]);
  const [under, setUnder] = useState<string>();
  const [compareAt, setCompareAt] = useState(0.5);
  const canvas = useRef<HTMLDivElement>(null);
  const dragCompare = (event: ReactPointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const box = canvas.current?.getBoundingClientRect(); if (box) setCompareAt(Math.min(1, Math.max(0, (next.clientX - box.left) / box.width))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const all = useMemo(() => (layout ? flatNodes(layout.root).filter((node) => node.visible) : []), [layout]);
  const fitState = useMemo(() => (layout ? fitSummary(layout.root) : undefined), [layout]);
  const guides = useMemo(() => (main ? layoutGuides(props.elementOf(main), nodes.get(main)) : undefined), [main, nodes, reply]);
  const xOf = (value: number) => (layout ? `${(value / layout.output.width) * 100}%` : '0');
  const yOf = (value: number) => (layout ? `${(value / layout.output.height) * 100}%` : '0');
  const boxStyle = (box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }) => ({ left: xOf(box.x), top: yOf(box.y), width: xOf(box.width), height: yOf(box.height) });
  /** 布局摘要的框不计旋转：写了固定角度的元素，框按角度转过去。 */
  const rotated = (path: string) => { const rotation = props.elementOf(path)?.['rotation']; return typeof rotation === 'number' && rotation !== 0 ? { transform: `rotate(${rotation}deg)` } : {}; };
  const legend = [
    ...(props.layers.fit && fitState ? [`适配：${fitState.compressed} 处被压缩${fitState.lowest === undefined ? '' : `，最低 ${Math.round(fitState.lowest * 100)}%`}${fitState.overflow ? `，${fitState.overflow} 处放不下` : ''}`] : []),
    ...(props.layers.data ? ['灰底是数据驱动，虚线是固定内容'] : []),
  ].join(' · ');
  const hit = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!layout) return [];
    const box = event.currentTarget.getBoundingClientRect();
    return hitStack(layout.root, ((event.clientX - box.left) / box.width) * layout.output.width, ((event.clientY - box.top) / box.height) * layout.output.height);
  };
  return (
    <div className={`design-stage${panning ? ' tool-pan' : ''}${preview.loading ? ' busy' : ''}`} ref={stage} data-testid="design-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
      {image && layout ? (
        <div className="design-canvas" ref={canvas} data-testid="design-canvas" style={{ width, height, left, top }}
          onMouseMove={(event) => { if (panning) { setUnder(undefined); return; } const path = hit(event)[0]?.path; if (path !== under) setUnder(path); }} onMouseLeave={() => setUnder(undefined)}
          onClick={(event) => { if (panning) return; const stack = hit(event); if (stack.length) props.onPick(stack.map((node) => node.path), event.altKey); }}
          onContextMenu={(event) => { const stack = hit(event); if (!stack.length) return; event.preventDefault(); props.onMenu(event.clientX, event.clientY, stack); }}>
          <img data-testid="preview-image" src={`data:image/${image.format};base64,${image.base64}`} alt="工作副本的草稿预览" draggable={false} />
          {props.compare && (
            <>
              <span className="compare-clip" data-testid="compare-clip" style={{ width: `${compareAt * 100}%` }}><img src={props.compare} alt="当前修订的草稿预览" draggable={false} style={{ width }} /></span>
              <span className="compare-bar" data-testid="compare-bar" style={{ left: `${compareAt * 100}%` }} onPointerDown={dragCompare} onClick={(event) => event.stopPropagation()}><i aria-hidden="true" /></span>
              <span className="compare-tag left">当前修订</span>
              <span className="compare-tag right">工作副本</span>
            </>
          )}
          {props.layers.structure && all.filter((node) => node.path !== layout.root.path).map((node) => <span key={`structure-${node.path}`} className={`layer-box structure${node.children?.length ? '' : ' leaf'}`} data-testid="structure-box" style={percent(node)} />)}
          {props.layers.data && all.map((node) => { const kind = contentKind(props.elementOf(node.path)); return kind ? <span key={`data-${node.path}`} className={`layer-box ${kind}`} data-testid={`${kind}-box`} style={percent(node)} /> : null; })}
          {props.layers.fit && all.filter((node) => node.text && (node.text.overflow || node.text.compression < 0.999)).map((node) => (
            <span key={`fit-${node.path}`} className={`layer-box fit${node.text!.overflow ? ' over' : ''}`} data-testid={node.text!.overflow ? 'overflow-box' : 'fit-box'} title={`压到 ${Math.round(node.text!.compression * 100)}%${node.text!.overflow ? '，仍放不下' : ''}`} style={percent(node)} />
          ))}
          {props.usedBy && (reply?.elements ?? []).filter((element) => props.usedBy!.has(`${element.source.template}\n${element.source.path}`) && element.source.path !== element.source.template).map((element) => { const node = nodes.get(element.path); return node ? <span key={`use-${element.path}`} className="layer-box use" data-testid="use-box" style={percent(node)} /> : null; })}
          {guides?.gaps.map((box, index) => <span key={`gap-${index}`} className="guide-gap" data-testid="guide-gap" style={boxStyle(box)} />)}
          {guides?.padding.map((box, index) => <span key={`pad-${index}`} className="guide-pad" data-testid="guide-pad" style={boxStyle(box)} />)}
          {guides?.tracks.map((track, index) => (track.axis === 'row'
            ? <span key={`track-${index}`} className="guide-track" data-testid="guide-track" style={{ left: xOf(track.from), width: xOf(track.to - track.from), top: yOf(track.at), height: 1 }} />
            : <span key={`track-${index}`} className="guide-track" data-testid="guide-track" style={{ top: yOf(track.from), height: yOf(track.to - track.from), left: xOf(track.at), width: 1 }} />))}
          {guides?.labels.map((label, index) => <span key={`label-${index}`} className="guide-label" data-testid="guide-label" style={{ left: xOf(label.x), top: yOf(label.y) }}>{label.text}</span>)}
          {props.layers.problems && marks.map((mark, index) => (
            <span key={index} className={`mark ${mark.problem.level}`} data-testid="problem-mark" style={{ left: `${mark.box.left}%`, top: `${mark.box.top}%`, width: `${mark.box.width}%`, height: `${mark.box.height}%` }} title={mark.problem.message}>
              <span className="marker-number">{index + 1}</span>
            </span>
          ))}
          {[...hovered, ...(under ? [under] : [])].map((path) => { const node = nodes.get(path); return node ? <span key={`hover-${path}`} className="select-box hover" data-testid="hover-box" style={{ ...percent(node), ...rotated(path) }} /> : null; })}
          {instances.filter((path) => path !== main).map((path) => { const node = nodes.get(path); return node ? <span key={path} className="select-box other" style={{ ...percent(node), ...rotated(path) }} /> : null; })}
          {main && nodes.get(main) && (
            <span className="select-box" data-testid="select-box" data-path={main} style={{ ...percent(nodes.get(main)!), ...rotated(main) }}><span className="select-tag" data-testid="select-tag">{nodes.get(main)!.name} · {round(nodes.get(main)!.width)} × {round(nodes.get(main)!.height)} mm</span></span>
          )}
        </div>
      ) : (
        <div className="stage-empty">{reply ? '没有图片：问题见样例带的问题页' : preview.problems ? '预览失败' : '正在出草稿预览…'}</div>
      )}
      {legend && <span className="design-legend small" data-testid="overlay-legend">{legend}</span>}
    </div>
  );
}
