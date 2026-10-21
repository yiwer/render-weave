/**
 * webhook 的 PostgreSQL 实现（票据 11，迁移 0008）：注册与停用、批次结束时记事件与投递、投递任务的领取与记录。
 * 租户的操作都在 withTenant 里；领取是跨租户的，经属主身份执行的 rw_claim_webhook_deliveries。
 */
import { randomUUID } from 'node:crypto';
import {
  MAX_ACTIVE_WEBHOOKS, type BatchState, type ClaimedDelivery, type TenantScope, type Webhook, type WebhookAttempt, type WebhookDelivery,
  type WebhookEventType, type WebhookOutbox,
} from '../backend.js';
import { batchFinishedEvent } from '../batches.js';
import { withTenant, type Db, type DbClient } from './db.js';

const iso = (value: Date | null | undefined) => (value ? new Date(value).toISOString() : undefined);

interface WebhookRow { id: string; url: string; description: string | null; events: WebhookEventType[]; secret_prefix: string; active: boolean; created_at: Date; disabled_at: Date | null }
const COLUMNS = 'id, url, description, events, secret_prefix, active, created_at, disabled_at';
const webhookOf = (row: WebhookRow): Webhook => ({
  id: row.id, url: row.url, ...(row.description === null ? {} : { description: row.description }), events: row.events, secretPrefix: row.secret_prefix,
  active: row.active, createdAt: iso(row.created_at)!, ...(row.disabled_at ? { disabledAt: iso(row.disabled_at)! } : {}),
});

