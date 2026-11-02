/**
 * 结构化差异（引擎的 revisionDiff，P1 票据 09）：按元素路径列出改动，标出新增、删除与修改的属性。
 * 元素的 path 从模板名开始、画板就是模板名；模板层的改动写键名，参数、派生变量与检查项以名称为键。
 */
import type { RevisionDiff, TemplateChange } from '../types.js';

const CHANGE: Readonly<Record<TemplateChange['change'], string>> = { added: '新增', removed: '删除', changed: '修改' };
const SIGN: Readonly<Record<TemplateChange['change'], string>> = { added: '+', removed: '−', changed: '~' };
const LAYER: Readonly<Record<string, string>> = { parameters: '参数', derived: '派生变量', checks: '检查项', base: '基准数据定义', dslVersion: 'DSL 版本', name: '名称' };

/** 一个值写成一行：变量写成"变量 名称"，太长的截断，悬停看全文。 */
export function valueText(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'var' in value && Object.keys(value).length === 1) return `变量 ${String((value as { var: unknown }).var)}`;
  return typeof value === 'string' ? value : JSON.stringify(value) ?? '';
}
const shortened = (text: string) => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

function Value(props: { readonly value: unknown }) {
  const text = valueText(props.value);
  return <code className="change-value" title={text}>{shortened(text)}</code>;
}

function propertyChange(before: unknown, after: unknown): TemplateChange['change'] {
  return before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
}

function Property(props: { readonly name: string; readonly before?: unknown; readonly after?: unknown }) {
  const { name, before, after } = props, change = propertyChange(before, after);
  return (
    <li className={`change-property ${change}`} data-testid="change-property" data-key={name} data-change={change}>
      <code className="change-key">{name}</code>
      <span className="change-kind">{CHANGE[change]}</span>
      {before !== undefined && <Value value={before} />}
      {before !== undefined && after !== undefined && <span aria-label="改为">→</span>}
      {after !== undefined && <Value value={after} />}
    </li>
  );
}

interface PropertyLine { readonly key: string; readonly before?: unknown; readonly after?: unknown }

const plainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 两边都是对象的属性往里展开，只列真正变了的子键（如参数的 nameSize.default）。 */
function expanded(line: PropertyLine): readonly PropertyLine[] {
  const { key, before, after } = line;
  if (!plainObject(before) || !plainObject(after)) return [line];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .flatMap((name) => expanded({ key: `${key}.${name}`, ...(before[name] !== undefined ? { before: before[name] } : {}), ...(after[name] !== undefined ? { after: after[name] } : {}) }));
}

/** 没有属性清单的改动（新增、删除的元素，模板层整个键）：改前改后的内容各写一行，子元素各有一条。 */
function changeProperties(change: TemplateChange): readonly PropertyLine[] {
  if (change.properties) return change.properties.flatMap(expanded);
  if (change.target === 'template') return [{ key: change.path, ...(change.before !== undefined ? { before: change.before } : {}), ...(change.after !== undefined ? { after: change.after } : {}) }];
  const side = change.after ?? change.before;
  if (typeof side !== 'object' || side === null) return [];
  return Object.entries(side).map(([key, value]) => ({ key, ...(change.change === 'added' ? { after: value } : { before: value }) }));
}

export function RevisionChanges(props: { readonly diff: RevisionDiff; readonly label: string; readonly empty?: string }) {
  const { diff } = props;
  if (diff.status === 'added') return <p className="muted">这是一个新模板，还没有修订可比；发布后记修订 1。</p>;
  if (diff.changes.length === 0) return <p className="muted">{props.empty ?? '没有改动。'}</p>;
  return (
    <ul className="changes" aria-label={props.label}>
      {diff.changes.map((change) => (
        <li key={`${change.target}:${change.path}`} className={`change ${change.change}`} data-testid="change" data-path={change.path} data-change={change.change}>
          <div className="change-head">
            <span className="change-sign" aria-hidden="true">{SIGN[change.change]}</span>
            <code className="change-path">{change.path}</code>
            <span className="change-kind">{change.target === 'template' ? (LAYER[change.path] ?? '模板') : `${CHANGE[change.change]}元素`}</span>
          </div>
          <ul className="change-properties">
            {changeProperties(change).map((property) => <Property key={property.key} name={property.key} before={property.before} after={property.after} />)}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** 差异的一句话：多少处、多少元素。 */
export function changesSummary(diff: RevisionDiff): string {
  const elements = diff.changes.filter((change) => change.target === 'element').length, others = diff.changes.length - elements;
  return [elements ? `${elements} 个元素` : '', others ? `${others} 处模板层改动` : ''].filter(Boolean).join('，') || '没有改动';
}
