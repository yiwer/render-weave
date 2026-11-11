/**
 * 模板工作副本与修订的端点（P1 票据 07，ADR-0022、M265、M267、M345、M346）：新建、暂存、丢弃、检查与保存工作副本，复制为新模板，从空白新建（模板设计页票据 18），修订历史，指回旧修订。
 * 一套处理逻辑，两种寻址（M261、M345），同数据定义。
 * - 暂存不影响当前修订：出图、只读预览与推送的差异都照旧读当前修订；预览可以指定用工作副本（previews.ts）；
 * - 保存时工作副本的基准不是当前修订答 409 并带两边差异，显式 overwrite 才覆盖，口径同 agent apply --overwrite；
 * - 模板静态检查有严重问题时拒绝保存（ADR-0021）；字节与当前修订相同记为不变（M265），工作副本照样删除；
 * - 指回旧修订（POST /v1/template-current）开放给客户管理员，代建工程师的端点在 authoring.ts，两边走 setCurrentTemplate；
 * - 模板范围打开了审批策略时，能批准的主体以外的保存与指回答 202，记一份发布申请（P1 票据 11）；申请之后工作副本又被修改，申请随之过期。
 * 客户成员的读取不记审计；代建工程师的读取与所有写入都记。写入另记前后内容哈希与差异摘要（M347）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import { documentSource, type AuditContent, type AuditDiff, type AuthoringState, type NewAuditEvent, type PublishRequestApproval, type TemplateCurrentOrigin, type TenantScope, type TenantStorage, type TemplateWorkingCopy } from '../backend.js';
import { checkTemplateStatic, diffTemplate, revisionDiff, type TemplateChange, type Workspace } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { sortedState } from '../push.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { checkedDocument, documentBytes, parsedDocument, staleDraft, type AuthoringAddressing } from './authoring-documents.js';
import { ApiError, fail, notFound, problem, ServiceProblemCodes } from './problems.js';
import { constrainedScopes, expirePending, openPublishRequest, type AuditWriter, type RequestActor } from './publish-requests.js';

/** 复制出来的模板名称：1–200 个字符，没有控制字符，首尾没有空白，也没有元素路径用的 / [ ]。推送进来的沿用本地的名称。 */
const NAME_PATTERN = '^(?=[\\s\\S]{1,200}$)[^\\s\\p{Cc}/\\[\\]](?:[^\\p{Cc}/\\[\\]]*[^\\s\\p{Cc}/\\[\\]])?$';
const SHA256 = '^[0-9a-f]{64}$';
const COPY_SCHEMA = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200, pattern: NAME_PATTERN } } } as const;
const RANGE_SCHEMA = { type: 'object', required: ['min', 'max'], additionalProperties: false, properties: { min: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 }, max: { type: 'number', exclusiveMinimum: 0, maximum: 100_000 } } } as const;
/** 从空白新建：名称、基准（静态数据定义的确切版本，或内置的空数据定义）与适用尺寸范围，同 DSL 的写法。 */
const BLANK_SCHEMA = {
  type: 'object', required: ['name', 'base', 'sizeRange'], additionalProperties: false,
  properties: {
    name: COPY_SCHEMA.properties.name,
    base: {
      type: 'object', required: ['name', 'version'], additionalProperties: false,
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, version: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }] } },
    },
    sizeRange: { type: 'object', required: ['width', 'height'], additionalProperties: false, properties: { width: RANGE_SCHEMA, height: RANGE_SCHEMA } },
  },
} as const;
const SAVE_SCHEMA = {
  type: 'object', required: ['expectedSha256'], additionalProperties: false,
  properties: { expectedSha256: { type: 'string', pattern: SHA256 }, overwrite: { type: 'boolean', description: '基准不是当前修订时也保存，盖过别人先保存的修订' } },
} as const;
export const SET_CURRENT_SCHEMA = {
  type: 'object', required: ['template', 'revision'], additionalProperties: false,
  properties: { template: { type: 'string', minLength: 1, maxLength: 500 }, revision: { type: 'integer', minimum: 1 } },
} as const;

