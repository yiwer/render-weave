/**
 * 数据定义的端点（ADR-0030，P1 票据 04、05、06、17，M297、M345、M355）：新建、读取、保存、校验、预检、发布与删除，列出本租户的数据定义与发布记录。
 * 一套处理逻辑，两种寻址（M261、M345）：客户端点的租户由身份决定，代建端点在路径里写目标租户；同一操作的请求与回答相同。
 * - 数据定义是独立的实体，主键是名称，按原始字节存，读回的 content 与保存时逐字节相同，sha256 就是它的哈希；保存带预期哈希，不是当前内容答 409（draft.stale）；
 * - 保存只要求是 JSON 对象、名称与路径一致，还没写完的也能存；问题由校验回答，与发布同一个入口（publishStaticSchema）；
 * - 数据定义不进工作区：渲染、数据集与模板只看静态数据定义。发布走 publishStaticSchema，原文与编译产物按本地 renderweave publish 的写法成对登记，逐字节相同（M278）；
 * - 发布只产出一个静态版本，不改数据定义：能接着改、接着发布。和哪一版比较读取时现算，取这个名称最新发布的版本；
 * - 删除数据定义不影响静态版本。有过静态版本的名称不能再新建，否则新的数据定义会把旧版本认成自己的；
 * - 发布记录不另存：谁、何时、与哪一版比较读审计（definition.publish、push.commit），内容与差异读不可变的版本本身（M355）。
 * 客户成员的读取不记审计；代建工程师的读取与所有写入都记。写入另记前后内容哈希与差异摘要（M347）。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { auditDiff } from '../audit.js';
import { parseDocumentSource, type AuditContent, type AuditDiff, type AuditDiffPath, type AuditEvent, type NewAuditEvent, type PublishRequestApproval, type StoredDefinition, type TenantScope, type TenantStorage } from '../backend.js';
import { checkDataset, describeTemplate, diffDefinition, publishStaticSchema, readWorkspaceDocuments, templateFieldUses, type DefinitionDiff, type Problem, type PublishedStaticSchema, type StaticSchemaEntry, type StaticSchemaRef, type TemplateEntry, type Workspace, formatStaticSchemaRef, parseSchemaVersion, type SchemaVersion } from '../engine.js';
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
const PUBLISH_CHECK_SCHEMA = { type: 'object', required: ['expectedSha256'], additionalProperties: false, properties: { expectedSha256: { type: 'string', pattern: SHA256 } } } as const;
/** 发布：version 不写就是下一个编号（ADR-0028），写法由引擎查；note 是发布说明。 */
const PUBLISH_SCHEMA = {
  type: 'object', required: ['expectedSha256'], additionalProperties: false,
  properties: { expectedSha256: { type: 'string', pattern: SHA256 }, version: { anyOf: [{ type: 'integer' }, { type: 'string' }] }, note: { type: 'string', maxLength: 2000 } },
} as const;
/** 预检回答前多少份失配数据集的问题摘要，每份至多几条问题（M346）。 */
const MISMATCH_SAMPLES = 20, SAMPLE_PROBLEMS = 5;
const CREATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name'],
  description: '空白新建写 name 与 displayName；复制一个静态版本写 name 与 fromStatic，displayName 不写就沿用它的',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    displayName: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' },
    fromStatic: {
      type: 'object', additionalProperties: false, required: ['name', 'version'],
      properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, version: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
    },
  },
} as const;

const contentSource = (name: string) => `schema:${name}`;
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
  if (!diff || diff.problems.length) return auditDiff([{ path: contentSource(name), change: 'changed', beforeSha256, afterSha256 }]);
  return auditDiff(diffPaths(diff));
}

/** 与最新版本比较：还没发布过就没有基准，与同一份文档去掉全部字段比，字段全算新增。 */
export const baseDocumentOf = (base: unknown, document: unknown) => base ?? { ...(document as object), fields: [] };

/**
 * 这个名称最新发布的静态版本：按登记的先后，字符串版本没有大小（ADR-0028）。
 * 每次读时现算：发布不往数据定义上记任何东西（ADR-0030）。
 */
