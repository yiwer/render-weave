/** 提取覆盖只核对本次样例的可信事实；领域名称与 Agent 自述均不产生真值。 */
import { isDeepStrictEqual } from 'node:util';
import { isRecord } from '../util.js';
import type { AgentTaskId } from './tasks.js';
import type { CandidateCheck, SubmittedOutcome } from './outcome.js';

export type CoverageKind = 'field' | 'derived' | 'parameter' | 'constant' | 'pending';
export interface ContentCoverageItem {
  readonly id: string; readonly label: string; readonly kind: CoverageKind;
  readonly file?: string; readonly path?: string; readonly isOptional?: boolean;
  readonly derivedFrom?: readonly string[]; readonly logic?: string; readonly justification?: string;
  readonly sampleOmissions?: number; readonly notes?: string;
}
export interface BusinessContentBaselineItem {
  readonly id: string; readonly label: string; readonly expectedKind?: CoverageKind;
  /** 核准的定义名与字段名，不从 code 等通用名称猜业务归属。 */
  readonly definition?: string; readonly field?: string;
  readonly sampleOmissions?: number;
  readonly allowConstantWithoutBrief?: boolean; readonly mustBeOptionalIfPartial?: boolean; readonly derivableFrom?: string;
  /** 本次示例的逐项事实。path 沿用数据集的 1-based 字段路径。 */
  readonly values?: readonly { readonly path: string; readonly value?: unknown; readonly unknown?: boolean }[];
  /** 兼容旧调用方；布尔声明不产生缺值数量或未知站点。 */
  readonly partialOmissionsExpected?: boolean; readonly partialUnknownExpected?: boolean;
}
export interface BusinessContentBaseline {
  readonly name: string; readonly items: readonly BusinessContentBaselineItem[];
  readonly allowedConstantsInBrief?: readonly string[];
}
export type CoverageAnomalyCode = 'fieldShouldBeOptional' | 'omissionWithoutExplanation' | 'unjustifiedConstant' |
  'duplicateTerminalField' | 'fabricatedQrContent' | 'missingBusinessCoverage' | 'missingDerivationBasis' |
  'fabricatedUnknownValues' | 'missingCoverageItem' | 'invalidCoverageKind' | 'valueMismatch';
export interface CoverageAnomaly {
  readonly code: CoverageAnomalyCode; readonly level: 'hint' | 'severe'; readonly item: string;
  readonly message: string; readonly path?: string;
}
/** 旧版五维总分未校准；保留字段供旧报告读取，不再产生或用总分放行。 */
export interface ExtractionCoverageScore { readonly totalScore: null; readonly passed: boolean; readonly anomalies: readonly CoverageAnomaly[] }
export interface CoverageVerificationRecord {
  readonly status: 'notChecked' | 'needsWork' | 'needsReview'; readonly passed: boolean;
  readonly score: ExtractionCoverageScore; readonly coveredItems: readonly string[]; readonly missingItems: readonly string[];
  readonly unknownItems: readonly string[]; readonly anomalies: readonly CoverageAnomaly[];
}
export interface CoverageAssessment extends Omit<CoverageVerificationRecord, 'score'> { readonly score: null }
/** 兼容导出。通用领域没有“15 个缺编号”等特定样例事实。 */
export const ROUTE_SIGN_BUSINESS_BASELINE: BusinessContentBaseline = { name: 'route-sign', items: [] };

export function validateContentBaseline(input: unknown): input is BusinessContentBaseline {
  if (!isRecord(input) || typeof input['name'] !== 'string' || !Array.isArray(input['items'])) return false;
  const ids = new Set<string>();
  if (input['allowedConstantsInBrief'] !== undefined && (!Array.isArray(input['allowedConstantsInBrief']) ||
    !input['allowedConstantsInBrief'].every((id) => typeof id === 'string'))) return false;
  return input['items'].every((item: unknown) => {
    if (!isRecord(item) || typeof item['id'] !== 'string' || !item['id'] || ids.has(item['id']) || typeof item['label'] !== 'string') return false;
    ids.add(item['id']);
    if (['definition', 'field', 'derivableFrom'].some((key) => item[key] !== undefined && typeof item[key] !== 'string')) return false;
    if (item['expectedKind'] !== undefined && !['field', 'derived', 'parameter', 'constant', 'pending'].includes(String(item['expectedKind']))) return false;
    if (['allowConstantWithoutBrief', 'mustBeOptionalIfPartial', 'partialOmissionsExpected', 'partialUnknownExpected'].some((key) => item[key] !== undefined && typeof item[key] !== 'boolean')) return false;
    if (item['sampleOmissions'] !== undefined && (!Number.isSafeInteger(item['sampleOmissions']) || Number(item['sampleOmissions']) < 0)) return false;
    return item['values'] === undefined || (Array.isArray(item['values']) && item['values'].every((value: unknown) =>
      isRecord(value) && typeof value['path'] === 'string' && validDataPath(value['path']) &&
      (value['unknown'] === true ? !('value' in value) : 'value' in value && (value['unknown'] === undefined || value['unknown'] === false))));
  });
}

