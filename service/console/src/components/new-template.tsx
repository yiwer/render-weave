/**
 * 从空白新建模板（模板设计页票据 18，M362 的弹窗）：名称、基准、适用尺寸范围与默认尺寸，建好是一块空画板的工作副本，第一次发布记修订 1。
 * - 基准是静态数据定义的确切版本，或内置的空数据定义（不用数据）；从循环与调用的表单打开时基准预先填好，不能改；
 * - 默认尺寸不是 DSL 里的数：记成设计页样例带上的尺寸（存在这个浏览器里），出图仍由请求给尺寸；
 * - 被调模板的实际尺寸由调用方分配，适用尺寸范围默认放宽。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { writeStored } from '../design/tray.js';
import { versionLabel } from '../form/schema-version.js';
import { problemsOf, useLoad } from '../hooks.js';
import type { Problem, SchemaRef } from '../types.js';
import { Modal } from './modal.js';
import { ErrorBox } from './problems.js';

const EMPTY: SchemaRef = { name: '空数据定义', version: 1 };
const keyOf = (ref: SchemaRef) => `${ref.name}\n${String(ref.version)}`;

/** 一行两个数：宽 [最小] – [最大] mm，默认尺寸 [宽] × [高] mm。 */
export function Pair(props: { readonly label: string; readonly joiner: string; readonly names: readonly [string, string]; readonly values: readonly [string, string]; readonly onChange: (index: 0 | 1, value: string) => void }) {
  return (
    <div className="pair-row">
      <span className="pair-label">{props.label}</span>
      <input type="text" inputMode="decimal" aria-label={props.names[0]} value={props.values[0]} onChange={(event) => props.onChange(0, event.target.value)} />
      <span className="faint">{props.joiner}</span>
      <input type="text" inputMode="decimal" aria-label={props.names[1]} value={props.values[1]} onChange={(event) => props.onChange(1, event.target.value)} />
      <span className="faint">mm</span>
    </div>
  );
}

