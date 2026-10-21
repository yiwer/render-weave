/**
 * 参数面板：模板的对外参数（模板只读，只能调对外参数，阶段 4 PRD「Out of Scope」）与出图参数。
 * 参数值原样交给预览与交付；取值对不对由服务端的问题清单说明。
 */
import { useId } from 'react';
import { parameterNumber } from '../form/value.js';
import type { OutputSettings, TemplateInfo, TemplateParameter } from '../types.js';
import { ImageChoice } from './image-picker.js';

export type ParameterValues = Readonly<Record<string, unknown>>;

/** 对外参数的初始值：有缺省值的取缺省值。 */
export function defaultParameters(template: TemplateInfo): ParameterValues {
  return Object.fromEntries((template.parameters ?? []).flatMap((parameter) => (parameter.default === undefined ? [] : [[parameter.name, parameter.default]])));
}

/** 出图参数的初始值：适用尺寸范围的下限，120 DPI，PNG（M280）。 */
export function defaultOutput(template: TemplateInfo): OutputSettings {
  return { width: template.sizeRange?.width.min ?? 100, height: template.sizeRange?.height.min ?? 100, dpi: 120, format: 'png' };
}

function ParameterInput(props: { readonly parameter: TemplateParameter; readonly value: unknown; readonly onChange: (value: unknown) => void }) {
  const { parameter, value, onChange } = props, id = useId();
  const text = value === undefined ? '' : String(value);
  const options = parameter.constraints?.enum;
  let input;
  if (options && (parameter.type === 'text' || parameter.type === 'number')) {
    input = (
      <select id={id} value={text} onChange={(event) => onChange(event.target.value === '' ? undefined : parameter.type === 'number' ? Number(event.target.value) : event.target.value)}>
        <option value="">（不填）</option>
        {options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
      </select>
    );
  } else {
    switch (parameter.type) {
      case 'boolean':
        input = <input id={id} type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />;
        break;
      case 'color':
        input = (
          <span className="color-input">
            {/* 颜色可以带透明度（#RRGGBBAA）；取色器只认 #RRGGBB，取前 6 位显示，选了新颜色就是不透明的。 */}
            <input type="color" aria-label={`${parameter.displayName}（取色）`} value={/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(text) ? text.slice(0, 7).toLowerCase() : '#000000'}
              onChange={(event) => onChange(event.target.value.toUpperCase())} />
            <input id={id} type="text" value={text} placeholder="#RRGGBB" onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)} />
          </span>
        );
        break;
      case 'number': {
        const { min, max, integer } = parameter.constraints ?? {};
        const box = <input id={id} type="text" inputMode={integer ? 'numeric' : 'decimal'} value={text} onChange={(event) => onChange(parameterNumber(event.target.value))} />;
        // 整数且范围不大时另给滑块，拖动就出新的预览。
        input = integer && min !== undefined && max !== undefined && max - min <= 1000 ? (
          <span className="slider">
            <input type="range" aria-label={`${parameter.displayName}（拖动）`} min={min} max={max} step={1} value={typeof value === 'number' ? value : min}
              onChange={(event) => onChange(Number(event.target.value))} />
            {box}
          </span>
        ) : box;
        break;
      }
      case 'date':
        input = <input id={id} type="date" value={text} onChange={(event) => onChange(event.target.value || undefined)} />;
        break;
      case 'time':
        input = <input id={id} type="time" value={text} onChange={(event) => onChange(event.target.value || undefined)} />;
        break;
      case 'image':
        input = <ImageChoice id={id} label={parameter.displayName} value={typeof value === 'string' ? value : undefined} onChange={onChange} allowUpload={false} />;
        break;
      default:
        input = <input id={id} type="text" value={text} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)} />;
    }
  }
  return (
    <div className="field">
      <label htmlFor={id}>{parameter.displayName}</label>
      {input}
    </div>
  );
}

export function ParameterPanel(props: { readonly template: TemplateInfo; readonly values: ParameterValues; readonly onChange: (values: ParameterValues) => void }) {
  const parameters = props.template.parameters ?? [];
  return (
    <fieldset className="group">
      <legend>对外参数</legend>
      {parameters.length === 0 && <p className="muted small">这个模板没有对外参数。</p>}
      {parameters.map((parameter) => (
        <ParameterInput key={parameter.name} parameter={parameter} value={props.values[parameter.name]}
          onChange={(value) => {
            const next: Record<string, unknown> = { ...props.values };
            if (value === undefined) delete next[parameter.name];
            else next[parameter.name] = value;
            props.onChange(next);
          }} />
      ))}
      {parameters.length > 0 && (
        <div><button type="button" className="link" onClick={() => props.onChange(defaultParameters(props.template))}>恢复缺省值</button></div>
      )}
    </fieldset>
  );
}

const DPIS = [60, 120, 200, 300];

export function OutputPanel(props: { readonly template: TemplateInfo; readonly value: OutputSettings; readonly onChange: (value: OutputSettings) => void }) {
  const range = props.template.sizeRange, widthId = useId(), heightId = useId(), dpiId = useId(), formatId = useId();
  const set = (patch: Partial<OutputSettings>) => props.onChange({ ...props.value, ...patch });
  const number = (text: string) => (text.trim() === '' ? Number.NaN : Number(text));
  return (
    <fieldset className="group">
      <legend>尺寸与分辨率</legend>
      <div className="field-row">
        <div className="field">
          <label htmlFor={widthId}>宽（mm）</label>
          <input id={widthId} type="number" step="any" min={range?.width.min} max={range?.width.max} value={Number.isNaN(props.value.width) ? '' : props.value.width}
            onChange={(event) => set({ width: number(event.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor={heightId}>高（mm）</label>
          <input id={heightId} type="number" step="any" min={range?.height.min} max={range?.height.max} value={Number.isNaN(props.value.height) ? '' : props.value.height}
            onChange={(event) => set({ height: number(event.target.value) })} />
        </div>
        <div className="field">
          <label htmlFor={dpiId}>DPI</label>
          <select id={dpiId} value={props.value.dpi} onChange={(event) => set({ dpi: Number(event.target.value) })}>
            {DPIS.map((dpi) => <option key={dpi} value={dpi}>{dpi}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={formatId}>格式</label>
          <select id={formatId} value={props.value.format} onChange={(event) => set({ format: event.target.value === 'jpeg' ? 'jpeg' : 'png' })}>
            <option value="png">PNG</option>
            <option value="jpeg">JPG</option>
          </select>
        </div>
      </div>
      {range && <p className="hint">适用尺寸 {rangeText(range)}；正式交付与预览用同样的尺寸和分辨率</p>}
    </fieldset>
  );
}

const span = (range: { min: number; max: number }) => (range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`);
export const rangeText = (range: NonNullable<TemplateInfo['sizeRange']>) => `${span(range.width)} × ${span(range.height)} mm`;
