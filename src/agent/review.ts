/**
 * 审核与应用（M46、M47、M18、M51、M52；第三阶段 PRD 第 10、11 条）。
 *
 * 审核结果保存在轮次目录的 review.json。它在 Agent 工作目录之外，Agent 写不到。待确认项逐项处理（位置的写法见 locations.ts）：
 * - 采纳候选（adopt）：数据定义与模板保留候选文件中该位置的写法；数据集把候选值写到该位置，没有候选值时保留文件中的值；
 * - 改值（edit）：用审核人给的值替换该位置；省略位置时替换整份文件；
 * - 标为空（empty）：删去该位置；省略位置时不写入这份候选。
 *
 * 其余内容整体确认一次。审核视图把处理结果作用到候选上，在工作区快照上重新校验，给出字段清单、数据清单或元素清单；
 * 有出图请求时，由 RenderWeave 重新渲染草稿预览（M52）。数据集中还没处理的待确认项用候选值预览（M46）。
 *
 * 模板辅助修改另有修改前的预览，候选带相对已保存模板的结构化差异（M49–M52）。
 *
 * 应用只接受审核通过的轮次：先核对成果与候选没有被改动，再比对工作区指纹。工作区已变化时列出差异并拒绝，除非明确选择覆盖；
 * 模板辅助修改要改的模板已被他人保存时，另列出他人的改动（M51）。
 * 在当前工作区上重新校验，全部通过后再写入：数据定义发布为下一个版本，数据集与新模板作为新文件保存，
 * 模板的工作副本整份替换已保存的文件，与已保存内容相同的不写；任何失败都撤回本次写入。
 *
 * 下一轮（M58）由 readPreviousRound 读出上一轮成果（含审核时的修改）；轮次链沿 round.json 的 previous 追溯。
 */
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { createMemoryResourceRepository } from '../resources.js';
import { publishStaticSchema, type PublishedStaticSchema } from '../schema/publish.js';
import { publishedFileNames } from '../schema/publish-files.js';
import { describeError, isRecord } from '../util.js';
import { loadWorkspace, loadWorkspaceDocuments, type StaticSchemaEntry, type StaticSchemaRef, type Workspace } from '../workspace.js';
import { checkCandidates, type CandidateContext, type CandidateResult } from './candidates.js';
import { assessCandidates } from './assessment.js';
import { canonical, diffTemplate, revisionDiff, type RevisionDiff, type TemplateChange } from './diff.js';
import { applyChanges, flattenData, flattenElements, fullElementPath, locate, overlaps, read, within, type Change } from './locations.js';
import { DRAFT_FILE, OUTCOME_FILE, SUBMITTED_OUTCOME_SCHEMA, candidateName, type FieldLocation, type PendingItem, type PendingReason } from './outcome.js';
import { renderPreview, type PreviewView } from './preview.js';
import { AgentUsageError, exists, jsonFileHashes, sha256, workspaceFingerprint } from './round-files.js';
import type { RoundOutcome, RoundRecord, RoundUsage } from './run.js';
import { replaceFile, writeJsonFiles, type JsonFileWrite } from './write-files.js';
import { AGENT_TASKS, type AgentTaskId, type CandidateKind } from './tasks.js';
import { captureResources, contentIdentity, readResourceSnapshot, resourceDifferences, trackResources, type ContentIdentity, type ResourceSnapshotRef, type ResourceIdentity } from './content-identity.js';
import { readExecution, type RoundExecution } from './execution.js';
import { localAccessProblem, withLocalAccess } from '../local-access.js';

export const REVIEW_FILE = 'review.json';
export const APPLIED_FILE = 'applied.json';
export const REVIEW_ACTIONS = ['adopt', 'edit', 'empty'] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
export type ReviewStatus = 'inProgress' | 'approved' | 'rejected';
export type { PreviewView } from './preview.js';

/** 一个待确认项的处理结果。 */
export interface ReviewDecision {
  /** 待确认项序号，从 1 开始，对应 outcome.json 的 pending。 */
  readonly item: number;
  /** 抄自待确认项，便于直接阅读 review.json。 */
  readonly file: string;
  readonly path?: string;
  readonly action: ReviewAction;
  /** 改值时的新值：数据定义中是整个字段，模板中是整个元素，数据集中是该位置的值；省略位置时是整份文件。 */
  readonly value?: unknown;
}

/** 审核结果 review.json。 */
export interface ReviewRecord {
  readonly format: 'renderweave-review/1';
  readonly contentIdentity?: ContentIdentity;
  readonly resourceSnapshot?: ResourceSnapshotRef;
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
  readonly contentIdentity?: ContentIdentity;
  readonly round: {
    readonly dir: string;
    readonly task: AgentTaskId;
    readonly taskName: string;
    /** 成果校验的结论；不合格的成果也可以审核，改好后才能通过。 */
    readonly verdict: RoundRecord['verdict'];
    readonly source: 'agent' | 'hostRecovery';
    /** 示例图在轮次目录中的位置。 */
    readonly sample: string;
    /** 本轮基于的工作区，应用时缺省写到这里。 */
    readonly workspace: string | null;
    readonly notes: string;
    readonly usage: RoundUsage;
    /** 第几轮。 */
    readonly round: number;
    /** 轮次链：从第 1 轮到本轮。 */
    readonly chain: readonly RoundLink[];
    /** 模板辅助修改的修改要求、下一轮的反馈：原文，按纯文本显示。 */
    readonly requirement?: string;
    readonly feedback?: string;
  };
  readonly review: ReviewRecord;
  /** review.json 是否已经存在。 */
  readonly saved: boolean;
  readonly pending: readonly PendingView[];
  readonly candidates: readonly CandidateView[];
  /** 由 RenderWeave 重新渲染的草稿预览；本轮有出图请求时才有。模板辅助修改时是修改后的预览。 */
  readonly preview?: PreviewView;
  /** 模板辅助修改：修改前的预览，用已保存的模板渲染（M50、M52）。 */
  readonly previewBefore?: PreviewView;
  /** 审核层面的问题：未处理的待确认项、未整体确认、处理结果矛盾、review.json 不合格。候选的引擎问题在各候选中。 */
  readonly problems: readonly Problem[];
  /** 没有任何严重问题（含候选的引擎问题，以及模板辅助设计的预览问题）时才能通过。 */
  readonly canApprove: boolean;
  readonly applied?: AppliedRecord;
}

/** 轮次链上的一轮。 */
export interface RoundLink {
  readonly round: number;
  readonly dir: string;
  readonly task?: AgentTaskId;
  readonly verdict?: RoundRecord['verdict'];
  readonly review?: ReviewStatus;
  readonly applied: boolean;
  /** 轮次目录或 round.json 读不到：链在这里断开。 */
  readonly missing?: boolean;
}

/** 模板辅助修改中一份模板候选相对已保存内容的差异。 */
export interface RevisionView extends RevisionDiff {
  /** 工作副本所基于的保存内容（M51）；新增的模板没有。 */
  readonly basis?: { readonly file: string; readonly sha256: string };
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
  /** 数据定义与模板的名称，数据集的 id。 */
  readonly name?: string;
  readonly displayName?: string;
  readonly description?: string;
  /** 整份标为空：不写入。 */
  readonly dropped: boolean;
  /** 整份改过。 */
  readonly edited: boolean;
  /** 作用了处理结果之后的文档。 */
  readonly document?: unknown;
  /** 数据定义的字段清单；其他种类为空。 */
  readonly fields: readonly FieldView[];
  /** 数据集的数据清单：逐个叶子值。 */
  readonly entries?: readonly EntryView[];
  /** 数据集选定的数据定义。 */
  readonly staticSchema?: StaticSchemaRef;
  /** 模板的元素清单与对外参数、基准。 */
  readonly elements?: readonly ElementView[];
  readonly template?: { readonly base?: StaticSchemaRef; readonly parameters: readonly ParameterView[] };
  /** 整份候选在图上的位置。 */
  readonly location?: FieldLocation;
  /** 在工作区快照上于内存中发布成的名称与版本。 */
  readonly published?: StaticSchemaRef;
  readonly compiled?: CompiledSummary;
  /** 模板辅助修改：审核后的工作副本相对已保存模板的差异。 */
  readonly revision?: RevisionView;
  readonly problems: readonly Problem[];
}

/** kept 保留原样；edited 审核时改过；removed 审核时标为空，不再出现在文档中。 */
export type ItemState = 'kept' | 'edited' | 'removed';

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
  readonly state: ItemState;
}

