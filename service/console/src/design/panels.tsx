/**
 * 左面板与检查器的内容（模板设计页票据 03）：结构与变量在左，属性在右，右边永远只显示选中的东西。
 * 字段都从模板文档与 Schema 生成（template/properties.ts），分组按元素类型排；内容与适配有专属的编辑器（票据 10）。手柄见票据 13。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api.js';
import { ProblemList } from '../components/problems.js';
import { FieldRow, FieldRows, type BindingHost, type FieldContext } from '../components/property-fields.js';
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import { href, useLoad } from '../hooks.js';
import { baseFieldsOf, describeOrigin, extractParameter, scopeVariables, suggestParameter, takenNames, type BaseField } from '../template/binding.js';
import { elementAt, flatElements, hiddenReason, isObject, relatedChecks, type JsonObject } from '../template/document.js';
import { fontFamilies, type FontFamily } from '../template/fonts.js';
import { splitPanel, type AddableProperty } from '../template/optional.js';
import { nameProblem } from '../template/structure.js';
import { feedOf } from '../template/tree.js';
import { ELEMENT_TYPES, fieldByKey, listItemPanel, propertyPanel, stateOverridable, writeListItem, writeProperty, type FieldPath, type PropertyField } from '../template/properties.js';
import type { DesignDoc, DesignSession } from '../template/session.js';
import type { ElementInspection, LayoutNode, PreviewReply } from '../types.js';
import { usePopoverDismiss } from '../components/binding-popover.js';
import { ContentEditor } from './content-editor.js';
import { FitSection } from './fit-editor.js';
import { TextSection } from './text-form.js';
import { ArgsForm, CallSourceForm, ItemLayoutForm, LoopSourceForm } from './loop-form.js';
import { LayoutSection } from './layout-form.js';
import { setElement } from '../template/calls.js';
import type { HandleSet } from '../template/handles.js';
import { carryOverride, knownValues, mergedDocument, resetOverride, setStateBy, statesOf, writeElementOverride, writeOverride } from '../template/states.js';
import { StateBar } from './state-bar.js';
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
  /** 选中那一处在图上能拖什么（票据 13）。 */
  readonly handles?: HandleSet;
  /** 状态样式选中的取值（票据 17）：编辑写进这个取值的覆盖。 */
  readonly stateValue?: string;
  readonly onStateValue: (value: string | undefined) => void;
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
      <PropertiesTab key={`${doc.name}\n${selected.path}`} doc={doc} selected={selected} reply={props.reply} impact={props.impact} {...(props.handles ? { handles: props.handles } : {})} {...(props.stateValue !== undefined ? { stateValue: props.stateValue } : {})} onStateValue={props.onStateValue} lists={lists} baseFields={baseFields} {...(fonts ? { fonts } : {})} {...(props.inspection ? { inspection: props.inspection } : {})} documentOf={props.documentOf} onVariable={props.onVariable} onEdit={edit} onCommit={() => void session.flush()} onSelected={props.onSelected} onOpenTemplate={props.onOpenTemplate} />
      <ElementRules key={`${doc.name}\n${selected.path}\nrules`} doc={doc} path={selected.path} reply={props.reply} lists={lists} onEdit={edit} />
    </>
  );
}

interface ElementProps {
  readonly doc: DesignDoc; readonly selected: Selection; readonly lists: FieldContext['lists']; readonly onEdit: (document: JsonObject, key: string) => void; readonly onCommit: () => void;
  readonly baseFields: readonly BaseField[]; readonly fonts?: readonly FontFamily[]; readonly inspection?: ElementInspection; readonly documentOf: (template: string) => JsonObject | undefined; readonly onVariable: (selection: VariableSelection) => void;
  readonly onSelected: (selection: Selection) => void;
  /** 状态样式选中的取值：写回落进这个取值的覆盖。 */
  readonly state?: string;
}

