/**
 * 按 OpenAPI 描述核对每一个回答（票据 11）：createWorld 发出的每个请求都过一遍，两种后端的全部 API 用例因此都在核对描述与实际是否一致。
 * - 状态码必须在这个端点的描述里；媒体类型必须是描述里的；JSON 回答按描述的 Schema 校验；
 * - 核对时把描述里的对象当作封闭的（没写的属性就是多出来的），这样漏写的回答字段也会被发现；
 *   发布的描述不封闭，客户端应忽略不认识的属性（1.x 只做加法）；
 * - 错误回答一律是问题清单，其中每个严重问题的问题码与 HTTP 状态按 PROBLEM_STATUS 对应。
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { ENGINE_PROBLEM_STATUS, PROBLEM_STATUS } from '../src/api/openapi.js';

type Json = Record<string, unknown>;
const COMPONENT = '#/components/schemas/';
const key = (name: string) => `urn:openapi:components:${name}`;

/** 把组件引用改成登记的键；封闭时给写了 properties 却没写 additionalProperties 的对象补上 false。 */
function prepare(schema: unknown, ids: ReadonlyMap<string, string>, closed: boolean): unknown {
  if (Array.isArray(schema)) return schema.map((item) => prepare(item, ids, closed));
  if (typeof schema !== 'object' || schema === null) return schema;
  const out: Json = {};
  for (const [name, value] of Object.entries(schema)) {
    out[name] = name === '$ref' && typeof value === 'string' && value.startsWith(COMPONENT) ? ids.get(value.slice(COMPONENT.length)) ?? value
      : name === 'properties' && typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prepare(v, ids, closed)]))
      : prepare(value, ids, closed);
  }
  if (closed && out['properties'] && out['additionalProperties'] === undefined) out['additionalProperties'] = false;
  return out;
}

export interface ResponseSample {
  readonly method: string;
  /** 匹配到的路由模板，如 /v1/batches/:batchId；没匹配到路由时没有。 */
  readonly route?: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export function openApiChecker(doc: Json) {
  const ajv = new Ajv2020({ strict: false, allErrors: false });
  ajv.addFormat('uuid', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)));
  const schemas = (doc['components'] as { schemas: Record<string, Json> }).schemas;
  // DSL 的 Schema 自带 $id，按它登记；其余组件按名字登记。
  const ids = new Map(Object.entries(schemas).map(([name, schema]) => [name, typeof schema['$id'] === 'string' ? schema['$id'] : key(name)]));
  for (const [name, schema] of Object.entries(schemas)) {
    ajv.addSchema(typeof schema['$id'] === 'string' ? schema : { ...(prepare(schema, ids, true) as Json), $id: key(name) });
  }
  const validators = new Map<unknown, ValidateFunction>();
  const validatorOf = (schema: unknown) => {
    let validate = validators.get(schema);
    if (!validate) validators.set(schema, validate = ajv.compile(prepare(schema, ids, true) as Json));
    return validate;
  };
  type Response = { $ref?: string; content?: Record<string, { schema: unknown }> };
  const paths = doc['paths'] as Record<string, Record<string, { responses: Record<string, Response> }>>;
  const shared = (doc['components'] as { responses?: Record<string, Response> }).responses ?? {};
  const responseOf = (response: Response | undefined) => (response?.$ref ? shared[response.$ref.slice('#/components/responses/'.length)] : response);

  /** 核对一个回答；返回不符之处，都符合时为空。 */
  return function check(sample: ResponseSample): string[] {
    const where = `${sample.method} ${sample.route ?? '（未知路由）'} → ${sample.status}`;
    const problems: string[] = [];
    const media = sample.contentType.split(';')[0]!.trim().toLowerCase();
    let parsed: unknown;
    if (media === 'application/json' && sample.body) {
      try { parsed = JSON.parse(sample.body); } catch { return [`${where}：回答声明是 JSON，但不能解析`]; }
    }
    if (sample.status >= 400) problems.push(...problemStatus(where, sample.status, parsed));
    if (!sample.route) {
      if (sample.status !== 404) problems.push(`${where}：没匹配到路由的回答只能是 404`);
      return problems;
    }
    const operation = paths[sample.route.replace(/:([A-Za-z0-9]+)/g, '{$1}')]?.[sample.method.toLowerCase()];
    if (!operation) return [...problems, `${where}：描述里没有这个端点`];
    const response = responseOf(operation.responses[String(sample.status)]);
    if (!response) return [...problems, `${where}：描述里没有这个状态`];
    if (!response.content) {
      if (sample.body) problems.push(`${where}：描述是空回答，实际有正文`);
      return problems;
    }
    const content = response.content[media];
    if (!content) return [...problems, `${where}：媒体类型 ${media} 不在描述里（${Object.keys(response.content).join('、')}）`];
    if (media === 'application/json' && (content.schema as Json)['contentMediaType'] === undefined) {
      const validate = validatorOf(content.schema);
      if (!validate(parsed)) problems.push(`${where}：回答与描述不符：${ajv.errorsText(validate.errors, { separator: '；' })}`);
    }
    return problems;
  };
}

/** 错误回答：至少一个严重问题；每个严重问题的问题码与状态对应。 */
function problemStatus(where: string, status: number, body: unknown): string[] {
  const problems = (body as { problems?: { level?: string; code?: string }[] } | undefined)?.problems;
  if (!Array.isArray(problems) || !problems.some((problem) => problem.level === 'severe')) return [`${where}：错误回答要带至少一个严重问题的问题清单`];
  const wrong: string[] = [];
  for (const problem of problems) {
    if (problem.level !== 'severe' || typeof problem.code !== 'string') continue;
    const allowed = (PROBLEM_STATUS as Record<string, readonly number[]>)[problem.code] ?? ENGINE_PROBLEM_STATUS[problem.code] ?? [400];
    if (!allowed.includes(status)) wrong.push(`${where}：问题码 ${problem.code} 应随 ${allowed.join(' 或 ')} 返回`);
  }
  return wrong;
}
