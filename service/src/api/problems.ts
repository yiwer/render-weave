/**
 * 服务的问题：格式与引擎的问题一致（问题码、等级、位置、说明），错误响应一律是 { problems: [...] }。
 * HTTP 状态按类别映射：请求不合法 400、未鉴权 401、无权限 403、不存在 404、冲突 409（阶段 4 PRD「开放 API」）。
 */
import type { Problem } from '../engine.js';

export const ServiceProblemCodes = {
  requestInvalid: 'request.invalid',
  notFound: 'request.notFound',
  authRequired: 'auth.required',
  authInvalidCredentials: 'auth.invalidCredentials',
  authForbidden: 'auth.forbidden',
  memberEmailTaken: 'member.emailTaken',
  memberLastAdmin: 'member.lastAdmin',
  /** 代建推送（M264）：与服务端已有内容冲突，整体拒绝。 */
  pushConflict: 'push.conflict',
  /** 代建推送：要写入的内容还没有上传。 */
  pushContentMissing: 'push.contentMissing',
  /** 代建推送：上传的内容与哈希、字节数、种类或键的声明不符。 */
  pushContentMismatch: 'push.contentMismatch',
  /** 入队前的限制（ADR-0017，票据 06）：超限直接拒绝（413），不占 worker。 */
  limitRequestTooLarge: 'limit.requestTooLarge',
  limitDatasetTooLarge: 'limit.datasetTooLarge',
  limitPixelsExceeded: 'limit.pixelsExceeded',
  limitExpansionExceeded: 'limit.expansionExceeded',
  /** 按租户的预览并发与频率（429）。 */
  previewRateLimited: 'preview.rateLimited',
  /** 等不到 worker 完成渲染（503）。 */
  workerUnavailable: 'worker.unavailable',
  /** 批量交付（票据 07）：同一个幂等键配了不同的请求（409）。 */
  batchIdempotencyConflict: 'batch.idempotencyConflict',
  /** 数据集与资源（票据 10）：与引擎相同的问题码。新建的 ID 已有（409）。 */
  inputDuplicate: 'input.duplicate',
  /** 替换检查报告与路径里的资源不符、替换内容不在服务端（400）。 */
  resourceReplacementInvalid: 'resource.replacementInvalid',
  /** 检查之后资源已有新版本，或工作区已变化（409，M152）。 */
  resourceReplacementStale: 'resource.replacementStale',
  internalError: 'service.internalError',
} as const;
export type ServiceProblemCode = (typeof ServiceProblemCodes)[keyof typeof ServiceProblemCodes];

export interface ServiceProblem {
  readonly level: 'severe';
  readonly code: ServiceProblemCode;
  readonly location: { readonly kind: 'input'; readonly source: string };
  readonly message: string;
}

/** 错误响应：{ problems }，服务的问题或引擎的问题，可以另带说明情况的字段（如推送冲突时的差异）。 */
export class ApiError extends Error {
  constructor(readonly status: number, readonly problems: readonly (ServiceProblem | Problem)[], readonly extra: Readonly<Record<string, unknown>> = {}) {
    super(problems.map((p) => p.message).join('；'));
  }
}

export const problem = (code: ServiceProblemCode, source: string, message: string): ServiceProblem =>
  ({ level: 'severe', code, location: { kind: 'input', source }, message });

export const fail = (status: number, code: ServiceProblemCode, source: string, message: string) => new ApiError(status, [problem(code, source, message)]);

/** 不存在与无权看到同样回答：不泄露对象是否存在。 */
export const notFound = () => fail(404, ServiceProblemCodes.notFound, 'request.path', '请求的对象不存在');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 路径里的对象 ID 不是 UUID 时也答"不存在"，与不存在的对象一样。 */
export function objectId(value: string): string {
  if (!UUID.test(value)) throw notFound();
  return value;
}

/** 把 JSON Schema 的校验错误译成问题。 */
export function validationProblems(errors: readonly { instancePath: string; keyword: string; params: Record<string, unknown>; message?: string }[], part: string): ServiceProblem[] {
  return errors.map((error) => {
    const path = error.instancePath.split('/').filter(Boolean).join('.');
    const source = ['request', part, path].filter(Boolean).join('.');
    const message = error.keyword === 'required' ? `缺少必填项 ${String(error.params['missingProperty'])}`
      : error.keyword === 'additionalProperties' ? `不能有未定义的属性 ${String(error.params['additionalProperty'])}`
      : error.keyword === 'type' ? `${path || part} 的类型应为 ${String(error.params['type'])}`
      : `${path || part} 的取值不合规（${error.keyword}）`;
    return problem(ServiceProblemCodes.requestInvalid, source, message);
  });
}
