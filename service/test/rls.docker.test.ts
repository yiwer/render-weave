/**
 * 行级安全（ADR-0018 的第二道防线，M262）：应用层写错查询、漏写租户条件时，数据库也不返回、不改动别的租户的行。
 * 用与服务相同的应用账号连库；两个租户各有成员、会话、API 密钥、审计、文档、资源与批次。
 */
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { asPlatform, withTenant, type Db } from '../src/postgres/db.js';
import { connectOwner, postgresBackend } from './support.js';

const TENANT_TABLES = ['workspace_documents', 'resource_stores', 'resources', 'resource_versions', 'batches', 'batch_items', 'batch_item_files', 'api_keys', 'users', 'sessions', 'audit_events',
  'template_revisions', 'templates', 'render_tasks', 'tenant_plans', 'usage_counters', 'usage_events', 'webhooks', 'webhook_events', 'webhook_deliveries', 'webhook_attempts'];
/** 平台模式下可见的表；其余租户数据表在平台模式下仍然只认当前租户。代建令牌的租户表只在平台模式下可见。 */
const PLATFORM_VISIBLE = new Set(['users', 'sessions', 'audit_events', 'authoring_token_tenants']);
const PLATFORM_ONLY = ['authoring_token_tenants'];

let db: Db, owner: Db, backend: ServiceBackend;
const tenants: { id: string; email: string; keyId: string; auditSha256: string }[] = [];
const bytes = (value: string) => new Uint8Array(Buffer.from(value));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

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
    // 代建写入的审计（P1 票据 03）：前后内容哈希与差异摘要随行，一样只让本租户看到。
    const auditSha256 = digest(`审计 ${name}`);
    await scope.appendAudit({ actor: { kind: 'authoringToken', id: 'test', label: '测试' }, action: 'template.setCurrent', object: { type: 'template', id: name }, crossTenant: true,
      beforeSha256: digest(name), afterSha256: auditSha256, diff: { added: 0, removed: 0, changed: 1, paths: [{ path: `template:${name}`, change: 'changed', afterSha256: auditSha256 }] },
      round: `轮次 ${name}`, reason: `理由 ${name}` }, new Date());
    await scope.storage.putDocuments([{ source: `${name}.json`, bytes: bytes(`{"name":"${name}"}`) }]);
    expect((await scope.storage.resources.commit([{ type: 'create', id: 'logo', kind: 'image', bytes: bytes(name) }])).problems).toEqual([]);
    const template = bytes(`{"dslVersion":"renderweave-template/1","name":"${name}"}`);
    const sha256 = await scope.storage.contents.put(template);
    // 推送随附一轮代建的 token：记一条用量事件（票据 09）。
    await scope.storage.push(async () => ({ documents: [], templates: [{ name, sha256, byteLength: template.length }], resources: [],
      rounds: [{ sha256: sha256.replace(/^./, 'a'), task: 'rls', round: 1, tokens: { inputTokens: 1 } }] }), { pushedBy: '测试', now: new Date() });
    // 套餐与当期计数：设套餐，再建一个一项的批次预占额度。
    await scope.setPlan({ monthlyImages: 5, maxPixels: 1_000, concurrency: 1 }, new Date());
    // webhook（票据 11）：注册一个，取消批次让它结束，记下事件与投递；Compose 里接口进程的投递任务会来投（连不上），记下尝试。
    const hook = await scope.createWebhook({ url: 'http://127.0.0.1:9/rls', events: ['batch.finished'], secretSealed: 'v1.x', secretPrefix: 'whsec_xxxxxx' }, new Date());
    expect(hook).toMatchObject({ active: true });
    const created = await scope.tasks.createBatch({ snapshot: sha256, build: 'sha256:rls', template: name, mode: 'final', items: [{ index: 1, id: '1' }], requestSha256: sha256 }, new Date());
    expect(created).toMatchObject({ created: true });
    await scope.tasks.cancelBatch((created as { batch: { batchId: string } }).batch.batchId, new Date());
    const deadline = Date.now() + 30_000, hookId = (hook as { id: string }).id;
    while (!(await scope.listWebhookDeliveries(hookId, { limit: 1 }))[0]?.attempts.length) {
      if (Date.now() > deadline) throw new Error('等不到接口进程的投递任务记下尝试');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await scope.updateWebhook(hookId, { active: false }, new Date());
    await scope.tasks.enqueuePreview({ template: '不存在' }, { concurrency: 9, perMinute: 9, staleAfterMs: 60_000 }, new Date());
    const batch = await scope.storage.createBatch();
    await batch.output.write(1, { files: new Map([['problems.json', bytes('[]\n')]]) });
    tenants.push({ id, email, keyId: key.id, auditSha256 });
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

it('审计的内容哈希与差异摘要：按别的租户的哈希查不到；经后端只读到本租户的', async () => {
  for (const tenant of tenants) {
    const others = tenants.filter((other) => other.id !== tenant.id);
    const rows = await withTenant(db, tenant.id, async (client) => (await client.query(
      `SELECT tenant_id, after_sha256, diff, round, reason FROM audit_events WHERE after_sha256 IS NOT NULL OR diff IS NOT NULL OR round IS NOT NULL`)).rows);
    expect(rows.map((row) => [row.tenant_id, row.after_sha256])).toEqual([[tenant.id, tenant.auditSha256]]);
    for (const other of others) {
      const found = await withTenant(db, tenant.id, (client) => client.query(`SELECT 1 FROM audit_events WHERE after_sha256 = $1 OR diff::text LIKE '%' || $1 || '%'`, [other.auditSha256]));
      expect(found.rowCount).toBe(0);
    }
    const events = await backend.tenant(tenant.id).listAudit({ limit: 500, actorKind: 'authoringToken' });
    expect(events.map((event) => event.afterSha256)).toEqual([tenant.auditSha256]);
    expect(events[0]).toMatchObject({ diff: { changed: 1, paths: [{ afterSha256: tenant.auditSha256 }] }, crossTenant: true });
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

it('审计、用量事件与 webhook 的事件、尝试只能追加；webhook 不能删；应用账号不能改表结构', async () => {
  const [a] = tenants;
  for (const statement of [`UPDATE webhook_events SET body = '{}'`, 'DELETE FROM webhook_events', 'UPDATE webhook_attempts SET status_code = 200', 'DELETE FROM webhook_attempts',
    'DELETE FROM webhook_deliveries', 'DELETE FROM webhooks']) {
    await expect(withTenant(db, a!.id, (client) => client.query(statement)), statement).rejects.toThrow(/permission denied/);
  }
  await expect(withTenant(db, a!.id, (client) => client.query(`UPDATE audit_events SET action = 'x'`))).rejects.toThrow(/permission denied/);
  await expect(withTenant(db, a!.id, (client) => client.query(`UPDATE audit_events SET after_sha256 = NULL, diff = NULL`))).rejects.toThrow(/permission denied/);
  await expect(withTenant(db, a!.id, (client) => client.query(`DELETE FROM audit_events`))).rejects.toThrow(/permission denied/);
  await expect(withTenant(db, a!.id, (client) => client.query(`UPDATE usage_events SET quantity = 0`))).rejects.toThrow(/permission denied/);
  await expect(withTenant(db, a!.id, (client) => client.query(`DELETE FROM usage_events`))).rejects.toThrow(/permission denied/);
  await expect(db.query('DROP TABLE api_keys')).rejects.toThrow(/must be owner/);
  await expect(db.query('CREATE TABLE intruder (id integer)')).rejects.toThrow(/permission denied/);
});

it('按邮箱登录只经属主函数跨租户查找；应用账号直接查账号表查不到', async () => {
  const [a] = tenants;
  expect((await db.query('SELECT id FROM users WHERE email = $1', [a!.email])).rowCount).toBe(0);
  expect((await db.query('SELECT user_id, tenant_id FROM rw_find_login($1)', [a!.email])).rows).toEqual([expect.objectContaining({ tenant_id: a!.id })]);
});
