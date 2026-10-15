/**
 * 渲染请求：一次出图调用，指定模板、数据集（引用工作区中的数据集或附带 JSON）、
 * 对外参数值、出图参数与模式（沿用 M402 草稿 render-request-m402.json 的形状）。
 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { mmToPx } from './units.js';
import { isRecord } from './util.js';
import { parseDatasetDocument, type DatasetDocument } from './workspace.js';

export type OutputFormat = 'png' | 'jpeg';
export type RenderMode = 'draft' | 'final';

export interface RenderRequest {
  readonly template: string;
  /** `{ id }` 引用工作区中的数据集；`{ inline }` 直接附带一份数据集文档。 */
  readonly dataset: { readonly id: string } | { readonly inline: DatasetDocument };
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly output: {
    /** 实际宽度，毫米。 */
    readonly width: number;
    /** 实际高度，毫米。 */
    readonly height: number;
    readonly dpi: number;
    readonly format: OutputFormat;
  };
  readonly mode: RenderMode;
}

/** 单边像素上限与总像素上限，防止误写的尺寸或 DPI 耗尽内存。 */
export const MAX_SIDE_PX = 20_000;
export const MAX_TOTAL_PX = 100_000_000;

const KNOWN_KEYS = new Set(['template', 'dataset', 'parameters', 'output', 'mode']);

export function parseRenderRequest(value: unknown): { request?: RenderRequest; problems: Problem[] } {
  const problems: Problem[] = [];
  const invalid = (source: string, message: string) =>
    problems.push(severe(ProblemCodes.requestInvalid, { kind: 'input', source }, message));

  if (!isRecord(value)) {
    invalid('request', '渲染请求必须是 JSON 对象');
    return { problems };
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_KEYS.has(key)) invalid(`request.${key}`, `渲染请求中有未定义的属性 ${key}`);
  }

  const template = value['template'];
  if (typeof template !== 'string' || template === '') invalid('request.template', '渲染请求必须指定模板名称');

  let dataset: RenderRequest['dataset'] | undefined;
  const datasetValue = value['dataset'];
  // 只能是 { id } 与 { inline } 之一，不静默忽略其他键（M224）。
  const datasetKeys = isRecord(datasetValue) ? Object.keys(datasetValue) : [];
  if (isRecord(datasetValue) && datasetKeys.length === 1 && typeof datasetValue['id'] === 'string' && datasetValue['id'] !== '') {
    dataset = { id: datasetValue['id'] };
  } else if (isRecord(datasetValue) && datasetKeys.length === 1 && 'inline' in datasetValue) {
    const parsed = parseDatasetDocument(datasetValue['inline']);
    if (typeof parsed === 'string') invalid('request.dataset.inline', parsed);
    else dataset = { inline: parsed };
  } else {
    invalid('request.dataset', '渲染请求的数据集写成 { "id": 数据集 ID } 或 { "inline": 数据集文档 } 之一');
  }

  const parameters = value['parameters'] === undefined ? {} : value['parameters'];
  if (!isRecord(parameters)) invalid('request.parameters', '对外参数必须是 JSON 对象');

  const output = value['output'];
  let parsedOutput: RenderRequest['output'] | undefined;
  if (!isRecord(output)) {
    invalid('request.output', '渲染请求必须给出出图参数 output');
  } else {
    const { width, height, dpi, format } = output;
    const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
    if (!positive(width)) invalid('request.output.width', '出图宽度必须是大于 0 的毫米数');
    if (!positive(height)) invalid('request.output.height', '出图高度必须是大于 0 的毫米数');
    if (!positive(dpi)) invalid('request.output.dpi', 'DPI 必须大于 0');
    const normalizedFormat = format === 'png' ? 'png' : format === 'jpeg' || format === 'jpg' ? 'jpeg' : undefined;
    if (!normalizedFormat) invalid('request.output.format', '图片格式只能是 png 或 jpg');
    for (const key of Object.keys(output)) {
      if (!['width', 'height', 'dpi', 'format'].includes(key)) invalid(`request.output.${key}`, `出图参数中有未定义的属性 ${key}`);
    }
    if (positive(width) && positive(height) && positive(dpi) && normalizedFormat) {
      parsedOutput = { width, height, dpi, format: normalizedFormat };
      const widthPx = mmToPx(width, dpi);
      const heightPx = mmToPx(height, dpi);
      if (widthPx < 1 || heightPx < 1 || widthPx > MAX_SIDE_PX || heightPx > MAX_SIDE_PX || widthPx * heightPx > MAX_TOTAL_PX) {
        problems.push(
          severe(
            ProblemCodes.requestOutputTooLarge,
            { kind: 'input', source: 'request.output' },
            `出图像素为 ${widthPx} × ${heightPx}，超出允许范围（单边 1–${MAX_SIDE_PX} 像素，总数不超过 ${MAX_TOTAL_PX}）`,
          ),
        );
      }
    }
  }

  const mode = value['mode'];
  if (mode !== 'draft' && mode !== 'final') invalid('request.mode', '模式只能是 draft（草稿预览）或 final（正式出图）');

  if (problems.length > 0 || typeof template !== 'string' || !dataset || !parsedOutput || !isRecord(parameters)) {
    return { problems };
  }
  return {
    request: { template, dataset, parameters, output: parsedOutput, mode: mode as RenderMode },
    problems,
  };
}
