/**
 * 审核与应用（M47、M18、M51；第三阶段 PRD 第 10、11 条）。
 *
 * 审核结果保存在轮次目录的 review.json。它在 Agent 工作目录之外，Agent 写不到。待确认项逐项处理：
 * - 采纳候选（adopt）：保留候选文件中该位置的写法；
 * - 改值（edit）：用审核人给的值替换该位置。数据定义中是整个字段；省略位置时是整份定义；
 * - 标为空（empty）：删去该位置。数据定义中删去该字段；省略位置时不发布这份候选。
 *
 * 其余内容整体确认一次。审核视图把处理结果作用到候选上，在工作区快照上于内存中重新发布，给出字段清单与编译产物摘要。
 *
 * 应用只接受审核通过的轮次：先核对成果与候选没有被改动，再比对工作区指纹。工作区已变化时列出差异并拒绝，除非明确选择覆盖。
 * 全部定义先在内存中发布成功，再排他写入；任何失败都撤回本次写入，工作区保持原状。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { publishStaticSchema, type PublishedStaticSchema } from '../schema/publish.js';
import { publishedFileNames, writeExclusiveJsonFiles } from '../schema/publish-files.js';
import { describeError, isRecord } from '../util.js';
import { loadWorkspaceDocuments, type StaticSchemaEntry, type StaticSchemaRef } from '../workspace.js';
import {
  OUTCOME_FILE, SUBMITTED_OUTCOME_SCHEMA, publishInDependencyOrder,
  type FieldLocation, type PendingItem, type PendingReason,
} from './outcome.js';
import { AgentUsageError, workspaceFingerprint, type RoundOutcome, type RoundRecord, type RoundUsage } from './run.js';
import { AGENT_TASKS, type AgentTaskId, type CandidateKind } from './tasks.js';

export const REVIEW_FILE = 'review.json';
export const APPLIED_FILE = 'applied.json';
export const REVIEW_ACTIONS = ['adopt', 'edit', 'empty'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export type ReviewStatus = 'inProgress' | 'approved' | 'rejected';

/** 一个待确认项的处理结果。 */
export interface ReviewDecision {
  /** 待确认项序号，从 1 开始，对应 outcome.json 的 pending。 */
  readonly item: number;
  /** 抄自待确认项，便于直接阅读 review.json。 */
  readonly file: string;
  readonly path?: string;
  readonly action: ReviewAction;
  /** 改值时的新值：数据定义中是整个字段；省略位置时是整份定义。 */
  readonly value?: unknown;
}

/** 审核结果 review.json。 */
export interface ReviewRecord {
  readonly format: 'renderweave-review/1';
  /** 所审核的 outcome.json 的 SHA-256：成果变了，审核结果作废。 */
  readonly outcomeSha256: string;
  readonly status: ReviewStatus;
  readonly decisions: readonly ReviewDecision[];
  /** 待确认项以外的内容已整体确认（M47）。 */
  readonly restConfirmed: boolean;
  /** 审核未通过的理由，或通过时的备注。 */
  readonly comment?: string;
  readonly updatedAt: string;
  /** 给出通过或未通过结论的时间。 */
  readonly decidedAt?: string;
}

/** 审核页与调用方可做的操作。 */
export type ReviewChange =
  | { readonly type: 'decide'; readonly item: number; readonly action: ReviewAction; readonly value?: unknown }
  | { readonly type: 'undecide'; readonly item: number }
  | { readonly type: 'confirmRest'; readonly confirmed: boolean }
  | { readonly type: 'approve'; readonly comment?: string }
  | { readonly type: 'reject'; readonly comment: string }
  | { readonly type: 'reopen' };

export interface ReviewView {
  readonly round: {
    readonly dir: string;
    readonly task: AgentTaskId;
    readonly taskName: string;
    /** 成果校验的结论；不合格的成果也可以审核，改好后才能通过。 */
    readonly verdict: RoundRecord['verdict'];
    /** 示例图在轮次目录中的位置。 */
    readonly sample: string;
    /** 本轮基于的工作区，应用时缺省写到这里。 */
    readonly workspace: string | null;
    readonly notes: string;
    readonly usage: RoundUsage;
  };
  readonly review: ReviewRecord;
  /** review.json 是否已经存在。 */
  readonly saved: boolean;
  readonly pending: readonly PendingView[];
  readonly candidates: readonly CandidateView[];
  /** 审核层面的问题：未处理的待确认项、未整体确认、处理结果矛盾、review.json 不合格。候选的引擎问题在各候选中。 */
  readonly problems: readonly Problem[];
  /** 没有任何严重问题（含候选的引擎问题）时才能通过。 */
  readonly canApprove: boolean;
  readonly applied?: AppliedRecord;
}

export interface PendingView extends PendingItem {
  readonly item: number;
  readonly reasonName: string;
  /** 候选文件中该位置原来的内容。 */
  readonly current?: unknown;
  readonly decision?: ReviewDecision;
  readonly location?: FieldLocation;
}

