/**
 * 接口进程的 HTTP 外壳（ADR-0017、M259）：鉴权、校验，再交给后端；它自己不渲染。
 * 每个路由声明访问要求（permissions.ts），鉴权钩子统一判断；错误一律带问题清单。
 */
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Actor, Identity, ServiceBackend } from '../backend.js';
import { hashToken, tokenShape, type PasswordCost } from '../credentials.js';
import { parseJsonKeepingPrecision } from '../engine.js';
import type { Logger } from '../log.js';
import { can, type Access } from './permissions.js';
import { ApiError, fail, problem, ServiceProblemCodes, validationProblems } from './problems.js';
import { registerAuthoringRoutes } from './authoring.js';
import { registerBatchRoutes } from './batches.js';
import { registerDatasetRoutes } from './datasets.js';
import { DEFAULT_LIMITS, registerPreviewRoutes, type ServiceLimits } from './previews.js';
import { registerRecordRoutes } from './records.js';
import { registerResourceRoutes } from './resources.js';
import { registerRoutes } from './routes.js';

declare module 'fastify' {
  interface FastifyContextConfig { access?: Access }
  interface FastifyRequest { identity: Identity | null }
}

export interface ApiOptions {
  readonly backend: ServiceBackend;
  readonly build: string;
  readonly logger: Logger;
  /** 当前时间；测试用它控制会话与令牌的过期。 */
  readonly now?: () => Date;
  readonly passwordCost?: PasswordCost;
  /** 入队前的限制与预览的并发、频率（ADR-0017）；缺省值见 DEFAULT_LIMITS。 */
  readonly limits?: Partial<ServiceLimits>;
}

export interface ApiContext {
  readonly backend: ServiceBackend;
  readonly now: () => Date;
  readonly passwordCost: PasswordCost;
  readonly limits: ServiceLimits;
}

/** 已注册的路由与访问要求，供跨租户端点清单的测试核对。 */
export interface RouteEntry { readonly method: string; readonly url: string; readonly access: Access }

export function createApi(options: ApiOptions): FastifyInstance & { routeTable: RouteEntry[] } {
  const context: ApiContext = {
    backend: options.backend, now: options.now ?? (() => new Date()), passwordCost: options.passwordCost ?? 'production', limits: { ...DEFAULT_LIMITS, ...options.limits },
  };
  const app = Fastify({ loggerInstance: options.logger as FastifyBaseLogger, ajv: { customOptions: { allErrors: false, removeAdditional: false, coerceTypes: false } } });
  const routeTable: RouteEntry[] = [];
  app.decorateRequest('identity', null);
  // JSON 请求体按原文检查精度：超过 15 位有效数字的数值按双精度读取会失真，与命令行一样拒绝（M112）。
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_request, body, done) => {
    const tooPrecise: string[] = [];
    let value: unknown;
    try { value = parseJsonKeepingPrecision(String(body), tooPrecise); }
    catch { return done(fail(400, ServiceProblemCodes.requestInvalid, 'request.body', '请求体不是合法的 JSON'), undefined); }
    if (tooPrecise.length) {
      return done(fail(400, ServiceProblemCodes.requestInvalid, 'request.body', `请求中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}（M112）`), undefined);
    }
    done(null, value);
  });
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') routeTable.push({ method, url: route.url, access: route.config?.access ?? 'public' });
  });
  app.addHook('onRequest', async (request) => {
    const access = request.routeOptions.config?.access;
    if (!access || access === 'public') return;
    request.identity = await authenticate(context, request);
    if (access === 'authenticated') return;
    if (access === 'session') {
      if (request.identity.kind !== 'member' && request.identity.kind !== 'platformUser') throw forbidden();
      return;
    }
    if (!can(request.identity, access)) throw forbidden();
  });
  app.setErrorHandler((error: Error & { validation?: never[]; validationContext?: string; statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.status).send({ problems: error.problems, ...error.extra });
    if (error.validation) return reply.code(400).send({ problems: validationProblems(error.validation, error.validationContext ?? 'body') });
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const limit = request.routeOptions.bodyLimit;
      return reply.code(413).send({ problems: [problem(ServiceProblemCodes.limitRequestTooLarge, 'request.body', `请求超过${limit ? ` ${limit} 字节的` : '允许的'}上限`)] });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ problems: [problem(ServiceProblemCodes.requestInvalid, 'request', `请求无法处理：${error.code ?? error.message}`)] });
    }
    request.log.error({ err: error }, '请求处理失败');
    return reply.code(500).send({ problems: [problem(ServiceProblemCodes.internalError, 'request', '服务内部错误')] });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ problems: [problem(ServiceProblemCodes.notFound, 'request.path', '请求的对象不存在')] }));

  // 健康检查由编排每隔几秒调用一次，只在出问题时记日志。
  app.get('/healthz', { logLevel: 'warn' }, async () => ({ status: 'ok', service: 'api', build: options.build }));
  app.get('/readyz', { logLevel: 'warn' }, async (_request, reply) => {
    const result = await options.backend.readiness();
    if (!result.ready) options.logger.warn({ checks: result.checks }, '接口进程未就绪');
    reply.code(result.ready ? 200 : 503);
    return { status: result.ready ? 'ready' : 'unready', service: 'api', build: options.build, ...result };
  });
  registerRoutes(app, context);
  registerAuthoringRoutes(app, context);
  registerPreviewRoutes(app, context);
  registerBatchRoutes(app, context);
  registerDatasetRoutes(app, context);
  registerResourceRoutes(app, context);
  registerRecordRoutes(app, context);
  return Object.assign(app, { routeTable });
}

const forbidden = () => fail(403, ServiceProblemCodes.authForbidden, 'request.authorization', '当前身份没有这项操作的权限');

/** 从 Authorization: Bearer <令牌> 解析身份。缺少、格式不对、过期或吊销都答 401。 */
async function authenticate(context: ApiContext, request: FastifyRequest): Promise<Identity> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  const identity = token && tokenShape.test(token) ? await context.backend.platform.resolveToken(hashToken(token), context.now()) : undefined;
  if (!identity) throw fail(401, ServiceProblemCodes.authRequired, 'request.authorization', '需要有效的会话、API 密钥或代建令牌');
  return identity;
}

export function actorOf(identity: Identity): Actor {
  switch (identity.kind) {
    case 'member': return { kind: 'member', id: identity.userId, label: identity.email };
    case 'platformUser': return { kind: 'platformUser', id: identity.userId, label: identity.email };
    case 'apiKey': return { kind: 'apiKey', id: identity.keyId, label: identity.name };
    case 'authoringToken': return { kind: 'authoringToken', id: identity.tokenId, label: identity.label };
  }
}

/** 成员与 API 密钥只属于一个租户；其他身份没有"本租户"。 */
export function ownTenant(identity: Identity): string {
  if (identity.kind === 'member' || identity.kind === 'apiKey') return identity.tenantId;
  throw fail(403, ServiceProblemCodes.authForbidden, 'request.authorization', '当前身份不属于任何租户');
}

/** 已鉴权请求的身份；访问要求不是 public 的路由才有。 */
export function identityOf(request: FastifyRequest): Identity {
  if (!request.identity) throw fail(401, ServiceProblemCodes.authRequired, 'request.authorization', '需要有效的会话、API 密钥或代建令牌');
  return request.identity;
}
