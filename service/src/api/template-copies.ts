/**
 * 模板工作副本与修订的端点（P1 票据 07，ADR-0022、M265、M267、M345、M346）：新建、暂存、丢弃、检查与保存工作副本，复制为新模板，修订历史，指回旧修订。
 * 一套处理逻辑，两种寻址（M261、M345），同数据定义草案。
 * - 暂存不影响当前修订：出图、只读预览与推送的差异都照旧读当前修订；预览可以指定用工作副本（previews.ts）；
 * - 保存时工作副本的基准不是当前修订答 409 并带两边差异，显式 overwrite 才覆盖，口径同 agent apply --overwrite；
 * - 模板静态检查有严重问题时拒绝保存（ADR-0021）；字节与当前修订相同记为不变（M265），工作副本照样删除；
 * - 指回旧修订（POST /v1/template-current）开放给客户管理员，代建工程师的端点在 authoring.ts，两边走 setCurrentTemplate。
 * 客户成员的读取不记审计；代建工程师的读取与所有写入都记。写入另记前后内容哈希与差异摘要（M347）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import { documentSource, type AuditContent, type AuditDiff, type AuthoringState, type NewAuditEvent, type TenantScope, type TenantStorage, type TemplateWorkingCopy } from '../backend.js';
import { checkTemplateStatic, diffTemplate, revisionDiff, type TemplateChange, type Workspace } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { sortedState } from '../push.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { checkedDocument, documentBytes, parsedDocument, staleDraft, type AuthoringAddressing } from './authoring-documents.js';
import { ApiError, fail, notFound, problem, ServiceProblemCodes } from './problems.js';

/** 复制出来的模板名称：1–200 个字符，没有控制字符，首尾没有空白，也没有元素路径用的 / [ ]。推送进来的沿用本地的名称。 */
const NAME_PATTERN = '^(?=[\\s\\S]{1,200}$)[^\\s\\p{Cc}/\\[\\]](?:[^\\p{Cc}/\\[\\]]*[^\\s\\p{Cc}/\\[\\]])?$';
const SHA256 = '^[0-9a-f]{64}$';
const COPY_SCHEMA = { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200, pattern: NAME_PATTERN } } } as const;
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
function currentOf(state: AuthoringState, name: string) {
  const template = state.templates.find((candidate) => candidate.name === name);
  const revision = template?.revisions.find((candidate) => candidate.revision === template.currentRevision);
  return template && revision ? { template, revision } : undefined;
}

/** 工作区换上这一份工作副本，别的模板照旧：保存时的静态检查看的就是保存之后的样子。 */
const overlaid = (workspace: Workspace, name: string, document: unknown): Workspace => ({
  ...workspace, templates: [...workspace.templates.filter((template) => template.name !== name), { name, document, source: copySource(name) }],
});

