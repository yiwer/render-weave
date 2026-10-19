/**
 * 服务的问题：格式与引擎的问题一致（问题码、等级、位置、说明），错误响应一律是 { problems: [...] }。
 * HTTP 状态按类别映射：请求不合法 400、未鉴权 401、无权限 403、不存在 404、冲突 409（阶段 4 PRD「开放 API」）。
 */
export const ServiceProblemCodes = {
  requestInvalid: 'request.invalid',
  notFound: 'request.notFound',
  authRequired: 'auth.required',
  authInvalidCredentials: 'auth.invalidCredentials',
  authForbidden: 'auth.forbidden',
  memberEmailTaken: 'member.emailTaken',
  memberLastAdmin: 'member.lastAdmin',
  internalError: 'service.internalError',
} as const;
export type ServiceProblemCode = (typeof ServiceProblemCodes)[keyof typeof ServiceProblemCodes];

export interface ServiceProblem {
  readonly level: 'severe';
  readonly code: ServiceProblemCode;
  readonly location: { readonly kind: 'input'; readonly source: string };
  readonly message: string;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly problems: readonly ServiceProblem[]) { super(problems.map((p) => p.message).join('；')); }
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