export interface EntryView {
  /** 字段路径，如 stations[3].name。 */
  readonly path: string;
  readonly value: unknown;
  readonly location?: FieldLocation;
  /** 位置与它重叠的待确认项序号。 */
  readonly pending: readonly number[];
  readonly state: ItemState;
}

export interface ElementView {
  /** 元素路径，如 胸牌/姓名区/姓名。 */
  readonly path: string;
  readonly type: string;
  readonly location?: FieldLocation;
  readonly pending: readonly number[];
  readonly state: ItemState;
}

export interface ParameterView {
  readonly name: string;
  readonly displayName?: string;
  readonly type?: string;
  readonly visibility?: string;
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
  /** 模板辅助修改：要改的模板已被他人保存（M51）。 */
  readonly templates?: readonly TemplateConflict[];
}

/** 工作副本所基于的模板在快照之后又被保存过。 */
export interface TemplateConflict {
  readonly name: string;
  readonly basis: { readonly file: string; readonly sha256: string };
  /** 当前工作区中保存这份模板的文件；模板已被删去时为 null。 */
  readonly current: { readonly file: string; readonly sha256: string } | null;
  /** 他人在基准之后做的改动。 */
  readonly changes: readonly TemplateChange[];
}

/** 应用记录 applied.json：写在轮次目录，本轮不能再次应用。 */
export interface AppliedRecord {
  readonly format: 'renderweave-applied/1';
  readonly contentIdentity?: string;
  readonly appliedAt: string;
  readonly workspace: string;
  /** 工作区已变化时明确选择了覆盖。 */
  readonly overwrite: boolean;
  readonly fingerprints: { readonly round: string; readonly before: string; readonly after: string };
  /** 写入的内容：数据定义带发布的版本，数据集与模板没有版本；replaced 表示工作副本替换了已保存的模板。 */
  readonly published: readonly {
    readonly candidate: string; readonly kind: CandidateKind; readonly name: string; readonly version?: number; readonly files: readonly string[];
    readonly replaced?: boolean;
  }[];
  /** 与已保存内容相同、没有写入的工作副本（模板名）。 */
  readonly unchanged?: readonly string[];
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
const KIND_NAMES: Record<CandidateKind, string> = { definition: '定义', dataset: '数据集', template: '模板' };
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
    contentIdentity: { type: 'object', required: ['format', 'id', 'resources'], properties: { format: { const: 'renderweave-content-identity/1' }, id: { type: 'string' }, resources: { type: 'array' } } },
    resourceSnapshot: { type: 'object', required: ['directory', 'sha256'], properties: { directory: { type: 'string' }, sha256: { type: 'string' } } },
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

interface RoundCandidate {
  readonly path: string; readonly kind: CandidateKind; readonly name?: string; readonly document: unknown;
  readonly revises?: { readonly file: string; readonly sha256: string };
}

/** 读入并核对过的轮次：成果、运行记录、候选、工作区快照与出图请求。 */
interface AgentRound {
  readonly resourceSnapshot?: ResourceSnapshotRef;
  readonly resourceIdentity?: readonly ResourceIdentity[];
  readonly recovered: boolean;
  readonly dir: string;
  readonly outcome: RoundOutcome;
  readonly outcomeSha256: string;
  readonly record: RoundRecord;
  readonly candidates: readonly RoundCandidate[];
  /** 工作区快照，连同资源仓库（有记录时）。 */
  readonly workspace: Workspace;
  readonly resourcesDir?: string;
  readonly context: CandidateContext;
  /** 规范化后的出图请求（轮次目录的 request.json）。 */
  readonly request?: Record<string, unknown>;
  readonly requirement?: string;
  readonly feedback?: string;
  readonly applied?: AppliedRecord;
}

/** 读取一轮的审核视图；轮次本身不完整或被改动时没有视图，只有问题。 */
export async function readReview(roundDir: string): Promise<{ view?: ReviewView; execution?: RoundExecution; problems: Problem[] }> {
  try { return await readReviewCaptured(roundDir); }
  catch (error) { const problem = localAccessProblem(error); if (problem) return { problems: [problem] }; throw error; }
}
async function openReview(roundDir: string) {
  try { return await withLocalAccess([roundDir], async () => {
    const opened = await openRound(roundDir);
    return { ...opened, review: opened.round ? await readReviewRecord(opened.round) : undefined };
  }, 1000); } catch (error) {
    if (localAccessProblem(error)) throw error;
    return { round: undefined, review: undefined, problems: [severe(ProblemCodes.roundInvalid,
      { kind: 'input', source: roundDir }, `轮次无法读取：${describeError(error)}`)] };
  }
}
async function readReviewCaptured(roundDir: string): Promise<{ view?: ReviewView; execution?: RoundExecution; problems: Problem[] }> {
  const execution = await readExecution(roundDir);
  if (execution.problems.length || (execution.execution && !execution.execution.committed)) return execution;
  const opened = await openReview(roundDir);
  if (!opened.round) return { problems: opened.problems, execution: execution.execution };
  const { record, saved, problems } = opened.review!;
  return { view: await buildView(opened.round, record, saved, problems), execution: execution.execution, problems: [] };
}

/**
 * 做一次审核操作并保存 review.json。被拒绝时不写文件，problems 说明原因。
 * 给出结论（通过或未通过）后不能再改处理结果，要先撤回结论（reopen）；本轮应用后不能再改。
 */
export async function changeReview(roundDir: string, change: unknown): Promise<{ view?: ReviewView; problems: Problem[] }> {
  try { return await changeReviewCaptured(roundDir, change); }
  catch (error) { const problem = localAccessProblem(error); if (problem) return { problems: [problem] }; throw error; }
}
async function changeReviewCaptured(roundDir: string, change: unknown): Promise<{ view?: ReviewView; problems: Problem[] }> {
  const opened = await openReview(roundDir);
  if (!opened.round) return { problems: opened.problems };
  let round = opened.round;
  const current = opened.review!;
  const view = () => buildView(round, current.record, current.saved, current.problems);
  const refuse = async (message: string, code: Problem['code'] = ProblemCodes.reviewInvalid) =>
    ({ view: await view(), problems: [severe(code, { kind: 'input', source: join(round.dir, REVIEW_FILE) }, message)] });

  if (round.recovered) return refuse('宿主抢救的中断草稿只能查看；请用 --from 带反馈续跑后再审核');
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
      if (action === 'edit') {
        const invalid = editValueProblem(kindOf(round, pending.file), pending.path, value);
        if (invalid) return refuse(invalid);
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
      const before = await view();
      if (!before.canApprove) {
        return { view: before, problems: [severe(ProblemCodes.reviewPending, { kind: 'input', source: join(round.dir, REVIEW_FILE) },
          `还不能通过：${blockingProblems(before).map((problem) => problem.message).join('；')}`)] };
      }
      const { comment: _comment, ...rest } = record;
      next = { ...rest, contentIdentity: before.contentIdentity!, status: 'approved', ...(comment ? { comment } : {}), updatedAt: now, decidedAt: now };
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
      if (inProgress && round.resourceSnapshot && !(await view()).problems.some(p => p.code === ProblemCodes.applyResourcesChanged)) return refuse('审核还在进行，没有可撤回的结论');
      const { comment: _comment, decidedAt: _decidedAt, contentIdentity: _identity, ...rest } = record;
      if (current.saved) {
        await mkdir(join(round.dir, 'reviews'), { recursive: true });
        await writeFile(join(round.dir, 'reviews', `${sha256(JSON.stringify(record))}.json`), JSON.stringify(record, null, 2));
      }
      if (round.resourcesDir) {
        try {
          const resourceSnapshot = await captureResources(round.dir, round.resourcesDir);
          round = { ...round, resourceSnapshot, resourceIdentity: (await readResourceSnapshot(round.dir, resourceSnapshot)).resources,
            workspace: await loadRoundWorkspace(join(round.dir, 'snapshot'), join(round.dir, resourceSnapshot.directory)) };
          next = { ...rest, resourceSnapshot, restConfirmed: false, status: 'inProgress', updatedAt: now };
        } catch (error) { return refuse(`无法重新固定资源：${describeError(error)}`); }
      } else next = { ...rest, restConfirmed: false, status: 'inProgress', updatedAt: now };
      break;
    }
    default:
      return refuse(`无法识别的审核操作：${change['type']}`);
  }
  const conflict = await withLocalAccess([round.dir, ...(round.resourcesDir ? [round.resourcesDir] : [])], async () => {
    const latest = await readReviewRecord(round);
    if (await exists(join(round.dir, APPLIED_FILE)) || latest.saved !== current.saved || canonical(latest.record) !== canonical(current.record)) {
      return severe(ProblemCodes.applyConcurrentChange, { kind: 'input', source: round.dir }, '审核或应用状态已被另一操作改变；请刷新后重试');
    }
    if (next.status === 'approved' && round.resourcesDir) {
      const changed = await resourceDifferences(round.resourcesDir, next.contentIdentity!.resources);
      if (changed.length) return changed[0];
    }
    await saveReviewRecord(round.dir, next);
    return undefined;
  });
  if (conflict) return { problems: [conflict] };
  return { view: await buildView(round, next, true, []), problems: [] };
}

