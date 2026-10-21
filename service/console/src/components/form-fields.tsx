/**
 * 按编译产物生成的数据集表单（M248），排版按原型方案一（M282）：
 * - 顶层的简单字段排成网格，放在第一张卡片里；每个列表与数据定义引用各占一张卡片；
 * - 元素是对象的列表（如停靠站点），对象的字段都能放进单元格时排成表格：一行一项、一列一个字段；放不下时每项一组；
 * - 元素是简单值的列表（如班次时刻）排成一排小输入框；可选值固定的（如站名上方的标识）是一组勾选。
 * 字段用显示名称；每个输入框下面列出服务端问题清单里定位到它的问题（路径与引擎相同，如 stops[8].name），表单自己不判断对错。
 */
import { Fragment, useId, type ReactNode } from 'react';
import { childPath, itemPath, type FieldSpec, type ListField, type NamedField, type ObjectField, type ScalarField } from '../form/schema.js';
import { fromDateTimeInput, NumberText, toDateTimeInput } from '../form/value.js';
import type { Problem } from '../types.js';
import { ImageChoice } from './image-picker.js';

export type ProblemsByPath = ReadonlyMap<string, readonly Problem[]>;

export function problemsByPath(problems: readonly Problem[]): ProblemsByPath {
  const map = new Map<string, Problem[]>();
  for (const problem of problems) {
    if (problem.location.kind !== 'field') continue;
    map.set(problem.location.path, [...(map.get(problem.location.path) ?? []), problem]);
  }
  return map;
}

/** 让路径对应的输入框滚到眼前并获得焦点。 */
export function focusField(path: string): void {
  const field = document.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
  if (!field) return;
  field.scrollIntoView({ block: 'center', behavior: 'smooth' });
  field.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true });
}

function FieldProblems(props: { readonly id?: string; readonly problems?: readonly Problem[] }) {
  if (!props.problems?.length) return null;
  return (
    <ul className="field-problems" id={props.id}>
      {props.problems.map((problem, index) => <li key={index} className={problem.level} role={problem.level === 'severe' ? 'alert' : undefined}>{problem.message}</li>)}
    </ul>
  );
}

function hintOf(spec: FieldSpec): string | undefined {
  switch (spec.kind) {
    case 'text': return spec.maxLength !== undefined ? `最多 ${spec.maxLength} 字` : undefined;
    case 'number': {
      const range = spec.minimum !== undefined && spec.maximum !== undefined ? `${spec.minimum}–${spec.maximum}`
        : spec.minimum !== undefined ? `不小于 ${spec.minimum}` : spec.maximum !== undefined ? `不大于 ${spec.maximum}` : '';
      return [spec.integer ? '整数' : '', range].filter(Boolean).join('，') || undefined;
    }
    case 'time': return '如 08:30';
    case 'list': {
      const count = spec.minItems !== undefined && spec.maxItems !== undefined ? `${spec.minItems}–${spec.maxItems} 项`
        : spec.maxItems !== undefined ? `最多 ${spec.maxItems} 项` : spec.minItems !== undefined ? `至少 ${spec.minItems} 项` : undefined;
      return count;
    }
    default: return undefined;
  }
}

const isScalar = (spec: FieldSpec): spec is ScalarField => spec.kind !== 'list' && spec.kind !== 'object';
/** 可选值固定的简单值列表：一组勾选。 */
const enumList = (spec: FieldSpec): spec is ListField & { items: ScalarField & { enum: readonly (string | number)[] } } =>
  spec.kind === 'list' && isScalar(spec.items) && 'enum' in spec.items && Array.isArray(spec.items.enum) && spec.items.enum.length > 0;
/** 对象的字段都能放进单元格：简单值，或可选值固定的列表。 */
const tabular = (spec: ObjectField) => spec.fields.every(({ spec: field }) => isScalar(field) || enumList(field));

