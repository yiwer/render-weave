/**
 * 发布数据定义草案（P1 票据 05，验收 A04、A10）：只经开放 API 驱动。预检用 M402 样例与构造的失配数据集；
 * 发布产物与本地 renderweave publish 的输出比字节；回退是从旧版另起草案再发布。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli.js';
import { DEFAULT_LIMITS } from '../src/api/previews.js';
import type { ServiceBackend, TenantScope, TenantStorage } from '../src/backend.js';
import { publishStaticSchema, readWorkspaceDocuments } from '../src/engine.js';
import { createWorld, type World } from './api-suite.js';
import { M402_DIR, seedDocuments, seedGreeting, seedM402 } from './seed.js';

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const JSON_TYPE = { 'content-type': 'application/json' };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ROUTE_SIGN = encodeURIComponent('线路牌'), GREETING = encodeURIComponent('问候');

export function describeDefinitionPublish(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`发布数据定义草案（${name}）`, () => {
    let world: World, backend: ServiceBackend;
    /** 下一次登记之前先做的事：用来排出"算好版本之后被别人抢先"的先后。 */
    let beforeCommit: (() => Promise<void>) | undefined;
    const temps: string[] = [];
    beforeAll(async () => {
      backend = await makeBackend();
      // 只包一层登记：其余操作原样。
      const wrapped: ServiceBackend = Object.create(backend, { tenant: { value: (id: string): TenantScope => {
        const scope = backend.tenant(id), storage: TenantStorage = scope.storage;
        const publishDefinitionDraft: TenantStorage['publishDefinitionDraft'] = async (...args) => {
          const before = beforeCommit;
          beforeCommit = undefined;
          await before?.();
          return storage.publishDefinitionDraft(...args);
        };
        return Object.create(scope, { storage: { value: Object.create(storage, { publishDefinitionDraft: { value: publishDefinitionDraft } }) } });
      } } });
      world = await createWorld(wrapped);
    });
    afterAll(async () => { await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true }))); });

    const tenant = async (seed: (storage: TenantStorage) => Promise<void> = seedM402) => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `发布 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `代建工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      await seed(backend.tenant(id).storage);
      return { id, engineer: issued.body.token as string, admin: await world.member(id, 'admin'), operator: await world.member(id, 'operator') };
    };
    const fromVersion = (token: string, version: number, name = ROUTE_SIGN, prefix = '/v1') => world.call('POST', `${prefix}/definitions/${name}/draft`, token, { fromVersion: version });
    const documentOf = async (token: string, name = ROUTE_SIGN) => JSON.parse((await world.call('GET', `/v1/definitions/${name}/draft`, token)).body.content);
    const save = (token: string, name: string, document: unknown, expected: string) => world.call('PUT', `/v1/definitions/${name}/draft?expectedSha256=${expected}`, token, text(document), JSON_TYPE);
    const preflight = async (token: string, expectedSha256: string, name = ROUTE_SIGN, prefix = '/v1') => {
      const reply = await world.call('POST', `${prefix}/definitions/${name}/draft/publish-check`, token, { expectedSha256 });
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const publish = (token: string, expectedSha256: string, name = ROUTE_SIGN, prefix = '/v1') => world.call('POST', `${prefix}/definitions/${name}/draft/publish`, token, { expectedSha256 });
    /** 客户管理员从 v1 另起，在线路牌上加一个必填字段、改一个显示名称、删一个字段。 */
    const editedDraft = async (token: string) => {
      const first = (await fromVersion(token, 1)).body;
      const document = await documentOf(token);
      document.fields.find((field: any) => field.name === 'fare').displayName = '票价';
      document.fields = document.fields.filter((field: any) => field.name !== 'scheduleType');
      document.fields.push({ name: 'operatorCode', displayName: '运营方编码', type: 'text', constraints: { required: true } });
      const saved = await save(token, ROUTE_SIGN, document, first.sha256);
      expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
      return { document, sha256: saved.body.sha256 as string };
    };

    it('预检：与基于版本的字段级差异、按新版失配的数据集份数与问题摘要、仍绑定旧版的模板；不写任何东西', async () => {
      const target = await tenant(), token = target.admin.token;
      const { sha256: draftSha } = await editedDraft(token);
      const schemasBefore = (await world.call('GET', '/v1/static-schemas', token)).raw;
      const check = await preflight(token, draftSha);
      expect(check).toMatchObject({ sha256: draftSha, baseVersion: 1, problems: [], version: 2 });
      expect(check.diff.definition).toEqual([]);
      const changes = Object.fromEntries((check.diff.fields as any[]).map((field) => [field.path, field]));
      expect(Object.keys(changes).sort()).toEqual(['fare', 'operatorCode', 'scheduleType']);
      expect(changes['fare']).toMatchObject({ change: 'changed', properties: [{ key: 'displayName' }] });
      expect(changes['operatorCode']).toMatchObject({ change: 'added' });
      expect(changes['scheduleType']).toMatchObject({ change: 'removed', affectsBindings: true });
      // M402 的数据集没有新的必填字段，按新版失配，问题定位到字段。
      expect(check.datasets).toMatchObject({ total: 1, checked: 1, complete: true, mismatched: 1 });
      expect(check.datasets.samples).toEqual([{ id: expect.any(String), problemCount: expect.any(Number), problems: expect.any(Array) }]);
      expect(JSON.stringify(check.datasets.samples[0].problems)).toContain('operatorCode');
      expect(check.templates).toEqual([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]);
      // 只读：静态版本与草案都没变。
      expect((await world.call('GET', '/v1/static-schemas', token)).raw).toBe(schemasBefore);
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).body.sha256).toBe(draftSha);
      // 预期哈希不是当前内容：看的不是这一份。
      expect(await world.call('POST', `/v1/definitions/${ROUTE_SIGN}/draft/publish-check`, token, { expectedSha256: sha256('别的') }))
        .toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale' }], currentSha256: draftSha } });
    });

    it('预检：只加可选字段时数据集不失配；有严重问题时只答问题，发布同样拒绝且问题码与本地发布相同', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await fromVersion(token, 1)).body, document = await documentOf(token);
      document.fields.push({ name: 'memo', displayName: '备注', type: 'text' });
      const optional = await save(token, ROUTE_SIGN, document, first.sha256);
      expect((await preflight(token, optional.body.sha256)).datasets).toEqual({ total: 1, checked: 1, complete: true, mismatched: 0, samples: [] });

      document.fields.find((field: any) => field.name === 'fare').constraints = { min: 10, max: 1 };
      const broken = await save(token, ROUTE_SIGN, document, optional.body.sha256);
      const check = await preflight(token, broken.body.sha256);
      expect(check).toEqual({ sha256: broken.body.sha256, baseVersion: 1, problems: [expect.objectContaining({ level: 'severe', code: 'definition.constraintConflict' })] });
      const refused = await publish(token, broken.body.sha256);
      expect(refused).toMatchObject({ status: 400, body: { problems: [{ code: 'definition.constraintConflict', location: { path: 'fare.constraints' } }] } });
      // 本地发布同一份文档：同一个问题码。
      const dir = await mkdtemp(join(tmpdir(), 'rw-publish-')); temps.push(dir);
      await writeFile(join(dir, 'schema.json'), text(document));
      const out: string[] = [];
      const code = await runCli(['publish', '--definition', join(dir, 'schema.json'), '--workspace', M402_DIR, '--out', join(dir, 'out')], { stdout: (line) => out.push(line), stderr: (line) => out.push(line) });
      expect(code).not.toBe(0);
      expect(out.join('')).toContain('definition.constraintConflict');
      // 草案还在，改正之后可以发布。
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).status).toBe(200);
      expect((await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/2`, token)).status).toBe(404);
    });

    it('发布：产物与本地 renderweave publish 逐字节相同，成对写入，删除草案；旧版本、模板与数据集不动；记审计', async () => {
      const target = await tenant(), token = target.admin.token;
      const { document, sha256: draftSha } = await editedDraft(token);
      const v1Before = (await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/1`, token)).raw;
      const templatesBefore = (await world.call('GET', '/v1/templates', token)).raw, datasetsBefore = (await world.call('GET', '/v1/datasets', token)).raw;

      const published = await publish(token, draftSha);
      expect(published.status, published.raw.slice(0, 300)).toBe(201);
      expect(published.body).toEqual({ name: '线路牌', version: 2, baseVersion: 1, definitionSha256: expect.any(String), compiledSha256: expect.any(String) });

      // 本地发布同一份文档。
      const dir = await mkdtemp(join(tmpdir(), 'rw-publish-')); temps.push(dir);
      await writeFile(join(dir, 'schema-route-sign.json'), text(document));
      const code = await runCli(['publish', '--definition', join(dir, 'schema-route-sign.json'), '--workspace', M402_DIR, '--out', join(dir, 'out')], { stdout: () => {}, stderr: () => {} });
      expect(code).toBe(0);
      const localDefinition = await readFile(join(dir, 'out', 'schema-route-sign-v2.json')), localCompiled = await readFile(join(dir, 'out', 'compiled-route-sign-v2.schema.json'));
      expect(published.body.definitionSha256).toBe(sha256(localDefinition));
      expect(published.body.compiledSha256).toBe(sha256(localCompiled));
      const state = (await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).body;
      const stored = (kind: string) => state.documents.find((item: any) => item.kind === kind && item.key === '线路牌@2');
      expect(stored('definition')).toMatchObject({ sha256: sha256(localDefinition), byteLength: localDefinition.length });
      expect(stored('compiled')).toMatchObject({ sha256: sha256(localCompiled), byteLength: localCompiled.length });
      const readBack = await world.call('GET', `/v1/authoring/tenants/${target.id}/contents/${sha256(localCompiled)}`, target.engineer);
      expect(Buffer.compare(readBack.bytes, localCompiled)).toBe(0);

      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).status, '草案已删除').toBe(404);
      const listed = (await world.call('GET', '/v1/definitions', token)).body.definitions.find((item: any) => item.name === '线路牌');
      expect(listed.versions.map((version: any) => version.version)).toEqual([1, 2]);
      expect(listed).not.toHaveProperty('draft');
      expect((await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/1`, token)).raw, '旧版本不变').toBe(v1Before);
      expect((await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/2`, token)).status).toBe(200);
      expect((await world.call('GET', '/v1/templates', token)).raw, '模板不动').toBe(templatesBefore);
      expect((await world.call('GET', '/v1/datasets', token)).raw, '数据集不动').toBe(datasetsBefore);

      const v1Sha = state.documents.find((item: any) => item.kind === 'definition' && item.key === '线路牌@1').sha256;
      const [event] = ((await world.call('GET', '/v1/audit-events?limit=500', token)).body.events as any[]).filter((item) => item.action === 'definition.publish');
      expect(event).toMatchObject({
        actor: { kind: 'member', label: target.admin.email }, object: { type: 'definition', id: '线路牌@2' }, crossTenant: false, beforeSha256: v1Sha, afterSha256: sha256(localDefinition),
        diff: { added: 1, removed: 1, changed: 1, paths: expect.arrayContaining([{ path: 'field:operatorCode', change: 'added' }, { path: 'field:scheduleType', change: 'removed' }, { path: 'field:fare', change: 'changed' }]) },
      });
    });

    it('回退：从旧版另起草案再发布，得到内容与旧版相同的新版本；旧版本保持不变；预期哈希不符时拒绝', async () => {
      const target = await tenant(), token = target.admin.token;
      const { sha256: draftSha } = await editedDraft(token);
      expect(await publish(token, sha256('别的内容'))).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale' }], currentSha256: draftSha } });
      expect((await publish(token, draftSha)).status).toBe(201);
      const v2 = (await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/2`, token)).raw;

      const rollback = await fromVersion(token, 1);
      expect(rollback).toMatchObject({ status: 201, body: { baseVersion: 1 } });
      const check = await preflight(token, rollback.body.sha256);
      expect(check).toMatchObject({ version: 3, baseVersion: 1, diff: { fields: [] }, datasets: { total: 1, mismatched: 0 } });
      const published = await publish(token, rollback.body.sha256);
      expect(published.body).toMatchObject({ version: 3, baseVersion: 1 });
      const read = async (version: number) => (await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/${version}`, token)).body;
      const [v1, v3] = [await read(1), await read(3)];
      expect({ ...v3.definition, version: 1 }).toEqual(v1.definition);
      expect(v3.definition.version).toBe(3);
      expect((await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/2`, token)).raw).toBe(v2);
    });

    /** 代建工程师推送一个静态版本：原文与编译产物，都按本地发布的写法。 */
    const pushVersion = async (target: { id: string; engineer: string }, definition: Record<string, unknown>) => {
      const key = `${String(definition['name'])}@${String(definition['version'])}`;
      const { published } = publishStaticSchema(definition, (await readWorkspaceDocuments(backend.tenant(target.id).storage.documents)).staticSchemas);
      const documents = [{ kind: 'definition', key, bytes: text(published!.definition) }, { kind: 'compiled', key, bytes: text(published!.compiled) }];
      for (const { bytes } of documents) {
        const put = await world.call('PUT', `/v1/authoring/tenants/${target.id}/contents/${sha256(bytes)}`, target.engineer, Buffer.from(bytes), { 'content-type': 'application/octet-stream' });
        expect(put.status, put.raw.slice(0, 300)).toBe(204);
      }
      const pushed = await world.call('POST', `/v1/authoring/tenants/${target.id}/pushes`, target.engineer, {
        documents: documents.map(({ kind, key: documentKey, bytes }) => ({ kind, key: documentKey, sha256: sha256(bytes), byteLength: Buffer.byteLength(bytes) })), resources: [],
      });
      expect(pushed.status, pushed.raw.slice(0, 300)).toBe(200);
      return published!;
    };

    it('发布记录（票据 06，M355）：操作员也能看，每个版本谁在何时发布、来源、前后内容哈希与差异；以旧版另发的差异是空的；审计之前的版本没有主体', async () => {
      const target = await tenant(), token = target.admin.token, operator = target.operator.token;
      const records = async (who = operator, query = '') => {
        const reply = await world.call('GET', `/v1/definition-publications${query}`, who);
        expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
        return reply.body.publications as any[];
      };
      const stored = async () => (await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).body.documents as any[];
      const shaOf = (documents: any[], kind: string, key: string) => documents.find((item) => item.kind === kind && item.key === key).sha256;

      // 种子直接写存储，没有审计：列得出版本，没有主体与时间；首个版本的字段全算新增。
      const seeded = (await records()).find((item) => item.name === '线路牌');
      expect(seeded).toMatchObject({ version: 1, displayName: expect.any(String), sha256: shaOf(await stored(), 'definition', '线路牌@1'), compiledSha256: shaOf(await stored(), 'compiled', '线路牌@1') });
      for (const key of ['actor', 'at', 'source', 'baseVersion', 'baseSha256']) expect(seeded, key).not.toHaveProperty(key);
      expect((seeded.diff.fields as any[]).every((field) => field.change === 'added')).toBe(true);

      // 客户管理员发布 v2：基于 v1，字段级差异与预检相同，主体是他的邮箱。
      const { sha256: draftSha } = await editedDraft(token);
      const check = await preflight(token, draftSha);
      const v2 = (await publish(token, draftSha)).body;
      const [newest] = await records();
      const documents = await stored();
      expect(newest).toEqual({
        name: '线路牌', version: 2, displayName: expect.any(String), sha256: v2.definitionSha256, compiledSha256: v2.compiledSha256, baseVersion: 1, baseSha256: shaOf(documents, 'definition', '线路牌@1'),
        source: 'web', at: expect.any(String), actor: { kind: 'member', label: target.admin.email }, diff: check.diff,
      });

      // 以 v1 另发：基准是 v1，没有差异。
      const rollback = await fromVersion(token, 1);
      await publish(token, rollback.body.sha256);
      expect((await records())[0]).toMatchObject({ version: 3, baseVersion: 1, source: 'web', diff: { fields: [], definition: [] } });

      // 代建工程师推送 v4：来源是推送，主体是令牌的标签，与上一版比。
      const { problems: _none, ...v3Document } = { ...(await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/3`, token)).body.definition, problems: [] };
      const pushed = await pushVersion(target, { ...v3Document, version: 4, description: '推送的说明' });
      const [fourth] = await records();
      expect(fourth).toMatchObject({ version: 4, source: 'push', baseVersion: 3, actor: { kind: 'authoringToken' }, diff: { definition: [{ key: 'description', after: '推送的说明' }], fields: [] } });
      expect(fourth.sha256).toBe(sha256(text(pushed.definition)));

      // 按名称筛选；不存在的名称是空列表。代建端点读到相同的内容，读取记审计。
      expect((await records(operator, `?name=${ROUTE_SIGN}`)).map((item) => item.version)).toEqual([4, 3, 2, 1]);
      expect(await records(operator, `?name=${encodeURIComponent('没有这个名称')}`)).toEqual([]);
      const authored = await world.call('GET', `/v1/authoring/tenants/${target.id}/definition-publications`, target.engineer);
      expect(authored.body.publications).toEqual(await records());
      expect((await world.call('GET', '/v1/audit-events?limit=500', token)).body.events.some((event: any) => event.action === 'authoring.read' && event.object.type === 'tenant')).toBe(true);
    });

    it('一个数据定义（票据 06）：静态版本、草案与每个字段被哪些模板读到，经过引用读到的也算；只读，操作员也能看；不存在答 404', async () => {
      const target = await tenant(), token = target.admin.token, operator = target.operator.token;
      const read = async (name: string, who = operator) => world.call('GET', `/v1/definitions/${encodeURIComponent(name)}`, who);
      const route = (await read('线路牌')).body;
      const list = (await world.call('GET', '/v1/definitions', operator)).body.definitions as any[];
      const { fieldUses, ...entry } = route;
      expect(entry).toEqual(list.find((item) => item.name === '线路牌'));
      const uses = new Map((fieldUses as any[]).map((item) => [item.field, item.templates]));
      expect(uses.get('routeNo')).toEqual([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]);
      expect(uses.get('fare')).toEqual([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]);
      // 停靠站点的字段由线路牌的模板经引用读到。
      expect(new Map(((await read('停靠站点')).body.fieldUses as any[]).map((item) => [item.field, item.templates.map((template: any) => template.name)])).get('name')).toContain('标准线路单边');
      // 草案也在；与校验的 affectedBindings 同一份。
      const first = (await fromVersion(token, 1)).body, document = await documentOf(token);
      document.fields = document.fields.filter((field: any) => field.name !== 'routeNo');
      await save(token, ROUTE_SIGN, document, first.sha256);
      expect((await read('线路牌')).body.draft).toMatchObject({ baseVersion: 1 });
      const check = (await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft/check`, operator)).body;
      expect(check.affectedBindings).toEqual([{ field: 'routeNo', templates: uses.get('routeNo') }]);
      // 还没发布过的名称只有草案。
      await world.call('POST', `/v1/definitions/${encodeURIComponent('全新')}/draft`, token, { displayName: '全新结构' });
      expect((await read('全新')).body).toMatchObject({ name: '全新', displayName: '全新结构', versions: [], draft: { name: '全新' }, fieldUses: [] });
      expect((await read(`没有${randomUUID()}`)).status).toBe(404);
    });

    it('新名称：没有基准，字段全算新增，发布成 v1；空白草案可以发布；代建工程师走自己的寻址，审计标跨租户', async () => {
      const target = await tenant(), prefix = `/v1/authoring/tenants/${target.id}`, name = encodeURIComponent('全新结构');
      const blank = await world.call('POST', `${prefix}/definitions/${name}/draft`, target.engineer, { displayName: '全新结构' });
      expect(blank.status).toBe(201);
      const document = { dslVersion: 'renderweave-schema/1', name: '全新结构', displayName: '全新结构', fields: [{ name: 'title', displayName: '标题', type: 'text' }] };
      const saved = await world.call('PUT', `${prefix}/definitions/${name}/draft?expectedSha256=${blank.body.sha256}`, target.engineer, text(document), JSON_TYPE);
      const check = await preflight(target.engineer, saved.body.sha256, name, prefix);
      expect(check).toMatchObject({ version: 1, problems: [], datasets: { total: 0, checked: 0, complete: true, mismatched: 0, samples: [] }, templates: [] });
      expect(check).not.toHaveProperty('baseVersion');
      expect((check.diff.fields as any[]).map((field) => [field.path, field.change])).toEqual([['title', 'added']]);
      const published = await publish(target.engineer, saved.body.sha256, name, prefix);
      expect(published.status, published.raw.slice(0, 300)).toBe(201);
      expect(published.body.version).toBe(1);
      expect(published.body).not.toHaveProperty('baseVersion');
      const events = (await world.call('GET', '/v1/audit-events?limit=500', target.admin.token)).body.events as any[];
      const event = events.find((item) => item.action === 'definition.publish');
      expect(event).toMatchObject({ actor: { kind: 'authoringToken' }, crossTenant: true, object: { id: '全新结构@1' }, afterSha256: published.body.definitionSha256,
        diff: { added: 1, paths: [{ path: 'field:title', change: 'added' }] } });
      expect(event).not.toHaveProperty('beforeSha256');
      expect(events.some((item) => item.action === 'authoring.read' && item.object.type === 'definitionDraft'), '代建工程师的预检记审计').toBe(true);
      // 操作员看得到，但不能发布。
      const operator = target.operator.token;
      expect((await world.call('GET', `/v1/static-schemas/${name}/versions/1`, operator)).status).toBe(200);
      const again = await world.call('POST', `/v1/definitions/${name}/draft`, target.admin.token, { fromVersion: 1 });
      expect((await publish(operator, again.body.sha256, name)).status).toBe(403);
      expect((await world.call('POST', `/v1/definitions/${name}/draft/publish-check`, operator, { expectedSha256: again.body.sha256 })).status).toBe(403);
    });

    it('算好版本之后被抢先：推送先写了 v2、别人先改了草案，都答 409，什么也没写；再发一次用下一个版本', async () => {
      const target = await tenant(seedGreeting), token = target.admin.token;
      const first = (await fromVersion(token, 1, GREETING)).body, document = await documentOf(token, GREETING);
      document.fields.push({ name: 'extra', displayName: '新增', type: 'text' });
      const saved = (await save(token, GREETING, document, first.sha256)).body;

      // 代建工程师抢先推送了 v2。
      beforeCommit = async () => {
        const { published } = publishStaticSchema({ ...document, displayName: '推送的第二版' }, [
          { ref: { name: '问候', version: 1 }, definition: { ...document, version: 1, fields: document.fields.slice(0, -1) } },
        ]);
        await seedDocuments(backend.tenant(target.id).storage, [published!.definition, published!.compiled].map((value) => new Uint8Array(Buffer.from(text(value)))));
      };
      const taken = await publish(token, saved.sha256, GREETING);
      expect(taken).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.versionTaken' }] } });
      const read = async (version: number) => (await world.call('GET', `/v1/static-schemas/${GREETING}/versions/${version}`, token)).body;
      expect((await read(2)).definition.displayName).toBe('推送的第二版');
      expect((await world.call('GET', `/v1/definitions/${GREETING}/draft`, token)).body.sha256, '草案还在').toBe(saved.sha256);
      const retried = await publish(token, saved.sha256, GREETING);
      expect(retried).toMatchObject({ status: 201, body: { version: 3 } });

      // 别人在预检之后、登记之前保存了草案。
      const next = (await fromVersion(token, 3, GREETING)).body;
      const nextDocument = await documentOf(token, GREETING);
      beforeCommit = async () => { expect((await save(token, GREETING, { ...nextDocument, displayName: '别人改的' }, next.sha256)).status).toBe(200); };
      const stale = await publish(token, next.sha256, GREETING);
      expect(stale).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale' }] } });
      expect((await world.call('GET', `/v1/static-schemas/${GREETING}/versions/4`, token)).status).toBe(404);
    });

    it('失配很多时只给前 20 份的摘要；超过上限只校验前面的，标为未全部核对', async () => {
      expect(DEFAULT_LIMITS.publishCheckDatasets).toBe(1_000);
      const limited = await createWorld(backend, { api: { limits: { publishCheckDatasets: 22 } } });
      const created = await limited.call('POST', '/v1/platform/tenants', limited.platform, { name: `上限 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string, storage = backend.tenant(id).storage, admin = (await limited.member(id, 'admin')).token;
      await seedGreeting(storage);
      await seedDocuments(storage, Array.from({ length: 24 }, (_unused, index) =>
        new Uint8Array(Buffer.from(text({ dataset: { id: `ds-${String(index).padStart(2, '0')}`, staticSchema: { name: '问候', version: 1 } }, data: { message: '你好' } })))));
      const draft = (await limited.call('POST', `/v1/definitions/${GREETING}/draft`, admin, { fromVersion: 1 })).body;
      const document = JSON.parse((await limited.call('GET', `/v1/definitions/${GREETING}/draft`, admin)).body.content);
      document.fields.push({ name: 'mustHave', displayName: '必填', type: 'text', constraints: { required: true } });
      const saved = await limited.call('PUT', `/v1/definitions/${GREETING}/draft?expectedSha256=${draft.sha256}`, admin, text(document), JSON_TYPE);
      const reply = await limited.call('POST', `/v1/definitions/${GREETING}/draft/publish-check`, admin, { expectedSha256: saved.body.sha256 });
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      // 问候牌样例自带一份，加上 24 份，共 25 份。
      expect(reply.body.datasets).toMatchObject({ total: 25, checked: 22, complete: false, mismatched: 22 });
      expect(reply.body.datasets.samples).toHaveLength(20);
      expect(reply.body.datasets.samples.map((sample: any) => sample.id)).toEqual([...reply.body.datasets.samples.map((sample: any) => sample.id)].sort());
      for (const sample of reply.body.datasets.samples) expect(sample.problems.length).toBeLessThanOrEqual(5);
    });
  });
}
