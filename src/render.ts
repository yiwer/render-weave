/**
 * 渲染入口（主接缝）：接收工作区与渲染请求，返回图片、问题清单与布局摘要。
 * 不依赖任何框架，命令行、日后的 MCP 服务与 HTTP 服务都调用这一个函数。
 *
 * 本版本的顺序：渲染请求 → 模板 → 数据集与编译产物 → 数据集校验 → 数据集版本与模板基准 → 模板静态检查 → 对外参数 → 尺寸范围
 * → 求值（检查项、派生变量、绑定、条件显示、状态样式、插槽）→ 排版 → 绘制。
 * 完整的检查顺序与草稿预览的出图条件见 M102（票据 12）。
 */
import { loadCanvasKit } from './canvaskit.js';
import { validateDataset, CompiledSchemaError } from './dataset-validation.js';
import { draw, type EncodedImage } from './draw.js';
import { formatElementPath } from './element-path.js';
import { ImageStore } from './images.js';
import { evaluate, walkVisible } from './evaluate.js';
import { layout, type LayoutSummary } from './layout/index.js';
import { ProblemCodes, hasSevere, severe, type Problem } from './problems.js';
import { parseRenderRequest, type RenderRequest } from './request.js';
import { prepareTemplates } from './template/program.js';
import { findStaticSchema } from './schema/builtins.js';
import { Scope, resolveParameters } from './template/scope.js';
import type { TemplateModel } from './template/model.js';
import { parseTemplate } from './template/parse.js';
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
  const schema = findStaticSchema(workspace, schemaRef);
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
    problems.push(...validateDataset(schema.compiled, dataset.data, workspace.resources));
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
  // 渲染时数据集选定的静态数据定义必须与模板基准完全一致（M37）；不一致时模板无法展开，两种模式都不出图（M102）。
  if (!sameStaticSchema(template.base, schemaRef)) {
    problems.push(
      severe(
        ProblemCodes.datasetStaticSchemaMismatch,
        { kind: 'input', source: 'dataset.staticSchema' },
        `数据集选定的是"${formatStaticSchemaRef(schemaRef)}"，模板"${template.name}"的基准是"${formatStaticSchemaRef(template.base)}"`,
      ),
    );
    return { problems };
  }
  const checked = prepareTemplates(workspace, template, schema.compiled);
  problems.push(...checked.problems);
  const parameters = resolveParameters(template, request.parameters);
  problems.push(...parameters.problems);
  problems.push(...checkSizeRange(template, request.output));
  if (checked.blocked) return { problems };

  const evaluation = evaluate(new Scope(template, checked.program.get(template.name)!.table, dataset.data, parameters.values), checked.program);
  problems.push(...evaluation.problems);
  const evaluated = evaluation.evaluated;
  if (!evaluated) return { problems };
  const ck = await loadCanvasKit();
  const fonts = new FontStore(ck, workspace.resources);
  const images = new ImageStore(ck, workspace.resources);
  try {
    // 先加载会显示的元素用到的字体与图片，排版与绘制都是同步的。
    for (const node of walkVisible(evaluated.root)) {
      const model = node.model;
      if (model.type === 'text') {
        // 元素自身的字体与各片段的字体，同一元素的同一字体只报一次。
        const ids = new Set([model.font, ...(node.fragments ?? []).map((fragment) => fragment.style.font)]);
        for (const id of ids) {
          const problem = await fonts.load(id, model.path);
          if (problem) problems.push(problem);
        }
      } else if (model.type === 'image' && model.source) {
        const problem = await images.load(model.source, model.path);
        if (problem) problems.push(problem);
      }
    }
    const result = layout(evaluated, request.output, { fonts, images }, ck);
    problems.push(...result.problems);
    if (request.mode === 'final' && hasSevere(problems)) return { problems, layout: result.summary };
    const image = draw(ck, { fonts, images }, result.drawOps, request.output);
    return { image, problems, layout: result.summary };
  } finally {
    fonts.dispose();
    images.dispose();
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
