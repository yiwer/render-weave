/**
 * 数据定义草案（P1 票据 04，验收 A02、A10）：只经开放 API 驱动——客户管理员与代建工程师各用自己的寻址，
 * 断言回答、问题清单、经 API 可见的列表与审计。同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { compileStaticSchema, localWorkspaceDocuments, publishStaticSchema, readWorkspaceDocuments } from '../src/engine.js';
import { createWorld, type World } from './api-suite.js';
import { M402_DIR, M402_FILES, seedDocuments } from './seed.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const JSON_TYPE = { 'content-type': 'application/json' };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ROUTE_SIGN = encodeURIComponent('线路牌'), STOP = encodeURIComponent('停靠站点');

export function describeDefinitions(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`数据定义草案（${name}）`, () => {
    let world: World, backend: ServiceBackend;
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
    });

    /** 平台管理员新开一个租户：管理员、操作员、只指定给它的代建令牌，工作区是 M402 样例（线路牌 v1、停靠站点 v1、五个模板、一份数据集）。 */
    const tenant = async () => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `草案 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `代建工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      await seedDocuments(backend.tenant(id).storage, await Promise.all(M402_FILES.map(async (file) => new Uint8Array(await readFile(`${M402_DIR}${file}`)))));
      return { id, engineer: issued.body.token as string, admin: await world.member(id, 'admin'), operator: await world.member(id, 'operator') };
    };
    const save = (token: string, name: string, content: string, expected: string, prefix = '/v1') =>
      world.call('PUT', `${prefix}/definitions/${name}/draft?expectedSha256=${expected}`, token, content, JSON_TYPE);
    const fromV1 = (token: string, name = ROUTE_SIGN, prefix = '/v1') => world.call('POST', `${prefix}/definitions/${name}/draft`, token, { fromVersion: 1 });
    const draftDocument = async (token: string, name = ROUTE_SIGN, prefix = '/v1') => {
      const reply = await world.call('GET', `${prefix}/definitions/${name}/draft`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return { reply: reply.body, document: JSON.parse(reply.body.content) };
    };
    const check = async (token: string, name = ROUTE_SIGN, prefix = '/v1') => {
      const reply = await world.call('GET', `${prefix}/definitions/${name}/draft/check`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const auditOf = async (token: string, action: string) =>
      ((await world.call('GET', '/v1/audit-events?limit=500', token)).body.events as any[]).filter((event) => event.action === action);

    it('列出每个名称的静态版本、各版本被多少数据集与模板使用，以及草案基于哪一版', async () => {
      const target = await tenant();
      const list = async () => (await world.call('GET', '/v1/definitions', target.operator.token)).body.definitions as any[];
      expect(await list()).toEqual([
        { name: '停靠站点', displayName: expect.any(String), versions: [{ version: 1, displayName: expect.any(String), datasets: 0, templates: 2 }] },
        { name: '线路牌', displayName: expect.any(String), versions: [{ version: 1, displayName: expect.any(String), datasets: 1, templates: 1 }] },
      ]);
      const draft = await fromV1(target.admin.token);
      expect(draft.status).toBe(201);
      expect((await world.call('POST', '/v1/definitions/新结构/draft'.replace('新结构', encodeURIComponent('新结构')), target.admin.token, { displayName: '新结构显示名' })).status).toBe(201);
      const [fresh, stop, sign] = (await list()).sort((a, b) => (a.name === '新结构' ? -1 : b.name === '新结构' ? 1 : a.name === '停靠站点' ? -1 : 1));
      expect(fresh).toMatchObject({ name: '新结构', displayName: '新结构显示名', versions: [], draft: { name: '新结构', updatedBy: target.admin.email } });
      expect(fresh.draft).not.toHaveProperty('baseVersion');
      expect(stop).not.toHaveProperty('draft');
      expect(sign.draft).toMatchObject({ name: '线路牌', baseVersion: 1, sha256: draft.body.sha256 });
      // 卡片要的数（M360）：草案的显示名称与字段数；静态版本的字段数与引用深度，线路牌引用了停靠站点。
      const schemas = (await world.call('GET', '/v1/static-schemas', target.admin.token)).body.staticSchemas as { name: string; displayName: string; fieldCount: number; referenceDepth: number }[];
      const [stops, line] = [schemas.find((schema) => schema.name === '停靠站点')!, schemas.find((schema) => schema.name === '线路牌')!];
      expect(fresh.draft).toMatchObject({ displayName: '新结构显示名', fieldCount: 0 });
      expect(sign.draft).toMatchObject({ displayName: line.displayName, fieldCount: line.fieldCount });
      expect([stops.referenceDepth, line.referenceDepth]).toEqual([0, 1]);
      expect(stops.fieldCount).toBeGreaterThan(0);
      expect(line.fieldCount).toBe(JSON.parse((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, target.admin.token)).body.content).fields.length);
      // 还没写成字段列表的草案也能列，只是没有字段数。
      const unfinished = await world.call('PUT', `/v1/definitions/${encodeURIComponent('新结构')}/draft?expectedSha256=${fresh.draft.sha256}`, target.admin.token, JSON.stringify({ name: '新结构', displayName: '没写完', fields: '还没想好' }), { 'content-type': 'application/json' });
      expect(unfinished.status, unfinished.raw.slice(0, 300)).toBe(200);
      const relisted = (await list()).find((item) => item.name === '新结构');
      expect(relisted.draft).toMatchObject({ displayName: '没写完' });
      expect(relisted.draft).not.toHaveProperty('fieldCount');
    });

    it('从静态版本另起：复制原文、去掉版本号；空白新建可以用新名称；同名已有草案、已有静态版本、没有这一版、名称不合规都拒绝', async () => {
      const target = await tenant(), token = target.admin.token;
      const created = await fromV1(token);
      expect(created).toMatchObject({ status: 201, body: { name: '线路牌', baseVersion: 1, updatedBy: target.admin.email } });
      const { reply, document } = await draftDocument(target.operator.token);
      const original = JSON.parse(await readFile(`${M402_DIR}schema-route-sign-v1.json`, 'utf8'));
      const { version: _version, ...withoutVersion } = original;
      expect(document).toEqual(withoutVersion);
      expect(sha256(reply.content)).toBe(reply.sha256);
      expect(Buffer.byteLength(reply.content)).toBe(reply.byteLength);
      // 每个名称至多一份。
      expect(await fromV1(token)).toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate' }] } });
      // 空白新建不能用已有静态版本的名称：那样草案就没有基准。
      expect(await world.call('POST', `/v1/definitions/${STOP}/draft`, token, { displayName: '站点' })).toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate' }] } });
      expect(await world.call('POST', `/v1/definitions/${STOP}/draft`, token, { fromVersion: 9 })).toMatchObject({ status: 404 });
      const blankName = encodeURIComponent('全新结构');
      const blank = await world.call('POST', `/v1/definitions/${blankName}/draft`, token, { displayName: '全新结构' });
      expect(blank.status).toBe(201);
      expect(blank.body).not.toHaveProperty('baseVersion');
      expect((await draftDocument(token, blankName)).document).toEqual({ dslVersion: 'renderweave-schema/1', name: '全新结构', displayName: '全新结构', fields: [] });
      expect((await world.call('POST', `/v1/definitions/${encodeURIComponent(' 首尾空白 ')}/draft`, token, { displayName: 'x' })).status).toBe(400);
      for (const body of [{}, { displayName: ' ' }, { displayName: 'x', fromVersion: 1 }, { fromVersion: 0 }]) {
        expect((await world.call('POST', `/v1/definitions/${encodeURIComponent('别的名称')}/draft`, token, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('保存：整份替换，按原始字节存，带预期哈希，不符答 409 并给当前哈希，草案不变；请求不合规答 400', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await fromV1(token)).body;
      const { document } = await draftDocument(token);
      // 键的顺序、缩进与行尾都照原样。
      const edited = `{"fields":[${JSON.stringify(document.fields[0])}],\n\t"dslVersion":"renderweave-schema/1", "name":"线路牌","displayName":"改过的线路牌"}\r\n`;
      const saved = await save(token, ROUTE_SIGN, edited, first.sha256);
      expect(saved).toMatchObject({ status: 200, body: { name: '线路牌', baseVersion: 1, sha256: sha256(edited), byteLength: Buffer.byteLength(edited), createdAt: first.createdAt } });
      expect((await draftDocument(token)).reply.content).toBe(edited);
      // 还是旧哈希：别人先保存了。
      const stale = await save(token, ROUTE_SIGN, text(document), first.sha256);
      expect(stale).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale', location: { source: 'request.querystring.expectedSha256' } }], currentSha256: sha256(edited) } });
      expect((await draftDocument(token)).reply.content).toBe(edited);
      // 没写完的草案也能存：问题由校验回答。
      const unfinished = text({ dslVersion: 'renderweave-schema/1', name: '线路牌', fields: [{ name: '不合规 名称', type: 'text' }] });
      const stored = await save(token, ROUTE_SIGN, unfinished, sha256(edited));
      expect(stored.status).toBe(200);
      for (const [body, source] of [
        ['不是 JSON', 'request.body'], ['[]', 'request.body'],
        [text({ ...document, name: '改了名称' }), 'request.body.name'],
        [text({ ...document, description: 1.23456789012345678 }).replace('1.2345678901234568', '1.23456789012345678'), 'request.body'],
      ] as const) {
        expect(await save(token, ROUTE_SIGN, body, stored.body.sha256), body.slice(0, 30)).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', location: { source } }] } });
      }
      expect((await world.call('PUT', `/v1/definitions/${ROUTE_SIGN}/draft`, token, unfinished, JSON_TYPE)).status, '要带预期哈希').toBe(400);
      expect((await world.call('PUT', `/v1/definitions/${ROUTE_SIGN}/draft?expectedSha256=${stored.body.sha256}`, token, new Uint8Array(Buffer.from(unfinished)))).status, '媒体类型').toBe(415);
      expect((await world.call('PUT', `/v1/authoring/tenants/${target.id}/definitions/${ROUTE_SIGN}/draft?expectedSha256=${stored.body.sha256}`, target.engineer, new Uint8Array(Buffer.from(unfinished)))).status, '代建端点的媒体类型').toBe(415);
      expect((await save(token, ROUTE_SIGN, ' '.repeat(1024 * 1024 + 1), stored.body.sha256)).status).toBe(413);
      expect((await save(token, STOP, unfinished, stored.body.sha256)).status, '没有这份草案').toBe(404);
      // 重复保存相同内容不报错，审计的差异是空的。
      expect((await save(token, ROUTE_SIGN, unfinished, stored.body.sha256)).status).toBe(200);
    });

    it('校验：问题定位到字段，有严重问题时没有编译产物；编译预览与本地发布的产物相同；引用不存在、版本号写错都报', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await fromV1(token)).body;
      const clean = await check(target.operator.token);
      const workspace = await readWorkspaceDocuments(localWorkspaceDocuments(M402_DIR));
      const local = publishStaticSchema(JSON.parse((await draftDocument(token)).reply.content), workspace.staticSchemas);
      expect(clean).toEqual({ sha256: first.sha256, problems: [], version: 2, compiled: local.published!.compiled, affectedBindings: [] });
      // 与 compileStaticSchema 的产物相同（发布的产物就是它）。
      expect(compileStaticSchema({ ref: { name: '线路牌', version: 2 }, definition: local.published!.definition }, workspace.staticSchemas).compiled).toEqual(clean.compiled);

      const { document } = await draftDocument(token);
      const fare = document.fields.find((field: any) => field.name === 'fare');
      fare.constraints = { min: 10, max: 1 };
      const conflict = await save(token, ROUTE_SIGN, text(document), first.sha256);
      expect(conflict.status).toBe(200);
      const located = await check(token);
      expect(located.sha256).toBe(conflict.body.sha256);
      expect(located.problems).toEqual([expect.objectContaining({ level: 'severe', code: 'definition.constraintConflict', location: { kind: 'definition', schema: '线路牌', path: 'fare.constraints' } })]);
      expect(located).not.toHaveProperty('compiled');
      expect(located).not.toHaveProperty('version');

      // 引用的静态数据定义不存在：要读其他文档才能判断，这里也报。
      fare.constraints = { min: 0, max: 100 };
      document.fields.push({ name: 'missingRef', displayName: '引用', type: 'ref', ref: { name: '没有这个', version: 1 } });
      const ref = await save(token, ROUTE_SIGN, text(document), conflict.body.sha256);
      expect((await check(token)).problems.map((problem: any) => problem.level)).toEqual(['severe']);
      // 文档里写了版本号：版本号由发布分配，写错的发布会拒绝，校验提前报。
      document.fields.pop();
      document.version = 9;
      await save(token, ROUTE_SIGN, text(document), ref.body.sha256);
      expect((await check(token)).problems).toEqual([expect.objectContaining({ code: 'definition.invalid', message: expect.stringContaining('下一个版本是 v2') })]);
    });

    it('与基于的版本相比，删除与改名的字段列为会影响绑定，带用到它们的模板；没用到的字段模板为空，新名称没有基准', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await fromV1(token)).body;
      const { document } = await draftDocument(token);
      const fare = document.fields.find((field: any) => field.name === 'fare');
      fare.name = 'price';
      document.fields = document.fields.filter((field: any) => field.name !== 'operator');
      document.fields.push({ name: 'extra', displayName: '新增', type: 'text' });
      const saved = await save(token, ROUTE_SIGN, text(document), first.sha256);
      expect(saved.status).toBe(200);
      const route = (await check(target.operator.token)).affectedBindings as any[];
      expect(route.map((item) => item.field).sort()).toEqual(['fare', 'operator']);
      const uses = (field: string) => route.find((item) => item.field === field).templates;
      expect(uses('fare')).toEqual([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]);
      expect(uses('operator')).toEqual([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]);

      // 被引用的数据定义：删掉 landmark，线路牌的模板经 nextStop.landmark 读到它。
      const stop = (await fromV1(token, STOP)).body;
      const stopDocument = (await draftDocument(token, STOP)).document;
      stopDocument.fields = stopDocument.fields.filter((field: any) => field.name !== 'landmark');
      expect((await save(token, STOP, text(stopDocument), stop.sha256)).status).toBe(200);
      const affected = (await check(token, STOP)).affectedBindings as any[];
      expect(affected).toEqual([{ field: 'landmark', templates: expect.arrayContaining([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]) }]);

      // 没有模板用到的字段：照样列出，模板为空。
      const { published } = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '无人使用', displayName: '无人使用', fields: [{ name: 'unused', displayName: '没人用', type: 'text' }] }, []);
      await seedDocuments(backend.tenant(target.id).storage, [published!.definition, published!.compiled].map((value) => new Uint8Array(Buffer.from(text(value)))));
      const nobody = encodeURIComponent('无人使用');
      const draft = (await fromV1(token, nobody)).body, nobodyDocument = (await draftDocument(token, nobody)).document;
      expect((await save(token, nobody, text({ ...nobodyDocument, fields: [] }), draft.sha256)).status).toBe(200);
      expect((await check(token, nobody)).affectedBindings).toEqual([{ field: 'unused', templates: [] }]);

      // 新名称没有基准。
      const blank = encodeURIComponent('全新结构');
      await world.call('POST', `/v1/definitions/${blank}/draft`, token, { displayName: '全新结构' });
      expect((await check(token, blank)).affectedBindings).toEqual([]);
    });

    it('删除草案；静态版本不受影响；草案不进工作区：静态数据定义列表与工作区都看不到，模板照旧', async () => {
      const target = await tenant(), token = target.admin.token;
      const schemasBefore = (await world.call('GET', '/v1/static-schemas', token)).raw;
      const before = await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer);
      await fromV1(token);
      const blank = encodeURIComponent('只是草案');
      await world.call('POST', `/v1/definitions/${blank}/draft`, token, { displayName: '只是草案' });
      expect((await world.call('GET', '/v1/static-schemas', token)).raw).toBe(schemasBefore);
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).raw).toBe(before.raw);
      expect((await world.call('GET', `/v1/static-schemas/${blank}/versions/1`, token)).status).toBe(404);

      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).status).toBe(204);
      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).status).toBe(404);
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, token)).status).toBe(404);
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft/check`, token)).status).toBe(404);
      const list = (await world.call('GET', '/v1/definitions', token)).body.definitions as any[];
      expect(list.find((item) => item.name === '线路牌')).toMatchObject({ versions: [{ version: 1 }] });
      expect(list.find((item) => item.name === '线路牌')).not.toHaveProperty('draft');
      // 删掉之后可以重新另起。
      expect((await fromV1(token)).status).toBe(201);
    });

    it('两种寻址共用一份实现：代建工程师写的草案客户管理员看得到，反之亦然；每次写入记审计，带前后内容哈希与差异摘要，代建的另标跨租户', async () => {
      const target = await tenant(), admin = target.admin.token, prefix = `/v1/authoring/tenants/${target.id}`;
      const created = await fromV1(target.engineer, ROUTE_SIGN, prefix);
      expect(created).toMatchObject({ status: 201, body: { baseVersion: 1 } });
      const list = (await world.call('GET', `${prefix}/definitions`, target.engineer)).body.definitions as any[];
      expect(list.find((item) => item.name === '线路牌').draft.sha256).toBe(created.body.sha256);
      const seen = await draftDocument(admin);
      expect(seen.reply.sha256).toBe(created.body.sha256);

      // 客户管理员改一个字段的显示名称、加一个字段；代建工程师读回、再删一个字段。
      const edited = seen.document;
      edited.displayName = '改过的线路牌';
      edited.fields.find((field: any) => field.name === 'fare').displayName = '票价';
      edited.fields.push({ name: 'extra', displayName: '新增', type: 'text' });
      const byAdmin = await save(admin, ROUTE_SIGN, text(edited), created.body.sha256);
      expect(byAdmin).toMatchObject({ status: 200, body: { updatedBy: target.admin.email } });
      const again = await draftDocument(target.engineer, ROUTE_SIGN, prefix);
      expect(again.reply.content).toBe(text(edited));
      again.document.fields = again.document.fields.filter((field: any) => field.name !== 'extra');
      const byEngineer = await save(target.engineer, ROUTE_SIGN, text(again.document), byAdmin.body.sha256, prefix);
      expect(byEngineer.status).toBe(200);
      expect(byEngineer.body.updatedBy).not.toBe(target.admin.email);
      expect((await check(target.engineer, ROUTE_SIGN, prefix)).sha256).toBe(byEngineer.body.sha256);
      // 还没写完的文档读不了时，差异只记整份。
      const broken = text({ dslVersion: 'renderweave-schema/1', name: '线路牌', fields: 'x' });
      const unfinished = await save(admin, ROUTE_SIGN, broken, byEngineer.body.sha256);
      expect(unfinished.status).toBe(200);
      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}/draft`, admin)).status).toBe(204);

      const [create] = await auditOf(admin, 'definitionDraft.create');
      expect(create).toMatchObject({
        actor: { kind: 'authoringToken' }, object: { type: 'definitionDraft', id: '线路牌' }, crossTenant: true, afterSha256: created.body.sha256,
        diff: { added: 1, removed: 0, changed: 0, paths: [{ path: 'definitionDraft:线路牌', change: 'added', afterSha256: created.body.sha256 }] },
      });
      expect(create).not.toHaveProperty('beforeSha256');
      const saves = (await auditOf(admin, 'definitionDraft.save')).reverse();
      expect(saves[0]).toMatchObject({
        actor: { kind: 'member', label: target.admin.email }, crossTenant: false, beforeSha256: created.body.sha256, afterSha256: byAdmin.body.sha256,
        diff: { added: 1, removed: 0, changed: 2, paths: expect.arrayContaining([
          { path: 'definition:displayName', change: 'changed' }, { path: 'field:fare', change: 'changed' }, { path: 'field:extra', change: 'added' },
        ]) },
      });
      expect(saves[1]).toMatchObject({
        actor: { kind: 'authoringToken' }, crossTenant: true, beforeSha256: byAdmin.body.sha256, afterSha256: byEngineer.body.sha256,
        diff: { added: 0, removed: 1, changed: 0, paths: [{ path: 'field:extra', change: 'removed' }] },
      });
      expect(saves[2]).toMatchObject({
        beforeSha256: byEngineer.body.sha256, afterSha256: unfinished.body.sha256,
        diff: { changed: 1, paths: [{ path: 'definitionDraft:线路牌', change: 'changed', beforeSha256: byEngineer.body.sha256, afterSha256: unfinished.body.sha256 }] },
      });
      const [removed] = await auditOf(admin, 'definitionDraft.delete');
      expect(removed).toMatchObject({ actor: { kind: 'member' }, crossTenant: false, beforeSha256: unfinished.body.sha256,
        diff: { removed: 1, paths: [{ path: 'definitionDraft:线路牌', change: 'removed', beforeSha256: unfinished.body.sha256 }] } });
      expect(removed).not.toHaveProperty('afterSha256');
      // 代建工程师的读取记审计，客户成员的不记。
      const reads = await auditOf(admin, 'authoring.read');
      expect(reads.filter((event) => event.object.type === 'definitionDraft').length).toBe(2);
      expect(reads.every((event) => event.actor.kind === 'authoringToken' && event.crossTenant)).toBe(true);
    });

    it('操作员与 API 密钥只读；代建令牌只认被指定的租户；别的租户的草案答 404', async () => {
      const target = await tenant(), other = await tenant(), token = target.admin.token;
      const draft = (await fromV1(token)).body;
      const content = (await draftDocument(token)).reply.content;
      const key = await world.call('POST', '/v1/api-keys', token, { name: '只读检查' });
      world.secrets.push(key.body.key);
      for (const reader of [target.operator.token, key.body.key as string]) {
        expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, reader)).status).toBe(200);
        expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft/check`, reader)).status).toBe(200);
        expect((await save(reader, ROUTE_SIGN, content, draft.sha256)).status).toBe(403);
        expect((await fromV1(reader, STOP)).status).toBe(403);
        expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}/draft`, reader)).status).toBe(403);
      }
      expect((await fromV1(other.engineer, ROUTE_SIGN, `/v1/authoring/tenants/${target.id}`)).status).toBe(404);
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/definitions`, other.engineer)).status).toBe(404);
      // 另一租户有同名的静态版本，也看不到、改不到这边的草案。
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/draft`, other.admin.token)).status).toBe(404);
      expect((await save(other.admin.token, ROUTE_SIGN, content, draft.sha256)).status).toBe(404);
      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}/draft`, other.admin.token)).status).toBe(404);
      expect((await draftDocument(token)).reply.sha256).toBe(draft.sha256);
    });
  });
}
