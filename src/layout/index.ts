/**
 * 排版：测量、决定、记录（M99）。绘制是第四步，在 draw.ts 中只按这里的记录执行。
 *
 * - 测量：自下而上算出每个元素"随内容"时的尺寸（文字的字形与墨迹、图形的坐标范围、容器内的排布）。
 * - 决定：自上而下按所在容器的布局方式给每个元素一个框：自由布局按距边定位（M93），
 *   堆叠布局按方向依次排列、填满的元素按权重分剩余空间，网格布局先定行列再放进格子。
 *   隐藏的元素不参与布局（M27）。放不下时记为问题。
 * - 记录：生成布局摘要与绘制指令；布局摘要在绘制前就已完整，叠放顺序等于元素顺序（M72）。
 */
import type { CanvasKit } from 'canvaskit-wasm';
import { formatElementPath } from '../element-path.js';
import type { EvaluatedNode, EvaluatedTemplate } from '../evaluate.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import type { RenderRequest } from '../request.js';
import type { Align, ArtboardModel, ContainerModel, Edges, ElementModel, Layout, Place, SizeSpec, Track } from '../template/model.js';
import type { ImageStore } from '../images.js';
import type { FontStore } from '../text/fonts.js';
import { mmToPx, roundMm } from '../units.js';
import { imageIntrinsic, recordImage } from './image.js';
import { radii, recordShape, shapeIntrinsic, type PathBounds } from './shapes.js';
import { measureTextNode, recordText, type TextMeasure } from './text.js';
import { EPSILON, type Box, type DrawOp, type LayoutNode, type LayoutResult, type Size } from './types.js';

export type { Box, DrawOp, ImageSummary, LayoutNode, LayoutResult, LayoutSummary, Radii, TextSummary } from './types.js';

type Axis = 'width' | 'height';

/** 字体与图片须已由 FontStore、ImageStore 加载；加载失败的元素不画，只在布局摘要中记录框。 */
export function layout(
  evaluated: EvaluatedTemplate,
  output: RenderRequest['output'],
  resources: { readonly fonts: FontStore; readonly images: ImageStore },
  ck: CanvasKit,
): LayoutResult {
  const layouter = new Layouter(resources.fonts, resources.images, ck);
  const root = layouter.arrange(evaluated.root, { x: 0, y: 0, width: output.width, height: output.height });
  return {
    summary: {
      template: evaluated.template.name,
      output: {
        width: output.width,
        height: output.height,
        dpi: output.dpi,
        widthPx: mmToPx(output.width, output.dpi),
        heightPx: mmToPx(output.height, output.dpi),
        format: output.format,
      },
      root,
    },
    drawOps: layouter.drawOps,
    problems: layouter.problems,
  };
}

class Layouter {
  readonly drawOps: DrawOp[] = [];
  readonly problems: Problem[] = [];
  private readonly intrinsics = new Map<EvaluatedNode, Size>();
  private readonly textMeasures = new Map<EvaluatedNode, TextMeasure>();
  private readonly pathBoundsCache = new Map<string, ReturnType<PathBounds>>();

  constructor(
    private readonly fonts: FontStore,
    private readonly images: ImageStore,
    private readonly ck: CanvasKit,
  ) {}

  // ---------- 测量 ----------

  /** 随内容时的元素框尺寸（含内边距、不含外边距），未按最小最大尺寸限制。 */
  private intrinsic(node: EvaluatedNode): Size {
    let size = this.intrinsics.get(node);
    if (size) return size;
    const model = node.model;
    switch (model.type) {
      case 'artboard':
      case 'container':
        size = this.containerIntrinsic(node, model);
        break;
      case 'text':
        size = this.textMeasure(node).intrinsic;
        break;
      case 'image':
        size = imageIntrinsic(model, model.source ? this.images.get(model.source) : undefined);
        break;
      default:
        size = shapeIntrinsic(model, (d) => this.pathBounds(d));
    }
    this.intrinsics.set(node, size);
    return size;
  }

  private textMeasure(node: EvaluatedNode): TextMeasure {
    let measure = this.textMeasures.get(node);
    if (!measure && node.model.type === 'text') {
      measure = measureTextNode(node.model, node.fragments ?? [], this.fonts);
      this.textMeasures.set(node, measure);
    }
    return measure!;
  }

