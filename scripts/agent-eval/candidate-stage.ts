/** 人工审核链中的单个公开 Agent 阶段：固定实际上游输入，不负责审核、应用或循环。 */
import {mkdir,readFile,writeFile,realpath,readdir,lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {materialHashes} from '../../src/agent/provenance.js';
import {AGENT_TASKS} from '../../src/agent/tasks.js';
import {readReview,readPreviousRound} from '../../src/agent/review.js';
import {verifyCandidate} from './candidate.js';
import {experimentIdentity,identityDifferences,sha256} from './identity.js';
import type {RuntimeOptions} from './eval.js';

interface StageRequest{
  format:'renderweave-stage-request/1';unit:string;
  materials:{file:string;sha256:string}[];
  upstreamRounds?:string[];
  args:string[];
}
const pathArguments=['sample','brief','resources','workspace','request','reference','content-baseline','requirement','from','feedback','out'];
const allowed=new Set([...pathArguments,'task','domain','definition','dataset','checkpoint','model','small-model','endpoint','max-turns','timeout-ms','stagnation-threshold','context-policy','effort','claude','claude-args']);
async function stageFiles(dir:string,prefix:string):Promise<Record<string,string>>{
  const visit=async(path:string)=>{
    if((await lstat(path)).isSymbolicLink())throw new Error(`阶段输入目录不能是链接，未派发：${path}`);
    for(const entry of await readdir(path,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw new Error(`阶段输入不能包含链接，未派发：${join(path,entry.name)}`);
      if(entry.isDirectory()&&!/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(entry.name))await visit(join(path,entry.name));
    }
  };
  await visit(dir);return materialHashes(dir,prefix);
}
function parameters(request:StageRequest):Record<string,string>{
  if(request.format!=='renderweave-stage-request/1'||!request.unit?.trim()||!Array.isArray(request.materials)||!request.materials.length||!Array.isArray(request.args)||request.args.length%2)throw new Error('阶段请求需要单元标识、核准材料身份和成对的 agent run 参数');
  const args:Record<string,string>={};
  for(let i=0;i<request.args.length;i+=2){
    const flag=request.args[i]!,value=request.args[i+1]!;
    const name=flag.startsWith('--')?flag.slice(2):'';
    if(!allowed.has(name)||name in args||typeof value!=='string'||!value)throw new Error(`不支持或重复的阶段参数：${flag}`);
    args[name]=value;
  }
  for(const name of pathArguments)if(args[name]&&!isAbsolute(args[name]))throw new Error(`阶段路径必须为绝对路径：${name}`);
  if(!args.out||!args.from&&(!args.task||!(args.task in AGENT_TASKS)||!args.sample||!args.brief||!args.resources))throw new Error('阶段请求缺少公开 agent run 必需参数');
  return args;
}
async function stageIdentity(request:StageRequest,file:string){
  const args=parameters(request),inputs:Record<string,string>={};
  for(const material of request.materials){
    if(!isAbsolute(material.file)||!/^sha256:[a-f0-9]{64}$/.test(material.sha256))throw new Error('核准材料需要绝对路径和 SHA-256');
    const actual=sha256(await readFile(material.file));
    if(actual!==material.sha256)throw new Error(`核准材料变化，未派发：${material.file}`);
    inputs[`approved/${material.file}`]=actual;
  }
  for(const name of ['sample','brief','request','reference','content-baseline','requirement','feedback'])if(args[name])inputs[name]=sha256(await readFile(args[name]));
  let workspace=args.workspace,resources=args.resources;
  if(args.from){
    const previous=await readPreviousRound(args.from,{checkpoint:args.checkpoint});
    Object.assign(inputs,await stageFiles(args.from,'previous'));
    workspace=previous.checkpointWorkspace??previous.record.inputs.workspace.source??workspace;
    resources=previous.resources??resources;
    if(previous.checkpoint)inputs.selectedCheckpoint=previous.checkpoint.id;
  }
  if(workspace)Object.assign(inputs,await stageFiles(workspace,'workspace'));
  if(request.upstreamRounds!==undefined&&!Array.isArray(request.upstreamRounds))throw new Error('上游应用轮次必须是目录数组');
  for(const [index,dir] of (request.upstreamRounds??[]).entries()){
    if(!isAbsolute(dir)||!workspace)throw new Error('上游应用轮次需要绝对路径及实际工作区');
    const checked=await readReview(dir);
    if(!checked.view?.applied||await realpath(checked.view.applied.workspace)!==await realpath(workspace))throw new Error(`上游轮次尚未完成有效应用或工作区不同，未派发：${dir}`);
    Object.assign(inputs,await stageFiles(dir,`upstream/${index}`));
  }
  if(!resources)throw new Error('阶段资源来源未知，未派发');
  const positive=(name:string)=>{if(args[name]===undefined)return undefined;const number=Number(args[name]);if(!Number.isSafeInteger(number)||number<1)throw new Error(`阶段预算必须为正整数：${name}`);return number;};
  const claudeArgs:unknown=args['claude-args']===undefined?undefined:JSON.parse(args['claude-args']);
  if(claudeArgs!==undefined&&(!args.claude||!Array.isArray(claudeArgs)||!claudeArgs.every(value=>typeof value==='string')))throw new Error('claude-args 需要执行器及字符串数组');
  if(args.effort&&!['low','medium','high','xhigh','max'].includes(args.effort))throw new Error('无效 effort');
  const runtime:RuntimeOptions={model:args.model,smallModel:args['small-model'],endpoint:args.endpoint,effort:args.effort,maxTurns:positive('max-turns'),roundTimeoutMs:positive('timeout-ms'),stagnationThreshold:positive('stagnation-threshold'),contextPolicy:args['context-policy'] as RuntimeOptions['contextPolicy'],...(args.claude?{claude:{command:args.claude,args:claudeArgs as string[]|undefined}}:{})};
  const identity=await experimentIdentity({format:'renderweave-agent-eval-config/2',consecutivePasses:1,resources,scenarios:[]},file,[],runtime,{scenarios:[request.unit],repeat:1,pairedJobs:null});
  return {...identity,inputs,request:request.args};
}
interface StageBinding{
  format:'renderweave-candidate-stage/1';id:string;candidate:{id:string;directory:string};unit:string;
  identity:Awaited<ReturnType<typeof stageIdentity>>;
}
export async function bindStage(candidateDir:string,requestFile:string,out:string):Promise<StageBinding>{
  const candidate=await verifyCandidate(candidateDir,true),bytes=await readFile(requestFile);
  const request:StageRequest=JSON.parse(bytes.toString()),identity=await stageIdentity(request,requestFile);
  if(identity.config!==sha256(bytes))throw new Error('绑定时阶段请求变化，未发布');
  await mkdir(out);await writeFile(join(out,'request.json'),bytes,{flag:'wx'});
  const body={format:'renderweave-candidate-stage/1' as const,candidate:{id:candidate.id,directory:resolve(candidateDir)},unit:request.unit,identity};
  const binding={...body,id:sha256(JSON.stringify(body))};
  await writeFile(join(out,'binding.json'),JSON.stringify(binding,null,2)+'\n',{flag:'wx'});return binding;
}
export async function verifyStage(dir:string):Promise<{binding:StageBinding;request:StageRequest}>{
  const binding:StageBinding=JSON.parse(await readFile(join(dir,'binding.json'),'utf8')),{id,...body}=binding;
  if(binding.format!=='renderweave-candidate-stage/1'||id!==sha256(JSON.stringify(body)))throw new Error('阶段绑定损坏，未派发');
  const candidate=await verifyCandidate(binding.candidate.directory,true);
  if(candidate.id!==binding.candidate.id)throw new Error('阶段候选身份不匹配，未派发');
  const file=join(dir,'request.json'),request:StageRequest=JSON.parse(await readFile(file,'utf8'));
  const changes=identityDifferences(binding.identity,await stageIdentity(request,file));
  if(changes.length)throw new Error(`阶段来源与绑定不匹配，未派发：\n${changes.join('\n')}`);
  return {binding,request};
}
export async function dispatchStage(dir:string,keyEnv:string):Promise<number>{
  const {binding,request}=await verifyStage(dir),args=parameters(request);
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv)||!process.env[keyEnv])throw new Error('缺少指定凭据环境变量；未派发');
  // 一次绑定只消费一次；失败或接续须保留原件并新建阶段请求，不能覆盖重跑。
  await writeFile(join(dir,'dispatch-start.json'),JSON.stringify({binding:binding.id,startedAt:new Date().toISOString(),out:args.out})+'\n',{flag:'wx'});
  // 与 dist/bin.js 使用同一个公开 CLI；让原监督器接收取消，不能杀掉其宿主而遗留执行器。
  const {runCli}=await import('../../dist/cli.js');
  const controller=new AbortController(),cancel=()=>controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  let exitCode:number;
  try{exitCode=await runCli(['agent','run',...request.args,'--key-env',keyEnv],{stdout:text=>process.stdout.write(text),stderr:text=>process.stderr.write(text),stdin:process.stdin,signal:controller.signal});}
  finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
  const files=await materialHashes(args.out!,'').catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return {};throw error;});
  let invalid:string|null=null;
  try{await verifyStage(dir);}catch(error){invalid=error instanceof Error?error.message:String(error);}
  await writeFile(join(dir,'dispatch.json'),JSON.stringify({format:'renderweave-stage-dispatch/1',candidate:binding.candidate.id,binding:binding.id,unit:binding.unit,exitCode,invalid,files:Object.fromEntries(Object.entries(files).map(([key,hash])=>[key.slice(1),`sha256:${hash}`]))},null,2)+'\n',{flag:'wx'});
  if(invalid)throw new Error(`阶段运行期间身份变化，结果不可计入同一候选：${invalid}`);
  return exitCode;
}
