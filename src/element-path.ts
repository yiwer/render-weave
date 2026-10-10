/**
 * 元素路径（M101）：从根模板起，由模板调用链上的元素名称逐层组成，
 * 循环容器处带循环序号（从 1 开始），如 `标准线路单边/站点面板/站点列[12]/名称区/站名`。
 * 第一段是根模板名，代表画板本身。
 * 问题清单、布局摘要与草稿预览的标注共用这一种路径。
 */

export interface ElementPathSegment {
  readonly name: string;
  /** 循环序号，从 1 开始；只出现在循环容器的段上。 */
  readonly index?: number;
}

export type ElementPath = readonly ElementPathSegment[];

/** 元素名称不能含有路径里用作分隔的字符。 */
export const RESERVED_NAME_CHARACTERS = ['/', '[', ']'] as const;

export function rootPath(templateName: string): ElementPath {
  return [{ name: templateName }];
}

export function childPath(parent: ElementPath, name: string, index?: number): ElementPath {
  return [...parent, index === undefined ? { name } : { name, index }];
}

export function formatElementPath(path: ElementPath): string {
  return path
    .map((segment) => (segment.index === undefined ? segment.name : `${segment.name}[${segment.index}]`))
    .join('/');
}
