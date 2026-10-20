/**
 * 服务的后端（ADR-0018）：平台级的跨租户操作，与只触及一个租户的句柄。
 * 两种实现跑同一组 API 用例：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑（阶段 4 PRD「接缝」）。
 */
import type {
  BatchItemFiles, BatchOutput, BatchSource, BatchSummary, LayoutSummary, Problem, ProblemLocation, RecordSource, RenderMode, ResourceVersionBackend, WorkspaceDocumentSource,
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
    Promise<{ readonly state: AuthoringState; readonly revisions: ReadonlyMap<string, number> }>;
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

export interface TenantBatch {
  readonly batchId: string;
  readonly output: BatchOutput;
  readonly source: BatchSource;
  record(index: number): RecordSource;
  /** 本项已登记的文件名（含完成清单）；还没登记时 undefined。 */
  itemFiles(index: number): Promise<readonly string[] | undefined>;
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
  /** 取走结果之后清掉图片与布局；还在排队的撤回，不再占并发。 */
  release(id: string): Promise<void>;
  /** 建批次并按项入队。同一幂等键已有批次时不建，返回已有的那个（created 为 false）。 */
  createBatch(batch: NewBatch, now: Date): Promise<{ readonly batch: BatchState; readonly created: boolean }>;
  /** 按幂等键找批次。 */
  findBatch(idempotencyKey: string): Promise<BatchState | undefined>;
  /** 批次不在本租户时 undefined。 */
  batch(batchId: string): Promise<BatchState | undefined>;
  /**
   * 取消批次：还在排队的项标为未执行；正在渲染的一项由 worker 结束。没有正在渲染的项时随即发布批次清单。
   * 批次已结束时不改变什么。批次不在本租户时 undefined。
   */
  cancelBatch(batchId: string, now: Date): Promise<BatchState | undefined>;
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

export type ClaimedTask = PreviewTask | BatchItemTask;

/** 领取的条件：worker 只领自己构建的批次项（预览哪个构建都可以领）；停止前不再领预览。 */
export interface ClaimOptions {
  readonly build: string;
  /** 批次项的租约：过了 now + leaseMs 还没写回，同构建的 worker 可以重领。 */
  readonly leaseMs: number;
  readonly previews: boolean;
}

/**
 * 任务队列的 worker 一侧（ADR-0017）：领取任务（跨租户，SKIP LOCKED），完成后写回结果。
 * 预览优先；批次项按项序号轮转，各批次的第 1 项先于任何批次的第 2 项。
 */
export interface TaskQueue {
  claim(worker: string, now: Date, options: ClaimOptions): Promise<ClaimedTask | undefined>;
  finish(task: PreviewTask, result: TaskResult, now: Date): Promise<void>;
  /**
   * 写回批次项的结果；这一次领取已被重领时不生效（返回 false）。
   * 与"批次的其余项都已结束"同一个事务里发布批次清单（锁住批次行，最后结束的那一项负责）。
   */
  finishItem(task: BatchItemTask, result: ItemResult, now: Date): Promise<boolean>;
  /** 批次是否已请求取消：worker 渲染时定期查看，取消了就结束正在渲染的一项。 */
  cancelRequested(task: BatchItemTask): Promise<boolean>;
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
  readonly storage: TenantStorage;
  readonly tasks: TenantTasks;
}

export interface ServiceBackend {
  readiness(): Promise<Readiness>;
  readonly platform: PlatformStore;
  tenant(tenantId: string): TenantScope;
  readonly queue: TaskQueue;
}
