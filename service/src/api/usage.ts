/**
 * 计量与额度的端点（票据 09，ADR-0020、M242）。
 * - 本租户一个计费周期的用量：出图张数的限额、已用、预占与剩余，各种 token 的合计；客户成员与 API 密钥都能看（M300）；
 * - 用量事件的明细只给客户管理员；
 * - 平台管理员设置租户的套餐（每月出图张数、单张最大像素、并发数），并看任一租户的用量与明细，记进该租户的审计。
 * 周期是按 UTC+8 切分的自然月，写作 YYYY-MM，缺省是当前周期。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ENGINE_MAX_PIXELS, PERIOD, periodOf, periodRange, USAGE_KINDS, type Plan, type TenantScope, type UsageKind } from '../backend.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { notFound, objectId } from './problems.js';

/** 套餐的取值范围：单张最大像素不超过引擎上限，并发数与容量基线（票据 15）的量级相当。 */
export const PLAN_SCHEMA = {
  type: 'object', required: ['monthlyImages', 'maxPixels', 'concurrency'], additionalProperties: false,
  properties: {
    monthlyImages: { type: 'integer', minimum: 0, maximum: 1_000_000_000 },
    maxPixels: { type: 'integer', minimum: 1, maximum: ENGINE_MAX_PIXELS },
    concurrency: { type: 'integer', minimum: 1, maximum: 64 },
  },
} as const;

const PERIOD_PATTERN = PERIOD.source;
const USAGE_QUERY = { querystring: { type: 'object', additionalProperties: false, properties: { period: { type: 'string', pattern: PERIOD_PATTERN } } } };
const EVENTS_QUERY = { querystring: { type: 'object', additionalProperties: false, properties: {
  period: { type: 'string', pattern: PERIOD_PATTERN }, kind: { type: 'string', enum: USAGE_KINDS },
  limit: { type: 'string', pattern: '^([1-9][0-9]?|[1-4][0-9]{2}|500)$' }, before: { type: 'string', pattern: '^[1-9][0-9]{0,17}$' },
} } };

export function registerUsageRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, now } = context;
  const periodOfQuery = (request: FastifyRequest) => (request.query as { period?: string }).period ?? periodOf(now());

  /** 一个周期的用量；剩余额度 = 限额 − 已用 − 预占，不小于 0。 */
  const usage = async (scope: TenantScope, period: string) => {
    const [counts, plan] = await Promise.all([scope.usage(period), scope.plan()]);
    const { start, end } = periodRange(period);
    return {
      period, start: start.toISOString(), end: end.toISOString(), plan,
      images: { limit: counts.limit, used: counts.used, reserved: counts.reserved, remaining: Math.max(counts.limit - counts.used - counts.reserved, 0) },
      tokens: counts.tokens,
    };
  };
  const events = async (scope: TenantScope, request: FastifyRequest) => {
    const query = request.query as { kind?: UsageKind; limit?: string; before?: string };
    const limit = Number(query.limit ?? 100), period = periodOfQuery(request);
    const list = await scope.listUsageEvents({ period, ...(query.kind ? { kind: query.kind } : {}), ...(query.before ? { before: query.before } : {}), limit });
    return { period, events: list, ...(list.length === limit ? { next: list.at(-1)!.id } : {}) };
  };
  const ownScope = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  /** 平台管理员操作的目标租户：不存在时答 404；每次都记进该租户的审计（跨租户操作）。 */
  const platformScope = async (request: FastifyRequest, action: string) => {
    const scope = backend.tenant(objectId((request.params as { tenantId: string }).tenantId));
    if (!(await scope.get())) throw notFound();
    await scope.appendAudit({ actor: actorOf(identityOf(request)), action, object: { type: 'tenant', id: scope.tenantId }, crossTenant: true }, now());
    return scope;
  };

  app.get('/v1/usage', { config: { access: 'usage.summary' }, schema: USAGE_QUERY }, async (request) => usage(ownScope(request), periodOfQuery(request)));
  app.get('/v1/usage/events', { config: { access: 'usage.read' }, schema: EVENTS_QUERY }, async (request) => events(ownScope(request), request));

  app.get('/v1/platform/tenants/:tenantId/plan', { config: { access: 'platform.plans' } }, async (request) => (await platformScope(request, 'plan.read')).plan());
  app.put('/v1/platform/tenants/:tenantId/plan', { config: { access: 'platform.plans' }, schema: { body: PLAN_SCHEMA } }, async (request) => {
    const plan = request.body as Plan, scope = await platformScope(request, 'plan.update');
    await scope.setPlan({ monthlyImages: plan.monthlyImages, maxPixels: plan.maxPixels, concurrency: plan.concurrency }, now());
    return scope.plan();
  });
  app.get('/v1/platform/tenants/:tenantId/usage', { config: { access: 'platform.plans' }, schema: USAGE_QUERY }, async (request) =>
    usage(await platformScope(request, 'usage.read'), periodOfQuery(request)));
  app.get('/v1/platform/tenants/:tenantId/usage/events', { config: { access: 'platform.plans' }, schema: EVENTS_QUERY }, async (request) =>
    events(await platformScope(request, 'usage.read'), request));
}
