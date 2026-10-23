/** CLI 假执行器 + 真实 MCP：检查点的保存完成、强退与接续验收接缝。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview } from '../src/index.js';
import { repoRoot, resourcesDir } from './support/fixtures.js';
let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-checkpoint-')); await writeFile(join(base, 'brief.md'), '提取线路号'); });
afterAll(async () => { await rm(base, {recursive:true,force:true}); });
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
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run','--task','definition-extraction','--sample',join(resourcesDir,'images/test/quadrants.png'),
    '--brief',join(base,'brief.md'),'--resources',resourcesDir,'--out',out,'--key-env','RW_CHECKPOINT_TEST_KEY','--claude',process.execPath,
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
