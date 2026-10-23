/** 候选序列经实际 CLI 与真实 MCP 检查，选择结论只从公开审核入口读取。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, readPreviousRound, render, loadWorkspace, publishStaticSchema } from '../src/index.js';
import { copyWorkspaceFixture, repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';

let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rw-retained-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});});
async function waitJson(file:string):Promise<any> {
  for(let i=0;i<600;i++){try{return JSON.parse(await readFile(file,'utf8'));}catch{}await new Promise(done=>setTimeout(done,20));}
  throw new Error(`未收到公开结果：${file}`);
}
async function stop(child:ChildProcess){
  if(!child.pid||child.exitCode!==null)return;
  if(process.platform==='win32'){const task=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await once(task,'close');}
  else {
    const out=child.spawnargs[child.spawnargs.indexOf('--out')+1];let executor:number|undefined;
    try{const state=JSON.parse(await readFile(join(out!,'execution.json'),'utf8'));if(state.owner?.pid===child.pid&&!state.executorExited&&Number.isSafeInteger(state.executorPid)&&state.executorPid>1)executor=state.executorPid;}catch{}
    if(executor)try{process.kill(-executor,'SIGKILL');}catch{}
    try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
    if(executor)for(let i=0;i<100;i++){try{process.kill(executor,0);}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')break;}await new Promise(done=>setTimeout(done,20));}
  }
}
const definition=(fields:string[])=>({dslVersion:'renderweave-schema/1',name:'线路',fields:fields.map(name=>({name,displayName:name,type:'text'}))});
async function start(name:string,fields:string[],baseline=true,approvedFields=['number','title','station'],sample='images/test/quadrants.png'){
  const dir=join(root,name),preset=join(root,`${name}-preset`),brief=join(root,`${name}.md`),facts=join(root,`${name}-facts.json`);
  await mkdir(join(preset,'candidates'),{recursive:true});await writeFile(brief,'从图中提取线路字段');
  await writeFile(facts,JSON.stringify({name:'核准线路字段',items:approvedFields.map(field=>({id:field,label:field,definition:'线路',field}))}));
  await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(definition(fields)));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'候选'}));
  return launch(dir,preset,['--task','definition-extraction','--sample',join(resourcesDir,sample),'--brief',brief,'--resources',resourcesDir,...(baseline?['--content-baseline',facts]:[])]);
}
async function launch(dir:string,preset:string,args:string[]){
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run',...args,'--out',dir,'--key-env','RW_SELECTION_KEY','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),preset])],{cwd:repoRoot,env:{...process.env,RW_SELECTION_KEY:'offline'},windowsHide:true,stdio:'pipe',detached:process.platform!=='win32'});
  let errors='';child.stderr!.on('data',data=>errors+=String(data));const closed=once(child,'close');
  await Promise.race([waitJson(join(dir,'agent/checkpoint-observed.json')),closed.then(()=>{throw new Error(errors);})]);
  return {dir,child,closed,errors:()=>errors};
}
async function check(dir:string,id:number,fields:string[]){
  await writeFile(join(dir,'agent/candidates/schema.json'),JSON.stringify(definition(fields)));
  await writeFile(join(dir,'agent/checkpoint-action.json'),JSON.stringify({id}));
  return JSON.parse((await waitJson(join(dir,`agent/checkpoint-observed-${id}.json`))).result.content[0].text);
}

it('核准缺项真实减少才保留较好候选，之后退步只更新最后完整集合',async()=>{
  const job=await start('coverage',['number']);
  try{
    const first=await readReview(job.dir);
    expect((first as any).candidateSelection).toMatchObject({comparison:{status:'uncompared'}});
    expect((first as any).candidateSelection.better).toBeUndefined();
    const improved=await check(job.dir,1,['number','title']);
    const retained=(await readReview(job.dir) as any).candidateSelection;
    expect(retained.better.id).toBe(improved.checkpoint.id);
    expect(retained.comparison).toMatchObject({status:'improved',improved:expect.arrayContaining([expect.objectContaining({dimension:'coverage.missing',item:'title'})])});
    expect(retained.better.check.coverageVerification.missingItems).toEqual(['station']);
    const regressed=await check(job.dir,2,['number']);
    const after=(await readReview(job.dir) as any).candidateSelection;
    expect(after.latest.id).toBe(regressed.checkpoint.id);expect(after.better.id).toBe(improved.checkpoint.id);
    expect(after.comparison.status).toBe('regressed');
    await writeFile(join(job.dir,'agent/continue'),'');await job.closed;
    expect(JSON.parse(await readFile(join(job.dir,'candidates/schema.json'),'utf8')).fields.map((field:any)=>field.name)).toEqual(['number']);
    const final=(await readReview(job.dir)).candidateSelection as any;
    expect(final.latest.documents[0].document.fields).toHaveLength(1);expect(final.better.documents[0].document.fields).toHaveLength(2);
    expect(final.differences).toEqual(expect.arrayContaining([expect.objectContaining({file:'candidates/schema.json',path:'/fields/1',after:null})]));
  }finally{await stop(job.child);await job.closed;}
});
it('两轮真实检查的核准依据不同，审核比较给出不可排序及具体依据',async()=>{
  const first=await start('baseline-a',['number']),second=await start('baseline-b',['number'],true,['number']);
  try{
    const a=(await readReview(first.dir)).checkpoint!;
    const result=await (readReview as any)(second.dir,{compareWith:{roundDir:first.dir,id:a.id}});
    expect(result.candidateComparison.comparison).toMatchObject({status:'incomparable',reasons:expect.arrayContaining(['比较依据不同：reference'])});
    expect(result.candidateComparison.before.id).toBe(a.id);
    expect(result.candidateComparison.after.id).toBe((await readReview(second.dir)).checkpoint!.id);
  }finally{for(const job of [first,second]){await stop(job.child);await job.closed;}}
});
it('提取任务即使内容事实相同，示例图字节不同也不可跨参考排序',async()=>{
  const first=await start('sample-a',['number']),second=await start('sample-b',['number','title'],true,undefined,'images/test/quadrants.jpg');
  try{
    const checkpoint=(await readReview(first.dir)).checkpoint!;
    const compared=await readReview(second.dir,{compareWith:{roundDir:first.dir,id:checkpoint.id}});
    expect(compared.candidateComparison?.comparison).toMatchObject({status:'incomparable',reasons:expect.arrayContaining(['比较依据不同：reference'])});
  }finally{for(const job of [first,second]){await stop(job.child);await job.closed;}}
});
it('没有可信核准事实不能排序，相同候选和无关字段变化也不制造改善',async()=>{
  const unknown=await start('no-reference',['number'],false),known=await start('unchanged',['number','title','station']);
  try{
    await check(unknown.dir,1,['number','title','station']);
    const unranked=(await readReview(unknown.dir)).candidateSelection!;expect(unranked.better).toBeUndefined();expect(unranked.comparison.status).toBe('incomparable');
    await check(known.dir,1,['number','title','station']);
    expect((await readReview(known.dir)).candidateSelection?.comparison.status).toBe('unchanged');
    const old=(await readReview(known.dir)).checkpoint!.contentIdentity;
    await check(known.dir,2,['number','title','station','unrelated']);
    const changed=(await readReview(known.dir)).candidateSelection!;
    expect(changed.latest.contentIdentity).not.toBe(old);expect(changed.comparison.status).toBe('unchanged');expect(changed.better).toBeUndefined();
  }finally{for(const job of [unknown,known]){await stop(job.child);await job.closed;}}
});
it('缺项数量相同但换成新错误，或技术硬约束受损时不覆盖较好候选',async()=>{
  const job=await start('swapped',['number']);
  try{
    const better=await check(job.dir,1,['number','title']);await check(job.dir,2,['number','station']);
    const swapped=(await readReview(job.dir)).candidateSelection!;
    expect(swapped.better?.id).toBe(better.checkpoint.id);expect(swapped.comparison.status).toBe('incomparable');
    expect(swapped.comparison.regressed).toEqual(expect.arrayContaining([expect.objectContaining({dimension:'coverage.missing',item:'title'})]));
    const invalid=definition(['number','title','station']);
    Object.assign(invalid.fields[0]!,{constraints:{minLength:9,maxLength:1}});
    const checked=await checkTemplate(job.dir,3,invalid);expect(checked.checkpoint.status).toBe('saved');
    const blocked=(await readReview(job.dir)).candidateSelection!;
    expect(blocked.latest.check.assessment.candidates).toBe('invalid');expect(blocked.better?.id).toBe(better.checkpoint.id);
    expect(blocked.comparison.reasons).toContain('新候选未保持技术硬约束或授权修改范围');
  }finally{await stop(job.child);await job.closed;}
});
it('新增待确认范围不能因已核准字段齐全而变成更好',async()=>{
  const job=await start('pending-growth',['number']);
  try{
    const better=await check(job.dir,1,['number','title']);
    await writeFile(join(job.dir,'agent/outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[{file:'candidates/schema.json',path:'title',reason:'unreadable',note:'标题仍不能辨认'}],notes:'补齐字段'}));
    await check(job.dir,2,['number','title','station']);
    const result=(await readReview(job.dir)).candidateSelection!;
    expect(result.better?.id).toBe(better.checkpoint.id);expect(result.comparison.status).toBe('incomparable');expect(result.comparison.unknownAdded.length).toBeGreaterThan(0);
  }finally{await stop(job.child);await job.closed;}
});
it.each(['interrupted','completed'])('从所选较好完整集合开新轮次，保留原%s事实与正式稿',async ending=>{
  const source=await start(`selected-${ending}`,['number']);
  const improved=await check(source.dir,1,['number','title']);await check(source.dir,2,['number']);
  if(ending==='completed'){await writeFile(join(source.dir,'agent/continue'),'');await source.closed;}
  else {await stop(source.child);await source.closed;}
  const prior=await readFile(join(source.dir,'execution.json'),'utf8');
  const feedback=join(root,`resume-${ending}.md`),preset=join(root,`resume-${ending}-preset`);await mkdir(preset);await writeFile(feedback,'继续修复剩余缺项');
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'继续'}));
  const next=await launch(join(root,`resume-${ending}`),preset,['--from',source.dir,'--checkpoint','better','--feedback',feedback]);
  try{
    const seeds=await waitJson(join(next.dir,'agent/checkpoint-seeds.json'));
    expect(JSON.parse(seeds['schema.json']).fields.map((field:any)=>field.name)).toEqual(['number','title']);
    const state=await readReview(next.dir);
    expect(state.execution?.start?.inputs.previous?.checkpoint).toMatchObject({id:improved.checkpoint.id,source:'hostRecovery'});
    expect(await readFile(join(source.dir,'execution.json'),'utf8')).toBe(prior);
  }finally{await stop(next.child);await next.closed;}
});

const template=(size:number,text='科技园')=>({dslVersion:'renderweave-template/1',name:'对照',base:{name:'问候',version:1},
  artboard:{sizeRange:{width:{min:10,max:200},height:{min:10,max:200}},layout:{mode:'free'},children:[
    {type:'text',name:'站名',content:[{text}],font:'res:font-hei-medium',fontSize:size,color:'#000000',place:{left:10,top:10,width:{fixed:60},height:{fixed:30}}}]}});
async function startTemplate(name:string,revision=false){
  const dir=join(root,name),preset=join(root,`${name}-preset`),brief=join(root,`${name}.md`),reference=join(root,`${name}-reference.json`),sample=join(root,`${name}.png`),requestFile=join(root,`${name}-request.json`);
  await mkdir(join(preset,'candidates'),{recursive:true});await writeFile(brief,'核对站名字号与文字');
  const request={template:'对照',dataset:{id:'ds-greeting'},parameters:{},output:{width:100,height:60,dpi:50,format:'png' as const},mode:'final' as const};
  const workspace=await loadWorkspace({dir:singleTextDir,resourcesDir});
  const good=template(10),image=(await render({...workspace,templates:[...workspace.templates,{name:'对照',document:good,source:'candidate.json'}]},request)).image!;
  await writeFile(sample,image.bytes);
  await writeFile(reference,JSON.stringify({sampleWidthPx:image.widthPx,sampleHeightPx:image.heightPx,artboardWidthMm:100,artboardHeightMm:60,
    approvedRegions:[{id:'stop',name:'站名',sampleRegion:{x:0,y:0,width:image.widthPx,height:image.heightPx},targetPathPattern:'对照/站名',expectedFontSizeMm:10,expectedText:'科技园'}]}));
  await writeFile(requestFile,JSON.stringify(request));await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(template(6)));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'候选'}));
  let workspaceDir=singleTextDir;
  if(revision){workspaceDir=join(root,`${name}-workspace`);await copyWorkspaceFixture(singleTextDir,workspaceDir);await writeFile(join(workspaceDir,'comparison.template.json'),JSON.stringify(good));}
  return launch(dir,preset,['--task',revision?'template-revision':'template-design','--sample',sample,'--brief',brief,'--resources',resourcesDir,'--workspace',workspaceDir,'--dataset','ds-greeting','--request',requestFile,'--reference',reference,...(revision?['--requirement',brief]:[])]);
}
async function checkTemplate(dir:string,id:number,document:unknown){
  await writeFile(join(dir,'agent/candidates/schema.json'),JSON.stringify(document));
  await writeFile(join(dir,'agent/checkpoint-action.json'),JSON.stringify({id}));
  return JSON.parse((await waitJson(join(dir,`agent/checkpoint-observed-${id}.json`))).result.content[0].text);
}
it('同一核准字号偏差真实减小可保留，但字号与文字互有得失不能替代',async()=>{
  const job=await startTemplate('style');
  try{
    const better=await checkTemplate(job.dir,1,template(7));
    const selected=(await readReview(job.dir)).candidateSelection!;
    expect(selected.better?.id,JSON.stringify(selected.comparison)).toBe(better.checkpoint.id);
    expect(selected.comparison.status).toBe('improved');
    expect(selected.better?.check.styleVerification?.passed).toBe(false);
    await checkTemplate(job.dir,2,template(10,'科枝园'));
    const conflict=(await readReview(job.dir)).candidateSelection!;
    expect(conflict.better?.id).toBe(better.checkpoint.id);expect(conflict.comparison.status).toBe('incomparable');
    expect(conflict.comparison.improved.length).toBeGreaterThan(0);expect(conflict.comparison.regressed.length).toBeGreaterThan(0);
    const unknown={...template(10),artboard:{...template(10).artboard,children:[{type:'rect',name:'站名',fill:'#000000',place:{left:10,top:10,width:{fixed:60},height:{fixed:30}}}]}};
    await checkTemplate(job.dir,3,unknown);
    const unmeasured=(await readReview(job.dir)).candidateSelection!;
    expect(unmeasured.comparison.status).toBe('incomparable');expect(unmeasured.comparison.unknownAdded.length).toBeGreaterThan(0);expect(unmeasured.better?.id).toBe(better.checkpoint.id);
    const acceptable=await checkTemplate(job.dir,4,template(8.5));await checkTemplate(job.dir,5,template(9));
    const within=(await readReview(job.dir)).candidateSelection!;
    expect(within.better?.id).toBe(acceptable.checkpoint.id);expect(within.comparison.status).toBe('unchanged');
  }finally{await stop(job.child);await job.closed;}
});
it('修改任务中改动范围外已保存模板不能用视觉改善抵消，显式 ID 恢复完整两文件集合',async()=>{
  const job=await startTemplate('revision-range',true);
  try{
    const better=await checkTemplate(job.dir,1,template(7));
    await writeFile(join(job.dir,'agent/candidates/extra.json'),JSON.stringify({...template(10),name:'问候牌'}));
    await writeFile(join(job.dir,'agent/outcome.json'),JSON.stringify({candidates:['candidates/schema.json','candidates/extra.json'],pending:[],notes:'越界'}));
    const extra=await checkTemplate(job.dir,2,template(8));expect(extra.checkpoint.status).toBe('saved');
    const state=(await readReview(job.dir)).candidateSelection!;
    expect(state.better?.id).toBe(better.checkpoint.id);expect(state.comparison.status).toBe('incomparable');
    expect(state.comparison.reasons).toContain('新候选未保持技术硬约束或授权修改范围');
    expect(state.latest.documents).toHaveLength(2);
    await stop(job.child);await job.closed;
    const feedback=join(root,'revision-resume.md'),preset=join(root,'revision-resume-preset');await mkdir(preset);await writeFile(feedback,'检查完整两份草稿后修复范围');
    await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json','candidates/extra.json'],pending:[],notes:'完整接续'}));
    const resumed=await launch(join(root,'revision-resume'),preset,['--from',job.dir,'--checkpoint',extra.checkpoint.id,'--feedback',feedback]);
    try{
      const seeds=await waitJson(join(resumed.dir,'agent/checkpoint-seeds.json'));
      expect(JSON.parse(seeds['schema.json'])).toEqual(template(8));expect(JSON.parse(seeds['extra.json'])).toEqual({...template(10),name:'问候牌'});
      expect((await readReview(resumed.dir)).execution?.start?.inputs.previous?.checkpoint?.id).toBe(extra.checkpoint.id);
    }finally{await stop(resumed.child);await resumed.closed;}
  }finally{await stop(job.child);await job.closed;}
});
it('没有改善时不能冒称较好候选；旧指针保持最后检查点，损坏较好集合不回退到残留内容',async()=>{
  const job=await start('selection-compat',['number']);
  await stop(job.child);await job.closed;
  await expect(readPreviousRound(job.dir,{checkpoint:'better'})).rejects.toThrow('没有有证据较好的候选');
  await expect(readPreviousRound(job.dir,{checkpoint:'00000000-0000-0000-0000-000000000000'})).rejects.toThrow('完整发布');
  const pointer=JSON.parse(await readFile(join(job.dir,'checkpoint.json'),'utf8'));
  await writeFile(join(job.dir,'checkpoint.json'),JSON.stringify({format:'renderweave-checkpoint-ref/1',id:pointer.id,sha256:pointer.sha256}));
  const legacy=await readReview(job.dir);expect(legacy.checkpoint?.id).toBe(pointer.id);expect(legacy.candidateSelection).toBeUndefined();
  expect((await readPreviousRound(job.dir,{checkpoint:'latest'})).checkpoint?.id).toBe(pointer.id);
  const damaged=await start('selection-corrupt',['number']);
  try{
    const better=await check(damaged.dir,1,['number','title']);await check(damaged.dir,2,['number']);
    await writeFile(join(damaged.dir,'checkpoints',better.checkpoint.id,'agent/candidates/schema.json'),'{}');
    const view=await readReview(damaged.dir);expect(view.candidateSelection).toBeUndefined();expect(view.problems[0]?.message).toContain('内容已变化');
  }finally{await stop(damaged.child);await damaged.closed;}
});
it('数据集核准值修正可保留；审核差异区分空值与删除',async()=>{
  const name='dataset',dir=join(root,name),preset=join(root,`${name}-preset`),brief=join(root,`${name}.md`),facts=join(root,`${name}-facts.json`);
  const document={dataset:{id:'selected-data',staticSchema:{name:'问候',version:1}},data:{message:null as unknown}};
  await mkdir(join(preset,'candidates'),{recursive:true});await writeFile(brief,'提取核准问候语');
  await writeFile(facts,JSON.stringify({name:'问候语',items:[{id:'message',label:'问候语',values:[{path:'message',value:'欢迎乘坐'}]}]}));
  await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(document));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'数据'}));
  const job=await launch(dir,preset,['--task','dataset-extraction','--workspace',singleTextDir,'--definition','问候@1','--sample',join(resourcesDir,'images/test/quadrants.png'),'--brief',brief,'--resources',resourcesDir,'--content-baseline',facts]);
  try{
    const first=(await readReview(dir)).checkpoint!;
    await checkTemplate(dir,1,{...document,data:{}});
    const changed=await readReview(dir,{compareWith:{roundDir:dir,id:first.id}});
    expect(changed.candidateComparison?.differences).toContainEqual({file:'candidates/schema.json',path:'/data/message',change:'removed',before:null,after:null});
    const corrected=await checkTemplate(dir,2,{...document,data:{message:'欢迎乘坐'}});
    const selected=(await readReview(dir)).candidateSelection!;
    expect(selected.better?.id).toBe(corrected.checkpoint.id);expect(selected.comparison.status).toBe('improved');
    expect(selected.better?.check.coverageVerification?.passed).toBe(true);
  }finally{await stop(job.child);await job.closed;}
});
it('同一工作区选择了不同定义版本时不能跨依据排序',async()=>{
  const workspace=join(root,'definition-basis-workspace');await copyWorkspaceFixture(singleTextDir,workspace);
  const loaded=await loadWorkspace({dir:workspace,resourcesDir});
  const original=loaded.staticSchemas[0]!.definition as Record<string,unknown>;
  const published=publishStaticSchema({...original,version:undefined},loaded.staticSchemas).published!;
  await writeFile(join(workspace,'schema-v2.json'),JSON.stringify(published.definition));await writeFile(join(workspace,'compiled-v2.schema.json'),JSON.stringify(published.compiled));
  const brief=join(root,'definition-basis.md'),facts=join(root,'definition-basis.json');await writeFile(brief,'核对问候语');
  await writeFile(facts,JSON.stringify({name:'问候语',items:[{id:'message',label:'问候语',values:[{path:'message',value:'欢迎乘坐'}]}]}));
  const jobs=[];
  try{
    for(const version of [1,2]){
      const preset=join(root,`definition-basis-preset-${version}`);await mkdir(join(preset,'candidates'),{recursive:true});
      await writeFile(join(preset,'candidates/schema.json'),JSON.stringify({dataset:{id:'basis-data',staticSchema:{name:'问候',version}},data:{message:version===1?'欢迎':'欢迎乘坐'}}));
      await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'候选'}));
      jobs.push(await launch(join(root,`definition-basis-${version}`),preset,['--task','dataset-extraction','--workspace',workspace,'--definition',`问候@${version}`,'--sample',join(resourcesDir,'images/test/quadrants.png'),'--brief',brief,'--resources',resourcesDir,'--content-baseline',facts]));
    }
    const first=(await readReview(jobs[0]!.dir)).checkpoint!;
    const compared=await readReview(jobs[1]!.dir,{compareWith:{roundDir:jobs[0]!.dir,id:first.id}});
    expect(compared.candidateComparison?.comparison).toMatchObject({status:'incomparable',reasons:expect.arrayContaining(['比较依据不同：workspace'])});
  }finally{for(const job of jobs){await stop(job.child);await job.closed;}}
});
