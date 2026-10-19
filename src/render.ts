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
import { formatElementPath } from './element-path.js';
import { ImageStore } from './images.js';
import { evaluate, walkVisible } from './evaluate.js';
import { layout, type LayoutSummary } from './layout/index.js';
import { ProblemCodes, hasSevere, severe, type Problem } from './problems.js';
import { parseRenderRequest, type RenderRequest } from './request.js';
import { Scope } from './template/scope.js';
import type { TemplateModel } from './template/model.js';
import { FontStore } from './text/fonts.js';
import { resolveGlyphFallbacks } from './text/fallback.js';
import type { Workspace } from './workspace.js';

export interface RenderResult {
  /** 正式出图存在严重问题时没有图片。 */
  readonly image?: EncodedImage;
  readonly problems: readonly Problem[];
  /** 排版完成时才有布局摘要。 */
  readonly layout?: LayoutSummary;
}

export interface RenderOptions {
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

export async function render(workspace: Workspace, requestInput: unknown, options: RenderOptions = {}): Promise<RenderResult> {
  const { request, prepared, problems } = prepareRender(workspace, requestInput);
  if (!request || !prepared) return { problems };
  const { template, dataset, checked, parameters } = prepared;
  problems.push(...checkSizeRange(template, request.output));
  const evaluation = evaluate(new Scope(template, checked.program.get(template.name)!.table, dataset.data, parameters.values),
    checked.program, problems, parameters.problems);
  problems.push(...evaluation.problems);
  const evaluated = evaluation.evaluated;
  if (!evaluated) return expansionBlocked(problems);
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
    return { image, problems, layout: result.summary };
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
