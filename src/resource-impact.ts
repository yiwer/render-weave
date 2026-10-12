/** 只检查调用方提供的本地工作区；引用位置使用 JSON Pointer。 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ProblemCodes, severe, type Problem } from './problems.js';
import type { RenderOptions } from './render.js';
import { parseResourceRef } from './resources.js';
import { findStaticSchema } from './schema/builtins.js';
import { parseTemplate } from './template/parse.js';
import type { TemplateModel } from './template/model.js';
import { DEFAULT_FALLBACK_FONTS } from './text/fonts.js';
import { describeError, isRecord } from './util.js';
import { loadWorkspaceDocuments } from './workspace.js';

export interface ResourceImpact {
  readonly kind: 'templateFixed' | 'stateStyle' | 'parameterDefault' | 'derivedValue' | 'callArgument' | 'datasetImage';
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
const pointer = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

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
    const documents = await loadWorkspaceDocuments(root);
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
      const document = template.document as Record<string, unknown>;
      const add = (value: unknown, path: string, kind: ResourceImpact['kind']) => {
        if (value === ref) references.push({ kind, document: template.name, source: template.source!, path });
      };
      if (Array.isArray(document.parameters)) document.parameters.forEach((parameter, i) => {
        if (isRecord(parameter) && parameter.type === 'image') add(parameter.default, `/parameters/${i}/default`, 'parameterDefault');
      });
      if (Array.isArray(document.derived)) document.derived.forEach((derived, i) => {
        if (!isRecord(derived) || derived.type !== 'image') return;
        if (Array.isArray(derived.branches)) derived.branches.forEach((branch, j) => {
          if (isRecord(branch) && isRecord(branch.then)) add(branch.then.value, `/derived/${i}/branches/${j}/then/value`, 'derivedValue');
        });
        if (isRecord(derived.otherwise)) add(derived.otherwise.value, `/derived/${i}/otherwise/value`, 'derivedValue');
      });
      const scanStyle = (style: Record<string, unknown>, type: unknown, target: unknown, path: string, state = false) => {
        const kind = state ? 'stateStyle' : 'templateFixed';
        if (type === 'image') add(style.source, `${path}/source`, kind);
        if (type === 'text' || type === 'barcode') add(style.font, `${path}/font`, kind);
        if (type === 'text' && Array.isArray(style.content)) style.content.forEach((fragment, i) => {
          if (isRecord(fragment)) add(fragment.font, `${path}/content/${i}/font`, kind);
        });
        if (type === 'call' || type === 'loop') {
          const called = typeof target === 'string' ? models.get(target) : undefined;
          if (!called) throw new Error(`模板 ${template.name}${path} 的被调模板无法检查`);
          if (isRecord(style.args)) for (const [key, argument] of Object.entries(style.args)) {
            if (called.parameters.some((parameter) => parameter.name === key && parameter.type === 'image') && isRecord(argument)) {
              add(argument.value, `${path}/args/${pointer(key)}/value`, state ? 'stateStyle' : 'callArgument');
            }
          }
        }
      };
      const scan = (node: unknown, path: string) => {
        if (!isRecord(node)) return;
        scanStyle(node, node.type, node.template, path);
        if (isRecord(node.states) && isRecord(node.states.cases)) for (const [key, style] of Object.entries(node.states.cases)) {
          if (isRecord(style)) scanStyle(style, node.type, node.template, `${path}/states/cases/${pointer(key)}`, true);
        }
        if (Array.isArray(node.children)) node.children.forEach((child, i) => scan(child, `${path}/children/${i}`));
      };
      scan(document.artboard, '/artboard');
    }
    // 编译产物中的 image 标记是权威；普通文本中的 res: 字样不是资源引用。
    for (const dataset of documents.datasets) {
      const compiled = findStaticSchema(documents, dataset.document.dataset.staticSchema)?.compiled;
      if (!compiled) throw new Error(`数据集 ${dataset.id} 缺少编译产物，无法完整检查图片字段`);
      const scan = (schema: Record<string, unknown>, value: unknown, path: string) => {
        if (schema.$ref !== undefined || schema.allOf !== undefined || schema.anyOf !== undefined || schema.oneOf !== undefined) throw new Error('影响检查需要 RenderWeave 内联编译产物，不接受外部引用或组合 Schema');
        if (schema['x-renderweave-type'] === 'image') {
          if (value === ref) references.push({ kind: 'datasetImage', document: dataset.id, source: dataset.source!, path });
        } else if (schema.type === 'array' && isRecord(schema.items) && Array.isArray(value)) {
          const items = schema.items;
          value.forEach((item, i) => scan(items, item, `${path}/${i}`));
        } else if (isRecord(schema.properties) && isRecord(value)) {
          for (const [key, property] of Object.entries(schema.properties)) if (isRecord(property)) scan(property, value[key], `${path}/${pointer(key)}`);
        }
      };
      scan(compiled, dataset.document.data, '/data');
    }
    const configuration: ResourceConfigurationImpact[] = [];
    for (const kind of ['fallbackFonts', 'svgFonts'] as const) renderOptions[kind].forEach((candidate, i) => {
      if (candidate === id) configuration.push({ kind, path: `/${kind}/${i}` });
    });
    const after = await resourceWorkspaceFingerprint(root, renderOptions);
    if (before !== after) return { problems: [severe(ProblemCodes.resourceReplacementStale, { kind: 'input', source: root }, '检查期间工作区已变化，请重新检查')] };
    return { problems, impact: { workspaceDirectory: root, workspaceFingerprint: before, renderOptions, references, configuration,
      scope: '仅覆盖指定工作区的直接引用及所提供的字体配置；包含隐藏元素与所有状态分支，不覆盖其他工作区或调用时临时参数。' } };
  } catch (error) {
    return { problems: [severe(ProblemCodes.inputUnreadable, { kind: 'input', source: dir }, `资源影响检查失败：${describeError(error)}`)] };
  }
}
