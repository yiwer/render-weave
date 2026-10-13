/** 正式交付的输入快照；固定可达模板、静态定义及有类型的资源引用。 */
import { parseRenderRequest, type RenderRequest } from './request.js';
import type { Problem } from './problems.js';
import type { RenderOptions } from './render.js';
import { parseTemplate } from './template/parse.js';
import { DEFAULT_FALLBACK_FONTS } from './text/fonts.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseResourceRef, type ResourceKind } from './resources.js';
import { parseDefinition } from './schema/parse.js';
import type { ValueModel } from './schema/model.js';
import type { TemplateModel } from './template/model.js';
import { isRecord } from './util.js';
import { parseStaticSchemaRef, type Workspace, type StaticSchemaRef, type StaticSchemaEntry, type TemplateEntry } from './workspace.js';
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

/** 一批最多的渲染项数；本地产品边界，不改变静态数据定义中的列表约束（M153）。 */
export const MAX_BATCH_ITEMS = 1_000;
type BatchItem = BatchRenderRequest['items'][number];
/** 已通过外层检查的批次：各项只确认是带唯一 id 的对象，内容留给逐项解析。 */
export interface BatchEnvelope {
  readonly template: string;
  readonly mode: 'final';
  readonly items: readonly (Readonly<Record<string, unknown>> & { readonly id: string })[];
}

/** 外层结构、模式、项数或标识不合法时整批拒绝；返回副本，调用者随后修改请求不影响本批。 */
export function parseBatchEnvelope(value: unknown): BatchEnvelope {
  if (!isRecord(value)) recordFail('批量请求必须是对象', ProblemCodes.requestInvalid);
  keys(value, ['template', 'mode', 'items']);
  if (typeof value.template !== 'string' || value.template === '') recordFail('批量请求必须指定根模板名称', ProblemCodes.requestInvalid);
  if (value.mode !== 'final') recordFail('当前正式交付只接受 final 模式', ProblemCodes.deliveryUnsupported);
  if (!Array.isArray(value.items) || value.items.length === 0) recordFail('渲染项列表必须是非空数组', ProblemCodes.requestInvalid);
  if (value.items.length > MAX_BATCH_ITEMS) recordFail(`渲染项共 ${value.items.length} 项，超过一批 ${MAX_BATCH_ITEMS} 项的上限，请拆成多个批次`, ProblemCodes.requestInvalid);
  const ids = new Set<string>();
  value.items.forEach((item: unknown, index: number) => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) recordFail(`第 ${index + 1} 个渲染项必须是带非空标识 id 的对象`, ProblemCodes.requestInvalid);
    keys(item, ['id', 'dataset', 'parameters', 'output']);
    if (ids.has(item.id)) recordFail(`渲染项标识重复：${item.id}`, ProblemCodes.requestInvalid);
    ids.add(item.id);
  });
  return structuredClone({ template: value.template, mode: 'final', items: value.items as BatchEnvelope['items'] });
}

/** 逐项解析数据集、参数与出图参数；错误只属于本项。 */
export function parseBatchItem(envelope: Pick<BatchEnvelope, 'template' | 'mode'>, item: BatchEnvelope['items'][number]): { item?: BatchItem; problems: Problem[] } {
  const parsed = parseRenderRequest({ template: envelope.template, mode: envelope.mode, dataset: item.dataset, parameters: item.parameters, output: item.output });
  if (!parsed.request) return { problems: parsed.problems };
  const { template: _template, mode: _mode, ...input } = parsed.request;
  return { item: structuredClone({ id: item.id, ...input }), problems: [] };
}