export async function latestStatic(storage: TenantStorage, workspace: Pick<Workspace, 'staticSchemas'>, name: string): Promise<StaticSchemaEntry | undefined> {
  const registered = (await storage.authoringState()).documents.filter((stored) => stored.kind === 'definition').map((stored) => stored.key);
  return workspace.staticSchemas.filter((entry) => entry.ref.name === name)
    .sort((a, b) => registered.indexOf(`${name}@${a.ref.version}`) - registered.indexOf(`${name}@${b.ref.version}`)).at(-1);
}

interface ToPublish {
  readonly definition: StoredDefinition;
  readonly document: unknown;
  readonly workspace: Pick<Workspace, 'staticSchemas'>;
  readonly published: PublishedStaticSchema;
  /** 发布说明：记在发布的审计事件里，发布记录从那里读。 */
  readonly note?: string;
}

/** 发布对内容的改动：与最新版本比较，它的内容哈希与字段级差异摘要。直接发布与发布申请记同一份。 */
async function publishChange(storage: TenantStorage, { definition, document, workspace }: Omit<ToPublish, 'published'>) {
  const base = await latestStatic(storage, workspace, definition.name);
  const documents = (await storage.authoringState()).documents;
  const beforeSha256 = base && documents.find((stored) => stored.kind === 'definition' && stored.key === `${definition.name}@${base.ref.version}`)?.sha256;
  return { baseVersion: base?.ref.version, ...(beforeSha256 ? { beforeSha256 } : {}), diff: auditDiff(diffPaths(diffDefinition(baseDocumentOf(base?.definition, document), document))) };
}

/**
 * 发布：原文与编译产物按本地发布的写法存，成对登记，数据定义不动（ADR-0030）。批准申请时带 approving，申请与内容在同一个事务里生效。
 * 算版本与登记之间版本被占用（别的发布或推送）答 409，什么也没写，再发一次就会用下一个版本。
 */
export async function commitPublish(scope: TenantScope, { definition, document, workspace, published, note }: ToPublish, audit: AuditWriter, approving?: PublishRequestApproval) {
  const storage = scope.storage, name = definition.name;
  // 先算：登记之后最新版本就是刚发布的这一版了。
  const { baseVersion, ...change } = await publishChange(storage, { definition, document, workspace });
  const definitionBytes = documentBytes(published.definition), compiledBytes = documentBytes(published.compiled);
  const key = `${name}@${published.ref.version}`;
  const [definitionSha256, compiledSha256] = await Promise.all([storage.contents.put(definitionBytes), storage.contents.put(compiledBytes)]);
  const result = await storage.publishDefinition(name, definition.sha256, {
    key, version: published.ref.version, definition: { sha256: definitionSha256, byteLength: definitionBytes.length }, compiled: { sha256: compiledSha256, byteLength: compiledBytes.length },
  }, approving);
  if (!result) throw notFound();
  if ('stale' in result) throw staleDraft(result.stale, 'request.body.expectedSha256');
  if ('taken' in result) throw fail(409, ServiceProblemCodes.draftVersionTaken, 'request.path.name', `${formatStaticSchemaRef(published.ref)} 刚被别的发布或推送占用；什么也没写，重新发布`);
  await audit('definition.publish', { type: 'definition', id: key }, { ...change, afterSha256: definitionSha256, ...(note ? { reason: note } : {}) });
  return { name, version: published.ref.version, ...(baseVersion === undefined ? {} : { baseVersion }), definitionSha256, compiledSha256 };
}

