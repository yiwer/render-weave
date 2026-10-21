/**
 * 图片与字体资源的端点（票据 10，M271；M152、M241）：上传、列出、查看、读回内容，替换检查与应用替换。
 * - 上传的新资源从 v1 开始，资源 ID 与种类创建后不变；字体不做授权确认（M241）。内容按原始字节存，
 *   能不能用于绘制由渲染器在预览里报告，与本地资源仓库相同。
 * - 替换分两步（M152）：检查只读，返回受影响的模板、数据集与字体配置，候选内容先存成本租户还没登记的内容；
 *   管理员凭检查报告应用，按预期版本提交，提交前在同一把锁里核对工作区指纹，过期的报告被拒绝。
 * 租户由身份决定；别的租户的资源与不存在的同样答 404。
 */
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { documentSource, parseDocumentSource, type NewAuditEvent, type TenantScope } from '../backend.js';
import {
  memoryWorkspaceDocuments, ProblemCodes, readWorkspaceDocuments, resourceImpact,
  type Problem, type ResourceWorkspaceImpact, type VersionedResourceInfo,
} from '../engine.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { MAX_CONTENT_BYTES } from './authoring.js';
import { ApiError, fail, notFound, ServiceProblemCodes } from './problems.js';

/** 资源 ID 的写法与引擎的资源引用相同（res:资源ID）。 */
const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const SHA256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const BYTE_LENGTH = { type: 'integer', minimum: 0 } as const;
const SCOPE = '覆盖本租户工作区里全部模板（当前修订）与数据集的直接引用，以及服务渲染用的字体配置；包含隐藏元素与所有状态分支。';

