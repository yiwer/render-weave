/**
 * 舞台上的手柄（模板设计页票据 13，M392）：画在选中的那一处上。拖动中只画幽灵框、插入线与读数，不写回、不出图；
 * 松手把结果交给页面，页面记一步撤销、暂存、出图。能拖什么、写什么由 template/handles.ts 定。Esc 取消这次拖动。
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { applyHandle, handlesOf, type Box, type Handle, type HandleInput, type HandleResult } from '../template/handles.js';

/** 按下后挪过几个像素才算拖动：少于这个是点击，交给舞台点选。 */
const DRAG_PX = 3;

export function HandleLayer(props: {
  readonly input: HandleInput; readonly output: { readonly width: number; readonly height: number };
  /** 旋转的元素：移动区跟着框转过去。 */
  readonly rotation?: CSSProperties;
  /** 方向键挪完的读数，过一会儿消失。 */
  readonly note?: string;
  readonly onCommit: (result: HandleResult) => void;
}) {
  const { input, output } = props;
  const set = useMemo(() => handlesOf(input), [input]);
  const [live, setLive] = useState<{ readonly id: string; readonly result?: HandleResult }>();
  const stopDrag = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopDrag.current?.(), []);
  const x = (value: number) => `${(value / output.width) * 100}%`, y = (value: number) => `${(value / output.height) * 100}%`;
  const boxStyle = (box: Box): CSSProperties => ({ left: x(box.x), top: y(box.y), width: x(box.width), height: y(box.height) });

  const start = (handle: Handle) => (event: ReactPointerEvent<HTMLElement>) => {
    // Alt 是沿层叠往下穿透点选，不拖。
    if (event.button !== 0 || event.altKey) return;
    const canvas = event.currentTarget.closest('[data-testid="design-canvas"]')?.getBoundingClientRect();
    if (!canvas) return;
    // 移动区不拦默认动作：点它和点图一样，焦点回到页面，方向键接着能用。
    if (handle.id !== 'move') event.preventDefault();
    const scale = canvas.width / output.width, from = { x: event.clientX, y: event.clientY };
    let moved = false, result: HandleResult | undefined;
    const move = (next: PointerEvent) => {
      if (!moved && Math.abs(next.clientX - from.x) + Math.abs(next.clientY - from.y) < DRAG_PX) return;
      moved = true;
      result = applyHandle(input, {
        handle: handle.id, dx: (next.clientX - from.x) / scale, dy: (next.clientY - from.y) / scale,
        point: { x: (next.clientX - canvas.left) / scale, y: (next.clientY - canvas.top) / scale }, fine: next.shiftKey,
      });
      setLive(result ? { id: handle.id, result } : { id: handle.id });
    };
    const finish = (commit: boolean) => {
      stop();
      setLive(undefined);
      if (moved) {
        // 拖完松手不算点击：不然舞台会按落点重新点选。
        const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
        window.addEventListener('click', swallow, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      }
      if (commit && result) props.onCommit(result);
    };
    let cancelled = false;
    const up = () => finish(!cancelled);
    const cancel = () => finish(false);
    // 先于页面接住 Esc：取消拖动，不是选上一层。还按着键：等松手再收尾，那一下也不算点击。
    const key = (next: KeyboardEvent) => {
      if (next.key !== 'Escape') return;
      next.preventDefault();
      next.stopPropagation();
      cancelled = true;
      result = undefined;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('keydown', key, true);
      setLive(undefined);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      stopDrag.current = undefined;
    };
    stopDrag.current?.();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    stopDrag.current = stop;
  };

  const result = live?.result;
  const anchor = result?.ghost ?? result?.line ?? input.node;
  const readout = live ? result?.readout ?? '没有变化' : props.note;
  return (
    <>
      {set.handles.map((handle) => {
        const common = { title: handle.label, 'data-handle': handle.id, onPointerDown: start(handle) };
        if (handle.id === 'move') return <span key="move" className={`handle-body${live?.id === 'move' ? ' dragging' : ''}`} data-testid="handle-move" style={{ ...boxStyle(handle.bar!), ...props.rotation, cursor: handle.cursor }} {...common} />;
        // 间距条与轨道线：点它不改选中。
        if (handle.bar) return <span key={handle.id} className={`handle-bar${handle.bar.width === 0 ? ' vertical' : handle.bar.height === 0 ? ' horizontal' : ''}${live?.id === handle.id ? ' dragging' : ''}`} data-testid="handle-bar" style={{ ...boxStyle(handle.bar), cursor: handle.cursor }} onClick={(event) => event.stopPropagation()} {...common} />;
        return <span key={handle.id} className={`handle${live?.id === handle.id ? ' dragging' : ''}`} data-testid="handle" style={{ left: x(handle.x), top: y(handle.y), cursor: handle.cursor }} onClick={(event) => event.stopPropagation()} {...common} />;
      })}
      {result?.ghost && <span className="handle-ghost" data-testid="handle-ghost" style={boxStyle(result.ghost)} />}
      {result?.line && <span className={`handle-line${result.line.width === 0 ? ' vertical' : result.line.height === 0 ? ' horizontal' : ''}`} data-testid="handle-line" style={boxStyle(result.line)} />}
      {readout && <span className="handle-readout" data-testid="handle-readout" role="status" style={{ left: x(anchor.x), top: y(anchor.y + anchor.height) }}>{readout}</span>}
    </>
  );
}
