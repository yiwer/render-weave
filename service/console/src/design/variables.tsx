/**
 * 左面板的"数据"页（第三轮票据 07，方案「左面板」，M396）：字段、参数、派生变量、检查项四组，带当前样例的取值。
 * - 字段能拖：拖到图上空白处或图层里建绑定好的元素，拖到已有元素上就是连上（template/connect.ts）；行尾的"+"是点一下就加，
 *   列表与单引用字段先选基准相符的模板；
 * - 悬停时图上标出谁在用，选中一个变量时右边显示它（票据 08 的变量面板，原样留着）；每组标题旁的"+"新建参数、派生变量、检查项。
 * 取值都来自元素求值（POST /v1/previews/inspection），页面不再实现一遍求值。
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { FieldRow, OriginLine, type FieldContext } from '../components/property-fields.js';
import { TYPE_GLYPHS, ValueText } from '../components/value-text.js';
import { href } from '../hooks.js';
import { describeOrigin, parameterNameProblem, scopeVariables, takenNames, type BaseField } from '../template/binding.js';
import type { DataSource } from '../template/connect.js';
import { planFromField, type Drop, type FieldInfo } from '../template/create.js';
import { addCheck, addDerived, cycleOf, definitionsUsing, newCheck, newDerived, OPS, removeCheck, removeDerived, setDerived, withOp, type DerivedOp } from '../template/derived.js';
import { DerivedEditor } from './derived-editor.js';
import { elementVariables, flatElements, isObject, variableClosure, type JsonObject } from '../template/document.js';
import { listItemPanel, writeListItem } from '../template/properties.js';
import type { DesignDoc, DesignSession } from '../template/session.js';
import type { ElementInspection, InspectedValue, InspectedVariable, ParameterOrigin } from '../types.js';
import { endAddDrag, refText, startAddDrag, TemplateChoice, type InsertSources } from './insert-bar.js';

export type VariableKind = 'field' | 'parameter' | 'derived' | 'check';
export interface VariableSelection { readonly template: string; readonly name: string; readonly kind: VariableKind }

/** 字段建出来的元素放在哪：拖到图上或图层里时由落点定，点"+"时没有（照 insertionPoint）。label 是说给人听的那个容器。 */
export interface FieldPlace { readonly container: string; readonly at: Drop; readonly label: string }
/** 列表或单引用字段正在选模板：选好之前什么也不写。 */
export interface Choosing { readonly template: string; readonly field: string; readonly place?: FieldPlace }

const OPERATIONS: Readonly<Record<string, string>> = { branch: '条件分支', pickItem: '取项', splitPart: '拆取文本', length: '长度', add: '加', subtract: '减', multiply: '乘', divide: '除', mod: '取模' };

/** 这个元素实例的求值结果：改动、样例或实例变了才问；问不到不影响别的。 */
export function useInspection(request: unknown, element: string | undefined, version: string): ElementInspection | undefined {
  const [inspection, setInspection] = useState<ElementInspection>();
  const text = request === undefined ? '' : JSON.stringify(request);
  useEffect(() => {
    if (!text || !element) { setInspection(undefined); return undefined; }
    let stale = false;
    const timer = window.setTimeout(() => {
      api.inspectElement(JSON.parse(text), element).then(
        (reply) => { if (!stale) setInspection(reply.inspection); },
        () => { if (!stale) setInspection(undefined); },
      );
    }, 60);
    return () => { stale = true; window.clearTimeout(timer); };
  }, [text, element, version]);
  return inspection;
}

const namedList = (document: JsonObject, list: string): readonly JsonObject[] => (Array.isArray(document[list]) ? (document[list] as unknown[]).filter(isObject) : []);

interface Row { readonly name: string; readonly label: string; readonly kind: VariableKind; readonly type?: string; readonly value?: InspectedValue; readonly failed?: boolean; readonly level?: string }