interface InputProps {
  readonly spec: ScalarField;
  readonly id: string;
  readonly value: unknown;
  readonly onChange: (value: unknown) => void;
  readonly describedBy?: string;
  readonly invalid: boolean;
  readonly label: string;
  /** 列表项里的输入框：清空时保留空值，由服务端报问题。 */
  readonly inList: boolean;
  /** 在单元格里：用无文字的标签（aria-label），图片用缩略按钮。 */
  readonly compact?: boolean;
}

function ScalarInput(props: InputProps) {
  const { spec, id, value, onChange } = props;
  // 必填只作提示（aria-required），不加 required 属性：浏览器自己的校验会挡住提交，校验以服务端为准。
  const common = {
    id, 'aria-invalid': props.invalid || undefined, 'aria-describedby': props.describedBy,
    'aria-required': (spec.required && !props.inList) || undefined, ...(props.compact ? { 'aria-label': props.label } : {}),
  };
  const text = typeof value === 'string' ? value : '';
  /** 清空时：对象里的可选字段省略这个键；列表项保留空文本。 */
  const cleared = props.inList ? '' : undefined;
  switch (spec.kind) {
    case 'text':
      if (spec.enum) {
        return (
          <select {...common} value={text} onChange={(event) => onChange(event.target.value === '' ? cleared : event.target.value)}>
            <option value="">（未填）</option>
            {spec.enum.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        );
      }
      return <input {...common} type="text" value={text} onChange={(event) => onChange(event.target.value === '' ? cleared : event.target.value)} />;
    case 'number': {
      const raw = value instanceof NumberText ? value.text : typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
      if (spec.enum) {
        return (
          <select {...common} value={raw} onChange={(event) => onChange(event.target.value === '' ? cleared : new NumberText(event.target.value))}>
            <option value="">（未填）</option>
            {spec.enum.map((option) => <option key={option} value={String(option)}>{option}</option>)}
          </select>
        );
      }
      return <input {...common} type="text" inputMode={spec.integer ? 'numeric' : 'decimal'} value={raw}
        onChange={(event) => onChange(event.target.value.trim() === '' ? (props.inList ? new NumberText('') : undefined) : new NumberText(event.target.value))} />;
    }
    case 'date':
      return <input {...common} type="date" value={text} onChange={(event) => onChange(event.target.value === '' ? cleared : event.target.value)} />;
    case 'time':
      return <input {...common} type="time" step={/:\d\d:\d\d$/.test(text) ? 1 : 60} value={text} onChange={(event) => onChange(event.target.value === '' ? cleared : event.target.value)} />;
    case 'datetime':
      return <input {...common} type="datetime-local" step={1} value={text ? toDateTimeInput(text) : ''} onChange={(event) => onChange(fromDateTimeInput(event.target.value) ?? cleared)} />;
    case 'boolean':
      return (
        <select {...common} value={value === true ? 'true' : value === false ? 'false' : ''} onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}>
          <option value="">（未填）</option>
          <option value="true">是</option>
          <option value="false">否</option>
        </select>
      );
    case 'image':
      return <ImageChoice id={id} label={props.label} value={text || undefined} sources={spec.sources} invalid={props.invalid} compact={props.compact ?? false}
        onChange={(next) => onChange(next ?? cleared)} />;
  }
}

interface FieldProps<S extends FieldSpec> {
  readonly spec: S;
  readonly value: unknown;
  readonly path: string;
  readonly onChange: (value: unknown) => void;
  readonly problems: ProblemsByPath;
}

/** 一个简单字段：标签、输入框、提示与问题。 */
function ScalarFieldView(props: FieldProps<ScalarField>) {
  const id = useId(), problemId = `${id}-problems`, problems = props.problems.get(props.path), hint = hintOf(props.spec);
  return (
    <div className={`field${props.spec.kind === 'image' ? ' wide' : ''}`} data-path={props.path}>
      <label htmlFor={id} className={props.spec.required ? 'required' : undefined}>{props.spec.title}</label>
      <ScalarInput spec={props.spec} id={id} value={props.value} onChange={props.onChange} label={props.spec.title} inList={false}
        invalid={Boolean(problems?.some((problem) => problem.level === 'severe'))} {...(problems ? { describedBy: problemId } : {})} />
      {hint && <span className="hint">{hint}</span>}
      <FieldProblems id={problemId} problems={problems} />
    </div>
  );
}

