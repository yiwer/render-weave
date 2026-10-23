/** 候选共同代码与资料的实字节快照；具体计划的输入和运行请求另外绑定。 */
import {mkdir,readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {DEFAULT_ENDPOINT,DEFAULT_GOOGLE_ENDPOINT,DEFAULT_MODEL,DEFAULT_SMALL_MODEL} from '../../src/agent/run.js';
import {DEFAULT_ROUND_TIMEOUT_MS} from '../../src/agent/supervision.js';
import {DEFAULT_STAGNATION_THRESHOLD} from '../../src/agent/stagnation.js';
import {AGENT_TASKS} from '../../src/agent/tasks.js';
import {contextPolicy,type ContextPolicy} from '../../src/agent/context-policy.js';
import {MCP_CONTRACT_VERSION} from '../../src/mcp/tools.js';
import {openResourceRepository} from '../../src/resources.js';
import {withLocalAccess} from '../../src/local-access.js';
import {experimentIdentity,identityDifferences,resourceInputIdentity,sha256,type ExperimentIdentity} from './identity.js';
import {REPO,readConfig,repoPath,stageNames} from './scenarios.js';
import type {RuntimeOptions} from './eval.js';

const roots=['src','dist','agent','schemas','node_modules'];
const singles=['package.json','package-lock.json','tsconfig.json','tsconfig.build.json'];
const skippedDirectories=new Set(['.bin','.cache','.vite','.vite-temp']);
export async function commonFiles(root=REPO,destination?:string):Promise<Record<string,string>>{
  for(const path of ['',...roots,'scripts','scripts/agent-eval'])if((await lstat(join(root,path))).isSymbolicLink())throw new Error(`候选目录不能是链接：${path||root}`);
  const files:Record<string,string>={};
  const file=async(path:string)=>{
    const source=join(root,path);
    if((await lstat(source)).isSymbolicLink())throw new Error(`候选文件不能是链接：${path}`);
    const bytes=await readFile(source);files[path]=sha256(bytes);
    if(destination){await mkdir(dirname(join(destination,path)),{recursive:true});await writeFile(join(destination,path),bytes,{flag:'wx',mode:(await lstat(source)).mode});}
  };
  const tree=async(path:string)=>{
    for(const entry of (await readdir(join(root,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const child=`${path}/${entry.name}`;
      if(entry.isSymbolicLink())throw new Error(`候选文件不能是链接：${child}`);
      if(entry.isDirectory()){if(!skippedDirectories.has(entry.name))await tree(child);}
      else if(entry.isFile()&&entry.name!=='.package-lock.json')await file(child);
    }
  };
  for(const path of roots)await tree(path);
  for(const path of singles)await file(path);
  for(const entry of (await readdir(join(root,'scripts/agent-eval'),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
    if(entry.isFile()&&/\.(?:ts|mjs)$/.test(entry.name))await file(`scripts/agent-eval/${entry.name}`);
  }
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
}
export interface CandidateIdentity{
  files:Record<string,string>;
  mcpContract:string;
  defaults:{model:string;smallModel:string;endpoint:string;googleEndpoint:string;effort:null;contextPolicy:ContextPolicy;roundTimeoutMs:number;stagnationThreshold:number;maxTurns:Record<string,number>};
  node:{version:string;platform:string;arch:string;binary:string};
  providerRevision:null;
}
export interface Candidate{format:'renderweave-candidate/1';id:string;identity:CandidateIdentity}
export async function freezeCandidate(out:string):Promise<Candidate>{
  const target=resolve(out),path=relative(REPO,target);
  if(path===''||roots.some(root=>path===root||path.startsWith(root+'/')||path.startsWith(root+'\\')))throw new Error('候选包不能写进被快照的源码、资料或依赖目录');
  await mkdir(target);
  const files=await commonFiles(REPO,join(target,'content'));
  const changes=identityDifferences(files,await commonFiles());
  if(changes.length)throw new Error(`冻结期间来源变化，候选未发布：${changes.join('、')}`);
  const identity:CandidateIdentity={files,mcpContract:MCP_CONTRACT_VERSION,providerRevision:null,
    node:{version:process.version,platform:process.platform,arch:process.arch,binary:sha256(await readFile(process.execPath))},
    defaults:{model:DEFAULT_MODEL,smallModel:DEFAULT_SMALL_MODEL,endpoint:DEFAULT_ENDPOINT,googleEndpoint:DEFAULT_GOOGLE_ENDPOINT,
      effort:null,contextPolicy:contextPolicy(undefined),roundTimeoutMs:DEFAULT_ROUND_TIMEOUT_MS,stagnationThreshold:DEFAULT_STAGNATION_THRESHOLD,
      maxTurns:Object.fromEntries(Object.values(AGENT_TASKS).map(task=>[task.id,task.maxTurns]))}};
  const candidate:Candidate={format:'renderweave-candidate/1',id:sha256(JSON.stringify(identity)),identity};
  await writeFile(join(target,'candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  return candidate;
}
export async function verifyCandidate(dir:string,current=false):Promise<Candidate>{
  const candidate:Candidate=JSON.parse(await readFile(join(dir,'candidate.json'),'utf8'));
  if(candidate.format!=='renderweave-candidate/1'||!candidate.identity?.files||candidate.id!==sha256(JSON.stringify(candidate.identity)))throw new Error('候选清单损坏，未派发');
  const saved=identityDifferences(candidate.identity.files,await commonFiles(join(dir,'content')));
  if(saved.length)throw new Error(`候选包字节变化，未派发：\n${saved.join('\n')}`);
  if(current){
    const changed=identityDifferences(candidate.identity.files,await commonFiles());
    changed.push(...identityDifferences(candidate.identity.node,{version:process.version,platform:process.platform,arch:process.arch,binary:sha256(await readFile(process.execPath))},'node'));
    if(changed.length)throw new Error(`当前内容与候选不匹配，未派发：\n${changed.join('\n')}`);
  }
  return candidate;
}
export interface CandidateBinding{
  format:'renderweave-candidate-binding/1';id:string;candidate:{id:string;directory:string};identity:ExperimentIdentity;
  units:{scenario:string;repetition:number;stage:string}[];
  resourceEvidence:Record<string,{file:string;sha256:string}>;
  revalidation?:{previousBinding:string;previousCandidate:string;changed:string[];units:CandidateBinding['units']};
}
export async function bindCandidate(options:{candidate:string;config:string;out:string;scenarios?:string;repeat?:number;pairedJobs:number|null;runtime:RuntimeOptions;previousBinding?:string}):Promise<CandidateBinding>{
  const candidate=await verifyCandidate(options.candidate,true),config=await readConfig(options.config);
  const ids=options.scenarios?.split(',').map(value=>value.trim()).filter(Boolean),scenarios=ids?ids.map(id=>{
    const scenario=config.scenarios.find(value=>value.id===id);if(!scenario)throw new Error(`未知场景 ${id}`);return scenario;
  }):[...config.scenarios];
  const repeat=options.repeat??config.consecutivePasses;
  if(!Number.isSafeInteger(repeat)||repeat<config.consecutivePasses)throw new Error('绑定次数不得少于计划要求');
  const identity=await experimentIdentity(config,options.config,scenarios,options.runtime,{scenarios:scenarios.map(value=>value.id),repeat,pairedJobs:options.pairedJobs});
  const configBytes=await readFile(options.config);
  if(sha256(configBytes)!==identity.config)throw new Error('绑定时评分配置变化，绑定未发布');
  const units=Array.from({length:repeat},(_,index)=>scenarios.flatMap(scenario=>stageNames(scenario).map(stage=>({scenario:scenario.id,repetition:index+1,stage})))).flat();
  let revalidation:CandidateBinding['revalidation'];
  if(options.previousBinding){
    const previous:CandidateBinding=JSON.parse(await readFile(join(options.previousBinding,'binding.json'),'utf8'));
    const {id,...body}=previous;
    if(previous.format!=='renderweave-candidate-binding/1'||id!==sha256(JSON.stringify(body)))throw new Error('旧计划绑定损坏，不能推导重验单元');
    const old=await verifyCandidate(previous.candidate.directory);
    if(old.id!==previous.candidate.id)throw new Error('旧候选与计划绑定不符');
    const changed=[...identityDifferences(old.identity,candidate.identity,'candidate'),...identityDifferences(previous.identity,identity,'plan')];
    revalidation={previousBinding:id,previousCandidate:old.id,changed,units:changed.length?units:[]};
  }
  const resources=repoPath(config.resources);
  const bytes=await withLocalAccess([resources],async()=>{
    const opened=await openResourceRepository(resources);
    if(opened.problems.some(problem=>problem.level==='severe'))throw new Error('计划资源无法保存，绑定未发布');
    return Promise.all(opened.repository.list().map(async resource=>({id:resource.id,bytes:await opened.repository.read(resource.id)})));
  });
  await mkdir(options.out);await mkdir(join(options.out,'resources'));
  await writeFile(join(options.out,'config.json'),configBytes,{flag:'wx'});
  const resourceEvidence:CandidateBinding['resourceEvidence']={};
  for(const resource of bytes){
    const hash=sha256(resource.bytes);
    if(hash!==identity.resources[`resource-bytes/${resource.id}`])throw new Error(`绑定时资源变化：${resource.id}`);
    const file=`resources/${sha256(resource.id).slice(7)}.bin`;
    await writeFile(join(options.out,file),resource.bytes,{flag:'wx'});resourceEvidence[resource.id]={file,sha256:hash};
  }
  const changes=identityDifferences(identity.resources,await resourceInputIdentity(resources));
  if(changes.length)throw new Error(`绑定时资源变化，绑定未发布：${changes.join('、')}`);
  const body={format:'renderweave-candidate-binding/1' as const,candidate:{id:candidate.id,directory:resolve(options.candidate)},identity,units,resourceEvidence,...(revalidation?{revalidation}:{})};
  const binding={...body,id:sha256(JSON.stringify(body))};
  await writeFile(join(options.out,'binding.json'),JSON.stringify(binding,null,2)+'\n',{flag:'wx'});
  return binding;
}
export async function verifyCandidateBinding(dir:string,identity:ExperimentIdentity):Promise<{id:string;candidateId:string}>{
  const binding:CandidateBinding=JSON.parse(await readFile(join(dir,'binding.json'),'utf8'));
  const {id,...body}=binding;
  if(binding.format!=='renderweave-candidate-binding/1'||id!==sha256(JSON.stringify(body)))throw new Error('候选计划绑定损坏，未派发');
  const candidate=await verifyCandidate(binding.candidate.directory,true);
  if(candidate.id!==binding.candidate.id)throw new Error('候选身份不匹配，未派发');
  if(sha256(await readFile(join(dir,'config.json')))!==binding.identity.config)throw new Error('绑定评分配置字节变化，未派发');
  if((await lstat(join(dir,'resources'))).isSymbolicLink())throw new Error('绑定资源目录不能是链接，未派发');
  const resourceIds=Object.keys(binding.identity.resources).filter(key=>key.startsWith('resource-bytes/')).map(key=>key.slice('resource-bytes/'.length));
  if(!binding.resourceEvidence||identityDifferences([...resourceIds].sort(),Object.keys(binding.resourceEvidence).sort()).length)throw new Error('绑定资源清单不完整，未派发');
  for(const id of resourceIds){
    const resource=binding.resourceEvidence[id]!;
    if(!/^resources\/[a-f0-9]{64}\.bin$/.test(resource.file)||resource.sha256!==binding.identity.resources[`resource-bytes/${id}`])throw new Error(`绑定资源身份无效：${id}，未派发`);
    if((await lstat(join(dir,resource.file))).isSymbolicLink()||sha256(await readFile(join(dir,resource.file)))!==resource.sha256)throw new Error(`绑定资源字节变化：${id}，未派发`);
  }
  const changes=identityDifferences(binding.identity,identity);
  if(changes.length)throw new Error(`计划与候选绑定不匹配，未派发：\n${changes.join('\n')}`);
  return {id,candidateId:candidate.id};
}
