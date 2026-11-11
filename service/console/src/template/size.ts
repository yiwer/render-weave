/**
 * 宽高一格（模板设计页第三轮票据 01，方案「检查器」）：数值加尺寸方式，打数就是固定，同 Figma 的宽高框。
 * 两处用它：元素的 `place.width` / `place.height`（DSL 的 size：随内容、撑满、固定、按比例撑满），
 * 循环的每项尺寸（loopItemSize：等分、随内容、固定）。这里只答"现在是什么、打一个数或选一种方式写什么"，不碰页面。
 */
import { isObject } from './document.js';
import type { PropertyField } from './properties.js';

export type SizeKind = 'fixed' | 'hug' | 'fill' | 'ratio' | 'equal' | 'content';

export interface SizeOption { readonly kind: SizeKind; readonly label: string }

export interface SizeModel {
  /** 下拉里的方式，固定在最前。 */
  readonly options: readonly SizeOption[];
  /** 现在的方式；没写是 undefined。 */
  readonly kind?: SizeKind;
  /** 固定的字面值。 */
  readonly fixed?: number;
  /** 固定值绑定的变量。 */
  readonly bound?: string;
  /** 按比例撑满的权重。 */
  readonly ratio?: number;
  /** 固定值能不能是 0：元素尺寸能（非负），循环每项不能（正数）。 */
  readonly positive: boolean;
}

export const SIZE_LABELS: Readonly<Record<SizeKind, string>> = { fixed: '固定', hug: '随内容', fill: '撑满', ratio: '按比例撑满', equal: '等分', content: '随内容' };

const KIND_OF_CONST: Readonly<Record<string, SizeKind>> = { hug: 'hug', fill: 'fill', equal: 'equal', content: 'content' };

/** 一个尺寸值是哪种方式；不是尺寸的写法时 undefined。 */
export function sizeKindOf(value: unknown): SizeKind | undefined {
  if (typeof value === 'string') return KIND_OF_CONST[value];
  if (!isObject(value)) return undefined;
  if ('fixed' in value) return 'fixed';
  if ('fill' in value) return 'ratio';
  return undefined;
}

function modelOf(value: unknown, kinds: readonly SizeKind[], positive: boolean): SizeModel {
  const kind = sizeKindOf(value);
  const inner = isObject(value) ? (kind === 'fixed' ? value['fixed'] : kind === 'ratio' ? value['fill'] : undefined) : undefined;
  return {
    options: kinds.map((item) => ({ kind: item, label: SIZE_LABELS[item] })), positive,
    ...(kind && kinds.includes(kind) ? { kind } : {}),
    ...(kind === 'fixed' && typeof inner === 'number' ? { fixed: inner } : {}),
    ...(kind === 'fixed' && isObject(inner) && typeof inner['var'] === 'string' ? { bound: inner['var'] } : {}),
    ...(kind === 'ratio' && typeof inner === 'number' ? { ratio: inner } : {}),
  };
}

/**
 * 元素的宽高字段能不能画成一格：生成规则给的是变体，里面有"固定"（`{ fixed }`）和随内容、撑满这类常量。
 * Schema 加了写法而这里不认识时答 undefined，页面照旧画变体下拉，不丢东西。
 */
export function sizeModel(field: PropertyField): SizeModel | undefined {
  const editor = field.editor;
  if (editor.kind !== 'variants') return undefined;
  const kinds = editor.variants.map((variant) => sizeKindOf(variant.initial));
  if (kinds.some((kind) => kind === undefined) || !kinds.includes('fixed') || !kinds.some((kind) => kind === 'hug' || kind === 'fill')) return undefined;
  const ordered = (['fixed', 'hug', 'fill', 'ratio'] as const).filter((kind) => kinds.includes(kind));
  return modelOf(field.value, ordered, false);
}

/** 循环的每项尺寸（loopItemSize）：等分、随内容、固定；固定要是正数。 */
export function itemSizeModel(value: unknown): SizeModel {
  return modelOf(value, ['fixed', 'equal', 'content'], true);
}

/** 打了一个数：按比例撑满时改权重，别的都写成固定；清空是去掉这一项（回到缺省）。不合法时答原因，不写回。 */
export function typedSize(model: SizeModel, text: string): { readonly value: unknown } | { readonly problem: string } {
  if (text.trim() === '') return { value: undefined };
  const number = Number(text);
  if (!Number.isFinite(number)) return { problem: '要填数字' };
  if (model.kind === 'ratio') return number > 0 ? { value: { fill: number } } : { problem: '比例要大于 0' };
  if (model.positive ? number <= 0 : number < 0) return { problem: model.positive ? '要大于 0' : '不能小于 0' };
  return { value: { fixed: number } };
}

const round = (value: number) => Math.round(value * 10) / 10;

/**
 * 选了一种方式写什么。换成固定时取现在的固定值，没有就取这一处的实际尺寸（布局摘要），再没有给 10；
 * 换成按比例时保留原来的权重，没有给 1；空串是去掉这一项。
 */
export function chosenSize(model: SizeModel, kind: SizeKind | '', actual?: number): unknown {
  switch (kind) {
    case '': return undefined;
    case 'fixed': {
      if (model.kind === 'fixed') return model.bound ? { fixed: { var: model.bound } } : { fixed: model.fixed };
      const size = actual !== undefined && actual > 0 ? round(actual) : 10;
      return { fixed: model.positive ? Math.max(size, 0.1) : size };
    }
    case 'ratio': return { fill: model.ratio ?? 1 };
    default: return kind;
  }
}