export interface CandidateView {
  readonly path: string;
  readonly kind: CandidateKind;
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  /** 整份标为空：不发布。 */
  readonly dropped: boolean;
  /** 整份改过。 */
  readonly edited: boolean;
  /** 作用了处理结果之后的文档。 */
  readonly document?: unknown;
  readonly fields: readonly FieldView[];
  /** 整份候选在图上的位置。 */
  readonly location?: FieldLocation;
  /** 在工作区快照上于内存中发布成的名称与版本。 */
  readonly published?: StaticSchemaRef;
  readonly compiled?: CompiledSummary;
  readonly problems: readonly Problem[];
}

export interface FieldView {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  /** 如"文本""列表<引用 站点 v1>"。 */
  readonly type: string;
  /** 如"必填""长度 1–12""可选值 讲者、嘉宾"。 */
  readonly constraints: readonly string[];
  readonly location?: FieldLocation;
  /** 指向该字段的待确认项序号。 */
  readonly pending: readonly number[];
  /** kept 保留原样；edited 审核时改过；removed 审核时标为空，不再出现在定义中。 */
  readonly state: 'kept' | 'edited' | 'removed';
}

export interface CompiledSummary {
  readonly title?: string;
  readonly properties: number;
  readonly required: readonly string[];
  /** 完整的编译产物（JSON Schema）。 */
  readonly schema: Record<string, unknown>;
}

/** 与候选同名、在快照之后又发布了新版本的数据定义。 */
export interface NewerDefinition {
  readonly name: string;
  /** 快照中的最新版本，没有为 null。 */
  readonly snapshot: number | null;
  readonly workspace: number;
}

/** 工作区自成果生成后的变化：按文件名比对快照与当前工作区的顶层 JSON 文件。 */
export interface WorkspaceDrift {
  readonly expected: string;
  readonly actual: string;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  readonly newerDefinitions: readonly NewerDefinition[];
}

/** 应用记录 applied.json：写在轮次目录，本轮不能再次应用。 */
export interface AppliedRecord {
  readonly format: 'renderweave-applied/1';
  readonly appliedAt: string;
  readonly workspace: string;
  /** 工作区已变化时明确选择了覆盖。 */
  readonly overwrite: boolean;
  readonly fingerprints: { readonly round: string; readonly before: string; readonly after: string };
  readonly published: readonly { readonly candidate: string; readonly name: string; readonly version: number; readonly files: readonly string[] }[];
  /** 覆盖时工作区相对成果所基于快照的变化。 */
  readonly drift?: WorkspaceDrift;
}

export interface AgentApplyOptions {
  readonly roundDir: string;
  /** 缺省为本轮基于的工作区；本轮没有工作区时必须给出。 */
  readonly workspace?: string;
  /** 工作区已变化时仍然应用：按当前工作区发布为下一个版本（M51 的"覆盖"）。 */
  readonly overwrite?: boolean;
}

export interface AgentApplyResult {
  readonly applied?: AppliedRecord;
  /** 工作区已变化时的差异；没有选择覆盖时据此拒绝。 */
  readonly drift?: WorkspaceDrift;
  readonly problems: readonly Problem[];
}

const REASON_NAMES: Record<PendingReason, string> = { unreadable: '看不清', inferred: '推测', conflicting: '来源冲突', requiredMissing: '必填未提供' };
const TYPE_NAMES: Record<string, string> = {
  text: '文本', number: '数值', date: '日期', time: '时刻', datetime: '日期时间', boolean: '是否', image: '图片', list: '列表', ref: '引用',
};
/** 候选文件在轮次目录中的位置：candidates/ 下的 .json，任何一段都不以点开头。 */
const CANDIDATE_PATH = '^candidates/([^/\\\\.][^/\\\\]*/)*[^/\\\\.][^/\\\\]*\\.json$';
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateRoundOutcome = ajv.compile({
  type: 'object', required: ['format', 'task', 'round', 'inputs', 'candidates', 'pending', 'notes'],
  properties: {
    format: { const: 'renderweave-outcome/1' },
    task: { enum: Object.keys(AGENT_TASKS) },
    round: { type: 'integer', minimum: 1 },
    inputs: { type: 'object', required: ['workspaceFingerprint'], properties: { workspaceFingerprint: { type: 'string' } } },
    candidates: { type: 'array', items: { type: 'object', required: ['path', 'kind', 'sha256'], properties: {
      path: { type: 'string', pattern: CANDIDATE_PATH }, kind: { enum: ['definition', 'dataset', 'template'] },
      name: { type: 'string' }, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    } } },
    locations: SUBMITTED_OUTCOME_SCHEMA.properties.locations,
    pending: SUBMITTED_OUTCOME_SCHEMA.properties.pending,
    notes: { type: 'string' },
  },
});
const validateReviewRecord = ajv.compile({
  type: 'object', additionalProperties: false, required: ['format', 'outcomeSha256', 'status', 'decisions', 'restConfirmed', 'updatedAt'],
  properties: {
    format: { const: 'renderweave-review/1' },
    outcomeSha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    status: { enum: ['inProgress', 'approved', 'rejected'] },
    decisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'file', 'action'], properties: {
      item: { type: 'integer', minimum: 1 }, file: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
      action: { enum: [...REVIEW_ACTIONS] }, value: {},
    } } },
    restConfirmed: { type: 'boolean' },
    comment: { type: 'string' },
    updatedAt: { type: 'string' },
    decidedAt: { type: 'string' },
  },
});

