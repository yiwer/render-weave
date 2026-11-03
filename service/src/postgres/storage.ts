/**
 * 一个租户的存储（ADR-0018、ADR-0019）：工作区文档、版本化资源仓库与出图记录，实现引擎的三处存储接口。
 * 对象键与查询条件都由句柄生成，客户端不能提交键或路径；每条查询都在 withTenant 里执行，行级安全再挡一道。
 * 每类写入都先写对象、再在一个数据库事务里登记；没登记的对象不会被任何读者看到。
 */
import {
  APPROVAL_SCOPES, documentSource, parseDocumentSource, PublishRequestDecided,
  type ApprovalPolicy, type ApprovalScope, type AuthoringState, type DefinitionDraft, type PublishRequest, type PublishRequestApproval, type StoredDocument, type StoredTemplate, type TemplateRevision,
  type TemplateWorkingCopy, type TenantBatch, type TenantStorage,
} from '../backend.js';
import {
  itemDirectory, manifestBytes, resourceBackend,
  type BatchOutput, type BatchSource, type RecordSource, type ResourceManifestEntry, type ResourceVersionBackend, type WorkspaceDocumentSource,
} from '../engine.js';
import { sha256Hex, type BlobStore } from './blobs.js';
import { isUniqueViolation, withTenant, type Db, type DbClient } from './db.js';
import { recordRounds, settleItem } from './metering.js';