/** 绑定最新版本的数据集逐份按新编译产物校验（M346）：按 ID 排序，超过上限只校验前面的，回答失配份数与前几份的问题摘要。 */
function datasetImpact(workspace: Workspace, base: StaticSchemaRef, published: PublishedStaticSchema, limit: number) {
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
 * 差异与基准比：网页发布的基准是当时最新的版本（审计的 beforeSha256），推送没有记，与它的上一版比；都没有就是首个版本，字段全算新增。
 */
async function definitionPublications(scope: TenantScope, only: string | undefined) {
  const storage = scope.storage, documents = (await storage.authoringState()).documents;
  const compiled = new Map(documents.filter((stored) => stored.kind === 'compiled').map((stored) => [stored.key, stored.sha256]));
  const versions = documents.flatMap((stored) => {
    const key = stored.kind === 'definition' && compiled.has(stored.key) ? parseKey(stored.key) : undefined;
    return key && (only === undefined || key.name === only) ? [{ ...key, key: stored.key, stored, compiledSha256: compiled.get(stored.key)! }] : [];
  });
  const registered = versions.map((version) => version.key);
  const events = await publicationEvents(scope, new Set(registered));
  const content = new Map(await Promise.all(versions.map(async (version) => [version.key, await readJson(storage, version.stored)] as const)));
  return versions.flatMap((version) => {
    const document = content.get(version.key), event = events.get(version.key);
    if (!document) return [];
    const siblings = versions.filter((other) => other.name === version.name);
    const base = event?.action === 'definition.publish'
      ? siblings.find((other) => other.stored.sha256 === event.beforeSha256)
      : siblings[siblings.indexOf(version) - 1];
    const { problems: _none, ...diff } = diffDefinition(baseDocumentOf(base && content.get(base.key), document), document);
    const displayName = document['displayName'];
    return [{
      name: version.name, version: version.version, displayName: typeof displayName === 'string' ? displayName : version.name,
      sha256: version.stored.sha256, compiledSha256: version.compiledSha256, ...(base ? { baseVersion: base.version, baseSha256: base.stored.sha256 } : {}),
      ...(event ? { source: event.action === 'push.commit' ? 'push' : 'web', at: event.at, actor: { kind: event.actor.kind, label: event.actor.label } } : {}),
      ...(event?.action === 'definition.publish' && event.reason ? { note: event.reason } : {}), diff,
    }];
  }).sort((a, b) => {
    // 新的在前；审计之前的版本没有时间，排在最后。
    if ((a.at ?? '') !== (b.at ?? '')) return (a.at ?? '') < (b.at ?? '') ? 1 : -1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : registered.indexOf(`${b.name}@${b.version}`) - registered.indexOf(`${a.name}@${a.version}`);
  });
}

/** 一个静态版本的原文；与 /v1/static-schemas 一样，原文与编译产物都在才算有。复制成新的数据定义时读。 */
async function staticVersion(storage: TenantStorage, name: string, version: SchemaVersion): Promise<Record<string, unknown> | undefined> {
  const key = `${name}@${version}`, documents = (await storage.authoringState()).documents;
  const definition = documents.find((stored) => stored.kind === 'definition' && stored.key === key);
  return definition && documents.some((stored) => stored.kind === 'compiled' && stored.key === key) ? readJson(storage, definition) : undefined;
}

export function registerDefinitionRoutes(app: FastifyInstance, context: ApiContext, addressing: AuthoringAddressing): void {
  const { limits, now } = context;
  const { prefix, read: readAccess, scopeOf, crossTenant } = addressing;
  const url = `${prefix}/definitions`, itemUrl = `${url}/:name`;
  const audit = (request: FastifyRequest, action: string, object: NewAuditEvent['object'], content: AuditContent = {}) =>
    scopeOf(request).appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant, ...content }, now());
  /** 代建工程师的读取也记审计（M261）；客户成员的读取不记。 */
  const auditRead = async (request: FastifyRequest, object: NewAuditEvent['object']) => { if (crossTenant) await audit(request, 'authoring.read', object); };
  const writer = (request: FastifyRequest) => ({ updatedBy: actorOf(identityOf(request)).label, now: now() });
  /** 路径里的数据定义；没有时答 404。 */
  const definitionOf = async (storage: TenantStorage, name: string): Promise<StoredDefinition> => {
    const definition = await storage.definition(name);
    if (!definition) throw notFound();
    return definition;
  };

  /**
   * 本租户的数据定义：每一个的显示名称与字段数（来自它自己的内容）、这个名称的静态版本、各版本被多少数据集与模板直接使用。没有原文或编译产物的版本不列。
   * 只有静态版本、数据定义已删除的名称不在这里，在 /v1/static-schemas 上标"来源已删除"。
   */
  const definitionsOf = async (scope: TenantScope) => {
    const workspace = await readWorkspaceDocuments(scope.storage.documents);
    const used = new Map<string, { datasets: number; templates: number }>();
    const usage = (key: string) => used.get(key) ?? used.set(key, { datasets: 0, templates: 0 }).get(key)!;
    for (const { document } of workspace.datasets) usage(`${document.dataset.staticSchema.name}@${document.dataset.staticSchema.version}`).datasets++;
    for (const template of workspace.templates) {
      const base = describeTemplate(template.document).template?.base;
      if (base) usage(`${base.name}@${base.version}`).templates++;
    }
    const rows = await scope.storage.definitions();
    const versions = new Map<string, { version: SchemaVersion; displayName: string; datasets: number; templates: number }[]>();
    const registered = (await scope.storage.authoringState()).documents.filter((stored) => stored.kind === 'definition').map((stored) => stored.key);
    for (const { ref, definition, compiled } of workspace.staticSchemas) {
      if (definition === undefined || compiled === undefined) continue;
      const displayName = (definition as { displayName?: unknown }).displayName;
      const list = versions.get(ref.name) ?? [];
      list.push({ version: ref.version, displayName: typeof displayName === 'string' ? displayName : ref.name, ...(used.get(`${ref.name}@${ref.version}`) ?? { datasets: 0, templates: 0 }) });
      versions.set(ref.name, list);
    }
    return {
      workspace,
      definitions: await Promise.all([...rows].sort((a, b) => (a.name < b.name ? -1 : 1)).map(async (row) => {
        // 版本按发布的先后：字符串版本没有大小，最后一个就是最新的（ADR-0028）。
        const name = row.name, list = (versions.get(name) ?? []).sort((a, b) => registered.indexOf(`${name}@${a.version}`) - registered.indexOf(`${name}@${b.version}`));
        const bytes = await scope.storage.contents.get(row.sha256);
        const document = bytes ? parsedDocument(bytes) as { displayName?: unknown; fields?: unknown } : undefined;
        // 还没写成字段列表的没有字段数（M360）。
        return { ...row, displayName: typeof document?.displayName === 'string' ? document.displayName : name, ...(Array.isArray(document?.fields) ? { fieldCount: document.fields.length } : {}), versions: list };
      })),
    };
  };

  app.get(url, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), { definitions } = await definitionsOf(scope);
    await auditRead(request, { type: 'tenant', id: scope.tenantId });
    return { definitions };
  });

  /**
   * 一个数据定义：列表里的一项，加原文与每个字段被哪些模板读到（详情页的"谁在用"，改名与删字段时提示影响）。没有模板读的字段不列。
   * content 就是保存时的字节，它的 SHA-256 是 sha256。
   */
  app.get(itemUrl, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), { workspace, definitions } = await definitionsOf(scope);
    const definition = definitions.find((item) => item.name === name);
    const bytes = definition && await scope.storage.contents.get(definition.sha256);
    if (!definition || !bytes) throw notFound();
    await auditRead(request, { type: 'definition', id: name });
    const uses = fieldUses(name, workspace.templates, workspace.staticSchemas);
    return { ...definition, content: Buffer.from(bytes).toString('utf8'), fieldUses: [...uses].map(([field, templates]) => ({ field, templates })) };
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

  /**
   * 新建数据定义：空白，或复制一个静态版本（原文去掉版本号，换成这个名称）。名称是主键：已有数据定义答 409；
   * 有过静态版本的名称也答 409，那个数据定义被删了，新建的会把旧版本认成自己的。
   */
  app.post(url, { config: { access: 'definitions.write' }, schema: { body: CREATE_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), body = request.body as { name: string; displayName?: string; fromStatic?: { name: string; version: number | string } };
    const { name, displayName, fromStatic } = body;
    if (!NAME.test(name)) throw invalid('request.body.name', '数据定义名称要有 1–200 个字符，不能有控制字符，首尾不能是空白');
    if (!fromStatic && displayName === undefined) throw invalid('request.body', '空白新建要写 displayName，复制要写 fromStatic');
    if ((await scope.storage.authoringState()).documents.some((stored) => stored.kind === 'definition' && parseKey(stored.key)?.name === name)) {
      throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `名称 ${name} 已有发布过的静态数据定义；名称不能再用，换一个`);
    }
    let bytes: Uint8Array;
    if (fromStatic) {
      const version = parseSchemaVersion(fromStatic.version);
      if (version === undefined) throw invalid('request.body.fromStatic.version', '版本的写法不对');
      const source = await staticVersion(scope.storage, fromStatic.name, version);
      if (!source) throw notFound();
      const { version: _version, ...rest } = source;
      bytes = documentBytes({ ...rest, name, ...(displayName === undefined ? {} : { displayName }) });
    } else bytes = documentBytes({ dslVersion: 'renderweave-schema/1', name, displayName, fields: [] });
    const definition = await scope.storage.createDefinition({ name, bytes }, writer(request));
    if (!definition) throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.name', `已有数据定义 ${name}`);
    await audit(request, 'definition.create', { type: 'definition', id: name }, {
      afterSha256: definition.sha256, diff: auditDiff([{ path: contentSource(name), change: 'added', afterSha256: definition.sha256 }]),
    });
    reply.code(201);
    return definition;
  });

  // 保存拿到请求体的原文：按原始字节存（同数据集，M270）。
  app.register(async (raw) => {
    // 代建端点所在的作用域还认 application/octet-stream；两种寻址要答得一样，这里只留 JSON。
    raw.removeAllContentTypeParsers();
    raw.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: limits.maxRequestBytes }, (_request, body, done) => done(null, body));

    raw.put(itemUrl, {
      config: { access: 'definitions.write' }, bodyLimit: limits.maxRequestBytes,
      schema: { querystring: { type: 'object', required: ['expectedSha256'], additionalProperties: false, properties: { expectedSha256: { type: 'string', pattern: SHA256 } } } },
    }, async (request) => {
      const scope = scopeOf(request), name = nameOf(request), storage = scope.storage;
      // 先答"不存在"，再看请求体：别的租户的数据定义与不存在的回答相同。
      await definitionOf(storage, name);
      const bytes = checkedDocument(request.body, name, '数据定义'), { expectedSha256 } = request.query as { expectedSha256: string };
      const before = await storage.contents.get(expectedSha256);
      const result = await storage.saveDefinition(name, expectedSha256, bytes, writer(request));
      if (!result) throw notFound();
      if ('stale' in result) throw staleDraft(result.stale, 'request.querystring.expectedSha256');
      await audit(request, 'definition.save', { type: 'definition', id: name }, {
        beforeSha256: expectedSha256, afterSha256: result.saved.sha256, diff: saveDiff(name, before, bytes, expectedSha256, result.saved.sha256),
      });
      await expirePending(scope, 'definitionPublish', name, '数据定义在申请之后又被修改', requesterOf(request), result.saved.sha256);
      return result.saved;
    });
  });

  /**
   * 校验并预览编译产物，都按当前保存的内容，不写任何东西：
   * problems 定位到字段，走发布的同一入口；没有严重问题时给下一个版本号与编译产物。
   * 与最新版本相比被删除的字段（改名等于删一个、加一个）列在 affectedBindings，带用到它们的模板。
   */
  app.get(`${itemUrl}/check`, { config: { access: readAccess } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), definition = await definitionOf(scope.storage, name);
    const bytes = await scope.storage.contents.get(definition.sha256);
    if (!bytes) throw notFound();
    const document = parsedDocument(bytes), workspace = await readWorkspaceDocuments(scope.storage.documents);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    const base = await latestStatic(scope.storage, workspace, name);
    const removed = base?.definition === undefined ? [] : diffDefinition(base.definition, document).fields.filter((field) => field.affectsBindings).map((field) => field.path);
    await auditRead(request, { type: 'definition', id: name });
    return {
      sha256: definition.sha256, ...(base ? { baseVersion: base.ref.version } : {}), problems,
      ...(published ? { version: published.ref.version, compiled: published.compiled } : {}),
      affectedBindings: affectedBindings(name, removed, workspace.templates, workspace.staticSchemas),
    };
  });

  /** 路径里的数据定义，内容哈希要等于预期；不符答 409，与保存相同。 */
  const expectedDefinition = async (storage: TenantStorage, name: string, expectedSha256: string) => {
    const definition = await definitionOf(storage, name);
    if (definition.sha256 !== expectedSha256) throw staleDraft(definition.sha256, 'request.body.expectedSha256');
    const bytes = await storage.contents.get(definition.sha256);
    if (!bytes) throw notFound();
    return { definition, document: parsedDocument(bytes) };
  };

  /**
   * 发布预检（只读）：与最新版本的字段级差异、绑定最新版本的数据集按新编译产物会失配多少份、仍绑定旧版本的模板（不改动它们，ADR-0008）。
   * 有严重问题时只答问题，发布也会同样拒绝。
   */
  app.post(`${itemUrl}/publish-check`, { config: { access: 'authoring.publish' }, schema: { body: PUBLISH_CHECK_SCHEMA } }, async (request) => {
    const scope = scopeOf(request), name = nameOf(request), { expectedSha256 } = request.body as { expectedSha256: string };
    const { definition, document } = await expectedDefinition(scope.storage, name, expectedSha256);
    const workspace = await loadTenantWorkspace(scope.storage);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas);
    await auditRead(request, { type: 'definition', id: name });
    const base = await latestStatic(scope.storage, workspace, name);
    const reply = { sha256: definition.sha256, ...(base ? { baseVersion: base.ref.version } : {}), problems };
    if (!published) return reply;
    const { problems: _none, ...diff } = diffDefinition(baseDocumentOf(base?.definition, document), document);
    const templates = workspace.templates.flatMap((template) => {
      const found = describeTemplate(template.document).template?.base;
      return found?.name === name ? [{ name: template.name, base: found }] : [];
    }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return {
      ...reply, version: published.ref.version, diff, templates,
      datasets: datasetImpact(workspace, { name, version: base?.ref.version ?? published.ref.version }, published, limits.publishCheckDatasets),
    };
  });

  /**
   * 发布：算出下一版本，产出一个静态版本，数据定义不动。严重问题答 400，问题码与本地发布相同。
   * 数据定义范围打开了审批策略时，能批准的主体以外的发布答 202，记一份固定内容哈希与版本的发布申请（P1 票据 11）。
   */
  app.post(`${itemUrl}/publish`, { config: { access: 'authoring.publish' }, schema: { body: PUBLISH_SCHEMA } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request), storage = scope.storage;
    const { expectedSha256, version, note: written } = request.body as { expectedSha256: string; version?: number | string; note?: string };
    const note = written?.trim() || undefined;
    const { definition, document } = await expectedDefinition(storage, name, expectedSha256);
    const workspace = await readWorkspaceDocuments(storage.documents);
    const { published, problems } = publishStaticSchema(document, workspace.staticSchemas, version === undefined ? {} : { version });
    if (!published) throw new ApiError(400, problems);
    const requester = requesterOf(request);
    if ((await constrainedScopes(scope, identityOf(request), ['definitions'])).length) {
      const { baseVersion, ...change } = await publishChange(storage, { definition, document, workspace });
      const publishRequest = await openPublishRequest(scope, {
        kind: 'definitionPublish', subject: name, scopes: ['definitions'], sha256: definition.sha256, ...change,
        ...(baseVersion === undefined ? {} : { baseVersion }), version: published.ref.version, ...(note ? { note } : {}),
      }, requester);
      reply.code(202);
      return { request: publishRequest };
    }
    const result = await commitPublish(scope, { definition, document, workspace, published, ...(note ? { note } : {}) }, requester.audit);
    await expirePending(scope, 'definitionPublish', name, '这份内容已被直接发布', requester);
    reply.code(201);
    return result;
  });

  /** 删除数据定义：静态版本不受影响，模板与数据集照旧用。 */
  app.delete(itemUrl, { config: { access: 'definitions.write' } }, async (request, reply) => {
    const scope = scopeOf(request), name = nameOf(request);
    const definition = await scope.storage.deleteDefinition(name);
    if (!definition) throw notFound();
    await audit(request, 'definition.delete', { type: 'definition', id: name }, {
      beforeSha256: definition.sha256, diff: auditDiff([{ path: contentSource(name), change: 'removed', beforeSha256: definition.sha256 }]),
    });
    await expirePending(scope, 'definitionPublish', name, '数据定义已被删除', requesterOf(request));
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