function VariableRow(props: { readonly row: Row; readonly selected: boolean; readonly onSelect: () => void; readonly onHover: (hovering: boolean) => void }) {
  const { row } = props;
  return (
    <div className={`variable-row${props.selected ? ' selected' : ''}${row.failed ? ' failed' : ''}`} data-testid={row.kind === 'parameter' ? 'parameter-row' : row.kind === 'check' ? 'check-row' : 'variable-row'} data-name={row.name} data-kind={row.kind}
      onMouseEnter={() => props.onHover(true)} onMouseLeave={() => props.onHover(false)}>
      <button type="button" className="variable-button" aria-pressed={props.selected} title={row.name} onClick={props.onSelect}>
        <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[row.type ?? ''] ?? '·'}</span>
        <span className="variable-name">{row.label}</span>
        {row.kind === 'check'
          ? <span className="value-text">{row.failed === undefined ? '' : row.failed ? `成立·${row.level === 'severe' ? '严重' : '提示'}` : '未成立'}</span>
          : <ValueText value={row.value} {...(row.type ? { type: row.type } : {})} />}
      </button>
    </div>
  );
}

/** 每组标题旁的"+"。 */
function Plus(props: { readonly label: string; readonly open?: boolean; readonly onClick: () => void }) {
  return <button type="button" className="variable-plus" aria-label={props.label} title={props.label} {...(props.open === undefined ? {} : { 'aria-expanded': props.open })} onClick={props.onClick}>+</button>;
}

