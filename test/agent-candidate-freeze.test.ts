/** 候选冻结只从公开 CLI 观察文件身份与实际可执行产物。 */
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile,rename,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {repoRoot} from './support/fixtures.js';
import {runAgentTask,changeReview,applyAgentRound} from '../src/index.js';

let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rw-candidate-freeze-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
function execute(args:string[],cwd=repoRoot){
  return new Promise<{code:number|null;stdout:string;stderr:string}>(done=>{
    const child=spawn(process.execPath,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,RW_FREEZE_KEY:'offline-fixture-key'}});
    let stdout='',stderr='';child.stdout.on('data',value=>stdout+=value);child.stderr.on('data',value=>stderr+=value);
    child.on('close',code=>done({code,stdout,stderr}));
  });
}
const freeze=(args:string[])=>execute([join(repoRoot,'node_modules/tsx/dist/cli.mjs'),'scripts/agent-eval/freeze.ts',...args]);
const stage=(args:string[])=>execute([join(repoRoot,'node_modules/tsx/dist/cli.mjs'),'scripts/agent-eval/stage.ts',...args]);
async function killRound(child:ChildProcess,out:string){
  if(!child.pid||child.exitCode!==null)return;
  if(process.platform==='win32'){const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await once(killer,'close');}
  else{
    const state=JSON.parse(await readFile(join(out,'execution.json'),'utf8'));
    if(state.owner?.supervisorPid===child.pid&&Number.isSafeInteger(state.owner.pid)&&state.owner.pid>1){
      try{process.kill(-state.owner.pid,'SIGKILL');}catch{}
      for(let i=0;i<100;i++){try{process.kill(state.owner.pid,0);}catch{break;}await new Promise(resolve=>setTimeout(resolve,20));}
    }
    try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}
  }
}
it('宿主真实强退后没有round.json的完整检查点仍能绑定并通过原CLI接续',async()=>{
  const source=join(root,'killed-round'),preset=join(root,'killed-preset'),brief=join(root,'recovery-brief.md');
  await mkdir(join(preset,'candidates'),{recursive:true});await writeFile(brief,'提取线路号');
  const bytes=JSON.stringify({dslVersion:'renderweave-schema/1',name:'线路',fields:[{name:'number',displayName:'线路号',type:'text'}]});
  await writeFile(join(preset,'candidates/schema.json'),bytes);await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'完整检查点'}));
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run','--task','definition-extraction','--sample',join(repoRoot,'fixtures/resources/images/test/quadrants.png'),'--brief',brief,'--resources',join(repoRoot,'fixtures/resources'),'--out',source,'--key-env','RW_FREEZE_KEY','--claude',process.execPath,'--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),preset])],{cwd:repoRoot,windowsHide:true,detached:process.platform!=='win32',stdio:'pipe',env:{...process.env,RW_FREEZE_KEY:'offline-fixture-key'}});
  const closed=once(child,'close');let errors='';child.stderr!.on('data',chunk=>errors+=chunk);
  try{
    let observed;
    for(let i=0;i<600;i++){try{observed=JSON.parse(await readFile(join(source,'agent/checkpoint-observed.json'),'utf8'));break;}catch{}await new Promise(resolve=>setTimeout(resolve,20));}
    expect(observed,errors).toBeDefined();expect(JSON.parse(observed.reply.result.content[0].text).checkpoint.status).toBe('saved');
  }finally{await killRound(child,source);await closed;}
  await expect(readFile(join(source,'round.json'))).rejects.toMatchObject({code:'ENOENT'});
  const candidate=join(root,'recovery-candidate'),binding=join(root,'recovery-binding'),request=join(root,'recovery-request.json'),feedback=join(root,'recovery-feedback.md'),out=join(root,'recovered-round');
  await writeFile(feedback,'继续完整检查点');
  const executor=join(root,'recovery-executor.mjs'),fake=join(repoRoot,'test/support/fake-claude.mjs');
  await writeFile(executor,`import {pathToFileURL} from 'node:url';if(process.argv.includes('--version'))console.log('recovery/1');else{process.argv.splice(1,1,${JSON.stringify(fake)},'none');await import(pathToFileURL(${JSON.stringify(fake)}).href);}`);
  await writeFile(request,JSON.stringify({format:'renderweave-stage-request/1',unit:'recovery/run-1/attempt-2',materials:[{file:brief,sha256:`sha256:${createHash('sha256').update(await readFile(brief)).digest('hex')}`}],args:['--from',source,'--feedback',feedback,'--out',out,'--claude',process.execPath,'--claude-args',JSON.stringify([executor])]}));
  expect((await freeze(['--out',candidate])).code).toBe(0);
  const bound=await stage(['--bind',candidate,'--request',request,'--out',binding]);expect(bound.code,bound.stderr).toBe(0);
  const resumed=await stage(['--dispatch',binding,'--key-env','RW_FREEZE_KEY']);expect(resumed.code,resumed.stderr).toBe(1);
  expect(JSON.parse(await readFile(join(out,'round.json'),'utf8')).inputs.previous.checkpoint.source).toBe('hostRecovery');
  expect(await readFile(join(out,'agent/candidates/schema.json'),'utf8')).toBe(bytes);
},120000);
it('直接数据集阶段绑定人工应用后的工作区，变化在单次派发前拒绝且不自动审核或应用',async()=>{
  const candidate=join(root,'stage-candidate'),binding=join(root,'stage-binding'),workspace=join(root,'stage-workspace');
  const request=join(root,'stage-request.json'),approval=join(root,'approval.json'),out=join(root,'stage-round');
  const executor=join(root,'stage-executor.mjs'),ledger=join(root,'stage-dispatches.txt'),fake=join(repoRoot,'test/support/fake-claude.mjs');
  await writeFile(executor,`import {appendFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';if(process.argv.includes('--version'))console.log('direct-stage/1');else{await appendFile(${JSON.stringify(ledger)},'dispatch\\n');process.argv.splice(1,1,${JSON.stringify(fake)},'none');await import(pathToFileURL(${JSON.stringify(fake)}).href);}`);
  const preset=join(root,'stage-upstream-preset'),upstream=join(root,'stage-upstream');
  await mkdir(join(preset,'candidates'),{recursive:true});
  await writeFile(join(preset,'candidates/greeting.json'),JSON.stringify({dslVersion:'renderweave-schema/1',name:'问候',fields:[{name:'message',displayName:'问候语',type:'text'}]}));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/greeting.json'],pending:[],notes:'无模型夹具'}));
  await runAgentTask({task:'definition-extraction',sample:join(repoRoot,'fixtures/resources/images/test/quadrants.png'),brief:join(repoRoot,'scripts/agent-eval/scenarios/m402/brief-definition.md'),resources:join(repoRoot,'fixtures/resources'),out:upstream,key:'offline-fixture-key',keyEnv:'RW_FREEZE_KEY',claude:{command:process.execPath,args:[fake,preset]}});
  await changeReview(upstream,{type:'confirmRest',confirmed:true});
  await changeReview(upstream,{type:'approve'});
  await mkdir(workspace);
  const applied=await applyAgentRound({roundDir:upstream,workspace});
  expect(applied.applied,JSON.stringify(applied.problems)).toBeDefined();
  await writeFile(approval,'{"approvedPreparation":"independent-offline-test"}');
  const approved=`sha256:${createHash('sha256').update(await readFile(approval)).digest('hex')}`;
  const args=['--task','dataset-extraction','--definition','问候','--workspace',workspace,'--sample',join(repoRoot,'docs/examples/materials/m402-route-sign.jpg'),'--brief',join(repoRoot,'scripts/agent-eval/scenarios/m402/brief-definition.md'),'--resources',join(repoRoot,'fixtures/resources'),'--out',out,'--max-turns','40','--timeout-ms','60000','--stagnation-threshold','2','--claude',process.execPath,'--claude-args',JSON.stringify([executor])];
  await writeFile(request,JSON.stringify({format:'renderweave-stage-request/1',unit:'holdout-test/run-1/dataset/attempt-1',materials:[{file:approval,sha256:approved}],upstreamRounds:[upstream],args}));
  expect((await freeze(['--out',candidate])).code).toBe(0);
  const bound=await stage(['--bind',candidate,'--request',request,'--out',binding]);
  expect(bound.code,bound.stderr).toBe(0);
  const file=join(workspace,applied.applied!.published[0]!.files.find(file=>!file.includes('compiled'))!),before=await readFile(file);
  await writeFile(file,Buffer.concat([before,Buffer.from('\n')]));
  const rejected=await stage(['--dispatch',binding,'--key-env','RW_FREEZE_KEY']);
  expect(rejected.code).toBe(2);expect(rejected.stderr).toContain('workspace');
  await expect(readFile(ledger)).rejects.toMatchObject({code:'ENOENT'});
  await writeFile(file,before);
  const dispatched=await stage(['--dispatch',binding,'--key-env','RW_FREEZE_KEY']);
  expect(dispatched.code,dispatched.stderr).toBe(1);
  expect(await readFile(ledger,'utf8')).toBe('dispatch\n');
  expect(JSON.parse(await readFile(join(out,'round.json'),'utf8')).task).toBe('dataset-extraction');
  const proof=JSON.parse(await readFile(join(binding,'dispatch.json'),'utf8'));
  expect(proof).toMatchObject({format:'renderweave-stage-dispatch/1',unit:'holdout-test/run-1/dataset/attempt-1',candidate:expect.stringMatching(/^sha256:/),binding:expect.stringMatching(/^sha256:/),exitCode:1});
  expect(proof.files['round.json']).toMatch(/^sha256:/);
  await expect(readFile(join(out,'review.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(await readFile(file)).toEqual(before);
  const followup=JSON.parse(await readFile(request,'utf8'));followup.upstreamRounds=[out];
  await writeFile(request,JSON.stringify(followup));
  const unapproved=await stage(['--bind',candidate,'--request',request,'--out',join(root,'unapproved-stage')]);
  expect(unapproved.code).toBe(2);expect(unapproved.stderr).toContain('应用');
  followup.upstreamRounds=[upstream];await writeFile(request,JSON.stringify(followup));
  const target=join(root,'external-schema.json');await rename(file,target);await symlink(target,file,'file');
  const linked=await stage(['--bind',candidate,'--request',request,'--out',join(root,'linked-stage')]);
  expect(linked.code).toBe(2);expect(linked.stderr).toContain('链接');
},120000);
it('候选内容目录不能换成指向工作目录的链接，即使当前字节相同也拒绝',async()=>{
  const candidate=join(root,'linked-candidate');
  expect((await freeze(['--out',candidate])).code).toBe(0);
  await rename(join(candidate,'content/agent'),join(candidate,'content/agent-original'));
  await symlink(join(repoRoot,'agent'),join(candidate,'content/agent'),process.platform==='win32'?'junction':'dir');
  const result=await freeze(['--verify',candidate]);
  expect(result.code).toBe(2);expect(result.stderr).toContain('链接');
});
it('冻结实际构建、资料、合同和依赖字节，包内 CLI 可独立加载且不能覆盖',async()=>{
  const out=join(root,'candidate');
  const result=await freeze(['--out',out]);
  expect(result.code,result.stderr).toBe(0);
  const manifest=JSON.parse(await readFile(join(out,'candidate.json'),'utf8'));
  expect(manifest).toMatchObject({format:'renderweave-candidate/1',id:expect.stringMatching(/^sha256:/),identity:{mcpContract:'0.17.0',defaults:{contextPolicy:'full',stagnationThreshold:2},providerRevision:null}});
  for(const path of ['dist/bin.js','agent/reference/outcome.md','node_modules/canvaskit-wasm/bin/full/canvaskit.wasm']){
    expect(await readFile(join(out,'content',path))).toEqual(await readFile(join(repoRoot,path)));
    expect(manifest.identity.files[path]).toMatch(/^sha256:/);
  }
  const help=await execute([join(out,'content/dist/bin.js'),'resources-init','--resources',join(root,'new-resources')],join(out,'content'));
  expect(help.code,help.stderr).toBe(0);
  expect(help.stdout).not.toContain('ERR_MODULE_NOT_FOUND');
  const again=await freeze(['--out',out]);
  expect(again.code).not.toBe(0);
  expect(JSON.parse(await readFile(join(out,'candidate.json'),'utf8')).id).toBe(manifest.id);
});
it('工作目录重新构建或修改资料不会改变已冻结包，当前内容不匹配时列出差异',async()=>{
  const working=join(root,'working-copy'),out=join(root,'unchanging-package');
  expect((await freeze(['--out',working])).code).toBe(0);
  const cwd=join(working,'content');
  const command=(args:string[])=>execute([join(cwd,'node_modules/tsx/dist/cli.mjs'),'scripts/agent-eval/freeze.ts',...args],cwd);
  const created=await command(['--out',out]);
  expect(created.code,created.stderr).toBe(0);
  const source='agent/reference/outcome.md',build='dist/bin.js';
  const original=await readFile(join(out,'content',source));
  await writeFile(join(cwd,source),'已修改的工作资料');
  await writeFile(join(cwd,build),(await readFile(join(cwd,build),'utf8'))+'\n// 本地重新构建\n');
  expect(await readFile(join(out,'content',source))).toEqual(original);
  const saved=await command(['--verify',out]);
  expect(saved.code,saved.stderr).toBe(0);
  const changed=await command(['--verify',out,'--current']);
  expect(changed.code).toBe(2);
  expect(changed.stderr).toContain(source);
  expect(changed.stderr).toContain(build);
},120000);
it('冻结后修改资料产生新候选身份，并从旧计划明确列出必须重验的全部单元',async()=>{
  const working=join(root,'revision-working'),old=join(root,'revision-old'),next=join(root,'revision-next');
  const configFile=join(root,'revision-config.json'),executor=join(root,'revision-version.mjs');
  await writeFile(executor,"if(process.argv.includes('--version'))console.log('revision-only/1');else throw new Error('不得调用模型');");
  const original=JSON.parse(await readFile(join(repoRoot,'scripts/agent-eval/config.json'),'utf8'));
  const scenario=original.scenarios.find((value:{id:string})=>value.id==='m402-definition');
  await writeFile(configFile,JSON.stringify({...original,resources:join(repoRoot,'fixtures/resources'),scenarios:[{...scenario,sample:join(repoRoot,scenario.sample),brief:join(repoRoot,scenario.brief)}]}));
  expect((await freeze(['--out',working])).code).toBe(0);
  const cwd=join(working,'content');
  const command=(args:string[])=>execute([join(cwd,'node_modules/tsx/dist/cli.mjs'),'scripts/agent-eval/freeze.ts',...args],cwd);
  const args=['--config',configFile,'--claude',process.execPath,'--claude-args',JSON.stringify([executor])];
  expect((await command(['--out',old])).code).toBe(0);
  const oldBinding=join(root,'revision-old-binding'),newBinding=join(root,'revision-new-binding');
  const bound=await command(['--bind',old,'--out',oldBinding,...args]);expect(bound.code,bound.stderr).toBe(0);
  const before=await readFile(join(old,'candidate.json'),'utf8');
  const path=join(cwd,'agent/reference/outcome.md');await writeFile(path,(await readFile(path,'utf8'))+'\n追加已核准说明。\n');
  expect((await command(['--out',next])).code).toBe(0);
  const rebound=await command(['--bind',next,'--out',newBinding,'--previous-binding',oldBinding,...args]);
  expect(rebound.code,rebound.stderr).toBe(0);
  const result=JSON.parse(await readFile(join(newBinding,'binding.json'),'utf8'));
  expect(result.candidate.id).not.toBe(JSON.parse(before).id);
  expect(result.revalidation).toMatchObject({previousBinding:JSON.parse(await readFile(join(oldBinding,'binding.json'),'utf8')).id,previousCandidate:JSON.parse(before).id});
  expect(result.revalidation.changed).toContain('candidate.files.agent/reference/outcome.md');
  expect(result.revalidation.units).toEqual([{scenario:'m402-definition',repetition:1,stage:'definition'},{scenario:'m402-definition',repetition:2,stage:'definition'}]);
  expect(await readFile(join(old,'candidate.json'),'utf8')).toBe(before);
},120000);
it('同一共同候选分别绑定不同计划，原始评分配置另存而不锁死校准输入',async()=>{
  const candidate=join(root,'shared-candidate'),executor=join(root,'version-only.mjs');
  await writeFile(executor,"if(process.argv.includes('--version'))console.log('binding-only/1');else throw new Error('不得调用模型');");
  expect((await freeze(['--out',candidate])).code).toBe(0);
  const original=JSON.parse(await readFile(join(repoRoot,'scripts/agent-eval/config.json'),'utf8'));
  const bindings=[];
  for(const id of ['m402-definition','m402-template']){
    const configFile=join(root,`${id}.json`),out=join(root,`${id}-binding`);
    const config={...original,scenarios:original.scenarios.filter((scenario:{id:string})=>scenario.id===id)};
    const bytes=JSON.stringify(config);await writeFile(configFile,bytes);
    const result=await freeze(['--bind',candidate,'--out',out,'--config',configFile,'--claude',process.execPath,'--claude-args',JSON.stringify([executor])]);
    expect(result.code,result.stderr).toBe(0);
    const binding=JSON.parse(await readFile(join(out,'binding.json'),'utf8'));bindings.push(binding);
    expect(await readFile(join(out,'config.json'),'utf8')).toBe(bytes);
    config.scenarios[0].pass.expertFields=0;await writeFile(configFile,JSON.stringify(config));
    expect(await readFile(join(out,'config.json'),'utf8')).toBe(bytes);
  }
  expect(bindings[0].candidate.id).toBe(bindings[1].candidate.id);
  expect(bindings[0].id).not.toBe(bindings[1].id);
  expect(bindings[0].identity.inputs['m402-definition/sample']).toMatch(/^sha256:/);
  expect(bindings[1].identity.inputs['m402-template/sample']).toMatch(/^sha256:/);
  expect(bindings[1].identity.inputs['m402-definition/sample']).toBeUndefined();
},120000);
it('计划绑定同一候选后实际派发，改变计划输入在模型启动前拒绝且不改旧记录',async()=>{
  const candidate=join(root,'dispatch-candidate'),binding=join(root,'binding'),configFile=join(root,'config.json');
  const ledger=join(root,'dispatches.txt'),executor=join(root,'executor.mjs');
  const fake=join(repoRoot,'test/support/fake-claude.mjs');
  await writeFile(executor,`import {appendFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';
if(process.argv.includes('--version'))console.log('candidate-test-executor/1');else{await appendFile(${JSON.stringify(ledger)},'dispatch\\n');process.argv.splice(1,1,${JSON.stringify(fake)},'none');await import(pathToFileURL(${JSON.stringify(fake)}).href);}`);
  const config=JSON.parse(await readFile(join(repoRoot,'scripts/agent-eval/config.json'),'utf8'));
  await writeFile(configFile,JSON.stringify(config));
  expect((await freeze(['--out',candidate])).code).toBe(0);
  const args=['--config',configFile,'--scenarios','m402-definition','--repeat','2','--jobs','1','--claude',process.execPath,'--claude-args',JSON.stringify([executor])];
  const bound=await freeze(['--bind',candidate,'--out',binding,...args]);
  expect(bound.code,bound.stderr).toBe(0);
  const saved=await readFile(join(binding,'binding.json'),'utf8');
  expect(JSON.parse(saved)).toMatchObject({format:'renderweave-candidate-binding/1',candidate:{id:expect.stringMatching(/^sha256:/)},identity:{runtime:{providerRevision:null},budgets:{stagnation:2}},units:[{scenario:'m402-definition',repetition:1,stage:'definition'},{scenario:'m402-definition',repetition:2,stage:'definition'}]});
  const font=JSON.parse(saved).resourceEvidence?.['font-hei-regular'];
  expect(font).toMatchObject({file:expect.any(String),sha256:expect.stringMatching(/^sha256:/)});
  expect(await readFile(join(binding,font.file))).toEqual(await readFile(join(repoRoot,'fixtures/resources/fonts/SourceHanSansCN-Regular.otf')));
  const run=(label:string)=>execute([join(repoRoot,'node_modules/tsx/dist/cli.mjs'),'scripts/agent-eval/run.ts',...args,'--candidate-binding',binding,'--repetitions','1-1','--label',label,'--out',join(root,label),'--reports',join(root,'reports'),'--key-env','RW_FREEZE_KEY']);
  const first=await run('matched');
  expect(first.code,first.stderr).toBe(1);
  expect(await readFile(ledger,'utf8')).toBe('dispatch\n');
  expect(JSON.parse(await readFile(join(root,'matched/eval.json'),'utf8')).candidateBinding).toMatchObject({id:JSON.parse(saved).id,candidateId:JSON.parse(saved).candidate.id});
  const originalConfig=await readFile(configFile);config.scenarios[0].pass.expertFields=1;await writeFile(configFile,JSON.stringify(config));
  const mismatch=await run('mismatch');
  expect(mismatch.code).toBe(2);expect(mismatch.stderr).toContain('config');
  expect(await readFile(ledger,'utf8')).toBe('dispatch\n');
  expect(await readFile(join(binding,'binding.json'),'utf8')).toBe(saved);
  await writeFile(configFile,originalConfig);
  await writeFile(join(binding,font.file),'已损坏的封存字体');
  const corrupted=await run('corrupted-resource');
  expect(corrupted.code).toBe(2);expect(corrupted.stderr).toContain('绑定资源');
  expect(await readFile(ledger,'utf8')).toBe('dispatch\n');
  await writeFile(join(binding,font.file),await readFile(join(repoRoot,'fixtures/resources/fonts/SourceHanSansCN-Regular.otf')));
  await rename(join(binding,'resources'),join(binding,'resources-original'));
  await symlink(join(binding,'resources-original'),join(binding,'resources'),process.platform==='win32'?'junction':'dir');
  const linked=await run('linked-resource');
  expect(linked.code).toBe(2);expect(linked.stderr).toContain('绑定资源');
  expect(await readFile(ledger,'utf8')).toBe('dispatch\n');
},120000);
