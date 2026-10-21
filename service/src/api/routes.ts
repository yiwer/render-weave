/**
 * 账号、租户与鉴权的端点（M247、M261）。客户端点的租户由身份决定，路径里没有租户 ID；
 * 代建端点在 authoring.ts，路径里写目标租户。对象不在本租户时与不存在同样答 404。
 */
import type { FastifyInstance } from 'fastify';
import { EmailTakenError, type Identity, type Member, type MemberRole, type NewAuditEvent, type Plan, type TenantScope } from '../backend.js';
import { dummyVerify, generatePassword, generateToken, hashPassword, verifyPassword } from '../credentials.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { fail, notFound, objectId, ServiceProblemCodes } from './problems.js';
import { PLAN_SCHEMA } from './usage.js';

/** 会话有效期 12 小时；代建令牌缺省 30 天，最长 365 天。 */
const SESSION_HOURS = 12;
const email = { type: 'string', minLength: 3, maxLength: 254, pattern: '^[^@\\s]+@[^@\\s]+$' } as const;
const name = { type: 'string', minLength: 1, maxLength: 100 } as const;
const role = { type: 'string', enum: ['admin', 'operator'] } as const;
const body = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) =>
  ({ body: { type: 'object', properties, required, additionalProperties: false } });


const me = (identity: Identity) => {
  switch (identity.kind) {
    case 'member': return { kind: identity.kind, role: identity.role, userId: identity.userId, email: identity.email, tenantId: identity.tenantId };
    case 'platformUser': return { kind: identity.kind, role: 'platformAdmin', userId: identity.userId, email: identity.email };
    case 'apiKey': return { kind: identity.kind, role: 'apiKey', keyId: identity.keyId, name: identity.name, tenantId: identity.tenantId };
    case 'authoringToken': return { kind: identity.kind, role: 'authoringEngineer', tokenId: identity.tokenId, label: identity.label, tenantIds: identity.tenantIds };
  }
};

