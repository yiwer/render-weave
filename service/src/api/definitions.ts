/**
 * 数据定义与草案的端点（P1 票据 04、05、06，M297、M298、M345、M346、M355）：新建、读取、保存、校验、预检、发布与删除草案，列出本租户的数据定义与发布记录。
 * 一套处理逻辑，两种寻址（M261、M345）：客户端点的租户由身份决定，代建端点在路径里写目标租户；同一操作的请求与回答相同。
 * - 草案按原始字节存，读回的 content 与保存时逐字节相同，sha256 就是它的哈希；保存带预期哈希，不是当前内容答 409（draft.stale）；
 * - 保存只要求是 JSON 对象、名称与路径一致，还没写完的草案也能存；问题由校验回答，与发布同一个入口（publishStaticSchema）；
 * - 草案不进工作区：渲染、数据集与模板看不到它，直到发布。发布走 publishStaticSchema，原文与编译产物按本地 renderweave publish 的写法成对登记，逐字节相同（M278）；
 * - 回退没有单独的操作：从旧版本另起草案（fromVersion），再发布成新版本。旧版本不变（ADR-0008）；
 * - 发布记录不另存：谁、何时、基于哪一版读审计（definition.publish、push.commit），内容与差异读不可变的版本本身（M355）。
 * 客户成员的读取不记审计；代建工程师的读取与所有写入都记。写入另记前后内容哈希与差异摘要（M347）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import { parseDocumentSource, type AuditContent, type AuditDiff, type AuditDiffPath, type AuditEvent, type DefinitionDraft, type NewAuditEvent, type PublishRequestApproval, type TenantScope, type TenantStorage } from '../backend.js';
import {
  checkDataset, describeTemplate, diffDefinition, publishStaticSchema, readWorkspaceDocuments, templateFieldUses,
  type DefinitionDiff, type Problem, type PublishedStaticSchema, type StaticSchemaEntry, type StaticSchemaRef, type TemplateEntry, type Workspace,
} from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { checkedDocument, documentBytes, parsedDocument, staleDraft, type AuthoringAddressing } from './authoring-documents.js';
import { ApiError, fail, notFound, ServiceProblemCodes } from './problems.js';
import { constrainedScopes, expirePending, openPublishRequest, type AuditWriter, type RequestActor } from './publish-requests.js';
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
export const baseDocumentOf = (base: unknown, document: unknown) => base ?? { ...(document as object), fields: [] };

interface DraftToPublish {
  readonly draft: DefinitionDraft;
  readonly document: unknown;
  readonly workspace: Pick<Workspace, 'staticSchemas'>;
  readonly published: PublishedStaticSchema;
}

/** 发布对内容的改动：基于版本的内容哈希与字段级差异摘要。直接发布与发布申请记同一份。 */
async function publishChange(storage: TenantStorage, { draft, document, workspace }: Omit<DraftToPublish, 'published'>) {
  const base = draft.baseVersion === undefined ? undefined : workspace.staticSchemas.find((entry) => entry.ref.name === draft.name && entry.ref.version === draft.baseVersion);
  const documents = (await storage.authoringState()).documents;
  const beforeSha256 = base && documents.find((stored) => stored.kind === 'definition' && stored.key === `${draft.name}@${base.ref.version}`)?.sha256;
  return { ...(beforeSha256 ? { beforeSha256 } : {}), diff: auditDiff(diffPaths(diffDefinition(baseDocumentOf(base?.definition, document), document))) };
}

/**
 * 发布草案：原文与编译产物按本地发布的写法存，成对登记，删除草案。批准申请时带 approving，申请与内容在同一个事务里生效。
 * 算版本与登记之间版本被占用（别的发布或推送）答 409，什么也没写，再发一次就会用下一个版本。
 */
export async function commitDraftPublish(scope: TenantScope, { draft, document, workspace, published }: DraftToPublish, audit: AuditWriter, approving?: PublishRequestApproval) {
  const storage = scope.storage, name = draft.name;
  const definitionBytes = documentBytes(published.definition), compiledBytes = documentBytes(published.compiled);
  const key = `${name}@${published.ref.version}`;
  const [definitionSha256, compiledSha256] = await Promise.all([storage.contents.put(definitionBytes), storage.contents.put(compiledBytes)]);
  const result = await storage.publishDefinitionDraft(name, draft.sha256, {
    key, definition: { sha256: definitionSha256, byteLength: definitionBytes.length }, compiled: { sha256: compiledSha256, byteLength: compiledBytes.length },
  }, approving);
  if (!result) throw notFound();
  if ('stale' in result) throw staleDraft(result.stale, 'request.body.expectedSha256');
  if ('taken' in result) throw fail(409, ServiceProblemCodes.draftVersionTaken, 'request.path.name', `${name} 的版本 ${published.ref.version} 刚被别的发布或推送占用；什么也没写，重新发布`);
  await audit('definition.publish', { type: 'definition', id: key }, { ...await publishChange(storage, { draft, document, workspace }), afterSha256: definitionSha256 });
  return { name, version: published.ref.version, ...(draft.baseVersion === undefined ? {} : { baseVersion: draft.baseVersion }), definitionSha256, compiledSha256 };
}

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

