/** Excel 入口的跨模块行为：真实读取原件、正式审核与既有提交路径。 */
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { importExcelRound, readReview, changeReview, applyAgentRound, startReviewServer, readWorkspaceDocuments, localWorkspaceDocuments } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { createHash } from 'node:crypto';
import { watch } from 'node:fs';
import { spawn } from 'node:child_process';

let root: string, n = 0;
const source = join(process.cwd(), 'scripts/prototypes/excel-agent/evidence-p04/live-01');
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'rw-excel-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const save = (p: string, d: unknown) => writeFile(p, JSON.stringify(d, null, 2));
async function setup(from = source, fixture = 'fixtures/workspaces/price-tag') {
  const dir = join(root, String(++n)); await mkdir(dir);
  const workspace = join(dir, 'workspace'); await cp(fixture, workspace, { recursive: true });
  const round = join(dir, 'round');
  await importExcelRound({ from, workspace, out: round });
  return { dir, workspace, round };
}
async function approve(round: string) {
  const review = await readReview(round); expect(review.problems).toEqual([]);
  for (const p of review.view!.pending) if (!p.decision) expect((await changeReview(round, { type: 'decide', item: p.item, action: 'adopt' })).problems).toEqual([]);
  expect((await changeReview(round, { type: 'confirmRest', confirmed: true })).problems).toEqual([]);
  expect((await changeReview(round, { type: 'approve' })).problems).toEqual([]);
}
it('正式 CLI 导入六份候选，页面提供固定 xlsx 与来源，尚不可应用', async () => {
  const dir = join(root, String(++n)); await mkdir(dir); const workspace = join(dir, 'workspace'); await cp('fixtures/workspaces/price-tag', workspace, { recursive: true });
  const round = join(dir, 'round'); let stdout = '', stderr = '';
  const exit = await runCli(['agent','import-excel','--from',source,'--workspace',workspace,'--out',round], { stdout: s=>stdout+=s, stderr: s=>stderr+=s });
  expect(exit, stderr).toBe(0); expect(JSON.parse(stdout).candidates).toBe(6);
  const review = await readReview(round); expect(review.problems).toEqual([]); expect(review.view!.excel!.sources.length).toBeGreaterThan(40);
  expect(review.view!.canApprove).toBe(false); expect((await applyAgentRound({ roundDir: round })).applied).toBeUndefined();
  const server = await startReviewServer({ roundDir: round });
  try {
    const response = await fetch(new URL('/sample', server.url)); expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(await readFile(join(source,'inputs/source.xlsx')));
    const html = await (await fetch(server.url)).text(); expect(html).toContain('Excel 来源与人工修正');
  } finally { await server.close(); }
});
it('人工改值须有原因、保持身份和完整集合，类型错误不能批准', async () => {
  const f = await setup(), original = (await readReview(f.round)).view!.candidates[0]!.document as any;
  const changed = structuredClone(original); changed.data.retailPrice = 'invalid';
  expect((await changeReview(f.round,{type:'decide',item:1,action:'edit',value:changed})).problems.length).toBeGreaterThan(0);
  expect((await changeReview(f.round,{type:'decide',item:1,action:'empty'})).problems.length).toBeGreaterThan(0);
  expect((await changeReview(f.round,{type:'decide',item:1,action:'edit',value:changed,note:'测试错误类型'})).view!.canApprove).toBe(false);
  changed.data.retailPrice = 2; changed.dataset.id = 'changed-id';
  const review = await changeReview(f.round,{type:'decide',item:1,action:'edit',value:changed,note:'测试身份变化'});
  expect(review.view!.problems.some(p=>p.message.includes('保持候选身份'))).toBe(true);
});
it('同源重跑重放人工修改、保留原因并重新审核，整批应用可幂等重试', async () => {
  const f = await setup(), edited = structuredClone((await readReview(f.round)).view!.candidates[0]!.document) as any;
  edited.data.retailPrice = 2.5;
  expect((await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited,note:'核准零售价'})).problems).toEqual([]);
  await approve(f.round);
  const next = join(f.dir,'next'); const imported = await importExcelRound({from:source,workspace:f.workspace,out:next,previous:f.round});
  expect(imported.corrections).toMatchObject([{path:'/retailPrice',before:2,after:2.5,status:'replayed',reason:'核准零售价'}]);
  const review = (await readReview(next)).view!; expect(review.review.status).toBe('inProgress'); expect(review.canApprove).toBe(false);
  expect((review.candidates[0]!.document as any).data.retailPrice).toBe(2.5);
  await approve(next); const applied = await applyAgentRound({roundDir:next}); expect(applied.problems).toEqual([]); expect(applied.applied!.published).toHaveLength(6);
  const again = await applyAgentRound({roundDir:next}); expect(again.reused).toBe(true); expect(again.applied!.commitId).toBe(applied.applied!.commitId);
  expect((await readWorkspaceDocuments(localWorkspaceDocuments(f.workspace))).datasets).toHaveLength(6);
  const other=join(f.dir,'other'); await cp(source,other,{recursive:true});
  const plan=await json(join(other,'attempt-02/plan.json')), bundle=await json(join(other,'attempt-02/candidate.json'));
  for(const d of plan.datasets) d.id='other-'+d.id;
  for(const d of bundle.datasets) d.dataset.id='other-'+d.dataset.id;
  for(const s of bundle.sources) s.datasetId='other-'+s.datasetId;
  await save(join(other,'attempt-02/plan.json'),plan); await save(join(other,'attempt-02/candidate.json'),bundle);
  const extra=join(f.dir,'extra'); await importExcelRound({from:other,workspace:f.workspace,out:extra}); await approve(extra);
  expect((await applyAgentRound({roundDir:extra})).problems).toEqual([]);
  expect((await readWorkspaceDocuments(localWorkspaceDocuments(f.workspace))).datasets).toHaveLength(12);
});
it('候选顺序变化仍按数据集身份重放，不按文件下标覆盖另一项', async () => {
  const f = await setup(), edited = structuredClone((await readReview(f.round)).view!.candidates[0]!.document) as any;
  edited.data.retailPrice = 2.5; await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited,note:'价格核准'});
  const from = join(f.dir,'reordered'); await cp(source,from,{recursive:true});
  const plan = await json(join(from,'attempt-02/plan.json')), candidate = await json(join(from,'attempt-02/candidate.json'));
  plan.datasets.reverse(); candidate.datasets.reverse(); await save(join(from,'attempt-02/plan.json'),plan); await save(join(from,'attempt-02/candidate.json'),candidate);
  const next = join(f.dir,'next'); await importExcelRound({from,workspace:f.workspace,out:next,previous:f.round});
  const candidates = (await readReview(next)).view!.candidates;
  expect((candidates.find(c=>c.name==='0012345')!.document as any).data.retailPrice).toBe(2.5);
  expect((candidates[0]!.document as any).data.retailPrice).toBe(7.98);
});
it('原件身份改变时留冲突并保留新原值，不自动复用旧批准', async () => {
  const f = await setup(), edited = structuredClone((await readReview(f.round)).view!.candidates[0]!.document) as any;
  edited.data.retailPrice = 2.5; await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited,note:'核准价格'});
  const from = join(f.dir,'changed'); await cp(source,from,{recursive:true});
  const file = join(from,'inputs/source.xlsx'); await appendFile(file,Buffer.from([0]));
  const plan = await json(join(from,'attempt-02/plan.json')); plan.sourceHash=createHash('sha256').update(await readFile(file)).digest('hex'); await save(join(from,'attempt-02/plan.json'),plan);
  const next = join(f.dir,'next'); const imported=await importExcelRound({from,workspace:f.workspace,out:next,previous:f.round});
  expect(imported.corrections[0]!.status).toBe('conflict'); const view=(await readReview(next)).view!;
  expect((view.candidates[0]!.document as any).data.retailPrice).toBe(2); expect(view.pending[0]!.reason).toBe('conflicting'); expect(view.canApprove).toBe(false);
  await expect(importExcelRound({from,workspace:f.workspace,out:join(f.dir,'third'),previous:next})).rejects.toThrow('未处理的人工修正冲突');
});
it('不相信通过标记，删掉第二份候选在独立检查时被拒绝', async () => {
  const dir = join(root,String(++n)); await mkdir(dir); const from=join(dir,'bad'); await cp(source,from,{recursive:true});
  const candidate=await json(join(from,'attempt-02/candidate.json')); candidate.datasets.splice(1,1); await save(join(from,'attempt-02/candidate.json'),candidate);
  await expect(importExcelRound({from,workspace:'fixtures/workspaces/price-tag',out:join(dir,'round')})).rejects.toThrow('独立工作簿检查失败');
  expect((await readReview(join(dir,'round'))).view).toBeUndefined();
});
it('导入只核对固定原件和映射，不运行提取包附带脚本', async () => {
  const dir=join(root,String(++n)); await mkdir(dir); const from=join(dir,'package'); await cp(source,from,{recursive:true});
  await writeFile(join(from,'attempt-02/transform.py'),'raise RuntimeError("must never execute during import")');
  const f=await setup(from); expect((await readReview(f.round)).problems).toEqual([]);
  expect(await readFile(join(f.round,'excel/brief.md'),'utf8')).toBe(await readFile(join(from,'inputs/brief.md'),'utf8'));
});
it('批准后篡改映射证据，审核与应用拒绝旧身份', async () => {
  const f=await setup(); await approve(f.round); await appendFile(join(f.round,'excel/plan.json'),' ');
  expect((await readReview(f.round)).view).toBeUndefined(); expect((await applyAgentRound({roundDir:f.round})).applied).toBeUndefined();
  expect((await readdir(f.workspace)).filter(n=>n.startsWith('dataset-'))).toHaveLength(0);
});
it('工作空间定义已改变时拒绝导入旧提取结果', async () => {
  const dir=join(root,String(++n)); await mkdir(dir); const workspace=join(dir,'workspace'); await cp('fixtures/workspaces/price-tag',workspace,{recursive:true});
  const file=join(workspace,'compiled-price-tag-v1.schema.json'), schema=await json(file); schema.properties.retailPrice.maximum=1; await save(file,schema);
  await expect(importExcelRound({from:source,workspace,out:join(dir,'round')})).rejects.toThrow('数据定义与提取时不同');
});
it('连续重放保留原修改原因，可选字段删除也按来源重放', async () => {
  const f=await setup(), edited=structuredClone((await readReview(f.round)).view!.candidates[0]!.document) as any;
  delete edited.data.memberPrice;
  await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited,note:'取消会员专享价格'});
  const next=join(f.dir,'next'); await importExcelRound({from:source,workspace:f.workspace,out:next,previous:f.round});
  await approve(next);
  const third=join(f.dir,'third'); const imported=await importExcelRound({from:source,workspace:f.workspace,out:third,previous:next});
  expect(imported.corrections).toMatchObject([{path:'/memberPrice',before:1.8,removed:true,status:'replayed',reason:'取消会员专享价格'}]);
  expect((await readReview(third)).view!.candidates[0]!.document).not.toHaveProperty('data.memberPrice');
});
it('嵌套列表重排后修改跟随源单元格，审核整份目录后可应用', async () => {
  const nested='scripts/prototypes/excel-agent/evidence-p05/nested-01';
  const f=await setup(nested,'fixtures/workspaces/excel-catalog');
  const edited=structuredClone((await readReview(f.round)).view!.candidates[0]!.document) as any;
  edited.data.batches[0].items[0].retailPrice=2.5;
  await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited,note:'核准目录首项售价'});
  const from=join(f.dir,'reordered'); await cp(nested,from,{recursive:true});
  const plan=await json(join(from,'attempt-02/plan.json')), candidate=await json(join(from,'attempt-02/candidate.json'));
  const fields=plan.datasets[0].value.fields.batches.items[0].fields, rows=fields.items;
  fields.items={op:'array',items:Array.from({length:6},(_,i)=>JSON.parse(JSON.stringify(rows.item).replaceAll('{row}',String(7-i))))};
  candidate.datasets[0].data.batches[0].items.reverse();
  for(const trace of candidate.sources) trace.path=trace.path.replace(/^\/batches\/0\/items\/(\d+)/, (_:string,i:string)=>`/batches/0/items/${5-Number(i)}`);
  await save(join(from,'attempt-02/plan.json'),plan); await save(join(from,'attempt-02/candidate.json'),candidate);
  const next=join(f.dir,'next'); const imported=await importExcelRound({from,workspace:f.workspace,out:next,previous:f.round});
  expect(imported.corrections).toMatchObject([{path:'/batches/0/items/5/retailPrice',status:'replayed'}]);
  const items=((await readReview(next)).view!.candidates[0]!.document as any).data.batches[0].items;
  expect(items[0].retailPrice).toBe(7.98); expect(items[5].retailPrice).toBe(2.5);
  await approve(next); expect((await applyAgentRound({roundDir:next})).applied!.published).toHaveLength(1);
});
it.each([false,true])('Excel 整批应用强退后恢复；证据被改时阻止恢复=%s', async tamper => {
  const dir=join(root,String(++n)); await mkdir(dir); const from=join(dir,'many'); await cp(source,from,{recursive:true});
  const plan=await json(join(from,'attempt-02/plan.json')), candidate=await json(join(from,'attempt-02/candidate.json'));
  const item=plan.datasets[0], doc=candidate.datasets[0], traces=candidate.sources.filter((s:any)=>s.datasetId===doc.dataset.id);
  plan.datasets=Array.from({length:30},(_,i)=>({...item,id:`crash-${i}`}));
  candidate.datasets=plan.datasets.map((d:any)=>({...doc,dataset:{...doc.dataset,id:d.id}}));
  candidate.sources=plan.datasets.flatMap((d:any)=>traces.map((s:any)=>({...s,datasetId:d.id})));
  // 保留原六份计划对其余行的覆盖；新三十份用于扩大公开提交的强退窗口。
  const originalPlan=await json(join(source,'attempt-02/plan.json')), originalCandidate=await json(join(source,'attempt-02/candidate.json'));
  plan.datasets.push(...originalPlan.datasets); candidate.datasets.push(...originalCandidate.datasets); candidate.sources.push(...originalCandidate.sources);
  await save(join(from,'attempt-02/plan.json'),plan); await save(join(from,'attempt-02/candidate.json'),candidate);
  const f=await setup(from); await approve(f.round);
  const child=spawn(process.execPath,['--import','tsx','src/bin.ts','agent','apply',f.round],{windowsHide:true});
  let killed=false,output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
  const watcher=watch(f.workspace,(_,name)=>{if(!killed&&name?.startsWith('dataset-')&&name.endsWith('.json')) killed=child.kill('SIGKILL');});
  try {await new Promise<void>((done,fail)=>{child.once('error',fail);child.once('close',()=>done());});} finally {watcher.close();}
  expect(killed,output).toBe(true);
  const partial=(await readdir(f.workspace)).filter(name=>name.startsWith('dataset-'));
  expect(partial.length).toBeGreaterThan(0); expect(partial.length).toBeLessThan(36);
  const path=join(f.round,'excel/plan.json'), bytes=await readFile(path);
  if(tamper) {
    await appendFile(path,' '); const blocked=await readReview(f.round);
    expect(blocked.view).toBeUndefined(); expect(blocked.problems.some(p=>p.code==='apply.recoveryRequired')).toBe(true);
    await writeFile(path,bytes);
  }
  const recovered=await readReview(f.round); expect(recovered.problems).toEqual([]); expect(recovered.view!.applied!.published).toHaveLength(36);
  expect((await applyAgentRound({roundDir:f.round})).reused).toBe(true);
  expect((await readWorkspaceDocuments(localWorkspaceDocuments(f.workspace))).datasets).toHaveLength(36);
},60000);
