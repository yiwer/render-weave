/**
 * 内存后端：与 PostgreSQL 加 S3 后端语义相同，供 npm test 里的 API 用例使用（阶段 4 PRD「接缝」）。
 * 每个租户的数据按租户 ID 分开存放，租户句柄只能看到自己那一份。
 */
import { randomUUID } from 'node:crypto';
import {
  EmailTakenError,
  type ApiKeyInfo, type AuditEvent, type AuthoringTokenInfo, type Identity, type LoginRecord, type Member, type MemberRole, type NewAuditEvent,
  type PlatformUser, type ServiceBackend, type Tenant, type TenantBatch, type TenantScope, type TenantStorage,
} from './backend.js';
import { createMemoryBatch, createMemoryResourceBackend, memoryWorkspaceDocuments } from './engine.js';

interface UserRow { id: string; tenantId: string | null; email: string; role: MemberRole | 'platformAdmin'; passwordHash: string; active: boolean; createdAt: string }
interface SessionRow { id: string; userId: string; tenantId: string | null; tokenHash: string; expiresAt: Date; revokedAt?: Date }
interface ApiKeyRow extends ApiKeyInfo { tenantId: string; tokenHash: string }
interface AuthoringRow extends AuthoringTokenInfo { tokenHash: string }

export function createMemoryBackend(): ServiceBackend {
  const tenants = new Map<string, Tenant>();
  const users = new Map<string, UserRow>();
  const sessions = new Map<string, SessionRow>();
  const apiKeys = new Map<string, ApiKeyRow>();
  const authoring = new Map<string, AuthoringRow>();
  const audit: AuditEvent[] = [];
  const storages = new Map<string, TenantStorage>();
  let sequence = 0;

  const member = (row: UserRow): Member => ({ id: row.id, tenantId: row.tenantId!, email: row.email, role: row.role as MemberRole, active: row.active, createdAt: row.createdAt });
  const keyInfo = ({ tenantId: _t, tokenHash: _h, ...info }: ApiKeyRow): ApiKeyInfo => info;
  const tokenInfo = ({ tokenHash: _h, ...info }: AuthoringRow): AuthoringTokenInfo => info;
  const emailTaken = (email: string) => [...users.values()].some((user) => user.email === email.toLowerCase());
  const record = (tenantId: string | null, event: NewAuditEvent, now: Date) => {
    audit.push({ id: String(++sequence), tenantId, at: now.toISOString(), ...structuredClone(event) });
  };
  const session = (userId: string, tenantId: string | null, tokenHash: string, expiresAt: Date) => {
    const id = randomUUID();
    sessions.set(id, { id, userId, tenantId, tokenHash, expiresAt });
    return id;
  };

  const tenant = (tenantId: string): TenantScope => {
    const own = (row: { tenantId: string | null } | undefined) => row?.tenantId === tenantId;
    return {
      tenantId,
      get: async () => tenants.get(tenantId),
      listMembers: async () => [...users.values()].filter(own).map(member).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.email.localeCompare(b.email)),
      getMember: async (id) => { const row = users.get(id); return own(row) ? member(row!) : undefined; },
      async createMember({ email, role, passwordHash }) {
        if (emailTaken(email)) throw new EmailTakenError(email);
        const row: UserRow = { id: randomUUID(), tenantId, email: email.toLowerCase(), role, passwordHash, active: true, createdAt: new Date().toISOString() };
        users.set(row.id, row);
        return member(row);
      },
      async updateMember(id, change) {
        const row = users.get(id);
        if (!own(row)) return undefined;
        if (change.role) row!.role = change.role;
        if (change.active !== undefined) row!.active = change.active;
        return member(row!);
      },
      async setPassword(id, passwordHash) {
        const row = users.get(id);
        if (!own(row)) return false;
        row!.passwordHash = passwordHash;
        return true;
      },
      createSession: async (userId, tokenHash, expiresAt) => session(userId, tenantId, tokenHash, expiresAt),
      async revokeSessionsOf(userId, now) {
        for (const row of sessions.values()) if (row.tenantId === tenantId && row.userId === userId && !row.revokedAt) row.revokedAt = now;
      },
      async createApiKey({ name, tokenHash, prefix }) {
        const row: ApiKeyRow = { id: randomUUID(), tenantId, name, prefix, tokenHash, createdAt: new Date().toISOString() };
        apiKeys.set(row.id, row);
        return keyInfo(row);
      },
      listApiKeys: async () => [...apiKeys.values()].filter(own).map(keyInfo),
      async revokeApiKey(id, now) {
        const row = apiKeys.get(id);
        if (!own(row) || row!.revokedAt) return own(row);
        apiKeys.set(id, { ...row!, revokedAt: now.toISOString() });
        return true;
      },
      appendAudit: async (event, now) => record(tenantId, event, now),
      async listAudit({ limit, before }) {
        return audit.filter((event) => event.tenantId === tenantId && (!before || Number(event.id) < Number(before))).reverse().slice(0, limit).map((event) => structuredClone(event));
      },
      get storage() {
        let storage = storages.get(tenantId);
        if (!storage) storages.set(tenantId, storage = memoryStorage());
        return storage;
      },
    };
  };

  return {
    readiness: async () => ({ ready: true, checks: { memory: 'ok' } }),
    tenant,
    platform: {
      async createTenant(name) {
        const row: Tenant = { id: randomUUID(), name, createdAt: new Date().toISOString() };
        tenants.set(row.id, row);
        return row;
      },
      listTenants: async () => [...tenants.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      async createPlatformUser(email, passwordHash): Promise<PlatformUser> {
        if (emailTaken(email)) throw new EmailTakenError(email);
        const row: UserRow = { id: randomUUID(), tenantId: null, email: email.toLowerCase(), role: 'platformAdmin', passwordHash, active: true, createdAt: new Date().toISOString() };
        users.set(row.id, row);
        return { id: row.id, email: row.email, createdAt: row.createdAt };
      },
      async findLogin(email): Promise<LoginRecord | undefined> {
        const row = [...users.values()].find((user) => user.email === email.toLowerCase());
        return row && { userId: row.id, tenantId: row.tenantId, email: row.email, role: row.role, passwordHash: row.passwordHash, active: row.active };
      },
      createSession: async (userId, tokenHash, expiresAt) => session(userId, null, tokenHash, expiresAt),
      async resolveToken(tokenHash, now): Promise<Identity | undefined> {
        const live = (row: { revokedAt?: unknown; expiresAt?: Date | string }) => !row.revokedAt && (!row.expiresAt || new Date(row.expiresAt) > now);
        const found = [...sessions.values()].find((row) => row.tokenHash === tokenHash && live(row));
        if (found) {
          const user = users.get(found.userId);
          if (!user?.active || (user.tenantId && !tenants.has(user.tenantId))) return undefined;
          return user.tenantId
            ? { kind: 'member', userId: user.id, tenantId: user.tenantId, role: user.role as MemberRole, email: user.email, sessionId: found.id }
            : { kind: 'platformUser', userId: user.id, email: user.email, sessionId: found.id };
        }
        const key = [...apiKeys.values()].find((row) => row.tokenHash === tokenHash && live(row));
        if (key) return tenants.has(key.tenantId) ? { kind: 'apiKey', keyId: key.id, tenantId: key.tenantId, name: key.name } : undefined;
        const token = [...authoring.values()].find((row) => row.tokenHash === tokenHash && live(row));
        return token && { kind: 'authoringToken', tokenId: token.id, label: token.label, tenantIds: [...token.tenantIds] };
      },
      async revokeSession(sessionId) {
        const row = sessions.get(sessionId);
        if (row && !row.revokedAt) row.revokedAt = new Date();
      },
      async createAuthoringToken({ label, tokenHash, prefix, tenantIds, expiresAt }) {
        const row: AuthoringRow = { id: randomUUID(), label, prefix, tokenHash, tenantIds: [...tenantIds], createdAt: new Date().toISOString(), expiresAt: expiresAt.toISOString() };
        authoring.set(row.id, row);
        return tokenInfo(row);
      },
      listAuthoringTokens: async () => [...authoring.values()].map(tokenInfo),
      async revokeAuthoringToken(id, now) {
        const row = authoring.get(id);
        if (!row) return false;
        if (!row.revokedAt) authoring.set(id, { ...row, revokedAt: now.toISOString() });
        return true;
      },
      appendAudit: async (event, now) => record(null, event, now),
    },
  };
}

/** 一个租户的工作区文档、资源仓库与批次，全在内存里。 */
function memoryStorage(): TenantStorage {
  const documents = new Map<string, Uint8Array>();
  const batches = new Map<string, TenantBatch>();
  const open = (batchId: string): TenantBatch => {
    const batch = batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    return batch;
  };
  return {
    async putDocuments(list) { for (const { source, bytes } of list) documents.set(source, new Uint8Array(bytes)); },
    documents: { location: 'memory', list: () => memoryWorkspaceDocuments([...documents].map(([source, bytes]) => ({ source, bytes }))).list() },
    resources: createMemoryResourceBackend(),
    async createBatch() {
      const batchId = randomUUID(), batch = createMemoryBatch(`batches/${batchId}`);
      const created: TenantBatch = { batchId, output: batch.output, source: batch.batch, record: (index) => batch.record(index) };
      batches.set(batchId, created);
      return created;
    },
    openBatch: open,
  };
}
