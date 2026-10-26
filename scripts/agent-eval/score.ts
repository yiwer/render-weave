/**
 * 评估场景的评分（第三阶段票据 08）：沿用 M211–M217 的检查，改为只看产品路径交回的成果。
 * - 数据定义（M402）：专家版的 15 个字段按类型与名称、显示名称逐个对应；M216 的 6 项约定在数据定义上判断。
 *   数据定义提取只交数据定义（M43），所以不再像验证脚本那样从数据集反推字段。
 * - 转录（366）：站名、地标圈号与设施图标，与人工转录逐站对照（M217）。
 * - 模板（M402）：10 个压测场景（M213）与 M215 的两项版面检查；另记示例请求的问题数与相似度，只作参考。
 * - 模板（模板设计评估集，M335）：压测与版面检查由用例目录的 stress.json、checks.json 给出，在草稿的问题清单与布局摘要上判断。
 */
import { loadCanvasKit } from '../../src/canvaskit.js';
import { loadWorkspace, render, revisionDiff, type RevisionDiff, type Workspace } from '../../src/index.js';

/** 站名旁的 ①②③④ 是地标图片（M77），转录时常被并进站名；比对时去掉。 */
const CIRCLED = /[①②③④⑤⑥⑦⑧⑨]$/u;

type Field = {
  readonly name: string; readonly displayName?: string; readonly type: string; readonly items?: Field;
  readonly ref?: { readonly name: string }; readonly constraints?: Record<string, unknown>;
};
type Definition = { readonly name: string; readonly fields: readonly Field[] };

// ---------- 数据定义 ----------

/** 专家版的 15 个字段（docs/examples/m402-dsl 的线路牌 v1 与停靠站点 v1）：所在的定义、类型，以及名称或显示名称中的关键词。 */
const EXPERT_FIELDS: readonly { id: string; label: string; of: 'route' | 'stop'; type: string; match: (text: string) => boolean }[] = [
  { id: 'routeNo', label: '线路号', of: 'route', type: 'text', match: (t) => /线路号|线路编号|路号|route|line/i.test(t) },
  { id: 'routeNoImage', label: '线路号图片', of: 'route', type: 'image', match: (t) => /线路号|路号|route|line/i.test(t) },
  { id: 'fareType', label: '票制', of: 'route', type: 'text', match: (t) => /票制|票价类型|收费(方式|类型)|fare.?(type|system|mode|kind)/i.test(t) },
  { id: 'fare', label: '票价', of: 'route', type: 'number', match: (t) => /票价|金额|fare|price/i.test(t) },
  { id: 'operator', label: '运营方', of: 'route', type: 'text', match: (t) => /运营(方|企业|单位|公司|商)|公交公司|企业|公司|operator|company/i.test(t) },
  { id: 'firstDeparture', label: '首班', of: 'route', type: 'time', match: (t) => /首班|开始|起|start|first/i.test(t) && !/末班|结束|止|end|last/i.test(t) },
  { id: 'lastDeparture', label: '末班', of: 'route', type: 'time', match: (t) => /末班|结束|止|end|last/i.test(t) },
  { id: 'serviceNote', label: '运营说明', of: 'route', type: 'text', match: (t) => /说明|备注|注记|运营日|note|remark|days/i.test(t) },
  { id: 'scheduleType', label: '班车类型', of: 'route', type: 'text', match: (t) => /班车类型|班次类型|发车方式|班车方式|发车类型|schedule.?(type|kind|mode)|service.?(mode|kind|type)/i.test(t) },
  { id: 'departureTimes', label: '班次时刻', of: 'route', type: 'list<time>', match: () => true },
  { id: 'stops', label: '停靠站点', of: 'route', type: 'list<ref>', match: () => true },
  { id: 'name', label: '站名', of: 'stop', type: 'text', match: (t) => /站名|^name\b|stop.?name|station.?name/i.test(t) },
  { id: 'road', label: '所在道路', of: 'stop', type: 'text', match: (t) => /道路|路段|路名|road/i.test(t) },
  { id: 'badges', label: '站名上方的标识', of: 'stop', type: 'list<text>', match: (t) => /设施|标识|标记|换乘|badge|facilit|mark|icon/i.test(t) },
  { id: 'landmark', label: '地标', of: 'stop', type: 'image', match: (t) => /地标|landmark/i.test(t) },
];

/** M216 的 6 项约定检查。 */
export const CONVENTIONS = {
  landmark: '地标是图片字段',
  badges: '标识是文本枚举列表',
  fareIsNumber: '票价是数值',
  noTerminalField: '没有终点站字段',
  noCurrentStop: '没有本站字段',
  routeNoText: '线路号有文本字段',
} as const;
export type ConventionId = keyof typeof CONVENTIONS;

export interface DefinitionScore {
  /** 专家字段对上了几个；mapping 是专家字段到候选字段（定义名.字段名）。 */
  readonly expertFields: { readonly matched: number; readonly of: number; readonly missing: readonly string[]; readonly mapping: Readonly<Record<string, string>> };
  readonly conventions: Readonly<Record<ConventionId, boolean>>;
  readonly conventionsPassed: number;
}

