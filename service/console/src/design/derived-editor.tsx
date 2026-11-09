/**
 * 派生变量的编辑器（模板设计页票据 16，方案第 6 节）：每种运算一个表单，不做表达式输入框（ADR-0004）。
 * 分支每行是"当 [左] [比较] [右]，取 [值]"，最后一行"否则取"；当前样例命中的那一支高亮，变量旁边显示当前值。写回是 template/derived.ts。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ValueText } from '../components/value-text.js';
import { isObject, type JsonObject } from '../template/document.js';
import { addBranch, ARITHMETIC, BRANCH_TYPES, COMPARES, EMPTY_VALUE, itemType, moveBranch, OPS, removeBranch, typeEditable, UNARY, withBranchType, withCompareOp, withConditionKind, type DerivedOp, type Variable } from '../template/derived.js';
import type { InspectedValue } from '../types.js';

/** 编辑器要的变量：名字、显示名称、类型、当前值；列表另有每一项的类型。 */
export interface EditorVariable extends Variable { readonly label: string; readonly value?: InspectedValue }

const TYPE_NAMES: Readonly<Record<string, string>> = { text: '文本', number: '数值', boolean: '布尔', color: '颜色', date: '日期', time: '时刻', datetime: '时间', image: '图片', list: '列表', ref: '引用' };

/** 固定值：按类型给输入框；数值打不成数时不写回。 */
export function LiteralInput(props: { readonly type: string; readonly value: unknown; readonly label: string; readonly onChange: (value: string | number | boolean) => void }) {
  const { type, value } = props;
  const [draft, setDraft] = useState(String(value ?? ''));
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);
  if (type === 'boolean') {
    return (
      <select aria-label={props.label} value={String(value === true)} onChange={(event) => props.onChange(event.target.value === 'true')}>
        <option value="true">是</option><option value="false">否</option>
      </select>
    );
  }
  return (
    <input type="text" aria-label={props.label} className={type === 'number' ? 'prop-number' : undefined} value={draft} placeholder={type === 'text' ? '空文本' : ''}
      onChange={(event) => {
        setDraft(event.target.value);
        if (type !== 'number') { props.onChange(event.target.value); return; }
        const number = Number(event.target.value);
        if (event.target.value.trim() !== '' && Number.isFinite(number)) props.onChange(number);
      }} />
  );
}

