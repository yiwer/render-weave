/**
 * 属性面板的字段（P1 票据 08）：把生成规则给的可编辑项画出来，改动交给 onWrite。
 * 输入框里的草稿留在这里：不合法的不写回，标红并说明；撤销、换元素时跟着文档里的值走。
 * 能绑定的属性画成值格（模板设计页票据 09）：字面值、没写、绑定三种样子，绑定与断开写回同一个入口。
 */
import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { boundName, currentLiteral, unboundValue, type OriginLink, type OriginText, type ScopeVariable } from '../template/binding.js';
import { edgesSummary, inSpokenOrder, partsNoun, partValues, writePart } from '../template/edges.js';
import { familyOf, fontInFamily, type FontFamily } from '../template/fonts.js';
import type { Bindable, Editor, FieldPath, PropertyField } from '../template/properties.js';
import { sizeKindOf, sizeModel } from '../template/size.js';
import { BindingPopover } from './binding-popover.js';
import { SizeCell } from './size-cell.js';
import { CROSS, Icon, LINK, SIDES, UNLINK } from './icon.js';
import { ValueText } from './value-text.js';

/** 值格要的页面能力。没有它时（列表项的编辑）字段按老样子画变体下拉。 */
export interface BindingHost {
  /** 这个模板作用域里的变量，带当前样例的值。 */
  readonly variables: readonly ScopeVariable[];
  readonly taken: ReadonlySet<string>;
  suggest(field: PropertyField): { readonly name: string; readonly displayName: string };
  /** written：绑定只是这一格的一部分时（四边里的一边）整格要写成什么。 */
  extract(field: PropertyField, bindable: Bindable, value: unknown, name: string, displayName: string, written?: unknown): void;
  describe(variable: ScopeVariable): OriginText | undefined;
  /** 来源链与"查看变量"跳过去。 */
  open(link: Pick<OriginLink, 'template' | 'name' | 'kind'>): void;
  /** 状态样式在哪些取值下覆盖这一项；没有时是空的。 */
  overriddenBy(field: PropertyField): readonly string[];
}

export interface FieldContext {
  /** now：选项与开关立刻写回，打字才等停顿。 */
  onWrite(path: FieldPath, value: unknown, options?: { readonly now?: boolean }): void;
  /** 建议的选项：<datalist> 的 ID，由页面按变量、字段与资源生成。 */
  readonly lists: Readonly<Record<'variable' | 'field' | 'font' | 'image', string>>;
  readonly binding?: BindingHost;
  /** 字体按族分组列字重（M115）；没给时字体是文本框。 */
  readonly fonts?: readonly FontFamily[];
  /** 写回之前的额外检查（元素名在模板内唯一）：有问题时不写回，标在输入框下面。 */
  check?(field: PropertyField, value: unknown): string | undefined;
  /** 状态样式选中的取值（票据 17）：被这个取值覆盖的项可以重置回自身属性。 */
  readonly stateValue?: string;
  resetOverride?(field: PropertyField): void;
  /** 选中的这一处在图上的实际尺寸（布局摘要）：宽高一格没写或随内容时淡色显示它（第三轮票据 01）。 */
  readonly box?: { readonly width: number; readonly height: number };
  /** 从"+ 属性"加上的项（第三轮票据 05）：行尾有"去掉"，点了删掉这个键，这一项回到菜单里。值是字段的 key。 */
  readonly removable?: ReadonlySet<string>;
  onRemove?(field: PropertyField): void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** 没写时的提示：引擎的缺省值淡色显示，不知道时写"缺省"。 */
const placeholderOf = (field: PropertyField, required = '') => (field.required ? required : field.fallback !== undefined ? String(field.fallback) : '缺省');

/** 草稿：合法才写回。外面的值变了（撤销、重做）就换成外面的值，自己写回的不算。 */
function useDraft(value: unknown, format: (value: unknown) => string) {
  const [draft, setDraft] = useState(() => format(value));
  const [error, setError] = useState<string>();
  const written = useRef(value);
  useEffect(() => {
    if (same(value, written.current)) return;
    written.current = value;
    setDraft(format(value));
    setError(undefined);
  }, [value]);
  return { draft, setDraft, error, setError, written };
}

function numberError(editor: Extract<Editor, { kind: 'number' }>, value: number): string | undefined {
  if (!Number.isFinite(value)) return '要填数字';
  if (editor.integer && !Number.isInteger(value)) return '要填整数';
  if (editor.min !== undefined && value < editor.min) return `不能小于 ${editor.min}`;
  if (editor.max !== undefined && value > editor.max) return `不能大于 ${editor.max}`;
  if (editor.exclusiveMin !== undefined && value <= editor.exclusiveMin) return `要大于 ${editor.exclusiveMin}`;
  return undefined;
}

function NumberInput(props: { readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'number' }>; readonly context: FieldContext; readonly live?: number | undefined; readonly hint?: string | undefined }) {
  const { field, editor, live } = props;
  const { draft, setDraft, error, setError, written } = useDraft(field.value, (value) => (typeof value === 'number' ? String(value) : ''));
  const change = (text: string) => {
    setDraft(text);
    if (text.trim() === '') {
      if (field.required) { setError('必填'); return; }
      setError(undefined);
      written.current = undefined;
      props.context.onWrite(field.path, undefined);
      return;
    }
    const value = Number(text), problem = numberError(editor, value);
    setError(problem);
    if (problem) return;
    written.current = value;
    props.context.onWrite(field.path, value);
  };
  return (
    <>
      <input id={props.id} type="text" inputMode="decimal" className="prop-number" value={live === undefined ? draft : String(live)} aria-invalid={error ? true : undefined} placeholder={props.hint ?? placeholderOf(field)}
        onChange={(event) => change(event.target.value)} />
      {error && <span className="prop-error" role="alert">{error}</span>}
    </>
  );
}

