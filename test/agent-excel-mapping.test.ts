/** 从真实工作簿经正式导入核对显式显示映射；不执行候选脚本。 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { importExcelRound, readReview, changeReview, publishStaticSchema } from '../src/index.js';
let root: string, sequence = 0;
const save = (p: string, value: unknown) => writeFile(p, JSON.stringify(value));
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'rw-mapping-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const dir = join(root, String(++sequence)), from = join(dir, 'from'), workspace = join(dir, 'workspace'), out = join(dir, 'review');
  for (const p of [join(from, 'inputs'), join(from, 'attempt-01'), workspace]) await mkdir(p, { recursive: true });
  const source = join(from, 'inputs/source.xlsx');
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-X', 'utf8', 'test/support/excel-comments.py', source, 'mapping'], { windowsHide: true });
  const entry = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: 'handling-tag', fields: [{ name: 'category', displayName: '类别', type: 'text', constraints: { required: true } }] }, []).published!;
  const selected = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: 'handling', fields: [
    { name: 'raw', displayName: '原文', type: 'text' }, { name: 'tags', displayName: '标记', type: 'list', items: { type: 'ref', ref: entry.ref } },
    { name: 'empty', displayName: '空标记', type: 'list', items: { type: 'ref', ref: entry.ref } }
  ] }, [entry]).published!;
  for (const s of [entry, selected]) { await save(join(workspace, `${s.ref.name}.json`), s.definition); await save(join(workspace, `${s.ref.name}.schema.json`), s.compiled); }
  const mapping = { separators: ['、'], values: { 冷藏: { category: 'chilled' }, 易碎: { category: 'fragile' } } };
  const split = (cell: string) => ({ op: 'split', sheet: 'sheet-1', cell, ...mapping });
  const plan: any = { format: 'rw-excel-plan/2', sourceHash: createHash('sha256').update(await readFile(source)).digest('hex'), definition: selected.ref,
    datasets: [{ id: 'item', value: { op: 'object', fields: { raw: { op: 'cell', sheet: 'sheet-1', cell: 'A1' }, tags: split('A1'), empty: split('A2') } } }],
    commentContext: ['B2', 'C3'].map(cell => ({ sheet: 'sheet-1', cell, reason: '合成夹具批注不在本次定义内，明确待审' })) };
  const candidate: any = { datasets: [{ dataset: { id: 'item', staticSchema: selected.ref }, data: { raw: ' 冷藏、易碎、冷藏 ', tags: [{ category: 'chilled' }, { category: 'fragile' }, { category: 'chilled' }], empty: [] } }],
    sources: [{ datasetId: 'item', path: '/raw', sheet: 'sheet-1', cells: ['A1'], rule: 'cell' },
      ...[['/tags', ['A1']], ['/empty', []]].map(([path, cells]) => ({ datasetId: 'item', path, sheet: 'sheet-1', cells, rule: 'split', mapping: structuredClone(mapping) }))] };
  await save(join(from, 'inputs/target.json'), { selected, staticSchemas: [entry, selected] });
  await writeFile(join(from, 'inputs/brief.md'), '按显式对照解释显示类别，保留原文。');
  await save(join(from, 'start.json'), { model: 'test' }); await save(join(from, 'result.json'), { passed: true });
  await save(join(from, 'submission.json'), { attemptId: 'attempt-01', notes: '测试', pending: ['显示解释需要审核'] });
  await writeFile(join(from, 'attempt-01/transform.py'), 'raise RuntimeError("must not execute")');
  const flush = async () => { await save(join(from, 'attempt-01/plan.json'), plan); await save(join(from, 'attempt-01/candidate.json'), candidate); };
  await flush(); return { dir, from, workspace, out, plan, candidate, flush };
}
it('显示映射保留原文、顺序与重复项，空白输出空列表，审核保留完整对照和 VML', async () => {
  const f = await fixture(); await importExcelRound(f); const view = (await readReview(f.out)).view!;
  expect(view.candidates[0]!.document).toEqual(f.candidate.datasets[0]);
  expect(view.excel!.sources).toEqual(f.candidate.sources);
  expect(view.excel!.comments![0]!.vml).toMatchObject({ row: 1, column: 1 });
  expect(view.canApprove).toBe(false);
});
it.each(['unknown', 'forged-value', 'forged-rule', 'invalid-table', 'too-deep'])('拒绝 %s，不能把未经核对的显示解释送入审核', async kind => {
  const f = await fixture(), node = f.plan.datasets[0].value.fields.tags;
  if (kind === 'unknown') delete node.values.易碎;
  if (kind === 'forged-value') f.candidate.datasets[0].data.tags[0].category = 'invented';
  if (kind === 'forged-rule') f.candidate.sources[1].mapping.values.冷藏.category = 'invented';
  if (kind === 'invalid-table') node.values = {};
  if (kind === 'too-deep') { let deep: any = 'x'; for (let i = 0; i < 10; i++) deep = { x: deep }; node.values.冷藏 = deep; }
  await f.flush(); await expect(importExcelRound(f)).rejects.toThrow('独立工作簿检查失败');
  expect((await readReview(f.out)).view).toBeUndefined();
});
it('同规则重放人工修改；对照规则改变时保留冲突，即使原输出未变', async () => {
  const f = await fixture(); await importExcelRound(f);
  const value = structuredClone(f.candidate.datasets[0]); value.data.tags[0].category = 'reviewed';
  expect((await changeReview(f.out, { type: 'decide', item: 1, action: 'edit', value, note: '人工修正测试' })).problems).toEqual([]);
  const same = await importExcelRound({ ...f, out: join(f.dir, 'same'), previous: f.out });
  expect(same.corrections).toMatchObject([{ path: '/tags/0/category', status: 'replayed' }]);
  for (const field of ['tags', 'empty']) f.plan.datasets[0].value.fields[field].values.常温 = { category: 'ambient' };
  for (const s of f.candidate.sources.filter((s: any) => s.mapping)) s.mapping.values.常温 = { category: 'ambient' };
  await f.flush();
  const changed = await importExcelRound({ ...f, out: join(f.dir, 'changed'), previous: f.out });
  expect(changed.corrections).toMatchObject([{ path: '/tags/0/category', status: 'conflict' }]);
});
