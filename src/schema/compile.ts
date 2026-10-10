/**
 * 把静态数据定义编译为 JSON Schema 2020-12（ADR-0006）：
 * 内联展开引用的静态数据定义，不允许未定义的键（M90 S7），title 取显示名称；
 * 日期、时刻、时间、图片写成自定义格式或正则，并以 x-renderweave-type 标明原类型。
 * 引用不存在或成环时返回问题（M32、M39）。
 */
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { formatStaticSchemaRef, type StaticSchemaRef } from '../workspace.js';
import {
  DATE_PATTERN,
  DATETIME_PATTERN,
  RESOURCE_OR_URL_PATTERN,
  RESOURCE_REF_PATTERN,
  TIME_PATTERN,
  URL_PATTERN,
} from './formats.js';
import type { DefinitionModel, FieldModel, ValueModel } from './model.js';

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** 按确切版本找到已发布的静态数据定义。 */
export type DefinitionResolver = (ref: StaticSchemaRef) => DefinitionModel | undefined;

type JsonObject = Record<string, unknown>;

export function compileDefinition(
  model: DefinitionModel,
  version: number,
  resolve: DefinitionResolver,
): { compiled?: JsonObject; problems: Problem[] } {
  const compiler = new Compiler(resolve, { name: model.name, version });
  const body = compiler.object(model, { name: model.name, version }, [], '');
  if (compiler.problems.length > 0 || !body) return { problems: compiler.problems };
  return {
    compiled: { $schema: JSON_SCHEMA_DIALECT, title: formatStaticSchemaRef({ name: model.name, version }), ...body },
    problems: [],
  };
}

class Compiler {
  readonly problems: Problem[] = [];

  constructor(
    private readonly resolve: DefinitionResolver,
    private readonly root: StaticSchemaRef,
  ) {}

  /** 一个静态数据定义编译成的对象；chain 是正在展开的引用链，用于发现成环；prefix 是它在根定义中的位置。 */
  object(model: DefinitionModel, ref: StaticSchemaRef, chain: readonly string[], prefix: string): JsonObject | undefined {
    const key = formatStaticSchemaRef(ref);
    const nextChain = [...chain, key];
    const properties: JsonObject = {};
    for (const field of model.fields) {
      const compiled = this.field(field, nextChain, prefix === '' ? field.name : `${prefix}.${field.name}`);
      if (compiled) properties[field.name] = compiled;
    }
    const required = model.fields.filter((field) => field.required).map((field) => field.name);
    return {
      'x-renderweave-static-schema': { name: ref.name, version: ref.version },
      type: 'object',
      additionalProperties: false,
      ...(required.length > 0 && { required }),
      properties,
    };
  }

  private field(field: FieldModel, chain: readonly string[], path: string): JsonObject | undefined {
    const value = this.value(field.value, chain, path);
    return value && { title: field.displayName, ...value };
  }

  private value(value: ValueModel, chain: readonly string[], path: string): JsonObject | undefined {
    switch (value.type) {
      case 'text': {
        const c = value.constraints;
        return {
          type: 'string',
          ...(c.minLength !== undefined && { minLength: c.minLength }),
          ...(c.maxLength !== undefined && { maxLength: c.maxLength }),
          ...(c.pattern !== undefined && { pattern: c.pattern }),
          ...(c.enum !== undefined && { enum: [...c.enum] }),
        };
      }
      case 'number': {
        const c = value.constraints;
        return {
          type: c.integer ? 'integer' : 'number',
          ...(c.min !== undefined && { minimum: c.min }),
          ...(c.max !== undefined && { maximum: c.max }),
          ...(c.enum !== undefined && { enum: [...c.enum] }),
        };
      }
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
        return { type: 'string', format: 'date', pattern: DATE_PATTERN, 'x-renderweave-type': 'date' };
      case 'time':
        return { type: 'string', format: 'rw-time', pattern: TIME_PATTERN, 'x-renderweave-type': 'time' };
      case 'datetime':
        return { type: 'string', format: 'rw-datetime', pattern: DATETIME_PATTERN, 'x-renderweave-type': 'datetime' };
      case 'image': {
        const sources = value.constraints.allowedSources;
        const pattern =
          sources.includes('resource') && sources.includes('url') ? RESOURCE_OR_URL_PATTERN : sources.includes('url') ? URL_PATTERN : RESOURCE_REF_PATTERN;
        return { type: 'string', pattern, 'x-renderweave-type': 'image' };
      }
      case 'list': {
        const items = this.value(value.items, chain, `${path}.items`);
        const c = value.constraints;
        return (
          items && {
            type: 'array',
            ...(c.minItems !== undefined && { minItems: c.minItems }),
            ...(c.maxItems !== undefined && { maxItems: c.maxItems }),
            items,
          }
        );
      }
      case 'ref': {
        const key = formatStaticSchemaRef(value.ref);
        const location = { kind: 'definition', schema: formatStaticSchemaRef(this.root), path } as const;
        if (chain.includes(key)) {
          this.problems.push(severe(ProblemCodes.definitionRefCycle, location, `数据定义之间的引用成环：${[...chain, key].join(' → ')}（M32）`));
          return undefined;
        }
        const target = this.resolve(value.ref);
        if (!target) {
          this.problems.push(severe(ProblemCodes.definitionRefNotFound, location, `引用的静态数据定义"${key}"不存在`));
          return undefined;
        }
        return this.object(target, value.ref, chain, path);
      }
    }
  }
}
