/**
 * PostgreSQL 加 S3 后端（ADR-0018）：租户句柄的每条查询都在 withTenant 里执行，平台级操作在 asPlatform 里执行；
 * 按邮箱登录与按令牌解析身份调用属主身份执行的函数（迁移 0002）。
 */
import {
  EmailTakenError, periodOf,
  type ApiKeyInfo, type AuditEvent, type AuthoringTokenInfo, type BatchState, type Identity, type ItemResult, type Member, type MemberRole, type NewAuditEvent,
  type PreviewQuota, type Readiness, type RecordCursor, type RecordEntry, type ReplayResult, type ReplayState, type ServiceBackend, type TaskCounts, type TaskResult, type TaskState,
  type Tenant, type TenantScope, type UsageEvent, type UsageKind,
} from '../backend.js';
import { batchManifest, NOT_STARTED, notRunItem } from '../batches.js';
import { manifestBytes, type RenderMode } from '../engine.js';
import { backlogOf } from '../tasks.js';
import type { BlobStore } from './blobs.js';
import { asPlatform, isUniqueViolation, withTenant, type Db, type DbClient } from './db.js';
import { lockCounter, readPlan, releaseReserved, usageCounts } from './metering.js';
import { checkMigrations, type Migration } from './migrate.js';
import { tenantStorage } from './storage.js';
import { enqueueBatchFinished, tenantWebhooks, webhookOutbox } from './webhooks.js';

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : undefined);
const tenantRow = (row: { id: string; name: string; created_at: Date }): Tenant => ({ id: row.id, name: row.name, createdAt: iso(row.created_at)! });
const memberRow = (row: { id: string; tenant_id: string; email: string; role: MemberRole; active: boolean; created_at: Date }): Member =>
  ({ id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role, active: row.active, createdAt: iso(row.created_at)! });
const keyRow = (row: { id: string; name: string; prefix: string; created_at: Date; revoked_at: Date | null }): ApiKeyInfo =>
  ({ id: row.id, name: row.name, prefix: row.prefix, createdAt: iso(row.created_at)!, ...(row.revoked_at ? { revokedAt: iso(row.revoked_at)! } : {}) });
const MEMBER_COLUMNS = 'id, tenant_id, email, role, active, created_at';

interface BatchRow {
  batch_id: string; build: string; template: string; mode: RenderMode; idempotency_key: string | null; request_sha256: string; created_at: Date;
  cancel_requested_at: Date | null; finished_at: Date | null; summary: NonNullable<BatchState['manifest']>['summary'] | null; problems: NonNullable<BatchState['manifest']>['problems'] | null;
}
const BATCH_COLUMNS = 'batch_id, build, template, mode, idempotency_key, request_sha256, created_at, cancel_requested_at, finished_at, summary, problems';