/** 一个元素的字段环境：写回、绑定与字体。检查器和图上的就地编辑共用。 */
function useElementContext(props: ElementProps): FieldContext {
  const { doc, selected, inspection } = props, path = selected.path;
  const variables = useMemo(() => scopeVariables(doc.document, props.baseFields, inspection?.template === doc.name ? inspection : undefined), [doc.document, props.baseFields, inspection, doc.name]);
  const segments = path.split('/'), element = elementAt(doc.document, path)?.element;
  const cases = isObject(element?.['states']) && isObject(element['states']['cases']) ? element['states']['cases'] : {};
  const state = props.state;
  const binding: BindingHost = {
    variables,
    taken: takenNames(doc.document, variables),
    suggest: (field) => suggestParameter(doc.document, variables, segments.at(-1)!, field),
    // 加参数与绑定是一次写回，一步撤销。
    extract: (field, bindable, value, name, displayName, written) => {
      const parameter = { name, displayName, type: bindable.type, value };
      // 在某个取值下提成参数：参数照常加，绑定写进这个取值的覆盖。
      const next = state === undefined ? extractParameter(doc.document, path, field.path, parameter, written)
        : carryOverride(doc.document, path, state, extractParameter(mergedDocument(doc.document, path, state), path, field.path, parameter, written), [String(field.path[0])]);
      props.onEdit(next, `extract:${path}:${name}`);
      props.onCommit();
    },
    describe: (variable) => (variable.origin ? describeOrigin(variable.origin, doc.name, props.documentOf) : undefined),
    open: (link) => props.onVariable({ template: link.template || doc.name, name: link.name, kind: link.kind }),
    // 覆盖是整项替换：位置与尺寸摊开的各格跟着 place 算。选了取值时只看这个取值。
    overriddenBy: (field) => {
      const top = String(field.path[0]);
      if (field.path.length !== 1 && top !== 'place') return [];
      return Object.entries(cases).flatMap(([value, overrides]) => ((state === undefined || value === state) && isObject(overrides) && top in overrides ? [value] : []));
    },
  };
  return {
    lists: props.lists,
    binding,
    ...(props.fonts ? { fonts: props.fonts } : {}),
    check: (field, value) => (field.key === 'name' && typeof value === 'string' && path !== doc.name ? nameProblem(doc.document, doc.name, path, value) : undefined),
    ...(state !== undefined ? {
      stateValue: state,
      resetOverride: (field: PropertyField) => { props.onEdit(resetOverride(doc.document, path, state, String(field.path[0])), `${path}:${state}:reset:${Date.now()}`); props.onCommit(); },
    } : {}),
    onWrite: (fieldPath: FieldPath, value: unknown, options) => {
      if (state !== undefined) {
        props.onEdit(writeOverride(doc.document, path, state, fieldPath, value), `${path}:${state}:${fieldPath.join('.')}`);
        if (options?.now) props.onCommit();
        return;
      }
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

function PropertiesTab(props: ElementProps & {
  readonly reply?: PreviewReply | undefined; readonly impact?: string | undefined; readonly handles?: HandleSet; readonly onOpenTemplate: (template: string) => void;
  readonly stateValue?: string; readonly onStateValue: (value: string | undefined) => void;
}) {
  const { doc, selected, reply } = props;
  const path = selected.path, own = elementAt(doc.document, path)?.element, info = statesOf(own);
  // 选了取值：面板显示自身属性加这个取值的覆盖，写回落进覆盖（票据 17）。
  const state = info.by !== undefined && path !== doc.name ? props.stateValue : undefined;
  const display = state === undefined ? doc.document : mergedDocument(doc.document, path, state);
  const panel = propertyPanel(display, path);
  const elementContext = useElementContext({ ...props, ...(state !== undefined ? { state } : {}) });
  // 宽高一格要这一处的实际尺寸（第三轮票据 01）。
  const node = instanceNode(reply, selected), box = node ? { width: node.width, height: node.height } : undefined;
  const [formProblem, setFormProblem] = useState<string>();
  // "+ 属性"（第三轮票据 05）：人清空了输入框、还在改的项先留着这一行；写上值之后不用再留，换取值时从头算。
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set());
  const [added, setAdded] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const filled = panel ? [...pinned].filter((key) => fieldByKey(panel, key)?.value !== undefined).join('\n') : '';
  useEffect(() => { if (filled) setPinned((current) => new Set([...current].filter((key) => !filled.split('\n').includes(key)))); }, [filled]);
  useEffect(() => setPinned(new Set()), [state]);
  // 刚加上的一项滚到看得见的地方，焦点落进它的编辑器。
  useEffect(() => {
    if (!added) return;
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-testid="property-field"]') ?? [])].find((item) => item.dataset['key'] === added);
    if (!row) return;
    row.scrollIntoView({ block: 'nearest' });
    row.querySelector<HTMLElement>('.prop-control :is(input, select, textarea, button)')?.focus({ preventScroll: true });
    setAdded(undefined);
  }, [added, panel]);
  if (!panel) return <p className="muted">这个元素已经不在模板里了。</p>;
  const allowed = stateOverridable(doc.document, path);
  // 常用的、必填的与写了的显示，其余的在底部的"+ 属性"里；选了取值时只有可覆盖的能加，写进这个取值的覆盖。
  const split = splitPanel(panel, { pinned, ...(state !== undefined ? { overridable: allowed } : {}), ...(box ? { box } : {}) });
  const fieldKeys = new Set(panel.groups.flatMap((item) => item.fields.map((field) => field.key)));
  const unpin = (drop: (key: string) => boolean) => setPinned((current) => new Set([...current].filter((key) => !drop(key))));
  const context: FieldContext = {
    ...elementContext, ...(box ? { box } : {}), removable: split.removable,
    onWrite: (fieldPath, value, options) => {
      // 清空输入框和点"去掉"不一样：人多半还要接着打字，这一行不能跟着没了。
      const key = fieldPath.join('.');
      if (value === undefined && fieldKeys.has(key)) setPinned((current) => new Set([...current, key]));
      elementContext.onWrite(fieldPath, value, options);
    },
    onRemove: (field) => { unpin((key) => key === field.key); elementContext.onWrite(field.path, undefined, { now: true }); },
    ...(elementContext.resetOverride ? { resetOverride: (field: PropertyField) => { unpin((key) => key.split('.')[0] === String(field.path[0])); elementContext.resetOverride!(field); } } : {}),
  };
  const add = (item: AddableProperty) => { context.onWrite(item.field.path, item.value, { now: true }); setAdded(item.field.key); };
  const segments = path.split('/'), element = elementAt(display, path)?.element;
  const shown = !reply?.elements || reply.elements.some((item) => item.source.template === doc.name && item.source.path === path);
  const template = typeof element?.['template'] === 'string' ? element['template'] : undefined;
  const isText = panel.type === 'text', vertical = element?.['writingMode'] === 'vertical';
  const fitOf = (node: JsonObject | undefined) => (isObject(node?.['fit']) ? node['fit'] : undefined);
  const group = fitOf(element)?.['widthOverflow'], groupName = isObject(group) ? group['shrinkGroup'] : undefined;
  const members = typeof groupName === 'string'
    ? flatElements(doc.document, doc.name).filter((node) => { const other = fitOf(elementAt(doc.document, node.path)?.element)?.['widthOverflow']; return isObject(other) && other['shrinkGroup'] === groupName; }).map((node) => node.name)
    : [];
  const base = panel.type === 'artboard' && isObject(doc.document['base']) ? doc.document['base'] : undefined;
  const isLoop = panel.type === 'loop', isCall = panel.type === 'call', variables = context.binding?.variables ?? [];
  /** 循环与调用的表单写回整个元素；选项类的立刻暂存。 */
  const writeElement = (next: JsonObject, now?: boolean) => {
    setFormProblem(undefined);
    props.onEdit(state === undefined ? setElement(doc.document, path, next) : writeElementOverride(doc.document, path, state, next), `${path}:${state ?? ''}:form`);
    if (now) props.onCommit();
  };
  // 状态样式：依据的全部取值与当前样例的各处取值，以引擎求值为准；还没求值时按文档推。
  const inspected = props.inspection && props.inspection.template === doc.name && props.inspection.source === path && props.inspection.states?.by === info.by ? props.inspection : undefined;
  const known = info.by === undefined ? undefined : inspected?.states?.known ?? knownValues(doc.document, variables, info.by);
  const lock = (field: PropertyField): PropertyField => (state === undefined || allowed.includes(String(field.path[0])) ? field : { ...field, blocked: '不能按取值换：状态样式不覆盖这一项' });
  const rows = (fields: Parameters<typeof FieldRows>[0]['fields'], keys: readonly string[]) => <FieldRows fields={fields.filter((field) => keys.includes(field.key))} context={context} />;
  const body = (name: string, fields: Parameters<typeof FieldRows>[0]['fields']) => {
    // 选了取值时，循环与调用的来源按一项项的字段改：模板不能覆盖，列表、数据可以。
    if (state !== undefined && (name === '循环' || name === '调用')) return <FieldRows fields={fields} context={context} />;
    if (element && isLoop && name === '循环') return <LoopSourceForm element={element} template={doc.name} variables={variables} documentOf={props.documentOf} onElement={writeElement} onProblem={setFormProblem}>{rows(fields, ['reverse', 'slice'])}</LoopSourceForm>;
    if (element && isCall && name === '调用') return <CallSourceForm element={element} template={doc.name} document={doc.document} variables={variables} onElement={writeElement} />;
    if (element && (isLoop || isCall) && name === '传入参数') return <ArgsForm element={element} called={props.documentOf(String(element['template'] ?? ''))} variables={variables} onElement={writeElement} />;
    if (element && isLoop && name === '每项排布') {
      const gap = fieldByKey(panel, 'itemLayout.gap'), cross = fieldByKey(panel, 'itemLayout.crossGap');
      return (
        <ItemLayoutForm element={element} node={instanceNode(reply, selected)} onElement={writeElement} onProblem={setFormProblem}>
          {gap && <FieldRow field={gap} context={context} />}
          {cross && isObject(element['itemLayout']) && element['itemLayout']['wrap'] === true && <FieldRow field={cross} context={context} />}
          {rows(fields, ['padding'])}
        </ItemLayoutForm>
      );
    }
    // 排布（第三轮票据 03）：方向图标、九宫格、间距与内边距一行；这个取值下不能改排布时仍是一项项的字段。
    if (name === '排布' && fields.some((field) => field.key === 'layout' && !field.blocked)) return <LayoutSection panel={panel} fields={fields} context={context} childCount={Array.isArray(element?.['children']) ? element['children'].length : 0} />;
    const content = isText && name === '内容' ? fields.find((field) => field.key === 'content') : undefined;
    if (content) return <ContentEditor field={content} panel={panel} context={context} vertical={vertical} />;
    // 文字（第三轮票据 04）：常用的几项挤成一块；适配平时是一行摘要，点开才是编辑器。
    if (isText && name === '文字') return <TextSection fields={fields} context={context} />;
    if (name === '位置与尺寸') return <PlaceRows fields={fields} context={context} />;
    if (isText && name === '适配' && element) return <FitSection panel={panel} element={element} context={context} boardMinimum={boardMinimumOf(doc.document)} members={members} vertical={vertical} instance={instanceNode(reply, selected)} />;
    return <FieldRows fields={fields} context={context} />;
  };
  /** 分组标题右边的一句（原型 01）：文字写有几项被状态样式覆盖，适配写横排还是竖排。 */
  const note = (name: string, fields: readonly PropertyField[]): { readonly text: string; readonly title?: string } | undefined => {
    if (!isText) return undefined;
    if (name === '适配') return { text: vertical ? '竖排' : '横排' };
    if (name !== '文字') return undefined;
    const covered = fields.filter((field) => (context.binding?.overriddenBy(field) ?? []).length > 0);
    return covered.length ? { text: `${covered.length} 项被状态覆盖`, title: `${covered.map((field) => field.label).join('、')}在状态样式里被覆盖` } : undefined;
  };
  return (
    <div ref={root} data-testid="properties" data-path={path} data-type={panel.type}>
      <div className="inspector-head">
        <h2>{segments.at(-1)}</h2>
        <span className="small muted">{ELEMENT_TYPES[panel.type] ?? panel.type}</span>
      </div>
      {props.impact && <p className="design-impact" data-testid="design-impact">{props.impact}</p>}
      {!shown && <p className="small muted" data-testid="hidden-reason">{hiddenReason(doc.document, path)}</p>}
      {panel.type !== 'artboard' && own && (
        <StateBar element={own} variables={variables} {...(known ? { known } : {})} {...(inspected ? { instances: inspected.instances } : {})} {...(state !== undefined ? { value: state } : {})}
          onValue={props.onStateValue} onLocate={(instance) => props.onSelected({ template: doc.name, path, instance })}
          onBy={(by) => { props.onEdit(setStateBy(doc.document, path, by), `${path}:states.by:${Date.now()}`); props.onCommit(); }} />
      )}
      {props.handles && (props.handles.can || props.handles.notes.length > 0) && (
        <div className="handle-notes small" data-testid="handle-notes">
          {props.handles.can && <p>{props.handles.can}</p>}
          {props.handles.notes.map((note) => <p key={note} className="muted">{note}</p>)}
        </div>
      )}
      {template && <p className="small"><button type="button" className="link" data-testid="enter-template" title="选中它的画板；图还是这一张" onClick={() => { props.onSelected({ template, path: template }); props.onOpenTemplate(template); }}>进入模板「{template}」</button></p>}
      {formProblem && <p className="prop-error" role="alert">{formProblem}</p>}
      {template && element && <p className="small muted" data-testid="call-feed">{feedOf(element, props.documentOf)}。进去之后只有这份数据和传入的参数，作用域不继承。</p>}
      {base && (
        <section className="prop-section" aria-label="基准">
          <h3>基准</h3>
          <p className="small" data-testid="artboard-base">{String(base['name'])} v{String(base['version'])}<a className="small" style={{ marginLeft: 8 }} href={href(['definitions', String(base['name'])])}>打开数据定义</a></p>
        </section>
      )}
      {split.groups.filter((item) => item.name !== '状态样式').map((item) => (
        <section key={item.name} className="prop-section" aria-label={item.name}>
          <h3>{item.name}</h3>
          {((mark) => mark && <span className="prop-section-note small" data-testid="section-note" title={mark.title}>{mark.title && <i className="prop-state-dot" />}{mark.text}</span>)(note(item.name, item.fields))}
          {body(item.name, item.fields.map(lock))}
          {item.name === '显示' && <p className="hint" data-testid="visible-hint">隐藏的元素不占位：堆叠与网格里像没写它一样排，后面的补上来。</p>}
          {item.name === '缩字下限' && <p className="hint">这个模板文字缩字的最低字号，不写时 5 mm。</p>}
        </section>
      ))}
      {split.addable.length > 0 && (
        <div className="add-props" role="group" aria-label="添加属性" data-testid="add-property">
          <span className="add-props-title">+ 属性</span>
          {split.addable.map((item) => (
            <button key={item.field.key} type="button" className="add-prop" data-key={item.field.key} disabled={Boolean(item.needs)}
              title={item.needs ? `先加${item.needs.join('、')}` : state !== undefined ? '写进这个取值的覆盖' : item.field.description} onClick={() => add(item)}>{item.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 位置与尺寸：宽高并排一行，名称缩成 W、H（第三轮票据 05，原型 01）；别的照旧一项一行。这个取值下不能改位置时不并排。 */
function PlaceRows(props: { readonly fields: readonly PropertyField[]; readonly context: FieldContext }) {
  const { fields, context } = props;
  const size = fields.filter((field) => (field.key === 'place.width' || field.key === 'place.height') && !field.blocked);
  if (size.length < 2) return <FieldRows fields={fields} context={context} />;
  const at = fields.indexOf(size[0]!), others = (list: readonly PropertyField[]) => list.filter((field) => !size.includes(field));
  return (
    <>
      <FieldRows fields={others(fields.slice(0, at))} context={context} />
      <div className="prop-pair size-pair" data-testid="size-pair">
        {size.map((field) => <FieldRow key={field.key} field={field} context={context} half caption={field.key === 'place.width' ? 'W' : 'H'} />)}
      </div>
      <FieldRows fields={others(fields.slice(at))} context={context} />
    </>
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
