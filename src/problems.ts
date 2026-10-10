/**
 * 问题清单：校验与渲染过程中发现的问题。
 *
 * 每项包含稳定的问题代码、等级（提示或严重）、位置与中文说明。
 * 问题代码一经发布不改名，调用方（命令行、MCP 服务、agent）可以按代码分辨问题。
 */

export type ProblemLevel = 'hint' | 'severe';

/**
 * 问题的位置。
 * - field：数据集中的字段路径，列表序号从 1 开始，如 `stops[12].name`。
 * - parameter：对外参数名。
 * - element：元素路径（M101），如 `标准线路单边/站点面板/站点列[12]/名称区/站名`。
 * - check：模板名与检查项名。
 * - input：无法归到以上几类的输入位置，如工作区文件或渲染请求的属性。
 */
export type ProblemLocation =
  | { kind: 'field'; path: string }
  | { kind: 'parameter'; name: string }
  | { kind: 'element'; path: string }
  | { kind: 'check'; template: string; name: string }
  | { kind: 'input'; source: string };

export interface Problem {
  code: ProblemCode;
  level: ProblemLevel;
  location: ProblemLocation;
  message: string;
}

export const ProblemCodes = {
  /** 工作区、请求或资源文件无法读取或不是合法 JSON。 */
  inputUnreadable: 'input.unreadable',
  /** 工作区中名称或版本重复，无法确定使用哪一份。 */
  inputDuplicate: 'input.duplicate',
  /** 渲染请求的结构或取值不合法。 */
  requestInvalid: 'request.invalid',
  /** 渲染请求的出图尺寸换算成像素后过大。 */
  requestOutputTooLarge: 'request.outputTooLarge',
  templateNotFound: 'input.templateNotFound',
  datasetNotFound: 'input.datasetNotFound',
  staticSchemaNotFound: 'input.staticSchemaNotFound',
  /** 静态数据定义没有附带编译产物（M103）。 */
  compiledSchemaMissing: 'input.compiledSchemaMissing',

  datasetRequiredMissing: 'dataset.requiredMissing',
  datasetNullValue: 'dataset.nullValue',
  datasetUnknownKey: 'dataset.unknownKey',
  datasetTypeMismatch: 'dataset.typeMismatch',
  datasetFormatInvalid: 'dataset.formatInvalid',
  datasetConstraintViolated: 'dataset.constraintViolated',
  datasetInvalid: 'dataset.invalid',

  /** 模板 DSL 的结构或取值不合法。 */
  templateInvalid: 'template.invalid',
  /** 模板中出现未定义的属性。 */
  templateUnknownProperty: 'template.unknownProperty',
  /** 模板用到了本版本尚未实现的能力。 */
  templateUnsupported: 'template.unsupported',
  templateDuplicateElementName: 'template.duplicateElementName',
  templateInvalidElementName: 'template.invalidElementName',

  resourceNotFound: 'resource.notFound',
  resourceKindMismatch: 'resource.kindMismatch',
  resourceUnreadable: 'resource.unreadable',

  /** 实际尺寸超出画板的适用尺寸范围。 */
  renderSizeOutOfRange: 'render.sizeOutOfRange',
  /** 文字按适配规则处理后仍放不下元素框。 */
  layoutTextOverflow: 'layout.textOverflow',
} as const;

export type ProblemCode = (typeof ProblemCodes)[keyof typeof ProblemCodes];

export function severe(code: ProblemCode, location: ProblemLocation, message: string): Problem {
  return { code, level: 'severe', location, message };
}

export function hint(code: ProblemCode, location: ProblemLocation, message: string): Problem {
  return { code, level: 'hint', location, message };
}

export function hasSevere(problems: readonly Problem[]): boolean {
  return problems.some((problem) => problem.level === 'severe');
}
