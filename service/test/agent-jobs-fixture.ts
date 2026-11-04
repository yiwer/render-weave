/** 合成工作簿的确定性执行接缝；读取、来源核查、审核与保存仍走正式代码。 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishStaticSchema, importExcelRound } from '../src/engine.js';
import { contentHash } from '../src/agent-files.js';
import type { WorkbookExtractor } from '../src/agent-worker.js';

export const note = ' 制作\n甲 & <script>test</script> ';
export const commentSchema = () => publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: 'comment-test', displayName: '物料卡', fields: [
  { name: 'label', displayName: '名称', type: 'text', constraints: { required: true } }, { name: 'note', displayName: '批注', type: 'text' }, { name: 'emptyNote', displayName: '空批注', type: 'text' },
] }, []).published!;
export async function commentWorkbook(root: string) {
  const file = join(root, 'source.xlsx');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', fileURLToPath(new URL('../../test/support/excel-comments.py', import.meta.url)), file, 'good'], { windowsHide: true });
  return readFile(file);
}
export const fixtureExtractor: WorkbookExtractor = async ({ job, storage, root, progress }) => {
  const workspace = join(root, 'workspace'), from = join(root, 'from'), round = join(root, 'round'), schema = commentSchema();
  for (const p of [workspace, join(from, 'inputs'), join(from, 'attempt-01')]) await mkdir(p, { recursive: true });
  const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
  const bytes = await storage.contents.get(job.source.sha256); if (!bytes) throw new Error('Missing fixture');
  await writeFile(join(from, 'inputs/source.xlsx'), bytes);
  await save(join(workspace, 'schema.json'), schema.definition); await save(join(workspace, 'compiled.schema.json'), schema.compiled);
  await save(join(from, 'inputs/target.json'), { selected: schema, staticSchemas: [schema], datasetIds: [] });
  await writeFile(join(from, 'inputs/brief.md'), job.brief);
  await save(join(from, 'start.json'), { model: 'deterministic-fixture', endpoint: 'test' });
  await save(join(from, 'result.json'), { passed: true, attempts: [], usage: {} });
  await save(join(from, 'submission.json'), { attemptId: 'attempt-01', notes: '两份物料卡，核对正文和全部批注。', pending: [] });
  const ids = [`${job.id}-1`, `${job.id}-2`];
  const plan = { format: 'rw-excel-plan/2', sourceHash: contentHash(bytes), definition: schema.ref,
    datasets: ids.map(id => ({ id, value: { op: 'object', fields: { label: { op: 'cell', sheet: 'sheet-1', cell: 'A1' }, note: { op: 'comment', sheet: 'sheet-1', cell: 'B2' }, emptyNote: { op: 'comment', sheet: 'sheet-1', cell: 'C3' } } } })), context: [], commentContext: [] };
  const candidate = { datasets: ids.map(id => ({ dataset: { id, staticSchema: schema.ref }, data: { label: '甲', note, emptyNote: '' } })), sources: ids.flatMap(datasetId => [
    { datasetId, path: '/label', sheet: 'sheet-1', cells: ['A1'], rule: 'cell' },
    ...[['/note', 'B2'], ['/emptyNote', 'C3']].map(([path, cell]) => ({ datasetId, path, sheet: 'sheet-1', cells: [cell], rule: 'comment', parts: ['xl/comments1.xml'] })),
  ]) };
  await save(join(from, 'attempt-01/plan.json'), plan); await save(join(from, 'attempt-01/candidate.json'), candidate);
  await writeFile(join(from, 'attempt-01/transform.py'), 'raise RuntimeError("The import verifier must not execute scripts")');
  progress('确定性模型夹具已交回，正在执行真实来源核查');
  await importExcelRound({ from, workspace, out: round, python: process.platform === 'win32' ? 'python' : 'python3' });
  return { round };
};
