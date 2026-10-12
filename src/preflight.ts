/** 按各自输入独立执行静态检查与数据检查，汇总后才决定是否能展开（M102）。 */
import { CompiledSchemaError, validateDataset } from './dataset-validation.js';
import { ProblemCodes, severe, type Problem } from './problems.js';
import type { RenderRequest } from './request.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseTemplate } from './template/parse.js';
import { prepareTemplates } from './template/program.js';
import { resolveParameters } from './template/scope.js';
import { formatStaticSchemaRef, parseDatasetDocument, sameStaticSchema, type DatasetDocument, type Workspace } from './workspace.js';

export function preflight(workspace: Workspace, request: RenderRequest, problems: Problem[]) {
  const entry = workspace.templates.find((candidate) => candidate.name === request.template);
  const parsed = entry && parseTemplate(entry.name, entry.document);
  if (parsed) problems.push(...parsed.problems);
  else problems.push(severe(ProblemCodes.templateNotFound, { kind: 'input', source: 'request.template' }, `工作区中没有模板"${request.template}"`));
  const template = parsed?.model;
  const dataset = resolveDataset(workspace, request, problems);
  let blocked = !template || !dataset;

  const templateSchema = template && findStaticSchema(workspace, template.base);
  const datasetSchema = dataset && findStaticSchema(workspace, dataset.dataset.staticSchema);
  const checked = template && templateSchema?.compiled && prepareTemplates(workspace, template, templateSchema.compiled);
  if (checked) { problems.push(...checked.problems); blocked ||= checked.blocked; }
  // 同一版本只报告一次缺失编译产物；不同版本分别检查，不能拿数据集的版本检查模板。
  if (template && !templateSchema?.compiled && (!dataset || !sameStaticSchema(template.base, dataset.dataset.staticSchema))) {
    problems.push(severe(templateSchema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound,
      { kind: 'input', source: 'template.base' }, `模板基准“${formatStaticSchemaRef(template.base)}”没有可用的编译产物`));
    blocked = true;
  }
  if (dataset) {
    if (!datasetSchema?.compiled) {
      problems.push(severe(datasetSchema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound,
        { kind: 'input', source: 'dataset.staticSchema' }, `数据集选定的静态数据定义“${formatStaticSchemaRef(dataset.dataset.staticSchema)}”没有可用的编译产物`));
      blocked = true;
    } else {
      try { problems.push(...validateDataset(datasetSchema.compiled, dataset.data, workspace.resources)); }
      catch (error) {
        if (!(error instanceof CompiledSchemaError)) throw error;
        problems.push(severe(ProblemCodes.inputUnreadable, { kind: 'input', source: 'dataset.staticSchema' }, `编译产物无法使用：${error.message}`));
        blocked = true;
      }
    }
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
