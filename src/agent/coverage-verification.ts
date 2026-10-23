/**
 * 业务内容提取覆盖核查与未知值表达（票据 33）：
 * 把数据定义与最小样例数据、图上业务内容覆盖记录一起核对，
 * 修复站码必填、无依据固定业务信息及累计分钟漏项，
 * 区分字段、派生、参数、固定标签与待确认，防止 Agent 自述替代独立事实核对。
 */
import { isRecord } from '../util.js';
import type { AgentTaskId } from './tasks.js';
import type { CandidateCheck, SubmittedOutcome } from './outcome.js';

export type CoverageKind = 'field' | 'derived' | 'parameter' | 'constant' | 'pending';

/** 覆盖记录中的一项 */
export interface ContentCoverageItem {
  readonly id: string;
  readonly label: string;
  readonly kind: CoverageKind;
  readonly file?: string;
  readonly path?: string;
  readonly isOptional?: boolean;
  readonly derivedFrom?: readonly string[];
  readonly logic?: string;
  readonly justification?: string;
  readonly sampleOmissions?: number;
  readonly notes?: string;
}

/** 业务基准项定义 */
export interface BusinessContentBaselineItem {
  readonly id: string;
  readonly label: string;
  readonly expectedKind?: CoverageKind;
  /** 是否允许直接作为常量而无需简报授权；若为 false 且 brief 未明确说明，归为 constant 报 unjustifiedConstant */
  readonly allowConstantWithoutBrief?: boolean;
  /** 是否在部分示例上有缺项（例如 16 站仅 1 站有站码，15 站已知缺编号） */
  readonly partialOmissionsExpected?: boolean;
  /** 当存在部分缺项时，数据定义中的对应字段必须为可选 */
  readonly mustBeOptionalIfPartial?: boolean;
  /** 该项是否应该由其他字段派生（如终点站派生自站点末项） */
  readonly derivableFrom?: string;
  /** 该项是否有区间未知值（如第 2-5 站到站分钟未知），要求未提供依据时不得编造 */
  readonly partialUnknownExpected?: boolean;
}

/** 业务内容基准 */
export interface BusinessContentBaseline {
  readonly name: string;
  readonly items: readonly BusinessContentBaselineItem[];
  /** brief 或项目说明中明确允许作为固定常量的业务项 ID */
  readonly allowedConstantsInBrief?: readonly string[];
}

export type CoverageAnomalyCode =
  | 'fieldShouldBeOptional'        // 示例图存在已知缺值（如 15 个站缺编号），字段必须为可选
  | 'omissionWithoutExplanation'   // 存在缺值但未在待确认项或覆盖记录中说明（无说明放过）
  | 'unjustifiedConstant'          // 业务内容无 brief 依据归为全市固定常量
  | 'duplicateTerminalField'       // 终点站重复建立独立字段，未由末站派生
  | 'fabricatedQrContent'          // 二维码占位臆造业务协议/内容
  | 'missingBusinessCoverage'      // 关键业务信息（如累计分钟）在数据集中全部留空/丢失
  | 'missingDerivationBasis'       // 推导值未提供计算依据（note 缺少计算过程）
  | 'fabricatedUnknownValues'      // 未知值被凭空编造（如第 2-5 站编造了数字）
  | 'missingCoverageItem'          // 基准要求的业务项完全未被覆盖
  | 'invalidCoverageKind';         // 覆盖类型归类错误

export interface CoverageAnomaly {
  readonly code: CoverageAnomalyCode;
  readonly level: 'hint' | 'severe';
  readonly item: string;
  readonly message: string;
  readonly path?: string;
}

export interface ExtractionCoverageScore {
  readonly totalScore: number;
  readonly passed: boolean;
  readonly breakdown: {
    readonly requiredFieldAccuracy: number; // 必填/可选判断 (0-20)
    readonly omissionHandling: number;      // 缺值与待确认处理 (0-20)
    readonly constantValidity: number;       // 常量归属合法性 (0-20)
    readonly derivationValidity: number;     // 派生与非重复性 (0-20)
    readonly contentCompleteness: number;    // 内容完整性与未知值表达 (0-20)
  };
  readonly anomalies: readonly CoverageAnomaly[];
}

export interface CoverageVerificationRecord {
  readonly passed: boolean;
  readonly score: ExtractionCoverageScore;
  readonly coveredItems: readonly string[];
  readonly missingItems: readonly string[];
  readonly anomalies: readonly CoverageAnomaly[];
}

