/**
 * 审批策略与发布申请的端点（P1 票据 11，ADR-0021、ADR-0022）。
 * - 策略：两个范围各一个开关，缺省关（直发）；只有客户管理员能改，改动记审计。
 * - 读：一套实现，两种寻址（M261、M345）；代建工程师看得到自己申请的结果与退回的留言。批准与退回只有客户端点。
 * - 批准：先重核（内容哈希、基准、严重问题），任何一项不符就把申请标为过期，答 409；相符就与内容在同一个事务里生效，再记生效事件与批准事件。
 *   生效事件与直接发布相同（definition.publish、template.save、template.setCurrent、push.commit），主体是批准的人，发布记录照常读到它。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import { APPROVAL_SCOPES, PUBLISH_REQUEST_STATUSES, PublishRequestDecided, type ApprovalScope, type AuditDiffPath, type NewAuditEvent, type PublishRequest, type PublishRequestApproval, type PublishRequestStatus, type TenantScope } from '../backend.js';
import { checkTemplateStatic, diffDefinition, nextSchemaVersion, publishStaticSchema, readWorkspaceDocuments, revisionDiff, type Problem } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { commitPush, diffPush, pushProblems, pushWrites, verifyContents, type PushManifest } from '../push.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { parsedDocument, type AuthoringAddressing } from './authoring-documents.js';
import { baseDocumentOf, commitDraftPublish } from './definitions.js';
import { ApiError, notFound, objectId, problem, ServiceProblemCodes } from './problems.js';
import { requestContent, requestObject, type RequestActor } from './publish-requests.js';
import { commitCopy, currentOf, overlaid, setCurrentTemplate } from './template-copies.js';

const LIST_LIMIT = 200;
const POLICY_SCHEMA = {
  type: 'object', additionalProperties: false, minProperties: 1,
  properties: { definitions: { type: 'boolean', description: '数据定义发布要批准' }, templates: { type: 'boolean', description: '模板修订（含指回）要批准' } },
} as const;
const REJECT_SCHEMA = { type: 'object', required: ['message'], additionalProperties: false, properties: { message: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S', description: '退回的留言' } } } as const;
const LIST_QUERY = {
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string', enum: PUBLISH_REQUEST_STATUSES }, scope: { type: 'string', enum: APPROVAL_SCOPES },
    limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT, description: `至多多少份，缺省 ${LIST_LIMIT}` },
  },
} as const;

const STATUS_NAMES: Readonly<Record<PublishRequestStatus, string>> = { pending: '待处理', approved: '已批准', rejected: '已退回', expired: '已过期' };
const decided = (request: PublishRequest) => new ApiError(409, [problem(ServiceProblemCodes.publishRequestDecided, 'request.path.id', `这份申请${STATUS_NAMES[request.status]}，不能再处理`)], { request });

/** 重核的结果：还能批准时带着生效的做法；不能时是过期的原因。changes 给页面看这份申请改了什么。 */
type Recheck =
  | { readonly changes: unknown; readonly apply: (approving: PublishRequestApproval, approver: RequestActor) => Promise<unknown>; readonly stale?: undefined }
  | { readonly changes?: unknown; readonly stale: string; readonly blockers?: readonly unknown[]; readonly apply?: undefined };
const severeOf = (problems: readonly Problem[]) => problems.filter((item) => item.level === 'severe');