export function DataPanel(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly sources: InsertSources; readonly inspection?: ElementInspection; readonly selected?: VariableSelection;
  /** 点"+"加到哪（insertionLabel 的说法），与选中的元素叫什么（布尔字段绑到它的显示）。 */
  readonly targetLabel: string; readonly selectionLabel?: string;
  readonly choosing?: Choosing; readonly onChoosing: (next: Choosing | undefined) => void;
  readonly onAdd: (element: JsonObject, place?: FieldPlace) => void; readonly onConnectSelected: (field: DataSource) => void;
  readonly onSelect: (selection: VariableSelection) => void; readonly onHover: (selection: { readonly template: string; readonly name: string } | undefined) => void;
}) {
  const { doc, inspection, selected, sources, choosing } = props, document = doc.document, base = sources.base;
  const [newName, setNewName] = useState<string>();
  const [template, setTemplate] = useState('');
  const values = useMemo(() => new Map<string, InspectedVariable>((inspection?.template === doc.name ? inspection.variables : []).map((item) => [item.name, item])), [inspection, doc.name]);
  const scope = useMemo(() => scopeVariables(document, sources.baseFields, inspection?.template === doc.name ? inspection : undefined), [document, sources.baseFields, inspection, doc.name]);
  const [creating, setCreating] = useState<{ readonly list: 'derived' | 'checks'; readonly name: string; readonly op: DerivedOp } | undefined>();
  const [createProblem, setCreateProblem] = useState<string>();
  // 换了一个字段或落点，上一次选的模板不算数。
  const choosingKey = choosing ? `${choosing.field}\u0000${choosing.place?.container ?? ''}` : '';
  useEffect(() => { setTemplate(''); if (choosingKey) sources.refresh(); }, [choosingKey]);
  /** 新建派生变量或检查项：名称一般用英文（M89），同作用域不能重名；显示名称先同名称，在右边改。 */
  const create = () => {
    if (!creating) return;
    const trimmed = creating.name.trim(), problem = parameterNameProblem(trimmed, takenNames(document, scope));
    if (problem) { setCreateProblem(problem); return; }
    const variables = scope.map((item) => ({ name: item.name, type: item.type, ...(item.itemType ? { itemType: item.itemType } : {}), ...(item.itemRef ? { itemRef: item.itemRef } : {}) }));
    if (creating.list === 'checks') {
      props.session.edit(doc.name, addCheck(document, newCheck(trimmed, trimmed, variables)), `checks:add:${trimmed}`);
      props.onSelect({ template: doc.name, name: trimmed, kind: 'check' });
    } else {
      const definition = newDerived(creating.op, trimmed, trimmed, variables);
      if ('problem' in definition) { setCreateProblem(String(definition['problem'])); return; }
      props.session.edit(doc.name, addDerived(document, definition), `derived:add:${trimmed}`);
      props.onSelect({ template: doc.name, name: trimmed, kind: 'derived' });
    }
    void props.session.flush();
    setCreating(undefined);
    setCreateProblem(undefined);
  };
  const toggleCreating = (list: 'derived' | 'checks') => { setCreating(creating?.list === list ? undefined : { list, name: '', op: 'branch' }); setCreateProblem(undefined); };
  const creator = (list: 'derived' | 'checks') => creating?.list === list && (
    <form className="prop-actions variable-create" aria-label={list === 'derived' ? '新建派生变量' : '新建检查项'} onSubmit={(event) => { event.preventDefault(); create(); }}>
      <input type="text" autoFocus aria-label={list === 'derived' ? '新派生变量的名称' : '新检查项的名称'} placeholder="名称，一般用英文" value={creating.name} aria-invalid={createProblem ? true : undefined}
        onChange={(event) => { setCreating({ ...creating, name: event.target.value }); setCreateProblem(undefined); }} />
      {list === 'derived' && (
        <select aria-label="运算" value={creating.op} onChange={(event) => setCreating({ ...creating, op: event.target.value as DerivedOp })}>
          {OPS.map((item) => <option key={item.op} value={item.op}>{item.label}</option>)}
        </select>
      )}
      <button type="submit" className="small">新建</button>
      <button type="button" className="small quiet" onClick={() => { setCreating(undefined); setCreateProblem(undefined); }}>取消</button>
      {createProblem && <span className="prop-error" role="alert">{createProblem}</span>}
    </form>
  );
  const parameters = namedList(document, 'parameters'), derived = namedList(document, 'derived'), checks = namedList(document, 'checks');
  // 内置的单值数据定义没有静态版本，字段名单只能从求值结果来。
  const fields = useMemo((): readonly FieldInfo[] => {
    if (sources.baseFields.length > 0) return sources.baseFields.map((field) => sources.fields.find((item) => item.name === field.name) ?? { name: field.name, label: field.label, type: field.type });
    return [...values.values()].filter((item) => item.kind === 'field').map((item) => ({ name: item.name, label: item.displayName, type: item.type }));
  }, [sources.baseFields, sources.fields, values]);
  const rowOf = (name: string, label: string, kind: VariableKind, declared?: string): Row => {
    const known = values.get(name), type = known?.type ?? declared;
    return { name, label, kind, ...(type ? { type } : {}), ...(known ? { value: known.value } : {}) };
  };
  const failed = (name: string) => inspection?.template === doc.name ? inspection.checks.find((check) => check.name === name)?.failed : undefined;
  const isSelected = (name: string) => selected?.template === doc.name && selected.name === name;
  const rowsOf = (rows: readonly Row[]) => rows.map((row) => (
    <VariableRow key={row.name} row={row} selected={isSelected(row.name)}
      onSelect={() => props.onSelect({ template: doc.name, name: row.name, kind: row.kind })}
      onHover={(hovering) => props.onHover(hovering && row.kind !== 'check' ? { template: doc.name, name: row.name } : undefined)} />
  ));
  const parameterRows = (visibility: string) => parameters.filter((item) => item['visibility'] === visibility).map((item) => rowOf(String(item['name']), String(item['displayName'] ?? item['name']), 'parameter', String(item['type'])));
  const publicRows = parameterRows('public'), internalRows = parameterRows('internal');
  const derivedRows = derived.map((item) => rowOf(String(item['name']), String(item['displayName'] ?? item['name']), 'derived', String(item['type'])));
  const checkRows = checks.map((item): Row => { const name = String(item['name']), result = failed(name); return { name, label: String(item['displayName'] ?? name), kind: 'check', type: 'boolean', ...(result === undefined ? {} : { failed: result }), level: String(item['level']) }; });
  const trimmed = (newName ?? '').trim(), taken = values.has(trimmed) || parameters.some((item) => item['name'] === trimmed), valid = trimmed !== '' && !trimmed.includes('.') && !taken;
  const add = () => {
    props.session.edit(doc.name, { ...document, parameters: [...parameters, { name: trimmed, displayName: trimmed, visibility: 'public', type: 'text', default: '' }] }, `parameters:add:${trimmed}`);
    props.onSelect({ template: doc.name, name: trimmed, kind: 'parameter' });
    setNewName(undefined);
  };

  /** 字段的一行：整行能拖，点名称选中它，行尾的"+"点一下就加（布尔是绑到选中元素的显示，列表与单引用先选模板）。 */
  const fieldRow = (field: FieldInfo) => {
    const plan = planFromField(field, document, sources.bindings);
    const row = rowOf(field.name, field.label, 'field', field.type), open = choosing?.field === field.name;
    const image = plan.kind === 'element' && plan.element['type'] === 'image';
    const action = plan.kind === 'element' ? `把「${field.label}」加成${image ? '图片' : '文字'}`
      : plan.kind === 'visible' ? `把「${field.label}」绑到选中元素的显示`
      : plan.kind === 'template' ? `用「${field.label}」建${field.type === 'list' ? '循环容器' : '子模板调用'}` : plan.reason;
    const hint = plan.kind === 'element' ? `${action}，加到${props.targetLabel}`
      : plan.kind === 'visible' ? (props.selectionLabel ? `绑到「${props.selectionLabel}」的显示` : '先选中一个元素')
      : plan.kind === 'template' ? `${action}：先选基准相符的模板` : plan.reason;
    return (
      <div key={field.name}>
        <div className={`variable-row field-row${isSelected(field.name) ? ' selected' : ''}`} data-testid="variable-row" data-name={field.name} data-kind="field" draggable={plan.kind !== 'none'}
          onDragStart={(event) => { if (plan.kind !== 'none') startAddDrag(event, { template: doc.name, fromField: true, field, ...(plan.kind === 'element' ? { element: plan.element } : {}) }); }} onDragEnd={endAddDrag}
          onMouseEnter={() => props.onHover({ template: doc.name, name: field.name })} onMouseLeave={() => props.onHover(undefined)}>
          <span className="variable-grip" aria-hidden="true" />
          <button type="button" className="variable-button" aria-pressed={isSelected(field.name)} title={`${field.name}：拖到图上建元素，拖到元素上连上`} onClick={() => props.onSelect({ template: doc.name, name: field.name, kind: 'field' })}>
            <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[row.type ?? ''] ?? '·'}</span>
            <span className="variable-name">{field.label}<span className="variable-key mono">{field.name}</span></span>
            <ValueText value={row.value} {...(row.type ? { type: row.type } : {})} />
          </button>
          <button type="button" className="variable-plus" data-testid="add-field" data-field={field.name} aria-label={action} title={hint}
            disabled={plan.kind === 'none' || (plan.kind === 'visible' && !props.selectionLabel)} {...(plan.kind === 'template' ? { 'aria-expanded': open } : {})}
            onClick={() => {
              if (plan.kind === 'element') props.onAdd(plan.element);
              else if (plan.kind === 'visible') props.onConnectSelected(field);
              else if (plan.kind === 'template') props.onChoosing(open ? undefined : { template: doc.name, field: field.name });
            }}>+</button>
        </div>
        {open && plan.kind === 'template' && (
          <form className="add-form" aria-label={`从 ${field.label} 创建`} onSubmit={(event) => { event.preventDefault(); if (template) { props.onAdd(plan.element(template), choosing.place); props.onChoosing(undefined); } }}>
            <TemplateChoice base={plan.base} templates={sources.templates} self={doc.name} value={template} why={field.type === 'list' ? `循环的每一项是「${field.label}」的一项，被调模板的基准就是它。` : `调用传「${field.label}」这份数据，被调模板的基准是它指向的数据定义。`} onChange={setTemplate} />
            <p className="small faint">{choosing.place ? '加进刚才拖到的' : '加到'}<span data-testid="add-target">{choosing.place?.label ?? props.targetLabel}</span>。</p>
            <span className="prop-actions">
              <button type="submit" className="small" disabled={!template}>{field.type === 'list' ? '添加循环容器' : '添加子模板调用'}</button>
              <button type="button" className="small quiet" onClick={() => props.onChoosing(undefined)}>取消</button>
            </span>
          </form>
        )}
      </div>
    );
  };

  return (
    <div className="data-panel" data-testid="data-panel">
      <p className="small faint variable-scope">作用域 <strong>{doc.name}</strong>：每次模板调用各是一个作用域，不继承；要用外面的值，经调用传入。</p>
      <section className="variable-group" aria-label="字段">
        <h3>字段<span className="small faint">{base ? refText(base) : ''}</span></h3>
        {!base && <p className="small muted">这个模板没有写数据定义。</p>}
        {base && fields.length === 0 && <p className="small muted">{sources.loadingFields ? '正在读取字段…' : '读不到字段：内置的单值数据定义只有 value。'}</p>}
        {fields.length > 0 && <p className="small faint variable-hint">拖到图上建元素；拖到元素上就是连上。</p>}
        {fields.map(fieldRow)}
      </section>
      <section className="variable-group" aria-label="参数">
        <h3>参数<span className="small faint">调用方给值，或设计者设定</span><Plus label="新建参数" open={newName !== undefined} onClick={() => setNewName(newName === undefined ? '' : undefined)} /></h3>
        {newName !== undefined && (
          <form className="prop-actions variable-create" aria-label="添加参数" onSubmit={(event) => { event.preventDefault(); if (valid) add(); }}>
            <input type="text" autoFocus aria-label="新参数的名称" placeholder="新参数的名称，一般用英文" value={newName} onChange={(event) => setNewName(event.target.value)} aria-invalid={taken ? true : undefined} />
            <button type="submit" className="small" disabled={!valid}>添加参数</button>
            <button type="button" className="small quiet" onClick={() => setNewName(undefined)}>取消</button>
          </form>
        )}
        {parameters.length === 0 && <p className="small muted">还没有参数。</p>}
        {publicRows.length > 0 && <div role="group" aria-label="对外参数"><span className="small faint variable-sub">对外</span>{rowsOf(publicRows)}</div>}
        {internalRows.length > 0 && <div role="group" aria-label="内部参数"><span className="small faint variable-sub">内部</span>{rowsOf(internalRows)}</div>}
      </section>
      <section className="variable-group" aria-label="派生变量">
        <h3>派生变量<span className="small faint">单步运算，按名组合</span><Plus label="新建派生变量" open={creating?.list === 'derived'} onClick={() => toggleCreating('derived')} /></h3>
        {creator('derived')}
        {derivedRows.length === 0 && <p className="small muted">还没有派生变量。</p>}
        {rowsOf(derivedRows)}
      </section>
      <section className="variable-group" aria-label="检查项">
        <h3>检查项<span className="small faint">渲染前求值</span><Plus label="新建检查项" open={creating?.list === 'checks'} onClick={() => toggleCreating('checks')} /></h3>
        {creator('checks')}
        {checkRows.length === 0 && <p className="small muted">这个模板没有检查项。</p>}
        {rowsOf(checkRows)}
      </section>
    </div>
  );
}

