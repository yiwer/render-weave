/** 问题清单：等级、位置与说明，格式与引擎的问题一致；位置写成给人看的说法。 */
import { fieldLabel, type ObjectField } from '../form/schema.js';
import type { Problem } from '../types.js';

export interface ProblemContext {
  /** 数据集的表单：字段路径写成显示名称。 */
  readonly form?: ObjectField;
  /** 对外参数的显示名称。 */
  readonly parameters?: ReadonlyMap<string, string>;
}

const INPUT_SOURCES: Readonly<Record<string, string>> = {
  'request.output': '出图参数', dataset: '数据集', 'dataset.staticSchema': '数据集选定的数据定义', 'request.dataset': '数据集', request: '请求',
};

export function locationText(problem: Problem, context: ProblemContext = {}): string {
  const location = problem.location;
  switch (location.kind) {
    case 'field': return `字段 ${context.form ? fieldLabel(context.form, location.path) : location.path}`;
    case 'parameter': return `参数 ${context.parameters?.get(location.name) ?? location.name}`;
    case 'element': return `元素 ${location.path}`;
    case 'check': return `检查项 ${location.template} / ${location.name}`;
    case 'variable': return `变量 ${location.template} / ${location.name}`;
    case 'definition': return `数据定义 ${location.schema}`;
    case 'input': return INPUT_SOURCES[location.source] ?? location.source;
  }
}

export const levelText = (problem: Problem) => (problem.level === 'severe' ? '严重' : '提示');

export function countText(problems: readonly Problem[]): string {
  const severe = problems.filter((problem) => problem.level === 'severe').length;
  return problems.length ? `问题 ${problems.length} 个（严重 ${severe}，提示 ${problems.length - severe}）` : '没有问题';
}

/** 一组问题；numbered 时在前面标号，与预览图上的标记对应。 */
export function ProblemList(props: {
  readonly problems: readonly Problem[];
  readonly context?: ProblemContext;
  readonly numbers?: ReadonlyMap<Problem, number>;
  readonly selected?: Problem;
  readonly onSelect?: (problem: Problem) => void;
  readonly label?: string;
}) {
  if (!props.problems.length) return null;
  return (
    <ul className="problems" aria-label={props.label ?? '问题清单'}>
      {props.problems.map((problem, index) => {
        const number = props.numbers?.get(problem);
        return (
          <li key={index} className={`problem ${problem.level}${problem === props.selected ? ' selected' : ''}`}>
            <button type="button" className="problem-button" onClick={() => props.onSelect?.(problem)} disabled={!props.onSelect}>
              {number !== undefined ? <span className="marker-number">{number}</span> : <span className="level-dot" aria-hidden="true" />}
              <span className="problem-where">{locationText(problem, props.context)}</span>
              <span className="problem-message">{problem.message}</span>
              <code className="problem-code">{problem.code} · {levelText(problem)}</code>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 请求失败时的问题说明（不分位置）。 */
export function ErrorBox(props: { readonly problems?: readonly Problem[]; readonly title?: string }) {
  if (!props.problems?.length) return null;
  return (
    <div className="error-box" role="alert">
      {props.title && <strong>{props.title}</strong>}
      <ProblemList problems={props.problems} />
    </div>
  );
}
