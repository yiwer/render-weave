/**
 * 批量正式交付的端点（票据 07，ADR-0017、ADR-0019、M246）。正式图只走这里：单张也是一项的批次，每张都有出图记录。
 * - 提交：接口进程固定批次（引擎 freezeBatch），把快照存成本租户的内容，按项入队，立即返回批次；
 *   外层非法整批拒绝；单项超出像素、展开规模或数据集字节数只让这一项失败，不渲染；
 * - 幂等：带 Idempotency-Key 时，重试返回同一批次，同一个键配不同的请求答 409；
 * - 查询逐项进度与结果；取消：排队的项标为未执行，正在渲染的一项由 worker 结束；
 * - 额度（票据 09，ADR-0020）：建批次时预占本批项数，本月额度不够就整批拒绝（429 quota.exceeded，说明里写剩余额度）。
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { BatchState, QuotaShortfall } from '../backend.js';
import { batchView } from '../batches.js';
import { freezeBatch, measureRender, type BatchSnapshot, type Problem } from '../engine.js';
import { openTenantWorkspace } from '../preview.js';
import { actorOf, identityOf, ownTenant, type ApiContext } from './app.js';
import { datasetLimitProblems, measureLimitProblems } from './previews.js';
import { ApiError, fail, notFound, objectId, problem, ServiceProblemCodes, type ServiceProblem } from './problems.js';

const KEY_HEADER = 'idempotency-key';
/** 幂等键：1–200 个可见字符。 */
const KEY = /^[\x21-\x7e -￿][\x20-\x7e -￿]{0,199}$/u;

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers[KEY_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !KEY.test(value)) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.headers.idempotency-key', '幂等键须是 1–200 个可见字符');
  return value;
}

export function registerBatchRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, limits, now } = context;
  const scopeOf = (request: FastifyRequest) => backend.tenant(ownTenant(identityOf(request)));
  const audit = (request: FastifyRequest, action: string, batchId: string) => {
    const identity = identityOf(request);
    return scopeOf(request).appendAudit({ actor: actorOf(identity), action, object: { type: 'batch', id: batchId }, crossTenant: false }, now());
  };
  /** 额度不够：整批拒绝，不建批次、不预占。 */
  const exceeded = (shortfall: QuotaShortfall) => {
    const remaining = Math.max(shortfall.limit - shortfall.used - shortfall.reserved, 0);
    return new ApiError(429, [problem(ServiceProblemCodes.quotaExceeded, 'request.items',
      `本月（${shortfall.period}）额度不够这一批：限额 ${shortfall.limit} 张，已用 ${shortfall.used}、预占 ${shortfall.reserved}，剩余 ${remaining} 张，本批 ${shortfall.requested} 项。`
      + '整批未提交；额度由平台管理员按套餐设置，下个月重新计算')], { quota: { ...shortfall, remaining } });
  };
  /** 幂等键已有批次：同一个请求返回它，不同的请求答 409。 */
  const replay = (state: BatchState, requestSha256: string) => {
    if (state.requestSha256 !== requestSha256) {
      throw fail(409, ServiceProblemCodes.batchIdempotencyConflict, 'request.headers.idempotency-key', `幂等键已用于批次 ${state.batchId}，请求内容与那次不同；重试请发送同样的请求，新批次请换一个键`);
    }
    return batchView(state);
  };

  app.post('/v1/batches', { config: { access: 'deliver' }, bodyLimit: limits.maxBatchRequestBytes }, async (request, reply) => {
    const scope = scopeOf(request), key = idempotencyKey(request), body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.body', '批量请求必须是 JSON 对象');
    const input = body as Record<string, unknown>;
    if (input['mode'] !== undefined && input['mode'] !== 'final') {
      throw fail(400, ServiceProblemCodes.requestInvalid, 'request.mode', '批量交付只出正式图；草稿走预览');
    }
    const batchRequest = { ...input, mode: 'final' };
    const requestSha256 = createHash('sha256').update(JSON.stringify(batchRequest)).digest('hex');
    if (key !== undefined) {
      const existing = await scope.tasks.findBatch(key);
      if (existing) return replay(existing, requestSha256);
    }

    // 固定：校验外层，固定文档与资源版本；外层非法、根模板无法准备等整批拒绝，问题清单与本地交付相同（M153、M258）。
    const opened = await openTenantWorkspace(scope.storage);
    if (!opened.store) throw new ApiError(500, opened.workspace.problems as unknown as ServiceProblem[]);
    const frozen = await freezeBatch({ workspace: opened.documents, resources: opened.store, request: batchRequest });
    if (!frozen.snapshot) throw new ApiError(400, frozen.problems as unknown as ServiceProblem[]);

    // 入队前的限制（ADR-0017）：只让超限的那一项失败，问题写进快照里这一项的准备问题，worker 不渲染它。
    const envelope = frozen.snapshot.envelope, plan = await scope.plan();
    const items: BatchSnapshot['items'][number][] = [];
    for (const item of frozen.snapshot.items) {
      if (item.problems.length) { items.push(item); continue; }
      const raw = envelope.items[item.index - 1]!, at = `request.items.${item.index - 1}`;
      const problems: ServiceProblem[] = await datasetLimitProblems(limits, scope, raw['dataset'], `${at}.dataset`);
      if (!problems.length) {
        const measured = measureRender(opened.workspace, { template: envelope.template, mode: envelope.mode, dataset: raw['dataset'], parameters: raw['parameters'], output: raw['output'] });
        if (measured.measure) {
          const { pixels, expansion } = measureLimitProblems(limits, plan, measured.measure, at);
          problems.push(...pixels, ...expansion);
        }
      }
      items.push(problems.length ? { ...item, problems: problems as unknown as Problem[] } : item);
    }
    const snapshot: BatchSnapshot = { ...frozen.snapshot, items };
    const sha256 = await scope.storage.contents.put(new Uint8Array(Buffer.from(JSON.stringify(snapshot))));
    const created = await scope.tasks.createBatch({
      snapshot: sha256, build: snapshot.build, template: envelope.template, mode: envelope.mode,
      items: items.map(({ index, id }) => ({ index, id })), ...(key === undefined ? {} : { idempotencyKey: key }), requestSha256,
    }, now());
    if ('shortfall' in created) throw exceeded(created.shortfall);
    // 同一个键的另一次提交先建成了批次：按重试处理。
    if (!created.created) return replay(created.batch, requestSha256);
    await audit(request, 'batch.create', created.batch.batchId);
    reply.code(202);
    return batchView(created.batch);
  });

  app.get('/v1/batches/:batchId', { config: { access: 'records.read' } }, async (request) => {
    const state = await scopeOf(request).tasks.batch(objectId((request.params as { batchId: string }).batchId));
    if (!state) throw notFound();
    return batchView(state);
  });

  app.post('/v1/batches/:batchId/cancel', { config: { access: 'deliver' } }, async (request) => {
    const state = await scopeOf(request).tasks.cancelBatch(objectId((request.params as { batchId: string }).batchId), now());
    if (!state) throw notFound();
    await audit(request, 'batch.cancel', state.batchId);
    return batchView(state);
  });
}