/**
 * 应用审核通过的轮次：数据定义经发布入口发布为下一个版本（M18），数据集与模板作为新文件保存到工作区（M49 的"应用即保存"）。
 */
export async function applyAgentRound(options: AgentApplyOptions): Promise<AgentApplyResult> {
  try { return await applyCapturedRound(options); }
  catch (error) { const problem = localAccessProblem(error); if (problem) return { problems: [problem] }; throw error; }
}
async function applyCapturedRound(options: AgentApplyOptions): Promise<AgentApplyResult> {
  const opened = await openReview(options.roundDir);
  if (!opened.round) return { problems: opened.problems };
  const round = opened.round;
  const at = (file: string) => ({ kind: 'input', source: join(round.dir, file) }) as const;
  if (round.applied) {
    return { problems: [severe(ProblemCodes.applyAlreadyApplied, at(APPLIED_FILE),
      `本轮已于 ${round.applied.appliedAt} 应用到 ${round.applied.workspace}；不能再次应用`)] };
  }
  const review = opened.review!;
  if (!review.saved) {
    return { problems: [severe(ProblemCodes.reviewNotApproved, at(REVIEW_FILE), '本轮还没有审核：先用 renderweave agent review 审核并通过')] };
  }
  if (review.problems.length > 0) return { problems: review.problems };
  if (review.record.status !== 'approved') {
    return { problems: [severe(ProblemCodes.reviewNotApproved, at(REVIEW_FILE), review.record.status === 'rejected'
      ? `审核未通过${review.record.comment ? `：${review.record.comment}` : ''}；不能应用`
      : '审核还没有通过；不能应用')] };
  }
  if (!review.record.contentIdentity || !round.resourceSnapshot) return { problems: [severe(ProblemCodes.reviewInvalid, at(REVIEW_FILE),
    '历史批准没有完整内容与资源身份，不能补造当时版本；请在 agent review 撤回结论，按当前资源重新检查预览、整体确认并核准')] };
  const resourceProblems = round.resourcesDir ? await resourceDifferences(round.resourcesDir, review.record.contentIdentity.resources) : [];
  if (resourceProblems.length) return { problems: resourceProblems };
  // review.json 可能被手工改过：按其中的处理结果重新核对一遍，仍须没有严重问题。
  const state = reviewState(round, review.record);
  const view = await buildView(round, review.record, true, [], state);
  if (view.contentIdentity?.id !== review.record.contentIdentity.id) return { problems: [severe(ProblemCodes.reviewInvalid, at(REVIEW_FILE),
    '当前内容或判据已不对应批准身份；请撤回结论，重新检查预览、整体确认并核准')] };
  if (!view.canApprove) {
    return { problems: [severe(ProblemCodes.reviewInvalid, at(REVIEW_FILE), `审核结果与成果对不上，不能应用：${blockingProblems(view).map((problem) => problem.message).join('；')}`)] };
  }

  const source = options.workspace ?? round.record.inputs.workspace.source;
  if (source === null) throw new AgentUsageError('本轮没有基于工作区：用 --workspace 指定发布到哪个工作区');
  const workspace = resolve(source);
  try {
    if (!(await stat(workspace)).isDirectory()) throw new Error('不是目录');
  } catch (error) {
    throw new AgentUsageError(`工作区目录无法读取：${source}（${describeError(error)}）`);
  }

  // 工作区自成果生成后变了：列出差异，要求明确选择覆盖或重做（M51）。要改的模板已被他人保存时，另列出他人的改动。
  const { before, currentWorkspace } = await withLocalAccess([workspace, ...(round.resourcesDir ? [round.resourcesDir] : [])], async () => ({
    before: await workspaceFingerprint(workspace), currentWorkspace: await loadRoundWorkspace(workspace, round.resourcesDir),
  }));
  const applicationResources = trackResources(currentWorkspace.resources, review.record.contentIdentity.resources);
  const current = { ...currentWorkspace, resources: applicationResources.repository };
  let drift: WorkspaceDrift | undefined;
  if (before !== round.outcome.inputs.workspaceFingerprint) {
    drift = await workspaceDrift(round, workspace, before, current, state);
    if (!options.overwrite) {
      return { drift, problems: [severe(ProblemCodes.applyWorkspaceChanged, { kind: 'input', source: workspace }, drift.templates?.length
        ? `要修改的模板已被他人保存（${drift.templates.map((item) => item.name).join('、')}）：确认差异后加 --overwrite 用工作副本覆盖，` +
          '或用 renderweave agent run --from <本轮> --feedback <反馈> 基于最新保存的内容重做'
        : '工作区自成果生成后已变化：确认差异后加 --overwrite 按当前工作区写入，或基于当前工作区重新发起一轮')] };
    }
  }
  const failed = (problems: readonly Problem[]): AgentApplyResult => ({ ...(drift ? { drift } : {}), problems });
  if (current.problems.some((problem) => problem.level === 'severe')) return failed(current.problems);

  // 数据定义：按审核时的发布顺序在当前工作区上重新发布。覆盖时版本号可能后移，候选之间的引用随之改到新版本。
  const versions = new Map<string, number>();
  const published: { candidate: string; entry: PublishedStaticSchema }[] = [];
  for (const [path, result] of state.results) {
    if (!result.published) continue;
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
    versions.set(`${result.published.ref.name}\0${result.published.ref.version}`, outcome.published.ref.version);
    published.push({ candidate: path, entry: outcome.published });
  }
  // 数据集与模板：在当前工作区上重新校验（工作区可能已有同名的数据集或模板；覆盖时工作副本代替最新保存的模板）。
  const saved = round.candidates.filter((candidate) => candidate.kind !== 'definition' && state.documents.has(candidate.path));
  const recheck = checkCandidates(saved.map((candidate) => ({ path: candidate.path, kind: candidate.kind, document: state.documents.get(candidate.path) })), current, round.context);
  const severeFound = [...recheck].flatMap(([path, result]) => result.problems.filter((problem) => problem.level === 'severe').map((problem) => ({ path, problem })));
  if (severeFound.length > 0) {
    return failed([severe(ProblemCodes.applyFailed, { kind: 'input', source: workspace },
      `在当前工作区上校验不通过，工作区未改动：${severeFound.map(({ path, problem }) => `${path}：${problem.message}`).join('；')}`)]);
  }

  const rendering = await assessCandidates(current, saved.map((candidate) => ({ path: candidate.path, kind: candidate.kind, document: state.documents.get(candidate.path) })),
    round.request, round.outcome.task === 'template-design' || round.outcome.task === 'template-revision');
  const newDependencies = applicationResources.used().filter(item => !review.record.contentIdentity!.resources.some(expected => expected.id === item.id));
  if (applicationResources.errors.length || newDependencies.length) return failed([
    ...applicationResources.errors,
    ...newDependencies.map(item => severe(ProblemCodes.applyResourcesChanged, { kind: 'input', source: `res:${item.id}` },
      `当前应用新增未核准的资源依赖 ${item.id}；请按当前工作区重新发起一轮并审核`)),
  ]);
  if (rendering.blocking && rendering.status === 'blocked') return failed([
    severe(ProblemCodes.applyFailed, { kind: 'input', source: workspace }, '在当前工作区上渲染受阻，工作区未改动'), ...rendering.problems,
  ]);

  type Entry = { candidate: string; kind: CandidateKind; name: string; version?: number; replaced?: boolean; files: JsonFileWrite[] };
  const entries: Entry[] = published.map(({ candidate, entry }) => {
    const names = publishedFileNames(candidate, entry.ref.version);
    return { candidate, kind: 'definition' as const, name: entry.ref.name, version: entry.ref.version, files: [
      { path: join(workspace, names.schema), value: entry.definition, mode: 'create' as const },
      { path: join(workspace, names.compiled), value: entry.compiled, mode: 'create' as const },
    ] };
  });
  const unchanged: string[] = [];
  for (const candidate of saved) {
    const document = state.documents.get(candidate.path);
    const name = candidateName(candidate.kind, document) ?? basename(candidate.path, '.json');
    if (candidate.revises) {
      // 模板的工作副本：与已保存内容相同的不写；否则整份替换当前保存这份模板的文件（M49 的"应用即保存"）。
      if (revisionView(round, candidate, document).status === 'unchanged') {
        unchanged.push(name);
        continue;
      }
      const target = current.templates.find((entry) => entry.name === candidate.name)?.source;
      entries.push({ candidate: candidate.path, kind: candidate.kind, name, ...(target ? { replaced: true } : {}),
        files: [{ path: target ?? join(workspace, candidate.revises.file), value: document, mode: target ? 'replace' : 'create' }] });
      continue;
    }
    const file = `${candidate.kind}-${basename(candidate.path, '.json').replace(/^(dataset|template)-/, '')}.json`;
    entries.push({ candidate: candidate.path, kind: candidate.kind, name, files: [{ path: join(workspace, file), value: document, mode: 'create' }] });
  }
  const files = entries.flatMap((entry) => entry.files);
  return withLocalAccess([round.dir, workspace, ...(round.resourcesDir ? [round.resourcesDir] : [])], async () => {
    if (await workspaceFingerprint(workspace) !== before) return failed([severe(ProblemCodes.applyConcurrentChange,
      { kind: 'input', source: workspace }, '计算期间工作区已被另一操作改变；本次未写入，请重新检查后重试（--overwrite 不能跳过最后核对）')]);
    const latest = await openReview(round.dir);
    if (!latest.round) return failed(latest.problems);
    if (latest.round.applied || canonical(latest.round.record) !== canonical(round.record) || latest.round.outcomeSha256 !== round.outcomeSha256 ||
      canonical(latest.review!.record) !== canonical(review.record)) return failed([severe(ProblemCodes.applyConcurrentChange,
        { kind: 'input', source: round.dir }, '计算期间轮次、审核或应用状态已变化；本次未写入，请刷新后重试')]);
    const changed = round.resourcesDir ? await resourceDifferences(round.resourcesDir, review.record.contentIdentity!.resources) : [];
    if (changed.length) return failed(changed);
    let undoWrites: () => Promise<void>;
    try {
      undoWrites = await writeJsonFiles(files);
    } catch (error) {
      return failed([severe(ProblemCodes.applyFailed, { kind: 'input', source: workspace }, `写入失败，已撤回本次写入，工作区未改动：${describeError(error)}`)]);
    }
    const applied: AppliedRecord = {
      format: 'renderweave-applied/1', contentIdentity: review.record.contentIdentity!.id, appliedAt: new Date().toISOString(), workspace, overwrite: drift !== undefined,
      fingerprints: { round: round.outcome.inputs.workspaceFingerprint, before, after: await workspaceFingerprint(workspace) },
      published: entries.map((entry) => ({
        candidate: entry.candidate, kind: entry.kind, name: entry.name, ...(entry.version !== undefined ? { version: entry.version } : {}),
        files: entry.files.map((file) => basename(file.path)), ...(entry.replaced ? { replaced: true } : {}),
      })),
      ...(unchanged.length > 0 ? { unchanged } : {}),
      ...(drift ? { drift } : {}),
    };
    try {
      await writeFile(join(round.dir, APPLIED_FILE), `${JSON.stringify(applied, null, 2)}\n`, { flag: 'wx' });
    } catch (error) {
      await undoWrites();
      return failed([severe(ProblemCodes.applyFailed, at(APPLIED_FILE), `应用记录写入失败，已撤回本次写入，工作区未改动：${describeError(error)}`)]);
    }
    return { applied, ...(drift ? { drift } : {}), problems: [] };
  });
}

