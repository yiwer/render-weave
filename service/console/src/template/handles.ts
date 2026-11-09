/**
 * 舞台上的手柄（模板设计页票据 13，方案第 4 节「手柄」，M392）：能拖什么由父容器的布局决定，只写 DSL 里已有的数。纯函数：
 * 给文档、选中的元素、它在图上的框与手势，得到新文档、幽灵框与读数；拖动中页面只画幽灵框，松手才写回。
 * - 自由布局：移动与八个手柄，写 place 的锚点值（原来是距右、距下的保持）、width、height；
 * - 堆叠：沿主轴拖动改 children 顺序（同时决定叠放）；固定的尺寸才有手柄；
 * - 网格：吸到格子写 row、column，右边、下边改跨度，不超出轨道数；
 * - 选中堆叠或循环：间距条写间距；选中网格：固定轨道的线写轨道尺寸。
 * 写不进的不给手柄，notes 说明怎么改：值绑定了变量、尺寸是随内容或撑满、轨道按比例或随内容、旋转的元素只给移动、画板与循环项不能拖。
 * 状态样式选中某个取值时写进这个取值的覆盖；覆盖是整项替换（引擎 src/template/parse.ts:450），所以写整份 place 或 layout。
 */
import type { LayoutNode } from '../types.js';
import { setElement } from './calls.js';
import { elementAt, isObject, type JsonObject } from './document.js';
import { moveElementTo } from './structure.js';

/** 拖动吸到 0.5 mm，按住 Shift 到 0.1 mm；方向键的步长相同。 */
export const SNAP = 0.5;
export const FINE = 0.1;
const MIN_SIZE = FINE;

export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** move 是拖元素本身；gap:i 是第 i 个间距条；rows:i、columns:i 是第 i 条固定轨道的末端。 */
export type HandleId = 'move' | Edge | `gap:${number}` | `rows:${number}` | `columns:${number}`;
export type ParentMode = 'free' | 'stack' | 'grid';

export interface HandleInput {
  readonly document: JsonObject;
  readonly template: string;
  readonly path: string;
  /** 图上的这一处（选中容器时用它的子元素画间距与轨道）。 */
  readonly node: LayoutNode;
  /** 父容器在图上的那一处，含兄弟元素：堆叠排序、网格吸格要用。 */
  readonly parent?: LayoutNode;
  /** 选中的是子模板的画板时，调用它的元素：循环项与子模板调用的说法不同。 */
  readonly host?: JsonObject;
  /** 状态样式选中的取值：手柄写进这个取值的覆盖。 */
  readonly state?: string;
  /** 这个定义在图上一共几处：多于一处时读数写明一起变。 */
  readonly count?: number;
}

export interface Handle {
  readonly id: HandleId;
  /** 手柄画在哪（毫米，图的坐标）；条形的手柄另有 bar。 */
  readonly x: number;
  readonly y: number;
  readonly cursor: string;
  readonly label: string;
  readonly bar?: Box;
}

export interface HandleSet {
  readonly mode?: ParentMode;
  readonly handles: readonly Handle[];
  /** 图上能做什么，一句话。 */
  readonly can: string;
  /** 没有手柄的原因与改法。 */
  readonly notes: readonly string[];
}

export interface Gesture {
  readonly handle: HandleId;
  /** 从按下到现在的位移（毫米）。 */
  readonly dx: number;
  readonly dy: number;
  /** 指针现在的位置（毫米，图的坐标）：排序与吸格看它。 */
  readonly point: { readonly x: number; readonly y: number };
  /** 按住 Shift：吸到 0.1 mm。 */
  readonly fine?: boolean;
  /** 方向键：按步长挪，不吸附。 */
  readonly exact?: boolean;
}

