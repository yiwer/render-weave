/** 离线试验的公开评判入口。观察布局摘要，不改变产品 verdict，也不证明最终像素可见。 */
import type { LayoutNode, LayoutSummary } from '../../src/index.js';

type Box = { x: number; y: number; width: number; height: number };
export interface DisplayRole {
  id: string;
  region: Box; // 归一化的粗位置提示；只有 regionOnly / labelPrefix 消歧会用到边界。
  expected: readonly string[];
  mode: 'text' | 'contains' | 'time' | 'image';
  vocabulary?: readonly string[];
  ordered?: boolean;
  /** 该区域是否只应含本角色标签；多出的陌生文本保留为待核查，不静默过滤。 */
  exclusiveText?: boolean;
  /** 含前缀的合成文本允许越过粗区域；无前缀时仍按区域区分同名角色。 */
  labelPrefix?: string;
  /** 重复图像没有文字前缀可区分；指定区域仅作角色消歧，越界只能说未匹配。 */
  regionOnly?: boolean;
}
export interface DisplayContract {
  basis: string;
  roles: readonly DisplayRole[];
  routeNumber: { text: string; image?: string; region: Box };
}
interface Evidence {
  value: string;
  path: string;
  box: Box;
  fontSize: number | null;
  writingMode: string | null;
  colors: readonly string[];
}
export interface RoleMeasurement {
  id: string;
  expected: number;
  observed: number;
  matched: number;
  missingOrUnmatched: readonly string[];
  unexpected: readonly string[];
  unassignedText: readonly { value: string; path: string; box: Box }[];
  inversionRate: number | null;
  matches: readonly (Evidence | null)[];
  fontSizeMm: { min: number; median: number; max: number } | null;
  geometry: { compared: number; meanCenterError: number; maxCenterError: number; meanSizeLogError: number; meanFontLogError: number | null } | null;
}
export interface FidelityMeasurement {
  scope: 'layout-evidence-only';
  content: 'matched' | 'mismatch' | 'unknown';
  routeNumber: boolean | null;
  roles: readonly RoleMeasurement[];
  diagnostics: readonly { role: string; code: string; message: string }[];
  unknown: readonly string[];
}
const normalize = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '');
const normalizeTime = (s: string) => normalize(s).replace(/^(\d):/, '0$1:');
const resourceId = (s: string) => s.replace(/^res:/, '').split('@')[0]!;
const average = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const inside = (box: Box, region: Box) => {
  const p = center(box);
  return p.x >= region.x && p.x <= region.x + region.width && p.y >= region.y && p.y <= region.y + region.height;
};

