/**
 * 一个租户的存储（ADR-0018、ADR-0019）：工作区文档、版本化资源仓库与出图记录，实现引擎的三处存储接口。
 * 对象键与查询条件都由句柄生成，客户端不能提交键或路径；每条查询都在 withTenant 里执行，行级安全再挡一道。
 * 每类写入都先写对象、再在一个数据库事务里登记；没登记的对象不会被任何读者看到。
 */
import {
  documentSource, parseDocumentSource,
  type AuthoringState, type StoredDocument, type StoredTemplate, type TemplateRevision, type TenantBatch, type TenantStorage,
} from '../backend.js';
import {
  itemDirectory, manifestBytes, resourceBackend,
  type BatchOutput, type BatchSource, type RecordSource, type ResourceManifestEntry, type ResourceVersionBackend, type WorkspaceDocumentSource,
} from '../engine.js';
import { sha256Hex, type BlobStore } from './blobs.js';
import { isUniqueViolation, withTenant, type Db, type DbClient } from './db.js';

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
    push: (prepare, { pushedBy, now }) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const writes = await prepare(await authoringState(client, tenantId));
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
        await client.query(`INSERT INTO templates (tenant_id, name, current_revision) VALUES ($1, $2, $3)
          ON CONFLICT (tenant_id, name) DO UPDATE SET current_revision = EXCLUDED.current_revision`, [tenantId, name, next]);
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
      return { state: await authoringState(client, tenantId), revisions };
    }),
    setCurrentTemplate: (name, revision) => withTenant(db, tenantId, async (client) => {
      await lockTenant(client, tenantId);
      const [found] = (await client.query<{ sha256: string; byte_length: string }>(
        'SELECT sha256, byte_length FROM template_revisions WHERE tenant_id = $1 AND name = $2 AND revision = $3', [tenantId, name, revision])).rows;
      if (!found) return undefined;
      await client.query('UPDATE templates SET current_revision = $3 WHERE tenant_id = $1 AND name = $2', [tenantId, name, revision]);
      await pointTemplate(client, tenantId, name, { sha256: found.sha256, byteLength: Number(found.byte_length) });
      return (await authoringState(client, tenantId)).templates.find((template) => template.name === name);
    }),
  };
}

/** 锁住租户的一行：资源提交、推送与改模板的当前修订依次进行（M260、M264）。 */
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
  const documents = (await client.query<{ source: string; sha256: string; byte_length: string }>(
    'SELECT source, sha256, byte_length FROM workspace_documents WHERE tenant_id = $1', [tenantId])).rows.flatMap((row): StoredDocument[] => {
    const parsed = parseDocumentSource(row.source);
    return parsed ? [{ ...parsed, sha256: row.sha256, byteLength: Number(row.byte_length) }] : [];
  });
  const revisions = new Map<string, TemplateRevision[]>();
  for (const row of (await client.query<{ name: string; revision: number; sha256: string; byte_length: string; pushed_by: string; created_at: Date }>(
    'SELECT name, revision, sha256, byte_length, pushed_by, created_at FROM template_revisions WHERE tenant_id = $1 ORDER BY revision', [tenantId])).rows) {
    const list = revisions.get(row.name) ?? [];
    list.push({ revision: row.revision, sha256: row.sha256, byteLength: Number(row.byte_length), createdAt: new Date(row.created_at).toISOString(), pushedBy: row.pushed_by });
    revisions.set(row.name, list);
  }
  const templates = (await client.query<{ name: string; current_revision: number }>(
    'SELECT name, current_revision FROM templates WHERE tenant_id = $1', [tenantId])).rows.map((row): StoredTemplate =>
    ({ name: row.name, currentRevision: row.current_revision, revisions: revisions.get(row.name) ?? [] }));
  const resources = (await resourceEntries(client, tenantId)).map((entry) => ({
    id: entry.id, kind: entry.kind, currentVersion: entry.currentVersion,
    versions: entry.versions.map(({ version, sha256, byteLength }) => ({ version, sha256, byteLength })),
  }));
  return { documents, templates, resources };
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

/** 版本化资源仓库（M260）：提交点是事务；同一租户的提交锁住 resource_stores 的一行依次进行，新清单只追加。 */
function resourceStore(db: Db, blobs: BlobStore, tenantId: string): ResourceVersionBackend {
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
  return { batchId, output, source, record };
}
