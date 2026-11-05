/**
 * 内容编辑器（模板设计页票据 10，方案第 7 节）：文字和插槽排成一行，打字是文字，`/` 插入字段，点插槽改展示格式；片段样式点开改。
 * 不用 contentEditable：每段文字是一个输入框，插槽是按钮，光标跨段靠方向键。这样中文输入法、撤销与写回都走平常的路。
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FieldRow, type FieldContext } from '../components/property-fields.js';
import { usePopoverDismiss } from '../components/binding-popover.js';
import { Icon, PLUS } from '../components/icon.js';
import { TYPE_GLYPHS, ValueText } from '../components/value-text.js';
import type { ScopeVariable } from '../template/binding.js';
import { canDisplay, FORMAT_PRESETS, formatProblem, fragmentsOf, insertSlot, insertText, isSlot, isStyled, removeFragment, setText, STYLE_KEYS, type Caret, type Fragment } from '../template/content.js';
import { fieldByKey, type PropertyField, type PropertyPanel } from '../template/properties.js';

const GROUPS: readonly { readonly kind: ScopeVariable['kind']; readonly title: string }[] = [{ kind: 'field', title: '字段' }, { kind: 'parameter', title: '参数' }, { kind: 'derived', title: '派生变量' }];

/** 输入框按内容变宽：汉字算两格。 */
const widthOf = (text: string) => `calc(${Math.max(1, [...text].reduce((total, char) => total + (char.charCodeAt(0) > 255 ? 2 : 1), 0))}ch + 4px)`;