  private containerIntrinsic(node: EvaluatedNode, model: ArtboardModel | ContainerModel): Size {
    const children = visibleChildren(node);
    let content: Size;
    switch (model.layout.mode) {
      case 'free':
        content = {
          width: Math.max(0, ...children.map((child) => place(child).horizontal.offset + this.hugSize(child, 'width'))),
          height: Math.max(0, ...children.map((child) => place(child).vertical.offset + this.hugSize(child, 'height'))),
        };
        break;
      case 'stack': {
        const main: Axis = model.layout.direction === 'row' ? 'width' : 'height';
        const cross: Axis = main === 'width' ? 'height' : 'width';
        const mainTotal =
          children.reduce((sum, child) => sum + this.outerHug(child, main), 0) + model.layout.gap * Math.max(0, children.length - 1);
        const crossMax = Math.max(0, ...children.map((child) => this.outerHug(child, cross)));
        content = main === 'width' ? { width: mainTotal, height: crossMax } : { width: crossMax, height: mainTotal };
        break;
      }
      case 'grid': {
        const columns = this.resolveTracks(model.layout.columns, model.layout.columnGap, children, 'width', undefined);
        const rows = this.resolveTracks(model.layout.rows, model.layout.rowGap, children, 'height', undefined);
        content = { width: columns.total, height: rows.total };
        break;
      }
    }
    return {
      width: content.width + model.padding.left + model.padding.right,
      height: content.height + model.padding.top + model.padding.bottom,
    };
  }

  /** 随内容（填满按随内容算）时的尺寸，按最小最大尺寸限制。 */
  private hugSize(node: EvaluatedNode, axis: Axis): number {
    const spec = place(node)[axis];
    const value = spec?.kind === 'fixed' ? spec.value : this.intrinsic(node)[axis];
    return clampSize(node, axis, value);
  }

  private outerHug(node: EvaluatedNode, axis: Axis): number {
    const margin = place(node).margin;
    return this.hugSize(node, axis) + (axis === 'width' ? margin.left + margin.right : margin.top + margin.bottom);
  }

  /** 路径的边界；路径数据不合法时为 undefined（问题在记录时上报）。 */
  private pathBounds(d: string): ReturnType<PathBounds> {
    if (!this.pathBoundsCache.has(d)) {
      const path = this.ck.Path.MakeFromSVGString(d);
      if (!path) {
        this.pathBoundsCache.set(d, undefined);
      } else {
        const bounds = path.computeTightBounds();
        path.delete();
        this.pathBoundsCache.set(d, { right: bounds[2]!, bottom: bounds[3]! });
      }
    }
    return this.pathBoundsCache.get(d);
  }

  // ---------- 决定与记录 ----------

  arrange(node: EvaluatedNode, box: Box): LayoutNode {
    const model = node.model;
    const wrapped = model.type !== 'artboard' && this.pushSave(model, box);
    let summary: Partial<LayoutNode> = {};
    switch (model.type) {
      case 'artboard':
      case 'container':
        summary = { children: this.arrangeContainer(node, model, box) };
        break;
      case 'text': {
        const text = recordText(model, node.fragments ?? [], this.textMeasure(node), box, this.drawOps, this.problems);
        summary = text ? { text } : {};
        break;
      }
      case 'image': {
        const image = recordImage(model, box, model.source ? this.images.get(model.source) : undefined, this.drawOps);
        summary = image ? { image } : {};
        break;
      }
      default:
        if (model.type === 'path' && !this.pathBounds(model.d)) {
          this.problems.push(
            severe(ProblemCodes.templateInvalid, { kind: 'element', path: formatElementPath(model.path) }, `路径数据 d 不是合法的 SVG 路径：${model.d}`),
          );
        } else {
          recordShape(model, box, this.drawOps);
        }
    }
    if (wrapped) this.drawOps.push({ op: 'restore' });
    return {
      path: formatElementPath(model.path),
      name: model.name,
      type: model.type,
      x: roundMm(box.x),
      y: roundMm(box.y),
      width: roundMm(box.width),
      height: roundMm(box.height),
      visible: true,
      ...summary,
    };
  }

