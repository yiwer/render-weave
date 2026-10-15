/**
 * 成果校验（M48、第三阶段 PRD 第 9 条）：先校验 Agent 交回的 outcome.json 的结构，再用引擎校验候选。
 * 不合格时给出问题清单，不自动重试。只读取 Agent 工作目录内的文件。
 */
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { dslDocumentKind } from '../dsl.js';
import { ToolInputError, WorkingDirectory } from '../mcp/files.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { publishStaticSchema } from '../schema/publish.js';
import { isRecord } from '../util.js';
import type { StaticSchemaEntry, StaticSchemaRef } from '../workspace.js';
import { AGENT_TASKS, type AgentTaskId, type CandidateKind } from './tasks.js';

/** 待确认项的四类原因（M44）：看不清、推测、来源冲突、必填未提供。 */
export const PENDING_REASONS = ['unreadable', 'inferred', 'conflicting', 'requiredMissing'] as const;
export type PendingReason = (typeof PENDING_REASONS)[number];

export interface PendingItem {
  /** 候选文件，相对 Agent 工作目录，如 candidates/schema-badge.json。 */
  readonly file: string;
  /** 文件内的位置：数据定义写字段名，数据集写字段路径；省略表示整份文件。 */
  readonly path?: string;
  /** 候选值，可以没有。 */
  readonly candidate?: unknown;
  readonly reason: PendingReason;
  readonly note: string;
}

/** Agent 在工作目录中写的 outcome.json。 */
export interface SubmittedOutcome {
  readonly candidates: readonly string[];
  readonly pending: readonly PendingItem[];
  readonly notes: string;
}

/** Agent 交回的 outcome.json 的结构，写给 Agent 的说明见 agent/reference/outcome.md。 */
export const SUBMITTED_OUTCOME_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['candidates', 'pending', 'notes'],
  properties: {
    candidates: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
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
  readonly name?: string;
  readonly sha256?: string;
  /** 数据定义候选在内存中发布成的名称与版本。 */
  readonly published?: StaticSchemaRef;
  readonly problems: readonly Problem[];
}

export interface OutcomeCheck {
  /** 合格：结构合格，且候选没有严重问题。 */
  readonly verdict: 'qualified' | 'unqualified';
  /** 结构问题：没有 outcome.json、结构不合格、候选文件或待确认项不对。 */
  readonly problems: readonly Problem[];
  readonly candidates: readonly CandidateCheck[];
  /** 结构合格时才有。 */
  readonly submission?: SubmittedOutcome;
}

export const OUTCOME_FILE = 'outcome.json';
const CANDIDATE_DIR = 'candidates';
const validateSubmission = new Ajv2020({ allErrors: true, strict: true }).compile(SUBMITTED_OUTCOME_SCHEMA);

/** 校验一轮的成果：agentDir 是 Agent 工作目录，staticSchemas 是本轮工作区快照中已发布的静态数据定义。 */
export async function checkAgentOutcome(options: {
  readonly task: AgentTaskId;
  readonly agentDir: string;
  readonly staticSchemas: readonly StaticSchemaEntry[];
}): Promise<OutcomeCheck> {
  const task = AGENT_TASKS[options.task];
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
  const candidates: (CandidateCheck & { document?: unknown })[] = [];
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
    const name = isRecord(document) && typeof document['name'] === 'string' ? document['name'] : undefined;
    candidates.push({ path: rel, kind, ...(name !== undefined ? { name } : {}), sha256: createHash('sha256').update(bytes).digest('hex'), document, problems: [] });
  }
  const names = candidates.filter((candidate) => candidate.kind === 'definition').map((candidate) => candidate.name);
  for (const name of new Set(names.filter((value, index) => names.indexOf(value) !== index))) {
    problems.push(severe(ProblemCodes.outcomeInvalid, at('candidates'), `候选数据定义的名称重复：${String(name)}`));
  }

  // 待确认项：指向候选文件；数据定义的位置是其中的字段名。
  const byPath = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  for (const [index, item] of submission.pending.entries()) {
    const where = at(`pending[${index + 1}]`);
    const candidate = byPath.get(item.file.replaceAll('\\', '/').replace(/^\.\//, ''));
    if (!candidate) {
      problems.push(severe(ProblemCodes.outcomeInvalid, where, `待确认项指向的文件不在候选中：${item.file}`));
    } else if (item.path !== undefined && candidate.kind === 'definition' && !fieldNames(candidate.document).includes(item.path)) {
      problems.push(severe(ProblemCodes.outcomeInvalid, where, `数据定义"${candidate.name}"中没有字段 ${item.path}`));
    }
  }

  // 引擎校验：数据定义按依赖顺序在内存中发布，版本号接在快照之后。
  const checked: CandidateCheck[] = candidates.map(({ document: _document, ...candidate }) => candidate);
  const definitions = candidates.filter((candidate) => candidate.kind === 'definition');
  const published: StaticSchemaEntry[] = [];
  const results = new Map<string, { published?: StaticSchemaRef; problems: Problem[] }>();
  let remaining = definitions;
  for (let progress = true; progress && remaining.length > 0;) {
    progress = false;
    const next: typeof remaining = [];
    for (const candidate of remaining) {
      const outcome = publishStaticSchema(candidate.document, [...options.staticSchemas, ...published]);
      if (outcome.published) {
        published.push(outcome.published);
        results.set(candidate.path, { published: outcome.published.ref, problems: outcome.problems });
        progress = true;
      } else {
        results.set(candidate.path, { problems: outcome.problems });
        next.push(candidate);
      }
    }
    remaining = next;
  }
  const final = checked.map((candidate) => {
    const result = results.get(candidate.path);
    return result ? { ...candidate, ...(result.published ? { published: result.published } : {}), problems: result.problems } : candidate;
  });
  const severeFound = problems.some((problem) => problem.level === 'severe') ||
    final.some((candidate) => candidate.problems.some((problem) => problem.level === 'severe'));
  return { verdict: severeFound ? 'unqualified' : 'qualified', problems, candidates: final, ...(problems.length === 0 ? { submission } : {}) };
}

function candidateKind(document: unknown): CandidateKind | undefined {
  const kind = dslDocumentKind(document);
  return kind === 'definition' || kind === 'dataset' || kind === 'template' ? kind : undefined;
}

function kindName(kind: CandidateKind): string {
  return { definition: '数据定义', dataset: '数据集', template: '模板' }[kind];
}

function fieldNames(document: unknown): string[] {
  const fields = isRecord(document) && Array.isArray(document['fields']) ? document['fields'] : [];
  return fields.flatMap((field) => (isRecord(field) && typeof field['name'] === 'string' ? [field['name']] : []));
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
    default: return `${at} ${error.message ?? '不合规'}`;
  }
}
