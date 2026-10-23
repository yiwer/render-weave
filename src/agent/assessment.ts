/** 成果的技术评估不代替内容与样式审核；草稿能画出来也不代表能正式交付。 */
import type { Problem } from '../problems.js';
import { render } from '../render.js';
import type { LayoutSummary } from '../layout/index.js';
import { isRecord } from '../util.js';
import type { Workspace } from '../workspace.js';
import type { CandidateDocument } from './candidates.js';

export interface RenderAssessment {
  readonly status: 'notChecked' | 'renderable' | 'blocked';
  readonly problems: readonly Problem[];
  readonly hasImage: boolean;
  /** 已知引擎能力边界，修改模板无法修复；仍保留 severe 并阻止正式交付。 */
  readonly capabilityBlocked: boolean;
  readonly blocking: boolean;
  readonly layout?: LayoutSummary;
}

export function assessRendering(problems: readonly Problem[], hasImage: boolean, blocking: boolean, layout?: LayoutSummary): RenderAssessment {
  const severe = problems.filter((problem) => problem.level === 'severe');
  return { status: severe.length > 0 || !hasImage ? 'blocked' : 'renderable', problems, hasImage, blocking,
    capabilityBlocked: severe.some((problem) => problem.code === 'text.unshapedScript'), ...(layout ? { layout } : {}) };
}

/** 与审核预览一样覆盖候选模板；数据集提取的预览只作参考，不否定数据候选。 */
export async function assessCandidates(workspace: Workspace, candidates: readonly CandidateDocument[],
  request: Record<string, unknown> | undefined, blocking: boolean): Promise<RenderAssessment> {
  if (!request || !isRecord(request['output'])) return { status: 'notChecked', problems: [], hasImage: false, capabilityBlocked: false, blocking };
  const templates = candidates.filter((candidate) => candidate.kind === 'template' && isRecord(candidate.document) && typeof candidate.document['name'] === 'string')
    .map((candidate) => ({ name: (candidate.document as { name: string }).name, document: candidate.document, source: candidate.path }));
  const names = new Set(templates.map((entry) => entry.name));
  const dataset = candidates.find((candidate) => candidate.kind === 'dataset');
  const result = await render({ ...workspace, templates: [...workspace.templates.filter((entry) => !names.has(entry.name)), ...templates] },
    { ...request, ...(dataset ? { dataset: { inline: dataset.document } } : {}), mode: 'draft' });
  return assessRendering(result.problems, !!result.image, blocking, result.layout);
}