/** 重核一份待处理申请：内容哈希与基准都没变，没有严重问题（ADR-0021）。只读，详情与批准走同一份判断。 */
async function recheck(scope: TenantScope, request: PublishRequest): Promise<Recheck> {
  const storage = scope.storage;
  switch (request.kind) {
    case 'definitionPublish': {
      const draft = await storage.definitionDraft(request.subject);
      if (!draft) return { stale: '草案已经不在了' };
      if (draft.sha256 !== request.sha256) return { stale: '草案在申请之后又被修改' };
      const bytes = await storage.contents.get(draft.sha256);
      if (!bytes) return { stale: '草案的内容读不到' };
      const document = parsedDocument(bytes), workspace = await readWorkspaceDocuments(storage.documents);
      const base = draft.baseVersion === undefined ? undefined : workspace.staticSchemas.find((entry) => entry.ref.name === draft.name && entry.ref.version === draft.baseVersion)?.definition;
      const { problems: _none, ...changes } = diffDefinition(baseDocumentOf(base, document), document);
      const taken = workspace.staticSchemas.filter((entry) => entry.ref.name === draft.name).map((entry) => entry.ref.version);
      if (request.version !== undefined && taken.includes(request.version)) return { changes, stale: `申请时的版本 ${request.version} 已被占用，下一个版本已是 ${nextSchemaVersion(taken)}` };
      const { published, problems } = publishStaticSchema(document, workspace.staticSchemas, request.version === undefined ? {} : { version: request.version });
      if (!published) return { changes, stale: '草案有严重问题', blockers: problems };
      return { changes, apply: (approving, approver) => commitDraftPublish(scope, { draft, document, workspace, published, ...(request.note ? { note: request.note } : {}) }, approver.audit, approving) };
    }
    case 'templateSave': {
      const copy = await storage.templateWorkingCopy(request.subject);
      if (!copy) return { stale: '工作副本已经不在了' };
      if (copy.sha256 !== request.sha256) return { stale: '工作副本在申请之后又被修改' };
      const bytes = await storage.contents.get(copy.sha256);
      if (!bytes) return { stale: '工作副本的内容读不到' };
      const document = parsedDocument(bytes), state = await storage.authoringState(), current = currentOf(state, copy.name);
      const before = current && await storage.contents.get(current.revision.sha256);
      const changes = revisionDiff(before && parsedDocument(before), document);
      if (current?.template.currentRevision !== request.baseRevision) return { changes, stale: `当前修订已不是申请时的 ${request.baseRevision ?? '（无）'}` };
      const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), copy.name, document), copy.name);
      if (blocked || severeOf(problems).length) return { changes, stale: '工作副本有严重问题', blockers: severeOf(problems) };
      return {
        changes,
        apply: (approving, approver) => commitCopy(scope, { copy, document, before, current, overwrite: request.overwrite ?? false, expectedCurrent: request.baseRevision, pushedBy: request.requestedBy.label }, approver, approving),
      };
    }
    case 'templateSetCurrent': {
      const state = await storage.authoringState(), current = currentOf(state, request.subject);
      const target = current?.template.revisions.find((item) => item.revision === request.revision);
      if (!current || !target) return { stale: '模板或要指回的修订已经不在了' };
      const before = await storage.contents.get(current.revision.sha256), after = await storage.contents.get(target.sha256);
      if (!after) return { stale: '要指回的修订读不到内容' };
      const document = parsedDocument(after), changes = revisionDiff(before && parsedDocument(before), document);
      if (current.template.currentRevision !== request.baseRevision) return { changes, stale: `当前修订已不是申请时的 ${request.baseRevision}` };
      const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), request.subject, document), request.subject);
      if (blocked || severeOf(problems).length) return { changes, stale: '要指回的修订有严重问题', blockers: severeOf(problems) };
      return {
        changes,
        apply: ({ requestId, by, now }, approver) => setCurrentTemplate(scope, { template: request.subject, revision: request.revision }, {
          source: 'web', by, now, expectedCurrent: request.baseRevision!, approving: { requestId, by, now },
        }, approver.audit),
      };
    }
    case 'push': {
      const bytes = await storage.contents.get(request.sha256);
      if (!bytes) return { stale: '推送清单读不到' };
      const manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as PushManifest, state = await storage.authoringState();
      const changes = diffPush(manifest, state);
      if (changes.summary.conflicts) return { changes, stale: `按推送的规则重算有 ${changes.summary.conflicts} 处冲突：${[...changes.documents, ...changes.resources].find((item) => item.status === 'conflict')!.reason}` };
      const writes = pushWrites(manifest, changes), missing = await verifyContents(writes, storage.contents);
      if (missing.length) return { changes, stale: '推送的内容读不到或与清单不符', blockers: missing };
      const severe = await pushProblems(storage, writes);
      if (severe.length) return { changes, stale: '推送的模板有严重问题', blockers: severe };
      return { changes, apply: (approving, approver) => commitPush(scope, manifest, request.id, { pushedBy: request.requestedBy.label, now: approving.now, approving }, approver.audit) };
    }
  }
}

/** 审批策略与发布申请的读取：两种寻址共用。 */
export function registerApprovalReads(app: FastifyInstance, context: ApiContext, addressing: AuthoringAddressing): void {
  const { prefix, read, scopeOf, crossTenant } = addressing;
  const auditRead = async (request: FastifyRequest, object: NewAuditEvent['object']) => {
    if (crossTenant) await scopeOf(request).appendAudit({ actor: actorOf(identityOf(request)), action: 'authoring.read', object, crossTenant }, context.now());
  };

  app.get(`${prefix}/approval-policy`, { config: { access: read } }, async (request) => {
    const scope = scopeOf(request);
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return scope.storage.approvalPolicy();
  });

  /** 发布申请，新的在前；可以按状态与范围筛。列表不重核，要看现在还能不能批准读详情。 */
  app.get(`${prefix}/publish-requests`, { config: { access: read }, schema: { querystring: LIST_QUERY } }, async (request) => {
    const scope = scopeOf(request), { status, scope: approvalScope, limit } = request.query as { status?: PublishRequestStatus; scope?: ApprovalScope; limit?: number };
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return { requests: await scope.storage.publishRequests({ ...(status ? { status } : {}), ...(approvalScope ? { scope: approvalScope } : {}), limit: limit ?? LIST_LIMIT }) };
  });

  /** 一份申请：待处理时另给重核结果与它改了什么，批准之前看后果。 */
  app.get(`${prefix}/publish-requests/:id`, { config: { access: read } }, async (request) => {
    const scope = scopeOf(request), found = await scope.storage.publishRequest(objectId((request.params as { id: string }).id));
    if (!found) throw notFound();
    await auditRead(request, { type: 'publishRequest', id: found.id });
    if (found.status !== 'pending') return found;
    const checked = await recheck(scope, found);
    return {
      ...found, ...(checked.changes === undefined ? {} : { changes: checked.changes }),
      recheck: checked.stale ? { valid: false, message: checked.stale, ...(checked.blockers?.length ? { blockers: checked.blockers } : {}) } : { valid: true },
    };
  });
}

