import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkspace, type Workspace } from '../../src/index.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const resourcesDir = join(repoRoot, 'fixtures', 'resources');
export const singleTextDir = join(repoRoot, 'fixtures', 'workspaces', 'single-text');
export const m402Dir = join(repoRoot, 'docs', 'examples', 'm402-dsl');

export function loadSingleText(): Promise<Workspace> {
  return loadWorkspace({ dir: singleTextDir, resourcesDir });
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
