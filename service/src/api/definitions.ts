/**
 * 数据定义与草案的端点（P1 票据 04、05，M297、M298、M345、M346）：新建、读取、保存、校验、预检、发布与删除草案，列出本租户的数据定义。
 * 一套处理逻辑，两种寻址（M261、M345）：客户端点的租户由身份决定，代建端点在路径里写目标租户；同一操作的请求与回答相同。
 * - 草案按原始字节存，读回的 content 与保存时逐字节相同，sha256 就是它的哈希；保存带预期哈希，不是当前内容答 409（draft.stale）；
 * - 保存只要求是 JSON 对象、名称与路径一致，还没写完的草案也能存；问题由校验回答，与发布同一个入口（publishStaticSchema）；
 * - 草案不进工作区：渲染、数据集与模板看不到它，直到发布。发布走 publishStaticSchema，原文与编译产物按本地 renderweave publish 的写法成对登记，逐字节相同（M278）；
 * - 回退没有单独的操作：从旧版本另起草案（fromVersion），再发布成新版本。旧版本不变（ADR-0008）。
 * 客户成员的读取不记审计；代建工程师的读取与所有写入都记。写入另记前后内容哈希与差异摘要（M347）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import type { AuditContent, AuditDiff, AuditDiffPath, DefinitionDraft, NewAuditEvent, TenantStorage } from '../backend.js';
import {
  checkDataset, describeTemplate, diffDefinition, publishStaticSchema, readWorkspaceDocuments, templateFieldUses,
  type DefinitionDiff, type Problem, type PublishedStaticSchema, type StaticSchemaEntry, type TemplateEntry, type Workspace,
} from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { checkedDocument, documentBytes, parsedDocument, staleDraft, type AuthoringAddressing } from './authoring-documents.js';
import { ApiError, fail, notFound, ServiceProblemCodes } from './problems.js';
import { parseKey, readJson } from './static-schemas.js';

/** 经接口新建的数据定义名称：1–200 个字符，没有控制字符，首尾没有空白。推送进来的沿用本地的名称。 */
const NAME = /^(?=[\s\S]{1,200}$)[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u;
const SHA256 = '^[0-9a-f]{64}$';
/** 发布预检的请求：预期哈希确认看的就是这一份内容，发布用同一结构。 */
const PUBLISH_SCHEMA = { type: 'object', required: ['expectedSha256'], additionalProperties: false, properties: { expectedSha256: { type: 'string', pattern: SHA256 } } } as const;
/** 预检回答前多少份失配数据集的问题摘要，每份至多几条问题（M346）。 */
const MISMATCH_SAMPLES = 20, SAMPLE_PROBLEMS = 5;
const CREATE_SCHEMA = {
  type: 'object', additionalProperties: false, minProperties: 1, maxProperties: 1,
  description: '空白新建写 displayName；从静态版本另起写 fromVersion。两者只写一个',
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    fromVersion: { type: 'integer', minimum: 1, maximum: 999_999_999 },
  },
} as const;

const draftSource = (name: string) => `definitionDraft:${name}`;
const nameOf = (request: FastifyRequest) => (request.params as { name: string }).name;
const invalid = (source: string, message: string) => fail(400, ServiceProblemCodes.requestInvalid, source, message);

/** 差异摘要的路径：field:字段名称、definition:属性。 */
const diffPaths = (diff: DefinitionDiff): AuditDiffPath[] => [
  ...diff.definition.map((property) => ({ path: `definition:${property.key}`, change: 'changed' as const })),
  ...diff.fields.map((field) => ({ path: `field:${field.path}`, change: field.change })),
  ...(diff.order ? [{ path: 'definition:fieldOrder', change: 'changed' as const }] : []),
];

/** 保存的差异摘要：两份都读得了时逐字段；有一份读不了时只记整份文档与前后哈希。 */
function saveDiff(name: string, before: Uint8Array | undefined, after: Uint8Array, beforeSha256: string, afterSha256: string): AuditDiff {
  if (beforeSha256 === afterSha256) return auditDiff([]);
  const diff = before && diffDefinition(parsedDocument(before), parsedDocument(after));
  if (!diff || diff.problems.length) return auditDiff([{ path: draftSource(name), change: 'changed', beforeSha256, afterSha256 }]);
  return auditDiff(diffPaths(diff));
}

