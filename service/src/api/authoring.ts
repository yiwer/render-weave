/**
 * 代建工程师的端点（票据 04、05，M261、M264）：路径里写目标租户，只认令牌被指定的租户；
 * 不是被指定的租户、或租户不存在，都与随机 ID 同样答 404，而且在读请求体之前就答。
 * 每次调用都记进目标租户的审计，标为跨租户操作；不记内容与令牌。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NewAuditEvent, TenantScope } from '../backend.js';
import {
  checkManifest, conflictProblems, diffPush, MANIFEST_SCHEMA, pushWrites, registeredContents, sortedState, verifyContents, writtenContents,
  type PushDiff, type PushManifest,
} from '../push.js';
import { actorOf, identityOf, type ApiContext } from './app.js';
import { runPreview } from './previews.js';
import { ApiError, fail, notFound, objectId, ServiceProblemCodes } from './problems.js';

/** 单份上传内容的上限；思源黑体一类的中文字体约 16 MB。 */
export const MAX_CONTENT_BYTES = 64 * 1024 * 1024;
/** 推送清单（JSON）的上限。 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export function registerAuthoringRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, now } = context;
  const targets = new WeakMap<FastifyRequest, TenantScope>();
  const target = (request: FastifyRequest) => targets.get(request)!;
  const audit = (request: FastifyRequest, action: string, object: NewAuditEvent['object']) =>
    target(request).appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant: true }, now());

  app.register(async (scope) => {
    // 在全局鉴权之后、读请求体之前确定目标租户。
    scope.addHook('onRequest', async (request) => {
      const identity = identityOf(request), tenantId = objectId((request.params as { tenantId: string }).tenantId);
      if (identity.kind !== 'authoringToken' || !identity.tenantIds.includes(tenantId)) throw notFound();
      const tenant = backend.tenant(tenantId);
      if (!(await tenant.get())) throw notFound();
      targets.set(request, tenant);
    });
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CONTENT_BYTES }, (_request, body, done) => done(null, body));

    scope.get('/v1/authoring/tenants/:tenantId', { config: { access: 'authoring.read' } }, async (request) => {
      await audit(request, 'authoring.access', { type: 'tenant', id: target(request).tenantId });
      return (await target(request).get())!;
    });

    /** 租户工作区的当前状态：文档（模板为当前修订）、模板修订与资源内容版本。 */
    scope.get('/v1/authoring/tenants/:tenantId/workspace', { config: { access: 'authoring.read' } }, async (request) => {
      await audit(request, 'authoring.read', { type: 'tenant', id: target(request).tenantId });
      return sortedState(await target(request).storage.authoringState());
    });

    /** 按 SHA-256 读回已登记的内容；只上传、没登记的内容与不存在一样答 404。 */
    scope.get('/v1/authoring/tenants/:tenantId/contents/:sha256', { config: { access: 'authoring.read' } }, async (request, reply) => {
      const hash = contentHash(request);
      const storage = target(request).storage;
      const bytes = registeredContents(await storage.authoringState()).has(hash) ? await storage.contents.get(hash) : undefined;
      if (!bytes) throw notFound();
      await audit(request, 'content.read', { type: 'content', id: hash });
      return reply.type('application/octet-stream').send(Buffer.from(bytes));
    });

    /** 上传一份内容：按路径里的 SHA-256 核对；登记要等推送提交。 */
    scope.put('/v1/authoring/tenants/:tenantId/contents/:sha256', { config: { access: 'authoring.push' } }, async (request, reply) => {
      const hash = contentHash(request);
      if (!Buffer.isBuffer(request.body)) throw fail(415, ServiceProblemCodes.requestInvalid, 'request.body', '内容要以 application/octet-stream 上传');
      if (createHash('sha256').update(request.body).digest('hex') !== hash) throw fail(400, ServiceProblemCodes.pushContentMismatch, 'request.body', '上传内容的 SHA-256 与路径里的不一致');
      await target(request).storage.contents.put(request.body);
      await audit(request, 'content.upload', { type: 'content', id: hash });
      reply.code(204);
    });

    /** 推送前的差异：不写任何东西；uploads 是服务端还缺、提交前要上传的内容。 */
    scope.post('/v1/authoring/tenants/:tenantId/push-plans', { config: { access: 'authoring.push' }, bodyLimit: MAX_MANIFEST_BYTES, schema: { body: MANIFEST_SCHEMA } }, async (request) => {
      const manifest = validManifest(request.body);
      const storage = target(request).storage;
      const diff = diffPush(manifest, await storage.authoringState());
      const needed = diff.summary.conflicts ? [] : writtenContents(pushWrites(manifest, diff));
      const uploads: string[] = [];
      for (const hash of needed) if (!(await storage.contents.has(hash))) uploads.push(hash);
      await audit(request, 'push.plan', { type: 'tenant', id: target(request).tenantId });
      return { ...diff, uploads };
    });

    /** 提交：在一个事务里按最新状态重算差异；有冲突整体拒绝（409），内容没上传或不符也拒绝（400），服务端保持原样。 */
    scope.post('/v1/authoring/tenants/:tenantId/pushes', { config: { access: 'authoring.push' }, bodyLimit: MAX_MANIFEST_BYTES, schema: { body: MANIFEST_SCHEMA } }, async (request) => {
      const manifest = validManifest(request.body);
      const storage = target(request).storage, pushId = randomUUID();
      let diff: PushDiff | undefined;
      try {
        const { revisions } = await storage.push(async (state) => {
          diff = diffPush(manifest, state);
          if (diff.summary.conflicts) throw new ApiError(409, conflictProblems(diff), { diff });
          const writes = pushWrites(manifest, diff);
          const problems = await verifyContents(writes, storage.contents);
          if (problems.length) throw new ApiError(400, problems);
          return writes;
        }, { pushedBy: actorOf(identityOf(request)).label, now: now() });
        const result = { ...diff!, documents: diff!.documents.map((item) => (revisions.has(item.key) && item.kind === 'template' ? { ...item, revision: revisions.get(item.key)! } : item)) };
        await audit(request, 'push.commit', { type: 'push', id: pushId });
        return { pushId, ...result };
      } catch (error) {
        if (error instanceof ApiError) await audit(request, 'push.reject', { type: 'push', id: pushId });
        throw error;
      }
    });

    /** 用被指定租户的身份看草稿预览（票据 06）：与客户的预览同一套检查与限制。 */
    scope.post('/v1/authoring/tenants/:tenantId/previews', { config: { access: 'authoring.preview' }, bodyLimit: context.limits.maxRequestBytes }, async (request) => {
      const template = (request.body as { template?: unknown } | null)?.template;
      await audit(request, 'authoring.preview', { type: 'template', id: typeof template === 'string' ? template : '' });
      return runPreview(context, target(request), request.body);
    });

    /** 把模板的当前修订指向它已有的一个修订，可以指回旧修订。 */
    scope.post('/v1/authoring/tenants/:tenantId/template-current', {
      config: { access: 'authoring.push' },
      schema: { body: { type: 'object', required: ['template', 'revision'], additionalProperties: false,
        properties: { template: { type: 'string', minLength: 1, maxLength: 500 }, revision: { type: 'integer', minimum: 1 } } } },
    }, async (request) => {
      const { template, revision } = request.body as { template: string; revision: number };
      const updated = await target(request).storage.setCurrentTemplate(template, revision);
      if (!updated) throw notFound();
      await audit(request, 'template.setCurrent', { type: 'template', id: template });
      return sortedState({ documents: [], templates: [updated], resources: [] }).templates[0];
    });
  });
}

/** 路径里的 SHA-256 不合规时也答"不存在"。 */
function contentHash(request: FastifyRequest): string {
  const hash = (request.params as { sha256: string }).sha256;
  if (!SHA256.test(hash)) throw notFound();
  return hash;
}

function validManifest(body: unknown): PushManifest {
  const manifest = body as PushManifest;
  const problems = checkManifest(manifest);
  if (problems.length) throw new ApiError(400, problems);
  return manifest;
}
