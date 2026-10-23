/** 只测公开离线评估报告入口；这些手工数字不代表真实模型观测。 */
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {repoRoot} from './support/fixtures.js';
let root:string;
beforeAll(async()=>{root=await mkdtemp(join(tmpdir(),'rw-context-trial-'));});
afterAll(async()=>{await rm(root,{recursive:true,force:true});});
const sha=(value:unknown)=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function prepare(name:string){
  const policy={format:'renderweave-context-trial-policy/1',status:'frozen',cases:['calibration'],repetitions:2,plannedObservations:4,runtime:{model:'controlled-report'},
    metric:{fields:['inputTokens','cacheReadTokens','cacheCreationTokens'],minimumRelativeReduction:0.2,requiredKnownFields:['inputTokens','outputTokens','cacheReadTokens','cacheCreationTokens'],requiredUsageSource:'result'},
    quality:{requiredFeedbackGuards:['targetCorrection','nonTargetPreservation','unknownRetained','finalCheckMatches','pagination']}};
  const identity=(strategy:string)=>({contextPolicy:{name:strategy,id:strategy},runtime:{model:'controlled-report'},plan:{scenarios:['calibration'],repeat:2,pairedJobs:1},inputs:{sample:'same'},build:{engine:'same'}});
  const fullIdentity=identity('full'),candidateIdentity=identity('on-demand');
  const pair={format:'renderweave-context-pair/1',ready:true,arms:[fullIdentity,candidateIdentity].map(value=>({policy:value.contextPolicy.name,identity:value,identityHash:sha(value)}))};
  const report=(candidate:boolean)=>({format:'renderweave-agent-eval/4',experimentIdentity:candidate?candidateIdentity:fullIdentity,
    results:[1,2].map(repetition=>({id:'calibration',repetition,status:'pass',checks:{feedback:Object.fromEntries(policy.quality.requiredFeedbackGuards.map(key=>[key,true]))}})),
    attempts:[1,2].map(repetition=>({id:`${candidate?'candidate':'full'}-${repetition}`,unit:`run-${repetition}/calibration`,state:'completed',usage:{verdict:'qualified',usageSource:'result',inputTokens:candidate?70:100,outputTokens:candidate?40:50,cacheReadTokens:candidate?10:20,cacheCreationTokens:candidate?0:10}})),
    timing:{actualWallMs:candidate?180:200},runtime:{servedModels:['controlled-report'],providerRevision:null}});
  const files={policy:join(root,name+'-policy.json'),pair:join(root,name+'-pair.json'),full:join(root,name+'-full.json'),candidate:join(root,name+'-candidate.json'),out:join(root,name+'-out.json')};
  const values={policy,pair,full:report(false),candidate:report(true)};
  for(const key of ['policy','pair','full','candidate'] as const)await writeFile(files[key],JSON.stringify(values[key]));
  return {files,values};
}
async function summarize(files:Awaited<ReturnType<typeof prepare>>['files']){
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/context-trial-report.ts','--policy',files.policy,'--pair',files.pair,'--full',files.full,'--on-demand',files.candidate,'--out',files.out],{cwd:repoRoot,windowsHide:true}).catch(error=>error);
  return {code:result.code,stderr:result.stderr,report:JSON.parse(await readFile(files.out,'utf8'))};
}
it('公开比较按全部尝试计四类token，thinking未知不重复加入，数学收益不冒充真实来源或默认采用',async()=>{
  const {files}=await prepare('complete');const result=await summarize(files);
  expect(result.report).toMatchObject({complete:true,candidateEligible:true,verifiedRealModelObservations:0,decision:'requires-source-verification',
    full:{inputAndCacheTokens:260,outputTokens:100,actualWallMs:200,unknownThinkingAttempts:2},onDemand:{inputAndCacheTokens:160,outputTokens:80,actualWallMs:180}});
  expect(result.report.relativeReduction).toBeCloseTo(0.3846153846);
});
it.each(['unknown','partial','output','wall','quality'])('全部配对完成但%s守卫不满足时保留full，不用已知小计宣称更省',async(mode)=>{
  const {files,values}=await prepare(mode),candidate:any=values.candidate;
  if(mode==='unknown')delete candidate.attempts[1].usage.cacheReadTokens;
  if(mode==='partial')candidate.attempts[1].usage.usageSource='messages';
  if(mode==='output')candidate.attempts[1].usage.outputTokens=61;
  if(mode==='wall')candidate.timing.actualWallMs=201;
  if(mode==='quality')candidate.results[1].checks.feedback.nonTargetPreservation=false;
  await writeFile(files.candidate,JSON.stringify(candidate));const result=await summarize(files);
  expect(result.report).toMatchObject({complete:true,candidateEligible:false,decision:'retain-full'});
  if(mode==='unknown'||mode==='partial')expect(result.report.relativeReduction).toBeNull();
});
it('缺少计划内观测保持未完成，额外失败尝试也计入成本，原始报告不改写',async()=>{
  const {files,values}=await prepare('incomplete'),candidate:any=values.candidate;
  candidate.results.pop();candidate.attempts.pop();
  candidate.attempts.push({id:'failed-first',unit:'run-1/calibration',state:'completed',error:'上游失败',usage:{inputTokens:500,outputTokens:0,cacheReadTokens:0,cacheCreationTokens:0,usageSource:'result'}});
  const original=JSON.stringify(candidate);await writeFile(files.candidate,original);
  const result=await summarize(files);expect(result.code).toBe(3);
  expect(result.report).toMatchObject({complete:false,decision:'incomplete',candidateEligible:false,onDemand:{attempts:2,inputAndCacheTokens:580}});
  expect(await readFile(files.candidate,'utf8')).toBe(original);
});
it('报告与冻结身份不一致时拒绝比较，不产生可采用结果',async()=>{
  const {files,values}=await prepare('drift');values.candidate.experimentIdentity.runtime.model='changed';await writeFile(files.candidate,JSON.stringify(values.candidate));
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/context-trial-report.ts','--policy',files.policy,'--pair',files.pair,'--full',files.full,'--on-demand',files.candidate,'--out',files.out],{cwd:repoRoot,windowsHide:true}).catch(error=>error);
  expect(result.code).not.toBe(0);expect(result.stderr).toContain('报告与冻结身份不匹配');
  await expect(readFile(files.out)).rejects.toMatchObject({code:'ENOENT'});
});
it('既往尝试的关键不合格不能被单元最终通过覆盖',async()=>{
  const {files,values}=await prepare('critical-history');values.candidate.attempts[0]!.usage.verdict='unqualified';
  await writeFile(files.candidate,JSON.stringify(values.candidate));const result=await summarize(files);
  expect(result.report).toMatchObject({complete:true,candidateEligible:false,decision:'retain-full',onDemand:{nonqualifiedAttempts:1},guards:{candidateNoCriticalErrors:false}});
});
it('两组彼此一致但共同偏离预登记模型时仍拒绝，不把相互匹配当作登记核对',async()=>{
  const {files,values}=await prepare('policy-drift');
  for(const arm of values.pair.arms){arm.identity.runtime.model='other-model';arm.identityHash=sha(arm.identity);}
  await writeFile(files.pair,JSON.stringify(values.pair));
  for(const key of ['full','candidate'] as const){values[key].experimentIdentity.runtime.model='other-model';await writeFile(files[key],JSON.stringify(values[key]));}
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/context-trial-report.ts','--policy',files.policy,'--pair',files.pair,'--full',files.full,'--on-demand',files.candidate,'--out',files.out],{cwd:repoRoot,windowsHide:true}).catch(error=>error);
  expect(result.code).not.toBe(0);expect(result.stderr).toContain('运行条件与预登记政策不符');
  await expect(readFile(files.out)).rejects.toMatchObject({code:'ENOENT'});
});
