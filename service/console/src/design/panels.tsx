/**
 * 左面板与检查器的内容（模板设计页票据 03）：结构与变量在左，属性在右，右边永远只显示选中的东西。
 * 字段都从模板文档与 Schema 生成（template/properties.ts），分组按元素类型排；内容与适配有专属的编辑器（票据 10）。手柄见票据 13。
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ProblemList } from '../components/problems.js';
import { FieldRow, FieldRows, type BindingHost, type FieldContext } from '../components/property-fields.js';
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import { href, useLoad } from '../hooks.js';
import { baseFieldsOf, describeOrigin, extractParameter, scopeVariables, suggestParameter, takenNames, type BaseField } from '../template/binding.js';
import { elementAt, flatElements, hiddenReason, isObject, relatedChecks, type JsonObject } from '../template/document.js';
import { fontFamilies, type FontFamily } from '../template/fonts.js';
import { nameProblem } from '../template/structure.js';
import { feedOf } from '../template/tree.js';
import { ELEMENT_TYPES, fieldByKey, listItemPanel, propertyPanel, writeListItem, writeProperty, type FieldPath } from '../template/properties.js';
import type { DesignDoc, DesignSession } from '../template/session.js';
import type { ElementInspection, LayoutNode, PreviewReply } from '../types.js';
import { usePopoverDismiss } from '../components/binding-popover.js';
import { ContentEditor } from './content-editor.js';
import { FitEditor } from './fit-editor.js';
import { flatNodes } from './overlays.js';
import type { Selection } from './stage.js';
import { VariableInspector, type VariableSelection } from './variables.js';

/** 建议项：变量、字段与资源。内置的数据定义（单值文本）没有静态版本，只是少几条建议。 */
function useFieldLists(doc: DesignDoc): { readonly lists: FieldContext['lists']; readonly element: ReactNode; readonly baseFields: readonly BaseField[]; readonly fonts?: readonly FontFamily[] } {
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
  const baseFields = useMemo<readonly BaseField[]>(() => baseFieldsOf(compiled.data), [compiled.data]);
  const named = (list: string) => (Array.isArray(doc.document[list]) ? (doc.document[list] as unknown[]).flatMap((item) => (isObject(item) && typeof item['name'] === 'string' ? [item['name']] : [])) : []);
  const variables = [...named('parameters'), ...named('derived'), ...fields];
  const refs = (kind: 'font' | 'image') => (resources.data?.resources ?? []).filter((resource) => resource.kind === kind).map((resource) => `res:${resource.id}`);
  const options = (id: string, values: readonly string[]) => <datalist id={id}>{values.map((value) => <option key={value} value={value} />)}</datalist>;
  return {
    lists: { variable: 'design-variables', field: 'design-fields', font: 'design-fonts', image: 'design-images' },
    element: <>{options('design-variables', variables)}{options('design-fields', fields)}{options('design-fonts', refs('font'))}{options('design-images', refs('image'))}</>,
    baseFields,
    ...(resources.data ? { fonts: fontFamilies(resources.data.resources.filter((resource) => resource.kind === 'font').map((resource) => resource.id)) } : {}),
  };
}

/** 右边的检查器：选中的东西，元素或变量；什么都没选时是画板。 */
export function DesignInspector(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly selected?: Selection; readonly reply?: PreviewReply; readonly impact?: string;
  readonly variable?: VariableSelection; readonly inspection?: ElementInspection; readonly onVariable: (selection: VariableSelection | undefined) => void;
  readonly documentOf: (template: string) => JsonObject | undefined;
  readonly onSelect: (path: string) => void; readonly onSelected: (selection: Selection) => void; readonly onOpenTemplate: (template: string) => void;
}) {
  const { doc, session } = props;
  // 什么都没选时显示画板。
  const selected = props.selected ?? { template: doc.name, path: doc.name };
  const { lists, element, baseFields, fonts } = useFieldLists(doc);
  const edit = (document: JsonObject, key: string) => session.edit(doc.name, document, key);
  if (props.variable) {
    return (
      <>
        {element}
        <VariableInspector key={`${props.variable.template}\n${props.variable.name}`} doc={doc} session={session} selection={props.variable} {...(props.inspection ? { inspection: props.inspection } : {})} lists={lists} baseFields={baseFields} documentOf={props.documentOf} onElement={props.onSelect} onVariable={props.onVariable} onClear={() => props.onVariable(undefined)} />
      </>
    );
  }
  return (
    <>
      {element}
      <PropertiesTab key={`${doc.name}\n${selected.path}`} doc={doc} selected={selected} reply={props.reply} impact={props.impact} lists={lists} baseFields={baseFields} {...(fonts ? { fonts } : {})} {...(props.inspection ? { inspection: props.inspection } : {})} documentOf={props.documentOf} onVariable={props.onVariable} onEdit={edit} onCommit={() => void session.flush()} onSelected={props.onSelected} onOpenTemplate={props.onOpenTemplate} />
      <ElementRules key={`${doc.name}\n${selected.path}\nrules`} doc={doc} path={selected.path} reply={props.reply} lists={lists} onEdit={edit} />
    </>
  );
}

