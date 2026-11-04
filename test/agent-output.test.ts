import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { prepareAgentOutput, deliverAgentOutput, importExcelRound, changeReview, readReview, applyAgentRound,
  initializeResourceStore, importResources, readOutputRecord, replayOutputRecord, readBatch } from '../src/index.js';
import { runCli } from '../src/cli.js';

let root: string, resources: string, sequence=0;
const json = async (path: string)=>JSON.parse(await readFile(path,'utf8'));
const save = (path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2));
const priceSource='scripts/prototypes/excel-agent/evidence-p04/live-01';
const nestedSource='scripts/prototypes/excel-agent/evidence-p05/nested-01';
beforeAll(async()=>{
  root=await mkdtemp(join(tmpdir(),'rw-output-plan-'));resources=join(root,'resources');
  expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({sourceDir:'fixtures/resources',dir:resources})).problems).toEqual([]);
});
afterAll(async()=>{
  if(!resolve(root).startsWith(join(resolve(tmpdir()),'rw-output-plan-'))) throw new Error('测试清理路径越界');
  await rm(root,{recursive:true,force:true});
});
async function setup(nested=false,apply=true) {
  const dir=join(root,String(++sequence));await mkdir(dir);const workspace=join(dir,'workspace');
  await cp(nested?'fixtures/workspaces/excel-catalog':'fixtures/workspaces/price-tag',workspace,{recursive:true});
  if(nested) await cp('fixtures/excel/output/template-catalog-item.json',join(workspace,'template-catalog-item.json'));
  const round=join(dir,'round');await importExcelRound({from:nested?nestedSource:priceSource,workspace,out:round});
  if(apply) await approveApply(round);
  return {dir,workspace,round,prepared:join(dir,'prepared')};
}
async function approveApply(round:string) {
  const review=await readReview(round);expect(review.problems).toEqual([]);
  for(const p of review.view!.pending) if(!p.decision) expect((await changeReview(round,{type:'decide',item:p.item,action:'adopt'})).problems).toEqual([]);
  expect((await changeReview(round,{type:'confirmRest',confirmed:true})).problems).toEqual([]);
  expect((await changeReview(round,{type:'approve'})).problems).toEqual([]);
  expect((await applyAgentRound({roundDir:round})).problems).toEqual([]);
}
async function prepare(f:Awaited<ReturnType<typeof setup>>,plan:unknown) {return prepareAgentOutput({roundDir:f.round,resources,plan,outDir:f.prepared});}
const pricePlan=()=>json('fixtures/excel/output/price-tags-plan.json');
it('未审核应用不能准备，计划覆盖所有候选且可见跳过项',async()=>{
  const f=await setup(false,false),plan=await pricePlan();
  await expect(prepare(f,plan)).rejects.toThrow('完整审核并应用');await expect(stat(f.prepared)).rejects.toThrow();
  await approveApply(f.round);
  const value=await prepare(f,plan);expect(value.state).toBe('prepared');expect(value.items).toHaveLength(6);expect(value.skipped).toHaveLength(1);expect(value.batches).toHaveLength(2);
  await expect(stat(join(f.prepared,'delivery.json'))).rejects.toThrow();
});
it('正式 CLI 从准备到 PNG/JPEG 交付，出图记录可独立重放',async()=>{
  const f=await setup();let stdout='',stderr='';const io={stdout:(s:string)=>{stdout+=s;},stderr:(s:string)=>{stderr+=s;}};
  expect(await runCli(['agent','prepare-output','--round',f.round,'--resources',resources,'--plan','fixtures/excel/output/price-tags-plan.json','--out',f.prepared],io),stderr).toBe(0);
  expect(JSON.parse(stdout).state).toBe('prepared');stdout='';const out=join(f.dir,'delivery');
  expect(await runCli(['agent','deliver-output','--prepared',f.prepared,'--out',out],io),stderr).toBe(0);
  const result=JSON.parse(stdout);expect(result.state).toBe('delivered');expect(result.summary).toMatchObject({total:6,delivered:6,failed:0,notRun:0});
  expect((await readBatch({dir:join(out,'0001')})).problems).toEqual([]);
  const record=join(out,'0001/0001');expect((await readOutputRecord({dir:record})).record).toBeDefined();
  const replay=join(f.dir,'replay');expect((await replayOutputRecord({dir:record,outDir:replay})).replayed).toBeDefined();
  expect(await readFile(join(replay,'image.png'))).toEqual(await readFile(join(record,'image.png')));
  expect(await readFile(join(out,'0002/0001/image.jpg'))).not.toHaveLength(0);
},30000);
it('嵌套列表按位置展开，重复品名仍分别出图，跳过不重排后续参数',async()=>{
  const f=await setup(true,false),review=(await readReview(f.round)).view!,doc=structuredClone(review.candidates[0]!.document) as any;
  doc.data.batches[0].items[1].productName=doc.data.batches[0].items[0].productName;
  await changeReview(f.round,{type:'decide',item:1,action:'edit',value:doc,note:'重复品名位置测试'});await approveApply(f.round);
  const plan=await json('fixtures/excel/output/catalog-plan.json'),prepared=await prepare(f,plan);
  expect(prepared.items.map(i=>i.index)).toEqual([0,1,3,4,5]);expect(prepared.skipped[0]).toMatchObject({index:2,reason:'演示范围：第三项不在本次制作范围'});
  const request=await json(join(f.prepared,'request-001.json'));expect(request.items.map((i:any)=>i.parameters.productIndex)).toEqual([1,2,4,5,6]);
  const out=join(f.dir,'delivery'),delivered=await deliverAgentOutput({preparedDir:f.prepared,outDir:out});expect(delivered.state).toBe('delivered');expect(delivered.summary.delivered).toBe(5);
  const input=await json(join(out,'0001/0002/input.json'));expect(input.batch.items[0].parameters.productIndex).toBe(2);
  const layout=JSON.stringify(await json(join(out,'0001/0002/layout.json')));expect(layout).toContain('0088012');
},30000);
it('漏候选、未知参数、错误尺寸和重复分组均拒绝创建准备目录',async()=>{
  const f=await setup();const base=await pricePlan();
  const plans=[{...base,groups:[{...base.groups[0],datasets:['0012345']}],skipped:[]},
    {...base,groups:[{...base.groups[0],parameters:{wrong:'x'}}]},
    {...base,groups:[{...base.groups[0],output:{...base.groups[0].output,width:999}}]},
    {...base,groups:[base.groups[0],base.groups[0]]}];
  for(const plan of plans) {await expect(prepare(f,plan)).rejects.toThrow();await expect(stat(f.prepared)).rejects.toThrow();}
});
it('路径和位置参数必须明确，越界跳过不被静默忽略',async()=>{
  const f=await setup(true),plan=await json('fixtures/excel/output/catalog-plan.json');
  for(const forEach of [{...plan.groups[0].forEach,path:'/missing'},{...plan.groups[0].forEach,parameter:'missing'},{...plan.groups[0].forEach,skip:[{index:99,reason:'越界'}]}]) {
    await expect(prepare(f,{...plan,groups:[{...plan.groups[0],forEach}]})).rejects.toThrow();
  }
});
it('应用后数据被修改必须重新审核，准备时不能换入未核准数据',async()=>{
  const f=await setup(),file=(await readdir(f.workspace)).find(n=>n.startsWith('dataset-'))!;
  const doc=await json(join(f.workspace,file));doc.data.retailPrice=999;await save(join(f.workspace,file),doc);
  await expect(prepare(f,await pricePlan())).rejects.toThrow('应用后数据集已改变');
});
it('准备后使用固定快照，后续工作空间改动不混入本次交付',async()=>{
  const f=await setup();await prepare(f,await pricePlan());
  const file=(await readdir(f.workspace)).find(n=>n.startsWith('dataset-'))!;await writeFile(join(f.workspace,file),'invalid future workspace');
  const out=join(f.dir,'delivery'),result=await deliverAgentOutput({preparedDir:f.prepared,outDir:out});expect(result.state).toBe('delivered');
  expect((await json(join(out,'0001/0001/input.json'))).documents.datasets[0].document.data.retailPrice).toBe(2);
},30000);
it.each(['batch-001.json','asset'])('准备文件 %s 被修改时拒绝交付且不创建输出',async target=>{
  const f=await setup(),prepared=await prepare(f,await pricePlan());
  const file=target==='asset'?prepared.files.find(f=>f.file.startsWith('asset-'))!.file:target;
  await appendFile(join(f.prepared,file),' ');const out=join(f.dir,'delivery');
  await expect(deliverAgentOutput({preparedDir:f.prepared,outDir:out})).rejects.toThrow('不匹配');await expect(stat(out)).rejects.toThrow();
});
it('取消在项间生效，跨模板组保留未执行数量并返回未完成',async()=>{
  const f=await setup();await prepare(f,await pricePlan());const cancel=new AbortController();
  const result=await deliverAgentOutput({preparedDir:f.prepared,outDir:join(f.dir,'delivery'),signal:cancel.signal,onItem:()=>cancel.abort()});
  expect(result.state).toBe('incomplete');expect(result.summary).toMatchObject({total:6,delivered:1,notRun:5});
});
it('草稿仅记预览；缺少准备完成清单的目录不能交付',async()=>{
  const f=await setup(),plan=await pricePlan();await prepare(f,{...plan,mode:'draft'});
  const out=join(f.dir,'draft');const result=await deliverAgentOutput({preparedDir:f.prepared,outDir:out});expect(result.state).toBe('previewed');expect(result.summary.previewed).toBe(6);
  await expect(stat(join(out,'0001/0001/record.json'))).rejects.toThrow();expect(await stat(join(out,'0001/0001/preview.json'))).toBeDefined();
  const incomplete=join(f.dir,'incomplete');await mkdir(incomplete);
  await expect(deliverAgentOutput({preparedDir:incomplete,outDir:join(f.dir,'bad')})).rejects.toThrow();
},30000);
it('即使改写快照哈希，也不能替换已审核数据或漏掉计划渲染项',async()=>{
  const f=await setup();await prepare(f,await pricePlan());
  const manifestPath=join(f.prepared,'prepared.json'),manifest=await json(manifestPath);
  const snapshotPath=join(f.prepared,'batch-001.json'),original=await readFile(snapshotPath),snapshot=JSON.parse(original.toString('utf8'));
  snapshot.documents.datasets[0].document.data.retailPrice=999;await save(snapshotPath,snapshot);
  const bytes=await readFile(snapshotPath),entry=manifest.files.find((e:any)=>e.file==='batch-001.json');
  entry.sha256=createHash('sha256').update(bytes).digest('hex');entry.byteLength=bytes.length;await save(manifestPath,manifest);
  await expect(deliverAgentOutput({preparedDir:f.prepared,outDir:join(f.dir,'forged')})).rejects.toThrow('已审核应用');
  await writeFile(snapshotPath,original);entry.sha256=createHash('sha256').update(original).digest('hex');entry.byteLength=original.length;
  manifest.batches.pop();manifest.items.pop();await save(manifestPath,manifest);
  await expect(deliverAgentOutput({preparedDir:f.prepared,outDir:join(f.dir,'partial')})).rejects.toThrow('计划范围');
});
it('布局阶段失败记为未完成，不能用准备成功代替交付成功',async()=>{
  const f=await setup(),file=join(f.workspace,'template-price-tag.json'),template=await json(file);
  template.artboard.children[2].children[0].fontSize=200;await save(file,template);
  await prepare(f,await pricePlan());const result=await deliverAgentOutput({preparedDir:f.prepared,outDir:join(f.dir,'failed')});
  expect(result.state).toBe('incomplete');expect(result.summary.failed).toBeGreaterThan(0);expect(result.summary.delivered).toBe(0);
},30000);