const nameOf = (request: FastifyRequest) => (request.params as { name: string }).name;
const copySource = (name: string) => `templateWorkingCopy:${name}`;
const changePaths = (changes: readonly TemplateChange[]) => changes.map((change) => ({ path: `${change.target}:${change.path}`, change: change.change }));

/** 模板的当前修订；模板不存在时 undefined。 */
export function currentOf(state: AuthoringState, name: string) {
  const template = state.templates.find((candidate) => candidate.name === name);
  const revision = template?.revisions.find((candidate) => candidate.revision === template.currentRevision);
  return template && revision ? { template, revision } : undefined;
}

/** 工作区换上这一份工作副本，别的模板照旧：保存时的静态检查看的就是保存之后的样子。 */
export const overlaid = (workspace: Workspace, name: string, document: unknown): Workspace => ({
  ...workspace, templates: [...workspace.templates.filter((template) => template.name !== name), { name, document, source: copySource(name) }],
});

/** 指回旧修订：客户管理员与代建工程师的端点都走这里；审计记改前改后两个修订的内容哈希。批准申请时带 expectedCurrent 与 approving，当前修订变了答 409。 */
export async function setCurrentTemplate(scope: TenantScope, body: unknown,
  origin: { readonly source: TemplateCurrentOrigin['source']; readonly by: string; readonly now: Date; readonly expectedCurrent?: number; readonly approving?: PublishRequestApproval },
  audit: AuditWriter) {
  const { template, revision } = body as { template: string; revision: number };
  const updated = await scope.storage.setCurrentTemplate(template, revision, origin);
  if (!updated) throw notFound();
  if ('moved' in updated) throw fail(409, ServiceProblemCodes.templateRevisionConflict, 'request.body.revision', `当前修订已变成 ${updated.moved}`);
  const sha256Of = (number: number) => updated.template.revisions.find((item) => item.revision === number)!.sha256;
  const beforeSha256 = sha256Of(updated.previousRevision), afterSha256 = sha256Of(revision);
  await audit('template.setCurrent', { type: 'template', id: template }, {
    beforeSha256, afterSha256,
    diff: auditDiff(beforeSha256 === afterSha256 ? [] : [{ path: documentSource('template', template), change: 'changed', beforeSha256, afterSha256 }]),
  });
  return sortedState({ documents: [], templates: [updated.template], resources: [] }).templates[0];
}

/** 指回变成申请：固定要指回的修订与申请时的当前修订。模板或修订不存在答 404，要指回的修订有严重问题答 400，同直接保存。 */
export async function requestSetCurrent(scope: TenantScope, body: unknown, requester: RequestActor) {
  const { template, revision } = body as { template: string; revision: number }, storage = scope.storage;
  const current = currentOf(await storage.authoringState(), template), target = current?.template.revisions.find((item) => item.revision === revision);
  if (!current || !target) throw notFound();
  const bytes = await storage.contents.get(target.sha256);
  if (!bytes) throw notFound();
  const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), template, parsedDocument(bytes)), template);
  if (blocked || problems.some((item) => item.level === 'severe')) throw new ApiError(400, problems);
  const beforeSha256 = current.revision.sha256;
  return openPublishRequest(scope, {
    kind: 'templateSetCurrent', subject: template, scopes: ['templates'], sha256: target.sha256, beforeSha256, baseRevision: current.template.currentRevision, revision,
    diff: auditDiff(beforeSha256 === target.sha256 ? [] : [{ path: documentSource('template', template), change: 'changed', beforeSha256, afterSha256: target.sha256 }]),
  }, requester);
}

const documentAt = async (storage: TenantStorage, sha256: string | undefined): Promise<unknown> => {
  if (sha256 === undefined) return undefined;
  const bytes = await storage.contents.get(sha256);
  if (!bytes) throw notFound();
  return parsedDocument(bytes);
};