export function verifyExtractionCoverage(options: {
  readonly task: AgentTaskId; readonly candidates: readonly (CandidateCheck & { document?: unknown })[];
  readonly submission?: SubmittedOutcome; readonly baseline?: BusinessContentBaseline;
  readonly definitions?: readonly unknown[]; readonly sampleDataset?: unknown; readonly briefText?: string;
}): CoverageVerificationRecord {
  const anomalies: CoverageAnomaly[] = [], coveredItems: string[] = [], missingItems: string[] = [], unknownItems: string[] = [];
  const baseline = options.baseline, submission = options.submission;
  const dataCandidate = options.candidates.find((c) => c.kind === 'dataset' && isRecord(c.document));
  const data = isRecord(dataCandidate?.document) ? dataCandidate.document['data'] : undefined;
  for (const item of baseline?.items ?? []) {
    const claim = submission?.coverage?.find((c) => c.id === item.id);
    const issue = (code: CoverageAnomalyCode, message: string, path?: string, level: 'hint' | 'severe' = 'severe') =>
      anomalies.push({ code, item: item.id, level, message: `${item.label}：${message}`, ...(path ? { path } : {}) });
    let measured = false, missing = false, awaitingReview = false;
    if (claim?.kind === 'constant' && item.allowConstantWithoutBrief === false && !baseline?.allowedConstantsInBrief?.includes(item.id)) {
      issue('unjustifiedConstant', '本次核准基准未授权固定常量；自述 justification 不能替代授权');
    }
    if (options.task === 'definition-extraction' && item.definition && item.field) {
      measured = true;
      const entry = options.candidates.find((c) => c.kind === 'definition' && isRecord(c.document) && c.document['name'] === item.definition);
      const definition = entry?.document;
      const fields = isRecord(definition) && Array.isArray(definition['fields']) ? definition['fields'] : [];
      const field = fields.find((f: unknown) => isRecord(f) && f['name'] === item.field);
      const path = `${item.definition}.${item.field}`;
      if (item.expectedKind === 'derived' && item.derivableFrom) {
        if (field) issue('duplicateTerminalField', '基准要求派生，但候选仍声明独立字段；coverage 自述不能抵消实际字段', path);
        measured = false; // 未存独立字段不等于派生关系已经独立核实。
      } else if (!field) {
        missing = true;
        issue('missingCoverageItem', '核准信息对应的字段缺失', path);
      } else if (isRecord(field)) {
        const omissions = item.sampleOmissions ?? 0;
        if (omissions > 0 && item.mustBeOptionalIfPartial && isRecord(field['constraints']) && field['constraints']['required'] === true) {
          issue('fieldShouldBeOptional', `本次示例已核准 ${omissions} 处缺值，字段不能必填`, path);
        }
        if (omissions > 0 && claim?.sampleOmissions !== omissions && !submission?.pending.some((p) => p.file === entry?.path && p.path === item.field)) {
          issue('omissionWithoutExplanation', `本次示例已核准 ${omissions} 处缺值，覆盖记录尚未对应说明`, path, 'hint');
        }
      }
    }
    if (options.task === 'dataset-extraction' && item.values?.length) {
      measured = true;
      for (const fact of item.values) {
        const actual = atDataPath(data, fact.path);
        const pending = submission?.pending.find((p) => p.file === dataCandidate?.path && p.path === fact.path);
        if (pending) awaitingReview = true;
        if (fact.unknown) {
          if (actual !== undefined && actual !== null && !pending) issue('fabricatedUnknownValues', '基准标记该值未知，不能因 notes 声称有来源而当作已确定数据', fact.path);
          if (pending && pending.reason === 'inferred') issue('missingDerivationBasis', '推导候选仍需人工核实计算与来源', fact.path, 'hint');
        } else if (!isDeepStrictEqual(actual, fact.value)) {
          missing = true;
          issue(actual === undefined ? 'missingBusinessCoverage' : 'valueMismatch', '候选与本次核准的图上值不一致', fact.path, pending ? 'hint' : 'severe');
        }
      }
    }
    if (!measured || awaitingReview) unknownItems.push(item.id);
    else if (missing) missingItems.push(item.id);
    else coveredItems.push(item.id);
  }
  const hasErrors = anomalies.some((a) => a.level === 'severe');
  const passed = !!baseline?.items.length && !hasErrors && !unknownItems.length && !missingItems.length;
  return { status: !baseline?.items.length ? 'notChecked' : hasErrors ? 'needsWork' : 'needsReview', passed,
    score: { totalScore: null, passed, anomalies }, coveredItems, missingItems, unknownItems, anomalies };
}

function validDataPath(path: string): boolean { return /^[^.[\]]+(?:\[[1-9]\d*\]|\.[^.[\]]+)*$/.test(path); }
function atDataPath(data: unknown, path: string): unknown {
  let value = data;
  for (const token of path.match(/[^.[\]]+|\[\d+\]/g) ?? []) {
    if (token.startsWith('[')) value = Array.isArray(value) ? value[Number(token.slice(1, -1)) - 1] : undefined;
    else value = isRecord(value) && Object.hasOwn(value, token) ? value[token] : undefined;
  }
  return value;
}
export function scoreExtractionCoverage(record: CoverageVerificationRecord): ExtractionCoverageScore { return record.score; }
