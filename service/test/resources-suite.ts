/**
 * 资源接口（票据 10，M152、M241）：上传、列出、读回、替换检查与应用替换。只经 HTTP 驱动。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 在 Docker 后端测试里跑。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { loadWorkspace, resourceImpact, type ResourceImpact, type Workspace } from '../src/engine.js';
import { createWorld, type World } from './api-suite.js';
import { M402_DIR, M402_RESOURCES, RESOURCES_DIR, seedM402 } from './seed.js';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const fixture = async (file: string) => new Uint8Array(await readFile(`${RESOURCES_DIR}${file}`));
/** 引用位置与本机检查比较：来源的写法不同（服务端是"种类:键"，本机是文件路径），比较种类、文档与 JSON Pointer。 */
const places = (references: readonly ResourceImpact[]) => references.map(({ kind, document, path }) => `${kind} ${document} ${path}`).sort();

export function describeResources(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`资源接口（${name}）`, () => {
    let world: World;
    /** 本机的 M402 工作区：服务的影响检查与引擎对它的检查比较。 */
    let m402: Workspace, m402Dataset: any;
    let image: Uint8Array, font: Uint8Array, replacement: Uint8Array;
    beforeAll(async () => {
      const backend = await makeBackend();
      world = await createWorld(backend);
      await seedM402(backend.tenant(world.b.id).storage);
      m402 = await loadWorkspace({ dir: M402_DIR, resourcesDir: RESOURCES_DIR });
      m402Dataset = JSON.parse(await readFile(`${M402_DIR}dataset-m402.json`, 'utf8'));
      [image, font, replacement] = await Promise.all([fixture('images/test/quadrants.png'), fixture('font-subsets/TestSubset-Medium.otf'), fixture('images/test/quadrants.webp')]);
    });

    const check = async (id: string, bytes = replacement) => {
      const reply = await world.call('POST', `/v1/resources/${id}/replacement-checks`, world.b.admin.token, bytes);
      expect(reply.status, reply.raw.slice(0, 500)).toBe(200);
      return reply.body;
    };
    const apply = (id: string, report: unknown) => world.call('POST', `/v1/resources/${id}/replacements`, world.b.admin.token, { check: report });
    const current = async (id: string) => (await world.call('GET', `/v1/resources/${id}`, world.b.admin.token)).body.currentVersion;

    it('上传新的图片与字体：得到资源 ID 与 v1，可以列出、查看与读回；同一 ID 不能再上传，种类创建后不能改', async () => {
      const { call, b } = world;
      const uploaded = await call('POST', '/v1/resources?kind=image&id=logo-new', b.operator.token, image);
      expect(uploaded).toMatchObject({ status: 201, body: { id: 'logo-new', kind: 'image', version: 1, sha256: sha256(image), byteLength: image.length } });
      // 不给 ID 时由服务生成；字体不做授权确认（M241）。
      const generated = await call('POST', '/v1/resources?kind=font', b.key.token, font);
      expect(generated).toMatchObject({ status: 201, body: { kind: 'font', version: 1, sha256: sha256(font), byteLength: font.length } });
      expect(generated.body.id).toMatch(/^font-[0-9a-f]{12}$/);

      const listed = await call('GET', '/v1/resources', b.operator.token);
      expect(listed.status).toBe(200);
      expect(listed.body.resources.map((resource: { id: string }) => resource.id)).toEqual([...M402_RESOURCES.map((resource) => resource.id), 'logo-new', generated.body.id].sort());
      const detail = { id: 'logo-new', kind: 'image', currentVersion: 1, versions: [{ version: 1, sha256: sha256(image), byteLength: image.length }] };
      expect(listed.body.resources.find((resource: { id: string }) => resource.id === 'logo-new')).toEqual(detail);
      expect(await call('GET', '/v1/resources/logo-new', b.key.token)).toMatchObject({ status: 200, body: detail });
      const content = await call('GET', '/v1/resources/logo-new/versions/1/content', b.operator.token);
      expect(content.status).toBe(200);
      expect(content.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      expect(content.bytes.equals(Buffer.from(image))).toBe(true);

      for (const kind of ['image', 'font']) {
        expect(await call('POST', `/v1/resources?kind=${kind}&id=logo-new`, b.operator.token, font))
          .toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate', location: { kind: 'input', source: 'request.query.id' } }] } });
      }
      expect(await call('GET', '/v1/resources/logo-new', b.operator.token)).toMatchObject({ body: detail });

      for (const query of ['?kind=video&id=x', '?id=x', '?kind=image&id=%E4%B8%AD%E6%96%87', '?kind=image&id=-x', '?kind=image&id=x&extra=1']) {
        expect(await call('POST', `/v1/resources${query}`, b.operator.token, image), query).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
      }
      expect((await call('POST', '/v1/resources?kind=image&id=empty', b.operator.token, new Uint8Array())).status).toBe(400);
      expect((await call('POST', '/v1/resources?kind=image&id=json', b.operator.token, { not: 'bytes' })).status).toBe(415);
      for (const url of ['/v1/resources/no-such', '/v1/resources/logo-new/versions/2/content', '/v1/resources/no-such/versions/1/content', '/v1/resources/logo-new/versions/x/content']) {
        expect((await call('GET', url, b.operator.token)).status, url).toBe(404);
      }

      // 上传的资源可以用在数据集的图片字段里；保存时核对资源的存在与种类。站点不带地标，后面的影响检查只看到样例数据集里的引用。
      const stops = [{ name: '起点', road: '深南路' }, { name: '终点', road: '东门路' }];
      const dataset = (id: string, ref: string) => JSON.stringify({ dataset: { ...m402Dataset.dataset, id }, data: { routeNo: 'M1', routeNoImage: ref, stops } });
      expect(await call('POST', '/v1/datasets', b.operator.token, dataset('ds-new-logo', 'res:logo-new'), { 'content-type': 'application/json' })).toMatchObject({ status: 201 });
      expect(await call('POST', '/v1/datasets', b.operator.token, dataset('ds-font-logo', `res:${generated.body.id}`), { 'content-type': 'application/json' }))
        .toMatchObject({ status: 400, body: { problems: [{ code: 'dataset.resourceKindMismatch', location: { kind: 'field', path: 'routeNoImage' } }] } });

      const events = (await call('GET', '/v1/audit-events?limit=500', b.admin.token)).body.events;
      expect(events.filter((event: { action: string }) => event.action === 'resource.upload').map((event: any) => [event.object.id, event.actor.kind]))
        .toEqual(expect.arrayContaining([['logo-new', 'member'], [generated.body.id, 'apiKey']]));
    });

    it('替换前先检查影响：受影响的模板、数据集与字体配置，与引擎对同一工作区的检查相同；检查不改资源', async () => {
      const { call, b } = world;
      for (const id of ['landmark-2', 'icon-metro', 'font-hei-medium', 'route-no-m402']) {
        const reply = await check(id);
        const local = resourceImpact(m402, id).impact!;
        expect(local.references.length + local.configuration.length, id).toBeGreaterThan(0);
        expect(places(reply.check.impact.references), id).toEqual(places(local.references));
        expect(reply.check.impact.configuration, id).toEqual(local.configuration);
        expect(reply.check.impact.renderOptions, id).toEqual(local.renderOptions);
        const resource = (await call('GET', `/v1/resources/${id}`, b.admin.token)).body;
        expect(reply.check, id).toMatchObject({
          resource: { id, kind: resource.kind, version: 1, sha256: resource.versions[0].sha256, byteLength: resource.versions[0].byteLength },
          replacement: { sha256: sha256(replacement), byteLength: replacement.length },
          impact: { workspaceFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/), scope: expect.any(String) },
        });
      }
      // 来源写成"种类:键"：数据集与模板各在哪里引用。
      expect((await check('landmark-2')).check.impact.references).toEqual(expect.arrayContaining([
        { kind: 'datasetImage', document: 'ds-m402-wanguocheng', source: 'dataset:ds-m402-wanguocheng', path: '/data/stops/3/landmark' },
      ]));
      expect((await check('font-hei-medium')).check.impact.configuration).toEqual([{ kind: 'fallbackFonts', path: '/fallbackFonts/1' }, { kind: 'svgFonts', path: '/svgFonts/1' }]);
      expect(await current('landmark-2')).toBe(1);
      expect((await call('POST', '/v1/resources/no-such/replacement-checks', b.admin.token, replacement)).status).toBe(404);
      expect((await call('POST', '/v1/resources/landmark-2/replacement-checks', b.admin.token, new Uint8Array())).status).toBe(400);
    });

    it('管理员凭检查报告应用：按预期版本提交得到 v2，旧版本内容保留；用过的、工作区已变化的报告被拒绝（M152）', async () => {
      const { call, b } = world;
      const original = await fixture('images/m402/landmark-1.png');
      const report = (await check('landmark-1')).check;
      for (const token of [b.operator.token, b.key.token]) {
        expect((await call('POST', '/v1/resources/landmark-1/replacement-checks', token, replacement)).status).toBe(403);
        expect((await call('POST', '/v1/resources/landmark-1/replacements', token, { check: report })).status).toBe(403);
      }
      const applied = await apply('landmark-1', report);
      expect(applied).toMatchObject({ status: 200, body: { id: 'landmark-1', kind: 'image', version: 2, sha256: sha256(replacement), byteLength: replacement.length } });
      expect((await call('GET', '/v1/resources/landmark-1/versions/1/content', b.operator.token)).bytes.equals(Buffer.from(original))).toBe(true);
      expect((await call('GET', '/v1/resources/landmark-1/versions/2/content', b.operator.token)).bytes.equals(Buffer.from(replacement))).toBe(true);
      expect((await call('GET', '/v1/resources/landmark-1', b.operator.token)).body).toMatchObject({ kind: 'image', currentVersion: 2 });

      const stale = { status: 409, body: { problems: [{ code: 'resource.replacementStale' }] } };
      expect(await apply('landmark-1', report)).toMatchObject(stale);
      expect(await current('landmark-1')).toBe(2);

      // 检查之后工作区变了（数据集改过）：报告过期，资源不变。
      const before = (await check('landmark-3')).check;
      const changed = JSON.stringify({ ...m402Dataset, data: { ...m402Dataset.data, serviceNote: '节假日运营' } });
      expect((await call('PUT', '/v1/datasets/ds-m402-wanguocheng', b.operator.token, changed, { 'content-type': 'application/json' })).status).toBe(200);
      expect(await apply('landmark-3', before)).toMatchObject(stale);
      expect(await current('landmark-3')).toBe(1);

      // 报告不属于路径里的资源、替换内容不在服务端、报告不完整：都拒绝。
      const fresh = (await check('landmark-4')).check;
      const invalid = { status: 400, body: { problems: [{ code: 'resource.replacementInvalid' }] } };
      expect(await apply('landmark-3', fresh)).toMatchObject(invalid);
      expect(await apply('landmark-4', { ...fresh, replacement: { sha256: '0'.repeat(64), byteLength: 3 } })).toMatchObject(invalid);
      expect(await apply('landmark-4', { ...fresh, replacement: { ...fresh.replacement, byteLength: fresh.replacement.byteLength + 1 } })).toMatchObject(invalid);
      expect(await apply('landmark-4', { ...fresh, resource: { ...fresh.resource, kind: 'font' } })).toMatchObject(invalid);
      expect(await apply('landmark-4', { resource: fresh.resource })).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid' }] } });
      expect((await apply('no-such', fresh)).status).toBe(404);
      expect(await current('landmark-4')).toBe(1);

      // 同一份报告同时应用两次：只有一次成功。
      const replies = await Promise.all([apply('landmark-4', fresh), apply('landmark-4', fresh)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
      expect(await current('landmark-4')).toBe(2);

      const events = (await call('GET', '/v1/audit-events?limit=500', b.admin.token)).body.events;
      expect(events.filter((event: { action: string }) => event.action === 'resource.replace').map((event: any) => [event.object.id, event.actor.id]).sort())
        .toEqual([['landmark-1', b.admin.id], ['landmark-4', b.admin.id]]);
    });
  });
}