/** 与基于的版本比较：新名称没有基准，就与同一份文档去掉全部字段比，字段全算新增。 */
const baseDocumentOf = (base: unknown, document: unknown) => base ?? { ...(document as object), fields: [] };

/** 绑定基于版本的数据集逐份按新编译产物校验（M346）：按 ID 排序，超过上限只校验前面的，回答失配份数与前几份的问题摘要。 */
function datasetImpact(workspace: Workspace, base: { name: string; version: number }, published: PublishedStaticSchema, limit: number) {
  const bound = workspace.datasets.filter(({ document }) => document.dataset.staticSchema.name === base.name && document.dataset.staticSchema.version === base.version)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const candidate = { staticSchemas: [...workspace.staticSchemas, published], resources: workspace.resources };
  const checked = bound.slice(0, limit), mismatches: { id: string; problemCount: number; problems: readonly Problem[] }[] = [];
  for (const { id, document } of checked) {
    const rebound = { ...document, dataset: { ...document.dataset, staticSchema: published.ref } };
    const severe = checkDataset(documentBytes(rebound), candidate).problems.filter((problem) => problem.level === 'severe');
    if (severe.length) mismatches.push({ id, problemCount: severe.length, problems: severe.slice(0, SAMPLE_PROBLEMS) });
  }
  return { total: bound.length, checked: checked.length, complete: checked.length === bound.length, mismatched: mismatches.length, samples: mismatches.slice(0, MISMATCH_SAMPLES) };
}

