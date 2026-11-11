/**
 * 样例带（模板设计页票据 07，方案第 8 节）：样例是一个渲染项，数据集、对外参数与画板尺寸，用来看，不写进模板。
 * 卡片一眼看到每份输入的结果；试值存浏览器。只重出当前样例，其他卡片标"改动后没重新出"，点到才出。
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { queuePreview } from '../hooks.js';
import type { PreviewReply, Problem, TemplateInfo, TemplateParameter } from '../types.js';

export interface Sample { readonly id: string; readonly name: string; readonly stress: boolean }
export interface Trial { readonly parameters: Readonly<Record<string, unknown>>; readonly width?: number; readonly height?: number }
export const NO_TRIAL: Trial = { parameters: {} };

const STORAGE_PREFIX = 'renderweave.design.trial.';
interface Stored { readonly datasetId?: string; readonly trial?: Trial }
export function readStored(root: string): Stored {
  try {
    const text = localStorage.getItem(STORAGE_PREFIX + root);
    return text ? JSON.parse(text) as Stored : {};
  } catch { return {}; }
}
export function writeStored(root: string, value: Stored): void {
  try { localStorage.setItem(STORAGE_PREFIX + root, JSON.stringify(value)); } catch { /* 存不了时这一页仍可用，只是下次不记得 */ }
}

interface Thumb { readonly src?: string; readonly severe: number; readonly hints: number; readonly version: string }
const thumbOf = (reply: PreviewReply, version: string): Thumb => {
  const severe = reply.problems.filter((problem: Problem) => problem.level === 'severe').length;
  return { ...(reply.image ? { src: `data:image/${reply.image.format};base64,${reply.image.base64}` } : {}), severe, hints: reply.problems.length - severe, version };
};
/** 卡片的缩略图一次最多补这么多份：预览有频率限制，每分钟 60 次（docs/service.md）。 */
const MAX_THUMBS = 12;

/**
 * 卡片上的结果：当前样例用主预览的回答，其他样例在主预览出完之后依次补一次，之后不再自动重出。
 * version 变了（有新的改动或试值），旧结果还留着，卡片标"没重新出"。
 */
export function useSampleThumbs(samples: readonly Sample[], current: string, reply: PreviewReply | undefined, version: string, requestFor: (id: string) => unknown) {
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, Thumb>>(new Map());
  const latest = useRef({ requestFor, version });
  latest.current = { requestFor, version };
  useEffect(() => {
    if (!reply) return;
    setThumbs((now) => new Map(now).set(current, thumbOf(reply, version)));
  }, [reply]);
  const ready = Boolean(reply);
  const ids = samples.map((sample) => sample.id).join('\n');
  useEffect(() => {
    if (!ready) return undefined;
    let stopped = false;
    void (async () => {
      for (const id of ids.split('\n').slice(0, MAX_THUMBS)) {
        if (stopped) return;
        if (id === current || thumbsRef.current.has(id)) continue;
        try {
          const answer = await queuePreview(latest.current.requestFor(id), () => stopped, undefined, { workingCopies: true, sample: id || 'blank' });
          if (answer && !stopped) setThumbs((now) => new Map(now).set(id, thumbOf(answer, latest.current.version)));
        } catch { /* 缩略图出不来不影响主预览，卡片上写还没出 */ }
      }
    })();
    return () => { stopped = true; };
  }, [ready, ids]);
  const thumbsRef = useRef(thumbs);
  thumbsRef.current = thumbs;
  return thumbs;
}

function SampleCard(props: { readonly sample: Sample; readonly thumb?: Thumb; readonly version: string; readonly current: boolean; readonly onChoose: () => void }) {
  const { sample, thumb, version } = props;
  const stale = thumb !== undefined && thumb.version !== version && !props.current;
  const state = !thumb ? { dot: '', text: '还没出' } : stale ? { dot: '', text: '改动后没重新出' }
    : thumb.severe ? { dot: 'bad', text: `${thumb.severe} 个严重问题` } : thumb.hints ? { dot: 'warn', text: `${thumb.hints} 个提示` } : { dot: 'ok', text: '没有问题' };
  return (
    <button type="button" className={`sample-card${props.current ? ' current' : ''}`} data-testid="sample-card" data-id={sample.id} aria-pressed={props.current} onClick={props.onChoose}>
      <span className="sample-thumb">{thumb?.src ? <img src={thumb.src} alt="" draggable={false} /> : <span className="small faint">点一下出图</span>}</span>
      <span className="sample-name">{sample.name}</span>
      <span className="sample-state small" data-testid="sample-state"><span className={`status-dot ${state.dot}`} aria-hidden="true" />{state.text}</span>
    </button>
  );
}

function CommittedNumber(props: { readonly label: string; readonly value: number; readonly min?: number; readonly max?: number; readonly step?: number; readonly unit?: string; readonly onCommit: (value: number) => void }) {
  const { min, max } = props;
  const [draft, setDraft] = useState<string>();
  const shown = draft ?? String(props.value);
  const commit = () => {
    if (draft === undefined) return;
    const value = Number(draft);
    setDraft(undefined);
    if (draft.trim() !== '' && Number.isFinite(value) && value !== props.value) props.onCommit(value);
  };
  return (
    <span className="knob-number">
      {min !== undefined && max !== undefined && max > min && max - min <= 5000 && (
        <input type="range" aria-label={`${props.label}（拖动）`} min={min} max={max} step={props.step ?? 'any'} value={Number(shown)}
          onChange={(event) => setDraft(event.target.value)} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      )}
      <input type="text" inputMode="decimal" aria-label={props.label} value={shown} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') commit(); }} />
      {props.unit && <span className="small faint">{props.unit}</span>}
    </span>
  );
}

