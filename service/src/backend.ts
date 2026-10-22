/**
 * 服务的后端（ADR-0018）：平台级的跨租户操作，与只触及一个租户的句柄。
 * 两种实现跑同一组 API 用例：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑（阶段 4 PRD「接缝」）。
 */
import type {
  BatchItemFiles, BatchOutput, BatchSource, BatchSummary, LayoutSummary, Problem, ProblemLocation, RecordSource, RenderMode, ReplayManifest, ResourceVersionBackend,
  WorkspaceDocumentSource,
} from './engine.js';

export interface Tenant {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** 客户角色（M247）：管理员有操作员的全部权限，另管成员、密钥、webhook、替换资源、用量与审计。 */
export type MemberRole = 'admin' | 'operator';

export interface Member {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface PlatformUser {
  readonly id: string;
  readonly email: string;
  readonly createdAt: string;
}

/** 按邮箱找到的登录账号：成员属于一个租户；平台用户不属于任何租户。 */
export interface LoginRecord {
  readonly userId: string;
  readonly tenantId: string | null;
  readonly email: string;
  readonly role: MemberRole | 'platformAdmin';
  readonly passwordHash: string;
  readonly active: boolean;
}

export interface ApiKeyInfo {
  readonly id: string;
  readonly name: string;
  /** 密钥开头几位，用来辨认；完整密钥只在创建时显示一次。 */
  readonly prefix: string;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface AuthoringTokenInfo {
  readonly id: string;
  readonly label: string;
  readonly prefix: string;
  readonly tenantIds: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string;
}

/** 由令牌解析出的身份。会话属于成员或平台用户；API 密钥属于租户；代建令牌只能访问被指定的租户。 */
export type Identity =
  | { readonly kind: 'member'; readonly userId: string; readonly tenantId: string; readonly role: MemberRole; readonly email: string; readonly sessionId: string }
  | { readonly kind: 'platformUser'; readonly userId: string; readonly email: string; readonly sessionId: string }
  | { readonly kind: 'apiKey'; readonly keyId: string; readonly tenantId: string; readonly name: string }
  | { readonly kind: 'authoringToken'; readonly tokenId: string; readonly label: string; readonly tenantIds: readonly string[] };

export interface Actor {
  readonly kind: 'member' | 'platformUser' | 'apiKey' | 'authoringToken' | 'system';
  readonly id: string;
  /** 邮箱、密钥名或令牌标签；不含密钥本身。 */
  readonly label: string;
}

/** 审计事件：记人、租户、操作、对象与时间，不记业务数据内容与密钥。追加写入，不改不删。 */
export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string | null;
  readonly at: string;
  readonly actor: Actor;
  readonly action: string;
  readonly object: { readonly type: string; readonly id: string };
  /** 我们的内部人员（平台管理员、代建工程师）对客户租户的操作。 */
  readonly crossTenant: boolean;
}
export type NewAuditEvent = Omit<AuditEvent, 'id' | 'at' | 'tenantId'>;

export interface Readiness {
  readonly ready: boolean;
  readonly schemaVersion?: number;
  readonly checks: Readonly<Record<string, string>>;
}

export class EmailTakenError extends Error {}

/**
 * 套餐（M242、ADR-0020）：每月出图张数、单张最大像素与并发数，由平台管理员设置。
 * 并发数限的是预览与重放同时排队与渲染中的任务数（按种类各算各的）；批次项不按租户限并发，按项序号轮转（M269）。
 */
export interface Plan {
  readonly monthlyImages: number;
  readonly maxPixels: number;
  readonly concurrency: number;
}

/** 引擎的单张像素上限（单边 20,000 px、总数 1 亿，ADR-0017）：套餐的单张最大像素不超过它。 */
export const ENGINE_MAX_PIXELS = 100_000_000;

/** 新租户没设套餐时的缺省值：每月 0 张，先由平台管理员设置套餐才能正式交付。 */
export const DEFAULT_PLAN: Plan = { monthlyImages: 0, maxPixels: ENGINE_MAX_PIXELS, concurrency: 2 };

/** 用量的种类：正式交付成功的一张，或代建一轮的四种 token（RoundUsage）。 */
export const TOKEN_KINDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];
export type UsageKind = 'image' | TokenKind;
export const USAGE_KINDS: readonly UsageKind[] = ['image', ...TOKEN_KINDS];

/** 计费周期按 UTC+8 切分的自然月（ADR-0020），写作 YYYY-MM。 */
const PERIOD_OFFSET_MS = 8 * 3_600_000;
export const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;
export const periodOf = (at: Date): string => new Date(at.getTime() + PERIOD_OFFSET_MS).toISOString().slice(0, 7);
/** 周期的起止（含起、不含止）。 */
export function periodRange(period: string): { readonly start: Date; readonly end: Date } {
  const [, year, month] = PERIOD.exec(period)!;
  return { start: new Date(Date.UTC(Number(year), Number(month) - 1, 1) - PERIOD_OFFSET_MS), end: new Date(Date.UTC(Number(year), Number(month), 1) - PERIOD_OFFSET_MS) };
}

/** 一条用量事件：追加写入，不改不删。出处是批次与项，或代建的一轮（round.json 的 SHA-256、任务与轮次）。 */
export interface UsageEvent {
  readonly id: string;
  readonly at: string;
  readonly period: string;
  readonly kind: UsageKind;
  readonly quantity: number;
  readonly batchId?: string;
  readonly index?: number;
  readonly round?: { readonly sha256: string; readonly task: string; readonly round: number };
}

/** 一个周期的计数：出图张数的限额、已用与预占，以及各种 token 的合计。 */
export interface UsageCounts {
  readonly period: string;
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  readonly tokens: Readonly<Record<TokenKind, number>>;
}

/** 代建一轮的 token 用量（推送时随附，票据 09）：同一轮（round.json 字节相同）在一个租户只记一次。 */
export interface RoundUsageEntry {
  readonly sha256: string;
  readonly task: string;
  readonly round: number;
  readonly tokens: Readonly<Partial<Record<TokenKind, number>>>;
}

/** 额度不够时的计数：本期限额、已用、预占与本批要预占的项数。 */
export interface QuotaShortfall {
  readonly period: string;
  readonly limit: number;
  readonly used: number;
  readonly reserved: number;
  readonly requested: number;
}

/** 对账退回的预占：批次已结束、或接受它的构建已没有 worker 且闲置超过宽限时间。 */
export interface ReleasedReservation {
  readonly tenantId: string;
  readonly batchId: string;
  readonly released: number;
}

/** webhook 能订阅的事件（票据 11）：v1.0 只有批次结束；以后新增的种类要显式订阅，已注册的 webhook 收到的事件不变。 */
export const WEBHOOK_EVENT_TYPES = ['batch.finished'] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
/** 一个租户同时启用的 webhook 上限：每个批次结束时每个 webhook 各投递一次，不让一个租户放大出站请求。 */
export const MAX_ACTIVE_WEBHOOKS = 10;

/** 一个 webhook：签名密钥只在注册时显示一次，之后只给前缀，用来认出是哪一个。 */
export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly description?: string;
  readonly events: readonly WebhookEventType[];
  readonly secretPrefix: string;
  readonly active: boolean;
  readonly createdAt: string;
  readonly disabledAt?: string;
}

