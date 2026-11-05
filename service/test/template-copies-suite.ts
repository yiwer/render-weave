/**
 * 模板工作副本（P1 票据 07，验收 A05、A10）：只经开放 API 驱动——暂存、预览、复制、保存与指回，断言回答、问题清单、修订与审计。
 * 同一组用例跑两种后端：内存后端加进程内 worker 进 npm test；PostgreSQL 加 S3 在 Docker 后端测试里跑，预览由 Compose 里的 worker 渲染。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend, TenantStorage } from '../src/backend.js';
import { loadWorkspace, render } from '../src/engine.js';
import { inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { greetingPreview, M402_DIR, RESOURCES_DIR, seedGreeting, seedM402, SINGLE_TEXT } from './seed.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const JSON_TYPE = { 'content-type': 'application/json' };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const GREETING = encodeURIComponent('问候牌'), STOP = encodeURIComponent('站点');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;

export function describeTemplateCopies(name: string, makeBackend: () => Promise<ServiceBackend>, options: { readonly inProcessWorker: boolean }): void {
  describe(`模板工作副本（${name}）`, () => {
    let world: World, backend: ServiceBackend, scheduler: Scheduler | undefined;
    beforeAll(async () => {
      backend = await makeBackend();
      world = await createWorld(backend);
      if (options.inProcessWorker) scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'template-copies', build: 'sha256:test', leaseMs: 60_000 });
    });
    afterAll(async () => { await scheduler?.stop(); });

    const tenant = async (seed: (storage: TenantStorage) => Promise<void> = (storage) => seedGreeting(storage, { withFont: true })) => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `工作副本 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `代建工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      await seed(backend.tenant(id).storage);
      return { id, engineer: issued.body.token as string, admin: await world.member(id, 'admin'), operator: await world.member(id, 'operator') };
    };
    const open = (token: string, template = GREETING, prefix = '/v1') => world.call('POST', `${prefix}/templates/${template}/working-copy`, token);
    const documentOf = async (token: string, template = GREETING, prefix = '/v1') => JSON.parse((await world.call('GET', `${prefix}/templates/${template}/working-copy`, token)).body.content);
    const stash = (token: string, document: unknown, expected: string, template = GREETING, prefix = '/v1') =>
      world.call('PUT', `${prefix}/templates/${template}/working-copy?expectedSha256=${expected}`, token, typeof document === 'string' ? document : text(document), JSON_TYPE);
    const save = (token: string, expectedSha256: string, extra: Record<string, unknown> = {}, template = GREETING, prefix = '/v1') =>
      world.call('POST', `${prefix}/templates/${template}/working-copy/save`, token, { expectedSha256, ...extra });
    const check = async (token: string, template = GREETING, prefix = '/v1') => {
      const reply = await world.call('GET', `${prefix}/templates/${template}/working-copy/check`, token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const revisions = async (token: string, template = GREETING) => (await world.call('GET', `/v1/templates/${template}/revisions`, token)).body;
    const preview = async (token: string, body: unknown, query = '') => {
      const reply = await world.call('POST', `/v1/previews${query}`, token, body);
      expect(reply.status, reply.raw.slice(0, 500)).toBe(200);
      return reply.body;
    };
    /** 模板的底色换成另一种，预览图随之不同。 */
    const recolored = (document: any, color = '#E0F4FF') => JSON.parse(JSON.stringify(document).replace('#FFF4E0', color));
    const auditOf = async (token: string, action: string) => ((await world.call('GET', '/v1/audit-events?limit=500', token)).body.events as any[]).filter((event) => event.action === action);
    /** 工作副本基于修订 1，改好底色。 */
    const editedCopy = async (token: string, color?: string) => {
      const copy = (await open(token)).body, document = recolored(await documentOf(token), color);
      const stashed = await stash(token, document, copy.sha256);
      expect(stashed.status, stashed.raw.slice(0, 300)).toBe(200);
      return { document, sha256: stashed.body.sha256 as string };
    };

    it('预览照旧忽略不认识的查询参数：加了 workingCopies 不改变已有请求的回答（只做加法）', async () => {
      const target = await tenant();
      const reply = await preview(target.operator.token, greetingPreview(), '?somethingElse=1');
      expect(reply.image).toBeDefined();
    });

    it('新建记基准修订，暂存整份替换、按原始字节存、带预期哈希；每个模板至多一份；可以丢弃；不合规答 400', async () => {
      const target = await tenant(), token = target.admin.token;
      expect((await open(token, encodeURIComponent('没有这个模板'))).status).toBe(404);
      const copy = await open(token);
      expect(copy).toMatchObject({ status: 201, body: { name: '问候牌', baseRevision: 1, updatedBy: target.admin.email } });
      expect(await open(token)).toMatchObject({ status: 409, body: { problems: [{ code: 'input.duplicate' }] } });
      const read = (await world.call('GET', `/v1/templates/${GREETING}/working-copy`, target.operator.token)).body;
      expect(read.content).toBe(await readFile(`${SINGLE_TEXT}template-greeting.json`, 'utf8'));
      expect(sha256(read.content)).toBe(copy.body.sha256);

      const raw = `{"dslVersion":"renderweave-template/1",\n\t"name":"问候牌"}\r\n`;
      const stashed = await stash(token, raw, copy.body.sha256);
      expect(stashed).toMatchObject({ status: 200, body: { sha256: sha256(raw), baseRevision: 1 } });
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).body.content).toBe(raw);
      expect(await stash(token, raw, copy.body.sha256)).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale' }], currentSha256: sha256(raw) } });
      for (const [body, source] of [['不是 JSON', 'request.body'], ['[]', 'request.body'], ['{"name":"改了名称"}', 'request.body.name']] as const) {
        expect(await stash(token, body, sha256(raw)), body).toMatchObject({ status: 400, body: { problems: [{ code: 'request.invalid', location: { source } }] } });
      }
      expect((await world.call('PUT', `/v1/templates/${GREETING}/working-copy`, token, raw, JSON_TYPE)).status, '要带预期哈希').toBe(400);
      expect((await world.call('GET', '/v1/template-working-copies', target.operator.token)).body.workingCopies.map((item: any) => item.name)).toEqual(['问候牌']);

      expect((await world.call('DELETE', `/v1/templates/${GREETING}/working-copy`, token)).status).toBe(204);
      expect((await world.call('DELETE', `/v1/templates/${GREETING}/working-copy`, token)).status).toBe(404);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).status).toBe(404);
      expect((await open(token)).status, '丢弃之后可以重新开').toBe(201);
    });

    it('暂存不影响当前修订：模板列表、工作区与默认预览照旧；指定用工作副本才看到改动，问题与本地渲染相同', async () => {
      const target = await tenant(), token = target.admin.token;
      const listed = (await world.call('GET', '/v1/templates', token)).raw;
      const state = (await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).raw;
      const before = await preview(token, greetingPreview());
      const { document } = await editedCopy(token);
      expect((await world.call('GET', '/v1/templates', token)).raw).toBe(listed);
      expect((await world.call('GET', `/v1/authoring/tenants/${target.id}/workspace`, target.engineer)).raw).toBe(state);
      const still = await preview(token, greetingPreview());
      expect(still.image.base64, '默认预览照旧读当前修订').toBe(before.image.base64);
      const edited = await preview(target.operator.token, greetingPreview(), '?workingCopies=true');
      expect(edited.image.base64).not.toBe(before.image.base64);

      // 与本地渲染同一份内容：问题相同，图片也相同。
      const local = await loadWorkspace({ dir: SINGLE_TEXT, resourcesDir: RESOURCES_DIR });
      const overlay = { ...local, templates: [...local.templates.filter((item) => item.name !== '问候牌'), { name: '问候牌', document }] };
      const rendered = await render(overlay, greetingPreview({ mode: 'draft' }));
      expect(edited.problems).toEqual(JSON.parse(JSON.stringify(rendered.problems)));

      // 工作副本有问题时走同一套检查，问题在清单里。
      const copy = (await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).body;
      const broken = { ...document, artboard: { ...document.artboard, children: [{ ...document.artboard.children[0], content: [{ slot: 'noSuchField' }] }] } };
      expect((await stash(token, broken, copy.sha256)).status).toBe(200);
      const blocked = await preview(token, greetingPreview(), '?workingCopies=true');
      expect(JSON.stringify(blocked.problems)).toContain('noSuchField');
      expect((await world.call('POST', '/v1/previews?workingCopies=false', token, greetingPreview())).status, '只有 true').toBe(400);
    });

    it('预览回答元素定位：循环与子模板调用里的元素指向它所在的模板文档；改子模板的工作副本，父模板的预览也看得到', async () => {
      const target = await tenant(seedM402), token = target.admin.token;
      const request = JSON.parse(await readFile(`${M402_DIR}render-request-m402.json`, 'utf8'));
      const before = await preview(token, { ...request, mode: 'draft' });
      const layoutPaths = new Set<string>();
      const walk = (node: any) => { layoutPaths.add(node.path); (node.children ?? []).forEach(walk); };
      walk(before.layout.root);
      const instances = (before.elements as any[]).filter((element) => element.source.template === '站点');
      expect(instances.length).toBeGreaterThan(5);
      for (const { path, source } of before.elements as any[]) {
        expect(layoutPaths.has(path), path).toBe(true);
        expect(source.path.split('/')[0], path).toBe(source.template);
        expect(source.path, path).not.toMatch(/\[\d+\]/);
      }
      expect(instances[0].path.startsWith('标准线路单边/')).toBe(true);
      expect(instances[0].path).toMatch(/\[\d+\]/);

      const copy = (await open(token, STOP)).body;
      const document = await documentOf(token, STOP);
      const edited = structuredClone(document);
      edited.parameters.find((parameter: any) => parameter.name === 'nameColor').default = '#FF0000';
      expect((await stash(token, edited, copy.sha256, STOP)).status).toBe(200);
      const after = await preview(token, { ...request, mode: 'draft' }, '?workingCopies=true');
      expect(after.image.base64, '根模板调用的子模板用工作副本').not.toBe(before.image.base64);
      expect((await preview(token, { ...request, mode: 'draft' })).image.base64).toBe(before.image.base64);
    }, 120_000);

    it('元素求值（模板设计页票据 02）：回答实例的变量取值、命中分支、参数来源与全部实例；不入队，不占预览的频率；路径不存在时没有这个字段', async () => {
      const target = await tenant(seedM402), token = target.admin.token;
      const request = { ...JSON.parse(await readFile(`${M402_DIR}render-request-m402.json`, 'utf8')), mode: 'draft' };
      const inspect = async (element: string, query = '') => {
        const reply = await world.call('POST', `/v1/previews/inspection?element=${encodeURIComponent(element)}${query}`, token, request);
        expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
        return reply.body;
      };
      const path = '标准线路单边/站点面板/站点列[12]/名称区/站名';
      const asked = await inspect(path);
      expect(asked).not.toHaveProperty('image');
      expect(asked.inspection).toMatchObject({ path, template: '站点', source: '站点/名称区/站名' });
      expect(asked.inspection.instances).toHaveLength(35);
      expect(asked.inspection.variables.find((variable: any) => variable.name === 'stopState')).toMatchObject({ value: '未到站', branch: -1 });
      expect((await inspect('没有')).inspection).toBeUndefined();
      expect((await world.call('POST', '/v1/previews/inspection', token, request)).status, '要写元素路径').toBe(400);
      // 工作副本：改了内部参数的缺省值，求值跟着变。
      const copy = (await open(token, STOP)).body;
      const document = await documentOf(token, STOP);
      document.parameters.find((parameter: any) => parameter.name === 'nameColor').default = '#FF0000';
      expect((await stash(token, document, copy.sha256, STOP)).status).toBe(200);
      const of = (reply: any, name: string) => reply.inspection.variables.find((variable: any) => variable.name === name).value;
      expect(of(await inspect(path, '&workingCopies=true'), 'nameColor')).toBe('#FF0000FF');
      expect(of(await inspect(path), 'nameColor')).toBe('#333333FF');
      // 不占预览的频率：连问很多次也不答 429。
      for (let index = 0; index < 70; index++) expect((await world.call('POST', `/v1/previews/inspection?element=${encodeURIComponent(path)}`, token, request)).status).toBe(200);
      // 代建工程师同样能问，记审计。
      const authored = await world.call('POST', `/v1/authoring/tenants/${target.id}/previews/inspection?element=${encodeURIComponent(path)}`, target.engineer, request);
      expect(authored.status).toBe(200);
      expect(authored.body.inspection.template).toBe('站点');
    }, 120_000);

    it('保存：按 M265 记新修订，来源是网页，当前修订指向它，删除工作副本；出图读到新内容；字节相同记为不变；记审计', async () => {
      const target = await tenant(), token = target.admin.token;
      const original = await readFile(`${SINGLE_TEXT}template-greeting.json`);
      const before = await preview(token, greetingPreview());
      const { sha256: copySha } = await editedCopy(token);
      const checked = await check(token);
      expect(checked).toMatchObject({ sha256: copySha, baseRevision: 1, currentRevision: 1, problems: [], changes: { status: 'modified' } });
      expect(checked).not.toHaveProperty('conflict');
      expect(checked.changes.changes.length).toBeGreaterThan(0);

      const saved = await save(token, copySha);
      expect(saved).toMatchObject({ status: 200, body: { name: '问候牌', revision: 2, status: 'saved', sha256: copySha } });
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).status, '工作副本已删除').toBe(404);
      const history = await revisions(target.operator.token);
      expect(history).toMatchObject({ name: '问候牌', currentRevision: 2 });
      expect(history.revisions.map((item: any) => [item.revision, item.source])).toEqual([[1, 'push'], [2, 'web']]);
      expect(history.revisions[1]).toMatchObject({ pushedBy: target.admin.email, sha256: copySha });
      const after = await preview(token, greetingPreview());
      expect(after.image.base64, '当前修订是新内容').not.toBe(before.image.base64);

      const [event] = await auditOf(token, 'template.save');
      expect(event).toMatchObject({ actor: { kind: 'member', label: target.admin.email }, object: { type: 'template', id: '问候牌' }, crossTenant: false,
        beforeSha256: sha256(original), afterSha256: copySha, diff: { changed: expect.any(Number) } });
      expect(event.diff.paths[0].path).toMatch(/^(element|template):/);

      // 字节相同：不记修订，工作副本照样删除。
      const again = (await open(token)).body;
      expect(await save(token, again.sha256)).toMatchObject({ status: 200, body: { revision: 2, status: 'unchanged' } });
      expect((await revisions(token)).revisions).toHaveLength(2);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).status).toBe(404);
    });

    it('别人先保存了：基准不符答 409 带两边差异，工作副本不动；显式 overwrite 才覆盖；预期哈希不符也拒绝', async () => {
      const target = await tenant(), token = target.admin.token, prefix = `/v1/authoring/tenants/${target.id}`;
      const mine = await editedCopy(token, '#AAAAAA');
      expect(await save(token, sha256('别的内容'))).toMatchObject({ status: 409, body: { problems: [{ code: 'draft.stale' }], currentSha256: mine.sha256 } });

      // 代建工程师推送了修订 2。
      const theirs = new TextEncoder().encode(text(recolored(JSON.parse(await readFile(`${SINGLE_TEXT}template-greeting.json`, 'utf8')), '#BBBBBB')));
      expect((await world.call('PUT', `${prefix}/contents/${sha256(theirs)}`, target.engineer, theirs)).status).toBe(204);
      const pushed = await world.call('POST', `${prefix}/pushes`, target.engineer, { documents: [{ kind: 'template', key: '问候牌', sha256: sha256(theirs), byteLength: theirs.length }], resources: [] });
      expect(pushed.status, pushed.raw.slice(0, 300)).toBe(200);

      const refused = await save(token, mine.sha256);
      expect(refused).toMatchObject({ status: 409, body: { problems: [{ code: 'template.revisionConflict' }],
        conflict: { baseRevision: 1, currentRevision: 2, ours: { status: 'modified' }, theirs: { status: 'modified' } } } });
      expect(JSON.stringify(refused.body.conflict.ours)).toContain('#AAAAAA');
      expect(JSON.stringify(refused.body.conflict.theirs)).toContain('#BBBBBB');
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).body.sha256, '工作副本不动').toBe(mine.sha256);
      expect((await revisions(token)).currentRevision).toBe(2);
      expect((await check(token)).conflict).toMatchObject({ baseRevision: 1, currentRevision: 2 });

      const forced = await save(token, mine.sha256, { overwrite: true });
      expect(forced).toMatchObject({ status: 200, body: { revision: 3, status: 'saved' } });
      const history = (await revisions(token)).revisions as any[];
      expect(history.map((item) => item.source)).toEqual(['push', 'push', 'web']);
      expect(history[2].sha256).toBe(mine.sha256);
    });

    it('模板静态检查有严重问题时拒绝保存，工作副本不动；检查也报同样的问题', async () => {
      const target = await tenant(), token = target.admin.token;
      const copy = (await open(token)).body, document = await documentOf(token);
      const broken = { ...document, artboard: { ...document.artboard, children: [{ ...document.artboard.children[0], content: [{ slot: 'noSuchField' }] }] } };
      const stashed = await stash(token, broken, copy.sha256);
      const checked = await check(token);
      expect(checked.problems.some((problem: any) => problem.level === 'severe' && problem.message.includes('noSuchField'))).toBe(true);
      const refused = await save(token, stashed.body.sha256);
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body.problems)).toContain('noSuchField');
      expect((await revisions(token)).currentRevision).toBe(1);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, token)).body.sha256).toBe(stashed.body.sha256);
    });

    it('读当前修订的内容：不开工作副本、不写审计；暂存不影响它；两种寻址都能读，代建的读取记审计', async () => {
      const { id, admin, operator, engineer } = await tenant();
      const url = `/v1/templates/${GREETING}/content`;
      const audited = async () => (await world.call('GET', '/v1/audit-events?limit=200', admin.token)).body.events as { action: string }[];
      const auditBefore = (await audited()).length;
      const read = await world.call('GET', url, admin.token);
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ name: '问候牌', revision: 1 });
      expect(read.body.sha256).toBe(sha256(read.body.content as string));
      expect((await world.call('GET', url, operator.token)).status).toBe(200);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, admin.token)).status, '读内容不开工作副本').toBe(404);
      expect((await audited()).length, '客户成员的读取不记审计').toBe(auditBefore);

      const opened = await open(admin.token);
      const document = JSON.parse(read.body.content as string) as Record<string, unknown>;
      const stashed = await stash(admin.token, { ...document, parameters: [] }, opened.body.sha256 as string);
      expect(stashed.status, stashed.raw.slice(0, 300)).toBe(200);
      expect((await world.call('GET', url, admin.token)).body.sha256, '暂存不影响当前修订').toBe(read.body.sha256);
      await world.call('DELETE', `/v1/templates/${GREETING}/working-copy`, admin.token);

      const authored = await world.call('GET', `/v1/authoring/tenants/${id}/templates/${GREETING}/content`, engineer);
      expect(authored.status).toBe(200);
      expect(authored.body.sha256).toBe(read.body.sha256);
      expect((await audited()).some((event) => event.action === 'authoring.read'), '代建工程师的读取记审计').toBe(true);
      expect((await world.call('GET', '/v1/templates/not-here/content', admin.token)).status).toBe(404);
    });

    it('复制为新模板：内容与基准取当前修订，没有基准修订，保存时记修订 1；名称已有时拒绝；可以预览还没保存的新模板', async () => {
      const target = await tenant(), token = target.admin.token, fresh = encodeURIComponent('问候牌-竖版');
      const copied = await world.call('POST', `/v1/templates/${GREETING}/copies`, token, { name: '问候牌-竖版' });
      expect(copied.status, copied.raw.slice(0, 300)).toBe(201);
      expect(copied.body).toMatchObject({ name: '问候牌-竖版' });
      expect(copied.body).not.toHaveProperty('baseRevision');
      const document = await documentOf(token, fresh);
      const original = JSON.parse(await readFile(`${SINGLE_TEXT}template-greeting.json`, 'utf8'));
      expect(document).toEqual({ ...original, name: '问候牌-竖版' });
      expect((await world.call('GET', '/v1/templates', token)).body.templates.map((item: any) => item.name), '还没保存').toEqual(['问候牌']);

      expect((await preview(token, greetingPreview({ template: '问候牌-竖版' }), '?workingCopies=true')).image).toBeTruthy();
      expect((await preview(token, greetingPreview({ template: '问候牌-竖版' }))).problems.map((problem: any) => problem.code)).toContain('input.templateNotFound');
      expect((await check(token, fresh)).changes).toEqual({ status: 'added', changes: [] });

      for (const [body, status] of [[{ name: '问候牌' }, 409], [{ name: '问候牌-竖版' }, 409], [{ name: '带/斜杠' }, 400], [{ name: ' 首尾空白 ' }, 400], [{}, 400]] as const) {
        expect((await world.call('POST', `/v1/templates/${GREETING}/copies`, token, body)).status, JSON.stringify(body)).toBe(status);
      }
      expect((await world.call('POST', `/v1/templates/${encodeURIComponent('没有这个模板')}/copies`, token, { name: '随便' })).status).toBe(404);

      const saved = await save(token, copied.body.sha256, {}, fresh);
      expect(saved).toMatchObject({ status: 200, body: { name: '问候牌-竖版', revision: 1, status: 'saved' } });
      expect((await world.call('GET', '/v1/templates', token)).body.templates.map((item: any) => item.name)).toEqual(['问候牌', '问候牌-竖版']);
      const [copyEvent] = await auditOf(token, 'templateWorkingCopy.copy');
      expect(copyEvent).toMatchObject({ object: { id: '问候牌-竖版' }, afterSha256: copied.body.sha256 });
      const saveEvent = (await auditOf(token, 'template.save')).find((event) => event.object.id === '问候牌-竖版');
      expect(saveEvent).not.toHaveProperty('beforeSha256');
    });

    it('指回旧修订开放给客户管理员，记审计；操作员不能指回；工作副本的基准随之过期', async () => {
      const target = await tenant(), token = target.admin.token;
      const { sha256: copySha } = await editedCopy(token);
      expect((await save(token, copySha)).body.revision).toBe(2);
      const opened = (await open(token)).body;
      const body = { template: '问候牌', revision: 1 };
      expect((await world.call('POST', '/v1/template-current', target.operator.token, body)).status).toBe(403);
      expect((await world.call('POST', '/v1/template-current', token, { template: '问候牌', revision: 9 })).status).toBe(404);
      const back = await world.call('POST', '/v1/template-current', token, body);
      expect(back).toMatchObject({ status: 200, body: { name: '问候牌', currentRevision: 1 } });
      const [event] = await auditOf(token, 'template.setCurrent');
      expect(event).toMatchObject({ actor: { kind: 'member', label: target.admin.email }, crossTenant: false, beforeSha256: copySha, diff: { changed: 1 } });
      // 工作副本基于修订 2，当前修订已指回 1：保存时要明确覆盖。
      expect(await save(token, opened.sha256)).toMatchObject({ status: 409, body: { conflict: { baseRevision: 2, currentRevision: 1 } } });
    });

    it('两种寻址共用一份实现，每次写入记审计，代建的另标跨租户；操作员与密钥只读；别的租户答 404；发布推送用的旧端点行为不变', async () => {
      const target = await tenant(), other = await tenant(), admin = target.admin.token, prefix = `/v1/authoring/tenants/${target.id}`;
      const opened = await open(target.engineer, GREETING, prefix);
      expect(opened).toMatchObject({ status: 201, body: { baseRevision: 1 } });
      expect((await world.call('GET', `${prefix}/template-working-copies`, target.engineer)).body.workingCopies).toHaveLength(1);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, admin)).body.sha256, '代建工程师开的，客户管理员看得到').toBe(opened.body.sha256);
      const edited = recolored(await documentOf(target.engineer, GREETING, prefix));
      const byEngineer = await stash(target.engineer, edited, opened.body.sha256, GREETING, prefix);
      expect(byEngineer.status).toBe(200);
      const checked = await check(target.engineer, GREETING, prefix);
      expect(checked.sha256).toBe(byEngineer.body.sha256);
      const key = await world.call('POST', '/v1/api-keys', admin, { name: '只读检查' });
      world.secrets.push(key.body.key);
      for (const reader of [target.operator.token, key.body.key as string]) {
        expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, reader)).status).toBe(200);
        expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy/check`, reader)).status).toBe(200);
        expect((await world.call('GET', `/v1/templates/${GREETING}/revisions`, reader)).status).toBe(200);
        expect((await stash(reader, edited, byEngineer.body.sha256)).status).toBe(403);
        expect((await save(reader, byEngineer.body.sha256)).status).toBe(403);
        expect((await world.call('DELETE', `/v1/templates/${GREETING}/working-copy`, reader)).status).toBe(403);
        expect((await world.call('POST', `/v1/templates/${GREETING}/copies`, reader, { name: '不行' })).status).toBe(403);
      }
      expect((await world.call('GET', `${prefix}/templates/${GREETING}/working-copy`, other.engineer)).status).toBe(404);
      expect((await world.call('GET', `/v1/templates/${GREETING}/working-copy`, other.admin.token)).status).toBe(404);
      const saved = await save(target.engineer, byEngineer.body.sha256, {}, GREETING, prefix);
      expect(saved).toMatchObject({ status: 200, body: { revision: 2 } });
      const history = (await revisions(admin)).revisions as any[];
      expect(history[1]).toMatchObject({ source: 'web' });
      expect(history[1].pushedBy).not.toBe(target.admin.email);

      const [created] = await auditOf(admin, 'templateWorkingCopy.create');
      expect(created).toMatchObject({ actor: { kind: 'authoringToken' }, crossTenant: true, afterSha256: opened.body.sha256,
        diff: { added: 1, paths: [{ path: 'templateWorkingCopy:问候牌', change: 'added', afterSha256: opened.body.sha256 }] } });
      const [stashed] = await auditOf(admin, 'templateWorkingCopy.save');
      expect(stashed).toMatchObject({ crossTenant: true, beforeSha256: opened.body.sha256, afterSha256: byEngineer.body.sha256 });
      expect(stashed.diff.paths[0].path).toMatch(/^(element|template):/);
      expect((await auditOf(admin, 'authoring.read')).some((event) => event.object.type === 'templateWorkingCopy'), '代建工程师的读取记审计').toBe(true);
      const again = (await open(admin)).body;
      expect((await world.call('DELETE', `/v1/templates/${GREETING}/working-copy`, admin)).status).toBe(204);
      const [discarded] = await auditOf(admin, 'templateWorkingCopy.delete');
      expect(discarded).toMatchObject({ actor: { kind: 'member' }, crossTenant: false, beforeSha256: again.sha256 });
    });
  });
}
