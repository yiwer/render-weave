/**
 * 数据定义（ADR-0030，P1 票据 04、17，验收 A02、A10）：只经开放 API 驱动——客户管理员与代建工程师各用自己的寻址，
 * 断言回答、问题清单、经 API 可见的列表与审计。同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { compileStaticSchema, localWorkspaceDocuments, publishStaticSchema, readWorkspaceDocuments } from '../src/engine.js';
import { backfillDefinitions } from '../src/postgres/data-steps.js';
import { createWorld, type World } from './api-suite.js';
import { M402_DIR, M402_FILES, seedDocuments } from './seed.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const JSON_TYPE = { 'content-type': 'application/json' };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const ROUTE_SIGN = encodeURIComponent('线路牌'), STOP = encodeURIComponent('停靠站点');

export function describeDefinitions(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`数据定义（${name}）`, () => {
    let world: World, backend: ServiceBackend;
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
    });

    /** 平台管理员新开一个租户：管理员、操作员、只指定给它的代建令牌，工作区是 M402 样例（线路牌 v1、停靠站点 v1、五个模板、一份数据集）。 */
    const tenant = async () => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `数据定义 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `代建工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      await seedDocuments(backend.tenant(id).storage, await Promise.all(M402_FILES.map(async (file) => new Uint8Array(await readFile(`${M402_DIR}${file}`)))));
      return { id, engineer: issued.body.token as string, admin: await world.member(id, 'admin'), operator: await world.member(id, 'operator') };
    };
    const save = (token: string, name: string, content: string, expected: string, prefix = '/v1') =>
      world.call('PUT', `${prefix}/definitions/${name}?expectedSha256=${expected}`, token, content, JSON_TYPE);
    /** 新建：name 写原文，不编码。 */
    const create = (token: string, body: Record<string, unknown>, prefix = '/v1') => world.call('POST', `${prefix}/definitions`, token, body);
    const current = (token: string, name = ROUTE_SIGN, prefix = '/v1') => world.call('GET', `${prefix}/definitions/${name}`, token);
    const draftDocument = async (token: string, name = ROUTE_SIGN, prefix = '/v1') => {
      const reply = await world.call('GET', `${prefix}/definitions/${name}`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return { reply: reply.body, document: JSON.parse(reply.body.content) };
    };
    const check = async (token: string, name = ROUTE_SIGN, prefix = '/v1') => {
      const reply = await world.call('GET', `${prefix}/definitions/${name}/check`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const auditOf = async (token: string, action: string) =>
      ((await world.call('GET', '/v1/audit-events?limit=500', token)).body.events as any[]).filter((event) => event.action === action);

    it('列表：每个数据定义的内容摘要、这个名称的静态版本与谁在用；显示名称与字段数来自它自己的内容，不是最新版本的', async () => {
      const target = await tenant();
      const list = async () => (await world.call('GET', '/v1/definitions', target.operator.token)).body.definitions as any[];
      const entry = (versions: unknown) => ({ displayName: expect.any(String), sha256: expect.any(String), byteLength: expect.any(Number), createdAt: expect.any(String), updatedAt: expect.any(String), updatedBy: '测试准备', fieldCount: expect.any(Number), versions });
      expect(await list()).toEqual([
        { name: '停靠站点', ...entry([{ version: 1, displayName: expect.any(String), datasets: 0, templates: 2 }]) },
        { name: '线路牌', ...entry([{ version: 1, displayName: expect.any(String), datasets: 1, templates: 1 }]) },
      ]);
      expect((await create(target.admin.token, { name: '新结构', displayName: '新结构显示名' })).status).toBe(201);
      const fresh = (await list()).find((item) => item.name === '新结构');
      expect(fresh).toMatchObject({ name: '新结构', displayName: '新结构显示名', fieldCount: 0, versions: [], updatedBy: target.admin.email });
      // 静态版本的字段数与引用深度，线路牌引用了停靠站点；来源都在。
      const schemas = (await world.call('GET', '/v1/static-schemas', target.admin.token)).body.staticSchemas as { name: string; displayName: string; fieldCount: number; referenceDepth: number; sourceDeleted: boolean }[];
      const [stops, line] = [schemas.find((schema) => schema.name === '停靠站点')!, schemas.find((schema) => schema.name === '线路牌')!];
      expect([stops.referenceDepth, line.referenceDepth]).toEqual([0, 1]);
      expect([stops.sourceDeleted, line.sourceDeleted]).toEqual([false, false]);
      expect(stops.fieldCount).toBeGreaterThan(0);
      const sign = (await list()).find((item) => item.name === '线路牌');
      expect(sign).toMatchObject({ displayName: line.displayName, fieldCount: line.fieldCount });
      // 改了显示名称没发布：列表上是数据定义自己的，静态版本还是原来的。
      const edited = JSON.parse((await current(target.admin.token)).body.content);
      expect((await save(target.admin.token, ROUTE_SIGN, text({ ...edited, displayName: '改过没发布' }), sign.sha256)).status).toBe(200);
      expect((await list()).find((item) => item.name === '线路牌')).toMatchObject({ displayName: '改过没发布' });
      expect((await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/1`, target.admin.token)).body.displayName).toBe(line.displayName);
      // 还没写成字段列表的也能列，只是没有字段数。
      const unfinished = await world.call('PUT', `/v1/definitions/${encodeURIComponent('新结构')}?expectedSha256=${fresh.sha256}`, target.admin.token, JSON.stringify({ name: '新结构', displayName: '没写完', fields: 'x' }), JSON_TYPE);
      expect(unfinished.status, unfinished.raw.slice(0, 300)).toBe(200);
      const relisted = (await list()).find((item) => item.name === '新结构');
      expect(relisted).toMatchObject({ displayName: '没写完' });
      expect(relisted).not.toHaveProperty('fieldCount');
    });

    it('新建：名称是主键。空白新建；复制静态版本要换名称、内容是原文去掉版本号；已有数据定义、有过静态版本、没有这一版、请求不合规都拒绝', async () => {
      const target = await tenant(), token = target.admin.token;
      // 推送来的线路牌本来就有数据定义：内容是静态版本去掉版本号，能直接改。
      const { reply, document } = await draftDocument(target.operator.token);
      const original = JSON.parse(await readFile(`${M402_DIR}schema-route-sign-v1.json`, 'utf8'));
      const { version: _version, ...withoutVersion } = original;
      expect(document).toEqual(withoutVersion);
      expect(sha256(reply.content)).toBe(reply.sha256);
      expect(Buffer.byteLength(reply.content)).toBe(reply.byteLength);
      // 名称已有数据定义，或有过静态版本：都不能再建。
      expect(await create(token, { name: '线路牌', displayName: '重名' })).toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate', location: { source: 'request.body.name' } }] } });
      expect(await create(token, { name: '线路牌', fromStatic: { name: '线路牌', version: 1 } })).toMatchObject({ status: 409 });
      // 复制静态版本：换名称，字段照抄。
      const copied = await create(token, { name: '线路牌副本', fromStatic: { name: '线路牌', version: 1 } });
      expect(copied).toMatchObject({ status: 201, body: { name: '线路牌副本', updatedBy: target.admin.email } });
      expect(copied.body).not.toHaveProperty('baseVersion');
      const copy = encodeURIComponent('线路牌副本');
      expect((await draftDocument(token, copy)).document).toEqual({ ...withoutVersion, name: '线路牌副本' });
      expect((await create(token, { name: '改了显示名称的副本', displayName: '新的显示名称', fromStatic: { name: '线路牌', version: 1 } })).status).toBe(201);
      expect((await draftDocument(token, encodeURIComponent('改了显示名称的副本'))).document).toMatchObject({ name: '改了显示名称的副本', displayName: '新的显示名称' });
      expect((await current(token, copy)).body.versions, '副本没有发布过，不继承版本').toEqual([]);
      expect(await create(token, { name: '再一个副本', fromStatic: { name: '线路牌', version: 9 } })).toMatchObject({ status: 404 });
      expect((await create(token, { name: '再一个副本', fromStatic: { name: '线路牌', version: 'UP' } })).status, '版本写法不对').toBe(400);
      // 空白新建。
      const blank = await create(token, { name: '全新结构', displayName: '全新结构' });
      expect(blank.status).toBe(201);
      expect((await draftDocument(token, encodeURIComponent('全新结构'))).document).toEqual({ dslVersion: 'renderweave-schema/1', name: '全新结构', displayName: '全新结构', fields: [] });
      for (const body of [{}, { name: '别的名称' }, { name: ' 首尾空白 ', displayName: 'x' }, { name: '别的名称', displayName: ' ' }, { displayName: 'x' }, { name: '别的名称', fromVersion: 1 }]) {
        expect((await create(token, body)).status, JSON.stringify(body)).toBe(400);
      }
    });

    it('存量补齐（M389）：只有静态版本的名称补一个数据定义，内容是最新版本去掉版本号；已有的不动，补过再跑不多写', async () => {
      const target = await tenant(), token = target.admin.token, storage = backend.tenant(target.id).storage;
      const edited = await draftDocument(token);
      // 发布两版，最新的是字符串版本：按登记的先后，不按版本的大小。
      const saved = await save(token, ROUTE_SIGN, text({ ...edited.document, displayName: '第二版' }), edited.reply.sha256);
      expect((await world.call('POST', `/v1/definitions/${ROUTE_SIGN}/publish`, token, { expectedSha256: saved.body.sha256, version: 'a-tag' })).status).toBe(201);
      // 回到迁移之前的样子：线路牌没有数据定义；停靠站点的留着并改过。
      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}`, token)).status).toBe(204);
      const stop = await draftDocument(token, STOP);
      const keep = await save(token, STOP, text({ ...stop.document, displayName: '不该被覆盖' }), stop.reply.sha256);

      expect(await backfillDefinitions(storage)).toBe(1);
      const filled = await draftDocument(token);
      expect(filled.document).toEqual({ ...edited.document, displayName: '第二版' });
      expect(filled.document).not.toHaveProperty('version');
      expect(filled.reply.updatedBy).toBe('部署步骤');
      expect((await current(token, STOP)).body.sha256).toBe(keep.body.sha256);
      expect(await backfillDefinitions(storage), '再跑一遍不多写').toBe(0);
    });

    it('保存：整份替换，按原始字节存，带预期哈希，不符答 409 并给当前哈希，内容不变；请求不合规答 400', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await current(token)).body;
      const { document } = await draftDocument(token);
      // 键的顺序、缩进与行尾都照原样。
      const edited = `{"fields":[${JSON.stringify(document.fields[0])}],\n\t"dslVersion":"renderweave-schema/1", "name":"线路牌","displayName":"改过的线路牌"}\r\n`;
      const saved = await save(token, ROUTE_SIGN, edited, first.sha256);
      expect(saved).toMatchObject({ status: 200, body: { name: '线路牌', sha256: sha256(edited), byteLength: Buffer.byteLength(edited), createdAt: first.createdAt } });
      expect((await draftDocument(token)).reply.content).toBe(edited);
      // 还是旧哈希：别人先保存了。
      const stale = await save(token, ROUTE_SIGN, text(document), first.sha256);
      expect(stale).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale', location: { source: 'request.querystring.expectedSha256' } }], currentSha256: sha256(edited) } });
      expect((await draftDocument(token)).reply.content).toBe(edited);
      // 没写完的也能存：问题由校验回答。
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
      expect((await world.call('PUT', `/v1/definitions/${ROUTE_SIGN}`, token, unfinished, JSON_TYPE)).status, '要带预期哈希').toBe(400);
      expect((await world.call('PUT', `/v1/definitions/${ROUTE_SIGN}?expectedSha256=${stored.body.sha256}`, token, new Uint8Array(Buffer.from(unfinished)))).status, '媒体类型').toBe(415);
      expect((await world.call('PUT', `/v1/authoring/tenants/${target.id}/definitions/${ROUTE_SIGN}?expectedSha256=${stored.body.sha256}`, target.engineer, new Uint8Array(Buffer.from(unfinished)))).status, '代建端点的媒体类型').toBe(415);
      expect((await save(token, ROUTE_SIGN, ' '.repeat(1024 * 1024 + 1), stored.body.sha256)).status).toBe(413);
      expect((await save(token, encodeURIComponent('没有这个'), unfinished, stored.body.sha256)).status, '没有这个数据定义').toBe(404);
      // 重复保存相同内容不报错，审计的差异是空的。
      expect((await save(token, ROUTE_SIGN, unfinished, stored.body.sha256)).status).toBe(200);
    });

    it('校验：问题定位到字段，有严重问题时没有编译产物；编译预览与本地发布的产物相同；引用不存在、版本号写错都报', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await current(token)).body;
      const clean = await check(target.operator.token);
      const workspace = await readWorkspaceDocuments(localWorkspaceDocuments(M402_DIR));
      const local = publishStaticSchema(JSON.parse((await draftDocument(token)).reply.content), workspace.staticSchemas);
      expect(clean).toEqual({ sha256: first.sha256, baseVersion: 1, problems: [], version: 2, compiled: local.published!.compiled, affectedBindings: [] });
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

    it('与最新版本相比，删除与改名的字段列为会影响绑定，带用到它们的模板；没用到的字段模板为空，没发布过的没有基准', async () => {
      const target = await tenant(), token = target.admin.token;
      const first = (await current(token)).body;
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
      const stop = (await current(token, STOP)).body;
      const stopDocument = (await draftDocument(token, STOP)).document;
      stopDocument.fields = stopDocument.fields.filter((field: any) => field.name !== 'landmark');
      expect((await save(token, STOP, text(stopDocument), stop.sha256)).status).toBe(200);
      const affected = (await check(token, STOP)).affectedBindings as any[];
      expect(affected).toEqual([{ field: 'landmark', templates: expect.arrayContaining([{ name: '标准线路单边', base: { name: '线路牌', version: 1 } }]) }]);

      // 没有模板用到的字段：照样列出，模板为空。
      const { published } = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '无人使用', displayName: '无人使用', fields: [{ name: 'unused', displayName: '没人用', type: 'text' }] }, []);
      await seedDocuments(backend.tenant(target.id).storage, [published!.definition, published!.compiled].map((value) => new Uint8Array(Buffer.from(text(value)))));
      const nobody = encodeURIComponent('无人使用');
      const draft = (await current(token, nobody)).body, nobodyDocument = (await draftDocument(token, nobody)).document;
      expect((await save(token, nobody, text({ ...nobodyDocument, fields: [] }), draft.sha256)).status).toBe(200);
      expect((await check(token, nobody)).affectedBindings).toEqual([{ field: 'unused', templates: [] }]);

      // 没发布过的没有基准。
      const blank = encodeURIComponent('全新结构');
      await create(token, { name: '全新结构', displayName: '全新结构' });
      expect((await check(token, blank)).affectedBindings).toEqual([]);
    });

    it('删除：静态版本不受影响，标来源已删除；名称不能再用；数据定义不进工作区：静态数据定义列表与工作区都看不到，模板照旧', async () => {
      const target = await tenant(), token = target.admin.token;
      const schemasBefore = (await world.call('GET', '/v1/static-schemas', token)).raw;
      const before = await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer);
      const blank = encodeURIComponent('只是定义');
      await create(token, { name: '只是定义', displayName: '只是定义' });
      expect((await world.call('GET', '/v1/static-schemas', token)).raw).toBe(schemasBefore);
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).raw).toBe(before.raw);
      expect((await world.call('GET', `/v1/static-schemas/${blank}/versions/1`, token)).status).toBe(404);

      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}`, token)).status).toBe(204);
      expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}`, token)).status).toBe(404);
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}`, token)).status).toBe(404);
      expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/check`, token)).status).toBe(404);
      const list = (await world.call('GET', '/v1/definitions', token)).body.definitions as any[];
      expect(list.some((item) => item.name === '线路牌'), '列表上没有了').toBe(false);
      // 静态版本照常能用，标来源已删除；工作区不变。
      const v1 = await world.call('GET', `/v1/static-schemas/${ROUTE_SIGN}/versions/1`, token);
      expect(v1).toMatchObject({ status: 200, body: { name: '线路牌', version: 1, sourceDeleted: true } });
      const schemas = (await world.call('GET', '/v1/static-schemas', token)).body.staticSchemas as any[];
      expect(schemas.find((schema) => schema.name === '线路牌')).toMatchObject({ sourceDeleted: true });
      expect(schemas.find((schema) => schema.name === '停靠站点')).toMatchObject({ sourceDeleted: false });
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).raw).toBe(before.raw);
      // 有过静态版本的名称不能再建：新的数据定义会把旧版本认成自己的。要接着用就复制成新名称。
      expect(await create(token, { name: '线路牌', displayName: '重建' })).toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate' }] } });
      expect((await create(token, { name: '线路牌二', fromStatic: { name: '线路牌', version: 1 } })).status).toBe(201);
      // 没发布过的删了，名称可以再用。
      expect((await world.call('DELETE', `/v1/definitions/${blank}`, token)).status).toBe(204);
      expect((await create(token, { name: '只是定义', displayName: '再建一次' })).status).toBe(201);
    });

    it('两种寻址共用一份实现：代建工程师写的客户管理员看得到，反之亦然；每次写入记审计，带前后内容哈希与差异摘要，代建的另标跨租户', async () => {
      const target = await tenant(), admin = target.admin.token, prefix = `/v1/authoring/tenants/${target.id}`;
      const COPY = encodeURIComponent('线路牌副本');
      const created = await create(target.engineer, { name: '线路牌副本', fromStatic: { name: '线路牌', version: 1 } }, prefix);
      expect(created.status, created.raw.slice(0, 300)).toBe(201);
      const list = (await world.call('GET', `${prefix}/definitions`, target.engineer)).body.definitions as any[];
      expect(list.find((item) => item.name === '线路牌副本').sha256).toBe(created.body.sha256);
      const seen = await draftDocument(admin, COPY);
      expect(seen.reply.sha256).toBe(created.body.sha256);

      // 客户管理员改一个字段的显示名称、加一个字段；代建工程师读回、再删一个字段。
      const edited = seen.document;
      edited.displayName = '改过的线路牌';
      edited.fields.find((field: any) => field.name === 'fare').displayName = '票价';
      edited.fields.push({ name: 'extra', displayName: '新增', type: 'text' });
      const byAdmin = await save(admin, COPY, text(edited), created.body.sha256);
      expect(byAdmin).toMatchObject({ status: 200, body: { updatedBy: target.admin.email } });
      const again = await draftDocument(target.engineer, COPY, prefix);
      expect(again.reply.content).toBe(text(edited));
      again.document.fields = again.document.fields.filter((field: any) => field.name !== 'extra');
      const byEngineer = await save(target.engineer, COPY, text(again.document), byAdmin.body.sha256, prefix);
      expect(byEngineer.status).toBe(200);
      expect(byEngineer.body.updatedBy).not.toBe(target.admin.email);
      expect((await check(target.engineer, COPY, prefix)).sha256).toBe(byEngineer.body.sha256);
      // 还没写完的文档读不了时，差异只记整份。
      const broken = text({ dslVersion: 'renderweave-schema/1', name: '线路牌副本', fields: 'x' });
      const unfinished = await save(admin, COPY, broken, byEngineer.body.sha256);
      expect(unfinished.status).toBe(200);
      expect((await world.call('DELETE', `/v1/definitions/${COPY}`, admin)).status).toBe(204);

      const [createEvent] = await auditOf(admin, 'definition.create');
      expect(createEvent).toMatchObject({
        actor: { kind: 'authoringToken' }, object: { type: 'definition', id: '线路牌副本' }, crossTenant: true, afterSha256: created.body.sha256,
        diff: { added: 1, removed: 0, changed: 0, paths: [{ path: 'schema:线路牌副本', change: 'added', afterSha256: created.body.sha256 }] },
      });
      expect(createEvent).not.toHaveProperty('beforeSha256');
      const saves = (await auditOf(admin, 'definition.save')).reverse();
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
        diff: { changed: 1, paths: [{ path: 'schema:线路牌副本', change: 'changed', beforeSha256: byEngineer.body.sha256, afterSha256: unfinished.body.sha256 }] },
      });
      const [removed] = await auditOf(admin, 'definition.delete');
      expect(removed).toMatchObject({ actor: { kind: 'member' }, crossTenant: false, beforeSha256: unfinished.body.sha256,
        diff: { removed: 1, paths: [{ path: 'schema:线路牌副本', change: 'removed', beforeSha256: unfinished.body.sha256 }] } });
      expect(removed).not.toHaveProperty('afterSha256');
      // 代建工程师的读取记审计，客户成员的不记。
      const reads = await auditOf(admin, 'authoring.read');
      expect(reads.filter((event) => event.object.type === 'definition').length).toBe(2);
      expect(reads.every((event) => event.actor.kind === 'authoringToken' && event.crossTenant)).toBe(true);
    });

    it('操作员与 API 密钥只读；代建令牌只认被指定的租户；别的租户的数据定义答 404', async () => {
      const target = await tenant(), other = await tenant(), token = target.admin.token;
      const draft = (await current(token)).body;
      const content = (await draftDocument(token)).reply.content;
      const key = await world.call('POST', '/v1/api-keys', token, { name: '只读检查' });
      world.secrets.push(key.body.key);
      for (const reader of [target.operator.token, key.body.key as string]) {
        expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}`, reader)).status).toBe(200);
        expect((await world.call('GET', `/v1/definitions/${ROUTE_SIGN}/check`, reader)).status).toBe(200);
        expect((await save(reader, ROUTE_SIGN, content, draft.sha256)).status).toBe(403);
        expect((await create(reader, { name: '不让建', displayName: '不让建' })).status).toBe(403);
        expect((await world.call('DELETE', `/v1/definitions/${ROUTE_SIGN}`, reader)).status).toBe(403);
      }
      expect((await create(other.engineer, { name: '不让建', displayName: '不让建' }, `/v1/authoring/tenants/${target.id}`)).status).toBe(404);
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/definitions`, other.engineer)).status).toBe(404);
      // 这边新建的名称，另一租户看不到、改不到。
      const mine = encodeURIComponent('只有这边有');
      const only = (await create(token, { name: '只有这边有', displayName: '只有这边有' })).body;
      expect((await world.call('GET', `/v1/definitions/${mine}`, other.admin.token)).status).toBe(404);
      expect((await save(other.admin.token, mine, content, only.sha256)).status).toBe(404);
      expect((await world.call('DELETE', `/v1/definitions/${mine}`, other.admin.token)).status).toBe(404);
      expect((await current(token, mine)).body.sha256).toBe(only.sha256);
    });
  });
}
