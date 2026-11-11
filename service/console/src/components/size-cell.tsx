/**
 * 宽高一格（模板设计页第三轮票据 01，方案「检查器」）：左边数值框，右边尺寸方式，同 Figma 的宽高框。
 * 数值框显示固定值或比例；随内容、撑满、没写时淡色显示这一处的实际尺寸（布局摘要）。在框里打数就是固定，
 * 按比例时打的是权重。固定值能绑定变量，绑定时数值框换成灰底条，同值格（票据 09）。写什么由 template/size.ts 决定。
 */
import { useEffect, useRef, useState } from 'react';
import type { ScopeVariable } from '../template/binding.js';
import type { Bindable, PropertyField } from '../template/properties.js';
import { chosenSize, SIZE_LABELS, typedSize, type SizeKind, type SizeModel } from '../template/size.js';
import { BindingPopover } from './binding-popover.js';
import { Icon, LINK, UNLINK } from './icon.js';
import type { BindingHost } from './property-fields.js';
import { ValueText } from './value-text.js';

const round = (value: number) => Math.round(value * 10) / 10;
const NUMBER: Bindable = { type: 'number', literal: { kind: 'number', min: 0 }, initial: 0, schema: { type: 'number', minimum: 0 } };

export function SizeCell(props: {
  readonly id?: string;
  /** 数值框的名称："宽""每项宽"。 */
  readonly label: string;
  readonly model: SizeModel;
  /** 这一处的实际尺寸（毫米）；还没出图时没有。 */
  readonly actual?: number | undefined;
  /** 没写时引擎怎么排；必填的没有"缺省"这一项。 */
  readonly fallback?: SizeKind | undefined;
  readonly required?: boolean;
  /** 用不了的方式与原因（循环每项的互斥），下拉里禁用。 */
  readonly blocked?: Partial<Record<SizeKind, string>>;
  /** 半行宽的格子（宽高并排，第三轮票据 05）：没写时下拉只写"缺省"，引擎怎么排放进提示。 */
  readonly compact?: boolean | undefined;
  /** now：选方式立刻写回；打字等停顿。 */
  readonly onWrite: (value: unknown, now: boolean) => void;
  /** 固定值能绑定变量时给：绑定弹层与提取为参数用这个字段的 `fixed` 子项。 */
  readonly binding?: { readonly host: BindingHost; readonly field: PropertyField };
}) {
  const { model, label, actual } = props;
  const shown = model.kind === 'ratio' ? model.ratio : model.kind === 'fixed' ? model.fixed : undefined;
  const [draft, setDraft] = useState(shown === undefined ? '' : String(shown));
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const written = useRef(shown);
  // 外面的值变了（撤销、换元素、选了别的方式）就跟着换；自己刚写回的不算。
  useEffect(() => {
    if (shown === written.current) return;
    written.current = shown;
    setDraft(shown === undefined ? '' : String(shown));
    setError(undefined);
  }, [shown]);
  const type = (text: string) => {
    setDraft(text);
    const result = typedSize(model, text);
    if ('problem' in result) { setError(result.problem); return; }
    if (result.value === undefined && props.required) { setError('必填：选一种方式，或打一个数'); return; }
    setError(undefined);
    const next = result.value as { fixed?: number; fill?: number } | undefined;
    written.current = next?.fixed ?? next?.fill;
    props.onWrite(result.value, false);
  };
  const choose = (kind: SizeKind | '') => { setError(undefined); props.onWrite(chosenSize(model, kind, actual), true); };
  const host = props.binding?.host, variable = model.bound !== undefined ? host?.variables.find((item: ScopeVariable) => item.name === model.bound) : undefined;
  const fixedField = props.binding && { ...props.binding.field, path: [...props.binding.field.path, 'fixed'], key: `${props.binding.field.key}.fixed` };
  const placeholder = actual !== undefined ? String(round(actual)) : props.fallback ? SIZE_LABELS[props.fallback] : '';
  return (
    <div className="size-cell" data-testid="size-cell" data-kind={model.kind ?? ''}>
      <div className="size-cell-row">
        {model.bound !== undefined ? (
          <button type="button" className="value-bound" data-testid="bound-chip" aria-label={`${label}绑定了 ${variable?.label ?? model.bound}，点开换绑定`} aria-expanded={open} title={model.bound} onClick={() => setOpen(!open)}>
            <span className="value-bound-name">{variable?.label ?? model.bound}</span>
            <ValueText value={variable?.value} type="number" />
          </button>
        ) : (
          <input id={props.id} type="text" inputMode="decimal" className={`prop-number size-input${shown === undefined ? ' implied' : ''}`} aria-label={label} value={draft} placeholder={placeholder}
            aria-invalid={error ? true : undefined} title={model.kind === 'ratio' ? '按比例撑满的权重' : '打一个数就是固定尺寸（毫米）'} onChange={(event) => type(event.target.value)} />
        )}
        {model.kind === 'ratio' && <span className="size-unit small faint">份</span>}
        <select className="size-mode" aria-label={`${label}的尺寸方式`} value={model.kind ?? ''} onChange={(event) => choose(event.target.value as SizeKind | '')}
          {...(props.compact && props.fallback && model.kind === undefined ? { title: `缺省（${SIZE_LABELS[props.fallback]}）` } : {})}>
          {(!props.required || model.kind === undefined) && <option value="">{props.fallback && !props.compact ? `缺省（${SIZE_LABELS[props.fallback]}）` : '缺省'}</option>}
          {model.options.map((option) => {
            const reason = option.kind === model.kind ? undefined : props.blocked?.[option.kind];
            return <option key={option.kind} value={option.kind} disabled={Boolean(reason)} title={reason}>{option.label}{reason ? `（${reason}）` : ''}</option>;
          })}
        </select>
        {model.bound !== undefined ? (
          <button type="button" className="value-action" aria-label="断开绑定" title="断开绑定：当前值变成固定值" data-testid="unbind-button"
            onClick={() => props.onWrite({ fixed: typeof variable?.value === 'number' ? variable.value : actual !== undefined ? round(actual) : 10 }, true)}><Icon d={UNLINK} /></button>
        ) : host && (
          <button type="button" className="value-action" aria-label="绑定变量" title="固定尺寸绑定变量" aria-expanded={open} data-testid="bind-button" onClick={() => setOpen(!open)}><Icon d={LINK} /></button>
        )}
      </div>
      {error && <span className="prop-error" role="alert">{error}</span>}
      {open && host && fixedField && (
        <BindingPopover type="number" label={label} {...(model.bound !== undefined ? { current: model.bound } : {})} variables={host.variables}
          extract={{ value: model.fixed ?? (actual !== undefined ? round(actual) : 10), ...host.suggest(fixedField), taken: host.taken }}
          onPick={(name) => { props.onWrite({ fixed: { var: name } }, true); setOpen(false); }}
          onExtract={(name, displayName) => { host.extract(fixedField, NUMBER, model.fixed ?? (actual !== undefined ? round(actual) : 10), name, displayName); setOpen(false); }}
          onOpen={(target) => { setOpen(false); host.open({ template: '', name: target.name.split('.')[0]!, kind: target.kind }); }}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}
