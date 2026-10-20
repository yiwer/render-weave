/**
 * 数据集校验：按所选静态数据定义的编译产物 JSON Schema 2020-12 用 ajv 校验（ADR-0006），
 * 再做图片类型自带的检查（资源引用存在且是图片资源，M9）与数值有效数字检查（M112）。
 * 问题的位置是字段路径，列表序号从 1 开始，如 `stops[12].name`（M107）。
 */
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from './problems.js';
import { parseResourceRef, type ResourceRepository } from './resources.js';
import { findStaticSchema } from './schema/builtins.js';
import { TIME_PATTERN, isValidDate, isValidDatetime, significantDigits } from './schema/formats.js';
import { MAX_SIGNIFICANT_DIGITS } from './schema/model.js';
import { describeError, isRecord } from './util.js';
import { formatStaticSchemaRef, parseDatasetDocument, parseJsonKeepingPrecision, type DatasetDocument, type Workspace } from './workspace.js';

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, verbose: true, strict: true });
  ajv.addVocabulary(['x-renderweave-type', 'x-renderweave-static-schema']);
  // 日期 2026-01-02、时刻 HH:mm（秒可选）、时间 2025-01-02 09:08:12，都不带时区（M6）。
  ajv.addFormat('date', { type: 'string', validate: isValidDate });
  ajv.addFormat('rw-time', new RegExp(TIME_PATTERN));
  ajv.addFormat('rw-datetime', { type: 'string', validate: isValidDatetime });
  return ajv;
}

const ajv = createAjv();
// 按编译产物内容缓存：ajv 按 schema 对象引用永久保留编译结果，而批量交付每项都重新解析记录输入、得到新对象；
// 按对象引用缓存会每项编译一次并逐项累积内存。按内容缓存后，同一内容在进程内只编译一次。
const compiledValidators = new Map<string, ValidateFunction>();

/** 编译产物本身无法使用时抛出，由渲染入口转为问题。 */
export class CompiledSchemaError extends Error {}

export function validateDataset(compiled: Record<string, unknown>, data: unknown, resources: ResourceRepository): Problem[] {
  return [...validateAgainstSchema(compiled, data), ...checkTypes(compiled, data, '', resources)];
}

/**
 * 按数据集选定的静态数据定义校验数据：找不到可用的编译产物、或编译产物无法使用时，问题在 dataset.staticSchema，且无法展开。
 * 渲染入口与 checkDataset 共用这一处，两边对同一数据集给出相同的问题。
 */
export function checkDatasetData(workspace: Pick<Workspace, 'staticSchemas' | 'resources'>, dataset: DatasetDocument): { problems: Problem[]; blocked: boolean } {
  const where = { kind: 'input', source: 'dataset.staticSchema' } as const;
  const entry = findStaticSchema(workspace, dataset.dataset.staticSchema);
  if (!entry?.compiled) {
    return { blocked: true, problems: [severe(entry ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound,
      where, `数据集选定的静态数据定义“${formatStaticSchemaRef(dataset.dataset.staticSchema)}”没有可用的编译产物`)] };
  }
  try { return { blocked: false, problems: validateDataset(entry.compiled, dataset.data, workspace.resources) }; }
  catch (error) {
    if (!(error instanceof CompiledSchemaError)) throw error;
    return { blocked: true, problems: [severe(ProblemCodes.inputUnreadable, where, `编译产物无法使用：${error.message}`)] };
  }
}

export interface DatasetCheck {
  /** 解析出的数据集；不是合法的 JSON、或不是数据集文档时省略。 */
  readonly dataset?: DatasetDocument;
  readonly problems: readonly Problem[];
}

/**
 * 校验一份数据集的原始字节（票据 10）：JSON 与数值精度（M112）、身份部分、所选静态数据定义的编译产物与资源引用。
 * 问题与工作区读取加渲染时对数据集的检查相同：整份文档的问题在 dataset，字段问题定位到字段路径（M107）。
 * 出图服务保存数据集与表单实时提示都用它。
 */
export function checkDataset(bytes: Uint8Array, workspace: Pick<Workspace, 'staticSchemas' | 'resources'>): DatasetCheck {
  const where = { kind: 'input', source: 'dataset' } as const;
  const tooPrecise: string[] = [];
  let document: unknown;
  try { document = parseJsonKeepingPrecision(Buffer.from(bytes).toString('utf8'), tooPrecise); }
  catch (error) { return { problems: [severe(ProblemCodes.inputUnreadable, where, `数据集不是合法的 JSON：${describeError(error)}`)] }; }
  const dataset = parseDatasetDocument(document);
  if (typeof dataset === 'string') return { problems: [severe(ProblemCodes.datasetInvalid, where, dataset)] };
  const problems = tooPrecise.map((literal) =>
    severe(ProblemCodes.datasetTooManyDigits, where, `数据集中的数值 ${literal} 超过 ${MAX_SIGNIFICANT_DIGITS} 位有效数字，按双精度读取会失真（M112）`));
  return { dataset, problems: [...problems, ...checkDatasetData(workspace, dataset).problems] };
}

function validateAgainstSchema(compiled: Record<string, unknown>, data: unknown): Problem[] {
  const key = JSON.stringify(compiled);
  let validate = compiledValidators.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(compiled);
    } catch (error) {
      throw new CompiledSchemaError(error instanceof Error ? error.message : String(error));
    }
    compiledValidators.set(key, validate);
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

/**
 * 编译产物表达不了的类型自带检查：图片资源引用必须存在且是图片资源（M9）；
 * 数值不超过 15 位有效数字，保证按双精度比较等同于按十进制比较（M112）。
 * 只检查已通过 JSON Schema 结构校验的位置，格式不对的取值已由前一步报告。
 */
function checkTypes(schema: unknown, value: unknown, path: string, resources: ResourceRepository): Problem[] {
  if (!isRecord(schema)) return [];
  const problems: Problem[] = [];
  const title = typeof schema['title'] === 'string' ? `"${schema['title']}"（${path}）` : path;
  if (schema['type'] === 'object' && isRecord(value) && isRecord(schema['properties'])) {
    for (const [key, propertySchema] of Object.entries(schema['properties'])) {
      if (key in value) problems.push(...checkTypes(propertySchema, value[key], joinField(path, key), resources));
    }
  } else if (schema['type'] === 'array' && Array.isArray(value)) {
    value.forEach((item, index) => problems.push(...checkTypes(schema['items'], item, `${path}[${index + 1}]`, resources)));
  } else if (schema['x-renderweave-type'] === 'image' && typeof value === 'string') {
    const id = parseResourceRef(value);
    const info = id === undefined ? undefined : resources.get(id);
    if (id !== undefined && !info) {
      problems.push(severe(ProblemCodes.datasetResourceNotFound, { kind: 'field', path }, `图片字段${title}引用的资源 ${value} 不存在`));
    } else if (info && info.kind !== 'image') {
      problems.push(severe(ProblemCodes.datasetResourceKindMismatch, { kind: 'field', path }, `图片字段${title}引用的 ${value} 是字体资源，不是图片`));
    }
  } else if ((schema['type'] === 'number' || schema['type'] === 'integer') && typeof value === 'number') {
    if (significantDigits(String(value)) > MAX_SIGNIFICANT_DIGITS) {
      problems.push(
        severe(ProblemCodes.datasetTooManyDigits, { kind: 'field', path }, `数值字段${title}的值 ${value} 超过 ${MAX_SIGNIFICANT_DIGITS} 位有效数字`),
      );
    }
  }
  return problems;
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