/** 谁在用这个变量：元素（连带派生变量）与直接引用它的派生变量。 */
export function usesOfVariable(document: JsonObject, template: string, name: string): { readonly elements: readonly { readonly path: string; readonly name: string }[]; readonly derived: readonly string[] } {
  const root = isObject(document['artboard']) ? document['artboard'] : {};
  const elementAtPath = (path: string): JsonObject => {
    let node = root;
    for (const segment of path.split('/').slice(1)) node = (Array.isArray(node['children']) ? (node['children'] as unknown[]).filter(isObject) : []).find((child) => child['name'] === segment) ?? {};
    return node;
  };
  const head = name.split('.')[0]!;
  const elements = flatElements(document, template).filter((node) => {
    const element = elementAtPath(node.path);
    return variableClosure(document, elementVariables(element)).has(head);
  }).map((node) => ({ path: node.path, name: node.name }));
  const derived = namedList(document, 'derived').filter((item) => item['name'] !== head && elementVariables(item).some((variable) => variable.split('.')[0] === head)).map((item) => String(item['name']));
  return { elements, derived };
}

function Uses(props: { readonly document: JsonObject; readonly template: string; readonly name: string; readonly onElement: (path: string) => void; readonly onVariable: (name: string) => void }) {
  const uses = usesOfVariable(props.document, props.template, props.name);
  return (
    <section className="prop-section" aria-label="谁在用">
      <h3>谁在用<span className="small faint"> {uses.elements.length} 个元素</span></h3>
      {uses.elements.length === 0 && <p className="small muted">没有元素直接或间接用它。</p>}
      <ul className="variable-uses" data-testid="variable-uses">
        {uses.elements.map((element) => <li key={element.path}><button type="button" className="link" onClick={() => props.onElement(element.path)}>{element.path === props.template ? '画板' : element.name}</button></li>)}
      </ul>
      {uses.derived.length > 0 && <p className="small muted">派生变量：{uses.derived.map((name, index) => <span key={name}>{index > 0 && '、'}<button type="button" className="link" onClick={() => props.onVariable(name)}>{name}</button></span>)}</p>}
    </section>
  );
}

