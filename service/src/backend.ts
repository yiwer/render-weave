/**
 * 服务的后端（ADR-0018）：平台级的跨租户操作，与只触及一个租户的句柄。
 * 两种实现跑同一组 API 用例：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑（阶段 4 PRD「接缝」）。
 */
import type { BatchOutput, BatchSource, RecordSource, ResourceVersionBackend, WorkspaceDocumentSource } from './engine.js';

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

export interface TenantStorage {
  /** 按原始字节保存工作区文档；同一来源再次保存时指向新内容。 */
  putDocuments(documents: readonly { readonly source: string; readonly bytes: Uint8Array }[]): Promise<void>;
  readonly documents: WorkspaceDocumentSource;
  readonly resources: ResourceVersionBackend;
  createBatch(): Promise<TenantBatch>;
  openBatch(batchId: string): TenantBatch;
}

export interface TenantBatch {
  readonly batchId: string;
  readonly output: BatchOutput;
  readonly source: BatchSource;
  record(index: number): RecordSource;
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
}

export interface ServiceBackend {
  readiness(): Promise<Readiness>;
  readonly platform: PlatformStore;
  tenant(tenantId: string): TenantScope;
}