/** 给一组线路牌数据定义打分：含站点列表（列表项为引用）的是主定义，被它引用的是站点定义。 */
export function scoreDefinitions(documents: readonly unknown[]): DefinitionScore {
  const definitions = documents.filter((doc): doc is Definition => isRecord(doc) && Array.isArray(doc['fields']) && typeof doc['name'] === 'string');
  const listOfRef = (field: Field) => field.type === 'list' && field.items?.type === 'ref';
  const route = definitions.find((def) => def.fields.some(listOfRef));
  const stopName = route?.fields.find(listOfRef)?.items?.ref?.name;
  const stop = definitions.find((def) => def !== route && def.name === stopName) ?? definitions.find((def) => def !== route);
  const typeOf = (field: Field) => (field.type === 'list' ? `list<${field.items?.type ?? '?'}>` : field.type);
  const text = (field: Field) => `${field.name} ${field.displayName ?? ''}`;
  const used = new Set<Field>();
  const mapping: Record<string, string> = {};
  for (const expert of EXPERT_FIELDS) {
    const def = expert.of === 'route' ? route : stop;
    const field = def?.fields.find((item) => !used.has(item) && typeOf(item) === expert.type && expert.match(text(item)));
    if (!field || !def) continue;
    used.add(field);
    mapping[expert.id] = `${def.name}.${field.name}`;
  }
  const all = definitions.flatMap((def) => def.fields);
  const routeFields = route?.fields ?? [];
  const enumOf = (field: Field) => Array.isArray(field.items?.constraints?.['enum']) || Array.isArray(field.constraints?.['enum']);
  const conventions: Record<ConventionId, boolean> = {
    landmark: 'landmark' in mapping,
    badges: (stop?.fields ?? []).some((field) => typeOf(field) === 'list<text>' && enumOf(field) && /设施|标识|标记|换乘|badge|facilit|mark|icon/i.test(text(field))),
    fareIsNumber: 'fare' in mapping,
    noTerminalField: !routeFields.some((field) => field.type !== 'list' && /终点|终到|开往|方向|terminal|destination/i.test(text(field))),
    noCurrentStop: !all.some((field) => /本站|当前站|当前停靠|current/i.test(text(field))),
    routeNoText: 'routeNo' in mapping,
  };
  return {
    expertFields: {
      matched: Object.keys(mapping).length, of: EXPERT_FIELDS.length,
      missing: EXPERT_FIELDS.filter((expert) => !(expert.id in mapping)).map((expert) => expert.label), mapping,
    },
    conventions, conventionsPassed: Object.values(conventions).filter(Boolean).length,
  };
}

// ---------- 转录 ----------

export interface TruthStop { readonly name: string; readonly landmark?: number; readonly facilities?: readonly string[] }

interface StopPosition { readonly candidatePosition: number; readonly candidateName: string }
interface TruthPosition { readonly truthPosition: number; readonly truthName: string }
export interface TranscriptionAlignment {
  readonly kind: 'match' | 'substitution' | 'omission' | 'insertion' | 'duplicate' | 'moved';
  readonly candidatePosition?: number; readonly truthPosition?: number;
  readonly candidateName?: string; readonly truthName?: string;
}
const TRANSCRIPTION_SCORER = {
  version: 'renderweave-transcription/3',
  matchingPolicy: { id: 'ordered-occurrences/1', exact: 0, singleCharacterEdit: 1, otherSubstitution: 2, insertion: 1, omission: 1,
    nameNormalization: 'trim-trailing-circled-digit', tieBreak: 'diagonal-insertion-omission-for-diagnostics-only',
    surplusExactName: 'never-single-character-tolerance', reorder: 'exact-occurrence-links-before-residual-edits', annotations: 'compare-only-after-name-alignment', landmarkReferences: 'all-occurrences-multiset', ambiguity: 'all-optimal-correspondences-require-review' },
} as const;
interface AlignmentAmbiguity {
  readonly candidatePosition?: number; readonly truthPosition?: number;
  readonly possibleTruthPositions?: readonly (number | null)[];
  readonly possibleCandidatePositions?: readonly (number | null)[];
}
interface AnnotationError { readonly candidatePosition?: number; readonly truthPosition?: number; readonly value: string | number }
export interface TranscriptionScore {
  /** 交回的站数 / 真值站数。 */
  readonly stops: string;
  /** 一对一完全同名的出现次数；有顺序违例仍不通过。 */
  readonly names: number;
  readonly namesInOrder: number;
  readonly scorer: typeof TRANSCRIPTION_SCORER;
  readonly alignment: readonly TranscriptionAlignment[];
  readonly ambiguities: readonly AlignmentAmbiguity[];
  readonly requiresReview: boolean;
  readonly errors: {
    readonly orderViolations: readonly { readonly candidatePosition: number; readonly truthPosition: number }[];
    readonly insertions: readonly StopPosition[];
    readonly duplicates: readonly (StopPosition & { readonly truthPositions: readonly number[] })[];
    readonly substitutions: readonly (StopPosition & TruthPosition)[];
    readonly omissions: readonly TruthPosition[];
    readonly landmarkMissing: readonly AnnotationError[];
    readonly landmarkExtra: readonly AnnotationError[];
    readonly facilityMissing: readonly AnnotationError[];
    readonly facilityExtra: readonly AnnotationError[];
  };
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly landmarks: { readonly matched: number; readonly of: number; readonly extra: number };
  readonly facilities: { readonly matched: number; readonly of: number; readonly extra: number };
}

const FACILITY_NAMES: readonly [RegExp, string][] = [[/地铁|metro|subway/i, '地铁'], [/医院|hospital|medical/i, '医院']];