/** 同一租户的注册与重新启用依次进行，启用数的上限才准。 */
async function lockWebhooks(client: DbClient, tenantId: string): Promise<number> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('webhooks:' || $1, 0))`, [tenantId]);
  return Number((await client.query<{ active: string }>('SELECT count(*) AS active FROM webhooks WHERE tenant_id = $1 AND active', [tenantId])).rows[0]!.active);
}

/** 批次结束：与发布批次清单同一个事务，给启用、订阅了批次结束的每个 webhook 记一条投递。没有这样的 webhook 就不记事件。 */
export async function enqueueBatchFinished(client: DbClient, tenantId: string, state: BatchState, now: Date): Promise<void> {
  const hooks = (await client.query<{ id: string }>(`SELECT id FROM webhooks WHERE tenant_id = $1 AND active AND 'batch.finished' = ANY (events) ORDER BY created_at, id`,
    [tenantId])).rows;
  if (!hooks.length) return;
  const eventId = randomUUID();
  const inserted = await client.query(`INSERT INTO webhook_events (tenant_id, id, type, batch_id, body, created_at) VALUES ($1, $2, 'batch.finished', $3, $4, $5)
    ON CONFLICT (tenant_id, batch_id, type) DO NOTHING`, [tenantId, eventId, state.batchId, batchFinishedEvent({ id: eventId, tenantId, createdAt: now }, state), now]);
  if (inserted.rowCount !== 1) return;
  await client.query(`INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, next_attempt_at, created_at)
    SELECT $1, hook, $2, $3, $3 FROM unnest($4::uuid[]) AS hook`, [tenantId, eventId, now, hooks.map((hook) => hook.id)]);
}

type WebhookMethods = Pick<TenantScope, 'createWebhook' | 'listWebhooks' | 'getWebhook' | 'updateWebhook' | 'listWebhookDeliveries'>;

export function tenantWebhooks(db: Db, tenantId: string): WebhookMethods {
  const run = <T>(work: (client: DbClient) => Promise<T>) => withTenant(db, tenantId, work);
  return {
    createWebhook: (webhook, now) => run(async (client) => {
      if ((await lockWebhooks(client, tenantId)) >= MAX_ACTIVE_WEBHOOKS) return { limitReached: true } as const;
      return webhookOf((await client.query<WebhookRow>(`INSERT INTO webhooks (tenant_id, url, description, events, secret_sealed, secret_prefix, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
      [tenantId, webhook.url, webhook.description ?? null, webhook.events, webhook.secretSealed, webhook.secretPrefix, now])).rows[0]!);
    }),
    listWebhooks: () => run(async (client) =>
      (await client.query<WebhookRow>(`SELECT ${COLUMNS} FROM webhooks WHERE tenant_id = $1 ORDER BY created_at, id`, [tenantId])).rows.map(webhookOf)),
    getWebhook: (id) => run(async (client) => {
      const row = (await client.query<WebhookRow>(`SELECT ${COLUMNS} FROM webhooks WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows[0];
      return row && webhookOf(row);
    }),
    updateWebhook: (id, change, now) => run(async (client) => {
      const active = await lockWebhooks(client, tenantId);
      const current = (await client.query<WebhookRow>(`SELECT ${COLUMNS} FROM webhooks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id])).rows[0];
      if (!current) return undefined;
      if (change.active === true && !current.active && active >= MAX_ACTIVE_WEBHOOKS) return { limitReached: true } as const;
      const enabled = change.active ?? current.active;
      return webhookOf((await client.query<WebhookRow>(`UPDATE webhooks SET active = $3, description = $4,
          disabled_at = CASE WHEN $3 THEN NULL WHEN active THEN $5 ELSE disabled_at END
        WHERE tenant_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
      [tenantId, id, enabled, change.description ?? current.description, now])).rows[0]!);
    }),
    listWebhookDeliveries: (webhookId, { limit, before }) => run(async (client) => (await client.query<{
      id: string; webhook_id: string; event_id: string; type: WebhookEventType; batch_id: string; status: WebhookDelivery['status'];
      created_at: Date; next_attempt_at: Date | null; finished_at: Date | null;
      attempts: { attempt: number; at: string; duration_ms: number; status_code: number | null; error: string | null }[];
    }>(`SELECT d.id, d.webhook_id, d.event_id, e.type, e.batch_id, d.status, d.created_at, d.next_attempt_at, d.finished_at,
          coalesce((SELECT json_agg(json_build_object('attempt', a.attempt, 'at', a.at, 'duration_ms', a.duration_ms, 'status_code', a.status_code, 'error', a.error)
                                    ORDER BY a.attempt) FROM webhook_attempts a WHERE a.tenant_id = d.tenant_id AND a.delivery_id = d.id), '[]') AS attempts
        FROM webhook_deliveries d JOIN webhook_events e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
       WHERE d.tenant_id = $1 AND d.webhook_id = $2 AND ($3::bigint IS NULL OR d.id < $3::bigint)
       ORDER BY d.id DESC LIMIT $4`, [tenantId, webhookId, before ?? null, limit])).rows.map((row): WebhookDelivery => ({
      id: row.id, webhookId: row.webhook_id, eventId: row.event_id, eventType: row.type, batchId: row.batch_id, status: row.status,
      createdAt: iso(row.created_at)!, ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at)! } : {}),
      ...(row.finished_at ? { finishedAt: iso(row.finished_at)! } : {}),
      attempts: row.attempts.map((attempt) => ({
        attempt: attempt.attempt, at: new Date(attempt.at).toISOString(), durationMs: attempt.duration_ms,
        ...(attempt.status_code === null ? {} : { statusCode: attempt.status_code }), ...(attempt.error === null ? {} : { error: attempt.error }),
      })),
    }))),
  };
}

export function webhookOutbox(db: Db): WebhookOutbox {
  return {
    claim: async (now, leaseUntil, limit) => (await db.query<{
      id: string; tenant_id: string; webhook_id: string; url: string; secret_sealed: string; event_id: string; event_type: WebhookEventType; body: string; attempts: number;
    }>('SELECT * FROM rw_claim_webhook_deliveries($1, $2, $3)', [now, leaseUntil, limit])).rows.map((row): ClaimedDelivery => ({
      id: row.id, tenantId: row.tenant_id, webhookId: row.webhook_id, url: row.url, secretSealed: row.secret_sealed,
      eventId: row.event_id, eventType: row.event_type, body: row.body, attempts: row.attempts,
    })),
    record: (delivery, attempt: WebhookAttempt, outcome) => withTenant(db, delivery.tenantId, async (client) => {
      const finished = outcome.status === 'pending' ? null : new Date(attempt.at);
      const updated = await client.query(`UPDATE webhook_deliveries SET attempts = attempts + 1, status = $4, next_attempt_at = $5, finished_at = $6, lease_until = NULL
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending' AND attempts = $3`,
      [delivery.tenantId, delivery.id, delivery.attempts, outcome.status, outcome.status === 'pending' ? outcome.nextAttemptAt : null, finished]);
      if (updated.rowCount !== 1) return false;
      await client.query(`INSERT INTO webhook_attempts (delivery_id, tenant_id, attempt, at, duration_ms, status_code, error) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [delivery.id, delivery.tenantId, attempt.attempt, attempt.at, attempt.durationMs, attempt.statusCode ?? null, attempt.error ?? null]);
      return true;
    }),
  };
}
