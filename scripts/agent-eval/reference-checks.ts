/** 实验用核准布局清单。逐元素/逐片段核对，不从参考框推断字号，不作为最终墨迹验收。 */
import type { LayoutNode, LayoutSummary } from '../../src/index.js';
import type { RepairCheck } from './repair-feedback.js';

export interface ReferenceElement {
  path: string; role: string; type: string;
  box: { x: number; y: number; width: number; height: number };
  boxKind: 'layout' | 'ink';
  text?: string; image?: string;
  characters?: { text: string; size: number; color: string }[];
}
export interface LayoutReference {
  basis: string; width: number; height: number; elements: ReferenceElement[];
}
export const REFERENCE_THRESHOLDS = { center: 0.005, sizeLog: Math.log(1.1), fontLog: Math.log(1.1) } as const;
const normalizeColor = (c: string) => (c.length === 7 ? c + 'ff' : c).toLowerCase();
const leaves = (layout?: LayoutSummary): LayoutNode[] => {
  const nodes: LayoutNode[] = [];
  const walk = (n: LayoutNode) => { if (!n.visible) return; if (n.text?.content || n.image) nodes.push(n); n.children?.forEach(walk); };
  if (layout) walk(layout.root);
  return nodes;
};
const characters = (node: LayoutNode) => node.text?.fragments.flatMap(f => [...f.text].map(text => ({ text, size: f.fontSize, color: normalizeColor(f.color) })));
export function createLayoutReference(layout: LayoutSummary, basis: string): LayoutReference {
  const elements = leaves(layout).map(n => ({ path: n.path, role: n.path.replace(/\[\d+\]/g, ''), type: n.type,
    box: { x: n.x, y: n.y, width: n.width, height: n.height }, boxKind: 'layout' as const,
    ...(n.text ? { text: n.text.content, characters: characters(n) } : {}), ...(n.image ? { image: n.image.source } : {}) }));
  if (!basis.trim() || !elements.length || new Set(elements.map(e => e.path)).size !== elements.length) throw new Error('参考需要依据和非空、唯一的元素清单');
  return { basis, width: layout.output.width, height: layout.output.height, elements };
}

/** 路径稳定是受控局部修复的约束；不把改名/拆分后的歧义猜成成功匹配。 */
export function checkLayoutReference(actual: LayoutSummary | undefined, reference: LayoutReference, geometry = true): RepairCheck[] {
  const observed = leaves(actual), checks: RepairCheck[] = [];
  const validReference = reference.basis.trim().length > 0 && reference.elements.length > 0 &&
    Number.isFinite(reference.width) && reference.width > 0 && Number.isFinite(reference.height) && reference.height > 0 &&
    new Set(reference.elements.map(e => e.path)).size === reference.elements.length;
  const inventoryValid = validReference && !!actual && new Set(observed.map(n => n.path)).size === observed.length;
  const extra = observed.filter(n => !reference.elements.some(e => e.path === n.path));
  checks.push({ id: 'inventory:content', role: 'inventory', dimension: 'content', pass: inventoryValid && extra.length === 0, severity: 100,
    status: inventoryValid ? 'measured' : 'unknown', detail: inventoryValid ? `未登记元素 ${extra.map(n => n.path).join('、') || '无'}` : '缺少有效布局或非空唯一参考清单，不能判通过' });
  for (const e of reference.elements) {
    const matches = observed.filter(n => n.path === e.path), node = matches.length === 1 ? matches[0] : undefined;
    const state = !inventoryValid || matches.length > 1 ? 'unknown' : node ? 'measured' : 'missing';
    const push = (dimension: RepairCheck['dimension'], pass: boolean, severity: number, detail: string, status: RepairCheck['status'] = state) =>
      checks.push({ id: `${e.path}:${dimension}`, role: e.role, dimension, pass: inventoryValid && pass, severity: Number.isFinite(severity) ? severity : 100,
        detail, status, ...(node ? { path: node.path } : {}) });
    const content = !!node && node.type === e.type && (e.text === undefined || node.text?.content === e.text) && (e.image === undefined || node.image?.source === e.image);
    push('content', content, 10, `参考 ${e.text ?? e.image ?? e.type}；实际 ${node?.text?.content ?? node?.image?.source ?? '未匹配'}；匹配数 ${matches.length}`);
    if (e.text !== undefined) {
      const chars = node && characters(node), expected = e.characters;
      const aligned = content && !!chars?.length && !!expected?.length && chars.map(c => c.text).join('') === expected.map(c => c.text).join('');
      const fontKnown = aligned && chars!.every(c => Number.isFinite(c.size) && c.size > 0) && expected!.every(c => Number.isFinite(c.size) && c.size > 0);
      const errors = fontKnown ? chars!.map((c, i) => Math.abs(Math.log(c.size / expected![i]!.size))) : [];
      const maxFont = errors.length ? Math.max(...errors) : Infinity;
      push('font', fontKnown && maxFont <= REFERENCE_THRESHOLDS.fontLog, maxFont,
        `实际片段字号 ${[...new Set(chars?.map(c => c.size))].join(',') || '未知'} mm；核准片段字号 ${[...new Set(expected?.map(c => c.size))].join(',') || '未知'} mm；逐字最大对数偏差 ${fontKnown ? maxFont : '未知'}，不从框推字号`, fontKnown ? state : 'unknown');
      const colorKnown = aligned && chars!.every(c => /^#[a-f0-9]{8}$/.test(c.color)) && expected!.every(c => /^#[a-f0-9]{8}$/.test(c.color));
      push('color', colorKnown && chars!.every((c, i) => c.color === expected![i]!.color), 1,
        `实际颜色 ${[...new Set(chars?.map(c => c.color))].join(',') || '未知'}；参考 ${[...new Set(expected?.map(c => c.color))].join(',') || '未知'}`, colorKnown ? state : 'unknown');
    }
    if (geometry) {
      const boxKnown = !!node && e.boxKind === 'layout' && [...Object.values(e.box), node.x, node.y, node.width, node.height].every(Number.isFinite) && e.box.width > 0 && e.box.height > 0 && node.width > 0 && node.height > 0 &&
        actual?.output.width === reference.width && actual.output.height === reference.height;
      const delta = boxKnown ? { x: node!.x + node!.width / 2 - e.box.x - e.box.width / 2, y: node!.y + node!.height / 2 - e.box.y - e.box.height / 2 } : null;
      const error = delta ? Math.hypot(delta.x / reference.width, delta.y / reference.height) : Infinity;
      push('position', boxKnown && error <= REFERENCE_THRESHOLDS.center, error,
        `布局框中心偏移 ${delta ? `x=${delta.x.toFixed(3)}, y=${delta.y.toFixed(3)} mm` : '未知（不能把墨迹框与布局框混比）'}；归一化偏差 ${boxKnown ? error : '未知'}；目标 ≤${REFERENCE_THRESHOLDS.center}`, boxKnown ? state : 'unknown');
      const size = boxKnown ? Math.max(Math.abs(Math.log(node!.width / e.box.width)), Math.abs(Math.log(node!.height / e.box.height))) : Infinity;
      push('size', boxKnown && size <= REFERENCE_THRESHOLDS.sizeLog, size,
        `布局框实际 ${node?.width ?? '?'}×${node?.height ?? '?'} mm；参考 ${e.box.width}×${e.box.height} mm；最大尺寸对数偏差 ${boxKnown ? size : '未知'}`, boxKnown ? state : 'unknown');
    }
  }
  return checks;
}