/** 按人工转录真值给站点打分：地标比较 res:landmark-N 的 N，设施比较文本列表（中英文写法统一）。 */
export function scoreTranscription(stops: readonly Record<string, unknown>[], truth: readonly TruthStop[]): TranscriptionScore {
  const truthNames = truth.map((stop) => stop.name);
  const nameKey = [...new Set(stops.flatMap((stop) => Object.keys(stop)))]
    .map((key) => [key, stops.filter((stop) => truthNames.includes(String(stop[key]).replace(CIRCLED, '').trim())).length] as const)
    .sort((a, b) => b[1] - a[1])[0]?.[0];
  const names = stops.map((stop) => String(nameKey === undefined ? '' : stop[nameKey] ?? '').replace(CIRCLED, '').trim());
  const used = new Set<number>();
  const occurrences = names.flatMap((name, candidate) => {
    const expected = truthNames.findIndex((value, index) => value === name && !used.has(index));
    if (expected < 0) return [];
    used.add(expected);
    return [{ candidatePosition: candidate + 1, truthPosition: expected + 1 }];
  });
  const orderViolations = occurrences.filter((entry, index) => occurrences.some((other, otherIndex) =>
    (otherIndex < index && other.truthPosition > entry.truthPosition) || (otherIndex > index && other.truthPosition < entry.truthPosition)));
  const aligned = alignStops(names, truthNames);
  const ambiguities = aligned.ambiguities;
  // 已证实的移位用同名出现连接表示，避免编辑距离把反序解释成大量错别字。
  // 只有未被这些连接使用的出现才保留替换；任何原有歧义仍需复核。
  const alignment: TranscriptionAlignment[] = orderViolations.length === 0 ? aligned.alignment : (() => {
    const linkedCandidates = new Set(occurrences.map((entry) => entry.candidatePosition));
    const linkedTruth = new Set(occurrences.map((entry) => entry.truthPosition));
    const rows: TranscriptionAlignment[] = occurrences.map((entry) => ({ ...entry,
      kind: orderViolations.some((moved) => moved.candidatePosition === entry.candidatePosition) ? 'moved' : 'match',
      candidateName: names[entry.candidatePosition - 1]!, truthName: truthNames[entry.truthPosition - 1]!,
    }));
    for (const row of aligned.alignment) {
      if (row.kind !== 'substitution' || linkedCandidates.has(row.candidatePosition!) || linkedTruth.has(row.truthPosition!)) continue;
      rows.push(row); linkedCandidates.add(row.candidatePosition!); linkedTruth.add(row.truthPosition!);
    }
    names.forEach((name, index) => {
      if (!linkedCandidates.has(index + 1)) rows.push({ kind: truthNames.includes(name) ? 'duplicate' : 'insertion', candidatePosition: index + 1, candidateName: name });
    });
    truthNames.forEach((name, index) => {
      if (!linkedTruth.has(index + 1)) rows.push({ kind: 'omission', truthPosition: index + 1, truthName: name });
    });
    return rows.sort((a, b) => (a.candidatePosition ?? Infinity) - (b.candidatePosition ?? Infinity));
  })();
  const insertions = alignment.filter((entry) => entry.kind === 'insertion').map((entry) => ({ candidatePosition: entry.candidatePosition!, candidateName: entry.candidateName! }));
  const duplicates = alignment.filter((entry) => entry.kind === 'duplicate').map((entry) => ({ candidatePosition: entry.candidatePosition!, candidateName: entry.candidateName!,
    truthPositions: truthNames.flatMap((name, index) => name === entry.candidateName ? [index + 1] : []),
  }));
  const substitutions = alignment.filter((entry) => entry.kind === 'substitution').map((entry) => ({ candidatePosition: entry.candidatePosition!, truthPosition: entry.truthPosition!, candidateName: entry.candidateName!, truthName: entry.truthName! }));
  const omissions = alignment.filter((entry) => entry.kind === 'omission').map((entry) => ({ truthPosition: entry.truthPosition!, truthName: entry.truthName! }));
  const landmarksOf = (value: unknown): number[] => typeof value === 'string'
    ? [...value.matchAll(/res:landmark-(\d+)/g)].map(match => Number(match[1]))
    : Array.isArray(value) ? value.flatMap(landmarksOf)
      : isRecord(value) ? Object.values(value).flatMap(landmarksOf) : [];
  const facility = (value: string) => FACILITY_NAMES.find(([pattern]) => pattern.test(value))?.[1] ?? value;
  const facilitiesOf = (stop: Record<string, unknown> | undefined) => Object.values(stop ?? {})
    .filter((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && !item.startsWith('res:')))
    .flat().map(facility).sort();
  const landmarkMissing: AnnotationError[] = [], landmarkExtra: AnnotationError[] = [];
  const facilityMissing: AnnotationError[] = [], facilityExtra: AnnotationError[] = [];
  let landmarkMatched = 0, facilityMatched = 0;
  for (const row of alignment) {
    const expected = row.truthPosition === undefined ? undefined : truth[row.truthPosition - 1];
    const actual = row.candidatePosition === undefined ? undefined : stops[row.candidatePosition - 1];
    const position = { candidatePosition: row.candidatePosition, truthPosition: row.truthPosition };
    const marks = landmarksOf(actual);
    if (expected?.landmark !== undefined) {
      const index = marks.indexOf(expected.landmark);
      if (index < 0) landmarkMissing.push({ ...position, value: expected.landmark });
      else { landmarkMatched++; marks.splice(index, 1); }
    }
    landmarkExtra.push(...marks.map(value => ({ ...position, value })));
    const wanted = [...(expected?.facilities ?? [])].map(facility).sort(), got = facilitiesOf(actual);
    if (wanted.length > 0 && wanted.join('+') === got.join('+')) facilityMatched++;
    // 多重集合：多报同一设施不能被集合去重吞掉。
    const remaining = [...got];
    for (const value of wanted) {
      const index = remaining.indexOf(value);
      if (index < 0) facilityMissing.push({ ...position, value });
      else remaining.splice(index, 1);
    }
    facilityExtra.push(...remaining.map((value) => ({ ...position, value })));
  }
  return {
    stops: `${stops.length}/${truth.length}`,
    names: alignment.filter((entry) => entry.kind === 'match' || entry.kind === 'moved').length, namesInOrder: lcs(names, truthNames),
    scorer: TRANSCRIPTION_SCORER, alignment, ambiguities, requiresReview: ambiguities.length > 0, errors: { orderViolations, insertions, duplicates, substitutions, omissions, landmarkMissing, landmarkExtra, facilityMissing, facilityExtra },
    missing: alignment.filter((row) => row.kind === 'omission' || row.kind === 'substitution').map((row) => row.truthName!),
    unexpected: alignment.filter((row) => ['insertion', 'duplicate', 'substitution'].includes(row.kind)).map((row) => row.candidateName!),
    landmarks: { matched: landmarkMatched, of: truth.filter((stop) => stop.landmark !== undefined).length, extra: landmarkExtra.length },
    facilities: { matched: facilityMatched, of: truth.filter((stop) => stop.facilities?.length).length, extra: facilityExtra.length },
  };
}

