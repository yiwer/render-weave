
import {afterAll, beforeAll, expect, it} from 'vitest';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCli} from '../src/cli.js';
import {mkdir, readFile} from 'node:fs/promises';
import {changeReview, applyAgentRound, runAgentTask, initializeResourceStore, importResources} from '../src/index.js';
import {copyWorkspaceFixture, singleTextDir, resourcesDir, repoRoot, greetingRequest} from './support/fixtures.js';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {runScenario, type Launcher} from '../scripts/agent-eval/eval.js';
import {readConfig} from '../scripts/agent-eval/scenarios.js';
import {pathToFileURL} from 'node:url';

let root: string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rw-order-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
async function cli(args:string[]) {
  let stdout='',stderr=''; const code=await runCli(args,{stdout:value=>stdout+=value,stderr:value=>stderr+=value});
  return {code,stdout,stderr,value:()=>JSON.parse(stdout)};
}
async function initialize(name:string, orders:unknown[], pricing?:unknown) {
  const scope=join(root,name+'.json'), out=join(root,name);
  await writeFile(scope,JSON.stringify({format:'renderweave-order-scope/1',id:name,orders,...(pricing?{pricing}:{})}));
  const result=await cli(['agent','order-init','--scope',scope,'--out',out]);
  expect(result.code,result.stderr).toBe(0); return out;
}
it('预先固定完整订单范围，未运行计划不算尝试或成功，零成功订单的单位成本未定义',async()=>{
  const out=await initialize('empty',[{id:'a',plans:[{id:'design',task:'template-design',root:join(root,'a-rounds')}],deliveries:[]},
    {id:'b',plans:[{id:'design',task:'template-design',root:join(root,'b-rounds')}],deliveries:[]}]);
  const result=await cli(['agent','order-report','--order',out]);
  expect(result.code,result.stderr).toBe(0);
  expect(result.value().counts).toEqual({orders:2,plans:2,attempts:0,successfulOrders:0});
  expect(result.value().costPerSuccessfulOrder).toBeNull();
  expect(result.value().orders.map((o:any)=>o.status)).toEqual(['not-run','not-run']);
  const repeat=await cli(['agent','order-init','--scope',join(root,'empty.json'),'--out',out]);
  expect(repeat.code).toBe(1);
});
async function setup(name:string, pending=false, extra:unknown[]=[], pricing?:unknown){
  const dir=join(root,name+'-data'), workspace=join(dir,'workspace'), preset=join(dir,'preset'), rounds=join(dir,'rounds');
  await copyWorkspaceFixture(singleTextDir,workspace);await mkdir(join(preset,'candidates'),{recursive:true});
  const template={dslVersion:'renderweave-template/1',name:'订单牌',base:{name:'问候',version:1},artboard:{sizeRange:{width:{min:160,max:160},height:{min:40,max:40}},fill:'#FF0000',layout:{mode:'free'},children:[]}};
  await writeFile(join(preset,'candidates/template.json'),JSON.stringify(template));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/template.json'],pending:pending?[{file:'candidates/template.json',reason:'inferred',note:'背景待审核'}]:[],notes:'private-customer-secret'}));
  const brief=join(dir,'brief.md');await writeFile(brief,'测试订单');
  const request=greetingRequest({template:'订单牌'});await writeFile(join(dir,'request.json'),JSON.stringify(request));
  const scope=await initialize(name,[{id:'order-a',plans:[{id:'design',task:'template-design',root:rounds}],deliveries:[{id:'image-a',plan:'design',request}]},...extra],pricing);
  const run=await runAgentTask({task:'template-design',sample:join(resourcesDir,'images/test/quadrants.png'),brief,workspace,resources:resourcesDir,dataset:'ds-greeting',request:join(dir,'request.json'),out:join(rounds,'round-1'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),preset]}});
  expect(run.check.verdict).toBe('qualified');
  return {scope,dir,workspace,rounds,round:run.roundDir,request,preset,template};
}
async function event(out:string,value:unknown){
  const file=join(root,'event-'+Math.random()+'.json');await writeFile(file,JSON.stringify(value));
  return cli(['agent','order-record','--order',out,'--event',file]);
}
async function delivery(f:Awaited<ReturnType<typeof setup>>, before?:()=>Promise<void>){
  await changeReview(f.round,{type:'confirmRest',confirmed:true});
  expect((await changeReview(f.round,{type:'approve'})).problems).toEqual([]);
  expect((await applyAgentRound({roundDir:f.round})).problems).toEqual([]);
  await before?.();
  const resources=join(f.dir,'resources');expect((await initializeResourceStore(resources)).problems).toEqual([]);
  expect((await importResources({sourceDir:resourcesDir,dir:resources})).problems).toEqual([]);
  const batch={template:'订单牌',mode:'final',items:[{...f.request,template:undefined,mode:undefined,id:'image-a'}]};
  const file=join(f.dir,'batch.json');await writeFile(file,JSON.stringify(batch));
  const out=join(f.dir,'delivery'), result=await cli(['deliver','--workspace',f.workspace,'--resources',resources,'--request',file,'--out',out]);
  expect(result.code,result.stderr).toBe(0);
  const manifest=JSON.parse(await readFile(join(out,'batch.json'),'utf8'));
  return join(out,manifest.items[0].directory);
}
it('Agent审核应用与正式出图关联到同一订单，重复记录和查询不重复计量',async()=>{
  const f=await setup('success');const record=await delivery(f);
  const input={id:'delivery-1',kind:'delivery',order:'order-a',plan:'design',round:f.round,delivery:'image-a',record};
  for(let i=0;i<2;i++){const r=await event(f.scope,input);expect(r.code,r.stderr).toBe(0);}
  for(let i=0;i<2;i++){
    const r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);const report=r.value();
    expect(report.counts).toEqual({orders:1,plans:1,attempts:1,successfulOrders:1});
    expect(report.orders[0].commits).toHaveLength(1);expect(report.orders[0].deliveries).toHaveLength(1);
    expect(report.orders[0].attempts[0].evidence).toMatchObject({review:'approved',reviewIdentity:expect.any(String),candidates:[{path:'candidates/template.json',kind:'template',name:'订单牌',edited:false,dropped:false}]});
    expect(report.orders[0].events).toHaveLength(1);expect(report.scope.orders[0].plans).toHaveLength(1);
    expect(report.totals.usage.outputTokens).toEqual({known:222,unknownAttempts:0});
    expect(report.totals.usage.thinkingTokens).toEqual({known:150,unknownAttempts:0});
    expect(report.costPerSuccessfulOrder.usage.outputTokens).toBe(222);
    expect(report.amount).toEqual({value:null,reason:'pricing-unavailable'});
  }
},60000);

