/**
 * 按 `schemas/` 中发布的 JSON Schema 校验 DSL 文档（M219）：给外部生成的文档（如业务 Agent 的候选）做前置校验，
 * 与集成方用的是同一份契约。结构不合格时，引擎的解析器也一定拒绝；这里先报，是为了让问题按契约的写法说出来。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { DslDocumentKind } from './dsl.js';

const FILES: Record<DslDocumentKind, string> = {
  definition: 'data-definition.schema.json', dataset: 'dataset.schema.json', template: 'template.schema.json',
  renderRequest: 'render-request.schema.json', batchRequest: 'batch-request.schema.json',
};
const MAX_MESSAGES = 5;
let validators: Map<DslDocumentKind, ValidateFunction> | undefined;

/** 返回 Schema 文件名与不合格之处（最多 5 条）；合格时 messages 为空。 */
export function checkAgainstDslSchema(kind: DslDocumentKind, document: unknown): { file: string; messages: string[] } {
  // 严格模式能发现 Schema 中拼错的关键字；strictRequired 与 strictTypes 是 ajv 自己的额外要求，标准写法下的条件分支会触发，故关闭。
  validators ??= new Map(Object.entries(FILES).map(([name, file]) => [name as DslDocumentKind,
    new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false })
      .compile(JSON.parse(readFileSync(fileURLToPath(new URL(`../schemas/${file}`, import.meta.url)), 'utf8')))]));
  const validate = validators.get(kind)!;
  if (validate(document)) return { file: `schemas/${FILES[kind]}`, messages: [] };
  // 组合关键字的报错只是"某个分支不符"，具体原因在其他条目里；只剩它们时才保留。
  const errors = validate.errors ?? [];
  const specific = errors.filter((error) => !['anyOf', 'oneOf', 'if'].includes(error.keyword));
  const messages = [...new Set((specific.length > 0 ? specific : errors).map(describe))];
  return { file: `schemas/${FILES[kind]}`, messages: messages.length > MAX_MESSAGES ? [...messages.slice(0, MAX_MESSAGES), `另有 ${messages.length - MAX_MESSAGES} 处`] : messages };
}

function describe(error: ErrorObject): string {
  const at = error.instancePath === '' ? '根' : error.instancePath.slice(1).replaceAll('/', '.');
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required': return `${at} 缺少 ${String(params['missingProperty'])}`;
    case 'additionalProperties': return `${at} 不能有 ${String(params['additionalProperty'])}`;
    case 'type': return `${at} 应为 ${String(params['type'])}`;
    case 'enum': return `${at} 只能取 ${(params['allowedValues'] as unknown[]).map((value) => JSON.stringify(value)).join('、')}`;
    case 'const': return `${at} 只能是 ${JSON.stringify(params['allowedValue'])}`;
    case 'minItems': return `${at} 至少要有 ${String(params['limit'])} 项`;
    case 'minLength': return `${at} 不能为空`;
    case 'minimum': return `${at} 不能小于 ${String(params['limit'])}`;
    case 'maximum': return `${at} 不能大于 ${String(params['limit'])}`;
    case 'exclusiveMinimum': return `${at} 必须大于 ${String(params['limit'])}`;
    case 'pattern': return `${at} 的写法不对`;
    default: return `${at} ${error.message ?? error.keyword}`;
  }
}