async function openRound(dir: string): Promise<{ round?: AgentRound; problems: Problem[] }> {
  const root = resolve(dir);
  const fail = (file: string, message: string) => ({ problems: [severe(ProblemCodes.roundInvalid, { kind: 'input', source: join(root, file) }, message)] });
  const execution = await readExecution(root);
  if (execution.problems.length) return { problems: execution.problems };
  if (execution.execution && !execution.execution.committed) return fail('execution.json', execution.execution.diagnostics.join('；'));
  const readJson = async (file: string): Promise<{ bytes: Buffer; value: unknown } | string> => {
    try {
      const bytes = await readFile(join(root, file));
      return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      return describeError(error);
    }
  };

  const recovered = !(await exists(join(root, OUTCOME_FILE))) && await exists(join(root, DRAFT_FILE));
  const outcomeFile = await readJson(recovered ? DRAFT_FILE : OUTCOME_FILE);
  if (typeof outcomeFile === 'string') return fail(OUTCOME_FILE, `没有可审核的轮次成果：${outcomeFile}。结构不合格的轮次没有 outcome.json，不能审核`);
  if (recovered && (!isRecord(outcomeFile.value) || outcomeFile.value['format'] !== 'renderweave-draft/1' || outcomeFile.value['source'] !== 'hostRecovery')) return fail(DRAFT_FILE, 'draft.json 不是宿主保存的中断草稿');
  const value = recovered ? (outcomeFile.value as Record<string, unknown>)['outcome'] : outcomeFile.value;
  if (!validateRoundOutcome(value)) return fail(recovered ? DRAFT_FILE : OUTCOME_FILE, '不是有效的轮次候选清单');
  const stored = value as unknown as RoundOutcome;
  let outcome: RoundOutcome = { ...stored, locations: stored.locations ?? [] };
  const recordFile = await readJson('round.json');
  if (typeof recordFile === 'string') return fail('round.json', `轮次记录无法读取：${recordFile}`);
  const record = recordFile.value as RoundRecord;
  if (!isRecord(record) || record.format !== 'renderweave-round/1' || !Object.hasOwn(AGENT_TASKS, record.task)
    || !Number.isSafeInteger(record.round) || record.round < 1 || typeof record.startedAt !== 'string' || typeof record.endedAt !== 'string'
    || !isRecord(record.run) || !['qualified', 'unqualified'].includes(record.verdict)
    || !isRecord(record.inputs) || !isRecord(record.inputs.workspace) || typeof record.inputs.workspace.fingerprint !== 'string'
    || typeof record.inputs.sample?.sha256 !== 'string' || typeof record.inputs.sample?.file !== 'string' || !/^agent\/sample\.(png|jpg|webp)$/.test(record.inputs.sample.file)) {
    return fail('round.json', 'round.json 不是 renderweave-round/1 轮次记录');
  }
  for (const input of [record.inputs.sample, record.inputs.referenceImage, record.inputs.reference, record.inputs.contentBaseline]) {
    if (!input) continue;
    try {
      if (sha256(await readFile(join(root, input.file))) !== input.sha256) return fail(input.file, '参考资料已改变；不能复用旧预览或批准身份');
    } catch (error) { return fail(input.file, `检查依据无法读取：${describeError(error)}`); }
  }
  if (await workspaceFingerprint(join(root, 'snapshot')) !== record.inputs.workspace.fingerprint) return fail('snapshot', '依赖文档快照已改变；不能复用旧检查身份');

  const candidates: RoundCandidate[] = [];
  for (const candidate of outcome.candidates) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, candidate.path));
    } catch (error) {
      return fail(candidate.path, `候选文件无法读取：${describeError(error)}`);
    }
    if (sha256(bytes) !== candidate.sha256) return fail(candidate.path, `候选文件自成果生成后被改动：${candidate.path}`);
    candidates.push({
      path: candidate.path, kind: candidate.kind, ...(candidate.name !== undefined ? { name: candidate.name } : {}), document: JSON.parse(bytes.toString('utf8')),
      ...(candidate.revises ? { revises: candidate.revises } : {}),
    });
  }
  for (const item of outcome.pending) {
    if (!candidates.some((candidate) => candidate.path === item.file)) return fail(OUTCOME_FILE, `待确认项指向的文件不在候选中：${item.file}`);
  }
  // 模板中的元素路径统一为从模板名开始的写法，待确认项、图上位置与元素清单才能对上。
  const full = <T extends { file: string; path?: string }>(item: T): T => {
    const candidate = candidates.find((entry) => entry.path === item.file);
    return candidate?.kind === 'template' && item.path !== undefined ? { ...item, path: fullElementPath(candidate.document, item.path) } : item;
  };
  outcome = { ...outcome, pending: outcome.pending.map(full), locations: outcome.locations.map(full) };
  let request: Record<string, unknown> | undefined;
  if (record.inputs.request) {
    const requestFile = await readJson('request.json');
    if (typeof requestFile === 'string' || !isRecord(requestFile.value)) return fail('request.json', '出图请求无法读取');
    request = requestFile.value;
  }
  const texts: { requirement?: string; feedback?: string } = {};
  for (const name of ['requirement', 'feedback'] as const) {
    if (!record.inputs[name]) continue;
    try {
      texts[name] = await readFile(join(root, `${name}.md`), 'utf8');
    } catch (error) {
      return fail(`${name}.md`, `${name === 'requirement' ? '修改要求' : '反馈'}无法读取：${describeError(error)}`);
    }
  }
  const resourcesDir = record.inputs.resources ?? await resourcesFromMcpConfig(root);
  const reviewFile = await readJson(REVIEW_FILE);
  const resourceSnapshot = typeof reviewFile !== 'string' && isRecord(reviewFile.value) && reviewFile.value['resourceSnapshot']
    ? reviewFile.value['resourceSnapshot'] as ResourceSnapshotRef : record.inputs.resourceSnapshot;
  let resourceIdentity: readonly ResourceIdentity[] | undefined;
  if (resourceSnapshot) {
    try { resourceIdentity = (await readResourceSnapshot(root, resourceSnapshot)).resources; }
    catch (error) { return fail('resources', `固定资源无法读取：${describeError(error)}`); }
  }
  const workspace = await loadRoundWorkspace(join(root, 'snapshot'), resourceSnapshot ? join(root, resourceSnapshot.directory) : resourcesDir);
  let applied: AppliedRecord | undefined;
  const appliedFile = await readJson(APPLIED_FILE);
  if (typeof appliedFile !== 'string') applied = appliedFile.value as AppliedRecord;
  else if (await exists(join(root, APPLIED_FILE))) return fail(APPLIED_FILE, `应用记录无法读取：${appliedFile}`);
  return {
    round: {
      dir: root, recovered, outcome, outcomeSha256: sha256(outcomeFile.bytes), record, candidates, workspace,
      ...(resourcesDir ? { resourcesDir } : {}),
      ...(resourceSnapshot ? { resourceSnapshot, resourceIdentity } : {}),
      context: outcome.task === 'dataset-extraction' && record.inputs.definition ? { definition: record.inputs.definition }
        : outcome.task === 'template-revision' ? { revision: { templates: (record.inputs.templates ?? []).map((entry) => entry.name) } } : {},
      ...(request ? { request } : {}), ...texts, ...(applied ? { applied } : {}),
    },
    problems: [],
  };
}