interface ElementProps {
  readonly doc: DesignDoc; readonly selected: Selection; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void; readonly onCommit: () => void;
  readonly baseFields: readonly BaseField[]; readonly fonts?: readonly FontFamily[]; readonly inspection?: ElementInspection; readonly documentOf: (template: string) => JsonObject | undefined; readonly onVariable: (selection: VariableSelection) => void;
  readonly onSelected: (selection: Selection) => void;
}

/** 一个元素的字段环境：写回、绑定与字体。检查器和图上的就地编辑共用。 */
function useElementContext(props: ElementProps): FieldContext {
  const { doc, selected, inspection } = props, path = selected.path;
  const variables = useMemo(() => scopeVariables(doc.document, props.baseFields, inspection?.template === doc.name ? inspection : undefined), [doc.document, props.baseFields, inspection, doc.name]);
  const segments = path.split('/'), element = elementAt(doc.document, path)?.element;
  const cases = isObject(element?.['states']) && isObject(element['states']['cases']) ? element['states']['cases'] : {};
  const binding: BindingHost = {
    variables,
    taken: takenNames(doc.document, variables),
    suggest: (field) => suggestParameter(doc.document, variables, segments.at(-1)!, field),
    // 加参数与绑定是一次写回，一步撤销。
    extract: (field, bindable, value, name, displayName) => { props.onEdit(extractParameter(doc.document, path, field.path, { name, displayName, type: bindable.type, value }), `extract:${path}:${name}`); props.onCommit(); },
    describe: (variable) => (variable.origin ? describeOrigin(variable.origin, doc.name, props.documentOf) : undefined),
    open: (link) => props.onVariable({ template: link.template || doc.name, name: link.name, kind: link.kind }),
    overriddenBy: (field) => (field.path.length === 1 ? Object.entries(cases).flatMap(([state, overrides]) => (isObject(overrides) && String(field.path[0]) in overrides ? [state] : [])) : []),
  };
  return {
    lists: props.lists,
    binding,
    ...(props.fonts ? { fonts: props.fonts } : {}),
    check: (field, value) => (field.key === 'name' && typeof value === 'string' && path !== doc.name ? nameProblem(doc.document, doc.name, path, value) : undefined),
    onWrite: (fieldPath: FieldPath, value: unknown, options) => {
      props.onEdit(writeProperty(doc.document, path, fieldPath, value), `${path}:${fieldPath.join('.')}`);
      if (options?.now) props.onCommit();
      // 改名之后元素路径跟着变，选中不丢。
      if (fieldPath.length === 1 && fieldPath[0] === 'name' && typeof value === 'string') props.onSelected({ template: doc.name, path: [...segments.slice(0, -1), value].join('/') });
    },
  };
}

const boardMinimumOf = (document: JsonObject) => { const board = isObject(document['artboard']) ? document['artboard'] : {}; return typeof board['minFontSize'] === 'number' ? board['minFontSize'] : 5; };

/** 这个元素定义现在对应图上的哪一处：选中的实例，没有时是第一处。 */
function instanceNode(reply: PreviewReply | undefined, selected: Selection): LayoutNode | undefined {
  if (!reply?.layout) return undefined;
  const nodes = flatNodes(reply.layout.root);
  if (selected.instance) { const exact = nodes.find((node) => node.path === selected.instance); if (exact) return exact; }
  const first = reply.elements?.find((item) => item.source.template === selected.template && item.source.path === selected.path);
  return first ? nodes.find((node) => node.path === first.path) : undefined;
}