export interface HandleResult {
  readonly document: JsonObject;
  /** 幽灵框：松手后元素大致在哪（毫米）。 */
  readonly ghost?: Box;
  /** 插入线、轨道线的新位置（宽或高为 0 的框）。 */
  readonly line?: Box;
  readonly readout: string;
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const show = (value: number) => String(Math.round(value * 100) / 100);
const num = (value: unknown) => (typeof value === 'number' ? value : undefined);
const boundName = (value: unknown) => (isObject(value) && typeof value['var'] === 'string' ? value['var'] : undefined);
const childrenOf = (element: JsonObject | undefined): readonly JsonObject[] => (Array.isArray(element?.['children']) ? (element['children'] as unknown[]).filter(isObject) : []);
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/');
const nameOf = (path: string) => path.split('/').at(-1)!;

/** 状态样式的这个取值的覆盖；没选取值、元素没有状态样式时 undefined。 */
function caseOf(element: JsonObject, state: string | undefined): JsonObject | undefined {
  if (state === undefined || !isObject(element['states']) || !isObject(element['states']['cases'])) return undefined;
  const found = element['states']['cases'][state];
  return isObject(found) ? found : {};
}

/** 元素自己的一项：选了取值且覆盖写了这一项时取覆盖。 */
function own(element: JsonObject, key: string, state: string | undefined): unknown {
  const override = caseOf(element, state);
  return override && key in override ? override[key] : element[key];
}

/** 写元素自己的一项：选了取值就写进覆盖（整项替换，和引擎合并的口径一致）。 */
function withOwn(element: JsonObject, key: string, value: unknown, state: string | undefined): JsonObject {
  const override = caseOf(element, state);
  if (!override) return { ...element, [key]: value };
  const states = element['states'] as JsonObject, cases = states['cases'] as JsonObject;
  return { ...element, states: { ...states, cases: { ...cases, [state!]: { ...override, [key]: value } } } };
}

export function modeOf(element: JsonObject | undefined): ParentMode {
  const layout = isObject(element?.['layout']) ? element['layout'] : undefined;
  return layout?.['mode'] === 'stack' ? 'stack' : layout?.['mode'] === 'grid' ? 'grid' : 'free';
}

/** 尺寸能不能拖：固定的字面值才能。不能时说明怎么改。 */
function sizeOf(size: unknown, label: string, fallback: 'hug' | 'fill'): { readonly fixed?: number; readonly note?: string } {
  const value = size ?? fallback;
  if (isObject(value) && 'fixed' in value) {
    const fixed = value['fixed'], name = boundName(fixed);
    return typeof fixed === 'number' ? { fixed } : { note: `${label}绑定了变量 ${name ?? ''}，没有手柄：在检查器里换成固定值再拖。` };
  }
  if (value === 'hug') return { note: `${label}是随内容，没有手柄：先在检查器的位置与尺寸里切成固定。` };
  return { note: `${label}是撑满，没有手柄：先在检查器的位置与尺寸里切成固定。` };
}

const AXIS = {
  x: { start: 'left', end: 'right', size: 'width', startLabel: '距左', endLabel: '距右', sizeLabel: '宽' },
  y: { start: 'top', end: 'bottom', size: 'height', startLabel: '距上', endLabel: '距下', sizeLabel: '高' },
} as const;

/** 自由布局里一个方向的锚点：原来写的是距右（距下）就保持；都没写是距左 0。 */
function anchorOf(place: JsonObject, axis: 'x' | 'y') {
  const keys = AXIS[axis], atEnd = place[keys.end] !== undefined;
  const key = atEnd ? keys.end : keys.start, raw = place[key];
  const offset = raw === undefined ? 0 : num(raw);
  return { atEnd, key, offset, label: atEnd ? keys.endLabel : keys.startLabel, bound: boundName(raw) };
}

const EDGES: readonly { readonly id: Edge; readonly fx: number; readonly fy: number; readonly cursor: string }[] = [
  { id: 'nw', fx: 0, fy: 0, cursor: 'nwse-resize' }, { id: 'n', fx: 0.5, fy: 0, cursor: 'ns-resize' }, { id: 'ne', fx: 1, fy: 0, cursor: 'nesw-resize' },
  { id: 'e', fx: 1, fy: 0.5, cursor: 'ew-resize' }, { id: 'se', fx: 1, fy: 1, cursor: 'nwse-resize' }, { id: 's', fx: 0.5, fy: 1, cursor: 'ns-resize' },
  { id: 'sw', fx: 0, fy: 1, cursor: 'nesw-resize' }, { id: 'w', fx: 0, fy: 0.5, cursor: 'ew-resize' },
];
const sidesOf = (edge: Edge) => ({ left: edge.includes('w'), right: edge.includes('e'), top: edge.includes('n'), bottom: edge.includes('s') });

function edgeHandle(id: Edge, box: Box, label: string): Handle {
  const spec = EDGES.find((edge) => edge.id === id)!;
  return { id, x: box.x + box.width * spec.fx, y: box.y + box.height * spec.fy, cursor: spec.cursor, label };
}

function rotatedOf(element: JsonObject, state: string | undefined): boolean {
  const rotation = own(element, 'rotation', state);
  return rotation !== undefined && rotation !== 0;
}

/** 网格的行与列在图上的位置：固定取定值，随内容取只占这一条的元素中最大的，按比例的分剩余（引擎 resolveTracks 的口径）。 */
export interface TrackBox { readonly start: number; readonly size: number; readonly kind: 'fixed' | 'hug' | 'fraction' }
export interface GridTracks { readonly rows: readonly TrackBox[]; readonly columns: readonly TrackBox[] }

function edgesOf(padding: unknown) {
  const side = (key: string) => (typeof padding === 'number' ? padding : isObject(padding) ? num(padding[key]) ?? 0 : 0);
  return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') };
}

export function gridTracks(element: JsonObject, node: LayoutNode): GridTracks | undefined {
  const layout = isObject(element['layout']) ? element['layout'] : undefined;
  if (layout?.['mode'] !== 'grid' || !Array.isArray(layout['rows']) || !Array.isArray(layout['columns'])) return undefined;
  const padding = edgesOf(element['padding']);
  const children = childrenOf(element), kids = (node.children ?? []).filter((kid) => kid.visible);
  const solve = (tracks: readonly unknown[], gap: number, key: 'row' | 'column', span: 'rowSpan' | 'columnSpan', start: number, room: number, measure: (kid: LayoutNode, place: JsonObject) => number): TrackBox[] => {
    const kinds = tracks.map((track) => (isObject(track) && 'fixed' in track ? 'fixed' as const : isObject(track) && 'fraction' in track ? 'fraction' as const : 'hug' as const));
    const sizes = tracks.map((track, index) => {
      if (kinds[index] === 'fixed') return num((track as JsonObject)['fixed']) ?? 0;
      if (kinds[index] === 'fraction') return 0;
      return Math.max(0, ...children.flatMap((child) => {
        const place = isObject(child['place']) ? child['place'] : {};
        if (place[key] !== index + 1 || (num(place[span]) ?? 1) !== 1) return [];
        const kid = kids.find((item) => item.name === child['name']);
        return kid ? [measure(kid, place)] : [];
      }));
    });
    const fractions = tracks.reduce<number>((sum, track, index) => sum + (kinds[index] === 'fraction' ? num((track as JsonObject)['fraction']) ?? 0 : 0), 0);
    const rest = Math.max(0, room - sizes.reduce((sum, size) => sum + size, 0) - gap * Math.max(0, tracks.length - 1));
    let cursor = start;
    return tracks.map((track, index) => {
      const size = kinds[index] === 'fraction' && fractions > 0 ? (rest * (num((track as JsonObject)['fraction']) ?? 0)) / fractions : sizes[index]!;
      const box = { start: cursor, size, kind: kinds[index]! };
      cursor += size + gap;
      return box;
    });
  };
  const margin = (place: JsonObject) => edgesOf(place['margin']);
  return {
    rows: solve(layout['rows'] as unknown[], num(layout['rowGap']) ?? 0, 'row', 'rowSpan', node.y + padding.top, node.height - padding.top - padding.bottom, (kid, place) => kid.height + margin(place).top + margin(place).bottom),
    columns: solve(layout['columns'] as unknown[], num(layout['columnGap']) ?? 0, 'column', 'columnSpan', node.x + padding.left, node.width - padding.left - padding.right, (kid, place) => kid.width + margin(place).left + margin(place).right),
  };
}

/** 指针落在第几条轨道（从 1 数）：在轨道之间时取近的那条。 */
function trackAt(tracks: readonly TrackBox[], at: number): number {
  let best = 1, distance = Infinity;
  tracks.forEach((track, index) => {
    const away = at < track.start ? track.start - at : at > track.start + track.size ? at - track.start - track.size : 0;
    if (away < distance) { distance = away; best = index + 1; }
  });
  return best;
}

/** 堆叠与循环的间距：方向、写在哪一项、现在的值；绑定了变量或两端对齐时说明为什么没有手柄。 */
function gapOf(element: JsonObject, state: string | undefined): { readonly key: 'layout' | 'itemLayout'; readonly row: boolean; readonly value?: number; readonly note?: string } | undefined {
  if (element['type'] === 'loop') {
    const items = own(element, 'itemLayout', state);
    if (!isObject(items)) return undefined;
    const name = boundName(items['gap']);
    return { key: 'itemLayout', row: items['direction'] !== 'column', ...(name ? { note: `项间距绑定了变量 ${name}，没有间距条。` } : { value: num(items['gap']) ?? 0 }) };
  }
  const layout = own(element, 'layout', state);
  if (!isObject(layout) || layout['mode'] !== 'stack') return undefined;
  const name = boundName(layout['gap']), row = layout['direction'] !== 'column';
  if (name) return { key: 'layout', row, note: `间距绑定了变量 ${name}，没有间距条。` };
  if (layout['justifyContent'] === 'spaceBetween' || layout['justifyContent'] === 'spaceEvenly') return { key: 'layout', row, note: '主轴两端对齐时空隙是分出来的，没有间距条：间距在检查器的排布里填。' };
  return { key: 'layout', row, value: num(layout['gap']) ?? 0 };
}

/** 选中容器自己的手柄：堆叠与循环的间距条，网格的固定轨道线。 */
function containerHandles(input: HandleInput, element: JsonObject): { readonly handles: Handle[]; readonly notes: string[] } {
  const { node, state } = input, handles: Handle[] = [], notes: string[] = [];
  const gap = gapOf(element, state);
  if (gap) {
    if (gap.note) notes.push(gap.note);
    else {
      const kids = (node.children ?? []).filter((kid) => kid.visible);
      for (let index = 0; index + 1 < kids.length; index++) {
        const a = kids[index]!, b = kids[index + 1]!;
        const bar = gap.row ? { x: a.x + a.width, y: node.y, width: Math.max(0, b.x - a.x - a.width), height: node.height } : { x: node.x, y: a.y + a.height, width: node.width, height: Math.max(0, b.y - a.y - a.height) };
        // 折行之后相邻的两项不在一行，中间不是间距。
        if (gap.row ? b.x < a.x : b.y < a.y) continue;
        handles.push({ id: `gap:${index}`, x: bar.x + bar.width / 2, y: bar.y + bar.height / 2, cursor: gap.row ? 'ew-resize' : 'ns-resize', label: '间距', bar });
      }
    }
  }
  const layout = own(element, 'layout', state), tracks = gridTracks(isObject(layout) ? { ...element, layout } : element, node);
  if (tracks && isObject(layout)) {
    let others = 0;
    for (const axis of ['rows', 'columns'] as const) {
      const list = layout[axis] as unknown[];
      tracks[axis].forEach((track, index) => {
        const raw = list[index];
        if (!(isObject(raw) && typeof raw['fixed'] === 'number')) { others++; return; }
        const end = track.start + track.size;
        const bar = axis === 'rows' ? { x: node.x, y: end, width: node.width, height: 0 } : { x: end, y: node.y, width: 0, height: node.height };
        handles.push({ id: `${axis}:${index}`, x: bar.x + bar.width / 2, y: bar.y + bar.height / 2, cursor: axis === 'rows' ? 'ns-resize' : 'ew-resize', label: axis === 'rows' ? `第 ${index + 1} 行` : `第 ${index + 1} 列`, bar });
      });
    }
    if (others) notes.push('按比例或随内容的轨道没有手柄：在检查器的排布里改。');
  }
  return { handles, notes };
}

function selfOf(input: HandleInput) {
  const element = elementAt(input.document, input.path)?.element;
  const isArtboard = input.path === input.template;
  const parent = isArtboard ? undefined : elementAt(input.document, parentPath(input.path))?.element;
  return { element, isArtboard, parent };
}

const countText = (input: HandleInput) => `${input.state !== undefined ? `；写进「${input.state}」的覆盖` : ''}${(input.count ?? 1) > 1 ? `；图上 ${input.count} 处一起变` : ''}`;

/** 这个元素在图上有哪些手柄，没有的写明原因。 */
export function handlesOf(input: HandleInput): HandleSet {
  const { element, isArtboard, parent } = selfOf(input);
  if (!element) return { handles: [], can: '', notes: [] };
  const own_ = containerHandles(input, element);
  const done = (mode: ParentMode | undefined, handles: Handle[], notes: string[], can: string[]): HandleSet => {
    const all = [...handles, ...own_.handles];
    if (own_.handles.some((handle) => handle.id.startsWith('gap'))) can.push('拖间距条改间距');
    if (own_.handles.some((handle) => handle.id.startsWith('rows') || handle.id.startsWith('columns'))) can.push('拖轨道线改固定轨道');
    const moves = handles.some((handle) => handle.id === 'move');
    const keys = !moves ? '' : mode === 'free' ? '；方向键挪 0.5 mm，按住 Shift 挪 0.1 mm' : mode === 'grid' ? '；方向键挪一格' : '；方向键和前后换位';
    return { ...(mode ? { mode } : {}), handles: all, can: can.length ? `图上可以${can.join('、')}${keys}。` : '', notes: [...notes, ...own_.notes] };
  };
  if (isArtboard) {
    const host = input.host;
    const note = host?.['type'] === 'loop' ? `循环项不能拖：项由数据决定，排布在循环容器「${String(host['name'])}」上改。`
      : host ? `子模板的画板不能拖：位置与尺寸在调用它的「${String(host['name'])}」上改。` : '画板不能拖：实际尺寸是出图参数，在样例带里调。';
    return done(undefined, [], [note], []);
  }
  const mode = modeOf(parent), state = input.state, box = input.node;
  const place = isObject(own(element, 'place', state)) ? own(element, 'place', state) as JsonObject : {};
  const rotated = rotatedOf(element, state);
  const handles: Handle[] = [], notes: string[] = [], can: string[] = [];
  const move = (cursor: string, label: string) => handles.push({ id: 'move', x: box.x + box.width / 2, y: box.y + box.height / 2, cursor, label, bar: box });
  if (mode === 'free') {
    const h = anchorOf(place, 'x'), v = anchorOf(place, 'y');
    const width = sizeOf(place['width'], '宽', 'hug'), height = sizeOf(place['height'], '高', 'hug');
    if (h.bound) notes.push(`${h.label}绑定了变量 ${h.bound}，不能横着拖。`);
    if (v.bound) notes.push(`${v.label}绑定了变量 ${v.bound}，不能竖着拖。`);
    if (!h.bound || !v.bound) { move('move', '移动'); can.push('移动'); }
    if (rotated) notes.push('旋转的元素只能移动：框不计旋转，尺寸在检查器里填。');
    else {
      if (width.note) notes.push(width.note);
      if (height.note) notes.push(height.note);
      const canSide = { left: width.fixed !== undefined && (h.atEnd || !h.bound), right: width.fixed !== undefined && (!h.atEnd || !h.bound), top: height.fixed !== undefined && (v.atEnd || !v.bound), bottom: height.fixed !== undefined && (!v.atEnd || !v.bound) };
      const edges = EDGES.filter((edge) => { const sides = sidesOf(edge.id); return (['left', 'right', 'top', 'bottom'] as const).every((side) => !sides[side] || canSide[side]); });
      edges.forEach((edge) => handles.push(edgeHandle(edge.id, box, '改尺寸')));
      if (edges.length) can.push(edges.length === 8 ? '拖八个手柄改宽高' : '拖边上的手柄改尺寸');
    }
    return done(mode, handles, notes, can);
  }
  if (mode === 'stack') {
    const layout = isObject(parent?.['layout']) ? parent['layout'] : {}, row = layout['direction'] !== 'column';
    // 顺序是父容器的 children，不能按取值换：选了取值时不给。
    if (childrenOf(parent).length > 1 && state !== undefined) notes.push('顺序不分取值，没有排序手柄：回到「自身属性」再拖。');
    else if (childrenOf(parent).length > 1) { move('grab', '改顺序'); can.push(`${row ? '左右' : '上下'}拖动改顺序`); }
    if (rotated) notes.push('旋转的元素只能改顺序：框不计旋转，尺寸在检查器里填。');
    else {
      const width = sizeOf(place['width'], '宽', 'hug'), height = sizeOf(place['height'], '高', 'hug');
      if (width.note) notes.push(width.note);
      if (height.note) notes.push(height.note);
      const edges: Edge[] = [...(width.fixed !== undefined ? ['e' as const] : []), ...(height.fixed !== undefined ? ['s' as const] : []), ...(width.fixed !== undefined && height.fixed !== undefined ? ['se' as const] : [])];
      edges.forEach((id) => handles.push(edgeHandle(id, box, '改尺寸')));
      if (edges.length) can.push(edges.length === 3 ? '拖右下的手柄改宽高' : edges[0] === 'e' ? '拖右边改宽' : '拖下边改高');
    }
    return done(mode, handles, notes, can);
  }
  const row = boundName(place['row']), column = boundName(place['column']);
  if (row || column) notes.push(`${row ? `行号绑定了变量 ${row}` : `列号绑定了变量 ${column}`}，不能吸到别的格子。`);
  else { move('grab', '换格子'); can.push('拖到别的格子'); }
  if (rotated) notes.push('旋转的元素只能换格子：跨度在检查器里填。');
  else {
    const rowSpan = boundName(place['rowSpan']), columnSpan = boundName(place['columnSpan']);
    if (rowSpan) notes.push(`跨行绑定了变量 ${rowSpan}，没有下边的手柄。`);
    if (columnSpan) notes.push(`跨列绑定了变量 ${columnSpan}，没有右边的手柄。`);
    // 只有一列（一行）的网格横（竖）着跨不出去，不给那条边的手柄。
    const grid = isObject(parent?.['layout']) ? parent['layout'] : {};
    const wide = !columnSpan && Array.isArray(grid['columns']) && grid['columns'].length > 1, tall = !rowSpan && Array.isArray(grid['rows']) && grid['rows'].length > 1;
    const edges: Edge[] = [...(wide ? ['e' as const] : []), ...(tall ? ['s' as const] : []), ...(wide && tall ? ['se' as const] : [])];
    edges.forEach((id) => handles.push(edgeHandle(id, box, '改跨度')));
    if (edges.length) can.push(wide && tall ? '拖右边、下边改跨度' : wide ? '拖右边改跨几列' : '拖下边改跨几行');
  }
  return done(mode, handles, notes, can);
}

const snapper = (gesture: Gesture) => (value: number) => (gesture.exact ? round(value) : round(Math.round(value / (gesture.fine ? FINE : SNAP)) * (gesture.fine ? FINE : SNAP)));

/** 自由布局里一个方向的拖动：起边、末边各动没动。返回要写的键与两条边的位移。 */
function freeAxis(place: JsonObject, axis: 'x' | 'y', delta: number, start: boolean, end: boolean, snap: (value: number) => number): { readonly set: JsonObject; readonly d0: number; readonly d1: number } | undefined {
  if (!start && !end) return { set: {}, d0: 0, d1: 0 };
  const keys = AXIS[axis], anchor = anchorOf(place, axis), size = sizeOf(place[keys.size], '', 'hug').fixed;
  const { key, offset, atEnd } = anchor;
  if (start && end) {
    if (offset === undefined) return undefined;
    const next = snap(atEnd ? offset - delta : offset + delta), moved = atEnd ? offset - next : next - offset;
    return { set: { [key]: next }, d0: moved, d1: moved };
  }
  if (size === undefined) return undefined;
  const fixed = (value: number) => ({ fixed: round(value) });
  if (start ? atEnd : !atEnd) {
    // 拖的是没有锚点的那一边：只改尺寸。
    const next = Math.max(MIN_SIZE, snap(start ? size - delta : size + delta));
    return { set: { [keys.size]: fixed(next) }, d0: start ? size - next : 0, d1: start ? 0 : next - size };
  }
  // 拖的是锚点那一边：锚点值跟着动，对边不动。
  if (offset === undefined) return undefined;
  let next = snap(atEnd ? offset - delta : offset + delta);
  if (size + offset - next < MIN_SIZE) next = round(offset + size - MIN_SIZE);
  const grown = offset - next;
  return atEnd ? { set: { [key]: next, [keys.size]: fixed(size + grown) }, d0: 0, d1: grown } : { set: { [key]: next, [keys.size]: fixed(size - (next - offset)) }, d0: next - offset, d1: 0 };
}

function writePlace(input: HandleInput, element: JsonObject, place: JsonObject): JsonObject {
  return setElement(input.document, input.path, withOwn(element, 'place', place, input.state));
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 一次手势的结果：拖动中拿它画幽灵框与读数，松手时写回它的文档。没有变化或这个手柄不适用时 undefined。 */
export function applyHandle(input: HandleInput, gesture: Gesture): HandleResult | undefined {
  const { element, isArtboard, parent } = selfOf(input);
  if (!element) return undefined;
  const id = gesture.handle, snap = snapper(gesture), state = input.state, box = input.node;
  if (id.startsWith('gap:') || id.startsWith('rows:') || id.startsWith('columns:')) return containerGesture(input, element, gesture, snap);
  if (isArtboard) return undefined;
  const mode = modeOf(parent);
  const place = isObject(own(element, 'place', state)) ? own(element, 'place', state) as JsonObject : {};
  const available = handlesOf(input).handles.some((handle) => handle.id === id);
  if (!available) return undefined;
  if (mode === 'free') {
    const sides = id === 'move' ? { left: true, right: true, top: true, bottom: true } : sidesOf(id as Edge);
    const h = freeAxis(place, 'x', gesture.dx, sides.left, sides.right, snap), v = freeAxis(place, 'y', gesture.dy, sides.top, sides.bottom, snap);
    // 一个方向绑定了变量时，移动只走另一个方向。
    const hx = h ?? { set: {}, d0: 0, d1: 0 }, vy = v ?? { set: {}, d0: 0, d1: 0 };
    const next = { ...place, ...hx.set, ...vy.set };
    if (same(next, place)) return undefined;
    const ghost = { x: box.x + hx.d0, y: box.y + vy.d0, width: box.width + hx.d1 - hx.d0, height: box.height + vy.d1 - vy.d0 };
    const readout = id === 'move'
      ? (() => { const a = anchorOf(next, 'x'), b = anchorOf(next, 'y'); return `${a.label} ${show(a.offset ?? 0)} · ${b.label} ${show(b.offset ?? 0)} mm`; })()
      : `宽 ${show(ghost.width)} × 高 ${show(ghost.height)} mm`;
    return { document: writePlace(input, element, next), ghost, readout: readout + countText(input) };
  }
  if (mode === 'stack') {
    const layout = isObject(parent?.['layout']) ? parent['layout'] : {}, row = layout['direction'] !== 'column';
    if (id === 'move') return reorder(input, row, layout['wrap'] === true, gesture);
    const sides = sidesOf(id as Edge), next = { ...place };
    let width = box.width, height = box.height;
    if (sides.right) { const fixed = sizeOf(place['width'], '', 'hug').fixed!; width = Math.max(MIN_SIZE, snap(fixed + gesture.dx)); next['width'] = { fixed: width }; }
    if (sides.bottom) { const fixed = sizeOf(place['height'], '', 'hug').fixed!; height = Math.max(MIN_SIZE, snap(fixed + gesture.dy)); next['height'] = { fixed: height }; }
    if (same(next, place)) return undefined;
    return { document: writePlace(input, element, next), ghost: { x: box.x, y: box.y, width, height }, readout: `宽 ${show(width)} × 高 ${show(height)} mm${countText(input)}` };
  }
  return gridGesture(input, element, parent!, place, gesture);
}

/** 堆叠里改顺序：指针越过了哪些兄弟元素的中线。折行时先比行，再比行内。 */
function reorder(input: HandleInput, row: boolean, wrap: boolean, gesture: Gesture): HandleResult | undefined {
  const parentNode = input.parent, parent = elementAt(input.document, parentPath(input.path))?.element;
  if (!parentNode || !parent) return undefined;
  const siblings = childrenOf(parent), self = siblings.findIndex((child) => child['name'] === nameOf(input.path));
  const kids = (parentNode.children ?? []).filter((kid) => kid.visible);
  const { x, y } = gesture.point;
  const before = (kid: LayoutNode) => {
    if (!wrap) return row ? kid.x + kid.width / 2 < x : kid.y + kid.height / 2 < y;
    return row ? kid.y + kid.height <= y || (y >= kid.y && kid.x + kid.width / 2 < x) : kid.x + kid.width <= x || (x >= kid.x && kid.y + kid.height / 2 < y);
  };
  let last = -1;
  siblings.forEach((child, index) => { const kid = index === self ? undefined : kids.find((item) => item.name === child['name']); if (kid && before(kid)) last = index; });
  const index = last + 1;
  const edited = moveElementTo(input.document, input.template, input.path, parentPath(input.path), index);
  if (!edited) return undefined;
  const order = childrenOf(elementAt(edited.document, parentPath(input.path))?.element).findIndex((child) => child['name'] === nameOf(input.path));
  const anchor = last >= 0 ? kids.find((kid) => kid.name === siblings[last]!['name']) : kids.find((kid) => kid.name !== nameOf(input.path));
  const at = anchor ? (last >= 0 ? (row ? anchor.x + anchor.width : anchor.y + anchor.height) : (row ? anchor.x : anchor.y)) : 0;
  const line = anchor ? (row ? { x: at, y: anchor.y, width: 0, height: anchor.height } : { x: anchor.x, y: at, width: anchor.width, height: 0 }) : undefined;
  const box = input.node;
  return {
    document: edited.document,
    ghost: { x: box.x + gesture.dx, y: box.y + gesture.dy, width: box.width, height: box.height },
    ...(line ? { line } : {}),
    readout: `放到第 ${order + 1} 位（共 ${siblings.length} 位）；堆叠里的先后也是叠放的先后，后面的压在前面上${countText(input)}`,
  };
}

function gridGesture(input: HandleInput, element: JsonObject, parent: JsonObject, place: JsonObject, gesture: Gesture): HandleResult | undefined {
  const parentNode = input.parent, tracks = parentNode && gridTracks(parent, parentNode);
  if (!tracks || !tracks.rows.length || !tracks.columns.length) return undefined;
  const rows = tracks.rows.length, columns = tracks.columns.length;
  let row = num(place['row']) ?? 1, column = num(place['column']) ?? 1;
  let rowSpan = num(place['rowSpan']) ?? 1, columnSpan = num(place['columnSpan']) ?? 1;
  const id = gesture.handle;
  if (id === 'move') {
    row = Math.min(trackAt(tracks.rows, gesture.point.y), rows - rowSpan + 1);
    column = Math.min(trackAt(tracks.columns, gesture.point.x), columns - columnSpan + 1);
    row = Math.max(1, row); column = Math.max(1, column);
  } else {
    const sides = sidesOf(id as Edge);
    if (sides.right) columnSpan = Math.max(1, Math.min(trackAt(tracks.columns, gesture.point.x) - column + 1, columns - column + 1));
    if (sides.bottom) rowSpan = Math.max(1, Math.min(trackAt(tracks.rows, gesture.point.y) - row + 1, rows - row + 1));
  }
  const next: JsonObject = { ...place, row, column };
  if (rowSpan !== 1 || 'rowSpan' in place) next['rowSpan'] = rowSpan;
  if (columnSpan !== 1 || 'columnSpan' in place) next['columnSpan'] = columnSpan;
  if (same(next, place)) return undefined;
  const r0 = tracks.rows[row - 1]!, r1 = tracks.rows[row + rowSpan - 2]!, c0 = tracks.columns[column - 1]!, c1 = tracks.columns[column + columnSpan - 2]!;
  const ghost = { x: c0.start, y: r0.start, width: c1.start + c1.size - c0.start, height: r1.start + r1.size - r0.start };
  const readout = id === 'move' ? `第 ${row} 行第 ${column} 列` : `跨 ${rowSpan} 行 ${columnSpan} 列`;
  return { document: writePlace(input, element, next), ghost, readout: readout + countText(input) };
}

function containerGesture(input: HandleInput, element: JsonObject, gesture: Gesture, snap: (value: number) => number): HandleResult | undefined {
  const [kind, at] = gesture.handle.split(':') as [string, string];
  const index = Number(at), state = input.state;
  const handle = containerHandles(input, element).handles.find((item) => item.id === gesture.handle);
  if (!handle?.bar) return undefined;
  if (kind === 'gap') {
    const gap = gapOf(element, state)!, value = Math.max(0, snap(gap.value! + (gap.row ? gesture.dx : gesture.dy)));
    if (value === gap.value) return undefined;
    const owner = own(element, gap.key, state) as JsonObject;
    const document = setElement(input.document, input.path, withOwn(element, gap.key, { ...owner, gap: value }, state));
    const bar = handle.bar, line = gap.row ? { ...bar, width: value } : { ...bar, height: value };
    return { document, line, readout: `间距 ${show(value)} mm${countText(input)}` };
  }
  const layout = own(element, 'layout', state) as JsonObject, axis = kind as 'rows' | 'columns';
  const list = [...(layout[axis] as unknown[])], fixed = num((list[index] as JsonObject)['fixed'])!;
  const value = Math.max(0, snap(fixed + (axis === 'rows' ? gesture.dy : gesture.dx)));
  if (value === fixed) return undefined;
  list[index] = { fixed: value };
  const document = setElement(input.document, input.path, withOwn(element, 'layout', { ...layout, [axis]: list }, state));
  const bar = handle.bar, moved = value - fixed;
  const line = axis === 'rows' ? { ...bar, y: bar.y + moved } : { ...bar, x: bar.x + moved };
  return { document, line, readout: `${axis === 'rows' ? `第 ${index + 1} 行` : `第 ${index + 1} 列`} ${show(value)} mm${countText(input)}` };
}

export type ArrowKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

/**
 * 方向键（步长和拖动吸附的相同）：自由布局挪 0.5 mm（Shift 0.1 mm）；网格挪一格；堆叠沿主轴和前后的换位。
 * 不能挪时 undefined。
 */
export function nudge(input: HandleInput, key: ArrowKey, fine: boolean): HandleResult | undefined {
  const { element, isArtboard, parent } = selfOf(input);
  if (!element || isArtboard) return undefined;
  const mode = modeOf(parent), step = fine ? FINE : SNAP, box = input.node;
  const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0, dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (mode === 'free') return applyHandle(input, { handle: 'move', dx: dx * step, dy: dy * step, point: { x: box.x, y: box.y }, exact: true });
  if (mode === 'grid') {
    const tracks = input.parent && gridTracks(parent!, input.parent);
    const place = isObject(own(element, 'place', input.state)) ? own(element, 'place', input.state) as JsonObject : {};
    const row = (num(place['row']) ?? 1) + dy, column = (num(place['column']) ?? 1) + dx;
    const r = tracks?.rows[row - 1], c = tracks?.columns[column - 1];
    if (!r || !c) return undefined;
    return applyHandle(input, { handle: 'move', dx: 0, dy: 0, point: { x: c.start + c.size / 2, y: r.start + r.size / 2 } });
  }
  const layout = isObject(parent?.['layout']) ? parent['layout'] : {}, row = layout['direction'] !== 'column';
  const step_ = row ? dx : dy;
  if (!step_ || !handlesOf(input).handles.some((handle) => handle.id === 'move')) return undefined;
  const siblings = childrenOf(parent), self = siblings.findIndex((child) => child['name'] === nameOf(input.path)), target = self + step_;
  if (target < 0 || target >= siblings.length) return undefined;
  const edited = moveElementTo(input.document, input.template, input.path, parentPath(input.path), step_ > 0 ? target + 1 : target);
  return edited ? { document: edited.document, readout: `放到第 ${target + 1} 位（共 ${siblings.length} 位）${countText(input)}` } : undefined;
}

/** 布局摘要里一处实例和它的父容器。 */
export function layoutContext(root: LayoutNode, instance: string): { readonly node: LayoutNode; readonly parent?: LayoutNode } | undefined {
  const walk = (node: LayoutNode, parent: LayoutNode | undefined): { node: LayoutNode; parent?: LayoutNode } | undefined => {
    if (node.path === instance) return parent ? { node, parent } : { node };
    for (const child of node.children ?? []) { const found = walk(child, node); if (found) return found; }
    return undefined;
  };
  return walk(root, undefined);
}