export function registerRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, now } = context;
  /** 写操作与跨租户操作追加写入审计：记人、操作与对象，不记业务内容与密钥。 */
  const audit = (scope: TenantScope, identity: Identity, action: string, object: NewAuditEvent['object']) =>
    scope.appendAudit({ actor: actorOf(identity), action, object, crossTenant: identity.kind === 'platformUser' || identity.kind === 'authoringToken' }, now());
  /** 平台管理员操作的目标租户；不存在时答 404。 */
  const platformTenant = async (tenantId: string) => {
    const scope = backend.tenant(objectId(tenantId));
    if (!(await scope.get())) throw notFound();
    return scope;
  };

  // —— 会话与身份 ——
  app.post('/v1/sessions', { config: { access: 'public' }, schema: body({ email, password: { type: 'string', minLength: 1, maxLength: 200 } }) }, async (request, reply) => {
    const { email: address, password } = request.body as { email: string; password: string };
    const login = await backend.platform.findLogin(address);
    if (!login) await dummyVerify(password, context.passwordCost);
    if (!login || !(await verifyPassword(password, login.passwordHash)) || !login.active) {
      throw fail(401, ServiceProblemCodes.authInvalidCredentials, 'request.body', '邮箱或密码不正确');
    }
    const { token, hash } = generateToken('session'), expiresAt = new Date(now().getTime() + SESSION_HOURS * 3_600_000);
    const sessionId = login.tenantId
      ? await backend.tenant(login.tenantId).createSession(login.userId, hash, expiresAt)
      : await backend.platform.createSession(login.userId, hash, expiresAt);
    const identity = (await backend.platform.resolveToken(hash, now()))!;
    const event = { actor: actorOf(identity), action: 'session.create', object: { type: 'session', id: sessionId }, crossTenant: false };
    if (login.tenantId) await backend.tenant(login.tenantId).appendAudit(event, now());
    else await backend.platform.appendAudit(event, now());
    reply.code(201);
    return { token, expiresAt: expiresAt.toISOString(), identity: me(identity) };
  });

  app.delete('/v1/sessions/current', { config: { access: 'session' } }, async (request, reply) => {
    const identity = identityOf(request);
    if (identity.kind === 'member' || identity.kind === 'platformUser') await backend.platform.revokeSession(identity.sessionId);
    reply.code(204);
  });

  app.get('/v1/me', { config: { access: 'authenticated' } }, async (request) => me(identityOf(request)));

  // —— 平台管理员：租户、成员账号与代建令牌 ——
  app.get('/v1/platform/tenants', { config: { access: 'platform.tenants' } }, async () => ({ tenants: await backend.platform.listTenants() }));

  // 建租户时可以一并设套餐（票据 09）；不设就是缺省套餐，每月 0 张，正式交付前要先设。
  app.post('/v1/platform/tenants', { config: { access: 'platform.tenants' }, schema: body({ name, plan: PLAN_SCHEMA }, ['name']) }, async (request, reply) => {
    const { name: tenantName, plan } = request.body as { name: string; plan?: Plan };
    const tenant = await backend.platform.createTenant(tenantName);
    const scope = backend.tenant(tenant.id);
    await audit(scope, identityOf(request), 'tenant.create', { type: 'tenant', id: tenant.id });
    if (plan) {
      await scope.setPlan({ monthlyImages: plan.monthlyImages, maxPixels: plan.maxPixels, concurrency: plan.concurrency }, now());
      await audit(scope, identityOf(request), 'plan.update', { type: 'tenant', id: tenant.id });
    }
    reply.code(201);
    return { ...tenant, plan: await scope.plan() };
  });

  app.get('/v1/platform/tenants/:tenantId/members', { config: { access: 'platform.members' } }, async (request) => {
    const scope = await platformTenant((request.params as { tenantId: string }).tenantId);
    await audit(scope, identityOf(request), 'member.list', { type: 'tenant', id: scope.tenantId });
    return { members: await scope.listMembers() };
  });

  app.post('/v1/platform/tenants/:tenantId/members', { config: { access: 'platform.members' }, schema: body({ email, role }) }, async (request, reply) => {
    const scope = await platformTenant((request.params as { tenantId: string }).tenantId);
    const { email: address, role: memberRole } = request.body as { email: string; role: MemberRole };
    const password = generatePassword();
    let member: Member;
    try { member = await scope.createMember({ email: address, role: memberRole, passwordHash: await hashPassword(password, context.passwordCost) }); }
    catch (error) {
      if (error instanceof EmailTakenError) throw fail(409, ServiceProblemCodes.memberEmailTaken, 'request.body.email', '这个邮箱已有账号');
      throw error;
    }
    await audit(scope, identityOf(request), 'member.create', { type: 'member', id: member.id });
    reply.code(201);
    return { member, initialPassword: password };
  });

  app.post('/v1/platform/tenants/:tenantId/members/:memberId/password-reset', { config: { access: 'platform.members' } }, async (request) => {
    const params = request.params as { tenantId: string; memberId: string };
    const scope = await platformTenant(params.tenantId), memberId = objectId(params.memberId);
    const password = generatePassword();
    if (!(await scope.setPassword(memberId, await hashPassword(password, context.passwordCost)))) throw notFound();
    await scope.revokeSessionsOf(memberId, now());
    await audit(scope, identityOf(request), 'member.passwordReset', { type: 'member', id: memberId });
    return { password };
  });

  app.get('/v1/platform/authoring-tokens', { config: { access: 'platform.authoringTokens' } }, async () => ({ tokens: await backend.platform.listAuthoringTokens() }));

  app.post('/v1/platform/authoring-tokens', {
    config: { access: 'platform.authoringTokens' },
    schema: body({
      label: name,
      tenantIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: { type: 'string' } },
      expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
    }, ['label', 'tenantIds']),
  }, async (request, reply) => {
    const { label, tenantIds, expiresInDays = 30 } = request.body as { label: string; tenantIds: string[]; expiresInDays?: number };
    const scopes = await Promise.all(tenantIds.map((id) => platformTenant(id)));
    const { token, hash, prefix } = generateToken('authoring');
    const info = await backend.platform.createAuthoringToken({ label, tokenHash: hash, prefix, tenantIds, expiresAt: new Date(now().getTime() + expiresInDays * 86_400_000) });
    const identity = identityOf(request);
    await backend.platform.appendAudit({ actor: actorOf(identity), action: 'authoringToken.create', object: { type: 'authoringToken', id: info.id }, crossTenant: false }, now());
    for (const scope of scopes) await audit(scope, identity, 'authoringToken.create', { type: 'authoringToken', id: info.id });
    reply.code(201);
    return { token, authoringToken: info };
  });

  app.delete('/v1/platform/authoring-tokens/:tokenId', { config: { access: 'platform.authoringTokens' } }, async (request, reply) => {
    const tokenId = objectId((request.params as { tokenId: string }).tokenId);
    const info = (await backend.platform.listAuthoringTokens()).find((token) => token.id === tokenId);
    if (!info || !(await backend.platform.revokeAuthoringToken(tokenId, now()))) throw notFound();
    const identity = identityOf(request);
    await backend.platform.appendAudit({ actor: actorOf(identity), action: 'authoringToken.revoke', object: { type: 'authoringToken', id: tokenId }, crossTenant: false }, now());
    for (const tenantId of info.tenantIds) await audit(backend.tenant(tenantId), identity, 'authoringToken.revoke', { type: 'authoringToken', id: tokenId });
    reply.code(204);
  });

  // —— 客户：本租户、成员、API 密钥与审计 ——
  app.get('/v1/tenant', { config: { access: 'tenant.read' } }, async (request) => {
    const tenant = await backend.tenant(ownTenant(identityOf(request))).get();
    if (!tenant) throw notFound();
    return tenant;
  });

  app.get('/v1/members', { config: { access: 'members.manage' } }, async (request) => ({ members: await backend.tenant(ownTenant(identityOf(request))).listMembers() }));

  app.patch('/v1/members/:memberId', {
    config: { access: 'members.manage' },
    schema: { body: { type: 'object', properties: { role, active: { type: 'boolean' } }, additionalProperties: false, minProperties: 1 } },
  }, async (request) => {
    const identity = identityOf(request), scope = backend.tenant(ownTenant(identity));
    const memberId = objectId((request.params as { memberId: string }).memberId);
    const change = request.body as { role?: MemberRole; active?: boolean };
    const members = await scope.listMembers(), target = members.find((member) => member.id === memberId);
    if (!target) throw notFound();
    const demoted = target.role === 'admin' && target.active && ((change.role && change.role !== 'admin') || change.active === false);
    if (demoted && members.filter((member) => member.role === 'admin' && member.active).length === 1) {
      throw fail(409, ServiceProblemCodes.memberLastAdmin, 'request.body', '租户至少要保留一个启用的管理员');
    }
    const updated = (await scope.updateMember(memberId, change))!;
    if (change.active === false) await scope.revokeSessionsOf(memberId, now());
    await audit(scope, identity, 'member.update', { type: 'member', id: memberId });
    return updated;
  });

  app.get('/v1/api-keys', { config: { access: 'apiKeys.manage' } }, async (request) => ({ apiKeys: await backend.tenant(ownTenant(identityOf(request))).listApiKeys() }));

  app.post('/v1/api-keys', { config: { access: 'apiKeys.manage' }, schema: body({ name }) }, async (request, reply) => {
    const identity = identityOf(request), scope = backend.tenant(ownTenant(identity));
    const { token, hash, prefix } = generateToken('apiKey');
    const apiKey = await scope.createApiKey({ name: (request.body as { name: string }).name, tokenHash: hash, prefix });
    await audit(scope, identity, 'apiKey.create', { type: 'apiKey', id: apiKey.id });
    reply.code(201);
    return { key: token, apiKey };
  });

  app.delete('/v1/api-keys/:keyId', { config: { access: 'apiKeys.manage' } }, async (request, reply) => {
    const identity = identityOf(request), scope = backend.tenant(ownTenant(identity));
    const keyId = objectId((request.params as { keyId: string }).keyId);
    if (!(await scope.revokeApiKey(keyId, now()))) throw notFound();
    await audit(scope, identity, 'apiKey.revoke', { type: 'apiKey', id: keyId });
    reply.code(204);
  });

  app.get('/v1/audit-events', {
    config: { access: 'audit.read' },
    schema: { querystring: { type: 'object', properties: { limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$' }, before: { type: 'string', pattern: '^[0-9]{1,18}$' } }, additionalProperties: false } },
  }, async (request) => {
    const query = request.query as { limit?: string; before?: string };
    const limit = Math.min(Number(query.limit ?? 100), 500);
    const events = await backend.tenant(ownTenant(identityOf(request))).listAudit({ limit, ...(query.before ? { before: query.before } : {}) });
    return { events, ...(events.length === limit ? { next: events.at(-1)!.id } : {}) };
  });
}