  /** 透明度与旋转作用于元素及其子元素整体；旋转绕元素框中心，不影响布局。 */
  private pushSave(model: ElementModel, box: Box): boolean {
    if (model.opacity >= 1 && model.rotation === 0) return false;
    this.drawOps.push({
      op: 'save',
      ...(model.opacity < 1 && { opacity: model.opacity }),
      ...(model.rotation !== 0 && { rotation: { degrees: model.rotation, cx: box.x + box.width / 2, cy: box.y + box.height / 2 } }),
    });
    return true;
  }

  private arrangeContainer(node: EvaluatedNode, model: ArtboardModel | ContainerModel, box: Box): LayoutNode[] {
    const corner = radii(model.cornerRadius);
    if (model.fill) this.drawOps.push({ op: 'rect', ...box, radii: corner, fill: model.fill });
    if (model.clip) this.drawOps.push({ op: 'save', clip: { ...box, radii: corner } });

    const content: Box = {
      x: box.x + model.padding.left,
      y: box.y + model.padding.top,
      width: Math.max(0, box.width - model.padding.left - model.padding.right),
      height: Math.max(0, box.height - model.padding.top - model.padding.bottom),
    };
    const boxes = this.childBoxes(node, model, content);
    const children = (node.children ?? []).map((child) => {
      const childBox = boxes.get(child);
      return childBox ? this.arrange(child, childBox) : hiddenNode(child);
    });

    if (model.clip) this.drawOps.push({ op: 'restore' });
    // 描边画在子元素之上，免得被填满的子元素盖住。
    if (model.stroke) this.drawOps.push({ op: 'rect', ...box, radii: corner, stroke: model.stroke });
    return children;
  }

  private childBoxes(node: EvaluatedNode, model: ArtboardModel | ContainerModel, content: Box): Map<EvaluatedNode, Box> {
    const children = visibleChildren(node);
    switch (model.layout.mode) {
      case 'free':
        return new Map(children.map((child) => [child, this.freeBox(child, content)]));
      case 'stack':
        return this.stackBoxes(model, model.layout, children, content);
      case 'grid':
        return this.gridBoxes(model, model.layout, children, content);
    }
  }

  private freeBox(child: EvaluatedNode, content: Box): Box {
    const { horizontal, vertical } = place(child);
    const width = this.resolveSize(child, 'width', 'hug', content.width - horizontal.offset);
    const height = this.resolveSize(child, 'height', 'hug', content.height - vertical.offset);
    return {
      x: horizontal.edge === 'left' ? content.x + horizontal.offset : content.x + content.width - horizontal.offset - width,
      y: vertical.edge === 'top' ? content.y + vertical.offset : content.y + content.height - vertical.offset - height,
      width,
      height,
    };
  }

  private stackBoxes(
    model: ArtboardModel | ContainerModel,
    layout: Extract<Layout, { mode: 'stack' }>,
    children: EvaluatedNode[],
    content: Box,
  ): Map<EvaluatedNode, Box> {
    const row = layout.direction === 'row';
    const main: Axis = row ? 'width' : 'height';
    const cross: Axis = row ? 'height' : 'width';
    const available = content[main];
    const before = (edges: Edges) => (row ? edges.left : edges.top);
    const after = (edges: Edges) => (row ? edges.right : edges.bottom);

    // 主方向：固定与随内容的元素先取尺寸，填满的元素按权重分剩余空间（受最小最大尺寸限制）。
    const sizes = new Map<EvaluatedNode, number>();
    const fills: EvaluatedNode[] = [];
    let used = layout.gap * Math.max(0, children.length - 1);
    for (const child of children) {
      const margin = place(child).margin;
      used += before(margin) + after(margin);
      if (place(child)[main]?.kind === 'fill') {
        fills.push(child);
      } else {
        const size = this.resolveSize(child, main, 'hug', 0);
        sizes.set(child, size);
        used += size;
      }
    }
    let remaining = available - used;
    for (const [child, size] of distributeFill(fills, Math.max(0, remaining), main)) {
      sizes.set(child, size);
      remaining -= size;
    }
    if (remaining < -EPSILON) {
      this.contentOverflow(model, `${row ? '横向' : '纵向'}堆叠的内容需要 ${fmt(available - remaining)} mm，可用 ${fmt(available)} mm`);
    }

    // 主方向分布：只在有剩余空间、且没有填满的元素时生效。
    const free = Math.max(0, remaining);
    const count = children.length;
    let offset = 0;
    let between = layout.gap;
    if (fills.length === 0 && free > 0) {
      switch (layout.justifyContent) {
        case 'center':
          offset = free / 2;
          break;
        case 'end':
          offset = free;
          break;
        case 'spaceBetween':
          if (count > 1) between += free / (count - 1);
          break;
        case 'spaceEvenly':
          offset = free / (count + 1);
          between += free / (count + 1);
          break;
      }
    }

    const boxes = new Map<EvaluatedNode, Box>();
    let cursor = content[row ? 'x' : 'y'] + offset;
    for (const child of children) {
      const margin = place(child).margin;
      const mainSize = sizes.get(child)!;
      cursor += before(margin);
      // 交叉方向：填满时撑满可用空间，否则按交叉方向对齐。
      const crossBefore = row ? margin.top : margin.left;
      const crossAfter = row ? margin.bottom : margin.right;
      const crossAvailable = content[cross] - crossBefore - crossAfter;
      const crossSize = this.resolveSize(child, cross, 'hug', crossAvailable);
      const crossOffset = alignOffset(place(child).alignSelf ?? layout.alignItems, crossAvailable - crossSize);
      const crossStart = content[row ? 'y' : 'x'] + crossBefore + crossOffset;
      boxes.set(
        child,
        row
          ? { x: cursor, y: crossStart, width: mainSize, height: crossSize }
          : { x: crossStart, y: cursor, width: crossSize, height: mainSize },
      );
      cursor += mainSize + after(margin) + between;
    }
    return boxes;
  }

