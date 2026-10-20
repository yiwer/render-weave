/**
 * 模板 DSL 解析（renderweave-template/1）。
 *
 * 把模板文档读成类型明确的模型，并在出图前发现结构错误，问题以元素路径定位。
 * 尚未实现的元素类型与属性在后续票据中逐步加入，遇到时返回问题而不是静默忽略。
 *
 * 同一个读取器有两种用法，区别只在遇到变量引用 { "var": … } 时怎么办（BindingHost）：
 * - 静态读取（parseTemplate）：记下引用（绑定、插槽、状态样式）供模板静态检查，返回占位值；
 *   状态样式的每个取值都与元素合并后读一遍，覆盖的属性同样经过检查。
 * - 求值读取（readArtboardResolved）：按作用域取值，状态样式先按变量取值选中再与元素合并；
 *   隐藏的元素不再读取其余属性，直接用静态读取的模型（M27）。
 */
import {
  RESERVED_NAME_CHARACTERS,
  childPath,
  formatElementPath,
  rootPath,
  type ElementPath,
} from '../element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { parseDisplayFormat, type DisplayFormat } from '../display-format.js';
import { isVarOperand, normalizeColor, readDeclarations } from './declarations.js';
import { parseResourceRef } from '../resources.js';
import { isRecord } from '../util.js';
import { parseStaticSchemaRef } from '../workspace.js';
import {
  BARCODE_FORMATS,
  MAX_SLANT,
  DEFAULT_MIN_FONT_SIZE,
  MIN_COMPRESSION,
  MIN_READABLE_FONT_SIZE,
  type ArtboardModel,
  type Color,
  type ContainerBody,
  type ContentItem,
  type Corners,
  type Edges,
  type ElementBase,
  type ElementModel,
  type FragmentStyle,
  type Layout,
  type Place,
  type Point,
  type Range,
  type ShapeFit,
  type ShapeStroke,
  type SizeSpec,
  type TemplateModel,
  type TextElementModel,
  type TextFit,
  type TextStroke,
  type Track,
  type VariableUse,
  type ViewBox,
  type CallArgument,
  type CallModel,
  type LoopItemSize,
  type LoopModel,
  type LoopSlice,
} from './model.js';

const TEMPLATE_KEYS = ['dslVersion', 'name', 'base', 'parameters', 'derived', 'checks', 'artboard'];
const CONTAINER_BODY_KEYS = ['layout', 'padding', 'fill', 'stroke', 'cornerRadius', 'clip', 'children'];
const ARTBOARD_KEYS = ['sizeRange', 'minFontSize', ...CONTAINER_BODY_KEYS];
const COMMON_KEYS = ['type', 'name', 'place', 'visible', 'opacity', 'rotation', 'states'];
/** 状态样式不能覆盖的属性：结构与身份。 */
const STATE_FIXED_KEYS = ['type', 'name', 'children', 'states', 'template'];
const ELEMENT_KEYS: Record<ElementModel['type'], readonly string[]> = {
  container: [...COMMON_KEYS, ...CONTAINER_BODY_KEYS],
  loop: [...COMMON_KEYS, 'list', 'reverse', 'slice', 'template', 'args', 'itemLayout', 'padding', 'fill', 'stroke', 'cornerRadius', 'clip', 'mergeBy'],
  call: [...COMMON_KEYS, 'template', 'data', 'args'],
  text: [
    ...COMMON_KEYS,
    'content',
    'font',
    'fontSize',
    'letterSpacing',
    'color',
    'writingMode',
    'horizontalAlign',
    'verticalAlign',
    'slant',
    'fit',
    'stroke',
    'padding',
    // 不支持，单独说明该怎么写（M115）。
    'fontWeight',
  ],
  image: [...COMMON_KEYS, 'source', 'fit'],
  qrcode: [...COMMON_KEYS, 'content', 'errorCorrectionLevel', 'foreground', 'background'],
  barcode: [...COMMON_KEYS, 'content', 'format', 'foreground', 'background', 'showText', 'font', 'fontSize'],
  rect: [...COMMON_KEYS, 'fill', 'stroke', 'cornerRadius'],
  ellipse: [...COMMON_KEYS, 'fill', 'stroke'],
  line: [...COMMON_KEYS, 'from', 'to', 'stroke', 'viewBox', 'fit'],
  polygon: [...COMMON_KEYS, 'points', 'fill', 'stroke', 'viewBox', 'fit'],
  path: [...COMMON_KEYS, 'd', 'fill', 'stroke', 'fillRule', 'viewBox', 'fit'],
};
const SIZE_LIMIT_KEYS = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const;
const PLACE_KEYS: Record<Layout['mode'], readonly string[]> = {
  free: ['left', 'right', 'top', 'bottom', 'width', 'height', ...SIZE_LIMIT_KEYS],
  stack: ['width', 'height', 'margin', 'alignSelf', ...SIZE_LIMIT_KEYS],
  grid: ['row', 'column', 'rowSpan', 'columnSpan', 'width', 'height', 'margin', 'justifySelf', 'alignSelf', ...SIZE_LIMIT_KEYS],
};
const FIT_KEYS = ['steps', 'compressMin', 'minFontSize', 'onFail', 'widthOverflow'];
const FRAGMENT_STYLE_KEYS = ['font', 'fontSize', 'color', 'slant', 'fontWeight'];
const NO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
const NO_CORNERS: Corners = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
const ALIGNS = ['start', 'center', 'end'] as const;

export function parseTemplate(name: string, document: unknown): { model?: TemplateModel; problems: Problem[] } {
  const host = new StaticHost();
  const reader = new TemplateReader(name, host, new WeakMap());
  const model = reader.readTemplate(document);
  return { model: reader.failed ? undefined : model, problems: dedupe(reader.problems) };
}

/** 求值读取：按作用域重新读取画板，得到绑定与状态样式都已取值的模型。 */
export function readArtboardResolved(template: TemplateModel, host: BindingHost, path = rootPath(template.name)): { artboard?: ArtboardModel; problems: Problem[] } {
  const reader = new TemplateReader(template.name, host, template.staticElements);
  const artboard = reader.readArtboard(template.artboardDocument, path);
  return { ...(artboard && { artboard }), problems: reader.problems };
}

/** 读到绑定的位置：元素路径与属性名称。 */
export interface BindingSite {
  readonly path: ElementPath;
  readonly label: string;
}

export interface NumberRule {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: boolean;
  readonly integer?: boolean;
}

/** 读取时遇到变量引用怎么办。各方法返回 undefined 表示没有可用的值（问题已报告）。 */
export interface BindingHost {
  /** 求值读取为 true：状态样式按取值选中、隐藏的元素不再读取。 */
  readonly resolving: boolean;
  color(ref: string, site: BindingSite): Read<Color>;
  /** fallback 是属性未写时的缺省值，缺值或取值不合规时用它；没有缺省值则返回 undefined。 */
  number(ref: string, site: BindingSite, rule: NumberRule, fallback: number | undefined): Read<number>;
  boolean(ref: string, site: BindingSite, fallback: boolean): Read<boolean>;
  /** 图片资源 ID；null 表示不画内容。 */
  image(ref: string, site: BindingSite): string | null;
  text(ref: string, site: BindingSite): string;
  /** 插槽：求值读取返回文字；静态读取返回 undefined，保留插槽。 */
  slot(ref: string, format: DisplayFormat | undefined, site: BindingSite): string | undefined;
  placeholder?(ref: string): string | undefined;
  /** 状态样式：求值读取返回选中的取值（没有列出时为 undefined）。 */
  state(ref: string, keys: readonly string[], site: BindingSite): string | undefined;
}

/** 静态读取：记下变量引用，返回能通过各属性检查的占位值。 */
class StaticHost implements BindingHost {
  readonly resolving = false;
  readonly uses: VariableUse[] = [];

  text(ref: string, site: BindingSite): string {
    this.uses.push({ use: 'binding', var: ref, expected: 'text', element: site.path, label: site.label });
    return '';
  }

