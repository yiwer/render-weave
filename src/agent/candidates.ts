/**
 * 用引擎校验候选文件（第三阶段 PRD 第 9 条）：成果校验与审核视图共用，应用前也在当前工作区上再跑一遍。
 * - 数据定义：按依赖顺序在内存中发布，版本号接在工作区之后。
 * - 数据集：先按 JSON Schema 做前置校验；再要求有 id、不与工作区重复、选定本轮的数据定义；最后按编译产物校验数据。
 * - 模板：先按 JSON Schema 做前置校验；再以全部候选作为工作副本做静态检查。模板辅助设计只新建模板，名称不能与工作区重复；
 *   模板辅助修改的候选与主模板调用树中的模板同名时是它们的工作副本，代替已保存的模板（M49、M50）。
 */
import { CompiledSchemaError, validateDataset } from '../dataset-validation.js';
import { checkAgainstDslSchema } from '../dsl-schema.js';
import { ProblemCodes, severe, type Problem } from '../problems.js';
import { findStaticSchema } from '../schema/builtins.js';
import { publishStaticSchema, type PublishedStaticSchema } from '../schema/publish.js';
import { parseTemplate } from '../template/parse.js';
import { prepareTemplates } from '../template/program.js';
import { isRecord } from '../util.js';
import { formatStaticSchemaRef, parseDatasetDocument, sameStaticSchema, type StaticSchemaEntry, type StaticSchemaRef, type Workspace } from '../workspace.js';
import type { CandidateKind } from './tasks.js';

export interface CandidateDocument {
  readonly path: string;
  readonly kind: CandidateKind;
  readonly document: unknown;
}

export interface CandidateContext {
  /** 数据集提取所选的数据定义：候选数据集必须选定它。 */
  readonly definition?: StaticSchemaRef;
  /** 模板辅助修改可以改的已保存模板：出图请求主模板的调用树。 */
  readonly revision?: { readonly templates: readonly string[] };
}

export interface CandidateResult {
  readonly problems: Problem[];
  /** 数据定义在内存中发布的结果。 */
  readonly published?: PublishedStaticSchema;
}

/** 校验一组候选；结果按候选路径给出，数据定义按发布顺序排在前面。 */
export function checkCandidates(candidates: readonly CandidateDocument[], workspace: Workspace, context: CandidateContext = {}): Map<string, CandidateResult> {
  const results = new Map<string, CandidateResult>(publishInDependencyOrder(candidates.filter((candidate) => candidate.kind === 'definition'), workspace.staticSchemas));
  const datasets = candidates.filter((candidate) => candidate.kind === 'dataset');
  for (const candidate of datasets) results.set(candidate.path, { problems: checkDataset(candidate, datasets, workspace, context) });
  const templates = candidates.filter((candidate) => candidate.kind === 'template');
  for (const [path, problems] of checkTemplates(templates, workspace, context.revision)) results.set(path, { problems });
  return results;
}

/**
 * 在内存中按依赖顺序发布数据定义：引用其他候选的定义，等被引用者发布后再发布；版本号接在 existing 之后。
 * 结果按发布顺序排列，发布不了的定义带着最后一次尝试的问题排在最后。
 */
export function publishInDependencyOrder(
  definitions: readonly { readonly path: string; readonly document: unknown }[],
  existing: readonly StaticSchemaEntry[],
): Map<string, { published?: PublishedStaticSchema; problems: Problem[] }> {
  const published: PublishedStaticSchema[] = [];
  const results = new Map<string, { published?: PublishedStaticSchema; problems: Problem[] }>();
  const failed = new Map<string, Problem[]>();
  let remaining = definitions;
  for (let progress = true; progress && remaining.length > 0;) {
    progress = false;
    const next: (typeof definitions)[number][] = [];
    for (const candidate of remaining) {
      const outcome = publishStaticSchema(candidate.document, [...existing, ...published]);
      if (outcome.published) {
        published.push(outcome.published);
        results.set(candidate.path, { published: outcome.published, problems: outcome.problems });
        progress = true;
      } else {
        failed.set(candidate.path, outcome.problems);
        next.push(candidate);
      }
    }
    remaining = next;
  }
  for (const candidate of remaining) results.set(candidate.path, { problems: failed.get(candidate.path)! });
  return results;
}