/**
 * 字体：字体族与字重两个下拉（第三轮票据 04），写回的仍是一个资源引用（M115）。换字体族时字重留着，这一族没有就取 Regular。
 * 资源库里没有的引用也列出来，不悄悄换掉；这时字重没得选。
 */
function FontSelect(props: { readonly id: string; readonly field: PropertyField; readonly families: readonly FontFamily[]; readonly context: FieldContext }) {
  const { field, families, context } = props;
  const value = typeof field.value === 'string' ? field.value : '';
  const current = familyOf(families, value), weight = current?.fonts.find((font) => font.ref === value)?.weight;
  const write = (ref: string | undefined) => context.onWrite(field.path, ref, { now: true });
  const pickFamily = (name: string) => {
    if (name === '') return write(undefined);
    const family = families.find((item) => item.family === name);
    if (family) write(fontInFamily(family, weight));
  };
  return (
    <span className="font-select">
      <select id={props.id} value={current ? current.family : value} data-testid="font-family" aria-label="字体族" title="字体族" onChange={(event) => pickFamily(event.target.value)}>
        {!field.required && <option value="">缺省</option>}
        {field.required && value === '' && <option value="">选择字体</option>}
        {value !== '' && !current && <option value={value}>{value}（资源库里没有）</option>}
        {families.map((family) => <option key={family.family} value={family.family}>{family.family}</option>)}
      </select>
      <select value={current ? value : ''} data-testid="font-select" aria-label="字重" title="字重：换的是这一族里的另一个字体资源" disabled={!current} onChange={(event) => write(event.target.value)}>
        {!current && <option value="">字重</option>}
        {current?.fonts.map((font) => <option key={font.ref} value={font.ref}>{font.weight}</option>)}
      </select>
    </span>
  );
}

