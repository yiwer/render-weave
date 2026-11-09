/**
 * 循环容器与子模板调用的表单（模板设计页票据 15，方案第 7 节），取代通用字段：
 * 列表只列列表类型的变量，模板只列基准与列表的项（或调用的数据）相符的；传入参数一行一个被调模板的对外参数；每项排布的互斥直接禁用并写原因。
 * 写回是 template/calls.ts。
 */
import { useState, type ReactNode } from 'react';
import { NewTemplate } from '../components/new-template.js';
import { api, ApiError } from '../api.js';
import { baseFieldsOf, type ScopeVariable } from '../template/binding.js';
import { argRows, canUseLoopInfo, dataOf, directionOf, itemSizeOf, LOOP_INFO_TYPES, LOOP_INFOS, mergeBlocked, mergeOf, setData, setDirection, setItemSize, setMergeBy, setWrap, sizeBlocked, wrapBlocked, wrapOf, writeArg, type ItemSize } from '../template/calls.js';
import { fieldInfo, matchingTemplates, type SchemaRef } from '../template/create.js';
import { isObject, type JsonObject } from '../template/document.js';
import { useLoad } from '../hooks.js';
import { itemSizeModel, SIZE_LABELS, type SizeKind } from '../template/size.js';
import type { LayoutNode } from '../types.js';
import { SizeCell } from '../components/size-cell.js';
import { LiteralInput } from './derived-editor.js';

const Row = (props: { readonly label: string; readonly children: ReactNode; readonly testid?: string }) => (
  <div className="prop" data-testid={props.testid}><span className="prop-label">{props.label}</span><div className="prop-control">{props.children}</div></div>
);
const refText = (ref: SchemaRef) => `${ref.name} v${ref.version}`;
const sameRef = (a: SchemaRef | undefined, b: SchemaRef | undefined) => Boolean(a && b && a.name === b.name && Number(a.version) === Number(b.version));
const round = (value: number) => Math.round(value * 10) / 10;

/** 被调模板与它的基准：页面已经读到的文档优先（可能是工作副本），没有时用模板列表。 */
function useTemplates() {
  const list = useLoad(() => api.templates(), 'design-form-templates');
  return (list.data?.templates ?? []).map((item) => ({ name: item.name, ...(item.base ? { base: { name: item.base.name, version: Number(item.base.version) } } : {}) }));
}

const NEW = '\u0000new';

/** 被调模板：只列基准相符的；"+ 新建模板…"当场从空白新建，基准预先填好（票据 18）。 */
function TemplateSelect(props: {
  readonly value: string; readonly base: SchemaRef | undefined; readonly self: string; readonly templates: readonly { readonly name: string; readonly base?: SchemaRef }[]; readonly code: string;
  /** 新建时说明基准为什么是它。 */
  readonly why: string;
  readonly onChange: (name: string) => void;
}) {
  const [creating, setCreating] = useState(false);
  const names = props.base ? matchingTemplates(props.templates, props.base).filter((name) => name !== props.self) : [];
  const current = props.templates.find((item) => item.name === props.value);
  const mismatch = props.value && props.base && current?.base && !sameRef(current.base, props.base);
  return (
    <>
      <select aria-label="被调模板" value={props.value} onChange={(event) => { if (event.target.value === NEW) setCreating(true); else props.onChange(event.target.value); }}>
        {!names.includes(props.value) && <option value={props.value}>{props.value || '选一个模板'}</option>}
        {names.map((name) => <option key={name} value={name}>{name}</option>)}
        {props.base && <option value={NEW}>+ 新建模板…</option>}
      </select>
      {creating && props.base && <NewTemplate base={{ ref: props.base, why: props.why }} onClose={() => setCreating(false)} onCreated={(name) => { setCreating(false); props.onChange(name); }} />}
      {props.base && <span className="small faint">只列基准是 {refText(props.base)} 的</span>}
      {mismatch && <span className="prop-error" role="alert" data-testid="base-mismatch">「{props.value}」的基准是 {refText(current!.base!)}，对不上（{props.code}）</span>}
    </>
  );
}

