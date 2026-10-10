/**
 * 模板 DSL 解析（renderweave-template/1）。
 *
 * 把模板文档读成类型明确的模型，并在出图前发现结构错误。本版本支持画板、自由布局与横排文本元素；
 * 其他元素类型、布局方式与属性在后续票据中逐步加入，遇到时返回问题而不是静默忽略。
 */
import {
  RESERVED_NAME_CHARACTERS,
  childPath,
  formatElementPath,
  rootPath,
  type ElementPath,
} from './element-path.js';
import { ProblemCodes, severe, type Problem, type ProblemCode } from './problems.js';
import { parseResourceRef } from './resources.js';
import { isRecord } from './util.js';
import { parseStaticSchemaRef, type StaticSchemaRef } from './workspace.js';

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface TemplateModel {
  readonly name: string;
  readonly base: StaticSchemaRef;
  readonly artboard: ArtboardModel;
}

export interface ArtboardModel {
  readonly path: ElementPath;
  /** 适用尺寸范围，毫米。 */
  readonly sizeRange: { readonly width: Range; readonly height: Range };
  readonly fill?: Color;
  readonly children: readonly ElementModel[];
}

export type ElementModel = TextElementModel;

export interface TextElementModel {
  readonly type: 'text';
  readonly name: string;
  readonly path: ElementPath;
  readonly content: readonly ContentItem[];
  /** 字体资源 ID。 */
  readonly font: string;
  /** 字号，毫米（em 框的高度）。 */
  readonly fontSize: number;
  readonly color: Color;
  readonly writingMode: 'horizontal' | 'vertical';
  /** 横排时是文字在框内的水平位置；竖排时是整列在框内的水平位置。 */
  readonly horizontalAlign: 'start' | 'center' | 'end';
  /** distribute（两端分布）只用于竖排：首字墨迹贴顶、末字墨迹贴底、中间均分。 */
  readonly verticalAlign: 'top' | 'center' | 'bottom' | 'distribute';
  readonly fit: TextFit;
  readonly stroke?: TextStroke;
  readonly place: FreePlace;
}

/** 文字放不下时的处理（M82、M88）。 */
export interface TextFit {
  /** 收紧字距：字距最小收到 0。两端分布时字距由框高决定、本来就不小于 0，这一步记录的是"压缩之前先收字距"的顺序。 */
  readonly tightenSpacing: boolean;
  /** 压缩字形：沿书写方向压缩，不低于 compressMin。 */
  readonly compressGlyphs: boolean;
  readonly compressMin: number;
  /** 仍放不下时的问题等级。 */
  readonly onFail: 'severe' | 'hint';
}

/** 文字描边：画在填充之下，width 是字形外侧可见的宽度，毫米（M108）。 */
export interface TextStroke {
  readonly color: Color;
  readonly width: number;
}

/** 字形压缩的下限，模板只能设得更高（M88）。 */
export const MIN_COMPRESSION = 0.6;

/** 文本内容片段：文字，或绑定变量的插槽。 */
export type ContentItem = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'slot'; readonly path: string };

/** 自由布局中的位置与尺寸：横向距左或距右、纵向距上或距下（M93）。 */
export interface FreePlace {
  readonly horizontal: { readonly edge: 'left' | 'right'; readonly offset: number };
  readonly vertical: { readonly edge: 'top' | 'bottom'; readonly offset: number };
  readonly width: SizeSpec;
  readonly height: SizeSpec;
}

export type SizeSpec = { readonly kind: 'fixed'; readonly value: number } | { readonly kind: 'hug' };

/** 颜色统一为 `#RRGGBBAA`。 */
export type Color = string;

const TEMPLATE_KEYS = ['dslVersion', 'name', 'base', 'parameters', 'derived', 'checks', 'artboard'];
const ARTBOARD_KEYS = ['sizeRange', 'fill', 'layout', 'children'];
const TEXT_KEYS = [
  'type',
  'name',
  'content',
  'font',
  'fontSize',
  'color',
  'writingMode',
  'horizontalAlign',
  'verticalAlign',
  'fit',
  'stroke',
  'place',
];
const FIT_KEYS = ['steps', 'compressMin', 'onFail'];
const FREE_PLACE_KEYS = ['left', 'right', 'top', 'bottom', 'width', 'height'];

export function parseTemplate(name: string, document: unknown): { model?: TemplateModel; problems: Problem[] } {
  const reader = new TemplateReader(name);
  const model = reader.readTemplate(document);
  return { model: reader.failed ? undefined : model, problems: reader.problems };
}

class TemplateReader {
  readonly problems: Problem[] = [];
  /** 有严重到无法继续使用模型的问题。 */
  failed = false;
  private readonly elementNames = new Map<string, ElementPath>();

  constructor(private readonly templateName: string) {}

