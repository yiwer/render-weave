/**
 * 排布一块（模板设计页第三轮票据 03，方案「检查器」）：方向四个图标与九宫格对齐。
 * 这里只答"现在是哪种排布、点了之后 `layout` 整项写什么"，不碰页面；写进文档仍走 writeProperty，
 * 子元素认不得的 `place` 键由它按现有规则清掉（fitChildren）。
 * DSL 的规矩（docs/dsl/template.md「排布」）：堆叠的 `justifyContent` 管主轴、`alignItems` 管交叉轴，缺省都是 `start`；
 * 缺省值不写进文档，所以点回左上就是去掉这两个键。
 */
import { isObject, type JsonObject } from './document.js';

/** 页面上的四种排布：自由、横向堆叠、纵向堆叠、网格。 */
export type Flow = 'free' | 'row' | 'column' | 'grid';
export type Align = 'start' | 'center' | 'end';
/** 主轴上把空隙分出去的两种分布：两端、均分。 */
export type Spread = 'spaceBetween' | 'spaceEvenly';

export const FLOW_LABELS: Readonly<Record<Flow, string>> = { free: '自由', row: '横向堆叠', column: '纵向堆叠', grid: '网格' };
export const ALIGNS: readonly Align[] = ['start', 'center', 'end'];
export const SPREAD_LABELS: Readonly<Record<Spread, string>> = { spaceBetween: '两端', spaceEvenly: '均分' };

const isAlign = (value: unknown): value is Align => value === 'start' || value === 'center' || value === 'end';
const isSpread = (value: unknown): value is Spread => value === 'spaceBetween' || value === 'spaceEvenly';
const without = (object: JsonObject, ...keys: readonly string[]): JsonObject => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));

/** 现在是哪一种：没写 `layout` 是自由。 */
export function flowOf(layout: unknown): Flow {
  if (!isObject(layout)) return 'free';
  if (layout['mode'] === 'grid') return 'grid';
  if (layout['mode'] === 'stack') return layout['direction'] === 'column' ? 'column' : 'row';
  return 'free';
}

/**
 * 点了方向图标之后 `layout` 整项写什么。
 * - 堆叠之间换方向：只改 `direction`，间距、折行、对齐都留着；
 * - 堆叠与网格互换：主轴的间距带过去（横向的间距是列间距，纵向的是行间距），反过来也一样；
 * - 换成网格：原来排成一行就给同样多的列，排成一列（或自由）就给同样多的行，轨道都是随内容，子元素一格一个不重叠；
 * - 换成自由：只剩 `mode`。
 * children 是子元素个数，只在换成网格时用。
 */
export function withFlow(layout: unknown, flow: Flow, children = 0): JsonObject {
  const from = flowOf(layout), current = isObject(layout) ? layout : {};
  if (flow === 'free') return { mode: 'free' };
  if (flow === 'grid') {
    if (from === 'grid') return current;
    const tracks = Array.from({ length: Math.max(1, children) }, () => 'hug');
    const across = from === 'row', gap = current['gap'], cross = current['crossGap'];
    return {
      mode: 'grid', rows: across ? ['hug'] : tracks, columns: across ? tracks : ['hug'],
      ...(from !== 'free' && gap !== undefined ? { [across ? 'columnGap' : 'rowGap']: gap } : {}),
      ...(from !== 'free' && cross !== undefined ? { [across ? 'rowGap' : 'columnGap']: cross } : {}),
    };
  }
  if (from === 'row' || from === 'column') return { ...current, direction: flow };
  const gap = from === 'grid' ? current[flow === 'row' ? 'columnGap' : 'rowGap'] : undefined;
  return { mode: 'stack', direction: flow, ...(gap !== undefined ? { gap } : {}) };
}

export interface Alignment {
  readonly direction: 'row' | 'column';
  /** 主轴：靠哪边，或者把空隙分出去。 */
  readonly main: Align | Spread;
  readonly cross: Align;
}

/** 堆叠现在的对齐；不是堆叠时 undefined。没写的按缺省 `start`。 */
export function alignmentOf(layout: unknown): Alignment | undefined {
  if (!isObject(layout) || layout['mode'] !== 'stack') return undefined;
  const main = layout['justifyContent'], cross = layout['alignItems'];
  return { direction: layout['direction'] === 'column' ? 'column' : 'row', main: isAlign(main) || isSpread(main) ? main : 'start', cross: isAlign(cross) ? cross : 'start' };
}

/** 主轴上是不是在分空隙（两端、均分）：这时九宫格只管交叉轴。 */
export const spreadOf = (alignment: Alignment | undefined): Spread | undefined => (alignment && isSpread(alignment.main) ? alignment.main : undefined);

/**
 * 九宫格的一格（horizontal 是左中右，vertical 是上中下）落在哪根轴上：
 * 横向堆叠的主轴是水平的，所以左中右写 `justifyContent`、上中下写 `alignItems`；纵向堆叠反过来。
 */
export const cellAxes = (direction: 'row' | 'column', horizontal: Align, vertical: Align): { readonly main: Align; readonly cross: Align } =>
  (direction === 'row' ? { main: horizontal, cross: vertical } : { main: vertical, cross: horizontal });

/** 这一格是不是现在的对齐；主轴在分空隙时，交叉轴对上的那一排（或一列）三格都算。 */
export function cellOn(alignment: Alignment, horizontal: Align, vertical: Align): boolean {
  const axes = cellAxes(alignment.direction, horizontal, vertical);
  return axes.cross === alignment.cross && (isSpread(alignment.main) || axes.main === alignment.main);
}

/** 写一个键：缺省值（`start`）不写，原来有就去掉。 */
const put = (layout: JsonObject, key: string, value: Align | Spread | undefined): JsonObject => (value === undefined || value === 'start' ? without(layout, key) : { ...layout, [key]: value });

/** 点了九宫格的一格之后 `layout` 整项写什么。主轴在分空隙时只改交叉轴，分布留着。不是堆叠时原样返回。 */
export function withCell(layout: unknown, horizontal: Align, vertical: Align): JsonObject {
  const alignment = alignmentOf(layout);
  if (!alignment || !isObject(layout)) return isObject(layout) ? layout : { mode: 'free' };
  const axes = cellAxes(alignment.direction, horizontal, vertical);
  const next = put(layout, 'alignItems', axes.cross);
  return isSpread(alignment.main) ? next : put(next, 'justifyContent', axes.main);
}

/** 选了分布：两端、均分写进 `justifyContent`；选回"挨着排"是去掉它，主轴回到开头。不是堆叠时原样返回。 */
export function withSpread(layout: unknown, spread: Spread | undefined): JsonObject {
  if (!isObject(layout) || layout['mode'] !== 'stack') return isObject(layout) ? layout : { mode: 'free' };
  if (spread === undefined) return isSpread(layout['justifyContent']) ? without(layout, 'justifyContent') : layout;
  return put(layout, 'justifyContent', spread);
}

/** 九宫格一格的叫法：左上、上中、右上、左中、居中、右中、左下、下中、右下。 */
export function cellLabel(horizontal: Align, vertical: Align): string {
  const h = { start: '左', center: '中', end: '右' }[horizontal], v = { start: '上', center: '中', end: '下' }[vertical];
  if (horizontal === 'center' && vertical === 'center') return '居中';
  return horizontal === 'center' ? `${v}${h}` : `${h}${v}`;
}