const objectOf = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {});
const withKey = (object: Record<string, unknown>, name: string, next: unknown) => {
  const updated = { ...object };
  if (next === undefined) delete updated[name];
  else updated[name] = next;
  return updated;
};

/** 一组字段：简单字段排成网格，其余各占整行。 */
function FieldGrid(props: FieldProps<ObjectField>) {
  const value = objectOf(props.value);
  return (
    <div className="fields">
      {props.spec.fields.map(({ name, spec }) => {
        const path = childPath(props.path, name), change = (next: unknown) => props.onChange(withKey(value, name, next));
        if (isScalar(spec)) return <ScalarFieldView key={name} spec={spec} value={value[name]} path={path} onChange={change} problems={props.problems} />;
        return (
          <div className="wide" key={name}>
            <Compound spec={spec} value={value[name]} path={path} onChange={change} problems={props.problems} />
          </div>
        );
      })}
    </div>
  );
}

/** 列表或数据定义引用（不在卡片里时）：带标题的一组。 */
function Compound(props: FieldProps<ListField | ObjectField>) {
  const id = useId(), hint = hintOf(props.spec);
  return (
    <fieldset className="group" data-path={props.path} aria-labelledby={`${id}-title`}>
      <legend id={`${id}-title`} className={props.spec.required ? 'required' : undefined}>{props.spec.title}{hint && <span className="hint"> · {hint}</span>}</legend>
      <FieldProblems problems={props.problems.get(props.path)} />
      <CompoundBody {...props} />
    </fieldset>
  );
}

function CompoundBody(props: FieldProps<ListField | ObjectField>) {
  const { spec } = props;
  if (spec.kind === 'object') {
    if (props.value === undefined) {
      return <div className="group-actions"><button type="button" className="small quiet" onClick={() => props.onChange({})}>填写{spec.title}</button></div>;
    }
    return (
      <>
        <FieldGrid {...props} spec={spec} />
        {!spec.required && <div className="group-actions"><button type="button" className="link" onClick={() => props.onChange(undefined)}>不填{spec.title}</button></div>}
      </>
    );
  }
  if (enumList(spec)) return <EnumChecks {...props} spec={spec} />;
  if (isScalar(spec.items) && spec.items.kind !== 'image') return <ScalarChips {...props} spec={spec} />;
  if (spec.items.kind === 'object' && tabular(spec.items)) return <ListTable {...props} spec={spec} items={spec.items} />;
  return <ListGroups {...props} spec={spec} />;
}

/**
 * 数据集的根：顶层的简单字段放进第一张卡片（标题是数据定义的显示名称），列表与引用各占一张卡片。
 */
export function DatasetForm(props: FieldProps<ObjectField> & { readonly title?: string }) {
  const value = objectOf(props.value);
  const scalars = props.spec.fields.filter(({ spec }) => isScalar(spec));
  const others = props.spec.fields.filter(({ spec }) => !isScalar(spec)) as (NamedField & { spec: ListField | ObjectField })[];
  return (
    <>
      {scalars.length > 0 && (
        <section className="card" aria-label={props.title ?? props.spec.title}>
          <h2>{props.title ?? props.spec.title}</h2>
          <FieldGrid spec={{ ...props.spec, fields: scalars }} value={value} path="" problems={props.problems} onChange={(next) => props.onChange({ ...value, ...objectOf(next) })} />
        </section>
      )}
      {others.map(({ name, spec }) => {
        const path = childPath('', name), hint = hintOf(spec), count = Array.isArray(value[name]) ? (value[name] as unknown[]).length : undefined;
        return (
          <section className="card" key={name} data-path={path} aria-label={spec.title}>
            <div className="card-head">
              <h2 className={spec.required ? 'required' : undefined}>{spec.title}</h2>
              <span className="hint">{[count === undefined ? '' : `${count} 项`, hint ?? ''].filter(Boolean).join(' · ')}</span>
            </div>
            <FieldProblems problems={props.problems.get(path)} />
            <CompoundBody spec={spec} value={value[name]} path={path} problems={props.problems} onChange={(next) => props.onChange(withKey(value, name, next))} />
          </section>
        );
      })}
    </>
  );
}