/** 工作区连同资源仓库；没有资源仓库记录时（票据 04、05 的数据定义轮次）用空仓库，数据定义的校验用不到资源。 */
async function loadRoundWorkspace(dir: string, resourcesDir: string | undefined): Promise<Workspace> {
  if (resourcesDir) return loadWorkspace({ dir, resourcesDir });
  return { ...(await loadWorkspaceDocuments(dir)), resources: createMemoryResourceRepository([]) };
}

/** 早期轮次的 round.json 没有记录资源仓库，从 MCP 配置的启动参数里取。 */
async function resourcesFromMcpConfig(root: string): Promise<string | undefined> {
  try {
    const config = JSON.parse(await readFile(join(root, 'logs/mcp.json'), 'utf8')) as { mcpServers?: { rw?: { args?: string[] } } };
    const args = config.mcpServers?.rw?.args ?? [];
    const index = args.indexOf('--resources');
    return index >= 0 ? args[index + 1] : undefined;
  } catch {
    return undefined;
  }
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
    if (decision.action !== 'edit' && decision.value !== undefined) return invalid(`处理结果 ${decision.item}：只有改值带新值`);
    const problem = decision.action === 'edit' ? editValueProblem(kindOf(round, decision.file), decision.path, decision.value) : undefined;
    if (problem) return invalid(`处理结果 ${decision.item}：${problem}`);
  }
  return { record, saved: true, problems: [] };
}

/** 改值的新值是否合用：整份与数据定义、模板中的位置要给 JSON 对象，数据集中的位置给任意值。 */
function editValueProblem(kind: CandidateKind, path: string | undefined, value: unknown): string | undefined {
  if (path === undefined) return isRecord(value) ? undefined : `改值时要给出整份${KIND_NAMES[kind]}（JSON 对象）`;
  if (kind === 'dataset') return value === undefined ? `改值时要给出 ${path} 的新值` : undefined;
  return isRecord(value) ? undefined : `改值时要给出${kind === 'definition' ? '字段' : '元素'} ${path} 的完整写法（JSON 对象）`;
}

function kindOf(round: AgentRound, file: string): CandidateKind {
  return round.candidates.find((candidate) => candidate.path === file)?.kind ?? 'definition';
}

/** 整份替换：关闭后重开总能读到一份完整的审核结果。 */
async function saveReviewRecord(dir: string, record: ReviewRecord): Promise<void> {
  await replaceFile(join(dir, REVIEW_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

interface ReviewState {
  /** 作用了处理结果之后、仍要写入的候选文档。 */
  readonly documents: ReadonlyMap<string, unknown>;
  readonly dropped: ReadonlySet<string>;
  readonly wholeEdited: ReadonlySet<string>;
  /** 候选文件 → 已处理的改值与标为空（不含整份）。 */
  readonly changes: ReadonlyMap<string, readonly { readonly path: string; readonly action: 'edit' | 'empty'; readonly value?: unknown }[]>;
  /** 在工作区快照上校验的结果；数据定义按发布顺序排在前面。 */
  readonly results: ReadonlyMap<string, CandidateResult>;
  readonly problems: readonly Problem[];
}

/** 把处理结果作用到候选上，再在快照上校验一遍。 */
function reviewState(round: AgentRound, record: ReviewRecord): ReviewState {
  const problems: Problem[] = [];
  const source = join(round.dir, REVIEW_FILE);
  // 同一位置的处理结果必须一致；位置相互包含的处理会相互覆盖；整份改动与位置上的改动不能同时出现。
  const byLocation = new Map<string, ReviewDecision[]>();
  for (const decision of record.decisions) {
    const key = `${decision.file}\0${decision.path ?? ''}`;
    byLocation.set(key, [...(byLocation.get(key) ?? []), decision]);
  }
  const effective: ReviewDecision[] = [];
  for (const decisions of byLocation.values()) {
    const effects = new Set(decisions.map((decision) => canonical({ action: decision.action, value: decision.value })));
    if (effects.size > 1) {
      problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source },
        `待确认项 ${decisions.map((decision) => decision.item).join('、')} 指向同一位置，处理结果不一致`));
      continue;
    }
    if (decisions[0]!.action !== 'adopt') effective.push(decisions[0]!);
  }
  const documents = new Map<string, unknown>(), dropped = new Set<string>(), wholeEdited = new Set<string>();
  const changes = new Map<string, { path: string; action: 'edit' | 'empty'; value?: unknown }[]>();
  for (const candidate of round.candidates) {
    const mine = effective.filter((decision) => decision.file === candidate.path);
    const whole = mine.find((decision) => decision.path === undefined);
    const located = mine.filter((decision) => decision.path !== undefined);
    if (whole && located.length > 0) {
      problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source },
        `${candidate.path} 既整份处理（待确认项 ${whole.item}），又处理了其中的位置（待确认项 ${located.map((decision) => decision.item).join('、')}）`));
    }
    for (const [index, a] of located.entries()) {
      for (const b of located.slice(index + 1)) {
        if (a.path !== b.path && overlaps(a.path!, b.path!)) {
          problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source },
            `待确认项 ${a.item}、${b.item} 的位置相互包含（${a.path}、${b.path}），处理结果会相互覆盖`));
        }
      }
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
    const decided = located.map((decision) => ({ path: decision.path!, action: decision.action as 'edit' | 'empty', ...(decision.action === 'edit' ? { value: decision.value } : {}) }));
    changes.set(candidate.path, decided);
    let document = candidate.document;
    if (candidate.kind === 'dataset') {
      // 数据集：采纳与尚未处理的待确认项用候选值（M46 的草稿用候选值）。
      const candidateValues: Change[] = round.outcome.pending.flatMap((item) => (item.file === candidate.path && item.path !== undefined && item.candidate !== undefined &&
        !decided.some((change) => overlaps(change.path, item.path!)) ? [{ path: item.path, action: 'set' as const, value: item.candidate }] : []));
      document = applyChanges('dataset', document, candidateValues).document;
    }
    const applied = applyChanges(candidate.kind, document, decided.map((change) => ({ path: change.path, action: change.action === 'edit' ? 'set' as const : 'remove' as const, value: change.value })));
    for (const error of applied.errors) problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source }, `${candidate.path}：${error}`));
    documents.set(candidate.path, applied.document);
  }
  const results = checkCandidates(round.candidates.filter((candidate) => documents.has(candidate.path))
    .map((candidate) => ({ path: candidate.path, kind: candidate.kind, document: documents.get(candidate.path) })), round.workspace, round.context);
  return { documents, dropped, wholeEdited, changes, results, problems };
}