function TextInput(props: { readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'text' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  const { draft, setDraft, error, setError, written } = useDraft(field.value, (value) => (typeof value === 'string' ? value : ''));
  const change = (text: string) => {
    setDraft(text);
    if (text === '' && !field.required) {
      setError(undefined);
      written.current = undefined;
      context.onWrite(field.path, undefined);
      return;
    }
    const tooShort = editor.minLength !== undefined && text.length < editor.minLength, badPattern = editor.pattern !== undefined && !new RegExp(editor.pattern, 'u').test(text);
    if (tooShort || badPattern) { setError(text === '' ? '必填' : '格式不对'); return; }
    const problem = context.check?.(field, text);
    if (problem) { setError(problem); return; }
    setError(undefined);
    written.current = text;
    context.onWrite(field.path, text);
  };
  return (
    <>
      <input id={props.id} type="text" value={draft} aria-invalid={error ? true : undefined} {...(editor.suggest ? { list: context.lists[editor.suggest] } : {})}
        placeholder={placeholderOf(field)} onChange={(event) => change(event.target.value)} />
      {error && <span className="prop-error" role="alert">{error}</span>}
    </>
  );
}

function ColorInput(props: { readonly id: string; readonly field: PropertyField; readonly context: FieldContext }) {
  const { field, context } = props;
  const { draft, setDraft, error, setError, written } = useDraft(field.value, (value) => (typeof value === 'string' ? value : ''));
  const write = (text: string) => {
    setDraft(text);
    if (text === '' && !field.required) {
      setError(undefined);
      written.current = undefined;
      context.onWrite(field.path, undefined);
      return;
    }
    if (!/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(text)) { setError('写成 #RRGGBB'); return; }
    setError(undefined);
    written.current = text;
    context.onWrite(field.path, text);
  };
  return (
    <span className="color-input">
      {/* 取色器只认 #RRGGBB，带透明度的取前 6 位显示。 */}
      <input type="color" className={draft ? undefined : 'unset'} aria-label={`${field.label}（取色）`} value={/^#[0-9a-fA-F]{6}/.test(draft) ? draft.slice(0, 7).toLowerCase() : '#000000'} onChange={(event) => write(event.target.value.toUpperCase())} />
      <input id={props.id} type="text" value={draft} aria-invalid={error ? true : undefined} placeholder={placeholderOf(field, '#RRGGBB')} onChange={(event) => write(event.target.value)} />
      {error && <span className="prop-error" role="alert">{error}</span>}
    </span>
  );
}

function JsonInput(props: { readonly id: string; readonly field: PropertyField; readonly context: FieldContext }) {
  const { field, context } = props;
  const { draft, setDraft, error, setError, written } = useDraft(field.value, (value) => (value === undefined ? '' : JSON.stringify(value)));
  const change = (text: string) => {
    setDraft(text);
    if (text.trim() === '') {
      setError(undefined);
      written.current = undefined;
      context.onWrite(field.path, undefined);
      return;
    }
    let value: unknown;
    try { value = JSON.parse(text); } catch { setError('不是合法的 JSON'); return; }
    setError(undefined);
    written.current = value;
    context.onWrite(field.path, value);
  };
  return (
    <>
      <textarea id={props.id} rows={2} className="mono" value={draft} aria-invalid={error ? true : undefined} onChange={(event) => change(event.target.value)} />
      {error && <span className="prop-error" role="alert">{error}</span>}
    </>
  );
}

/** 用序号当选项的值：值可能是数组、布尔。 */
function Choice(props: { readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'choice' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  const selected = editor.options.findIndex((option) => same(option.value, field.value));
  const fallback = field.fallback === undefined ? undefined : editor.options.find((option) => same(option.value, field.fallback));
  // 选项少又短的摊开成分段：一眼看到全部取值，一下点到。没写又不知道缺省是什么的还用下拉，要能显示"缺省"。
  const short = editor.options.length <= 4 && editor.options.reduce((total, option) => total + option.label.length, 0) <= 12;
  if (short && (field.required || fallback)) {
    return (
      <div className="segmented prop-segmented" role="group" aria-label={field.label} data-testid="segmented">
        {editor.options.map((option, index) => (
          <button key={index} type="button" aria-pressed={selected === index} className={selected < 0 && same(option.value, field.fallback) ? 'implied' : undefined} title={selected < 0 && same(option.value, field.fallback) ? '没写，这是缺省值' : undefined}
            onClick={() => context.onWrite(field.path, option.value, { now: true })}>{option.label}</button>
        ))}
      </div>
    );
  }
  return (
    <select id={props.id} value={selected} onChange={(event) => { const index = Number(event.target.value); context.onWrite(field.path, index < 0 ? undefined : editor.options[index]!.value, { now: true }); }}>
      {(!field.required || selected < 0) && <option value={-1}>{fallback ? `缺省（${fallback.label}）` : '缺省'}</option>}
      {editor.options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select>
  );
}

/** 来源链：这个变量真正的值在哪，一键跳过去。 */
export function OriginLine(props: { readonly text: OriginText; readonly onOpen: (link: OriginLink) => void }) {
  const { text } = props;
  return (
    <p className="value-origin small" data-testid="value-origin">
      {text.before}
      {text.link && <button type="button" className="link" onClick={() => props.onOpen(text.link!)}>{text.link.label}</button>}
      {text.after}
    </p>
  );
}

/**
 * 值格：绑定时是灰底条（显示名称与当前值），点开换绑定，旁边断开；断开时当前值变成字面值，图不变。
 * 没绑定时是字面值的输入框，没写就淡色显示缺省值；右边的按钮打开绑定弹层。字面值有几种写法时在下拉里选（四边、四角另由 EdgesCell 画）。
 */
function ValueCell(props: {
  readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'variants' }>; readonly bindable: Bindable; readonly host: BindingHost; readonly context: FieldContext; readonly live?: number | undefined;
  /** 数值框空着时显示的字（四边一格的摘要）；没给就是缺省值。 */
  readonly hint?: string | undefined;
  /** 排在绑定按钮前面的按钮（四边一格的展开）。 */
  readonly extra?: ReactNode;
  /** 窄格（四边里的一边）：不画来源那一行，变量的名称在灰底条的提示里。 */
  readonly compact?: boolean;
}) {
  const { id, field, editor, bindable, host, context, live } = props;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const name = boundName(field.value), variable = name === undefined ? undefined : host.variables.find((item) => item.name === name);
  const origin = variable && host.describe(variable);
  const literals = editor.variants.flatMap((variant, index) => (boundName(variant.initial) === undefined ? [{ variant, index }] : []));
  // 字面值之外还有对象形态的变体（内边距分别设置）才要下拉；是与否由字面值的选择框管。
  const choose = bindable.type !== 'boolean' && literals.length > 1;
  const scalar = !editor.editor || editor.editor.kind === bindable.literal.kind;
  const shown = scalar ? bindable.literal : editor.editor!;
  const activeLiteral = name === undefined && editor.active >= 0 ? editor.active : literals.find(({ variant }) => typeof variant.initial !== 'object')?.index ?? literals[0]?.index ?? 0;
  const suggested = host.suggest(field);
  const button = (label: string) => (
    <button type="button" className="value-action" aria-label={label} title={label} aria-expanded={open} data-testid="bind-button" onClick={() => setOpen(!open)}><Icon d={LINK} /></button>
  );
  return (
    <div className="value-cell" data-testid="value-cell" data-state={name !== undefined ? 'bound' : field.value === undefined ? 'unset' : 'literal'}>
      <div className="value-cell-row">
        {name !== undefined ? (
          <>
            <button type="button" className="value-bound" data-testid="bound-chip" aria-label={`${field.label}绑定了 ${variable?.label ?? name}，点开换绑定`} aria-expanded={open} title={name} onClick={() => setOpen(!open)}>
              <span className="value-bound-name">{variable?.label ?? name}</span>
              <ValueText value={variable?.value} type={variable?.type ?? bindable.type} />
            </button>
            {props.extra}
            <button type="button" className="value-action" aria-label="断开绑定" title="断开绑定：当前值变成字面值" data-testid="unbind-button" onClick={() => context.onWrite(field.path, unboundValue(bindable, variable?.value), { now: true })}><Icon d={UNLINK} /></button>
          </>
        ) : (
          <>
            {choose && (
              <select className="prop-variant" aria-label={`${field.label}的写法`} value={activeLiteral} onChange={(event) => context.onWrite(field.path, editor.variants[Number(event.target.value)]!.initial, { now: true })}>
                {literals.map(({ variant, index }) => <option key={index} value={index}>{variant.label}</option>)}
              </select>
            )}
            {/* 字面值的输入框不随"没写→写了"重建，否则打第一个字就丢焦点。 */}
            {scalar && <EditorView key="literal" id={id} field={field} editor={shown} context={context} live={live} hint={props.hint} />}
            {props.extra}
            {button('绑定变量')}
          </>
        )}
      </div>
      {/* 写成对象的变体（内边距分别设置）放在下拉下面，占满整行：挤在一行里每格就太窄了。 */}
      {name === undefined && !scalar && <EditorView key={editor.active} id={id} field={field} editor={shown} context={context} live={live} />}
      {origin && !props.compact && <OriginLine text={origin} onOpen={host.open} />}
      {open && (
        <BindingPopover type={bindable.type} label={field.label} {...(name !== undefined ? { current: name } : {})} variables={host.variables}
          extract={{ value: currentLiteral(field, bindable, variable?.value), name: suggested.name, displayName: suggested.displayName, taken: host.taken }}
          onPick={(next) => { context.onWrite(field.path, { var: next }, { now: true }); close(); }}
          onExtract={(next, displayName) => { host.extract(field, bindable, currentLiteral(field, bindable, variable?.value), next, displayName); close(); }}
          onOpen={(target) => { const base = target.name.split('.')[0]!; close(); host.open({ template: '', name: base, kind: target.kind }); }}
          onClose={close} />
      )}
    </div>
  );
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * 四边一格（第三轮票据 02）：内边距、外边距、圆角。一格是一个数（四边都是它）或一个变量；四边不一样时框里是摘要（"上 1 · 下 2"），
 * 这时打一个数是四边都改。点右边的按钮展开四个值格，直接在某一边打数或绑定变量；只写那一边，四边都一样时收回成一个数。
 * 每边的取值与写回由 template/edges.ts 决定。
 */
function EdgesCell(props: {
  readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'variants' }>; readonly bindable: Bindable; readonly parts: readonly PropertyField[];
  readonly host: BindingHost; readonly context: FieldContext; readonly live?: number | undefined;
}) {
  const { id, field, editor, bindable, parts, host, context } = props;
  const [open, setOpen] = useState(false);
  const keys = parts.map((part) => part.key.slice(field.key.length + 1)), noun = partsNoun(keys);
  const split = typeof field.value === 'object' && field.value !== null && boundName(field.value) === undefined;
  // 这一格只管"一个数或一个变量"：对象形态的变体不进下拉，由展开的四格写。
  const scalar = editor.variants.flatMap((variant, index) => (typeof variant.initial === 'object' && variant.initial !== null && boundName(variant.initial) === undefined ? [] : [{ variant, index }]));
  const whole: Extract<Editor, { kind: 'variants' }> = { kind: 'variants', variants: scalar.map((item) => item.variant), active: scalar.findIndex((item) => item.index === editor.active), bindable };
  const labelOfVariable = (name: string) => host.variables.find((item) => item.name === name)?.label ?? name;
  const summary = split ? edgesSummary(field.value, parts.map((part, index) => ({ key: keys[index]!, label: part.label })), labelOfVariable) : undefined;
  const values = partValues(field.value, keys);
  const toggle = (
    <button type="button" className="value-action" aria-label={`${open ? '收起' : '展开'}${field.label}的${noun}`} title={`${noun}分开写`} aria-expanded={open} data-testid="edges-toggle" onClick={() => setOpen(!open)}><Icon d={SIDES} /></button>
  );
  return (
    <div className="edges-cell" data-testid="edges-cell" data-state={split ? 'parts' : boundName(field.value) !== undefined ? 'bound' : field.value === undefined ? 'unset' : 'literal'} {...(summary !== undefined ? { 'data-summary': summary, title: `${noun}不一样：${summary}。在这里打一个数是${noun}都改` } : {})}>
      <ValueCell id={id} field={{ ...field, editor: whole }} editor={whole} bindable={bindable} host={host} context={context} live={props.live} hint={summary} extra={toggle} />
      {open && (
        <div className="edges-parts" role="group" aria-label={`${field.label}的${noun}`} data-testid="edges-parts">
          {inSpokenOrder(parts.map((part, index) => ({ key: keys[index]!, part }))).map(({ key, part }) => {
            const value = values[key];
            if (part.editor.kind !== 'variants' || !part.editor.bindable) return null;
            const partEditor: Extract<Editor, { kind: 'variants' }> = { ...part.editor, active: value === undefined ? -1 : boundName(value) !== undefined ? part.editor.variants.findIndex((variant) => boundName(variant.initial) !== undefined) : part.editor.variants.findIndex((variant) => boundName(variant.initial) === undefined) };
            const partField: PropertyField = { ...part, label: `${field.label}（${part.label}）`, value, editor: partEditor, fallback: 0 };
            // 写一边就是写整格：别的边照现在的取值留着。
            const partContext: FieldContext = {
              ...context,
              onWrite: (_path, next, options) => context.onWrite(field.path, writePart(field.value, keys, key, next), options),
              binding: {
                ...host,
                suggest: () => {
                  const base = host.suggest(field), stem = `${base.name.replace(/\d+$/u, '')}${capital(key)}`;
                  let name = stem;
                  for (let count = 2; host.taken.has(name); count++) name = `${stem}${count}`;
                  return { name, displayName: `${base.displayName}（${part.label}）` };
                },
                extract: (_field, kind, current, name, displayName) => host.extract(field, kind, current, name, displayName, writePart(field.value, keys, key, { var: name })),
                overriddenBy: () => [],
              },
            };
            return (
              <div key={key} className="edges-part" data-testid="property-field" data-key={part.key}>
                <label className="edges-part-label small muted" htmlFor={`${id}-${key}`}>{part.label}</label>
                <ValueCell id={`${id}-${key}`} field={partField} editor={partEditor} bindable={part.editor.bindable} host={partContext.binding!} context={partContext} compact />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Variants(props: { readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'variants' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  return (
    <>
      <select id={props.id} className="prop-variant" value={editor.active} onChange={(event) => { const index = Number(event.target.value); context.onWrite(field.path, index < 0 ? undefined : editor.variants[index]!.initial, { now: true }); }}>
        {(!field.required || editor.active < 0) && <option value={-1}>缺省</option>}
        {editor.variants.map((variant, index) => <option key={index} value={index}>{variant.label}</option>)}
      </select>
      {/* 换了变体，里面的输入框要跟着换。 */}
      {editor.editor && <EditorView key={editor.active} id={`${props.id}-value`} field={field} editor={editor.editor} context={context} />}
    </>
  );
}

const hasRequired = (initial: unknown) => (Array.isArray(initial) ? initial.length > 0 : typeof initial === 'object' && initial !== null && Object.keys(initial).length > 0);

function Group(props: { readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'group' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  // 有必填子项的对象（描边、状态样式）要先添加。
  if (editor.absent && hasRequired(editor.initial)) {
    return <button type="button" className="small quiet prop-add" onClick={() => context.onWrite(field.path, editor.initial, { now: true })}>添加</button>;
  }
  // 只有一项的对象（{ fixed: 数值 }、{ var: 变量名 }）不再多一层标题。
  if (editor.fields.length === 1) {
    const only = editor.fields[0]!;
    return <span className="prop-inline" data-testid="property-field" data-key={only.key}><EditorView id={`${only.key}-only`} field={only} editor={only.editor} context={context} /></span>;
  }
  const tuple = typeof editor.fields[0]?.path.at(-1) === 'number';
  // 只有一个取值的必填项（layout 的 mode）已经由外层的变体选定，不用再摆一个只有一项的选择。
  const shown = editor.fields.filter((inner) => !(inner.required && inner.editor.kind === 'choice' && inner.editor.options.length === 1));
  return (
    <div className={tuple ? 'prop-tuple' : 'prop-group'}>
      {tuple
        ? shown.map((inner) => <span key={inner.key} data-testid="property-field" data-key={inner.key}><EditorView id={inner.key} field={inner} editor={inner.editor} context={context} /></span>)
        : <FieldRows fields={shown} context={context} />}
      {!field.required && !editor.absent && hasRequired(editor.initial) && !context.removable?.has(field.key) && (
        <button type="button" className="link danger prop-remove" onClick={() => context.onWrite(field.path, undefined, { now: true })}>去掉{field.label}</button>
      )}
    </div>
  );
}

function ListEditor(props: { readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'list' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  const current = Array.isArray(field.value) ? field.value as unknown[] : [];
  return (
    <div className="prop-list">
      {editor.items.map((item, index) => (
        <div key={index} className="prop-list-item" data-testid="property-field" data-key={item.key}>
          <div className="prop-list-head">
            <span className="small muted">{item.label}</span>
            {current.length > editor.minItems && <button type="button" className="link danger" onClick={() => context.onWrite(field.path, current.filter((_, at) => at !== index))}>删除</button>}
          </div>
          <EditorView id={item.key} field={item} editor={item.editor} context={context} />
        </div>
      ))}
      <div className="prop-actions">
        {editor.append.map((option) => (
          <button key={option.label} type="button" className="small quiet" onClick={() => context.onWrite(field.path, [...current, option.value])}>添加{option.label}</button>
        ))}
      </div>
    </div>
  );
}

function MapEditor(props: { readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'map' }>; readonly context: FieldContext }) {
  const { field, editor, context } = props;
  const [name, setName] = useState('');
  const current = (typeof field.value === 'object' && field.value !== null ? field.value : {}) as Record<string, unknown>;
  const add = () => {
    const key = name.trim();
    if (!key || key in current) return;
    context.onWrite([...field.path, key], editor.initial);
    setName('');
  };
  return (
    <div className="prop-list">
      {editor.entries.map((entry) => {
        const overrides = (typeof entry.value === 'object' && entry.value !== null ? entry.value : {}) as Record<string, unknown>;
        const addable = editor.overrides?.filter((option) => !((option.value as { key: string }).key in overrides));
        return (
          <div key={entry.key} className="prop-list-item" data-testid="property-field" data-key={entry.key}>
            <div className="prop-list-head">
              <strong className="small">{entry.label}</strong>
              <button type="button" className="link danger" onClick={() => context.onWrite(entry.path, undefined)}>删除</button>
            </div>
            <EditorView id={entry.key} field={entry} editor={entry.editor} context={context} />
            {addable && addable.length > 0 && (
              <select aria-label={`给 ${entry.label} 添加覆盖的属性`} value="" onChange={(event) => {
                const chosen = addable.find((option) => (option.value as { key: string }).key === event.target.value);
                if (chosen) { const { key, initial } = chosen.value as { key: string; initial: unknown }; context.onWrite([...entry.path, key], initial); }
              }}>
                <option value="">添加覆盖的属性…</option>
                {addable.map((option) => <option key={(option.value as { key: string }).key} value={(option.value as { key: string }).key}>{option.label}</option>)}
              </select>
            )}
          </div>
        );
      })}
      <div className="prop-actions">
        <input type="text" aria-label={`${field.label}的名称`} placeholder="名称" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" className="small quiet" disabled={!name.trim() || name.trim() in current} onClick={add}>添加</button>
      </div>
    </div>
  );
}

function EditorView(props: { readonly id: string; readonly field: PropertyField; readonly editor: Editor; readonly context: FieldContext; readonly live?: number | undefined; readonly hint?: string | undefined; readonly compact?: boolean }) {
  const { id, field, editor, context, live } = props;
  switch (editor.kind) {
    case 'number': return <NumberInput id={id} field={field} editor={editor} context={context} live={live} hint={props.hint} />;
    case 'text': return editor.suggest === 'font' && context.fonts ? <FontSelect id={id} field={field} families={context.fonts} context={context} /> : <TextInput id={id} field={field} editor={editor} context={context} />;
    case 'color': return <ColorInput id={id} field={field} context={context} />;
    case 'choice': return <Choice id={id} field={field} editor={editor} context={context} />;
    case 'variants': {
      // 宽高：数值加尺寸方式一格（第三轮票据 01）。只在设计页（有绑定能力时）这样画，别处照旧是变体下拉。
      const size = context.binding && editor === field.editor ? sizeModel(field) : undefined;
      if (size) {
        const axis = field.path.at(-1), actual = axis === 'width' ? context.box?.width : axis === 'height' ? context.box?.height : undefined;
        return <SizeCell id={id} label={field.label} model={size} actual={actual} fallback={sizeKindOf(field.fallback)} required={field.required} compact={props.compact}
          onWrite={(value, now) => context.onWrite(field.path, value, { now })} binding={{ host: context.binding!, field }} />;
      }
      // 四边、四角：一格写完，要分开时点开（第三轮票据 02）。
      if (editor.bindable && context.binding && editor.parts && editor === field.editor) return <EdgesCell id={id} field={field} editor={editor} bindable={editor.bindable} parts={editor.parts} host={context.binding} context={context} live={live} />;
      return editor.bindable && context.binding
        ? <ValueCell id={id} field={field} editor={editor} bindable={editor.bindable} host={context.binding} context={context} live={live} />
        : <Variants id={id} field={field} editor={editor} context={context} />;
    }
    case 'group': return <Group field={field} editor={editor} context={context} />;
    case 'list': return <ListEditor field={field} editor={editor} context={context} />;
    case 'map': return <MapEditor field={field} editor={editor} context={context} />;
    case 'json': return <JsonInput id={id} field={field} context={context} />;
  }
}

/** 一组字段：没写的可选项也留在组里，淡色显示缺省值（方案第 7 节，取代"其他 N 项"，M356）。 */
export function FieldRows(props: { readonly fields: readonly PropertyField[]; readonly context: FieldContext }) {
  return <>{props.fields.map((field) => <FieldRow key={field.key} field={field} context={props.context} />)}</>;
}

/** 能拖标签的数值：字面值或没写；绑定着的、写成对象的不能拖。 */
function draggableNumber(field: PropertyField, context: FieldContext): Extract<Editor, { kind: 'number' }> | undefined {
  if (field.needs) return undefined;
  if (field.editor.kind === 'number') return field.editor;
  const literal = field.editor.kind === 'variants' && context.binding ? field.editor.bindable?.literal : undefined;
  return literal?.kind === 'number' && (field.value === undefined || typeof field.value === 'number') ? literal : undefined;
}

/** 拖一下走多少：0 到 1 的属性（不透明度）细一些，整数一格一个，毫米 0.1。 */
const dragStep = (editor: Extract<Editor, { kind: 'number' }>) => (editor.integer ? 1 : editor.max !== undefined && editor.max - (editor.min ?? 0) <= 1 ? 0.01 : 0.1);

function clampNumber(editor: Extract<Editor, { kind: 'number' }>, value: number, step: number): number {
  let result = Math.round(value / step) * step;
  if (editor.min !== undefined) result = Math.max(editor.min, result);
  if (editor.max !== undefined) result = Math.min(editor.max, result);
  if (editor.exclusiveMin !== undefined && result <= editor.exclusiveMin) result = editor.exclusiveMin + step;
  return Number(result.toFixed(4));
}

/** 按住标签左右拖：拖的时候只改显示，松手才写回，所以一次拖动只出一张图、撤销一步。按住 Shift 走得快十倍。 */
function useLabelDrag(field: PropertyField, context: FieldContext) {
  const [live, setLive] = useState<number>();
  const editor = draggableNumber(field, context);
  const start = (event: ReactPointerEvent) => {
    if (!editor || event.button !== 0) return;
    const from = typeof field.value === 'number' ? field.value : typeof field.fallback === 'number' ? field.fallback : editor.min ?? 0;
    const x = event.clientX, step = dragStep(editor);
    let moved = false, value = from;
    const move = (next: PointerEvent) => {
      const distance = next.clientX - x;
      if (!moved && Math.abs(distance) < 3) return;
      moved = true;
      value = clampNumber(editor, from + distance * step * (next.shiftKey ? 10 : 1), step);
      setLive(value);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setLive(undefined);
      if (moved && value !== from) context.onWrite(field.path, value, { now: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { live, draggable: Boolean(editor), start };
}

/**
 * 一项属性：名称与它的编辑器。放不进一行的（对象、列表）占满整行。half：两项并排一行时的半格，名称在上面（第三轮票据 03）。
 * bare：名称不占地方（只给读屏），编辑器占满一行，状态覆盖的圆点挪到编辑器前面（第三轮票据 04 的字体一行）。
 * caption：名称换成短的（宽高的 W、H），排在编辑器左边；全名留在提示与读屏的名称里（第三轮票据 05）。
 */
export function FieldRow(props: { readonly field: PropertyField; readonly context: FieldContext; readonly half?: boolean; readonly bare?: boolean; readonly caption?: string }) {
  const { field, context } = props, id = useId();
  const wide = field.editor.kind === 'group' || field.editor.kind === 'list' || field.editor.kind === 'map';
  const { live, draggable, start } = useLabelDrag(field, context);
  const overridden = context.binding?.overriddenBy(field) ?? [];
  const bare = Boolean(props.bare) && !wide;
  const labelClass = `prop-label${field.required ? ' required' : ''}${draggable ? ' draggable' : ''}${bare ? ' visually-hidden' : ''}`;
  const dot = overridden.length > 0 && <i className="prop-state-dot" data-testid="state-dot" title={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} aria-label={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} />;
  const resettable = context.stateValue !== undefined && context.resetOverride && overridden.includes(context.stateValue);
  const removable = Boolean(context.onRemove) && Boolean(context.removable?.has(field.key));
  const caption = wide ? undefined : props.caption;
  return (
    <div className={`prop${wide ? ' wide' : ''}${props.half ? ' half' : ''}${bare ? ' bare' : ''}${removable ? ' removable' : ''}${caption ? ' captioned' : ''}`} data-testid="property-field" data-key={field.key} title={field.noBinding ?? field.description}>
      {wide ? <span className={labelClass}>{dot}{field.label}</span>
        : <label className={labelClass} htmlFor={id} onPointerDown={start} {...(caption ? { title: field.label } : {})}>{!bare && dot}{caption ?? field.label}</label>}
      <div className="prop-control">
        {bare && dot}
        {field.blocked ? <span className="small faint" data-testid="field-blocked">{field.blocked}</span>
          : field.needs ? <span className="small muted">先写{field.needs.join('、')}</span>
          : <EditorView id={id} field={field} editor={field.editor} context={context} live={live} compact={Boolean(caption)} />}
      </div>
      {removable && (
        <button type="button" className="value-action prop-drop" data-testid="property-remove" aria-label={`去掉${field.label}`} title={`去掉${field.label}：删掉这一项，要用时再从"+ 属性"加`} onClick={() => context.onRemove!(field)}>
          <Icon d={CROSS} />
        </button>
      )}
      {field.noBinding && <p className="prop-nobind small faint" data-testid="no-binding">{field.noBinding}</p>}
      {field.exclusive && <p className="prop-nobind small faint" data-testid="field-exclusive">和{field.exclusive.join('、')}二选一，写了这一项会去掉它。</p>}
      {resettable && <button type="button" className="link small prop-reset" data-testid="state-reset" onClick={() => context.resetOverride!(field)}>重置为自身属性{field.path[0] === 'place' && field.path.length > 1 ? '（整个位置与尺寸）' : ''}</button>}
    </div>
  );
}