interface RoundCandidate { readonly path: string; readonly kind: CandidateKind; readonly name?: string; readonly document: unknown }

/** 读入并核对过的轮次：成果、运行记录、候选与工作区快照。 */
interface AgentRound {
  readonly dir: string;
  readonly outcome: RoundOutcome;
  readonly outcomeSha256: string;
  readonly record: RoundRecord;
  readonly candidates: readonly RoundCandidate[];
  readonly snapshot: readonly StaticSchemaEntry[];
  readonly applied?: AppliedRecord;
}

/** 读取一轮的审核视图；轮次本身不完整或被改动时没有视图，只有问题。 */
export async function readReview(roundDir: string): Promise<{ view?: ReviewView; problems: Problem[] }> {
  const opened = await openRound(roundDir);
  if (!opened.round) return { problems: opened.problems };
  const { record, saved, problems } = await readReviewRecord(opened.round);
  return { view: buildView(opened.round, record, saved, problems), problems: [] };
}

/**
 * 做一次审核操作并保存 review.json。被拒绝时不写文件，problems 说明原因。
 * 给出结论（通过或未通过）后不能再改处理结果，要先撤回结论（reopen）；本轮应用后不能再改。
 */
export async function changeReview(roundDir: string, change: unknown): Promise<{ view?: ReviewView; problems: Problem[] }> {
  const opened = await openRound(roundDir);
  if (!opened.round) return { problems: opened.problems };
  const round = opened.round;
  const current = await readReviewRecord(round);
  const view = () => buildView(round, current.record, current.saved, current.problems);
  const refuse = (message: string, code: Problem['code'] = ProblemCodes.reviewInvalid) =>
    ({ view: view(), problems: [severe(code, { kind: 'input', source: join(round.dir, REVIEW_FILE) }, message)] });

  if (round.applied) return refuse('本轮已经应用，审核结果不再修改');
  if (current.problems.length > 0) return refuse(`review.json 不能继续使用：${current.problems.map((problem) => problem.message).join('；')}`);
  if (!isRecord(change) || typeof change['type'] !== 'string') return refuse('审核操作必须是带 type 的对象');
  const record = current.record;
  const inProgress = record.status === 'inProgress';
  const concluded = '已经给出审核结论；要修改，先撤回结论';
  const pendingItem = (item: unknown) => (Number.isSafeInteger(item) ? round.outcome.pending[(item as number) - 1] : undefined);
  let next: ReviewRecord;
  const now = new Date().toISOString();

  switch (change['type']) {
    case 'decide': {
      if (!inProgress) return refuse(concluded);
      const item = change['item'], action = change['action'], value = change['value'];
      const pending = pendingItem(item);
      if (!pending) return refuse(`没有待确认项 ${String(item)}`);
      if (!REVIEW_ACTIONS.includes(action as ReviewAction)) return refuse(`处理方式只能是 ${REVIEW_ACTIONS.join('、')}`);
      if (action === 'edit' && !isRecord(value)) {
        return refuse(pending.path === undefined ? '改值时要给出整份定义（JSON 对象）' : `改值时要给出字段 ${pending.path} 的完整写法（JSON 对象）`);
      }
      if (action !== 'edit' && value !== undefined) return refuse('只有改值才带新值');
      const decision: ReviewDecision = {
        item: item as number, file: pending.file, ...(pending.path !== undefined ? { path: pending.path } : {}),
        action: action as ReviewAction, ...(action === 'edit' ? { value } : {}),
      };
      next = { ...record, decisions: [...record.decisions.filter((entry) => entry.item !== item), decision].sort((a, b) => a.item - b.item), updatedAt: now };
      break;
    }
    case 'undecide': {
      if (!inProgress) return refuse(concluded);
      if (!pendingItem(change['item'])) return refuse(`没有待确认项 ${String(change['item'])}`);
      next = { ...record, decisions: record.decisions.filter((entry) => entry.item !== change['item']), updatedAt: now };
      break;
    }
    case 'confirmRest': {
      if (!inProgress) return refuse(concluded);
      if (typeof change['confirmed'] !== 'boolean') return refuse('confirmed 必须是 true 或 false');
      next = { ...record, restConfirmed: change['confirmed'], updatedAt: now };
      break;
    }
    case 'approve': {
      if (!inProgress) return refuse(concluded);
      const comment = optionalComment(change['comment']);
      if (comment === null) return refuse('备注必须是文本');
      const before = view();
      if (!before.canApprove) {
        const blocking = [...before.problems, ...before.candidates.flatMap((candidate) => candidate.problems)].filter((problem) => problem.level === 'severe');
        return { view: before, problems: [severe(ProblemCodes.reviewPending, { kind: 'input', source: join(round.dir, REVIEW_FILE) },
          `还不能通过：${blocking.map((problem) => problem.message).join('；')}`)] };
      }
      const { comment: _comment, ...rest } = record;
      next = { ...rest, status: 'approved', ...(comment ? { comment } : {}), updatedAt: now, decidedAt: now };
      break;
    }
    case 'reject': {
      if (!inProgress) return refuse(concluded);
      const comment = optionalComment(change['comment']);
      if (!comment) return refuse('审核未通过时要写明理由');
      next = { ...record, status: 'rejected', comment, updatedAt: now, decidedAt: now };
      break;
    }
    case 'reopen': {
      if (inProgress) return refuse('审核还在进行，没有可撤回的结论');
      const { comment: _comment, decidedAt: _decidedAt, ...rest } = record;
      next = { ...rest, status: 'inProgress', updatedAt: now };
      break;
    }
    default:
      return refuse(`无法识别的审核操作：${change['type']}`);
  }
  await saveReviewRecord(round.dir, next);
  return { view: buildView(round, next, true, []), problems: [] };
}