async function buildView(round: AgentRound, record: ReviewRecord, saved: boolean, recordProblems: readonly Problem[], computed?: ReviewState): Promise<ReviewView> {
  const tracked = trackResources(round.workspace.resources, round.resourceIdentity);
  round = { ...round, workspace: { ...round.workspace, resources: tracked.repository } };
  const state = computed ?? reviewState(round, record);
  const problems: Problem[] = [...recordProblems, ...state.problems];
  if (round.recovered) problems.push(severe(ProblemCodes.outcomeInvalid, { kind: 'input', source: DRAFT_FILE },
    '宿主抢救的中断草稿：Agent 未交回有效成果，完成度未知；只能查看，不能批准或应用。请用 --from 带反馈续跑。'));
  const decisions = new Map(record.decisions.map((decision) => [decision.item, decision]));
  const locationsOf = (file: string) => round.outcome.locations.filter((location) => location.file === file);
  const pending: PendingView[] = round.outcome.pending.map((item, index) => {
    const candidate = round.candidates.find((entry) => entry.path === item.file);
    const decision = decisions.get(index + 1);
    const location = locationsOf(item.file).find((entry) => entry.path === item.path);
    let current: unknown = candidate?.document;
    if (candidate && item.path !== undefined) {
      const { slot } = locate(candidate.kind, candidate.document, item.path);
      current = slot ? read(slot) : undefined;
    }
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
    const shownDocument = document ?? candidate.document;
    const context: ItemContext = {
      candidate, document, whole: state.wholeEdited.has(candidate.path), changes: state.changes.get(candidate.path) ?? [],
      locations: locationsOf(candidate.path), pending: pending.filter((item) => item.file === candidate.path),
    };
    const location = context.locations.find((entry) => entry.path === undefined);
    const compiled = result?.published?.compiled;
    const dataset = candidate.kind === 'dataset' && isRecord(shownDocument) && isRecord(shownDocument['dataset']) ? shownDocument['dataset'] : undefined;
    return {
      path: candidate.path, kind: candidate.kind,
      ...(candidateName(candidate.kind, shownDocument) !== undefined ? { name: candidateName(candidate.kind, shownDocument)! } : candidate.name !== undefined ? { name: candidate.name } : {}),
      ...(isRecord(shownDocument) && typeof shownDocument['displayName'] === 'string' ? { displayName: shownDocument['displayName'] } : {}),
      ...(dataset && typeof dataset['name'] === 'string' ? { displayName: dataset['name'] } : {}),
      ...(isRecord(shownDocument) && typeof shownDocument['description'] === 'string' ? { description: shownDocument['description'] } : {}),
      dropped: state.dropped.has(candidate.path), edited: context.whole,
      ...(document !== undefined ? { document } : {}),
      fields: candidate.kind === 'definition' ? fieldViews(context) : [],
      ...(candidate.kind === 'dataset' ? { entries: entryViews(context), ...(dataset && isRecord(dataset['staticSchema']) ? { staticSchema: dataset['staticSchema'] as unknown as StaticSchemaRef } : {}) } : {}),
      ...(candidate.kind === 'template' ? { elements: elementViews(context), template: templateSummary(shownDocument) } : {}),
      ...(location ? { location } : {}),
      ...(result?.published ? { published: result.published.ref } : {}),
      ...(compiled ? { compiled: {
        ...(typeof compiled['title'] === 'string' ? { title: compiled['title'] } : {}),
        properties: isRecord(compiled['properties']) ? Object.keys(compiled['properties']).length : 0,
        required: Array.isArray(compiled['required']) ? compiled['required'].map(String) : [],
        schema: compiled,
      } } : {}),
      ...(round.outcome.task === 'template-revision' && candidate.kind === 'template' && document !== undefined ? { revision: revisionView(round, candidate, document) } : {}),
      problems: result?.problems ?? [],
    };
  });
  const preview = await previewOf(round, state);
  const previewBefore = round.outcome.task === 'template-revision' ? await previewBeforeOf(round) : undefined;
  problems.push(...tracked.errors);
  if (!round.resourceSnapshot) problems.push(severe(ProblemCodes.reviewInvalid, { kind: 'input', source: REVIEW_FILE },
    '历史轮次没有完整资源身份；保留原记录，先撤回结论，以当前资源重新检查预览并核准'));
  const identity = await contentIdentity({ workspace: round.workspace, candidates: { files: [...state.documents].map(([path, document]) => ({ path, sha256: sha256(canonical(document)) })), outcome: round.outcomeSha256 },
    request: round.request, reference: { sample: round.record.inputs.sample.sha256, reference: round.record.inputs.reference, contentBaseline: round.record.inputs.contentBaseline }, resources: tracked.used() });
  if (round.resourcesDir && !round.applied && round.resourceSnapshot) problems.push(...await resourceDifferences(round.resourcesDir, identity.resources));
  await mkdir(join(round.dir, 'checks'), { recursive: true });
  try {
    await writeFile(join(round.dir, 'checks', `${identity.id}.json`), JSON.stringify({ contentIdentity: identity, preview, previewBefore }, null, 2), { flag: 'wx' });
  } catch (error) { if (!isRecord(error) || error.code !== 'EEXIST') throw error; }
  const view: Omit<ReviewView, 'canApprove'> = {
    round: {
      dir: round.dir, source: round.recovered ? 'hostRecovery' : 'agent', task: round.outcome.task, taskName: AGENT_TASKS[round.outcome.task].name, verdict: round.record.verdict,
      sample: round.record.inputs.sample.file, workspace: round.record.inputs.workspace?.source ?? null, notes: round.outcome.notes, usage: round.outcome.usage,
      round: round.outcome.round, chain: await readRoundChain(round.dir),
      ...(round.requirement !== undefined ? { requirement: round.requirement } : {}), ...(round.feedback !== undefined ? { feedback: round.feedback } : {}),
    },
    contentIdentity: identity, review: record, saved, pending, candidates, ...(preview ? { preview } : {}), ...(previewBefore ? { previewBefore } : {}), problems,
    ...(round.applied ? { applied: round.applied } : {}),
  };
  return { ...view, canApprove: blockingProblems(view).length === 0 };
}

/** 阻止通过的严重问题：审核层面的、候选的，以及模板辅助设计、模板辅助修改的预览问题。 */
function blockingProblems(view: Pick<ReviewView, 'problems' | 'candidates' | 'preview'>): Problem[] {
  return [...view.problems, ...view.candidates.flatMap((candidate) => candidate.problems), ...(view.preview?.blocking ? view.preview.problems : [])]
    .filter((problem) => problem.level === 'severe');
}

/**
 * 有出图请求时重新渲染预览：模板辅助设计与模板辅助修改用审核后的候选模板（同名的代替已保存的模板，M50）与已保存的数据集；
 * 数据集提取用已保存的模板与审核后的候选数据集。
 */
async function previewOf(round: AgentRound, state: ReviewState): Promise<PreviewView | undefined> {
  if (!round.request) return undefined;
  const templates = round.candidates.filter((candidate) => candidate.kind === 'template' && state.documents.has(candidate.path))
    .flatMap((candidate) => {
      const name = candidateName('template', state.documents.get(candidate.path));
      return name === undefined ? [] : [{ name, document: state.documents.get(candidate.path), source: candidate.path }];
    });
  const names = new Set(templates.map((entry) => entry.name));
  const workspace: Workspace = { ...round.workspace, templates: [...round.workspace.templates.filter((entry) => !names.has(entry.name)), ...templates] };
  let request = round.request, shown = round.request, dataset: unknown;
  if (round.outcome.task === 'dataset-extraction') {
    const candidate = round.candidates.find((entry) => entry.kind === 'dataset' && state.documents.has(entry.path));
    if (!candidate) return { request: shown, problems: [], blocking: false };
    dataset = state.documents.get(candidate.path);
    request = { ...round.request, dataset: { inline: dataset } };
    shown = { ...round.request, dataset: { candidate: candidate.path } };
  }
  return renderPreview({
    roundDir: round.dir, workspace, request, shown, sample: await readFile(join(round.dir, round.record.inputs.sample.file)),
    inputs: { templates: templates.map((entry) => entry.document), dataset, resources: round.resourceSnapshot, workspace: round.record.inputs.workspace.fingerprint,
      sample: round.record.inputs.sample.sha256, reference: round.record.inputs.reference, contentBaseline: round.record.inputs.contentBaseline }, blocking: round.outcome.task === 'template-design' || round.outcome.task === 'template-revision',
  });
}

