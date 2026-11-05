/**
 * 数据定义与模板工作副本共用的部分（P1 票据 04、07）：两种寻址，与按原始字节存的文档。
 */
import type { FastifyRequest } from 'fastify';
import type { TenantScope } from '../backend.js';
import { parseJsonKeepingPrecision } from '../engine.js';
import type { Permission } from './permissions.js';
import { ApiError, fail, problem, ServiceProblemCodes } from './problems.js';

/** 一种寻址（M261、M345）：路径前缀、读取要的权限、目标租户。crossTenant 的身份是我们的内部人员，读取也记审计。 */
export interface AuthoringAddressing {
  readonly prefix: string;
  readonly read: Permission;
  scopeOf(request: FastifyRequest): TenantScope;
  readonly crossTenant: boolean;
}

export const documentBytes = (document: unknown) => new Uint8Array(Buffer.from(`${JSON.stringify(document, null, 2)}\n`));

/** 文档已在保存时核对过是 JSON；数值精度也在那时拒绝（M112）。 */
export const parsedDocument = (bytes: Uint8Array): unknown => parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), []);

const invalid = (source: string, message: string) => fail(400, ServiceProblemCodes.requestInvalid, source, message);

/**
 * 保存的请求体：UTF-8 的 JSON 对象，名称与路径一致；否则答 400。返回请求体的原始字节。
 * 不看文档的其余内容：还没写完的也能存，问题由校验回答。
 */
export function checkedDocument(body: unknown, name: string, what: string): Uint8Array {
  if (!Buffer.isBuffer(body)) throw fail(415, ServiceProblemCodes.requestInvalid, 'request.body', `${what}要以 application/json 发送`);
  let document: unknown;
  const tooPrecise: string[] = [];
  try { document = parseJsonKeepingPrecision(new TextDecoder('utf-8', { fatal: true }).decode(body), tooPrecise); }
  catch { throw invalid('request.body', '请求体不是合法的 UTF-8 JSON'); }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) throw invalid('request.body', `${what}必须是 JSON 对象`);
  if (tooPrecise.length) throw invalid('request.body', `请求中的数值超过 15 位有效数字，按双精度读取会失真：${tooPrecise.join('、')}（M112）`);
  if ((document as { name?: unknown }).name !== name) throw invalid('request.body.name', `文档的 name 要与路径里的名称 ${name} 一致；名称是身份，不能在这里改`);
  return new Uint8Array(body);
}

/** 预期哈希不是当前内容：别人先保存了。回答带当前哈希，读回最新内容再改。 */
export const staleDraft = (current: string, source: string, what = '数据定义') =>
  new ApiError(409, [problem(ServiceProblemCodes.draftStale, source, `${what}已被别人保存，当前内容哈希是 ${current}；读回最新内容再改`)], { currentSha256: current });