/** 出图记录保存的是恰好一项的批次。 */
export function parseBatchRequest(value: unknown): BatchRenderRequest {
  const envelope = parseBatchEnvelope(value);
  if (envelope.items.length !== 1) recordFail('出图记录必须恰好包含一个渲染项');
  const { item, problems } = parseBatchItem(envelope, envelope.items[0]!);
  if (!item) recordFail(problems.map((p) => p.message).join('；'), ProblemCodes.requestInvalid);
  return { template: envelope.template, mode: envelope.mode, items: [item] };
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
export function prepareRecordInput(documents: RecordDocuments, batchInput: unknown, options?: unknown): { input: RecordInput; resourceKinds: Map<string, ResourceKind> } {
  const batch = parseBatchRequest(batchInput), configured = recordOptions(options);
  const request = singleRequest(batch);
  const { templates, schemas, resourceKinds, dataset } = collect(documents, batch.template, configured, request);
  return { input: structuredClone({ batch, options: configured, documents: {
    templates: [...templates.values()], datasets: 'id' in request.dataset ? [{ id: request.dataset.id, document: dataset! }] : [],
    staticSchemas: [...schemas.values()], problems: documents.problems,
  } }), resourceKinds };
}

/** 批次级准备：根模板调用闭包、模板引用的定义与资源和渲染配置；失败即整批拒绝。返回模板与配置引用的资源种类。 */
export function checkBatchTemplate(documents: RecordDocuments, template: string, configured: Required<RenderOptions>): Map<string, ResourceKind> {
  return collect(documents, template, configured).resourceKinds;
}

/** 收集根模板可达的调用闭包、静态定义及资源种类；给出渲染项时再加入其数据集、根实参与数据中的资源。 */
function collect(documents: RecordDocuments, rootTemplate: string, configured: Required<RenderOptions>, request?: RenderRequest) {
  if (!Array.isArray(documents.templates) || !Array.isArray(documents.datasets) || !Array.isArray(documents.staticSchemas) || !Array.isArray(documents.problems)) recordFail('记录文档结构不完整');
  if (documents.problems.some((p) => p.level === 'severe')) recordFail('工作区有严重读取问题，不能交付');
  const dataset = request === undefined ? undefined : 'inline' in request.dataset ? request.dataset.inline : (() => {
    const id = request.dataset.id, matches = documents.datasets.filter((d) => d.id === id);
    if (matches.length !== 1) recordFail(`数据集不存在或重复：${id}`);
    return matches[0]!.document;
  })();
  const templates = new Map<string, TemplateEntry>(), models = new Map<string, TemplateModel>();
  const schemas = new Map<string, StaticSchemaEntry>(), visitingSchemas = new Set<string>(), visitingTemplates = new Set<string>();
  const schemaKey = (ref: StaticSchemaRef) => JSON.stringify([ref.name, ref.version]);
  function visitSchema(ref: StaticSchemaRef): void {
    const key = schemaKey(ref);
    if (visitingSchemas.has(key)) recordFail(`静态定义引用成环：${key}`);
    if (schemas.has(key)) return;
    const builtin = findStaticSchema({ staticSchemas: [] }, ref);
    const matches = documents.staticSchemas.filter((s) => schemaKey(s.ref) === key);
    if (!builtin && matches.length !== 1) recordFail(`静态定义不存在或重复：${key}`);
    const schema = builtin ?? matches[0];
    if (!schema?.compiled) recordFail(`缺少静态定义编译产物：${key}`);
    if (!builtin && !schema.definition) recordFail(`正式记录必须包含静态定义原文：${key}`);
    visitingSchemas.add(key); schemas.set(key, schema);
    if (!builtin) {
      const parsed = parseDefinition(schema.definition);
      if (!parsed.model || parsed.problems.length || parsed.model.name !== ref.name || parsed.version !== ref.version) recordFail(`静态定义原文无效或版本不一致：${key}`);
      const visitValue = (value: ValueModel): void => {
        if (value.type === 'ref') visitSchema(value.ref);
        else if (value.type === 'list') visitValue(value.items);
      };
      parsed.model.fields.forEach((field) => visitValue(field.value));
    }
    function compiledReferences(value: unknown, root = false): void {
      if (!isRecord(value)) return;
      if ('$ref' in value || 'allOf' in value || 'anyOf' in value || 'oneOf' in value) recordFail('记录要求 RenderWeave 内联编译产物', ProblemCodes.deliveryUnsupported);
      if ('x-renderweave-static-schema' in value) {
        const nested = parseStaticSchemaRef(value['x-renderweave-static-schema']);
        if (!nested || (root && schemaKey(nested) !== key)) recordFail(`编译产物定义身份不一致：${key}`);
        if (!root) visitSchema(nested);
      }
      if (isRecord(value.properties)) Object.values(value.properties).forEach((v) => compiledReferences(v));
      compiledReferences(value.items);
    }
    compiledReferences(schema.compiled, true);
    visitingSchemas.delete(key);
  }
  function visitTemplate(name: string): void {
    if (visitingTemplates.has(name)) recordFail(`模板调用成环：${name}`);
    if (templates.has(name)) return;
    const matches = documents.templates.filter((t) => t.name === name);
    if (matches.length !== 1) recordFail(`模板不存在或重复：${name}`);
    const entry = matches[0]!, parsed = parseTemplate(name, entry.document);
    if (!parsed.model || parsed.problems.some((p) => p.level === 'severe')) recordFail(`模板 ${name} 无法通过静态读取：${parsed.problems.map((p) => p.message).join('；')}`);
    templates.set(name, entry); models.set(name, parsed.model); visitingTemplates.add(name);
    visitSchema(parsed.model.base);
    for (const derived of parsed.model.derived) if (derived.type === 'ref' && derived.ref) visitSchema(derived.ref);
    parsed.model.calls.forEach((call) => visitTemplate(call.template));
    visitingTemplates.delete(name);
  }
  visitTemplate(rootTemplate);
  if (dataset) visitSchema(dataset.dataset.staticSchema);
  const resourceKinds = new Map<string, ResourceKind>();
  const add = (value: unknown, kind: ResourceKind): void => {
    if (typeof value !== 'string') return; // 绑定从数据、参数和派生声明的类型收集。
    const id = parseResourceRef(value);
    if (!id) {
      if (/^https?:/i.test(value)) recordFail('出图记录不支持 URL 图片', ProblemCodes.deliveryUnsupported);
      return; // 其他非法值仍由正式渲染诊断。
    }
    if (resourceKinds.has(id) && resourceKinds.get(id) !== kind) recordFail(`同一资源被用作图片与字体：${id}`);
    resourceKinds.set(id, kind);
  };
  [...configured.fallbackFonts, ...configured.svgFonts].forEach((id) => add(`res:${id}`, 'font'));
  for (const [name, template] of templates) {
    const model = models.get(name)!;
    for (const parameter of model.parameters) if (parameter.type === 'image') {
      add(parameter.default, 'image');
      if (request && name === rootTemplate && parameter.visibility === 'public') add(request.parameters[parameter.name], 'image');
    }
    for (const derived of model.derived) if (derived.type === 'image' && derived.operation.op === 'branch') {
      for (const branch of derived.operation.branches) if ('value' in branch.then) add(branch.then.value, 'image');
      if ('value' in derived.operation.otherwise) add(derived.operation.otherwise.value, 'image');
    }
    const scanStyle = (style: Record<string, unknown>, type: unknown, target: unknown): void => {
      if (type === 'image') add(style.source, 'image');
      if (type === 'text') {
        add(style.font, 'font');
        if (Array.isArray(style.content)) for (const fragment of style.content) if (isRecord(fragment)) add(fragment.font, 'font');
      }
      if ((type === 'call' || type === 'loop') && typeof target === 'string' && isRecord(style.args)) {
        const args = style.args;
        for (const parameter of models.get(target)!.parameters) if (parameter.type === 'image') {
          const argument = args[parameter.name]; if (isRecord(argument)) add(argument.value, 'image');
        }
      }
    };
    const scan = (node: unknown): void => {
      if (!isRecord(node)) return;
      if (node.type === 'qrcode' || node.type === 'barcode') recordFail('码图正式交付留待后续票据', ProblemCodes.deliveryUnsupported);
      scanStyle(node, node.type, node.template);
      if (isRecord(node.states) && isRecord(node.states.cases)) for (const style of Object.values(node.states.cases)) if (isRecord(style)) scanStyle(style, node.type, node.template);
      if (Array.isArray(node.children)) node.children.forEach(scan);
    };
    scan((template.document as Record<string, unknown>).artboard);
  }
  function scanData(schema: Record<string, unknown>, value: unknown): void {
    if (schema['x-renderweave-type'] === 'image') add(value, 'image');
    else if (schema.type === 'array' && isRecord(schema.items) && Array.isArray(value)) {
      const items = schema.items; value.forEach((item) => scanData(items, item));
    } else if (isRecord(schema.properties) && isRecord(value)) for (const [name, property] of Object.entries(schema.properties)) if (isRecord(property)) scanData(property, value[name]);
  }
  if (dataset) scanData(schemas.get(schemaKey(dataset.dataset.staticSchema))!.compiled!, dataset.data);
  return { templates, schemas, dataset, resourceKinds: new Map([...resourceKinds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}