it('审核拒绝后人工修正保留原始失败，人工分钟独立累加且缺记录明确未知',async()=>{
  const f=await setup('corrected',true);
  expect((await changeReview(f.round,{type:'reject',comment:'背景错'})).problems).toEqual([]);
  const original={id:'original-a',kind:'assessment',order:'order-a',plan:'design',round:f.round,phase:'original',result:'fail'};
  let r=await event(f.scope,original);expect(r.code,r.stderr).toBe(0);
  r=await event(f.scope,{id:'review-time',kind:'labor',order:'order-a',plan:'design',round:f.round,category:'review',minutes:3});expect(r.code,r.stderr).toBe(0);
  await changeReview(f.round,{type:'reopen'});
  const edited={...f.template,artboard:{...f.template.artboard,fill:'#00FF00'}};
  expect((await changeReview(f.round,{type:'decide',item:1,action:'edit',value:edited})).problems).toEqual([]);
  r=await event(f.scope,{id:'correction-time',kind:'labor',order:'order-a',plan:'design',round:f.round,category:'correction',minutes:7});expect(r.code,r.stderr).toBe(0);
  r=await event(f.scope,{id:'corrected-a',kind:'assessment',order:'order-a',plan:'design',round:f.round,phase:'corrected',result:'pass'});expect(r.code,r.stderr).toBe(0);
  const record=await delivery(f);
  expect((await event(f.scope,{id:'delivery-a',kind:'delivery',order:'order-a',plan:'design',round:f.round,delivery:'image-a',record})).code).toBe(0);
  const report=(await cli(['agent','order-report','--order',f.scope])).value();
  expect(report.orders[0].quality).toMatchObject({original:'fail',corrected:'pass',agentFirstSuccess:false});
  expect(report.orders[0].labor).toEqual({review:{knownMinutes:3,unknownPlans:0},correction:{knownMinutes:7,unknownPlans:0},rework:{knownMinutes:0,unknownPlans:1}});
  expect(report.totals.labor.correction.knownMinutes).toBe(7);
  expect(report.costPerSuccessfulOrder.labor.knownMinutes).toBe(10);
  expect(report.costPerSuccessfulOrder.labor.complete).toBe(false);
},60000);

