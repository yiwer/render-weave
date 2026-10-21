/**
 * 数据集的端点（票据 10，M270）：新建、读取、修改、复制、列出，以及只校验、不保存。
 * - 按原始字节存：写数据集的请求体不经全局的 JSON 解析，原文交给引擎的 checkDataset，读回的就是保存时的字节；
 * - 保存时按所选静态数据定义的编译产物校验，问题与渲染时对数据集的检查相同；有严重问题不保存，答 400 与问题清单。
 * 租户由身份决定；别的租户的数据集与不存在的同样答 404。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { NewAuditEvent, StoredDocument, TenantScope, TenantStorage } from '../backend.js';
import { checkDataset, classifyWorkspaceDocument, parseJsonKeepingPrecision, type DatasetDocument, type Problem } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { ApiError, fail, notFound, ServiceProblemCodes } from './problems.js';

/** 列表与保存结果里的一份数据集：ID、名称、所选的静态数据定义与内容哈希。 */
export interface DatasetEntry {
  readonly id: string;
  readonly name?: string;
  readonly staticSchema?: { readonly name: string; readonly version: number };
  readonly sha256: string;
  readonly byteLength: number;
}

/** 经接口保存的数据集 ID：1–200 个字符，没有控制字符，首尾没有空白。推送进来的数据集沿用本地的 ID。 */
const DATASET_ID = /^(?=[\s\S]{1,200}$)[^\s\p{Cc}](?:[^\p{Cc}]*[^\s\p{Cc}])?$/u;
const ID_SCHEMA = { type: 'string', minLength: 1, maxLength: 200, pattern: DATASET_ID.source } as const;

const severe = (problems: readonly Problem[]) => problems.some((problem) => problem.level === 'severe');

function entryOf(stored: StoredDocument, document: DatasetDocument | undefined): DatasetEntry {
  const name = document?.dataset['name'];
  return {
    id: stored.key,
    ...(typeof name === 'string' ? { name } : {}),
    ...(document ? { staticSchema: document.dataset.staticSchema } : {}),
    sha256: stored.sha256,
    byteLength: stored.byteLength,
  };
}

/** 已保存数据集的身份部分；读不了的只列 ID 与哈希。 */
function parsed(bytes: Uint8Array | undefined): DatasetDocument | undefined {
  if (!bytes) return undefined;
  try {
    const found = classifyWorkspaceDocument(parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []));
    return found.kind === 'dataset' ? found.document : undefined;
  } catch { return undefined; }
}

async function storedDataset(storage: TenantStorage, id: string): Promise<StoredDocument | undefined> {
  return (await storage.authoringState()).documents.find((document) => document.kind === 'dataset' && document.key === id);
}

/** 按租户的静态数据定义与资源校验一份数据集的原文。 */
async function check(scope: TenantScope, bytes: Uint8Array) {
  return checkDataset(bytes, await loadTenantWorkspace(scope.storage));
}

/** 写数据集的请求体：JSON 原文的字节。 */
function rawBody(request: FastifyRequest): Uint8Array {
  if (!Buffer.isBuffer(request.body)) throw fail(415, ServiceProblemCodes.requestInvalid, 'request.body', '数据集要以 application/json 发送');
  return new Uint8Array(request.body);
}

const idProblem = (message: string) => fail(400, ServiceProblemCodes.requestInvalid, 'request.body.dataset.id', message);