/** 客户端点：读取走上面那一份，改策略、批准与退回只有客户管理员。 */
export function registerCustomerApprovalRoutes(app: FastifyInstance, context: ApiContext): void {
  const { now } = context;
  const scopeOf = (request: FastifyRequest) => context.backend.tenant(ownTenant(identityOf(request)));
  registerApprovalReads(app, context, { prefix: '/v1', read: 'tenant.read', scopeOf, crossTenant: false });
  const approverOf = (request: FastifyRequest): RequestActor => {
    const actor = actorOf(identityOf(request));
    return { actor, now: now(), audit: (action, object, content = {}) => scopeOf(request).appendAudit({ actor, action, object, crossTenant: false, ...content }, now()) };
  };
  const requestOf = async (scope: TenantScope, request: FastifyRequest) => {
    const found = await scope.storage.publishRequest(objectId((request.params as { id: string }).id));
    if (!found) throw notFound();
    return found;
  };

  /** 改开关：只有真的改了的范围记进差异；什么也没变不记审计。 */
  app.put('/v1/approval-policy', { config: { access: 'authoring.policy' }, schema: { body: POLICY_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), body = request.body as Partial<Record<ApprovalScope, boolean>>, approver = approverOf(request);
    const before = await scope.storage.approvalPolicy();
    const changed = APPROVAL_SCOPES.filter((item) => body[item] !== undefined && body[item] !== before[item].required);
    if (!changed.length) return before;
    const after = await scope.storage.setApprovalPolicy(Object.fromEntries(changed.map((item) => [item, body[item]!])), { updatedBy: approver.actor.label, now: approver.now });
    await approver.audit('approvalPolicy.update', { type: 'tenant', id: scope.tenantId }, {
      diff: auditDiff(changed.map((item): AuditDiffPath => ({ path: `approvalPolicy:${item}`, change: 'changed' }))),
    });
    return after;
  });

  /** 批准：重核相符就生效，不符标为过期。回答申请与生效的结果。 */
  app.post('/v1/publish-requests/:id/approve', { config: { access: 'authoring.approve' } }, async (request) => {
    const scope = scopeOf(request), found = await requestOf(scope, request);
    if (found.status !== 'pending') throw decided(found);
    const approver = approverOf(request);
    const expire = async (message: string, blockers: readonly unknown[] = []) => {
      const expired = await scope.storage.settlePublishRequest(found.id, { status: 'expired', by: approver.actor.label, now: approver.now, message });
      if (!expired) return decided(await requestOf(scope, request));
      await approver.audit('publishRequest.expire', requestObject(expired), requestContent(expired));
      return new ApiError(409, [problem(ServiceProblemCodes.publishRequestExpired, 'request.path.id', `这份申请已过期：${message}；要重新发起`)], { request: expired, ...(blockers.length ? { blockers } : {}) });
    };
    const checked = await recheck(scope, found);
    if (checked.stale !== undefined) throw await expire(checked.stale, checked.blockers);
    let result: unknown;
    try {
      result = await checked.apply({ requestId: found.id, by: approver.actor.label, now: approver.now }, approver);
    } catch (error) {
      if (error instanceof PublishRequestDecided) throw decided(await requestOf(scope, request));
      // 重核之后、事务之前内容变了：写入路径照常答 409，这里按过期处理。
      if (error instanceof ApiError && error.status < 500) throw await expire(error.message);
      throw error;
    }
    const approved = await requestOf(scope, request);
    await approver.audit('publishRequest.approve', requestObject(approved), requestContent(approved));
    return { request: approved, result };
  });

  /** 退回：必须留言。 */
  app.post('/v1/publish-requests/:id/reject', { config: { access: 'authoring.approve' }, schema: { body: REJECT_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), found = await requestOf(scope, request), approver = approverOf(request);
    const rejected = await scope.storage.settlePublishRequest(found.id, { status: 'rejected', by: approver.actor.label, now: approver.now, message: (request.body as { message: string }).message });
    if (!rejected) throw decided(await requestOf(scope, request));
    await approver.audit('publishRequest.reject', requestObject(rejected), requestContent(rejected));
    return rejected;
  });
}