/** 实际结果：项数与每项尺寸，来自布局摘要。 */
function LoopResult(props: { readonly node?: LayoutNode | undefined; readonly direction: 'row' | 'column' }) {
  const items = (props.node?.children ?? []).filter((child) => child.visible);
  if (!props.node) return null;
  const main = items.map((child) => (props.direction === 'row' ? child.width : child.height));
  const span = main.length ? (Math.min(...main) === Math.max(...main) ? `${round(main[0]!)}` : `${round(Math.min(...main))}–${round(Math.max(...main))}`) : '0';
  return <p className="fit-result small" data-testid="loop-result">这一处：{items.length} 项，每项{props.direction === 'row' ? '宽' : '高'} {span} mm</p>;
}

/** 循环的来源：列表、被调模板、合并相邻。 */
export function LoopSourceForm(props: {
  readonly element: JsonObject; readonly template: string; readonly variables: readonly ScopeVariable[]; readonly documentOf: (template: string) => JsonObject | undefined;
  readonly onElement: (next: JsonObject, now?: boolean) => void; readonly onProblem: (problem: string) => void; readonly children?: ReactNode;
}) {
  const { element, variables } = props, templates = useTemplates();
  const listName = isObject(element['list']) ? String(element['list']['var']) : '';
  const lists = variables.filter((item) => item.type === 'list');
  const chosen = lists.find((item) => item.name === listName);
  const base = chosen?.itemType ? fieldInfo({ name: chosen.name, type: 'list', items: { type: chosen.itemType, ...(chosen.itemRef ? { ref: chosen.itemRef } : {}) } }).target : undefined;
  const called = String(element['template'] ?? '');
  const calledDoc = props.documentOf(called), calledBase = isObject(calledDoc?.['base']) ? calledDoc['base'] as unknown as SchemaRef : undefined;
  const detail = useLoad(() => (calledBase ? api.staticSchema(calledBase.name, calledBase.version).catch((error: unknown) => { if (error instanceof ApiError) return undefined; throw error; }) : Promise.resolve(undefined)), `${calledBase?.name}@${calledBase?.version}`);
  const mergeFields = baseFieldsOf(detail.data).filter((field) => !['list', 'ref'].includes(field.type));
  const merge = mergeOf(element), blocked = mergeBlocked(element);
  return (
    <div className="call-form" data-testid="loop-form">
      <Row label="循环的列表">
        <select aria-label="循环的列表" value={listName} onChange={(event) => props.onElement({ ...element, list: { var: event.target.value } }, true)}>
          {!chosen && <option value={listName}>{listName || '选一个列表'}</option>}
          {lists.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
        </select>
      </Row>
      <Row label="被调模板"><TemplateSelect value={called} base={base} self={props.template} templates={templates} code="template.loopBaseMismatch" why={`循环的每一项是「${chosen?.label ?? listName}」的一项，被调模板的基准就是它。`} onChange={(name) => props.onElement({ ...element, template: name }, true)} /></Row>
      {props.children}
      <Row label="合并相邻" testid="merge-row">
        <select aria-label="合并相邻同值项" value={merge ?? ''} disabled={Boolean(blocked) && !merge} title={blocked} onChange={(event) => {
          const next = setMergeBy(element, event.target.value || undefined);
          if ('problem' in next) props.onProblem(String(next['problem'])); else props.onElement(next, true);
        }}>
          <option value="">不合并</option>
          {merge && !mergeFields.some((field) => field.name === merge) && <option value={merge}>{merge}</option>}
          {mergeFields.map((field) => <option key={field.name} value={field.name}>按「{field.label}」合并</option>)}
        </select>
        {blocked && !merge && <span className="small faint" data-testid="merge-blocked">{blocked}</span>}
        {merge && <span className="small faint">相邻且取值相同的项合成一组，按组内项数跨格；每项尺寸只能等分</span>}
      </Row>
    </div>
  );
}

/** 调用的来源：传什么数据，被调模板按它的基准筛。 */
export function CallSourceForm(props: { readonly element: JsonObject; readonly template: string; readonly document: JsonObject; readonly variables: readonly ScopeVariable[]; readonly onElement: (next: JsonObject, now?: boolean) => void }) {
  const { element, variables } = props, templates = useTemplates();
  const data = dataOf(element);
  const refs = variables.filter((item) => item.type === 'ref' && !item.name.includes('.'));
  const own = isObject(props.document['base']) ? props.document['base'] as unknown as SchemaRef : undefined;
  // 单引用字段指向的数据定义读不到（编译产物里内联了）：被调模板就列全部，选错了由基准检查报。
  const base = data === 'current' ? own : data === 'none' ? { name: '空数据定义', version: 1 } : undefined;
  return (
    <div className="call-form" data-testid="call-form">
      <Row label="传给它的数据">
        <select aria-label="传给它的数据" value={data} onChange={(event) => props.onElement(setData(element, event.target.value), true)}>
          <option value="current">当前数据（{own ? refText(own) : '没有基准'}）</option>
          {refs.map((item) => <option key={item.name} value={item.name}>字段 {item.label}</option>)}
          <option value="none">不传数据</option>
        </select>
      </Row>
      <Row label="被调模板">
        {base
          ? <TemplateSelect value={String(element['template'] ?? '')} base={base} self={props.template} templates={templates} code="template.callBaseMismatch" why={data === 'none' ? '这个调用不传数据，被调模板的基准是空数据定义。' : '这个调用传当前数据，被调模板的基准和这个模板相同。'} onChange={(name) => props.onElement({ ...element, template: name }, true)} />
          : (
            <select aria-label="被调模板" value={String(element['template'] ?? '')} onChange={(event) => props.onElement({ ...element, template: event.target.value }, true)}>
              {templates.filter((item) => item.name !== props.template).map((item) => <option key={item.name} value={item.name}>{item.name}{item.base ? `（${refText(item.base)}）` : ''}</option>)}
            </select>
          )}
      </Row>
    </div>
  );
}

/** 传入参数：被调模板的全部对外参数，每行来源是变量、固定值或循环信息；没有缺省值又没传的标红。 */
export function ArgsForm(props: { readonly element: JsonObject; readonly called: JsonObject | undefined; readonly variables: readonly ScopeVariable[]; readonly onElement: (next: JsonObject, now?: boolean) => void }) {
  const { element, variables } = props;
  if (!props.called) return <p className="small muted">读不到被调模板，参数列不出来。</p>;
  const { rows, extra } = argRows(element, props.called), loop = canUseLoopInfo(element);
  if (rows.length === 0 && extra.length === 0) return <p className="small muted">被调模板没有对外参数。</p>;
  return (
    <div className="args" data-testid="args-form">
      {rows.map((row) => {
        const value = row.value, kind = !value ? 'none' : 'loop' in value ? 'loop' : 'var' in value ? 'var' : 'value';
        const candidates = variables.filter((item) => item.type === row.type);
        const infos = LOOP_INFOS.filter(([info]) => LOOP_INFO_TYPES[info] === row.type);
        const write = (next: JsonObject | undefined) => props.onElement(writeArg(element, row.name, next), kind !== 'value');
        return (
          <div key={row.name} className={`arg-row${row.missing ? ' missing' : ''}`} data-testid="arg-row" data-name={row.name} data-missing={row.missing ? 'true' : undefined}>
            <span className="arg-name" title={row.name}>{row.label}</span>
            <select aria-label={`${row.label}的来源`} value={kind} onChange={(event) => {
              const to = event.target.value;
              props.onElement(writeArg(element, row.name, to === 'none' ? undefined : to === 'var' ? { var: candidates[0]?.name ?? '' } : to === 'loop' ? { loop: infos[0]?.[0] ?? 'index' } : { value: row.type === 'number' ? 0 : row.type === 'boolean' ? false : '' }), true);
            }}>
              <option value="var">变量</option>
              <option value="value">固定值</option>
              {loop && infos.length > 0 && <option value="loop">循环信息</option>}
              <option value="none">{row.hasDefault ? '不传（用缺省值）' : '不传'}</option>
            </select>
            {kind === 'var' && (
              <select aria-label={`${row.label}的变量`} value={String((value as JsonObject)['var'])} onChange={(event) => write({ var: event.target.value })}>
                {!candidates.some((item) => item.name === (value as JsonObject)['var']) && <option value={String((value as JsonObject)['var'])}>{String((value as JsonObject)['var']) || '选一个变量'}</option>}
                {candidates.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
              </select>
            )}
            {kind === 'value' && <LiteralInput type={row.type} value={(value as JsonObject)['value']} label={`${row.label}的固定值`} onChange={(next) => write({ value: next })} />}
            {kind === 'loop' && (
              <select aria-label={`${row.label}的循环信息`} value={String((value as JsonObject)['loop'])} onChange={(event) => write({ loop: event.target.value })}>
                {infos.map(([info, label]) => <option key={info} value={info}>{label}</option>)}
              </select>
            )}
            {row.missing && <span className="prop-error" data-testid="arg-missing">没有缺省值，必须传</span>}
          </div>
        );
      })}
      {extra.map((name) => (
        <div key={name} className="arg-row missing" data-testid="arg-extra">
          <span className="arg-name">{name}</span>
          <span className="small faint">被调模板没有这个对外参数</span>
          <button type="button" className="link danger" onClick={() => props.onElement(writeArg(element, name, undefined), true)}>去掉</button>
        </div>
      ))}
    </div>
  );
}

const ITEM_KINDS = ['equal', 'content', 'fixed'] as const;

/** 每项排布：方向、每项尺寸、折行；用不了的选项禁用并写原因。每项尺寸是宽高一格（第三轮票据 01），间距与换行间距沿用值格。 */
export function ItemLayoutForm(props: { readonly element: JsonObject; readonly node?: LayoutNode | undefined; readonly onElement: (next: JsonObject, now?: boolean) => void; readonly onProblem: (problem: string) => void; readonly children?: ReactNode }) {
  const { element } = props, direction = directionOf(element), size = itemSizeOf(element) ?? 'equal';
  const sizeKind = typeof size === 'string' ? size : 'fixed', wrap = wrapOf(element), wrapReason = wrapBlocked(element);
  const apply = (next: JsonObject | { problem: string }) => { if ('problem' in next) props.onProblem(String(next['problem'])); else props.onElement(next, true); };
  const writeSize = (value: unknown, now: boolean) => { const next = setItemSize(element, value as ItemSize); if ('problem' in next) props.onProblem(String(next['problem'])); else props.onElement(next, now); };
  const items = (props.node?.children ?? []).filter((child) => child.visible), label = direction === 'row' ? '每项宽' : '每项高';
  const blocked = Object.fromEntries(ITEM_KINDS.flatMap((kind) => { const reason = kind === sizeKind ? undefined : sizeBlocked(element, kind); return reason ? [[kind, reason]] : []; })) as Partial<Record<SizeKind, string>>;
  return (
    <div className="call-form" data-testid="item-layout-form">
      <Row label="方向">
        <div className="segmented prop-segmented" role="group" aria-label="方向">
          {(['row', 'column'] as const).map((value) => <button key={value} type="button" aria-pressed={direction === value} onClick={() => apply(setDirection(element, value))}>{value === 'row' ? '横向' : '纵向'}</button>)}
        </div>
      </Row>
      <Row label={label}>
        <SizeCell label={label} model={itemSizeModel(itemSizeOf(element))} actual={items.length ? (direction === 'row' ? items[0]!.width : items[0]!.height) : undefined} required blocked={blocked} onWrite={writeSize} />
        {ITEM_KINDS.map((kind) => (blocked[kind] ? <span key={kind} className="small faint" data-testid="size-blocked">{SIZE_LABELS[kind]}：{blocked[kind]}</span> : null))}
      </Row>
      {props.children}
      <Row label="折行">
        <div className="segmented prop-segmented" role="group" aria-label="折行">
          <button type="button" aria-pressed={!wrap} onClick={() => apply(setWrap(element, false))}>不折行</button>
          <button type="button" aria-pressed={wrap} disabled={!wrap && Boolean(wrapReason)} title={wrapReason} onClick={() => apply(setWrap(element, true))}>放不下就折行</button>
        </div>
        {!wrap && wrapReason && <span className="small faint" data-testid="wrap-blocked">{wrapReason}</span>}
      </Row>
      <p className="small faint">横向写每项宽、纵向写每项高；换方向时尺寸跟着换过去。</p>
      <LoopResult node={props.node} direction={direction} />
    </div>
  );
}