/** 有序编辑对齐：单字增删改代价 1，其他替换代价 2，漏项/插入各 1；位置从 1 开始。 */
function alignStops(candidate: readonly string[], truth: readonly string[]): { alignment: TranscriptionAlignment[]; ambiguities: AlignmentAmbiguity[] } {
  const n = candidate.length, m = truth.length;
  const costs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  const surplusNames = new Set(candidate.filter((name) => truth.includes(name) && candidate.filter((value) => value === name).length > truth.filter((value) => value === name).length));
  const substitutionCost = (i: number, j: number) => candidate[i] === truth[j] ? 0 :
    !surplusNames.has(candidate[i]!) && oneCharacterEdit(candidate[i]!, truth[j]!) ? 1 : 2;
  for (let i = n; i >= 0; i--) for (let j = m; j >= 0; j--) {
    if (i === n) costs[i]![j] = m - j;
    else if (j === m) costs[i]![j] = n - i;
    else costs[i]![j] = Math.min(substitutionCost(i, j) + costs[i + 1]![j + 1]!, 1 + costs[i + 1]![j]!, 1 + costs[i]![j + 1]!);
  }
  // 遍历最优路径的 DAG，收集所有可能对应，而不是枚举指数数量的路径或按地标挑选。
  const candidates = Array.from({ length: n }, () => new Set<number | null>());
  const expected = Array.from({ length: m }, () => new Set<number | null>());
  const visited = new Set<number>(), pending: [number, number][] = [[0, 0]];
  while (pending.length > 0) {
    const [i, j] = pending.pop()!;
    const key = i * (m + 1) + j;
    if (visited.has(key)) continue;
    visited.add(key);
    if (i < n && j < m && costs[i]![j] === substitutionCost(i, j) + costs[i + 1]![j + 1]!) {
      candidates[i]!.add(j + 1); expected[j]!.add(i + 1); pending.push([i + 1, j + 1]);
    }
    if (i < n && costs[i]![j] === 1 + costs[i + 1]![j]!) {
      candidates[i]!.add(null); pending.push([i + 1, j]);
    }
    if (j < m && costs[i]![j] === 1 + costs[i]![j + 1]!) {
      expected[j]!.add(null); pending.push([i, j + 1]);
    }
  }
  const ordered = (values: Set<number | null>) => [...values].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const ambiguities: AlignmentAmbiguity[] = [
    ...candidates.flatMap((values, index) => values.size > 1 ? [{ candidatePosition: index + 1, possibleTruthPositions: ordered(values) }] : []),
    ...expected.flatMap((values, index) => values.size > 1 ? [{ truthPosition: index + 1, possibleCandidatePositions: ordered(values) }] : []),
  ];
  const rows: TranscriptionAlignment[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !(surplusNames.has(candidate[i]!) && candidate[i] !== truth[j]) && costs[i]![j] === substitutionCost(i, j) + costs[i + 1]![j + 1]!) {
      rows.push({ kind: candidate[i] === truth[j] ? 'match' : 'substitution', candidatePosition: i + 1, truthPosition: j + 1, candidateName: candidate[i]!, truthName: truth[j]! });
      i++; j++;
    } else if (i < n && costs[i]![j] === 1 + costs[i + 1]![j]!) {
      rows.push({ kind: 'insertion', candidatePosition: i + 1, candidateName: candidate[i]! }); i++;
    } else {
      rows.push({ kind: 'omission', truthPosition: j + 1, truthName: truth[j]! }); j++;
    }
  }
  // 被有序对齐排除的同名出现是移位，不能把它同时算作真实插入与漏项。
  const removed = new Set<TranscriptionAlignment>();
  const result = rows.map((row): TranscriptionAlignment => {
    if (row.kind !== 'insertion') return row;
    const omitted = rows.find((other) => other.kind === 'omission' && !removed.has(other) && other.truthName === row.candidateName);
    if (omitted) {
      removed.add(omitted);
      return { ...row, kind: 'moved', truthPosition: omitted.truthPosition!, truthName: omitted.truthName! };
    }
    return { ...row, kind: truth.includes(row.candidateName!) ? 'duplicate' : 'insertion' };
  });
  return { alignment: result.filter((row) => !removed.has(row)), ambiguities };
}