/** 模板辅助修改的修改前预览：只用工作区快照中已保存的模板。 */
async function previewBeforeOf(round: AgentRound): Promise<PreviewView | undefined> {
  if (!round.request) return undefined;
  return renderPreview({
    roundDir: round.dir, workspace: round.workspace, request: round.request, shown: round.request,
    sample: await readFile(join(round.dir, round.record.inputs.sample.file)), inputs: { templates: [], resources: round.resourceSnapshot, workspace: round.record.inputs.workspace.fingerprint }, blocking: false,
  });
}

/** 审核后的工作副本相对快照中同名已保存模板的差异；没有基准的是新增的模板。 */
function revisionView(round: AgentRound, candidate: RoundCandidate, document: unknown): RevisionView {
  const saved = candidate.revises ? round.workspace.templates.find((entry) => entry.name === candidate.name)?.document : undefined;
  return { ...revisionDiff(saved, document), ...(candidate.revises ? { basis: candidate.revises } : {}) };
}

interface ItemContext {
  readonly candidate: RoundCandidate;
  /** 审核后的文档；整份标为空时没有。 */
  readonly document: unknown;
  readonly whole: boolean;
  readonly changes: readonly { readonly path: string; readonly action: 'edit' | 'empty'; readonly value?: unknown }[];
  readonly locations: readonly FieldLocation[];
  readonly pending: readonly PendingView[];
}

/** 某个位置上最具体的图上位置。 */
function locationAt(context: ItemContext, path: string): FieldLocation | undefined {
  return context.locations.filter((location) => location.path !== undefined && within(location.path, path))
    .sort((a, b) => b.path!.length - a.path!.length)[0];
}

function pendingAt(context: ItemContext, path: string, exact = false): number[] {
  return context.pending.filter((item) => item.path !== undefined && (exact ? item.path === path : overlaps(item.path, path))).map((item) => item.item);
}

function stateAt(context: ItemContext, path: string): ItemState {
  return context.changes.some((change) => change.action === 'edit' && within(change.path, path)) ? 'edited' : 'kept';
}

function fieldViews(context: ItemContext): FieldView[] {
  const view = (field: Record<string, unknown>, state: ItemState) => {
    const name = String(field['name']);
    return fieldView(field, state, context.locations.find((location) => location.path === name), pendingAt(context, name, true));
  };
  const original = fieldsOf(context.candidate.document);
  if (context.whole) {
    // 整份改值时按字段名与原文比对：没变的保留，变了或新加的标为改过，原有而被删掉的标为已删去。
    const now = fieldsOf(context.document);
    return [
      ...now.map((field) => {
        const before = original.find((item) => item['name'] === field['name']);
        return view(field, before !== undefined && canonical(before) === canonical(field) ? 'kept' : 'edited');
      }),
      ...original.filter((field) => !now.some((item) => item['name'] === field['name'])).map((field) => view(field, 'removed')),
    ];
  }
  return original.map((field) => {
    const change = context.changes.find((item) => item.path === field['name']);
    if (!change) return view(field, 'kept');
    return change.action === 'empty' ? view(field, 'removed') : view(isRecord(change.value) ? change.value : field, 'edited');
  });
}

function entryViews(context: ItemContext): EntryView[] {
  const view = (path: string, value: unknown, state: ItemState): EntryView => {
    const location = locationAt(context, path);
    return { path, value, ...(location ? { location } : {}), pending: pendingAt(context, path), state };
  };
  const data = (document: unknown) => (isRecord(document) ? document['data'] : undefined);
  if (context.whole) {
    const before = new Map(flattenData(data(context.candidate.document)).map((entry) => [entry.path, entry.value]));
    const now = flattenData(data(context.document));
    return [
      ...now.map((entry) => view(entry.path, entry.value, before.has(entry.path) && canonical(before.get(entry.path)) === canonical(entry.value) ? 'kept' : 'edited')),
      ...[...before].filter(([path]) => !now.some((entry) => entry.path === path)).map(([path, value]) => view(path, value, 'removed')),
    ];
  }
  const removed = context.changes.filter((change) => change.action === 'empty').flatMap((change) => {
    const { slot } = locate('dataset', context.candidate.document, change.path);
    const value = slot ? read(slot) : undefined;
    return value === undefined ? [] : flattenData(value, change.path).length > 0 ? flattenData(value, change.path) : [{ path: change.path, value }];
  });
  return [
    ...flattenData(data(context.document)).map((entry) => view(entry.path, entry.value, stateAt(context, entry.path))),
    ...removed.map((entry) => view(entry.path, entry.value, 'removed')),
  ];
}

function elementViews(context: ItemContext): ElementView[] {
  const paths = [...flattenElements(context.candidate.document), ...flattenElements(context.document)].map((item) => item.path);
  const view = (path: string, element: Record<string, unknown>, state: ItemState): ElementView => {
    const location = locationAt(context, path) ?? context.locations.find((entry) => entry.path !== undefined && within(path, entry.path) &&
      !paths.some((other) => other.length > path.length && within(path, other) && within(other, entry.path!)));
    return { path, type: String(element['type']), ...(location ? { location } : {}), pending: pendingAt(context, path), state };
  };
  const original = flattenElements(context.candidate.document);
  const now = flattenElements(context.document);
  if (context.whole) {
    // 只比较元素自身的属性，子元素各自比较。
    const own = (element: Record<string, unknown>) => canonical({ ...element, children: undefined });
    return [
      ...now.map(({ path, element }) => {
        const before = original.find((item) => item.path === path);
        return view(path, element, before && own(before.element) === own(element) ? 'kept' : 'edited');
      }),
      ...original.filter((item) => !now.some((entry) => entry.path === item.path)).map(({ path, element }) => view(path, element, 'removed')),
    ];
  }
  const removed = context.changes.filter((change) => change.action === 'empty')
    .flatMap((change) => original.filter((item) => within(change.path, item.path)));
  return [
    ...now.map(({ path, element }) => view(path, element, stateAt(context, path))),
    ...removed.map(({ path, element }) => view(path, element, 'removed')),
  ];
}

function templateSummary(document: unknown): { base?: StaticSchemaRef; parameters: ParameterView[] } {
  if (!isRecord(document)) return { parameters: [] };
  const base = isRecord(document['base']) ? document['base'] as unknown as StaticSchemaRef : undefined;
  const parameters = (Array.isArray(document['parameters']) ? document['parameters'] : []).filter(isRecord).map((parameter) => ({
    name: String(parameter['name']),
    ...(typeof parameter['displayName'] === 'string' ? { displayName: parameter['displayName'] } : {}),
    ...(typeof parameter['type'] === 'string' ? { type: parameter['type'] } : {}),
    ...(typeof parameter['visibility'] === 'string' ? { visibility: parameter['visibility'] } : {}),
  }));
  return { ...(base ? { base } : {}), parameters };
}

