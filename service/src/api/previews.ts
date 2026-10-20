/**
 * 模板与草稿预览的端点（票据 06，ADR-0017）。
 * - 模板列表与只读查看：名称、当前修订、所用的数据定义、适用尺寸范围与对外参数；
 * - 草稿预览：接口进程先在本进程里做入队前的检查（不出图），过了才入队，等 worker 渲染完同步返回。
 *   无法展开的请求不入队，直接答与单次渲染相同的问题清单；预览不计额度，按租户限制并发（套餐的并发数）与频率。
 */
import type { FastifyInstance } from 'fastify';
import type { Plan, TaskResult, TenantScope } from '../backend.js';
import { describeTemplate, measureRender, parseJsonKeepingPrecision, type Problem, type RenderMeasure } from '../engine.js';
import { loadTenantWorkspace } from '../preview.js';
import { identityOf, ownTenant, type ApiContext } from './app.js';
import { ApiError, fail, notFound, problem, ServiceProblemCodes, type ServiceProblem } from './problems.js';

/** 入队前的限制与预览的频率。数值是暂定的，容量基线（票据 15）实测后再定；并发数与单张最大像素另由套餐定（票据 09）。 */
export interface ServiceLimits {
  /** 请求体的字节数，内联的数据集算在里面。 */
  readonly maxRequestBytes: number;
  /** 批量交付请求体的字节数（票据 07）：一批最多 1,000 项，比单张的请求大。 */
  readonly maxBatchRequestBytes: number;
  /** 引用的已保存数据集的字节数。 */
  readonly maxDatasetBytes: number;
  /** 单张图的像素总数的服务上限（引擎上限）；实际取它与套餐值中小的那个。 */
  readonly maxPixels: number;
  /** 展开后会显示的元素数。 */
  readonly maxElements: number;
  /** 展开后的循环项数，嵌套循环逐层累计。 */
  readonly maxLoopItems: number;
  /** 同一租户一分钟内入队的预览数。 */
  readonly previewPerMinute: number;
  /** 接口进程等 worker 渲染完的时间；过了答 503，还在排队的撤回。 */
  readonly previewWaitMs: number;
}

export const DEFAULT_LIMITS: ServiceLimits = {
  maxRequestBytes: 1024 * 1024,
  maxBatchRequestBytes: 8 * 1024 * 1024,
  maxDatasetBytes: 1024 * 1024,
  maxPixels: 100_000_000,
  maxElements: 20_000,
  maxLoopItems: 2_000,
  previewPerMinute: 60,
  previewWaitMs: 60_000,
};

/** 预览的回答：引擎的结果，图片以 base64 放进 JSON。 */
export interface PreviewReply {
  readonly image?: { readonly format: 'png' | 'jpeg'; readonly widthPx: number; readonly heightPx: number; readonly dpi: number; readonly base64: string };
  readonly problems: TaskResult['problems'];
  readonly layout?: TaskResult['layout'];
}

/** 引用的已保存数据集超出字节上限时的问题；source 是请求里数据集的位置。 */
export async function datasetLimitProblems(limits: ServiceLimits, scope: TenantScope, dataset: unknown, source: string): Promise<ServiceProblem[]> {
  const datasetId = (dataset as { id?: unknown } | undefined)?.id;
  if (typeof datasetId !== 'string') return [];
  const stored = (await scope.storage.authoringState()).documents.find((document) => document.kind === 'dataset' && document.key === datasetId);
  return stored && stored.byteLength > limits.maxDatasetBytes
    ? [problem(ServiceProblemCodes.limitDatasetTooLarge, source, `数据集 ${datasetId} 有 ${stored.byteLength} 字节，超出上限 ${limits.maxDatasetBytes} 字节`)] : [];
}

/** 单张最大像素：套餐值，且不超过服务上限（ADR-0017、M242）。 */
export const maxPixelsOf = (limits: ServiceLimits, plan: Plan) => Math.min(limits.maxPixels, plan.maxPixels);

/** 量出的像素与展开规模超出上限时的问题（ADR-0017）；at 是这张图的请求在请求体里的位置。 */
export function measureLimitProblems(limits: ServiceLimits, plan: Plan, measure: RenderMeasure, at: string): { pixels: ServiceProblem[]; expansion: ServiceProblem[] } {
  const { widthPx, heightPx, elements, loopItems } = measure, maxPixels = maxPixelsOf(limits, plan);
  return {
    pixels: widthPx * heightPx > maxPixels
      ? [problem(ServiceProblemCodes.limitPixelsExceeded, `${at}.output`, `出图像素为 ${widthPx} × ${heightPx} = ${widthPx * heightPx}，超出单张上限 ${maxPixels}`)] : [],
    expansion: [
      ...(loopItems > limits.maxLoopItems ? [problem(ServiceProblemCodes.limitExpansionExceeded, at, `展开后的循环项数为 ${loopItems}，超出上限 ${limits.maxLoopItems}`)] : []),
      ...(elements > limits.maxElements ? [problem(ServiceProblemCodes.limitExpansionExceeded, at, `展开后的元素数为 ${elements}，超出上限 ${limits.maxElements}`)] : []),
    ],
  };
}