export interface CoverageAssessment {
  readonly passed: boolean;
  readonly score: number;
  readonly anomalies: readonly CoverageAnomaly[];
  readonly coveredItems: readonly string[];
  readonly missingItems: readonly string[];
}

/** 标准公交线路牌业务内容基准 */
export const ROUTE_SIGN_BUSINESS_BASELINE: BusinessContentBaseline = {
  name: 'route-sign',
  items: [
    { id: 'routeNo', label: '线路号', expectedKind: 'field' },
    { id: 'stops', label: '停靠站点列表', expectedKind: 'field' },
    { id: 'stopName', label: '站点名称', expectedKind: 'field' },
    {
      id: 'stopCode',
      label: '站点编号',
      expectedKind: 'field',
      partialOmissionsExpected: true,
      mustBeOptionalIfPartial: true,
    },
    {
      id: 'minutesFromStart',
      label: '到站累计分钟',
      expectedKind: 'field',
      partialUnknownExpected: true,
    },
    {
      id: 'peakHours',
      label: '高峰时段',
      expectedKind: 'field',
      allowConstantWithoutBrief: false,
    },
    {
      id: 'paymentMethods',
      label: '付款方式',
      expectedKind: 'field',
      allowConstantWithoutBrief: false,
    },
    {
      id: 'transferValidity',
      label: '换乘有效期',
      expectedKind: 'field',
      allowConstantWithoutBrief: false,
    },
    { id: 'fare', label: '票价', expectedKind: 'field' },
    {
      id: 'terminal',
      label: '终点站',
      expectedKind: 'derived',
      derivableFrom: 'stops',
    },
    { id: 'qrcode', label: '二维码占位', expectedKind: 'field' },
    { id: 'currentStopIndex', label: '本站序号', expectedKind: 'parameter' },
  ],
  allowedConstantsInBrief: [],
};

/**
 * 校验业务内容提取覆盖情况与未知值表达
 */
