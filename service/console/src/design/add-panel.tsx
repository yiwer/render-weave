/**
 * 左面板的"添加"页（模板设计页票据 14，方案第 13 节）：元素目录与从字段创建。点一下加到选中的容器（选中的不是容器就放在它后面），
 * 或者拖到结构树与舞台上。循环、调用与列表、单引用字段要先选基准相符的模板。写回在 template/create.ts。
 */
import { useState, type DragEvent } from 'react';
import { api, ApiError } from '../api.js';
import { Icon } from '../components/icon.js';
import { TYPE_GLYPHS } from '../components/value-text.js';
import { useLoad } from '../hooks.js';
import { CATALOG, fieldInfo, matchingTemplates, newElement, planFromField, type FieldInfo, type NewKind, type SchemaRef } from '../template/create.js';
import { isObject, type JsonObject } from '../template/document.js';
import type { DefinitionField } from '../types.js';
import { ELEMENT_ICONS } from './icons.js';

/** 正在拖的新元素：拖动时读不到 dataTransfer 的内容，放在这里给结构树与舞台看。 */
export interface AddPayload { readonly template: string; readonly element: JsonObject; readonly fromField: boolean }
let pending: AddPayload | undefined;
export const currentAdd = () => pending;
export const ADD_TYPE = 'application/x-renderweave-add';

const startDrag = (event: DragEvent<HTMLElement>, payload: AddPayload) => {
  pending = payload;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(ADD_TYPE, String(payload.element['type']));
};
const endDrag = () => { pending = undefined; };

const refText = (ref: SchemaRef) => `${ref.name} v${ref.version}`;
const EMPTY: SchemaRef = { name: '空数据定义', version: 1 };

/** 选模板：只列基准相符的，没有时写明缺什么。 */
function TemplateChoice(props: { readonly base: SchemaRef | undefined; readonly templates: readonly { readonly name: string; readonly base?: SchemaRef }[]; readonly self: string; readonly value: string; readonly onChange: (name: string) => void }) {
  const names = props.base ? matchingTemplates(props.templates, props.base).filter((name) => name !== props.self) : [];
  if (!props.base) return <p className="small muted">先选上面那一项。</p>;
  if (names.length === 0) return <p className="small muted" data-testid="no-template">还没有基准是「{refText(props.base)}」的模板。从空白新建模板在票据 18。</p>;
  return (
    <label className="small add-field">被调模板（基准 {refText(props.base)}）
      <select aria-label="被调模板" autoFocus value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选一个模板</option>
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
  );
}