/** 一次草稿预览：检查、入队、等结果。客户与代建工程师的端点都走这里。 */
export async function runPreview(context: ApiContext, scope: TenantScope, body: unknown): Promise<PreviewReply> {
  const { limits, now } = context;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fail(400, ServiceProblemCodes.requestInvalid, 'request.body', '预览请求必须是 JSON 对象');
  const input = body as Record<string, unknown>;
  if (input['mode'] !== undefined && input['mode'] !== 'draft') {
    throw fail(400, ServiceProblemCodes.requestInvalid, 'request.mode', '预览只出草稿；正式图走批量交付，每张都有出图记录');
  }
  const request = { ...input, mode: 'draft' };

  const dataset = await datasetLimitProblems(limits, scope, input['dataset'], 'request.dataset');
  if (dataset.length) throw new ApiError(413, dataset);

  const measured = measureRender(await loadTenantWorkspace(scope.storage), request);
  if (!measured.measure) return { problems: measured.problems };
  const plan = await scope.plan();
  const { pixels, expansion } = measureLimitProblems(limits, plan, measured.measure, 'request');
  if (pixels.length) throw new ApiError(413, pixels);
  if (expansion.length) throw new ApiError(413, expansion);

  const queued = await scope.tasks.enqueuePreview(request, { concurrency: plan.concurrency, perMinute: limits.previewPerMinute, staleAfterMs: limits.previewWaitMs }, now());
  if ('limited' in queued) {
    throw fail(429, ServiceProblemCodes.previewRateLimited, 'request', queued.limited === 'concurrency'
      ? `本租户同时进行的预览已达并发上限 ${plan.concurrency} 个，请等前面的完成`
      : `本租户一分钟内的预览已达每分钟上限 ${limits.previewPerMinute} 次，请稍后再试`);
  }
  const deadline = Date.now() + limits.previewWaitMs;
  for (;;) {
    const state = await scope.tasks.state(queued.id);
    if (state?.status === 'done') {
      await scope.tasks.release(queued.id);
      return reply(state.result);
    }
    if (Date.now() > deadline) {
      await scope.tasks.release(queued.id);
      throw fail(503, ServiceProblemCodes.workerUnavailable, 'request', `等了 ${limits.previewWaitMs} ms 还没有 worker 渲染完，请稍后再试`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function reply(result: TaskResult): PreviewReply {
  const { image } = result;
  return {
    ...(image ? { image: { format: image.format, widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi, base64: Buffer.from(image.bytes).toString('base64') } } : {}),
    problems: result.problems,
    ...(result.layout ? { layout: result.layout } : {}),
  };
}

/** 模板的对外信息：读不了的模板只有问题清单。 */
async function templates(scope: TenantScope): Promise<Record<string, unknown>[]> {
  const state = await scope.storage.authoringState();
  const entries = [];
  for (const template of [...state.templates].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const current = template.revisions.find((revision) => revision.revision === template.currentRevision)!;
    const bytes = await scope.storage.contents.get(current.sha256);
    let described: { template?: object; problems: Problem[] };
    try { described = describeTemplate(parseJsonKeepingPrecision(Buffer.from(bytes ?? []).toString('utf8'), [])); }
    catch { described = { problems: [] }; }
    entries.push({ name: template.name, currentRevision: template.currentRevision, ...(described.template ?? {}), ...(described.template ? {} : { problems: described.problems }) });
  }
  return entries;
}

export function registerPreviewRoutes(app: FastifyInstance, context: ApiContext): void {
  const { backend, limits } = context;
  const scopeOf = (request: Parameters<typeof identityOf>[0]) => backend.tenant(ownTenant(identityOf(request)));

  app.get('/v1/templates', { config: { access: 'tenant.read' } }, async (request) => ({ templates: await templates(scopeOf(request)) }));

  app.get('/v1/templates/:name', { config: { access: 'tenant.read' } }, async (request) => {
    const name = (request.params as { name: string }).name;
    const found = (await templates(scopeOf(request))).find((template) => template.name === name);
    if (!found) throw notFound();
    return found;
  });

  app.post('/v1/previews', { config: { access: 'preview' }, bodyLimit: limits.maxRequestBytes }, async (request) => runPreview(context, scopeOf(request), request.body));
}