/** 批次与逐项状态；只认接口进程建的批次（有快照）。 */
async function batchState(client: DbClient, tenantId: string, where: { batchId: string } | { idempotencyKey: string }): Promise<BatchState | undefined> {
  const [row] = (await client.query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM batches WHERE tenant_id = $1 AND snapshot_sha256 IS NOT NULL AND
    ${'batchId' in where ? 'batch_id = $2::uuid' : 'idempotency_key = $2'}`,
  [tenantId, 'batchId' in where ? where.batchId : where.idempotencyKey])).rows;
  if (!row) return undefined;
  const items = (await client.query<{ item_index: number; id: string; status: string; result: ItemResult | null }>(
    `SELECT item_index, request->>'id' AS id, status, result FROM render_tasks WHERE tenant_id = $1 AND batch_id = $2 ORDER BY item_index`,
    [tenantId, row.batch_id])).rows;
  return {
    batchId: row.batch_id, build: row.build, template: row.template, mode: row.mode,
    ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }), requestSha256: row.request_sha256,
    createdAt: iso(row.created_at)!, ...(row.cancel_requested_at ? { cancelRequestedAt: iso(row.cancel_requested_at)! } : {}),
    ...(row.finished_at ? { finishedAt: iso(row.finished_at)! } : {}),
    items: items.map((item) => ({
      index: item.item_index, id: item.id, status: item.result ? 'ended' : item.status === 'running' ? 'running' : 'queued',
      ...(item.result ? { result: item.result } : {}),
    })),
    ...(row.summary && row.problems ? { manifest: { summary: row.summary, problems: row.problems } } : {}),
  };
}

/** 锁住批次行：同一批次的写回与取消依次进行，最后结束的那一项看得到其余各项的结果。批次不在时 false。 */
async function lockBatch(client: DbClient, tenantId: string, batchId: string): Promise<boolean> {
  return (await client.query('SELECT 1 FROM batches WHERE tenant_id = $1 AND batch_id = $2 AND snapshot_sha256 IS NOT NULL FOR NO KEY UPDATE',
    [tenantId, batchId])).rowCount === 1;
}

/**
 * 全部项都结束了就发布批次清单（batch.json），与写回最后一项或取消在同一个事务里；调用方已锁住批次行。
 * 先只数还没结束的项，最后一项才读全部结果，免得每写回一项都读一遍整批。
 */
async function finalizeBatch(client: DbClient, blobs: BlobStore, tenantId: string, batchId: string, now: Date): Promise<void> {
  const { open } = (await client.query<{ open: string }>(`SELECT count(*) AS open FROM render_tasks
    WHERE tenant_id = $1 AND batch_id = $2 AND status IN ('queued', 'running')`, [tenantId, batchId])).rows[0]!;
  if (Number(open) > 0) return;
  const state = (await batchState(client, tenantId, { batchId }))!;
  if (state.manifest || state.items.some((item) => !item.result)) return;
  const manifest = batchManifest({ build: state.build, template: state.template, mode: state.mode, cancelled: state.cancelRequestedAt !== undefined },
    state.items.map((item) => item.result!));
  const sha256 = await blobs.put(tenantId, manifestBytes(manifest));
  await client.query(`UPDATE batches SET manifest_sha256 = $3, finished_at = $4, summary = $5, problems = $6
    WHERE tenant_id = $1 AND batch_id = $2 AND manifest_sha256 IS NULL`,
  [tenantId, state.batchId, sha256, now, JSON.stringify(manifest.summary), JSON.stringify(manifest.problems)]);
  // 批次结束时退回剩下的预占（ADR-0020）。
  await releaseReserved(client, tenantId, state.batchId, 'all');
  // 批次结束的 webhook 事件（票据 11）：与批次清单同一个事务，每个批次只记一次。
  await enqueueBatchFinished(client, tenantId, { ...state, finishedAt: now.toISOString(), manifest: { summary: manifest.summary, problems: manifest.problems } }, now);
}

async function insertAudit(client: DbClient, tenantId: string | null, event: NewAuditEvent, now: Date): Promise<void> {
  await client.query(`INSERT INTO audit_events (tenant_id, at, actor_kind, actor_id, actor_label, action, object_type, object_id, cross_tenant)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [tenantId, now, event.actor.kind, event.actor.id, event.actor.label, event.action, event.object.type, event.object.id, event.crossTenant]);
}

