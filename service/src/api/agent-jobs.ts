/** 数据集智能导入：上传与入队、可恢复进度、来源审核和整组应用。 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { ApiError, fail, notFound, ServiceProblemCodes } from './problems.js';
import { advanceJob, AgentJobConflict, authoringBasis, type AgentJob } from '../agent-jobs.js';
import { agentScratch, artifactBytes, captureAgentFiles, contentHash, restoreAgentFiles } from '../agent-files.js';
import { changeReview, checkDataset, readReview, type ReviewView } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import type { TenantStorage } from '../backend.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const refSchema = { type: 'object', additionalProperties: false, required: ['name', 'version'], properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, version: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' }] } } };
const revision = { type: 'integer', minimum: 1 };
const conflict = (message: string) => fail(409, ServiceProblemCodes.inputDuplicate, 'request', message);
function summary(job: AgentJob) {
  const { workspace: _workspace, artifacts: _artifacts, diagnostics: _diagnostics, lease: _lease, actor: _actor, ...view } = job;
  return view;
}
function reviewView(view: ReviewView) {
  return { candidates: view.candidates, pending: view.pending, problems: view.problems, excel: view.excel,
    notes: view.round.notes, usage: view.round.usage, canApprove: view.canApprove };
}
async function checkedReview(root: string) {
  const loaded = await readReview(root);
  if (!loaded.view || loaded.problems.length) throw new ApiError(400, loaded.problems.length ? loaded.problems : [{ code: 'review.invalid', level: 'severe', location: { kind: 'input', source: 'job' }, message: '任务审核材料不完整' }]);
  return loaded.view;
}
const withReview = <T>(storage: TenantStorage, job: AgentJob, work: (root: string, view: ReviewView) => Promise<T>) => agentScratch(async root => {
  await restoreAgentFiles(storage, job, root); return work(root, await checkedReview(root));
});

export function registerAgentJobRoutes(app: FastifyInstance, context: ApiContext, enabled: boolean): void {
  const maxWorkbookBytes = Math.min(context.limits.maxWorkbookBytes, 16 * 1024 * 1024);
  const scopeOf = (request: FastifyRequest) => context.backend.tenant(ownTenant(identityOf(request)));
  const read = async (request: FastifyRequest) => {
    const id = (request.params as { id: string }).id;
    if (!uuid.test(id)) throw notFound();
    const scope = scopeOf(request), job = await scope.storage.agentJobs.get(id);
    if (!job) throw notFound(); return { scope, job };
  };
  const save = async (storage: TenantStorage, ...args: Parameters<TenantStorage['agentJobs']['save']>) => {
    try { await storage.agentJobs.save(...args); } catch (e) { if (e instanceof AgentJobConflict) throw conflict(e.message); throw e; }
  };
  app.get('/v1/agent-jobs', { config: { access: 'tenant.read' } }, async request => ({ enabled, maxWorkbookBytes, jobs: (await scopeOf(request).storage.agentJobs.list()).map(summary) }));
  app.post('/v1/agent-jobs', { config: { access: 'datasets.write' }, bodyLimit: Math.ceil(maxWorkbookBytes * 4 / 3) + 65536,
    schema: { body: { type: 'object', additionalProperties: false, required: ['staticSchema', 'workbook', 'filename', 'brief'], properties: {
      requestId: { type: 'string', pattern: uuid.source }, staticSchema: refSchema,
      workbook: { type: 'string', minLength: 4 }, filename: { type: 'string', minLength: 1, maxLength: 200 }, brief: { type: 'string', minLength: 1, maxLength: 12000 },
    } } },
  }, async (request, reply) => {
    if (!enabled) throw fail(503, ServiceProblemCodes.workerUnavailable, 'request', '智能导入尚未配置处理服务');
    const body = request.body as { requestId?: string; staticSchema: AgentJob['staticSchema']; workbook: string; filename: string; brief: string };
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body.workbook) || body.workbook.length % 4) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.workbook', '工作簿不是有效的 base64');
    const bytes = Buffer.from(body.workbook, 'base64');
    if (bytes.length > maxWorkbookBytes) throw fail(413, ServiceProblemCodes.limitWorkbookTooLarge, 'request.workbook', '工作簿超过文件大小上限');
    if (!body.filename.toLowerCase().endsWith('.xlsx') || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw fail(400, ServiceProblemCodes.importWorkbookUnreadable, 'request.workbook', '请上传 .xlsx 工作簿');
    const scope = scopeOf(request), storage = scope.storage, id = body.requestId ?? randomUUID();
    const old = await storage.agentJobs.get(id), sha256 = contentHash(bytes);
    if (old) {
      if (old.source.sha256 !== sha256 || old.brief !== body.brief || old.staticSchema.name !== body.staticSchema.name || old.staticSchema.version !== body.staticSchema.version) throw conflict('相同请求 ID 的内容已改变');
      return { job: summary(old) };
    }
    const state = await storage.authoringState(), workspace = await loadTenantWorkspace(storage);
    if (!workspace.staticSchemas.some(s => s.ref.name === body.staticSchema.name && s.ref.version === body.staticSchema.version && s.compiled)) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.staticSchema', '本租户没有这个静态数据定义版本');
    // 固定读取所需文档；模板不参与数据提取，资源引用仍由最终数据集检查把关。
    const documents = state.documents.filter(d => ['definition', 'compiled', 'dataset'].includes(d.kind));
    const now = context.now().toISOString(), actor = actorOf(identityOf(request));
    const job: AgentJob = { id, revision: 1, kind: 'dataset-extraction', status: 'queued', createdAt: now, updatedAt: now,
      actor, staticSchema: body.staticSchema, filename: body.filename, brief: body.brief, workspace: documents,
      source: { file: 'source.xlsx', sha256: await storage.contents.put(bytes), byteLength: bytes.length }, events: [{ sequence: 1, at: now, message: '原件已保存，等待处理' }] };
    await save(storage, job, 0, { audit: { actor, action: 'agent.create', object: { type: 'agentJob', id }, crossTenant: false, afterSha256: sha256 } });
    reply.code(202); return { job: summary(job) };
  });
  app.get('/v1/agent-jobs/:id', { config: { access: 'tenant.read' } }, async request => {
    const { scope, job } = await read(request);
    const review = job.artifacts ? await withReview(scope.storage, job, async (_root, view) => reviewView(view)) : undefined;
    return { job: summary(job), ...(review ? { review } : {}) };
  });
  app.get('/v1/agent-jobs/:id/source', { config: { access: 'tenant.read' } }, async (request, reply) => {
    const { scope, job } = await read(request);
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(job.filename)}`).send(Buffer.from(await artifactBytes(scope.storage, job.source)));
  });
  app.get('/v1/agent-jobs/:id/cells', { config: { access: 'tenant.read' }, schema: { querystring: { type: 'object', additionalProperties: false, properties: {
    sheet: { type: 'string', maxLength: 100 }, cell: { type: 'string', pattern: '^[A-Z]{1,3}[1-9][0-9]*$' }, offset: { type: 'string', pattern: '^[0-9]{1,6}$' },
  } } } }, async request => {
    const { scope, job } = await read(request), query = request.query as { sheet?: string; cell?: string; offset?: string };
    const artifact = job.artifacts?.find(a => a.file === 'excel/view.json'); if (!artifact) throw notFound();
    const view = JSON.parse(Buffer.from(await artifactBytes(scope.storage, artifact)).toString('utf8')) as { sheets: { id: string; name: string; cells: { address: string }[]; comments?: unknown[] }[] };
    const sheet = view.sheets.find(s => s.id === (query.sheet ?? view.sheets[0]?.id)); if (!sheet) throw notFound();
    const cells = query.cell ? sheet.cells.filter(c => (c as any).cell === query.cell || c.address === query.cell) : sheet.cells;
    const offset = Number(query.offset ?? 0);
    return { sheets: view.sheets.map(s => ({ id: s.id, name: s.name })), sheet: sheet.id, cells: cells.slice(offset, offset + 100), total: cells.length, offset };
  });
  app.post('/v1/agent-jobs/:id/cancel', { config: { access: 'datasets.write' } }, async request => {
    const { scope, job } = await read(request);
    if (['applied', 'failed', 'cancelled'].includes(job.status)) return { job: summary(job) };
    const next = advanceJob(job, { status: 'cancelled' }, '用户取消了任务', context.now());
    await save(scope.storage, next, job.revision, { audit: { actor: actorOf(identityOf(request)), action: 'agent.cancel', object: { type: 'agentJob', id: job.id }, crossTenant: false } });
    return { job: summary(next) };
  });
  app.post('/v1/agent-jobs/:id/review', { config: { access: 'datasets.write' }, bodyLimit: context.limits.maxDatasetBytes + 8192,
    schema: { body: { type: 'object', additionalProperties: false, required: ['revision', 'item', 'document', 'reason'], properties: {
      revision, item: { type: 'integer', minimum: 0 }, document: { type: 'object' }, reason: { type: 'string', minLength: 1, maxLength: 2000 },
    } } },
  }, async request => {
    const { scope, job } = await read(request), body = request.body as { revision: number; item: number; document: unknown; reason: string };
    if (job.status !== 'needsReview' || job.revision !== body.revision) throw conflict('任务状态已改变，请刷新后核对');
    return withReview(scope.storage, job, async (root) => {
      const changed = await changeReview(root, { type: 'decide', item: body.item, action: 'edit', value: body.document, note: body.reason });
      if (!changed.view || changed.problems.length) throw new ApiError(400, changed.problems);
      const next = advanceJob(job, { artifacts: await captureAgentFiles(scope.storage, root) }, '人工修改已保存，需核对后确认整组数据', context.now());
      await save(scope.storage, next, job.revision, { audit: { actor: actorOf(identityOf(request)), action: 'agent.review', object: { type: 'agentJob', id: job.id }, crossTenant: false, reason: body.reason } });
      return { job: summary(next), review: reviewView(changed.view) };
    });
  });
  app.post('/v1/agent-jobs/:id/apply', { config: { access: 'datasets.write' }, schema: { body: { type: 'object', additionalProperties: false, required: ['revision', 'confirmed'], properties: { revision, confirmed: { const: true } } } } }, async request => {
    const { scope, job } = await read(request), body = request.body as { revision: number };
    if (job.status === 'applied') return { job: summary(job) };
    if (job.status !== 'needsReview' || body.revision !== job.revision) throw conflict('任务状态已改变，请刷新后核对');
    return withReview(scope.storage, job, async (root, original) => {
      for (const pending of original.pending.filter(p => !p.decision)) {
        const decided = await changeReview(root, { type: 'decide', item: pending.item, action: 'adopt' });
        if (decided.problems.length) throw new ApiError(400, decided.problems);
      }
      await changeReview(root, { type: 'confirmRest', confirmed: true });
      const approved = await changeReview(root, { type: 'approve', comment: '用户在数据集导入页面核对后确认整组保存' });
      if (!approved.view || approved.problems.length) throw new ApiError(400, approved.problems);
      const state = await scope.storage.authoringState(), workspace = await loadTenantWorkspace(scope.storage);
      for (const fixed of job.workspace.filter(d => d.kind === 'definition' || d.kind === 'compiled')) {
        if (!state.documents.some(d => d.kind === fixed.kind && d.key === fixed.key && d.sha256 === fixed.sha256)) throw conflict('静态数据定义材料已改变，请重新提取');
      }
      const datasets = approved.view.candidates.map(candidate => {
        const bytes = Buffer.from(JSON.stringify(candidate.document));
        const checked = checkDataset(bytes, workspace);
        if (!checked.dataset || checked.problems.some(p => p.level === 'severe')) throw new ApiError(400, checked.problems);
        const id = checked.dataset.dataset.id;
        if (!id || id.length > 200 || id.trim() !== id || /\p{Cc}/u.test(id)) throw fail(400, ServiceProblemCodes.requestInvalid, 'dataset.id', '数据集 ID 非法');
        return { id, bytes };
      });
      if (!datasets.length || datasets.length !== original.candidates.length) throw conflict('候选集合不完整');
      const next = advanceJob(job, { status: 'applied', artifacts: await captureAgentFiles(scope.storage, root), datasetIds: datasets.map(d => d.id) }, `已保存 ${datasets.length} 份数据集`, context.now());
      await save(scope.storage, next, job.revision, { datasets, basis: authoringBasis(state), audit: { actor: actorOf(identityOf(request)), action: 'agent.apply', object: { type: 'agentJob', id: job.id }, crossTenant: false,
        afterSha256: contentHash(Buffer.concat(datasets.map(d => d.bytes))) } });
      return { job: summary(next) };
    });
  });
}
