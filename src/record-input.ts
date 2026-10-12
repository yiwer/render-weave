/** 正式交付的输入快照；06 只接受单项、单根模板、文字与图形。 */
import { parseRenderRequest, type RenderRequest } from './request.js';
import type { RenderOptions } from './render.js';
import { parseTemplate } from './template/parse.js';
import { DEFAULT_FALLBACK_FONTS } from './text/fonts.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseResourceRef } from './resources.js';
import { isRecord } from './util.js';
import type { Workspace } from './workspace.js';
import { ProblemCodes, type ProblemCode } from './problems.js';

export interface BatchRenderRequest {
  readonly template: string;
  readonly mode: RenderRequest['mode'];
  readonly items: readonly (Omit<RenderRequest, 'template' | 'mode'> & { readonly id: string })[];
}
export type RecordDocuments = Omit<Workspace, 'resources'>;
export interface RecordInput {
  readonly batch: BatchRenderRequest;
  readonly documents: RecordDocuments;
  readonly options: Required<RenderOptions>;
}
export class RecordError extends Error {
  constructor(readonly code: ProblemCode, message: string) { super(message); }
}
export function recordFail(message: string, code: ProblemCode = ProblemCodes.recordInvalid): never { throw new RecordError(code, message); }
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) recordFail('请求或选项含有未定义属性', ProblemCodes.requestInvalid);
}

export function parseBatchRequest(value: unknown): BatchRenderRequest {
  if (!isRecord(value)) recordFail('批量请求必须是对象', ProblemCodes.requestInvalid);
  keys(value, ['template', 'mode', 'items']);
  if (value.mode !== 'final' || !Array.isArray(value.items) || value.items.length !== 1) recordFail('当前正式交付只接受 final 模式且恰好一个渲染项', ProblemCodes.deliveryUnsupported);
  const item: unknown = value.items[0];
  if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) recordFail('渲染项必须有非空唯一标识 id', ProblemCodes.requestInvalid);
  keys(item, ['id', 'dataset', 'parameters', 'output']);
  const parsed = parseRenderRequest({ template: value.template, mode: value.mode, dataset: item.dataset, parameters: item.parameters, output: item.output });
  if (!parsed.request) recordFail(parsed.problems.map((p) => p.message).join('；'), ProblemCodes.requestInvalid);
  const { template, mode, ...input } = parsed.request;
  return structuredClone({ template, mode, items: [{ id: item.id, ...input }] });
}

export function recordOptions(value: unknown): Required<RenderOptions> {
  if (value === undefined) value = {};
  if (!isRecord(value)) recordFail('渲染选项必须是对象', ProblemCodes.requestInvalid);
  keys(value, ['fallbackFonts', 'svgFonts']);
  const fontIds = (key: string): string[] => {
    const ids = value[key] ?? DEFAULT_FALLBACK_FONTS;
    if (value[key] === null || !Array.isArray(ids) || ids.some((id: unknown) => typeof id !== 'string' || !parseResourceRef(`res:${id}`))) recordFail(`${key} 必须是资源 ID 数组`, ProblemCodes.requestInvalid);
    return [...ids];
  };
  return { fallbackFonts: fontIds('fallbackFonts'), svgFonts: fontIds('svgFonts') };
}

export function singleRequest(batch: BatchRenderRequest): RenderRequest {
  const { id: _id, ...item } = batch.items[0]!;
  return { ...item, template: batch.template, mode: batch.mode };
}

/** 同步复制文档和请求后才允许任何异步读取，调用者随后修改对象不会改变归档。 */
export function prepareRecordInput(documents: RecordDocuments, batchInput: unknown, options?: unknown): { input: RecordInput; fontIds: string[] } {
  const batch = parseBatchRequest(batchInput), configured = recordOptions(options);
  if (!Array.isArray(documents.templates) || !Array.isArray(documents.datasets) || !Array.isArray(documents.staticSchemas) || !Array.isArray(documents.problems)) recordFail('记录文档结构不完整');
  if (documents.problems.some((p) => p.level === 'severe')) recordFail('工作区有严重读取问题，不能交付');
  const entries = documents.templates.filter((t) => t.name === batch.template);
  if (entries.length !== 1) recordFail('根模板不存在或重复');
  const template = structuredClone(entries[0]!);
  const unsupported = () => recordFail('本票仅支持单根模板的文字与图形；调用、循环、图片、码图和引用定义留待后续票据', ProblemCodes.deliveryUnsupported);
  const fontIds = new Set([...configured.fallbackFonts, ...configured.svgFonts]);
  function scan(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (!isRecord(value)) return;
    if (['image', 'call', 'loop', 'qrcode', 'barcode', 'ref'].includes(String(value.type)) || value['x-renderweave-type'] === 'image' || '$ref' in value) unsupported();
    if (typeof value.font === 'string') { const id = parseResourceRef(value.font); if (id) fontIds.add(id); }
    Object.values(value).forEach(scan);
  }
  scan(template.document);
  const parsed = parseTemplate(template.name, template.document);
  if (!parsed.model || parsed.problems.some((p) => p.level === 'severe')) recordFail(`根模板无法通过静态读取：${parsed.problems.map((p) => p.message).join('；')}`);
  if (parsed.model.calls.length) unsupported();
  const request = singleRequest(batch);
  const dataset = 'inline' in request.dataset ? request.dataset.inline : (() => {
    const id = request.dataset.id, matches = documents.datasets.filter((d) => d.id === id);
    if (matches.length !== 1) recordFail('数据集不存在或重复');
    return matches[0]!.document;
  })();
  const schema = findStaticSchema(documents, parsed.model.base);
  if (!schema?.compiled) recordFail('缺少静态定义编译产物');
  // 内置定义由确切构建提供，无 DSL 原文；保存其实际编译产物。
  const builtin = schema.ref.name === '空数据定义' || schema.ref.name.startsWith('单值·');
  if (!builtin && !schema.definition) recordFail('正式记录必须包含静态定义原文');
  scan(schema.definition); scan(schema.compiled);
  return { input: structuredClone({ batch, options: configured, documents: {
    templates: [template], datasets: 'id' in request.dataset ? [{ id: request.dataset.id, document: dataset }] : [],
    staticSchemas: [schema], problems: documents.problems,
  } }), fontIds: [...fontIds].sort() };
}
