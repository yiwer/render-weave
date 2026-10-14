/**
 * DSL 1.0 文档的自足检查（M219）：判断一份 JSON 文档是哪种 DSL 文档，并做只看这份文档就能完成的检查。
 *
 * 结构问题与 `schemas/` 中的 JSON Schema 一致：Schema 拒绝的文档，这里一定报严重问题。
 * 这里额外报告 Schema 表达不了的语义问题，如约束冲突、正则不合法、字段名称重复。
 * 需要其他文档才能判断的问题（引用是否存在、数据是否符合所选静态数据定义）不在此处，由发布与渲染入口报告。
 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { parseDefinition } from './schema/parse.js';
import { isRecord } from './util.js';
import { parseDatasetDocument } from './workspace.js';

export type DslDocumentKind = 'definition' | 'dataset';

export interface DslDocumentCheck {
  /** 识别出的文档种类；无法识别时省略。 */
  readonly kind?: DslDocumentKind;
  readonly problems: readonly Problem[];
}

export function checkDslDocument(document: unknown, source = '文档'): DslDocumentCheck {
  if (isRecord(document) && typeof document['dslVersion'] === 'string' && document['dslVersion'].startsWith('renderweave-schema/')) {
    return { kind: 'definition', problems: parseDefinition(document).problems };
  }
  if (isRecord(document) && !('dslVersion' in document) && 'dataset' in document) {
    const parsed = parseDatasetDocument(document);
    return {
      kind: 'dataset',
      problems: typeof parsed === 'string' ? [severe(ProblemCodes.datasetInvalid, { kind: 'input', source }, parsed)] : [],
    };
  }
  return {
    problems: [
      severe(
        ProblemCodes.inputUnreadable,
        { kind: 'input', source },
        '无法识别的文档：数据定义以 dslVersion 为 renderweave-schema/1 开头，数据集由 dataset 与 data 两部分组成',
      ),
    ],
  };
}