export function AddPanel(props: {
  readonly template: string; readonly document: JsonObject; readonly targetLabel: string; readonly selectionLabel?: string;
  readonly onAdd: (element: JsonObject) => void; readonly onBindVisible: (variable: string) => void;
}) {
  const { template, document } = props;
  const base = isObject(document['base']) ? document['base'] as unknown as SchemaRef : undefined;
  const detail = useLoad(() => (base ? api.staticSchema(base.name, base.version).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${base?.name}@${base?.version}`);
  const templates = useLoad(() => api.templates(), 'design-add-templates');
  const resources = useLoad(() => api.resources(), 'design-add-resources');
  const font = resources.data?.resources.find((resource) => resource.kind === 'font');
  const bindings = font ? { font: `res:${font.id}` } : {};
  const fields: readonly FieldInfo[] = (detail.data?.definition.fields ?? []).map((field: DefinitionField) => fieldInfo(field as never));
  const all = (templates.data?.templates ?? []).map((item) => ({ name: item.name, ...(item.base ? { base: item.base as SchemaRef } : {}) }));
  const [open, setOpen] = useState<string>();
  const [chosen, setChosen] = useState({ template: '', list: '', data: 'current' });
  const reset = (key?: string) => { setOpen(key); setChosen({ template: '', list: '', data: 'current' }); };

  const lists = fields.filter((field) => field.type === 'list'), refs = fields.filter((field) => field.type === 'ref');
  const listBase = lists.find((field) => field.name === chosen.list)?.target;
  const callBase = chosen.data === 'current' ? base : chosen.data === 'none' ? EMPTY : refs.find((field) => field.name === chosen.data)?.target;

  const catalogItem = (kind: NewKind, label: string, needsTemplate?: true) => {
    const element = needsTemplate ? undefined : newElement(kind, document, bindings);
    return (
      <div key={kind} className="add-item-wrap">
        <button type="button" className="add-item" data-testid="add-element" data-kind={kind} draggable={Boolean(element)} aria-expanded={needsTemplate ? open === kind : undefined}
          title={needsTemplate ? '先选模板' : `加到${props.targetLabel}，也可以拖到结构树或图上`}
          onDragStart={(event) => element && startDrag(event, { template, element, fromField: false })} onDragEnd={endDrag}
          onClick={() => (element ? props.onAdd(element) : reset(open === kind ? undefined : kind))}>
          <Icon d={ELEMENT_ICONS[kind] ?? ELEMENT_ICONS['container']!} /><span>{label}</span>
        </button>
      </div>
    );
  };
  return (
    <div className="add-panel" data-testid="add-panel">
      <p className="small faint">加到 <strong data-testid="add-target">{props.targetLabel}</strong>：选中容器就放进去，选中别的元素就放在它后面。也可以拖到结构树或图上。</p>
      <section aria-label="元素" className="add-section">
        <h3>元素</h3>
        <div className="add-grid">{CATALOG.map((item) => catalogItem(item.kind, item.label, item.needsTemplate))}</div>
        {open === 'loop' && (
          <form className="add-form" aria-label="添加循环容器" onSubmit={(event) => { event.preventDefault(); if (chosen.list && chosen.template) { props.onAdd(newElement('loop', document, { list: chosen.list, template: chosen.template })); reset(); } }}>
            <label className="small add-field">循环的列表
              <select aria-label="循环的列表" autoFocus value={chosen.list} onChange={(event) => setChosen({ ...chosen, list: event.target.value, template: '' })}>
                <option value="">选一个列表字段</option>
                {lists.map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}
              </select>
            </label>
            {lists.length === 0 && <p className="small muted">这个模板的数据里没有列表字段。</p>}
            {chosen.list && <TemplateChoice base={listBase} templates={all} self={template} value={chosen.template} onChange={(name) => setChosen({ ...chosen, template: name })} />}
            <button type="submit" className="small" disabled={!chosen.list || !chosen.template}>添加循环容器</button>
          </form>
        )}
        {open === 'call' && (
          <form className="add-form" aria-label="添加子模板调用" onSubmit={(event) => { event.preventDefault(); if (chosen.template) { props.onAdd(newElement('call', document, { template: chosen.template, data: chosen.data === 'current' || chosen.data === 'none' ? chosen.data : { var: chosen.data } })); reset(); } }}>
            <label className="small add-field">传给它的数据
              <select aria-label="传给它的数据" autoFocus value={chosen.data} onChange={(event) => setChosen({ ...chosen, data: event.target.value, template: '' })}>
                <option value="current">当前数据（{base ? refText(base) : '没有基准'}）</option>
                {refs.map((field) => <option key={field.name} value={field.name}>字段 {field.label}</option>)}
                <option value="none">不传数据</option>
              </select>
            </label>
            <TemplateChoice base={callBase} templates={all} self={template} value={chosen.template} onChange={(name) => setChosen({ ...chosen, template: name })} />
            <button type="submit" className="small" disabled={!chosen.template}>添加子模板调用</button>
          </form>
        )}
      </section>
      <section aria-label="从字段创建" className="add-section">
        <h3>从字段创建<span className="small faint"> {base ? refText(base) : ''}</span></h3>
        {!base && <p className="small muted">这个模板没有写数据定义。</p>}
        {fields.length === 0 && base && <p className="small muted">{detail.loading ? '正在读取字段…' : '读不到字段：内置的单值数据定义只有 value。'}</p>}
        <ul className="add-fields">
          {fields.map((field) => {
            const plan = planFromField(field, document, bindings);
            const element = plan.kind === 'element' ? plan.element : undefined;
            const key = `field:${field.name}`;
            const what = plan.kind === 'element' ? (element?.['type'] === 'image' ? '变图片' : '变文字') : plan.kind === 'visible' ? '绑到选中元素的显示' : plan.kind === 'template' ? (field.type === 'list' ? '变循环容器' : '变子模板调用') : plan.reason;
            return (
              <li key={field.name}>
                <button type="button" className="add-field-row" data-testid="add-field" data-name={field.name} draggable={Boolean(element)} disabled={plan.kind === 'none' || (plan.kind === 'visible' && !props.selectionLabel)}
                  title={plan.kind === 'visible' && !props.selectionLabel ? '先选中一个元素' : field.name} aria-expanded={plan.kind === 'template' ? open === key : undefined}
                  onDragStart={(event) => element && startDrag(event, { template, element, fromField: true })} onDragEnd={endDrag}
                  onClick={() => {
                    if (plan.kind === 'element') props.onAdd(plan.element);
                    else if (plan.kind === 'visible') props.onBindVisible(plan.variable);
                    else if (plan.kind === 'template') reset(open === key ? undefined : key);
                  }}>
                  <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[field.type] ?? '·'}</span>
                  <span className="variable-name">{field.label}</span>
                  <span className="small faint">{plan.kind === 'visible' && props.selectionLabel ? `绑到「${props.selectionLabel}」的显示` : what}</span>
                </button>
                {open === key && plan.kind === 'template' && (
                  <form className="add-form" aria-label={`从 ${field.label} 创建`} onSubmit={(event) => { event.preventDefault(); if (chosen.template) { props.onAdd(plan.element(chosen.template)); reset(); } }}>
                    <TemplateChoice base={plan.base} templates={all} self={template} value={chosen.template} onChange={(name) => setChosen({ ...chosen, template: name })} />
                    <button type="submit" className="small" disabled={!chosen.template}>{field.type === 'list' ? '添加循环容器' : '添加子模板调用'}</button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

/** 拖到结构树或图上之前：这一份能不能放进 template 这个模板。字段只属于这个模板自己的数据，放进别的模板就绑错了。 */
export const canDropInto = (payload: AddPayload | undefined, template: string) => Boolean(payload && (!payload.fromField || payload.template === template));
export const isAddDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(ADD_TYPE);