export function registerDatasetRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, limits, now } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  const audit = (request: FastifyRequest, scope: TenantScope, action: string, object: NewAuditEvent['object']) =>
    scope.appendAudit({ actor: actorOf(identityOf(request)), action, object, crossTenant: false }, now());
  /** 校验后保存；有严重问题答 400，条件不满足（新建时已有）答 409。 */
  const save = async (scope: TenantScope, id: string, bytes: Uint8Array, mode: 'create' | 'update', problems: readonly Problem[], document: DatasetDocument) => {
    if (severe(problems)) throw new ApiError(400, problems);
    const stored = await scope.storage.saveDataset(id, bytes, mode);
    if (!stored && mode === 'create') throw fail(409, ServiceProblemCodes.inputDuplicate, 'request.body.dataset.id', `已有数据集 ${id}`);
    if (!stored) throw notFound();
    return { dataset: entryOf(stored, document), problems };
  };

  app.get('/v1/datasets', { config: { access: 'tenant.read' } }, async (request) => {
    const storage = scopeOf(request).storage;
    const datasets = (await storage.authoringState()).documents.filter((document) => document.kind === 'dataset')
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { datasets: await Promise.all(datasets.map(async (stored) => entryOf(stored, parsed(await storage.contents.get(stored.sha256))))) };
  });

  /** 读回保存时的原始字节。 */
  app.get('/v1/datasets/:datasetId', { config: { access: 'tenant.read' } }, async (request, reply) => {
    const storage = scopeOf(request).storage;
    const stored = await storedDataset(storage, (request.params as { datasetId: string }).datasetId);
    const bytes = stored && await storage.contents.get(stored.sha256);
    if (!bytes) throw notFound();
    return reply.type('application/json; charset=utf-8').send(Buffer.from(bytes));
  });

  app.post('/v1/datasets/:datasetId/copies', {
    config: { access: 'datasets.write' },
    schema: { body: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID_SCHEMA, name: { type: 'string', minLength: 1, maxLength: 200 } } } },
  }, async (request, reply) => {
    const scope = scopeOf(request);
    const stored = await storedDataset(scope.storage, (request.params as { datasetId: string }).datasetId);
    const bytes = stored && await scope.storage.contents.get(stored.sha256);
    if (!bytes) throw notFound();
    const { id, name } = request.body as { id: string; name?: string };
    // 副本与原件只差身份部分的 ID 与名称：按原件校验（原件的数值原文也在这里核对），原件有严重问题时 save 不存副本。
    const source = await check(scope, bytes);
    if (!source.dataset) throw new ApiError(400, source.problems);
    const document = parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []) as { dataset: Record<string, unknown> };
    document.dataset = { ...document.dataset, id, ...(name === undefined ? {} : { name }) };
    const copy = new Uint8Array(Buffer.from(`${JSON.stringify(document, null, 2)}\n`));
    const saved = await save(scope, id, copy, 'create', source.problems, { ...source.dataset, dataset: { ...source.dataset.dataset, id, ...(name === undefined ? {} : { name }) } });
    await audit(request, scope, 'dataset.copy', { type: 'dataset', id });
    reply.code(201);
    return saved;
  });

  // 写数据集的端点拿到请求体的原文：保存原始字节，数值精度由引擎按原文检查（M112）。
  app.register(async (raw) => {
    raw.removeContentTypeParser('application/json');
    raw.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: limits.maxDatasetBytes }, (_request, body, done) => done(null, body));

    raw.post('/v1/datasets', { config: { access: 'datasets.write' }, bodyLimit: limits.maxDatasetBytes }, async (request, reply) => {
      const scope = scopeOf(request), bytes = rawBody(request);
      const checked = await check(scope, bytes);
      if (!checked.dataset) throw new ApiError(400, checked.problems);
      const id = checked.dataset.dataset.id;
      if (id === undefined) throw idProblem('保存的数据集要写 dataset.id');
      if (!DATASET_ID.test(id)) throw idProblem('数据集 ID 要有 1–200 个字符，不能有控制字符，首尾不能是空白');
      const saved = await save(scope, id, bytes, 'create', checked.problems, checked.dataset);
      await audit(request, scope, 'dataset.create', { type: 'dataset', id });
      reply.code(201);
      return saved;
    });

    raw.put('/v1/datasets/:datasetId', { config: { access: 'datasets.write' }, bodyLimit: limits.maxDatasetBytes }, async (request) => {
      const scope = scopeOf(request), id = (request.params as { datasetId: string }).datasetId;
      // 先答"不存在"，再看请求体：别的租户的数据集与不存在的回答相同。
      if (!(await storedDataset(scope.storage, id))) throw notFound();
      const bytes = rawBody(request), checked = await check(scope, bytes);
      if (!checked.dataset) throw new ApiError(400, checked.problems);
      if (checked.dataset.dataset.id !== id) throw idProblem(`请求体里的 dataset.id 要与路径里的数据集 ${id} 一致`);
      const saved = await save(scope, id, bytes, 'update', checked.problems, checked.dataset);
      await audit(request, scope, 'dataset.update', { type: 'dataset', id });
      return saved;
    });

    /** 只校验、不保存，供表单实时提示；不要求 dataset.id。 */
    raw.post('/v1/dataset-checks', { config: { access: 'datasets.write' }, bodyLimit: limits.maxDatasetBytes }, async (request) =>
      ({ problems: (await check(scopeOf(request), rawBody(request))).problems }));
  });
}
