/**
 * 模板 DSL 解析（renderweave-template/1）。
 *
 * 把模板文档读成类型明确的模型，并在出图前发现结构错误，问题以元素路径定位。
 * 尚未实现的元素类型、属性与变量绑定在后续票据中逐步加入，遇到时返回问题而不是静默忽略。
 */
import {
  RESERVED_NAME_CHARACTERS,
  childPath,
  formatElementPath,
  rootPath,
  type ElementPath,
} from '../element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from '../problems.js';
import { parseResourceRef } from '../resources.js';
import { isRecord } from '../util.js';
import { parseStaticSchemaRef } from '../workspace.js';
import {
  MIN_COMPRESSION,
  type ArtboardModel,
  type Color,
  type ContainerBody,
  type ContentItem,
  type Corners,
  type Edges,
  type ElementBase,
  type ElementModel,
  type Layout,
  type Place,
  type Point,
  type Range,
  type ShapeStroke,
  type SizeSpec,
  type TemplateModel,
  type TextElementModel,
  type TextFit,
  type TextStroke,
  type Track,
} from './model.js';

const TEMPLATE_KEYS = ['dslVersion', 'name', 'base', 'parameters', 'derived', 'checks', 'artboard'];
const CONTAINER_BODY_KEYS = ['layout', 'padding', 'fill', 'stroke', 'cornerRadius', 'clip', 'children'];
const ARTBOARD_KEYS = ['sizeRange', ...CONTAINER_BODY_KEYS];
const COMMON_KEYS = ['type', 'name', 'place', 'visible', 'opacity', 'rotation'];
const ELEMENT_KEYS: Record<ElementModel['type'], readonly string[]> = {
  container: [...COMMON_KEYS, ...CONTAINER_BODY_KEYS],
  text: [
    ...COMMON_KEYS,
    'content',
    'font',
    'fontSize',
    'color',
    'writingMode',
    'horizontalAlign',
    'verticalAlign',
    'fit',
    'stroke',
    'padding',
  ],
  rect: [...COMMON_KEYS, 'fill', 'stroke', 'cornerRadius'],
  ellipse: [...COMMON_KEYS, 'fill', 'stroke'],
  line: [...COMMON_KEYS, 'from', 'to', 'stroke'],
  polygon: [...COMMON_KEYS, 'points', 'fill', 'stroke'],
  path: [...COMMON_KEYS, 'd', 'fill', 'stroke', 'fillRule'],
};
/** 元素目录中已有、但尚未实现的元素类型。 */
const PLANNED_TYPES = new Set(['image', 'loop', 'call', 'qrcode', 'barcode']);
const SIZE_LIMIT_KEYS = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'] as const;
const PLACE_KEYS: Record<Layout['mode'], readonly string[]> = {
  free: ['left', 'right', 'top', 'bottom', 'width', 'height', ...SIZE_LIMIT_KEYS],
  stack: ['width', 'height', 'margin', 'alignSelf', ...SIZE_LIMIT_KEYS],
  grid: ['row', 'column', 'rowSpan', 'columnSpan', 'width', 'height', 'margin', 'justifySelf', 'alignSelf', ...SIZE_LIMIT_KEYS],
};
const FIT_KEYS = ['steps', 'compressMin', 'onFail'];
const NO_EDGES: Edges = { top: 0, right: 0, bottom: 0, left: 0 };
const NO_CORNERS: Corners = { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 };
const ALIGNS = ['start', 'center', 'end'] as const;

export function parseTemplate(name: string, document: unknown): { model?: TemplateModel; problems: Problem[] } {
  const reader = new TemplateReader(name);
  const model = reader.readTemplate(document);
  return { model: reader.failed ? undefined : model, problems: reader.problems };
}

/** 读取失败时返回 undefined，并已记录问题。 */
type Read<T> = T | undefined;

class TemplateReader {
  readonly problems: Problem[] = [];
  /** 有严重到无法继续使用模型的问题。 */
  failed = false;
  private readonly elementNames = new Map<string, ElementPath>();