/** 指回旧修订：客户管理员与代建工程师的端点都走这里；审计记改前改后两个修订的内容哈希。 */
export async function setCurrentTemplate(scope: TenantScope, body: unknown, audit: (object: NewAuditEvent['object'], content: AuditContent) => Promise<void>) {
  const { template, revision } = body as { template: string; revision: number };
  const updated = await scope.storage.setCurrentTemplate(template, revision);
  if (!updated) throw notFound();
  const sha256Of = (number: number) => updated.template.revisions.find((item) => item.revision === number)!.sha256;
  const beforeSha256 = sha256Of(updated.previousRevision), afterSha256 = sha256Of(revision);
  await audit({ type: 'template', id: template }, {
    beforeSha256, afterSha256,
    diff: auditDiff(beforeSha256 === afterSha256 ? [] : [{ path: documentSource('template', template), change: 'changed', beforeSha256, afterSha256 }]),
  });
  return sortedState({ documents: [], templates: [updated.template], resources: [] }).templates[0];
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
  const documentAt = async (storage: TenantStorage, sha256: string | undefined): Promise<unknown> => (sha256 === undefined ? undefined : parsedDocument(await contentOf(storage, sha256)));
  /** 基准不是当前修订时的两边差异：基准到工作副本是这边改的，基准到当前修订是别人改的。 */
  const conflictOf = async (storage: TenantStorage, state: AuthoringState, copy: TemplateWorkingCopy, document: unknown) => {
    const current = currentOf(state, copy.name);
    if (!current || copy.baseRevision === current.template.currentRevision) return undefined;
    const base = await documentAt(storage, current.template.revisions.find((revision) => revision.revision === copy.baseRevision)?.sha256);
    return {
      ...(copy.baseRevision === undefined ? {} : { baseRevision: copy.baseRevision }), currentRevision: current.template.currentRevision,
      ours: revisionDiff(base, document), theirs: revisionDiff(base, await documentAt(storage, current.revision.sha256)),
    };
  };

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

  // 暂存拿到请求体的原文：按原始字节存，同数据定义草案。
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
      return result.saved;
    });
  });

  app.delete(copyUrl, { config: { access: 'templates.write' } }, async (request, reply) => {
    const name = nameOf(request), copy = await scopeOf(request).storage.deleteTemplateWorkingCopy(name);
    if (!copy) throw notFound();
    await audit(request, 'templateWorkingCopy.delete', { type: 'templateWorkingCopy', id: name }, {
      beforeSha256: copy.sha256, diff: auditDiff([{ path: copySource(name), change: 'removed', beforeSha256: copy.sha256 }]),
    });
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

  /** 保存模板：先做静态检查，再在一个事务里核对内容与基准并记修订。 */
  app.post(`${copyUrl}/save`, { config: { access: 'authoring.publish' }, schema: { body: SAVE_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), storage = scope.storage, name = nameOf(request);
    const { expectedSha256, overwrite = false } = request.body as { expectedSha256: string; overwrite?: boolean };
    const copy = await copyOf(storage, name);
    if (copy.sha256 !== expectedSha256) throw staleDraft(copy.sha256, 'request.body.expectedSha256', '工作副本');
    const document = parsedDocument(await contentOf(storage, copy.sha256));
    const { problems, blocked } = checkTemplateStatic(overlaid(await loadTenantWorkspace(storage), name, document), name);
    if (blocked || problems.some((item) => item.level === 'severe')) throw new ApiError(400, problems);
    const state = await storage.authoringState(), before = currentOf(state, name)?.revision.sha256;
    const beforeDocument = await documentAt(storage, before);
    const result = await storage.commitTemplateWorkingCopy(name, expectedSha256, { overwrite, pushedBy: actorOf(identityOf(request)).label, now: now() });
    if (!result) throw notFound();
    if ('stale' in result) throw staleDraft(result.stale, 'request.body.expectedSha256', '工作副本');
    if ('conflict' in result) {
      // 事务里看到的当前修订可能比上面读的新：重新读一次再算两边差异。
      const conflict = await conflictOf(storage, await storage.authoringState(), copy, document);
      throw new ApiError(409, [problem(ServiceProblemCodes.templateRevisionConflict, 'request.body.expectedSha256',
        `工作副本基于修订 ${copy.baseRevision ?? '（无）'}，当前修订已是 ${result.conflict.currentRevision}；看过两边差异后，明确 overwrite 才覆盖`)], conflict ? { conflict } : {});
    }
    await audit(request, 'template.save', { type: 'template', id: name }, {
      ...(before ? { beforeSha256: before } : {}), afterSha256: result.sha256, diff: auditDiff(changePaths(beforeDocument === undefined ? [] : diffTemplate(beforeDocument, document))),
    });
    return { name, revision: result.revision, status: result.status, sha256: result.sha256 };
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
    const scope = scopeOf(request);
    return setCurrentTemplate(scope, request.body, (object, content) =>
      scope.appendAudit({ actor: actorOf(identityOf(request)), action: 'template.setCurrent', object, crossTenant: false, ...content }, context.now()));
  });
}