export interface NewWebhook {
  readonly url: string;
  readonly description?: string;
  readonly events: readonly WebhookEventType[];
  /** 用服务密钥加密后的签名密钥（webhooks.ts 的 sealSecret）。 */
  readonly secretSealed: string;
  readonly secretPrefix: string;
}

/** 一次投递尝试：收到的 HTTP 状态，或没收到回答的原因。 */
export interface WebhookAttempt {
  readonly attempt: number;
  readonly at: string;
  readonly durationMs: number;
  readonly statusCode?: number;
  readonly error?: string;
}

/** 一个事件对一个 webhook 的投递：pending 还会再试，succeeded 收到 2xx，failed 试满次数仍没成功。 */
export interface WebhookDelivery {
  readonly id: string;
  readonly webhookId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  readonly batchId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly createdAt: string;
  readonly nextAttemptAt?: string;
  readonly finishedAt?: string;
  readonly attempts: readonly WebhookAttempt[];
}

/** 投递任务领到的一次投递；attempts 是此前已记下的尝试次数。 */
export interface ClaimedDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly webhookId: string;
  readonly url: string;
  readonly secretSealed: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  /** 事件正文：记事件时定下的字节，每次尝试原样发送。 */
  readonly body: string;
  readonly attempts: number;
}