  readTemplate(document: unknown): TemplateModel | undefined {
    const path = rootPath(this.templateName);
    if (!isRecord(document)) {
      this.fail(path, '模板必须是 JSON 对象');
      return undefined;
    }
    this.checkKeys(document, TEMPLATE_KEYS, path, '模板');
    if (document['dslVersion'] !== 'renderweave-template/1') {
      this.fail(path, `模板的 dslVersion 必须是 renderweave-template/1`);
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

  private readArtboard(value: unknown, path: ElementPath): ArtboardModel | undefined {
    if (!isRecord(value)) {
      this.fail(path, '模板必须有画板 artboard');
      return undefined;
    }
    this.checkKeys(value, ARTBOARD_KEYS, path, '画板');
    const sizeRange = this.readSizeRange(value['sizeRange'], path);
    const fill = value['fill'] === undefined ? undefined : this.readColor(value['fill'], path, 'fill');
    this.readFreeLayout(value['layout'], path);
    const childrenValue = value['children'] ?? [];
    const children: ElementModel[] = [];
    if (!Array.isArray(childrenValue)) {
      this.fail(path, '画板的 children 必须是列表');
    } else {
      for (const child of childrenValue) {
        const element = this.readElement(child, path);
        if (element) children.push(element);
      }
    }
    if (!sizeRange) return undefined;
    return { path, sizeRange, fill, children };
  }

  private readSizeRange(value: unknown, path: ElementPath): ArtboardModel['sizeRange'] | undefined {
    const range = (v: unknown, label: string): Range | undefined => {
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

  private readFreeLayout(value: unknown, path: ElementPath): void {
    if (value === undefined) return;
    if (!isRecord(value) || typeof value['mode'] !== 'string') {
      this.fail(path, '布局方式 layout 必须写成 { "mode": … }');
      return;
    }
    if (value['mode'] !== 'free') {
      this.unsupported(path, `布局方式 ${value['mode']} 尚未支持，目前只支持自由布局 free`);
      return;
    }
    this.checkKeys(value, ['mode'], path, '自由布局');
  }

  private readElement(value: unknown, parent: ElementPath): ElementModel | undefined {
    if (!isRecord(value)) {
      this.fail(parent, '元素必须是 JSON 对象');
      return undefined;
    }
    const name = this.readElementName(value['name'], parent);
    if (name === undefined) return undefined;
    const path = childPath(parent, name);
    const type = value['type'];
    if (type !== 'text') {
      this.unsupported(path, `元素类型 ${String(type)} 尚未支持，目前只支持文本 text`);
      return undefined;
    }
    return this.readText(value, name, path);
  }

  private readElementName(value: unknown, parent: ElementPath): string | undefined {
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
      this.report(
        ProblemCodes.templateDuplicateElementName,
        path,
        `元素名称"${value}"在模板内重复，已用于 ${formatElementPath(previous)}`,
      );
      this.failed = true;
    } else {
      this.elementNames.set(value, path);
    }
    return value;
  }

  private readText(value: Record<string, unknown>, name: string, path: ElementPath): TextElementModel | undefined {
    this.checkKeys(value, TEXT_KEYS, path, '文本元素');
    const content = this.readContent(value['content'], path);
    const fontRef = value['font'];
    const font = typeof fontRef === 'string' ? parseResourceRef(fontRef) : undefined;
    if (!font) this.fail(path, '文本的字体 font 必须是资源引用 res:资源ID');
    const fontSize = value['fontSize'];
    if (!isPositive(fontSize)) this.fail(path, '文本的字号 fontSize 必须是大于 0 的毫米数');
    const color = value['color'] === undefined ? '#000000FF' : this.readColor(value['color'], path, 'color');
    const writingMode = this.readEnum(value['writingMode'], ['horizontal', 'vertical'] as const, 'horizontal', path, 'writingMode');
    const horizontalAlign = this.readEnum(value['horizontalAlign'], ['start', 'center', 'end'] as const, 'start', path, 'horizontalAlign');
    const verticalAlign = this.readEnum(
      value['verticalAlign'],
      ['top', 'center', 'bottom', 'distribute'] as const,
      'top',
      path,
      'verticalAlign',
    );
    if (verticalAlign === 'distribute' && writingMode !== 'vertical') {
      this.fail(path, 'verticalAlign 取 distribute（两端分布）只用于竖排文字');
    }
    const fit = this.readFit(value['fit'], writingMode, path);
    const stroke = value['stroke'] === undefined ? undefined : this.readStroke(value['stroke'], path);
    const place = this.readFreePlace(value['place'], path);
    if (
      !content ||
      !font ||
      !isPositive(fontSize) ||
      !color ||
      !writingMode ||
      !horizontalAlign ||
      !verticalAlign ||
      !fit ||
      (value['stroke'] !== undefined && !stroke) ||
      !place
    ) {
      return undefined;
    }
    return {
      type: 'text',
      name,
      path,
      content,
      font,
      fontSize,
      color,
      writingMode,
      horizontalAlign,
      verticalAlign,
      fit,
      ...(stroke && { stroke }),
      place,
    };
  }

  /**
   * 放不下时的处理。竖排支持 tightenSpacing、compressGlyphs，且收紧字距必须在压缩字形之前（M82）；
   * 横排的压缩、缩字与拉开字距在票据 09 加入；按宽度统一缩字（widthOverflow）在票据 10 加入。
   * 不写 fit 时文字不做适配，放不下即按严重问题上报。
   */
  private readFit(value: unknown, writingMode: TextElementModel['writingMode'] | undefined, path: ElementPath): TextFit | undefined {
    const none: TextFit = { tightenSpacing: false, compressGlyphs: false, compressMin: MIN_COMPRESSION, onFail: 'severe' };
    if (value === undefined) return none;
    if (!isRecord(value)) {
      this.fail(path, 'fit 必须是对象');
      return undefined;
    }
    if ('widthOverflow' in value) {
      this.unsupported(path, 'fit.widthOverflow（按宽度统一缩字）尚未支持');
    }
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
    if (steps.includes('compressGlyphs') && !(steps.includes('tightenSpacing') && steps.indexOf('tightenSpacing') < steps.indexOf('compressGlyphs'))) {
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

  private readStroke(value: unknown, path: ElementPath): TextStroke | undefined {
    if (!isRecord(value)) {
      this.fail(path, 'stroke 必须写成 { "color": 颜色, "width": 毫米 }');
      return undefined;
    }
    this.checkKeys(value, ['color', 'width'], path, '文字描边');
    const color = this.readColor(value['color'], path, 'stroke.color');
    const width = value['width'];
    if (!isPositive(width)) {
      this.fail(path, 'stroke.width 必须是大于 0 的毫米数');
      return undefined;
    }
    return color ? { color, width } : undefined;
  }

  private readContent(value: unknown, path: ElementPath): ContentItem[] | undefined {
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

  private readFreePlace(value: unknown, path: ElementPath): FreePlace | undefined {
    if (!isRecord(value)) {
      this.fail(path, '元素必须用 place 给出位置与尺寸');
      return undefined;
    }
    this.checkKeys(value, FREE_PLACE_KEYS, path, '自由布局的位置');
    const edge = <E extends string>(a: E, b: E, axis: string): { edge: E; offset: number } | undefined => {
      const hasA = value[a] !== undefined;
      const hasB = value[b] !== undefined;
      if (hasA && hasB) {
        this.fail(path, `${axis}位置只能写 ${a} 或 ${b} 之一`);
        return undefined;
      }
      const key = hasB ? b : a;
      const offset = value[key] ?? 0;
      if (typeof offset !== 'number' || !Number.isFinite(offset)) {
        this.fail(path, `位置 ${key} 必须是毫米数`);
        return undefined;
      }
      return { edge: key, offset };
    };
    const horizontal = edge('left', 'right', '横向');
    const vertical = edge('top', 'bottom', '纵向');
    const width = this.readSize(value['width'], path, 'width');
    const height = this.readSize(value['height'], path, 'height');
    if (!horizontal || !vertical || !width || !height) return undefined;
    return { horizontal, vertical, width, height };
  }

  private readSize(value: unknown, path: ElementPath, label: string): SizeSpec | undefined {
    if (value === 'hug') return { kind: 'hug' };
    if (isRecord(value) && isPositive(value['fixed']) && Object.keys(value).length === 1) {
      return { kind: 'fixed', value: value['fixed'] };
    }
    if (value === 'fill') {
      this.unsupported(path, `尺寸方式 fill 尚未支持`);
      return undefined;
    }
    this.fail(path, `${label} 必须写成 { "fixed": 毫米 } 或 "hug"`);
    return undefined;
  }

  private readColor(value: unknown, path: ElementPath, label: string): Color | undefined {
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

  private readEnum<T extends string>(
    value: unknown,
    allowed: readonly T[],
    fallback: T,
    path: ElementPath,
    label: string,
  ): T | undefined {
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
    this.fail(path, `${label} 只能取 ${allowed.join('、')}`);
    return undefined;
  }

  private checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: ElementPath, what: string): void {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        this.report(ProblemCodes.templateUnknownProperty, path, `${what}中有未定义或尚未支持的属性 ${key}`);
        this.failed = true;
      }
    }
  }

  private fail(path: ElementPath, message: string): void {
    this.report(ProblemCodes.templateInvalid, path, message);
    this.failed = true;
  }

  private unsupported(path: ElementPath, message: string): void {
    this.report(ProblemCodes.templateUnsupported, path, message);
    this.failed = true;
  }

  private report(code: ProblemCode, path: ElementPath, message: string): void {
    this.problems.push(severe(code, { kind: 'element', path: formatElementPath(path) }, message));
  }
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
