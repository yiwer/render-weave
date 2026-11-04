/**
 * 数据定义页面共用的字段部件（M360）：一行摘要、字段树、谁在用、改名与删字段的影响、这种类型能写的约束。
 * 数据定义的编辑页与静态数据定义的详情页都用；只显示与改值，不调接口。
 */
import { useRef, useState, type ReactNode } from 'react';
import { constraintText, isRequired, typeText, withConstraint } from '../form/definition.js';
import { href } from '../hooks.js';
import type { DefinitionDocument, DefinitionField, DefinitionItems, FieldType, Problem, SchemaRef, StaticSchemaSummary, TemplateBinding } from '../types.js';

export type UseMap = ReadonlyMap<string, readonly TemplateBinding[]>;
export const fieldLabel = (field: DefinitionField, index: number) => field.displayName || field.name || `未命名字段 ${index + 1}`;

/** 谁在用：这个字段被哪些模板读到，可以点开模板。 */
export function UsedBy(props: { readonly templates: readonly TemplateBinding[] | undefined }) {
  const templates = props.templates ?? [];
  if (!templates.length) return <>还没有模板读这个字段</>;
  return <>{templates.map((template, index) => <span key={template.name}>{index > 0 && '、'}<a href={href(['templates', template.name])}>{template.name}</a><span className="muted">（绑定 v{template.base.version}）</span></span>)}</>;
}

/** 字段的一行摘要：类型点、名称、类型、约束。表单、树与只读列表都是它。 */
export function FieldSummary(props: { readonly field: DefinitionField; readonly index: number; readonly tag?: 'added' | 'changed' | undefined; readonly status?: ReactNode }) {
  const { field, index, tag, status } = props;
  return (
    <>
      <span className={`type-dot type-${field.type}`} aria-hidden="true" />
      <span className="field-identity">
        <strong>{fieldLabel(field, index)}</strong>
        {tag === 'added' && <span className="chip ok field-tag">新增</span>}
        {tag === 'changed' && <span className="chip warn field-tag">已修改</span>}
        <code>{field.name || '还没写字段名称'}</code>
      </span>
      <span className="type-chip" data-testid="field-type">{typeText(field)}</span>
      <span className="field-constraints" data-testid="field-constraints">{constraintText(field) || <span className="faint">没有约束</span>}</span>
      {status}
    </>
  );
}

/** 根对象：字段树与编辑页的表单都从它长出去。 */
export function TreeRoot(props: { readonly name: string; readonly document: DefinitionDocument }) {
  return (
    <header className="tree-root">
      <span><small>根对象</small><strong>{props.document.displayName || props.name}</strong><code>{props.name}</code></span>
      <em>{props.document.fields.length} 个字段</em>
    </header>
  );
}

