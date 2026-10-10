/**
 * 数据集校验：按所选静态数据定义的编译产物 JSON Schema 2020-12 用 ajv 校验（ADR-0006）。
 * ajv 的错误转换为问题清单，位置是字段路径，列表序号从 1 开始，如 `stops[12].name`。
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from './problems.js';
import { isRecord } from './util.js';

const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$/;
const DATETIME = /^(\d{4})-(\d{2})-(\d{2}) ([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: true });
  ajv.addVocabulary(['x-renderweave-type', 'x-renderweave-static-schema']);
  // 时刻：HH:mm 或 HH:mm:ss；时间：yyyy-MM-dd HH:mm:ss，不带时区（M90）。
  ajv.addFormat('rw-time', TIME);
  ajv.addFormat('rw-datetime', {
    type: 'string',
    validate: (value: string) => {
      const match = DATETIME.exec(value);
      if (!match) return false;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const date = new Date(Date.UTC(year, month - 1, day));
      return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
    },
  });
  return ajv;
}

const ajv = createAjv();
const compiledValidators = new WeakMap<object, ValidateFunction>();

/** 编译产物本身无法使用时抛出，由渲染入口转为问题。 */
export class CompiledSchemaError extends Error {}

export function validateDataset(compiled: Record<string, unknown>, data: unknown): Problem[] {
  let validate = compiledValidators.get(compiled);
  if (!validate) {
    try {
      validate = ajv.compile(compiled);
    } catch (error) {
      throw new CompiledSchemaError(error instanceof Error ? error.message : String(error));
    }
    compiledValidators.set(compiled, validate);
  }
  if (validate(data)) return [];
  // 编译产物为时刻、时间同时写了 format 与等价的 pattern，同一字段的同类问题只报一次。
  const seen = new Set<string>();
  return (validate.errors ?? [])
    .flatMap((error) => toProblem(error, data))
    .filter((problem) => {
      const key = `${problem.code} ${JSON.stringify(problem.location)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function toProblem(error: ErrorObject, data: unknown): Problem[] {
  const base = fieldPath(error.instancePath, data);
  const title = (schema: unknown) => (isRecord(schema) && typeof schema['title'] === 'string' ? schema['title'] : undefined);
  const describe = (path: string, schema: unknown) => {
    const label = title(schema);
    return label ? `"${label}"（${path}）` : path || '数据';
  };
  const problem = (code: ProblemCode, path: string, message: string) => [
    severe(code, { kind: 'field', path }, message),
  ];

  switch (error.keyword) {
    case 'required': {
      const missing = String(error.params['missingProperty']);
      const path = joinField(base, missing);
      const properties = isRecord(error.parentSchema) ? error.parentSchema['properties'] : undefined;
      const schema = isRecord(properties) ? properties[missing] : undefined;
      return problem(ProblemCodes.datasetRequiredMissing, path, `必填字段${describe(path, schema)}缺失`);
    }
    case 'additionalProperties': {
      const extra = String(error.params['additionalProperty']);
      const path = joinField(base, extra);
      return problem(ProblemCodes.datasetUnknownKey, path, `数据集出现未定义的键 ${path}`);
    }
    case 'type':
      if (error.data === null) {
        return problem(ProblemCodes.datasetNullValue, base, `字段${describe(base, error.parentSchema)}的值不能为 null；可选字段没有值时直接省略`);
      }
      return problem(ProblemCodes.datasetTypeMismatch, base, `字段${describe(base, error.parentSchema)}的类型应为 ${String(error.params['type'])}`);
    case 'format':
    case 'pattern':
      return problem(ProblemCodes.datasetFormatInvalid, base, `字段${describe(base, error.parentSchema)}的格式不正确：${JSON.stringify(error.data)}`);
    case 'minLength':
    case 'maxLength':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'minItems':
    case 'maxItems':
    case 'enum':
    case 'multipleOf':
      return problem(ProblemCodes.datasetConstraintViolated, base, `字段${describe(base, error.parentSchema)}不满足约束：${constraintText(error)}`);
    default:
      return problem(ProblemCodes.datasetInvalid, base, `字段${describe(base, error.parentSchema)}不符合静态数据定义：${error.message ?? error.keyword}`);
  }
}

function constraintText(error: ErrorObject): string {
  const p = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'minLength':
      return `长度至少 ${String(p['limit'])}`;
    case 'maxLength':
      return `长度至多 ${String(p['limit'])}`;
    case 'minimum':
      return `不小于 ${String(p['limit'])}`;
    case 'maximum':
      return `不大于 ${String(p['limit'])}`;
    case 'exclusiveMinimum':
      return `大于 ${String(p['limit'])}`;
    case 'exclusiveMaximum':
      return `小于 ${String(p['limit'])}`;
    case 'minItems':
      return `至少 ${String(p['limit'])} 项`;
    case 'maxItems':
      return `至多 ${String(p['limit'])} 项`;
    case 'enum':
      return `只能取 ${JSON.stringify(p['allowedValues'])}`;
    default:
      return error.message ?? error.keyword;
  }
}

/** 把 JSON Pointer 转为字段路径：`/stops/11/name` → `stops[12].name`。 */
function fieldPath(pointer: string, data: unknown): string {
  if (pointer === '') return '';
  let path = '';
  let current: unknown = data;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      const index = Number(token);
      path += `[${index + 1}]`;
      current = current[index];
    } else {
      path = joinField(path, token);
      current = isRecord(current) ? current[token] : undefined;
    }
  }
  return path;
}

function joinField(base: string, name: string): string {
  return base === '' ? name : `${base}.${name}`;
}