/** 用到被删字段的模板：按模板当前修订读到的字段，模板读不了时不列。 */
function affectedBindings(name: string, removed: readonly string[], templates: readonly TemplateEntry[], staticSchemas: readonly StaticSchemaEntry[]) {
  const reads = templates.map((template) => ({
    name: template.name,
    base: describeTemplate(template.document).template?.base,
    fields: new Set(templateFieldUses(template.document, staticSchemas).uses.filter((use) => use.schema.name === name).map((use) => use.field)),
  }));
  return removed.map((field) => ({
    field,
    templates: reads.filter((template) => template.base && template.fields.has(field)).map((template) => ({ name: template.name, base: template.base! }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  }));
}

/** 一个静态版本的原文；与 /v1/static-schemas 一样，原文与编译产物都在才算有。 */
async function staticVersion(storage: TenantStorage, name: string, version: number): Promise<Record<string, unknown> | undefined> {
  const key = `${name}@${version}`, documents = (await storage.authoringState()).documents;
  const definition = documents.find((stored) => stored.kind === 'definition' && stored.key === key);
  return definition && documents.some((stored) => stored.kind === 'compiled' && stored.key === key) ? readJson(storage, definition) : undefined;
}

export function registerDefinitionRoutes(app: FastifyInstance, context: ApiContext, addressing: AuthoringAddressing): void {
  const { limits, now } = context;
  const { prefix, read: readAccess, scopeOf, crossTenant } = addressing;
  const url = `${prefix}/definitions`, draftUrl = `${url}/:name/draft`;
  const audit = (request: FastifyRequest, action: string, object: NewAuditEvent['object'], content: AuditContent = {}) =>
    scopeOf(request).appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant, ...content }, now());
  /** 代建工程师的读取也记审计（M261）；客户成员的读取不记。 */
  const auditRead = async (request: FastifyRequest, object: NewAuditEvent['object']) => { if (crossTenant) await audit(request, 'authoring.read', object); };
  const writer = (request: FastifyRequest) => ({ updatedBy: actorOf(identityOf(request)).label, now: now() });
  /** 路径里的草案；没有时答 404。 */
  const draftOf = async (storage: TenantStorage, name: string): Promise<DefinitionDraft> => {
    const draft = await storage.definitionDraft(name);
    if (!draft) throw notFound();
    return draft;
  };

  /** 本租户的数据定义：每个名称的静态版本、各版本被多少数据集与模板直接使用，以及草案。没有原文或编译产物的版本不列。 */
  app.get(url, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), workspace = await readWorkspaceDocuments(scope.storage.documents);
    const used = new Map<string, { datasets: number; templates: number }>();
    const usage = (key: string) => used.get(key) ?? used.set(key, { datasets: 0, templates: 0 }).get(key)!;
    for (const { document } of workspace.datasets) usage(`${document.dataset.staticSchema.name}@${document.dataset.staticSchema.version}`).datasets++;
    for (const template of workspace.templates) {
      const base = describeTemplate(template.document).template?.base;
      if (base) usage(`${base.name}@${base.version}`).templates++;
    }
    const drafts = new Map((await scope.storage.definitionDrafts()).map((draft) => [draft.name, draft]));
    const versions = new Map<string, { version: number; displayName: string; datasets: number; templates: number }[]>();
    for (const { ref, definition, compiled } of workspace.staticSchemas) {
      if (definition === undefined || compiled === undefined) continue;
      const displayName = (definition as { displayName?: unknown }).displayName;
      const list = versions.get(ref.name) ?? [];
      list.push({ version: ref.version, displayName: typeof displayName === 'string' ? displayName : ref.name, ...(used.get(`${ref.name}@${ref.version}`) ?? { datasets: 0, templates: 0 }) });
      versions.set(ref.name, list);
    }
    const names = [...new Set([...versions.keys(), ...drafts.keys()])].sort();
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return {
      definitions: await Promise.all(names.map(async (name) => {
        const list = (versions.get(name) ?? []).sort((a, b) => a.version - b.version), draft = drafts.get(name);
        const draftJson = draft && !list.length ? await scope.storage.contents.get(draft.sha256) : undefined;
        const draftDisplayName = draftJson && (parsedDocument(draftJson) as { displayName?: unknown }).displayName;
        return { name, displayName: list.at(-1)?.displayName ?? (typeof draftDisplayName === 'string' ? draftDisplayName : name), versions: list, ...(draft ? { draft } : {}) };
      })),
    };
  });

  /** 新建草案：空白，或从某个静态版本另起（复制原文，去掉版本号）。这个名称已有草案答 409；空白新建不能用已有静态版本的名称，那样草案就没有基准。 */
  app.post(draftUrl, { config: { access: 'definitions.write' }, schema: { body: CREATE_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), body = request.body as { displayName?: string; fromVersion?: number };
    let bytes: Uint8Array;
    if (body.fromVersion !== undefined) {
      const definition = await staticVersion(scope.storage, name, body.fromVersion);
      if (!definition) throw notFound();
      const { version: _version, ...rest } = definition;
      bytes = documentBytes(rest);
    } else {
      if (!NAME.test(name)) throw invalid('request.path.name', '数据定义名称要有 1–200 个字符，不能有控制字符，首尾不能是空白');
      if ((await scope.storage.authoringState()).documents.some((stored) => stored.kind === 'definition' && parseKey(stored.key)?.name === name)) {
        throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.path.name', `已有静态数据定义 ${name}，要改它请从某个版本另起草案`);
      }
      bytes = documentBytes({ dslVersion: 'renderweave-schema/1', name, displayName: body.displayName, fields: [] });
    }
    const draft = await scope.storage.createDefinitionDraft({ name, ...(body.fromVersion === undefined ? {} : { baseVersion: body.fromVersion }), bytes }, writer(request));
    if (!draft) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.path.name', `数据定义 ${name} 已有草案；每个名称至多一份`);
    await audit(request, 'definitionDraft.create', { type: 'definitionDraft', id: name }, {
      afterSha256: draft.sha256, diff: auditDiff([{ path: draftSource(name), change: 'added', afterSha256: draft.sha256 }]),
    });
    reply.code(201);
    return draft;
  });

  /** 读草案：登记信息与原文。content 就是保存时的字节，它的 SHA-256 是 sha256。 */
  app.get(draftUrl, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), draft = await draftOf(scope.storage, name);
    const bytes = await scope.storage.contents.get(draft.sha256);
    if (!bytes) throw notFound();
    await auditRead(request, { type: 'definitionDraft', id: name });
    return { ...draft, content: Buffer.from(bytes).toString('utf8') };
  });

  // 保存拿到请求体的原文：按原始字节存（同数据集，M270）。
  app.register(async (raw) => {
    // 代建端点所在的作用域还认 application/octet-stream；两种寻址要答得一样，这里只留 JSON。
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: limits.maxRequestBytes }, (_request, body, done) => done(null, body));

    raw.put(draftUrl, {
      config: { access: 'definitions.write' }, bodyLimit: limits.maxRequestBytes,
      schema: { querystring: { type: 'object', required: ['expectedSha256'], additionalProperties: false, properties: { expectedSha256: { type: 'string', pattern: SHA256 } } } },
    }, async (request) => {
      const scope = scopeOf(request), name = nameOf(request), storage = scope.storage;
      // 先答"不存在"，再看请求体：别的租户的草案与不存在的回答相同。
      await draftOf(storage, name);
      const bytes = checkedDocument(request.body, name, '数据定义'), { expectedSha256 } = request.query as { expectedSha256: string };
      const before = await storage.contents.get(expectedSha256);
      const result = await storage.saveDefinitionDraft(name, expectedSha256, bytes, writer(request));
      if (!result) throw notFound();
      if ('stale' in result) throw staleDraft(result.stale, 'request.querystring.expectedSha256');
      await audit(request, 'definitionDraft.save', { type: 'definitionDraft', id: name }, {
        beforeSha256: expectedSha256, afterSha256: result.saved.sha256, diff: saveDiff(name, before, bytes, expectedSha256, result.saved.sha256),
      });
      return result.saved;
    });
  });

  /**
   * 校验并预览编译产物，都按当前保存的内容，不写任何东西：
   * problems 定位到字段，走发布的同一入口；没有严重问题时给下一个版本号与编译产物。
   * 与基于的版本相比被删除的字段（改名等于删一个、加一个）列在 affectedBindings，带用到它们的模板。
   */
  app.get(`${draftUrl}/check`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), draft = await draftOf(scope.storage, name);
    const bytes = await scope.storage.contents.get(draft.sha256);
    if (!bytes) throw notFound();
    const document = parsedDocument(bytes), workspace = await readWorkspaceDocuments(scope.storage.documents);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    const base = draft.baseVersion === undefined ? undefined : workspace.staticSchemas.find((entry) => entry.ref.name === name && entry.ref.version === draft.baseVersion)?.definition;
    const removed = base === undefined ? [] : diffDefinition(base, document).fields.filter((field) => field.affectsBindings).map((field) => field.path);
    await auditRead(request, { type: 'definitionDraft', id: name });
    return {
      sha256: draft.sha256, problems,
      ...(published ? { version: published.ref.version, compiled: published.compiled } : {}),
      affectedBindings: affectedBindings(name, removed, workspace.templates, workspace.staticSchemas),
    };
  });

  /** 路径里的草案，内容哈希要等于预期；不符答 409，与保存相同。 */
  const expectedDraft = async (storage: TenantStorage, name: string, expectedSha256: string) => {
    const draft = await draftOf(storage, name);
    if (draft.sha256 !== expectedSha256) throw staleDraft(draft.sha256, 'request.body.expectedSha256');
    const bytes = await storage.contents.get(draft.sha256);
    if (!bytes) throw notFound();
    return { draft, document: parsedDocument(bytes) };
  };

  /**
   * 发布预检（只读）：与基于版本的字段级差异、绑定基于版本的数据集按新编译产物会失配多少份、仍绑定旧版本的模板（不改动它们，ADR-0008）。
   * 有严重问题时只答问题，发布也会同样拒绝。
   */
  app.post(`${draftUrl}/publish-check`, { config: { access: 'authoring.publish' }, schema: { body: PUBLISH_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), { expectedSha256 } = request.body as { expectedSha256: string };
    const { draft, document } = await expectedDraft(scope.storage, name, expectedSha256);
    const workspace = await loadTenantWorkspace(scope.storage);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    await auditRead(request, { type: 'definitionDraft', id: name });
    const reply = { sha256: draft.sha256, ...(draft.baseVersion === undefined ? {} : { baseVersion: draft.baseVersion }), problems };
    if (!published) return reply;
    const base = draft.baseVersion === undefined ? undefined : workspace.staticSchemas.find((entry) => entry.ref.name === name && entry.ref.version === draft.baseVersion)?.definition;
    const { problems: _none, ...diff } = diffDefinition(baseDocumentOf(base, document), document);
    const templates = workspace.templates.flatMap((template) => {
      const found = describeTemplate(template.document).template?.base;
      return found?.name === name ? [{ name: template.name, base: found }] : [];
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      ...reply, version: published.ref.version, diff, templates,
      datasets: datasetImpact(workspace, { name, version: draft.baseVersion ?? published.ref.version }, published, limits.publishCheckDatasets),
    };
  });

  /**
   * 发布草案：算出下一版本，原文与编译产物按本地发布的写法存，成对登记，删除草案。严重问题答 400，问题码与本地发布相同。
   * 算版本与登记之间版本被占用（别的发布或推送）答 409，什么也没写，再发一次就会用下一个版本。
   */
  app.post(`${draftUrl}/publish`, { config: { access: 'authoring.publish' }, schema: { body: PUBLISH_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), storage = scope.storage, { expectedSha256 } = request.body as { expectedSha256: string };
    const { draft, document } = await expectedDraft(storage, name, expectedSha256);
    const workspace = await readWorkspaceDocuments(storage.documents);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    if (!published) throw new ApiError(400, problems);
    const definitionBytes = documentBytes(published.definition), compiledBytes = documentBytes(published.compiled);
    const key = `${name}@${published.ref.version}`;
    const [definitionSha256, compiledSha256] = await Promise.all([storage.contents.put(definitionBytes), storage.contents.put(compiledBytes)]);
    const result = await storage.publishDefinitionDraft(name, expectedSha256, {
      key, definition: { sha256: definitionSha256, byteLength: definitionBytes.length }, compiled: { sha256: compiledSha256, byteLength: compiledBytes.length },
    });
    if (!result) throw notFound();
    if ('stale' in result) throw staleDraft(result.stale, 'request.body.expectedSha256');
    if ('taken' in result) throw fail(409, ServiceProblemCodes.draftVersionTaken, 'request.path.name', `${name} 的版本 ${published.ref.version} 刚被别的发布或推送占用；什么也没写，重新发布`);
    const documents = (await storage.authoringState()).documents;
    const base = draft.baseVersion === undefined ? undefined : workspace.staticSchemas.find((entry) => entry.ref.name === name && entry.ref.version === draft.baseVersion);
    const beforeSha256 = base && documents.find((stored) => stored.kind === 'definition' && stored.key === `${name}@${base.ref.version}`)?.sha256;
    await audit(request, 'definition.publish', { type: 'definition', id: key }, {
      ...(beforeSha256 ? { beforeSha256 } : {}), afterSha256: definitionSha256,
      diff: auditDiff(diffPaths(diffDefinition(baseDocumentOf(base?.definition, document), document))),
    });
    reply.code(201);
    return { name, version: published.ref.version, ...(draft.baseVersion === undefined ? {} : { baseVersion: draft.baseVersion }), definitionSha256, compiledSha256 };
  });

  app.delete(draftUrl, { config: { access: 'definitions.write' } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request);
    const draft = await scope.storage.deleteDefinitionDraft(name);
    if (!draft) throw notFound();
    await audit(request, 'definitionDraft.delete', { type: 'definitionDraft', id: name }, {
      beforeSha256: draft.sha256, diff: auditDiff([{ path: draftSource(name), change: 'removed', beforeSha256: draft.sha256 }]),
    });
    reply.code(204);
  });
}

/** 客户端点：租户由身份决定。代建端点在 authoring.ts 里注册同一份实现。 */
export function registerCustomerDefinitionRoutes(app: FastifyInstance, context: ApiContext): void {
  registerDefinitionRoutes(app, context, {
    prefix: '/v1', read: 'tenant.read', crossTenant: false,
    scopeOf: (request) => context.backend.tenant(ownTenant(identityOf(request))),
  });
}
