/**
 * 模板文档的读取（P1 票据 08、09）：页面拿到的是工作副本原文，这里从文档里读出页面要的东西。
 * 不校验：还没写完的工作副本也能打开，问题由服务端的问题清单说明。
 */
import type { TemplateInfo, TemplateParameter } from '../types.js';

export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

/** 工作副本原文解析成文档；服务端在暂存时核对过是 JSON 对象。 */
export function parseTemplateText(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  return isObject(parsed) ? parsed : {};
}

/** 与服务端写文档的格式相同（两格缩进、末尾换行）。 */
export const templateText = (document: unknown) => `${JSON.stringify(document, null, 2)}\n`;

/**
 * 文档里的模板信息，与 GET /v1/templates/{name} 同样的形状：工作副本的适用尺寸、基准与对外参数可能已经改了，
 * 复制出来还没保存的新模板也只有文档。
 */
export function documentInfo(name: string, document: JsonObject): TemplateInfo {
  const artboard = isObject(document['artboard']) ? document['artboard'] : {};
  const sizeRange = artboard['sizeRange'] as TemplateInfo['sizeRange'];
  const parameters = Array.isArray(document['parameters']) ? document['parameters'] as (TemplateParameter & { readonly visibility?: string })[] : [];
  return {
    name, currentRevision: 0,
    ...(isObject(document['base']) ? { base: document['base'] as unknown as NonNullable<TemplateInfo['base']> } : {}),
    ...(sizeRange ? { sizeRange } : {}),
    parameters: parameters.filter((parameter) => parameter.visibility === 'public'),
  };
}
