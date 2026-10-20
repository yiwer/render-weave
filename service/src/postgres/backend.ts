/**
 * PostgreSQL 加 S3 后端（ADR-0018）：租户句柄的每条查询都在 withTenant 里执行，平台级操作在 asPlatform 里执行；
 * 按邮箱登录与按令牌解析身份调用属主身份执行的函数（迁移 0002）。
 */
import {
  EmailTakenError,
  type ApiKeyInfo, type AuditEvent, type AuthoringTokenInfo, type Identity, type Member, type MemberRole, type NewAuditEvent,
  type Readiness, type ServiceBackend, type TaskResult, type TaskState, type Tenant, type TenantScope,
} from '../backend.js';
import type { BlobStore } from './blobs.js';
import { asPlatform, isUniqueViolation, withTenant, type Db, type DbClient } from './db.js';
import { checkMigrations, type Migration } from './migrate.js';
import { tenantStorage } from './storage.js';

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : undefined);
const tenantRow = (row: { id: string; name: string; created_at: Date }): Tenant => ({ id: row.id, name: row.name, createdAt: iso(row.created_at)! });
const memberRow = (row: { id: string; tenant_id: string; email: string; role: MemberRole; active: boolean; created_at: Date }): Member =>
  ({ id: row.id, tenantId: row.tenant_id, email: row.email, role: row.role, active: row.active, createdAt: iso(row.created_at)! });
const keyRow = (row: { id: string; name: string; prefix: string; created_at: Date; revoked_at: Date | null }): ApiKeyInfo =>
  ({ id: row.id, name: row.name, prefix: row.prefix, createdAt: iso(row.created_at)!, ...(row.revoked_at ? { revokedAt: iso(row.revoked_at)! } : {}) });
const MEMBER_COLUMNS = 'id, tenant_id, email, role, active, created_at';

async function insertAudit(client: DbClient, tenantId: string | null, event: NewAuditEvent, now: Date): Promise<void> {
  await client.query(`INSERT INTO audit_events (tenant_id, at, actor_kind, actor_id, actor_label, action, object_type, object_id, cross_tenant)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [tenantId, now, event.actor.kind, event.actor.id, event.actor.label, event.action, event.object.type, event.object.id, event.crossTenant]);
}

export function createPostgresBackend(options: { readonly db: Db; readonly blobs: BlobStore; readonly migrations: readonly Migration[] }): ServiceBackend {
  const { db, blobs, migrations } = options;

  const tenant = (tenantId: string): TenantScope => {
    const run = <T>(work: (client: DbClient) => Promise<T>) => withTenant(db, tenantId, work);
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
      storage: tenantStorage(db, blobs, tenantId),
      tasks: {
        // 同一租户的入队依次进行，并发与频率的计数才准。
        enqueuePreview: (request, quota, now) => run(async (client) => {
          await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('preview:' || $1, 0))`, [tenantId]);
          const { active, recent } = (await client.query<{ active: string; recent: string }>(
            `SELECT count(*) FILTER (WHERE status IN ('queued', 'running') AND created_at > $3) AS active, count(*) FILTER (WHERE created_at > $4) AS recent
               FROM render_tasks WHERE tenant_id = $1 AND kind = $2`,
            [tenantId, 'preview', new Date(now.getTime() - quota.staleAfterMs), new Date(now.getTime() - 60_000)])).rows[0]!;
          if (Number(active) >= quota.concurrency) return { limited: 'concurrency' as const };
          if (Number(recent) >= quota.perMinute) return { limited: 'rate' as const };
          const { id } = (await client.query<{ id: string }>(
            `INSERT INTO render_tasks (tenant_id, kind, request, status, created_at) VALUES ($1, 'preview', $2, 'queued', $3) RETURNING id`,
            [tenantId, JSON.stringify(request), now])).rows[0]!;
          return { id };
        }),
        state: (id) => run(async (client) => {
          const row = (await client.query<{ status: TaskState['status']; result: { problems: TaskResult['problems']; layout?: TaskResult['layout']; image?: Omit<NonNullable<TaskResult['image']>, 'bytes'> } | null; image: Buffer | null }>(
            'SELECT status, result, image FROM render_tasks WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0];
          if (!row) return undefined;
          if (row.status !== 'done') return { status: row.status } as TaskState;
          const { image, ...rest } = row.result!;
          return { status: 'done', result: { ...rest, ...(image && row.image ? { image: { ...image, bytes: new Uint8Array(row.image) } } : {}) } };
        }),
        release: (id) => run(async (client) => {
          await client.query(`UPDATE render_tasks SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END, image = NULL,
              result = CASE WHEN result IS NULL THEN NULL ELSE jsonb_build_object('problems', result->'problems') END
            WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
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
      async claim(worker, now) {
        const row = (await db.query<{ id: string; tenant_id: string; kind: 'preview'; request: unknown }>('SELECT * FROM rw_claim_task($1, $2)', [worker, now])).rows[0];
        return row && { id: row.id, tenantId: row.tenant_id, kind: row.kind, request: row.request };
      },
      finish: (task, result, now) => withTenant(db, task.tenantId, async (client) => {
        const { image, ...rest } = result;
        const meta = image ? { format: image.format, widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi } : undefined;
        await client.query(`UPDATE render_tasks SET status = 'done', finished_at = $3, result = $4, image = $5 WHERE tenant_id = $1 AND id = $2 AND status = 'running'`,
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
    },
  };
}