/** 应用审核通过的轮次：数据定义经发布入口发布为下一个版本（M18），写入工作区。 */
export async function applyAgentRound(options: AgentApplyOptions): Promise<AgentApplyResult> {
  const opened = await openRound(options.roundDir);
  if (!opened.round) return { problems: opened.problems };
  const round = opened.round;
  const at = (file: string) => ({ kind: 'input', source: join(round.dir, file) }) as const;
  if (round.applied) {
    return { problems: [severe(ProblemCodes.applyAlreadyApplied, at(APPLIED_FILE),
      `本轮已于 ${round.applied.appliedAt} 应用到 ${round.applied.workspace}；不能再次应用`)] };
  }
  const review = await readReviewRecord(round);
  if (!review.saved) {
    return { problems: [severe(ProblemCodes.reviewNotApproved, at(REVIEW_FILE), '本轮还没有审核：先用 renderweave agent review 审核并通过')] };
  }
  if (review.problems.length > 0) return { problems: review.problems };
  if (review.record.status !== 'approved') {
    return { problems: [severe(ProblemCodes.reviewNotApproved, at(REVIEW_FILE), review.record.status === 'rejected'
      ? `审核未通过${review.record.comment ? `：${review.record.comment}` : ''}；不能应用`
      : '审核还没有通过；不能应用')] };
  }
  // review.json 可能被手工改过：按其中的处理结果重新核对一遍，仍须没有严重问题。
  const state = reviewState(round, review.record);
  const view = buildView(round, review.record, true, [], state);
  if (!view.canApprove) {
    const blocking = [...view.problems, ...view.candidates.flatMap((candidate) => candidate.problems)].filter((problem) => problem.level === 'severe');
    return { problems: [severe(ProblemCodes.reviewInvalid, at(REVIEW_FILE), `审核结果与成果对不上，不能应用：${blocking.map((problem) => problem.message).join('；')}`)] };
  }

  const source = options.workspace ?? round.record.inputs.workspace.source;
  if (source === null) throw new AgentUsageError('本轮没有基于工作区：用 --workspace 指定发布到哪个工作区');
  const workspace = resolve(source);
  try {
    if (!(await stat(workspace)).isDirectory()) throw new Error('不是目录');
  } catch (error) {
    throw new AgentUsageError(`工作区目录无法读取：${source}（${describeError(error)}）`);
  }

  // 工作区自成果生成后变了：列出差异，要求明确选择覆盖或重做（M51）。
  const before = await workspaceFingerprint(workspace);
  const current = await loadWorkspaceDocuments(workspace);
  let drift: WorkspaceDrift | undefined;
  if (before !== round.outcome.inputs.workspaceFingerprint) {
    drift = await workspaceDrift(round, workspace, before, current.staticSchemas, state);
    if (!options.overwrite) {
      return { drift, problems: [severe(ProblemCodes.applyWorkspaceChanged, { kind: 'input', source: workspace },
        '工作区自成果生成后已变化：确认差异后加 --overwrite 按当前工作区发布为下一个版本，或基于当前工作区重新发起一轮')] };
    }
  }
  const failed = (problems: readonly Problem[]): AgentApplyResult => ({ ...(drift ? { drift } : {}), problems });
  if (current.problems.some((problem) => problem.level === 'severe')) return failed(current.problems);

  // 按审核时的发布顺序在当前工作区上重新发布。覆盖时版本号可能后移，候选之间的引用随之改到新版本。
  const versions = new Map<string, number>();
  const published: { candidate: string; entry: PublishedStaticSchema }[] = [];
  for (const [path, result] of state.results) {
    const document = structuredClone(state.documents.get(path)) as Record<string, unknown>;
    retargetReferences(document, (ref) => {
      const version = versions.get(`${ref.name}\0${ref.version}`);
      return version === undefined ? ref : { name: ref.name, version };
    });
    delete document['version'];
    const outcome = publishStaticSchema(document, [...current.staticSchemas, ...published.map((item) => item.entry)]);
    if (!outcome.published) {
      return failed([severe(ProblemCodes.applyFailed, at(path), `发布失败，工作区未改动：${outcome.problems.map((problem) => problem.message).join('；')}`), ...outcome.problems]);
    }
    versions.set(`${result.published!.ref.name}\0${result.published!.ref.version}`, outcome.published.ref.version);
    published.push({ candidate: path, entry: outcome.published });
  }

  const files = published.flatMap(({ candidate, entry }) => {
    const names = publishedFileNames(candidate, entry.ref.version);
    return [{ path: join(workspace, names.schema), value: entry.definition }, { path: join(workspace, names.compiled), value: entry.compiled }];
  });
  try {
    await writeExclusiveJsonFiles(files);
  } catch (error) {
    return failed([severe(ProblemCodes.applyFailed, { kind: 'input', source: workspace }, `写入失败，已撤回本次写入，工作区未改动：${describeError(error)}`)]);
  }
  const applied: AppliedRecord = {
    format: 'renderweave-applied/1', appliedAt: new Date().toISOString(), workspace, overwrite: drift !== undefined,
    fingerprints: { round: round.outcome.inputs.workspaceFingerprint, before, after: await workspaceFingerprint(workspace) },
    published: published.map(({ candidate, entry }) => {
      const names = publishedFileNames(candidate, entry.ref.version);
      return { candidate, name: entry.ref.name, version: entry.ref.version, files: [names.schema, names.compiled] };
    }),
    ...(drift ? { drift } : {}),
  };
  try {
    await writeFile(join(round.dir, APPLIED_FILE), `${JSON.stringify(applied, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    for (const file of files) await rm(file.path, { force: true });
    return failed([severe(ProblemCodes.applyFailed, at(APPLIED_FILE), `应用记录写入失败，已撤回本次写入，工作区未改动：${describeError(error)}`)]);
  }
  return { applied, ...(drift ? { drift } : {}), problems: [] };
}

async function openRound(dir: string): Promise<{ round?: AgentRound; problems: Problem[] }> {
  const root = resolve(dir);
  const fail = (file: string, message: string) => ({ problems: [severe(ProblemCodes.roundInvalid, { kind: 'input', source: join(root, file) }, message)] });
  const readJson = async (file: string): Promise<{ bytes: Buffer; value: unknown } | string> => {
    try {
      const bytes = await readFile(join(root, file));
      return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      return describeError(error);
    }
  };

  const outcomeFile = await readJson(OUTCOME_FILE);
  if (typeof outcomeFile === 'string') return fail(OUTCOME_FILE, `没有可审核的轮次成果：${outcomeFile}。结构不合格的轮次没有 outcome.json，不能审核`);
  if (!validateRoundOutcome(outcomeFile.value)) return fail(OUTCOME_FILE, 'outcome.json 不是 renderweave-outcome/1 轮次成果');
  const stored = outcomeFile.value as unknown as RoundOutcome;
  const outcome: RoundOutcome = { ...stored, locations: stored.locations ?? [] };
  const recordFile = await readJson('round.json');
  if (typeof recordFile === 'string') return fail('round.json', `轮次记录无法读取：${recordFile}`);
  const record = recordFile.value as RoundRecord;
  if (!isRecord(record) || !isRecord(record.inputs) || typeof record.inputs.sample?.file !== 'string' || !/^agent\/sample\.(png|jpg|webp)$/.test(record.inputs.sample.file)) {
    return fail('round.json', 'round.json 不是 renderweave-round/1 轮次记录');
  }

  const candidates: RoundCandidate[] = [];
  for (const candidate of outcome.candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, candidate.path));
    } catch (error) {
      return fail(candidate.path, `候选文件无法读取：${describeError(error)}`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== candidate.sha256) return fail(candidate.path, `候选文件自成果生成后被改动：${candidate.path}`);
    candidates.push({ path: candidate.path, kind: candidate.kind, ...(candidate.name !== undefined ? { name: candidate.name } : {}), document: JSON.parse(bytes.toString('utf8')) });
  }
  for (const item of [...outcome.pending, ...outcome.locations]) {
    if (!candidates.some((candidate) => candidate.path === item.file)) return fail(OUTCOME_FILE, `待确认项或图上位置指向的文件不在候选中：${item.file}`);
  }
  const { staticSchemas } = await loadWorkspaceDocuments(join(root, 'snapshot'));
  let applied: AppliedRecord | undefined;
  const appliedFile = await readJson(APPLIED_FILE);
  if (typeof appliedFile !== 'string') applied = appliedFile.value as AppliedRecord;
  else if (await exists(join(root, APPLIED_FILE))) return fail(APPLIED_FILE, `应用记录无法读取：${appliedFile}`);
  return {
    round: {
      dir: root, outcome, outcomeSha256: createHash('sha256').update(outcomeFile.bytes).digest('hex'), record, candidates, snapshot: staticSchemas,
      ...(applied ? { applied } : {}),
    },
    problems: [],
  };
}

/** 读 review.json；没有时给出空白的审核结果。不可读、不合格或针对的不是当前成果时带问题，此时不能继续审核或应用。 */
async function readReviewRecord(round: AgentRound): Promise<{ record: ReviewRecord; saved: boolean; problems: Problem[] }> {
  const blank: ReviewRecord = {
    format: 'renderweave-review/1', outcomeSha256: round.outcomeSha256, status: 'inProgress', decisions: [], restConfirmed: false, updatedAt: '',
  };
  const file = join(round.dir, REVIEW_FILE);
  const invalid = (message: string) => ({ record: blank, saved: true, problems: [severe(ProblemCodes.reviewInvalid, { kind: 'input', source: file }, message)] });
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') return { record: blank, saved: false, problems: [] };
    return invalid(`review.json 无法读取：${describeError(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return invalid(`review.json 不是有效的 JSON：${describeError(error)}`);
  }
  if (!validateReviewRecord(value)) return invalid('review.json 不是 renderweave-review/1 审核结果');
  const record = value as unknown as ReviewRecord;
  if (record.outcomeSha256 !== round.outcomeSha256) return invalid('审核结果针对的是另一份成果（outcome.json 已变化）；删除 review.json 后重新审核');
  const seen = new Set<number>();
  for (const decision of record.decisions) {
    const pending = round.outcome.pending[decision.item - 1];
    if (!pending || pending.file !== decision.file || pending.path !== decision.path) return invalid(`处理结果 ${decision.item} 与待确认项对不上`);
    if (seen.has(decision.item)) return invalid(`待确认项 ${decision.item} 有多个处理结果`);
    seen.add(decision.item);
    if ((decision.action === 'edit') !== (decision.value !== undefined) || (decision.action === 'edit' && !isRecord(decision.value))) {
      return invalid(`处理结果 ${decision.item}：只有改值带新值，且新值是 JSON 对象`);
    }
  }
  return { record, saved: true, problems: [] };
}

async function saveReviewRecord(dir: string, record: ReviewRecord): Promise<void> {
  const target = join(dir, REVIEW_FILE), temporary = join(dir, `.review-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  try {
    // 整份替换：关闭后重开总能读到一份完整的审核结果。Windows 上替换偶尔短暂被拒，有界重试。
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        if (process.platform !== 'win32' || attempt >= 7 || !isRecord(error) || !['EPERM', 'EACCES', 'EBUSY'].includes(String(error['code']))) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

interface ReviewState {
  /** 作用了处理结果之后、仍要发布的候选文档。 */
  readonly documents: ReadonlyMap<string, unknown>;
  readonly dropped: ReadonlySet<string>;
  readonly wholeEdited: ReadonlySet<string>;
  /** 候选文件 → 字段名 → 审核时的改动。 */
  readonly fieldChanges: ReadonlyMap<string, ReadonlyMap<string, { readonly action: 'edit' | 'empty'; readonly value?: unknown }>>;
  /** 在工作区快照上按依赖顺序于内存中发布的结果，按发布顺序排列。 */
  readonly results: ReadonlyMap<string, { published?: PublishedStaticSchema; problems: Problem[] }>;
  readonly problems: readonly Problem[];
}

/** 把处理结果作用到候选上，再在快照上发布一遍。 */
function reviewState(round: AgentRound, record: ReviewRecord): ReviewState {
  const problems: Problem[] = [];
  const source = join(round.dir, REVIEW_FILE);
  // 同一位置的处理结果必须一致；整份改动与字段改动不能同时出现。
  const byLocation = new Map<string, ReviewDecision[]>();
  for (const decision of record.decisions) {
    const key = `${decision.file}\0${decision.path ?? ''}`;
    byLocation.set(key, [...(byLocation.get(key) ?? []), decision]);
  }
  const effective = new Map<string, ReviewDecision>();
  for (const [key, decisions] of byLocation) {
    const effects = new Set(decisions.map((decision) => canonical({ action: decision.action, value: decision.value })));
    if (effects.size > 1) {
      problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source },
        `待确认项 ${decisions.map((decision) => decision.item).join('、')} 指向同一位置，处理结果不一致`));
      continue;
    }
    if (decisions[0]!.action !== 'adopt') effective.set(key, decisions[0]!);
  }
  const documents = new Map<string, unknown>(), dropped = new Set<string>(), wholeEdited = new Set<string>();
  const fieldChanges = new Map<string, Map<string, { action: 'edit' | 'empty'; value?: unknown }>>();
  for (const candidate of round.candidates) {
    const whole = effective.get(`${candidate.path}\0`);
    const fields = [...effective.values()].filter((decision) => decision.file === candidate.path && decision.path !== undefined);
    if (whole && fields.length > 0) {
      problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source },
        `${candidate.path} 既整份处理（待确认项 ${whole.item}），又处理了其中的字段（待确认项 ${fields.map((decision) => decision.item).join('、')}）`));
    }
    if (whole?.action === 'empty') {
      dropped.add(candidate.path);
      continue;
    }
    if (whole?.action === 'edit') {
      wholeEdited.add(candidate.path);
      documents.set(candidate.path, structuredClone(whole.value));
      continue;
    }
    const changes = new Map(fields.map((decision) => [decision.path!, { action: decision.action as 'edit' | 'empty', ...(decision.action === 'edit' ? { value: decision.value } : {}) }]));
    fieldChanges.set(candidate.path, changes);
    const document = structuredClone(candidate.document);
    if (changes.size > 0 && isRecord(document) && Array.isArray(document['fields'])) {
      document['fields'] = document['fields'].flatMap((field: unknown) => {
        const change = isRecord(field) && typeof field['name'] === 'string' ? changes.get(field['name']) : undefined;
        return change === undefined ? [field] : change.action === 'empty' ? [] : [structuredClone(change.value)];
      });
    }
    documents.set(candidate.path, document);
  }
  const definitions = round.candidates.filter((candidate) => candidate.kind === 'definition' && documents.has(candidate.path))
    .map((candidate) => ({ path: candidate.path, document: documents.get(candidate.path) }));
  return { documents, dropped, wholeEdited, fieldChanges, results: publishInDependencyOrder(definitions, round.snapshot), problems };
}

function buildView(round: AgentRound, record: ReviewRecord, saved: boolean, recordProblems: readonly Problem[], computed?: ReviewState): ReviewView {
  const state = computed ?? reviewState(round, record);
  const problems: Problem[] = [...recordProblems, ...state.problems];
  const decisions = new Map(record.decisions.map((decision) => [decision.item, decision]));
  const locate = (file: string, path?: string) => round.outcome.locations.find((location) => location.file === file && location.path === path);
  const pending: PendingView[] = round.outcome.pending.map((item, index) => {
    const candidate = round.candidates.find((entry) => entry.path === item.file);
    const decision = decisions.get(index + 1);
    const location = locate(item.file, item.path);
    const current = item.path === undefined ? candidate?.document : fieldsOf(candidate?.document).find((field) => field['name'] === item.path);
    return {
      ...item, item: index + 1, reasonName: REASON_NAMES[item.reason] ?? item.reason,
      ...(current !== undefined ? { current } : {}), ...(decision ? { decision } : {}), ...(location ? { location } : {}),
    };
  });
  for (const item of pending) {
    if (!item.decision) {
      problems.push(severe(ProblemCodes.reviewPending, { kind: 'input', source: `${OUTCOME_FILE}#pending[${item.item}]` },
        `待确认项 ${item.item} 尚未处理：${item.file}${item.path !== undefined ? ` · ${item.path}` : ''}`));
    }
  }
  if (!record.restConfirmed) problems.push(severe(ProblemCodes.reviewPending, { kind: 'input', source: join(round.dir, REVIEW_FILE) }, '其余内容尚未整体确认'));

  const candidates: CandidateView[] = round.candidates.map((candidate) => {
    const document = state.documents.get(candidate.path);
    const result = state.results.get(candidate.path);
    const changes = state.fieldChanges.get(candidate.path) ?? new Map();
    const whole = state.wholeEdited.has(candidate.path);
    const pendingFor = (name: string) => pending.filter((item) => item.file === candidate.path && item.path === name).map((item) => item.item);
    // 整份改值时按字段名与原文比对：没变的保留，变了或新加的标为改过，原有而被删掉的标为已删去。
    const original = new Map(fieldsOf(candidate.document).map((field) => [String(field['name']), field]));
    const fields: FieldView[] = whole
      ? [
        ...fieldsOf(document).map((field) => {
          const name = String(field['name']), before = original.get(name);
          return fieldView(field, before !== undefined && canonical(before) === canonical(field) ? 'kept' : 'edited', locate(candidate.path, name), pendingFor(name));
        }),
        ...[...original].filter(([name]) => !fieldsOf(document).some((field) => String(field['name']) === name))
          .map(([name, field]) => fieldView(field, 'removed', locate(candidate.path, name), pendingFor(name))),
      ]
      : fieldsOf(candidate.document).map((field) => {
        const name = String(field['name']);
        const change = changes.get(name);
        const shown = change?.action === 'edit' && isRecord(change.value) ? change.value : field;
        return fieldView(shown, change === undefined ? 'kept' : change.action === 'edit' ? 'edited' : 'removed', locate(candidate.path, name), pendingFor(name));
      });
    const compiled = result?.published?.compiled;
    const shownDocument = document ?? candidate.document;
    const location = locate(candidate.path);
    return {
      path: candidate.path, kind: candidate.kind,
      ...(isRecord(shownDocument) && typeof shownDocument['name'] === 'string' ? { name: shownDocument['name'] } : candidate.name !== undefined ? { name: candidate.name } : {}),
      ...(isRecord(shownDocument) && typeof shownDocument['displayName'] === 'string' ? { displayName: shownDocument['displayName'] } : {}),
      ...(isRecord(shownDocument) && typeof shownDocument['description'] === 'string' ? { description: shownDocument['description'] } : {}),
      dropped: state.dropped.has(candidate.path), edited: whole,
      ...(document !== undefined ? { document } : {}),
      fields, ...(location ? { location } : {}),
      ...(result?.published ? { published: result.published.ref } : {}),
      ...(compiled ? { compiled: {
        ...(typeof compiled['title'] === 'string' ? { title: compiled['title'] } : {}),
        properties: isRecord(compiled['properties']) ? Object.keys(compiled['properties']).length : 0,
        required: Array.isArray(compiled['required']) ? compiled['required'].map(String) : [],
        schema: compiled,
      } } : {}),
      problems: result?.problems ?? [],
    };
  });
  const severeFound = problems.some((problem) => problem.level === 'severe') ||
    candidates.some((candidate) => candidate.problems.some((problem) => problem.level === 'severe'));
  const sample = round.record.inputs.sample.file;
  return {
    round: {
      dir: round.dir, task: round.outcome.task, taskName: AGENT_TASKS[round.outcome.task].name, verdict: round.record.verdict,
      sample, workspace: round.record.inputs.workspace?.source ?? null, notes: round.outcome.notes, usage: round.outcome.usage,
    },
    review: record, saved, pending, candidates, problems, canApprove: !severeFound,
    ...(round.applied ? { applied: round.applied } : {}),
  };
}

