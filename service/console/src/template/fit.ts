/**
 * 适配收成一行（模板设计页第三轮票据 04，方案「检查器」、原型 01）：规则一句、这一处的结果一句。
 * 规则来自元素的 `fit`（没写就是不适配），结果来自布局摘要里这一处的文字；点开之后的编辑器照旧（design/fit-editor.tsx）。
 */
import { isObject } from './document.js';
import { stepsLabel } from './properties.js';

/** 这一处排出来的结果：布局摘要里文字的一部分。 */
export interface FitOutcome { readonly compression: number; readonly fontSize: number; readonly overflow: boolean }

export interface FitDigest {
  /** 写了什么：适配顺序，竖排有缩字组时带上组名。 */
  readonly rule: string;
  /** 这一处的结果；图上没有这一处（隐藏、还没出图）时没有。 */
  readonly result?: string;
  /** 这一处仍放不下。 */
  readonly over: boolean;
}

const round = (value: number) => Math.round(value * 100) / 100;

export function fitDigest(fit: unknown, outcome?: FitOutcome): FitDigest {
  const written = isObject(fit) ? fit : {};
  const steps = Array.isArray(written['steps']) ? written['steps'] as unknown[] : [];
  const group = isObject(written['widthOverflow']) ? written['widthOverflow']['shrinkGroup'] : undefined;
  const rule = [stepsLabel(steps), ...(typeof group === 'string' && group !== '' ? [`缩字组 ${group}`] : [])].join(' · ');
  if (!outcome) return { rule, over: false };
  const compressed = outcome.compression < 0.999 ? `压到 ${Math.round(outcome.compression * 100)}%` : '没有压缩';
  return { rule, result: `这一处：${compressed}，字号 ${round(outcome.fontSize)} mm${outcome.overflow ? '，仍放不下' : ''}`, over: outcome.overflow };
}

/** 一行摘要：规则 · 这一处的结果。 */
export const fitLine = (digest: FitDigest): string => [digest.rule, ...(digest.result ? [digest.result] : [])].join(' · ');