export type DeliveryOutcome = { readonly status: 'succeeded' } | { readonly status: 'pending'; readonly nextAttemptAt: Date } | { readonly status: 'failed' };

/**
 * webhook 的出站队列（跨租户，票据 11）：批次结束时与批次清单同一个事务记下事件与投递，接口进程的投递任务领取到期的投递发送。
 * 领取带租约：投递任务中途退出时，租约过了别的投递任务再领，所以接收端可能收到同一事件不止一次，按事件 ID 去重。
 */
export interface WebhookOutbox {
  /** 领取到期、所属 webhook 仍启用的投递，最多 limit 条，租约到 leaseUntil。 */
  claim(now: Date, leaseUntil: Date, limit: number): Promise<readonly ClaimedDelivery[]>;
  /** 记下一次尝试与之后的状态；这次领取之后别人已记过时不生效（返回 false）。 */
  record(delivery: ClaimedDelivery, attempt: WebhookAttempt, outcome: DeliveryOutcome): Promise<boolean>;
}

export interface PlatformStore {
  createTenant(name: string): Promise<Tenant>;
  listTenants(): Promise<Tenant[]>;
  createPlatformUser(email: string, passwordHash: string): Promise<PlatformUser>;
  /** 按邮箱找登录账号，不分租户。邮箱在成员与平台用户之间唯一，不区分大小写。 */
  findLogin(email: string): Promise<LoginRecord | undefined>;
  /** 为平台用户建会话；成员的会话由租户句柄建。 */
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<string>;
  /** 按令牌哈希解析身份：会话、API 密钥或代建令牌。过期、吊销、账号停用或租户不在时没有身份。 */
  resolveToken(tokenHash: string, now: Date): Promise<Identity | undefined>;
  revokeSession(sessionId: string): Promise<void>;
  createAuthoringToken(token: { label: string; tokenHash: string; prefix: string; tenantIds: readonly string[]; expiresAt: Date }): Promise<AuthoringTokenInfo>;
  listAuthoringTokens(): Promise<AuthoringTokenInfo[]>;
  /** 吊销；令牌不存在时返回 false。 */
  revokeAuthoringToken(id: string, now: Date): Promise<boolean>;
  /** 不属于任何租户的事件，例如建平台用户、签发代建令牌。 */
  appendAudit(event: NewAuditEvent, now: Date): Promise<void>;
  /** 被出图记录引用的构建（跨租户，票据 08）：记录数与最近一次交付的时间。只要还有记录引用，就保留那个构建的镜像。 */
  recordBuilds(): Promise<readonly { readonly build: string; readonly records: number; readonly lastDeliveredAt: string }[]>;
}

/** 代建推送进来的工作区文档的种类（票据 05，M264）。 */
export type DocumentKind = 'definition' | 'compiled' | 'template' | 'dataset';
export const DOCUMENT_KINDS: readonly DocumentKind[] = ['definition', 'compiled', 'template', 'dataset'];

/**
 * 工作区文档在服务端的来源名："种类:键"，如 template:线路牌、definition:线路牌@1。
 * 渲染时它就是问题里的位置；键是数据定义与编译产物的"名称@版本"、模板名或数据集 ID。
 */
export const documentSource = (kind: DocumentKind, key: string) => `${kind}:${key}`;
export function parseDocumentSource(source: string): { kind: DocumentKind; key: string } | undefined {
  const at = source.indexOf(':'), kind = source.slice(0, at) as DocumentKind;
  return at > 0 && DOCUMENT_KINDS.includes(kind) && at < source.length - 1 ? { kind, key: source.slice(at + 1) } : undefined;
}