export function tenantStorage(db: Db, blobs: BlobStore, tenantId: string): TenantStorage {
  return {
    async putDocuments(documents) {
      const stored: { source: string; sha256: string; byteLength: number }[] = [];
      for (const { source, bytes } of documents) stored.push({ source, sha256: await blobs.put(tenantId, bytes), byteLength: bytes.length });
      await withTenant(db, tenantId, async (client) => {
        for (const { source, sha256, byteLength } of stored) {
          await client.query(`INSERT INTO workspace_documents (tenant_id, source, sha256, byte_length) VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, source) DO UPDATE SET sha256 = EXCLUDED.sha256, byte_length = EXCLUDED.byte_length, created_at = now()`,
          [tenantId, source, sha256, byteLength]);
        }
      });
    },
    documents: workspaceDocuments(db, blobs, tenantId),
    resources: resourceStore(db, blobs, tenantId),
    guardedResources: (guard) => resourceStore(db, blobs, tenantId, guard),
    async createBatch() {
      const { batch_id: batchId } = await withTenant(db, tenantId, async (client) =>
        (await client.query<{ batch_id: string }>('INSERT INTO batches (tenant_id) VALUES ($1) RETURNING batch_id', [tenantId])).rows[0]!);
      return batchStore(db, blobs, tenantId, batchId);
    },
    openBatch: (batchId) => batchStore(db, blobs, tenantId, batchId),
    contents: {
      put: (bytes) => blobs.put(tenantId, bytes),
      has: (sha256) => blobs.has(tenantId, sha256),
      get: async (sha256) => ((await blobs.has(tenantId, sha256)) ? blobs.get(tenantId, sha256) : undefined),
    },
    authoringState: () => withTenant(db, tenantId, (client) => authoringState(client, tenantId)),
    // 推送与资源提交锁住租户的同一行，依次进行；prepare 抛错即整个事务回滚。
    push: (prepare, { pushedBy, now, approving }) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const writes = await prepare(await authoringState(client, tenantId));
      await approveRequest(client, tenantId, approving);
      // 批准生效的修订算网页一侧（M354）：内容与主体还是推送的，当前修订的来历是批准的人。
      const currentSource = approving ? 'web' : 'push', currentBy = approving?.by ?? pushedBy;
      for (const document of writes.documents) {
        await client.query('INSERT INTO workspace_documents (tenant_id, source, sha256, byte_length) VALUES ($1, $2, $3, $4)',
          [tenantId, documentSource(document.kind, document.key), document.sha256, document.byteLength]);
      }
      const revisions = new Map<string, number>();
      for (const { name, sha256, byteLength } of writes.templates) {
        const { next } = (await client.query<{ next: number }>(
          'SELECT coalesce(max(revision), 0) + 1 AS next FROM template_revisions WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows[0]!;
        await client.query(`INSERT INTO template_revisions (tenant_id, name, revision, sha256, byte_length, pushed_by, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tenantId, name, next, sha256, byteLength, pushedBy, now]);
        await client.query(`INSERT INTO templates (tenant_id, name, current_revision, current_source, current_action, current_by, current_at) VALUES ($1, $2, $3, $6, 'revision', $4, $5)
          ON CONFLICT (tenant_id, name) DO UPDATE SET current_revision = EXCLUDED.current_revision, current_source = EXCLUDED.current_source, current_action = 'revision',
            current_by = EXCLUDED.current_by, current_at = EXCLUDED.current_at`, [tenantId, name, next, currentBy, now, currentSource]);
        await pointTemplate(client, tenantId, name, { sha256, byteLength });
        revisions.set(name, next);
      }
      for (const { id, kind, create, versions } of writes.resources) {
        if (create) await client.query('INSERT INTO resources (tenant_id, resource_id, kind) VALUES ($1, $2, $3)', [tenantId, id, kind]);
        for (const content of versions) {
          await client.query('INSERT INTO resource_versions (tenant_id, resource_id, version, sha256, byte_length) VALUES ($1, $2, $3, $4, $5)',
            [tenantId, id, content.version, content.sha256, content.byteLength]);
        }
      }
      const recordedRounds = await recordRounds(client, tenantId, writes.rounds ?? [], now);
      return { state: await authoringState(client, tenantId), revisions, recordedRounds };
    }),
    async saveDataset(id, bytes, mode) {
      const sha256 = await blobs.put(tenantId, bytes), source = documentSource('dataset', id);
      return withTenant(db, tenantId, async (client) => {
        await lockTenant(client, tenantId);
        const exists = (await client.query('SELECT 1 FROM workspace_documents WHERE tenant_id = $1 AND source = $2', [tenantId, source])).rowCount === 1;
        if (exists !== (mode === 'update')) return undefined;
        await client.query(`INSERT INTO workspace_documents (tenant_id, source, sha256, byte_length) VALUES ($1, $2, $3, $4)
          ON CONFLICT (tenant_id, source) DO UPDATE SET sha256 = EXCLUDED.sha256, byte_length = EXCLUDED.byte_length, created_at = now()`,
        [tenantId, source, sha256, bytes.length]);
        return { kind: 'dataset' as const, key: id, sha256, byteLength: bytes.length };
      });
    },
    setCurrentTemplate: (name, revision, { source, by, now, expectedCurrent, approving }) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [found] = (await client.query<{ sha256: string; byte_length: string }>(
        'SELECT sha256, byte_length FROM template_revisions WHERE tenant_id = $1 AND name = $2 AND revision = $3', [tenantId, name, revision])).rows;
      if (!found) return undefined;
      const [previous] = (await client.query<{ current_revision: number }>(
        'SELECT current_revision FROM templates WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;
      if (expectedCurrent !== undefined && previous!.current_revision !== expectedCurrent) return { moved: previous!.current_revision };
      await approveRequest(client, tenantId, approving);
      // 指向当前修订什么也不变，来历也不变：不能靠这一步把网页改动变成"代建工程师自己指回的"（M359）。
      if (revision !== previous!.current_revision) {
        await client.query(`UPDATE templates SET current_revision = $3, current_source = $4, current_action = 'setCurrent', current_by = $5, current_at = $6
          WHERE tenant_id = $1 AND name = $2`, [tenantId, name, revision, source, by, now]);
        await pointTemplate(client, tenantId, name, { sha256: found.sha256, byteLength: Number(found.byte_length) });
      }
      const template = (await authoringState(client, tenantId)).templates.find((item) => item.name === name)!;
      return { template, previousRevision: previous!.current_revision };
    }),
    definitionDrafts: () => withTenant(db, tenantId, async (client) =>
      (await client.query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM definition_drafts WHERE tenant_id = $1`, [tenantId])).rows.map(draftRow)),
    definitionDraft: (name) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<DraftRow>(`SELECT ${DRAFT_COLUMNS} FROM definition_drafts WHERE tenant_id = $1 AND name = $2`, [tenantId, name])).rows;
      return row && draftRow(row);
    }),
    async createDefinitionDraft({ name, baseVersion, bytes }, { updatedBy, now }) {
      const sha256 = await blobs.put(tenantId, bytes);
      return withTenant(db, tenantId, async (client) => {
        await lockTenant(client, tenantId);
        const [row] = (await client.query<DraftRow>(`INSERT INTO definition_drafts (tenant_id, name, base_version, sha256, byte_length, created_at, updated_at, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $6, $7) ON CONFLICT (tenant_id, name) DO NOTHING RETURNING ${DRAFT_COLUMNS}`,
        [tenantId, name, baseVersion ?? null, sha256, bytes.length, now, updatedBy])).rows;
        return row && draftRow(row);
      });
    },
    async saveDefinitionDraft(name, expectedSha256, bytes, { updatedBy, now }) {
      const sha256 = await blobs.put(tenantId, bytes);
      return withTenant(db, tenantId, async (client) => {
        await lockTenant(client, tenantId);
        const [current] = (await client.query<{ sha256: string }>('SELECT sha256 FROM definition_drafts WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;
        if (!current) return undefined;
        if (current.sha256 !== expectedSha256) return { stale: current.sha256 };
        const [row] = (await client.query<DraftRow>(`UPDATE definition_drafts SET sha256 = $3, byte_length = $4, updated_at = $5, updated_by = $6
          WHERE tenant_id = $1 AND name = $2 RETURNING ${DRAFT_COLUMNS}`, [tenantId, name, sha256, bytes.length, now, updatedBy])).rows;
        return { saved: draftRow(row!) };
      });
    },
    deleteDefinitionDraft: (name) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [row] = (await client.query<DraftRow>(`DELETE FROM definition_drafts WHERE tenant_id = $1 AND name = $2 RETURNING ${DRAFT_COLUMNS}`, [tenantId, name])).rows;
      return row && draftRow(row);
    }),
    templateWorkingCopies: () => withTenant(db, tenantId, async (client) =>
      (await client.query<CopyRow>(`SELECT ${COPY_COLUMNS} FROM template_working_copies WHERE tenant_id = $1`, [tenantId])).rows.map(copyRow)),
    templateWorkingCopy: (name) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<CopyRow>(`SELECT ${COPY_COLUMNS} FROM template_working_copies WHERE tenant_id = $1 AND name = $2`, [tenantId, name])).rows;
      return row && copyRow(row);
    }),
    async createTemplateWorkingCopy({ name, baseRevision, bytes }, { updatedBy, now }) {
      const sha256 = await blobs.put(tenantId, bytes);
      return withTenant(db, tenantId, async (client) => {
        await lockTenant(client, tenantId);
        const [row] = (await client.query<CopyRow>(`INSERT INTO template_working_copies (tenant_id, name, base_revision, sha256, byte_length, created_at, updated_at, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6, $6, $7) ON CONFLICT (tenant_id, name) DO NOTHING RETURNING ${COPY_COLUMNS}`,
        [tenantId, name, baseRevision ?? null, sha256, bytes.length, now, updatedBy])).rows;
        return row && copyRow(row);
      });
    },
    async saveTemplateWorkingCopy(name, expectedSha256, bytes, { updatedBy, now }) {
      const sha256 = await blobs.put(tenantId, bytes);
      return withTenant(db, tenantId, async (client) => {
        await lockTenant(client, tenantId);
        const [current] = (await client.query<{ sha256: string }>('SELECT sha256 FROM template_working_copies WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;
        if (!current) return undefined;
        if (current.sha256 !== expectedSha256) return { stale: current.sha256 };
        const [row] = (await client.query<CopyRow>(`UPDATE template_working_copies SET sha256 = $3, byte_length = $4, updated_at = $5, updated_by = $6
          WHERE tenant_id = $1 AND name = $2 RETURNING ${COPY_COLUMNS}`, [tenantId, name, sha256, bytes.length, now, updatedBy])).rows;
        return { saved: copyRow(row!) };
      });
    },
    deleteTemplateWorkingCopy: (name) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [row] = (await client.query<CopyRow>(`DELETE FROM template_working_copies WHERE tenant_id = $1 AND name = $2 RETURNING ${COPY_COLUMNS}`, [tenantId, name])).rows;
      return row && copyRow(row);
    }),
    commitTemplateWorkingCopy: (name, expectedSha256, { overwrite, pushedBy, now, expectedCurrent, approving }) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [copy] = (await client.query<{ base_revision: number | null; sha256: string; byte_length: string }>(
        'SELECT base_revision, sha256, byte_length FROM template_working_copies WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;
      if (!copy) return undefined;
      if (copy.sha256 !== expectedSha256) return { stale: copy.sha256 };
      const [current] = (await client.query<{ current_revision: number; sha256: string }>(`SELECT t.current_revision, r.sha256 FROM templates t
        JOIN template_revisions r ON r.tenant_id = t.tenant_id AND r.name = t.name AND r.revision = t.current_revision WHERE t.tenant_id = $1 AND t.name = $2`, [tenantId, name])).rows;
      if (current && (overwrite ? expectedCurrent !== undefined && current.current_revision !== expectedCurrent : copy.base_revision !== current.current_revision)) {
        return { conflict: { currentRevision: current.current_revision } };
      }
      await approveRequest(client, tenantId, approving);
      await client.query('DELETE FROM template_working_copies WHERE tenant_id = $1 AND name = $2', [tenantId, name]);
      if (current?.sha256 === copy.sha256) return { status: 'unchanged' as const, revision: current.current_revision, sha256: copy.sha256 };
      const { next } = (await client.query<{ next: number }>(
        'SELECT coalesce(max(revision), 0) + 1 AS next FROM template_revisions WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows[0]!;
      await client.query(`INSERT INTO template_revisions (tenant_id, name, revision, sha256, byte_length, pushed_by, created_at, source)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'web')`, [tenantId, name, next, copy.sha256, copy.byte_length, pushedBy, now]);
      await client.query(`INSERT INTO templates (tenant_id, name, current_revision, current_source, current_action, current_by, current_at) VALUES ($1, $2, $3, 'web', 'revision', $4, $5)
        ON CONFLICT (tenant_id, name) DO UPDATE SET current_revision = EXCLUDED.current_revision, current_source = 'web', current_action = 'revision',
          current_by = EXCLUDED.current_by, current_at = EXCLUDED.current_at`, [tenantId, name, next, approving?.by ?? pushedBy, now]);
      await pointTemplate(client, tenantId, name, { sha256: copy.sha256, byteLength: Number(copy.byte_length) });
      return { status: 'saved' as const, revision: next, sha256: copy.sha256 };
    }),
    publishDefinitionDraft: (name, expectedSha256, { key, definition, compiled }, approving) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [current] = (await client.query<{ sha256: string }>('SELECT sha256 FROM definition_drafts WHERE tenant_id = $1 AND name = $2', [tenantId, name])).rows;
      if (!current) return undefined;
      if (current.sha256 !== expectedSha256) return { stale: current.sha256 };
      const sources = [documentSource('definition', key), documentSource('compiled', key)];
      const occupied = await client.query('SELECT 1 FROM workspace_documents WHERE tenant_id = $1 AND source = ANY($2::text[])', [tenantId, sources]);
      if (occupied.rowCount) return { taken: true as const };
      await approveRequest(client, tenantId, approving);
      for (const [source, content] of [[sources[0]!, definition], [sources[1]!, compiled]] as const) {
        await client.query('INSERT INTO workspace_documents (tenant_id, source, sha256, byte_length) VALUES ($1, $2, $3, $4)', [tenantId, source, content.sha256, content.byteLength]);
      }
      await client.query('DELETE FROM definition_drafts WHERE tenant_id = $1 AND name = $2', [tenantId, name]);
      return { published: true as const };
    }),
    approvalPolicy: () => withTenant(db, tenantId, (client) => approvalPolicy(client, tenantId)),
    setApprovalPolicy: (changes, { updatedBy, now }) => withTenant(db, tenantId, async (client) => {
      for (const scope of APPROVAL_SCOPES) {
        const required = changes[scope];
        if (required === undefined) continue;
        await client.query(`INSERT INTO approval_policies (tenant_id, scope, required, updated_at, updated_by) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, scope) DO UPDATE SET required = EXCLUDED.required, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`, [tenantId, scope, required, now, updatedBy]);
      }
      return approvalPolicy(client, tenantId);
    }),
    publishRequests: ({ status, scope, limit }) => withTenant(db, tenantId, async (client) =>
      (await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM publish_requests
        WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR $3 = ANY(scopes)) ORDER BY requested_at DESC, id LIMIT $4`,
      [tenantId, status ?? null, scope ?? null, limit])).rows.map(requestRow)),
    publishRequest: (id) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM publish_requests WHERE tenant_id = $1 AND id = $2`, [tenantId, id])).rows;
      return row && requestRow(row);
    }),
    pendingPublishRequest: (kind, subject) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM publish_requests WHERE tenant_id = $1 AND kind = $2 AND subject = $3 AND status = 'pending'`, [tenantId, kind, subject])).rows;
      return row && requestRow(row);
    }),
    createPublishRequest: (request, now) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<RequestRow>(`INSERT INTO publish_requests
        (tenant_id, id, kind, subject, scopes, sha256, before_sha256, base_version, version, base_revision, revision, overwrite, diff, requested_by_kind, requested_by_id, requested_by_label, requested_at)
        VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (tenant_id, kind, subject) WHERE status = 'pending' DO NOTHING RETURNING ${REQUEST_COLUMNS}`,
      [tenantId, request.kind, request.subject, request.scopes, request.sha256, request.beforeSha256 ?? null, request.baseVersion ?? null, request.version ?? null,
        request.baseRevision ?? null, request.revision ?? null, request.overwrite ?? false, JSON.stringify(request.diff),
        request.requestedBy.kind, request.requestedBy.id, request.requestedBy.label, now])).rows;
      return row && requestRow(row);
    }),
    settlePublishRequest: (id, { status, by, now, message }) => withTenant(db, tenantId, async (client) => {
      const [row] = (await client.query<RequestRow>(`UPDATE publish_requests SET status = $3, decided_by = $4, decided_at = $5, message = $6
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending' RETURNING ${REQUEST_COLUMNS}`, [tenantId, id, status, by, now, message])).rows;
      return row && requestRow(row);
    }),
  };
}

