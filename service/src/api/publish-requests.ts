/**
 * 发布申请的公共部分（P1 票据 11，ADR-0022）：写入路径用它判断要不要变成申请、记下申请、让过时的申请过期。
 * 路由与批准时的重核在 approvals.ts：它要调各写入路径，这里不能反过来依赖它们。
 */
import type { Actor, ApprovalScope, AuditContent, Identity, NewAuditEvent, PublishRequest, PublishRequestKind, TenantScope } from '../backend.js';
import { can } from './permissions.js';
import { fail, ServiceProblemCodes } from './problems.js';

/** 写审计：两种寻址的写入路径各有自己的主体与跨租户标记。 */
export type AuditWriter = (action: string, object: NewAuditEvent['object'], content?: AuditContent) => Promise<void>;

/** 一次写入的主体：记审计、记申请人、标过期都用它。 */
export interface RequestActor {
  readonly actor: Actor;
  readonly now: Date;
  readonly audit: AuditWriter;
}

export const requestObject = (request: PublishRequest): NewAuditEvent['object'] => ({ type: 'publishRequest', id: request.id });

/** 申请的审计内容：主体在事件上，这里是内容哈希与差异摘要。 */
export const requestContent = (request: PublishRequest): AuditContent => ({
  ...(request.beforeSha256 ? { beforeSha256: request.beforeSha256 } : {}), afterSha256: request.sha256, diff: request.diff,
});

/** 打开了策略的范围：能批准的主体（客户管理员）自己的发布直接生效，所以对它永远是空的。 */
export async function constrainedScopes(scope: TenantScope, identity: Identity, scopes: readonly ApprovalScope[]): Promise<readonly ApprovalScope[]> {
  if (!scopes.length || can(identity, 'authoring.approve')) return [];
  const policy = await scope.storage.approvalPolicy();
  return scopes.filter((item) => policy[item].required);
}

/** 这份待处理申请若有，就标为过期并记审计；答过期之后的申请。别人刚处理掉时什么也不做。 */
export async function expirePending(scope: TenantScope, kind: PublishRequestKind, subject: string, message: string, { actor, now, audit }: RequestActor, keepSha256?: string): Promise<void> {
  const pending = await scope.storage.pendingPublishRequest(kind, subject);
  if (!pending || pending.sha256 === keepSha256) return;
  const expired = await scope.storage.settlePublishRequest(pending.id, { status: 'expired', by: actor.label, now, message });
  if (expired) await audit('publishRequest.expire', requestObject(expired), requestContent(expired));
}

type RequestFields = Omit<PublishRequest, 'id' | 'status' | 'requestedAt' | 'requestedBy' | 'decidedBy' | 'decidedAt' | 'message'>;

/**
 * 记一份申请。同一对象同一种申请同时最多一份待处理：内容与基准都相同就答那一份（重发不多记），不同就让它过期，再记新的。
 * 并发时两边都记不下才答 409，再发一次就好。
 */
export async function openPublishRequest(scope: TenantScope, fields: RequestFields, requester: RequestActor): Promise<PublishRequest> {
  const pending = await scope.storage.pendingPublishRequest(fields.kind, fields.subject);
  if (pending && pending.sha256 === fields.sha256 && pending.baseRevision === fields.baseRevision && pending.revision === fields.revision && pending.version === fields.version) return pending;
  await expirePending(scope, fields.kind, fields.subject, '同一对象有了新的申请', requester);
  const created = await scope.storage.createPublishRequest({ ...fields, requestedBy: requester.actor }, requester.now);
  if (!created) throw fail(409, ServiceProblemCodes.publishRequestPending, 'request', '同一对象刚有了别的待处理申请；再发一次');
  await requester.audit('publishRequest.create', requestObject(created), requestContent(created));
  return created;
}
