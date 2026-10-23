/**
 * 内存后端：与 PostgreSQL 加 S3 后端语义相同，供 npm test 里的 API 用例使用（阶段 4 PRD「接缝」）。
 * 每个租户的数据按租户 ID 分开存放，租户句柄只能看到自己那一份。
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  DEFAULT_PLAN, documentSource, EmailTakenError, MAX_ACTIVE_WEBHOOKS, parseDocumentSource, periodOf, TOKEN_KINDS,
  type ApiKeyInfo, type AuditEvent, type AuthoringState, type AuthoringTokenInfo, type BatchState, type Identity, type ItemResult, type LoginRecord, type Member,
  type MemberRole, type NewAuditEvent, type Plan, type PlatformUser, type PreviewQuota, type RecordCursor, type RecordEntry, type RegisteredFile,
  type ReleasedReservation, type ReplayResult, type RoundUsageEntry, type ServiceBackend, type StoredDocument, type StoredTemplate, type TaskResult,
  type TemplateRevision, type Tenant, type TenantBatch, type TenantScope, type TenantStorage, type TokenKind, type UsageEvent,
  type ClaimedDelivery, type Webhook, type WebhookAttempt, type WebhookDelivery, type WebhookEventType,
} from './backend.js';
import { batchFinishedEvent, batchManifest, NOT_STARTED, notRunItem } from './batches.js';
import { itemDirectory, manifestBytes, memoryWorkspaceDocuments, resourceBackend, type BatchSource, type RenderMode, type ResourceManifestEntry } from './engine.js';
import { backlogOf } from './tasks.js';

interface UserRow { id: string; tenantId: string | null; email: string; role: MemberRole | 'platformAdmin'; passwordHash: string; active: boolean; createdAt: string }
interface SessionRow { id: string; userId: string; tenantId: string | null; tokenHash: string; expiresAt: Date; revokedAt?: Date }
interface ApiKeyRow extends ApiKeyInfo { tenantId: string; tokenHash: string }
interface AuthoringRow extends AuthoringTokenInfo { tokenHash: string }
interface TaskRow {
  id: string; tenantId: string; kind: 'preview' | 'batchItem' | 'replay'; request: unknown; status: 'queued' | 'running' | 'done' | 'cancelled';
  result?: TaskResult; item?: ItemResult; replay?: ReplayResult; createdAt: Date; sequence: number;
  /** 批次项：所属批次、项序号与标识、接受它的构建、租约与领取次数。 */
  batchId?: string; index?: number; itemId?: string; build?: string; leaseUntil?: Date; attempts: number;
  /** 最近一次领取与写回的时间（对账看批次有没有动静）。 */
  startedAt?: Date; finishedAt?: Date;
}
interface BatchRow {
  tenantId: string; batchId: string; snapshot: string; build: string; template: string; mode: RenderMode; idempotencyKey?: string; requestSha256: string;
  createdAt: Date; cancelRequestedAt?: Date; finishedAt?: Date; manifest?: NonNullable<BatchState['manifest']>;
  /** 计费周期与剩余预占（票据 09）。 */
  period: string; reserved: number;
}
/** webhook（票据 11）：另存加密的签名密钥。 */
type WebhookRow = { -readonly [K in keyof Webhook]: Webhook[K] } & { tenantId: string; secretSealed: string };
/** 一个事件对一个 webhook 的投递：事件正文、租约与各次尝试。 */
interface DeliveryRow {
  id: string; tenantId: string; webhookId: string; eventId: string; eventType: WebhookEventType; batchId: string; body: string;
  status: WebhookDelivery['status']; createdAt: Date; nextAttemptAt?: Date; finishedAt?: Date; leaseUntil?: Date; attempts: WebhookAttempt[];
}
/** 当期计数：限额、已用与预占。 */
interface CounterRow { limit: number; used: number; reserved: number }
/** 计量的钩子：登记一项时结算，推送时记代建轮次（与 PostgreSQL 后端在同一个事务里做相同）。 */
interface MeteringHooks {
  settle(batchId: string, index: number, delivered: boolean): void;
  recordRounds(rounds: readonly RoundUsageEntry[], now: Date): string[];
}
/** 内存中的批次另外提供各项的登记时间与完成清单（查询出图记录用）。 */
type MemoryBatch = TenantBatch & { registration(index: number): { readonly at: Date; readonly completion?: string } | undefined };
/** 内存存储另外提供：按批次 ID 建批次的成果去处（接口进程建批次时用），以及按批次 ID 取内存中的批次。 */
type MemoryStorage = TenantStorage & { registerBatch(batchId: string): MemoryBatch; memoryBatch(batchId: string): MemoryBatch };

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
  /** 在线的 worker：最近一次报到的时间与构建。 */
  const workers = new Map<string, { build: string; seenAt: Date }>();
  /** 套餐、当期计数（租户|周期）与用量事件（追加写入）。 */
  const plans = new Map<string, Plan>();
  const counters = new Map<string, CounterRow>();
  const usageEvents: (UsageEvent & { tenantId: string })[] = [];
  /** webhook、已记事件的批次（每个批次只记一次）与投递。 */
  const webhooks: WebhookRow[] = [];
  const eventBatches = new Set<string>();
  const deliveries: DeliveryRow[] = [];
  let sequence = 0, taskSequence = 0, usageSequence = 0, deliverySequence = 0;
  const webhookOf = ({ tenantId: _t, secretSealed: _s, ...webhook }: WebhookRow): Webhook => structuredClone(webhook);
  const planOf = (tenantId: string) => plans.get(tenantId) ?? DEFAULT_PLAN;
  const counter = (tenantId: string, period: string) => {
    const key = `${tenantId}|${period}`;
    let row = counters.get(key);
    if (!row) counters.set(key, row = { limit: planOf(tenantId).monthlyImages, used: 0, reserved: 0 });
    return row;
  };
  /** 退回批次的预占：count 项，或剩下的全部；不超过批次剩余的预占。 */
  const release = (row: BatchRow, count: number | 'all') => {
    const released = count === 'all' ? row.reserved : Math.min(count, row.reserved);
    if (released <= 0) return;
    row.reserved -= released;
    const current = counter(row.tenantId, row.period);
    current.reserved = Math.max(current.reserved - released, 0);
  };
  const meteringOf = (tenantId: string): MeteringHooks => ({
    settle(batchId, index, delivered) {
      const row = batches.get(batchId);
      if (row?.tenantId !== tenantId) return;
      release(row, 1);
      if (!delivered) return;
      counter(tenantId, row.period).used++;
      usageEvents.push({ tenantId, id: String(++usageSequence), at: new Date().toISOString(), period: row.period, kind: 'image', quantity: 1, batchId, index });
    },
    recordRounds(rounds, now) {
      const recorded: string[] = [];
      for (const round of rounds) {
        let added = false;
        for (const kind of TOKEN_KINDS) {
          const quantity = round.tokens[kind];
          if (!quantity || usageEvents.some((event) => event.tenantId === tenantId && event.round?.sha256 === round.sha256 && event.kind === kind)) continue;
          usageEvents.push({ tenantId, id: String(++usageSequence), at: now.toISOString(), period: periodOf(now), kind, quantity,
            round: { sha256: round.sha256, task: round.task, round: round.round } });
          added = true;
        }
        if (added) recorded.push(round.sha256);
      }
      return recorded;
    },
  });
  const storageOf = (tenantId: string) => {
    let storage = storages.get(tenantId);
    if (!storage) storages.set(tenantId, storage = memoryStorage(meteringOf(tenantId)));
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
    // 批次结束时退回剩下的预占（ADR-0020）。
    release(row, 'all');
    // 批次结束的 webhook 事件（票据 11）：给启用、订阅了它的每个 webhook 各记一条投递；每个批次只记一次。
    const hooks = webhooks.filter((hook) => hook.tenantId === row.tenantId && hook.active && hook.events.includes('batch.finished'));
    if (hooks.length && !eventBatches.has(row.batchId)) {
      eventBatches.add(row.batchId);
      const eventId = randomUUID(), body = batchFinishedEvent({ id: eventId, tenantId: row.tenantId, createdAt: now }, batchState(row));
      for (const hook of hooks) {
        deliveries.push({ id: String(++deliverySequence), tenantId: row.tenantId, webhookId: hook.id, eventId, eventType: 'batch.finished', batchId: row.batchId, body,
          status: 'pending', createdAt: now, nextAttemptAt: now, attempts: [] });
      }
    }
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
    /** 预览与重放入队：并发与频率按种类各算各的。 */
    const enqueue = (kind: 'preview' | 'replay', request: unknown, quota: PreviewQuota, now: Date, build?: string) => {
      const same = tasks.filter((task) => own(task) && task.kind === kind);
      const active = (task: TaskRow) => (task.status === 'queued' || task.status === 'running') && task.createdAt.getTime() > now.getTime() - quota.staleAfterMs;
      if (same.filter(active).length >= quota.concurrency) return { limited: 'concurrency' as const };
      if (same.filter((task) => task.createdAt.getTime() > now.getTime() - 60_000).length >= quota.perMinute) return { limited: 'rate' as const };
      const row: TaskRow = { id: randomUUID(), tenantId, kind, request: structuredClone(request), status: 'queued', createdAt: now, sequence: ++taskSequence, attempts: 0,
        ...(build === undefined ? {} : { build }) };
      tasks.push(row);
      return { id: row.id };
    };
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
      plan: async () => planOf(tenantId),
      async setPlan(plan, now) {
        plans.set(tenantId, { ...plan });
        const current = counters.get(`${tenantId}|${periodOf(now)}`);
        if (current) current.limit = plan.monthlyImages;
      },
      async usage(period) {
        const row = counters.get(`${tenantId}|${period}`);
        const tokens = Object.fromEntries(TOKEN_KINDS.map((kind) => [kind, 0])) as Record<TokenKind, number>;
        for (const event of usageEvents) if (event.tenantId === tenantId && event.period === period && event.kind !== 'image') tokens[event.kind] += event.quantity;
        return { period, limit: row?.limit ?? planOf(tenantId).monthlyImages, used: row?.used ?? 0, reserved: row?.reserved ?? 0, tokens };
      },
      async listUsageEvents({ period, kind, before, limit }) {
        return usageEvents.filter((event) => event.tenantId === tenantId && event.period === period && (!kind || event.kind === kind) && (!before || Number(event.id) < Number(before)))
          .reverse().slice(0, limit).map(({ tenantId: _t, ...event }) => structuredClone(event));
      },
      async createWebhook(webhook, now) {
        if (webhooks.filter((hook) => own(hook) && hook.active).length >= MAX_ACTIVE_WEBHOOKS) return { limitReached: true };
        const row: WebhookRow = { tenantId, id: randomUUID(), url: webhook.url, ...(webhook.description === undefined ? {} : { description: webhook.description }),
          events: [...webhook.events], secretSealed: webhook.secretSealed, secretPrefix: webhook.secretPrefix, active: true, createdAt: now.toISOString() };
        webhooks.push(row);
        return webhookOf(row);
      },
      listWebhooks: async () => webhooks.filter(own).map(webhookOf),
      getWebhook: async (id) => { const row = webhooks.find((hook) => hook.id === id && own(hook)); return row && webhookOf(row); },
      async updateWebhook(id, change, now) {
        const row = webhooks.find((hook) => hook.id === id && own(hook));
        if (!row) return undefined;
        if (change.active === true && !row.active && webhooks.filter((hook) => own(hook) && hook.active).length >= MAX_ACTIVE_WEBHOOKS) return { limitReached: true };
        if (change.description !== undefined) row.description = change.description;
        if (change.active === true && !row.active) { row.active = true; delete row.disabledAt; }
        if (change.active === false && row.active) { row.active = false; row.disabledAt = now.toISOString(); }
        return webhookOf(row);
      },
      async listWebhookDeliveries(webhookId, { limit, before }) {
        return deliveries.filter((row) => own(row) && row.webhookId === webhookId && (!before || Number(row.id) < Number(before))).reverse().slice(0, limit)
          .map((row): WebhookDelivery => ({
            id: row.id, webhookId: row.webhookId, eventId: row.eventId, eventType: row.eventType, batchId: row.batchId, status: row.status,
            createdAt: row.createdAt.toISOString(), ...(row.nextAttemptAt ? { nextAttemptAt: row.nextAttemptAt.toISOString() } : {}),
            ...(row.finishedAt ? { finishedAt: row.finishedAt.toISOString() } : {}), attempts: structuredClone(row.attempts),
          }));
      },
      get storage() { return storageOf(tenantId); },
      tasks: {
        enqueuePreview: async (request, quota, now) => enqueue('preview', request, quota, now),
        enqueueReplay: async ({ batchId, index, build }, quota, now) => enqueue('replay', { batchId, index }, quota, now, build),
        async replayState(id) {
          const row = tasks.find((task) => task.id === id && own(task) && task.kind === 'replay');
          if (!row) return undefined;
          return row.status === 'done' ? { status: 'done', result: structuredClone(row.replay!) } : { status: row.status };
        },
        async listRecords({ batchId, template, from, to, before, limit }) {
          const storage = storageOf(tenantId);
          const found: (RecordEntry & { cursor: RecordCursor })[] = [];
          for (const row of batches.values()) {
            if (row.tenantId !== tenantId || (batchId && row.batchId !== batchId) || (template !== undefined && row.template !== template)) continue;
            const batch = storage.memoryBatch(row.batchId);
            for (const task of batchItems(row.batchId)) {
              const registered = batch.registration(task.index!);
              if (registered?.completion !== 'record.json' || (from && registered.at < from) || (to && registered.at >= to)) continue;
              const image = (await batch.itemFiles(task.index!))!.find((file) => file.name.startsWith('image.'))!.name;
              const at = registered.at.toISOString();
              found.push({ batchId: row.batchId, index: task.index!, id: task.itemId!, template: row.template, build: row.build, deliveredAt: at, image,
                cursor: { at, batchId: row.batchId, index: task.index! } });
            }
          }
          // 按登记时间、批次与项序号倒序；ISO 时间与定长的项序号按字符串比较就是按时间与数值比较。
          const key = (cursor: RecordCursor) => `${cursor.at} ${cursor.batchId} ${String(cursor.index).padStart(4, '0')}`;
          return found.filter((entry) => !before || key(entry.cursor) < key(before))
            .sort((a, b) => (key(a.cursor) < key(b.cursor) ? 1 : -1)).slice(0, limit);
        },
        async state(id) {
          const row = tasks.find((task) => task.id === id && own(task));
          if (!row) return undefined;
          return row.status === 'done' ? { status: 'done', result: row.result! } : { status: row.status };
        },
        async release(id) {
          const row = tasks.find((task) => task.id === id && own(task) && (task.kind === 'preview' || task.kind === 'replay'));
          if (row?.status === 'queued') row.status = 'cancelled';
          else if (row?.status === 'done' && row.result) row.result = { problems: row.result.problems };
        },
        async createBatch(batch, now) {
          const existing = batch.idempotencyKey === undefined ? undefined
            : [...batches.values()].find((row) => row.tenantId === tenantId && row.idempotencyKey === batch.idempotencyKey);
          if (existing) return { batch: batchState(existing), created: false };
          // 预占（ADR-0020）：已用 + 预占 + 本批项数超过限额时整批不建。
          const period = periodOf(now), current = counter(tenantId, period), requested = batch.items.length;
          if (current.used + current.reserved + requested > current.limit) return { shortfall: { period, ...current, requested } };
          current.reserved += requested;
          const row: BatchRow = { tenantId, batchId: randomUUID(), snapshot: batch.snapshot, build: batch.build, template: batch.template, mode: batch.mode,
            ...(batch.idempotencyKey === undefined ? {} : { idempotencyKey: batch.idempotencyKey }), requestSha256: batch.requestSha256, createdAt: now,
            period, reserved: requested };
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
            task.finishedAt = now;
            task.item = notRunItem(task.index!, task.itemId!, NOT_STARTED);
            // 未执行的项退回预占。
            release(row, 1);
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
    webhooks: {
      async claim(now, leaseUntil, limit) {
        const active = (row: DeliveryRow) => webhooks.some((hook) => hook.id === row.webhookId && hook.active);
        return deliveries.filter((row) => row.status === 'pending' && row.nextAttemptAt! <= now && (!row.leaseUntil || row.leaseUntil < now) && active(row))
          .sort((a, b) => a.nextAttemptAt!.getTime() - b.nextAttemptAt!.getTime() || Number(a.id) - Number(b.id)).slice(0, limit)
          .map((row): ClaimedDelivery => {
            row.leaseUntil = leaseUntil;
            const hook = webhooks.find((candidate) => candidate.id === row.webhookId)!;
            return { id: row.id, tenantId: row.tenantId, webhookId: row.webhookId, url: hook.url, secretSealed: hook.secretSealed, eventId: row.eventId,
              eventType: row.eventType, body: row.body, attempts: row.attempts.length };
          });
      },
      async record(delivery, attempt, outcome) {
        const row = deliveries.find((candidate) => candidate.id === delivery.id && candidate.tenantId === delivery.tenantId);
        if (!row || row.status !== 'pending' || row.attempts.length !== delivery.attempts) return false;
        row.attempts.push(structuredClone(attempt));
        row.status = outcome.status;
        delete row.leaseUntil;
        if (outcome.status === 'pending') row.nextAttemptAt = outcome.nextAttemptAt;
        else { delete row.nextAttemptAt; row.finishedAt = new Date(attempt.at); }
        return true;
      },
    },
    queue: {
      async claim(_worker, now, { build, leaseMs, previews }) {
        // 预览没有项序号，排在批次项前面；批次项按项序号轮转，再按入队先后。过了租约还在渲染中的批次项可以由同构建的 worker 重领。
        const claimable = (task: TaskRow) => task.kind === 'preview' ? previews && task.status === 'queued'
          : task.kind === 'replay' ? previews && task.status === 'queued' && task.build === build
            : task.build === build && (task.status === 'queued' || (task.status === 'running' && task.leaseUntil! < now));
        const row = tasks.filter(claimable).sort((a, b) =>
          (a.index ?? 0) - (b.index ?? 0) ||
          a.createdAt.getTime() - b.createdAt.getTime() || a.sequence - b.sequence)[0];
        if (!row) return undefined;
        row.status = 'running';
        row.attempts++;
        row.startedAt = now;
        if (row.kind === 'preview') return { id: row.id, tenantId: row.tenantId, kind: 'preview', request: structuredClone(row.request) };
        if (row.kind === 'replay') {
          const { batchId, index } = row.request as { batchId: string; index: number };
          return { id: row.id, tenantId: row.tenantId, kind: 'replay', batchId, index };
        }
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
      async finishReplay(task, result) {
        const row = tasks.find((item) => item.id === task.id && item.status === 'running');
        if (!row) return;
        row.status = 'done';
        row.replay = structuredClone(result);
      },
      async finishItem(task, result, now) {
        const row = tasks.find((item) => item.id === task.id && item.status === 'running' && item.attempts === task.attempts);
        if (!row) return false;
        row.status = 'done';
        row.finishedAt = now;
        row.item = structuredClone(result);
        const batch = batches.get(row.batchId!)!;
        // 没登记就结束的项在这里退回预占；登记了的已在登记时结算。
        if (!storageOf(batch.tenantId).memoryBatch(batch.batchId).registration(row.index!)) release(batch, 1);
        await finalize(batch, now);
        return true;
      },
      async cancelRequested(task) {
        return batches.get(task.batchId)?.cancelRequestedAt !== undefined;
      },
      async backlog(now) {
        return backlogOf(tasks.flatMap((task) => task.status === 'queued' || task.status === 'running'
          ? [{ kind: task.kind, status: task.status, tasks: 1, oldest: task.createdAt }] : []), now);
      },
      async purge(before) {
        const kept = tasks.filter((task) => task.kind === 'batchItem' || task.createdAt >= before);
        const removed = tasks.length - kept.length;
        tasks.splice(0, tasks.length, ...kept);
        return removed;
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
      async recordBuilds() {
        const builds = new Map<string, { records: number; last: Date }>();
        for (const row of batches.values()) {
          const batch = storageOf(row.tenantId).memoryBatch(row.batchId);
          for (const task of batchItems(row.batchId)) {
            const registered = batch.registration(task.index!);
            if (registered?.completion !== 'record.json') continue;
            const entry = builds.get(row.build) ?? { records: 0, last: registered.at };
            builds.set(row.build, { records: entry.records + 1, last: registered.at > entry.last ? registered.at : entry.last });
          }
        }
        return [...builds].sort(([a], [b]) => (a < b ? -1 : 1)).map(([build, { records, last }]) => ({ build, records, lastDeliveredAt: last.toISOString() }));
      },
    },
    async reconcileReservations({ onlineSince, idleBefore }) {
      const released: ReleasedReservation[] = [];
      for (const row of batches.values()) {
        if (row.reserved <= 0) continue;
        const online = [...workers.values()].some((worker) => worker.build === row.build && worker.seenAt >= onlineSince);
        const busy = row.createdAt >= idleBefore || batchItems(row.batchId).some((task) =>
          (task.startedAt !== undefined && task.startedAt >= idleBefore) || (task.finishedAt !== undefined && task.finishedAt >= idleBefore));
        if (!row.finishedAt && (online || busy)) continue;
        released.push({ tenantId: row.tenantId, batchId: row.batchId, released: row.reserved });
        release(row, 'all');
      }
      return released.sort((a, b) => (`${a.tenantId}${a.batchId}` < `${b.tenantId}${b.batchId}` ? -1 : 1));
    },
    workers: {
      async heartbeat(worker, build, now) { workers.set(worker, { build, seenAt: now }); },
      async leave(worker) { workers.delete(worker); },
      async online(since) {
        const counts = new Map<string, number>();
        for (const { build, seenAt } of workers.values()) if (seenAt >= since) counts.set(build, (counts.get(build) ?? 0) + 1);
        return counts;
      },
    },
  };
}

/** 一个租户的工作区文档、模板修订、资源仓库与批次，全在内存里。 */
function memoryStorage(metering: MeteringHooks): MemoryStorage {
  /** 本租户的全部内容，按 SHA-256 存放：工作区文档、模板修订、资源内容版本，以及已上传还没登记的内容。 */
  const contents = new Map<string, Uint8Array>();
  /** 工作区文档：来源 → 内容。推送进来的文档来源是"种类:键"，模板那一行指向当前修订。 */
  const documents = new Map<string, { sha256: string; byteLength: number }>();
  const templates = new Map<string, { current: number; revisions: TemplateRevision[] }>();
  let resources: readonly ResourceManifestEntry[] = [];
  const batches = new Map<string, MemoryBatch>();
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
  /** 资源仓库；guard 在提交的同一段独占里先核对工作区文档。 */
  const resourcesGuardedBy = (guard?: (documents: readonly StoredDocument[]) => void | Promise<void>) => resourceBackend({
    location: 'memory',
    snapshot: async () => ({ entries: structuredClone(resources), load: async (file) => read(file) }),
    place: async (bytes) => put(bytes),
    commit: (apply) => exclusive(async () => {
      await guard?.(state().documents);
      resources = structuredClone(await apply(structuredClone(resources)));
    }),
  });
  const registerBatch = (batchId: string) => {
    const batch = memoryBatch(batchId, put, read, (index, delivered) => metering.settle(batchId, index, delivered));
    batches.set(batchId, batch);
    return batch;
  };
  return {
    async putDocuments(list) { for (const { source, bytes } of list) documents.set(source, { sha256: put(bytes), byteLength: bytes.length }); },
    documents: {
      location: 'memory',
      list: () => memoryWorkspaceDocuments([...documents].map(([source, { sha256 }]) => ({ source, bytes: read(sha256) }))).list(),
    },
    resources: resourcesGuardedBy(),
    guardedResources: resourcesGuardedBy,
    async createBatch() { return registerBatch(randomUUID()); },
    openBatch: open,
    registerBatch,
    memoryBatch: (batchId) => {
      const batch = batches.get(batchId);
      if (!batch) throw new Error(`批次不存在：${batchId}`);
      return batch;
    },
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
      return { state: state(), revisions, recordedRounds: metering.recordRounds(writes.rounds ?? [], now) };
    }),
    saveDataset: (id, bytes, mode) => exclusive(async () => {
      const source = documentSource('dataset', id);
      if (documents.has(source) !== (mode === 'update')) return undefined;
      const stored = { sha256: put(bytes), byteLength: bytes.length };
      documents.set(source, stored);
      return { kind: 'dataset' as const, key: id, ...stored };
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
function memoryBatch(batchId: string, put: (bytes: Uint8Array) => string, read: (sha256: string) => Uint8Array,
  settle: (index: number, delivered: boolean) => void): MemoryBatch {
  const location = `batches/${batchId}`;
  const itemLocation = (index: number) => `${location}/${itemDirectory(index)}`;
  const items = new Map<number, { completion?: 'record.json' | 'preview.json'; files: Map<string, RegisteredFile>; at: Date }>();
  let manifest: string | undefined;
  const source: BatchSource = {
    location,
    itemLocation,
    manifest: async () => (manifest ? read(manifest) : undefined),
    items: async () => [...items.keys()].sort((a, b) => a - b),
    async completion(index) {
      const item = items.get(index);
      return item?.completion ? { name: item.completion, bytes: read(item.files.get(item.completion)!.sha256) } : undefined;
    },
  };
  return {
    batchId,
    source,
    output: {
      location: itemLocation,
      async write(index, contents) {
        const files = new Map<string, RegisteredFile>();
        const add = (name: string, bytes: Uint8Array) => files.set(name, { name, sha256: put(bytes), byteLength: bytes.length });
        for (const [name, bytes] of contents.files) add(name, bytes);
        if (contents.manifest) add(contents.manifest.name, manifestBytes(contents.manifest.value));
        if (items.has(index)) throw new Error(`第 ${itemDirectory(index)} 项已有成果，不能覆盖`);
        items.set(index, { ...(contents.manifest ? { completion: contents.manifest.name } : {}), files, at: new Date() });
        // 登记与结算一起做（ADR-0020）。
        settle(index, contents.manifest?.name === 'record.json');
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
        const registered = items.get(index)?.files.get(file);
        if (!registered) throw new Error(`记录文件不存在：${file}`);
        return read(registered.sha256);
      },
    }),
    async itemFiles(index) {
      const item = items.get(index);
      return item && [...item.files.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
    },
    manifestSha256: async () => manifest,
    registration(index) {
      const item = items.get(index);
      return item && { at: item.at, ...(item.completion ? { completion: item.completion } : {}) };
    },
  };
}