/** 这个名称的每个字段被哪些模板读到：按模板当前修订，经过引用读到的也算，模板读不了时不列。 */
function fieldUses(name: string, templates: readonly TemplateEntry[], staticSchemas: readonly StaticSchemaEntry[]): Map<string, { name: string; base: StaticSchemaRef }[]> {
  const uses = new Map<string, { name: string; base: StaticSchemaRef }[]>();
  for (const template of [...templates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const base = describeTemplate(template.document).template?.base;
    if (!base) continue;
    const fields = new Set(templateFieldUses(template.document, staticSchemas).uses.filter((use) => use.schema.name === name).map((use) => use.field));
    for (const field of fields) uses.set(field, [...(uses.get(field) ?? []), { name: template.name, base }]);
  }
  return uses;
}

/** 用到被删字段的模板。 */
function affectedBindings(name: string, removed: readonly string[], templates: readonly TemplateEntry[], staticSchemas: readonly StaticSchemaEntry[]) {
  const uses = fieldUses(name, templates, staticSchemas);
  return removed.map((field) => ({ field, templates: uses.get(field) ?? [] }));
}

/** 发布记录读的审计事件：网页与接口上发布、推送提交（M355）。 */
const PUBLICATION_ACTIONS = ['definition.publish', 'push.commit'], PUBLICATION_EVENTS_PAGE = 200;

/**
 * 每个静态版本（键是"名称@版本"）是哪个审计事件写下的：从新到旧读，都找到了就停。
 * 推送的差异摘要只留前 AUDIT_DIFF_PATHS 项，一次推送写入太多文档时靠后的找不到，与审计之前的版本一样回答没有记录。
 */
async function publicationEvents(scope: TenantScope, wanted: ReadonlySet<string>): Promise<Map<string, AuditEvent>> {
  const found = new Map<string, AuditEvent>();
  const keysOf = (event: AuditEvent) => (event.action === 'definition.publish' ? [event.object.id] : (event.diff?.paths ?? []).flatMap(({ path, change }) => {
    const source = parseDocumentSource(path);
    return source?.kind === 'definition' && change === 'added' ? [source.key] : [];
  }));
  for (let before: string | undefined; found.size < wanted.size;) {
    const events = await scope.listAudit({ limit: PUBLICATION_EVENTS_PAGE, actions: PUBLICATION_ACTIONS, ...(before ? { before } : {}) });
    for (const event of events) for (const key of keysOf(event)) if (wanted.has(key) && !found.has(key)) found.set(key, event);
    if (events.length < PUBLICATION_EVENTS_PAGE) break;
    before = events.at(-1)!.id;
  }
  return found;
}

/**
 * 本租户的发布记录，新的在前：每个静态版本一行，原文与编译产物都在才算有。
 * 差异与基准比：网页发布的基准是它基于的版本（审计的 beforeSha256），推送没有记基于哪一版，与它的上一版比；都没有就是首个版本，字段全算新增。
 */
async function definitionPublications(scope: TenantScope, only: string | undefined) {
  const storage = scope.storage, documents = (await storage.authoringState()).documents;
  const compiled = new Map(documents.filter((stored) => stored.kind === 'compiled').map((stored) => [stored.key, stored.sha256]));
  const versions = documents.flatMap((stored) => {
    const key = stored.kind === 'definition' && compiled.has(stored.key) ? parseKey(stored.key) : undefined;
    return key && (only === undefined || key.name === only) ? [{ ...key, key: stored.key, stored, compiledSha256: compiled.get(stored.key)! }] : [];
  });
  const events = await publicationEvents(scope, new Set(versions.map((version) => version.key)));
  const content = new Map(await Promise.all(versions.map(async (version) => [version.key, await readJson(storage, version.stored)] as const)));
  return versions.flatMap((version) => {
    const document = content.get(version.key), event = events.get(version.key);
    if (!document) return [];
    const siblings = versions.filter((other) => other.name === version.name);
    const base = event?.action === 'definition.publish'
      ? siblings.find((other) => other.stored.sha256 === event.beforeSha256)
      : siblings.filter((other) => other.version < version.version).sort((a, b) => b.version - a.version)[0];
    const { problems: _none, ...diff } = diffDefinition(baseDocumentOf(base && content.get(base.key), document), document);
    const displayName = document['displayName'];
    return [{
      name: version.name, version: version.version, displayName: typeof displayName === 'string' ? displayName : version.name,
      sha256: version.stored.sha256, compiledSha256: version.compiledSha256, ...(base ? { baseVersion: base.version, baseSha256: base.stored.sha256 } : {}),
      ...(event ? { source: event.action === 'push.commit' ? 'push' : 'web', at: event.at, actor: { kind: event.actor.kind, label: event.actor.label } } : {}), diff,
    }];
  }).sort((a, b) => {
    // 新的在前；审计之前的版本没有时间，排在最后。
    if ((a.at ?? '') !== (b.at ?? '')) return (a.at ?? '') < (b.at ?? '') ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : b.version - a.version;
  });
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
  const definitionsOf = async (scope: TenantScope) => {
    const workspace = await readWorkspaceDocuments(scope.storage.documents);
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
    return {
      workspace,
      definitions: await Promise.all(names.map(async (name) => {
        const list = (versions.get(name) ?? []).sort((a, b) => a.version - b.version), draft = drafts.get(name);
        const draftJson = draft && !list.length ? await scope.storage.contents.get(draft.sha256) : undefined;
        const draftDisplayName = draftJson && (parsedDocument(draftJson) as { displayName?: unknown }).displayName;
        return { name, displayName: list.at(-1)?.displayName ?? (typeof draftDisplayName === 'string' ? draftDisplayName : name), versions: list, ...(draft ? { draft } : {}) };
      })),
    };
  };

  app.get(url, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), { definitions } = await definitionsOf(scope);
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return { definitions };
  });

  /** 一个数据定义：列表里的一项，加每个字段被哪些模板读到（详情页的"谁在用"，改名与删字段时提示影响）。没有模板读的字段不列。 */
  app.get(`${url}/:name`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), { workspace, definitions } = await definitionsOf(scope);
    const definition = definitions.find((item) => item.name === name);
    if (!definition) throw notFound();
    await auditRead(request, { type: 'definition', id: name });
    const uses = fieldUses(name, workspace.templates, workspace.staticSchemas);
    return { ...definition, fieldUses: [...uses].map(([field, templates]) => ({ field, templates })) };
  });

  /** 发布记录：操作员也能看，所以不要求读审计的权限；这里只投影发布这一类事件，不暴露别的审计内容（M355）。 */
  app.get(`${prefix}/definition-publications`, {
    config: { access: readAccess },
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', minLength: 1, maxLength: 200, description: '只看这个名称' } } } },
  }, async (request) => {
    const scope = scopeOf(request), { name } = request.query as { name?: string };
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return { publications: await definitionPublications(scope, name) };
  });

  const requesterOf = (request: FastifyRequest): RequestActor => ({ actor: actorOf(identityOf(request)), now: now(), audit: (action, object, content) => audit(request, action, object, content) });

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
      await expirePending(scope, 'definitionPublish', name, '草案在申请之后又被修改', requesterOf(request), result.saved.sha256);
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
   * 发布草案：算出下一版本再发布。严重问题答 400，问题码与本地发布相同。
   * 数据定义范围打开了审批策略时，能批准的主体以外的发布答 202，记一份固定内容哈希与版本的发布申请（P1 票据 11）。
   */
  app.post(`${draftUrl}/publish`, { config: { access: 'authoring.publish' }, schema: { body: PUBLISH_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), storage = scope.storage, { expectedSha256 } = request.body as { expectedSha256: string };
    const { draft, document } = await expectedDraft(storage, name, expectedSha256);
    const workspace = await readWorkspaceDocuments(storage.documents);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    if (!published) throw new ApiError(400, problems);
    const requester = requesterOf(request);
    if ((await constrainedScopes(scope, identityOf(request), ['definitions'])).length) {
      const publishRequest = await openPublishRequest(scope, {
        kind: 'definitionPublish', subject: name, scopes: ['definitions'], sha256: draft.sha256, ...await publishChange(storage, { draft, document, workspace }),
        ...(draft.baseVersion === undefined ? {} : { baseVersion: draft.baseVersion }), version: published.ref.version,
      }, requester);
      reply.code(202);
      return { request: publishRequest };
    }
    const result = await commitDraftPublish(scope, { draft, document, workspace, published }, requester.audit);
    await expirePending(scope, 'definitionPublish', name, '草案已被直接发布', requester);
    reply.code(201);
    return result;
  });

  app.delete(draftUrl, { config: { access: 'definitions.write' } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request);
    const draft = await scope.storage.deleteDefinitionDraft(name);
    if (!draft) throw notFound();
    await audit(request, 'definitionDraft.delete', { type: 'definitionDraft', id: name }, {
      beforeSha256: draft.sha256, diff: auditDiff([{ path: draftSource(name), change: 'removed', beforeSha256: draft.sha256 }]),
    });
    await expirePending(scope, 'definitionPublish', name, '草案已被删除', requesterOf(request));
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