function oneCharacterEdit(a: string, b: string): boolean {
  const left = [...a], right = [...b];
  if (Math.abs(left.length - right.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (left.length <= right.length) j++;
  }
  return edits + left.length - i + right.length - j === 1;
}

/** 数据集中的站点列表：数据里第一个对象列表。 */
export function stopsOf(dataset: unknown): Record<string, unknown>[] {
  const data = isRecord(dataset) && isRecord(dataset['data']) ? dataset['data'] : {};
  const list = Object.values(data).find((value) => Array.isArray(value) && value.length >= 2 && value.every(isRecord));
  return (list as Record<string, unknown>[] | undefined) ?? [];
}

// ---------- 模板 ----------

export interface StressResult { readonly label: string; readonly severe: number; readonly hint: number; readonly codes: readonly string[] }

export interface TemplateScore {
  /** 示例图对应的请求按 120 DPI 草稿出图：问题数，以及缩小 8 倍后与示例图的相似度（1 − 平均绝对差 / 255）。只作参考。 */
  readonly sample: { readonly severe: number; readonly hint: number; readonly similarity?: number };
  readonly stress: readonly StressResult[];
  /** 没有严重问题的压测场景数。 */
  readonly stressPassed: number;
  /** M215 约定一（M402）：无地标站名的底边与地标底边齐平，差值毫米，2 mm 以内通过。 */
  readonly landmarkBaseline?: { readonly found: boolean; readonly deltaMm?: number; readonly pass: boolean; readonly reason?: string };
  /** M215 约定二（M402）：绑定 road 的文字为同间隔分布。 */
  readonly roadAlign?: { readonly aligns: readonly string[]; readonly pass: boolean };
  /** 模板设计评估集：checks.json 逐项的结果（M335）。 */
  readonly checks?: readonly CheckResult[];
  readonly layoutPassed: number;
  /** 版面检查的项数：M402 是 M215 的两项，评估集是 checks.json 的项数。 */
  readonly layoutTotal: number;
}

export interface RevisionScore {
  readonly templates: readonly { readonly name: string; readonly status: RevisionDiff['status'] }[];
  /** 修改要求没有点名、却被改动的已保存模板。 */
  readonly violations: readonly string[];
  /** 已保存模板中发生增删改的元素路径数（含画板，不含模板层参数等），只作参考。 */
  readonly changedElements: number;
}

/** 按模板名比较工作副本；没交回的模板保留已保存内容。新增模板不属于本场景的已保存模板范围检查。 */
export function scoreRevision(saved: Workspace['templates'], candidates: Workspace['templates'], allowed: readonly string[]): RevisionScore {
  const byName = new Map(candidates.map((entry) => [entry.name, entry.document]));
  const diffs = saved.map((entry) => ({ name: entry.name, ...revisionDiff(entry.document, byName.get(entry.name) ?? entry.document) }));
  return {
    templates: diffs.map(({ name, status }) => ({ name, status })),
    violations: diffs.filter((entry) => entry.status !== 'unchanged' && !allowed.includes(entry.name)).map((entry) => entry.name),
    changedElements: diffs.reduce((total, entry) => total + entry.changes.filter((change) => change.target === 'element').length, 0),
  };
}

/**
 * 给模板打分：templates 叠加在 workspaceDir（专家版数据定义与数据集）上，按主模板出图。
 * 压测用专家版验收过的场景：本站 0/1/末站、2/20/50 站、12 字长站名、740 与 1500 mm；草稿 30 DPI。
 */
export async function scoreTemplates(options: {
  readonly workspaceDir: string;
  readonly resourcesDir: string;
  readonly templates: readonly { readonly name: string; readonly document: unknown }[];
  readonly mainTemplate: string;
  readonly datasetId: string;
  readonly sample: Uint8Array;
}): Promise<TemplateScore> {
  const base = await loadWorkspace({ dir: options.workspaceDir, resourcesDir: options.resourcesDir });
  const names = new Set(options.templates.map((entry) => entry.name));
  const workspace: Workspace = { ...base, templates: [...base.templates.filter((entry) => !names.has(entry.name)), ...options.templates] };
  const dataset = base.datasets.find((entry) => entry.id === options.datasetId);
  if (!dataset) throw new Error(`工作区中没有数据集 ${options.datasetId}`);
  const stops = (dataset.document.data as { stops: Record<string, unknown>[] }).stops;

  const sampleRequest = { template: options.mainTemplate, dataset: { id: options.datasetId }, parameters: { currentIndex: 5 },
    output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'draft' };
  const sampleResult = await render(workspace, sampleRequest);
  const severeOf = (problems: readonly { level: string }[]) => problems.filter((problem) => problem.level === 'severe').length;
  const sample = {
    severe: severeOf(sampleResult.problems), hint: sampleResult.problems.length - severeOf(sampleResult.problems),
    ...(sampleResult.image ? { similarity: await similarity(sampleResult.image.bytes, options.sample) } : {}),
  };

  const extra = Array.from({ length: 15 }, (_, i) => ({ name: `${['新城', '科技', '文化', '体育', '滨海'][i % 5]}${['东', '西', '南'][Math.floor(i / 5)]}站`, road: i < 8 ? '新城大道' : '滨海路' }));
  const scenarios: [string, Record<string, unknown>[], number, number][] = [
    ['35 站本站 5', stops, 5, 740], ['本站 0', stops, 0, 740], ['本站 1', stops, 1, 740], ['本站 35', stops, 35, 740],
    ['2 站', stops.slice(0, 2), 1, 740], ['20 站', stops.slice(0, 20), 5, 740], ['50 站 740', [...stops, ...extra], 5, 740],
    ['50 站 1500', [...stops, ...extra], 5, 1500], ['35 站 1500', stops, 5, 1500],
    ['12 字站名', stops.map((stop, i) => (i === 10 ? { ...stop, name: '李朗国际珠宝园北门公交站' } : stop)), 5, 740],
  ];
  const stress: StressResult[] = [];
  for (const [label, list, currentIndex, width] of scenarios) {
    const result = await render(workspace, {
      template: options.mainTemplate, parameters: { currentIndex }, mode: 'draft', output: { width, height: 165, dpi: 30, format: 'png' },
      dataset: { inline: { dataset: { staticSchema: dataset.document.dataset.staticSchema }, data: { ...(dataset.document.data as object), stops: list } } },
    });
    const severe = result.problems.filter((problem) => problem.level === 'severe');
    stress.push({ label, severe: severe.length, hint: result.problems.length - severe.length, codes: [...new Set(severe.map((problem) => problem.code))] });
  }
  const landmark = sampleResult.layout ? landmarkBaseline(sampleResult.layout, stops) : { found: false, pass: false, reason: '没有布局摘要' };
  const road = roadAlign(options.templates.map((entry) => entry.document));
  return {
    sample, stress, stressPassed: stress.filter((row) => row.severe === 0).length,
    landmarkBaseline: landmark, roadAlign: road, layoutPassed: [landmark.pass, road.pass].filter(Boolean).length, layoutTotal: 2,
  };
}

// ---------- 模板（模板设计评估集，M335）----------

/**
 * 在用例的示例数据集上改数据：键是路径（`a`、`a.b`、`a[0].b`，序号从 0 开始），按写的顺序执行。
 * 值为 null 时删掉该键；`{"$take": {"from": 列表路径, "count": n}}` 从原数据集的列表循环取 n 项，用来缩短或加长列表。
 */
export type DataPatch = Readonly<Record<string, unknown>>;

/** 压测与版面检查的一种出图变化：改数据、改对外参数、改输出宽高（毫米）。 */
export interface Variation {
  readonly data?: DataPatch;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly output?: { readonly width?: number; readonly height?: number };
}

export interface StressSpec {
  /** 草稿 DPI，缺省取示例请求的 DPI；大尺寸的牌子写 30，与 M402 压测相同。 */
  readonly dpi?: number;
  readonly cases: readonly (Variation & { readonly label: string })[];
}

/**
 * 一项版面检查，在示例请求（或 variant 改过的请求）的草稿布局摘要上判断：
 * - text：有可见文字（文字元素，或条码自带的下方文字）的内容含 text 中的任一个（去掉空白后比较），可再限字号范围、颜色（与片段颜色的 RGB 距离不超过 100）；
 * - image：有可见图片引用 source 中的任一个资源；
 * - barcode / qrcode：有可见的条码（可限格式）/ 二维码；
 * - largest：字号最大的文字片段含 text 中的任一个。
 * region 限元素框中心在画板上的相对位置（0–1）；absent 为 true 时断言找不到。
 */
export interface CaseCheck {
  readonly label: string;
  readonly kind: 'text' | 'image' | 'barcode' | 'qrcode' | 'largest';
  readonly text?: string | readonly string[];
  readonly source?: string | readonly string[];
  readonly format?: string;
  readonly minFontSize?: number;
  readonly maxFontSize?: number;
  readonly color?: string;
  readonly region?: { readonly x?: readonly [number, number]; readonly y?: readonly [number, number] };
  readonly absent?: boolean;
  readonly variant?: Variation;
}

export interface CheckResult { readonly label: string; readonly pass: boolean; readonly detail?: string }

type LayoutNode = {
  type: string; path: string; x: number; y: number; width: number; height: number; visible: boolean;
  text?: TextSummary;
  image?: { source: string; drawn: Box };
  barcode?: { format: string; symbol: Box; label?: { box: Box; text: TextSummary } };
  qrcode?: { symbol: Box };
  children?: LayoutNode[];
};
type Box = { x: number; y: number; width: number; height: number };
type TextSummary = { content: string; fontSize: number; fragments: { text: string; fontSize: number; color: string; placeholder?: true }[] };
type Layout = { output: { width: number; height: number }; root: LayoutNode };

/** 按 DataPatch 改一份数据，不改原对象。 */
export function patchData(data: Readonly<Record<string, unknown>>, patch: DataPatch = {}): Record<string, unknown> {
  const result = structuredClone(data) as Record<string, unknown>;
  for (const [path, value] of Object.entries(patch)) {
    const keys = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) => (match[2] === undefined ? match[1]! : Number(match[2])));
    const take = isRecord(value) && isRecord(value['$take']) ? value['$take'] : undefined;
    const next = take ? cycle(read(data, String(take['from'])), Number(take['count'])) : value;
    let target: unknown = result;
    for (const key of keys.slice(0, -1)) target = (target as Record<string | number, unknown>)[key];
    if (typeof target !== 'object' || target === null) throw new Error(`改数据的路径不存在：${path}`);
    const last = keys[keys.length - 1]!;
    if (next === null) {
      if (Array.isArray(target) && typeof last === 'number') target.splice(last, 1);
      else delete (target as Record<string | number, unknown>)[last];
    } else {
      (target as Record<string | number, unknown>)[last] = structuredClone(next);
    }
  }
  return result;
}