it('失败订单的全部尝试仍进成功订单单位成本，invalid不进模型有效分母，未知用量不当零',async()=>{
  const rounds=join(root,'cost-failed');
  const f=await setup('cost',false,[{id:'order-b',plans:[{id:'design',task:'template-design',root:rounds}],deliveries:[]}]);
  const record=await delivery(f);expect((await event(f.scope,{id:'delivery-cost',kind:'delivery',order:'order-a',plan:'design',round:f.round,delivery:'image-a',record})).code).toBe(0);
  const shared={task:'template-design' as const,sample:join(resourcesDir,'images/test/quadrants.png'),brief:join(f.dir,'brief.md'),workspace:f.workspace,resources:resourcesDir,dataset:'ds-greeting',request:join(f.dir,'request.json'),key:'test',keyEnv:'TEST'};
  await runAgentTask({...shared,out:join(rounds,'failure'),claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),'none']}});
  const quota=join(f.dir,'quota');await mkdir(quota);await writeFile(join(quota,'.api-error'),'429 quota');
  await runAgentTask({...shared,out:join(rounds,'quota'),claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),quota]}});
  await runAgentTask({...shared,out:join(rounds,'unknown'),claude:{command:process.execPath,args:['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(1))']}});
  const r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);const report=r.value();
  expect(report.counts).toEqual({orders:2,plans:2,attempts:4,successfulOrders:1});
  expect(report.model).toMatchObject({validAttempts:3,invalidAttempts:1});
  expect(report.totals.usage.outputTokens).toEqual({known:444,unknownAttempts:1});
  expect(report.costPerSuccessfulOrder.usage.outputTokens).toBe(444);
  expect(report.costPerSuccessfulOrder.usageComplete).toBe(false);
  expect(report.timing).toMatchObject({actualWallMs:null,unknownAttemptDurations:0});
  expect(report.orders[1].totals.usage.outputTokens).toEqual({known:222,unknownAttempts:1});
},60000);

it('可分享摘要保留身份和数值但不复制本机路径、业务备注及上游错误原文',async()=>{
  const f=await setup('sharing');
  const secret='Bearer-private-customer-secret';
  const bad=join(f.dir,'sensitive');await mkdir(bad);await writeFile(join(bad,'.api-error'),'503 '+secret);
  await runAgentTask({task:'template-design',sample:join(resourcesDir,'images/test/quadrants.png'),brief:join(f.dir,'brief.md'),workspace:f.workspace,resources:resourcesDir,dataset:'ds-greeting',request:join(f.dir,'request.json'),out:join(f.rounds,'failed'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),bad]}});
  const shared=await cli(['agent','order-report','--order',f.scope,'--share']);
  expect(shared.code,shared.stderr).toBe(0);expect(shared.stdout).not.toContain(secret);expect(shared.stdout).not.toContain(root);expect(shared.stdout).not.toContain('private-customer-secret');
  expect(shared.value()).toMatchObject({format:'renderweave-order-share/1',reproductionBundle:false,scopeIdentity:expect.stringMatching(/^sha256:/),counts:{attempts:2}});
  expect(shared.value().orders[0].attempts[0].id).toBeTruthy();
  expect(shared.value().orders[0].attempts.find((a:any)=>a.original==='qualified')).toMatchObject({originalIdentity:expect.any(String),reviewIdentity:expect.any(String),recordIdentity:expect.stringMatching(/^sha256:/),execution:'completed'});
});

