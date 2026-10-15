/**
 * DSL 1.0 文档的自足检查（M219）：判断一份 JSON 文档是哪种 DSL 文档，并做只看这份文档就能完成的检查。
 *
 * 结构问题与 `schemas/` 中的 JSON Schema 一致：Schema 拒绝的文档，这里一定报严重问题。
 * 这里额外报告 Schema 表达不了的语义问题，如约束冲突、正则不合法、元素名称重复。
 * 需要其他文档才能判断的问题（引用是否存在、变量是否声明、数据是否符合所选静态数据定义）不在此处，
 * 由发布、模板静态检查与渲染入口报告。
 */
import { ProblemCodes, severe, type Problem } from './problems.js';
import { RecordError, parseBatchEnvelope, parseBatchItem } from './record-input.js';
import { parseRenderRequest } from './request.js';
import { parseDefinition } from './schema/parse.js';
import { parseTemplate } from './template/parse.js';
import { isRecord } from './util.js';
import { parseDatasetDocument } from './workspace.js';

export type DslDocumentKind = 'definition' | 'dataset' | 'template' | 'renderRequest' | 'batchRequest';

export interface DslDocumentCheck {
  /** 识别出的文档种类；无法识别时省略。 */
  readonly kind?: DslDocumentKind;
  readonly problems: readonly Problem[];
}

/** 按内容识别文档种类，不看文件名（与工作区读取一致）。 */
export function dslDocumentKind(document: unknown): DslDocumentKind | undefined {
  if (!isRecord(document)) return undefined;
  const dslVersion = document['dslVersion'];
  if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-schema/')) return 'definition';
  if (typeof dslVersion === 'string' && dslVersion.startsWith('renderweave-template/')) return 'template';
  if ('dslVersion' in document) return undefined;
  if ('template' in document && 'items' in document) return 'batchRequest';
  if ('template' in document && ('dataset' in document || 'output' in document || 'mode' in document)) return 'renderRequest';
  if ('dataset' in document) return 'dataset';
  return undefined;
}

export function checkDslDocument(document: unknown, source = '文档'): DslDocumentCheck {
  const kind = dslDocumentKind(document);
  switch (kind) {
    case 'definition':
      return { kind, problems: parseDefinition(document).problems };
    case 'template': {
      const name = (document as Record<string, unknown>)['name'];
      if (typeof name !== 'string' || name === '') {
        return { kind, problems: [severe(ProblemCodes.templateInvalid, { kind: 'input', source }, '模板必须有名称 name')] };
      }
      return { kind, problems: parseTemplate(name, document).problems };
    }
    case 'dataset': {
      const parsed = parseDatasetDocument(document);
      return { kind, problems: typeof parsed === 'string' ? [severe(ProblemCodes.datasetInvalid, { kind: 'input', source }, parsed)] : [] };
    }
    case 'renderRequest':
      return { kind, problems: parseRenderRequest(document).problems };
    case 'batchRequest':
      return { kind, problems: checkBatchRequest(document, source) };
    default:
      return {
        problems: [
          severe(
            ProblemCodes.inputUnreadable,
            { kind: 'input', source },
            '无法识别的文档：数据定义与模板以 dslVersion 区分，数据集由 dataset 与 data 组成，渲染请求含 template 与 output，批次请求含 template 与 items',
          ),
        ],
      };
  }
}

/** 批次请求：外层结构整批检查；各项按渲染请求逐项检查，问题位置改写为所在渲染项。 */
function checkBatchRequest(document: unknown, source: string): Problem[] {
  let envelope;
  try {
    envelope = parseBatchEnvelope(document);
  } catch (error) {
    if (!(error instanceof RecordError)) throw error;
    return [severe(error.code, { kind: 'input', source }, error.message)];
  }
  return envelope.items.flatMap((item, index) =>
    parseBatchItem(envelope, item).problems.map((problem) =>
      problem.location.kind === 'input'
        ? { ...problem, location: { kind: 'input', source: problem.location.source.replace(/^request/, `items[${index + 1}]`) } }
        : problem,
    ),
  );
}
