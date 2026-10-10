/**
 * 数据定义 DSL（renderweave-schema/1）解析与检查。
 *
 * 检查字段名称与类型、各类型可用的约束（M5、M7、M9），以及约束之间的冲突：
 * 最小长度大于最大长度、下界大于上界、枚举值违反其他约束等。列表的元素不能又是列表（M33）。
 * 引用是否存在、是否成环在编译时检查（compile.ts），因为它们取决于其他静态数据定义。
 */
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { isRecord } from '../util.js';
import { parseStaticSchemaRef } from '../workspace.js';
import {
  MAX_SIGNIFICANT_DIGITS,
  type DefinitionModel,
  type FieldModel,
  type ImageConstraints,
  type ListConstraints,
  type NumberConstraints,
  type TextConstraints,
  type ValueModel,
} from './model.js';
import { significantDigits } from './formats.js';

const DEFINITION_KEYS = ['dslVersion', 'name', 'version', 'displayName', 'description', 'fields'];
const FIELD_KEYS = ['name', 'displayName', 'description', 'type', 'constraints', 'items', 'ref'];
const ITEM_KEYS = ['type', 'constraints', 'ref'];
const TYPES = ['text', 'number', 'date', 'time', 'datetime', 'boolean', 'image', 'list', 'ref'] as const;
const CONSTRAINTS: Record<(typeof TYPES)[number], readonly string[]> = {
  text: ['minLength', 'maxLength', 'pattern', 'enum'],
  number: ['min', 'max', 'integer', 'enum'],
  date: [],
  time: [],
  datetime: [],
  boolean: [],
  image: ['allowedSources'],
  list: ['minItems', 'maxItems'],
  ref: [],
};
/** 字段名称：英文字母开头，字母、数字与下划线（M89）；不能含"."，因为变量路径用它分隔（M90 S2）。 */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface ParsedDefinition {
  readonly model?: DefinitionModel;
  /** 文档中写明的版本号；数据定义（未发布）可以不写。 */
  readonly version?: number;
  readonly problems: Problem[];
}

export function parseDefinition(document: unknown): ParsedDefinition {
  const reader = new DefinitionReader(isRecord(document) && typeof document['name'] === 'string' ? document['name'] : '（未命名）');
  const result = reader.read(document);
  return { ...result, problems: reader.problems };
}

class DefinitionReader {
  readonly problems: Problem[] = [];
  private failed = false;

  constructor(private readonly schemaName: string) {}

  read(document: unknown): { model?: DefinitionModel; version?: number } {
    if (!isRecord(document)) {
      this.fail('', '数据定义必须是 JSON 对象');
      return {};
    }
    this.checkKeys(document, DEFINITION_KEYS, '', '数据定义');
    if (document['dslVersion'] !== 'renderweave-schema/1') this.fail('', '数据定义的 dslVersion 必须是 renderweave-schema/1');
    const name = document['name'];
    if (typeof name !== 'string' || name.trim() === '') this.fail('', '数据定义必须有名称 name');
    let version: number | undefined;
    if (document['version'] !== undefined) {
      const ref = parseStaticSchemaRef({ name: 'x', version: document['version'] });
      if (ref) version = ref.version;
      else this.fail('', '版本号 version 必须是正整数');
    }
    const displayName = document['displayName'] ?? name;
    if (typeof displayName !== 'string' || displayName.trim() === '') this.fail('', '显示名称 displayName 必须是文本');

    const fieldsValue = document['fields'];
    const fields: FieldModel[] = [];
    if (!Array.isArray(fieldsValue)) {
      this.fail('', '数据定义的 fields 必须是字段列表');
    } else {
      const seen = new Set<string>();
      fieldsValue.forEach((value, index) => {
        const field = this.readField(value, index);
        if (!field) return;
        if (seen.has(field.name)) {
          this.fail(field.name, `字段名称 ${field.name} 重复`);
          return;
        }
        seen.add(field.name);
        fields.push(field);
      });
    }
    if (this.failed || typeof name !== 'string' || typeof displayName !== 'string') return { ...(version !== undefined && { version }) };
    return { model: { name, displayName, fields }, ...(version !== undefined && { version }) };
  }

