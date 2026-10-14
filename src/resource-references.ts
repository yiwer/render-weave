/** 模板与数据集原文中的资源引用位置；出图记录据此收集资源种类，替换影响检查据此报告引用位置。 */
import type { ResourceKind } from './resources.js';
import type { TemplateModel } from './template/model.js';
import { isRecord } from './util.js';

export type ResourceReferenceKind = 'templateFixed' | 'stateStyle' | 'parameterDefault' | 'derivedValue' | 'callArgument' | 'datasetImage';
/** 一处可写资源引用的位置；所在文档由调用方给出。 */
export interface ResourceReferenceSite {
  /** 原文取值，未必是合法的 `res:资源ID`，由调用方判断。 */
  readonly value: string;
  readonly resourceKind: ResourceKind;
  readonly kind: ResourceReferenceKind;
  /** 文档内的 JSON Pointer。 */
  readonly path: string;
}

const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

function* site(value: unknown, path: string, kind: ResourceReferenceKind, resourceKind: ResourceKind): Generator<ResourceReferenceSite> {
  if (typeof value === 'string') yield { value, resourceKind, kind, path }; // 非文本取值是变量绑定，不是固定引用。
}

/**
 * 模板原文中的固定资源引用：图片参数缺省值、图片派生变量的分支取值，以及画板元素树（含隐藏元素、状态样式各取值与调用实参）。
 * 调用方须先确认模板能通过静态读取；`callee` 给出被调模板，用于判断哪些实参是图片。
 */
export function* templateResourceReferences(name: string, document: Record<string, unknown>, callee: (name: string) => TemplateModel | undefined): Generator<ResourceReferenceSite> {
  if (Array.isArray(document.parameters)) for (const [i, parameter] of document.parameters.entries()) {
    if (isRecord(parameter) && parameter.type === 'image') yield* site(parameter.default, `/parameters/${i}/default`, 'parameterDefault', 'image');
  }
  if (Array.isArray(document.derived)) for (const [i, derived] of document.derived.entries()) {
    if (!isRecord(derived) || derived.type !== 'image') continue;
    if (Array.isArray(derived.branches)) for (const [j, branch] of derived.branches.entries()) {
      if (isRecord(branch) && isRecord(branch.then)) yield* site(branch.then.value, `/derived/${i}/branches/${j}/then/value`, 'derivedValue', 'image');
    }
    if (isRecord(derived.otherwise)) yield* site(derived.otherwise.value, `/derived/${i}/otherwise/value`, 'derivedValue', 'image');
  }
  function* style(value: Record<string, unknown>, type: unknown, target: unknown, path: string, state: boolean): Generator<ResourceReferenceSite> {
    const kind = state ? 'stateStyle' : 'templateFixed';
    if (type === 'image') yield* site(value.source, `${path}/source`, kind, 'image');
    // 条形码下方文字的字体不能绑定变量，只能固定或由状态样式切换；关闭文字时同样固定，记录不随显示与否变化。
    if (type === 'text' || type === 'barcode') yield* site(value.font, `${path}/font`, kind, 'font');
    if (type === 'text' && Array.isArray(value.content)) for (const [i, fragment] of value.content.entries()) {
      if (isRecord(fragment)) yield* site(fragment.font, `${path}/content/${i}/font`, kind, 'font');
    }
    if (type === 'call' || type === 'loop') {
      const called = typeof target === 'string' ? callee(target) : undefined;
      if (!called) throw new Error(`模板 ${name}${path} 的被调模板无法检查`);
      if (isRecord(value.args)) for (const [key, argument] of Object.entries(value.args)) {
        if (called.parameters.some((parameter) => parameter.name === key && parameter.type === 'image') && isRecord(argument)) {
          yield* site(argument.value, `${path}/args/${pointer(key)}/value`, state ? 'stateStyle' : 'callArgument', 'image');
        }
      }
    }
  }
  function* element(node: unknown, path: string): Generator<ResourceReferenceSite> {
    if (!isRecord(node)) return;
    yield* style(node, node.type, node.template, path, false);
    if (isRecord(node.states) && isRecord(node.states.cases)) for (const [key, state] of Object.entries(node.states.cases)) {
      if (isRecord(state)) yield* style(state, node.type, node.template, `${path}/states/cases/${pointer(key)}`, true);
    }
    if (Array.isArray(node.children)) for (const [i, child] of node.children.entries()) yield* element(child, `${path}/children/${i}`);
  }
  yield* element(document.artboard, '/artboard');
}

/** 数据中按编译产物标为图片的字段；编译产物中的 image 标记是权威，普通文本中的 res: 字样不是资源引用。 */
export function* datasetResourceReferences(schema: Record<string, unknown>, value: unknown, path = '/data'): Generator<ResourceReferenceSite> {
  if (schema.$ref !== undefined || schema.allOf !== undefined || schema.anyOf !== undefined || schema.oneOf !== undefined) throw new Error('影响检查需要 RenderWeave 内联编译产物，不接受外部引用或组合 Schema');
  if (schema['x-renderweave-type'] === 'image') yield* site(value, path, 'datasetImage', 'image');
  else if (schema.type === 'array' && isRecord(schema.items) && Array.isArray(value)) {
    const items = schema.items;
    for (const [i, item] of value.entries()) yield* datasetResourceReferences(items, item, `${path}/${i}`);
  } else if (isRecord(schema.properties) && isRecord(value)) {
    for (const [key, property] of Object.entries(schema.properties)) if (isRecord(property)) yield* datasetResourceReferences(property, value[key], `${path}/${pointer(key)}`);
  }
}