export function verifyExtractionCoverage(options: {
  readonly task: AgentTaskId;
  readonly candidates: readonly (CandidateCheck & { document?: unknown })[];
  readonly submission?: SubmittedOutcome;
  readonly baseline?: BusinessContentBaseline;
  /** 本轮可用的数据定义原文（含被引用的定义），用于判断数据集该不该有某个字段。 */
  readonly definitions?: readonly unknown[];
  readonly sampleDataset?: unknown;
  readonly briefText?: string;
}): CoverageVerificationRecord {
  const anomalies: CoverageAnomaly[] = [];
  const coveredSet = new Set<string>();
  const submission = options.submission;
  const coverageItems = submission?.coverage ?? [];
  const pending = submission?.pending ?? [];
  const notes = submission?.notes ?? '';

  const hasSpecificBaseline = !!options.baseline;
  const isRouteSign = hasSpecificBaseline || isRouteSignDomain(options.candidates, submission);
  const baseline = options.baseline ?? (isRouteSign ? ROUTE_SIGN_BUSINESS_BASELINE : undefined);

  for (const item of coverageItems) {
    coveredSet.add(item.id);
  }

  // 1. 数据定义提取任务核查
  if (options.task === 'definition-extraction') {
    const definitions = options.candidates
      .filter((c) => c.kind === 'definition' && isRecord(c.document))
      .map((c) => c.document as Record<string, unknown>);

    const allFields: { name: string; required: boolean; definitionName: string; raw: Record<string, unknown> }[] = [];
    for (const def of definitions) {
      const defName = typeof def['name'] === 'string' ? def['name'] : '';
      const fields = Array.isArray(def['fields']) ? def['fields'] : [];
      for (const f of fields) {
        if (!isRecord(f)) continue;
        const name = typeof f['name'] === 'string' ? f['name'] : '';
        const constraints = isRecord(f['constraints']) ? f['constraints'] : {};
        const required = constraints['required'] === true;
        allFields.push({ name, required, definitionName: defName, raw: f });
      }
    }

    if (baseline) {
      // (A) 站码必填与已知缺编号核查 (条目 1)
      const stopCodeBaseline = baseline.items.find((i) => i.id === 'stopCode');
      const stopCodeField = allFields.find((f) => /^(code|stopCode|stationCode)$/i.test(f.name));
      if (stopCodeField) {
        coveredSet.add('stopCode');
        // 如果基准标明在示例中存在部分缺失，且必须为 optional
        if (stopCodeBaseline?.mustBeOptionalIfPartial && stopCodeField.required) {
          anomalies.push({
            code: 'fieldShouldBeOptional',
            level: 'severe',
            item: 'stopCode',
            message: `示例图存在已知缺编号（15 处缺失），站码字段 "${stopCodeField.name}" 必须设为可选（required: false），不能设为必填`,
            path: `${stopCodeField.definitionName}.${stopCodeField.name}`,
          });
        }

        // 检查是否将已知缺值进行了说明（无说明放过检查）
        const hasExplanationInPending = pending.some((p) =>
          (p.path && /code/i.test(p.path)) || /编号|站码|code/i.test(p.note),
        );
        const coverageItem = coverageItems.find((c) => c.id === 'stopCode');
        const hasExplanationInCoverage = coverageItem && (coverageItem.sampleOmissions ?? 0) > 0;
        const hasExplanationInNotes = /缺编号|未提供编号|无站码|部分站(缺少|未设)编号|15/i.test(notes);

        if (!hasExplanationInPending && !hasExplanationInCoverage && !hasExplanationInNotes) {
          anomalies.push({
            code: 'omissionWithoutExplanation',
            // 字段可选时缺编号本身不阻止交付，但仍要让人看到；必填时才作为严重问题。
            level: stopCodeField.required ? 'severe' : 'hint',
            item: 'stopCode',
            message: '示例图中 15 处停靠站点缺少编号，未在待确认项、覆盖记录或说明中说明，不能无说明放过',
            path: `${stopCodeField.definitionName}.${stopCodeField.name}`,
          });
        }
      }

      // (B) 峰段、付款、换乘有效期等不能无依据归为全市固定常量 (条目 2)
      const constantRestrictedItems = baseline.items.filter((i) => i.allowConstantWithoutBrief === false);
      for (const item of constantRestrictedItems) {
        const allowedInBrief = (baseline.allowedConstantsInBrief ?? []).includes(item.id) ||
          (options.briefText && new RegExp(`${item.label}.*全市统一|统一规定|固定常量`, 'i').test(options.briefText));

        const fieldExists = allFields.some((f) =>
          new RegExp(item.id, 'i').test(f.name) || (typeof f.raw['displayName'] === 'string' && f.raw['displayName'].includes(item.label)),
        );

        // 如果没有建字段，检查是否被归为了 constant 或在 notes 里声称是全市固定常量
        const covItem = coverageItems.find((c) => c.id === item.id);
        const claimedConstantInCoverage = covItem && covItem.kind === 'constant';
        const claimedConstantInNotes = new RegExp(`${item.label}.*(全市统一|固定常量|统一规定|写死在模板)`, 'i').test(notes);

        // 只有明确声称“全市统一 / 固定常量”时才核查依据。图上没有出现、也没建字段，
        // 不等于把它归为常量；例如 M402 示例图不含高峰时段，缺这个字段是正常的。
        if ((claimedConstantInCoverage || claimedConstantInNotes) && !allowedInBrief) {
          anomalies.push({
            code: 'unjustifiedConstant',
            level: 'severe',
            item: item.id,
            message: `"${item.label}" 属于线路业务信息，项目说明未授权其为全市统一常量，不能无依据归为固定常量，应建为可选字段并列入待确认`,
          });
        } else if (fieldExists || covItem) {
          coveredSet.add(item.id);
        }
      }

      // (C) 终点不重复存 (条目 2)
      const terminalField = allFields.find((f) => /^(terminal|destination|terminalStop|endStop)$/i.test(f.name) ||
        (typeof f.raw['displayName'] === 'string' && /终点站|终到站|方向/i.test(f.raw['displayName'])));
      const terminalCov = coverageItems.find((c) => c.id === 'terminal');
      if (terminalField && (!terminalCov || terminalCov.kind === 'field')) {
        anomalies.push({
          code: 'duplicateTerminalField',
          level: 'severe',
          item: 'terminal',
          message: `数据定义中定义了独立终点字段 "${terminalField.name}"；终点站可由站点列表末项派生，不应重复存为独立字段`,
          path: `${terminalField.definitionName}.${terminalField.name}`,
        });
      } else {
        coveredSet.add('terminal');
      }

      // (D) QR 占位不臆造内容 (条目 2)
      const qrCov = coverageItems.find((c) => c.id === 'qrcode');
      const qrNotesClaim = /二维码.*(由站码推出|推导站码|通过编号生成)/i.test(notes) || (qrCov?.notes && /由站码推出/i.test(qrCov.notes));
      if (qrNotesClaim) {
        anomalies.push({
          code: 'fabricatedQrContent',
          level: 'severe',
          item: 'qrcode',
          message: '二维码占位缺少业务协议依据，不可臆造"可由站码推出"或编造内容，应作为占位符处理',
        });
      } else {
        coveredSet.add('qrcode');
      }
    }
  }

  // 2. 数据集提取任务核查
  if (options.task === 'dataset-extraction') {
    const datasetCandidate = options.candidates.find((c) => c.kind === 'dataset' && isRecord(c.document));
    const datasetDoc = datasetCandidate ? (datasetCandidate.document as Record<string, unknown>) : undefined;
    const data = datasetDoc && isRecord(datasetDoc['data']) ? (datasetDoc['data'] as Record<string, unknown>) : undefined;

    // 检查站点列表中 minutesFromStart 的覆盖与未知值表达 (条目 3)
    const stops = data && Array.isArray(data['stops']) ? data['stops'] : [];
    // 只有数据定义确实有到站分钟字段时才要求数据集承载它。366 一类线路牌不展示分钟，
    // 定义里也没有这个字段，不能因为数据集没有它而判为整块信息丢失。
    const minutesDefined = hasField(options.definitions, 'minutesFromStart');
    const hasMinutesKey = stops.some((s) => isRecord(s) && Object.prototype.hasOwnProperty.call(s, 'minutesFromStart'));
    if (stops.length > 0 && minutesDefined !== false && (minutesDefined === true || hasMinutesKey)) {
      const minutesValues = stops.map((s) => {
        if (!isRecord(s)) return undefined;
        return s['minutesFromStart'];
      });

      const allEmpty = minutesValues.every((v) => v === undefined || v === null);
      const pendingMinutes = pending.filter((p) => p.path && /minutesFromStart/i.test(p.path));

      // (A) 累计分钟全空丢失检查
      if (allEmpty && pendingMinutes.length === 0) {
        anomalies.push({
          code: 'missingBusinessCoverage',
          level: 'severe',
          item: 'minutesFromStart',
          message: '数据定义有到站分钟字段，数据集却全部留空且未列入待确认，导致整块业务信息丢失',
          path: 'stops[].minutesFromStart',
        });
      } else {
        coveredSet.add('minutesFromStart');

        // (B) 未知值不编造核查：每个非缺省值都要有来源。
        // 逐项待确认（含计算依据）或在覆盖记录中说明整列的来源，二者有一即可；
        // 第 1 站的 0 分钟是常见起点，不强制说明。
        const pendingIndices = new Set<number>();
        for (const item of pending) {
          const match = item.path?.match(/^stops\[(\d+)\]\.minutesFromStart$/);
          if (match) pendingIndices.add(Number(match[1]) - 1);
        }
        const minutesCoverage = coverageItems.find((c) => c.id === 'minutesFromStart');
        const coverageExplains = !!minutesCoverage && (
          ((minutesCoverage.derivedFrom?.length ?? 0) > 0 && !!minutesCoverage.logic) ||
          !!minutesCoverage.justification || !!minutesCoverage.notes
        );
        const unexplained: number[] = [];
        if (!coverageExplains) {
          minutesValues.forEach((value, index) => {
            if (value === undefined || value === null) return;
            if (index === 0 && value === 0) return;
            if (!pendingIndices.has(index)) unexplained.push(index + 1);
          });
        }

        if (unexplained.length > 0) {
          anomalies.push({
            code: 'fabricatedUnknownValues',
            level: 'severe',
            item: 'minutesFromStart',
            message: `第 ${unexplained.join('、')} 站的到站分钟没有来源：图上未给出时必须保持缺省，推导值要列入待确认并写明计算依据，或在覆盖记录中说明整列来源`,
            path: `stops[${unexplained[0]}].minutesFromStart`,
          });
        }

        // (C) 推导值有依据核查
        // 如果填写或推导了始发站(0)、当前站(24, 55-31)、及后续站(27...)，必须有推导依据
        const inferredItems = pending.filter((p) => p.reason === 'inferred');
        for (const item of inferredItems) {
          if (item.path && /minutesFromStart/i.test(item.path)) {
            const hasCalculationBasis = /[0-9]+\s*[-+]\s*[0-9]+|始发|55\s*-\s*31|计算|推导|累加/i.test(item.note);
            if (!hasCalculationBasis) {
              anomalies.push({
                code: 'missingDerivationBasis',
                level: 'severe',
                item: 'minutesFromStart',
                message: `待确认项 "${item.path}" 标记为推测（inferred），但说明中未提供计算依据（如 55-31=24）`,
                path: item.path,
              });
            }
          }
        }
      }
    }
  }

  // 3. 计算覆盖率与评分
  const missingItems: string[] = [];
  if (baseline) {
    for (const baselineItem of baseline.items) {
      if (baselineItem.expectedKind === 'field' && !coveredSet.has(baselineItem.id)) {
        missingItems.push(baselineItem.id);
      }
    }
  }

  const score = scoreExtractionCoverageInternal(anomalies, coveredSet, missingItems);
  const passed = score.passed && anomalies.every((a) => a.level !== 'severe');

  return {
    passed,
    score,
    coveredItems: [...coveredSet],
    missingItems,
    anomalies,
  };
}

