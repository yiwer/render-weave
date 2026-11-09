/**
 * 检查器顶部的状态样式（模板设计页票据 17，方案第 7 节）：按哪个变量，一排取值按钮带当前样例的命中数。
 * 选中一个取值后，下面的编辑都写进这个取值的覆盖（template/states.ts），舞台的手柄也写进去；"自身属性"回到不分状态。
 * 没覆盖的取值是虚线的"+ 未到站"；不会出现的取值标红，写明引擎会报的 template.unknownStateValue。
 */
import { useState } from 'react';
import type { ScopeVariable } from '../template/binding.js';
import type { JsonObject } from '../template/document.js';
import { normalizeValue, stateCandidates, stateChips, statesOf, unknownValueProblem } from '../template/states.js';

const CODE = 'template.unknownStateValue';

export function StateBar(props: {
  readonly element: JsonObject;
  readonly variables: readonly ScopeVariable[];
  /** 依据的全部取值：引擎求值给的，或按文档推出来的；推不出时 undefined，这时能手填取值。 */
  readonly known?: readonly string[];
  /** 当前样例里这个定义的各处与它们的取值；没有求值结果时 undefined，不显示命中数。 */
  readonly instances?: readonly { readonly path: string; readonly state?: string }[];
  readonly value?: string;
  readonly onValue: (value: string | undefined) => void;
  readonly onBy: (by: string | undefined) => void;
  readonly onLocate: (instance: string) => void;
}) {
  const info = statesOf(props.element), by = info.by;
  const variable = props.variables.find((item) => item.name === by), candidates = stateCandidates(props.variables);
  const chips = stateChips(props.element, { ...(props.known ? { known: props.known } : {}), ...(variable ? { type: variable.type } : {}), ...(props.instances ? { instances: props.instances } : {}), ...(props.value !== undefined ? { current: props.value } : {}) });
  const [draft, setDraft] = useState('');
  const [typed, setTyped] = useState<string>();
  const current = chips.find((chip) => chip.value === props.value);
  const covered = Object.keys(info.cases);
  const changeBy = (next: string) => {
    if (!next && covered.length && !window.confirm(`去掉状态样式会删掉 ${covered.length} 个取值的覆盖（${covered.join('、')}），确定？`)) return;
    props.onValue(undefined);
    props.onBy(next || undefined);
  };
  const add = () => {
    const value = normalizeValue(draft, variable?.type);
    if (!value || !by) return;
    const problem = unknownValueProblem(value, props.known, variable?.type, by);
    setTyped(problem ? `${problem}（${CODE}）` : undefined);
    if (problem) return;
    setDraft('');
    props.onValue(value);
  };
  // 写了但不会出现的取值合成一句，和引擎的说法一样："列出的取值 "已过站"、"本站" 不会出现"。
  const unknown = chips.filter((chip) => chip.problem);
  const reason = props.known ? `${by} 只可能是 ${props.known.join('、')}` : `${by} 是数值，取值要写成数字`;
  const problems = [
    ...(typed ? [typed] : []),
    ...(unknown.length ? [`列出的取值 ${unknown.map((chip) => `"${chip.value}"`).join('、')} 不会出现：${reason}（${CODE}）`] : []),
  ];
  return (
    <section className="state-bar" aria-label="状态样式" data-testid="state-bar">
      <div className="state-by">
        <span className="small muted">状态样式 · 按</span>
        <select aria-label="状态样式按哪个变量" value={by ?? ''} onChange={(event) => changeBy(event.target.value)}>
          <option value="">不分状态</option>
          {by && !candidates.some((item) => item.name === by) && <option value={by}>{by}</option>}
          {candidates.map((item) => <option key={item.name} value={item.name}>{item.label === item.name ? item.name : `${item.label}（${item.name}）`}</option>)}
        </select>
      </div>
      {by && (
        <>
          <div className="state-chips" role="group" aria-label="取值">
            <button type="button" className="state-chip own" aria-pressed={props.value === undefined} data-testid="state-chip" data-value="" onClick={() => props.onValue(undefined)}>自身属性</button>
            {chips.map((chip) => (
              <button key={chip.value} type="button" className={`state-chip${chip.covered ? '' : ' empty'}${chip.problem ? ' unknown' : ''}`} aria-pressed={props.value === chip.value}
                data-testid="state-chip" data-value={chip.value} title={chip.problem ?? (chip.covered ? '这个取值下写了覆盖' : '还没覆盖：选中后改的值写进这个取值')} onClick={() => props.onValue(chip.value)}
                aria-label={`${chip.value}${chip.count === undefined ? '' : `，当前样例 ${chip.count} 处`}${chip.covered ? '' : '，还没覆盖'}${chip.problem ? '，不会出现' : ''}`}>
                {chip.covered ? '' : '+ '}{chip.value}{chip.count !== undefined && <span className="state-count">{chip.count}</span>}
              </button>
            ))}
            {!props.known && (
              <input className="state-add" aria-label="添加取值" placeholder="+ 取值" value={draft}
                onChange={(event) => { setDraft(event.target.value); setTyped(undefined); }}
                onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
            )}
          </div>
          {problems.map((text) => <p key={text} className="prop-error" role="alert" data-testid="state-problem">{text}</p>)}
          <p className="small muted state-hint" data-testid="state-hint">
            {props.value === undefined ? '选一个取值，下面改的值就只在这个取值时生效。' : <>在「{props.value}」下改的值写进覆盖，圆点标出被覆盖的项。</>}
            {props.value !== undefined && current?.count !== undefined && (current.count > 0
              ? <>当前样例有 {current.count} 处。<button type="button" className="link" data-testid="state-locate" onClick={() => props.onLocate(current.first!)}>定位到第一处</button></>
              : <>当前样例里没有「{props.value}」：换个样例或调样例带上的参数再看。</>)}
          </p>
        </>
      )}
    </section>
  );
}
