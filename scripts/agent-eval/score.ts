/**
 * 评估场景的评分（第三阶段票据 08）：沿用 M211–M217 的检查，改为只看产品路径交回的成果。
 * - 数据定义（M402）：专家版的 15 个字段按类型与名称、显示名称逐个对应；M216 的 6 项约定在数据定义上判断。
 *   数据定义提取只交数据定义（M43），所以不再像验证脚本那样从数据集反推字段。
 * - 转录（366）：站名、地标圈号与设施图标，与人工转录逐站对照（M217）。
 * - 模板（M402）：10 个压测场景（M213）与 M215 的两项版面检查；另记示例请求的问题数与相似度，只作参考。
 */
import { loadCanvasKit } from '../../src/canvaskit.js';
import { loadWorkspace, render, type Workspace } from '../../src/index.js';

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

export interface TranscriptionScore {
  /** 交回的站数 / 真值站数。 */
  readonly stops: string;
  /** 与真值站名完全一致的站数（按站名对齐，不按位置，免得漏一站后全部错位）。 */
  readonly names: number;
  readonly namesInOrder: number;
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
  const byName = new Map(stops.map((stop, index) => [names[index]!, stop]));
  const landmarkOf = (stop: Record<string, unknown> | undefined) => {
    const match = Object.values(stop ?? {}).map(String).join(' ').match(/res:landmark-(\d+)/);
    return match ? Number(match[1]) : undefined;
  };
  const facility = (value: string) => FACILITY_NAMES.find(([pattern]) => pattern.test(value))?.[1] ?? value;
  const facilitiesOf = (stop: Record<string, unknown> | undefined) => Object.values(stop ?? {})
    .filter((value): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && !item.startsWith('res:')))
    .flat().map(facility).sort().join('+');
  const found = truth.filter((stop) => byName.has(stop.name));
  return {
    stops: `${stops.length}/${truth.length}`,
    names: found.length, namesInOrder: lcs(names, truthNames),
    missing: truth.filter((stop) => !byName.has(stop.name)).map((stop) => stop.name),
    unexpected: names.filter((name) => !truthNames.includes(name)),
    landmarks: {
      matched: found.filter((stop) => stop.landmark !== undefined && landmarkOf(byName.get(stop.name)) === stop.landmark).length,
      of: truth.filter((stop) => stop.landmark !== undefined).length,
      extra: found.filter((stop) => stop.landmark === undefined && landmarkOf(byName.get(stop.name)) !== undefined).length,
    },
    facilities: {
      matched: found.filter((stop) => stop.facilities && facilitiesOf(byName.get(stop.name)) === [...stop.facilities].sort().join('+')).length,
      of: truth.filter((stop) => stop.facilities).length,
      extra: found.filter((stop) => !stop.facilities && facilitiesOf(byName.get(stop.name)) !== '').length,
    },
  };
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
  /** M215 约定一：无地标站名的底边与地标底边齐平，差值毫米，2 mm 以内通过。 */
  readonly landmarkBaseline: { readonly found: boolean; readonly deltaMm?: number; readonly pass: boolean; readonly reason?: string };
  /** M215 约定二：绑定 road 的文字为同间隔分布。 */
  readonly roadAlign: { readonly aligns: readonly string[]; readonly pass: boolean };
  readonly layoutPassed: number;
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
    landmarkBaseline: landmark, roadAlign: road, layoutPassed: [landmark.pass, road.pass].filter(Boolean).length,
  };
}

/** M215 约定一：取第 1 站（无地标）与第 4 站（有地标），比较无地标站名的底边与地标图片的底边。 */
export function landmarkBaseline(layout: { root: unknown }, stops: readonly Record<string, unknown>[]): TemplateScore['landmarkBaseline'] {
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
export function roadAlign(templates: readonly unknown[]): TemplateScore['roadAlign'] {
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

/** 两张图都缩到 437 × 98 后逐像素比较。 */
async function similarity(a: Uint8Array, b: Uint8Array): Promise<number> {
  const ck = await loadCanvasKit();
  const shrink = (bytes: Uint8Array) => {
    const image = ck.MakeImageFromEncoded(bytes)!;
    const surface = ck.MakeSurface(437, 98)!;
    surface.getCanvas().drawImageRect(image, ck.XYWHRect(0, 0, image.width(), image.height()), ck.XYWHRect(0, 0, 437, 98), new ck.Paint());
    const pixels = surface.makeImageSnapshot().readPixels(0, 0, { width: 437, height: 98, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
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