/** 基准不是当前修订时的两边差异：基准到工作副本是这边改的，基准到当前修订是别人改的。 */
async function conflictOf(storage: TenantStorage, state: AuthoringState, copy: TemplateWorkingCopy, document: unknown) {
  const current = currentOf(state, copy.name);
  if (!current || copy.baseRevision === current.template.currentRevision) return undefined;
  const base = await documentAt(storage, current.template.revisions.find((revision) => revision.revision === copy.baseRevision)?.sha256);
  return {
    ...(copy.baseRevision === undefined ? {} : { baseRevision: copy.baseRevision }), currentRevision: current.template.currentRevision,
    ours: revisionDiff(base, document), theirs: revisionDiff(base, await documentAt(storage, current.revision.sha256)),
  };
}

const revisionConflict = async (storage: TenantStorage, copy: TemplateWorkingCopy, document: unknown, currentRevision: number) => {
  // 事务里看到的当前修订可能比外面读的新：重新读一次再算两边差异。
  const conflict = await conflictOf(storage, await storage.authoringState(), copy, document);
  return new ApiError(409, [problem(ServiceProblemCodes.templateRevisionConflict, 'request.body.expectedSha256',
    `工作副本基于修订 ${copy.baseRevision ?? '（无）'}，当前修订已是 ${currentRevision}；看过两边差异后，明确 overwrite 才覆盖`)], conflict ? { conflict } : {});
};

interface CopyToCommit {
  readonly copy: TemplateWorkingCopy;
  readonly document: unknown;
  /** 保存前的当前修订与它的内容；新模板没有。 */
  readonly current: ReturnType<typeof currentOf>;
  readonly before: Uint8Array | undefined;
  readonly overwrite: boolean;
  readonly expectedCurrent?: number | undefined;
  /** 修订上记的主体：直接保存是保存的人，批准申请时是申请的人。 */
  readonly pushedBy: string;
}

/** 保存模板：在一个事务里核对内容与基准并记修订。批准申请时带 approving，申请与内容在同一个事务里生效。 */
export async function commitCopy(scope: TenantScope, { copy, document, current, before, overwrite, expectedCurrent, pushedBy }: CopyToCommit, requester: RequestActor, approving?: PublishRequestApproval) {
  const storage = scope.storage, name = copy.name;
  const result = await storage.commitTemplateWorkingCopy(name, copy.sha256, {
    overwrite, pushedBy, now: requester.now, ...(expectedCurrent === undefined ? {} : { expectedCurrent }), ...(approving ? { approving } : {}),
  });
  if (!result) throw notFound();
  if ('stale' in result) throw staleDraft(result.stale, 'request.body.expectedSha256', '工作副本');
  if ('conflict' in result) throw await revisionConflict(storage, copy, document, result.conflict.currentRevision);
  await requester.audit('template.save', { type: 'template', id: name }, {
    ...(current ? { beforeSha256: current.revision.sha256 } : {}), afterSha256: result.sha256,
    diff: auditDiff(changePaths(before === undefined ? [] : diffTemplate(parsedDocument(before), document))),
  });
  return { name, revision: result.revision, status: result.status, sha256: result.sha256 };
}

