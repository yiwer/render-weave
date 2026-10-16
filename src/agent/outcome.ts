/**
 * 成果校验（M48、第三阶段 PRD 第 9 条）：先校验 Agent 交回的 outcome.json 的结构，再用引擎校验候选。
 * 不合格时给出问题清单，不自动重试。只读取 Agent 工作目录内的文件。
 */
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { dslDocumentKind } from '../dsl.js';
import { ToolInputError, WorkingDirectory } from '../mcp/files.js';
import { ProblemCodes, hint, severe, type Problem } from '../problems.js';
import { isRecord } from '../util.js';
import type { StaticSchemaRef, Workspace } from '../workspace.js';
import { checkCandidates, type CandidateContext } from './candidates.js';
import { revisionDiff, type RevisionDiff } from './diff.js';
import { applyChanges, locate, within } from './locations.js';
import { AGENT_TASKS, type AgentTaskId, type CandidateKind } from './tasks.js';

/** 待确认项的四类原因（M44）：看不清、推测、来源冲突、必填未提供。 */
export const PENDING_REASONS = ['unreadable', 'inferred', 'conflicting', 'requiredMissing'] as const;
export type PendingReason = (typeof PENDING_REASONS)[number];

export interface PendingItem {
  /** 候选文件，相对 Agent 工作目录，如 candidates/schema-badge.json。 */
  readonly file: string;
  /** 文件内的位置：数据定义写字段名，数据集写字段路径，模板写元素路径；省略表示整份文件。 */
  readonly path?: string;
  /** 候选值，可以没有。数据集中是该位置的值，草稿与"采纳候选"都用它；数据定义与模板中是给审核人的建议。 */
  readonly candidate?: unknown;
  readonly reason: PendingReason;
  readonly note: string;
}

/** 候选中的一处在示例图上的位置，供审核人对照；由 Agent 自述，不是识别证据（M220）。 */
export interface FieldLocation {
  readonly file: string;
  /** 位置写法同待确认项；省略表示整份文件。 */
  readonly path?: string;
  /** 文字描述，如"顶栏左侧的大号线路号"。 */
  readonly where: string;
  /** 示例图像素区域，左上角为原点，与 view_image 的 region 写法相同。 */
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/** Agent 在工作目录中写的 outcome.json。 */
export interface SubmittedOutcome {
  readonly candidates: readonly string[];
  readonly locations?: readonly FieldLocation[];
  readonly pending: readonly PendingItem[];
  readonly notes: string;
}

/** Agent 交回的 outcome.json 的结构，写给 Agent 的说明见 agent/reference/outcome.md。 */
export const SUBMITTED_OUTCOME_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates', 'pending', 'notes'],
  properties: {
    candidates: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    locations: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'where'],
      properties: {
        file: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        where: { type: 'string', minLength: 1 },
        region: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: {
          x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
          width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
        } },
      },
    } },
    pending: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['file', 'reason', 'note'],
      properties: {
        file: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        candidate: {},
        reason: { enum: [...PENDING_REASONS] },
        note: { type: 'string', minLength: 1 },
      },
    } },
    notes: { type: 'string', minLength: 1 },
  },
} as const;

export interface CandidateCheck {
  /** 相对 Agent 工作目录的路径，用 / 分隔。 */
  readonly path: string;
  readonly kind?: CandidateKind;
  /** 数据定义与模板的名称，数据集的 id。 */
  readonly name?: string;
  readonly sha256?: string;
  /** 数据定义候选在内存中发布成的名称与版本。 */
  readonly published?: StaticSchemaRef;
  readonly problems: readonly Problem[];
  /** 数据集中落在待确认位置上的问题：留给审核处理，不计入本轮结论（M46）。 */
  readonly deferred?: readonly Problem[];
  /** 模板辅助修改：相对已保存模板的差异。 */
  readonly revision?: RevisionDiff;
}

export interface OutcomeCheck {
  /** 合格：结构合格，且候选没有严重问题（待确认位置上的问题除外）。 */
  readonly verdict: 'qualified' | 'unqualified';
  /** 结构问题：没有 outcome.json、结构不合格、候选文件或待确认项不对。 */
  readonly problems: readonly Problem[];
  readonly candidates: readonly CandidateCheck[];
  /** 结构合格时才有。 */
  readonly submission?: SubmittedOutcome;
}

/** 本轮的已知输入：数据集提取所选的数据定义；示例图对应的出图请求（模板辅助设计时，其主模板必须在候选中）；模板辅助修改可以改的模板。 */
export interface OutcomeContext extends CandidateContext {
  readonly request?: { readonly template: string };
}

export const OUTCOME_FILE = 'outcome.json';
const CANDIDATE_DIR = 'candidates';
const validateSubmission = new Ajv2020({ allErrors: true, strict: true }).compile(SUBMITTED_OUTCOME_SCHEMA);