  constructor(private readonly templateName: string) {}

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
    for (const key of ['parameters', 'derived', 'checks']) {
      const value = document[key];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) {
        this.unsupported(path, `模板的 ${key}（参数、派生变量与检查项）尚未支持`);
      }
    }
    const base = parseStaticSchemaRef(document['base']);
    if (!base) this.fail(path, '模板必须用 base 写明基准数据定义的名称与版本号');
    const artboard = this.readArtboard(document['artboard'], path);
    if (!base || !artboard) return undefined;
    return { name: this.templateName, base, artboard };
  }

  private readArtboard(value: unknown, path: ElementPath): Read<ArtboardModel> {
    if (!isRecord(value)) {
      this.fail(path, '模板必须有画板 artboard');
      return undefined;
    }
    if (value['size'] !== undefined) this.unsupported(path, '画板的 size（被调用时随内容）尚未支持');
    this.checkKeys(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'size')),
      ARTBOARD_KEYS,
      path,
      '画板',
    );
    const sizeRange = this.readSizeRange(value['sizeRange'], path);
    const body = this.readContainerBody(value, path);
    if (!sizeRange || !body) return undefined;
    return { type: 'artboard', name: this.templateName, path, sizeRange, ...body };
  }

  private readSizeRange(value: unknown, path: ElementPath): Read<ArtboardModel['sizeRange']> {
    const range = (v: unknown, label: string): Read<Range> => {
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
    const childrenValue = value['children'] ?? [];
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
        this.checkKeys(value, ['mode', 'direction', 'gap', 'justifyContent', 'alignItems'], path, '堆叠布局');
        const direction = this.readEnum(value['direction'], ['row', 'column'] as const, undefined, path, 'layout.direction');
        const gap = this.readNumber(value['gap'], 0, path, 'layout.gap', { min: 0 });
        const justifyContent = this.readEnum(
          value['justifyContent'],
          ['start', 'center', 'end', 'spaceBetween', 'spaceEvenly'] as const,
          'start',
          path,
          'layout.justifyContent',
        );
        const alignItems = this.readEnum(value['alignItems'], ALIGNS, 'start', path, 'layout.alignItems');
        if (!direction || gap === undefined || !justifyContent || !alignItems) return undefined;
        return { mode: 'stack', direction, gap, justifyContent, alignItems };
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

  private readElement(value: unknown, parent: ElementPath, parentLayout: Layout): Read<ElementModel> {
    if (!isRecord(value)) {
      this.fail(parent, '元素必须是 JSON 对象');
      return undefined;
    }
    const name = this.readElementName(value['name'], parent);
    if (name === undefined) return undefined;
    const path = childPath(parent, name);
    const type = value['type'];
    if (typeof type !== 'string' || !(type in ELEMENT_KEYS)) {
      if (typeof type === 'string' && PLANNED_TYPES.has(type)) this.unsupported(path, `元素类型 ${type} 尚未支持`);
      else this.fail(path, `未知的元素类型 ${String(type)}`);
      return undefined;
    }
    const elementType = type as ElementModel['type'];
    this.checkKeys(value, ELEMENT_KEYS[elementType], path, '元素');
    const base = this.readElementBase(value, name, path, parentLayout);

    let element: Read<ElementModel>;
    switch (elementType) {
      case 'container': {
        const body = this.readContainerBody(value, path);
        element = base && body && { ...base, type: 'container', ...body };
        break;
      }
      case 'text':
        element = this.readText(value, base, path);
        break;
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
        element = base && from && to && stroke ? { ...base, type: 'line', from, to, stroke } : undefined;
        break;
      }
      case 'polygon': {
        const points = this.readPoints(value['points'], path);
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        element =
          base && points && fill !== null && stroke !== null
            ? { ...base, type: 'polygon', points, ...(fill && { fill }), ...(stroke && { stroke }) }
            : undefined;
        break;
      }
      case 'path': {
        const d = value['d'];
        if (typeof d !== 'string' || d.trim() === '') this.fail(path, '路径必须用 d 给出 SVG 路径数据（毫米）');
        const fill = this.optional(value['fill'], (v) => this.readColor(v, path, 'fill'));
        const stroke = this.optional(value['stroke'], (v) => this.readShapeStroke(v, path));
        const fillRule = this.readEnum(value['fillRule'], ['nonzero', 'evenodd'] as const, 'nonzero', path, 'fillRule');
        element =
          base && typeof d === 'string' && d.trim() !== '' && fill !== null && stroke !== null && fillRule
            ? { ...base, type: 'path', d, fillRule, ...(fill && { fill }), ...(stroke && { stroke }) }
            : undefined;
        break;
      }
    }
    return element;
  }

  private readElementName(value: unknown, parent: ElementPath): Read<string> {
    if (typeof value !== 'string' || value === '') {
      this.fail(parent, '元素必须有名称 name');
      return undefined;
    }
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
    const place = value ?? {};
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
      }
      if (column + columnSpan - 1 > parentLayout.columns.length) {
        this.fail(path, `网格只有 ${parentLayout.columns.length} 列，元素占到第 ${column + columnSpan - 1} 列`);
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

  private readSize(value: unknown, path: ElementPath, label: string): Read<SizeSpec> {
    if (value === 'hug') return { kind: 'hug' };
    if (value === 'fill') return { kind: 'fill', weight: 1 };
    if (isRecord(value) && Object.keys(value).length === 1) {
      if ('var' in value) {
        this.unsupported(path, `${label} 绑定变量尚未支持`);
        return undefined;
      }
      if (typeof value['fixed'] === 'number' && value['fixed'] >= 0) return { kind: 'fixed', value: value['fixed'] };
      if (isPositive(value['fill'])) return { kind: 'fill', weight: value['fill'] };
    }
    this.fail(path, `${label} 写成 { "fixed": 毫米 }、"hug"、"fill" 或 { "fill": 权重 }`);
    return undefined;
  }

  private readText(value: Record<string, unknown>, base: Read<ElementBase>, path: ElementPath): Read<TextElementModel> {
    const content = this.readContent(value['content'], path);
    const fontRef = value['font'];
    const font = typeof fontRef === 'string' ? parseResourceRef(fontRef) : undefined;
    if (!font) this.fail(path, '文本的字体 font 必须是资源引用 res:资源ID');
    const fontSize = this.readNumber(value['fontSize'], undefined, path, 'fontSize', { min: 0, exclusiveMin: true });
    const color = value['color'] === undefined ? '#000000FF' : this.readColor(value['color'], path, 'color');
    const writingMode = this.readEnum(value['writingMode'], ['horizontal', 'vertical'] as const, 'horizontal', path, 'writingMode');
    const horizontalAlign = this.readEnum(value['horizontalAlign'], ALIGNS, 'start', path, 'horizontalAlign');
    const verticalAlign = this.readEnum(value['verticalAlign'], ['top', 'center', 'bottom', 'distribute'] as const, 'top', path, 'verticalAlign');
    if (verticalAlign === 'distribute' && writingMode !== 'vertical') {
      this.fail(path, 'verticalAlign 取 distribute（两端分布）只用于竖排文字');
    }
    const fit = this.readFit(value['fit'], writingMode, path);
    const stroke = this.optional(value['stroke'], (v) => this.readTextStroke(v, path));
    const padding = this.readEdges(value['padding'], path, 'padding');
    if (!base || !content || !font || fontSize === undefined || !color || !writingMode || !horizontalAlign || !verticalAlign) return undefined;
    if (!fit || stroke === null || !padding) return undefined;
    return {
      ...base,
      type: 'text',
      content,
      font,
      fontSize,
      color,
      writingMode,
      horizontalAlign,
      verticalAlign,
      fit,
      ...(stroke && { stroke }),
      padding,
    };
  }

  private readContent(value: unknown, path: ElementPath): Read<ContentItem[]> {
    if (!Array.isArray(value)) {
      this.fail(path, '文本内容 content 必须是片段列表');
      return undefined;
    }
    const items: ContentItem[] = [];
    for (const item of value) {
      if (isRecord(item) && typeof item['text'] === 'string' && Object.keys(item).length === 1) {
        items.push({ kind: 'text', text: item['text'] });
      } else if (isRecord(item) && typeof item['slot'] === 'string' && item['slot'] !== '') {
        this.checkKeys(item, ['slot'], path, '变量插槽');
        items.push({ kind: 'slot', path: item['slot'] });
      } else {
        this.fail(path, '文本片段必须写成 { "text": 文字 } 或 { "slot": 变量路径 }');
        return undefined;
      }
    }
    return items;
  }

  /**
   * 放不下时的处理。竖排支持 tightenSpacing、compressGlyphs，且收紧字距必须在压缩字形之前（M82）；
   * 横排的压缩、缩字与拉开字距在票据 09 加入；按宽度统一缩字（widthOverflow）在票据 10 加入。
   * 不写 fit 时文字不做适配，放不下即按严重问题上报（M109）。
   */
  private readFit(value: unknown, writingMode: Read<TextElementModel['writingMode']>, path: ElementPath): Read<TextFit> {
    const none: TextFit = { tightenSpacing: false, compressGlyphs: false, compressMin: MIN_COMPRESSION, onFail: 'severe' };
    if (value === undefined) return none;
    if (!isRecord(value)) {
      this.fail(path, 'fit 必须是对象');
      return undefined;
    }
    if ('widthOverflow' in value) this.unsupported(path, 'fit.widthOverflow（按宽度统一缩字）尚未支持');
    this.checkKeys(
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'widthOverflow')),
      FIT_KEYS,
      path,
      '放不下时的处理 fit',
    );
    const steps = value['steps'] ?? [];
    if (!Array.isArray(steps) || !steps.every((step): step is string => typeof step === 'string')) {
      this.fail(path, 'fit.steps 必须是步骤名称的列表');
      return undefined;
    }
    const supported = writingMode === 'vertical' ? ['tightenSpacing', 'compressGlyphs'] : [];
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
      steps.includes('compressGlyphs') &&
      !(steps.includes('tightenSpacing') && steps.indexOf('tightenSpacing') < steps.indexOf('compressGlyphs'))
    ) {
      this.fail(path, '收紧字距必须排在压缩字形之前：字距收到 0 之前不压缩字形（M82）');
      return undefined;
    }
    const compressMin = value['compressMin'] ?? MIN_COMPRESSION;
    if (typeof compressMin !== 'number' || compressMin < MIN_COMPRESSION || compressMin > 1) {
      this.fail(path, `fit.compressMin 必须在 ${MIN_COMPRESSION} 到 1 之间（M88）`);
      return undefined;
    }
    const onFail = this.readEnum(value['onFail'], ['severe', 'hint'] as const, 'severe', path, 'fit.onFail');
    if (!onFail) return undefined;
    return {
      tightenSpacing: steps.includes('tightenSpacing'),
      compressGlyphs: steps.includes('compressGlyphs'),
      compressMin,
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

  private readEdges(value: unknown, path: ElementPath, label: string): Read<Edges> {
    if (value === undefined) return NO_EDGES;
    if (typeof value === 'number' && value >= 0) return { top: value, right: value, bottom: value, left: value };
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
    if (typeof value === 'number' && value >= 0) return { topLeft: value, topRight: value, bottomRight: value, bottomLeft: value };
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
    if (isRecord(value) && 'var' in value) {
      this.unsupported(path, `${label} 绑定变量尚未支持`);
      return undefined;
    }
    if (typeof value === 'string' && /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(value)) {
      return (value.length === 7 ? `${value}FF` : value).toUpperCase();
    }
    this.fail(path, `${label} 必须是 #RRGGBB 或 #RRGGBBAA 形式的颜色`);
    return undefined;
  }

  private readNumber(
    value: unknown,
    fallback: number | undefined,
    path: ElementPath,
    label: string,
    rule: { min?: number; max?: number; exclusiveMin?: boolean; integer?: boolean },
  ): Read<number> {
    if (value === undefined && fallback !== undefined) return fallback;
    if (isRecord(value) && 'var' in value) {
      this.unsupported(path, `${label} 绑定变量尚未支持`);
      return undefined;
    }
    const ok =
      isFiniteNumber(value) &&
      (rule.min === undefined || (rule.exclusiveMin ? value > rule.min : value >= rule.min)) &&
      (rule.max === undefined || value <= rule.max) &&
      (!rule.integer || Number.isInteger(value));
    if (ok) return value;
    const conditions = [
      rule.integer ? '整数' : '数',
      rule.min !== undefined ? `${rule.exclusiveMin ? '大于' : '不小于'} ${rule.min}` : '',
      rule.max !== undefined ? `不大于 ${rule.max}` : '',
    ].filter(Boolean);
    this.fail(path, `${label} 必须是${conditions.join('、')}`);
    return undefined;
  }

  private readBoolean(value: unknown, fallback: boolean, path: ElementPath, label: string): Read<boolean> {
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (isRecord(value) && 'var' in value) {
      this.unsupported(path, `${label} 绑定变量尚未支持`);
      return undefined;
    }
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositive(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}
