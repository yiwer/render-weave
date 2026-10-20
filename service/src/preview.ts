/**
 * 草稿预览的渲染（票据 06）：从租户的存储读出工作区与资源，交给引擎的 render。
 * 进程内 worker 与渲染子进程都调这一处；接口进程用同一份工作区做入队前的检查。
 */
import type { TaskResult, TenantStorage } from './backend.js';
import { createMemoryResourceRepository, readWorkspaceDocuments, render, type Workspace } from './engine.js';

/** 租户的工作区：全部文档（模板为当前修订），资源固定在当前内容版本。 */
export async function loadTenantWorkspace(storage: TenantStorage): Promise<Workspace> {
  const documents = await readWorkspaceDocuments(storage.documents);
  const opened = await storage.resources.open();
  const pinned = opened.store?.pin();
  return {
    ...documents,
    resources: pinned?.repository ?? createMemoryResourceRepository([]),
    problems: [...documents.problems, ...opened.problems, ...(pinned?.problems ?? [])],
  };
}

/** 渲染一次草稿预览；请求已由接口进程检查过，mode 已是 draft。 */
export async function renderPreview(storage: TenantStorage, request: unknown): Promise<TaskResult> {
  const result = await render(await loadTenantWorkspace(storage), request);
  const image = result.image;
  return {
    problems: result.problems,
    ...(result.layout ? { layout: result.layout } : {}),
    ...(image ? { image: { format: image.format, widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi, bytes: image.bytes } } : {}),
  };
}