function emptyItem(spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'object': return {};
    case 'number': return new NumberText('');
    case 'boolean': return false;
    default: return '';
  }
}

/** 列表的增删与调序；列表空了且可选时删去这个键。 */
function useList(props: FieldProps<ListField>) {
  const items = Array.isArray(props.value) ? props.value : [];
  const update = (next: unknown[]) => props.onChange(next.length || props.spec.required ? next : undefined);
  return {
    items,
    full: props.spec.maxItems !== undefined && items.length >= props.spec.maxItems,
    add: () => update([...items, emptyItem(props.spec.items)]),
    set: (index: number, next: unknown) => update(items.map((old, i) => (i === index ? next : old))),
    remove: (index: number) => update(items.filter((_, i) => i !== index)),
    move: (from: number, to: number) => {
      const next = [...items];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      update(next);
    },
  };
}

function RowTools(props: { readonly label: string; readonly index: number; readonly count: number; readonly move: (from: number, to: number) => void; readonly remove: (index: number) => void }) {
  const { index } = props;
  return (
    <span className="row-tools">
      <button type="button" className="icon" aria-label={`上移${props.label}`} disabled={index === 0} onClick={() => props.move(index, index - 1)}>↑</button>
      <button type="button" className="icon" aria-label={`下移${props.label}`} disabled={index === props.count - 1} onClick={() => props.move(index, index + 1)}>↓</button>
      <button type="button" className="icon" aria-label={`删除${props.label}`} onClick={() => props.remove(index)}>×</button>
    </span>
  );
}

/** 简单值的列表：一排小输入框。 */
function ScalarChips(props: FieldProps<ListField>) {
  const list = useList(props), spec = props.spec.items as ScalarField;
  return (
    <div className="chips">
      {list.items.map((item, index) => {
        const path = itemPath(props.path, index), problems = props.problems.get(path), label = `${props.spec.title} 第 ${index + 1} 项`;
        return (
          <span key={index} className="field" data-path={path}>
            <span className="chip-input">
              <ScalarInput spec={spec} id={`${props.path}-${index}`} value={item} onChange={(next) => list.set(index, next)} label={label} inList compact
                invalid={Boolean(problems?.some((problem) => problem.level === 'severe'))} />
              <button type="button" className="icon" aria-label={`删除${label}`} onClick={() => list.remove(index)}>×</button>
            </span>
            <FieldProblems problems={problems} />
          </span>
        );
      })}
      <button type="button" className="small quiet" disabled={list.full} onClick={list.add}>+ 添加{props.spec.title}</button>
    </div>
  );
}

/** 可选值固定的列表：每个可选值一个勾选，按可选值的顺序保存。 */
function EnumChecks(props: FieldProps<ListField> & { readonly label?: string; readonly compact?: boolean }) {
  const items = Array.isArray(props.value) ? props.value : [];
  const options = (props.spec.items as ScalarField & { enum: readonly (string | number)[] }).enum;
  const toggle = (option: string | number, on: boolean) => {
    const chosen = on ? [...items, option] : items.filter((item) => item !== option);
    const ordered = options.filter((candidate) => chosen.includes(candidate));
    props.onChange(ordered.length || props.spec.required ? ordered : undefined);
  };
  return (
    <span className="chips" role="group" aria-label={props.label ?? props.spec.title} data-path={props.compact ? props.path : undefined}>
      {options.map((option) => (
        <label key={String(option)} className="toggle-chip">
          <input type="checkbox" checked={items.includes(option)} onChange={(event) => toggle(option, event.target.checked)} />
          {String(option)}
        </label>
      ))}
    </span>
  );
}