function checkDataset(candidate: CandidateDocument, all: readonly CandidateDocument[], workspace: Workspace, context: CandidateContext): Problem[] {
  const where = { kind: 'input', source: candidate.path } as const;
  const schema = checkAgainstDslSchema('dataset', candidate.document);
  if (schema.messages.length > 0) return [severe(ProblemCodes.datasetInvalid, where, `不符合 ${schema.file}：${schema.messages.join('；')}`)];
  const parsed = parseDatasetDocument(candidate.document);
  if (typeof parsed === 'string') return [severe(ProblemCodes.datasetInvalid, where, parsed)];
  const problems: Problem[] = [];
  const id = parsed.dataset.id;
  if (id === undefined) problems.push(severe(ProblemCodes.datasetInvalid, where, '工作区中的数据集必须有 dataset.id'));
  else if (workspace.datasets.some((entry) => entry.id === id)) {
    problems.push(severe(ProblemCodes.datasetInvalid, where, `工作区已有数据集 ${id}：数据集提取只新建数据集，换一个 id`));
  } else if (all.some((other) => other !== candidate && datasetId(other.document) === id)) {
    problems.push(severe(ProblemCodes.datasetInvalid, where, `候选数据集的 id 重复：${id}`));
  }
  const ref = parsed.dataset.staticSchema;
  if (context.definition && !sameStaticSchema(ref, context.definition)) {
    problems.push(severe(ProblemCodes.datasetInvalid, where,
      `数据集要选定本轮的数据定义 ${formatStaticSchemaRef(context.definition)}，写的是 ${formatStaticSchemaRef(ref)}`));
    return problems;
  }
  const entry = findStaticSchema(workspace, ref);
  if (!entry?.compiled) {
    problems.push(severe(entry ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound, where,
      `工作区中找不到静态数据定义 ${formatStaticSchemaRef(ref)} 的编译产物`));
    return problems;
  }
  try {
    problems.push(...validateDataset(entry.compiled, parsed.data, workspace.resources));
  } catch (error) {
    if (!(error instanceof CompiledSchemaError)) throw error;
    problems.push(severe(ProblemCodes.inputUnreadable, where, `编译产物无法使用：${error.message}`));
  }
  return problems;
}

/** 模板候选作为工作副本叠加在工作区上（同名的代替已保存的模板），逐个做静态检查；同一问题只报一次，归到问题所在的模板。 */
function checkTemplates(candidates: readonly CandidateDocument[], workspace: Workspace, revision: CandidateContext['revision']): Map<string, Problem[]> {
  const results = new Map(candidates.map((candidate) => [candidate.path, [] as Problem[]]));
  const usable: { path: string; name: string; document: unknown }[] = [];
  for (const candidate of candidates) {
    const where = { kind: 'input', source: candidate.path } as const;
    const schema = checkAgainstDslSchema('template', candidate.document);
    if (schema.messages.length > 0) {
      results.get(candidate.path)!.push(severe(ProblemCodes.templateInvalid, where, `不符合 ${schema.file}：${schema.messages.join('；')}`));
      continue;
    }
    const name = (candidate.document as Record<string, unknown>)['name'] as string;
    const saved = workspace.templates.some((entry) => entry.name === name);
    if (saved && revision && !revision.templates.includes(name)) {
      results.get(candidate.path)!.push(severe(ProblemCodes.templateInvalid, where,
        `模板辅助修改只能改出图请求主模板调用到的模板（${revision.templates.join('、')}）：${name} 不在其中`));
    } else if (saved && !revision) {
      results.get(candidate.path)!.push(severe(ProblemCodes.templateInvalid, where, `工作区已有模板 ${name}：模板辅助设计只新建模板，修改已保存的模板用模板辅助修改`));
    } else if (usable.some((other) => other.name === name)) {
      results.get(candidate.path)!.push(severe(ProblemCodes.templateInvalid, where, `候选模板的名称重复：${name}`));
    } else usable.push({ path: candidate.path, name, document: candidate.document });
  }
  const replaced = new Set(usable.map((item) => item.name));
  const overlay: Workspace = { ...workspace, templates: [
    ...workspace.templates.filter((entry) => !replaced.has(entry.name)), ...usable.map((item) => ({ name: item.name, document: item.document, source: item.path })),
  ] };
  const seen = new Set<string>();
  for (const item of usable) {
    const parsed = parseTemplate(item.name, item.document);
    const problems = [...parsed.problems];
    if (parsed.model) {
      const schema = findStaticSchema(overlay, parsed.model.base);
      if (!schema?.compiled) {
        problems.push(severe(schema ? ProblemCodes.compiledSchemaMissing : ProblemCodes.staticSchemaNotFound, { kind: 'input', source: `${item.path}#base` },
          `模板基准 ${formatStaticSchemaRef(parsed.model.base)} 不在工作区中`));
      } else problems.push(...prepareTemplates(overlay, parsed.model, schema.compiled).problems);
    }
    for (const problem of problems) {
      const key = JSON.stringify(problem);
      if (seen.has(key)) continue;
      seen.add(key);
      const owner = usable.find((other) => other.name === templateOf(problem))?.path ?? item.path;
      results.get(owner)!.push(problem);
    }
  }
  return results;
}

/** 问题所在的模板名：元素路径的第一段，或检查项、变量所属的模板。 */
function templateOf(problem: Problem): string | undefined {
  const location = problem.location;
  if (location.kind === 'element') return location.path.split('/')[0];
  if (location.kind === 'check' || location.kind === 'variable') return location.template;
  return undefined;
}

function datasetId(document: unknown): unknown {
  return isRecord(document) && isRecord(document['dataset']) ? document['dataset']['id'] : undefined;
}