/** 替换检查报告：检查时的资源版本、候选内容与影响；应用时原样交回。 */
export interface ReplacementCheck {
  readonly resource: VersionedResourceInfo;
  readonly replacement: { readonly sha256: string; readonly byteLength: number };
  readonly impact: Omit<ResourceWorkspaceImpact, 'workspaceDirectory'>;
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * 工作区指纹（M152）：全部文档的来源、SHA-256 与字节数，加字体配置。
 * 检查时由读到的字节算，应用时由加锁后的登记算；内容按 SHA-256 寻址，两边得到的是同一个值。
 */
function workspaceFingerprint(documents: readonly { readonly source: string; readonly sha256: string; readonly byteLength: number }[], renderOptions: unknown): string {
  const entries = documents.map(({ source, sha256, byteLength }) => [source, sha256, byteLength] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify({ documents: entries, renderOptions })).digest('hex');
}

/** 服务渲染用的字体配置：接口进程与 worker 都用引擎的缺省配置。 */
const serviceRenderOptions = () => resourceImpact({ staticSchemas: [], templates: [], datasets: [], problems: [] }, 'none').impact!.renderOptions;

/** 检查替换某资源的影响：读出租户的全部文档，影响与指纹都按这同一份字节算。 */
async function inspect(scope: TenantScope, id: string): Promise<{ impact?: ReplacementCheck['impact']; problems: Problem[] }> {
  const read = await Promise.all((await scope.storage.documents.list()).map(async (entry) => ({ source: entry.source, bytes: await entry.read() })));
  const documents = await readWorkspaceDocuments(memoryWorkspaceDocuments(read, scope.storage.documents.location));
  let result: ReturnType<typeof resourceImpact>;
  try { result = resourceImpact(documents, id); }
  catch (error) {
    return { problems: [{ level: 'severe', code: ProblemCodes.inputUnreadable, location: { kind: 'input', source: 'workspace' },
      message: `资源影响检查失败：${error instanceof Error ? error.message : String(error)}` }] };
  }
  if (!result.impact) return { problems: result.problems };
  const { renderOptions, references, configuration } = result.impact;
  const registered = read.flatMap(({ source, bytes }) => (parseDocumentSource(source) ? [{ source, sha256: sha256Of(bytes), byteLength: bytes.length }] : []));
  return { problems: result.problems, impact: { workspaceFingerprint: workspaceFingerprint(registered, renderOptions), renderOptions, references, configuration, scope: SCOPE } };
}

/** 上传的内容：application/octet-stream 的原始字节，不能为空。 */
function contentBody(request: FastifyRequest): Uint8Array {
  if (!Buffer.isBuffer(request.body)) throw fail(415, ServiceProblemCodes.requestInvalid, 'request.body', '内容要以 application/octet-stream 上传');
  if (request.body.length === 0) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.body', '内容不能为空');
  return new Uint8Array(request.body);
}

/** 提交没成功：已有同一 ID、预期版本已过期答 409，其余是存储故障。 */
function commitFailure(problems: readonly Problem[]): Error {
  const conflict = problems.some((problem) => problem.code === ProblemCodes.inputDuplicate || problem.code === ProblemCodes.resourceReplacementStale);
  return conflict ? new ApiError(409, problems) : new Error(`资源提交失败：${problems.map((problem) => problem.message).join('；')}`);
}

export function registerResourceRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, now } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  const audit = (request: FastifyRequest, scope: TenantScope, action: string, object: NewAuditEvent['object']) =>
    scope.appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant: false }, now());
  /** 路径里的资源 ID 不合规时也答"不存在"。 */
  const resourceIdOf = (request: FastifyRequest) => {
    const id = (request.params as { resourceId: string }).resourceId;
    if (!RESOURCE_ID.test(id)) throw notFound();
    return id;
  };
  /** 资源的当前版本；不在本租户时答 404。 */
  const currentOf = async (scope: TenantScope, id: string): Promise<VersionedResourceInfo> => {
    const opened = await scope.storage.resources.open();
    if (!opened.store) throw new ApiError(500, opened.problems);
    const current = opened.store.get(id);
    if (!current) throw notFound();
    return current;
  };

  app.get('/v1/resources', { config: { access: 'tenant.read' } }, async (request) => ({
    resources: [...(await scopeOf(request).storage.authoringState()).resources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }));

  app.get('/v1/resources/:resourceId', { config: { access: 'tenant.read' } }, async (request) => {
    const id = resourceIdOf(request);
    const found = (await scopeOf(request).storage.authoringState()).resources.find((resource) => resource.id === id);
    if (!found) throw notFound();
    return found;
  });

  /** 读回一个内容版本的原始字节；按登记的 SHA-256 核对。不按图片类型返回，浏览器不会把它当页面执行。 */
  app.get('/v1/resources/:resourceId/versions/:version/content', { config: { access: 'tenant.read' } }, async (request, reply) => {
    const id = resourceIdOf(request), version = (request.params as { version: string }).version;
    if (!/^[1-9][0-9]{0,8}$/.test(version)) throw notFound();
    const opened = await scopeOf(request).storage.resources.open();
    if (!opened.store?.get(id, Number(version))) throw notFound();
    const bytes = await opened.store.read(id, Number(version));
    return reply.type('application/octet-stream').header('x-content-type-options', 'nosniff').send(Buffer.from(bytes));
  });

  /** 应用替换：凭检查报告按预期版本追加内容版本；提交前在同一把锁里核对工作区指纹。 */
  app.post('/v1/resources/:resourceId/replacements', {
    config: { access: 'resources.replace' },
    schema: { body: { type: 'object', required: ['check'], additionalProperties: false, properties: { check: {
      type: 'object', required: ['resource', 'replacement', 'impact'], properties: {
        resource: { type: 'object', required: ['id', 'kind', 'version', 'sha256', 'byteLength'], properties: {
          id: { type: 'string' }, kind: { type: 'string', enum: ['image', 'font'] }, version: { type: 'integer', minimum: 1 }, sha256: SHA256, byteLength: BYTE_LENGTH } },
        replacement: { type: 'object', required: ['sha256', 'byteLength'], properties: { sha256: SHA256, byteLength: BYTE_LENGTH } },
        impact: { type: 'object', required: ['workspaceFingerprint'], properties: { workspaceFingerprint: SHA256 } },
      } } } } },
  }, async (request) => {
    const scope = scopeOf(request), id = resourceIdOf(request);
    const current = await currentOf(scope, id);
    const { check } = request.body as { check: ReplacementCheck };
    const invalid = (message: string) => fail(400, ServiceProblemCodes.resourceReplacementInvalid, 'request.body.check', `${message}，请重新检查`);
    if (check.resource.id !== id) throw invalid(`检查报告属于资源 ${check.resource.id}，不是 ${id}`);
    if (check.resource.kind !== current.kind) throw invalid('检查报告里的资源种类与资源不符；资源种类创建后不可改变');
    const bytes = await scope.storage.contents.get(check.replacement.sha256);
    if (!bytes || bytes.length !== check.replacement.byteLength || sha256Of(bytes) !== check.replacement.sha256) throw invalid('替换内容不在服务端');
    const { version, sha256, byteLength } = check.resource;
    const renderOptions = serviceRenderOptions();
    let changed = false;
    const committed = await scope.storage.guardedResources((documents) => {
      const now = workspaceFingerprint(documents.map((document) => ({ source: documentSource(document.kind, document.key), sha256: document.sha256, byteLength: document.byteLength })), renderOptions);
      if (now === check.impact.workspaceFingerprint) return;
      changed = true;
      throw new Error('检查之后工作区已变化');
    }).commit([{ type: 'append', id, expected: { version, sha256, byteLength }, bytes }]);
    if (changed) {
      throw fail(409, ServiceProblemCodes.resourceReplacementStale, 'request.body.check.impact.workspaceFingerprint', '检查之后工作区（模板、数据集或字体配置）已变化，请重新检查');
    }
    if (!committed.committed) throw commitFailure(committed.problems);
    await audit(request, scope, 'resource.replace', { type: 'resource', id });
    return committed.committed[0];
  });

  app.register(async (binary) => {
    binary.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CONTENT_BYTES }, (_request, body, done) => done(null, body));

    /** 上传新的图片或字体，从 v1 开始；不给 ID 时由服务生成。 */
    binary.post('/v1/resources', {
      config: { access: 'resources.upload' },
      bodyLimit: MAX_CONTENT_BYTES,
      schema: { querystring: { type: 'object', required: ['kind'], additionalProperties: false, properties: {
        kind: { type: 'string', enum: ['image', 'font'] }, id: { type: 'string', maxLength: 200, pattern: RESOURCE_ID.source } } } },
    }, async (request, reply) => {
      const scope = scopeOf(request);
      const { kind, id = `${(request.query as { kind: string }).kind}-${randomUUID().replaceAll('-', '').slice(0, 12)}` } = request.query as { kind: 'image' | 'font'; id?: string };
      const committed = await scope.storage.resources.commit([{ type: 'create', id, kind, bytes: contentBody(request) }]);
      if (committed.problems.some((problem) => problem.code === ProblemCodes.inputDuplicate)) {
        throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.query.id', `已有资源 ${id}；资源 ID 与种类创建后不变，换内容要走替换`);
      }
      if (!committed.committed) throw commitFailure(committed.problems);
      await audit(request, scope, 'resource.upload', { type: 'resource', id });
      reply.code(201);
      return committed.committed[0];
    });

    /** 替换检查：只读，返回受影响的模板、数据集与字体配置；候选内容存成还没登记的内容，应用时按哈希取用。 */
    binary.post('/v1/resources/:resourceId/replacement-checks', { config: { access: 'resources.replace' }, bodyLimit: MAX_CONTENT_BYTES }, async (request) => {
      const scope = scopeOf(request), id = resourceIdOf(request);
      const resource = await currentOf(scope, id);
      const bytes = contentBody(request);
      const replacement = { sha256: await scope.storage.contents.put(bytes), byteLength: bytes.length };
      const { impact, problems } = await inspect(scope, id);
      if (!impact) throw new ApiError(409, problems);
      return { check: { resource, replacement, impact } satisfies ReplacementCheck, problems };
    });
  });
}
