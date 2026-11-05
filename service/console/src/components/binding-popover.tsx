/**
 * 绑定弹层（模板设计页票据 09）：只列类型相符的变量，分字段、参数、派生三组，带当前值；底部是提取为参数。
 * 新建派生变量的入口在派生变量的编辑器做完之后才有（票据 16）。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { bindingCandidates, parameterNameProblem, type ScopeVariable } from '../template/binding.js';
import type { BindingType } from '../template/properties.js';
import { TYPE_GLYPHS, ValueText } from './value-text.js';

const TYPE_NAMES: Readonly<Record<BindingType, string>> = { number: '数值', color: '颜色', boolean: '布尔', text: '文本', image: '图片' };
const GROUPS: readonly { readonly kind: ScopeVariable['kind']; readonly title: string }[] = [{ kind: 'field', title: '字段' }, { kind: 'parameter', title: '参数' }, { kind: 'derived', title: '派生变量' }];

export interface ExtractOffer {
  /** 要存成缺省值的当前值；没有单个的值时（分别设置、还没选图）提取关掉。 */
  readonly value: unknown;
  readonly name: string;
  readonly displayName: string;
  readonly taken: ReadonlySet<string>;
}

export function BindingPopover(props: {
  readonly type: BindingType; readonly label: string; readonly current?: string; readonly variables: readonly ScopeVariable[]; readonly extract: ExtractOffer;
  readonly onPick: (name: string) => void; readonly onExtract: (name: string, displayName: string) => void; readonly onOpen?: (variable: ScopeVariable) => void; readonly onClose: () => void;
}) {
  const { type, extract, current, onClose } = props;
  const box = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(extract.name);
  const [displayName, setDisplayName] = useState(extract.displayName);
  const candidates = bindingCandidates(props.variables, type);
  // 点外面关掉；弹层可能超出面板底边，打开时滚进视野。
  // Esc 在捕获阶段接住：打开时焦点常在触发按钮上，不接住就成了舞台的"选上一层"。
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest' });
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    document.addEventListener('pointerdown', away);
    window.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('keydown', escape, true); };
  }, [onClose]);
  const problem = parameterNameProblem(name.trim(), extract.taken);
  const canExtract = extract.value !== undefined;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!problem && displayName.trim()) props.onExtract(name.trim(), displayName.trim());
  };
  const currentVariable = current === undefined ? undefined : props.variables.find((item) => item.name === current);
  return (
    <div ref={box} className="value-popover" role="dialog" aria-label={`绑定${props.label}`} data-testid="binding-popover">
      <p className="small muted">只列{TYPE_NAMES[type]}类型的变量：类型不符的绑定不过检查。</p>
      {candidates.length === 0 && <p className="small muted" data-testid="binding-empty">这个模板的作用域里还没有{TYPE_NAMES[type]}变量。</p>}
      {GROUPS.map(({ kind, title }) => {
        const rows = candidates.filter((item) => item.kind === kind);
        return rows.length > 0 && (
          <section key={kind} aria-label={title} className="value-popover-group">
            <h4>{title}</h4>
            {rows.map((item) => (
              <button key={item.name} type="button" className={`value-option${item.name === current ? ' current' : ''}`} data-testid="binding-option" data-name={item.name} title={item.name} aria-pressed={item.name === current} onClick={() => props.onPick(item.name)}>
                <span className="variable-glyph mono" aria-hidden="true">{TYPE_GLYPHS[item.type] ?? '·'}</span>
                <span className="variable-name">{item.label}</span>
                <ValueText value={item.value} type={item.type} />
              </button>
            ))}
          </section>
        );
      })}
      <div className="value-popover-foot">
        {currentVariable && props.onOpen && <button type="button" className="link" data-testid="binding-open" onClick={() => props.onOpen!(currentVariable)}>查看变量 {currentVariable.label}</button>}
        {!naming && (
          <button type="button" className="link" disabled={!canExtract} title={canExtract ? undefined : '这一格现在没有单个的值可存'} onClick={() => setNaming(true)}>提取为参数</button>
        )}
        {naming && (
          <form className="value-extract" aria-label="提取为参数" onSubmit={submit}>
            <p className="small muted">把当前值 <span className="mono" data-testid="extract-value">{String(extract.value)}</span> 存成内部参数的缺省值，并绑定它。</p>
            <label className="small">名称<input type="text" autoFocus value={name} aria-invalid={problem ? true : undefined} onChange={(event) => setName(event.target.value)} /></label>
            {problem && <span className="prop-error" role="alert">{problem}</span>}
            <label className="small">显示名称<input type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <div className="prop-actions">
              <button type="submit" className="small" disabled={Boolean(problem) || !displayName.trim()}>提取并绑定</button>
              <button type="button" className="small quiet" onClick={() => setNaming(false)}>取消</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