/** 来源就是它自己（本模板的参数，值就在这里）：不用再说一遍。 */
const originIsSelf = (origin: ParameterOrigin, template: string, name: string) => (origin.kind === 'default' || origin.kind === 'request') && origin.template === template && origin.name === name;

/** 右边：选中的变量。参数与检查项能改；字段属于数据定义，只读；派生变量的编辑器在票据 16，这里先看。 */
export function VariableInspector(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly selection: VariableSelection; readonly inspection?: ElementInspection; readonly lists: FieldContext['lists'];
  readonly documentOf: (template: string) => JsonObject | undefined; readonly baseFields: readonly BaseField[];
  readonly onElement: (path: string) => void; readonly onVariable: (selection: VariableSelection) => void; readonly onClear: () => void;
}) {
  const { doc, session, selection, inspection } = props, { name, kind } = selection, document = doc.document;
  const known = inspection?.template === doc.name ? inspection.variables.find((item) => item.name === name) : undefined;
  const edit = (next: JsonObject, key: string) => session.edit(doc.name, next, key);
  const listField = (list: 'parameters' | 'checks') => {
    const items = namedList(document, list), index = items.findIndex((item) => item['name'] === name);
    if (index < 0) return null;
    const context: FieldContext = {
      lists: props.lists,
      onWrite: (path, value, options) => { edit(writeListItem(document, list, index, path, value), `${list}:${name}:${path.join('.')}`); if (options?.now) void session.flush(); },
    };
    return listItemPanel(document, list, index).map((field) => <FieldRow key={field.key} field={field} context={context} />);
  };
  const title = kind === 'field' ? known?.displayName ?? name : String(namedList(document, kind === 'check' ? 'checks' : kind === 'parameter' ? 'parameters' : 'derived').find((item) => item['name'] === name)?.['displayName'] ?? name);
  const kindText = { field: '数据字段', parameter: '模板参数', derived: '派生变量', check: '检查项' }[kind];
  const base = isObject(document['base']) ? String(document['base']['name']) : '';
  const derived = kind === 'derived' ? namedList(document, 'derived').find((item) => item['name'] === name) : undefined;
  const [opProblem, setOpProblem] = useState<string>();
  const scope = scopeVariables(document, props.baseFields, inspection?.template === doc.name ? inspection : undefined);
  const editorVariables = scope.map((item) => ({ name: item.name, label: item.label, type: item.type, ...(item.value !== undefined ? { value: item.value } : {}), ...(item.itemType ? { itemType: item.itemType } : {}), ...(item.itemRef ? { itemRef: item.itemRef } : {}) }));
  /** 删之前说清谁在用：还在用的留给问题清单报，不替人改绑定。 */
  const remove = (what: string, next: JsonObject) => {
    const uses = [...usesOfVariable(document, doc.name, name).elements.map((element) => element.name), ...definitionsUsing(document, name)];
    if (uses.length && !window.confirm(`还有 ${uses.length} 处在用：${uses.join('、')}。删了之后由问题清单报，不替你改绑定。确定删除${what}？`)) return;
    edit(next, `${kind}:delete:${name}:${Date.now()}`);
    void session.flush();
    props.onClear();
  };
  return (
    <div data-testid="variable-inspector" data-name={name} data-kind={kind}>
      <div className="inspector-head">
        <h2>{title}</h2>
        <span className="small muted">{kindText} · <span className="mono">{name}</span></span>
      </div>
      {known && <p className="small muted variable-current" data-testid="variable-current">当前样例取值：<ValueText value={known.value} type={known.type} /></p>}
      {known?.origin && !originIsSelf(known.origin, doc.name, name) && <OriginLine text={describeOrigin(known.origin, doc.name, props.documentOf)} onOpen={(link) => props.onVariable({ template: link.template, name: link.name, kind: link.kind })} />}
      {kind === 'field' && (
        <section className="prop-section" aria-label="字段">
          <p className="small muted">字段属于数据定义，这里只读。<a href={href(['definitions', base], { field: name })}>打开数据定义的这个字段</a></p>
        </section>
      )}
      {kind === 'parameter' && (
        <section className="prop-section" aria-label="参数">
          {listField('parameters')}
          <p className="hint">这里的缺省值写进模板。对外参数的试值在样例带里调，不写进模板。</p>
          <button type="button" className="link danger" onClick={() => { edit({ ...document, parameters: namedList(document, 'parameters').filter((item) => item['name'] !== name) }, `parameters:delete:${name}`); props.onClear(); }}>删除这个参数</button>
        </section>
      )}
      {kind === 'check' && (
        <section className="prop-section" aria-label="检查项">
          {listField('checks')}
          <button type="button" className="link danger" onClick={() => { edit(removeCheck(document, name), `checks:delete:${name}:${Date.now()}`); void session.flush(); props.onClear(); }}>删除这个检查项</button>
        </section>
      )}
      {derived && (
        <section className="prop-section" aria-label="运算">
          <h3>{OPERATIONS[String(derived['op'])] ?? String(derived['op'])}</h3>
          {known?.branch !== undefined && <p className="small muted" data-testid="branch-hit">{known.branch < 0 ? '当前命中"否则"' : `当前命中第 ${known.branch + 1} 支`}</p>}
          <DerivedEditor definition={derived} variables={editorVariables} hit={known?.branch}
            onChange={(next) => { setOpProblem(undefined); edit(setDerived(document, name, next), `derived:${name}`); }}
            onOp={(op: DerivedOp) => { const next = withOp(derived, op, editorVariables); if ('problem' in next) { setOpProblem(String(next['problem'])); return; } setOpProblem(undefined); edit(setDerived(document, name, next), `derived:${name}:op:${Date.now()}`); void session.flush(); }} />
          {opProblem && <p className="prop-error" role="alert">{opProblem}</p>}
          {cycleOf(document, name) && <p className="prop-error" role="alert" data-testid="variable-cycle">这个派生变量经别的派生变量用到了自己（template.variableCycle）。</p>}
          <button type="button" className="link danger" onClick={() => remove('这个派生变量', removeDerived(document, name))}>删除这个派生变量</button>
        </section>
      )}
      {kind !== 'check' && <Uses document={document} template={doc.name} name={name} onElement={props.onElement} onVariable={(next) => props.onVariable({ template: doc.name, name: next, kind: 'derived' })} />}
    </div>
  );
}