  private gridBoxes(
    model: ArtboardModel | ContainerModel,
    layout: Extract<Layout, { mode: 'grid' }>,
    children: EvaluatedNode[],
    content: Box,
  ): Map<EvaluatedNode, Box> {
    const columns = this.resolveTracks(layout.columns, layout.columnGap, children, 'width', content.width);
    const rows = this.resolveTracks(layout.rows, layout.rowGap, children, 'height', content.height);
    if (columns.total > content.width + EPSILON) {
      this.contentOverflow(model, `网格各列共需 ${fmt(columns.total)} mm，可用宽 ${fmt(content.width)} mm`);
    }
    if (rows.total > content.height + EPSILON) {
      this.contentOverflow(model, `网格各行共需 ${fmt(rows.total)} mm，可用高 ${fmt(content.height)} mm`);
    }
    const boxes = new Map<EvaluatedNode, Box>();
    for (const child of children) {
      const p = place(child);
      const cellX = content.x + columns.starts[p.column - 1]!;
      const cellY = content.y + rows.starts[p.row - 1]!;
      const cellWidth = columns.starts[p.column - 1 + p.columnSpan - 1]! + columns.sizes[p.column - 1 + p.columnSpan - 1]! - columns.starts[p.column - 1]!;
      const cellHeight = rows.starts[p.row - 1 + p.rowSpan - 1]! + rows.sizes[p.row - 1 + p.rowSpan - 1]! - rows.starts[p.row - 1]!;
      const availableWidth = cellWidth - p.margin.left - p.margin.right;
      const availableHeight = cellHeight - p.margin.top - p.margin.bottom;
      const width = this.resolveSize(child, 'width', 'fill', availableWidth);
      const height = this.resolveSize(child, 'height', 'fill', availableHeight);
      boxes.set(child, {
        x: cellX + p.margin.left + alignOffset(p.justifySelf ?? 'start', availableWidth - width),
        y: cellY + p.margin.top + alignOffset(p.alignSelf ?? 'start', availableHeight - height),
        width,
        height,
      });
    }
    return boxes;
  }