  private readField(value: unknown, index: number): FieldModel | undefined {
    const fallbackPath = `fields[${index + 1}]`;
    if (!isRecord(value)) {
      this.fail(fallbackPath, '字段必须是 JSON 对象');
      return undefined;
    }
    const name = value['name'];
    if (typeof name !== 'string' || !FIELD_NAME.test(name)) {
      this.fail(fallbackPath, `字段名称必须以英文字母开头，只含字母、数字与下划线：${JSON.stringify(name)}`);
      return undefined;
    }
    this.checkKeys(value, FIELD_KEYS, name, '字段');
    const displayName = value['displayName'];
    if (typeof displayName !== 'string' || displayName.trim() === '') {
      this.fail(name, '字段必须有显示名称 displayName');
    }
    if (value['description'] !== undefined && typeof value['description'] !== 'string') this.fail(name, '说明 description 必须是文本');

    const constraints = value['constraints'] ?? {};
    let required = false;
    if (isRecord(constraints) && 'required' in constraints) {
      if (typeof constraints['required'] !== 'boolean') this.fail(`${name}.constraints`, 'required 必须是 true 或 false');
      else required = constraints['required'];
    }
    const valueModel = this.readValue(value, name, true);
    if (!valueModel || typeof displayName !== 'string') return undefined;
    return { name, displayName, required, value: valueModel };
  }

  /** 读字段或列表元素的类型与约束。字段可写 required，列表元素不能。 */
  private readValue(value: Record<string, unknown>, path: string, isField: boolean): ValueModel | undefined {
    const type = value['type'];
    if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
      this.fail(path, `字段类型必须是 ${TYPES.join('、')} 之一`);
      return undefined;
    }
    const fieldType = type as (typeof TYPES)[number];
    const constraintsPath = `${path}.constraints`;
    const constraintsValue = value['constraints'] ?? {};
    if (!isRecord(constraintsValue)) {
      this.fail(constraintsPath, 'constraints 必须是对象');
      return undefined;
    }
    const allowed = isField ? ['required', ...CONSTRAINTS[fieldType]] : CONSTRAINTS[fieldType];
    for (const key of Object.keys(constraintsValue)) {
      if (!allowed.includes(key)) {
        const why = key === 'required' && !isField ? '列表元素不能单独设必填' : `${type} 类型不能用约束 ${key}`;
        this.report(ProblemCodes.definitionConstraintConflict, constraintsPath, why);
      }
    }
    if (fieldType !== 'list' && value['items'] !== undefined) this.fail(path, '只有列表类型才能写 items');
    if (fieldType !== 'ref' && value['ref'] !== undefined) this.fail(path, '只有引用类型才能写 ref');

