/** 只检查调用方提供的本地工作区；引用位置使用 JSON Pointer。 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import type { RenderOptions } from './render.js';
import { datasetResourceReferences, templateResourceReferences, type ResourceReferenceKind } from './resource-references.js';
import { parseResourceRef } from './resources.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseTemplate } from './template/parse.js';
import type { TemplateModel } from './template/model.js';
import { DEFAULT_FALLBACK_FONTS } from './text/fonts.js';
import { describeError, isRecord } from './util.js';
import { loadWorkspaceDocuments, type Workspace } from './workspace.js';

export interface ResourceImpact {
  readonly kind: ResourceReferenceKind;
  readonly document: string;
  readonly source: string;
  readonly path: string;
}
export interface ResourceConfigurationImpact {
  readonly kind: 'fallbackFonts' | 'svgFonts';
  readonly path: string;
}
export interface ResourceWorkspaceImpact {
  readonly workspaceDirectory: string;
  readonly workspaceFingerprint: string;
  readonly renderOptions: { readonly fallbackFonts: readonly string[]; readonly svgFonts: readonly string[] };
  readonly references: readonly ResourceImpact[];
  readonly configuration: readonly ResourceConfigurationImpact[];
  readonly scope: string;
}

/** 覆盖顶层全部 JSON 文件名与原始字节，并纳入实际字体配置。 */
export async function resourceWorkspaceFingerprint(dir: string, options: RenderOptions = {}): Promise<string> {
  const digest = createHash('sha256');
  digest.update(JSON.stringify(normalizeOptions(options)));
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    const path = join(dir, file);
    if (!(await lstat(path)).isFile()) throw new Error(`工作区 JSON 必须是普通文件：${path}`);
    const bytes = await readFile(path);
    digest.update(JSON.stringify([file, bytes.length]));
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function normalizeOptions(options: RenderOptions): ResourceWorkspaceImpact['renderOptions'] {
  if (!isRecord(options) || Object.keys(options).some((key) => key !== 'fallbackFonts' && key !== 'svgFonts')) throw new Error('仅支持 fallbackFonts 与 svgFonts 配置');
  const read = (key: 'fallbackFonts' | 'svgFonts') => {
    const value = options[key] === undefined ? DEFAULT_FALLBACK_FONTS : options[key];
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || parseResourceRef(`res:${id}`) !== id)) throw new Error(`${key} 必须是资源 ID 列表`);
    return [...value];
  };
  return { fallbackFonts: read('fallbackFonts'), svgFonts: read('svgFonts') };
}

export async function inspectResourceWorkspace(dir: string, id: string, options: RenderOptions = {}): Promise<{ impact?: ResourceWorkspaceImpact; problems: Problem[] }> {
  try {
    const root = await realpath(dir);
    const renderOptions = normalizeOptions(options);
    const before = await resourceWorkspaceFingerprint(root, renderOptions);
    const { impact, problems } = resourceImpact(await loadWorkspaceDocuments(root), id, renderOptions);
    if (!impact) return { problems };
    const after = await resourceWorkspaceFingerprint(root, renderOptions);
    if (before !== after) return { problems: [severe(ProblemCodes.resourceReplacementStale, { kind: 'input', source: root }, '检查期间工作区已变化，请重新检查')] };
    return { problems, impact: { workspaceDirectory: root, workspaceFingerprint: before, ...impact,
      scope: '仅覆盖指定工作区的直接引用及所提供的字体配置；包含隐藏元素与所有状态分支，不覆盖其他工作区或调用时临时参数。' } };
  } catch (error) {
    return { problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: dir }, `资源影响检查失败：${describeError(error)}`)] };
  }
}

/**
 * 替换资源的影响（M152）：一份已读出的工作区里直接引用该资源的模板与数据集位置（JSON Pointer），以及字体配置里的位置。
 * 不读文件，本地检查与出图服务共用；工作区本身有严重问题时只有问题。字体配置不合规、或数据集缺少编译产物时抛错。
 */
export function resourceImpact(documents: Omit<Workspace, 'resources'>, id: string, options: RenderOptions = {}):
  { impact?: Pick<ResourceWorkspaceImpact, 'renderOptions' | 'references' | 'configuration'>; problems: Problem[] } {
  const renderOptions = normalizeOptions(options);
  const problems = [...documents.problems];
  const models = new Map<string, TemplateModel>();
  for (const template of documents.templates) {
    const parsed = parseTemplate(template.name, template.document);
    problems.push(...parsed.problems);
    if (parsed.model) models.set(template.name, parsed.model);
  }
  if (problems.some((issue) => issue.level === 'severe')) return { problems };
  const references: ResourceImpact[] = [];
  const ref = `res:${id}`;
  for (const template of documents.templates) {
    for (const { value, kind, path } of templateResourceReferences(template.name, template.document as Record<string, unknown>, (name) => models.get(name))) {
      if (value === ref) references.push({ kind, document: template.name, source: template.source!, path });
    }
  }
  for (const dataset of documents.datasets) {
    const compiled = findStaticSchema(documents, dataset.document.dataset.staticSchema)?.compiled;
    if (!compiled) throw new Error(`数据集 ${dataset.id} 缺少编译产物，无法完整检查图片字段`);
    for (const { value, kind, path } of datasetResourceReferences(compiled, dataset.document.data)) {
      if (value === ref) references.push({ kind, document: dataset.id, source: dataset.source!, path });
    }
  }
  const configuration: ResourceConfigurationImpact[] = [];
  for (const kind of ['fallbackFonts', 'svgFonts'] as const) renderOptions[kind].forEach((candidate, i) => {
    if (candidate === id) configuration.push({ kind, path: `/${kind}/${i}` });
  });
  return { problems, impact: { renderOptions, references, configuration } };
}