function read(data: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), data);
}

function cycle(list: unknown, count: number): unknown[] {
  if (!Array.isArray(list) || list.length === 0 || !Number.isSafeInteger(count) || count < 0) throw new Error('$take 要从非空列表取非负整数项');
  return Array.from({ length: count }, (_, index) => structuredClone(list[index % list.length]) as unknown);
}

/** 按布局摘要判断一项检查。 */
export function evaluateCheck(check: CaseCheck, layout: Layout): CheckResult {
  const nodes: LayoutNode[] = [];
  (function walk(node: LayoutNode) { if (node.visible) { nodes.push(node); for (const child of node.children ?? []) walk(child); } })(layout.root);
  const strip = (value: string) => value.replace(/[\s　]/gu, '');
  const wanted = (value: string | readonly string[] | undefined) => (value === undefined ? [] : typeof value === 'string' ? [value] : [...value]).map(strip);
  const inRegion = (box: { x: number; y: number; width: number; height: number }) => {
    const cx = (box.x + box.width / 2) / layout.output.width, cy = (box.y + box.height / 2) / layout.output.height;
    const within = (range: readonly [number, number] | undefined, value: number) => !range || (value >= range[0] && value <= range[1]);
    return within(check.region?.x, cx) && within(check.region?.y, cy);
  };
  // 文字既有文字元素，也有条码自带的下方文字（showText）。
  const texts = nodes.flatMap((node) => [
    ...(node.text ? [{ text: node.text, box: node as Box }] : []),
    ...(node.barcode?.label ? [{ text: node.barcode.label.text, box: node.barcode.label.box }] : []),
  ]);
  const has = (text: TextSummary) => wanted(check.text).some((value) => strip(text.content).includes(value));
  let found: Box[] = [];
  let detail: string | undefined;
  if (check.kind === 'largest') {
    const fragments = texts.flatMap((entry) => entry.text.fragments.filter((fragment) => !fragment.placeholder && strip(fragment.text) !== '').map((fragment) => ({ ...entry, fragment })));
    const max = Math.max(0, ...fragments.map((entry) => entry.fragment.fontSize));
    const top = fragments.filter((entry) => entry.fragment.fontSize >= max - 0.01);
    found = top.filter((entry) => wanted(check.text).some((text) => strip(entry.fragment.text).includes(text))).map((entry) => entry.box);
    detail = `最大字号 ${max.toFixed(1)} mm：${[...new Set(top.map((entry) => entry.fragment.text))].join('、') || '没有文字'}`;
  } else if (check.kind === 'text') {
    const near = texts.filter((entry) => has(entry.text));
    found = near.filter(({ text }) => {
      if (check.minFontSize !== undefined && text.fontSize < check.minFontSize) return false;
      if (check.maxFontSize !== undefined && text.fontSize > check.maxFontSize) return false;
      return check.color === undefined || text.fragments.some((fragment) => colorDistance(fragment.color, check.color!) <= 100);
    }).map((entry) => entry.box);
    if (found.length === 0 && near.length > 0) detail = `文字在，但${near.map(({ text }) => `${text.fontSize.toFixed(1)} mm ${text.fragments.map((fragment) => fragment.color).join('/')}`).join('；')}`;
  } else if (check.kind === 'image') {
    found = nodes.filter((node) => node.image && wanted(check.source).includes(node.image.source)).map((node) => node.image!.drawn);
  } else if (check.kind === 'barcode') {
    found = nodes.filter((node) => node.barcode && (check.format === undefined || node.barcode.format === check.format)).map((node) => node.barcode!.symbol);
  } else {
    found = nodes.filter((node) => node.qrcode).map((node) => node.qrcode!.symbol);
  }
  const placed = found.filter(inRegion);
  if (placed.length === 0 && found.length > 0) {
    const where = found[0]!;
    detail = `位置不对：中心在 (${((where.x + where.width / 2) / layout.output.width).toFixed(2)}, ${((where.y + where.height / 2) / layout.output.height).toFixed(2)})`;
  }
  const pass = check.absent ? placed.length === 0 : placed.length > 0;
  return { label: check.label, pass, ...(pass || detail === undefined ? {} : { detail }) };
}

