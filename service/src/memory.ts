/**
 * 内存后端：与 PostgreSQL 加 S3 后端语义相同，供 npm test 里的 API 用例使用（阶段 4 PRD「接缝」）。
 * 每个租户的数据按租户 ID 分开存放，租户句柄只能看到自己那一份。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  documentSource, EmailTakenError, parseDocumentSource,
  type ApiKeyInfo, type AuditEvent, type AuthoringState, type AuthoringTokenInfo, type BatchState, type Identity, type ItemResult, type LoginRecord, type Member,
  type MemberRole, type NewAuditEvent, type PlatformUser, type ServiceBackend, type StoredTemplate, type TaskResult, type TemplateRevision, type Tenant,
  type TenantBatch, type TenantScope, type TenantStorage,
} from './backend.js';
import { batchManifest, NOT_STARTED, notRunItem } from './batches.js';
import { itemDirectory, manifestBytes, memoryWorkspaceDocuments, resourceBackend, type BatchSource, type RenderMode, type ResourceManifestEntry } from './engine.js';

interface UserRow { id: string; tenantId: string | null; email: string; role: MemberRole | 'platformAdmin'; passwordHash: string; active: boolean; createdAt: string }
interface SessionRow { id: string; userId: string; tenantId: string | null; tokenHash: string; expiresAt: Date; revokedAt?: Date }
interface ApiKeyRow extends ApiKeyInfo { tenantId: string; tokenHash: string }
interface AuthoringRow extends AuthoringTokenInfo { tokenHash: string }
interface TaskRow {
  id: string; tenantId: string; kind: 'preview' | 'batchItem'; request: unknown; status: 'queued' | 'running' | 'done' | 'cancelled';
  result?: TaskResult; item?: ItemResult; createdAt: Date; sequence: number;
  /** 批次项：所属批次、项序号与标识、接受它的构建、租约与领取次数。 */
  batchId?: string; index?: number; itemId?: string; build?: string; leaseUntil?: Date; attempts: number;
}
interface BatchRow {
  tenantId: string; batchId: string; snapshot: string; build: string; template: string; mode: RenderMode; idempotencyKey?: string; requestSha256: string;
  createdAt: Date; cancelRequestedAt?: Date; finishedAt?: Date; manifest?: NonNullable<BatchState['manifest']>;
}
/** 内存存储另外提供：按批次 ID 建批次的成果去处（接口进程建批次时用）。 */
type MemoryStorage = TenantStorage & { registerBatch(batchId: string): TenantBatch };

