/**
 * 提取为子模板的确认弹窗（模板设计页票据 19）：列出会带走的参数与派生变量、基准与传的数据、适用尺寸范围，人看过再提取。
 * 提取本身在页面里做：先建空白工作副本，再把两边的改动记成一步撤销（template/session.ts 的 editMany），之后逐像素比对。
 */
import { useState } from 'react';
import { api } from '../api.js';
import { Modal } from '../components/modal.js';
import { Pair } from '../components/new-template.js';
import { ErrorBox } from '../components/problems.js';
import { problemsOf, useLoad } from '../hooks.js';
import type { JsonObject } from '../template/document.js';
import { isObject } from '../template/document.js';
import { planExtract, type SizeRange } from '../template/extract.js';
import type { Problem } from '../types.js';

export function ExtractDialog(props: {
  readonly document: JsonObject; readonly template: string; readonly path: string;
  /** 这块元素在图上各处的实际尺寸。 */
  readonly boxes: readonly { readonly width: number; readonly height: number }[];
  /** 已经读进来的模板名称：新名称不和它们重。 */
  readonly open: readonly string[];
  /** 预览还没出来时不能提取：提取之后要和提取前的图比对。 */
  readonly ready: boolean;
  readonly onClose: () => void;
  readonly onExtract: (name: string, sizeRange: SizeRange) => Promise<void>;
}) {
  const templates = useLoad(() => api.templates(), 'extract-templates');
  const taken = new Set([...(templates.data?.templates ?? []).map((item) => item.name), ...props.open]);
  const plan = planExtract(props.document, props.template, props.path, props.boxes, taken);
  const [name, setName] = useState<string>();
  const [size, setSize] = useState<readonly [string, string, string, string]>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<readonly Problem[]>();
  const chosen = name ?? plan.name;
  const values = size ?? [String(plan.sizeRange.width.min), String(plan.sizeRange.width.max), String(plan.sizeRange.height.min), String(plan.sizeRange.height.max)] as const;
  const numbers = values.map(Number);
  const sizeProblem = numbers.some((value) => !Number.isFinite(value) || value <= 0) ? '尺寸要填大于 0 的数'
    : numbers[0]! > numbers[1]! || numbers[2]! > numbers[3]! ? '最小不能大于最大' : undefined;
  const nameProblem = !chosen.trim() ? '要填名称' : taken.has(chosen.trim()) ? `已有模板「${chosen.trim()}」` : undefined;
  const base = isObject(props.document['base']) ? `${String(props.document['base']['name'])} v${String(props.document['base']['version'])}` : '没有基准';
  const blocked = plan.problem ?? (!props.ready ? '等预览出来再提取：提取之后要和现在的图逐像素比对。' : undefined);
  const set = (index: number) => (value: string) => setSize(values.map((item, at) => (at === index ? value : item)) as unknown as readonly [string, string, string, string]);
  const submit = async () => {
    if (blocked || sizeProblem || nameProblem) return;
    setBusy(true);
    setProblems(undefined);
    try {
      await props.onExtract(chosen.trim(), { width: { min: numbers[0]!, max: numbers[1]! }, height: { min: numbers[2]!, max: numbers[3]! } });
    } catch (error) { setProblems(problemsOf(error)); setBusy(false); }
  };
  const list = (items: readonly string[]) => items.map((item) => <code key={item} className="extract-name">{item}</code>);
  return (
    <Modal title="提取为子模板" onClose={props.onClose}>
      <form className="modal-form" aria-label="提取为子模板" data-testid="extract-dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="small muted">「{props.path.split('/').at(-1)}」搬进新模板，原地换成调用它的元素；位置、尺寸与显示留在调用上，图应该不变。</p>
        <div className="field">
          <label htmlFor="extract-name">新模板名称</label>
          <input id="extract-name" type="text" maxLength={200} value={chosen} onChange={(event) => setName(event.target.value)} />
        </div>
        <dl className="facts extract-facts">
          <dt>基准</dt><dd data-testid="extract-base">{base}，调用传当前数据</dd>
          <dt>对外参数</dt><dd data-testid="extract-parameters">{plan.parameters.length ? <>{list(plan.parameters)}<span className="small faint">由调用按同名传入</span></> : '没有用到参数'}</dd>
          <dt>派生变量</dt><dd data-testid="extract-derived">{plan.derived.length ? <>{list(plan.derived)}<span className="small faint">复制过去，原模板里的不动</span></> : '没有用到派生变量'}</dd>
        </dl>
        {plan.singleRef && <p className="hint" data-testid="extract-single-ref">这块只用到单引用字段「{plan.singleRef}」下面的值：也可以改成只传这个字段（新模板的基准换成它指向的数据定义），提取之后在调用的表单里改。</p>}
        <fieldset className="field plain">
          <legend className="field-label">适用尺寸范围</legend>
          <Pair label="宽" joiner="–" names={['宽 最小', '宽 最大']} values={[values[0], values[1]]} onChange={(index, value) => set(index)(value)} />
          <Pair label="高" joiner="–" names={['高 最小', '高 最大']} values={[values[2], values[3]]} onChange={(index, value) => set(2 + index)(value)} />
          <span className="hint">按图上{props.boxes.length > 1 ? ` ${props.boxes.length} 处` : '这一处'}的实际尺寸，两头放宽；之后在新模板的画板上能改。</span>
        </fieldset>
        {(blocked ?? sizeProblem ?? nameProblem) && <p className="prop-error" role="alert" data-testid="extract-problem">{blocked ?? sizeProblem ?? nameProblem}</p>}
        <ErrorBox problems={problems} title="没有提取" />
        <div className="modal-actions">
          <button type="button" className="quiet" onClick={props.onClose}>取消</button>
          <button type="submit" className="primary" disabled={Boolean(blocked ?? sizeProblem ?? nameProblem) || busy}>{busy ? '正在提取…' : '提取'}</button>
        </div>
      </form>
    </Modal>
  );
}
