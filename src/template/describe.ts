/**
 * 模板的对外信息（阶段 4 票据 06）：出图服务的模板列表与只读查看用它，不出图。
 * 只列调用方能填的对外参数；内部参数由设计者设定，不对外。
 */
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { isRecord } from '../util.js';
import type { StaticSchemaRef } from '../workspace.js';
import type { ParameterConstraints, Range } from './model.js';
import { parseTemplate } from './parse.js';
import type { BasicKind } from './types.js';

export interface TemplateDescription {
  readonly name: string;
  /** 所用的数据定义：基准静态数据定义的确切版本。 */
  readonly base: StaticSchemaRef;
  /** 画板的适用尺寸范围，毫米。 */
  readonly sizeRange: { readonly width: Range; readonly height: Range };
  readonly parameters: readonly {
    readonly name: string;
    readonly displayName: string;
    readonly type: BasicKind;
    readonly constraints: ParameterConstraints;
    readonly default?: string | number | boolean;
  }[];
}

/** 读一份模板文档；读不了时没有 template，问题清单说明原因。 */
export function describeTemplate(document: unknown): { template?: TemplateDescription; problems: Problem[] } {
  const name = isRecord(document) ? document['name'] : undefined;
  if (typeof name !== 'string' || name === '') {
    return { problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: 'template' }, '模板缺少名称')] };
  }
  const { model, problems } = parseTemplate(name, document);
  if (!model) return { problems };
  return {
    problems,
    template: {
      name: model.name,
      base: model.base,
      sizeRange: model.artboard.sizeRange,
      parameters: model.parameters.filter((parameter) => parameter.visibility === 'public').map((parameter) => ({
        name: parameter.name, displayName: parameter.displayName, type: parameter.type, constraints: parameter.constraints,
        ...(parameter.default !== undefined ? { default: parameter.default } : {}),
      })),
    },
  };
}
