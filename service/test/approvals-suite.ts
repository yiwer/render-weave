/**
 * 审批策略与发布申请（P1 票据 11，验收 A07、A08）：只经开放 API 驱动——打开策略，代建工程师的发布、保存、指回与推送变成申请，客户管理员批准或退回，断言回答、状态与审计。
 * 同一组用例跑两种后端：内存后端进 npm test；PostgreSQL 加 S3 在 Docker 后端测试里跑，批准与内容同一个事务靠它验证。
 * 准备工作（放入样例、绕过接口挪动当前修订）经租户的存储接口，效果与代建推送相同。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend, TenantScope, TenantStorage } from '../src/backend.js';
import { createWorld, type World } from './api-suite.js';
import { M402_DIR, seedDocuments, seedGreeting, seedM402 } from './seed.js';

const sha256 = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const JSON_TYPE = { 'content-type': 'application/json' };
const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const bytes = (value: unknown) => new Uint8Array(Buffer.from(text(value)));
const GREETING = encodeURIComponent('问候牌'), DEFINITION = encodeURIComponent('问候');

export function describeApprovals(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`审批策略与发布申请（${name}）`, () => {
    let world: World, backend: ServiceBackend;
    /** 下一次保存模板的事务开始之前先做的事：用来排出"重核之后、事务之前申请被处理掉"的先后。 */
    let beforeCommit: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      backend = await makeBackend();
      // 只包一层保存：其余操作原样。
      const wrapped: ServiceBackend = Object.create(backend, { tenant: { value: (id: string): TenantScope => {
        const scope = backend.tenant(id), storage: TenantStorage = scope.storage;
        const commitTemplateWorkingCopy: TenantStorage['commitTemplateWorkingCopy'] = async (...args) => {
          const before = beforeCommit;
          beforeCommit = undefined;
          await before?.();
          return storage.commitTemplateWorkingCopy(...args);
        };
        return Object.create(scope, { storage: { value: Object.create(storage, { commitTemplateWorkingCopy: { value: commitTemplateWorkingCopy } }) } });
      } } });
      world = await createWorld(wrapped);
    });

    const tenant = async (seed: (storage: TenantStorage) => Promise<void> = (storage) => seedGreeting(storage, { withFont: true })) => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: `审批 ${randomUUID().slice(0, 8)}` });
      const id = created.body.id as string;
      const issued = await world.call('POST', '/v1/platform/authoring-tokens', world.platform, { label: `代建工程师 ${randomUUID().slice(0, 8)}`, tenantIds: [id] });
      world.secrets.push(issued.body.token);
      await seed(backend.tenant(id).storage);
      return {
        id, prefix: `/v1/authoring/tenants/${id}`, engineer: issued.body.token as string, label: issued.body.authoringToken.label as string,
        admin: await world.member(id, 'admin'), operator: await world.member(id, 'operator'),
      };
    };
    type Target = Awaited<ReturnType<typeof tenant>>;
    const policy = async (target: Target, changes: Record<string, boolean>) => {
      const reply = await world.call('PUT', '/v1/approval-policy', target.admin.token, changes);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const auditOf = async (target: Target, ...actions: string[]) => ((await world.call('GET', '/v1/audit-events?limit=500', target.admin.token)).body.events as any[]).filter((event) => actions.includes(event.action));
    const detail = async (target: Target, id: string) => {
      const reply = await world.call('GET', `/v1/publish-requests/${id}`, target.admin.token);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return reply.body;
    };
    const approve = (target: Target, id: string) => world.call('POST', `/v1/publish-requests/${id}/approve`, target.admin.token);
    const revisions = async (target: Target, template = GREETING) => (await world.call('GET', `/v1/templates/${template}/revisions`, target.admin.token)).body;
    const versions = async (target: Target) => ((await world.call('GET', '/v1/definitions', target.admin.token)).body.definitions as any[]).find((item) => item.name === '问候').versions.map((item: any) => item.version);

    /** 代建工程师在数据定义上加一个字段，答它的内容哈希。 */
    const engineerDraft = async (target: Target, field = 'note') => {
      const url = `${target.prefix}/definitions/${DEFINITION}`;
      const created = await world.call('GET', url, target.engineer);
      expect(created.status, created.raw.slice(0, 300)).toBe(200);
      const document = JSON.parse(created.body.content);
      document.fields.push({ name: field, displayName: '备注', type: 'text' });
      const saved = await world.call('PUT', `${url}?expectedSha256=${created.body.sha256}`, target.engineer, text(document), JSON_TYPE);
      expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
      return { url, document, sha256: saved.body.sha256 as string };
    };
    const publish = (target: Target, expectedSha256: string, token = target.engineer, url = `${target.prefix}/definitions/${DEFINITION}`) => world.call('POST', `${url}/publish`, token, { expectedSha256 });

    /** 代建工程师开工作副本、换底色，答工作副本的内容哈希。 */
    const engineerCopy = async (target: Target, color = '#E0F4FF', template = GREETING) => {
      const url = `${target.prefix}/templates/${template}/working-copy`;
      const copy = await world.call('POST', url, target.engineer);
      expect(copy.status, copy.raw.slice(0, 300)).toBe(201);
      const content = (await world.call('GET', url, target.engineer)).body.content as string;
      const stashed = await world.call('PUT', `${url}?expectedSha256=${copy.body.sha256}`, target.engineer, content.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`), JSON_TYPE);
      expect(stashed.status, stashed.raw.slice(0, 300)).toBe(200);
      return { url, content, sha256: stashed.body.sha256 as string };
    };
    const save = (target: Target, url: string, expectedSha256: string, extra: Record<string, unknown> = {}) => world.call('POST', `${url}/save`, target.engineer, { expectedSha256, ...extra });
    /** 绕过接口推一个新修订：当前修订向前走。 */
    const moveCurrent = async (target: Target, color: string) => {
      const current = (await revisions(target)).revisions.at(-1).sha256;
      const content = Buffer.from((await backend.tenant(target.id).storage.contents.get(current))!).toString('utf8');
      await seedDocuments(backend.tenant(target.id).storage, [new Uint8Array(Buffer.from(content.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`)))]);
    };

    /** 代建工程师上传一份新内容的模板，答推送清单。 */
    const pushManifest = async (target: Target, color: string, extra: Record<string, unknown> = {}) => {
      const current = (await revisions(target)).revisions.at(-1).sha256;
      const content = new Uint8Array(Buffer.from(Buffer.from((await backend.tenant(target.id).storage.contents.get(current))!).toString('utf8').replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`)));
      const hash = sha256(content);
      expect((await world.call('PUT', `${target.prefix}/contents/${hash}`, target.engineer, content)).status).toBe(204);
      return { documents: [{ kind: 'template', key: '问候牌', sha256: hash, byteLength: content.length, ...extra }], resources: [] };
    };

    it('策略：缺省关；操作员与代建工程师能读不能改；客户管理员改动记审计，没改动不记', async () => {
      const target = await tenant();
      const off = { definitions: { required: false }, templates: { required: false } };
      expect((await world.call('GET', '/v1/approval-policy', target.operator.token)).body).toEqual(off);
      expect((await world.call('GET', `${target.prefix}/approval-policy`, target.engineer)).body).toEqual(off);
      expect((await world.call('PUT', '/v1/approval-policy', target.operator.token, { templates: true })).status).toBe(403);
      expect((await world.call('PUT', '/v1/approval-policy', target.engineer, { templates: true })).status).toBe(403);
      expect((await world.call('PUT', '/v1/approval-policy', target.admin.token, {})).status).toBe(400);

      expect(await policy(target, { templates: true })).toMatchObject({ definitions: { required: false }, templates: { required: true, updatedBy: target.admin.email } });
      expect((await world.call('GET', `${target.prefix}/approval-policy`, target.engineer)).body.templates.required).toBe(true);
      await policy(target, { templates: true });
      const events = await auditOf(target, 'approvalPolicy.update');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actor: { kind: 'member', label: target.admin.email }, crossTenant: false, diff: { changed: 1, paths: [{ path: 'approvalPolicy:templates', change: 'changed' }] } });
    });

    it('数据定义：关闭时直发；打开后代建工程师的发布变成申请，批准后生效；客户管理员自己的发布直接生效', async () => {
      const target = await tenant();
      const direct = await engineerDraft(target);
      const published = await publish(target, direct.sha256);
      expect(published).toMatchObject({ status: 201, body: { name: '问候', version: 2 } });

      await policy(target, { definitions: true });
      const draft = await world.call('GET', `${target.prefix}/definitions/${DEFINITION}`, target.engineer);
      expect(draft.body, '发布之后数据定义还是发布前的内容').toMatchObject({ sha256: direct.sha256 });
      const url = `${target.prefix}/definitions/${DEFINITION}`, document = JSON.parse((await world.call('GET', url, target.engineer)).body.content);
      document.fields.push({ name: 'extra', displayName: '另一项', type: 'text' });
      const hash = (await world.call('PUT', `${url}?expectedSha256=${draft.body.sha256}`, target.engineer, text(document), JSON_TYPE)).body.sha256;

      const requested = await publish(target, hash);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      expect(requested.body.request).toMatchObject({
        kind: 'definitionPublish', subject: '问候', scopes: ['definitions'], status: 'pending', sha256: hash, baseVersion: 2, version: 3,
        requestedBy: { kind: 'authoringToken', label: target.label }, diff: { added: 1, paths: [{ path: 'field:extra', change: 'added' }] },
      });
      // 申请不改动任何东西：还是两个版本，数据定义还在；预期哈希不对的发布照样答 409。
      expect(await versions(target)).toEqual([1, 2]);
      expect((await world.call('GET', url, target.engineer)).status).toBe(200);
      expect((await publish(target, 'a'.repeat(64))).status).toBe(409);
      const id = requested.body.request.id as string;
      expect((await world.call('GET', `${target.prefix}/publish-requests/${id}`, target.engineer)).body).toMatchObject({ status: 'pending', recheck: { valid: true }, changes: { fields: [{ path: 'extra', change: 'added' }] } });
      expect((await world.call('GET', '/v1/publish-requests?status=pending&scope=definitions', target.operator.token)).body.requests.map((item: any) => item.id)).toEqual([id]);
      expect((await world.call('GET', '/v1/publish-requests?scope=templates', target.admin.token)).body.requests).toEqual([]);

      const approved = await approve(target, id);
      expect(approved.status, approved.raw.slice(0, 300)).toBe(200);
      expect(approved.body).toMatchObject({ request: { id, status: 'approved', decidedBy: target.admin.email }, result: { name: '问候', version: 3, baseVersion: 2 } });
      expect(await versions(target)).toEqual([1, 2, 3]);
      expect((await world.call('GET', url, target.engineer)).body, '批准之后数据定义也不变').toMatchObject({ sha256: hash });

      // 申请、批准与生效各记一条，带主体与内容哈希；发布记录要读的 definition.publish 是批准的人。
      const events = await auditOf(target, 'publishRequest.create', 'publishRequest.approve', 'definition.publish');
      expect(events.find((event) => event.action === 'publishRequest.create')).toMatchObject({ actor: { kind: 'authoringToken', label: target.label }, crossTenant: true, object: { type: 'publishRequest', id }, afterSha256: hash, diff: { added: 1 } });
      expect(events.find((event) => event.action === 'publishRequest.approve')).toMatchObject({ actor: { kind: 'member', label: target.admin.email }, crossTenant: false, object: { type: 'publishRequest', id }, afterSha256: hash });
      expect(events.find((event) => event.action === 'definition.publish' && event.object.id === '问候@3')).toMatchObject({ actor: { kind: 'member', label: target.admin.email }, afterSha256: approved.body.result.definitionSha256 });

      // 客户管理员自己的发布直接生效，不留申请。
      const own = await world.call('GET', `/v1/definitions/${DEFINITION}`, target.admin.token);
      const ownDocument = JSON.parse((await world.call('GET', `/v1/definitions/${DEFINITION}`, target.admin.token)).body.content);
      ownDocument.fields.push({ name: 'own', displayName: '自己的', type: 'text' });
      const ownHash = (await world.call('PUT', `/v1/definitions/${DEFINITION}?expectedSha256=${own.body.sha256}`, target.admin.token, text(ownDocument), JSON_TYPE)).body.sha256;
      expect(await publish(target, ownHash, target.admin.token, `/v1/definitions/${DEFINITION}`)).toMatchObject({ status: 201, body: { version: 4 } });
      expect((await world.call('GET', '/v1/publish-requests', target.admin.token)).body.requests).toHaveLength(1);
    });

    it('退回：必须留言；只有客户管理员能处理；代建工程师看得到留言，可以重新发起；处理过的不能再处理', async () => {
      const target = await tenant();
      await policy(target, { definitions: true });
      const draft = await engineerDraft(target);
      const id = (await publish(target, draft.sha256)).body.request.id as string;

      const reject = (token: string, body: unknown) => world.call('POST', `/v1/publish-requests/${id}/reject`, token, body);
      expect((await reject(target.admin.token, {})).status).toBe(400);
      expect((await reject(target.admin.token, { message: '   ' })).status).toBe(400);
      expect((await reject(target.operator.token, { message: '不行' })).status).toBe(403);
      expect((await reject(target.engineer, { message: '不行' })).status).toBe(403);
      expect((await world.call('POST', `/v1/publish-requests/${id}/approve`, target.engineer)).status).toBe(403);
      expect((await world.call('POST', `/v1/publish-requests/${randomUUID()}/approve`, target.admin.token)).status).toBe(404);

      const rejected = await reject(target.admin.token, { message: '字段名要英文' });
      expect(rejected).toMatchObject({ status: 200, body: { status: 'rejected', decidedBy: target.admin.email, message: '字段名要英文' } });
      expect((await world.call('GET', `${target.prefix}/publish-requests/${id}`, target.engineer)).body).toMatchObject({ status: 'rejected', message: '字段名要英文' });
      expect((await world.call('GET', `${target.prefix}/publish-requests/${id}`, target.engineer)).body.recheck).toBeUndefined();
      expect(await versions(target)).toEqual([1]);
      expect((await world.call('GET', draft.url, target.engineer)).status).toBe(200);

      const again = await approve(target, id);
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ problems: [{ code: 'publishRequest.decided' }], request: { status: 'rejected' } });
      expect((await reject(target.admin.token, { message: '再退一次' })).status).toBe(409);
      expect(await auditOf(target, 'publishRequest.reject')).toHaveLength(1);
      expect((await auditOf(target, 'publishRequest.reject'))[0]).toMatchObject({ actor: { label: target.admin.email }, afterSha256: draft.sha256 });

      const fresh = await publish(target, draft.sha256);
      expect(fresh.status).toBe(202);
      expect(fresh.body.request.id).not.toBe(id);
    });

    it('同一个数据定义最多一份待处理：重发答同一份；内容改了、删了或被直接发布，申请随之过期并记审计', async () => {
      const target = await tenant();
      await policy(target, { definitions: true });
      const draft = await engineerDraft(target);
      const id = (await publish(target, draft.sha256)).body.request.id as string;
      expect((await publish(target, draft.sha256)).body.request.id).toBe(id);
      expect(await auditOf(target, 'publishRequest.create')).toHaveLength(1);

      // 相同内容再保存一次不算修改。
      expect((await world.call('PUT', `${draft.url}?expectedSha256=${draft.sha256}`, target.engineer, text(draft.document), JSON_TYPE)).status).toBe(200);
      expect((await detail(target, id)).status).toBe('pending');

      draft.document.displayName = '改了显示名称';
      const edited = await world.call('PUT', `${draft.url}?expectedSha256=${draft.sha256}`, target.engineer, text(draft.document), JSON_TYPE);
      expect(await detail(target, id)).toMatchObject({ status: 'expired', decidedBy: target.label, message: '数据定义在申请之后又被修改' });
      expect((await auditOf(target, 'publishRequest.expire'))[0]).toMatchObject({ actor: { kind: 'authoringToken' }, object: { id }, afterSha256: draft.sha256 });
      const expired = await approve(target, id);
      expect(expired).toMatchObject({ status: 409, body: { problems: [{ code: 'publishRequest.decided' }], request: { status: 'expired' } } });

      // 新内容是新的一份；客户管理员直接发布，这一份也过期，不留着让人误批。
      const second = (await publish(target, edited.body.sha256)).body.request.id as string;
      expect(second).not.toBe(id);
      expect((await world.call('POST', `/v1/definitions/${DEFINITION}/publish`, target.admin.token, { expectedSha256: edited.body.sha256 })).status).toBe(201);
      expect(await detail(target, second)).toMatchObject({ status: 'expired', message: '这份内容已被直接发布' });

      const other = await engineerDraft(target, 'third');
      const third = (await publish(target, other.sha256)).body.request.id as string;
      expect((await world.call('DELETE', other.url, target.engineer)).status).toBe(204);
      expect(await detail(target, third)).toMatchObject({ status: 'expired', message: '数据定义已被删除' });
    });

    it('批准时重核：下一个版本被占用就过期，什么也不写，要重新发起', async () => {
      const target = await tenant();
      await policy(target, { definitions: true });
      const draft = await engineerDraft(target);
      const id = (await publish(target, draft.sha256)).body.request.id as string;
      // 别处先发布了 v2：推送进来的版本不经过这个数据定义。
      const storage = backend.tenant(target.id).storage, workspace = await seededVersionTwo(storage);
      expect(workspace).toBe(true);

      const checked = await detail(target, id);
      expect(checked).toMatchObject({ status: 'pending', recheck: { valid: false } });
      expect(checked.recheck.message).toContain('版本 2');

      const expired = await approve(target, id);
      expect(expired.status).toBe(409);
      expect(expired.body).toMatchObject({ problems: [{ code: 'publishRequest.expired' }], request: { status: 'expired', decidedBy: target.admin.email } });
      expect(await auditOf(target, 'publishRequest.expire')).toHaveLength(1);
      expect(await auditOf(target, 'publishRequest.approve')).toHaveLength(0);
      expect((await world.call('GET', draft.url, target.engineer)).status).toBe(200);
      const renewed = await publish(target, draft.sha256);
      expect(renewed.body.request).toMatchObject({ status: 'pending', version: 3 });
    });

    it('模板：打开后代建工程师的保存变成申请，当前修订不动；批准后生效，修订记申请人，当前修订的来历记批准的人', async () => {
      const target = await tenant();
      await policy(target, { templates: true });
      const before = await revisions(target), copy = await engineerCopy(target);
      const requested = await save(target, copy.url, copy.sha256);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      expect(requested.body.request).toMatchObject({ kind: 'templateSave', subject: '问候牌', scopes: ['templates'], sha256: copy.sha256, baseRevision: 1, beforeSha256: before.revisions[0].sha256 });
      expect(await revisions(target)).toEqual(before);
      const id = requested.body.request.id as string;
      const checked = await detail(target, id);
      expect(checked.recheck).toEqual({ valid: true });
      expect(checked.changes).toBeTruthy();

      const approved = await approve(target, id);
      expect(approved.status, approved.raw.slice(0, 300)).toBe(200);
      expect(approved.body.result).toMatchObject({ name: '问候牌', revision: 2, status: 'saved', sha256: copy.sha256 });
      const after = await revisions(target);
      expect(after).toMatchObject({ currentRevision: 2, current: { source: 'web', action: 'revision', by: target.admin.email } });
      expect(after.revisions[1]).toMatchObject({ revision: 2, sha256: copy.sha256, source: 'web', pushedBy: target.label });
      expect((await world.call('GET', copy.url, target.engineer)).status).toBe(404);
      expect((await auditOf(target, 'template.save'))[0]).toMatchObject({ actor: { label: target.admin.email }, beforeSha256: before.revisions[0].sha256, afterSha256: copy.sha256 });

      // 客户管理员自己保存直接生效。
      const url = `/v1/templates/${GREETING}/working-copy`, own = await world.call('POST', url, target.admin.token);
      const content = (await world.call('GET', url, target.admin.token)).body.content as string;
      const stashed = await world.call('PUT', `${url}?expectedSha256=${own.body.sha256}`, target.admin.token, content.replace('#E0F4FF', '#112233'), JSON_TYPE);
      expect(await world.call('POST', `${url}/save`, target.admin.token, { expectedSha256: stashed.body.sha256 })).toMatchObject({ status: 200, body: { revision: 3 } });
    });

    it('模板：工作副本改了或当前修订变了就过期；基准不符的申请要显式 overwrite，批准时再变也过期', async () => {
      const target = await tenant();
      await policy(target, { templates: true });
      const copy = await engineerCopy(target);
      const edited = (await save(target, copy.url, copy.sha256)).body.request.id as string;
      const changed = await world.call('PUT', `${copy.url}?expectedSha256=${copy.sha256}`, target.engineer, copy.content.replace('#FFF4E0', '#AABBCC'), JSON_TYPE);
      expect(await detail(target, edited)).toMatchObject({ status: 'expired', message: '工作副本在申请之后又被修改' });

      const moved = (await save(target, copy.url, changed.body.sha256)).body.request.id as string;
      await moveCurrent(target, '#101010');
      expect((await detail(target, moved)).recheck.valid).toBe(false);
      const expired = await approve(target, moved);
      expect(expired).toMatchObject({ status: 409, body: { problems: [{ code: 'publishRequest.expired' }], request: { status: 'expired' } } });
      expect((await revisions(target)).currentRevision).toBe(2);
      expect((await world.call('GET', copy.url, target.engineer)).status).toBe(200);

      // 工作副本基于修订 1，当前已是 2：没写 overwrite 不记申请，答两边差异。
      const conflict = await save(target, copy.url, changed.body.sha256);
      expect(conflict.status).toBe(409);
      expect(conflict.body.problems[0].code).toBe('template.revisionConflict');
      expect(conflict.body.conflict).toMatchObject({ baseRevision: 1, currentRevision: 2 });
      const forced = await save(target, copy.url, changed.body.sha256, { overwrite: true });
      expect(forced.body.request).toMatchObject({ baseRevision: 2, overwrite: true });
      await moveCurrent(target, '#202020');
      expect((await approve(target, forced.body.request.id)).body.problems[0].code).toBe('publishRequest.expired');
      const renewed = await save(target, copy.url, changed.body.sha256, { overwrite: true });
      expect(renewed.body.request).toMatchObject({ baseRevision: 3, overwrite: true });
      expect((await approve(target, renewed.body.request.id)).body.result).toMatchObject({ revision: 4, sha256: changed.body.sha256 });
    });

    it('指回：打开后代建工程师的指回变成申请；批准时当前修订变了就过期；批准后来历记批准的人', async () => {
      const target = await tenant();
      await moveCurrent(target, '#101010');
      await policy(target, { templates: true });
      const point = (revision: number) => world.call('POST', `${target.prefix}/template-current`, target.engineer, { template: '问候牌', revision });
      expect((await point(9)).status).toBe(404);
      const requested = await point(1);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      const before = await revisions(target);
      expect(requested.body.request).toMatchObject({ kind: 'templateSetCurrent', subject: '问候牌', revision: 1, baseRevision: 2, sha256: before.revisions[0].sha256, beforeSha256: before.revisions[1].sha256, diff: { changed: 1 } });
      expect(before.currentRevision).toBe(2);

      const approved = await approve(target, requested.body.request.id);
      expect(approved.status, approved.raw.slice(0, 300)).toBe(200);
      expect(await revisions(target)).toMatchObject({ currentRevision: 1, current: { source: 'web', action: 'setCurrent', by: target.admin.email } });
      expect((await auditOf(target, 'template.setCurrent'))[0]).toMatchObject({ actor: { label: target.admin.email }, afterSha256: before.revisions[0].sha256 });

      const stale = await point(2);
      await moveCurrent(target, '#303030');
      expect((await detail(target, stale.body.request.id)).recheck.valid).toBe(false);
      expect((await approve(target, stale.body.request.id)).body.problems[0].code).toBe('publishRequest.expired');
      expect((await revisions(target)).currentRevision).toBe(3);
    });

    it('严重问题：不能成为申请；申请之后才出现的，批准时过期并列出问题', async () => {
      const target = await tenant(seedM402);
      await policy(target, { templates: true });
      const ROUTE_SIGN = encodeURIComponent('标准线路单边');
      const url = `${target.prefix}/templates/${ROUTE_SIGN}/working-copy`;
      const copy = await world.call('POST', url, target.engineer);
      const original = (await world.call('GET', url, target.engineer)).body.content as string;
      const stashed = await world.call('PUT', `${url}?expectedSha256=${copy.body.sha256}`, target.engineer, original.replace('"var": "routeNoImage"', '"var": "没有这个字段"'), JSON_TYPE);
      expect(stashed.status).toBe(200);
      const refused = await save(target, url, stashed.body.sha256);
      expect(refused.status, refused.raw.slice(0, 300)).toBe(400);
      expect((await world.call('GET', '/v1/publish-requests', target.admin.token)).body.requests).toEqual([]);

      // 换一份没问题的内容，记下申请；再让它调用的子模板缺了参数，父模板就有了严重问题。
      const clean = await world.call('PUT', `${url}?expectedSha256=${stashed.body.sha256}`, target.engineer, original.replace(/"#[0-9A-Fa-f]{6}"/, '"#123456"'), JSON_TYPE);
      const requested = await save(target, url, clean.body.sha256);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      const child = JSON.parse(await readFile(`${M402_DIR}template-stop.json`, 'utf8'));
      child.parameters = child.parameters.filter((parameter: { name: string }) => parameter.name !== 'index');
      await seedDocuments(backend.tenant(target.id).storage, [bytes(child)]);

      const id = requested.body.request.id as string, checked = await detail(target, id);
      expect(checked.recheck.valid).toBe(false);
      expect(checked.recheck.blockers.length).toBeGreaterThan(0);
      const expired = await approve(target, id);
      expect(expired.status).toBe(409);
      expect(expired.body.problems[0].code).toBe('publishRequest.expired');
      expect(expired.body.request.status).toBe('expired');
      expect(expired.body.blockers.length).toBeGreaterThan(0);
      expect((await revisions(target, ROUTE_SIGN)).currentRevision).toBe(1);
    });

    it('推送：写入碰到打开的范围才变成申请，内容已上传但读不到；批准时按推送规则重算冲突，再一次提交', async () => {
      const target = await tenant();
      const pushes = `${target.prefix}/pushes`;
      // 只打开数据定义：只改模板的推送不受约束。
      await policy(target, { definitions: true });
      const direct = await pushManifest(target, '#010101', { baseRevision: 1 });
      expect((await world.call('POST', pushes, target.engineer, direct)).status).toBe(200);
      expect((await revisions(target)).currentRevision).toBe(2);

      await policy(target, { templates: true });
      const manifest = await pushManifest(target, '#020202', { baseRevision: 2 });
      const plan = await world.call('POST', `${target.prefix}/push-plans`, target.engineer, manifest);
      expect(plan.body).toMatchObject({ approvalScopes: ['templates'], uploads: [] });
      const requested = await world.call('POST', pushes, target.engineer, manifest);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      expect(requested.body.summary).toMatchObject({ updated: 1 });
      expect(requested.body.request).toMatchObject({ kind: 'push', scopes: ['templates'], status: 'pending', requestedBy: { label: target.label }, diff: { changed: 1 } });
      expect((await revisions(target)).currentRevision).toBe(2);
      // 没登记的内容读不到：推送清单与模板内容都一样。
      expect((await world.call('GET', `${target.prefix}/contents/${manifest.documents[0]!.sha256}`, target.engineer)).status).toBe(404);
      expect((await world.call('GET', `${target.prefix}/contents/${requested.body.request.sha256}`, target.engineer)).status).toBe(404);
      const id = requested.body.request.id as string;
      expect((await detail(target, id)).changes.documents[0]).toMatchObject({ key: '问候牌', status: 'updated' });
      // 重发同一份清单答同一份申请。
      expect((await world.call('POST', pushes, target.engineer, manifest)).body.request.id).toBe(id);

      const approved = await approve(target, id);
      expect(approved.status, approved.raw.slice(0, 300)).toBe(200);
      expect(approved.body.result.documents[0]).toMatchObject({ key: '问候牌', status: 'updated', revision: 3 });
      const after = await revisions(target);
      // 内容与主体还是推送的；批准产生的修订算网页一侧（M354），下一次从旧内容推送会挡住。
      expect(after.revisions[2]).toMatchObject({ source: 'push', pushedBy: target.label, sha256: manifest.documents[0]!.sha256 });
      expect(after).toMatchObject({ currentRevision: 3, current: { source: 'web', action: 'revision', by: target.admin.email } });
      expect((await auditOf(target, 'push.commit'))[0]).toMatchObject({ actor: { label: target.admin.email }, object: { type: 'push', id }, diff: { changed: 1 } });

      // 新的清单让旧的申请过期；申请之后别人先改了，批准时重算出冲突，过期。
      const first = await pushManifest(target, '#030303', { baseRevision: 3 }), second = await pushManifest(target, '#040404', { baseRevision: 3 });
      const superseded = (await world.call('POST', pushes, target.engineer, first)).body.request.id as string;
      const latest = (await world.call('POST', pushes, target.engineer, second)).body.request.id as string;
      expect(await detail(target, superseded)).toMatchObject({ status: 'expired', message: '同一对象有了新的申请' });
      expect((await detail(target, latest)).recheck.valid).toBe(true);
      await moveCurrent(target, '#050505');
      const stale = await detail(target, latest);
      expect(stale.recheck.valid).toBe(false);
      expect(stale.changes.summary.conflicts).toBe(1);
      expect((await approve(target, latest)).body.problems[0].code).toBe('publishRequest.expired');
      expect((await revisions(target)).currentRevision).toBe(4);

      // 现在就有冲突、或内容没上传的推送，照旧拒绝，不记申请。
      const count = (await world.call('GET', '/v1/publish-requests', target.admin.token)).body.requests.length;
      expect((await world.call('POST', pushes, target.engineer, await pushManifest(target, '#060606', { baseRevision: 1 }))).status).toBe(409);
      const missing = await pushManifest(target, '#070707', { baseRevision: 4 });
      expect((await world.call('POST', pushes, target.engineer, { ...missing, documents: [{ ...missing.documents[0]!, sha256: 'b'.repeat(64) }] })).status).toBe(400);
      expect((await world.call('GET', '/v1/publish-requests', target.admin.token)).body.requests).toHaveLength(count);
    });

    it('推送的范围：只写数据集不受约束；写静态数据定义的受数据定义范围约束，范围不开不约束', async () => {
      const target = await tenant();
      await policy(target, { templates: true });
      const upload = async (document: unknown) => {
        const content = bytes(document), hash = sha256(content);
        expect((await world.call('PUT', `${target.prefix}/contents/${hash}`, target.engineer, content)).status).toBe(204);
        return { sha256: hash, byteLength: content.length };
      };
      const pushes = `${target.prefix}/pushes`;
      const dataset = await upload({ dataset: { id: 'ds-direct', staticSchema: { name: '问候', version: 1 } }, data: { message: '直接生效' } });
      const onlyDataset = await world.call('POST', pushes, target.engineer, { documents: [{ kind: 'dataset', key: 'ds-direct', ...dataset }], resources: [] });
      expect(onlyDataset.status, onlyDataset.raw.slice(0, 300)).toBe(200);

      const storage = backend.tenant(target.id).storage, stored = (await storage.authoringState()).documents;
      const read = async (kind: string) => JSON.parse(Buffer.from((await storage.contents.get(stored.find((item) => item.kind === kind && item.key === '问候@1')!.sha256))!).toString('utf8'));
      const definition = await upload({ ...await read('definition'), version: 2 }), compiled = await upload({ ...await read('compiled'), 'x-renderweave-static-schema': { name: '问候', version: 2 } });
      const manifest = { documents: [{ kind: 'definition', key: '问候@2', ...definition }, { kind: 'compiled', key: '问候@2', ...compiled }], resources: [] };
      // 模板范围打开、数据定义范围关着：直接生效的是另一个版本号，不走到这里。
      expect((await world.call('POST', `${target.prefix}/push-plans`, target.engineer, manifest)).body.approvalScopes).toBeUndefined();
      await policy(target, { definitions: true, templates: false });
      const requested = await world.call('POST', pushes, target.engineer, manifest);
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      expect(requested.body.request).toMatchObject({ kind: 'push', scopes: ['definitions'], diff: { added: 2 } });
      expect(await versions(target)).toEqual([1]);
      expect((await approve(target, requested.body.request.id)).status).toBe(200);
      expect(await versions(target)).toEqual([1, 2]);
      expect((await auditOf(target, 'push.commit')).at(0)).toMatchObject({ actor: { label: target.admin.email }, diff: { added: 2 } });
    });

    it('批准与内容在同一个事务里：重核之后申请被退回，内容不生效', async () => {
      const target = await tenant();
      await policy(target, { templates: true });
      const copy = await engineerCopy(target);
      const id = (await save(target, copy.url, copy.sha256)).body.request.id as string;
      beforeCommit = async () => {
        expect((await world.call('POST', `/v1/publish-requests/${id}/reject`, target.admin.token, { message: '抢先退回' })).status).toBe(200);
      };
      const reply = await approve(target, id);
      expect(reply).toMatchObject({ status: 409, body: { problems: [{ code: 'publishRequest.decided' }], request: { status: 'rejected', message: '抢先退回' } } });
      expect((await revisions(target)).currentRevision).toBe(1);
      expect((await world.call('GET', copy.url, target.engineer)).status).toBe(200);
      expect(await auditOf(target, 'publishRequest.approve', 'template.save')).toHaveLength(0);
    });

    it('内容改了而申请还没标过期（保存之后中断）：批准时重核内容哈希，不会批错内容', async () => {
      const target = await tenant();
      await policy(target, { definitions: true, templates: true });
      const storage = backend.tenant(target.id).storage, by = { updatedBy: '测试', now: new Date() };
      const draft = await engineerDraft(target);
      const draftRequest = (await publish(target, draft.sha256)).body.request.id as string;
      await storage.saveDefinition('问候', draft.sha256, bytes({ ...draft.document, displayName: '绕过接口改的' }), by);
      expect(await detail(target, draftRequest)).toMatchObject({ status: 'pending', recheck: { valid: false, message: '数据定义在申请之后又被修改' } });
      expect((await approve(target, draftRequest)).body.problems[0].code).toBe('publishRequest.expired');
      expect(await versions(target)).toEqual([1]);

      const copy = await engineerCopy(target);
      const copyRequest = (await save(target, copy.url, copy.sha256)).body.request.id as string;
      await storage.saveTemplateWorkingCopy('问候牌', copy.sha256, new Uint8Array(Buffer.from(copy.content.replace('#FFF4E0', '#999999'))), by);
      expect(await detail(target, copyRequest)).toMatchObject({ status: 'pending', recheck: { valid: false, message: '工作副本在申请之后又被修改' } });
      expect((await approve(target, copyRequest)).body.problems[0].code).toBe('publishRequest.expired');
      expect((await revisions(target)).currentRevision).toBe(1);
    });

    it('并发：同一份申请同时批准只生效一次；批准与退回只有一边算数', async () => {
      const target = await tenant();
      await policy(target, { templates: true });
      const copy = await engineerCopy(target);
      const id = (await save(target, copy.url, copy.sha256)).body.request.id as string;
      const replies = await Promise.all([approve(target, id), approve(target, id), approve(target, id)]);
      expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409, 409]);
      expect((await revisions(target)).currentRevision).toBe(2);
      expect(await auditOf(target, 'publishRequest.approve')).toHaveLength(1);

      const second = await engineerCopy(target, '#ABCDEF');
      const another = (await save(target, second.url, second.sha256)).body.request.id as string;
      const [approved, rejected] = await Promise.all([approve(target, another), world.call('POST', `/v1/publish-requests/${another}/reject`, target.admin.token, { message: '不要了' })]);
      expect([approved.status, rejected.status].sort()).toEqual([200, 409]);
      const settled = await detail(target, another);
      expect(settled.status).toBe(approved.status === 200 ? 'approved' : 'rejected');
      expect((await revisions(target)).currentRevision).toBe(approved.status === 200 ? 3 : 2);
    });

    /** 经存储放进 问候@2：原文与编译产物都有，与推送进来的相同。 */
    const seededVersionTwo = async (storage: TenantStorage) => {
      const stored = (await storage.authoringState()).documents;
      const read = async (kind: string) => JSON.parse(Buffer.from((await storage.contents.get(stored.find((item) => item.kind === kind && item.key === '问候@1')!.sha256))!).toString('utf8'));
      const definition = await read('definition'), compiled = await read('compiled');
      await seedDocuments(storage, [bytes({ ...definition, version: 2 }), bytes({ ...compiled, 'x-renderweave-static-schema': { name: '问候', version: 2 } })]);
      return (await storage.authoringState()).documents.some((item) => item.kind === 'definition' && item.key === '问候@2');
    };
  });
}