function ParameterKnob(props: { readonly parameter: TemplateParameter; readonly value: unknown; readonly onChange: (value: unknown) => void }) {
  const { parameter, value } = props, id = useId();
  const options = parameter.constraints?.enum, label = parameter.displayName;
  let input;
  if (options) {
    input = <select id={id} value={value === undefined ? '' : String(value)} onChange={(event) => props.onChange(parameter.type === 'number' ? Number(event.target.value) : event.target.value)}>{options.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select>;
  } else if (parameter.type === 'boolean') {
    input = <input id={id} type="checkbox" checked={value === true} onChange={(event) => props.onChange(event.target.checked)} />;
  } else if (parameter.type === 'number') {
    const { min, max, integer } = parameter.constraints ?? {};
    input = <CommittedNumber label={label} value={typeof value === 'number' ? value : (min ?? 0)} {...(min === undefined ? {} : { min })} {...(max === undefined ? {} : { max })} {...(integer ? { step: 1 } : {})} onCommit={props.onChange} />;
  } else if (parameter.type === 'color') {
    const text = typeof value === 'string' ? value : '';
    input = (
      <span className="color-input">
        <input type="color" aria-label={`${label}（取色）`} value={/^#[0-9a-fA-F]{6}/.test(text) ? text.slice(0, 7).toLowerCase() : '#000000'} onChange={(event) => props.onChange(event.target.value.toUpperCase())} />
        <input id={id} type="text" value={text} placeholder="#RRGGBB" onChange={(event) => props.onChange(event.target.value)} />
      </span>
    );
  } else {
    input = <input id={id} type={parameter.type === 'date' ? 'date' : parameter.type === 'time' ? 'time' : 'text'} defaultValue={value === undefined ? '' : String(value)} onBlur={(event) => props.onChange(event.target.value || undefined)} />;
  }
  return <div className="knob" data-testid="parameter-knob" data-name={parameter.name}><label htmlFor={id} className="small muted">{label}</label>{input}</div>;
}

/** 对外参数与画板尺寸的试值：不写进模板，模板的缺省值在变量页改。 */
export function SampleKnobs(props: { readonly info: TemplateInfo; readonly defaults: Readonly<Record<string, unknown>>; readonly output: { readonly width: number; readonly height: number }; readonly trial: Trial; readonly onTrial: (trial: Trial) => void }) {
  const { info, trial, output } = props, range = info.sizeRange, parameters = info.parameters ?? [];
  const values = useMemo(() => ({ ...props.defaults, ...trial.parameters }), [props.defaults, trial.parameters]);
  const dirty = Object.keys(trial.parameters).length > 0 || trial.width !== undefined || trial.height !== undefined;
  return (
    <div className="sample-knobs" role="group" aria-label="试值">
      {parameters.map((parameter) => (
        <ParameterKnob key={parameter.name} parameter={parameter} value={values[parameter.name]}
          onChange={(value) => { const next: Record<string, unknown> = { ...trial.parameters }; if (value === undefined) delete next[parameter.name]; else next[parameter.name] = value; props.onTrial({ ...trial, parameters: next }); }} />
      ))}
      {range && range.width.min !== range.width.max && <div className="knob" data-testid="size-knob" data-name="width"><span className="small muted">画板宽</span><CommittedNumber label="画板宽" value={output.width} min={range.width.min} max={range.width.max} unit="mm" onCommit={(width) => props.onTrial({ ...trial, width })} /></div>}
      {range && range.height.min !== range.height.max && <div className="knob" data-testid="size-knob" data-name="height"><span className="small muted">画板高</span><CommittedNumber label="画板高" value={output.height} min={range.height.min} max={range.height.max} unit="mm" onCommit={(height) => props.onTrial({ ...trial, height })} /></div>}
      {dirty && <button type="button" className="link small" onClick={() => props.onTrial(NO_TRIAL)}>恢复缺省</button>}
      {!parameters.length && !(range && (range.width.min !== range.width.max || range.height.min !== range.height.max)) && <span className="small faint">这个模板没有能试的值。</span>}
      <p className="small faint sample-knobs-note">试值不写进模板。</p>
    </div>
  );
}

export function SampleCards(props: { readonly samples: readonly Sample[]; readonly current: string; readonly thumbs: ReadonlyMap<string, Thumb>; readonly version: string; readonly onChoose: (id: string) => void }) {
  const normal = props.samples.filter((sample) => !sample.stress && sample.id !== ''), stress = props.samples.filter((sample) => sample.stress), blank = props.samples.filter((sample) => sample.id === '');
  const group = (label: string, list: readonly Sample[]) => (list.length > 0 && (
    <div className="sample-group" role="group" aria-label={label}>
      <span className="small faint">{label}</span>
      <div className="sample-cards">{list.map((sample) => <SampleCard key={sample.id || 'blank'} sample={sample} {...(props.thumbs.get(sample.id) ? { thumb: props.thumbs.get(sample.id)! } : {})} version={props.version} current={sample.id === props.current} onChoose={() => props.onChoose(sample.id)} />)}</div>
    </div>
  ));
  return <>{group('数据集', normal)}{group('压测', stress)}{group('空白', blank)}</>;
}
