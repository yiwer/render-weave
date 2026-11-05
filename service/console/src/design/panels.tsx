/**
 * 左面板与检查器的内容（模板设计页票据 03）：结构与变量在左，属性在右，右边永远只显示选中的东西。
 * 字段都从模板文档与 Schema 生成（template/properties.ts）；只能填数，手柄见票据 13。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ProblemList } from '../components/problems.js';
import { FieldRow, FieldRows, type FieldContext } from '../components/property-fields.js';
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import { useLoad } from '../hooks.js';
import { elementAt, elementTree, flatElements, isObject, relatedChecks, type ElementNode, type JsonObject } from '../template/document.js';
import { ELEMENT_TYPES, listItemPanel, propertyPanel, writeListItem, writeProperty, type FieldPath } from '../template/properties.js';
import type { DesignDoc, DesignSession } from '../template/session.js';
import type { PreviewReply } from '../types.js';
import type { Selection } from './stage.js';

/** 建议项：变量、字段与资源。内置的数据定义（单值文本）没有静态版本，只是少几条建议。 */
function useFieldLists(doc: DesignDoc): { readonly lists: FieldContext['lists']; readonly element: ReactNode } {
  const base = isObject(doc.document['base']) ? doc.document['base'] as { name: string; version: number } : undefined;
  const compiled = useLoad(() => (base ? api.staticSchema(base.name, base.version).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${base?.name}@${base?.version}`);
  const resources = useLoad(() => api.resources(), 'design-resources');
  const fields = useMemo(() => {
    if (!compiled.data) return [];
    const names: string[] = [];
    for (const field of formOf(compiled.data.compiled as FormObject).fields) {
      names.push(field.name);
      if (field.spec.kind === 'object') for (const inner of field.spec.fields) names.push(`${field.name}.${inner.name}`);
    }
    return names;
  }, [compiled.data]);
  const named = (list: string) => (Array.isArray(doc.document[list]) ? (doc.document[list] as unknown[]).flatMap((item) => (isObject(item) && typeof item['name'] === 'string' ? [item['name']] : [])) : []);
  const variables = [...named('parameters'), ...named('derived'), ...fields];
  const refs = (kind: 'font' | 'image') => (resources.data?.resources ?? []).filter((resource) => resource.kind === kind).map((resource) => `res:${resource.id}`);
  const options = (id: string, values: readonly string[]) => <datalist id={id}>{values.map((value) => <option key={value} value={value} />)}</datalist>;
  return {
    lists: { variable: 'design-variables', field: 'design-fields', font: 'design-fonts', image: 'design-images' },
    element: <>{options('design-variables', variables)}{options('design-fields', fields)}{options('design-fonts', refs('font'))}{options('design-images', refs('image'))}</>,
  };
}

/** 右边的检查器：选中的东西。没有选中时是画板的入口。 */
export function DesignInspector(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly selected?: Selection; readonly reply?: PreviewReply;
  readonly onSelect: (path: string) => void; readonly onSelected: (selection: Selection) => void; readonly onOpenTemplate: (template: string) => void;
}) {
  const { doc, session, selected } = props;
  const { lists, element } = useFieldLists(doc);
  const edit = (document: JsonObject, key: string) => session.edit(doc.name, document, key);
  return (
    <>
      {element}
      <PropertiesTab key={`${doc.name}\n${selected?.path ?? ''}`} doc={doc} selected={selected} reply={props.reply} lists={lists} onEdit={edit} onSelect={props.onSelect} onSelected={props.onSelected} onOpenTemplate={props.onOpenTemplate} />
      {selected && <ElementRules key={`${doc.name}\n${selected.path}\nrules`} doc={doc} path={selected.path} reply={props.reply} lists={lists} onEdit={edit} />}
    </>
  );
}

/** 左面板的结构页。 */
export function DesignStructure(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly locateTick: number;
  readonly onSelect: (path: string) => void; readonly onOpenTemplate: (template: string) => void; readonly onMenu: (x: number, y: number, path: string) => void;
}) {
  return <StructureTab doc={props.doc} selected={props.selected} locateTick={props.locateTick} onSelect={props.onSelect} onOpenTemplate={props.onOpenTemplate} onMenu={props.onMenu} />;
}

/** 左面板的变量页：参数与检查项。 */
export function DesignVariables(props: { readonly doc: DesignDoc; readonly session: DesignSession; readonly open?: string; readonly onOpen: (name: string | undefined) => void }) {
  const { doc, session } = props;
  const { lists, element } = useFieldLists(doc);
  const edit = (document: JsonObject, key: string) => session.edit(doc.name, document, key);
  return (
    <>
      {element}
      <ParametersTab key={doc.name} doc={doc} lists={lists} open={props.open} onOpen={props.onOpen} onEdit={edit} />
      <AllChecks doc={doc} lists={lists} onEdit={edit} />
    </>
  );
}

function PropertiesTab(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly reply?: PreviewReply; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void;
  readonly onSelect: (path: string) => void; readonly onSelected: (selection: Selection) => void; readonly onOpenTemplate: (template: string) => void;
}) {
  const { doc, selected, reply } = props;
  const path = selected?.path, panel = path ? propertyPanel(doc.document, path) : undefined;
  if (!path || !panel) {
    return (
      <div className="inspector-empty">
        <p className="muted">在图上点选一个元素，或者到结构页里选。</p>
        <button type="button" className="small quiet" onClick={() => props.onSelect(doc.name)}>选中画板</button>
      </div>
    );
  }
  const segments = path.split('/'), element = elementAt(doc.document, path)?.element;
  const shown = !reply?.elements || reply.elements.some((item) => item.source.template === doc.name && item.source.path === path);
  const context: FieldContext = {
    lists: props.lists,
    onWrite: (fieldPath: FieldPath, value: unknown) => {
      props.onEdit(writeProperty(doc.document, path, fieldPath, value), `${path}:${fieldPath.join('.')}`);
      // 改名之后元素路径跟着变，选中不丢。
      if (fieldPath.length === 1 && fieldPath[0] === 'name' && typeof value === 'string') props.onSelected({ template: doc.name, path: [...segments.slice(0, -1), value].join('/') });
    },
  };
  const template = typeof element?.['template'] === 'string' ? element['template'] : undefined;
  return (
    <div data-testid="properties" data-path={path} data-type={panel.type}>
      <div className="inspector-head">
        <h2>{segments.at(-1)}</h2>
        <span className="small muted">{ELEMENT_TYPES[panel.type] ?? panel.type}</span>
      </div>
      <nav className="element-path" aria-label="元素路径" data-testid="selected-path">
        {segments.map((segment, index) => {
          const prefix = segments.slice(0, index + 1).join('/');
          return <span key={prefix}>{index > 0 && <span aria-hidden="true">/</span>}{index === segments.length - 1 ? <code>{segment}</code> : <button type="button" className="link mono" onClick={() => props.onSelect(prefix)}>{segment}</button>}</span>;
        })}
      </nav>
      {!shown && <p className="small muted">当前数据下这个元素不显示，图上没有框。</p>}
      {template && <p className="small"><button type="button" className="link" onClick={() => props.onOpenTemplate(template)}>打开子模板 {template}</button></p>}
      {panel.groups.map((group) => (
        <section key={group.name} className="prop-section" aria-label={group.name}>
          <h3>{group.name}</h3>
          <FieldRows fields={group.fields} context={context} />
        </section>
      ))}
    </div>
  );
}

const PARAMETER_TYPES: Readonly<Record<string, string>> = { text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '时间', boolean: '布尔', image: '图片', color: '颜色' };

function ParametersTab(props: {
  readonly doc: DesignDoc; readonly lists: FieldContext['lists']; readonly open?: string; readonly onOpen: (name: string | undefined) => void; readonly onEdit: (document: JsonObject, key: string) => void;
}) {
  const { doc, open } = props;
  const [name, setName] = useState('');
  const parameters = Array.isArray(doc.document['parameters']) ? (doc.document['parameters'] as unknown[]).filter(isObject) : [];
  const trimmed = name.trim(), taken = parameters.some((item) => item['name'] === trimmed), valid = trimmed !== '' && !trimmed.includes('.') && !taken;
  const add = () => {
    props.onEdit({ ...doc.document, parameters: [...parameters, { name: trimmed, displayName: trimmed, visibility: 'public', type: 'text', default: '' }] }, `parameters:add:${trimmed}`);
    props.onOpen(trimmed);
    setName('');
  };
  const section = (title: string, visibility: string) => {
    const shown = parameters.filter((item) => item['visibility'] === visibility);
    return (
      <section className="prop-section" aria-label={title}>
        <h3>{title}</h3>
        {shown.length === 0 && <p className="small muted">没有。</p>}
        {shown.map((parameter) => {
          const parameterName = String(parameter['name']), index = parameters.indexOf(parameter), expanded = open === parameterName;
          const context: FieldContext = {
            lists: props.lists,
            onWrite: (path, value) => props.onEdit(writeListItem(doc.document, 'parameters', index, path, value), `parameters:${parameterName}:${path.join('.')}`),
          };
          return (
            <div key={parameterName} className={`list-row${expanded ? ' selected' : ''}`} data-testid="parameter-row" data-name={parameterName}>
              <button type="button" className="list-row-button" aria-expanded={expanded} onClick={() => props.onOpen(expanded ? undefined : parameterName)}>
                <span>{String(parameter['displayName'] ?? parameterName)}</span>
                <span className="small muted mono">{parameterName} · {PARAMETER_TYPES[String(parameter['type'])] ?? String(parameter['type'])}</span>
              </button>
              {expanded && (
                <div className="list-row-body">
                  {listItemPanel(doc.document, 'parameters', index).map((field) => <FieldRow key={field.key} field={field} context={context} />)}
                  <button type="button" className="link danger" onClick={() => { props.onEdit({ ...doc.document, parameters: parameters.filter((item) => item !== parameter) }, `parameters:delete:${parameterName}`); props.onOpen(undefined); }}>删除这个参数</button>
                </div>
              )}
            </div>
          );
        })}
      </section>
    );
  };
  return (
    <div data-testid="parameters">
      {section('对外参数', 'public')}
      {section('内部参数', 'internal')}
      <form className="prop-actions" aria-label="添加参数" onSubmit={(event) => { event.preventDefault(); if (valid) add(); }}>
        <input type="text" aria-label="新参数的名称" placeholder="新参数的名称，一般用英文" value={name} onChange={(event) => setName(event.target.value)} aria-invalid={taken ? true : undefined} />
        <button type="submit" className="small quiet" disabled={!valid}>添加参数</button>
      </form>
    </div>
  );
}

function StructureTab(props: {
  readonly doc: DesignDoc; readonly selected?: Selection; readonly locateTick: number; readonly onSelect: (path: string) => void; readonly onOpenTemplate: (template: string) => void; readonly onMenu: (x: number, y: number, path: string) => void;
}) {
  const { doc, selected } = props, tree = useMemo(() => elementTree(doc.document, doc.name), [doc.document, doc.name]);
  const root = useRef<HTMLUListElement>(null);
  // 预览上选中了、或右键"在结构中定位"：滚到这一行。
  useEffect(() => {
    root.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected?.path, props.locateTick]);
  const row = (node: ElementNode) => (
    <li key={node.path}>
      <div className="tree-row" data-testid="structure-row" data-path={node.path} data-selected={selected?.path === node.path}
        onContextMenu={(event) => { event.preventDefault(); props.onMenu(event.clientX, event.clientY, node.path); }}>
        <button type="button" className="tree-button" aria-current={selected?.path === node.path ? 'true' : undefined} onClick={() => props.onSelect(node.path)}>
          <span>{node.name}</span><span className="small muted">{ELEMENT_TYPES[node.type] ?? node.type}</span>
        </button>
        {node.template && <button type="button" className="link small" onClick={() => props.onOpenTemplate(node.template!)}>打开 {node.template}</button>}
      </div>
      {node.children.length > 0 && <ul>{node.children.map(row)}</ul>}
    </li>
  );
  return <ul className="tree" ref={root} data-testid="structure">{row(tree)}</ul>;
}

function CheckRow(props: { readonly doc: DesignDoc; readonly index: number; readonly expanded: boolean; readonly lists: FieldContext['lists']; readonly onToggle: () => void; readonly onEdit: (document: JsonObject, key: string) => void }) {
  const { doc, index, expanded } = props, checks = Array.isArray(doc.document['checks']) ? doc.document['checks'] as unknown[] : [];
  const check = checks[index], name = isObject(check) ? String(check['name']) : `#${index + 1}`;
  const context: FieldContext = { lists: props.lists, onWrite: (fieldPath, value) => props.onEdit(writeListItem(doc.document, 'checks', index, fieldPath, value), `checks:${name}:${fieldPath.join('.')}`) };
  return (
    <div className={`list-row${expanded ? ' selected' : ''}`} data-testid="check-row" data-name={name}>
      <button type="button" className="list-row-button" aria-expanded={expanded} onClick={props.onToggle}>
        <span>{isObject(check) && typeof check['displayName'] === 'string' ? check['displayName'] : name}</span>
        <span className="small muted">{isObject(check) ? (check['level'] === 'severe' ? '严重' : '提示') : ''}</span>
      </button>
      {expanded && <div className="list-row-body">{listItemPanel(doc.document, 'checks', index).map((field) => <FieldRow key={field.key} field={field} context={context} />)}</div>}
    </div>
  );
}

function AllChecks(props: { readonly doc: DesignDoc; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void }) {
  const [open, setOpen] = useState<number>();
  const count = Array.isArray(props.doc.document['checks']) ? (props.doc.document['checks'] as unknown[]).length : 0;
  return (
    <section className="prop-section" aria-label="检查项">
      <h3>检查项</h3>
      {count === 0 && <p className="small muted">这个模板没有检查项。</p>}
      {Array.from({ length: count }, (_, index) => <CheckRow key={index} doc={props.doc} index={index} expanded={open === index} lists={props.lists} onEdit={props.onEdit} onToggle={() => setOpen(open === index ? undefined : index)} />)}
    </section>
  );
}

/** 检查器里跟着元素走的规则：适配的说明、相关的检查项、这个元素的问题。 */
function ElementRules(props: { readonly doc: DesignDoc; readonly path: string; readonly reply?: PreviewReply; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void }) {
  const { doc, path, reply } = props;
  const [openCheck, setOpenCheck] = useState<number>();
  const element = elementAt(doc.document, path)?.element, panel = propertyPanel(doc.document, path);
  const artboard = isObject(doc.document['artboard']) ? doc.document['artboard'] : {};
  const boardMinimum = typeof artboard['minFontSize'] === 'number' ? artboard['minFontSize'] : 5;
  const isText = panel?.type === 'text', isBoard = panel?.type === 'artboard';
  const fitOf = (node: JsonObject | undefined) => (isObject(node?.['fit']) ? node['fit'] : undefined);
  const group = fitOf(element)?.['widthOverflow'], groupName = isObject(group) ? group['shrinkGroup'] : undefined;
  const members = typeof groupName === 'string'
    ? flatElements(doc.document, doc.name).filter((node) => { const other = fitOf(elementAt(doc.document, node.path)?.element)?.['widthOverflow']; return isObject(other) && other['shrinkGroup'] === groupName; }).map((node) => node.name)
    : [];
  const related = relatedChecks(doc.document, element);
  const here = (reply?.problems ?? []).filter((problem) => problem.location.kind === 'element' && reply?.elements?.some((item) => item.path === (problem.location as { path: string }).path && item.source.template === doc.name && item.source.path === path));
  return (
    <div data-testid="rules">
      <section className="prop-section" aria-label="规则说明">
        {isText && <p className="hint" data-testid="fit-hint">压缩下限缺省 0.6；缩字下限缺省取画板的 {boardMinimum} mm，不能低于它。</p>}
        {isText && members.length > 0 && <p className="small" data-testid="shrink-group">缩字组 {String(groupName)}：{members.join('、')}，放不下时一起缩到同一字号。</p>}
        {isBoard && <p className="hint">缩字下限是这个模板文字缩字的最低字号，不写时 5 mm。</p>}
        {!isText && !isBoard && <p className="small muted">这个元素没有适配规则：适配只对文字起作用。</p>}
      </section>
      <section className="prop-section" aria-label="相关的检查项">
        <h3>相关的检查项</h3>
        {related.length === 0 && <p className="small muted">没有用到这个元素的变量的检查项。</p>}
        {related.map((index) => <CheckRow key={index} doc={doc} index={index} expanded={openCheck === index} lists={props.lists} onEdit={props.onEdit} onToggle={() => setOpenCheck(openCheck === index ? undefined : index)} />)}
      </section>
      {here.length > 0 && (
        <section className="prop-section" aria-label="这个元素的问题">
          <h3>这个元素的问题</h3>
          <ProblemList problems={here} label="这个元素的问题" />
        </section>
      )}
    </div>
  );
}