async function waitFile(file:string){for(let i=0;i<1000;i++){try{return JSON.parse(await readFile(file,'utf8'));}catch{}await new Promise(r=>setTimeout(r,20));}throw new Error('等待公开保存信号超时');}
async function killOwned(child:ChildProcess,out:string){
  if(!child.pid||child.exitCode!==null)return;
  if(process.platform==='win32'){const killed=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await once(killed,'close');}
  else{const state=await waitFile(join(out,'execution.json'));
    const host=state.owner.supervisorPid===child.pid?state.owner.pid:undefined;expect(host?state.owner.supervisorPid:state.owner.pid).toBe(child.pid);
    if(host)try{process.kill(-host,'SIGKILL');}catch{}
    if(state.executorPid)try{process.kill(-state.executorPid,'SIGKILL');}catch{}
    try{process.kill(-child.pid,'SIGKILL');}catch{}
    for(let i=0;i<100;i++){try{process.kill(state.executorPid,0);}catch{break;}await new Promise(r=>setTimeout(r,20));}}
}
it('真实MCP保存后强退再接续成功，订单保留中断尝试与检查点关系且用量未知不消失',async()=>{
  const f=await setup('recovered'), interrupted=join(f.rounds,'round-2');
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run','--from',f.round,'--feedback',join(f.dir,'brief.md'),'--out',interrupted,'--key-env','RW_ORDER_KEY','--claude',process.execPath,'--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-checkpoint.mjs'),f.preset])],{cwd:repoRoot,env:{...process.env,RW_ORDER_KEY:'test'},windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'});
  let errors='';child.stderr!.on('data',b=>errors+=String(b));child.stdout!.resume();const ended=once(child,'close');
  try{const observed=await waitFile(join(interrupted,'agent/checkpoint-observed.json'));expect(JSON.parse(observed.reply.result.content[0].text).checkpoint.status,errors).toBe('saved');}
  finally{await killOwned(child,interrupted);await ended;}
  const resumed=await runAgentTask({from:interrupted,feedback:join(f.dir,'brief.md'),out:join(f.rounds,'round-3'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),f.preset]}});
  expect(resumed.record.inputs.previous?.checkpoint).toBeDefined();
  const record=await delivery({...f,round:resumed.roundDir});expect((await event(f.scope,{id:'delivery-resumed',kind:'delivery',order:'order-a',plan:'design',round:resumed.roundDir,delivery:'image-a',record})).code).toBe(0);
  const r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);const report=r.value();
  expect(report.counts).toMatchObject({attempts:3,successfulOrders:1});
  expect(report.totals.usage.outputTokens).toEqual({known:444,unknownAttempts:1});
  expect(report.orders[0].attempts.filter((a:any)=>a.execution==='interrupted')).toHaveLength(1);
  expect(report.orders[0].attempts.at(-1).checkpoint).toMatchObject({source:'hostRecovery',id:resumed.record.inputs.previous?.checkpoint?.id});
  expect(report.timing.unknownAttemptDurations).toBe(1);
},60000);

