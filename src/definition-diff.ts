/**
 * 数据定义差异（阶段 5 P1 票据 02）：两份数据定义之间按字段列出增、删、改，改动细到属性键。
 * 出图服务发布前的字段级差异与审计的差异摘要都用它。纯函数，不读存储。
 *
 * - 字段名称是身份（ADR-0005）：改名是删一个旧名、加一个新名，删掉的一条标为"会影响绑定"。
 * - 比较的是解析后的模型，与编译产物一致：`required: false` 与不写、图片省略 `allowedSources` 与写满两种来源都算没改。
 *   模型之外只带说明 `description`。值用规范化 JSON 比较，与模板差异 `diffTemplate` 同一个 `canonical`。
 * - `version` 由发布分配，每次都不同，不参与比较。被引用的数据定义自己的字段不在这里：那要读另一份数据定义，
 *   引用的版本变了时，把两个版本各交给 `diffDefinition` 再比一次。
 */
import type { PropertyChange } from './agent/diff.js';
import { checkDslDocument, dslDocumentKind } from './dsl.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import type { FieldModel, ValueModel } from './schema/model.js';
import { parseDefinition } from './schema/parse.js';
import { canonical, isRecord } from './util.js';

export interface FieldChange {
  /** 字段名称。 */
  readonly path: string;
  readonly change: 'added' | 'removed' | 'changed';
  /**
   * 改了的属性，只有 `changed` 有。键从字段往下写全：`displayName`、`description`、`required`、`type`，
   * 约束 `constraints.maxLength`；列表元素的写成 `items.type`、`items.constraints.enum`、`items.ref.version`，
   * 引用字段自己的写成 `ref.name`、`ref.version`。列表元素和引用的改动因此带着字段作父路径。
   */
  readonly properties?: readonly PropertyChange[];
  /** 删去的字段，数据定义里的原样内容。 */
  readonly before?: unknown;
  /** 新增的字段，数据定义里的原样内容。 */
  readonly after?: unknown;
  /** 删掉这个字段（改名等于删旧名、加新名）后，按它的名称写的模板绑定和数据集的键不再有对应。 */
  readonly affectsBindings?: true;
}

/** 两边都有的字段换了先后次序，各自的字段名称按各自次序排；增删的字段不算在内。 */
export interface FieldOrderChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface DefinitionDiff {
  /** 任一份读不了时的问题清单，消息带"改前""改后"；此时没有差异。问题码与 `checkDslDocument` 相同。 */
  readonly problems: readonly Problem[];
  /** 数据定义自身的改动：`name`、`displayName`、`description`。 */
  readonly definition: readonly PropertyChange[];
  /** 新增、修改的字段按改后的次序，删除的字段接在后面。 */
  readonly fields: readonly FieldChange[];
  /** 字段顺序变了才有，与增删分开。 */
  readonly order?: FieldOrderChange;
}

interface ReadField {
  readonly document: unknown;
  readonly attributes: Record<string, unknown>;
}

interface ReadDefinition {
  readonly attributes: Record<string, unknown>;
  readonly fields: ReadonlyMap<string, ReadField>;
}

export function diffDefinition(before: unknown, after: unknown): DefinitionDiff {
  const left = readSide(before, '改前'), right = readSide(after, '改后');
  const problems = [...left.problems, ...right.problems];
  if (!left.read || !right.read) return { problems, definition: [], fields: [] };

  const fields: FieldChange[] = [];
  for (const [name, now] of right.read.fields) {
    const was = left.read.fields.get(name);
    if (!was) {
      fields.push({ path: name, change: 'added', after: now.document });
      continue;
    }
    const properties = propertyChanges(was.attributes, now.attributes);
    if (properties.length > 0) fields.push({ path: name, change: 'changed', properties });
  }
  for (const [name, was] of left.read.fields) {
    if (!right.read.fields.has(name)) fields.push({ path: name, change: 'removed', before: was.document, affectsBindings: true });
  }

  const common = (own: ReadDefinition, other: ReadDefinition) => [...own.fields.keys()].filter((name) => other.fields.has(name));
  const was = common(left.read, right.read), now = common(right.read, left.read);
  return {
    problems,
    definition: propertyChanges(left.read.attributes, right.read.attributes),
    fields,
    ...(canonical(was) !== canonical(now) ? { order: { before: was, after: now } } : {}),
  };
}

/** 读一份：不是数据定义或有问题时只回答问题。 */
function readSide(document: unknown, side: '改前' | '改后'): { read?: ReadDefinition; problems: Problem[] } {
  const kind = dslDocumentKind(document);
  if (kind === undefined) return { problems: [...checkDslDocument(document, side).problems] };
  if (kind !== 'definition') {
    return { problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: side }, `${side}的文档不是数据定义，识别为 ${kind}`)] };
  }
  const parsed = parseDefinition(document);
  if (!parsed.model || !isRecord(document)) {
    return { problems: parsed.problems.map((problem) => ({ ...problem, message: `${side}的数据定义：${problem.message}` })) };
  }
  const { model } = parsed;
  // 解析成功时字段全部有效，模型的字段与文档里的字段逐个对应。
  const documents = document['fields'] as readonly Record<string, unknown>[];
  return {
    problems: [],
    read: {
      attributes: {
        name: model.name,
        displayName: model.displayName,
        ...(document['description'] !== undefined && { description: document['description'] }),
      },
      fields: new Map(model.fields.map((field, index) => [field.name, { document: documents[index], attributes: fieldAttributes(field, documents[index]!['description']) }])),
    },
  };
}

function fieldAttributes(field: FieldModel, description: unknown): Record<string, unknown> {
  return {
    displayName: field.displayName,
    ...(description !== undefined && { description }),
    required: field.required,
    ...valueAttributes(field.value, ''),
  };
}

/** 类型、约束与引用摊成点分隔的键；列表元素的键以 `items.` 开头。 */
function valueAttributes(value: ValueModel, prefix: string): Record<string, unknown> {
  const attributes: Record<string, unknown> = { [`${prefix}type`]: value.type };
  if ('constraints' in value) {
    for (const [key, constraint] of Object.entries(value.constraints)) attributes[`${prefix}constraints.${key}`] = constraint;
  }
  if (value.type === 'ref') {
    attributes[`${prefix}ref.name`] = value.ref.name;
    attributes[`${prefix}ref.version`] = value.ref.version;
  }
  if (value.type === 'list') Object.assign(attributes, valueAttributes(value.items, `${prefix}items.`));
  return attributes;
}

function propertyChanges(before: Record<string, unknown>, after: Record<string, unknown>): PropertyChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => canonical(before[key]) !== canonical(after[key]))
    .map((key) => ({ key, ...(before[key] !== undefined ? { before: before[key] } : {}), ...(after[key] !== undefined ? { after: after[key] } : {}) }));
}