export function registerWorkingCopyRoutes(app: FastifyInstance, context: ApiContext, addressing: AuthoringAddressing): void {
  const { limits, now } = context;
  const { prefix, read: readAccess, scopeOf, crossTenant } = addressing;
  const templateUrl = `${prefix}/templates/:name`, copyUrl = `${templateUrl}/working-copy`;
  const audit = (request: FastifyRequest, action: string, object: NewAuditEvent['object'], content: AuditContent = {}) =>
    scopeOf(request).appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant, ...content }, now());
  const auditRead = async (request: FastifyRequest, object: NewAuditEvent['object']) => { if (crossTenant) await audit(request, 'authoring.read', object); };
  const writer = (request: FastifyRequest) => ({ updatedBy: actorOf(identityOf(request)).label, now: now() });
  const copyOf = async (storage: TenantStorage, name: string): Promise<TemplateWorkingCopy> => {
    const copy = await storage.templateWorkingCopy(name);
    if (!copy) throw notFound();
    return copy;
  };
  const contentOf = async (storage: TenantStorage, sha256: string): Promise<Uint8Array> => {
    const bytes = await storage.contents.get(sha256);
    if (!bytes) throw notFound();
    return bytes;
  };
  const requesterOf = (request: FastifyRequest): RequestActor => ({ actor: actorOf(identityOf(request)), now: now(), audit: (action, object, content) => audit(request, action, object, content) });

  app.get(`${prefix}/template-working-copies`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), workingCopies = [...await scope.storage.templateWorkingCopies()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return { workingCopies };
  });

  /** 从当前修订新建工作副本，记基准修订。 */
  app.post(copyUrl, { config: { access: 'templates.write' } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), current = currentOf(await scope.storage.authoringState(), name);
    if (!current) throw notFound();
    const copy = await scope.storage.createTemplateWorkingCopy(
      { name, baseRevision: current.template.currentRevision, bytes: await contentOf(scope.storage, current.revision.sha256) }, writer(request));
    if (!copy) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.path.name', `模板 ${name} 已有工作副本；每个模板至多一份`);
    await audit(request, 'templateWorkingCopy.create', { type: 'templateWorkingCopy', id: name }, {
      afterSha256: copy.sha256, diff: auditDiff([{ path: copySource(name), change: 'added', afterSha256: copy.sha256 }]),
    });
    reply.code(201);
    return copy;
  });

  app.get(copyUrl, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), copy = await copyOf(scope.storage, name);
    const bytes = await contentOf(scope.storage, copy.sha256);
    await auditRead(request, { type: 'templateWorkingCopy', id: name });
    return { ...copy, content: Buffer.from(bytes).toString('utf8') };
  });

  // 暂存拿到请求体的原文：按原始字节存，同数据定义。
  app.register(async (raw) => {
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: limits.maxRequestBytes }, (_request, body, done) => done(null, body));

    raw.put(copyUrl, {
      config: { access: 'templates.write' }, bodyLimit: limits.maxRequestBytes,
      schema: { querystring: { type: 'object', required: ['expectedSha256'], additionalProperties: false, properties: { expectedSha256: { type: 'string', pattern: SHA256 } } } },
    }, async (request) => {
      const scope = scopeOf(request), name = nameOf(request), storage = scope.storage;
      await copyOf(storage, name);
      const bytes = checkedDocument(request.body, name, '模板'), { expectedSha256 } = request.query as { expectedSha256: string };
      const before = await storage.contents.get(expectedSha256);
      const result = await storage.saveTemplateWorkingCopy(name, expectedSha256, bytes, writer(request));
      if (!result) throw notFound();
      if ('stale' in result) throw staleDraft(result.stale, 'request.querystring.expectedSha256', '工作副本');
      await audit(request, 'templateWorkingCopy.save', { type: 'templateWorkingCopy', id: name }, {
        beforeSha256: expectedSha256, afterSha256: result.saved.sha256, diff: stashDiff(name, before, bytes, expectedSha256, result.saved.sha256),
      });
      await expirePending(scope, 'templateSave', name, '工作副本在申请之后又被修改', requesterOf(request), result.saved.sha256);
      return result.saved;
    });
  });

  app.delete(copyUrl, { config: { access: 'templates.write' } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), copy = await scope.storage.deleteTemplateWorkingCopy(name);
    if (!copy) throw notFound();
    await audit(request, 'templateWorkingCopy.delete', { type: 'templateWorkingCopy', id: name }, {
      beforeSha256: copy.sha256, diff: auditDiff([{ path: copySource(name), change: 'removed', beforeSha256: copy.sha256 }]),
    });
    await expirePending(scope, 'templateSave', name, '工作副本已被丢弃', requesterOf(request));
    reply.code(204);
  });

  /** 模板静态检查与结构化差异：保存之前看后果，不写任何东西。 */
  app.get(`${copyUrl}/check`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), storage = scope.storage, name = nameOf(request), copy = await copyOf(storage, name);
    const document = parsedDocument(await contentOf(storage, copy.sha256));
    const state = await storage.authoringState(), current = currentOf(state, name);
    const { problems } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), name, document), name);
    const conflict = await conflictOf(storage, state, copy, document);
    await auditRead(request, { type: 'templateWorkingCopy', id: name });
    return {
      sha256: copy.sha256, ...(copy.baseRevision === undefined ? {} : { baseRevision: copy.baseRevision }),
      ...(current ? { currentRevision: current.template.currentRevision } : {}), problems,
      changes: revisionDiff(await documentAt(storage, current?.revision.sha256), document), ...(conflict ? { conflict } : {}),
    };
  });

  /** 保存模板：先做静态检查，再在一个事务里核对内容与基准并记修订；模板范围打开了审批策略时，变成发布申请（202）。 */
  app.post(`${copyUrl}/save`, { config: { access: 'authoring.publish' }, schema: { body: SAVE_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), storage = scope.storage, name = nameOf(request);
    const { expectedSha256, overwrite = false } = request.body as { expectedSha256: string; overwrite?: boolean };
    const copy = await copyOf(storage, name);
    if (copy.sha256 !== expectedSha256) throw staleDraft(copy.sha256, 'request.body.expectedSha256', '工作副本');
    const document = parsedDocument(await contentOf(storage, copy.sha256));
    const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), name, document), name);
    if (blocked || problems.some((item) => item.level === 'severe')) throw new ApiError(400, problems);
    const state = await storage.authoringState(), current = currentOf(state, name), requester = requesterOf(request);
    const before = current && await contentOf(storage, current.revision.sha256);
    if ((await constrainedScopes(scope, identityOf(request), ['templates'])).length) {
      if (current && copy.baseRevision !== current.template.currentRevision && !overwrite) throw await revisionConflict(storage, copy, document, current.template.currentRevision);
      const publishRequest = await openPublishRequest(scope, {
        kind: 'templateSave', subject: name, scopes: ['templates'], sha256: copy.sha256, ...(current ? { beforeSha256: current.revision.sha256, baseRevision: current.template.currentRevision } : {}),
        ...(overwrite ? { overwrite } : {}), diff: auditDiff(changePaths(before === undefined ? [] : diffTemplate(parsedDocument(before), document))),
      }, requester);
      reply.code(202);
      return { request: publishRequest };
    }
    const saved = await commitCopy(scope, { copy, document, current, before, overwrite, pushedBy: requester.actor.label }, requester);
    await expirePending(scope, 'templateSave', name, '工作副本已被直接保存', requester);
    return saved;
  });

  /** 复制为新模板：内容与基准数据定义取当前修订，换新名称，成为没有基准修订的工作副本。 */
  app.post(`${templateUrl}/copies`, { config: { access: 'templates.write' }, schema: { body: COPY_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), storage = scope.storage, source = nameOf(request), { name } = request.body as { name: string };
    const state = await storage.authoringState(), current = currentOf(state, source);
    if (!current) throw notFound();
    if (currentOf(state, name)) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `已有模板 ${name}`);
    const bytes = documentBytes({ ...(parsedDocument(await contentOf(storage, current.revision.sha256)) as object), name });
    const copy = await storage.createTemplateWorkingCopy({ name, bytes }, writer(request));
    if (!copy) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `${name} 已有工作副本`);
    await audit(request, 'templateWorkingCopy.copy', { type: 'templateWorkingCopy', id: name }, {
      afterSha256: copy.sha256, diff: auditDiff([{ path: copySource(name), change: 'added', afterSha256: copy.sha256 }]),
    });
    reply.code(201);
    return copy;
  });

  /**
   * 从空白新建（模板设计页票据 18）：一块空画板，成为没有基准修订的工作副本，保存时记修订 1，同复制为新模板。
   * 名称已有模板或工作副本答 409；基准不存在、尺寸范围最小大于最大这类严重问题答 400，问题清单同保存时的静态检查。
   */
  app.post(`${prefix}/templates`, { config: { access: 'templates.write' }, schema: { body: BLANK_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), storage = scope.storage;
    const { name, base, sizeRange } = request.body as { name: string; base: { name: string; version: number | string }; sizeRange: Record<'width' | 'height', { min: number; max: number }> };
    for (const axis of ['width', 'height'] as const) {
      if (sizeRange[axis].min > sizeRange[axis].max) throw fail(400, ServiceProblemCodes.requestInvalid, `request.body.sizeRange.${axis}`, `${axis === 'width' ? '宽' : '高'}的最小不能大于最大`);
    }
    if (currentOf(await storage.authoringState(), name)) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `已有模板 ${name}`);
    const document = { dslVersion: 'renderweave-template/1', name, base, artboard: { sizeRange } };
    const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), name, document), name);
    if (blocked || problems.some((item) => item.level === 'severe')) throw new ApiError(400, problems);
    const copy = await storage.createTemplateWorkingCopy({ name, bytes: documentBytes(document) }, writer(request));
    if (!copy) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `${name} 已有工作副本`);
    await audit(request, 'templateWorkingCopy.blank', { type: 'templateWorkingCopy', id: name }, {
      afterSha256: copy.sha256, diff: auditDiff([{ path: copySource(name), change: 'added', afterSha256: copy.sha256 }]),
    });
    reply.code(201);
    return copy;
  });

  /** 当前修订的内容：不开工作副本也能读，页面只看不改时不写任何东西（模板设计页票据 01）。 */
  app.get(`${templateUrl}/content`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), current = currentOf(await scope.storage.authoringState(), name);
    if (!current) throw notFound();
    const bytes = await contentOf(scope.storage, current.revision.sha256);
    await auditRead(request, { type: 'template', id: name });
    return { name, revision: current.template.currentRevision, sha256: current.revision.sha256, content: Buffer.from(bytes).toString('utf8') };
  });

  /** 修订历史：修订号、主体、时间与来源。 */
  app.get(`${templateUrl}/revisions`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request);
    const template = (await scope.storage.authoringState()).templates.find((candidate) => candidate.name === name);
    if (!template) throw notFound();
    await auditRead(request, { type: 'template', id: name });
    return sortedState({ documents: [], templates: [template], resources: [] }).templates[0];
  });
}