  color(ref: string, site: BindingSite): Color {
    this.uses.push({ use: 'binding', var: ref, expected: 'color', element: site.path, label: site.label });
    return '#000000FF';
  }

  number(ref: string, site: BindingSite, rule: NumberRule, fallback: number | undefined): number {
    this.uses.push({ use: 'binding', var: ref, expected: 'number', element: site.path, label: site.label });
    if (fallback !== undefined) return fallback;
    if (rule.min !== undefined) return rule.exclusiveMin ? rule.min + 1 : rule.min;
    return rule.max !== undefined ? Math.min(0, rule.max) : 0;
  }

  boolean(ref: string, site: BindingSite, fallback: boolean): boolean {
    this.uses.push({ use: 'binding', var: ref, expected: 'boolean', element: site.path, label: site.label });
    return fallback;
  }

  image(ref: string, site: BindingSite): null {
    this.uses.push({ use: 'binding', var: ref, expected: 'image', element: site.path, label: site.label });
    return null;
  }

  slot(ref: string, format: DisplayFormat | undefined, site: BindingSite): undefined {
    this.uses.push({ use: 'slot', var: ref, ...(format && { format }), element: site.path });
    return undefined;
  }

  state(ref: string, keys: readonly string[], site: BindingSite): undefined {
    this.uses.push({ use: 'state', var: ref, keys, element: site.path });
    return undefined;
  }
}

