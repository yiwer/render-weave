/**
 * 树状图（M364，呈现与交互照旧 RenderWeave 的 MapSurface）：根节点在左，字段节点在右，曲线相连；必填的线更重，列表与引用再连一个虚线的说明。
 * 点节点选中；拖节点排序；拖空白处平移，滚轮缩放，左下角放大、缩小、适合窗口。搜索时不匹配的变淡，不消失。
 * 旧项目用 xyflow，这里自己画：不多一个依赖，几何在 form/definition-map.ts。键盘要做全部操作时切回表单。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { constraintText, isRequired, typeText } from '../form/definition.js';
import { edgePath, fieldTop, fitView, MAP, mapSize, orderWhileDragging, rootTop, slotOf, zoomAt, type MapView } from '../form/definition-map.js';
import type { DefinitionDocument, DefinitionField, Problem } from '../types.js';
import { fieldLabel } from './definition-fields.js';
import { Icon, MINUS, PLUS, FIT } from './icon.js';

const detailOf = (field: DefinitionField): readonly [string, string] | undefined => {
  if (field.type === 'list' && field.items) return [`每一项 · ${typeText(field.items)}`, constraintText(field.items) || '没有约束'];
  if (field.type === 'ref') return ['引用', typeText(field).replace(/^.* · /, '')];
  return undefined;
};

export function DefinitionMap(props: {
  readonly name: string;
  readonly document: DefinitionDocument;
  readonly selected: number | undefined;
  readonly onSelect: (index: number) => void;
  /** 搜索时匹配的字段；别的变淡。不给就是全部。 */
  readonly visible?: ReadonlySet<number> | undefined;
  readonly tagOf?: (field: DefinitionField, index: number) => 'added' | 'changed' | undefined;
  readonly problemsOf?: (index: number) => readonly Problem[] | undefined;
  /** 给了才能拖动排序。 */
  readonly onMove?: (from: number, to: number) => void;
  /** 给了才有"添加字段"。 */
  readonly onAdd?: () => void;
}) {
  const { document, selected, onMove } = props, fields = document.fields, count = fields.length;
  const size = mapSize(count, fields.some((field) => detailOf(field)));
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<MapView>({ x: 0, y: 0, k: 1 });
  // 用户动过缩放或平移，窗口变化时就不再替他适合窗口；字段数变了从头适合一次。
  const touched = useRef(false);
  const fit = useCallback(() => {
    const element = box.current;
    if (element) setView(fitView(size, { width: element.clientWidth, height: element.clientHeight }));
  }, [size.width, size.height]);
  useLayoutEffect(() => {
    touched.current = false;
    fit();
  }, [count, fit]);
  useEffect(() => {
    const element = box.current;
    if (!element) return undefined;
    const watcher = new ResizeObserver(() => { if (!touched.current) fit(); });
    watcher.observe(element);
    // 滚轮缩放要拦下页面滚动，React 的 onWheel 是被动的，拦不住。
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      touched.current = true;
      setView((current) => zoomAt(current, Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => { watcher.disconnect(); element.removeEventListener('wheel', onWheel); };
  }, [fit]);

  const zoomBy = (factor: number) => {
    const element = box.current;
    if (!element) return;
    touched.current = true;
    setView((current) => zoomAt(current, factor, { x: element.clientWidth / 2, y: element.clientHeight / 2 }));
  };

  // 拖空白处平移。说明节点也能点，拖过了就不算点。
  const pan = useRef<{ readonly x: number; readonly y: number; readonly view: MapView }>(undefined);
  const panMoved = useRef(false);
  const [panning, setPanning] = useState(false);
  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pan.current = { x: event.clientX, y: event.clientY, view };
    panMoved.current = false;
    setPanning(true);
  };
  const movePan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pan.current;
    if (!start) return;
    // 没按着键还收到移动，是松手的事件没到（比如松在窗口外）：就此停下。
    if (event.buttons === 0) { endPan(); return; }
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { panMoved.current = true; touched.current = true; }
    setView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
  };
  function endPan() {
    pan.current = undefined;
    setPanning(false);
  }

  // 拖节点排序：动过几个像素才算拖，没动就是点。
  const [drag, setDrag] = useState<{ readonly index: number; readonly dx: number; readonly dy: number }>();
  const press = useRef<{ readonly index: number; readonly x: number; readonly y: number; moved: boolean }>(undefined);
  const justDragged = useRef(false);
  const target = drag ? slotOf(fieldTop(drag.index) + drag.dy, count) : undefined;
  const order = drag && target !== undefined ? orderWhileDragging(count, drag.index, target) : undefined;
  const pressNode = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    justDragged.current = false;
    if (!onMove || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { index, x: event.clientX, y: event.clientY, moved: false };
  };
  const moveNode = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = press.current;
    if (!start) return;
    if (event.buttons === 0) { releaseNode(); return; }
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (!start.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    start.moved = true;
    setDrag({ index: start.index, dx: dx / view.k, dy: dy / view.k });
  };
  function releaseNode() {
    const start = press.current;
    press.current = undefined;
    if (!start?.moved) return;
    // 松手之后浏览器还会发一次点击，这次不算选中；没发就在下一轮清掉，别吞了下一次真的点击。
    justDragged.current = true;
    window.setTimeout(() => { justDragged.current = false; }, 0);
    if (target !== undefined && target !== start.index) onMove?.(start.index, target);
    setDrag(undefined);
  }

  const topOf = (index: number) => {
    if (drag?.index === index) return fieldTop(index) + drag.dy;
    return fieldTop(order ? order.indexOf(index) : index);
  };
  const leftOf = (index: number) => MAP.fieldX + (drag?.index === index ? drag.dx : 0);
  const rootMiddle = rootTop(size) + MAP.rootHeight / 2, rootRight = MAP.rootX + MAP.rootWidth;

  return (
    <section className={`definition-map${panning ? ' panning' : ''}`} data-testid="definition-map" aria-label={`${document.displayName || props.name} 的树状图；键盘要做全部操作时切回表单`}>
      <div className="map-canvas" ref={box} onPointerDown={startPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan}>
        <div className="map-layer" style={{ width: size.width, height: size.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          <svg className="map-edges" width={size.width} height={size.height} aria-hidden="true">
            {fields.map((field, index) => {
              const y = topOf(index) + MAP.fieldHeight / 2, x = leftOf(index), detail = detailOf(field);
              const dim = props.visible && !props.visible.has(index);
              return (
                <g key={index} className={dim ? 'dimmed' : undefined}>
                  <path className={`map-edge${isRequired(field) ? ' required' : ''}${selected === index ? ' selected' : ''}`} d={edgePath({ x: rootRight, y: rootMiddle }, { x, y })} />
                  <circle className={`map-port${isRequired(field) ? ' required' : ''}${selected === index ? ' selected' : ''}`} cx={x} cy={y} r="3.5" />
                  {detail && <path className="map-edge detail" d={edgePath({ x: x + MAP.fieldWidth, y }, { x: MAP.detailX + (drag?.index === index ? drag.dx : 0), y })} />}
                </g>
              );
            })}
            <circle className="map-port root" cx={rootRight} cy={rootMiddle} r="4" />
          </svg>
          <div className="map-root" style={{ left: MAP.rootX, top: rootTop(size), width: MAP.rootWidth, height: MAP.rootHeight }}>
            <small>根节点</small>
            <strong>{document.displayName || props.name}</strong>
            <code>{props.name}</code>
          </div>
          {count === 0 && <p className="muted map-empty" style={{ left: MAP.fieldX, top: rootTop(size) + 26 }}>还没有字段。</p>}
          {fields.map((field, index) => {
            const detail = detailOf(field), label = fieldLabel(field, index), required = isRequired(field), tag = props.tagOf?.(field, index);
            const problems = props.problemsOf?.(index), dim = props.visible && !props.visible.has(index), dragging = drag?.index === index;
            return (
              <div key={index}>
                <div className={`map-field${dragging ? ' dragging' : ''}`} data-testid="tree-field" data-field={field.name} data-dimmed={dim ? 'true' : undefined}
                  style={{ width: MAP.fieldWidth, height: MAP.fieldHeight, transform: `translate(${leftOf(index)}px, ${topOf(index)}px)` }}>
                  <button type="button" className={`map-node type-${field.type}${selected === index ? ' selected' : ''}${problems?.length ? ' problem' : ''}`} aria-pressed={selected === index}
                    aria-label={`查看字段 ${label}，${typeText(field)}，${required ? '必填' : '可选'}${problems?.length ? `，${problems.length} 个问题` : ''}${onMove ? '；拖动可排序' : ''}`}
                    onPointerDown={(event) => pressNode(event, index)} onPointerMove={moveNode} onPointerUp={releaseNode} onPointerCancel={releaseNode} onLostPointerCapture={releaseNode}
                    onClick={() => { if (justDragged.current) justDragged.current = false; else props.onSelect(index); }}>
                    <span className="map-node-kind">{typeText(field).split(' · ')[0]} · {required ? '必填' : '可选'}{tag === 'added' ? ' · 新增' : tag === 'changed' ? ' · 已修改' : ''}</span>
                    <strong>{label}</strong>
                    <code>{field.name || '还没写字段名称'}</code>
                  </button>
                </div>
                {detail && (
                  <div className={`map-detail${dim ? ' dimmed' : ''}`} style={{ width: MAP.detailWidth, height: MAP.detailHeight, transform: `translate(${MAP.detailX + (dragging ? drag.dx : 0)}px, ${topOf(index) + (MAP.fieldHeight - MAP.detailHeight) / 2}px)` }}
                    onClick={() => { if (!panMoved.current) props.onSelect(index); }}>
                    <span>{detail[0]}</span><code>{detail[1]}</code>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="map-legend" aria-hidden="true">
        <span><i className="heavy" />必填</span>
        <span><i />可选</span>
        <span className="map-legend-bad"><i className="bad" />红色描边待修正</span>
      </div>
      {props.onAdd && <button type="button" className="small map-add" onClick={props.onAdd}><Icon d={PLUS} />添加字段</button>}
      <div className="map-zoom" role="group" aria-label="缩放">
        <button type="button" className="icon" aria-label="放大" onClick={() => zoomBy(1.2)}><Icon d={PLUS} /></button>
        <button type="button" className="icon" aria-label="缩小" onClick={() => zoomBy(1 / 1.2)}><Icon d={MINUS} /></button>
        <button type="button" className="icon" aria-label="适合窗口" onClick={() => { touched.current = true; fit(); }}><Icon d={FIT} /></button>
      </div>
      <p className="map-status small" data-testid="map-status">{count} 个字段{onMove ? ' · 拖动节点可排序' : ''}</p>
    </section>
  );
}
