/**
 * 底部工具栏的插入一组（第三轮票据 06，方案「底部工具栏管插入」，M396）：文字、图片、形状、容器、循环、调用。
 * - 点一下加到 insertionPoint 算出的位置（选中容器就放进去，选中别的就放在它后面），也能拖到图上或图层里；写回只有 template/create.ts 一处；
 * - 形状点开是一块小目录；循环与调用点开是小表单：选列表或数据，再选基准相符的模板，也能当场新建一个（票据 18）；
 * - 正在拖的东西与"能不能放"也在这里：舞台、图层与"数据"页共用。从"数据"页拖出来的是字段（第三轮票据 07）：
 *   拖到空白处或容器里建元素，拖到已有元素上是连上，所以带着字段本身，建得出元素的再带上元素。
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { api, ApiError } from '../api.js';
import { Icon } from '../components/icon.js';
import { NewTemplate } from '../components/new-template.js';
import { useLoad } from '../hooks.js';
import { baseFieldsOf, type BaseField } from '../template/binding.js';
import { CATALOG, INSERT_BAR, SHAPE_KINDS, fieldInfo, matchingTemplates, newElement, type Bindings, type FieldInfo, type NewKind, type SchemaRef } from '../template/create.js';
import { isObject, type JsonObject } from '../template/document.js';
import type { DefinitionField } from '../types.js';
import { ELEMENT_ICONS, SHAPES_ICON } from './icons.js';

// —— 拖一个新元素 ——

/**
 * 正在拖的东西：拖动时读不到 dataTransfer 的内容，放在这里给图层与舞台看。
 * 工具栏拖出来的只有 element；"数据"页拖出来的带 field，文字类与图片字段同时带着建好的 element，列表与单引用要先选模板所以没有。
 */
export interface AddPayload { readonly template: string; readonly fromField: boolean; readonly element?: JsonObject; readonly field?: FieldInfo }
let pending: AddPayload | undefined;
export const currentAdd = () => pending;
export const ADD_TYPE = 'application/x-renderweave-add';

export const startAddDrag = (event: DragEvent<HTMLElement>, payload: AddPayload) => {
  pending = payload;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(ADD_TYPE, String(payload.element?.['type'] ?? 'field'));
};
export const endAddDrag = () => { pending = undefined; };

/** 拖到结构树或图上之前：这一份能不能放进 template 这个模板。字段只属于这个模板自己的数据，放进别的模板就绑错了。 */
export const canDropInto = (payload: AddPayload | undefined, template: string) => Boolean(payload && (!payload.fromField || payload.template === template));
export const isAddDrag = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(ADD_TYPE);

// —— 加元素要读的东西：基准的字段、全部模板、资源库里的字体 ——

export interface InsertSources {
  readonly base: SchemaRef | undefined;
  readonly fields: readonly FieldInfo[];
  /** 同一份字段，带着一层引用展开（terminal.name 这样的）：作用域里能连的变量从它算。 */
  readonly baseFields: readonly BaseField[];
  readonly loadingFields: boolean;
  readonly templates: readonly { readonly name: string; readonly base?: SchemaRef }[];
  /** 模板里还没用过字体时，文字用资源库里的第一种。 */
  readonly bindings: Bindings;
  /** 重新读模板列表：打开循环、调用的表单时别的页面可能刚建了模板。 */
  readonly refresh: () => void;
}