/** 对象的列表排成表格：一行一项，一列一个字段。 */
function ListTable(props: FieldProps<ListField> & { readonly items: ObjectField }) {
  const list = useList(props), columns = props.items.fields;
  return (
    <>
      <div className="table-box">
        <table className="list-table">
          <thead>
            <tr>
              <th scope="col">序号</th>
              {columns.map(({ name, spec }) => <th scope="col" key={name} className={spec.required ? 'required' : undefined}>{spec.title}</th>)}
              <th scope="col"><span className="visually-hidden">调整</span></th>
            </tr>
          </thead>
          <tbody>
            {list.items.map((item, index) => {
              const rowPath = itemPath(props.path, index), value = objectOf(item), rowLabel = `${props.spec.title} 第 ${index + 1} 项`;
              const rowProblems = props.problems.get(rowPath);
              const problemInRow = [...props.problems.keys()].some((path) => path === rowPath || path.startsWith(`${rowPath}.`) || path.startsWith(`${rowPath}[`));
              return (
                <Fragment key={index}>
                  <tr className={problemInRow ? 'has-problem' : undefined} data-path={rowPath} aria-label={rowLabel}>
                    <td className="index">{index + 1}</td>
                    {columns.map(({ name, spec }) => {
                      const path = childPath(rowPath, name), problems = props.problems.get(path), label = `${rowLabel} ${spec.title}`;
                      const change = (next: unknown) => list.set(index, withKey(value, name, next));
                      return (
                        <td key={name} data-path={path}>
                          {isScalar(spec) ? (
                            <ScalarInput spec={spec} id={`${path}-input`} value={value[name]} onChange={change} label={label} inList={false} compact
                              invalid={Boolean(problems?.some((problem) => problem.level === 'severe'))} />
                          ) : (
                            <EnumChecks spec={spec as ListField} value={value[name]} path={path} problems={props.problems} onChange={change} label={label} compact />
                          )}
                          <FieldProblems problems={problems} />
                        </td>
                      );
                    })}
                    <td className="row-tools"><RowTools label={rowLabel} index={index} count={list.items.length} move={list.move} remove={list.remove} /></td>
                  </tr>
                  {rowProblems && <tr><td /><td colSpan={columns.length + 1}><FieldProblems problems={rowProblems} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="group-actions" style={{ marginTop: 12 }}>
        <button type="button" className="small quiet" disabled={list.full} onClick={list.add}>+ 添加{props.spec.title}</button>
      </div>
    </>
  );
}

/** 放不进表格的列表：每项一组。 */
function ListGroups(props: FieldProps<ListField>) {
  const list = useList(props), { spec } = props;
  return (
    <>
      {list.items.length === 0 && <p className="muted">没有项。</p>}
      {list.items.map((item, index) => {
        const path = itemPath(props.path, index), label = `${spec.title} 第 ${index + 1} 项`;
        let body: ReactNode;
        if (spec.items.kind === 'object') body = <FieldGrid spec={spec.items} value={item} path={path} problems={props.problems} onChange={(next) => list.set(index, next)} />;
        else if (isScalar(spec.items)) {
          body = <ScalarFieldView spec={{ ...spec.items, title: `第 ${index + 1} 项` }} value={item} path={path} problems={props.problems} onChange={(next) => list.set(index, next)} />;
        } else body = <Compound spec={spec.items} value={item} path={path} problems={props.problems} onChange={(next) => list.set(index, next)} />;
        return (
          <div className="list-item" role="group" aria-label={label} key={index} data-path={spec.items.kind === 'object' ? path : undefined}>
            <div className="list-item-head">
              <span>第 {index + 1} 项</span>
              <RowTools label={label} index={index} count={list.items.length} move={list.move} remove={list.remove} />
            </div>
            <FieldProblems problems={spec.items.kind === 'object' ? props.problems.get(path) : undefined} />
            {body}
          </div>
        );
      })}
      <div className="group-actions"><button type="button" className="small quiet" disabled={list.full} onClick={list.add}>+ 添加{spec.title}</button></div>
    </>
  );
}