/** 运算数：变量或固定值。type 给了时变量只列这个类型的（结果、数值运算），固定值按它给输入框。 */
export function OperandInput(props: { readonly value: unknown; readonly variables: readonly EditorVariable[]; readonly type?: string | undefined; readonly label: string; readonly onChange: (operand: JsonObject) => void }) {
  const { value, variables, type, label } = props;
  const isVar = isObject(value) && typeof value['var'] === 'string';
  const name = isVar ? String((value as JsonObject)['var']) : '';
  const candidates = type ? variables.filter((item) => item.type === type) : variables;
  const current = variables.find((item) => item.name === name);
  const literalType = type ?? (isObject(value) && typeof value['value'] === 'number' ? 'number' : isObject(value) && typeof value['value'] === 'boolean' ? 'boolean' : 'text');
  return (
    <span className="operand" data-testid="operand">
      <select aria-label={`${label}的写法`} className="operand-kind" value={isVar ? 'var' : 'value'}
        onChange={(event) => props.onChange(event.target.value === 'var' ? { var: candidates[0]?.name ?? variables[0]?.name ?? '' } : { value: EMPTY_VALUE[literalType] ?? '' })}>
        <option value="var">变量</option>
        <option value="value">固定值</option>
      </select>
      {isVar
        ? (
          <select aria-label={label} value={name} onChange={(event) => props.onChange({ var: event.target.value })}>
            {!current && <option value={name}>{name || '选一个变量'}</option>}
            {(candidates.some((item) => item.name === name) ? candidates : current ? [current, ...candidates] : candidates).map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
          </select>
        )
        : <LiteralInput type={literalType} value={isObject(value) ? value['value'] : ''} label={label} onChange={(next) => props.onChange({ value: next })} />}
      {isVar && current && <ValueText value={current.value} type={current.type} />}
    </span>
  );
}

function CompareEditor(props: { readonly compare: JsonObject; readonly variables: readonly EditorVariable[]; readonly label: string; readonly onChange: (compare: JsonObject) => void }) {
  const { compare, variables } = props;
  const left = compare['left'], op = String(compare['op'] ?? 'eq');
  const leftType = isObject(left) && typeof left['var'] === 'string' ? variables.find((item) => item.name === left['var'])?.type : undefined;
  return (
    <span className="compare" data-testid="compare">
      <OperandInput value={left} variables={variables} label={`${props.label}的左侧`} onChange={(next) => props.onChange({ ...compare, left: next })} />
      <select aria-label={`${props.label}的比较`} value={op} onChange={(event) => props.onChange(withCompareOp(compare, event.target.value))}>
        {COMPARES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
      </select>
      {!UNARY.has(op) && <OperandInput value={compare['right']} variables={variables} type={leftType === 'list' || leftType === 'ref' ? undefined : leftType} label={`${props.label}的右侧`} onChange={(next) => props.onChange({ ...compare, right: next })} />}
    </span>
  );
}

/** 条件：单个比较，或单层的全部成立、任一成立。 */
function ConditionEditor(props: { readonly when: unknown; readonly variables: readonly EditorVariable[]; readonly label: string; readonly onChange: (when: JsonObject) => void }) {
  const { when, variables } = props;
  const kind = isObject(when) && Array.isArray(when['all']) ? 'all' : isObject(when) && Array.isArray(when['any']) ? 'any' : 'single';
  const compares = kind === 'single' ? [isObject(when) ? when : { left: { value: '' }, op: 'notEmpty' }] : (when as JsonObject)[kind] as JsonObject[];
  const write = (next: readonly JsonObject[]) => props.onChange(kind === 'single' ? next[0]! : { [kind]: next });
  return (
    <span className="condition">
      <select aria-label={`${props.label}的写法`} className="condition-kind" value={kind} onChange={(event) => props.onChange(withConditionKind(when, event.target.value as 'single' | 'all' | 'any'))}>
        <option value="single">单个条件</option><option value="all">全部成立</option><option value="any">任一成立</option>
      </select>
      {compares.map((compare, index) => (
        <span key={index} className="condition-item">
          <CompareEditor compare={compare} variables={variables} label={`${props.label}第 ${index + 1} 个条件`} onChange={(next) => write(compares.map((item, at) => (at === index ? next : item)))} />
          {kind !== 'single' && compares.length > 1 && <button type="button" className="link danger" onClick={() => write(compares.filter((_, at) => at !== index))}>去掉</button>}
        </span>
      ))}
      {kind !== 'single' && <button type="button" className="link" onClick={() => write([...compares, { left: compares[0]?.['left'] ?? { value: '' }, op: 'notEmpty' }])}>再加一个条件</button>}
    </span>
  );
}

function BranchEditor(props: { readonly definition: JsonObject; readonly variables: readonly EditorVariable[]; readonly hit?: number | undefined; readonly onChange: (next: JsonObject) => void }) {
  const { definition, variables, hit } = props, type = String(definition['type'] ?? 'text');
  const branches = Array.isArray(definition['branches']) ? (definition['branches'] as unknown[]).filter(isObject) : [];
  const setBranch = (index: number, next: JsonObject) => props.onChange({ ...definition, branches: branches.map((item, at) => (at === index ? next : item)) });
  return (
    <div className="branches" data-testid="branch-editor">
      {branches.map((branch, index) => (
        <div key={index} className={`branch-row${hit === index ? ' hit' : ''}`} data-testid="branch-row" data-hit={hit === index ? 'true' : undefined}>
          <span className="branch-word">当</span>
          <ConditionEditor when={branch['when']} variables={variables} label={`第 ${index + 1} 支`} onChange={(when) => setBranch(index, { ...branch, when })} />
          <span className="branch-word">取</span>
          <OperandInput value={branch['then']} variables={variables} type={type} label={`第 ${index + 1} 支的取值`} onChange={(then) => setBranch(index, { ...branch, then })} />
          <span className="branch-tools">
            {hit === index && <span className="branch-hit-tag">当前命中</span>}
            <button type="button" className="link" aria-label={`第 ${index + 1} 支上移`} disabled={index === 0} onClick={() => { const next = moveBranch(definition, index, -1); if (next) props.onChange(next); }}>↑</button>
            <button type="button" className="link" aria-label={`第 ${index + 1} 支下移`} disabled={index === branches.length - 1} onClick={() => { const next = moveBranch(definition, index, 1); if (next) props.onChange(next); }}>↓</button>
            <button type="button" className="link danger" aria-label={`去掉第 ${index + 1} 支`} disabled={branches.length <= 1} onClick={() => { const next = removeBranch(definition, index); if (next) props.onChange(next); }}>去掉</button>
          </span>
        </div>
      ))}
      <div className={`branch-row otherwise${hit === -1 ? ' hit' : ''}`} data-testid="branch-otherwise" data-hit={hit === -1 ? 'true' : undefined}>
        <span className="branch-word">否则取</span>
        <OperandInput value={definition['otherwise']} variables={variables} type={type} label="否则的取值" onChange={(otherwise) => props.onChange({ ...definition, otherwise })} />
        {hit === -1 && <span className="branch-tools"><span className="branch-hit-tag">当前命中</span></span>}
      </div>
      <button type="button" className="small quiet" onClick={() => props.onChange(addBranch(definition, variables))}>加一支</button>
      <p className="small faint">按顺序取第一个成立的那一支，顺序就是意思。</p>
    </div>
  );
}

function PositionInput(props: { readonly value: unknown; readonly variables: readonly EditorVariable[]; readonly onChange: (position: unknown) => void }) {
  const kind = props.value === 'first' || props.value === 'last' ? props.value : 'index';
  return (
    <span className="operand">
      <select aria-label="取哪一项" value={kind} onChange={(event) => props.onChange(event.target.value === 'index' ? { index: { value: 1 } } : event.target.value)}>
        <option value="first">第一项</option><option value="last">最后一项</option><option value="index">第几项</option>
      </select>
      {kind === 'index' && <OperandInput value={isObject(props.value) ? props.value['index'] : { value: 1 }} variables={props.variables} type="number" label="序号（从 1 开始）" onChange={(index) => props.onChange({ index })} />}
    </span>
  );
}

const Row = (props: { readonly label: string; readonly children: ReactNode }) => (
  <div className="prop"><span className="prop-label">{props.label}</span><div className="prop-control">{props.children}</div></div>
);

/** 一个派生变量：显示名称、运算、结果类型，加运算自己的表单。onChange 的 now 是选项类的改动，立刻写回。 */
export function DerivedEditor(props: {
  readonly definition: JsonObject; readonly variables: readonly EditorVariable[]; readonly hit?: number | undefined;
  readonly onChange: (next: JsonObject) => void; readonly onOp: (op: DerivedOp) => void;
}) {
  const { definition, variables, onChange } = props;
  const op = String(definition['op']) as DerivedOp, type = String(definition['type'] ?? '');
  const own = variables.filter((item) => item.name !== definition['name']);
  const select = (key: string, types: readonly string[], label: string) => {
    const value = isObject(definition[key]) ? String((definition[key] as JsonObject)['var']) : '';
    const candidates = own.filter((item) => types.includes(item.type));
    return (
      <select aria-label={label} value={value} onChange={(event) => {
        const next = { ...definition, [key]: { var: event.target.value } };
        onChange(op === 'pickItem' ? { ...next, ...itemType(own.find((item) => item.name === event.target.value)), ...(itemType(own.find((item) => item.name === event.target.value)).ref ? {} : { ref: undefined }) } : next);
      }}>
        {!candidates.some((item) => item.name === value) && <option value={value}>{value || '选一个变量'}</option>}
        {candidates.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
      </select>
    );
  };
  return (
    <div className="derived-editor" data-testid="derived-editor">
      <Row label="显示名称"><input type="text" aria-label="显示名称" value={String(definition['displayName'] ?? '')} onChange={(event) => { if (event.target.value.trim()) onChange({ ...definition, displayName: event.target.value }); }} /></Row>
      <Row label="运算">
        <select aria-label="运算" value={ARITHMETIC.includes(op) ? 'arithmetic' : op} onChange={(event) => props.onOp((event.target.value === 'arithmetic' ? 'add' : event.target.value) as DerivedOp)}>
          {OPS.filter((item) => !ARITHMETIC.includes(item.op) || item.op === 'add').map((item) => <option key={item.op} value={ARITHMETIC.includes(item.op) ? 'arithmetic' : item.op}>{ARITHMETIC.includes(item.op) ? '加减乘除、取模' : item.label}</option>)}
        </select>
      </Row>
      <Row label="结果类型">
        {typeEditable(definition)
          ? (
            <select aria-label="结果类型" value={type} onChange={(event) => onChange(withBranchType(definition, event.target.value))}>
              {BRANCH_TYPES.map(([key, text]) => <option key={key} value={key}>{text}</option>)}
            </select>
          )
          : <span className="small muted" data-testid="result-type">{TYPE_NAMES[type] ?? type}{isObject(definition['ref']) ? `（${String(definition['ref']['name'])} v${String(definition['ref']['version'])}）` : ''}，按运算推出</span>}
      </Row>
      {op === 'branch' && <BranchEditor definition={definition} variables={own} hit={props.hit} onChange={onChange} />}
      {op === 'pickItem' && (
        <>
          <Row label="列表">{select('list', ['list'], '列表')}</Row>
          <Row label="取哪一项"><PositionInput value={definition['position']} variables={own} onChange={(position) => onChange({ ...definition, position })} /></Row>
          <p className="small faint">序号从 1 开始；越界时结果为空，不报错。</p>
        </>
      )}
      {op === 'splitPart' && (
        <>
          <Row label="拆谁">{select('of', ['text', 'number', 'date', 'time', 'datetime'], '拆谁')}</Row>
          <Row label="分隔符"><input type="text" aria-label="分隔符" value={typeof definition['delimiter'] === 'string' ? definition['delimiter'] : ''} onChange={(event) => { if (event.target.value) onChange({ ...definition, delimiter: event.target.value }); }} /></Row>
          <Row label="取哪一段"><PositionInput value={definition['position']} variables={own} onChange={(position) => onChange({ ...definition, position })} /></Row>
        </>
      )}
      {op === 'length' && <Row label="谁的长度">{select('of', ['list', 'text'], '谁的长度')}</Row>}
      {ARITHMETIC.includes(op) && (
        <>
          <Row label="算法">
            <select aria-label="算法" value={op} onChange={(event) => onChange({ ...definition, op: event.target.value })}>
              {OPS.filter((item) => ARITHMETIC.includes(item.op)).map((item) => <option key={item.op} value={item.op}>{item.label}</option>)}
            </select>
          </Row>
          <Row label="左"><OperandInput value={definition['left']} variables={own} type="number" label="左" onChange={(left) => onChange({ ...definition, left })} /></Row>
          <Row label="右"><OperandInput value={definition['right']} variables={own} type="number" label="右" onChange={(right) => onChange({ ...definition, right })} /></Row>
          {op === 'divide' && <p className="small faint">除数为 0 时报严重问题并按缺值处理。</p>}
        </>
      )}
    </div>
  );
}