/** 设计页读一次，工具栏、"数据"页与"连接数据…"共用。 */
export function useInsertSources(document: JsonObject | undefined): InsertSources {
  const base = document && isObject(document['base']) ? document['base'] as unknown as SchemaRef : undefined;
  const detail = useLoad(() => (base ? api.staticSchema(base.name, base.version).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${base?.name}@${base?.version}`);
  const templates = useLoad(() => api.templates(), 'design-add-templates');
  const resources = useLoad(() => api.resources(), 'design-add-resources');
  const font = resources.data?.resources.find((resource) => resource.kind === 'font');
  const baseFields = useMemo(() => baseFieldsOf(detail.data), [detail.data]);
  return {
    base,
    fields: (detail.data?.definition.fields ?? []).map((field: DefinitionField) => fieldInfo(field as never)),
    baseFields,
    loadingFields: detail.loading,
    templates: (templates.data?.templates ?? []).map((item) => ({ name: item.name, ...(item.base ? { base: item.base as SchemaRef } : {}) })),
    bindings: font ? { font: `res:${font.id}` } : {},
    refresh: templates.reload,
  };
}

// —— 选模板 ——

export const refText = (ref: SchemaRef) => `${ref.name} v${ref.version}`;
const EMPTY: SchemaRef = { name: '空数据定义', version: 1 };
const NEW = '\u0000new';

/** 选模板：只列基准相符的；也能当场从空白新建一个，基准预先填好（票据 18）。 */
export function TemplateChoice(props: { readonly base: SchemaRef | undefined; readonly templates: readonly { readonly name: string; readonly base?: SchemaRef }[]; readonly self: string; readonly value: string; readonly why: string; readonly onChange: (name: string) => void }) {
  const [creating, setCreating] = useState(false);
  const names = props.base ? matchingTemplates(props.templates, props.base).filter((name) => name !== props.self) : [];
  if (!props.base) return <p className="small muted">先选上面那一项。</p>;
  const dialog = creating && <NewTemplate base={{ ref: props.base, why: props.why }} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); props.onChange(name); }} />;
  if (names.length === 0 && !props.value) {
    return (
      <div className="small add-field" data-testid="no-template">
        <span className="muted">还没有基准是「{refText(props.base)}」的模板。</span>
        <button type="button" className="small" data-testid="new-template" onClick={() => setCreating(true)}>新建一个</button>
        {dialog}
      </div>
    );
  }
  return (
    <label className="small add-field">被调模板（基准 {refText(props.base)}）
      <select aria-label="被调模板" autoFocus value={props.value} onChange={(event) => { if (event.target.value === NEW) setCreating(true); else props.onChange(event.target.value); }}>
        <option value="">选一个模板</option>
        {props.value && !names.includes(props.value) && <option value={props.value}>{props.value}（新建，未发布）</option>}
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
        <option value={NEW}>+ 新建模板…</option>
      </select>
      {dialog}
    </label>
  );
}

// —— 工具栏上的一组 ——

type Popup = 'shape' | 'loop' | 'call';
const BLANK = { template: '', list: '', data: 'current' };
const labelOf = (kind: NewKind) => CATALOG.find((item) => item.kind === kind)!.label;

/**
 * 渲染在 .design-dock 里：一组按钮，外加浮在工具栏上方的那一块（形状目录，或循环、调用的表单）。
 * 加元素的按钮是动作，不是模式：没有按下的状态，加完焦点留在按钮上，再点一下再加一个。
 */
export function InsertBar(props: { readonly template: string; readonly document: JsonObject; readonly sources: InsertSources; readonly targetLabel: string; readonly onAdd: (element: JsonObject) => void }) {
  const { template, document, sources } = props, { base, fields } = sources;
  const [open, setOpen] = useState<Popup>();
  const [dragging, setDragging] = useState(false);
  const [chosen, setChosen] = useState(BLANK);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const show = (next?: Popup) => {
    setOpen(next); setDragging(false); setChosen(BLANK);
    if (next === 'loop' || next === 'call') sources.refresh();
  };
  // 点别处、按 Esc 收起；新建模板的弹窗开着时不算（它挂在 body 上，Esc 先归它）。Esc 在这里拦下，不再往上选父级。
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.dock-insert, .dock-pop, dialog')) show(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || window.document.querySelector('dialog[open]')) return;
      event.stopPropagation();
      show();
      buttons.current.get(open)?.focus();
    };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  }, [open]);

  const make = (kind: NewKind) => newElement(kind, document, sources.bindings);
  /** 从形状目录拖出去时目录先藏起来（不拆掉，拖完才收到 dragend），免得挡住要放的地方。 */
  const drag = (kind: NewKind, fromPopup: boolean) => ({
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>) => { startAddDrag(event, { template, element: make(kind), fromField: false }); if (fromPopup) window.setTimeout(() => setDragging(true), 0); },
    onDragEnd: () => { endAddDrag(); if (fromPopup) show(); },
  });
  const where = `加到${props.targetLabel}，也能拖到图上或图层里`;
  const lists = fields.filter((field) => field.type === 'list'), refs = fields.filter((field) => field.type === 'ref');
  const listBase = lists.find((field) => field.name === chosen.list)?.target;
  const callBase = chosen.data === 'current' ? base : chosen.data === 'none' ? EMPTY : refs.find((field) => field.name === chosen.data)?.target;
  const add = (element: JsonObject) => { props.onAdd(element); show(); };

  return (
    <>
      <span className="dock-group dock-insert" role="group" aria-label="插入">
        {INSERT_BAR.map(({ tool, label, key }) => {
          const ref = (node: HTMLButtonElement | null) => { if (node) buttons.current.set(tool, node); else buttons.current.delete(tool); };
          if (tool === 'shape') {
            return <button key={tool} ref={ref} type="button" data-testid="insert-shape" aria-label={label} title={`形状：${SHAPE_KINDS.map(labelOf).join('、')}`} aria-haspopup="true" aria-expanded={open === tool} onClick={() => show(open === tool ? undefined : tool)}><Icon d={SHAPES_ICON} /></button>;
          }
          if (tool === 'loop' || tool === 'call') {
            return <button key={tool} ref={ref} type="button" data-testid="add-element" data-kind={tool} aria-label={label} title={tool === 'loop' ? '循环容器：选列表，再选每一项用的模板' : '子模板调用：选传给它的数据，再选被调模板'} aria-haspopup="dialog" aria-expanded={open === tool} onClick={() => show(open === tool ? undefined : tool)}><Icon d={ELEMENT_ICONS[tool]!} /></button>;
          }
          return <button key={tool} ref={ref} type="button" data-testid="add-element" data-kind={tool} aria-label={label} title={`${label}${key ? ` ${key}` : ''}：${where}`} {...(key ? { 'aria-keyshortcuts': key } : {})} {...drag(tool, false)} onClick={() => add(make(tool))}><Icon d={ELEMENT_ICONS[tool]!} /></button>;
        })}
      </span>
      {open === 'shape' && (
        <div className={`dock-pop${dragging ? ' dragging' : ''}`} role="group" aria-label="形状" data-testid="insert-pop">
          <div className="dock-shapes">
            {SHAPE_KINDS.map((kind) => (
              <button key={kind} type="button" data-testid="add-element" data-kind={kind} {...drag(kind, true)} onClick={() => add(make(kind))}><Icon d={ELEMENT_ICONS[kind]!} /><span>{labelOf(kind)}</span></button>
            ))}
          </div>
          <p className="small faint">点一下加进<span data-testid="insert-target">{props.targetLabel}</span>；也能拖到图上或图层里。</p>
        </div>
      )}
      {open === 'loop' && (
        <form className="dock-pop dock-form" aria-label="添加循环容器" data-testid="insert-pop" onSubmit={(event) => { event.preventDefault(); if (chosen.list && chosen.template) add(newElement('loop', document, { list: chosen.list, template: chosen.template })); }}>
          <strong>循环容器</strong>
          <label className="small add-field">循环的列表
            <select aria-label="循环的列表" autoFocus value={chosen.list} onChange={(event) => setChosen({ ...chosen, list: event.target.value, template: '' })}>
              <option value="">选一个列表字段</option>
              {lists.map((field) => <option key={field.name} value={field.name}>{field.label}</option>)}
            </select>
          </label>
          {lists.length === 0 && <p className="small muted">{sources.loadingFields ? '正在读取字段…' : '这个模板的数据里没有列表字段。'}</p>}
          {chosen.list && <TemplateChoice base={listBase} templates={sources.templates} self={template} value={chosen.template} why={`循环的每一项是「${lists.find((field) => field.name === chosen.list)?.label ?? chosen.list}」的一项，被调模板的基准就是它。`} onChange={(name) => setChosen({ ...chosen, template: name })} />}
          <p className="small faint">加进<span data-testid="insert-target">{props.targetLabel}</span>。</p>
          <button type="submit" className="small primary" disabled={!chosen.list || !chosen.template}>添加循环容器</button>
        </form>
      )}
      {open === 'call' && (
        <form className="dock-pop dock-form" aria-label="添加子模板调用" data-testid="insert-pop" onSubmit={(event) => { event.preventDefault(); if (chosen.template) add(newElement('call', document, { template: chosen.template, data: chosen.data === 'current' || chosen.data === 'none' ? chosen.data : { var: chosen.data } })); }}>
          <strong>子模板调用</strong>
          <label className="small add-field">传给它的数据
            <select aria-label="传给它的数据" autoFocus value={chosen.data} onChange={(event) => setChosen({ ...chosen, data: event.target.value, template: '' })}>
              <option value="current">当前数据（{base ? refText(base) : '没有基准'}）</option>
              {refs.map((field) => <option key={field.name} value={field.name}>字段 {field.label}</option>)}
              <option value="none">不传数据</option>
            </select>
          </label>
          <TemplateChoice base={callBase} templates={sources.templates} self={template} value={chosen.template} why={chosen.data === 'none' ? '这个调用不传数据，被调模板的基准是空数据定义。' : chosen.data === 'current' ? '这个调用传当前数据，被调模板的基准和这个模板相同。' : '这个调用传这个单引用字段，被调模板的基准是它指向的数据定义。'} onChange={(name) => setChosen({ ...chosen, template: name })} />
          <p className="small faint">加进<span data-testid="insert-target">{props.targetLabel}</span>。</p>
          <button type="submit" className="small primary" disabled={!chosen.template}>添加子模板调用</button>
        </form>
      )}
    </>
  );
}