export function createMemoryBackend(): ServiceBackend {
  const tenants = new Map<string, Tenant>();
  const users = new Map<string, UserRow>();
  const sessions = new Map<string, SessionRow>();
  const apiKeys = new Map<string, ApiKeyRow>();
  const authoring = new Map<string, AuthoringRow>();
  const audit: AuditEvent[] = [];
  const storages = new Map<string, MemoryStorage>();
  /** 全部租户的渲染任务，按入队顺序。 */
  const tasks: TaskRow[] = [];
  const batches = new Map<string, BatchRow>();
  let sequence = 0, taskSequence = 0;
  const storageOf = (tenantId: string) => {
    let storage = storages.get(tenantId);
    if (!storage) storages.set(tenantId, storage = memoryStorage());
    return storage;
  };
  const batchItems = (batchId: string) => tasks.filter((task) => task.batchId === batchId).sort((a, b) => a.index! - b.index!);
  const batchState = (row: BatchRow): BatchState => ({
    batchId: row.batchId, build: row.build, template: row.template, mode: row.mode,
    ...(row.idempotencyKey === undefined ? {} : { idempotencyKey: row.idempotencyKey }), requestSha256: row.requestSha256,
    createdAt: row.createdAt.toISOString(), ...(row.cancelRequestedAt ? { cancelRequestedAt: row.cancelRequestedAt.toISOString() } : {}),
    ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}),
    items: batchItems(row.batchId).map((task) => ({
      index: task.index!, id: task.itemId!, status: task.item ? 'ended' : task.status === 'running' ? 'running' : 'queued',
      ...(task.item ? { result: structuredClone(task.item) } : {}),
    })),
    ...(row.manifest ? { manifest: structuredClone(row.manifest) } : {}),
  });
  /** 全部项都结束了就发布批次清单；与 PostgreSQL 后端在写回最后一项的事务里发布相同。 */
  const finalize = async (row: BatchRow, now: Date) => {
    const items = batchItems(row.batchId);
    if (row.manifest || items.some((task) => !task.item)) return;
    const manifest = batchManifest({ build: row.build, template: row.template, mode: row.mode, cancelled: row.cancelRequestedAt !== undefined }, items.map((task) => task.item!));
    row.manifest = { summary: manifest.summary, problems: manifest.problems };
    row.finishedAt = now;
    await storageOf(row.tenantId).openBatch(row.batchId).output.finish(manifest);
  };

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
      get storage() { return storageOf(tenantId); },
      tasks: {
        async enqueuePreview(request, quota, now) {
          const previews = tasks.filter((task) => own(task) && task.kind === 'preview');
          const active = (task: TaskRow) => (task.status === 'queued' || task.status === 'running') && task.createdAt.getTime() > now.getTime() - quota.staleAfterMs;
          if (previews.filter(active).length >= quota.concurrency) return { limited: 'concurrency' };
          if (previews.filter((task) => task.createdAt.getTime() > now.getTime() - 60_000).length >= quota.perMinute) return { limited: 'rate' };
          const row: TaskRow = { id: randomUUID(), tenantId, kind: 'preview', request: structuredClone(request), status: 'queued', createdAt: now, sequence: ++taskSequence, attempts: 0 };
          tasks.push(row);
          return { id: row.id };
        },
        async state(id) {
          const row = tasks.find((task) => task.id === id && own(task));
          if (!row) return undefined;
          return row.status === 'done' ? { status: 'done', result: row.result! } : { status: row.status };
        },
        async release(id) {
          const row = tasks.find((task) => task.id === id && own(task) && task.kind === 'preview');
          if (row?.status === 'queued') row.status = 'cancelled';
          else if (row?.status === 'done') row.result = { problems: row.result!.problems };
        },
        async createBatch(batch, now) {
          const existing = batch.idempotencyKey === undefined ? undefined
            : [...batches.values()].find((row) => row.tenantId === tenantId && row.idempotencyKey === batch.idempotencyKey);
          if (existing) return { batch: batchState(existing), created: false };
          const row: BatchRow = { tenantId, batchId: randomUUID(), snapshot: batch.snapshot, build: batch.build, template: batch.template, mode: batch.mode,
            ...(batch.idempotencyKey === undefined ? {} : { idempotencyKey: batch.idempotencyKey }), requestSha256: batch.requestSha256, createdAt: now };
          batches.set(row.batchId, row);
          storageOf(tenantId).registerBatch(row.batchId);
          for (const item of batch.items) {
            tasks.push({ id: randomUUID(), tenantId, kind: 'batchItem', request: { snapshot: batch.snapshot, id: item.id }, status: 'queued', createdAt: now,
              sequence: ++taskSequence, batchId: row.batchId, index: item.index, itemId: item.id, build: batch.build, attempts: 0 });
          }
          return { batch: batchState(row), created: true };
        },
        async findBatch(key) {
          const row = [...batches.values()].find((batch) => batch.tenantId === tenantId && batch.idempotencyKey === key);
          return row && batchState(row);
        },
        async batch(batchId) {
          const row = batches.get(batchId);
          return row?.tenantId === tenantId ? batchState(row) : undefined;
        },
        async cancelBatch(batchId, now) {
          const row = batches.get(batchId);
          if (row?.tenantId !== tenantId) return undefined;
          if (row.manifest) return batchState(row);
          row.cancelRequestedAt ??= now;
          for (const task of batchItems(batchId)) {
            if (task.status !== 'queued') continue;
            task.status = 'cancelled';
            task.item = notRunItem(task.index!, task.itemId!, NOT_STARTED);
          }
          await finalize(row, now);
          return batchState(row);
        },
      },
    };
  };

  return {
    readiness: async () => ({ ready: true, checks: { memory: 'ok' } }),
    tenant,
    queue: {
      async claim(_worker, now, { build, leaseMs, previews }) {
        // 预览没有项序号，排在批次项前面；批次项按项序号轮转，再按入队先后。过了租约还在渲染中的批次项可以由同构建的 worker 重领。
        const claimable = (task: TaskRow) => task.kind === 'preview'
          ? previews && task.status === 'queued'
          : task.build === build && (task.status === 'queued' || (task.status === 'running' && task.leaseUntil! < now));
        const row = tasks.filter(claimable).sort((a, b) =>
          (a.index ?? 0) - (b.index ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime() || a.sequence - b.sequence)[0];
        if (!row) return undefined;
        row.status = 'running';
        row.attempts++;
        if (row.kind === 'preview') return { id: row.id, tenantId: row.tenantId, kind: 'preview', request: structuredClone(row.request) };
        row.leaseUntil = new Date(now.getTime() + leaseMs);
        return { id: row.id, tenantId: row.tenantId, kind: 'batchItem', batchId: row.batchId!, index: row.index!, itemId: row.itemId!,
          snapshot: (row.request as { snapshot: string }).snapshot, attempts: row.attempts };
      },
      async finish(task, result) {
        const row = tasks.find((item) => item.id === task.id && item.status === 'running');
        if (!row) return;
        row.status = 'done';
        row.result = result;
      },
      async finishItem(task, result, now) {
        const row = tasks.find((item) => item.id === task.id && item.status === 'running' && item.attempts === task.attempts);
        if (!row) return false;
        row.status = 'done';
        row.item = structuredClone(result);
        await finalize(batches.get(row.batchId!)!, now);
        return true;
      },
      async cancelRequested(task) {
        return batches.get(task.batchId)?.cancelRequestedAt !== undefined;
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
function memoryStorage(): MemoryStorage {
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
  const registerBatch = (batchId: string) => {
    const batch = memoryBatch(batchId, put, read);
    batches.set(batchId, batch);
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
    async createBatch() { return registerBatch(randomUUID()); },
    openBatch: open,
    registerBatch,
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

/**
 * 内存中的一个批次，与 PostgreSQL 后端相同：文件按 SHA-256 存进本租户的内容（同一租户内相同字节只存一份，跨批次也是），
 * 各项在一处登记，"批次加项序号"唯一；批次清单只发布一次。
 */
function memoryBatch(batchId: string, put: (bytes: Uint8Array) => string, read: (sha256: string) => Uint8Array): TenantBatch {
  const location = `batches/${batchId}`;
  const itemLocation = (index: number) => `${location}/${itemDirectory(index)}`;
  const items = new Map<number, { completion?: 'record.json' | 'preview.json'; files: Map<string, string> }>();
  let manifest: string | undefined;
  const source: BatchSource = {
    location,
    itemLocation,
    manifest: async () => (manifest ? read(manifest) : undefined),
    items: async () => [...items.keys()].sort((a, b) => a - b),
    async completion(index) {
      const item = items.get(index);
      return item?.completion ? { name: item.completion, bytes: read(item.files.get(item.completion)!) } : undefined;
    },
  };
  return {
    batchId,
    source,
    output: {
      location: itemLocation,
      async write(index, contents) {
        const files = new Map<string, string>();
        for (const [name, bytes] of contents.files) files.set(name, put(bytes));
        if (contents.manifest) files.set(contents.manifest.name, put(manifestBytes(contents.manifest.value)));
        if (items.has(index)) throw new Error(`第 ${itemDirectory(index)} 项已有成果，不能覆盖`);
        items.set(index, { ...(contents.manifest ? { completion: contents.manifest.name } : {}), files });
      },
      available: async () => true,
      async finish(value) {
        if (manifest) throw new Error('批次清单已发布，不能覆盖');
        manifest = put(manifestBytes(value));
      },
    },
    record: (index) => ({
      location: itemLocation(index),
      async read(file) {
        const sha256 = items.get(index)?.files.get(file);
        if (!sha256) throw new Error(`记录文件不存在：${file}`);
        return read(sha256);
      },
    }),
    async itemFiles(index) {
      const item = items.get(index);
      return item && [...item.files.keys()];
    },
  };
}
