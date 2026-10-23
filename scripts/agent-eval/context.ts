/** 按需候选的公开离线准备入口；不读取留出结果，不调用模型。 */
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname,join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {parseArgs} from 'node:util';
import {PassThrough} from 'node:stream';
import {runCli} from '../../src/cli.js';
import {checkDslDocument} from '../../src/index.js';
import {REPO,readConfig} from './scenarios.js';
import {experimentIdentity,sha256} from './identity.js';
import {feedbackPlan} from './feedback.js';

const {values} = parseArgs({options:{check:{type:'string'},catalog:{type:'string'},'prepare-pair':{type:'string'},config:{type:'string'},model:{type:'string'},'small-model':{type:'string'},endpoint:{type:'string'},effort:{type:'string'},jobs:{type:'string'},repeat:{type:'string'},'max-turns':{type:'string'},claude:{type:'string'},'claude-args':{type:'string'}},strict:true});
if (values['prepare-pair']) {
  if(values.check||values.catalog||!values.config)throw new Error('--prepare-pair 需要 --config，不能混用指针检查');
  const configFile=resolve(values.config), config=await readConfig(configFile);
  const preparation=JSON.parse(await readFile(join(dirname(configFile),'preparation.json'),'utf8'));
  if(config.evidence!=='mechanism'||preparation.format!=='renderweave-feedback-preparation/1'||preparation.source!=='predeclared-synthetic-facts')throw new Error('本候选只接受票14明确登记的合成校准输入，不能使用留出结果');
  const plan=await feedbackPlan(config,config.scenarios);
  const positive=(value:string|undefined,fallback:number)=>{const number=Number(value??fallback);if(!Number.isSafeInteger(number)||number<1)throw new Error('次数、并行数和预算必须是正整数');return number;};
  const repeat=positive(values.repeat,config.consecutivePasses),jobs=positive(values.jobs,1);
  if(repeat<config.consecutivePasses)throw new Error('配对次数不能少于校准计划');
  if(values.effort&&!['low','medium','high','xhigh','max'].includes(values.effort))throw new Error('无效 effort');
  const args=values['claude-args']?JSON.parse(values['claude-args']):undefined;
  if(args!==undefined&&(!values.claude||!Array.isArray(args)||!args.every(value=>typeof value==='string')))throw new Error('claude-args 必须与 claude 一起提供字符串数组');
  const runtime={model:values.model,smallModel:values['small-model'],endpoint:values.endpoint,effort:values.effort,
    ...(values['max-turns']?{maxTurns:positive(values['max-turns'],1)}:{}),...(values.claude?{claude:{command:values.claude,args}}:{})};
  const arms=[];
  for(const policy of ['full','on-demand'] as const){
    const identity=await experimentIdentity(config,configFile,config.scenarios,{...runtime,contextPolicy:policy},{scenarios:config.scenarios.map(value=>value.id),repeat,pairedJobs:jobs});
    const flag=(name:string,value:unknown)=>value===undefined?[]:[`--${name}`,String(value)];
    arms.push({policy,identity,identityHash:sha256(JSON.stringify(identity)),arguments:['--config',configFile,'--context-policy',policy,'--paired','--jobs',String(jobs),'--repeat',String(repeat),
      ...flag('model',runtime.model),...flag('small-model',runtime.smallModel),...flag('endpoint',runtime.endpoint),...flag('effort',runtime.effort),...flag('max-turns',runtime.maxTurns),
      ...flag('claude',runtime.claude?.command),...(runtime.claude?.args?['--claude-args',JSON.stringify(runtime.claude.args)]:[])]});
  }
  const out=resolve(values['prepare-pair']);await mkdir(out);
  await writeFile(join(out,'pair.json'),JSON.stringify({format:'renderweave-context-pair/1',ready:plan.ready,defaultChanged:false,realModelObservations:0,preparation:sha256(await readFile(join(dirname(configFile),'preparation.json'))),units:plan.units,arms},null,2)+'\n',{flag:'wx'});
  process.exitCode=plan.ready?0:3;
} else {
if (!values.check) throw new Error('需要 --check <新报告.json> 或 --prepare-pair <新目录> --config <校准配置>');
const dir=await mkdtemp(join(tmpdir(),'rw-context-check-'));
try {
  await mkdir(join(dir,'workspace')); await mkdir(join(dir,'resources'));
  await writeFile(join(dir,'resources/resources.json'),JSON.stringify({fonts:[],images:[]}));
  const stdin=new PassThrough(), pending=new Map<number,(value:any)=>void>(); let id=0, buffer='';
  const exit=runCli(['mcp','--workspace',join(dir,'workspace'),'--resources',join(dir,'resources'),'--root',dir],{
    stdin,stderr:()=>{},stdout(text){buffer+=text;let end:number;while((end=buffer.indexOf('\n'))>=0){const reply=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);pending.get(reply.id)?.(reply);pending.delete(reply.id);}}
  });
  const request=(method:string,params:unknown)=>new Promise<any>((done,reject)=>{
    const current=++id,timer=setTimeout(()=>reject(new Error('公开 MCP 响应超时')),10000);
    pending.set(current,reply=>{clearTimeout(timer);done(reply);});stdin.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n');
  });
  const passed:any[]=[],unresolved:any[]=[];
  const problem=(target:string,error:unknown,owner='agent-harness-hardening/17')=>unresolved.push({status:'unresolved',target,owner,reason:error instanceof Error?error.message:String(error)});
  try {
    const initialized=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'context-pointer-check',version:'1'}});
    const listed=await request('tools/list',{}); const tools=listed.result?.tools;
    if(!Array.isArray(tools)||!tools.some((tool:any)=>tool.name==='dsl_reference')||tools.some((tool:any)=>!tool.annotations?.readOnlyHint))throw new Error('公开只读工具合同不完整');
    passed.push({kind:'tool-contract',target:'tools/list',version:initialized.result.serverInfo.version});
    const catalog=JSON.parse(await readFile(resolve(values.catalog??join(REPO,'agent/context-catalog.json')),'utf8'));
    if(catalog.format!=='renderweave-context-catalog/1'||!Array.isArray(catalog.stages)||!catalog.stages.length)throw new Error('资料目录格式错误');
    for(const stage of catalog.stages){
      try {
        if(typeof stage.id!=='string'||typeof stage.when!=='string'||typeof stage.name!=='string')throw new Error('目录项缺少 id、when 或 name');
        const reply=await request('tools/call',{name:'dsl_reference',arguments:{name:stage.name,...(stage.pointer!==undefined?{pointer:stage.pointer}:{})}});
        if(reply.error||reply.result?.isError)throw new Error(JSON.stringify(reply.error??reply.result));
        const text=reply.result.content.find((block:any)=>block.type==='text')?.text;
        if(!text||stage.heading&&!text.split(/\r?\n/).some((line:string)=>line.replace(/^#+ /,'')===stage.heading))throw new Error('参考缺少所需章节');
        passed.push({kind:'reference',target:stage.name,stage:stage.id,...(stage.heading?{heading:stage.heading}:{})});
      } catch(error){problem(String(stage.name),error);}
    }
    for(const file of (await readdir(join(REPO,'docs/examples/m402-dsl'))).filter(file=>file.endsWith('.json')&&!file.endsWith('.schema.json'))){
      const path=`docs/examples/m402-dsl/${file}`;
      try {
        const checked=checkDslDocument(JSON.parse(await readFile(join(REPO,path),'utf8')),path);
        if(checked.problems.some(item=>item.level==='severe'))throw new Error(JSON.stringify(checked.problems));
        const schema={definition:'data-definition',dataset:'dataset',template:'template',renderRequest:'render-request',batchRequest:'batch-request'}[checked.kind!];
        const reply=await request('tools/call',{name:'dsl_reference',arguments:{name:`schema/${schema}`}});
        if(reply.error||reply.result?.isError)throw new Error('共享样例对应的公开 Schema 不可达');
        passed.push({kind:'shared-example',target:path,reference:`schema/${schema}`});
      }catch(error){problem(path,error);}
    }
    const template=await readFile(join(REPO,'agent/reference/template.md'),'utf8');
    if(template.includes('dsl-reference.md（数据定义参考）'))problem('agent/reference/template.md → docs/dsl-reference.md','模板任务该文件仍指回模板参考；正确公开入口 reference/data-definition 已单独核对','agent-template-authoring/20');
    else problem('agent/reference/template.md / 原票20','预登记遗留错误的文本已变化，需重新核对责任，不自动记为通过','agent-template-authoring/20');
  }catch(error){problem('candidate-catalog',error);}
  finally{stdin.end();await exit;}
  const candidateReady=!unresolved.some(item=>item.owner==='agent-harness-hardening/17');
  await writeFile(resolve(values.check),JSON.stringify({format:'renderweave-context-check/1',status:candidateReady?'known-unresolved':'fail',candidateReady,realModelObservations:0,passed,unresolved},null,2)+'\n',{flag:'wx'});
  process.exitCode=candidateReady?0:1;
}finally{await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}
