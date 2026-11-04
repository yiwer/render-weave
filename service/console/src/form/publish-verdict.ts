/**
 * 发布确认的结论（M365）：把预检结果写成"能不能发、发了会怎样"，数据定义与模板各一个。
 * 只翻译不判断：能不能发以服务端的问题清单为准，发布时服务端同样这样判。
 */
import type { DefinitionPublishCheck, RevisionDiff } from '../types.js';

export type PublishTone = 'ok' | 'warn' | 'bad';
export interface PublishCheckLine {
  readonly key: string;
  readonly tone: PublishTone;
  readonly text: string;
  readonly note?: string;
}
export interface PublishVerdict { readonly tone: PublishTone; readonly label: string; readonly lines: readonly PublishCheckLine[] }

const number = (value: number) => value.toLocaleString('zh-CN');

function problemsLine(check: DefinitionPublishCheck): PublishCheckLine {
  const severe = check.problems.filter((problem) => problem.level === 'severe').length, hints = check.problems.length - severe;
  if (check.version === undefined) return { key: 'problems', tone: 'bad', text: `${number(severe)} 个严重问题`, note: '改正之后才能发布' };
  return { key: 'problems', tone: 'ok', text: hints ? `校验通过，有 ${number(hints)} 条提示` : '校验通过' };
}

function changesLine(check: DefinitionPublishCheck): PublishCheckLine {
  const { fields, definition, order } = check.diff!, base = check.baseVersion;
  if (base === undefined) return { key: 'changes', tone: 'ok', text: `首个版本，${number(fields.length)} 个字段` };
  if (!fields.length && !definition.length && !order) return { key: 'changes', tone: 'warn', text: `内容和 v${base} 相同`, note: '发布只会多一个内容相同的版本' };
  const count = (change: string) => fields.filter((field) => field.change === change).length;
  const counts = ([['新增', count('added')], ['修改', count('changed')], ['删除', count('removed')]] as const).filter(([, value]) => value > 0).map(([label, value]) => `${label} ${number(value)}`);
  // 明细都在左边，这里只说大头：有字段改动就只说字段。
  const text = counts.length ? `${counts.join('、')} 个字段` : [definition.length ? '改了数据定义的属性' : undefined, order ? '调整了字段顺序' : undefined].filter(Boolean).join('，');
  return fields.some((field) => field.affectsBindings)
    ? { key: 'changes', tone: 'warn', text, note: '删除的字段，按它写的模板绑定和数据集的键不再有对应' }
    : { key: 'changes', tone: 'ok', text };
}

function datasetsLine(check: DefinitionPublishCheck): PublishCheckLine {
  const datasets = check.datasets!, base = check.baseVersion, next = check.version!;
  if (base === undefined) return { key: 'datasets', tone: 'ok', text: '还没有数据集绑定' };
  if (datasets.total === 0) return { key: 'datasets', tone: 'ok', text: `没有数据集绑定 v${base}` };
  const stay = `它们继续按 v${base} 校验和出图`;
  if (!datasets.complete) return { key: 'datasets', tone: 'warn', text: `${number(datasets.total)} 份数据集只核对了前 ${number(datasets.checked)} 份`, note: datasets.mismatched ? `其中 ${number(datasets.mismatched)} 份按 v${next} 会失配，${stay}` : `这些都能按 v${next} 通过校验` };
  if (datasets.mismatched) return { key: 'datasets', tone: 'warn', text: `${number(datasets.mismatched)} 份数据集按 v${next} 会失配`, note: stay };
  return { key: 'datasets', tone: 'ok', text: `${number(datasets.total)} 份数据集都能按 v${next} 通过校验` };
}

function templatesLine(check: DefinitionPublishCheck): PublishCheckLine {
  const templates = check.templates!;
  if (!templates.length) return { key: 'templates', tone: 'ok', text: '还没有模板用这个数据定义' };
  const versions = new Set(templates.map((template) => template.base.version));
  return { key: 'templates', tone: 'ok', text: `${number(templates.length)} 个模板照旧绑定${versions.size === 1 ? ` v${[...versions][0]!}` : '各自的版本'}` };
}

export function publishVerdict(check: DefinitionPublishCheck): PublishVerdict {
  if (check.version === undefined) return { tone: 'bad', label: '不能发布', lines: [problemsLine(check)] };
  const lines = [problemsLine(check), changesLine(check), datasetsLine(check), templatesLine(check)];
  return lines.some((line) => line.tone === 'warn')
    ? { tone: 'warn', label: '可以发布，有影响要看', lines }
    : { tone: 'ok', label: '可以发布', lines };
}

export interface TemplatePublishFacts {
  readonly severe: number;
  readonly hints: number;
  readonly status: RevisionDiff['status'];
  /** 改动的一句话，如"1 个元素"。 */
  readonly summary: string;
  readonly next: number;
  readonly conflict?: { readonly baseRevision?: number; readonly currentRevision: number };
}

/** 模板修订的结论。按挡住发布的先后：严重问题、基准已变、没有改动。 */
export function templatePublishVerdict(facts: TemplatePublishFacts): PublishVerdict {
  const { severe, hints, status, summary, next, conflict } = facts;
  const problems: PublishCheckLine = severe
    ? { key: 'problems', tone: 'bad', text: `${number(severe)} 个严重问题`, note: '改好之后才能发布' }
    : { key: 'problems', tone: 'ok', text: hints ? `静态检查通过，有 ${number(hints)} 条提示` : '静态检查通过' };
  const changes: PublishCheckLine = status === 'added' ? { key: 'changes', tone: 'ok', text: '这是新模板，还没有修订可比' }
    : status === 'unchanged' ? { key: 'changes', tone: 'warn', text: '和当前修订没有差别' }
    : { key: 'changes', tone: 'ok', text: `改动 ${summary}` };
  if (severe) return { tone: 'bad', label: '不能发布', lines: [problems, changes] };
  if (conflict) {
    const line: PublishCheckLine = { key: 'conflict', tone: 'warn', text: `工作副本基于修订 ${conflict.baseRevision ?? '（无）'}，当前修订已是 ${conflict.currentRevision}`, note: '先看两边差异，再决定要不要覆盖' };
    return { tone: 'warn', label: '基准已变', lines: [problems, line] };
  }
  if (status === 'unchanged') return { tone: 'warn', label: '没有改动，不用发布', lines: [problems, changes] };
  return {
    tone: 'ok', label: '可以发布',
    lines: [problems, changes, { key: 'effect', tone: 'ok', text: `发布后出图读修订 ${number(next)}`, note: '数据集和调用方按名称引用模板，不用改' }],
  };
}