/** 字段树：根是数据定义，下面一层是字段；列表与引用再带一行说明元素是什么。选中一个字段，右边看它的详情。 */
export function DefinitionTree(props: {
  readonly name: string;
  readonly document: DefinitionDocument;
  readonly selected: number | undefined;
  readonly onSelect: (index: number) => void;
  /** 搜索时只显示这些字段；不给就是全部。 */
  readonly visible?: ReadonlySet<number> | undefined;
  readonly tagOf?: (field: DefinitionField, index: number) => 'added' | 'changed' | undefined;
  readonly problemsOf?: (index: number) => readonly Problem[] | undefined;
}) {
  const { document, selected } = props, fields = document.fields;
  return (
    <section className="definition-tree" data-testid="definition-tree" aria-label={`${document.displayName || props.name} 的字段树`}>
      <TreeRoot name={props.name} document={document} />
      {fields.length === 0 || props.visible?.size === 0 ? <p className="muted tree-empty">{fields.length ? '没有匹配的字段。' : '还没有字段。'}</p> : (
        <ol className="tree-branches">
          {fields.map((field, index) => {
            if (props.visible && !props.visible.has(index)) return null;
            const problems = props.problemsOf?.(index);
            return (
              <li key={index} data-testid="tree-field" data-field={field.name}>
                <button type="button" className={`tree-field${selected === index ? ' selected' : ''}`} aria-pressed={selected === index} aria-label={`查看字段 ${fieldLabel(field, index)}`} onClick={() => props.onSelect(index)}>
                  <span className="tree-number">{String(index + 1).padStart(2, '0')}</span>
                  <FieldSummary field={field} index={index} tag={props.tagOf?.(field, index)} />
                  <span className={isRequired(field) ? 'chip ok' : 'chip'}>{isRequired(field) ? '必填' : '可选'}</span>
                  {problems && problems.length > 0 && <span className="chip bad">{problems.length} 个问题</span>}
                </button>
                {field.type === 'list' && field.items && <p className="tree-detail"><small>每一项</small>{typeText(field.items)}{constraintText(field.items) ? `，${constraintText(field.items)}` : ''}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** 字段的只读详情：操作员，或已发布的版本。 */
export function FieldFacts(props: { readonly field: DefinitionField; readonly uses: UseMap }) {
  const { field } = props;
  return (
    <dl className="facts" data-testid="field-facts">
      <dt>字段名称</dt><dd className="mono">{field.name}</dd>
      <dt>显示名称</dt><dd>{field.displayName || <span className="faint">没有</span>}</dd>
      <dt>类型</dt><dd>{typeText(field)}</dd>
      <dt>约束</dt><dd>{constraintText(field) || '没有'}</dd>
      <dt>必填</dt><dd>{isRequired(field) ? '是' : '否'}</dd>
      {field.description && <><dt>说明</dt><dd>{field.description}</dd></>}
      <dt>谁在用</dt><dd data-testid="field-used-by"><UsedBy templates={props.uses.get(field.name)} /></dd>
    </dl>
  );
}

/** 改名或删字段的影响：字段名称是身份（ADR-0005）。 */
export function BindingImpact(props: { readonly kind: 'rename' | 'remove'; readonly field: string; readonly published: boolean; readonly templates: readonly TemplateBinding[] | undefined; readonly children?: ReactNode }) {
  const used = Boolean(props.templates?.length);
  return (
    <div className="impact-note" role="note" data-testid={props.kind === 'rename' ? 'rename-impact' : 'remove-impact'}>
      <strong>{props.kind === 'rename' ? `改字段名称等于删掉 ${props.field}、再加一个新字段。` : `删掉字段 ${props.field}。`}</strong>
      <span>{used ? <>会影响这些模板的绑定：<UsedBy templates={props.templates} />。它们照旧绑定各自的版本，升到新版时要改绑定。</> : '现在没有模板读这个字段。'}</span>
      {props.published ? <span>按这个名称填写的数据集，按新版校验时这个键不再有对应。</span> : <span>这个字段还没发布过，没有数据集用它。</span>}
      {props.children}
    </div>
  );
}

/** 这种类型有没有可加的约束（docs/dsl/data-definition.md）：日期、时刻、时间、布尔没有，引用选的是版本。 */
export const hasConstraints = (type: FieldType) => ['text', 'number', 'image', 'list'].includes(type);

/**
 * 可选约束的开关（M363，照旧 RenderWeave 的约束卡片）：勾上是展开等着填，写了值才进文档；取消勾选就去掉这条。
 * 框一直能输入，直接打字也算勾上，不用多点一下。
 */
function useOptional(hasValue: boolean, clear: () => void) {
  const [open, setOpen] = useState(false);
  const control = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  return {
    on: open || hasValue, control,
    toggle: (checked: boolean) => {
      setOpen(checked);
      if (checked) control.current?.focus();
      else clear();
    },
  };
}

function ConstraintCard(props: { readonly id: string; readonly label: string; readonly on: boolean; readonly wide?: boolean; readonly onToggle: (checked: boolean) => void; readonly children: ReactNode }) {
  return (
    <div className={`constraint-card${props.on ? ' on' : ''}${props.wide ? ' wide' : ''}`}>
      <div className="constraint-card-head">
        <input type="checkbox" aria-label={`启用${props.label}`} checked={props.on} onChange={(event) => props.onToggle(event.target.checked)} />
        <label htmlFor={props.id}>{props.label}</label>
      </div>
      {props.children}
    </div>
  );
}

/** 这种类型能写的约束：字段与列表元素用同一份。label 写在标签前面，元素的约束读作"元素最长（字）"。 */
export function TypeFields<T extends DefinitionItems>(props: { readonly owner: T; readonly prefix: string; readonly label?: string; readonly onChange: (owner: T) => void; readonly refs: readonly StaticSchemaSummary[] }) {
  const { owner, prefix, onChange, refs } = props, tag = props.label ?? '', c = owner.constraints ?? {};
  const set = (key: string, value: unknown) => onChange(withConstraint(owner, key, value));
  const number = (key: string, label: string, whole = true) => (
    <NumberField key={key} id={`${prefix}-${key}`} label={`${tag}${label}`} value={c[key] as number | undefined} whole={whole} onChange={(value) => set(key, value)} />
  );
  switch (owner.type) {
    case 'text':
      return (
        <>
          {number('minLength', '最短（字）')}
          {number('maxLength', '最长（字）')}
          <PatternField id={`${prefix}-pattern`} label={`${tag}正则`} value={typeof c['pattern'] === 'string' ? c['pattern'] : ''} onChange={(value) => set('pattern', value)} />
          <EnumField id={`${prefix}-enum`} label={`${tag}可选值（一行一个）`} value={c['enum']} numeric={false} onChange={(value) => set('enum', value)} />
        </>
      );
    case 'number':
      return (
        <>
          {number('min', '下限', false)}
          {number('max', '上限', false)}
          <label className={`constraint-card inline wide${c['integer'] === true ? ' on' : ''}`}><input type="checkbox" checked={c['integer'] === true} onChange={(event) => set('integer', event.target.checked ? true : undefined)} />{tag}只能是整数</label>
          <EnumField id={`${prefix}-enum`} label={`${tag}可选值（一行一个）`} value={c['enum']} numeric onChange={(value) => set('enum', value)} />
        </>
      );
    case 'image': {
      // 省略表示两种来源都允许；只取一种时才写。
      const sources = Array.isArray(c['allowedSources']) ? c['allowedSources'] as string[] : ['resource', 'url'];
      const toggle = (source: string, on: boolean) => {
        const next = ['resource', 'url'].filter((item) => (item === source ? on : sources.includes(item)));
        set('allowedSources', next.length === 2 ? undefined : next);
      };
      return (
        <fieldset className="tenant-picks wide">
          <legend>{tag}图片来源</legend>
          <label className="check"><input type="checkbox" checked={sources.includes('resource')} onChange={(event) => toggle('resource', event.target.checked)} />资源仓库</label>
          <label className="check"><input type="checkbox" checked={sources.includes('url')} onChange={(event) => toggle('url', event.target.checked)} />网址</label>
        </fieldset>
      );
    }
    case 'list':
      return <>{number('minItems', '最少项数')}{number('maxItems', '最多项数')}</>;
    case 'ref':
      return <RefField id={`${prefix}-ref`} label={`${tag}引用的数据定义`} value={owner.ref} refs={refs} onChange={(ref) => onChange({ ...owner, ref })} />;
    default:
      return <p className="small muted wide">这种类型没有可加的{tag}约束。</p>;
  }
}

/** 数值输入：自己留着正在打的字（"1."、"-"），写回去的是数值；清空就是没有这条约束。 */
function NumberField(props: { readonly id: string; readonly label: string; readonly value: number | undefined; readonly whole: boolean; readonly onChange: (value: number | undefined) => void }) {
  const [text, setText] = useState(props.value === undefined ? '' : String(props.value));
  const optional = useOptional(props.value !== undefined, () => { setText(''); props.onChange(undefined); });
  return (
    <ConstraintCard id={props.id} label={props.label} on={optional.on} onToggle={optional.toggle}>
      <input ref={optional.control} id={props.id} type="number" step={props.whole ? 1 : 'any'} {...(props.whole ? { min: 0 } : {})} value={text}
        onChange={(event) => { setText(event.target.value); props.onChange(event.target.value === '' ? undefined : Number(event.target.value)); }} />
    </ConstraintCard>
  );
}

function PatternField(props: { readonly id: string; readonly label: string; readonly value: string; readonly onChange: (value: string | undefined) => void }) {
  const optional = useOptional(Boolean(props.value), () => props.onChange(undefined));
  return (
    <ConstraintCard id={props.id} label={props.label} on={optional.on} wide onToggle={optional.toggle}>
      <input ref={optional.control} id={props.id} type="text" className="mono" spellCheck={false} value={props.value} onChange={(event) => props.onChange(event.target.value || undefined)} />
    </ConstraintCard>
  );
}

/** 枚举：一行一个。数值枚举读不成数的原样写回，由服务端报问题。 */
function EnumField(props: { readonly id: string; readonly label: string; readonly value: unknown; readonly numeric: boolean; readonly onChange: (value: unknown) => void }) {
  const [text, setText] = useState(Array.isArray(props.value) ? props.value.join('\n') : '');
  const change = (next: string) => {
    setText(next);
    const lines = next.split('\n').map((line) => line.trim()).filter(Boolean);
    props.onChange(lines.length ? (props.numeric ? lines.map((line) => (Number.isNaN(Number(line)) ? line : Number(line))) : lines) : undefined);
  };
  const optional = useOptional(Array.isArray(props.value), () => change(''));
  return (
    <ConstraintCard id={props.id} label={props.label} on={optional.on} wide onToggle={optional.toggle}>
      <textarea ref={optional.control} id={props.id} rows={3} value={text} onChange={(event) => change(event.target.value)} />
    </ConstraintCard>
  );
}

/** 引用：选已发布的确切版本；当前写的版本不在列表里也留着，由服务端报问题。 */
function RefField(props: { readonly id: string; readonly label: string; readonly value: SchemaRef | undefined; readonly refs: readonly StaticSchemaSummary[]; readonly onChange: (ref: SchemaRef) => void }) {
  const key = (ref: SchemaRef) => `${ref.name}@${ref.version}`;
  const missing = props.value && !props.refs.some((ref) => key(ref) === key(props.value!));
  if (!props.refs.length && !props.value) return <p className="small muted wide">还没有已发布的数据定义可以引用。</p>;
  return (
    <div className="field wide">
      <label htmlFor={props.id}>{props.label}</label>
      <select id={props.id} value={props.value ? key(props.value) : ''} onChange={(event) => {
        const at = event.target.value.lastIndexOf('@');
        props.onChange({ name: event.target.value.slice(0, at), version: Number(event.target.value.slice(at + 1)) });
      }}>
        {!props.value && <option value="">选一个版本</option>}
        {missing && <option value={key(props.value!)}>{props.value!.name} v{props.value!.version}（不存在）</option>}
        {props.refs.map((ref) => <option key={key(ref)} value={key(ref)}>{ref.displayName === ref.name ? ref.name : `${ref.displayName}（${ref.name}）`} v{ref.version}</option>)}
      </select>
    </div>
  );
}
