/** 按各自输入独立执行静态检查与数据检查，汇总后才决定是否能展开（M102）。 */
import { checkDatasetData } from './dataset-validation.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import type { RenderRequest } from './request.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseTemplate } from './template/parse.js';
import { prepareTemplates } from './template/program.js';
import { resolveParameters } from './template/scope.js';
import type { TemplateModel } from './template/model.js';
import { formatStaticSchemaRef, parseDatasetDocument, sameStaticSchema, type DatasetDocument, type StaticSchemaRef, type Workspace } from './workspace.js';

export function preflight(workspace: Workspace, request: RenderRequest, problems: Problem[]) {
  const template = readTemplate(workspace, request.template, problems);
  const dataset = resolveDataset(workspace, request, problems);
  let blocked = !template || !dataset;

  const side = template && checkTemplateSide(workspace, template, problems, dataset?.dataset.staticSchema);
  if (side?.blocked) blocked = true;
  const checked = side?.checked;
  if (dataset) {
    const data = checkDatasetData(workspace, dataset);
    problems.push(...data.problems);
    if (data.blocked) blocked = true;
  }
  if (template && dataset && !sameStaticSchema(template.base, dataset.dataset.staticSchema)) {
    problems.push(severe(ProblemCodes.datasetStaticSchemaMismatch, { kind: 'input', source: 'dataset.staticSchema' },
      `数据集选定的是"${formatStaticSchemaRef(dataset.dataset.staticSchema)}"，模板"${template.name}"的基准是"${formatStaticSchemaRef(template.base)}"`));
    blocked = true;
  }
  const parameters = template && resolveParameters(template, request.parameters);
  if (parameters) problems.push(...parameters.problems);
  if (blocked || !template || !dataset || !checked || !parameters) return undefined;
  return { template, dataset, checked, parameters };
}

/**
 * 只做模板一侧的检查：读取根模板、按基准准备调用树。不涉及数据集与参数，
 * 批量交付据此判断根模板能否展开（M258）；问题与单次渲染中模板一侧的问题相同。
 */
export function preflightTemplate(workspace: Workspace, name: string, problems: Problem[]): { blocked: boolean } {
  const template = readTemplate(workspace, name, problems);
  return { blocked: !template || checkTemplateSide(workspace, template, problems).blocked };
}

function readTemplate(workspace: Workspace, name: string, problems: Problem[]): TemplateModel | undefined {
  const entry = workspace.templates.find((candidate) => candidate.name === name);
  const parsed = entry && parseTemplate(entry.name, entry.document);
  if (parsed) problems.push(...parsed.problems);
  else problems.push(severe(ProblemCodes.templateNotFound, { kind: 'input', source: 'request.template' }, `工作区中没有模板"${name}"`));
  return parsed?.model;
}

/** 按模板基准准备调用树；datasetSchema 与基准是同一版本时，缺失的编译产物留给数据集一侧报告。 */
function checkTemplateSide(workspace: Workspace, template: TemplateModel, problems: Problem[], datasetSchema?: StaticSchemaRef) {
  const templateSchema = findStaticSchema(workspace, template.base);
  const checked = templateSchema?.compiled ? prepareTemplates(workspace, template, templateSchema.compiled) : undefined;
  let blocked = false;
  if (checked) { problems.push(...checked.problems); blocked = checked.blocked; }
  // 同一版本只报告一次缺失编译产物；不同版本分别检查，不能拿数据集的版本检查模板。
  if (!templateSchema?.compiled && (!datasetSchema || !sameStaticSchema(template.base, datasetSchema))) {
    problems.push(severe(templateSchema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound,
      { kind: 'input', source: 'template.base' }, `模板基准“${formatStaticSchemaRef(template.base)}”没有可用的编译产物`));
    blocked = true;
  }
  return { checked, blocked };
}

function resolveDataset(workspace: Workspace, request: RenderRequest, problems: Problem[]): DatasetDocument | undefined {
  let document: unknown;
  if ('inline' in request.dataset) document = request.dataset.inline;
  else {
    const id = request.dataset.id;
    const entry = workspace.datasets.find((candidate) => candidate.id === id);
    if (!entry) {
      problems.push(severe(ProblemCodes.datasetNotFound, { kind: 'input', source: 'request.dataset.id' }, `工作区中没有数据集 ${id}`));
      return undefined;
    }
    document = entry.document;
  }
  const parsed = parseDatasetDocument(document);
  if (typeof parsed !== 'string') return parsed;
  problems.push(severe(ProblemCodes.inputUnreadable, { kind: 'input', source: 'dataset' }, parsed));
  return undefined;
}
