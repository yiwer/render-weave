/**
 * 渲染入口（主接缝）：接收工作区与渲染请求，返回图片、问题清单与布局摘要。
 * 不依赖任何框架，命令行、日后的 MCP 服务与 HTTP 服务都调用这一个函数。
 *
 * 本版本的顺序：渲染请求 → 模板 → 数据集与编译产物 → 数据集校验 → 尺寸范围 → 求值 → 排版 → 绘制。
 * 完整的检查顺序与草稿预览的出图条件见 M102（票据 12）。
 */
import { loadCanvasKit } from './canvaskit.js';
import { validateDataset, CompiledSchemaError } from './dataset-validation.js';
import { draw, type EncodedImage } from './draw.js';
import { formatElementPath } from './element-path.js';
import { evaluate } from './evaluate.js';
import { layout, type LayoutSummary } from './layout.js';
import { ProblemCodes, hasSevere, severe, type Problem } from './problems.js';
import { parseRenderRequest, type RenderRequest } from './request.js';
import { parseTemplate, type TemplateModel } from './template.js';
import { FontStore } from './text/fonts.js';
import { formatStaticSchemaRef, sameStaticSchema, type DatasetDocument, type Workspace } from './workspace.js';

export interface RenderResult {
  /** 正式出图存在严重问题时没有图片。 */
  readonly image?: EncodedImage;
  readonly problems: readonly Problem[];
  /** 排版完成时才有布局摘要。 */
  readonly layout?: LayoutSummary;
}

export async function render(workspace: Workspace, requestInput: unknown): Promise<RenderResult> {
  const problems: Problem[] = [...workspace.problems];
  const parsed = parseRenderRequest(requestInput);
  problems.push(...parsed.problems);
  const request = parsed.request;
  if (!request) return { problems };

  const templateEntry = workspace.templates.find((entry) => entry.name === request.template);
  if (!templateEntry) {
    problems.push(
      severe(ProblemCodes.templateNotFound, { kind: 'input', source: 'request.template' }, `工作区中没有模板"${request.template}"`),
    );
    return { problems };
  }
  const { model: template, problems: templateProblems } = parseTemplate(templateEntry.name, templateEntry.document);
  problems.push(...templateProblems);

  const dataset = resolveDataset(workspace, request, problems);
  if (!dataset) return { problems };
  const schemaRef = dataset.dataset.staticSchema;
  const schema = workspace.staticSchemas.find((entry) => sameStaticSchema(entry.ref, schemaRef));
  if (!schema) {
    problems.push(
      severe(
        ProblemCodes.staticSchemaNotFound,
        { kind: 'input', source: 'dataset.staticSchema' },
        `工作区中没有数据集选定的静态数据定义"${formatStaticSchemaRef(schemaRef)}"`,
      ),
    );
    return { problems };
  }
  if (!schema.compiled) {
    problems.push(
      severe(
        ProblemCodes.compiledSchemaMissing,
        { kind: 'input', source: 'dataset.staticSchema' },
        `静态数据定义"${formatStaticSchemaRef(schemaRef)}"没有编译产物，无法校验数据集`,
      ),
    );
    return { problems };
  }
  try {
    problems.push(...validateDataset(schema.compiled, dataset.data));
  } catch (error) {
    if (!(error instanceof CompiledSchemaError)) throw error;
    problems.push(
      severe(
        ProblemCodes.inputUnreadable,
        { kind: 'input', source: 'dataset.staticSchema' },
        `静态数据定义"${formatStaticSchemaRef(schemaRef)}"的编译产物无法使用：${error.message}`,
      ),
    );
    return { problems };
  }

  if (!template) return { problems };
  problems.push(...checkSizeRange(template, request.output));

  const evaluated = evaluate(template, dataset.data);
  const ck = await loadCanvasKit();
  const fonts = new FontStore(ck, workspace.resources);
  try {
    for (const child of evaluated.children) {
      const problem = await fonts.load(child.model.font, child.model.path);
      if (problem) problems.push(problem);
    }
    const result = layout(evaluated, request.output, fonts);
    if (request.mode === 'final' && hasSevere(problems)) return { problems, layout: result.summary };
    const image = draw(ck, fonts, result.drawOps, request.output);
    return { image, problems, layout: result.summary };
  } finally {
    fonts.dispose();
  }
}

function resolveDataset(workspace: Workspace, request: RenderRequest, problems: Problem[]): DatasetDocument | undefined {
  if ('inline' in request.dataset) return request.dataset.inline;
  const id = request.dataset.id;
  const entry = workspace.datasets.find((candidate) => candidate.id === id);
  if (!entry) {
    problems.push(severe(ProblemCodes.datasetNotFound, { kind: 'input', source: 'request.dataset.id' }, `工作区中没有数据集 ${id}`));
    return undefined;
  }
  return entry.document;
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
