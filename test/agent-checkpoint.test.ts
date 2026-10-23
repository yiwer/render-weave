/** CLI 假执行器 + 真实 MCP：检查点的保存完成、强退与接续验收接缝。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, changeReview, applyAgentRound } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';
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
async function start(name: string) {
  const out=join(base,name),preset=join(base,`${name}-preset`);
  await mkdir(join(preset,'candidates'),{recursive:true});
  await writeFile(join(preset,'candidates/schema.json'),JSON.stringify(schema));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'线路号'}));
  return launch(out,preset,['--task','definition-extraction','--sample',join(resourcesDir,'images/test/quadrants.png'),
    '--brief',join(base,'brief.md'),'--resources',resourcesDir]);
}
function launch(out:string,preset:string,args:string[]) {
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run',...args,'--out',out,'--key-env','RW_CHECKPOINT_TEST_KEY','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),preset])],
    {cwd:repoRoot,env:{...process.env,RW_CHECKPOINT_TEST_KEY:'test-credential'},stdio:'pipe',windowsHide:true,detached:process.platform!=='win32'});
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
  const contenders=[launch(join(base,'contender-a'),preset,['--from',source.out,'--feedback',feedback]),
    launch(join(base,'contender-b'),preset,['--from',source.out,'--feedback',feedback])];
  try {
    await Promise.race([...contenders.map(job=>job.closed),new Promise((_,reject)=>setTimeout(()=>reject(new Error('两个恢复者都仍可写')),4000))]);
    const rejected=contenders.find(job=>job.child.exitCode!==null)!;
    expect(rejected.child.exitCode).toBe(2);
    const winner=contenders.find(job=>job!==rejected)!;
    await waitJson(join(winner.out,'agent/checkpoint-observed.json'));
    expect(rejected.errors()).toContain('恢复拥有者');
  } finally { for (const job of contenders) { await stop(job.child);await job.closed; } }
});
