/**
 * 左面板的结构页（模板设计页票据 05，方案第 5 节）：一棵树从根模板展开到循环模板与子模板，竖线标出作用域边界。
 * 这一票只选不改；改结构在票据 12。元素最多几十个，不需要虚拟滚动。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CHEVRON_RIGHT, EYE_OFF, Icon } from '../components/icon.js';
import { ELEMENT_TYPES } from '../template/properties.js';
import { ancestorKeys, buildTree, type TreeNode } from '../template/tree.js';
import type { JsonObject } from '../template/document.js';
import type { PreviewReply } from '../types.js';
import { ELEMENT_ICONS } from './icons.js';
import type { Selection } from './stage.js';

export interface TreeSource { readonly template: string; readonly path: string }

export function DesignStructure(props: {
  readonly root: string; readonly documentOf: (template: string) => JsonObject | undefined; readonly selection?: Selection; readonly reply?: PreviewReply; readonly locateTick: number;
  readonly onSelect: (template: string, path: string) => void; readonly onHover: (source: TreeSource | undefined) => void; readonly onMenu: (x: number, y: number, template: string, path: string) => void;
}) {
  const { root, documentOf, selection, reply } = props;
  const tree = buildTree(root, documentOf);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set([root]));
  const toggle = (key: string) => setExpanded((now) => { const next = new Set(now); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const list = useRef<HTMLUListElement>(null);

  // 选中时展开到那一行，再滚过去。
  useEffect(() => {
    if (selection?.instance) setExpanded((now) => new Set([...now, ...ancestorKeys(selection.instance!)]));
  }, [selection?.instance]);
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

  const rowOf = (node: TreeNode): ReactNode => {
    const source = `${node.template}\n${node.path}`, shown = facts.instances.get(source) ?? [];
    const isSelected = selection?.template === node.template && selection.path === node.path;
    const hidden = Boolean(reply?.elements) && shown.length === 0;
    const hasKids = node.children.length > 0 || node.called !== undefined, open = expanded.has(node.key);
    const items = node.type === 'loop' ? (reply?.elements ?? []).filter((element) => shown.some((path) => new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\[\\d+\\]$`).test(element.path))).length : undefined;
    return (
      <li key={node.key}>
        <div className={`tree-row${hidden ? ' hidden-now' : ''}`} data-testid="structure-row" data-path={node.path} data-selected={isSelected}
          onMouseEnter={() => props.onHover({ template: node.template, path: node.path })} onMouseLeave={() => props.onHover(undefined)}
          onContextMenu={(event) => { event.preventDefault(); props.onMenu(event.clientX, event.clientY, node.template, node.path); }}>
          <button type="button" className="tree-button" aria-current={isSelected ? 'true' : undefined} title={node.path} onClick={() => props.onSelect(node.template, node.path)}>
            <Icon d={ELEMENT_ICONS[node.type] ?? ELEMENT_ICONS['container']!} />
            <span className="tree-name">{node.name}</span>
            <span className="visually-hidden">{ELEMENT_TYPES[node.type] ?? node.type}</span>
          </button>
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
                      进入模板「{node.called.template}」{node.called.base ? ` · 基准 ${node.called.base}` : ''}
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
  return <ul className="tree" ref={list} data-testid="structure">{rowOf(tree)}</ul>;
}