/** 暂存的差异摘要：相同内容是空的；有一份读不了（不是模板）时 diffTemplate 也能比，路径是元素路径或模板层的键。 */
function stashDiff(name: string, before: Uint8Array | undefined, after: Uint8Array, beforeSha256: string, afterSha256: string): AuditDiff {
  if (beforeSha256 === afterSha256) return auditDiff([]);
  if (!before) return auditDiff([{ path: copySource(name), change: 'changed', beforeSha256, afterSha256 }]);
  return auditDiff(changePaths(diffTemplate(parsedDocument(before), parsedDocument(after))));
}

/** 客户端点：租户由身份决定，指回旧修订在 authoring.publish 之下。代建端点在 authoring.ts 里注册同一份实现。 */
export function registerCustomerTemplateRoutes(app: FastifyInstance, context: ApiContext): void {
  const scopeOf = (request: FastifyRequest) => context.backend.tenant(ownTenant(identityOf(request)));
  registerWorkingCopyRoutes(app, context, { prefix: '/v1', read: 'tenant.read', crossTenant: false, scopeOf });
  app.post('/v1/template-current', { config: { access: 'authoring.publish' }, schema: { body: SET_CURRENT_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), actor = actorOf(identityOf(request));
    return setCurrentTemplate(scope, request.body, { source: 'web', by: actor.label, now: context.now() }, (action, object, content = {}) =>
      scope.appendAudit({ actor, action, object, crossTenant: false, ...content }, context.now()));
  });
}