/** 一段文字。输入法组字时先不写回，否则拼音会进模板、进预览。 */
function TextPiece(props: {
  readonly text: string; readonly label: string; readonly styled?: boolean; readonly inputRef: (element: HTMLInputElement | null) => void;
  readonly onChange: (text: string) => void; readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void; readonly onFocus: () => void;
}) {
  const [draft, setDraft] = useState(props.text);
  const composing = useRef(false);
  useEffect(() => { if (!composing.current) setDraft(props.text); }, [props.text]);
  return (
    <input ref={props.inputRef} type="text" className={`token-text${props.styled ? ' styled' : ''}`} aria-label={props.label} value={draft} style={{ width: widthOf(draft) }} data-testid="content-text"
      onChange={(event) => { setDraft(event.target.value); if (!composing.current) props.onChange(event.target.value); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={(event) => { composing.current = false; props.onChange(event.currentTarget.value); }}
      onKeyDown={props.onKeyDown} onFocus={props.onFocus} />
  );
}

/** 插入字段：只列能显示成文字的变量，打字筛选，回车选第一个。 */
function SlotPicker(props: { readonly variables: readonly ScopeVariable[]; readonly onPick: (name: string) => void; readonly onClose: () => void; readonly onEscape: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  usePopoverDismiss(box, props.onClose, props.onEscape);
  const text = query.trim().toLowerCase();
  const rows = props.variables.filter((item) => canDisplay(item.type) && (text === '' || item.name.toLowerCase().includes(text) || item.label.toLowerCase().includes(text)));
  return (
    <div ref={box} className="value-popover" role="dialog" aria-label="插入字段" data-testid="slot-picker">
      <input type="text" autoFocus aria-label="筛选字段" placeholder="筛选字段、参数、派生变量" value={query} onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && rows[0]) { event.preventDefault(); props.onPick(rows[0].name); }
          // 没打字就退格：等于撤回这个 /。
          if (event.key === 'Backspace' && query === '') props.onClose();
        }} />
      {rows.length === 0 && <p className="small muted">没有能显示成文字的变量。</p>}
      {GROUPS.map(({ kind, title }) => {
        const group = rows.filter((item) => item.kind === kind);
        return group.length > 0 && (
          <section key={kind} aria-label={title} className="value-popover-group">
            <h4>{title}</h4>
            {group.map((item) => (
              <button key={item.name} type="button" className="value-option" data-testid="slot-option" data-name={item.name} title={item.name} onClick={() => props.onPick(item.name)}>
                <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[item.type] ?? '·'}</span>
                <span className="variable-name">{item.label}</span>
                <ValueText value={item.value} type={item.type} />
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

/** 一段的详情：插槽改字段与展示格式，文字和插槽都能单独设样式。 */
function PiecePopover(props: {
  readonly index: number; readonly fragment: Fragment; readonly panel: PropertyPanel; readonly variables: readonly ScopeVariable[]; readonly vertical: boolean; readonly context: FieldContext;
  readonly onRemove: () => void; readonly onClose: () => void;
}) {
  const { index, fragment, panel, variables, context } = props;
  const box = useRef<HTMLDivElement>(null);
  usePopoverDismiss(box, props.onClose);
  const slot = isSlot(fragment) ? String(fragment['slot']) : undefined;
  const variable = slot === undefined ? undefined : variables.find((item) => item.name === slot);
  const written = typeof fragment['format'] === 'string' ? fragment['format'] : '';
  const [format, setFormat] = useState(written);
  // 撤销、换字段之后跟着文档走。
  useEffect(() => { setFormat(written); }, [written]);
  const problem = format === '' ? undefined : formatProblem(format, variable?.type);
  const writeFormat = (next: string) => {
    setFormat(next);
    if (next === '') context.onWrite(['content', index, 'format'], undefined);
    else if (!formatProblem(next, variable?.type)) context.onWrite(['content', index, 'format'], next);
  };
  const presets = variable ? FORMAT_PRESETS[variable.type] ?? [] : [];
  const styleFields = STYLE_KEYS.filter((key) => !(key === 'slant' && props.vertical)).flatMap((key) => { const field = fieldByKey(panel, `content.${index}.${key}`); return field ? [field] : []; });
  return (
    <div ref={box} className="value-popover" role="dialog" aria-label={slot === undefined ? '这段文字的样式' : `插槽 ${variable?.label ?? slot}`} data-testid="piece-popover">
      {slot !== undefined && (
        <section className="value-popover-group" aria-label="插槽">
          <label className="small value-popover-field">字段
            <select aria-label="插槽的字段" value={slot} onChange={(event) => context.onWrite(['content', index, 'slot'], event.target.value, { now: true })}>
              {!variable && <option value={slot}>{slot}（这个作用域里没有）</option>}
              {variables.filter((item) => canDisplay(item.type)).map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
            </select>
          </label>
          {variable?.type === 'text' && !written
            ? <p className="small muted" data-testid="format-none">文本类型不带展示格式。</p>
            : (
              <label className="small value-popover-field">展示格式
                <input type="text" aria-label="展示格式" placeholder="按类型的缺省写法" value={format} aria-invalid={problem ? true : undefined} onChange={(event) => writeFormat(event.target.value)} />
              </label>
            )}
          {problem && <span className="prop-error" role="alert" data-testid="format-problem">{problem}</span>}
          {presets.length > 0 && (
            <div className="prop-actions" data-testid="format-presets">
              {presets.map((preset) => <button key={preset} type="button" className="small quiet mono" aria-pressed={format === preset} onClick={() => writeFormat(preset)}>{preset}</button>)}
            </div>
          )}
        </section>
      )}
      <section className="value-popover-group" aria-label="片段样式">
        <h4>片段样式<span className="small faint"> 没写的沿用文字元素的设置</span></h4>
        {styleFields.map((field) => <FieldRow key={field.key} field={field} context={context} />)}
      </section>
      {slot !== undefined && <div className="value-popover-foot"><button type="button" className="link danger" onClick={props.onRemove}>删除这个插槽</button></div>}
    </div>
  );
}

export function ContentEditor(props: { readonly field: PropertyField; readonly panel: PropertyPanel; readonly context: FieldContext; readonly vertical: boolean; readonly autoFocus?: boolean }) {
  const { field, panel, context, vertical } = props;
  const fragments = fragmentsOf(field.value);
  const variables = context.binding?.variables ?? [];
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const pending = useRef<Caret | undefined>(undefined);
  const [picker, setPicker] = useState<{ readonly at: Caret; readonly typed: boolean }>();
  const [active, setActive] = useState<Caret>({ gap: fragments.length });
  const [detail, setDetail] = useState<number>();

  const place = (caret: Caret) => {
    const element = inputs.current.get('gap' in caret ? `gap${caret.gap}` : `text${caret.index}`);
    if (!element) return;
    element.focus();
    if (!('gap' in caret)) element.setSelectionRange(caret.offset, caret.offset);
  };
  // 写回之后段落重排了，光标在这一轮渲染完才知道落到哪个输入框。
  useLayoutEffect(() => { if (pending.current) { place(pending.current); pending.current = undefined; } });
  useEffect(() => {
    if (!props.autoFocus) return;
    const last = fragments.length - 1, end = fragments[last];
    place(typeof end?.['text'] === 'string' ? { index: last, offset: String(end['text']).length } : { gap: fragments.length });
  }, []);

  const write = (next: readonly Fragment[], caret?: Caret) => {
    pending.current = caret;
    context.onWrite(field.path, next);
  };
  const pick = (at: Caret, slot: string) => {
    const result = insertSlot(fragments, at, slot);
    setPicker(undefined);
    pending.current = result.caret;
    // 插入是一个完整的动作，不等打字的停顿。
    context.onWrite(field.path, result.fragments, { now: true });
  };
  /** 字面上的 /：选字段时按 Esc。 */
  const typeSlash = (at: Caret) => {
    setPicker(undefined);
    if ('gap' in at) { write(insertText(fragments, at.gap, '/'), { index: at.gap, offset: 1 }); return; }
    const text = String(fragments[at.index]?.['text'] ?? '');
    write(setText(fragments, at.index, `${text.slice(0, at.offset)}/${text.slice(at.offset)}`), { index: at.index, offset: at.offset + 1 });
  };
  const neighbour = (position: number, step: -1 | 1): Caret | undefined => {
    // 相邻的是文字就进文字，是插槽就跳到它另一边的输入框。
    const next = step < 0 ? position - 1 : position + 1, there = fragments[next];
    if (there === undefined) return undefined;
    if (typeof there['text'] === 'string') return { index: next, offset: step < 0 ? String(there['text']).length : 0 };
    const beyond = fragments[next + step];
    if (typeof beyond?.['text'] === 'string') return { index: next + step, offset: step < 0 ? String(beyond['text']).length : 0 };
    return { gap: step < 0 ? next : next + 1 };
  };
  const keys = (event: KeyboardEvent<HTMLInputElement>, at: Caret, position: number) => {
    const input = event.currentTarget, start = input.selectionStart ?? 0, end = input.selectionEnd ?? 0;
    const caret: Caret = 'gap' in at ? at : { index: at.index, offset: start };
    if (event.key === '/' && !event.nativeEvent.isComposing) { event.preventDefault(); setPicker({ at: caret, typed: true }); return; }
    if (start !== end) return;
    if (event.key === 'Backspace' && start === 0) {
      // 空位在 position 这个位置前；文字段的前一段是 position - 1。
      const before = fragments[position - 1];
      if (isSlot(before)) { event.preventDefault(); const result = removeFragment(fragments, position - 1); write(result.fragments, result.caret); }
      return;
    }
    if (event.key === 'ArrowLeft' && start === 0) { const target = neighbour('gap' in at ? at.gap : position, -1) ?? undefined; if (target) { event.preventDefault(); place(target); } return; }
    if (event.key === 'ArrowRight' && start === input.value.length) { const target = neighbour('gap' in at ? at.gap - 1 : position, 1); if (target) { event.preventDefault(); place(target); } }
  };
  const slotLabel = (fragment: Fragment) => { const name = String(fragment['slot']), found = variables.find((item) => item.name === name); return { name, label: found?.label ?? name, variable: found }; };
  const gap = (position: number) => (
    <input key={`gap${position}`} ref={(element) => { if (element) inputs.current.set(`gap${position}`, element); else inputs.current.delete(`gap${position}`); }} type="text" className="token-text gap" aria-label="在这里打字" value="" style={{ width: widthOf('') }} data-testid="content-gap"
      onChange={(event) => { if (event.target.value) write(insertText(fragments, position, event.target.value), { index: position, offset: event.target.value.length }); }}
      onKeyDown={(event) => keys(event, { gap: position }, position)} onFocus={() => setActive({ gap: position })} />
  );
  const items = fragments.flatMap((fragment, index) => {
    const before = isSlot(fragment) && (index === 0 || isSlot(fragments[index - 1])) ? [gap(index)] : [];
    if (isSlot(fragment)) {
      const { name, label, variable } = slotLabel(fragment);
      return [...before, (
        <button key={`slot${index}`} type="button" className={`token-slot${isStyled(fragment) ? ' styled' : ''}`} data-testid="content-slot" data-slot={name} title={name} aria-expanded={detail === index} onClick={() => setDetail(detail === index ? undefined : index)}>
          <span className="value-bound-name">{label}</span>
          {typeof fragment['format'] === 'string' && <span className="token-format mono">{fragment['format']}</span>}
          {variable && <ValueText value={variable.value} type={variable.type} />}
        </button>
      )];
    }
    const text = String(fragment['text'] ?? '');
    return [...before, (
      <TextPiece key={`text${index}`} text={text} label={`第 ${index + 1} 段文字`} styled={isStyled(fragment)} inputRef={(element) => { if (element) inputs.current.set(`text${index}`, element); else inputs.current.delete(`text${index}`); }}
        onChange={(next) => write(setText(fragments, index, next), next === '' ? undefined : { index, offset: inputs.current.get(`text${index}`)?.selectionStart ?? next.length })}
        onKeyDown={(event) => keys(event, { index, offset: 0 }, index)}
        onFocus={() => setActive({ index, offset: 0 })} />
    )];
  });
  const tail = fragments.length === 0 || isSlot(fragments.at(-1)) ? gap(fragments.length) : null;
  const activeText = !('gap' in active) && typeof fragments[active.index]?.['text'] === 'string' ? active.index : undefined;
  const insertAt: Caret = 'gap' in active && active.gap <= fragments.length ? active : activeText !== undefined ? { index: activeText, offset: inputs.current.get(`text${activeText}`)?.selectionStart ?? String(fragments[activeText]!['text']).length } : { gap: fragments.length };
  const detailFragment = detail === undefined ? undefined : fragments[detail];
  return (
    <div className="content-editor" data-testid="content-editor">
      <div className="token-box" data-testid="token-box" onClick={(event) => { if (event.target === event.currentTarget) place(fragments.length ? { gap: fragments.length } : { gap: 0 }); }}>
        {items}
        {tail}
      </div>
      <div className="content-actions">
        {/* 中文输入法里按 / 打出来的是顿号，所以另给一个按钮。 */}
        <button type="button" className="small quiet" data-testid="insert-slot" onClick={() => setPicker({ at: insertAt, typed: false })}><Icon d={PLUS} />插入字段</button>
        {activeText !== undefined && <button type="button" className="small quiet" data-testid="text-style" aria-expanded={detail === activeText} onClick={() => setDetail(detail === activeText ? undefined : activeText)}>这段文字的样式</button>}
      </div>
      <p className="small faint content-hint">一个文字元素只排一行或一列，不会自动换行。打字是文字，输入 / 插入字段，点插槽改展示格式。</p>
      {picker && <SlotPicker variables={variables} onPick={(slot) => pick(picker.at, slot)} onClose={() => { setPicker(undefined); }} onEscape={() => (picker.typed ? typeSlash(picker.at) : setPicker(undefined))} />}
      {detail !== undefined && detailFragment && (
        <PiecePopover key={detail} index={detail} fragment={detailFragment} panel={panel} variables={variables} vertical={vertical} context={context} onClose={() => setDetail(undefined)}
          onRemove={() => { const result = removeFragment(fragments, detail); setDetail(undefined); pending.current = result.caret; context.onWrite(field.path, result.fragments, { now: true }); }} />
      )}
    </div>
  );
}