/** 状态样式的各取值与元素合并后重读一遍，同一个问题只报一次。 */
function dedupe(problems: readonly Problem[]): Problem[] {
  const seen = new Set<string>();
  return problems.filter((problem) => {
    const key = JSON.stringify(problem);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 读取失败时返回 undefined，并已记录问题。 */
type Read<T> = T | undefined;

class TemplateReader {
  readonly problems: Problem[] = [];
  /** 有严重到无法继续使用模型的问题。 */
  failed = false;
  private readonly elementNames = new Map<string, ElementPath>();
  /** 读状态样式的各取值时为 false：同一元素再读一遍，不登记名称、不记录静态模型。 */
  private primary = true;
  private readonly calls: (LoopModel | CallModel)[] = [];
  /** 本模板画板声明的缩字下限，元素与缩字组的下限缺省取它、只能更高（M238）。作用域不继承：每个模板各读各的画板。 */
  private floor: { readonly value: number; readonly source: 'default' | 'artboard' } = { value: DEFAULT_MIN_FONT_SIZE, source: 'default' };

  constructor(
    private readonly templateName: string,
    private readonly host: BindingHost,
    private readonly staticElements: WeakMap<object, ElementModel>,
  ) {}

  readTemplate(document: unknown): Read<TemplateModel> {
    const path = rootPath(this.templateName);
    if (!isRecord(document)) {
      this.fail(path, '模板必须是 JSON 对象');
      return undefined;
    }
    this.checkKeys(document, TEMPLATE_KEYS, path, '模板');
    if (document['dslVersion'] !== 'renderweave-template/1') {
      this.fail(path, '模板的 dslVersion 必须是 renderweave-template/1');
    }
    const declared = readDeclarations(this.templateName, document);
    this.problems.push(...declared.problems);
    if (declared.problems.length > 0) this.failed = true;
    if (isRecord(document['base'])) this.checkKeys(document['base'], ['name', 'version'], path, '基准 base');
    const base = parseStaticSchemaRef(document['base']);
    if (!base) this.fail(path, '模板必须用 base 写明基准数据定义的名称与版本号');
    const artboard = this.readArtboard(document['artboard'], path);
    if (!base || !artboard || !isRecord(document['artboard'])) return undefined;
    return {
      name: this.templateName,
      base,
      ...declared.declarations,
      artboard,
      artboardDocument: document['artboard'],
      uses: this.host instanceof StaticHost ? this.host.uses : [],
      calls: this.calls,
      staticElements: this.staticElements,
    };
  }

  readArtboard(value: unknown, path: ElementPath): Read<ArtboardModel> {
    if (!isRecord(value)) {
      this.fail(path, '模板必须有画板 artboard');
      return undefined;
    }
    if (value['size'] !== undefined && value['size'] !== 'hug') this.fail(path, '画板的 size 只能取 hug；实际尺寸由调用框或渲染请求决定');
    this.checkKeys(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'size')),
      ARTBOARD_KEYS,
      path,
      '画板',
    );
    const sizeRange = this.readSizeRange(value['sizeRange'], path);
    // 先读下限，子元素的 fit 要用它。
    if (value['minFontSize'] !== undefined) {
      const floor = value['minFontSize'];
      if (isFiniteNumber(floor) && floor >= MIN_READABLE_FONT_SIZE) this.floor = { value: floor, source: 'artboard' };
      else this.fail(path, `画板的 minFontSize 不能低于 ${MIN_READABLE_FONT_SIZE} mm（M238）`);
    }
    const body = this.readContainerBody(value, path);
    if (!sizeRange || !body) return undefined;
    return { type: 'artboard', name: this.templateName, path, sizeRange, ...body };
  }

  private readSizeRange(value: unknown, path: ElementPath): Read<ArtboardModel['sizeRange']> {
    const range = (v: unknown, label: string): Read<Range> => {
      if (isRecord(v)) this.checkKeys(v, ['min', 'max'], path, `适用尺寸范围 sizeRange.${label}`);
      if (isRecord(v) && isPositive(v['min']) && isPositive(v['max']) && v['min'] <= v['max']) {
        return { min: v['min'], max: v['max'] };
      }
      this.fail(path, `画板的适用尺寸范围 sizeRange.${label} 必须写成 { "min": 毫米, "max": 毫米 }，且 min 不大于 max`);
      return undefined;
    };
    if (!isRecord(value)) {
      this.fail(path, '画板必须声明适用尺寸范围 sizeRange');
      return undefined;
    }
    this.checkKeys(value, ['width', 'height'], path, '适用尺寸范围 sizeRange');
    const width = range(value['width'], 'width');
    const height = range(value['height'], 'height');
    return width && height ? { width, height } : undefined;
  }

  private readContainerBody(value: Record<string, unknown>, path: ElementPath): Read<ContainerBody> {
    const layout = this.readLayout(value['layout'], path);
    const padding = this.readEdges(value['padding'], path, 'padding');
    const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
    const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
    const cornerRadius = this.readCorners(value['cornerRadius'], path);
    const clip = this.readBoolean(value['clip'], false, path, 'clip');
    // null 不当作"没写"（M224），与 JSON Schema 一致；下同。
    const childrenValue = value['children'] === undefined ? [] : value['children'];
    const children: ElementModel[] = [];
    if (!Array.isArray(childrenValue)) {
      this.fail(path, 'children 必须是元素列表');
    } else if (layout) {
      for (const child of childrenValue) {
        const element = this.readElement(child, path, layout);
        if (element) children.push(element);
      }
    }
    if (!layout || !padding || fill === null || stroke === null || !cornerRadius || clip === undefined) return undefined;
    return {
      layout,
      padding,
      ...(fill && { fill }),
      ...(stroke && { stroke }),
      cornerRadius,
      clip,
      children,
    };
  }

  private readLayout(value: unknown, path: ElementPath): Read<Layout> {
    if (value === undefined) return { mode: 'free' };
    if (!isRecord(value) || typeof value['mode'] !== 'string') {
      this.fail(path, '布局方式 layout 必须写成 { "mode": "free" | "stack" | "grid", … }');
      return undefined;
    }
    switch (value['mode']) {
      case 'free':
        this.checkKeys(value, ['mode'], path, '自由布局');
        return { mode: 'free' };
      case 'stack': {
        this.checkKeys(value, ['mode', 'direction', 'gap', 'wrap', 'crossGap', 'justifyContent', 'alignItems'], path, '堆叠布局');
        const direction = this.readEnum(value['direction'], ['row', 'column'] as const, undefined, path, 'layout.direction');
        const gap = this.readNumber(value['gap'], 0, path, 'layout.gap', { min: 0 });
        const wrap = this.readLiteralBoolean(value['wrap'], false, path, 'layout.wrap');
        const crossGap = value['crossGap'] === undefined ? gap : this.readNumber(value['crossGap'], gap ?? 0, path, 'layout.crossGap', { min: 0 });
        const justifyContent = this.readEnum(
          value['justifyContent'],
          ['start', 'center', 'end', 'spaceBetween', 'spaceEvenly'] as const,
          'start',
          path,
          'layout.justifyContent',
        );
        const alignItems = this.readEnum(value['alignItems'], ALIGNS, 'start', path, 'layout.alignItems');
        if (!direction || gap === undefined || wrap === undefined || crossGap === undefined || !justifyContent || !alignItems) return undefined;
        return { mode: 'stack', direction, gap, wrap, crossGap, justifyContent, alignItems };
      }
      case 'grid': {
        this.checkKeys(value, ['mode', 'rows', 'columns', 'rowGap', 'columnGap'], path, '网格布局');
        const rows = this.readTracks(value['rows'], path, 'rows');
        const columns = this.readTracks(value['columns'], path, 'columns');
        const rowGap = this.readNumber(value['rowGap'], 0, path, 'layout.rowGap', { min: 0 });
        const columnGap = this.readNumber(value['columnGap'], 0, path, 'layout.columnGap', { min: 0 });
        if (!rows || !columns || rowGap === undefined || columnGap === undefined) return undefined;
        return { mode: 'grid', rows, columns, rowGap, columnGap };
      }
      default:
        this.fail(path, `布局方式只能是 free、stack 或 grid，不能是 ${String(value['mode'])}`);
        return undefined;
    }
  }

  private readTracks(value: unknown, path: ElementPath, label: string): Read<Track[]> {
    if (!Array.isArray(value) || value.length === 0) {
      this.fail(path, `网格的 ${label} 必须是非空列表`);
      return undefined;
    }
    const tracks: Track[] = [];
    for (const track of value) {
      if (track === 'hug') tracks.push({ kind: 'hug' });
      else if (isRecord(track) && Object.keys(track).length === 1 && typeof track['fixed'] === 'number' && track['fixed'] >= 0) {
        tracks.push({ kind: 'fixed', value: track['fixed'] });
      } else if (isRecord(track) && Object.keys(track).length === 1 && isPositive(track['fraction'])) {
        tracks.push({ kind: 'fraction', value: track['fraction'] });
      } else {
        this.fail(path, `网格的 ${label} 每项写成 { "fixed": 毫米 }、{ "fraction": 比例 } 或 "hug"`);
        return undefined;
      }
    }
    return tracks;
  }

  private readElement(document: unknown, parent: ElementPath, parentLayout: Layout): Read<ElementModel> {
    if (!isRecord(document)) {
      this.fail(parent, '元素必须是 JSON 对象');
      return undefined;
    }
    const name = this.readElementName(document['name'], parent);
    if (name === undefined) return undefined;
    const path = childPath(parent, name);
    const value = this.applyStates(document, path, parent, parentLayout);
    if (!value) return undefined;
    if (this.host.resolving) {
      // 隐藏的元素不参与布局，也不再读取其余属性（其绑定可能本来就缺值，如末站的"下一站地标"）。
      const visible = this.readBoolean(value['visible'], true, path, 'visible');
      const fallback = this.staticElements.get(document);
      if (visible === false && fallback) return { ...fallback, path, visible: false };
      const element = this.readElementBody(value, name, path, parentLayout);
      // 求值时取到的值不能用（问题已报告）：元素按隐藏处理，其余元素照常排版。
      return element ?? (fallback && { ...fallback, path, visible: false });
    }
    const element = this.readElementBody(value, name, path, parentLayout);
    if (element && this.primary) this.staticElements.set(document, element);
    return element;
  }

  /**
   * 状态样式（M28，S5）：按变量取值覆盖属性，未列出的取值沿用元素自身属性；覆盖值可以是字面值或变量。
   * 静态读取时把每个取值的覆盖与元素合并后各读一遍；求值读取时返回选中取值合并后的元素文档。
   */
  private applyStates(
    document: Record<string, unknown>,
    path: ElementPath,
    parent: ElementPath,
    parentLayout: Layout,
  ): Read<Record<string, unknown>> {
    const states = document['states'];
    if (states === undefined) return document;
    const usage = '状态样式写成 { "by": { "var": 变量 }, "cases": { 取值: { 属性: 值 } } }';
    if (!isRecord(states) || !isVarOperand(states['by']) || !isRecord(states['cases'])) {
      this.fail(path, usage);
      return undefined;
    }
    this.checkKeys(states, ['by', 'cases'], path, '状态样式');
    const cases = states['cases'];
    for (const [key, override] of Object.entries(cases)) {
      if (!isRecord(override)) {
        this.fail(path, `状态样式取值"${key}"的覆盖必须是对象：${usage}`);
        return undefined;
      }
      const fixed = Object.keys(override).filter((property) => STATE_FIXED_KEYS.includes(property));
      if (fixed.length > 0) {
        this.fail(path, `状态样式不能覆盖 ${fixed.join('、')}（取值"${key}"）`);
        return undefined;
      }
    }
    const { states: _states, ...own } = document;
    const chosen = this.host.state(states['by'].var, Object.keys(cases), { path, label: 'states.by' });
    if (this.host.resolving) return chosen === undefined ? own : { ...own, ...(cases[chosen] as Record<string, unknown>) };
    if (this.primary) {
      this.primary = false;
      try {
        for (const override of Object.values(cases)) {
          // 子元素不随状态变化，不必再读。
          const merged = { ...own, ...(override as Record<string, unknown>) };
          if ('children' in merged) merged['children'] = [];
          this.readElement(merged, parent, parentLayout);
        }
      } finally {
        this.primary = true;
      }
    }
    return own;
  }

  private readElementBody(value: Record<string, unknown>, name: string, path: ElementPath, parentLayout: Layout): Read<ElementModel> {
    const type = value['type'];
    if (typeof type !== 'string' || !Object.hasOwn(ELEMENT_KEYS, type)) {
      this.fail(path, `未知的元素类型 ${String(type)}`);
      return undefined;
    }
    const elementType = type as ElementModel['type'];
    this.checkKeys(value, ELEMENT_KEYS[elementType].filter((key) => key !== 'states'), path, '元素');
    const base = this.readElementBase(value, name, path, parentLayout);

    let element: Read<ElementModel>;
    switch (elementType) {
      case 'loop':
      case 'call':
        element = this.readCall(value, base, path, elementType);
        if (element && !this.host.resolving) this.calls.push(element);
        break;
      case 'container': {
        const body = this.readContainerBody(value, path);
        element = base && body && { ...base, type: 'container', ...body };
        break;
      }
      case 'text':
        element = this.readText(value, base, path);
        break;
      case 'image': {
        const source = value['source'] === undefined ? null : this.readImageSource(value['source'], path);
        const fit = this.readEnum(value['fit'], ['contain', 'cover', 'fill'] as const, 'contain', path, 'fit');
        element = base && source !== undefined && fit ? { ...base, type: 'image', ...(source !== null && { source }), fit } : undefined;
        break;
      }
      case 'barcode': {
        const raw = value['content'];
        const content = isVarOperand(raw) ? this.host.text(raw.var, { path, label: 'content' })
          : typeof raw === 'string' ? raw : this.fail(path, '条形码 content 必须是文本或文本变量绑定');
        const format = BARCODE_FORMATS.find(format => format === value['format'])
          ?? this.fail(path, `条形码 format 必须明确指定 ${BARCODE_FORMATS.join('、')}`);
        const foreground = this.readColor(value['foreground'] === undefined ? '#000000' : value['foreground'], path, 'foreground');
        const background = this.readColor(value['background'] === undefined ? '#FFFFFF' : value['background'], path, 'background');
        const showText = this.readBoolean(value['showText'], false, path, 'showText');
        const font = value['font'] !== undefined || showText ? this.readFont(value['font'], path, '条形码下方文字 font') : undefined;
        const fontSize = this.readNumber(value['fontSize'], 3, path, 'fontSize', { min: 0, exclusiveMin: true });
        const defaultSize: SizeSpec = parentLayout.mode === 'grid' ? { kind: 'fill', weight: 1 } : { kind: 'hug' };
        element = base && content !== undefined && format && foreground && background && showText !== undefined && fontSize !== undefined
          && (!(value['font'] !== undefined || showText) || font)
          ? { ...base, place: { ...base.place, width: base.place.width ?? defaultSize, height: base.place.height ?? defaultSize },
            type: 'barcode', format, content, foreground, background, showText, ...(font && { font }), fontSize } : undefined;
        break;
      }
      case 'qrcode': {
        const raw = value['content'];
        const content = isVarOperand(raw) ? this.host.text(raw.var, { path, label: 'content' })
          : typeof raw === 'string' ? raw : this.fail(path, '二维码 content 必须是文本或文本变量绑定');
        const errorCorrectionLevel = this.readEnum(value['errorCorrectionLevel'], ['L', 'M', 'Q', 'H'] as const, 'M', path, 'errorCorrectionLevel');
        const foreground = this.readColor(value['foreground'] === undefined ? '#000000' : value['foreground'], path, 'foreground');
        const background = this.readColor(value['background'] === undefined ? '#FFFFFF' : value['background'], path, 'background');
        const defaultSize: SizeSpec = parentLayout.mode === 'grid' ? { kind: 'fill', weight: 1 } : { kind: 'hug' };
        element = base && content !== undefined && errorCorrectionLevel && foreground && background
          ? { ...base, place: { ...base.place, width: base.place.width ?? defaultSize, height: base.place.height ?? defaultSize },
            type: 'qrcode', content, errorCorrectionLevel, foreground, background } : undefined;
        break;
      }
      case 'rect': {
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        const cornerRadius = this.readCorners(value['cornerRadius'], path);
        element =
          base && fill !== null && stroke !== null && cornerRadius
            ? { ...base, type: 'rect', ...(fill && { fill }), ...(stroke && { stroke }), cornerRadius }
            : undefined;
        break;
      }
      case 'ellipse': {
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        element = base && fill !== null && stroke !== null ? { ...base, type: 'ellipse', ...(fill && { fill }), ...(stroke && { stroke }) } : undefined;
        break;
      }
      case 'line': {
        const from = this.readPoint(value['from'], path, 'from');
        const to = this.readPoint(value['to'], path, 'to');
        const stroke = value['stroke'] === undefined ? this.fail(path, '线条必须有描边 stroke') : this.readShapeStroke(value['stroke'], path);
        const scaling = this.readShapeScaling(value, path);
        element = base && from && to && stroke && scaling ? { ...base, type: 'line', from, to, stroke, ...scaling } : undefined;
        break;
      }
      case 'polygon': {
        const points = this.readPoints(value['points'], path);
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        const scaling = this.readShapeScaling(value, path);
        element =
          base && points && fill !== null && stroke !== null && scaling
            ? { ...base, type: 'polygon', points, ...(fill && { fill }), ...(stroke && { stroke }), ...scaling }
            : undefined;
        break;
      }
      case 'path': {
        const d = value['d'];
        if (typeof d !== 'string' || d.trim() === '') this.fail(path, '路径必须用 d 给出 SVG 路径数据（毫米）；路径数据不能绑定变量（M71）');
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        const fillRule = this.readEnum(value['fillRule'], ['nonzero', 'evenodd'] as const, 'nonzero', path, 'fillRule');
        const scaling = this.readShapeScaling(value, path);
        element =
          base && typeof d === 'string' && d.trim() !== '' && fill !== null && stroke !== null && fillRule && scaling
            ? { ...base, type: 'path', d, fillRule, ...(fill && { fill }), ...(stroke && { stroke }), ...scaling }
            : undefined;
        break;
      }
    }
    return element;
  }

  private readCall(value: Record<string, unknown>, base: Read<ElementBase>, path: ElementPath, type: 'loop' | 'call'): Read<LoopModel | CallModel> {
    const template = value['template'];
    if (typeof template !== 'string' || template.trim() === '') return this.fail(path, '调用必须用 template 指定模板名称');
    const argsValue = value['args'] === undefined ? {} : value['args'];
    if (!isRecord(argsValue)) return this.fail(path, '调用的 args 必须是参数名称到运算数的对象');
    const args: Record<string, CallArgument> = Object.create(null) as Record<string, CallArgument>;
    for (const [name, argument] of Object.entries(argsValue)) {
      if (isVarOperand(argument)) args[name] = argument;
      else if (isRecord(argument) && Object.keys(argument).length === 1 &&
        (typeof argument['value'] === 'string' || typeof argument['value'] === 'boolean' || isFiniteNumber(argument['value']))) {
        args[name] = { value: argument['value'] };
      } else if (type === 'loop' && isRecord(argument) && Object.keys(argument).length === 1 &&
        ['index', 'isFirst', 'isLast', 'count', 'groupSize'].includes(String(argument['loop']))) {
        args[name] = { loop: argument['loop'] as 'index' | 'isFirst' | 'isLast' | 'count' | 'groupSize' };
      } else this.fail(path, `参数 ${name} 写成 { var: 路径 }、{ value: 固定值 }；循环容器还可用 { loop: index/isFirst/isLast/count/groupSize }`);
    }
    if (type === 'call') {
      const data = value['data'] === undefined ? 'none' : value['data'];
      if (data !== 'current' && data !== 'none' && !isVarOperand(data)) return this.fail(path, '子模板数据 data 写成 { var: 单引用路径 }、current 或 none');
      return base && { ...base, type, template, data, args };
    }
    const mergeBy = value['mergeBy'];
    if (mergeBy !== undefined && (typeof mergeBy !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/.test(mergeBy))) {
      return this.fail(path, 'mergeBy 必须是列表项中的字段路径');
    }
    const list = value['list'];
    if (!isVarOperand(list)) return this.fail(path, '循环的 list 必须是 { var: 列表字段路径 }');
    const reverse = this.readBoolean(value['reverse'], false, path, 'reverse');
    const slice = this.optional(value['slice'], (v) => this.readSlice(v, path));
    const item = value['itemLayout'];
    if (!isRecord(item)) return this.fail(path, '循环必须声明 itemLayout');
    this.checkKeys(item, ['direction', 'widths', 'heights', 'gap', 'wrap', 'crossGap', 'spanBy'], path, 'itemLayout');
    const spanBy = item['spanBy'];
    if (spanBy !== undefined && spanBy !== 'groupSize') return this.fail(path, 'itemLayout.spanBy 只能取 groupSize');
    const direction = this.readEnum(item['direction'], ['row', 'column'] as const, 'row', path, 'itemLayout.direction');
    if (!direction) return undefined;
    const gap = this.readNumber(item['gap'], 0, path, 'itemLayout.gap', { min: 0 });
    const wrap = this.readLiteralBoolean(item['wrap'], false, path, 'itemLayout.wrap');
    const crossGap = item['crossGap'] === undefined ? gap : this.readNumber(item['crossGap'], gap ?? 0, path, 'itemLayout.crossGap', { min: 0 });
    // 两个方向各用各的词：横向 widths、纵向 heights，写错方向的词时指明该用哪个（M236）。
    const [sizeKey, otherKey] = direction === 'row' ? ['widths', 'heights'] as const : ['heights', 'widths'] as const;
    if (item[otherKey] !== undefined) {
      return this.fail(path, `${direction === 'row' ? '横向' : '纵向'}循环用 itemLayout.${sizeKey} 指定每项${direction === 'row' ? '宽度' : '高度'}，不写 ${otherKey}`);
    }
    const size = this.readLoopItemSize(item[sizeKey], path, sizeKey);
    if (!size) return undefined;
    if (wrap) {
      if (mergeBy !== undefined || spanBy !== undefined) {
        return this.fail(path, '开启 wrap 的循环容器不能与 mergeBy 或 spanBy 同时使用');
      }
      if (size === 'equal') {
        return this.fail(path, `开启 wrap 的循环容器 itemLayout.${sizeKey} 只能取 content 或 { fixed: 毫米 }，不能取 equal`);
      }
    }
    if (mergeBy !== undefined && (size !== 'equal' || spanBy !== 'groupSize')) {
      return this.fail(path, `合并循环必须使用 ${sizeKey}: equal、spanBy: groupSize，按原始项数分${direction === 'row' ? '列' : '行'}`);
    }
    if (spanBy !== undefined && mergeBy === undefined) return this.fail(path, 'spanBy: groupSize 需要同时指定 mergeBy');
    const body = this.readContainerBody({ ...value, layout: { mode: 'free' }, children: [] }, path);
    if (!base || !body || gap === undefined || wrap === undefined || crossGap === undefined || reverse === undefined || slice === null) return undefined;
    const { children: _children, layout: _layout, ...appearance } = body;
    return { ...base, ...appearance, type, template, list, reverse, ...(slice && { slice }), args, ...(typeof mergeBy === 'string' && { mergeBy }),
      itemLayout: direction === 'row'
        ? { direction, widths: size, gap, wrap, crossGap, ...(spanBy && { spanBy }) }
        : { direction, heights: size, gap, wrap, crossGap, ...(spanBy && { spanBy }) } };
  }

  private readSlice(value: unknown, path: ElementPath): Read<LoopSlice> {
    if (!isRecord(value)) return this.fail(path, '循环的 slice 必须是对象');
    this.checkKeys(value, ['start', 'end'], path, '循环的 slice');
    const rawStart = value['start'];
    const rawEnd = value['end'];
    if (rawStart === undefined && rawEnd === undefined) {
      return this.fail(path, '循环的 slice 至少要指定 start 或 end 之一');
    }
    const readBound = (raw: unknown, label: string): Read<number> => {
      const unwrapped = isRecord(raw) && Object.keys(raw).length === 1 && 'value' in raw ? raw['value'] : raw;
      return this.readNumber(unwrapped, undefined, path, label, { min: 1, integer: true });
    };
    const start = rawStart === undefined ? undefined : readBound(rawStart, 'slice.start');
    const end = rawEnd === undefined ? undefined : readBound(rawEnd, 'slice.end');
    if ((rawStart !== undefined && start === undefined) || (rawEnd !== undefined && end === undefined)) {
      return undefined;
    }
    if (start !== undefined && end !== undefined && start > end) {
      if (this.host.resolving) {
        this.report(
          ProblemCodes.templateBindingValueInvalid,
          path,
          `循环的 slice.start（${start}）不能大于 slice.end（${end}），该元素不显示（M119）`,
        );
        return undefined;
      }
      if (!isVarOperand(rawStart) && !isVarOperand(rawEnd)) {
        return this.fail(path, '循环的 slice.start 不能大于 slice.end');
      }
    }
    return { ...(start !== undefined && { start }), ...(end !== undefined && { end }) };
  }

  private readLoopItemSize(value: unknown, path: ElementPath, key: 'widths' | 'heights'): Read<LoopItemSize> {
    if (value === 'equal' || value === 'content') return value;
    if (isRecord(value) && Object.keys(value).length === 1) {
      const fixed = this.readNumber(value['fixed'], undefined, path, `itemLayout.${key}.fixed`, { min: 0, exclusiveMin: true });
      return fixed === undefined ? undefined : { fixed };
    }
    return this.fail(path, `itemLayout.${key} 写成 equal、content 或 { fixed: 毫米 }`);
  }

  private readElementName(value: unknown, parent: ElementPath): Read<string> {
    if (typeof value !== 'string' || value === '') {
      this.fail(parent, '元素必须有名称 name');
      return undefined;
    }
    // 求值读取与状态样式的重读都是同一批元素，名称已在静态读取时检查过。
    if (this.host.resolving || !this.primary) return value;
    const path = childPath(parent, value);
    if (RESERVED_NAME_CHARACTERS.some((ch) => value.includes(ch))) {
      this.report(ProblemCodes.templateInvalidElementName, path, `元素名称"${value}"不能含有 / [ ]`);
      this.failed = true;
    }
    const previous = this.elementNames.get(value);
    if (previous) {
      this.report(ProblemCodes.templateDuplicateElementName, path, `元素名称"${value}"在模板内重复，已用于 ${formatElementPath(previous)}`);
      this.failed = true;
    } else {
      this.elementNames.set(value, path);
    }
    return value;
  }

  private readElementBase(value: Record<string, unknown>, name: string, path: ElementPath, parentLayout: Layout): Read<ElementBase> {
    const place = this.readPlace(value['place'], path, parentLayout);
    const visible = this.readBoolean(value['visible'], true, path, 'visible');
    const opacity = this.readNumber(value['opacity'], 1, path, 'opacity', { min: 0, max: 1 });
    const rotation = this.readNumber(value['rotation'], 0, path, 'rotation', {});
    if (!place || visible === undefined || opacity === undefined || rotation === undefined) return undefined;
    return { name, path, place, visible, opacity, rotation };
  }

  private readPlace(value: unknown, path: ElementPath, parentLayout: Layout): Read<Place> {
    const place = value === undefined ? {} : value;
    if (!isRecord(place)) {
      this.fail(path, 'place 必须是对象');
      return undefined;
    }
    const modeName = { free: '自由', stack: '堆叠', grid: '网格' }[parentLayout.mode];
    for (const key of Object.keys(place)) {
      if (!PLACE_KEYS[parentLayout.mode].includes(key)) {
        this.report(ProblemCodes.templateUnknownProperty, path, `所在容器是${modeName}布局，place 中不能写 ${key}`);
        this.failed = true;
      }
    }

    const edge = <E extends string>(a: E, b: E, axis: string): Read<{ edge: E; offset: number }> => {
      if (place[a] !== undefined && place[b] !== undefined) {
        this.fail(path, `${axis}位置只能写 ${a} 或 ${b} 之一`);
        return undefined;
      }
      const key = place[b] !== undefined ? b : a;
      const offset = this.readNumber(place[key], 0, path, `place.${key}`, {});
      return offset === undefined ? undefined : { edge: key, offset };
    };
    const horizontal = edge('left', 'right', '横向');
    const vertical = edge('top', 'bottom', '纵向');

    let row = 1;
    let column = 1;
    let rowSpan = 1;
    let columnSpan = 1;
    if (parentLayout.mode === 'grid') {
      const index = (key: string, fallback: number | undefined) =>
        this.readNumber(place[key], fallback, path, `place.${key}`, { min: 1, integer: true });
      if (place['row'] === undefined || place['column'] === undefined) this.fail(path, '网格中的元素必须写明所在行 row 与列 column');
      row = index('row', 1) ?? 1;
      column = index('column', 1) ?? 1;
      rowSpan = index('rowSpan', 1) ?? 1;
      columnSpan = index('columnSpan', 1) ?? 1;
      if (row + rowSpan - 1 > parentLayout.rows.length) {
        this.fail(path, `网格只有 ${parentLayout.rows.length} 行，元素占到第 ${row + rowSpan - 1} 行`);
        return undefined;
      }
      if (column + columnSpan - 1 > parentLayout.columns.length) {
        this.fail(path, `网格只有 ${parentLayout.columns.length} 列，元素占到第 ${column + columnSpan - 1} 列`);
        return undefined;
      }
    }

    const width = this.optional(place['width'], (v) => this.readSize(v, path, 'width'));
    const height = this.optional(place['height'], (v) => this.readSize(v, path, 'height'));
    const limits: Partial<Record<(typeof SIZE_LIMIT_KEYS)[number], number>> = {};
    for (const key of SIZE_LIMIT_KEYS) {
      const limit = this.optional(place[key], (v) => this.readNumber(v, undefined, path, `place.${key}`, { min: 0 }));
      if (typeof limit === 'number') limits[key] = limit;
    }
    if (limits.minWidth !== undefined && limits.maxWidth !== undefined && limits.minWidth > limits.maxWidth) {
      this.fail(path, 'minWidth 不能大于 maxWidth');
    }
    if (limits.minHeight !== undefined && limits.maxHeight !== undefined && limits.minHeight > limits.maxHeight) {
      this.fail(path, 'minHeight 不能大于 maxHeight');
    }
    const margin = this.readEdges(place['margin'], path, 'place.margin');
    const justifySelf = this.optional(place['justifySelf'], (v) => this.readEnum(v, ALIGNS, undefined, path, 'place.justifySelf'));
    const alignSelf = this.optional(place['alignSelf'], (v) => this.readEnum(v, ALIGNS, undefined, path, 'place.alignSelf'));
    if (!horizontal || !vertical || width === null || height === null || !margin || justifySelf === null || alignSelf === null) {
      return undefined;
    }
    return {
      horizontal,
      vertical,
      row,
      column,
      rowSpan,
      columnSpan,
      ...(width && { width }),
      ...(height && { height }),
      ...limits,
      margin,
      ...(justifySelf && { justifySelf }),
      ...(alignSelf && { alignSelf }),
    };
  }

  /** 图片来源：资源引用 res:资源ID，或绑定图片类型的变量（缺值时不画内容）。 */
  private readImageSource(value: unknown, path: ElementPath): string | null | undefined {
    if (isVarOperand(value)) return this.host.image(value.var, { path, label: 'source' });
    const id = typeof value === 'string' ? parseResourceRef(value) : undefined;
    if (!id) this.fail(path, '图片来源 source 必须是资源引用 res:资源ID');
    return id;
  }

  private readSize(value: unknown, path: ElementPath, label: string): Read<SizeSpec> {
    if (value === 'hug') return { kind: 'hug' };
    if (value === 'fill') return { kind: 'fill', weight: 1 };
    if (isRecord(value) && Object.keys(value).length === 1) {
      if ('fixed' in value && (isVarOperand(value['fixed']) || typeof value['fixed'] === 'number')) {
        const fixed = this.readNumber(value['fixed'], undefined, path, `${label}.fixed`, { min: 0 });
        return fixed === undefined ? undefined : { kind: 'fixed', value: fixed };
      }
      if (isPositive(value['fill'])) return { kind: 'fill', weight: value['fill'] };
    }
    this.fail(path, `${label} 写成 { "fixed": 毫米 }、"hug"、"fill" 或 { "fill": 权重 }`);
    return undefined;
  }

  private readText(value: Record<string, unknown>, base: Read<ElementBase>, path: ElementPath): Read<TextElementModel> {
    this.rejectFontWeight(value, path);
    const writingMode = this.readEnum(value['writingMode'], ['horizontal', 'vertical'] as const, 'horizontal', path, 'writingMode');
    const content = this.readContent(value['content'], writingMode, path);
    const font = this.readFont(value['font'], path, '文本的字体 font');
    const fontSize = this.readNumber(value['fontSize'], undefined, path, 'fontSize', { min: 0, exclusiveMin: true });
    const letterSpacing = this.readNumber(value['letterSpacing'], 0, path, 'letterSpacing', {});
    const color = value['color'] === undefined ? '#000000FF' : this.readColor(value['color'], path, 'color');
    const slant = this.readSlant(value['slant'], path, 'slant');
    if (slant && writingMode === 'vertical') this.unsupported(path, '竖排文字的倾斜 slant 尚未支持');
    const horizontalAlign = this.readEnum(value['horizontalAlign'], [...ALIGNS, 'distribute', 'spaceEvenly'] as const, 'start', path, 'horizontalAlign');
    if ((horizontalAlign === 'distribute' || horizontalAlign === 'spaceEvenly') && writingMode !== 'horizontal') {
      this.fail(path, `horizontalAlign 取 ${horizontalAlign} 只用于横排文字`);
    }
    const verticalAlign = this.readEnum(value['verticalAlign'], ['top', 'center', 'bottom', 'distribute'] as const, 'top', path, 'verticalAlign');
    if (verticalAlign === 'distribute' && writingMode !== 'vertical') {
      this.fail(path, 'verticalAlign 取 distribute（两端分布）只用于竖排文字');
    }
    const fit = this.readFit(value['fit'], writingMode, path);
    const stroke = this.optional(value['stroke'], (v) => this.readTextStroke(v, path));
    const padding = this.readEdges(value['padding'], path, 'padding');
    if (!base || !content || !font || fontSize === undefined || letterSpacing === undefined || !color || slant === undefined) return undefined;
    if (!writingMode || !horizontalAlign || !verticalAlign || !fit || stroke === null || !padding) return undefined;
    return {
      ...base,
      type: 'text',
      content,
      font,
      fontSize,
      letterSpacing,
      color,
      slant,
      writingMode,
      horizontalAlign,
      verticalAlign,
      fit,
      ...(stroke && { stroke }),
      padding,
    };
  }

  /**
   * 文本内容：文字片段 { "text" } 与变量插槽 { "slot", "format"? }，都可单独写 font、fontSize、color、slant，
   * 未写的沿用文本元素的设置（M73）。竖排文字片段可写 font、fontSize、color，不能设倾斜 slant（M109、M244）。
   */
  private readContent(value: unknown, writingMode: Read<TextElementModel['writingMode']>, path: ElementPath): Read<ContentItem[]> {
    if (!Array.isArray(value)) {
      this.fail(path, '文本内容 content 必须是片段列表');
      return undefined;
    }
    const items: ContentItem[] = [];
    for (const item of value) {
      const isText = isRecord(item) && 'text' in item;
      const isSlot = isRecord(item) && 'slot' in item;
      if (!isRecord(item) || isText === isSlot) {
        this.fail(path, '文本片段必须写成 { "text": 文字 } 或 { "slot": 变量路径 }，可另写 font、fontSize、color、slant');
        return undefined;
      }
      this.rejectFontWeight(item, path);
      this.checkKeys(item, isText ? ['text', ...FRAGMENT_STYLE_KEYS] : ['slot', 'format', ...FRAGMENT_STYLE_KEYS], path, isText ? '文字片段' : '变量插槽');
      const style = this.readFragmentStyle(item, path);
      if (!style) return undefined;
      if (writingMode === 'vertical' && style.slant !== undefined) {
        this.unsupported(path, '竖排文字的倾斜 slant 尚未支持');
        return undefined;
      }
      if (isText) {
        if (typeof item['text'] !== 'string') {
          this.fail(path, '文字片段的 text 必须是字符串');
          return undefined;
        }
        items.push({ kind: 'text', text: item['text'], style });
        continue;
      }
      const slot = item['slot'];
      if (typeof slot !== 'string' || !/^[^.]+(\.[^.]+)*$/.test(slot)) {
        this.fail(path, '变量插槽的 slot 必须是用"."分隔的变量路径，如 terminal.name');
        return undefined;
      }
      const format = item['format'] === undefined ? undefined : this.readDisplayFormat(item['format'], path, slot);
      if (item['format'] !== undefined && !format) return undefined;
      const text = this.host.slot(slot, format, { path, label: '插槽' });
      if (text !== undefined) {
        const placeholder = text === '' ? this.host.placeholder?.(slot) : undefined;
        items.push({ kind: 'text', text, style, ...(placeholder && { placeholder }) });
      }
      else items.push({ kind: 'slot', path: slot, ...(format && { format }), style });
    }
    return items;
  }

  private readDisplayFormat(value: unknown, path: ElementPath, slot: string): Read<DisplayFormat> {
    const parsed = typeof value === 'string' ? parseDisplayFormat(value) : '展示格式 format 必须是字符串，如 HH:mm、0.##';
    if (typeof parsed !== 'string') return parsed;
    this.fail(path, `插槽 ${slot}：${parsed}`);
    return undefined;
  }

  private readFragmentStyle(item: Record<string, unknown>, path: ElementPath): Read<FragmentStyle> {
    const style: { font?: string; fontSize?: number; color?: Color; slant?: number } = {};
    let ok = true;
    const read = <T>(key: string, reader: (value: unknown) => Read<T>, assign: (value: T) => void) => {
      if (item[key] === undefined) return;
      const value = reader(item[key]);
      if (value === undefined) ok = false;
      else assign(value);
    };
    read('font', (v) => this.readFont(v, path, '片段的字体 font'), (v) => (style.font = v));
    read('fontSize', (v) => this.readNumber(v, undefined, path, '片段的 fontSize', { min: 0, exclusiveMin: true }), (v) => (style.fontSize = v));
    read('color', (v) => this.readColor(v, path, '片段的 color'), (v) => (style.color = v));
    read('slant', (v) => this.readSlant(v, path, '片段的 slant'), (v) => (style.slant = v));
    return ok ? style : undefined;
  }

  private readFont(value: unknown, path: ElementPath, label: string): Read<string> {
    if (isVarOperand(value)) {
      this.fail(path, `${label} 不能绑定变量；需要按取值换字体时用状态样式`);
      return undefined;
    }
    const font = typeof value === 'string' ? parseResourceRef(value) : undefined;
    if (!font) this.fail(path, `${label} 必须是资源引用 res:资源ID`);
    return font;
  }

  /** 倾斜角度，度，绝对值不超过 MAX_SLANT。 */
  private readSlant(value: unknown, path: ElementPath, label: string): Read<number> {
    return this.readNumber(value, 0, path, label, { min: -MAX_SLANT, max: MAX_SLANT });
  }

  /** 字重随字体资源（M115）：写了 fontWeight 时说明该怎么写，而不只是报未知属性。 */
  private rejectFontWeight(value: Record<string, unknown>, path: ElementPath): void {
    if (value['fontWeight'] === undefined) return;
    this.fail(path, '字重由字体资源决定，不写 fontWeight：改用对应字重的字体资源，如 font 写 res:font-hei-heavy（M115）');
  }

  /**
   * 放不下时的处理。竖排支持 tightenSpacing、compressGlyphs，且收紧字距必须在压缩字形之前（M82）；
   * 横排先 compressGlyphs 再 shrink；竖排可用 widthOverflow 按列宽全组统一缩字。
   * 不写 fit 时文字不做适配，放不下即按严重问题上报（M109）。
   */
  private readFit(value: unknown, writingMode: Read<TextElementModel['writingMode']>, path: ElementPath): Read<TextFit> {
    const floor = this.floor;
    const none: TextFit = { tightenSpacing: false, compressGlyphs: false, compressMin: MIN_COMPRESSION, shrink: false,
      minFontSize: floor.value, minFontSizeSource: floor.source, onFail: 'severe' };
    const tooLow = (key: string) => floor.source === 'artboard'
      ? `${key} 不能低于画板的 minFontSize ${floor.value} mm（M238）`
      : `${key} 不能低于 ${floor.value} mm（缺省值，画板可写 minFontSize 调低）`;
    if (value === undefined) return none;
    if (!isRecord(value)) {
      this.fail(path, 'fit 必须是对象');
      return undefined;
    }
    this.checkKeys(value, FIT_KEYS, path, '放不下时的处理 fit');
    let widthOverflow: TextFit['widthOverflow'];
    if (value['widthOverflow'] !== undefined) {
      const rule = value['widthOverflow'];
      if (writingMode !== 'vertical' || !isRecord(rule)) return this.fail(path, 'widthOverflow 必须是竖排文本的缩字组配置对象');
      this.checkKeys(rule, ['shrinkGroup', 'minFontSize'], path, 'widthOverflow');
      const group = rule['shrinkGroup'];
      const minimum = rule['minFontSize'] === undefined ? floor.value : rule['minFontSize'];
      if (typeof group !== 'string' || !group.trim() || group !== group.trim()) return this.fail(path, 'shrinkGroup 必须是非空且首尾无空白的组名');
      if (!isFiniteNumber(minimum) || minimum < floor.value) return this.fail(path, tooLow('widthOverflow.minFontSize'));
      widthOverflow = { shrinkGroup: group, minFontSize: minimum };
    }
    const steps = value['steps'] === undefined ? [] : value['steps'];
    if (!Array.isArray(steps) || !steps.every((step): step is string => typeof step === 'string')) {
      this.fail(path, 'fit.steps 必须是步骤名称的列表');
      return undefined;
    }
    const supported = writingMode === 'vertical' ? ['tightenSpacing', 'compressGlyphs'] : ['tightenSpacing', 'compressGlyphs', 'shrink'];
    for (const step of steps) {
      if (!supported.includes(step)) {
        this.unsupported(path, `${writingMode === 'vertical' ? '竖排' : '横排'}文字的适配步骤 ${step} 尚未支持`);
        return undefined;
      }
    }
    if (new Set(steps).size !== steps.length) {
      this.fail(path, 'fit.steps 中的步骤不能重复');
      return undefined;
    }
    if (
      (writingMode === 'vertical' && steps.includes('compressGlyphs') && steps[0] !== 'tightenSpacing') ||
      (steps.includes('tightenSpacing') && steps[0] !== 'tightenSpacing')
    ) {
      this.fail(path, '收紧字距必须排在压缩字形之前：字距收到 0 之前不压缩字形（M82）');
      return undefined;
    }
    const compressMin = value['compressMin'] === undefined ? MIN_COMPRESSION : value['compressMin'];
    if (!isFiniteNumber(compressMin) || compressMin < MIN_COMPRESSION || compressMin > 1) {
      this.fail(path, `fit.compressMin 必须在 ${MIN_COMPRESSION} 到 1 之间（M88）`);
      return undefined;
    }
    if (steps.includes('shrink') && (!steps.includes('compressGlyphs') || steps.indexOf('shrink') < steps.indexOf('compressGlyphs'))) {
      return this.fail(path, '横排必须先 compressGlyphs 再 shrink（M84）');
    }
    const minFontSize = value['minFontSize'] === undefined ? floor.value : value['minFontSize'];
    if (!isFiniteNumber(minFontSize) || minFontSize < floor.value) return this.fail(path, tooLow('fit.minFontSize'));
    if (value['minFontSize'] !== undefined && !steps.includes('shrink')) return this.fail(path, 'minFontSize 只用于横排 shrink 步骤');
    const onFail = this.readEnum(value['onFail'], ['severe', 'hint'] as const, 'severe', path, 'fit.onFail');
    if (!onFail) return undefined;
    return {
      tightenSpacing: steps.includes('tightenSpacing'),
      compressGlyphs: steps.includes('compressGlyphs'),
      compressMin,
      shrink: steps.includes('shrink'),
      minFontSize,
      minFontSizeSource: value['minFontSize'] === undefined ? floor.source : 'element',
      ...(widthOverflow && { widthOverflow }),
      onFail,
    };
  }

  private readTextStroke(value: unknown, path: ElementPath): Read<TextStroke> {
    if (!isRecord(value)) {
      this.fail(path, 'stroke 必须写成 { "color": 颜色, "width": 毫米 }');
      return undefined;
    }
    this.checkKeys(value, ['color', 'width'], path, '文字描边');
    const color = this.readColor(value['color'], path, 'stroke.color');
    const width = this.readNumber(value['width'], undefined, path, 'stroke.width', { min: 0, exclusiveMin: true });
    return color && width !== undefined ? { color, width } : undefined;
  }

  private readShapeStroke(value: unknown, path: ElementPath): Read<ShapeStroke> {
    if (!isRecord(value)) {
      this.fail(path, 'stroke 必须写成 { "color": 颜色, "width": 毫米, "dash"?: [实, 空, …], "cap"?: … }');
      return undefined;
    }
    this.checkKeys(value, ['color', 'width', 'dash', 'cap'], path, '描边');
    const color = this.readColor(value['color'], path, 'stroke.color');
    const width = this.readNumber(value['width'], undefined, path, 'stroke.width', { min: 0, exclusiveMin: true });
    const cap = this.readEnum(value['cap'], ['butt', 'round', 'square'] as const, 'butt', path, 'stroke.cap');
    const dashValue = value['dash'];
    let dash: number[] | undefined;
    if (dashValue !== undefined) {
      if (!Array.isArray(dashValue) || dashValue.length === 0 || !dashValue.every(isPositive)) {
        this.fail(path, 'stroke.dash 必须是大于 0 的毫米数列表');
        return undefined;
      }
      // 与 SVG 一致：奇数个时重复一遍。
      dash = dashValue.length % 2 === 0 ? dashValue : [...dashValue, ...dashValue];
    }
    if (!color || width === undefined || !cap) return undefined;
    return { color, width, cap, ...(dash && { dash }) };
  }

  private readPoint(value: unknown, path: ElementPath, label: string): Read<Point> {
    if (Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)) return [value[0]!, value[1]!];
    this.fail(path, `${label} 必须写成 [x, y]（毫米，相对元素框左上角）`);
    return undefined;
  }

  private readPoints(value: unknown, path: ElementPath): Read<Point[]> {
    if (!Array.isArray(value) || value.length < 3) {
      this.fail(path, '多边形的 points 至少要有 3 个顶点');
      return undefined;
    }
    const points: Point[] = [];
    for (const point of value) {
      const parsed = this.readPoint(point, path, 'points 的每一项');
      if (!parsed) return undefined;
      points.push(parsed);
    }
    return points;
  }

  private readShapeScaling(value: Record<string, unknown>, path: ElementPath): Read<{ readonly viewBox?: ViewBox; readonly fit: ShapeFit }> {
    const viewBox = this.optional(value['viewBox'], (v) => this.readViewBox(v, path));
    if (value['fit'] !== undefined && value['viewBox'] === undefined) {
      return this.fail(path, '图形的 fit 只能在声明了 viewBox 时使用');
    }
    const fit = this.readEnum(value['fit'], ['fill', 'contain', 'cover'] as const, 'fill', path, 'fit');
    if (viewBox === null || !fit) return undefined;
    return { ...(viewBox && { viewBox }), fit };
  }

  private readViewBox(value: unknown, path: ElementPath): Read<ViewBox> {
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      isFiniteNumber(value[0]) &&
      isFiniteNumber(value[1]) &&
      isPositive(value[2]) &&
      isPositive(value[3])
    ) {
      return [value[0], value[1], value[2], value[3]];
    }
    return this.fail(path, 'viewBox 必须写成 [minX, minY, width, height]（4 个数，且 width、height 大于 0）');
  }

  private readEdges(value: unknown, path: ElementPath, label: string): Read<Edges> {
    if (value === undefined) return NO_EDGES;
    if (isVarOperand(value) || (typeof value === 'number' && value >= 0)) {
      const all = this.readNumber(value, 0, path, label, { min: 0 });
      return all === undefined ? undefined : { top: all, right: all, bottom: all, left: all };
    }
    if (isRecord(value)) {
      this.checkKeys(value, ['top', 'right', 'bottom', 'left'], path, label);
      const side = (key: string) => this.readNumber(value[key], 0, path, `${label}.${key}`, { min: 0 });
      const [top, right, bottom, left] = [side('top'), side('right'), side('bottom'), side('left')];
      if (top === undefined || right === undefined || bottom === undefined || left === undefined) return undefined;
      return { top, right, bottom, left };
    }
    this.fail(path, `${label} 写成毫米数，或 { "top", "right", "bottom", "left" } 中的若干项`);
    return undefined;
  }

  private readCorners(value: unknown, path: ElementPath): Read<Corners> {
    if (value === undefined) return NO_CORNERS;
    if (isVarOperand(value) || (typeof value === 'number' && value >= 0)) {
      const all = this.readNumber(value, 0, path, 'cornerRadius', { min: 0 });
      return all === undefined ? undefined : { topLeft: all, topRight: all, bottomRight: all, bottomLeft: all };
    }
    if (isRecord(value)) {
      this.checkKeys(value, ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'], path, 'cornerRadius');
      const corner = (key: string) => this.readNumber(value[key], 0, path, `cornerRadius.${key}`, { min: 0 });
      const [topLeft, topRight, bottomRight, bottomLeft] = [corner('topLeft'), corner('topRight'), corner('bottomRight'), corner('bottomLeft')];
      if (topLeft === undefined || topRight === undefined || bottomRight === undefined || bottomLeft === undefined) return undefined;
      return { topLeft, topRight, bottomRight, bottomLeft };
    }
    this.fail(path, 'cornerRadius 写成毫米数，或 { "topLeft", "topRight", "bottomRight", "bottomLeft" } 中的若干项');
    return undefined;
  }

  private readColor(value: unknown, path: ElementPath, label: string): Read<Color> {
    if (isVarOperand(value)) return this.host.color(value.var, { path, label });
    const color = normalizeColor(value);
    if (color) return color;
    this.fail(path, `${label} 必须是 #RRGGBB 或 #RRGGBBAA 形式的颜色`);
    return undefined;
  }

  private readNumber(
    value: unknown,
    fallback: number | undefined,
    path: ElementPath,
    label: string,
    rule: NumberRule,
  ): Read<number> {
    if (value === undefined && fallback !== undefined) return fallback;
    if (isVarOperand(value)) return this.host.number(value.var, { path, label }, rule, fallback);
    if (isFiniteNumber(value) && satisfies(value, rule)) return value;
    this.fail(path, `${label} 必须是${describeRule(rule)}`);
    return undefined;
  }

  private readBoolean(value: unknown, fallback: boolean, path: ElementPath, label: string): Read<boolean> {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (isVarOperand(value)) return this.host.boolean(value.var, { path, label }, fallback);
    this.fail(path, `${label} 必须是 true 或 false`);
    return undefined;
  }

  private readLiteralBoolean(value: unknown, fallback: boolean, path: ElementPath, label: string): Read<boolean> {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    this.fail(path, `${label} 必须是 true 或 false`);
    return undefined;
  }

  private readEnum<T extends string, F extends T | undefined>(
    value: unknown,
    allowed: readonly T[],
    fallback: F,
    path: ElementPath,
    label: string,
  ): Read<T> {
    if (value === undefined && fallback !== undefined) return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.fail(path, `${label} 只能取 ${allowed.join('、')}`);
    return undefined;
  }

  /** 可选属性：未写返回 undefined，写错返回 null（已记录问题）。 */
  private optional<T>(value: unknown, read: (value: unknown) => Read<T>): T | undefined | null {
    if (value === undefined) return undefined;
    return read(value) ?? null;
  }

  private checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: ElementPath, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.report(ProblemCodes.templateUnknownProperty, path, `${what}中有未定义或尚未支持的属性 ${key}`);
        this.failed = true;
      }
    }
  }

  private fail(path: ElementPath, message: string): undefined {
    this.report(ProblemCodes.templateInvalid, path, message);
    this.failed = true;
    return undefined;
  }

  private unsupported(path: ElementPath, message: string): void {
    this.report(ProblemCodes.templateUnsupported, path, message);
    this.failed = true;
  }

  private report(code: ProblemCode, path: ElementPath, message: string): void {
    this.problems.push(severe(code, { kind: 'element', path: formatElementPath(path) }, message));
  }
}

/** 数值是否满足属性的取值规则。 */
export function satisfies(value: number, rule: NumberRule): boolean {
  return (
    (rule.min === undefined || (rule.exclusiveMin ? value > rule.min : value >= rule.min)) &&
    (rule.max === undefined || value <= rule.max) &&
    (!rule.integer || Number.isInteger(value))
  );
}

/** 取值规则的说明，如"数、不小于 0、不大于 1"。 */
export function describeRule(rule: NumberRule): string {
  return [
    rule.integer ? '整数' : '数',
    rule.min !== undefined ? `${rule.exclusiveMin ? '大于' : '不小于'} ${rule.min}` : '',
    rule.max !== undefined ? `不大于 ${rule.max}` : '',
  ]
    .filter(Boolean)
    .join('、');
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
