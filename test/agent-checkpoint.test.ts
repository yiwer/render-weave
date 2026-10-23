/** CLI 假执行器 + 真实 MCP：检查点的保存完成、强退与接续验收接缝。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, readPreviousRound, changeReview, applyAgentRound } from '../src/index.js';
import { repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-checkpoint-')); await writeFile(join(base, 'brief.md'), '提取线路号'); });
afterAll(async () => { await rm(base, {recursive:true,force:true,maxRetries:20,retryDelay:100}); });
const schema = {dslVersion:'renderweave-schema/1',name:'线路',fields:[{name:'number',displayName:'线路号',type:'text'}]};
async function waitJson(file: string): Promise<any> {
  for (let i=0;i<600;i++) { try { return JSON.parse(await readFile(file,'utf8')); } catch {} await new Promise(resolve => setTimeout(resolve,20)); }
  throw new Error(`没有等到 ${file}`);
}
async function stop(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') { const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}); await once(kill,'close'); }
  else { try { process.kill(-child.pid,'SIGKILL'); } catch { child.kill('SIGKILL'); } }
}
async function start(name: string, definition:unknown=schema, fault?:string, candidate='candidates/schema.json') {
  const out=join(base,name),preset=join(base,`${name}-preset`);
  await mkdir(join(preset,'candidates'),{recursive:true});
  await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(definition));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:[candidate],pending:[],notes:'线路号'}));
  return launch(out,preset,['--task','definition-extraction','--sample',join(resourcesDir,'images/test/quadrants.png'),
    '--brief',join(base,'brief.md'),'--resources',resourcesDir],fault);
}
function launch(out:string,preset:string,args:string[],fault?:string) {
  const child=spawn(process.execPath,[...(fault?['--import',pathToFileURL(join(repoRoot,'test/support/checkpoint-fault.mjs')).href]:[]),join(repoRoot,'dist/bin.js'),'agent','run',...args,'--out',out,'--key-env','RW_CHECKPOINT_TEST_KEY','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),preset])],
    {cwd:repoRoot,env:{...process.env,RW_CHECKPOINT_TEST_KEY:'test-credential',...(fault?{RW_CHECKPOINT_FAULT:fault,RW_CHECKPOINT_FAULT_OUT:out}:{})},stdio:'pipe',windowsHide:true,detached:process.platform!=='win32'});
  let errors='';child.stderr!.on('data',data=>{errors+=String(data);}); const closed=once(child,'close');
  return {out,child,closed,errors:()=>errors};
}
it('真实MCP的完整成果检查返回宿主保存完成信号，读取入口可核对该检查点', async () => {
  const job=await start('saved');
  try {
    const observed=await waitJson(join(job.out,'agent/checkpoint-observed.json'));
    const result=JSON.parse(observed.reply.result.content[0].text);
    expect(result.checkpoint,job.errors()).toMatchObject({status:'saved',id:expect.any(String),contentIdentity:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(observed.hasBridgeSecret).toBe(false);
    expect(observed.tools.result.tools.every((tool:any)=>tool.annotations.readOnlyHint)).toBe(true);
    expect((await readReview(job.out)).checkpoint).toMatchObject({id:result.checkpoint.id,source:'hostRecovery'});
  } finally { await stop(job.child); await job.closed; }
});
it('沿用成果清单的合法相对路径写法，保存实际被检查候选', async () => {
  const job=await start('relative-path',schema,undefined,'./candidates/schema.json');
  try {
    const result=JSON.parse((await waitJson(join(job.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text);
    expect(result.checkpoint.status).toBe('saved');
    expect((await readReview(job.out)).checkpoint?.files).toHaveProperty('agent/candidates/schema.json');
  } finally { await stop(job.child);await job.closed; }
});
it('接续前核对旧轮次固定资料，说明或参考图被改动时拒绝继承', async () => {
  const job=await start('changed-materials');
  try { await waitJson(join(job.out,'agent/checkpoint-observed.json')); }
  finally { await stop(job.child);await job.closed; }
  expect((await readPreviousRound(job.out)).checkpoint).toBeDefined();
  for(const path of ['logs/materials/brief.md','logs/sample.png']) {
    const file=join(job.out,path),original=await readFile(file);
    await writeFile(file,'changed fixed material');
    await expect(readPreviousRound(job.out)).rejects.toThrow('固定资料');
    await writeFile(file,original);
  }
});

async function checkAgain(out:string,id:number) {
  await writeFile(join(out,'agent/checkpoint-action.json'),JSON.stringify({id}));
  const reply=await waitJson(join(out,`agent/checkpoint-observed-${id}.json`));
  return JSON.parse(reply.result.content[0].text);
}
it('结构完整但业务不合格仍保存；半写、缺文件及未检查写入保留上一完整检查点', async () => {
  const invalid={...schema,fields:[{...schema.fields[0],constraints:{minLength:8,maxLength:2}}]};
  const job=await start('blocked',invalid);
  try {
    const result=JSON.parse((await waitJson(join(job.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text);
    expect(result.verdict).toBe('unqualified');expect(result.checkpoint.status).toBe('saved');
    const first=result.checkpoint.id;
    await writeFile(join(job.out,'agent/candidates/schema.json'),'{');
    expect((await checkAgain(job.out,1)).checkpoint.status).toBe('notSaved');
    expect((await readReview(job.out)).checkpoint?.id).toBe(first);
    await writeFile(join(job.out,'agent/outcome.json'),JSON.stringify({candidates:['candidates/missing.json'],pending:[],notes:'缺文件'}));
    expect((await checkAgain(job.out,2)).checkpoint.reason).toContain('完整');
    await writeFile(join(job.out,'agent/outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'修复'}));
    await writeFile(join(job.out,'agent/candidates/schema.json'),JSON.stringify(schema));
    expect((await readReview(job.out)).checkpoint?.id).toBe(first);
    const updated=await checkAgain(job.out,3);expect(updated.checkpoint.status).toBe('saved');expect(updated.checkpoint.id).not.toBe(first);
    const record=(await readReview(job.out)).checkpoint!;
    await writeFile(join(job.out,'checkpoints',record.id,'agent/candidates/schema.json'),'{}');
    const corrupt=await readReview(job.out);expect(corrupt.checkpoint).toBeUndefined();expect(corrupt.problems[0]?.message).toContain('检查点');
  } finally { await stop(job.child);await job.closed; }
});

it('整组模板检查固定主模板与被调模板，缺依赖不覆盖且单份编辑不能自动替代', async () => {
  const name='templates',out=join(base,name),preset=join(base,`${name}-preset`),workspace=join(base,'template-workspace');
  await cp(singleTextDir,workspace,{recursive:true});await mkdir(join(preset,'candidates'),{recursive:true});
  const artboard={sizeRange:{width:{min:10,max:200},height:{min:10,max:100}},layout:{mode:'free'},children:[] as unknown[]};
  const child={dslVersion:'renderweave-template/1',name:'子模板',base:{name:'问候',version:1},artboard};
  const main={...child,name:'主模板',artboard:{...artboard,children:[{type:'call',name:'调用',template:'子模板',data:'current',place:{left:0,top:0,width:{fixed:50},height:{fixed:30}}}]}};
  const manifest={candidates:['candidates/main.json','candidates/child.json'],pending:[],notes:'整组模板'};
  for(const [path,value] of Object.entries({'outcome.json':manifest,'candidates/main.json':main,'candidates/child.json':child}))await writeFile(join(preset,path),JSON.stringify(value));
  const request=join(base,'template-request.json');await writeFile(request,JSON.stringify({template:'主模板',dataset:{id:'ds-greeting'},parameters:{},output:{width:100,height:40,dpi:50,format:'png'},mode:'final'}));
  const job=launch(out,preset,['--task','template-design','--sample',join(resourcesDir,'images/test/quadrants.png'),'--brief',join(base,'brief.md'),'--resources',resourcesDir,
    '--workspace',workspace,'--dataset','ds-greeting','--request',request]);
  try {
    const observed=await waitJson(join(out,'agent/checkpoint-observed.json'));
    const saved=JSON.parse(observed.reply.result.content[0].text);
    expect(JSON.parse(observed.comparison.result.content[0].text).reportId).toBe(saved.assessment.visual.reportId);
    expect(saved.checkpoint.status,JSON.stringify(saved)).toBe('saved');
    const first=(await readReview(out)).checkpoint!;
    expect(Object.keys(first.files)).toEqual(expect.arrayContaining(['agent/candidates/main.json','agent/candidates/child.json']));
    await writeFile(join(out,'agent/candidates/main.json'),JSON.stringify({...main,artboard:{...main.artboard,fill:'#FFFF00'}}));
    expect((await readReview(out)).checkpoint?.id).toBe(first.id);
    await writeFile(join(out,'agent/candidates/child.json'),JSON.stringify({...child,artboard:{...child.artboard,fill:'#FF0000'}}));
    expect((await readReview(out)).checkpoint?.id).toBe(first.id);
    const next=await checkAgain(out,1);expect(next.checkpoint.status).toBe('saved');expect(next.checkpoint.id).not.toBe(first.id);
    await writeFile(join(out,'agent/outcome.json'),JSON.stringify({...manifest,candidates:['candidates/main.json']}));
    const missing=await checkAgain(out,2);expect(missing.checkpoint.status).toBe('notSaved');expect(missing.checkpoint.reason).toContain('依赖');
    expect((await readReview(out)).checkpoint?.id).toBe(next.checkpoint.id);
    await stop(job.child);await job.closed;
    const feedback=join(base,'templates-feedback.md');await writeFile(feedback,'继续整组模板');
    const nextPreset=join(base,'templates-next-preset');await mkdir(nextPreset);await writeFile(join(nextPreset,'outcome.json'),JSON.stringify(manifest));
    const resumed=launch(join(base,'templates-next'),nextPreset,['--from',out,'--feedback',feedback]);
    try {
      const seeds=await waitJson(join(resumed.out,'agent/checkpoint-seeds.json'));
      expect(JSON.parse(seeds['main.json']).artboard.fill).toBe('#FFFF00');
      expect(JSON.parse(seeds['child.json']).artboard.fill).toBe('#FF0000');
      const observed=await waitJson(join(resumed.out,'agent/checkpoint-observed.json'));
      const checked=JSON.parse(observed.reply.result.content[0].text);
      const reportId=JSON.parse(observed.comparison.result.content[0].text).reportId;
      expect(checked.checkpoint.status).toBe('saved');expect(checked.assessment.visual.reportId).toBe(reportId);
      await writeFile(join(resumed.out,'agent/continue'),'');await resumed.closed;
      const final=await waitJson(join(resumed.out,'check.json'));
      expect(final.contentIdentity.id).toBe(checked.contentIdentity.id);expect(final.assessment.visual.reportId).toBe(reportId);
    } finally { await stop(resumed.child);await resumed.closed; }
  } finally { await stop(job.child);await job.closed; }
});
it('保存完成后强退宿主，只从被检查字节开新轮次；残片不能批准或应用', async () => {
  const job=await start('resume-source');
  const observed=await waitJson(join(job.out,'agent/checkpoint-observed.json'));
  const saved=JSON.parse(observed.reply.result.content[0].text).checkpoint;
  await writeFile(join(job.out,'agent/candidates/schema.json'),'{"unexamined":true}');
  await stop(job.child); await job.closed;
  const state=await readReview(job.out);
  expect(state.execution?.status).toBe('interrupted');
  expect(state.checkpoint?.id).toBe(saved.id);
  const oldState=await readFile(join(job.out,'execution.json'),'utf8');
  expect((await changeReview(job.out,{type:'approve'})).problems.length).toBeGreaterThan(0);
  expect((await applyAgentRound({roundDir:job.out})).problems.length).toBeGreaterThan(0);
  await writeFile(join(base,'feedback.md'),'按检查过的线路定义继续');
  const preset=join(base,'resume-preset');await mkdir(preset);
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'继续'}));
  const resumed=launch(join(base,'resumed'),preset,['--from',job.out,'--feedback',join(base,'feedback.md')]);
  try {
    const seeds=await waitJson(join(resumed.out,'agent/checkpoint-seeds.json'));
    expect(seeds['schema.json']).toBe(JSON.stringify(schema));
    await waitJson(join(resumed.out,'agent/checkpoint-observed.json'));
    await writeFile(join(resumed.out,'agent/continue'),'');
    await resumed.closed;
    const result=await readReview(resumed.out);
    expect(result.execution?.committed,resumed.errors()).toBe(true);
    expect(result.view?.round.chain[0]).toMatchObject({round:1,applied:false});
    expect(result.view?.round.chain[0]?.missing).not.toBe(true);
    expect(result.view?.round.chain[0]).not.toHaveProperty('verdict');
    expect(result.execution?.start?.inputs.previous).toMatchObject({dir:job.out,round:1,checkpoint:{id:saved.id,contentIdentity:saved.contentIdentity,source:'hostRecovery'}});
    expect(await readFile(join(job.out,'execution.json'),'utf8')).toBe(oldState);
  } finally { await stop(resumed.child); }
});
it('存活原执行器不能接管；同一中断轮次的并发恢复者至多一个开始执行', async () => {
  const source=await start('competition-source');
  await waitJson(join(source.out,'agent/checkpoint-observed.json'));
  const preset=join(base,'competition-preset');await mkdir(preset);
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'恢复'}));
  const feedback=join(base,'competition-feedback.md');await writeFile(feedback,'继续');
  const active=launch(join(base,'active-refused'),preset,['--from',source.out,'--feedback',feedback]);
  await active.closed;expect(active.child.exitCode).toBe(2);
  await stop(source.child);await source.closed;
  const originalState=await readFile(join(source.out,'execution.json'),'utf8');
  const unknown=JSON.parse(originalState);unknown.owner.host='unknown-host';
  await writeFile(join(source.out,'execution-owner.json'),JSON.stringify(unknown.owner));
  await writeFile(join(source.out,'execution.json'),JSON.stringify(unknown));
  const unconfirmed=launch(join(base,'unknown-refused'),preset,['--from',source.out,'--feedback',feedback]);
  await unconfirmed.closed;expect(unconfirmed.child.exitCode).toBe(2);
  await writeFile(join(source.out,'execution-owner.json'),JSON.stringify(JSON.parse(originalState).owner));
  await writeFile(join(source.out,'execution.json'),originalState);
  const contenders=[launch(join(base,'contender-a'),preset,['--from',source.out,'--feedback',feedback]),
    launch(join(base,'contender-b'),preset,['--from',source.out,'--feedback',feedback])];
  try {
    await Promise.race([...contenders.map(job=>job.closed),new Promise((_,reject)=>setTimeout(()=>reject(new Error('两个恢复者都仍可写')),4000))]);
    const rejected=contenders.find(job=>job.child.exitCode!==null)!;
    expect(rejected.child.exitCode).toBe(2);
    const winner=contenders.find(job=>job!==rejected)!;
    await waitJson(join(winner.out,'agent/checkpoint-observed.json'));
    expect(rejected.errors()).toContain('恢复拥有者');
    await stop(winner.child);await winner.closed;
    const retry=launch(join(base,'contender-retry'),preset,['--from',source.out,'--feedback',feedback]);
    try { await waitJson(join(retry.out,'agent/checkpoint-observed.json')); }
    finally { await stop(retry.child);await retry.closed; }
  } finally { for (const job of contenders) { await stop(job.child);await job.closed; } }
});
it('业务受阻的完整检查点能够接续，新轮次仍保留不合格结论', async () => {
  const invalid={...schema,fields:[{...schema.fields[0],constraints:{minLength:8,maxLength:2}}]};
  const job=await start('blocked-resume',invalid);
  try {
    await waitJson(join(job.out,'agent/checkpoint-observed.json'));await stop(job.child);await job.closed;
    const feedback=join(base,'blocked-resume-feedback.md');await writeFile(feedback,'保留待修复内容');
    const preset=join(base,'blocked-resume-next-preset');await mkdir(preset);
    await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'继续'}));
    const next=launch(join(base,'blocked-resume-next'),preset,['--from',job.out,'--feedback',feedback]);
    try {
      expect((await waitJson(join(next.out,'agent/checkpoint-seeds.json')))['schema.json']).toBe(JSON.stringify(invalid));
      const result=JSON.parse((await waitJson(join(next.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text);
      expect(result).toMatchObject({verdict:'unqualified',checkpoint:{status:'saved'}});
      await writeFile(join(next.out,'agent/continue'),'');await next.closed;
      expect((await readReview(next.out)).execution?.committed).toBe(true);
    } finally { await stop(next.child); }
  } finally { await stop(job.child); }
});
it('候选读取期间变化不发布；无完整检查点的中断轮次拒绝残片接续', async () => {
  const job=await start('read-race',schema,'reading');
  try {
    const result=JSON.parse((await waitJson(join(job.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text);
    expect(result.checkpoint).toMatchObject({status:'notSaved',reason:expect.stringContaining('发生变化')});
    await stop(job.child);await job.closed;
    expect((await readReview(job.out)).checkpoint).toBeUndefined();
    const feedback=join(base,'read-race-feedback.md');await writeFile(feedback,'继续');
    const rejected=launch(join(base,'read-race-next'),join(base,'read-race-preset'),['--from',job.out,'--feedback',feedback]);
    await rejected.closed;expect(rejected.child.exitCode).toBe(2);expect(rejected.errors()).toContain('没有可核对的完整检查点');
  } finally { await stop(job.child); }
});
it.each(['publish-second','final'])('%s 边界强退只恢复已发布可验证的集合', async fault => {
  const job=await start(`fault-${fault}`,schema,fault);
  try {
    const first=JSON.parse((await waitJson(join(job.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text).checkpoint;
    if (fault==='publish-second') {
      await writeFile(join(job.out,'agent/candidates/schema.json'),JSON.stringify({...schema,name:'第二份定义'}));
      await writeFile(join(job.out,'agent/checkpoint-action.json'),JSON.stringify({id:1}));
    } else await writeFile(join(job.out,'agent/continue'),'');
    await waitJson(join(job.out,'fault-ready.json'));
    await stop(job.child);await job.closed;
    const recovered=await readReview(job.out);
    expect(recovered.execution).toMatchObject({status:'interrupted',committed:false});
    expect(recovered.checkpoint?.contentIdentity).toBe(first.contentIdentity);
    if(fault==='publish-second')expect(recovered.checkpoint?.id).toBe(first.id);
    else expect(recovered.checkpoint?.id).not.toBe(first.id);
    const feedback=join(base,`${fault}-feedback.md`);await writeFile(feedback,'继续');
    const preset=join(base,`${fault}-next-preset`);await mkdir(preset);
    await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'继续'}));
    const next=launch(join(base,`${fault}-next`),preset,['--from',job.out,'--feedback',feedback]);
    try { expect((await waitJson(join(next.out,'agent/checkpoint-seeds.json')))['schema.json']).toBe(JSON.stringify(schema)); }
    finally { await stop(next.child);await next.closed; }
  } finally { await stop(job.child); }
});
it('终检发布后工作副本发生新写入，正式成果仍复制终检消费的字节', async () => {
  const job=await start('final-edit',schema,'final-edit');
  try {
    await waitJson(join(job.out,'agent/checkpoint-observed.json'));await writeFile(join(job.out,'agent/continue'),'');await job.closed;
    const result=await readReview(job.out);
    expect(result.problems).toEqual([]);expect(result.view?.round.source).toBe('agent');
    expect(await readFile(join(job.out,'candidates/schema.json'),'utf8')).toBe(JSON.stringify(schema));
  } finally { await stop(job.child); }
});
it('终检固定期间发生写入，拒绝正式交回并保留上一完整检查点', async () => {
  const job=await start('reading-final',schema,'reading-final');
  try {
    const first=JSON.parse((await waitJson(join(job.out,'agent/checkpoint-observed.json'))).reply.result.content[0].text).checkpoint;
    await writeFile(join(job.out,'agent/continue'),'');await job.closed;
    const result=await readReview(job.out);
    expect(result.checkpoint?.id).toBe(first.id);
    expect(result.view?.round.source).toBe('hostRecovery');
    expect((await waitJson(join(job.out,'check.json'))).verdict).toBe('unqualified');
    await expect(readFile(join(job.out,'outcome.json'))).rejects.toMatchObject({code:'ENOENT'});
  } finally { await stop(job.child); }
});
