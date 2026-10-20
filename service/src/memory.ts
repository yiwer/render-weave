/**
 * 内存后端：与 PostgreSQL 加 S3 后端语义相同，供 npm test 里的 API 用例使用（阶段 4 PRD「接缝」）。
 * 每个租户的数据按租户 ID 分开存放，租户句柄只能看到自己那一份。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  documentSource, EmailTakenError, parseDocumentSource,
  type ApiKeyInfo, type AuditEvent, type AuthoringState, type AuthoringTokenInfo, type Identity, type LoginRecord, type Member, type MemberRole, type NewAuditEvent,
  type PlatformUser, type ServiceBackend, type StoredTemplate, type TaskResult, type TemplateRevision, type Tenant, type TenantBatch, type TenantScope, type TenantStorage,
} from './backend.js';
import { createMemoryBatch, memoryWorkspaceDocuments, resourceBackend, type ResourceManifestEntry } from './engine.js';

interface UserRow { id: string; tenantId: string | null; email: string; role: MemberRole | 'platformAdmin'; passwordHash: string; active: boolean; createdAt: string }
interface SessionRow { id: string; userId: string; tenantId: string | null; tokenHash: string; expiresAt: Date; revokedAt?: Date }
interface ApiKeyRow extends ApiKeyInfo { tenantId: string; tokenHash: string }
interface AuthoringRow extends AuthoringTokenInfo { tokenHash: string }
interface TaskRow { id: string; tenantId: string; kind: 'preview'; request: unknown; status: 'queued' | 'running' | 'done' | 'cancelled'; result?: TaskResult; createdAt: Date }

export function createMemoryBackend(): ServiceBackend {
  const tenants = new Map<string, Tenant>();
  const users = new Map<string, UserRow>();
  const sessions = new Map<string, SessionRow>();
  const apiKeys = new Map<string, ApiKeyRow>();
  const authoring = new Map<string, AuthoringRow>();
  const audit: AuditEvent[] = [];
  const storages = new Map<string, TenantStorage>();
  /** 全部租户的渲染任务，按入队顺序。 */
  const tasks: TaskRow[] = [];
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
      tasks: {
        async enqueuePreview(request, quota, now) {
          const previews = tasks.filter((task) => own(task) && task.kind === 'preview');
          const active = (task: TaskRow) => (task.status === 'queued' || task.status === 'running') && task.createdAt.getTime() > now.getTime() - quota.staleAfterMs;
          if (previews.filter(active).length >= quota.concurrency) return { limited: 'concurrency' };
          if (previews.filter((task) => task.createdAt.getTime() > now.getTime() - 60_000).length >= quota.perMinute) return { limited: 'rate' };
          const row: TaskRow = { id: randomUUID(), tenantId, kind: 'preview', request: structuredClone(request), status: 'queued', createdAt: now };
          tasks.push(row);
          return { id: row.id };
        },
        async state(id) {
          const row = tasks.find((task) => task.id === id && own(task));
          if (!row) return undefined;
          return row.status === 'done' ? { status: 'done', result: row.result! } : { status: row.status };
        },
        async release(id) {
          const row = tasks.find((task) => task.id === id && own(task));
          if (row?.status === 'queued') row.status = 'cancelled';
          else if (row?.status === 'done') row.result = { problems: row.result!.problems };
        },
      },
    };
  };

  return {
    readiness: async () => ({ ready: true, checks: { memory: 'ok' } }),
    tenant,
    queue: {
      async claim() {
        const row = tasks.find((task) => task.status === 'queued');
        if (!row) return undefined;
        row.status = 'running';
        return { id: row.id, tenantId: row.tenantId, kind: row.kind, request: structuredClone(row.request) };
      },
      async finish(task, result) {
        const row = tasks.find((item) => item.id === task.id && item.status === 'running');
        if (!row) return;
        row.status = 'done';
        row.result = result;
      },
    },
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

/** 一个租户的工作区文档、模板修订、资源仓库与批次，全在内存里。 */
function memoryStorage(): TenantStorage {
  /** 本租户的全部内容，按 SHA-256 存放：工作区文档、模板修订、资源内容版本，以及已上传还没登记的内容。 */
  const contents = new Map<string, Uint8Array>();
  /** 工作区文档：来源 → 内容。推送进来的文档来源是"种类:键"，模板那一行指向当前修订。 */
  const documents = new Map<string, { sha256: string; byteLength: number }>();
  const templates = new Map<string, { current: number; revisions: TemplateRevision[] }>();
  let resources: readonly ResourceManifestEntry[] = [];
  const batches = new Map<string, TenantBatch>();
  /** 资源提交、推送与改当前修订依次进行，与 PostgreSQL 后端锁住租户的一行相同。 */
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => undefined);
    return run;
  };
  const put = (bytes: Uint8Array) => {
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (!contents.has(hash)) contents.set(hash, new Uint8Array(bytes));
    return hash;
  };
  const read = (hash: string) => {
    const bytes = contents.get(hash);
    if (!bytes) throw new Error(`内容不存在：${hash}`);
    return new Uint8Array(bytes);
  };
  const template = (name: string, row: { current: number; revisions: TemplateRevision[] }): StoredTemplate =>
    ({ name, currentRevision: row.current, revisions: structuredClone(row.revisions) });
  const state = (): AuthoringState => ({
    documents: [...documents].flatMap(([source, content]) => {
      const parsed = parseDocumentSource(source);
      return parsed ? [{ ...parsed, ...content }] : [];
    }),
    templates: [...templates].map(([name, row]) => template(name, row)),
    resources: resources.map((entry) => ({
      id: entry.id, kind: entry.kind, currentVersion: entry.currentVersion,
      versions: entry.versions.map(({ version, sha256, byteLength }) => ({ version, sha256, byteLength })),
    })),
  });
  const open = (batchId: string): TenantBatch => {
    const batch = batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    return batch;
  };
  return {
    async putDocuments(list) { for (const { source, bytes } of list) documents.set(source, { sha256: put(bytes), byteLength: bytes.length }); },
    documents: {
      location: 'memory',
      list: () => memoryWorkspaceDocuments([...documents].map(([source, { sha256 }]) => ({ source, bytes: read(sha256) }))).list(),
    },
    resources: resourceBackend({
      location: 'memory',
      snapshot: async () => ({ entries: structuredClone(resources), load: async (file) => read(file) }),
      place: async (bytes) => put(bytes),
      commit: (apply) => exclusive(async () => { resources = structuredClone(await apply(structuredClone(resources))); }),
    }),
    async createBatch() {
      const batchId = randomUUID(), batch = createMemoryBatch(`batches/${batchId}`);
      const created: TenantBatch = { batchId, output: batch.output, source: batch.batch, record: (index) => batch.record(index) };
      batches.set(batchId, created);
      return created;
    },
    openBatch: open,
    contents: {
      put: async (bytes) => put(bytes),
      has: async (hash) => contents.has(hash),
      get: async (hash) => (contents.has(hash) ? read(hash) : undefined),
    },
    authoringState: async () => state(),
    push: (prepare, { pushedBy, now }) => exclusive(async () => {
      const writes = await prepare(state());
      // prepare 之后不会再失败：一次改完，与事务提交相同。
      for (const document of writes.documents) documents.set(documentSource(document.kind, document.key), { sha256: document.sha256, byteLength: document.byteLength });
      const revisions = new Map<string, number>();
      for (const { name, sha256, byteLength } of writes.templates) {
        const row = templates.get(name) ?? { current: 0, revisions: [] };
        const revision = Math.max(0, ...row.revisions.map((item) => item.revision)) + 1;
        row.revisions.push({ revision, sha256, byteLength, createdAt: now.toISOString(), pushedBy });
        row.current = revision;
        templates.set(name, row);
        documents.set(documentSource('template', name), { sha256, byteLength });
        revisions.set(name, revision);
      }
      const entries = new Map(resources.map((entry) => [entry.id, entry]));
      for (const { id, kind, versions } of writes.resources) {
        const old = entries.get(id);
        const added = versions.map((content) => ({ ...content, file: content.sha256 }));
        entries.set(id, { id, kind, currentVersion: versions.at(-1)!.version, versions: [...(old?.versions ?? []), ...added] });
      }
      resources = [...entries.values()];
      return { state: state(), revisions };
    }),
    setCurrentTemplate: (name, revision) => exclusive(async () => {
      const row = templates.get(name), found = row?.revisions.find((item) => item.revision === revision);
      if (!row || !found) return undefined;
      row.current = revision;
      documents.set(documentSource('template', name), { sha256: found.sha256, byteLength: found.byteLength });
      return template(name, row);
    }),
  };
}