    switch (fieldType) {
      case 'text':
        return this.readText(constraintsValue, constraintsPath);
      case 'number':
        return this.readNumber(constraintsValue, constraintsPath);
      case 'image':
        return this.readImage(constraintsValue, constraintsPath);
      case 'date':
      case 'time':
      case 'datetime':
      case 'boolean':
        return { type: fieldType };
      case 'ref': {
        const ref = parseStaticSchemaRef(value['ref']);
        if (!ref) {
          this.fail(path, '引用类型必须用 ref 写明被引用的静态数据定义名称与版本号，如 { "name": "停靠站点", "version": 1 }');
          return undefined;
        }
        return { type: 'ref', ref };
      }
      case 'list': {
        const itemsPath = `${path}.items`;
        const items = value['items'];
        if (!isRecord(items)) {
          this.fail(path, '列表必须用 items 写明元素的类型');
          return undefined;
        }
        if (items['type'] === 'list') {
          this.report(ProblemCodes.definitionNestedList, itemsPath, '列表的元素不能又是列表（M33）');
          return undefined;
        }
        this.checkKeys(items, ITEM_KEYS, itemsPath, '列表元素');
        const itemModel = this.readValue(items, itemsPath, false);
        const constraints = this.readList(constraintsValue, constraintsPath);
        if (!itemModel || !constraints || itemModel.type === 'list') return undefined;
        return { type: 'list', items: itemModel, constraints };
      }
    }
  }

  private readText(c: Record<string, unknown>, path: string): ValueModel | undefined {
    const constraints: { -readonly [K in keyof TextConstraints]: TextConstraints[K] } = {};
    const minLength = this.count(c['minLength'], path, 'minLength');
    const maxLength = this.count(c['maxLength'], path, 'maxLength');
    if (minLength !== undefined) constraints.minLength = minLength;
    if (maxLength !== undefined) constraints.maxLength = maxLength;
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      this.conflict(path, `最小长度 ${minLength} 大于最大长度 ${maxLength}`);
    }
    let regex: RegExp | undefined;
    if (c['pattern'] !== undefined) {
      if (typeof c['pattern'] !== 'string') {
        this.fail(path, 'pattern 必须是正则表达式文本');
      } else {
        try {
          // 与 ajv 一致：按 ECMAScript 正则、Unicode 模式解释。
          regex = new RegExp(c['pattern'], 'u');
          constraints.pattern = c['pattern'];
        } catch (error) {
          this.fail(path, `pattern 不是合法的正则表达式：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (c['enum'] !== undefined) {
      const values = c['enum'];
      if (!Array.isArray(values) || values.length === 0 || !values.every((v): v is string => typeof v === 'string')) {
        this.fail(path, 'enum 必须是非空的文本列表');
      } else {
        if (new Set(values).size !== values.length) this.conflict(path, 'enum 中有重复的取值');
        for (const v of values) {
          const length = Array.from(v).length;
          if ((minLength !== undefined && length < minLength) || (maxLength !== undefined && length > maxLength)) {
            this.conflict(path, `枚举值"${v}"的长度 ${length} 不满足长度约束`);
          }
          if (regex && !regex.test(v)) this.conflict(path, `枚举值"${v}"不满足 pattern`);
        }
        constraints.enum = values;
      }
    }
    return { type: 'text', constraints };
  }

  private readNumber(c: Record<string, unknown>, path: string): ValueModel | undefined {
    const constraints: { -readonly [K in keyof NumberConstraints]: NumberConstraints[K] } = {};
    const bound = (key: 'min' | 'max') => {
      const v = c[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        this.fail(path, `${key} 必须是数值`);
        return undefined;
      }
      if (significantDigits(String(v)) > MAX_SIGNIFICANT_DIGITS) {
        this.fail(path, `${key} 超过 ${MAX_SIGNIFICANT_DIGITS} 位有效数字（M112）`);
        return undefined;
      }
      return v;
    };
    const min = bound('min');
    const max = bound('max');
    if (min !== undefined) constraints.min = min;
    if (max !== undefined) constraints.max = max;
    if (min !== undefined && max !== undefined && min > max) this.conflict(path, `下界 ${min} 大于上界 ${max}`);
    if (c['integer'] !== undefined) {
      if (typeof c['integer'] !== 'boolean') this.fail(path, 'integer 必须是 true 或 false');
      else if (c['integer']) constraints.integer = true;
    }
    if (constraints.integer && min !== undefined && max !== undefined && Math.ceil(min) > Math.floor(max)) {
      this.conflict(path, `${min} 到 ${max} 之间没有整数`);
    }
    if (c['enum'] !== undefined) {
      const values = c['enum'];
      if (!Array.isArray(values) || values.length === 0 || !values.every((v): v is number => typeof v === 'number' && Number.isFinite(v))) {
        this.fail(path, 'enum 必须是非空的数值列表');
      } else {
        if (new Set(values).size !== values.length) this.conflict(path, 'enum 中有重复的取值');
        for (const v of values) {
          if ((min !== undefined && v < min) || (max !== undefined && v > max)) this.conflict(path, `枚举值 ${v} 不在 ${min ?? '-∞'} 到 ${max ?? '+∞'} 之间`);
          if (constraints.integer && !Number.isInteger(v)) this.conflict(path, `枚举值 ${v} 不是整数`);
        }
        constraints.enum = values;
      }
    }
    return { type: 'number', constraints };
  }

  private readImage(c: Record<string, unknown>, path: string): ValueModel | undefined {
    const sources = c['allowedSources'] ?? ['resource', 'url'];
    if (
      !Array.isArray(sources) ||
      sources.length === 0 ||
      !sources.every((s): s is 'resource' | 'url' => s === 'resource' || s === 'url') ||
      new Set(sources).size !== sources.length
    ) {
      this.fail(path, 'allowedSources 必须是 resource、url 中不重复的若干项');
      return undefined;
    }
    const constraints: ImageConstraints = { allowedSources: sources };
    return { type: 'image', constraints };
  }

  private readList(c: Record<string, unknown>, path: string): ListConstraints | undefined {
    const constraints: { -readonly [K in keyof ListConstraints]: ListConstraints[K] } = {};
    const minItems = this.count(c['minItems'], path, 'minItems');
    const maxItems = this.count(c['maxItems'], path, 'maxItems');
    if (minItems !== undefined) constraints.minItems = minItems;
    if (maxItems !== undefined) constraints.maxItems = maxItems;
    if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) {
      this.conflict(path, `最少项数 ${minItems} 大于最多项数 ${maxItems}`);
    }
    return constraints;
  }

  /** 长度、项数：非负整数。 */
  private count(value: unknown, path: string, label: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    this.fail(path, `${label} 必须是非负整数`);
    return undefined;
  }

  private checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) this.report(ProblemCodes.definitionUnknownProperty, path, `${what}中有未定义的属性 ${key}`);
    }
  }

  private conflict(path: string, message: string): void {
    this.report(ProblemCodes.definitionConstraintConflict, path, `约束冲突：${message}`);
  }

  private fail(path: string, message: string): void {
    this.report(ProblemCodes.definitionInvalid, path, message);
  }

  private report(code: ProblemCode, path: string, message: string): void {
    this.problems.push(severe(code, { kind: 'definition', schema: this.schemaName, path }, message));
    this.failed = true;
  }
}
