/**
 * 数据定义模型：数据定义 DSL（renderweave-schema/1）解析后的类型。
 * 字段类型与约束见 docs/model/business-entities.md"数据定义侧"（M5–M7、M9、M32、M33）。
 */
import type { StaticSchemaRef } from '../workspace.js';

export type BasicFieldType = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'boolean' | 'image';
export type FieldType = BasicFieldType | 'list' | 'ref';

export interface DefinitionModel {
  readonly name: string;
  readonly displayName: string;
  readonly fields: readonly FieldModel[];
}

export interface FieldModel {
  /** 字段名称：字段的身份，数据集的键与模板绑定都用它（M18、M89）。 */
  readonly name: string;
  readonly displayName: string;
  /** 必填：键存在且值不为 null（M7）。 */
  readonly required: boolean;
  readonly value: ValueModel;
}

/** 字段的取值：基本类型带约束；列表的元素不能又是列表（M33）；引用指向确切版本（M39）。 */
export type ValueModel =
  | { readonly type: 'text'; readonly constraints: TextConstraints }
  | { readonly type: 'number'; readonly constraints: NumberConstraints }
  | { readonly type: 'date' | 'time' | 'datetime' | 'boolean' }
  | { readonly type: 'image'; readonly constraints: ImageConstraints }
  | { readonly type: 'ref'; readonly ref: StaticSchemaRef }
  | { readonly type: 'list'; readonly items: Exclude<ValueModel, { type: 'list' }>; readonly constraints: ListConstraints };

export interface TextConstraints {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
}

export interface NumberConstraints {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
  readonly enum?: readonly number[];
}

export interface ImageConstraints {
  /** 允许的来源；不写时两种都允许（M9）。 */
  readonly allowedSources: readonly ('resource' | 'url')[];
}

export interface ListConstraints {
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** 数值最多 15 位有效数字：此时按双精度比较与按十进制比较结果完全一致（M112）。 */
export const MAX_SIGNIFICANT_DIGITS = 15;
