/**
 * 弹窗（M362）：用浏览器自带的 <dialog>，焦点留在弹窗里、背后不能点、关掉后焦点回到打开它的按钮，都由浏览器负责。
 * 按 Esc、点背后的遮罩都走 onClose；打开时焦点落在第一个能聚焦的控件上。
 */
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

export function Modal(props: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  // 用 layout effect：关掉要在元素从页面上移除之前，浏览器才会把焦点还给打开它的按钮。
  useLayoutEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog ref={dialog} className="modal" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); props.onClose(); }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal-body">
        <h2 id={titleId}>{props.title}</h2>
        {props.children}
      </div>
    </dialog>
  );
}