/** 本轮可用的数据定义里有没有某个字段；没有给定义时返回 undefined，交给调用方按候选内容推断。 */
function hasField(definitions: readonly unknown[] | undefined, name: string): boolean | undefined {
  if (definitions === undefined) return undefined;
  for (const definition of definitions) {
    if (!isRecord(definition)) continue;
    const fields = Array.isArray(definition['fields']) ? definition['fields'] : [];
    for (const field of fields) {
      if (isRecord(field) && field['name'] === name) return true;
    }
  }
  return false;
}

function isRouteSignDomain(
  candidates: readonly (CandidateCheck & { document?: unknown })[],
  submission?: SubmittedOutcome,
): boolean {
  if (submission?.coverage && submission.coverage.length > 0) {
    if (submission.coverage.some((item) => /route|stop|minutes/i.test(item.id))) return true;
  }
  for (const c of candidates) {
    const doc = c.document;
    if (isRecord(doc)) {
      const name = typeof doc['name'] === 'string' ? doc['name'] : '';
      if (/线路|站点|公交|停靠|route|stop|station/i.test(name)) return true;
      if (Array.isArray(doc['fields'])) {
        for (const f of doc['fields']) {
          if (isRecord(f) && typeof f['name'] === 'string' && /^(code|stopCode|stationCode|stops|routeNo|minutesFromStart)$/i.test(f['name'])) {
            return true;
          }
        }
      }
      if (isRecord(doc['dataset']) && isRecord(doc['data'])) {
        if (Array.isArray(doc['data']['stops'])) return true;
      }
    }
  }
  return false;
}

