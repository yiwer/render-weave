/** 候选序列经实际 CLI 与真实 MCP 检查，选择结论只从公开审核入口读取。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';

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
  else {try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}}
}
const definition=(fields:string[])=>({dslVersion:'renderweave-schema/1',name:'线路',fields:fields.map(name=>({name,displayName:name,type:'text'}))});
async function start(name:string,fields:string[],baseline=true){
  const dir=join(root,name),preset=join(root,`${name}-preset`),brief=join(root,`${name}.md`),facts=join(root,`${name}-facts.json`);
  await mkdir(join(preset,'candidates'),{recursive:true});await writeFile(brief,'从图中提取线路字段');
  await writeFile(facts,JSON.stringify({name:'核准线路字段',items:['number','title','station'].map(field=>({id:field,label:field,definition:'线路',field}))}));
  await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(definition(fields)));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'候选'}));
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run','--task','definition-extraction','--sample',join(resourcesDir,'images/test/quadrants.png'),
    '--brief',brief,'--resources',resourcesDir,...(baseline?['--content-baseline',facts]:[]),'--out',dir,'--key-env','RW_SELECTION_KEY','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),preset])],{cwd:repoRoot,env:{...process.env,RW_SELECTION_KEY:'offline'},windowsHide:true,stdio:'pipe',detached:process.platform!=='win32'});
  let errors='';child.stderr!.on('data',data=>errors+=String(data));const closed=once(child,'close');
  await waitJson(join(dir,'agent/checkpoint-observed.json'));
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
  }finally{await stop(job.child);await job.closed;}
});
