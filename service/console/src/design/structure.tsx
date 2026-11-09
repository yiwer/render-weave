/**
 * 左面板的结构页（模板设计页票据 05，方案第 5 节）：一棵树从根模板展开到循环模板与子模板，竖线标出作用域边界。
 * 改结构（票据 12）：拖动排序、就地改名；复制、删除、包进容器等在右键菜单与快捷键里，写回都是 template/structure.ts。
 * 拖动只在同一个模板里：别的模板的元素在别的文档里。元素最多几十个，不需要虚拟滚动。
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { DropZone } from '../template/structure.js';
import { CHEVRON_RIGHT, EYE_OFF, Icon } from '../components/icon.js';
import { ELEMENT_TYPES } from '../template/properties.js';
import { ancestorKeys, buildTree, type TreeNode } from '../template/tree.js';
import type { JsonObject } from '../template/document.js';
import type { PreviewReply } from '../types.js';
import { ELEMENT_ICONS } from './icons.js';
import type { Selection } from './stage.js';

export interface TreeSource { readonly template: string; readonly path: string }

/** 就地改名：回车提交，名称不合规时当场说明，Esc 或离开就作罢。 */
function RenameInput(props: { readonly initial: string; readonly onCommit: (name: string) => string | undefined; readonly onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const [problem, setProblem] = useState<string>();
  return (
    <span className="tree-rename">
      <input type="text" autoFocus aria-label="新名称" value={value} aria-invalid={problem ? true : undefined} data-testid="rename-input"
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => { setValue(event.target.value); setProblem(undefined); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (value === props.initial) props.onCancel(); else setProblem(props.onCommit(value)); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
        }}
        onBlur={props.onCancel} />
      {problem && <span className="prop-error" role="alert">{problem}</span>}
    </span>
  );
}