it('评估重试原件与兼容阶段只计一次，封存日志改变后不能继续出具订单成本',async()=>{
  const config=await readConfig(),scenario=config.scenarios.find(s=>s.id==='m402-definition')!,out=join(root,'evaluated'),unit=join(out,'run-1',scenario.id);
  const scope=await initialize('eval-order',[{id:'eval-a',plans:[{id:'definition',task:'definition-extraction',root:unit}],deliveries:[]}]);
  const preset=join(root,'eval-preset');await mkdir(join(preset,'candidates'),{recursive:true});
  for(const name of ['route','stop'])await writeFile(join(preset,`candidates/${name}.json`),await readFile(join(repoRoot,`fixtures/agent-eval/definitions/des-gd1/${name}.json`)));
  await writeFile(join(preset,'outcome.json'),JSON.stringify({candidates:['candidates/route.json','candidates/stop.json'],pending:[],notes:'controlled'}));
  let calls=0;
  const launch:Launcher=async spec=>{calls++;await runAgentTask({...spec,key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-usage-claude.mjs'),calls===1?'none':preset,JSON.stringify({input_tokens:1,output_tokens:calls===1?13:222,output_tokens_details:{thinking_tokens:5},cache_read_input_tokens:0,cache_creation_input_tokens:0}),...(calls===1?['503 unavailable']:[])]}});};
  expect((await runScenario(config,scenario,1,out,launch,{sleep:async()=>{}})).status).toBe('pass');
  let r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);const report=r.value();
  expect(report.counts.attempts).toBe(2);expect(report.totals.usage.outputTokens).toEqual({known:235,unknownAttempts:0});
  const original=report.orders[0].attempts.find((a:any)=>a.usage.outputTokens===13).dir;
  await writeFile(join(original,'logs/stream.jsonl'),'');
  r=await cli(['agent','order-report','--order',scope]);expect(r.code).toBe(1);expect(r.stderr).toContain('尝试原件已改变');
},60000);

it('同名数据集被替换后生成的成品不能归为原应用交付，已登记成品不受之后工作区变化影响',async()=>{
  const f=await setup('wrong-data');
  const file=join(f.workspace,'dataset-greeting.json');
  const record=await delivery(f,async()=>{const data=JSON.parse(await readFile(file,'utf8'));data.data.message='改变客户';await writeFile(file,JSON.stringify(data));});
  const rejected=await event(f.scope,{id:'wrong-record',kind:'delivery',order:'order-a',plan:'design',round:f.round,delivery:'image-a',record});
  expect(rejected.code).toBe(1);expect(rejected.stderr).toContain('应用之后');
  const good=await setup('recorded-data'), completed=await delivery(good);
  expect((await event(good.scope,{id:'good-record',kind:'delivery',order:'order-a',plan:'design',round:good.round,delivery:'image-a',record:completed})).code).toBe(0);
  await writeFile(join(good.workspace,'unrelated.json'),'{}');
  const report=await cli(['agent','order-report','--order',good.scope]);expect(report.code,report.stderr).toBe(0);expect(report.value().counts.successfulOrders).toBe(1);
},60000);
it('人工审核绑定当时成果，后续修正使旧结论失效且记录被改后不能核算',async()=>{
  const f=await setup('event-integrity',true);
  expect((await event(f.scope,{id:'reviewed',kind:'assessment',order:'order-a',plan:'design',round:f.round,phase:'corrected',result:'pass'})).code).toBe(0);
  expect((await changeReview(f.round,{type:'decide',item:1,action:'edit',value:{...f.template,artboard:{...f.template.artboard,fill:'#0000FF'}}})).problems).toEqual([]);
  let r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().orders[0].quality.corrected).toBe('unknown');expect(r.value().orders[0].quality.assessments).toHaveLength(1);
  expect((await event(f.scope,{id:'time-a',kind:'labor',order:'order-a',plan:'design',round:f.round,category:'review',minutes:4})).code).toBe(0);
  const file=join(f.scope,'events/time-a.json'),value=JSON.parse(await readFile(file,'utf8'));value.input.minutes=0;await writeFile(file,JSON.stringify(value));
  r=await cli(['agent','order-report','--order',f.scope]);expect(r.code).toBe(1);expect(r.stderr).toContain('事件记录已改变');
});
it('订单首次成功必须覆盖每个预登记计划，技术合格与另一计划未运行不能补作业务通过',async()=>{
  const scope=await initialize('multi-plan',[{id:'order-a',plans:[{id:'design',task:'template-design',root:join(root,'multi-data/rounds')},{id:'second',task:'template-design',root:join(root,'not-yet')}],deliveries:[]}]);
  const f=await setup('multi');
  expect((await event(scope,{id:'first-pass',kind:'assessment',order:'order-a',plan:'design',round:f.round,phase:'original',result:'pass'})).code).toBe(0);
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().orders[0].quality).toMatchObject({original:'unknown',agentFirstSuccess:false});
  expect(r.value().counts).toMatchObject({plans:2,attempts:1,successfulOrders:0});
});
it('完整用量和固定提供方费率才估算金额，thinking不在output之外重复收费',async()=>{
  const pricing={version:'controlled-1',provider:'test-provider',currency:'USD',endpoint:'https://opencode.ai/inference/go/anthropic',model:'claude-haiku-5-5',basis:'separate-input-output-cache',perMillion:{inputTokens:1,outputTokens:2,cacheReadTokens:3,cacheCreationTokens:4}};
  const f=await setup('priced',false,[],pricing);
  let r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().amount).toMatchObject({value:0.00073,currency:'USD',pricingIdentity:expect.stringMatching(/^sha256:/),basis:'separate-input-output-cache'});
  await runAgentTask({task:'template-design',sample:join(resourcesDir,'images/test/quadrants.png'),brief:join(f.dir,'brief.md'),workspace:f.workspace,resources:resourcesDir,dataset:'ds-greeting',request:join(f.dir,'request.json'),out:join(f.rounds,'missing-usage'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:['-e','process.stdin.resume();process.stdin.on("end",()=>process.exit(1))']}});
  r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);expect(r.value().amount).toMatchObject({value:null,reason:'usage-or-provider-unknown'});
});
it('预登记拒绝草稿交付与重叠同任务计划，范围时间被改后不出报告',async()=>{
  const definition={id:'a',plans:[{id:'design',task:'template-design',root:join(root,'scope-rounds')}],deliveries:[{id:'image',plan:'design',request:greetingRequest({mode:'draft'})}]};
  const file=join(root,'invalid-scope.json');await writeFile(file,JSON.stringify({format:'renderweave-order-scope/1',id:'invalid',orders:[definition]}));
  let r=await cli(['agent','order-init','--scope',file,'--out',join(root,'invalid-scope')]);expect(r.code).toBe(1);
  definition.deliveries=[];definition.plans.push({id:'duplicate',task:'template-design',root:join(root,'scope-rounds/nested')});
  await writeFile(file,JSON.stringify({format:'renderweave-order-scope/1',id:'invalid',orders:[definition]}));
  r=await cli(['agent','order-init','--scope',file,'--out',join(root,'invalid-overlap')]);expect(r.code).toBe(1);
  const out=await initialize('dated',[{id:'a',plans:[{id:'design',task:'template-design',root:join(root,'dated-rounds')}],deliveries:[]}]);
  const saved=join(out,'scope.json'),scope=JSON.parse(await readFile(saved,'utf8'));scope.declaredAt='2020-01-01T00:00:00.000Z';await writeFile(saved,JSON.stringify(scope));
  r=await cli(['agent','order-report','--order',out]);expect(r.code).toBe(1);expect(r.stderr).toContain('预登记订单范围已改变');
});
it('接续来源在登记范围外时报告缺失历史，不把局部用量与首次质量当作完整订单',async()=>{
  const f=await setup('outside-source'),rounds=join(root,'only-new-rounds');
  const scope=await initialize('only-new',[{id:'order-a',plans:[{id:'design',task:'template-design',root:rounds}],deliveries:[{id:'image-a',plan:'design',request:f.request}]}]);
  const next=await runAgentTask({from:f.round,feedback:join(f.dir,'brief.md'),out:join(rounds,'continued'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),f.preset]}});
  expect((await event(scope,{id:'partial-first',kind:'assessment',order:'order-a',plan:'design',round:next.roundDir,phase:'original',result:'pass'})).code).toBe(0);
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().history).toMatchObject({complete:false,outsideScopePreviousRounds:1});
  expect(r.value().orders[0].quality.agentFirstSuccess).toBe(false);expect(r.value().totals.usage.outputTokens.known).toBe(222);
  for(const category of ['review','correction','rework'])expect((await event(scope,{id:'partial-'+category,kind:'labor',order:'order-a',plan:'design',round:next.roundDir,category,minutes:1})).code).toBe(0);
  const record=await delivery({...f,round:next.roundDir});expect((await event(scope,{id:'partial-delivery',kind:'delivery',order:'order-a',plan:'design',round:next.roundDir,delivery:'image-a',record})).code).toBe(0);
  const completed=await cli(['agent','order-report','--order',scope]);expect(completed.code,completed.stderr).toBe(0);
  expect(completed.value().counts.successfulOrders).toBe(1);expect(completed.value().costPerSuccessfulOrder.labor).toEqual({knownMinutes:3,complete:false});
});
it('派发在轮次建立前失败仍保留尝试成本未知与invalid，不能从报告消失',async()=>{
  const config=await readConfig(),scenario=config.scenarios.find(s=>s.id==='m402-definition')!,out=join(root,'dispatch-failed');
  const scope=await initialize('dispatch-order',[{id:'a',plans:[{id:'definition',task:'definition-extraction',root:join(out,'run-1',scenario.id)}],deliveries:[]}]);
  expect((await runScenario(config,scenario,1,out,async()=>{throw new Error('429 quota');},{sleep:async()=>{}})).status).toBe('invalid');
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().counts.attempts).toBe(1);expect(r.value().model).toEqual({validAttempts:0,invalidAttempts:1,unknownAttempts:0});
  expect(r.value().totals.usage.outputTokens).toEqual({known:0,unknownAttempts:1});expect(r.value().timing.unknownAttemptDurations).toBe(0);
});
it('同一评估目录中的不同任务按计划归属，各自失败与成功尝试都只计算一次',async()=>{
  const f=await setup('tasks');
  const scope=await initialize('task-plans',[{id:'a',plans:[{id:'design',task:'template-design',root:f.rounds},{id:'definition',task:'definition-extraction',root:f.rounds}],deliveries:[]}]);
  await runAgentTask({task:'definition-extraction',sample:join(resourcesDir,'images/test/quadrants.png'),brief:join(f.dir,'brief.md'),workspace:f.workspace,resources:resourcesDir,out:join(f.rounds,'extract-failed'),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[join(repoRoot,'test/support/fake-claude.mjs'),'none']}});
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);expect(r.value().counts).toMatchObject({plans:2,attempts:2});
  expect(r.value().orders[0].attempts.map((a:any)=>a.plan).sort()).toEqual(['definition','design']);
});
it('从另一个登记范围复制来的人工事件不会计入新订单',async()=>{
  const f=await setup('foreign-event');
  expect((await event(f.scope,{id:'labor-1',kind:'labor',order:'order-a',plan:'design',round:f.round,category:'review',minutes:10})).code).toBe(0);
  const scope=await initialize('foreign-target',[{id:'order-a',plans:[{id:'design',task:'template-design',root:f.rounds}],deliveries:[]}]);
  await mkdir(join(scope,'events'));await writeFile(join(scope,'events/labor-1.json'),await readFile(join(f.scope,'events/labor-1.json')));
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code).toBe(1);expect(r.stderr).toContain('订单事件记录已改变');
});
it('并行执行的墙钟取区间并集，各轮耗时求和保留实际投入',async()=>{
  const f=await setup('parallel-time'),slow=join(f.dir,'slow.mjs');
  const barrier=join(f.dir,'barrier');await mkdir(barrier);
  await writeFile(slow,"import {writeFile,access} from 'node:fs/promises';import {join} from 'node:path';"+
    "await writeFile(join(process.argv[4],process.argv[3]),'ready');const exists=p=>access(p).then(()=>true,()=>false);"+
    "while(!await exists(join(process.argv[4],'2'))||!await exists(join(process.argv[4],'3')))await new Promise(r=>setTimeout(r,20));"+
    "await new Promise(r=>setTimeout(r,1200));await import("+JSON.stringify(pathToFileURL(join(repoRoot,'test/support/fake-claude.mjs')).href)+');');
  await Promise.all([2,3].map(n=>runAgentTask({task:'template-design',sample:join(resourcesDir,'images/test/quadrants.png'),brief:join(f.dir,'brief.md'),workspace:f.workspace,resources:resourcesDir,dataset:'ds-greeting',request:join(f.dir,'request.json'),out:join(f.rounds,'parallel-'+n),key:'test',keyEnv:'TEST',claude:{command:process.execPath,args:[slow,f.preset,String(n),barrier]}})));
  const r=await cli(['agent','order-report','--order',f.scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().counts.attempts).toBe(3);expect(r.value().timing.executionWallMs).toBeGreaterThan(1200);
  expect(r.value().timing.executionWallMs).toBeLessThan(r.value().timing.attemptsElapsedMs);
  expect(r.value().timing.unknownAttemptDurations).toBe(0);
},60000);
it.each(['partial','sparse'])('强退时尚无round记录也保留%s消息用量，重复消息与空result不丢已知部分',async mode=>{
  const f=await setup('usage-'+mode),out=join(f.rounds,'interrupted');
  const child=spawn(process.execPath,[join(repoRoot,'dist/bin.js'),'agent','run','--task','definition-extraction','--sample',join(resourcesDir,'images/test/quadrants.png'),'--brief',join(f.dir,'brief.md'),'--resources',resourcesDir,'--out',out,'--key-env','RW_ORDER_KEY','--claude',process.execPath,'--claude-args',JSON.stringify([join(repoRoot,'test/support/budget-claude.mjs'),mode])],{cwd:repoRoot,env:{...process.env,RW_ORDER_KEY:'test'},windowsHide:true,detached:process.platform!=='win32',stdio:'pipe'});
  child.stdout!.resume();child.stderr!.resume();const ended=once(child,'close');
  try{await waitFile(join(out,'agent/budget-processes.json'));
    const deadline=Date.now()+20000;let ready=false;
    while(Date.now()<deadline){const text=await readFile(join(out,'logs/stream.jsonl'),'utf8').catch(()=>'');if(text.includes(mode==='sparse'?'"type":"result"':'"id":"two"')){ready=true;break;}await new Promise(r=>setTimeout(r,20));}
    expect(ready).toBe(true);
  }finally{await killOwned(child,out);await ended;}
  await expect(readFile(join(out,'round.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  const scope=await initialize('partial-scope-'+mode,[{id:'a',plans:[{id:'definition',task:'definition-extraction',root:out}],deliveries:[]}]);
  const r=await cli(['agent','order-report','--order',scope]);expect(r.code,r.stderr).toBe(0);
  expect(r.value().totals.usage.outputTokens).toEqual({known:12,unknownAttempts:1});
  expect(r.value().totals.usage.inputTokens).toEqual({known:mode==='sparse'?31:30,unknownAttempts:1});
  expect(r.value().orders[0].attempts[0].usage.usageSource).toBe('messages');
},60000);