function fieldView(field: Record<string, unknown>, state: FieldView['state'], location: FieldLocation | undefined, pending: number[]): FieldView {
  const constraints = constraintLabels(field['constraints']);
  if (field['type'] === 'list' && isRecord(field['items'])) constraints.push(...constraintLabels(field['items']['constraints']).map((label) => `每项${label}`));
  return {
    name: String(field['name']),
    ...(typeof field['displayName'] === 'string' ? { displayName: field['displayName'] } : {}),
    ...(typeof field['description'] === 'string' ? { description: field['description'] } : {}),
    type: typeLabel(field), constraints, ...(location ? { location } : {}), pending, state,
  };
}

function typeLabel(field: Record<string, unknown>): string {
  const type = String(field['type']);
  if (type === 'ref') return `引用 ${refLabel(field['ref'])}`;
  if (type === 'list') return `列表<${isRecord(field['items']) ? typeLabel(field['items']) : '?'}>`;
  return TYPE_NAMES[type] ?? type;
}

function refLabel(ref: unknown): string {
  return isRecord(ref) ? `${String(ref['name'])} v${String(ref['version'])}` : '?';
}

function constraintLabels(constraints: unknown): string[] {
  if (!isRecord(constraints)) return [];
  const labels: string[] = [];
  const range = (label: string, min: unknown, max: unknown) => {
    if (min !== undefined && max !== undefined) labels.push(`${label} ${String(min)}–${String(max)}`);
    else if (min !== undefined) labels.push(`${label} ≥ ${String(min)}`);
    else if (max !== undefined) labels.push(`${label} ≤ ${String(max)}`);
  };
  if (constraints['required'] === true) labels.push('必填');
  range('长度', constraints['minLength'], constraints['maxLength']);
  range('取值', constraints['min'], constraints['max']);
  range('项数', constraints['minItems'], constraints['maxItems']);
  if (constraints['integer'] === true) labels.push('整数');
  if (Array.isArray(constraints['enum'])) labels.push(`可选值 ${constraints['enum'].map(String).join('、')}`);
  if (typeof constraints['pattern'] === 'string') labels.push(`格式 ${constraints['pattern']}`);
  if (Array.isArray(constraints['allowedSources'])) labels.push(`来源 ${constraints['allowedSources'].map(String).join('、')}`);
  const known = ['required', 'minLength', 'maxLength', 'min', 'max', 'minItems', 'maxItems', 'integer', 'enum', 'pattern', 'allowedSources'];
  for (const [key, value] of Object.entries(constraints)) if (!known.includes(key)) labels.push(`${key} ${JSON.stringify(value)}`);
  return labels;
}

