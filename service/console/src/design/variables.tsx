/**
 * 变量面板（模板设计页票据 08，方案第 6 节）：左边列字段、参数、派生变量与检查项，带当前样例的取值；悬停时图上标出谁在用；
 * 选中一个变量时右边显示它。取值都来自元素求值（POST /v1/previews/inspection），页面不再实现一遍求值。
 */
import { useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../api.js';
import { FieldRow, type FieldContext } from '../components/property-fields.js';
import { formOf, type JsonObject as FormObject } from '../form/schema.js';
import { href, useLoad } from '../hooks.js';
import { elementVariables, flatElements, isObject, variableClosure, type JsonObject } from '../template/document.js';
import { listItemPanel, writeListItem } from '../template/properties.js';
import type { DesignDoc, DesignSession } from '../template/session.js';
import type { ElementInspection, InspectedValue, InspectedVariable } from '../types.js';

export type VariableKind = 'field' | 'parameter' | 'derived' | 'check';
export interface VariableSelection { readonly template: string; readonly name: string; readonly kind: VariableKind }

const TYPE_GLYPHS: Readonly<Record<string, string>> = { text: 'T', number: '#', date: '日', time: '时', datetime: '刻', boolean: '?', image: '图', color: '色', list: '≡', ref: '{}' };
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

export function ValueText(props: { readonly value: InspectedValue | undefined; readonly type?: string }) {
  const { value } = props;
  if (value === undefined || value === null) return <span className="value-text faint">空</span>;
  if (typeof value === 'object') {
    if ('list' in value) return <span className="value-text">{value.list} 项</span>;
    const name = value.fields['name'] ?? value.fields['title'];
    return <span className="value-text">{typeof name === 'string' ? `{ ${name} }` : '{…}'}</span>;
  }
  if (typeof value === 'boolean') return <span className="value-text">{value ? '是' : '否'}</span>;
  if (value === '') return <span className="value-text faint">空文本</span>;
  if (props.type === 'color') return <span className="value-text"><i className="value-swatch" style={{ background: String(value) }} aria-hidden="true" />{String(value)}</span>;
  const text = String(value);
  return <span className="value-text" title={text}>{text.startsWith('res:') ? text.slice(4) : text}</span>;
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

export function VariablesPanel(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly inspection?: ElementInspection; readonly selected?: VariableSelection;
  readonly onSelect: (selection: VariableSelection) => void; readonly onHover: (selection: { readonly template: string; readonly name: string } | undefined) => void;
}) {
  const { doc, inspection, selected } = props, document = doc.document;
  const [newName, setNewName] = useState('');
  const base = isObject(document['base']) ? document['base'] as { name: string; version: string | number } : undefined;
  const compiled = useLoad(() => (base ? api.staticSchema(base.name, base.version as number).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${base?.name}@${base?.version}`);
  const values = useMemo(() => new Map<string, InspectedVariable>((inspection?.template === doc.name ? inspection.variables : []).map((item) => [item.name, item])), [inspection, doc.name]);
  const parameters = namedList(document, 'parameters'), derived = namedList(document, 'derived'), checks = namedList(document, 'checks');
  const fields = useMemo(() => {
    if (compiled.data) return formOf(compiled.data.compiled as FormObject).fields.map((field) => ({ name: field.name, label: field.spec.title || field.name }));
    return [...values.values()].filter((item) => item.kind === 'field').map((item) => ({ name: item.name, label: item.displayName }));
  }, [compiled.data, values]);
  const rowOf = (name: string, label: string, kind: VariableKind, declared?: string): Row => {
    const known = values.get(name), type = known?.type ?? declared;
    return { name, label, kind, ...(type ? { type } : {}), ...(known ? { value: known.value } : {}) };
  };
  const failed = (name: string) => inspection?.template === doc.name ? inspection.checks.find((check) => check.name === name)?.failed : undefined;
  const section = (title: string, hint: string, rows: readonly Row[], empty?: string) => (rows.length > 0 || empty) && (
    <section className="variable-group" aria-label={title}>
      <h3>{title}<span className="small faint">{hint}</span></h3>
      {rows.length === 0 && <p className="small muted">{empty}</p>}
      {rows.map((row) => (
        <VariableRow key={row.name} row={row} selected={selected?.template === doc.name && selected.name === row.name}
          onSelect={() => props.onSelect({ template: doc.name, name: row.name, kind: row.kind })}
          onHover={(hovering) => props.onHover(hovering && row.kind !== 'check' ? { template: doc.name, name: row.name } : undefined)} />
      ))}
    </section>
  );
  const parameterRows = (visibility: string) => parameters.filter((item) => item['visibility'] === visibility).map((item) => rowOf(String(item['name']), String(item['displayName'] ?? item['name']), 'parameter', String(item['type'])));
  const trimmed = newName.trim(), taken = values.has(trimmed) || parameters.some((item) => item['name'] === trimmed), valid = trimmed !== '' && !trimmed.includes('.') && !taken;
  const add = () => {
    props.session.edit(doc.name, { ...document, parameters: [...parameters, { name: trimmed, displayName: trimmed, visibility: 'public', type: 'text', default: '' }] }, `parameters:add:${trimmed}`);
    props.onSelect({ template: doc.name, name: trimmed, kind: 'parameter' });
    setNewName('');
  };
  return (
    <div data-testid="parameters">
      <p className="small faint variable-scope">作用域 <strong>{doc.name}</strong>：每次模板调用各是一个作用域，不继承；要用外面的值，经调用传入。</p>
      {section('字段', base ? `${base.name} v${String(base.version)}` : '', fields.map((field) => rowOf(field.name, field.label, 'field')))}
      {section('对外参数', '调用方或渲染请求给值', parameterRows('public'), '没有。')}
      {section('内部参数', '设计者设定', parameterRows('internal'), '没有。')}
      <form className="prop-actions" aria-label="添加参数" onSubmit={(event) => { event.preventDefault(); if (valid) add(); }}>
        <input type="text" aria-label="新参数的名称" placeholder="新参数的名称，一般用英文" value={newName} onChange={(event) => setNewName(event.target.value)} aria-invalid={taken ? true : undefined} />
        <button type="submit" className="small quiet" disabled={!valid}>添加参数</button>
      </form>
      {section('派生变量', '单步运算，按名组合', derived.map((item) => rowOf(String(item['name']), String(item['displayName'] ?? item['name']), 'derived', String(item['type']))))}
      {section('检查项', '渲染前求值', checks.map((item) => { const name = String(item['name']), result = failed(name); return { name, label: String(item['displayName'] ?? name), kind: 'check' as const, type: 'boolean', ...(result === undefined ? {} : { failed: result }), level: String(item['level']) }; }), '这个模板没有检查项。')}
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

/** 右边：选中的变量。参数与检查项能改；字段属于数据定义，只读；派生变量的编辑器在票据 16，这里先看。 */
export function VariableInspector(props: {
  readonly doc: DesignDoc; readonly session: DesignSession; readonly selection: VariableSelection; readonly inspection?: ElementInspection; readonly lists: FieldContext['lists'];
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
  return (
    <div data-testid="variable-inspector" data-name={name} data-kind={kind}>
      <div className="inspector-head">
        <h2>{title}</h2>
        <span className="small muted">{kindText} · <span className="mono">{name}</span></span>
      </div>
      {known && <p className="small muted variable-current" data-testid="variable-current">当前样例取值：<ValueText value={known.value} type={known.type} /></p>}
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
      {kind === 'check' && <section className="prop-section" aria-label="检查项">{listField('checks')}</section>}
      {derived && (
        <section className="prop-section" aria-label="运算">
          <h3>{OPERATIONS[String(derived['op'])] ?? String(derived['op'])}</h3>
          {known?.branch !== undefined && <p className="small muted" data-testid="branch-hit">{known.branch < 0 ? '当前命中"否则"' : `当前命中第 ${known.branch + 1} 支`}</p>}
          <p className="small faint">编辑器在下一期。</p>
        </section>
      )}
      {kind !== 'check' && <Uses document={document} template={doc.name} name={name} onElement={props.onElement} onVariable={(next) => props.onVariable({ template: doc.name, name: next, kind: 'derived' })} />}
    </div>
  );
}
