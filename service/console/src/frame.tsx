/**
 * 控制台的框架（P1 票据 01，原型第 29 版，M208、M341）：吸顶的标题栏、吸底的状态栏，中间是当前模块。
 * - 标题栏：品牌、模块与动作（Ctrl+K）、模块下拉（按角色只列能进的模块，Ctrl+数字切换）、账号与退出；
 * - 状态栏：连接、当前租户、本月剩余张数、本标签页进行中的批次；
 * - 左栏留给 Agent（P2）：没给 agent 时不显示，右侧模块占满宽度。
 * 模块与动作的清单在 modules.ts；页面本身不知道框架，只经 # 路由切换。
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { api, isConnected, onConnectionChanged, onUsageChanged } from './api.js';
import { Logo, Loom } from './components/logo.js';
import { go, href, useLoad } from './hooks.js';
import { actionsFor, modulesFor, type ConsoleModule } from './modules.js';
import { useRunningBatches } from './pages/batches.js';
import type { Identity } from './types.js';

export const ROLE: Readonly<Record<string, string>> = { admin: '客户管理员', operator: '客户操作员', platformAdmin: '平台管理员', apiKey: 'API 密钥', authoringEngineer: '代建工程师' };

const Icon = (props: { readonly d: string }) => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true"><path d={props.d} /></svg>
);
const CHEVRON = 'M6 9l6 6 6-6';
const SEARCH = 'M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0zM20 20l-3.5-3.5';

/** Ctrl（macOS 上是 ⌘）加数字或 K：返回数字 1–9、'k'，别的按键返回 undefined。按物理键位认数字，换了键盘布局也一样。 */
function shortcutOf(event: KeyboardEvent): number | 'k' | undefined {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.isComposing) return undefined;
  if (event.key.toLowerCase() === 'k') return 'k';
  const digit = /^Digit([1-9])$/.exec(event.code);
  return digit ? Number(digit[1]) : undefined;
}

export function Frame(props: {
  readonly identity: Identity;
  readonly module?: ConsoleModule;
  /** 当前地址：换页时状态栏重新读取本月剩余。 */
  readonly page: string;
  readonly onLogout: () => void;
  /** Agent 的左栏（P2）。 */
  readonly agent?: ReactNode;
  readonly children: ReactNode;
}) {
  const modules = useMemo(() => modulesFor(props.identity), [props.identity]);
  const [commands, setCommands] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = shortcutOf(event);
      if (shortcut === undefined) return;
      if (shortcut === 'k') { event.preventDefault(); setCommands((open) => !open); return; }
      const target = modules[shortcut - 1];
      if (!target) return;
      event.preventDefault();
      setCommands(false);
      go(target.home);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modules]);

  return (
    <div className="frame">
      <header className="titlebar">
        <a className="brand" href={href(['datasets'])}><Logo />RenderWeave</a>
        <span className="titlebar-gap" />
        <button type="button" className="command-button" aria-keyshortcuts="Control+K" aria-haspopup="dialog" onClick={() => setCommands(true)}>
          <Icon d={SEARCH} /><span className="command-label">模块与动作</span><kbd aria-hidden="true">Ctrl K</kbd>
        </button>
        <ModuleSwitcher modules={modules} {...(props.module ? { current: props.module } : {})} />
        <span className="who" title={props.identity.email}>{props.identity.email} · {ROLE[props.identity.role] ?? props.identity.role}</span>
        <button type="button" className="small quiet" onClick={props.onLogout}>退出</button>
      </header>
      <div className="workspace">
        {props.agent && <aside className="agent-pane" aria-label="Agent 对话">{props.agent}</aside>}
        <main className="module">{props.children}</main>
      </div>
      <StatusBar page={props.page} />
      {commands && <CommandPalette identity={props.identity} modules={modules} onClose={() => setCommands(false)} />}
    </div>
  );
}