async function approvalPolicy(client: DbClient, tenantId: string): Promise<ApprovalPolicy> {
  const rows = new Map((await client.query<{ scope: ApprovalScope; required: boolean; updated_at: Date; updated_by: string }>(
    'SELECT scope, required, updated_at, updated_by FROM approval_policies WHERE tenant_id = $1', [tenantId])).rows.map((row) => [row.scope, row]));
  return Object.fromEntries(APPROVAL_SCOPES.map((scope) => {
    const row = rows.get(scope);
    return [scope, row ? { required: row.required, updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by } : { required: false }];
  })) as ApprovalPolicy;
}

/** 批准与内容在同一个事务里：申请已经不是待处理时抛错，整个事务回滚，什么也不写。 */
async function approveRequest(client: DbClient, tenantId: string, approving: PublishRequestApproval | undefined): Promise<void> {
  if (!approving) return;
  const updated = await client.query(`UPDATE publish_requests SET status = 'approved', decided_by = $3, decided_at = $4 WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [tenantId, approving.requestId, approving.by, approving.now]);
  if (!updated.rowCount) throw new PublishRequestDecided();
}

interface RequestRow {
  id: string; kind: PublishRequest['kind']; subject: string; scopes: ApprovalScope[]; status: PublishRequest['status']; sha256: string; before_sha256: string | null;
  base_version: number | null; version: number | null; base_revision: number | null; revision: number | null; overwrite: boolean; diff: PublishRequest['diff'];
  requested_by_kind: PublishRequest['requestedBy']['kind']; requested_by_id: string; requested_by_label: string; requested_at: Date; decided_by: string | null; decided_at: Date | null; message: string | null;
}
const REQUEST_COLUMNS = 'id, kind, subject, scopes, status, sha256, before_sha256, base_version, version, base_revision, revision, overwrite, diff, requested_by_kind, requested_by_id, requested_by_label, requested_at, decided_by, decided_at, message';
const requestRow = (row: RequestRow): PublishRequest => ({
  id: row.id, kind: row.kind, subject: row.subject, scopes: row.scopes, status: row.status, sha256: row.sha256, ...(row.before_sha256 === null ? {} : { beforeSha256: row.before_sha256 }),
  ...(row.base_version === null ? {} : { baseVersion: row.base_version }), ...(row.version === null ? {} : { version: row.version }),
  ...(row.base_revision === null ? {} : { baseRevision: row.base_revision }), ...(row.revision === null ? {} : { revision: row.revision }), ...(row.overwrite ? { overwrite: true } : {}),
  diff: row.diff, requestedBy: { kind: row.requested_by_kind, id: row.requested_by_id, label: row.requested_by_label }, requestedAt: new Date(row.requested_at).toISOString(),
  ...(row.decided_by === null ? {} : { decidedBy: row.decided_by }), ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at).toISOString() }), ...(row.message === null ? {} : { message: row.message }),
});

interface CopyRow { name: string; base_revision: number | null; sha256: string; byte_length: string; created_at: Date; updated_at: Date; updated_by: string }
const COPY_COLUMNS = 'name, base_revision, sha256, byte_length, created_at, updated_at, updated_by';
const copyRow = (row: CopyRow): TemplateWorkingCopy => ({
  name: row.name, ...(row.base_revision === null ? {} : { baseRevision: row.base_revision }), sha256: row.sha256, byteLength: Number(row.byte_length),
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by,
});

interface DraftRow { name: string; base_version: number | null; sha256: string; byte_length: string; created_at: Date; updated_at: Date; updated_by: string }
const DRAFT_COLUMNS = 'name, base_version, sha256, byte_length, created_at, updated_at, updated_by';
const draftRow = (row: DraftRow): DefinitionDraft => ({
  name: row.name, ...(row.base_version === null ? {} : { baseVersion: row.base_version }), sha256: row.sha256, byteLength: Number(row.byte_length),
  createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), updatedBy: row.updated_by,
});

/** 锁住租户的一行：资源提交、推送、改模板的当前修订、保存数据集与写草案依次进行（M260、M264、M270）。 */
async function lockTenant(client: DbClient, tenantId: string): Promise<void> {
  await client.query('INSERT INTO resource_stores (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [tenantId]);
  await client.query('SELECT tenant_id FROM resource_stores WHERE tenant_id = $1 FOR UPDATE', [tenantId]);
}

/** 工作区里模板那一行指向当前修订的内容，渲染读到的就是当前修订。 */
async function pointTemplate(client: DbClient, tenantId: string, name: string, content: { sha256: string; byteLength: number }): Promise<void> {
  await client.query(`INSERT INTO workspace_documents (tenant_id, source, sha256, byte_length) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, source) DO UPDATE SET sha256 = EXCLUDED.sha256, byte_length = EXCLUDED.byte_length, created_at = now()`,
  [tenantId, documentSource('template', name), content.sha256, content.byteLength]);
}

/** 推送看到的当前状态：来源是"种类:键"的文档、模板修订与资源。 */
async function authoringState(client: DbClient, tenantId: string): Promise<AuthoringState> {
  const documents = await storedDocuments(client, tenantId);
  const revisions = new Map<string, TemplateRevision[]>();
  for (const row of (await client.query<{ name: string; revision: number; sha256: string; byte_length: string; pushed_by: string; created_at: Date; source: TemplateRevision['source'] }>(
    'SELECT name, revision, sha256, byte_length, pushed_by, created_at, source FROM template_revisions WHERE tenant_id = $1 ORDER BY revision', [tenantId])).rows) {
    const list = revisions.get(row.name) ?? [];
    list.push({ revision: row.revision, sha256: row.sha256, byteLength: Number(row.byte_length), createdAt: new Date(row.created_at).toISOString(), pushedBy: row.pushed_by, source: row.source });
    revisions.set(row.name, list);
  }
  const templates = (await client.query<{ name: string; current_revision: number; current_source: 'push' | 'web'; current_action: 'revision' | 'setCurrent'; current_by: string | null; current_at: Date | null }>(
    'SELECT name, current_revision, current_source, current_action, current_by, current_at FROM templates WHERE tenant_id = $1', [tenantId])).rows.map((row): StoredTemplate => {
    const list = revisions.get(row.name) ?? [], revision = list.find((item) => item.revision === row.current_revision);
    return {
      name: row.name, currentRevision: row.current_revision, revisions: list,
      // 迁移 0013 之前的行没有记主体与时间：取当前修订自己的。
      current: { source: row.current_source, action: row.current_action, by: row.current_by ?? revision?.pushedBy ?? '', at: row.current_at ? new Date(row.current_at).toISOString() : revision?.createdAt ?? '' },
    };
  });
  const resources = (await resourceEntries(client, tenantId)).map((entry) => ({
    id: entry.id, kind: entry.kind, currentVersion: entry.currentVersion,
    versions: entry.versions.map(({ version, sha256, byteLength }) => ({ version, sha256, byteLength })),
  }));
  return { documents, templates, resources };
}

/** 工作区文档的登记：来源是"种类:键"的文档。 */
async function storedDocuments(client: DbClient, tenantId: string): Promise<StoredDocument[]> {
  return (await client.query<{ source: string; sha256: string; byte_length: string }>(
    'SELECT source, sha256, byte_length FROM workspace_documents WHERE tenant_id = $1', [tenantId])).rows.flatMap((row): StoredDocument[] => {
    const parsed = parseDocumentSource(row.source);
    return parsed ? [{ ...parsed, sha256: row.sha256, byteLength: Number(row.byte_length) }] : [];
  });
}

/** 工作区文档：引擎不核对文档字节，这里按登记的哈希核对。 */
function workspaceDocuments(db: Db, blobs: BlobStore, tenantId: string): WorkspaceDocumentSource {
  return {
    location: `tenants/${tenantId}/documents`,
    async list() {
      const rows = await withTenant(db, tenantId, async (client) => (await client.query<{ source: string; sha256: string; byte_length: string }>(
        'SELECT source, sha256, byte_length FROM workspace_documents WHERE tenant_id = $1', [tenantId])).rows);
      return rows.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)).map((row) => ({
        source: row.source,
        async read() {
          const bytes = await blobs.get(tenantId, row.sha256);
          if (bytes.length !== Number(row.byte_length) || sha256Hex(bytes) !== row.sha256) throw new Error(`文档内容与登记的哈希不符：${row.source}`);
          return bytes;
        },
      }));
    },
  };
}

/** 一条语句读出全部资源与内容版本，得到一致的清单快照。内容位置就是 SHA-256。 */
async function resourceEntries(client: DbClient, tenantId: string): Promise<ResourceManifestEntry[]> {
  const { rows } = await client.query<{ resource_id: string; kind: 'image' | 'font'; version: number; sha256: string; byte_length: string }>(
    `SELECT r.resource_id, r.kind, v.version, v.sha256, v.byte_length
       FROM resources r JOIN resource_versions v USING (tenant_id, resource_id)
      WHERE r.tenant_id = $1 ORDER BY r.resource_id, v.version`, [tenantId]);
  const entries = new Map<string, { id: string; kind: 'image' | 'font'; currentVersion: number; versions: ResourceManifestEntry['versions'][number][] }>();
  for (const row of rows) {
    const entry = entries.get(row.resource_id) ?? { id: row.resource_id, kind: row.kind, currentVersion: 0, versions: [] };
    entry.versions.push({ version: row.version, sha256: row.sha256, byteLength: Number(row.byte_length), file: row.sha256 });
    entry.currentVersion = row.version;
    entries.set(row.resource_id, entry);
  }
  return [...entries.values()];
}

/**
 * 版本化资源仓库（M260）：提交点是事务；同一租户的提交锁住 resource_stores 的一行依次进行，新清单只追加。
 * guard 在加锁之后、同一个事务里核对工作区文档的登记（替换资源，M152），不另占连接。
 */
function resourceStore(db: Db, blobs: BlobStore, tenantId: string, guard?: (documents: readonly StoredDocument[]) => void | Promise<void>): ResourceVersionBackend {
  return resourceBackend({
    location: `tenants/${tenantId}/resources`,
    async snapshot() {
      return { entries: await withTenant(db, tenantId, (client) => resourceEntries(client, tenantId)), load: (file) => blobs.get(tenantId, file) };
    },
    async place(bytes, sha256) {
      if (await blobs.put(tenantId, bytes) !== sha256) throw new Error('资源内容的哈希与引擎计算的不一致');
      return sha256;
    },
    commit: (apply) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      if (guard) await guard(await storedDocuments(client, tenantId));
      const before = await resourceEntries(client, tenantId);
      await persistAppended(client, tenantId, before, await apply(before));
    }),
  });
}

async function persistAppended(client: DbClient, tenantId: string, before: readonly ResourceManifestEntry[], after: readonly ResourceManifestEntry[]): Promise<void> {
  const previous = new Map(before.map((entry) => [entry.id, entry]));
  if (before.some((entry) => !after.some((next) => next.id === entry.id))) throw new Error('资源清单只能追加，不能删除资源');
  for (const entry of after) {
    const old = previous.get(entry.id);
    if (old && (old.kind !== entry.kind || old.versions.some((v, i) => JSON.stringify(v) !== JSON.stringify(entry.versions[i])))) {
      throw new Error(`资源清单只能追加，不能改动已有内容版本：${entry.id}`);
    }
    if (!old) await client.query('INSERT INTO resources (tenant_id, resource_id, kind) VALUES ($1, $2, $3)', [tenantId, entry.id, entry.kind]);
    for (const content of entry.versions.slice(old?.versions.length ?? 0)) {
      await client.query('INSERT INTO resource_versions (tenant_id, resource_id, version, sha256, byte_length) VALUES ($1, $2, $3, $4, $5)',
        [tenantId, entry.id, content.version, content.sha256, content.byteLength]);
    }
  }
}

/** 一个批次的成果去处与读取来源；各项成果在一个事务里登记，"批次加项序号"唯一（ADR-0019）。 */
function batchStore(db: Db, blobs: BlobStore, tenantId: string, batchId: string): TenantBatch {
  const location = `tenants/${tenantId}/batches/${batchId}`;
  const itemLocation = (index: number) => `${location}/${itemDirectory(index)}`;
  const query = <T extends Record<string, unknown>>(sql: string, values: unknown[]) =>
    withTenant(db, tenantId, async (client) => (await client.query<T>(sql, values)).rows);
  const fileHash = async (index: number, name: string) => (await query<{ sha256: string }>(
    'SELECT sha256 FROM batch_item_files WHERE tenant_id = $1 AND batch_id = $2 AND item_index = $3 AND name = $4',
    [tenantId, batchId, index, name]))[0]?.sha256;
  const output: BatchOutput = {
    location: itemLocation,
    async write(index, contents) {
      const files = new Map(contents.files);
      if (contents.manifest) files.set(contents.manifest.name, manifestBytes(contents.manifest.value));
      const stored: { name: string; sha256: string; byteLength: number }[] = [];
      for (const [name, bytes] of files) stored.push({ name, sha256: await blobs.put(tenantId, bytes), byteLength: bytes.length });
      await withTenant(db, tenantId, async (client) => {
        try {
          await client.query('INSERT INTO batch_items (tenant_id, batch_id, item_index, completion) VALUES ($1, $2, $3, $4)',
            [tenantId, batchId, index, contents.manifest?.name ?? null]);
        } catch (error) {
          if (isUniqueViolation(error)) throw new Error(`第 ${itemDirectory(index)} 项已有成果，不能覆盖`);
          throw error;
        }
        for (const { name, sha256, byteLength } of stored) {
          await client.query('INSERT INTO batch_item_files (tenant_id, batch_id, item_index, name, sha256, byte_length) VALUES ($1, $2, $3, $4, $5, $6)',
            [tenantId, batchId, index, name, sha256, byteLength]);
        }
        // 登记与结算同一个事务（ADR-0020）：交付成功与计费要么都发生，要么都不发生。
        await settleItem(client, tenantId, batchId, index, contents.manifest?.name === 'record.json');
      });
    },
    async available() {
      try { await db.query('SELECT 1'); } catch { return false; }
      return blobs.available();
    },
    async finish(manifest) {
      const sha256 = await blobs.put(tenantId, manifestBytes(manifest));
      const updated = await withTenant(db, tenantId, (client) => client.query(
        'UPDATE batches SET manifest_sha256 = $3, finished_at = now() WHERE tenant_id = $1 AND batch_id = $2 AND manifest_sha256 IS NULL',
        [tenantId, batchId, sha256]));
      if (updated.rowCount !== 1) throw new Error('批次不存在或批次清单已发布，不能覆盖');
    },
  };
  const source: BatchSource = {
    location,
    itemLocation,
    async manifest() {
      const [row] = await query<{ manifest_sha256: string | null }>('SELECT manifest_sha256 FROM batches WHERE tenant_id = $1 AND batch_id = $2', [tenantId, batchId]);
      if (!row) throw new Error(`批次不存在：${batchId}`);
      return row.manifest_sha256 ? blobs.get(tenantId, row.manifest_sha256) : undefined;
    },
    async items() {
      return (await query<{ item_index: number }>('SELECT item_index FROM batch_items WHERE tenant_id = $1 AND batch_id = $2 ORDER BY item_index',
        [tenantId, batchId])).map((row) => row.item_index);
    },
    async completion(index) {
      const [row] = await query<{ completion: 'record.json' | 'preview.json' | null }>(
        'SELECT completion FROM batch_items WHERE tenant_id = $1 AND batch_id = $2 AND item_index = $3', [tenantId, batchId, index]);
      if (!row?.completion) return undefined;
      const sha256 = await fileHash(index, row.completion);
      if (!sha256) throw new Error(`第 ${itemDirectory(index)} 项缺少完成清单`);
      return { name: row.completion, bytes: await blobs.get(tenantId, sha256) };
    },
  };
  const record = (index: number): RecordSource => ({
    location: itemLocation(index),
    async read(file) {
      const sha256 = await fileHash(index, file);
      if (!sha256) throw new Error(`记录文件不存在：${file}`);
      return blobs.get(tenantId, sha256);
    },
  });
  return {
    batchId, output, source, record,
    async manifestSha256() {
      return (await query<{ manifest_sha256: string | null }>('SELECT manifest_sha256 FROM batches WHERE tenant_id = $1 AND batch_id = $2', [tenantId, batchId]))[0]?.manifest_sha256 ?? undefined;
    },
    async itemFiles(index) {
      return withTenant(db, tenantId, async (client) => {
        if (!(await client.query('SELECT 1 FROM batch_items WHERE tenant_id = $1 AND batch_id = $2 AND item_index = $3', [tenantId, batchId, index])).rowCount) return undefined;
        return (await client.query<{ name: string; sha256: string; byte_length: string }>(
          'SELECT name, sha256, byte_length FROM batch_item_files WHERE tenant_id = $1 AND batch_id = $2 AND item_index = $3 ORDER BY name COLLATE "C"',
          [tenantId, batchId, index])).rows.map((row) => ({ name: row.name, sha256: row.sha256, byteLength: Number(row.byte_length) }));
      });
    },
  };
}
