/**
 * 行级安全（ADR-0018 的第二道防线，M262）：应用层写错查询、漏写租户条件时，数据库也不返回、不改动别的租户的行。
 * 用与服务相同的应用账号连库；两个租户各有成员、会话、API 密钥、审计、文档、资源与批次。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { asPlatform, withTenant, type Db } from '../src/postgres/db.js';
import { connectOwner, postgresBackend } from './support.js';

const TENANT_TABLES = ['workspace_documents', 'resource_stores', 'resources', 'resource_versions', 'batches', 'batch_items', 'batch_item_files', 'api_keys', 'users', 'sessions', 'audit_events',
  'template_revisions', 'templates', 'render_tasks'];
/** 平台模式下可见的表；其余租户数据表在平台模式下仍然只认当前租户。代建令牌的租户表只在平台模式下可见。 */
const PLATFORM_VISIBLE = new Set(['users', 'sessions', 'audit_events', 'authoring_token_tenants']);
const PLATFORM_ONLY = ['authoring_token_tenants'];

let db: Db, owner: Db, backend: ServiceBackend;
const tenants: { id: string; email: string; keyId: string }[] = [];
const bytes = (value: string) => new Uint8Array(Buffer.from(value));

beforeAll(async () => {
  ({ db, backend } = await postgresBackend());
  owner = connectOwner();
  for (const name of ['甲', '乙']) {
    const { id } = await backend.platform.createTenant(`行级安全 ${name}`);
    const scope = backend.tenant(id), email = `rls-${randomUUID()}@example.test`;
    const member = await scope.createMember({ email, role: 'admin', passwordHash: 'scrypt$1$1$1$x$y' });
    await scope.createSession(member.id, randomUUID().replaceAll('-', '').padEnd(64, '0'), new Date(Date.now() + 3_600_000));
    const key = await scope.createApiKey({ name: name, tokenHash: randomUUID().replaceAll('-', '').padEnd(64, '1'), prefix: 'rwk_xxxxxx' });
    await scope.appendAudit({ actor: { kind: 'system', id: 'test', label: '测试' }, action: 'test.seed', object: { type: 'tenant', id }, crossTenant: false }, new Date());
    await scope.storage.putDocuments([{ source: `${name}.json`, bytes: bytes(`{"name":"${name}"}`) }]);
    expect((await scope.storage.resources.commit([{ type: 'create', id: 'logo', kind: 'image', bytes: bytes(name) }])).problems).toEqual([]);
    const template = bytes(`{"dslVersion":"renderweave-template/1","name":"${name}"}`);
    const sha256 = await scope.storage.contents.put(template);
    await scope.storage.push(async () => ({ documents: [], templates: [{ name, sha256, byteLength: template.length }], resources: [] }), { pushedBy: '测试', now: new Date() });
    await scope.tasks.enqueuePreview({ template: '不存在' }, { concurrency: 9, perMinute: 9, staleAfterMs: 60_000 }, new Date());
    const batch = await scope.storage.createBatch();
    await batch.output.write(1, { files: new Map([['problems.json', bytes('[]\n')]]) });
    tenants.push({ id, email, keyId: key.id });
  }
  await backend.platform.createAuthoringToken({ label: '行级安全', tokenHash: 'e'.repeat(64).slice(0, 32) + randomUUID().replaceAll('-', ''), prefix: 'rwa_xxxxxx',
    tenantIds: tenants.map((tenant) => tenant.id), expiresAt: new Date(Date.now() + 3_600_000) });
});
afterAll(async () => { await db.end(); await owner.end(); });

it('每张带 tenant_id 的表都开了行级安全，测试覆盖全部这些表', async () => {
  const { rows } = await owner.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)`);
  expect(rows.map((row) => row.relname).sort()).toEqual([...TENANT_TABLES, ...PLATFORM_ONLY].sort());
  expect(rows.filter((row) => !row.relrowsecurity)).toEqual([]);
});

it('故意漏写租户条件：每张租户表都只返回当前租户的行', async () => {
  for (const tenant of tenants) {
    for (const table of TENANT_TABLES) {
      const rows = await withTenant(db, tenant.id, async (client) => (await client.query(`SELECT tenant_id FROM ${table}`)).rows);
      expect(rows.length, `${table}`).toBeGreaterThan(0);
      expect(rows.every((row) => row.tenant_id === tenant.id), `${table}`).toBe(true);
    }
    for (const table of PLATFORM_ONLY) {
      expect((await withTenant(db, tenant.id, (client) => client.query(`SELECT tenant_id FROM ${table}`))).rowCount, `${table}`).toBe(0);
    }
  }
});

it('没设置当前租户时什么也查不到；平台模式也看不到租户数据表', async () => {
  for (const table of [...TENANT_TABLES, ...PLATFORM_ONLY]) {
    expect(Number((await db.query(`SELECT count(*) FROM ${table}`)).rows[0].count), `${table}`).toBe(0);
    const platform = Number((await asPlatform(db, async (client) => (await client.query(`SELECT count(*) FROM ${table}`)).rows[0].count)));
    if (PLATFORM_VISIBLE.has(table)) expect(platform, `${table}`).toBeGreaterThan(0);
    else expect(platform, `${table}`).toBe(0);
  }
});

it('写别的租户的行被拒绝；漏写条件的更新只改到当前租户', async () => {
  const [a, b] = tenants as [typeof tenants[0], typeof tenants[0]];
  await expect(withTenant(db, a.id, (client) => client.query(
    `INSERT INTO api_keys (tenant_id, name, prefix, token_hash) VALUES ($1, '越权', 'rwk_xxxxxx', $2)`, [b.id, 'f'.repeat(64)]))).rejects.toThrow(/row-level security/);
  const updated = await withTenant(db, a.id, (client) => client.query(`UPDATE api_keys SET name = '改名'`));
  expect(updated.rowCount).toBe(1);
  const names = await withTenant(db, b.id, async (client) => (await client.query('SELECT name FROM api_keys')).rows.map((row) => row.name));
  expect(names).toEqual(['乙']);
});

it('审计只能追加；应用账号不能改表结构', async () => {
  const [a] = tenants;
  await expect(withTenant(db, a!.id, (client) => client.query(`UPDATE audit_events SET action = 'x'`))).rejects.toThrow(/permission denied/);
  await expect(withTenant(db, a!.id, (client) => client.query(`DELETE FROM audit_events`))).rejects.toThrow(/permission denied/);
  await expect(db.query('DROP TABLE api_keys')).rejects.toThrow(/must be owner/);
  await expect(db.query('CREATE TABLE intruder (id integer)')).rejects.toThrow(/permission denied/);
});

it('按邮箱登录只经属主函数跨租户查找；应用账号直接查账号表查不到', async () => {
  const [a] = tenants;
  expect((await db.query('SELECT id FROM users WHERE email = $1', [a!.email])).rowCount).toBe(0);
  expect((await db.query('SELECT user_id, tenant_id FROM rw_find_login($1)', [a!.email])).rows).toEqual([expect.objectContaining({ tenant_id: a!.id })]);
});
