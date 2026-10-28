/**
 * 审计的内容哈希、差异摘要、筛选与 CSV 导出（P1 票据 03，M347、ADR-0022）：只经开放 API 驱动——
 * 代建工程师按内容哈希上传、推送两次、再指回旧修订，客户管理员从审计接口与 CSV 导出读回断言。
 * 同一组用例跑两种后端：内存后端进 npm test，PostgreSQL 加 S3 后端在 Docker 后端测试里跑（行级安全另见 rls.docker.test.ts）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { createWorld, type World } from './api-suite.js';

const FIXTURE = new URL('../../fixtures/workspaces/single-text/', import.meta.url);
const PNG = fileURLToPath(new URL('../../fixtures/resources/images/test/quadrants.png', import.meta.url));
const DOCUMENTS = [
  { kind: 'definition', key: '问候@1', file: 'schema-greeting-v1.json' },
  { kind: 'compiled', key: '问候@1', file: 'compiled-greeting-v1.schema.json' },
  { kind: 'template', key: '问候牌', file: 'template-greeting.json' },
  { kind: 'dataset', key: 'ds-greeting', file: 'dataset-greeting.json' },
] as const;
const HOUR = 3_600_000;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const content = (bytes: Uint8Array) => ({ sha256: sha256(bytes), byteLength: bytes.length });

/** RFC 4180 的 CSV：引号里的逗号、换行与成对的引号。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell); cell = ''; }
    else if (char === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += char;
  }
  return rows;
}

export function describeAudit(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`审计的内容哈希与导出（${name}）`, () => {
    let world: World;
    beforeAll(async () => { world = await createWorld(await makeBackend()); });

    /** 平台管理员新开一个租户：一位客户管理员与只指定给它的代建令牌。 */
    const tenant = async (label = `代建工程师 ${randomUUID().slice(0, 8)}`) => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `审计 ${randomUUID().slice(0, 8)}` });
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label, tenantIds: [created.body.id] });
      world.secrets.push(issued.body.token);
      return { id: created.body.id as string, engineer: issued.body.token as string, admin: await world.member(created.body.id, 'admin') };
    };
    /** 代建工程师按内容哈希上传，再提交一次推送。 */
    const push = async (target: { id: string; engineer: string }, documents: readonly { kind: string; key: string; bytes: Uint8Array }[],
      resources: readonly { id: string; versions: readonly Uint8Array[] }[]) => {
      for (const bytes of [...documents.map((document) => document.bytes), ...resources.flatMap((resource) => resource.versions)]) {
        expect((await world.call('PUT', `/v1/authoring/tenants/${target.id}/contents/${sha256(bytes)}`, target.engineer, bytes)).status).toBe(204);
      }
      const reply = await world.call('POST', `/v1/authoring/tenants/${target.id}/pushes`, target.engineer, {
        documents: documents.map(({ kind, key, bytes }) => ({ kind, key, ...content(bytes) })),
        resources: resources.map(({ id, versions }) => ({ id, kind: 'image', versions: versions.map((bytes, i) => ({ version: i + 1, ...content(bytes) })) })),
      });
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const events = async (token: string, query = '') => {
      const reply = await world.call('GET', `/v1/audit-events?limit=500${query}`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body.events as any[];
    };

    it('推送提交与指回旧修订记前后内容哈希与差异摘要；别的事件没有这些字段；跨租户照旧标出', async () => {
      const target = await tenant();
      const files = await Promise.all(DOCUMENTS.map(async (document) => ({ ...document, bytes: new Uint8Array(await readFile(new URL(document.file, FIXTURE))) })));
      const template = files.find((file) => file.kind === 'template')!.bytes;
      const edited = new Uint8Array(Buffer.from(Buffer.from(template).toString('utf8').replace('#FFF4E0', '#E0F4FF')));
      const logo = new Uint8Array(await readFile(PNG)), logo2 = new Uint8Array(Buffer.concat([Buffer.from(logo), Buffer.from('第二版')]));

      const first = await push(target, files, [{ id: 'logo', versions: [logo] }]);
      expect(first.summary).toEqual({ added: 5, updated: 0, unchanged: 0, conflicts: 0 });
      const second = await push(target, files.map((file) => (file.kind === 'template' ? { ...file, bytes: edited } : file)), [{ id: 'logo', versions: [logo, logo2] }]);
      expect(second.summary).toEqual({ added: 0, updated: 2, unchanged: 3, conflicts: 0 });
      const back = await world.call('POST', `/v1/authoring/tenants/${target.id}/template-current`, target.engineer, { template: '问候牌', revision: 1 });
      expect(back.status).toBe(200);

      const all = await events(target.admin.token);
      const commits = all.filter((event) => event.action === 'push.commit').reverse();
      expect(commits).toHaveLength(2);
      expect(commits[0]).toMatchObject({ tenantId: target.id, actor: { kind: 'authoringToken' }, object: { type: 'push', id: first.pushId }, crossTenant: true });
      expect(commits[0].diff).toEqual({
        added: 5, removed: 0, changed: 0,
        paths: [
          ...files.filter((file) => file.kind !== 'template').map((file) => ({ path: `${file.kind}:${file.key}`, change: 'added', afterSha256: sha256(file.bytes) })),
          { path: 'template:问候牌', change: 'added', afterSha256: sha256(template) },
          { path: 'resource:logo', change: 'added', afterSha256: sha256(logo) },
        ],
      });
      expect(commits[1]).toMatchObject({ object: { type: 'push', id: second.pushId }, crossTenant: true });
      expect(commits[1].diff).toEqual({
        added: 0, removed: 0, changed: 2,
        paths: [
          { path: 'template:问候牌', change: 'changed', beforeSha256: sha256(template), afterSha256: sha256(edited) },
          { path: 'resource:logo', change: 'changed', beforeSha256: sha256(logo), afterSha256: sha256(logo2) },
        ],
      });
      // 推送提交的前后哈希在差异摘要的每一项里，事件本身不填。
      for (const commit of commits) expect(commit).not.toHaveProperty('beforeSha256');

      const [setCurrent] = all.filter((event) => event.action === 'template.setCurrent');
      expect(setCurrent).toEqual({
        id: expect.any(String), tenantId: target.id, at: expect.any(String), actor: { kind: 'authoringToken', id: expect.any(String), label: expect.any(String) },
        action: 'template.setCurrent', object: { type: 'template', id: '问候牌' }, crossTenant: true,
        beforeSha256: sha256(edited), afterSha256: sha256(template),
        diff: { added: 0, removed: 0, changed: 1, paths: [{ path: 'template:问候牌', change: 'changed', beforeSha256: sha256(edited), afterSha256: sha256(template) }] },
      });
      // 导出的差异路径按写入的原文，两种后端逐字相同（键的顺序不变）。
      const [header, ...rows] = parseCsv((await world.call('GET', '/v1/audit-events/export.csv?actorKind=authoringToken', target.admin.token)).raw.slice(1));
      expect(rows.find((row) => row[0] === setCurrent.id)![header!.indexOf('diffPaths')])
        .toBe(`[{"path":"template:问候牌","change":"changed","beforeSha256":"${sha256(edited)}","afterSha256":"${sha256(template)}"}]`);

      // 不是代建写入的事件（登录、开通、上传内容、推送前比对）没有这些字段。
      const plain = all.filter((event) => !['push.commit', 'template.setCurrent'].includes(event.action));
      expect(plain.map((event) => event.action)).toEqual(expect.arrayContaining(['tenant.create', 'member.create', 'session.create', 'content.upload']));
      for (const field of ['beforeSha256', 'afterSha256', 'diff', 'round', 'reason']) expect(plain.filter((event) => field in event), field).toEqual([]);

      // 别的租户的管理员看不到这些写入，也导不出来。
      const hashes = [sha256(template), sha256(edited), sha256(logo2)];
      const other = [JSON.stringify(await events(world.b.admin.token)), (await world.call('GET', '/v1/audit-events/export.csv', world.b.admin.token)).raw];
      for (const text of other) for (const hash of hashes) expect(text).not.toContain(hash);
    });

    it('差异摘要的路径至多 50 项，计数是全部的', async () => {
      const target = await tenant();
      const datasets = Array.from({ length: 55 }, (_, i) => ({ kind: 'dataset', key: `ds-${String(i).padStart(2, '0')}`,
        bytes: new Uint8Array(Buffer.from(JSON.stringify({
          dataset: { id: `ds-${String(i).padStart(2, '0')}`, name: `第 ${i} 份`, staticSchema: { name: '问候', version: 1 }, origin: { kind: 'manual' } }, data: { message: `第 ${i} 份` },
        }))) }));
      const pushed = await push(target, datasets, []);
      expect(pushed.summary.added).toBe(55);
      const [commit] = (await events(target.admin.token)).filter((event) => event.action === 'push.commit');
      expect(commit.diff).toMatchObject({ added: 55, removed: 0, changed: 0 });
      expect(commit.diff.paths).toHaveLength(50);
      expect(commit.diff.paths[49]).toEqual({ path: 'dataset:ds-49', change: 'added', afterSha256: sha256(datasets[49]!.bytes) });
    });

    it('按主体种类与时间筛选（from 含、to 不含），可以翻页；筛选条件不合规答 400', async () => {
      // 环境的时钟不走：开通、登录都记在 base，两次推送拨到 1 小时、2 小时之后（会话 12 小时内仍有效）。
      const base = world.clock.value.getTime();
      const target = await tenant();
      const bytes = new Uint8Array(await readFile(new URL('template-greeting.json', FIXTURE)));
      world.clock.value = new Date(base + HOUR);
      await push(target, [{ kind: 'template', key: '问候牌', bytes }], []);
      world.clock.value = new Date(base + 2 * HOUR);
      await push(target, [{ kind: 'template', key: '问候牌', bytes: new Uint8Array(Buffer.concat([Buffer.from(bytes), Buffer.from('\n')])) }], []);

      const kinds = async (query: string) => new Set((await events(target.admin.token, query)).map((event) => event.actor.kind));
      expect(await kinds('')).toEqual(new Set(['platformUser', 'member', 'authoringToken']));
      for (const kind of ['platformUser', 'member', 'authoringToken']) expect(await kinds(`&actorKind=${kind}`)).toEqual(new Set([kind]));
      expect(await events(target.admin.token, '&actorKind=apiKey')).toEqual([]);

      const at = (offset: number) => encodeURIComponent(new Date(base + offset).toISOString());
      const commits = async (query: string) => (await events(target.admin.token, query)).filter((event) => event.action === 'push.commit').map((event) => event.at);
      expect(await commits(`&from=${at(HOUR)}`)).toEqual([new Date(base + 2 * HOUR).toISOString(), new Date(base + HOUR).toISOString()]);
      expect(await commits(`&from=${at(HOUR + 1)}`)).toEqual([new Date(base + 2 * HOUR).toISOString()]);
      expect(await commits(`&to=${at(2 * HOUR)}`)).toEqual([new Date(base + HOUR).toISOString()]);
      expect(await commits(`&actorKind=authoringToken&from=${at(HOUR)}&to=${at(2 * HOUR)}`)).toHaveLength(1);
      expect((await events(target.admin.token, `&to=${at(0)}`))).toEqual([]);

      // 带筛选翻页：一页一条，翻完与一次读出的相同。
      const seen: string[] = [];
      let next: string | undefined;
      do {
        const page = await world.call('GET', `/v1/audit-events?limit=1&actorKind=authoringToken${next ? `&before=${next}` : ''}`, target.admin.token);
        seen.push(...page.body.events.map((event: { id: string }) => event.id));
        next = page.body.next;
      } while (next);
      expect(seen).toEqual((await events(target.admin.token, '&actorKind=authoringToken')).map((event) => event.id));

      for (const query of ['actorKind=robot', 'from=2031-03-01', 'to=yesterday', 'actorKind=']) {
        expect((await world.call('GET', `/v1/audit-events?${query}`, target.admin.token)).status, query).toBe(400);
        expect((await world.call('GET', `/v1/audit-events/export.csv?${query}`, target.admin.token)).status, query).toBe(400);
      }
      world.clock.value = new Date(base);
    });

    it('筛选结果导出为 CSV：列与审计接口一致，差异的路径是 JSON；以公式字符开头的格子加单引号；操作员与 API 密钥不能导出', async () => {
      const target = await tenant('=HYPERLINK("https://example.com","点我")');
      const bytes = new Uint8Array(await readFile(new URL('template-greeting.json', FIXTURE)));
      await push(target, [{ kind: 'template', key: '问候牌', bytes }], []);
      const listed = await events(target.admin.token, '&actorKind=authoringToken');

      const reply = await world.call('GET', '/v1/audit-events/export.csv?actorKind=authoringToken', target.admin.token);
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(reply.headers['content-disposition']).toBe('attachment; filename="audit-events.csv"');
      expect(reply.raw.startsWith('\uFEFF')).toBe(true);
      expect(reply.raw.endsWith('\r\n')).toBe(true);
      const [header, ...rows] = parseCsv(reply.raw.slice(1));
      expect(header).toEqual(['id', 'at', 'actorKind', 'actorId', 'actorLabel', 'action', 'objectType', 'objectId', 'crossTenant',
        'beforeSha256', 'afterSha256', 'diffAdded', 'diffRemoved', 'diffChanged', 'diffPaths', 'round', 'reason']);
      expect(rows.map((row) => row[0])).toEqual(listed.map((event) => event.id));
      const record = (row: string[]) => Object.fromEntries(header!.map((name, i) => [name, row[i]]));
      for (const [i, event] of listed.entries()) {
        const row = record(rows[i]!);
        expect(row).toMatchObject({ at: event.at, actorKind: 'authoringToken', actorId: event.actor.id, action: event.action, objectType: event.object.type,
          objectId: event.object.id, crossTenant: 'true', round: '', reason: '' });
        expect(row['actorLabel']).toBe(`'${event.actor.label}`);
      }
      const commit = listed.find((event) => event.action === 'push.commit');
      expect(record(rows[listed.indexOf(commit)]!)).toMatchObject({ beforeSha256: '', afterSha256: '', diffAdded: '1', diffRemoved: '0', diffChanged: '0',
        diffPaths: JSON.stringify(commit.diff.paths) });
      expect(JSON.parse(record(rows[listed.indexOf(commit)]!)['diffPaths']!)).toEqual([{ path: 'template:问候牌', change: 'added', afterSha256: sha256(bytes) }]);

      // 不带筛选导出的是本租户全部事件；操作员、API 密钥与代建令牌不能导出。
      const everything = parseCsv((await world.call('GET', '/v1/audit-events/export.csv', target.admin.token)).raw.slice(1)).slice(1);
      expect(everything.map((row) => row[0])).toEqual((await events(target.admin.token)).map((event) => event.id));
      for (const token of [world.a.operator.token, world.a.key.token]) expect((await world.call('GET', '/v1/audit-events/export.csv', token)).status).toBe(403);
      expect((await world.call('GET', '/v1/audit-events/export.csv', target.engineer)).status).toBe(403);
    });
  });
}