/** 校验一轮的成果：agentDir 是 Agent 工作目录，workspace 是本轮的工作区快照（连同资源仓库）。 */
export async function checkAgentOutcome(options: {
  readonly task: AgentTaskId;
  readonly agentDir: string;
  readonly workspace: Workspace;
  readonly context?: OutcomeContext;
}): Promise<OutcomeCheck> {
  const task = AGENT_TASKS[options.task];
  const context = options.context ?? {};
  const files = await WorkingDirectory.open(options.agentDir);
  const problems: Problem[] = [];
  const at = (source: string) => ({ kind: 'input', source: source === '' ? OUTCOME_FILE : `${OUTCOME_FILE}#${source}` }) as const;
  const unqualified = (candidates: CandidateCheck[] = []): OutcomeCheck => ({ verdict: 'unqualified', problems, candidates });

  let submitted: unknown;
  try {
    submitted = (await files.readJson(OUTCOME_FILE)).document;
  } catch (error) {
    if (!(error instanceof ToolInputError)) throw error;
    problems.push(severe(ProblemCodes.outcomeInvalid, at(''), `没有交回可读的 outcome.json：${error.message}`));
    return unqualified();
  }
  if (!validateSubmission(submitted)) {
    for (const error of validateSubmission.errors ?? []) problems.push(severe(ProblemCodes.outcomeInvalid, at(error.instancePath.slice(1).replaceAll('/', '.')), describe(error)));
    return unqualified();
  }
  const submission = submitted as unknown as SubmittedOutcome;

  // 候选文件：在 candidates/ 下，可读，种类属于本任务。
  const candidates: (CandidateCheck & { kind: CandidateKind; document: unknown })[] = [];
  for (const [index, path] of submission.candidates.entries()) {
    const where = at(`candidates[${index + 1}]`);
    let real: string;
    try {
      real = await files.resolve(path);
    } catch (error) {
      if (!(error instanceof ToolInputError)) throw error;
      problems.push(severe(ProblemCodes.outcomeInvalid, where, error.message));
      continue;
    }
    const rel = relative(files.root, real).split(sep).join('/');
    if (!rel.startsWith(`${CANDIDATE_DIR}/`) || !rel.endsWith('.json')) {
      problems.push(severe(ProblemCodes.outcomeInvalid, where, `候选文件要放在 ${CANDIDATE_DIR}/ 下，且是 .json 文件：${path}`));
      continue;
    }
    const bytes = await files.readBytes(path);
    let document: unknown;
    try {
      document = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch (error) {
      problems.push(severe(ProblemCodes.outcomeInvalid, where, `候选文件不是有效的 JSON：${path}（${error instanceof Error ? error.message : String(error)}）`));
      continue;
    }
    const kind = candidateKind(document);
    if (!kind || !task.candidateKinds.includes(kind)) {
      problems.push(severe(ProblemCodes.outcomeInvalid, where, `${task.name}的候选只能是${task.candidateKinds.map(kindName).join('或')}：${path}`));
      continue;
    }
    const name = candidateName(kind, document);
    candidates.push({ path: rel, kind, ...(name !== undefined ? { name } : {}), sha256: createHash('sha256').update(bytes).digest('hex'), document, problems: [] });
  }
  const names = candidates.filter((candidate) => candidate.kind === 'definition').map((candidate) => candidate.name);
  for (const name of new Set(names.filter((value, index) => names.indexOf(value) !== index))) {
    problems.push(severe(ProblemCodes.outcomeInvalid, at('candidates'), `候选数据定义的名称重复：${String(name)}`));
  }
  if (task.id === 'template-design' && context.request && candidates.length === submission.candidates.length &&
    !candidates.some((candidate) => candidate.kind === 'template' && candidate.name === context.request!.template)) {
    problems.push(severe(ProblemCodes.outcomeInvalid, at('candidates'), `出图请求的主模板 ${context.request.template} 不在候选中`));
  }

  // 待确认项与图上位置：指向候选文件中的一个位置（数据定义写字段名，数据集写字段路径，模板写元素路径）。
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const pointers = [
    ...submission.pending.map((item, index) => ({ key: `pending[${index + 1}]`, label: '待确认项', item })),
    ...(submission.locations ?? []).map((item, index) => ({ key: `locations[${index + 1}]`, label: '图上位置', item })),
  ];
  // 待确认项要处理，位置必须找得到；图上位置只给审核人参考，对不上时记为提示，不影响结论。
  for (const { key, label, item } of pointers) {
    const where = at(key);
    const report = (message: string) => problems.push(label === '待确认项'
      ? severe(ProblemCodes.outcomeInvalid, where, message)
      : hint(ProblemCodes.outcomeInvalid, where, `${message}（图上位置只作参考，不影响结论）`));
    const candidate = byPath.get(normalizeCandidatePath(item.file));
    if (!candidate) {
      report(`${label}指向的文件不在候选中：${item.file}`);
      continue;
    }
    if (item.path === undefined) continue;
    const { error } = locate(candidate.kind, candidate.document, item.path);
    if (error) report(candidate.kind === 'definition' ? `数据定义"${candidate.name}"中没有字段 ${item.path}` : error);
  }

  // 引擎校验：数据集先填上待确认项的候选值（草稿用候选值，M46），落在待确认位置上的问题留给审核。
  const pendingPaths = new Map<string, string[]>();
  for (const item of submission.pending) {
    if (item.path === undefined) continue;
    const file = normalizeCandidatePath(item.file);
    pendingPaths.set(file, [...(pendingPaths.get(file) ?? []), item.path]);
  }
  const documents = candidates.map((candidate) => ({ path: candidate.path, kind: candidate.kind,
    document: candidate.kind === 'dataset' ? withPendingCandidates(candidate.document, submission.pending.filter((item) => normalizeCandidatePath(item.file) === candidate.path)) : candidate.document }));
  const results = checkCandidates(documents, options.workspace, context);
  const final: CandidateCheck[] = candidates.map(({ document, ...candidate }) => {
    const result = results.get(candidate.path);
    if (!result) return candidate;
    if (context.revision && candidate.kind === 'template') {
      const saved = context.revision.templates.includes(candidate.name ?? '') ? options.workspace.templates.find((entry) => entry.name === candidate.name)?.document : undefined;
      const revision = revisionDiff(saved, document);
      if (revision.status === 'unchanged') {
        problems.push(hint(ProblemCodes.outcomeInvalid, { kind: 'input', source: candidate.path }, `工作副本与已保存的模板 ${candidate.name} 相同，应用时不写入`));
      }
      return { ...candidate, problems: result.problems, revision };
    }
    const paths = pendingPaths.get(candidate.path) ?? [];
    const deferred = candidate.kind === 'dataset' ? result.problems.filter((problem) => problem.location.kind === 'field' && paths.some((path) => within(path, (problem.location as { path: string }).path))) : [];
    return {
      ...candidate, ...(result.published ? { published: result.published.ref } : {}),
      problems: result.problems.filter((problem) => !deferred.includes(problem)), ...(deferred.length > 0 ? { deferred } : {}),
    };
  });
  const severeFound = problems.some((problem) => problem.level === 'severe') ||
    final.some((candidate) => candidate.problems.some((problem) => problem.level === 'severe'));
  return { verdict: severeFound ? 'unqualified' : 'qualified', problems, candidates: final, ...(problems.every((problem) => problem.level !== 'severe') ? { submission } : {}) };
}

/** 数据集中带候选值的待确认项：把候选值写到该位置。找不到的位置已在结构检查中报过。 */
export function withPendingCandidates(document: unknown, pending: readonly PendingItem[]): unknown {
  const changes = pending.filter((item) => item.path !== undefined && item.candidate !== undefined)
    .map((item) => ({ path: item.path!, action: 'set' as const, value: item.candidate }));
  return changes.length === 0 ? document : applyChanges('dataset', document, changes).document;
}

/** 待确认项与图上位置中的文件写法统一为 candidates/… 的正斜杠形式。 */
export function normalizeCandidatePath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function candidateKind(document: unknown): CandidateKind | undefined {
  const kind = dslDocumentKind(document);
  return kind === 'definition' || kind === 'dataset' || kind === 'template' ? kind : undefined;
}

/** 数据定义与模板取 name，数据集取 dataset.id。 */
export function candidateName(kind: CandidateKind, document: unknown): string | undefined {
  const value = kind === 'dataset' ? (isRecord(document) && isRecord(document['dataset']) ? document['dataset']['id'] : undefined) : isRecord(document) ? document['name'] : undefined;
  return typeof value === 'string' ? value : undefined;
}

function kindName(kind: CandidateKind): string {
  return { definition: '数据定义', dataset: '数据集', template: '模板' }[kind];
}

function describe(error: ErrorObject): string {
  const at = error.instancePath === '' ? 'outcome.json' : error.instancePath.slice(1).replaceAll('/', '.');
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required': return `${at} 缺少 ${String(params['missingProperty'])}`;
    case 'additionalProperties': return `${at} 不能有 ${String(params['additionalProperty'])}`;
    case 'enum': return `${at} 只能取 ${(params['allowedValues'] as unknown[]).join('、')}`;
    case 'minItems': return `${at} 至少要有 ${String(params['limit'])} 项`;
    case 'minLength': return `${at} 不能为空`;
    case 'uniqueItems': return `${at} 有重复项`;
    case 'type': return `${at} 应为 ${String(params['type'])}`;
    case 'minimum': return `${at} 不能小于 ${String(params['limit'])}`;
    case 'exclusiveMinimum': return `${at} 必须大于 ${String(params['limit'])}`;
    default: return `${at} ${error.message ?? '不合规'}`;
  }
}
