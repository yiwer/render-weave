/**
 * 草稿预览的渲染（票据 06）：从租户的存储读出工作区与资源，交给引擎的 render。
 * 进程内 worker 与渲染子进程都调这一处；接口进程用同一份工作区做入队前的检查。
 */
import type { TaskResult, TenantStorage } from './backend.js';
import { createMemoryResourceRepository, parseJsonKeepingPrecision, readWorkspaceDocuments, render, type VersionedResourceStore, type Workspace } from './engine.js';

/**
 * 打开租户的工作区：全部文档（模板为当前修订）与资源仓库的当前快照。
 * workspace 把资源固定在当前内容版本，供渲染与入队前的检查；批量交付另用 documents 与 store 固定批次（票据 07）。
 */
export async function openTenantWorkspace(storage: TenantStorage): Promise<{
  readonly documents: Omit<Workspace, 'resources'>; readonly store?: VersionedResourceStore; readonly workspace: Workspace;
}> {
  const documents = await readWorkspaceDocuments(storage.documents);
  const opened = await storage.resources.open();
  const pinned = opened.store?.pin();
  return {
    documents,
    ...(opened.store ? { store: opened.store } : {}),
    workspace: {
      ...documents,
      resources: pinned?.repository ?? createMemoryResourceRepository([]),
      problems: [...documents.problems, ...opened.problems, ...(pinned?.problems ?? [])],
    },
  };
}

/** 租户的工作区：全部文档（模板为当前修订），资源固定在当前内容版本。 */
export async function loadTenantWorkspace(storage: TenantStorage): Promise<Workspace> {
  return (await openTenantWorkspace(storage)).workspace;
}

/**
 * 工作区换上模板工作副本（P1 票据 07）：有工作副本的模板用工作副本，复制出来还没保存的模板也在。
 * 全部工作副本一起换上，改子模板时看父模板的预览也是改过的；出图与只读预览不走这里，照旧读当前修订。
 */
export async function withWorkingCopies(storage: TenantStorage, workspace: Workspace): Promise<Workspace> {
  const copies = await Promise.all((await storage.templateWorkingCopies()).map(async (copy) => ({
    name: copy.name, source: `workingCopy:${copy.name}`, document: parseJsonKeepingPrecision(Buffer.from((await storage.contents.get(copy.sha256)) ?? []).toString('utf8'), []),
  })));
  const names = new Set(copies.map((copy) => copy.name));
  return { ...workspace, templates: [...workspace.templates.filter((template) => !names.has(template.name)), ...copies] };
}

/** 渲染一次草稿预览；请求已由接口进程检查过，mode 已是 draft。任务里的 workingCopies 表示用工作副本预览。 */
export async function renderPreview(storage: TenantStorage, task: unknown): Promise<TaskResult> {
  const { workingCopies, ...request } = task as { workingCopies?: boolean };
  const workspace = await loadTenantWorkspace(storage);
  const result = await render(workingCopies ? await withWorkingCopies(storage, workspace) : workspace, request, { elementLocations: true });
  const image = result.image;
  return {
    problems: result.problems,
    ...(result.layout ? { layout: result.layout } : {}),
    ...(result.elements ? { elements: result.elements } : {}),
    ...(image ? { image: { format: image.format, widthPx: image.widthPx, heightPx: image.heightPx, dpi: image.dpi, bytes: image.bytes } } : {}),
  };
}