function fieldsOf(document: unknown): Record<string, unknown>[] {
  return isRecord(document) && Array.isArray(document['fields']) ? document['fields'].filter(isRecord) : [];
}

/** 改写定义中字段与列表项的引用。 */
function retargetReferences(document: Record<string, unknown>, retarget: (ref: StaticSchemaRef) => StaticSchemaRef): void {
  for (const field of fieldsOf(document)) {
    for (const holder of [field, field['items']]) {
      if (isRecord(holder) && isRecord(holder['ref']) && typeof holder['ref']['name'] === 'string' && typeof holder['ref']['version'] === 'number') {
        holder['ref'] = retarget({ name: holder['ref']['name'], version: holder['ref']['version'] });
      }
    }
  }
}

async function workspaceDrift(round: AgentRound, workspace: string, actual: string, current: readonly StaticSchemaEntry[], state: ReviewState): Promise<WorkspaceDrift> {
  const before = await jsonFileHashes(join(round.dir, 'snapshot'));
  const after = await jsonFileHashes(workspace);
  const latest = (entries: readonly StaticSchemaEntry[], name: string) => {
    const versions = entries.filter((entry) => entry.ref.name === name).map((entry) => entry.ref.version);
    return versions.length === 0 ? null : Math.max(...versions);
  };
  const names = [...state.results.values()].flatMap((result) => (result.published ? [result.published.ref.name] : []));
  return {
    expected: round.outcome.inputs.workspaceFingerprint, actual,
    added: [...after.keys()].filter((file) => !before.has(file)),
    removed: [...before.keys()].filter((file) => !after.has(file)),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
    newerDefinitions: names.flatMap((name) => {
      const snapshot = latest(round.snapshot, name), now = latest(current, name);
      return now !== null && (snapshot === null || now > snapshot) ? [{ name, snapshot, workspace: now }] : [];
    }),
  };
}

async function jsonFileHashes(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    hashes.set(file, createHash('sha256').update(await readFile(join(dir, file))).digest('hex'));
  }
  return hashes;
}

/** 键排序后的 JSON，用来比较两个处理结果是否相同。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/** 备注：没有给出时为 undefined；给了却不是文本时为 null。 */
function optionalComment(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value.trim() : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