export function createPostgresBackend(options: { readonly db: Db; readonly blobs: BlobStore; readonly migrations: readonly Migration[] }): ServiceBackend {
  const { db, blobs, migrations } = options;

  const tenant = (tenantId: string): TenantScope => {
    const run = <T>(work: (client: DbClient) => Promise<T>) => withTenant(db, tenantId, work);
    /** 预览与重放入队：同一租户同一种类的入队依次进行，并发与频率按种类各算各的，计数才准。 */
    const enqueue = (kind: 'preview' | 'replay', request: unknown, quota: PreviewQuota, now: Date, build?: string) => run(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($2 || ':' || $1, 0))`, [tenantId, kind]);
      const { active, recent } = (await client.query<{ active: string; recent: string }>(
        `SELECT count(*) FILTER (WHERE status IN ('queued', 'running') AND created_at > $3) AS active, count(*) FILTER (WHERE created_at > $4) AS recent
           FROM render_tasks WHERE tenant_id = $1 AND kind = $2`,
        [tenantId, kind, new Date(now.getTime() - quota.staleAfterMs), new Date(now.getTime() - 60_000)])).rows[0]!;
      if (Number(active) >= quota.concurrency) return { limited: 'concurrency' as const };
      if (Number(recent) >= quota.perMinute) return { limited: 'rate' as const };
      const { id } = (await client.query<{ id: string }>(
        `INSERT INTO render_tasks (tenant_id, kind, request, status, created_at, build) VALUES ($1, $2, $3, 'queued', $4, $5) RETURNING id`,
        [tenantId, kind, JSON.stringify(request), now, build ?? null])).rows[0]!;
      return { id };
    });
    return {
      tenantId,
      get: () => run(async (client) => {
        const row = (await client.query('SELECT id, name, created_at FROM tenants WHERE id = $1', [tenantId])).rows[0];
        return row && tenantRow(row);
      }),
      listMembers: () => run(async (client) =>
        (await client.query(`SELECT ${MEMBER_COLUMNS} FROM users WHERE tenant_id = $1 ORDER BY created_at, email`, [tenantId])).rows.map(memberRow)),
      getMember: (id) => run(async (client) => {
        const row = (await client.query(`SELECT ${MEMBER_COLUMNS} FROM users WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
        return row && memberRow(row);
      }),
      async createMember({ email, role, passwordHash }) {
        try {
          return await run(async (client) => memberRow((await client.query(
            `INSERT INTO users (tenant_id, email, role, password_hash) VALUES ($1, lower($2), $3, $4) RETURNING ${MEMBER_COLUMNS}`,
            [tenantId, email, role, passwordHash])).rows[0]));
        } catch (error) {
          if (isUniqueViolation(error)) throw new EmailTakenError(email);
          throw error;
        }
      },
      updateMember: (id, change) => run(async (client) => {
        const row = (await client.query(`UPDATE users SET role = coalesce($3, role), active = coalesce($4, active)
          WHERE tenant_id = $1 AND id = $2 RETURNING ${MEMBER_COLUMNS}`, [tenantId, id, change.role ?? null, change.active ?? null])).rows[0];
        return row && memberRow(row);
      }),
      setPassword: (id, passwordHash) => run(async (client) =>
        (await client.query('UPDATE users SET password_hash = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, id, passwordHash])).rowCount === 1),
      createSession: (userId, tokenHash, expiresAt) => run(async (client) => (await client.query<{ id: string }>(
        'INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id', [userId, tenantId, tokenHash, expiresAt])).rows[0]!.id),
      revokeSessionsOf: (userId, now) => run(async (client) => {
        await client.query('UPDATE sessions SET revoked_at = $3 WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL', [tenantId, userId, now]);
      }),
      createApiKey: ({ name, tokenHash, prefix }) => run(async (client) => keyRow((await client.query(
        'INSERT INTO api_keys (tenant_id, name, prefix, token_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, prefix, created_at, revoked_at',
        [tenantId, name, prefix, tokenHash])).rows[0])),
      listApiKeys: () => run(async (client) => (await client.query(
        'SELECT id, name, prefix, created_at, revoked_at FROM api_keys WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows.map(keyRow)),
      revokeApiKey: (id, now) => run(async (client) => {
        const found = await client.query('SELECT 1 FROM api_keys WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
        if (!found.rowCount) return false;
        await client.query('UPDATE api_keys SET revoked_at = $3 WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL', [tenantId, id, now]);
        return true;
      }),
      appendAudit: (event, now) => run((client) => insertAudit(client, tenantId, event, now)),
      listAudit: ({ limit, before }) => run(async (client) => (await client.query(
        `SELECT id, tenant_id, at, actor_kind, actor_id, actor_label, action, object_type, object_id, cross_tenant FROM audit_events
          WHERE tenant_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`, [tenantId, before ?? null, limit])).rows.map(
        (row): AuditEvent => ({ id: row.id, tenantId: row.tenant_id, at: iso(row.at)!, actor: { kind: row.actor_kind, id: row.actor_id, label: row.actor_label },
          action: row.action, object: { type: row.object_type, id: row.object_id }, crossTenant: row.cross_tenant }))),
      plan: () => run((client) => readPlan(client, tenantId)),
      setPlan: (plan, now) => run(async (client) => {
        await client.query(`INSERT INTO tenant_plans (tenant_id, monthly_images, max_pixels, concurrency, updated_at) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id) DO UPDATE SET monthly_images = EXCLUDED.monthly_images, max_pixels = EXCLUDED.max_pixels,
            concurrency = EXCLUDED.concurrency, updated_at = EXCLUDED.updated_at`, [tenantId, plan.monthlyImages, plan.maxPixels, plan.concurrency, now]);
        await client.query('UPDATE usage_counters SET image_limit = $3 WHERE tenant_id = $1 AND period = $2', [tenantId, periodOf(now), plan.monthlyImages]);
      }),
      usage: (period) => run((client) => usageCounts(client, tenantId, period)),
      listUsageEvents: ({ period, kind, before, limit }) => run(async (client) => (await client.query<{
        id: string; at: Date; period: string; kind: UsageKind; quantity: string; batch_id: string | null; item_index: number | null;
        round_sha256: string | null; round_task: string | null; round_number: number | null;
      }>(`SELECT id, at, period, kind, quantity, batch_id, item_index, round_sha256, round_task, round_number FROM usage_events
           WHERE tenant_id = $1 AND period = $2 AND ($3::text IS NULL OR kind = $3) AND ($4::bigint IS NULL OR id < $4::bigint)
           ORDER BY id DESC LIMIT $5`, [tenantId, period, kind ?? null, before ?? null, limit])).rows.map((row): UsageEvent => ({
        id: row.id, at: iso(row.at)!, period: row.period, kind: row.kind, quantity: Number(row.quantity),
        ...(row.batch_id === null ? {} : { batchId: row.batch_id, index: row.item_index! }),
        ...(row.round_sha256 === null ? {} : { round: { sha256: row.round_sha256, task: row.round_task!, round: row.round_number! } }),
      }))),
      ...tenantWebhooks(db, tenantId),
      storage: tenantStorage(db, blobs, tenantId),
      tasks: {
        enqueuePreview: (request, quota, now) => enqueue('preview', request, quota, now),
        enqueueReplay: ({ batchId, index, build }, quota, now) => enqueue('replay', { batchId, index }, quota, now, build),
        replayState: (id) => run(async (client) => {
          const row = (await client.query<{ status: ReplayState['status']; result: ReplayResult | null }>(
            `SELECT status, result FROM render_tasks WHERE tenant_id = $1 AND id = $2 AND kind = 'replay'`, [tenantId, id])).rows[0];
          if (!row) return undefined;
          return row.status === 'done' ? { status: 'done', result: row.result! } : { status: row.status } as ReplayState;
        }),
        listRecords: ({ batchId, template, from, to, before, limit }) => run(async (client) => (await client.query<{
          batch_id: string; item_index: number; id: string; template: string; build: string; at: string; delivered_at: Date; image: string;
        }>(`SELECT i.batch_id, i.item_index, t.request->>'id' AS id, b.template, b.build, i.created_at::text AS at, i.created_at AS delivered_at,
                   (SELECT f.name FROM batch_item_files f WHERE f.tenant_id = i.tenant_id AND f.batch_id = i.batch_id AND f.item_index = i.item_index
                       AND f.name IN ('image.png', 'image.jpg')) AS image
              FROM batch_items i
              JOIN batches b ON b.tenant_id = i.tenant_id AND b.batch_id = i.batch_id
              JOIN render_tasks t ON t.tenant_id = i.tenant_id AND t.batch_id = i.batch_id AND t.item_index = i.item_index AND t.kind = 'batchItem'
             WHERE i.tenant_id = $1 AND i.completion = 'record.json'
               AND ($2::uuid IS NULL OR i.batch_id = $2) AND ($3::text IS NULL OR b.template = $3)
               AND ($4::timestamptz IS NULL OR i.created_at >= $4) AND ($5::timestamptz IS NULL OR i.created_at < $5)
               AND ($6::timestamptz IS NULL OR (i.created_at, i.batch_id, i.item_index) < ($6::timestamptz, $7::uuid, $8::integer))
             ORDER BY i.created_at DESC, i.batch_id DESC, i.item_index DESC LIMIT $9`,
        [tenantId, batchId ?? null, template ?? null, from ?? null, to ?? null, before?.at ?? null, before?.batchId ?? null, before?.index ?? null, limit])).rows.map(
          (row): RecordEntry & { cursor: RecordCursor } => ({
            batchId: row.batch_id, index: row.item_index, id: row.id, template: row.template, build: row.build, deliveredAt: iso(row.delivered_at)!, image: row.image,
            cursor: { at: row.at, batchId: row.batch_id, index: row.item_index },
          }))),
        state: (id) => run(async (client) => {
          const row = (await client.query<{ status: TaskState['status']; result: { problems: TaskResult['problems']; layout?: TaskResult['layout']; image?: Omit<NonNullable<TaskResult['image']>, 'bytes'> } | null; image: Buffer | null }>(
            `SELECT status, result, image FROM render_tasks WHERE tenant_id = $1 AND id = $2 AND kind = 'preview'`, [tenantId, id])).rows[0];
          if (!row) return undefined;
          if (row.status !== 'done') return { status: row.status } as TaskState;
          const { image, ...rest } = row.result!;
          return { status: 'done', result: { ...rest, ...(image && row.image ? { image: { ...image, bytes: new Uint8Array(row.image) } } : {}) } };
        }),
        release: (id) => run(async (client) => {
          await client.query(`UPDATE render_tasks SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, image = NULL,
              result = CASE WHEN result IS NULL OR kind = 'replay' THEN result ELSE jsonb_build_object('problems', result->'problems') END
            WHERE tenant_id = $1 AND id = $2 AND kind IN ('preview', 'replay')`, [tenantId, id]);
        }),
        createBatch: (batch, now) => run(async (client) => {
          // 锁住当期计数行：同一租户的建批次依次进行，幂等键的查重与额度的检查都在锁里（ADR-0020）。
          const period = periodOf(now), counter = await lockCounter(client, tenantId, period), requested = batch.items.length;
          if (batch.idempotencyKey !== undefined) {
            const existing = await batchState(client, tenantId, { idempotencyKey: batch.idempotencyKey });
            if (existing) return { batch: existing, created: false };
          }
          if (counter.used + counter.reserved + requested > counter.limit) return { shortfall: { period, ...counter, requested } };
          const created = (await client.query<{ batch_id: string }>(
            `INSERT INTO batches (tenant_id, snapshot_sha256, build, template, mode, idempotency_key, request_sha256, created_at, period, reserved)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING batch_id`,
            [tenantId, batch.snapshot, batch.build, batch.template, batch.mode, batch.idempotencyKey ?? null, batch.requestSha256, now, period, requested])).rows[0];
          if (!created) return { batch: (await batchState(client, tenantId, { idempotencyKey: batch.idempotencyKey! }))!, created: false };
          await client.query('UPDATE usage_counters SET reserved = reserved + $3 WHERE tenant_id = $1 AND period = $2', [tenantId, period, requested]);
          await client.query(`INSERT INTO render_tasks (tenant_id, kind, request, status, created_at, batch_id, item_index, build)
            SELECT $1, 'batchItem', jsonb_build_object('snapshot', $2::text, 'id', item.id), 'queued', $3, $4, item.index, $5
              FROM jsonb_to_recordset($6::jsonb) AS item(index integer, id text)`,
          [tenantId, batch.snapshot, now, created.batch_id, batch.build, JSON.stringify(batch.items)]);
          return { batch: (await batchState(client, tenantId, { batchId: created.batch_id }))!, created: true };
        }),
        findBatch: (key) => run((client) => batchState(client, tenantId, { idempotencyKey: key })),
        batch: (batchId) => run((client) => batchState(client, tenantId, { batchId })),
        cancelBatch: (batchId, now) => run(async (client) => {
          if (!(await lockBatch(client, tenantId, batchId))) return undefined;
          const state = (await batchState(client, tenantId, { batchId }))!;
          if (state.manifest) return state;
          await client.query('UPDATE batches SET cancel_requested_at = coalesce(cancel_requested_at, $3) WHERE tenant_id = $1 AND batch_id = $2', [tenantId, batchId, now]);
          const queued = state.items.filter((item) => item.status === 'queued').map((item) => notRunItem(item.index, item.id, NOT_STARTED));
          const cancelled = await client.query(`UPDATE render_tasks t SET status = 'cancelled', finished_at = $3, result = item.result
              FROM jsonb_to_recordset($4::jsonb) AS item(index integer, result jsonb)
             WHERE t.tenant_id = $1 AND t.batch_id = $2 AND t.item_index = item.index AND t.status = 'queued'`,
          [tenantId, batchId, now, JSON.stringify(queued.map((result) => ({ index: result.index, result })))]);
          // 未执行的项退回预占。
          await releaseReserved(client, tenantId, batchId, cancelled.rowCount ?? 0);
          await finalizeBatch(client, blobs, tenantId, batchId, now);
          return batchState(client, tenantId, { batchId });
        }),
      },
    };
  };

  const tokenInfo = (row: { id: string; label: string; prefix: string; tenant_ids: string[]; created_at: Date; expires_at: Date; revoked_at: Date | null }): AuthoringTokenInfo =>
    ({ id: row.id, label: row.label, prefix: row.prefix, tenantIds: row.tenant_ids, createdAt: iso(row.created_at)!, expiresAt: iso(row.expires_at)!,
      ...(row.revoked_at ? { revokedAt: iso(row.revoked_at)! } : {}) });
  const TOKEN_SELECT = `SELECT a.id, a.label, a.prefix, a.created_at, a.expires_at, a.revoked_at,
    ARRAY(SELECT t.tenant_id FROM authoring_token_tenants t WHERE t.token_id = a.id ORDER BY t.tenant_id) AS tenant_ids FROM authoring_tokens a`;

  return {
    async readiness(): Promise<Readiness> {
      let database = 'ok', schema = 'ok', schemaVersion: number | undefined;
      try {
        await db.query('SELECT 1');
        const state = await checkMigrations(db, migrations);
        schemaVersion = state.version;
        if (state.problems.length) schema = state.problems.join('；');
        else if (state.pending.length) schema = `还有未执行的迁移：${state.pending.join('、')}`;
      } catch (error) {
        database = `数据库不可用：${(error as Error).message}`;
        schema = '未检查';
      }
      const storage = (await blobs.available()) ? 'ok' : '对象存储不可用';
      return { ready: database === 'ok' && schema === 'ok' && storage === 'ok', ...(schemaVersion === undefined ? {} : { schemaVersion }), checks: { database, migrations: schema, storage } };
    },
    tenant,
    queue: {
      async claim(worker, now, { build, leaseMs, previews }) {
        const row = (await db.query<{ id: string; tenant_id: string; kind: 'preview' | 'batchItem' | 'replay'; request: unknown; batch_id: string | null; item_index: number | null; attempts: number }>(
          'SELECT * FROM rw_claim_task($1, $2, $3, $4, $5)', [worker, now, build, new Date(now.getTime() + leaseMs), previews])).rows[0];
        if (!row) return undefined;
        if (row.kind === 'preview') return { id: row.id, tenantId: row.tenant_id, kind: 'preview', request: row.request };
        if (row.kind === 'replay') {
          const { batchId, index } = row.request as { batchId: string; index: number };
          return { id: row.id, tenantId: row.tenant_id, kind: 'replay', batchId, index };
        }
        const request = row.request as { snapshot: string; id: string };
        return { id: row.id, tenantId: row.tenant_id, kind: 'batchItem', batchId: row.batch_id!, index: row.item_index!, itemId: request.id, snapshot: request.snapshot, attempts: row.attempts };
      },
      finishItem: (task, result, now) => withTenant(db, task.tenantId, async (client) => {
        if (!(await lockBatch(client, task.tenantId, task.batchId))) return false;
        const updated = await client.query(`UPDATE render_tasks SET status = 'done', finished_at = $5, result = $6, lease_until = NULL
          WHERE tenant_id = $1 AND id = $2 AND batch_id = $3 AND status = 'running' AND attempts = $4`,
        [task.tenantId, task.id, task.batchId, task.attempts, now, JSON.stringify(result)]);
        if (updated.rowCount !== 1) return false;
        // 没登记就结束的项（未执行，或连问题清单都没写成）在这里退回预占；登记了的已在登记时结算。
        const registered = await client.query('SELECT 1 FROM batch_items WHERE tenant_id = $1 AND batch_id = $2 AND item_index = $3', [task.tenantId, task.batchId, task.index]);
        if (!registered.rowCount) await releaseReserved(client, task.tenantId, task.batchId, 1);
        await finalizeBatch(client, blobs, task.tenantId, task.batchId, now);
        return true;
      }),
      cancelRequested: (task) => withTenant(db, task.tenantId, async (client) => (await client.query<{ cancelled: boolean }>(
        'SELECT cancel_requested_at IS NOT NULL AS cancelled FROM batches WHERE tenant_id = $1 AND batch_id = $2', [task.tenantId, task.batchId])).rows[0]?.cancelled ?? false),
      finishReplay: (task, result, now) => withTenant(db, task.tenantId, async (client) => {
        await client.query(`UPDATE render_tasks SET status = 'done', finished_at = $3, result = $4 WHERE tenant_id = $1 AND id = $2 AND kind = 'replay' AND status = 'running'`,
          [task.tenantId, task.id, now, JSON.stringify(result)]);
      }),
      async backlog(now) {
        const rows = (await db.query<{ kind: keyof TaskCounts; status: 'queued' | 'running'; tasks: string; oldest: Date }>('SELECT * FROM rw_queue_backlog()')).rows;
        return backlogOf(rows.map((row) => ({ ...row, tasks: Number(row.tasks) })), now);
      },
      purge: async (before) => Number((await db.query<{ removed: string }>('SELECT rw_purge_tasks($1) AS removed', [before])).rows[0]!.removed),
      finish: (task, result, now) => withTenant(db, task.tenantId, async (client) => {
        const { image, ...rest } = result;
        const meta = image ? { format: image.format, widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi } : undefined;
        await client.query(`UPDATE render_tasks SET status = 'done', finished_at = $3, result = $4, image = $5 WHERE tenant_id = $1 AND id = $2 AND kind = 'preview' AND status = 'running'`,
          [task.tenantId, task.id, now, JSON.stringify({ ...rest, ...(meta ? { image: meta } : {}) }), image ? Buffer.from(image.bytes) : null]);
      }),
    },
    platform: {
      createTenant: (name) => asPlatform(db, async (client) =>
        tenantRow((await client.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at', [name])).rows[0])),
      listTenants: () => asPlatform(db, async (client) => (await client.query('SELECT id, name, created_at FROM tenants ORDER BY created_at')).rows.map(tenantRow)),
      async createPlatformUser(email, passwordHash) {
        try {
          return await asPlatform(db, async (client) => {
            const row = (await client.query(`INSERT INTO users (tenant_id, email, role, password_hash) VALUES (NULL, lower($1), 'platformAdmin', $2)
              RETURNING id, email, created_at`, [email, passwordHash])).rows[0];
            return { id: row.id, email: row.email, createdAt: iso(row.created_at)! };
          });
        } catch (error) {
          if (isUniqueViolation(error)) throw new EmailTakenError(email);
          throw error;
        }
      },
      async findLogin(email) {
        const row = (await db.query('SELECT * FROM rw_find_login($1)', [email])).rows[0];
        return row && { userId: row.user_id, tenantId: row.tenant_id, email: row.email, role: row.role, passwordHash: row.password_hash, active: row.active };
      },
      createSession: (userId, tokenHash, expiresAt) => asPlatform(db, async (client) => (await client.query<{ id: string }>(
        'INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at) VALUES ($1, NULL, $2, $3) RETURNING id', [userId, tokenHash, expiresAt])).rows[0]!.id),
      async resolveToken(tokenHash, now): Promise<Identity | undefined> {
        const row = (await db.query('SELECT * FROM rw_resolve_token($1, $2)', [tokenHash, now])).rows[0];
        if (!row) return undefined;
        switch (row.kind) {
          case 'member': return { kind: 'member', userId: row.user_id, tenantId: row.tenant_id, role: row.role, email: row.label, sessionId: row.id };
          case 'platformUser': return { kind: 'platformUser', userId: row.user_id, email: row.label, sessionId: row.id };
          case 'apiKey': return { kind: 'apiKey', keyId: row.id, tenantId: row.tenant_id, name: row.label };
          default: return { kind: 'authoringToken', tokenId: row.id, label: row.label, tenantIds: row.tenant_ids };
        }
      },
      revokeSession: (sessionId) => asPlatform(db, async (client) => {
        await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
      }),
      createAuthoringToken: ({ label, tokenHash, prefix, tenantIds, expiresAt }) => asPlatform(db, async (client) => {
        const { id } = (await client.query<{ id: string }>('INSERT INTO authoring_tokens (label, prefix, token_hash, expires_at) VALUES ($1, $2, $3, $4) RETURNING id',
          [label, prefix, tokenHash, expiresAt])).rows[0]!;
        for (const tenantId of tenantIds) await client.query('INSERT INTO authoring_token_tenants (token_id, tenant_id) VALUES ($1, $2)', [id, tenantId]);
        return tokenInfo((await client.query(`${TOKEN_SELECT} WHERE a.id = $1`, [id])).rows[0]);
      }),
      listAuthoringTokens: () => asPlatform(db, async (client) => (await client.query(`${TOKEN_SELECT} ORDER BY a.created_at`)).rows.map(tokenInfo)),
      revokeAuthoringToken: (id, now) => asPlatform(db, async (client) => {
        if (!(await client.query('SELECT 1 FROM authoring_tokens WHERE id = $1', [id])).rowCount) return false;
        await client.query('UPDATE authoring_tokens SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, now]);
        return true;
      }),
      appendAudit: (event, now) => asPlatform(db, (client) => insertAudit(client, null, event, now)),
      recordBuilds: async () => (await db.query<{ build: string; records: string; last_delivered_at: Date }>('SELECT * FROM rw_record_builds()')).rows.map(
        (row) => ({ build: row.build, records: Number(row.records), lastDeliveredAt: iso(row.last_delivered_at)! })),
    },
    reconcileReservations: async ({ onlineSince, idleBefore }) =>
      (await db.query<{ tenant_id: string; batch_id: string; released: number }>('SELECT * FROM rw_reconcile_reservations($1, $2)', [onlineSince, idleBefore])).rows.map(
        (row) => ({ tenantId: row.tenant_id, batchId: row.batch_id, released: row.released })),
    webhooks: webhookOutbox(db),
    workers: {
      async heartbeat(worker, build, now) { await db.query('SELECT rw_worker_heartbeat($1, $2, $3)', [worker, build, now]); },
      async leave(worker) { await db.query('SELECT rw_worker_leave($1)', [worker]); },
      async online(since) {
        return new Map((await db.query<{ build: string; workers: string }>('SELECT * FROM rw_online_workers($1)', [since])).rows.map((row) => [row.build, Number(row.workers)]));
      },
    },
  };
}
