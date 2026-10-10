import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryResourceRepository, loadWorkspace, type ResourceRepository, type Workspace } from '../../src/index.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const resourcesDir = join(repoRoot, 'fixtures', 'resources');
export const singleTextDir = join(repoRoot, 'fixtures', 'workspaces', 'single-text');
export const stopNameDir = join(repoRoot, 'fixtures', 'workspaces', 'stop-name');
export const skeletonDir = join(repoRoot, 'fixtures', 'workspaces', 'm402-skeleton');
export const m402Dir = join(repoRoot, 'docs', 'examples', 'm402-dsl');

export function loadSingleText(): Promise<Workspace> {
  return loadWorkspace({ dir: singleTextDir, resourcesDir });
}

export function loadStopName(): Promise<Workspace> {
  return loadWorkspace({ dir: stopNameDir, resourcesDir });
}

/** M402 站名区尺寸（35 站时列宽约 20 mm，有地标时站名高 73 mm）的竖排站名请求，站名直接附带。 */
export function stopNameRequest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: '竖排站名',
    dataset: { inline: { dataset: { staticSchema: { name: '站名样例', version: 1 } }, data: { name } } },
    parameters: {},
    output: { width: 20, height: 73, dpi: 120, format: 'png' },
    mode: 'final',
    ...overrides,
  };
}

export function greetingRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: '问候牌',
    dataset: { id: 'ds-greeting' },
    parameters: {},
    output: { width: 160, height: 40, dpi: 120, format: 'png' },
    mode: 'final',
    ...overrides,
  };
}

/** 复制工作区并修改其中一个模板文档。 */
export function withTemplate(workspace: Workspace, name: string, mutate: (document: Record<string, any>) => void): Workspace {
  return {
    ...workspace,
    templates: workspace.templates.map((entry) => {
      if (entry.name !== name) return entry;
      const document = structuredClone(entry.document) as Record<string, any>;
      mutate(document);
      return { ...entry, document };
    }),
  };
}

export function loadSkeleton(): Promise<Workspace> {
  return loadWorkspace({ dir: skeletonDir, resourcesDir });
}

export function skeletonRequest(width: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    template: 'M402 版式骨架',
    dataset: { id: 'ds-m402-skeleton' },
    parameters: {},
    output: { width, height: 165, dpi: 120, format: 'png' },
    mode: 'final',
    ...overrides,
  };
}

/** 在骨架工作区里加一个只含画板的实验模板（基准为不含字段的"M402 骨架"）。 */
export function withLabTemplate(workspace: Workspace, artboard: Record<string, unknown>): Workspace {
  const document = {
    dslVersion: 'renderweave-template/1',
    name: '布局实验',
    base: { name: 'M402 骨架', version: 1 },
    artboard: { sizeRange: { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } }, ...artboard },
  };
  return {
    ...workspace,
    templates: [...workspace.templates.filter((entry) => entry.name !== '布局实验'), { name: '布局实验', document }],
  };
}

export function labRequest(width: number, height: number, dpi = 120): Record<string, unknown> {
  return {
    template: '布局实验',
    dataset: { id: 'ds-m402-skeleton' },
    parameters: {},
    output: { width, height, dpi, format: 'png' },
    mode: 'final',
  };
}

/** M402 数据集引用的图片资源 ID；数据集校验只看资源是否存在、是不是图片，不读内容（图片夹具见票据 05）。 */
export const M402_IMAGE_IDS = ['route-no-m402', 'landmark-1', 'landmark-2', 'landmark-3', 'landmark-4', 'icon-metro', 'icon-hospital'];

export function imageOnlyResources(ids: readonly string[], fonts: readonly string[] = []): ResourceRepository {
  return createMemoryResourceRepository([
    ...ids.map((id) => ({ id, kind: 'image' as const, bytes: new Uint8Array() })),
    ...fonts.map((id) => ({ id, kind: 'font' as const, bytes: new Uint8Array() })),
  ]);
}

/** 在工作区里加一个指定基准、画板为空的模板，用于只看数据集校验的结果。 */
export function withEmptyTemplate(workspace: Workspace, name: string, base: { name: string; version: number }): Workspace {
  const document = {
    dslVersion: 'renderweave-template/1',
    name,
    base,
    artboard: { sizeRange: { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } } },
  };
  return { ...workspace, templates: [...workspace.templates.filter((entry) => entry.name !== name), { name, document }] };
}