export function DesignStructure(props: {
  readonly root: string; readonly documentOf: (template: string) => JsonObject | undefined; readonly selection?: Selection; readonly reply?: PreviewReply; readonly locateTick: number;
  readonly onSelect: (template: string, path: string) => void; readonly onHover: (source: TreeSource | undefined) => void; readonly onMenu: (x: number, y: number, template: string, path: string) => void;
  /** 正在改名的元素；onRename 回答问题时留在输入框里。 */
  readonly renaming?: TreeSource; readonly onRename: (template: string, path: string, name: string) => string | undefined; readonly onRenameDone: () => void;
  readonly onDrop: (template: string, path: string, over: string, zone: DropZone) => void;
}) {
  const { root, documentOf, selection, reply } = props;
  const dragged = useRef<TreeSource | undefined>(undefined);
  const [drop, setDrop] = useState<{ readonly key: string; readonly zone: DropZone }>();
  const tree = buildTree(root, documentOf);
  // 一开始就展开到选中的那一行：切回结构页时不先画一棵收起的树再跳开。
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([
    root,
    ...(selection?.instance ? ancestorKeys(selection.instance) : []),
    ...(selection && !selection.instance && selection.template === root ? ancestorKeys(selection.path) : []),
  ]));
  const toggle = (key: string) => setExpanded((now) => { const next = new Set(now); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const list = useRef<HTMLUListElement>(null);

  // 选中时展开到那一行，再滚过去。
  useEffect(() => {
    if (selection?.instance) setExpanded((now) => new Set([...now, ...ancestorKeys(selection.instance!)]));
  }, [selection?.instance]);
  // 改完结构选中的是路径、还没有实例（新预览没回来）：根模板里的路径就是树的位置，一样展开过去，拖进收起的容器也看得见。
  useEffect(() => {
    if (selection && !selection.instance && selection.template === root) setExpanded((now) => new Set([...now, ...ancestorKeys(selection.path)]));
  }, [selection?.path, selection?.instance, root]);
  useEffect(() => {
    list.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selection?.instance, selection?.path, expanded, props.locateTick]);

  // 图上的情况：每个定义有几处实例，循环展开了几项，哪里有问题。
  const facts = useMemo(() => {
    const instances = new Map<string, string[]>(), locations = new Map<string, string>();
    for (const element of reply?.elements ?? []) {
      const key = `${element.source.template}\n${element.source.path}`;
      instances.set(key, [...(instances.get(key) ?? []), element.path]);
      locations.set(element.path, key);
    }
    const flagged = new Set<string>();
    for (const problem of reply?.problems ?? []) if (problem.location.kind === 'element') { const key = locations.get(problem.location.path); if (key) flagged.add(key); }
    return { instances, flagged };
  }, [reply]);

  /** 拖到这一行的哪里：上半、下半，能装子元素的中间一段是放进去。 */
  const zoneOf = (event: DragEvent<HTMLElement>, node: TreeNode): DropZone | undefined => {
    const from = dragged.current;
    if (!from || from.template !== node.template || node.path === from.path || node.path.startsWith(`${from.path}/`)) return undefined;
    const holds = node.path === node.template || node.type === 'container';
    if (node.path === node.template) return 'inside';
    const box = event.currentTarget.getBoundingClientRect(), at = (event.clientY - box.top) / box.height;
    if (holds && at > 0.3 && at < 0.7) return 'inside';
    return at < 0.5 ? 'before' : 'after';
  };
  const rowOf = (node: TreeNode): ReactNode => {
    const source = `${node.template}\n${node.path}`, shown = facts.instances.get(source) ?? [];
    const renaming = props.renaming?.template === node.template && props.renaming.path === node.path && node.path !== node.template;
    const movable = node.path !== node.template;
    const dropHere = drop?.key === node.key ? ` drop-${drop.zone}` : '';
    const isSelected = selection?.template === node.template && selection.path === node.path;
    const hidden = Boolean(reply?.elements) && shown.length === 0;
    const hasKids = node.children.length > 0 || node.called !== undefined, open = expanded.has(node.key);
    const items = node.type === 'loop' ? (reply?.elements ?? []).filter((element) => shown.some((path) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[\\d+\\]$`).test(element.path))).length : undefined;
    return (
      <li key={node.key}>
        <div className={`tree-row${hidden ? ' hidden-now' : ''}${dropHere}`} data-testid="structure-row" data-path={node.path} data-selected={isSelected}
          draggable={movable && !renaming}
          onDragStart={(event) => { dragged.current = { template: node.template, path: node.path }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', node.path); }}
          onDragEnd={() => { dragged.current = undefined; setDrop(undefined); }}
          onDragOver={(event) => { const zone = zoneOf(event, node); if (!zone) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (drop?.key !== node.key || drop.zone !== zone) setDrop({ key: node.key, zone }); }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(undefined); }}
          onDrop={(event) => { const zone = zoneOf(event, node), from = dragged.current; event.preventDefault(); setDrop(undefined); dragged.current = undefined; if (zone && from) props.onDrop(from.template, from.path, node.path, zone); }}
          onMouseEnter={() => props.onHover({ template: node.template, path: node.path })} onMouseLeave={() => props.onHover(undefined)}
          onContextMenu={(event) => { event.preventDefault(); props.onMenu(event.clientX, event.clientY, node.template, node.path); }}>
          {renaming
            ? <RenameInput initial={node.name} onCommit={(name) => props.onRename(node.template, node.path, name)} onCancel={props.onRenameDone} />
            : (
              <button type="button" className="tree-button" aria-current={isSelected ? 'true' : undefined} title={node.path} onClick={() => props.onSelect(node.template, node.path)}>
                <Icon d={ELEMENT_ICONS[node.type] ?? ELEMENT_ICONS['container']!} />
                <span className="tree-name">{node.name}</span>
                <span className="visually-hidden">{ELEMENT_TYPES[node.type] ?? node.type}</span>
              </button>
            )}
          {hasKids
            ? <button type="button" className={`tree-toggle${open ? ' open' : ''}`} aria-label={`${open ? '收起' : '展开'} ${node.name}`} aria-expanded={open} onClick={() => toggle(node.key)}><Icon d={CHEVRON_RIGHT} /></button>
            : <span className="tree-toggle-space" aria-hidden="true" />}
          <span className="tree-marks small faint">
            {items !== undefined && <span className="tree-count" data-testid="loop-count">×{items}</span>}
            {node.layout && <span>{node.layout}</span>}
            {node.conditional && <span title="条件显示">显隐</span>}
            {node.hasStates && <span title="有状态样式">状态</span>}
            {hidden && <span title="当前样例不显示" data-testid="row-hidden"><Icon d={EYE_OFF} /></span>}
            {facts.flagged.has(source) && <span className="tree-flag" title="有问题" data-testid="row-problem" aria-label="有问题">●</span>}
          </span>
        </div>
        {hasKids && open && (
          <>
            {node.children.length > 0 && <ul>{node.children.map(rowOf)}</ul>}
            {node.called && (
              <ul className="tree-scope">
                <li>
                  {node.called.state === 'cycle' && <p className="tree-note warn" data-testid="row-cycle">调用成环：{node.called.template} 已经在这条调用链上（template.callCycle）</p>}
                  {node.called.state === 'missing' && <p className="tree-note warn">读不到模板 {node.called.template}</p>}
                  {node.called.state === 'ok' && (
                    <button type="button" className="tree-scope-head" title={`选中 ${node.called.template} 的画板`} onClick={() => props.onSelect(node.called!.template, node.called!.template)}>
                      进入模板「{node.called.template}」{node.called.feed ? ` · ${node.called.feed}` : ''}
                    </button>
                  )}
                </li>
                {node.called.children.map(rowOf)}
              </ul>
            )}
          </>
        )}
      </li>
    );
  };
  if (!tree) return <p className="small muted">正在读取模板…</p>;
  return (
    <>
      <p className="tree-hint small faint">顺序就是 DSL 的顺序：后面的压在前面的上面，也是堆叠里的先后。拖动排序，右键看更多操作。</p>
      <ul className="tree" ref={list} data-testid="structure">{rowOf(tree)}</ul>
    </>
  );
}
