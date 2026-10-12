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
 * - parameter：对外参数名；子模板实例的问题另带调用框 path。
 * - element：元素路径（M101），如 `标准线路单边/站点面板/站点列[12]/名称区/站名`。
 * - check：模板名与检查项名；子模板实例的问题另带调用框 path。
 * - variable：模板名与模板变量名（参数、派生变量的声明）。
 * - definition：数据定义中的位置，如 `stops.items.constraints`（发布与编译时的问题）。
 * - input：无法归到以上几类的输入位置，如工作区文件或渲染请求的属性。
 */
export type ProblemLocation =
  | { kind: 'field'; path: string }
  | { kind: 'parameter'; name: string; path?: string }
  | { kind: 'element'; path: string }
  | { kind: 'check'; template: string; name: string; path?: string }
  | { kind: 'variable'; template: string; name: string }
  | { kind: 'definition'; schema: string; path: string }
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
  /** 图片字段引用的资源不存在。 */
  datasetResourceNotFound: 'dataset.resourceNotFound',
  /** 图片字段引用了字体等非图片资源。 */
  datasetResourceKindMismatch: 'dataset.resourceKindMismatch',
  /** 数值超过 15 位有效数字（M112）。 */
  datasetTooManyDigits: 'dataset.tooManyDigits',
  /** 数据集选定的静态数据定义与模板基准不是同一个版本（M37），属于阻止展开的问题（M102）。 */
  datasetStaticSchemaMismatch: 'dataset.staticSchemaMismatch',

  /** 数据定义 DSL 的结构或取值不合法。 */
  definitionInvalid: 'definition.invalid',
  definitionUnknownProperty: 'definition.unknownProperty',
  /** 约束彼此冲突，或不适用于该字段类型。 */
  definitionConstraintConflict: 'definition.constraintConflict',
  /** 列表的元素又是列表（M33）。 */
  definitionNestedList: 'definition.nestedList',
  /** 引用的静态数据定义版本不存在。 */
  definitionRefNotFound: 'definition.refNotFound',
  /** 数据定义之间的引用成环（M32）。 */
  definitionRefCycle: 'definition.refCycle',

  /** 模板 DSL 的结构或取值不合法。 */
  templateInvalid: 'template.invalid',
  /** 模板中出现未定义的属性。 */
  templateUnknownProperty: 'template.unknownProperty',
  /** 模板用到了本版本尚未实现的能力。 */
  templateUnsupported: 'template.unsupported',
  templateDuplicateElementName: 'template.duplicateElementName',
  templateInvalidElementName: 'template.invalidElementName',
  /** 插槽或绑定引用的变量不存在。 */
  templateUnknownVariable: 'template.unknownVariable',
  /** 变量路径经过了列表或基本类型的值；路径只能经过单引用。 */
  templateInvalidPath: 'template.invalidPath',
  /** 取值类型与用途不符，如图片字段放进文字插槽、展示格式与字段类型不符、绑定的变量类型与属性不符。 */
  templateTypeMismatch: 'template.typeMismatch',
  /** 数据字段、参数与派生变量共用一个命名空间，名称重复（M90 S3）。 */
  templateDuplicateVariable: 'template.duplicateVariable',
  /** 派生变量之间的引用成环。 */
  templateVariableCycle: 'template.variableCycle',
  /** 模板调用关系成环，阻止展开（M102）。 */
  templateCallCycle: 'template.callCycle',
  /** 被调模板基准与调用数据不一致，阻止展开。 */
  templateCallBaseMismatch: 'template.callBaseMismatch',
  /** 循环模板基准与列表元素不一致，阻止展开（M102）。 */
  templateLoopBaseMismatch: 'template.loopBaseMismatch',
  /** 状态样式列出的取值不会出现，如拼错了派生变量的取值。 */
  templateUnknownStateValue: 'template.unknownStateValue',
  /** 求值时绑定得到的值不能用于该属性：数值缺值或超出范围。 */
  templateBindingValueInvalid: 'template.bindingValueInvalid',

  /** 对外参数必须提供而没有提供。 */
  parameterMissing: 'parameter.missing',
  /** 渲染请求填写了模板没有的参数。 */
  parameterUnknown: 'parameter.unknown',
  /** 渲染请求填写了内部参数；内部参数只由模板设计者设定（M15）。 */
  parameterInternal: 'parameter.internal',
  /** 参数取值的类型或约束不对。 */
  parameterInvalid: 'parameter.invalid',

  /** 检查项的问题条件成立，等级与提示文字由检查项给出（M25）。 */
  checkFailed: 'check.failed',

  resourceNotFound: 'resource.notFound',
  resourceKindMismatch: 'resource.kindMismatch',
  resourceUnreadable: 'resource.unreadable',
  /** 资源的文件格式不受支持（图片只支持 PNG、JPEG、WebP，SVG 见票据 13）。 */
  resourceUnsupportedFormat: 'resource.unsupportedFormat',

  /** 实际尺寸超出画板的适用尺寸范围。 */
  renderSizeOutOfRange: 'render.sizeOutOfRange',
  /** 容器内的元素按布局放不下（堆叠的主方向、网格的行列总和超出可用空间）。 */
  layoutContentOverflow: 'layout.contentOverflow',
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
