/**
 * 右键菜单（P1 票据 06，原型画板 06）：行上右键打开，或点行尾的"更多操作"按钮打开，键盘与触屏也够得到。
 * 方向键在项之间移动，Esc、点在外面或滚动就关掉；菜单不超出窗口。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface ContextMenuItem {
  readonly label: string;
  /** 项右边的小字，如版本号、为什么不能点。 */
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export function ContextMenu(props: { readonly label: string; readonly at: { readonly x: number; readonly y: number }; readonly items: readonly ContextMenuItem[]; readonly onClose: () => void }) {
  const { onClose } = props;
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: props.at.x, top: props.at.y });
  useLayoutEffect(() => {
    const box = menu.current!.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(props.at.x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(props.at.y, window.innerHeight - box.height - 8)) });
    menu.current!.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [props.at.x, props.at.y]);
  useEffect(() => {
    const away = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) onClose(); };
    const close = () => onClose();
    // 刚打开时到的滚动事件是打开之前就在路上的（惯性滚动、内容变高时浏览器调整位置），不算，否则菜单一闪就没了。
    const openedAt = performance.now();
    const scrolled = () => { if (performance.now() - openedAt > 200) onClose(); };
    document.addEventListener('pointerdown', away);
    window.addEventListener('scroll', scrolled, true);
    window.addEventListener('hashchange', close);
    return () => {
      document.removeEventListener('pointerdown', away);
      window.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('hashchange', close);
    };
  }, [onClose]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined && items.length) {
      event.preventDefault();
      items[(move + items.length) % items.length]!.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose();
    }
  };
  return (
    <div className="menu context-menu" role="menu" aria-label={props.label} ref={menu} style={position} onKeyDown={onKeyDown}>
      {props.items.map((item) => (
        <button key={item.label} type="button" role="menuitem" disabled={item.disabled} onClick={() => { onClose(); item.run(); }}>
          <span className="menu-label">{item.label}</span>{item.hint && <kbd aria-hidden="true">{item.hint}</kbd>}
        </button>
      ))}
    </div>
  );
}
