/** Excel 宿主证据与人工修正重放；不执行 Agent 的脚本。 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from './diff.js';
import { sha256 } from './round-files.js';

export interface ExcelSource { datasetId: string; path: string; sheet: string; cells: string[]; rule: string; parts?: string[]; mapping?: { separators: string[]; values: Record<string, unknown> } }
export interface ExcelComment {
  sheet: string; cell: string; text: string; author: string; part: string;
  vml?: { part: string; shapeId: string; row: number; column: number; anchor: number[]; visible: boolean };
}
export interface ExcelCorrection { datasetId: string; path: string; before?: unknown; after?: unknown; removed: boolean; reason: string; actor: 'local-review'; status: 'replayed' | 'conflict'; detail?: string }
export interface ExcelEvidence {
  format: 'renderweave-excel-evidence/1'; sourceHash: string; definition: { name: string; version: number };
  artifacts: { file: string; sha256: string }[]; sources: ExcelSource[];
  context: { sheet: string; range: string; reason: string }[];
  comments?: ExcelComment[];
  commentContext?: { sheet: string; cell: string; reason: string }[];
  sheets: { id: string; name: string }[]; corrections: ExcelCorrection[];
  candidates: { file: string; id: string }[];
}
export async function readExcelEvidence(root: string, ref: { file: string; sha256: string }): Promise<ExcelEvidence> {
  if (ref.file !== 'excel/manifest.json') throw new Error('工作簿证据路径非法');
  const bytes = await readFile(join(root, ref.file));
  if (sha256(bytes) !== ref.sha256) throw new Error('工作簿证据清单已改变');
  const value = JSON.parse(bytes.toString('utf8')) as ExcelEvidence;
  if (value.format !== 'renderweave-excel-evidence/1' || !Array.isArray(value.artifacts) || !Array.isArray(value.sources) || !Array.isArray(value.candidates)) throw new Error('工作簿证据结构非法');
  for (const artifact of value.artifacts) {
    if (!/^excel\/[a-z-]+\.(json|xlsx|py|md)$/.test(artifact.file) || artifact.file === ref.file) throw new Error('工作簿证据文件路径非法');
    if (sha256(await readFile(join(root, artifact.file))) !== artifact.sha256) throw new Error(`工作簿来源已改变：${artifact.file}`);
  }
  return value;
}

const pointer = (path: string) => path === '' ? [] : path.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'));
const escape = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');
function get(root: any, path: string): unknown { return pointer(path).reduce((v, key) => v?.[key], root); }
function set(root: any, path: string, value: unknown, removed: boolean) {
  const keys = pointer(path), last = keys.pop()!;
  const parent = keys.reduce((v, key) => v[key], root);
  if (removed) { if (Array.isArray(parent)) parent.splice(Number(last), 1); else delete parent[last]; }
  else Object.defineProperty(parent, last, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
}
function differences(before: any, after: any, path = ''): string[] {
  if (canonical(before) === canonical(after)) return [];
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)
      && (!Array.isArray(before) || before.length === after.length)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap(k => differences(before[k], after[k], path+'/'+escape(k)));
  }
  return [path];
}

/** 单元格来源相同但数组位置移动时按来源定位；原件、定义或原值变化即冲突。 */
export function replayExcelCorrections(options: {
  previous: ExcelEvidence; next: ExcelEvidence; before: any[]; reviewed: { id: string; data: unknown; reason?: string }[]; candidates: any[];
}): ExcelCorrection[] {
  const { previous, next, before, reviewed, candidates } = options;
  const corrections: ExcelCorrection[] = [];
  for (const old of before) {
    const id = old.dataset.id;
    const review = reviewed.find(r => r.id === id);
    if (!review) continue;
    for (const path of differences(old.data, review.data)) {
      const original = get(old.data, path), after = get(review.data, path);
      // collect/split 的列表项共享一个来源，匹配时保留相对列表位置。
      const anchor = previous.sources.filter(s => s.datasetId === id && (s.path === path || path.startsWith(s.path+'/'))).sort((a,b) => b.path.length-a.path.length)[0];
      const matches = anchor ? next.sources.filter(s => s.datasetId === id && s.sheet === anchor.sheet && s.rule === anchor.rule && canonical(s.cells) === canonical(anchor.cells) && canonical(s.parts ?? []) === canonical(anchor.parts ?? []) && canonical(s.mapping ?? null) === canonical(anchor.mapping ?? null)) : [];
      const target = candidates.find(c => c.dataset.id === id);
      const newPath = matches.length === 1 ? matches[0]!.path+path.slice(anchor!.path.length) : path;
      const sameBasis = previous.sourceHash === next.sourceHash && canonical(previous.definition) === canonical(next.definition);
      const compatible = sameBasis && !!target && !!anchor && matches.length === 1 && canonical(get(target.data, newPath)) === canonical(original);
      const correction: ExcelCorrection = { datasetId: id, path: newPath, before: original, after, removed: after === undefined,
        reason: review.reason ?? previous.corrections.find(c => c.datasetId === id && c.path === path)?.reason ?? '沿用上一轮已记录的人工修正', actor: 'local-review', status: compatible ? 'replayed' : 'conflict',
        ...(!compatible ? { detail: '原件、定义、唯一来源、显示映射规则或原候选值不匹配；未自动套用，请明确处理。' } : {}) };
      if (compatible) set(target.data, newPath, after, after === undefined);
      corrections.push(correction);
    }
  }
  return corrections;
}