/** reference 仅用于受控试验的布局偏差；没有金标准布局时不输出貌似精确的结构分数。 */
export function assessFidelity(layout: LayoutSummary | undefined, contract: DisplayContract, reference?: FidelityMeasurement): FidelityMeasurement {
  const unknown = ['未验证最终像素遮挡、透明度、裁切与旋转；layout.visible 不等于实际可见',
    '文字按完整文本节点/时刻 token 匹配；分字或跨节点排字可能未能匹配',
    '字号和布局框不是参考图墨迹或基线；未校准人类视觉偏好',
    '本试验未核对票价格式、本站背景/文字状态配色及全部静态文案',
    '同一文本跨角色时按粗区域纵向中心的接近度分配；不是引擎提供的真实语义角色 ID',
    '重复的下一站地标依赖粗区域消歧，越界可能未匹配；未完整识别词表外图像与装饰'];
  if (!layout) return { scope: 'layout-evidence-only', content: 'unknown', routeNumber: null, roles: [], diagnostics: [], unknown: ['没有布局证据', ...unknown] };
  const nodes: { node: LayoutNode; box: Box }[] = [];
  const walk = (node: LayoutNode) => {
    if (!node.visible) return;
    if (node.text || node.image) nodes.push({ node, box: { x: node.x / layout.output.width, y: node.y / layout.output.height,
      width: node.width / layout.output.width, height: node.height / layout.output.height } });
    node.children?.forEach(walk);
  };
  walk(layout.root);
  const vocabularies = contract.roles.map((role) => [...new Set((role.vocabulary ?? role.expected).map(role.mode === 'image' ? resourceId : normalize))]);
  const candidates = nodes.map(({ node, box }) => {
    const values = contract.roles.map((role, index) => {
      const vocabulary = vocabularies[index]!;
      if (role.regionOnly && !inside(box, role.region)) return [];
      if (role.labelPrefix && !inside(box, role.region) && !normalize(node.text?.content ?? '').includes(normalize(role.labelPrefix))) return [];
      if (role.mode === 'image') return node.image && vocabulary.includes(resourceId(node.image.source)) ? [resourceId(node.image.source)] : [];
      if (!node.text) return [];
      const content = normalize(node.text.content);
      if (role.mode === 'time') return (content.match(/(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/g) ?? []).map(normalizeTime);
      return role.mode === 'contains' ? containedLabels(content, vocabulary) : vocabulary.includes(content) ? [content] : [];
    });
    return { node, box, values };
  });
  const diagnostics: { role: string; code: string; message: string }[] = [];
  const roles = contract.roles.map((role, roleIndex): RoleMeasurement => {
    const expected = role.expected.map(role.mode === 'image' ? resourceId : role.mode === 'time' ? normalizeTime : normalize);
    const evidence: Evidence[] = [];
    const unassignedText: { value: string; path: string; box: Box }[] = [];
    for (const { node, box, values } of candidates) {
      // 语义匹配在整张图中查找；区域只帮助分辨同名角色，位置偏差不冒充内容缺失。
      if (role.exclusiveText && node.text && normalize(node.text.content) && inside(box, role.region) && values.every((v) => v.length === 0)) {
        unassignedText.push({ value: normalize(node.text.content), path: node.path, box });
      }
      for (const value of values[roleIndex]!) {
        const owners = contract.roles.map((r, i) => ({ index: i, distance: Math.abs(center(box).y - center(r.region).y) }))
          .filter(({ index }) => values[index]!.includes(value)).sort((a, b) => a.distance - b.distance);
        if (owners[0]?.index !== roleIndex) continue;
        const fragments = node.text?.fragments.filter((f) => normalize(f.text).includes(value));
        const sizes = (fragments?.length ? fragments : node.text?.fragments)?.filter((f) => f.text).map((f) => f.fontSize);
        evidence.push({ value, path: node.path, box, fontSize: sizes?.length ? Math.min(...sizes) : null,
          writingMode: node.text?.writingMode ?? null, colors: node.text?.fragments.map((f) => f.color) ?? [] });
      }
    }
    evidence.sort((a, b) => center(a.box).x - center(b.box).x || center(a.box).y - center(b.box).y);
    const remaining = [...evidence];
    const matches = expected.map((value) => {
      const index = remaining.findIndex((e) => e.value === value);
      return index === -1 ? null : remaining.splice(index, 1)[0]!;
    });
    const missing = expected.filter((_, i) => !matches[i]);
    if (missing.length) diagnostics.push({ role: role.id, code: 'content.unmatched', message: `${missing.length}/${expected.length} 个预期项未匹配；缺失或超出本试验匹配能力` });
    if (remaining.length) diagnostics.push({ role: role.id, code: 'content.extra', message: `${remaining.length} 个重复或多余项` });
    if (unassignedText.length) diagnostics.push({ role: role.id, code: 'content.unassigned', message: `${unassignedText.length} 个陌生文本节点待核查；不能确认是额外内容还是合法装饰` });
    let inversions = 0, pairs = 0;
    if (role.ordered) for (let i = 0; i < matches.length; i++) for (let j = i + 1; j < matches.length; j++) {
      if (!matches[i] || !matches[j]) continue;
      pairs++;
      if (center(matches[i]!.box).x > center(matches[j]!.box).x + 1e-6) inversions++;
    }
    if (inversions) diagnostics.push({ role: role.id, code: 'content.order', message: `${inversions}/${pairs} 对匹配标签逆序` });
    const sizes = matches.flatMap((m) => m?.fontSize == null ? [] : [m.fontSize]).sort((a, b) => a - b);
    const ref = reference?.roles.find((r) => r.id === role.id);
    const errors: { center: number; size: number; font: number | null }[] = [];
    if (ref) matches.forEach((m, i) => {
      const r = ref.matches[i];
      if (!m || !r || m.value !== r.value || m.box.width <= 0 || m.box.height <= 0 || r.box.width <= 0 || r.box.height <= 0) return;
      const mc = center(m.box), rc = center(r.box);
      errors.push({ center: Math.hypot(mc.x - rc.x, mc.y - rc.y),
        size: (Math.abs(Math.log(m.box.width / r.box.width)) + Math.abs(Math.log(m.box.height / r.box.height))) / 2,
        font: m.fontSize && r.fontSize ? Math.abs(Math.log(m.fontSize / r.fontSize)) : null });
    });
    const fonts = errors.flatMap((e) => e.font === null ? [] : [e.font]);
    return { id: role.id, expected: expected.length, observed: evidence.length, matched: matches.filter(Boolean).length,
      missingOrUnmatched: missing, unexpected: remaining.map((e) => e.value), unassignedText, inversionRate: pairs ? inversions / pairs : null, matches,
      fontSizeMm: sizes.length ? { min: sizes[0]!, median: sizes.length % 2 ? sizes[Math.floor(sizes.length / 2)]! :
        (sizes[sizes.length / 2 - 1]! + sizes[sizes.length / 2]!) / 2, max: sizes.at(-1)! } : null,
      geometry: errors.length ? { compared: errors.length, meanCenterError: average(errors.map((e) => e.center)), maxCenterError: Math.max(...errors.map((e) => e.center)),
        meanSizeLogError: average(errors.map((e) => e.size)), meanFontLogError: fonts.length ? average(fonts) : null } : null };
  });
  const routeLabel = normalize(contract.routeNumber.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const routePattern = new RegExp('(?<![A-Za-z0-9])' + routeLabel + '(?![A-Za-z0-9])');
  const routeNumber = nodes.some(({ node, box }) => inside(box, contract.routeNumber.region) &&
    (node.text && routePattern.test(normalize(node.text.content)) || node.image && contract.routeNumber.image && resourceId(node.image.source) === resourceId(contract.routeNumber.image)));
  if (!routeNumber) diagnostics.push({ role: 'route-number', code: 'content.unmatched', message: '顶栏未匹配线路号文字或声明的线路号图片' });
  return { scope: 'layout-evidence-only', content: diagnostics.some((d) => d.code !== 'content.unassigned') ? 'mismatch' : diagnostics.length ? 'unknown' : 'matched', routeNumber, roles, diagnostics, unknown };
}

/** 同一次出现只匹配最长名称；相隔的重复名称各计一次。 */
function containedLabels(text: string, vocabulary: readonly string[]): string[] {
  const labels: string[] = [], longestFirst = vocabulary.filter(Boolean).toSorted((a, b) => b.length - a.length);
  for (let index = 0; index < text.length;) {
    const found = longestFirst.find((value) => text.startsWith(value, index));
    if (found) { labels.push(found); index += found.length; } else index++;
  }
  return labels;
}

export interface M402Data {
  routeNo: string; routeNoImage?: string;
  firstDeparture: string; lastDeparture: string; departureTimes: string[];
  operator?: string; serviceNote?: string; scheduleType?: string;
  stops: { name: string; road: string; landmark?: string; badges?: string[] }[];
}
/** M402 试验显示契约；粗区域按原图五区固定，图片资源映射独立于被测候选。 */
export function m402DisplayContract(data: M402Data, currentIndex: number): DisplayContract {
  const stations = { x: 0, y: 165 / 780, width: 1, height: 465 / 780 };
  // 时刻/服务说明的语义足以区分角色；允许维护模板的底栏分界与原图不同，不把位置偏差误作缺内容。
  const service = { x: 0, y: 680 / 780, width: 1, height: 100 / 780 };
  const header = { x: 0, y: 0, width: 1, height: 165 / 780 };
  return { basis: 'M402 已有数据与显式显示契约；粗区域由原图分区给定。是离线试验，非核准的最终视觉验收。',
    routeNumber: { text: data.routeNo, ...(data.routeNoImage ? { image: data.routeNoImage } : {}), region: header },
    roles: [
      { id: 'stations', region: stations, expected: data.stops.map((s) => s.name), mode: 'text', ordered: true, exclusiveText: true },
      { id: 'roads', region: { x: 0, y: 630 / 780, width: 1, height: 50 / 780 }, mode: 'text', ordered: true, exclusiveText: true,
        expected: data.stops.filter((s, i) => i === 0 || s.road !== data.stops[i - 1]!.road).map((s) => s.road) },
      { id: 'terminal', region: header, expected: data.stops.length ? [data.stops.at(-1)!.name] : [], mode: 'contains' },
      { id: 'operator', region: header, expected: data.operator ? [data.operator] : [], mode: 'contains' },
      { id: 'service-times', region: service, expected: [data.firstDeparture, data.lastDeparture, ...data.departureTimes], mode: 'time' },
      { id: 'service-note', region: service, expected: [data.serviceNote, data.scheduleType].filter((s): s is string => !!s), mode: 'contains' },
      { id: 'next-stop', region: { x: 0, y: 680 / 780, width: 950 / 3496, height: 100 / 780 },
        expected: currentIndex > 0 && currentIndex < data.stops.length ? [data.stops[currentIndex]!.name] : [], mode: 'contains', labelPrefix: '下一站', vocabulary: data.stops.map((s) => s.name) },
      { id: 'landmarks', region: stations, expected: data.stops.flatMap((s) => s.landmark ? [s.landmark] : []), mode: 'image' },
      { id: 'next-landmark', region: { x: 0, y: 680 / 780, width: 950 / 3496, height: 100 / 780 }, mode: 'image', regionOnly: true,
        expected: currentIndex > 0 && currentIndex < data.stops.length && data.stops[currentIndex]!.landmark ? [data.stops[currentIndex]!.landmark!] : [],
        vocabulary: data.stops.flatMap((s) => s.landmark ? [s.landmark] : []) },
      { id: 'badges', region: stations, expected: data.stops.flatMap((s) => s.badges ?? []).map((b) => b === '地铁' ? 'res:icon-metro' : b === '医院' ? 'res:icon-hospital' : 'unknown-badge:' + b), mode: 'image', vocabulary: ['res:icon-metro', 'res:icon-hospital'] },
    ] };
}
