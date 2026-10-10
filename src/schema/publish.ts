/**
 * 发布静态数据定义（规格中的次接缝）：数据定义可修改，发布后形成不可变的静态数据定义，
 * 以名称加自动递增的版本号标识（M18、M38），并编译出 JSON Schema 作为数据集校验的权威（ADR-0006、M103）。
 */
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, sameStaticSchema, type StaticSchemaEntry, type StaticSchemaRef } from '../workspace.js';
import { compileDefinition, type DefinitionResolver } from './compile.js';
import type { DefinitionModel } from './model.js';
import { parseDefinition } from './parse.js';

export interface PublishedStaticSchema extends StaticSchemaEntry {
  /** 带上版本号的静态数据定义 DSL。 */
  readonly definition: Record<string, unknown>;
  readonly compiled: Record<string, unknown>;
}

/**
 * 把数据定义发布为下一个版本：版本号取同名静态数据定义的最大版本加 1。
 * 文档中写了版本号时必须与之相同。被引用的静态数据定义必须已经存在（指向确切版本）。
 */
export function publishStaticSchema(
  definition: unknown,
  existing: readonly StaticSchemaEntry[],
): { published?: PublishedStaticSchema; problems: Problem[] } {
  const parsed = parseDefinition(definition);
  if (!parsed.model || !isRecord(definition)) return { problems: parsed.problems };
  const model = parsed.model;
  const next = Math.max(0, ...existing.filter((entry) => entry.ref.name === model.name).map((entry) => entry.ref.version)) + 1;
  if (parsed.version !== undefined && parsed.version !== next) {
    return {
      problems: [
        severe(
          ProblemCodes.definitionInvalid,
          { kind: 'definition', schema: model.name, path: '' },
          `版本号由发布自动分配：下一个版本是 v${next}，文档中写的是 v${parsed.version}；已发布的静态数据定义不可修改（M18）`,
        ),
      ],
    };
  }
  const ref: StaticSchemaRef = { name: model.name, version: next };
  const { compiled, problems } = compileDefinition(model, next, resolverFor(existing));
  if (!compiled) return { problems };
  const { dslVersion, name, version: _version, ...rest } = definition;
  return {
    published: { ref, definition: { dslVersion, name, version: next, ...rest }, compiled },
    problems: [],
  };
}

/** 编译一份已发布的静态数据定义，用于生成或核对工作区中的编译产物。 */
export function compileStaticSchema(
  entry: StaticSchemaEntry,
  all: readonly StaticSchemaEntry[],
): { compiled?: Record<string, unknown>; problems: Problem[] } {
  const parsed = parseDefinition(entry.definition);
  if (!parsed.model) return { problems: parsed.problems };
  if (parsed.version !== entry.ref.version || parsed.model.name !== entry.ref.name) {
    return {
      problems: [
        severe(
          ProblemCodes.definitionInvalid,
          { kind: 'definition', schema: formatStaticSchemaRef(entry.ref), path: '' },
          '静态数据定义必须写明名称与版本号',
        ),
      ],
    };
  }
  return compileDefinition(parsed.model, entry.ref.version, resolverFor(all));
}

function resolverFor(entries: readonly StaticSchemaEntry[]): DefinitionResolver {
  const cache = new Map<string, DefinitionModel | undefined>();
  return (ref) => {
    const key = formatStaticSchemaRef(ref);
    if (!cache.has(key)) {
      const entry = entries.find((candidate) => sameStaticSchema(candidate.ref, ref));
      cache.set(key, entry?.definition === undefined ? undefined : parseDefinition(entry.definition).model);
    }
    return cache.get(key);
  };
}