function colorDistance(a: string, b: string): number {
  const rgb = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!);
}

/**
 * 模板设计评估集的一个用例打分：templates 叠加在用例工作区（专家版数据定义与数据集）上，按用例的示例请求出图。
 * 压测按 stress.json 改数据、参数或尺寸，草稿出图记严重问题；版面检查按 checks.json 在布局摘要上判断。
 * 示例请求按草稿出图的问题数与相似度只作参考；相似度按示例请求的宽高比缩到 400 像素宽比较。
 * 压测缺省按示例请求的 DPI，stress.json 可另写；版面检查与示例图按示例请求的 DPI。
 */
export async function scoreTemplateCase(options: {
  readonly workspaceDir: string;
  readonly resourcesDir: string;
  readonly templates: readonly { readonly name: string; readonly document: unknown }[];
  readonly request: { readonly template: string; readonly parameters?: Readonly<Record<string, unknown>>; readonly output: { readonly width: number; readonly height: number; readonly dpi: number } };
  readonly datasetId: string;
  readonly stress: StressSpec;
  readonly checks: readonly CaseCheck[];
  readonly sample: Uint8Array;
}): Promise<TemplateScore> {
  const base = await loadWorkspace({ dir: options.workspaceDir, resourcesDir: options.resourcesDir });
  const names = new Set(options.templates.map((entry) => entry.name));
  const workspace: Workspace = { ...base, templates: [...base.templates.filter((entry) => !names.has(entry.name)), ...options.templates] };
  const dataset = base.datasets.find((entry) => entry.id === options.datasetId);
  if (!dataset) throw new Error(`工作区中没有数据集 ${options.datasetId}`);
  const data = dataset.document.data as Record<string, unknown>;
  // 示例图与版面检查按示例请求的 DPI 出草稿：条码、二维码的模块像素与 Agent 用 request.json 自查时相同。
  const { width, height, dpi: sampleDpi } = options.request.output;
  const draft = (variation: Variation, dpi: number) => render(workspace, {
    template: options.request.template, mode: 'draft', parameters: { ...options.request.parameters, ...variation.parameters },
    output: { width: variation.output?.width ?? width, height: variation.output?.height ?? height, dpi, format: 'png' },
    dataset: variation.data
      ? { inline: { dataset: { staticSchema: dataset.document.dataset.staticSchema }, data: patchData(data, variation.data) } }
      : { id: options.datasetId },
  });
  const severeOf = <P extends { level: string }>(problems: readonly P[]) => problems.filter((problem) => problem.level === 'severe');

  const sampleResult = await draft({}, sampleDpi);
  const shrinkHeight = Math.max(1, Math.round((400 * height) / width));
  const sample = {
    severe: severeOf(sampleResult.problems).length, hint: sampleResult.problems.length - severeOf(sampleResult.problems).length,
    ...(sampleResult.image ? { similarity: await similarity(sampleResult.image.bytes, options.sample, 400, shrinkHeight) } : {}),
  };

  const stress: StressResult[] = [];
  for (const row of options.stress.cases) {
    const result = await draft(row, options.stress.dpi ?? sampleDpi);
    const severe = severeOf(result.problems);
    stress.push({ label: row.label, severe: severe.length, hint: result.problems.length - severe.length, codes: [...new Set(severe.map((problem) => problem.code))] });
  }

  const layouts = new Map<string, Layout | undefined>([['{}', sampleResult.layout as Layout | undefined]]);
  const checks: CheckResult[] = [];
  for (const check of options.checks) {
    const key = JSON.stringify(check.variant ?? {});
    if (!layouts.has(key)) layouts.set(key, (await draft(check.variant ?? {}, sampleDpi)).layout as Layout | undefined);
    const layout = layouts.get(key);
    checks.push(layout ? evaluateCheck(check, layout) : { label: check.label, pass: false, detail: '没有布局摘要' });
  }
  return {
    sample, stress, stressPassed: stress.filter((row) => row.severe === 0).length,
    checks, layoutPassed: checks.filter((check) => check.pass).length, layoutTotal: checks.length,
  };
}

