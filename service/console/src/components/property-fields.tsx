/**
 * 属性面板的字段（P1 票据 08）：把生成规则给的可编辑项画出来，改动交给 onWrite；只能填数，没有拖拽（M205）。
 * 输入框里的草稿留在这里：不合法的不写回，标红并说明；撤销、换元素时跟着文档里的值走。
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { Editor, FieldPath, PropertyField } from '../template/properties.js';

export interface FieldContext {
  /** now：选项与开关立刻写回，打字才等停顿。 */
  onWrite(path: FieldPath, value: unknown, options?: { readonly now?: boolean }): void;
  /** 建议的选项：<datalist> 的 ID，由页面按变量、字段与资源生成。 */
  readonly lists: Readonly<Record<'variable' | 'field' | 'font' | 'image', string>>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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

function NumberInput(props: { readonly id: string; readonly field: PropertyField; readonly editor: Extract<Editor, { kind: 'number' }>; readonly context: FieldContext }) {
  const { field, editor } = props;
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
      <input id={props.id} type="text" inputMode="decimal" className="prop-number" value={draft} aria-invalid={error ? true : undefined} placeholder={field.required ? '' : '缺省'}
        onChange={(event) => change(event.target.value)} />
      {error && <span className="prop-error" role="alert">{error}</span>}
    </>
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
    setError(undefined);
    written.current = text;
    context.onWrite(field.path, text);
  };
  return (
    <>
      <input id={props.id} type="text" value={draft} aria-invalid={error ? true : undefined} {...(editor.suggest ? { list: context.lists[editor.suggest] } : {})}
        placeholder={field.required ? '' : '缺省'} onChange={(event) => change(event.target.value)} />
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
      <input type="color" aria-label={`${field.label}（取色）`} value={/^#[0-9a-fA-F]{6}/.test(draft) ? draft.slice(0, 7).toLowerCase() : '#000000'} onChange={(event) => write(event.target.value.toUpperCase())} />
      <input id={props.id} type="text" value={draft} aria-invalid={error ? true : undefined} placeholder={field.required ? '#RRGGBB' : '缺省'} onChange={(event) => write(event.target.value)} />
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
  return (
    <select id={props.id} value={selected} onChange={(event) => { const index = Number(event.target.value); context.onWrite(field.path, index < 0 ? undefined : editor.options[index]!.value, { now: true }); }}>
      {(!field.required || selected < 0) && <option value={-1}>缺省</option>}
      {editor.options.map((option, index) => <option key={index} value={index}>{option.label}</option>)}
    </select>
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
  return (
    <div className={tuple ? 'prop-tuple' : 'prop-group'}>
      {tuple
        ? editor.fields.map((inner) => <span key={inner.key} data-testid="property-field" data-key={inner.key}><EditorView id={inner.key} field={inner} editor={inner.editor} context={context} /></span>)
        : <FieldRows fields={editor.fields} context={context} />}
      {!field.required && !editor.absent && hasRequired(editor.initial) && (
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

function EditorView(props: { readonly id: string; readonly field: PropertyField; readonly editor: Editor; readonly context: FieldContext }) {
  const { id, field, editor, context } = props;
  switch (editor.kind) {
    case 'number': return <NumberInput id={id} field={field} editor={editor} context={context} />;
    case 'text': return <TextInput id={id} field={field} editor={editor} context={context} />;
    case 'color': return <ColorInput id={id} field={field} context={context} />;
    case 'choice': return <Choice id={id} field={field} editor={editor} context={context} />;
    case 'variants': return <Variants id={id} field={field} editor={editor} context={context} />;
    case 'group': return <Group field={field} editor={editor} context={context} />;
    case 'list': return <ListEditor field={field} editor={editor} context={context} />;
    case 'map': return <MapEditor field={field} editor={editor} context={context} />;
    case 'json': return <JsonInput id={id} field={field} context={context} />;
  }
}

/**
 * 一组字段：写了的与必填的直接显示，没写的可选项不止一个时收进"其他 N 项"。按打开时的样子分一次，
 * 之后不再挪动，否则刚填的那一项会跳走、丢掉焦点。
 */
export function FieldRows(props: { readonly fields: readonly PropertyField[]; readonly context: FieldContext }) {
  const { fields, context } = props;
  const initial = useRef<ReadonlySet<string>>(new Set(fields.filter((field) => field.required || field.value !== undefined).map((field) => field.key)));
  const shown = fields.filter((field) => initial.current.has(field.key)), rest = fields.filter((field) => !initial.current.has(field.key));
  if (rest.length < 2) return <>{fields.map((field) => <FieldRow key={field.key} field={field} context={context} />)}</>;
  return (
    <>
      {shown.map((field) => <FieldRow key={field.key} field={field} context={context} />)}
      <details className="prop-more">
        <summary>其他 {rest.length} 项</summary>
        <div className="prop-more-body">{rest.map((field) => <FieldRow key={field.key} field={field} context={context} />)}</div>
      </details>
    </>
  );
}

/** 一项属性：名称与它的编辑器。放不进一行的（对象、列表）占满整行。 */
export function FieldRow(props: { readonly field: PropertyField; readonly context: FieldContext }) {
  const { field, context } = props, id = useId();
  const wide = field.editor.kind === 'group' || field.editor.kind === 'list' || field.editor.kind === 'map';
  return (
    <div className={`prop${wide ? ' wide' : ''}`} data-testid="property-field" data-key={field.key} title={field.description}>
      {wide ? <span className={`prop-label${field.required ? ' required' : ''}`}>{field.label}</span> : <label className={`prop-label${field.required ? ' required' : ''}`} htmlFor={id}>{field.label}</label>}
      <div className="prop-control">
        {field.needs ? <span className="small muted">先写{field.needs.join('、')}</span> : <EditorView id={id} field={field} editor={field.editor} context={context} />}
      </div>
    </div>
  );
}
