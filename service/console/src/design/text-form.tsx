/**
 * 文字一块（模板设计页第三轮票据 04，方案「检查器」、原型 01）：字体族与字重一行，字号与字距一行，颜色一行，
 * 书写方向、水平对齐、垂直对齐三组图标一行。值格、绑定、来源链与状态覆盖的圆点照旧，写回仍是一项一个键；
 * 换书写方向时只在另一个方向才合法的写法由 writeProperty 去掉。倾斜只在横排时出现（票据 05 归进"+ 属性"）。
 */
import { ALIGN_CENTER, ALIGN_END, ALIGN_START, Icon, TEXT_HORIZONTAL, TEXT_VERTICAL } from '../components/icon.js';
import { FieldRow, FieldRows, type FieldContext } from '../components/property-fields.js';
import type { PropertyField } from '../template/properties.js';

/** 一个取值画成什么：有图标的用图标，上中下与分散、均分用一个字。 */
const MARKS: Readonly<Record<string, Readonly<Record<string, { readonly icon?: string; readonly text?: string }>>>> = {
  writingMode: { horizontal: { icon: TEXT_HORIZONTAL }, vertical: { icon: TEXT_VERTICAL } },
  horizontalAlign: { start: { icon: ALIGN_START }, center: { icon: ALIGN_CENTER }, end: { icon: ALIGN_END }, distribute: { text: '散' }, spaceEvenly: { text: '匀' } },
  verticalAlign: { top: { text: '上' }, center: { text: '中' }, bottom: { text: '下' }, distribute: { text: '散' } },
};
const ALIGN_KEYS = ['writingMode', 'horizontalAlign', 'verticalAlign'] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const overriddenBy = (field: PropertyField, context: FieldContext) => context.binding?.overriddenBy(field) ?? [];
const resettable = (field: PropertyField, context: FieldContext) => context.stateValue !== undefined && context.resetOverride !== undefined && overriddenBy(field, context).includes(context.stateValue);

/** 一组图标按钮：取值来自这一项的选项（竖排多"分散"由 Schema 决定），选中的按下，没写时缺省值描边；点已经选中的不写。 */
function IconChoice(props: { readonly field: PropertyField; readonly context: FieldContext }) {
  const { field, context } = props;
  const options = field.editor.kind === 'choice' ? field.editor.options : [];
  const selected = options.find((option) => same(option.value, field.value));
  const implied = selected ? undefined : options.find((option) => same(option.value, field.fallback));
  const overridden = overriddenBy(field, context);
  return (
    <div className="text-choice" data-testid="property-field" data-key={field.key} title={field.noBinding ?? field.description}>
      {overridden.length > 0 && <i className="prop-state-dot" data-testid="state-dot" title={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} aria-label={`状态样式在 ${overridden.join('、')} 时覆盖这一项`} />}
      <div className="segmented flow-buttons text-buttons" role="group" aria-label={field.label}>
        {options.map((option) => {
          const mark = MARKS[field.key]?.[String(option.value)];
          return (
            <button key={String(option.value)} type="button" aria-label={option.label} aria-pressed={option === selected} data-value={String(option.value)}
              className={option === implied ? 'implied' : undefined} title={`${field.label}：${option.label}${option === implied ? '（没写，这是缺省值）' : ''}`}
              onClick={() => { if (option !== selected) context.onWrite(field.path, option.value, { now: true }); }}>{mark?.icon ? <Icon d={mark.icon} /> : mark?.text ?? option.label}</button>
          );
        })}
      </div>
    </div>
  );
}

export function TextSection(props: { readonly fields: readonly PropertyField[]; readonly context: FieldContext }) {
  const { fields, context } = props;
  const named = (key: string) => fields.find((field) => field.key === key);
  const font = named('font'), size = named('fontSize'), spacing = named('letterSpacing'), color = named('color'), slant = named('slant');
  const aligns = ALIGN_KEYS.map(named).filter((field): field is PropertyField => Boolean(field));
  // 三组都是能点的选项才排成一行图标；这个取值下不能改的（状态样式不覆盖）退回一项项的字段，把原因写出来。
  const iconic = aligns.length === ALIGN_KEYS.length && aligns.every((field) => field.editor.kind === 'choice' && !field.blocked && !field.needs);
  const vertical = named('writingMode')?.value === 'vertical';
  const taken = new Set<string>(['font', 'fontSize', 'letterSpacing', 'color', 'slant', ...(iconic ? ALIGN_KEYS : [])]);
  const half = (field: PropertyField | undefined) => field && <FieldRow key={field.key} field={field} context={context} half />;
  return (
    <>
      {font && <FieldRow field={font} context={context} bare={!font.blocked} />}
      {(size || spacing) && <div className="prop-pair text-pair" data-testid="prop-pair">{half(size)}{half(spacing)}</div>}
      {color && <FieldRow field={color} context={context} />}
      {iconic && (
        <>
          <div className="text-aligns" data-testid="text-aligns">{aligns.map((field) => <IconChoice key={field.key} field={field} context={context} />)}</div>
          {aligns.filter((field) => resettable(field, context)).map((field) => (
            <button key={field.key} type="button" className="link small prop-reset" data-testid="state-reset" data-key={field.key} onClick={() => context.resetOverride!(field)}>{field.label}重置为自身属性</button>
          ))}
        </>
      )}
      {/* 倾斜只在横排时出现；竖排下已经写着的（变量）留着，让人看得到、去得掉。 */}
      {slant && (!vertical || slant.value !== undefined) && <FieldRow field={slant} context={context} />}
      <FieldRows fields={fields.filter((field) => !taken.has(field.key))} context={context} />
    </>
  );
}
