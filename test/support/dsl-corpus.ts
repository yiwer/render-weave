import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { dslDocumentKind, type DslDocumentKind } from '../../src/index.js';
import { repoRoot } from './fixtures.js';

/** DSL 一致性测试的语料：仓库内的 .json 文件与 Markdown 中的 json 代码块（示例写错了同样要被发现）。 */
export interface CorpusDocument {
  readonly source: string;
  readonly kind: DslDocumentKind;
  readonly document: Record<string, unknown>;
}

const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'build', 'test-output', 'outside_context', '.git', '.claude', '.scratch', 'fonts']);

export async function loadCorpus(): Promise<CorpusDocument[]> {
  const found: CorpusDocument[] = [];
  const add = (source: string, text: string) => {
    const document = tryParse(text);
    const kind = document && dslDocumentKind(document);
    if (document && kind) found.push({ source, kind, document });
  };
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name));
        continue;
      }
      const file = join(dir, entry.name);
      const source = relative(repoRoot, file);
      if (entry.name.endsWith('.json')) add(source, await readFile(file, 'utf8'));
      else if (entry.name.endsWith('.md')) {
        const text = await readFile(file, 'utf8');
        [...text.matchAll(/```json\n([\s\S]*?)```/g)].forEach((match, index) => add(`${source}#json${index + 1}`, match[1]!));
      }
    }
  }
  await walk(repoRoot);
  return found;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export const SCHEMA_FILES: Record<DslDocumentKind, string> = {
  definition: 'data-definition.schema.json',
  dataset: 'dataset.schema.json',
  template: 'template.schema.json',
  renderRequest: 'render-request.schema.json',
  batchRequest: 'batch-request.schema.json',
};

export async function readSchema(kind: DslDocumentKind): Promise<Record<string, any>> {
  return JSON.parse(await readFile(join(repoRoot, 'schemas', SCHEMA_FILES[kind]), 'utf8'));
}

/** 编译 schemas/ 中的五份 JSON Schema。 */
export async function loadSchemas(): Promise<Record<DslDocumentKind, ValidateFunction>> {
  // 严格模式能发现 Schema 中拼错的关键字；strictRequired 与 strictTypes 是 ajv 自己的额外要求，标准写法下的条件分支会触发，故关闭。
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  const entries = await Promise.all(
    (Object.keys(SCHEMA_FILES) as DslDocumentKind[]).map(async (kind) => [kind, ajv.compile(await readSchema(kind))] as const),
  );
  return Object.fromEntries(entries) as Record<DslDocumentKind, ValidateFunction>;
}