function PropertiesTab(props: ElementProps & { readonly reply?: PreviewReply | undefined; readonly impact?: string | undefined; readonly onOpenTemplate: (template: string) => void }) {
  const { doc, selected, reply } = props;
  const path = selected.path, panel = propertyPanel(doc.document, path);
  const context = useElementContext(props);
  if (!panel) return <p className="muted">这个元素已经不在模板里了。</p>;
  const segments = path.split('/'), element = elementAt(doc.document, path)?.element;
  const shown = !reply?.elements || reply.elements.some((item) => item.source.template === doc.name && item.source.path === path);
  const template = typeof element?.['template'] === 'string' ? element['template'] : undefined;
  const isText = panel.type === 'text', vertical = element?.['writingMode'] === 'vertical';
  const fitOf = (node: JsonObject | undefined) => (isObject(node?.['fit']) ? node['fit'] : undefined);
  const group = fitOf(element)?.['widthOverflow'], groupName = isObject(group) ? group['shrinkGroup'] : undefined;
  const members = typeof groupName === 'string'
    ? flatElements(doc.document, doc.name).filter((node) => { const other = fitOf(elementAt(doc.document, node.path)?.element)?.['widthOverflow']; return isObject(other) && other['shrinkGroup'] === groupName; }).map((node) => node.name)
    : [];
  const base = panel.type === 'artboard' && isObject(doc.document['base']) ? doc.document['base'] : undefined;
  const body = (name: string, fields: Parameters<typeof FieldRows>[0]['fields']) => {
    const content = isText && name === '内容' ? fields.find((field) => field.key === 'content') : undefined;
    if (content) return <ContentEditor field={content} panel={panel} context={context} vertical={vertical} />;
    if (isText && name === '适配' && element) return <FitEditor panel={panel} element={element} context={context} boardMinimum={boardMinimumOf(doc.document)} members={members} vertical={vertical} instance={instanceNode(reply, selected)} />;
    return <FieldRows fields={fields} context={context} />;
  };
  return (
    <div data-testid="properties" data-path={path} data-type={panel.type}>
      <div className="inspector-head">
        <h2>{segments.at(-1)}</h2>
        <span className="small muted">{ELEMENT_TYPES[panel.type] ?? panel.type}</span>
      </div>
      {props.impact && <p className="design-impact" data-testid="design-impact">{props.impact}</p>}
      {!shown && <p className="small muted" data-testid="hidden-reason">{hiddenReason(doc.document, path)}</p>}
      {template && <p className="small"><button type="button" className="link" onClick={() => props.onOpenTemplate(template)}>打开子模板 {template}</button></p>}
      {template && element && <p className="small muted" data-testid="call-feed">{feedOf(element, props.documentOf)}。进去之后只有这份数据和传入的参数，作用域不继承。</p>}
      {base && (
        <section className="prop-section" aria-label="基准">
          <h3>基准</h3>
          <p className="small" data-testid="artboard-base">{String(base['name'])} v{String(base['version'])}<a className="small" style={{ marginLeft: 8 }} href={href(['definitions', String(base['name'])])}>打开数据定义</a></p>
        </section>
      )}
      {panel.groups.map((item) => (
        <section key={item.name} className="prop-section" aria-label={item.name}>
          <h3>{item.name}</h3>
          {body(item.name, item.fields)}
          {item.name === '缩字下限' && <p className="hint">这个模板文字缩字的最低字号，不写时 5 mm。</p>}
        </section>
      ))}
    </div>
  );
}

/** 图上双击文字就地改内容：和检查器里同一个编辑器。点外面或按 Esc 收起。 */
export function InlineTextEditor(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly selected: Selection; readonly inspection?: ElementInspection; readonly documentOf: (template: string) => JsonObject | undefined;
  readonly onVariable: (selection: VariableSelection) => void; readonly onSelected: (selection: Selection) => void; readonly onClose: () => void;
}) {
  const { doc, session, selected } = props;
  const { lists, element: lists_, baseFields, fonts } = useFieldLists(doc);
  const box = useRef<HTMLDivElement>(null);
  // 里面的弹层也在 box 内，点它们不算点外面；弹层自己先接住 Esc。
  usePopoverDismiss(box, props.onClose);
  const context = useElementContext({ doc, selected, lists, baseFields, ...(fonts ? { fonts } : {}), ...(props.inspection ? { inspection: props.inspection } : {}), documentOf: props.documentOf, onVariable: props.onVariable, onSelected: props.onSelected,
    onEdit: (document, key) => session.edit(doc.name, document, key), onCommit: () => void session.flush() });
  const panel = propertyPanel(doc.document, selected.path), element = elementAt(doc.document, selected.path)?.element;
  const field = panel && fieldByKey(panel, 'content');
  if (!panel || !field) return null;
  return (
    <div ref={box} className="inline-text" data-testid="inline-text">
      {lists_}
      <ContentEditor field={field} panel={panel} context={context} vertical={element?.['writingMode'] === 'vertical'} autoFocus />
    </div>
  );
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

/** 检查器里跟着元素走的规则：相关的检查项、这个元素的问题。 */
function ElementRules(props: { readonly doc: DesignDoc; readonly path: string; readonly reply?: PreviewReply; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void }) {
  const { doc, path, reply } = props;
  const [openCheck, setOpenCheck] = useState<number>();
  const element = elementAt(doc.document, path)?.element;
  const related = relatedChecks(doc.document, element);
  const here = (reply?.problems ?? []).filter((problem) => problem.location.kind === 'element' && reply?.elements?.some((item) => item.path === (problem.location as { path: string }).path && item.source.template === doc.name && item.source.path === path));
  return (
    <div data-testid="rules">
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