/** 服务端的一份工作区文档：种类加键，内容按 SHA-256 存放。模板是当前修订的内容。 */
export interface StoredDocument {
  readonly kind: DocumentKind;
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface TemplateRevision {
  readonly revision: number;
  readonly sha256: string;
  readonly byteLength: number;
  readonly createdAt: string;
  /** 推送者的标签（代建令牌的标签），不含令牌。 */
  readonly pushedBy: string;
}

/** 模板按名称指向当前修订；推送改了内容就记一个新修订，旧修订保留，当前修订可以指回旧修订（M264）。 */
export interface StoredTemplate {
  readonly name: string;
  readonly currentRevision: number;
  readonly revisions: readonly TemplateRevision[];
}

export interface ContentVersion {
  readonly version: number;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface StoredResource {
  readonly id: string;
  readonly kind: 'image' | 'font';
  readonly currentVersion: number;
  readonly versions: readonly ContentVersion[];
}

/** 推送看到的租户工作区：文档、模板修订与资源内容版本。 */
export interface AuthoringState {
  readonly documents: readonly StoredDocument[];
  readonly templates: readonly StoredTemplate[];
  readonly resources: readonly StoredResource[];
}

/** 一次推送要写入的内容，已按差异算好。 */
export interface PushWrites {
  /** 新的静态数据定义、编译产物与数据集：只新增，不覆盖。 */
  readonly documents: readonly StoredDocument[];
  /** 模板的新修订，写入后成为当前修订。 */
  readonly templates: readonly { readonly name: string; readonly sha256: string; readonly byteLength: number }[];
  /** 新资源（从 v1 起），或已有资源追加的后续内容版本。 */
  readonly resources: readonly { readonly id: string; readonly kind: 'image' | 'font'; readonly create: boolean; readonly versions: readonly ContentVersion[] }[];
  /** 随推送附带的代建轮次：与推送同一事务记为用量事件，已记过的轮次跳过（票据 09）。 */
  readonly rounds?: readonly RoundUsageEntry[];
}

/** 本租户按 SHA-256 存放的内容（ADR-0018）：先写内容，再登记；没有登记的内容不会出现在任何读者面前。 */
export interface ContentStore {
  /** 写入一份内容，返回它的 SHA-256；相同字节只存一份。 */
  put(bytes: Uint8Array): Promise<string>;
  has(sha256: string): Promise<boolean>;
  /** 读出一份内容（登记与否都读得到），不存在时 undefined。登记与否由调用方判断。 */
  get(sha256: string): Promise<Uint8Array | undefined>;
}

export interface TenantStorage {
  /** 按原始字节保存工作区文档；同一来源再次保存时指向新内容。 */
  putDocuments(documents: readonly { readonly source: string; readonly bytes: Uint8Array }[]): Promise<void>;
  readonly documents: WorkspaceDocumentSource;
  readonly resources: ResourceVersionBackend;
  createBatch(): Promise<TenantBatch>;
  openBatch(batchId: string): TenantBatch;
  readonly contents: ContentStore;
  /** 推送看到的当前状态：来源是"种类:键"的文档、模板修订与资源。 */
  authoringState(): Promise<AuthoringState>;
  /**
   * 一次推送：取得最新状态并排除其他推送与资源提交，交给 prepare 算出要写的内容，在一个事务里写入。
   * prepare 抛错时什么也不写。返回写入后的状态与各模板新修订的编号。
   */
  push(prepare: (state: AuthoringState) => Promise<PushWrites>, by: { readonly pushedBy: string; readonly now: Date }):
    Promise<{ readonly state: AuthoringState; readonly revisions: ReadonlyMap<string, number>; readonly recordedRounds: readonly string[] }>;
  /** 把模板的当前修订指向它已有的一个修订；模板或修订不存在时 undefined。 */
  setCurrentTemplate(name: string, revision: number): Promise<StoredTemplate | undefined>;
  /**
   * 保存一份数据集（票据 10）：新建时这个 ID 还不能有，修改时必须已有；条件不满足时什么也不写，返回 undefined。
   * 与推送、资源提交依次进行。
   */
  saveDataset(id: string, bytes: Uint8Array, mode: 'create' | 'update'): Promise<StoredDocument | undefined>;
  /**
   * 资源仓库，每次提交前在同一个事务、同一把锁里先把工作区文档的登记交给 guard 核对（替换资源，M152）；guard 抛错即整批不提交。
   * 推送、数据集保存与资源提交依次进行，所以核对之后、提交之前工作区不会变。
   */
  guardedResources(guard: (documents: readonly StoredDocument[]) => void | Promise<void>): ResourceVersionBackend;
}

/** 一项已登记的一个文件：读取时按登记的 SHA-256 与字节数核对（票据 08）。 */
export interface RegisteredFile {
  readonly name: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface TenantBatch {
  readonly batchId: string;
  readonly output: BatchOutput;
  readonly source: BatchSource;
  record(index: number): RecordSource;
  /** 本项已登记的文件（含完成清单），按文件名排列；还没登记时 undefined。 */
  itemFiles(index: number): Promise<readonly RegisteredFile[] | undefined>;
  /** 批次清单（batch.json）登记的 SHA-256；还没发布时 undefined。 */
  manifestSha256(): Promise<string | undefined>;
}

/** 结果里的问题：引擎的问题，或 worker 的问题（worker.timeout 等）；格式相同。 */
export type ResultProblem = Problem | { readonly code: string; readonly level: 'severe'; readonly location: ProblemLocation; readonly message: string };

/** 渲染任务的结果：与引擎 render 的结果相同（图片、问题清单、布局摘要）；worker 没能渲染完时只有问题清单。 */
export interface TaskResult {
  readonly image?: { readonly format: 'png' | 'jpeg'; readonly widthPx: number; readonly heightPx: number; readonly dpi: number; readonly bytes: Uint8Array };
  readonly problems: readonly ResultProblem[];
  readonly layout?: LayoutSummary;
}

/**
 * 批量交付一项的结果（票据 07）：引擎 deliverBatchItem 的结果，或 worker 一侧没能做完时的问题；不含图片字节。
 * directory 有值表示本项写了成果（问题清单，成功时还有记录），批次清单据此写项目录名。
 */
export interface ItemResult {
  readonly index: number;
  readonly id: string;
  readonly status: 'delivered' | 'failed' | 'notRun';
  readonly directory?: string;
  readonly files?: BatchItemFiles;
  readonly severe: number;
  readonly hints: number;
  readonly reason?: string;
  readonly problems: readonly ResultProblem[];
}

/** 渲染任务的状态：排队、渲染中、完成，或因等不到 worker 而撤回。 */
export type TaskState =
  | { readonly status: 'queued' | 'running' | 'cancelled' }
  | { readonly status: 'done'; readonly result: TaskResult };

/** 重放一条记录的结果（票据 08）：引擎 replayRecord 的完成清单与问题；没重放成时只有问题。 */
export interface ReplayResult {
  readonly manifest?: ReplayManifest;
  readonly problems: readonly ResultProblem[];
}

export type ReplayState =
  | { readonly status: 'queued' | 'running' | 'cancelled' }
  | { readonly status: 'done'; readonly result: ReplayResult };

/** 一条出图记录（票据 08）：正式交付成功、已登记的一项。 */
export interface RecordEntry {
  readonly batchId: string;
  readonly index: number;
  readonly id: string;
  readonly template: string;
  readonly build: string;
  /** 登记的时间，即这一项提交的时间。 */
  readonly deliveredAt: string;
  readonly image: string;
}

/** 记录的翻页位置：登记时间（后端自己的精度）、批次与项序号。 */
export interface RecordCursor {
  readonly at: string;
  readonly batchId: string;
  readonly index: number;
}

/** 查询出图记录：按登记时间倒序；from 含、to 不含；before 是上一页最后一条的位置。 */
export interface RecordQuery {
  readonly batchId?: string;
  readonly template?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly before?: RecordCursor;
  readonly limit: number;
}

/** 预览入队的限制（ADR-0017）：同一租户同时排队与渲染中的任务数，以及一分钟内入队的次数（撤回的也算）。 */
export interface PreviewQuota {
  readonly concurrency: number;
  readonly perMinute: number;
  /** 入队超过这么久的任务没人再等，不再占并发（例如 worker 中途退出、任务停在渲染中）。 */
  readonly staleAfterMs: number;
}

/** 新批次（票据 07）：接口进程固定好的批次，按项入队。 */
export interface NewBatch {
  /** 批次快照（renderweave-batch-snapshot/1）存成本租户的内容，这里是它的 SHA-256。 */
  readonly snapshot: string;
  /** 接受批次的构建：只由这个构建的 worker 交付。 */
  readonly build: string;
  readonly template: string;
  readonly mode: RenderMode;
  readonly items: readonly { readonly index: number; readonly id: string }[];
  readonly idempotencyKey?: string;
  /** 请求原文的 SHA-256：同一幂等键配不同的请求时拒绝。 */
  readonly requestSha256: string;
}

/** 批次的一项：排队、渲染中，或已结束（有结果）。 */
export interface BatchItemState {
  readonly index: number;
  readonly id: string;
  readonly status: 'queued' | 'running' | 'ended';
  readonly result?: ItemResult;
}

/** 批次的状态：逐项状态，全部结束后有批次清单。 */
export interface BatchState {
  readonly batchId: string;
  readonly build: string;
  readonly template: string;
  readonly mode: RenderMode;
  readonly idempotencyKey?: string;
  readonly requestSha256: string;
  readonly createdAt: string;
  readonly cancelRequestedAt?: string;
  readonly finishedAt?: string;
  readonly items: readonly BatchItemState[];
  /** 批次清单的摘要与批次级问题；全部项结束、清单发布后才有。 */
  readonly manifest?: { readonly summary: BatchSummary; readonly problems: readonly ResultProblem[] };
}

/** 一个租户的渲染任务。 */
export interface TenantTasks {
  /** 草稿预览入队；超过并发或频率时不入队，答 limited。 */
  enqueuePreview(request: unknown, quota: PreviewQuota, now: Date): Promise<{ readonly id: string } | { readonly limited: 'concurrency' | 'rate' }>;
  /** 任务不在本租户时 undefined。 */
  state(id: string): Promise<TaskState | undefined>;
  /** 取走结果之后清掉图片与布局；还在排队的撤回，不再占并发。预览与重放都适用。 */
  release(id: string): Promise<void>;
  /**
   * 建批次并按项入队，同一个事务里锁住当期计数行预占本批项数（ADR-0020）：已用 + 预占 + 本批项数超过限额时整批不建，答 shortfall。
   * 同一幂等键已有批次时不建、不预占，返回已有的那个（created 为 false）。批次的计费周期按 now 定，结算都记在这个周期。
   */
  createBatch(batch: NewBatch, now: Date): Promise<{ readonly batch: BatchState; readonly created: boolean } | { readonly shortfall: QuotaShortfall }>;
  /** 按幂等键找批次。 */
  findBatch(idempotencyKey: string): Promise<BatchState | undefined>;
  /** 批次不在本租户时 undefined。 */
  batch(batchId: string): Promise<BatchState | undefined>;
  /**
   * 取消批次：还在排队的项标为未执行；正在渲染的一项由 worker 结束。没有正在渲染的项时随即发布批次清单。
   * 批次已结束时不改变什么。批次不在本租户时 undefined。
   */
  cancelBatch(batchId: string, now: Date): Promise<BatchState | undefined>;
  /** 出图记录（票据 08）：每条带它的翻页位置。 */
  listRecords(query: RecordQuery): Promise<readonly (RecordEntry & { readonly cursor: RecordCursor })[]>;
  /** 重放入队：交给 build 的 worker；并发与频率的限制同预览，按种类各算各的。 */
  enqueueReplay(record: { readonly batchId: string; readonly index: number; readonly build: string }, quota: PreviewQuota, now: Date):
    Promise<{ readonly id: string } | { readonly limited: 'concurrency' | 'rate' }>;
  /** 任务不在本租户、或不是重放时 undefined。 */
  replayState(id: string): Promise<ReplayState | undefined>;
}

/** worker 领到的预览任务。 */
export interface PreviewTask {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'preview';
  readonly request: unknown;
}

/** worker 领到的批次项（票据 07）。attempts 是第几次领取，写回结果时用它作凭据：重领之后，旧的写回不生效。 */
export interface BatchItemTask {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'batchItem';
  readonly batchId: string;
  readonly index: number;
  readonly itemId: string;
  /** 批次快照的 SHA-256。 */
  readonly snapshot: string;
  readonly attempts: number;
}

/** worker 领到的重放（票据 08）：只由记录所属构建的 worker 领取。 */
export interface ReplayTask {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: 'replay';
  readonly batchId: string;
  readonly index: number;
}

export type ClaimedTask = PreviewTask | BatchItemTask | ReplayTask;

/** 领取的条件：worker 只领自己构建的批次项与重放（预览哪个构建都可以领）；停止前不再领预览与重放。 */
export interface ClaimOptions {
  readonly build: string;
  /** 批次项的租约：过了 now + leaseMs 还没写回，同构建的 worker 可以重领。 */
  readonly leaseMs: number;
  /** 领不领预览与重放（有人在等的任务）。 */
  readonly previews: boolean;
}

/**
 * 任务队列的 worker 一侧（ADR-0017）：领取任务（跨租户，SKIP LOCKED），完成后写回结果。
 * 预览优先；批次项按项序号轮转，各批次的第 1 项先于任何批次的第 2 项。
 */
export interface TaskQueue {
  claim(worker: string, now: Date, options: ClaimOptions): Promise<ClaimedTask | undefined>;
  finish(task: PreviewTask, result: TaskResult, now: Date): Promise<void>;
  finishReplay(task: ReplayTask, result: ReplayResult, now: Date): Promise<void>;
  /**
   * 写回批次项的结果；这一次领取已被重领时不生效（返回 false）。
   * 与"批次的其余项都已结束"同一个事务里发布批次清单（锁住批次行，最后结束的那一项负责）。
   */
  finishItem(task: BatchItemTask, result: ItemResult, now: Date): Promise<boolean>;
  /** 批次是否已请求取消：worker 渲染时定期查看，取消了就结束正在渲染的一项。 */
  cancelRequested(task: BatchItemTask): Promise<boolean>;
  /** 队列积压（跨租户，只有计数）：经接口进程与 worker 的就绪检查可见（票据 15）。 */
  backlog(now: Date): Promise<QueueBacklog>;
  /**
   * 删掉 before 之前入队的预览与重放任务行，返回删了几行（票据 15）。它们的结果由接口进程同步取走，之后没人再读；
   * 批次项的行是批次逐项状态与出图记录列表的来源，不删。
   */
  purge(before: Date): Promise<number>;
}

/** 各种类的任务数。 */
export interface TaskCounts { readonly preview: number; readonly batchItem: number; readonly replay: number }

export interface QueueBacklog {
  readonly queued: TaskCounts;
  /** 领了还没写回的，含过了租约等着重领的批次项。 */
  readonly running: TaskCounts;
  /** 排队最久的一项已经等了多久，毫秒；没有排队的任务时是 0。 */
  readonly oldestQueuedMs: number;
}

/** 一个租户的句柄：其中每个操作都只触及这个租户的数据（ADR-0018 的应用层防线）。 */
export interface TenantScope {
  readonly tenantId: string;
  get(): Promise<Tenant | undefined>;
  listMembers(): Promise<Member[]>;
  getMember(id: string): Promise<Member | undefined>;
  /** 邮箱已被任何账号使用时抛 EmailTakenError。 */
  createMember(member: { email: string; role: MemberRole; passwordHash: string }): Promise<Member>;
  updateMember(id: string, change: { role?: MemberRole; active?: boolean }): Promise<Member | undefined>;
  setPassword(memberId: string, passwordHash: string): Promise<boolean>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<string>;
  /** 吊销该成员的全部会话：停用或重置密码之后。 */
  revokeSessionsOf(userId: string, now: Date): Promise<void>;
  createApiKey(key: { name: string; tokenHash: string; prefix: string }): Promise<ApiKeyInfo>;
  listApiKeys(): Promise<ApiKeyInfo[]>;
  revokeApiKey(id: string, now: Date): Promise<boolean>;
  appendAudit(event: NewAuditEvent, now: Date): Promise<void>;
  /** 按时间倒序；before 是上一页最后一条的 ID。 */
  listAudit(options: { limit: number; before?: string }): Promise<AuditEvent[]>;
  /** 租户的套餐；没设过时是 DEFAULT_PLAN。 */
  plan(): Promise<Plan>;
  /** 设置套餐；当期计数行已有时一并改它的限额，以后的周期按新套餐。 */
  setPlan(plan: Plan, now: Date): Promise<void>;
  /** 一个周期的计数；这个周期还没有计数行时，限额取当前套餐。 */
  usage(period: string): Promise<UsageCounts>;
  /** 一个周期的用量事件，按 ID 倒序；before 是上一页最后一条的 ID。 */
  listUsageEvents(options: { readonly period: string; readonly kind?: UsageKind; readonly before?: string; readonly limit: number }): Promise<UsageEvent[]>;
  /** 注册 webhook；已启用 MAX_ACTIVE_WEBHOOKS 个时不注册。 */
  createWebhook(webhook: NewWebhook, now: Date): Promise<Webhook | { readonly limitReached: true }>;
  /** 按注册时间排列。 */
  listWebhooks(): Promise<Webhook[]>;
  getWebhook(id: string): Promise<Webhook | undefined>;
  /** 停用或重新启用、改说明；重新启用时已启用 MAX_ACTIVE_WEBHOOKS 个则不改。不存在时 undefined。 */
  updateWebhook(id: string, change: { readonly active?: boolean; readonly description?: string }, now: Date): Promise<Webhook | { readonly limitReached: true } | undefined>;
  /** 一个 webhook 的投递，按 ID 倒序；before 是上一页最后一条的 ID。 */
  listWebhookDeliveries(webhookId: string, options: { readonly limit: number; readonly before?: string }): Promise<WebhookDelivery[]>;
  readonly storage: TenantStorage;
  readonly tasks: TenantTasks;
}

/**
 * 在线的 worker（票据 08）：worker 定期报到自己的构建，停止时离开。重放前据此判断记录所属的构建有没有 worker；
 * 没有就拒绝，不排进一个没人领的队列。
 */
export interface WorkerRegistry {
  heartbeat(worker: string, build: string, now: Date): Promise<void>;
  leave(worker: string): Promise<void>;
  /** since 之后报到过的 worker，按构建计数。 */
  online(since: Date): Promise<ReadonlyMap<string, number>>;
}

export interface ServiceBackend {
  readiness(): Promise<Readiness>;
  readonly platform: PlatformStore;
  tenant(tenantId: string): TenantScope;
  readonly queue: TaskQueue;
  readonly workers: WorkerRegistry;
  /**
   * 对账（跨租户，ADR-0020）：退回崩溃后遗留的预占。批次已结束还有预占的，全部退回；没结束的，接受它的构建在 onlineSince 之后
   * 没有 worker 报到、批次在 idleBefore 之后也没有动静（建批次、领取、写回），视为没人再交付，退回剩余预占。
   * 这样的批次以后若又有那个构建的 worker 交付，成功的项照样计已用。
   */
  reconcileReservations(options: { readonly onlineSince: Date; readonly idleBefore: Date }): Promise<readonly ReleasedReservation[]>;
  readonly webhooks: WebhookOutbox;
}