  /**
   * 网格的行或列：固定取定值，随内容取只占这一条的元素中最大的，按比例的分剩余空间。
   * available 为 undefined 时是在测量随内容的尺寸，按比例的也按随内容算。
   */
  private resolveTracks(
    tracks: readonly Track[],
    gap: number,
    children: EvaluatedNode[],
    axis: Axis,
    available: number | undefined,
  ): { sizes: number[]; starts: number[]; total: number } {
    const sizes = tracks.map((track, index) => {
      if (track.kind === 'fixed') return track.value;
      if (track.kind === 'fraction' && available !== undefined) return 0;
      const occupants = children.filter((child) => {
        const p = place(child);
        return axis === 'width' ? p.column === index + 1 && p.columnSpan === 1 : p.row === index + 1 && p.rowSpan === 1;
      });
      return Math.max(0, ...occupants.map((child) => this.outerHug(child, axis)));
    });
    const gaps = gap * Math.max(0, tracks.length - 1);
    if (available !== undefined) {
      const fixedTotal = sizes.reduce((sum, size) => sum + size, 0) + gaps;
      const fractions = tracks.reduce((sum, track) => sum + (track.kind === 'fraction' ? track.value : 0), 0);
      const remaining = Math.max(0, available - fixedTotal);
      tracks.forEach((track, index) => {
        if (track.kind === 'fraction') sizes[index] = (remaining * track.value) / fractions;
      });
    }
    const starts: number[] = [];
    let cursor = 0;
    for (const size of sizes) {
      starts.push(cursor);
      cursor += size + gap;
    }
    return { sizes, starts, total: sizes.reduce((sum, size) => sum + size, 0) + gaps };
  }

  /** 按尺寸方式取尺寸：固定、随内容，或填满给定的可用空间；再按最小最大尺寸限制，不小于 0。 */
  private resolveSize(node: EvaluatedNode, axis: Axis, fallback: SizeSpec['kind'], fillAvailable: number): number {
    const spec = place(node)[axis];
    const kind = spec?.kind ?? fallback;
    const value = spec?.kind === 'fixed' ? spec.value : kind === 'fill' ? fillAvailable : this.intrinsic(node)[axis];
    return clampSize(node, axis, value);
  }

  private contentOverflow(model: ArtboardModel | ContainerModel, message: string): void {
    this.problems.push(
      severe(ProblemCodes.layoutContentOverflow, { kind: 'element', path: formatElementPath(model.path) }, `内容放不下：${message}`),
    );
  }
}

/** 填满的元素按权重分配空间；超出最小最大尺寸的元素固定在边界上，其余的重新分配。 */
function distributeFill(fills: EvaluatedNode[], space: number, axis: Axis): Map<EvaluatedNode, number> {
  const result = new Map<EvaluatedNode, number>();
  let active = [...fills];
  let remaining = space;
  while (active.length > 0) {
    const totalWeight = active.reduce((sum, node) => sum + weight(node, axis), 0);
    const clamped: EvaluatedNode[] = [];
    for (const node of active) {
      const share = (remaining * weight(node, axis)) / totalWeight;
      const size = clampSize(node, axis, share);
      if (Math.abs(size - share) > EPSILON) {
        result.set(node, size);
        clamped.push(node);
      }
    }
    if (clamped.length === 0) {
      for (const node of active) result.set(node, (remaining * weight(node, axis)) / totalWeight);
      break;
    }
    for (const node of clamped) remaining -= result.get(node)!;
    active = active.filter((node) => !clamped.includes(node));
  }
  return result;
}

function weight(node: EvaluatedNode, axis: Axis): number {
  const spec = place(node)[axis];
  return spec?.kind === 'fill' ? spec.weight : 1;
}

function clampSize(node: EvaluatedNode, axis: Axis, value: number): number {
  const p = place(node);
  const min = axis === 'width' ? p.minWidth : p.minHeight;
  const max = axis === 'width' ? p.maxWidth : p.maxHeight;
  let size = value;
  if (max !== undefined) size = Math.min(size, max);
  if (min !== undefined) size = Math.max(size, min);
  return Math.max(0, size);
}

function alignOffset(align: Align, free: number): number {
  return align === 'center' ? free / 2 : align === 'end' ? free : 0;
}

function place(node: EvaluatedNode): Place {
  if (node.model.type === 'artboard') throw new Error('画板没有 place');
  return node.model.place;
}

function visibleChildren(node: EvaluatedNode): EvaluatedNode[] {
  return (node.children ?? []).filter((child) => child.model.type !== 'artboard' && child.model.visible);
}

function hiddenNode(node: EvaluatedNode): LayoutNode {
  return {
    path: formatElementPath(node.model.path),
    name: node.model.name,
    type: node.model.type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    visible: false,
  };
}

function fmt(value: number): string {
  return String(roundMm(value));
}
