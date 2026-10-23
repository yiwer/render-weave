/**
 * 渲染入口（主接缝）：接收工作区与渲染请求，返回图片、问题清单与布局摘要。
 * 不依赖任何框架，命令行、日后的 MCP 服务与 HTTP 服务都调用这一个函数。
 *
 * 解析 → 独立检查并汇总（模板、数据、版本、参数）→ 判断能否展开 → 求值 → 排版 → 绘制。
 * 草稿的占位与问题边框是额外显示层，真实内容的诊断与正式出图一致（M102、M104）。
 */
import { loadCanvasKit } from './canvaskit.js';
import { draftBorders, withDraftPlaceholders } from './draft.js';
import { preflight, preflightTemplate } from './preflight.js';
import { draw, type EncodedImage } from './draw.js';
import { evidenceNodes, type RenderEvidence } from './render-evidence.js';
export type { RenderEvidence } from './render-evidence.js';
import { formatElementPath } from './element-path.js';
import { ImageStore } from './images.js';
import { evaluate, walkVisible, type EvaluatedTemplate } from './evaluate.js';
import { layout, type LayoutSummary } from './layout/index.js';
import { ProblemCodes, hasSevere, severe, type Problem } from './problems.js';
import { parseRenderRequest, type RenderRequest } from './request.js';
import { Scope } from './template/scope.js';
import type { TemplateModel } from './template/model.js';
import { FontStore } from './text/fonts.js';
import { mmToPx } from './units.js';
import { resolveGlyphFallbacks } from './text/fallback.js';
import type { Workspace } from './workspace.js';

export interface RenderResult {
  /** 可选的草稿比较证据：真实内容在占位与诊断边框之前的图与布局。 */
  readonly evidence?: RenderEvidence;
  /** 正式出图存在严重问题时没有图片。 */
  readonly image?: EncodedImage;
  readonly problems: readonly Problem[];
  /** 排版完成时才有布局摘要。 */
  readonly layout?: LayoutSummary;
}

export interface RenderOptions {
  /** 仅草稿模式收集；正式模式的 severe 阻断不变。 */
  readonly comparisonEvidence?: boolean;
  /** 后备字体资源 ID，按文件 OS/2 字重选择；省略时为默认思源黑体，空列表禁用替代。 */
  readonly fallbackFonts?: readonly string[];
  /** SVG 可用的字体资源 ID；缺省为思源黑体四种字重，始终禁用系统字体。 */
  readonly svgFonts?: readonly string[];
}

/**
 * 渲染的同步前段：解析请求，再做出图前检查（M102）。无法展开时没有 prepared，problems 就是 render 会返回的完整问题清单；
 * 批量交付据此给无法展开的项报与单次渲染相同的问题（M258）。
 */
export function prepareRender(workspace: Workspace, requestInput: unknown): {
  request?: RenderRequest;
  prepared?: NonNullable<ReturnType<typeof preflight>>;
  problems: Problem[];
} {
  const problems: Problem[] = [...workspace.problems];
  const parsed = parseRenderRequest(requestInput);
  problems.push(...parsed.problems);
  const request = parsed.request;
  if (!request) return { problems };
  const prepared = preflight(workspace, request, problems);
  if (!prepared) expansionBlocked(problems);
  return { request, prepared, problems };
}

/** 只看根模板一侧：无法展开时返回问题清单（工作区问题、模板一侧的问题与 render.expansionBlocked），能展开时返回 undefined（M258）。 */
export function templateBlocked(workspace: Workspace, template: string): Problem[] | undefined {
  const problems: Problem[] = [...workspace.problems];
  if (!preflightTemplate(workspace, template, problems).blocked) return undefined;
  expansionBlocked(problems);
  return problems;
}

/** 渲染的展开段（同步、不出图）：准备、尺寸范围与求值。无法展开时没有 evaluated，problems 是 render 会返回的完整问题清单。 */
function expand(workspace: Workspace, requestInput: unknown): { request?: RenderRequest; evaluated?: EvaluatedTemplate; problems: Problem[] } {
  const { request, prepared, problems } = prepareRender(workspace, requestInput);
  if (!request || !prepared) return { problems };
  const { template, dataset, checked, parameters } = prepared;
  problems.push(...checkSizeRange(template, request.output));
  const evaluation = evaluate(new Scope(template, checked.program.get(template.name)!.table, dataset.data, parameters.values),
    checked.program, problems, parameters.problems);
  problems.push(...evaluation.problems);
  if (!evaluation.evaluated) expansionBlocked(problems);
  return { request, ...(evaluation.evaluated && { evaluated: evaluation.evaluated }), problems };
}

/** 一次渲染的规模：出图像素，以及展开后会显示的元素数与循环项数。 */
export interface RenderMeasure {
  readonly widthPx: number;
  readonly heightPx: number;
  /** 展开后会显示的元素数，含画板、循环与调用展开成的容器。 */
  readonly elements: number;
  /** 会显示的循环展开出的项数，嵌套循环逐层累计。 */
  readonly loopItems: number;
}