/** 内部评分计算 */
function scoreExtractionCoverageInternal(
  anomalies: readonly CoverageAnomaly[],
  _coveredSet: ReadonlySet<string>,
  _missingItems: readonly string[],
): ExtractionCoverageScore {
  let requiredFieldAccuracy = 20;
  let omissionHandling = 20;
  let constantValidity = 20;
  let derivationValidity = 20;
  let contentCompleteness = 20;

  for (const anomaly of anomalies) {
    switch (anomaly.code) {
      case 'fieldShouldBeOptional':
        requiredFieldAccuracy = Math.max(0, requiredFieldAccuracy - 20);
        break;
      case 'omissionWithoutExplanation':
        omissionHandling = Math.max(0, omissionHandling - 20);
        break;
      case 'unjustifiedConstant':
        constantValidity = Math.max(0, constantValidity - 20);
        break;
      case 'duplicateTerminalField':
      case 'fabricatedQrContent':
      case 'missingDerivationBasis':
        derivationValidity = Math.max(0, derivationValidity - 10);
        break;
      case 'missingBusinessCoverage':
        contentCompleteness = Math.max(0, contentCompleteness - 20);
        break;
      case 'fabricatedUnknownValues':
        contentCompleteness = Math.max(0, contentCompleteness - 20);
        break;
      case 'missingCoverageItem':
        contentCompleteness = Math.max(0, contentCompleteness - 5);
        break;
    }
  }

  const totalScore = requiredFieldAccuracy + omissionHandling + constantValidity + derivationValidity + contentCompleteness;
  const passed = totalScore >= 80 && !anomalies.some((a) => a.level === 'severe');

  return {
    totalScore,
    passed,
    breakdown: {
      requiredFieldAccuracy,
      omissionHandling,
      constantValidity,
      derivationValidity,
      contentCompleteness,
    },
    anomalies,
  };
}

/** 独立公开的评分函数 */
export function scoreExtractionCoverage(record: CoverageVerificationRecord): ExtractionCoverageScore {
  return record.score;
}