function fieldView(field: Record<string, unknown>, state: ItemState, location: FieldLocation | undefined, pending: number[]): FieldView {
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

async function workspaceDrift(round: AgentRound, workspace: string, actual: string, current: Workspace, state: ReviewState): Promise<WorkspaceDrift> {
  const before = await jsonFileHashes(join(round.dir, 'snapshot'));
  const after = await jsonFileHashes(workspace);
  const latest = (entries: readonly StaticSchemaEntry[], name: string) => {
    const versions = entries.filter((entry) => entry.ref.name === name).map((entry) => entry.ref.version);
    return versions.length === 0 ? null : Math.max(...versions);
  };
  const names = [...state.results.values()].flatMap((result) => (result.published ? [result.published.ref.name] : []));
  // 模板辅助修改：改动了的工作副本所基于的模板，在当前工作区中换了内容、换了文件或被删去。
  const templates: TemplateConflict[] = [];
  for (const candidate of round.candidates) {
    if (!candidate.revises || !state.documents.has(candidate.path)) continue;
    if (revisionView(round, candidate, state.documents.get(candidate.path)).status !== 'modified') continue;
    const entry = current.templates.find((item) => item.name === candidate.name);
    const now = entry?.source ? { file: basename(entry.source), sha256: after.get(basename(entry.source)) ?? '' } : null;
    if (now && now.file === candidate.revises.file && now.sha256 === candidate.revises.sha256) continue;
    const saved = round.workspace.templates.find((item) => item.name === candidate.name)?.document;
    templates.push({ name: candidate.name!, basis: candidate.revises, current: now, changes: entry ? diffTemplate(saved, entry.document) : [] });
  }
  return {
    expected: round.outcome.inputs.workspaceFingerprint, actual,
    added: [...after.keys()].filter((file) => !before.has(file)),
    removed: [...before.keys()].filter((file) => !after.has(file)),
    changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
    newerDefinitions: names.flatMap((name) => {
      const snapshot = latest(round.workspace.staticSchemas, name), now = latest(current.staticSchemas, name);
      return now !== null && (snapshot === null || now > snapshot) ? [{ name, snapshot, workspace: now }] : [];
    }),
    ...(round.outcome.task === 'template-revision' ? { templates } : {}),
  };
}

/** 下一轮所需的上一轮内容（M58）。 */
export interface PreviousRound {
  readonly dir: string;
  readonly record: RoundRecord;
  readonly round: number;
  /** 上一轮所用的资源仓库。 */
  readonly resources?: string;
  /** 上一轮成果的哈希；结构不合格、没有成果时为 null。 */
  readonly outcomeSha256: string | null;
  readonly reviewSha256: string | null;
  readonly reviewStatus: ReviewStatus | null;
  /** 上一轮已经应用（有 applied.json）。 */
  readonly applied: boolean;
  /** 上一轮成果（含审核时的修改），路径相对 Agent 工作目录，如 candidates/schema-badge.json；结构不合格时是 Agent 交回的原样文件。 */
  readonly candidates: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** 原样交给下一轮的记录：outcome.json、review.json、check.json 中存在的。 */
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
}

/**
 * 读出上一轮，供下一轮使用：成果按 review.json 作用审核时的修改（与审核页、应用同一套规则）；整份标为空的候选不再给。
 * 上一轮结构不合格、没有成果时，给 Agent 当时交回的 candidates/ 下的文件与问题清单。
 */
export async function readPreviousRound(dir: string): Promise<PreviousRound> {
  try { return await withLocalAccess([dir], () => readPreviousRoundLocked(dir), 1000); }
  catch (error) { if (localAccessProblem(error) || error instanceof AgentUsageError) throw error; throw new AgentUsageError(`上一轮的轮次记录无法读取：${describeError(error)}`); }
}
async function readPreviousRoundLocked(dir: string): Promise<PreviousRound> {
  const execution = await readExecution(resolve(dir));
  if (execution.problems.length || (execution.execution && !execution.execution.committed)) throw new AgentUsageError(
    `轮次尚未完整提交，不能从残留候选接续：${[...execution.problems.map(p => p.message), ...(execution.execution?.diagnostics ?? [])].join('；')}`);
  const root = resolve(dir);
  let record: RoundRecord;
  try {
    record = JSON.parse(await readFile(join(root, 'round.json'), 'utf8')) as RoundRecord;
  } catch (error) {
    throw new AgentUsageError(`上一轮的轮次记录无法读取：${join(root, 'round.json')}（${describeError(error)}）`);
  }
  if (!isRecord(record) || record.format !== 'renderweave-round/1' || !Object.hasOwn(AGENT_TASKS, record.task) || !isRecord(record.inputs) ||
    !Number.isSafeInteger(record.round) || !isRecord(record.inputs.sample) || !isRecord(record.inputs.workspace)) {
    throw new AgentUsageError(`上一轮的 round.json 不是 renderweave-round/1 轮次记录：${root}`);
  }
  const files: { name: string; bytes: Uint8Array }[] = [];
  for (const name of [OUTCOME_FILE, DRAFT_FILE, REVIEW_FILE, 'check.json']) {
    if (await exists(join(root, name))) files.push({ name, bytes: await readFile(join(root, name)) });
  }
  const resources = record.inputs.resources ?? await resourcesFromMcpConfig(root);
  const base = { dir: root, record, round: record.round, ...(resources ? { resources } : {}), applied: await exists(join(root, APPLIED_FILE)), files };
  if (!files.some((file) => file.name === OUTCOME_FILE)) {
    return { ...base, outcomeSha256: null, reviewSha256: null, reviewStatus: null, candidates: await readJsonTree(join(root, 'agent'), 'candidates') };
  }
  const opened = await openRound(root);
  if (!opened.round) throw new AgentUsageError(`上一轮不能作为下一轮的基础：${opened.problems.map((problem) => problem.message).join('；')}`);
  const review = await readReviewRecord(opened.round);
  if (review.problems.length > 0) throw new AgentUsageError(`上一轮的审核结果不能使用：${review.problems.map((problem) => problem.message).join('；')}`);
  const state = reviewState(opened.round, review.record);
  if (state.problems.length > 0) throw new AgentUsageError(`上一轮的审核结果相互矛盾：${state.problems.map((problem) => problem.message).join('；')}`);
  const candidates: { path: string; bytes: Uint8Array }[] = [];
  for (const candidate of opened.round.candidates) {
    if (!state.documents.has(candidate.path)) continue;
    const document = state.documents.get(candidate.path);
    // 没有改动的保留原文，改过的按审核结果重写。
    candidates.push({ path: candidate.path, bytes: canonical(document) === canonical(candidate.document)
      ? await readFile(join(root, candidate.path)) : Buffer.from(`${JSON.stringify(document, null, 2)}\n`) });
  }
  const reviewFile = files.find((file) => file.name === REVIEW_FILE);
  return {
    ...base, outcomeSha256: opened.round.outcomeSha256, reviewSha256: review.saved && reviewFile ? sha256(reviewFile.bytes) : null,
    reviewStatus: review.saved ? review.record.status : null, candidates,
  };
}

/** 沿 round.json 的 previous 追溯到第 1 轮，按轮次先后排列；某一轮读不到时链在那里断开。 */
export async function readRoundChain(dir: string): Promise<RoundLink[]> {
  const chain: RoundLink[] = [];
  const seen = new Set<string>();
  let current: string | undefined = resolve(dir), expected: number | undefined;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    let record: RoundRecord | undefined;
    try {
      record = JSON.parse(await readFile(join(current, 'round.json'), 'utf8')) as RoundRecord;
    } catch {
      record = undefined;
    }
    if (!isRecord(record) || !isRecord(record.inputs) || !Number.isSafeInteger(record.round)) {
      chain.unshift({ round: expected ?? 0, dir: current, applied: false, missing: true });
      break;
    }
    let review: ReviewStatus | undefined;
    try {
      const value: unknown = JSON.parse(await readFile(join(current, REVIEW_FILE), 'utf8'));
      if (isRecord(value) && ['inProgress', 'approved', 'rejected'].includes(String(value['status']))) review = value['status'] as ReviewStatus;
    } catch {
      review = undefined;
    }
    chain.unshift({
      round: record.round, dir: current, task: record.task, verdict: record.verdict, ...(review ? { review } : {}), applied: await exists(join(current, APPLIED_FILE)),
    });
    const previous = record.inputs.previous;
    expected = previous?.round;
    current = previous ? resolve(previous.dir) : undefined;
  }
  return chain;
}

/** base 下 sub 目录里的全部 .json 文件，路径相对 base、用 / 分隔；目录不存在时为空。 */
async function readJsonTree(base: string, sub: string): Promise<{ path: string; bytes: Uint8Array }[]> {
  let names: string[];
  try {
    names = (await readdir(join(base, sub), { recursive: true })).map(String);
  } catch {
    return [];
  }
  const files: { path: string; bytes: Uint8Array }[] = [];
  for (const name of names.sort()) {
    const path = join(base, sub, name);
    if (!name.endsWith('.json') || !(await stat(path)).isFile()) continue;
    files.push({ path: relative(base, path).split(sep).join('/'), bytes: await readFile(path) });
  }
  return files;
}

/** 备注：没有给出时为 undefined；给了却不是文本时为 null。 */
function optionalComment(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value.trim() : null;
}