export function NewTemplate(props: {
  readonly onClose: () => void;
  readonly onCreated: (name: string) => void;
  /** 从循环与调用的表单打开：基准预先填好，不能改；说明这一份数据从哪来。 */
  readonly base?: { readonly ref: SchemaRef; readonly why: string };
}) {
  const fixed = props.base;
  const schemas = useLoad(() => (fixed ? Promise.resolve(undefined) : api.staticSchemas()), 'new-template-schemas');
  const [name, setName] = useState('');
  const [base, setBase] = useState<string>(fixed ? keyOf(fixed.ref) : '');
  // 被调模板的尺寸由调用方分配：范围放宽，不设默认尺寸。
  const [size, setSize] = useState(fixed
    ? { widthMin: '1', widthMax: '2000', heightMin: '1', heightMax: '2000', width: '', height: '' }
    : { widthMin: '100', widthMax: '100', heightMin: '70', heightMax: '70', width: '100', height: '70' });
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const options = [...(schemas.data?.staticSchemas ?? []).map((schema) => ({ ref: { name: schema.name, version: schema.version }, label: `${schema.displayName}（${schema.name} ${versionLabel(schema.version)}）` })), { ref: EMPTY, label: '空数据定义 v1（不用数据）' }];
  const chosen = fixed?.ref ?? options.find((option) => keyOf(option.ref) === base)?.ref;
  const number = (text: string) => (text.trim() === '' ? undefined : Number(text));
  const range = { width: { min: number(size.widthMin), max: number(size.widthMax) }, height: { min: number(size.heightMin), max: number(size.heightMax) } };
  const sizeProblem = (['width', 'height'] as const).map((axis) => {
    const { min, max } = range[axis], label = axis === 'width' ? '宽' : '高';
    if (min === undefined || max === undefined || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) return `${label}的最小、最大要填大于 0 的数`;
    return min > max ? `${label}的最小不能大于最大` : undefined;
  }).find(Boolean);
  const defaults = { width: number(size.width), height: number(size.height) };
  const defaultProblem = fixed || sizeProblem ? undefined : (['width', 'height'] as const).map((axis) => {
    const value = defaults[axis], { min, max } = range[axis];
    return value === undefined || !Number.isFinite(value) || value < min! || value > max! ? `默认${axis === 'width' ? '宽' : '高'}要在适用范围里` : undefined;
  }).find(Boolean);
  const invalid = !name.trim() || !chosen || Boolean(sizeProblem) || Boolean(defaultProblem);
  const create = async () => {
    if (invalid || !chosen) return;
    setBusy(true);
    setProblems(undefined);
    try {
      const sizeRange = { width: range.width as { min: number; max: number }, height: range.height as { min: number; max: number } };
      const created = await api.createTemplate({ name: name.trim(), base: chosen, sizeRange });
      if (!fixed) writeStored(created.name, { trial: { parameters: {}, width: defaults.width!, height: defaults.height! } });
      props.onCreated(created.name);
    } catch (error) { setProblems(problemsOf(error)); }
    finally { setBusy(false); }
  };
  const set = (key: keyof typeof size) => (value: string) => setSize((now) => ({ ...now, [key]: value }));
  return (
    <Modal title="新建模板" onClose={props.onClose}>
      <form className="modal-form" aria-label="新建模板" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="field">
          <label htmlFor="new-template-name">名称</label>
          <input id="new-template-name" type="text" maxLength={200} value={name} onChange={(event) => setName(event.target.value)} />
          <span className="hint">名称是模板的身份，出图请求按它找模板；建好就不能改。</span>
        </div>
        <div className="field">
          {fixed ? (
            <>
              <span className="field-label">基准</span>
              <span data-testid="new-template-base">{fixed.ref.name} v{String(fixed.ref.version)}</span>
              <span className="hint">{fixed.why}</span>
            </>
          ) : (
            <>
              <label htmlFor="new-template-base">基准</label>
              <select id="new-template-base" value={base} onChange={(event) => setBase(event.target.value)}>
                <option value="" disabled>选一个数据定义的版本</option>
                {options.map((option) => <option key={keyOf(option.ref)} value={keyOf(option.ref)}>{option.label}</option>)}
              </select>
              <span className="hint">模板读这个版本的数据；之后换基准要改模板里用到的字段。</span>
            </>
          )}
        </div>
        <fieldset className="field plain">
          <legend className="field-label">适用尺寸范围</legend>
          <Pair label="宽" joiner="–" names={['宽 最小', '宽 最大']} values={[size.widthMin, size.widthMax]} onChange={(index, value) => set(index ? 'widthMax' : 'widthMin')(value)} />
          <Pair label="高" joiner="–" names={['高 最小', '高 最大']} values={[size.heightMin, size.heightMax]} onChange={(index, value) => set(index ? 'heightMax' : 'heightMin')(value)} />
          <span className="hint">{fixed ? '被调模板的实际尺寸由调用它的地方分配，范围放宽就行。' : '最小等于最大就是固定尺寸。'}</span>
        </fieldset>
        {!fixed && (
          <fieldset className="field plain">
            <legend className="field-label">默认尺寸</legend>
            <Pair label="宽 × 高" joiner="×" names={['默认宽', '默认高']} values={[size.width, size.height]} onChange={(index, value) => set(index ? 'height' : 'width')(value)} />
            <span className="hint">设计页样例带先用这个尺寸出草稿；出图时由请求给尺寸。</span>
          </fieldset>
        )}
        {(sizeProblem ?? defaultProblem) && <p className="prop-error" role="alert" data-testid="new-template-problem">{sizeProblem ?? defaultProblem}</p>}
        <ErrorBox problems={problems} title="没有新建" />
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={props.onClose}>取消</button>
          <button type="submit" className="primary" disabled={invalid || busy}>{busy ? '正在新建…' : '新建'}</button>
        </div>
      </form>
    </Modal>
  );
}