/**
 * 不出图的度量（ADR-0017「进入队列前的限制」）：只解析、检查与求值，不加载 CanvasKit。
 * 无法展开时没有 measure，problems 与 render 返回的完全相同；能展开时 problems 是排版之前的问题。
 */
export function measureRender(workspace: Workspace, requestInput: unknown): { measure?: RenderMeasure; problems: Problem[] } {
  const { request, evaluated, problems } = expand(workspace, requestInput);
  if (!request || !evaluated) return { problems };
  let elements = 0, loopItems = 0;
  for (const node of walkVisible(evaluated.root)) {
    elements++;
    if (node.sourceType === 'loop') loopItems += node.children?.length ?? 0;
  }
  const { width, height, dpi } = request.output;
  return { measure: { widthPx: mmToPx(width, dpi), heightPx: mmToPx(height, dpi), elements, loopItems }, problems };
}

/** 预先加载绘制引擎（CanvasKit）。出图服务的渲染子进程启动时调用，第一项就不必等加载。 */
export async function preloadRenderer(): Promise<void> {
  await loadCanvasKit();
}

export async function render(workspace: Workspace, requestInput: unknown, options: RenderOptions = {}): Promise<RenderResult> {
  const { request, evaluated, problems } = expand(workspace, requestInput);
  if (!request || !evaluated) return { problems };
  const ck = await loadCanvasKit();
  const fonts = new FontStore(ck, workspace.resources, options.fallbackFonts);
  const images = new ImageStore(ck, workspace.resources, options.svgFonts);
  try {
    // 先加载会显示的元素用到的字体与图片，排版与绘制都是同步的。
    for (const node of walkVisible(evaluated.root)) {
      const model = node.model;
      if (model.type === 'text' || (model.type === 'barcode' && model.showText && model.font)) {
        // 元素自身的字体与各片段的字体，同一元素的同一字体只报一次。
        const ids = new Set([model.font!, ...(node.fragments ?? []).map((fragment) => fragment.style.font)]);
        for (const id of ids) {
          const problem = await fonts.load(id, model.path);
          if (problem) problems.push(problem);
        }
      } else if (model.type === 'image' && model.source) {
        const problem = await images.load(model.source, model.path);
        if (problem) problems.push(problem);
      }
    }
    const root = await resolveGlyphFallbacks(evaluated.root, fonts, problems);
    let result = layout({ ...evaluated, root }, request.output, { fonts, images }, ck);
    problems.push(...result.problems);
    const rasterized = images.prepare(result.drawOps, request.output.dpi);
    problems.push(...rasterized.problems);
    if (request.mode === 'final' && hasSevere(problems)) return { problems, layout: result.summary };
    let drawOps = rasterized.drawOps;
    const evidence = options.comparisonEvidence && request.mode === 'draft' ? {
      image: draw(ck, { fonts, images }, drawOps, request.output), layout: result.summary,
      nodes: evidenceNodes(root, drawOps, fonts),
    } : undefined;
    if (request.mode === 'draft') {
      const preview = withDraftPlaceholders(root);
      let draftRoot = preview.root;
      if (preview.changed) {
        // 占位字造成的缺字、溢出等不是原数据的问题，不进入公共问题清单。
        draftRoot = await resolveGlyphFallbacks(draftRoot, fonts, []);
        result = layout({ ...evaluated, root: draftRoot }, request.output, { fonts, images }, ck);
        drawOps = images.prepare(result.drawOps, request.output.dpi).drawOps;
      }
      drawOps = [...drawOps, ...draftBorders(draftRoot, result.summary, problems)];
    }
    const image = draw(ck, { fonts, images }, drawOps, request.output);
    return { image, problems, layout: result.summary, ...(evidence ? { evidence } : {}) };
  } finally {
    fonts.dispose();
    images.dispose();
  }
}

function expansionBlocked(problems: Problem[]): RenderResult {
  problems.push(severe(ProblemCodes.renderExpansionBlocked, { kind: 'input', source: 'render' },
    '输入无法展开，草稿预览与正式出图均停止；具体原因见上述问题'));
  return { problems };
}

/** 实际尺寸必须落在画板的适用尺寸范围内。 */
function checkSizeRange(template: TemplateModel, output: RenderRequest['output']): Problem[] {
  const { width, height } = template.artboard.sizeRange;
  const outside = (value: number, range: { min: number; max: number }) => value < range.min || value > range.max;
  if (!outside(output.width, width) && !outside(output.height, height)) return [];
  return [
    severe(
      ProblemCodes.renderSizeOutOfRange,
      { kind: 'element', path: formatElementPath(template.artboard.path) },
      `实际尺寸 ${output.width} × ${output.height} mm 超出模板"${template.name}"的适用尺寸范围：` +
        `宽 ${width.min}–${width.max} mm，高 ${height.min}–${height.max} mm`,
    ),
  ];
}