/** M215 约定一：取第 1 站（无地标）与第 4 站（有地标），比较无地标站名的底边与地标图片的底边。 */
export function landmarkBaseline(layout: { root: unknown }, stops: readonly Record<string, unknown>[]): NonNullable<TemplateScore['landmarkBaseline']> {
  if (stops.length < 4) return { found: false, pass: false, reason: '数据集不足 4 站' };
  type Node = { type?: string; path?: string; x?: number; y?: number; height?: number; visible?: boolean; text?: { content?: string; writingMode?: string }; children?: Node[] };
  const nodes: Node[] = [];
  (function walk(node: Node) { nodes.push(node); for (const child of node.children ?? []) walk(child); })(layout.root as Node);
  const visible = nodes.filter((node) => node.visible !== false && typeof node.y === 'number');
  // 比较前去掉首尾空白（含全角空格）：有的模板用空格给地标占位。
  const name = (content: unknown) => visible.find((node) => node.type === 'text' && node.text?.content?.trim() === content && node.text?.writingMode === 'vertical');
  const plain = name(stops[0]!['name']), marked = name(stops[3]!['name']);
  if (!plain || !marked) return { found: false, pass: false, reason: '找不到第 1 站或第 4 站的竖排站名' };
  const prefix = marked.path!.slice(0, marked.path!.lastIndexOf(']') + 1);
  const landmark = visible.filter((node) => node.type === 'image' && node.path!.startsWith(prefix) && node.y! >= marked.y!).sort((a, b) => b.y! - a.y!)[0];
  if (!landmark) return { found: false, pass: false, reason: '有地标的列中找不到地标图片' };
  const deltaMm = Number((plain.y! + plain.height! - (landmark.y! + landmark.height!)).toFixed(2));
  return { found: true, deltaMm, pass: Math.abs(deltaMm) <= 2 };
}

/** M215 约定二：静态检查模板中插槽绑定 road 的文字元素是否都是 spaceEvenly。 */
export function roadAlign(templates: readonly unknown[]): NonNullable<TemplateScore['roadAlign']> {
  const aligns: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!isRecord(value)) return;
    const content = value['content'];
    if (value['type'] === 'text' && Array.isArray(content) && content.some((part) => isRecord(part) && typeof part['slot'] === 'string' && /(^|\.)road$/.test(part['slot']))) {
      aligns.push(typeof value['horizontalAlign'] === 'string' ? value['horizontalAlign'] : 'start');
    }
    Object.values(value).forEach(walk);
  };
  templates.forEach(walk);
  return { aligns, pass: aligns.length > 0 && aligns.every((align) => align === 'spaceEvenly') };
}

/** 两张图都缩到同一尺寸后逐像素比较；缺省 437 × 98 是 M402 历次报告的口径。 */
async function similarity(a: Uint8Array, b: Uint8Array, width = 437, height = 98): Promise<number> {
  const ck = await loadCanvasKit();
  const shrink = (bytes: Uint8Array) => {
    const image = ck.MakeImageFromEncoded(bytes)!;
    const surface = ck.MakeSurface(width, height)!;
    surface.getCanvas().drawImageRect(image, ck.XYWHRect(0, 0, image.width(), image.height()), ck.XYWHRect(0, 0, width, height), new ck.Paint());
    const pixels = surface.makeImageSnapshot().readPixels(0, 0, { width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
    image.delete();
    surface.delete();
    return pixels;
  };
  const x = shrink(a), y = shrink(b);
  let sum = 0, n = 0;
  for (let i = 0; i < x.length; i += 4) for (let c = 0; c < 3; c++) { sum += Math.abs(x[i + c]! - y[i + c]!); n++; }
  return Number((1 - sum / n / 255).toFixed(4));
}

function lcs(a: readonly string[], b: readonly string[]): number {
  const d = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i]![j] = a[i - 1] === b[j - 1] ? d[i - 1]![j - 1]! + 1 : Math.max(d[i - 1]![j]!, d[i]![j - 1]!);
  return d[a.length]![b.length]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