/** 模块下拉：点开列出能进的模块；方向键在项之间移动，Esc 或点在外面关掉。 */
function ModuleSwitcher(props: { readonly modules: readonly ConsoleModule[]; readonly current?: ConsoleModule }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  // 换了页面（点了模块、Ctrl+数字、页面里的链接）就收起下拉。
  useEffect(() => {
    const close = () => setOpen(false);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const away = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    (menu.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? menu.current?.querySelector<HTMLElement>('[role="menuitem"]'))?.focus();
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined && items.length) {
      event.preventDefault();
      items[(move + items.length) % items.length]!.focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false);
      if (event.key === 'Escape') button.current?.focus();
    }
  };
  const current = props.current;
  return (
    <div className="switcher" ref={root}>
      <button type="button" ref={button} className="switcher-button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'module-menu' : undefined}
        aria-label={`切换模块，当前为${current?.label ?? '无'}`} onClick={() => setOpen((value) => !value)}>
        {current && <Icon d={current.icon} />}{current?.label ?? '模块'}<Icon d={CHEVRON} />
      </button>
      {open && (
        <div id="module-menu" className="menu" role="menu" aria-label="模块" ref={menu} onKeyDown={onKeyDown}>
          {props.modules.map((module, index) => (
            <a key={module.id} role="menuitem" href={href(module.home)} aria-current={module.id === current?.id ? 'page' : undefined}
              aria-keyshortcuts={`Control+${index + 1}`} onClick={() => setOpen(false)}>
              <Icon d={module.icon} /><span className="menu-label">{module.label}</span><kbd aria-hidden="true">Ctrl+{index + 1}</kbd>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** 换页之后等目标元素出现再给它焦点，最多等两秒（页面的数据是异步读的）。 */
function focusWhenReady(id: string, deadline = performance.now() + 2000): void {
  const element = document.getElementById(id);
  if (element) { element.focus(); element.scrollIntoView({ block: 'center' }); return; }
  if (performance.now() < deadline) requestAnimationFrame(() => focusWhenReady(id, deadline));
}

interface Command { readonly id: string; readonly group: '模块' | '动作'; readonly label: string; readonly path: readonly string[]; readonly focus?: string; readonly hint?: string }

/** Ctrl+K：模块与常用动作的列表，输入几个字筛选，方向键选、回车打开；不搜数据集、模板这类对象。 */
function CommandPalette(props: { readonly identity: Identity; readonly modules: readonly ConsoleModule[]; readonly onClose: () => void }) {
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null), returnTo = useRef<Element | null>(null);
  useEffect(() => {
    returnTo.current = document.activeElement;
    input.current?.focus();
  }, []);
  const all: readonly Command[] = [
    ...props.modules.map((module, index): Command => ({ id: `module-${module.id}`, group: '模块', label: module.label, path: module.home, hint: `Ctrl+${index + 1}` })),
    ...actionsFor(props.identity).map((action): Command => ({ id: `action-${action.id}`, group: '动作', label: action.label, path: action.path, ...(action.focus ? { focus: action.focus } : {}) })),
  ];
  const needle = text.trim().toLowerCase();
  const shown = all.filter((command) => command.label.toLowerCase().includes(needle));
  const chosen = shown[Math.min(active, shown.length - 1)];
  const close = () => {
    props.onClose();
    if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
  };
  const run = (command: Command) => {
    props.onClose();
    go(command.path);
    if (command.focus) focusWhenReady(command.focus);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (shown.length) setActive((Math.min(active, shown.length - 1) + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (chosen) run(chosen);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      // 对话框里只有输入框可以聚焦：焦点不离开对话框。
      event.preventDefault();
    }
  };
  const group = (name: Command['group']) => {
    const commands = shown.filter((command) => command.group === name);
    return commands.length > 0 && (
      <div role="group" aria-label={name}>
        <div className="command-group" aria-hidden="true">{name}</div>
        {commands.map((command) => (
          <div key={command.id} id={command.id} role="option" aria-selected={command === chosen} className="command-option"
            onPointerMove={() => setActive(shown.indexOf(command))} onClick={() => run(command)}>
            <span>{command.label}</span>{command.hint && <kbd aria-hidden="true">{command.hint}</kbd>}
          </div>
        ))}
      </div>
    );
  };
  return (
    <>
      <div className="scrim light" onClick={close} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="模块与动作" onKeyDown={onKeyDown}>
        <input ref={input} type="text" role="combobox" aria-label="筛选模块与动作" placeholder="输入模块或动作，如：导入、上传" aria-expanded="true"
          aria-controls="command-list" aria-autocomplete="list" {...(chosen ? { 'aria-activedescendant': chosen.id } : {})}
          value={text} onChange={(event) => { setText(event.target.value); setActive(0); }} />
        <div id="command-list" role="listbox" aria-label="模块与动作">
          {group('模块')}
          {group('动作')}
          {shown.length === 0 && <p className="muted small command-empty">没有对应的模块或动作。这里不搜数据集与模板，请到对应的模块里找。</p>}
        </div>
      </div>
    </>
  );
}

const useConnected = () => useSyncExternalStore((changed) => onConnectionChanged(changed), isConnected);

/**
 * 本月剩余张数：客户管理员与操作员都看得到（M300）。提交、取消批次与批次结束时重新读取；
 * 换页时也读一次，并且每分钟读一次（连不上时每 10 秒），别的成员或 API 密钥出的图在这里看得到，连接状态也随之更新。
 */
function Quota(props: { readonly page: string }) {
  const [text, setText] = useState<string>();
  const [version, setVersion] = useState(0);
  const connected = useConnected();
  useEffect(() => onUsageChanged(() => setVersion((value) => value + 1)), []);
  useEffect(() => {
    let live = true;
    const read = () => api.usage().then((usage) => {
      if (live) setText(`本月剩余 ${usage.images.remaining.toLocaleString('zh-CN')} / ${usage.images.limit.toLocaleString('zh-CN')} 张`);
    }, () => undefined);
    void read();
    const timer = window.setInterval(() => void read(), connected ? 60_000 : 10_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [props.page, version, connected]);
  return text ? <span className="quota" data-testid="quota">{text}</span> : null;
}

/** 状态栏：连接、租户、本月剩余与进行中的批次；窄窗口下先收起租户名。 */
function StatusBar(props: { readonly page: string }) {
  const connected = useConnected();
  const tenant = useLoad(() => api.tenant(), 'tenant');
  const running = useRunningBatches();
  return (
    <footer className="statusbar" aria-label="状态栏">
      <span className="state" data-testid="connection"><span className={`dot ${connected ? 'ok' : 'bad'}`} aria-hidden="true" />{connected ? '已连接' : '连不上出图服务'}</span>
      {tenant.data && <span className="tenant" data-testid="tenant" title="当前租户">{tenant.data.name}</span>}
      <span className="statusbar-gap" />
      <Quota page={props.page} />
      {running.length > 0
        ? <a href={href(running.length === 1 ? ['batches', running[0]!] : ['batches'])} data-testid="running-batches"><Loom />进行中的批次 {running.length}</a>
        : <span className="faint" data-testid="running-batches">没有进行中的批次</span>}
    </footer>
  );
}
