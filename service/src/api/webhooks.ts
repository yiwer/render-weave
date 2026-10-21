/**
 * webhook 的端点（票据 11，M246、M247）：客户管理员与 API 密钥注册、查看、停用与重新启用 webhook，查看投递记录。
 * - 注册时生成这个 webhook 的签名密钥，只在注册的回答里出现一次；之后只给前缀；
 * - URL 在注册时检查：生产只收 https 与公网地址（连接时还会再查解析出的地址，见 webhooks.ts）；
 * - 每个租户最多同时启用 MAX_ACTIVE_WEBHOOKS 个；webhook 不删除，停用后不再投递，投递记录保留。
 * 租户由身份决定；别的租户的 webhook 与不存在的同样答 404。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { MAX_ACTIVE_WEBHOOKS, WEBHOOK_EVENT_TYPES, type Webhook, type WebhookEventType } from '../backend.js';
import { generateWebhookSecret, sealSecret, webhookUrlProblem } from '../webhooks.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { fail, notFound, objectId, ServiceProblemCodes } from './problems.js';

const DESCRIPTION = { type: 'string', minLength: 1, maxLength: 200 } as const;
const EVENTS = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: WEBHOOK_EVENT_TYPES } } as const;

export function registerWebhookRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, now } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  const audit = (request: FastifyRequest, action: string, id: string) =>
    scopeOf(request).appendAudit({ actor: actorOf(identityOf(request)), action, object: { type: 'webhook', id }, crossTenant: false }, now());
  const limitReached = () => fail(409, ServiceProblemCodes.webhookLimitReached, 'request.body',
    `本租户已启用 ${MAX_ACTIVE_WEBHOOKS} 个 webhook，达到上限；先停用不用的再启用新的`);
  const webhookOf = async (request: FastifyRequest): Promise<Webhook> => {
    const found = await scopeOf(request).getWebhook(objectId((request.params as { webhookId: string }).webhookId));
    if (!found) throw notFound();
    return found;
  };

  app.post('/v1/webhooks', {
    config: { access: 'webhooks.manage' },
    schema: { body: { type: 'object', required: ['url'], additionalProperties: false, properties: {
      url: { type: 'string', minLength: 1, maxLength: 2000 }, description: DESCRIPTION, events: EVENTS } } },
  }, async (request, reply) => {
    const body = request.body as { url: string; description?: string; events?: WebhookEventType[] };
    const problem = webhookUrlProblem(body.url, context.allowPrivateWebhooks);
    if (problem) throw fail(400, ServiceProblemCodes.webhookUrlNotAllowed, 'request.body.url', problem);
    const scope = scopeOf(request), { secret, prefix } = generateWebhookSecret();
    const created = await scope.createWebhook({
      url: new URL(body.url).toString(), ...(body.description === undefined ? {} : { description: body.description }), events: body.events ?? ['batch.finished'],
      secretSealed: sealSecret(context.secretKey, scope.tenantId, secret), secretPrefix: prefix,
    }, now());
    if ('limitReached' in created) throw limitReached();
    await audit(request, 'webhook.create', created.id);
    reply.code(201);
    return { webhook: created, secret };
  });

  app.get('/v1/webhooks', { config: { access: 'webhooks.manage' } }, async (request) => ({ webhooks: await scopeOf(request).listWebhooks() }));

  app.get('/v1/webhooks/:webhookId', { config: { access: 'webhooks.manage' } }, async (request) => webhookOf(request));

  /** 停用、重新启用或改说明；URL 与订阅的事件不改，要换就注册新的。 */
  app.patch('/v1/webhooks/:webhookId', {
    config: { access: 'webhooks.manage' },
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { active: { type: 'boolean' }, description: DESCRIPTION } } },
  }, async (request) => {
    const id = objectId((request.params as { webhookId: string }).webhookId);
    const updated = await scopeOf(request).updateWebhook(id, request.body as { active?: boolean; description?: string }, now());
    if (!updated) throw notFound();
    if ('limitReached' in updated) throw limitReached();
    await audit(request, 'webhook.update', id);
    return updated;
  });

  /** 投递记录：按 ID 倒序，每条带各次尝试的时间、耗时与 HTTP 状态或失败原因。 */
  app.get('/v1/webhooks/:webhookId/deliveries', {
    config: { access: 'webhooks.manage' },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: {
      limit: { type: 'string', pattern: '^([1-9][0-9]?|100)$' }, before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' } } } },
  }, async (request) => {
    const webhook = await webhookOf(request), query = request.query as { limit?: string; before?: string };
    const limit = Number(query.limit ?? 50);
    const deliveries = await scopeOf(request).listWebhookDeliveries(webhook.id, { limit, ...(query.before ? { before: query.before } : {}) });
    return { deliveries, ...(deliveries.length === limit ? { next: deliveries.at(-1)!.id } : {}) };
  });
}
