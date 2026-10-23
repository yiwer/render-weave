/** 只读比较已保存的公开报告；数字通过不自动证明真实来源，也不修改默认策略。 */
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values} = parseArgs({options: {policy: {type:'string'}, pair: {type:'string'}, full: {type:'string'}, 'on-demand': {type:'string'}, out: {type:'string'}}, strict:true});
for (const name of ['policy','pair','full','on-demand','out'] as const) if (!values[name]) throw new Error(`缺少 --${name}`);
const sha = (value:string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const read = async (file:string) => { const bytes=await readFile(resolve(file),'utf8'); return {value:JSON.parse(bytes),sha256:sha(bytes),file:resolve(file)}; };
const [policyFile,pairFile,fullFile,candidateFile] = await Promise.all([read(values.policy!),read(values.pair!),read(values.full!),read(values['on-demand']!)]);
const policy=policyFile.value, pair=pairFile.value;
if (policy.format!=='renderweave-context-trial-policy/1' || policy.status!=='frozen' || pair.format!=='renderweave-context-pair/1' || pair.ready!==true) throw new Error('需要已冻结政策与完整配对身份');
if (!Array.isArray(policy.cases) || !policy.cases.length || new Set(policy.cases).size!==policy.cases.length || !Number.isSafeInteger(policy.repetitions) || policy.repetitions<1
  || policy.plannedObservations!==2*policy.cases.length*policy.repetitions) throw new Error('预登记单元不完整');
const planned:string[] = policy.cases.flatMap((id:string) => Array.from({length:policy.repetitions},(_,i)=>`run-${i+1}/${id}`));
const guards:string[] = policy.quality.requiredFeedbackGuards;
const knownFields:string[] = policy.metric.requiredKnownFields;
const inputFields:string[] = policy.metric.fields;
const number = (value:unknown):value is number => typeof value==='number' && Number.isFinite(value) && value>=0;
const key = (value:any) => `run-${value.repetition}/${value.id}`;

function inspect(file:typeof fullFile,strategy:string) {
  const report=file.value, arm=pair.arms?.find((value:any)=>value.policy===strategy);
  if (report.format!=='renderweave-agent-eval/4' || !arm || arm.identityHash!==sha(JSON.stringify(arm.identity))
    || JSON.stringify(report.experimentIdentity)!==JSON.stringify(arm.identity)) throw new Error(`${strategy} 报告与冻结身份不匹配`);
  if (JSON.stringify(arm.identity.plan.scenarios)!==JSON.stringify(policy.cases) || arm.identity.plan.repeat!==policy.repetitions) throw new Error(`${strategy} 计划与政策不匹配`);
  const registered=policy.runtime;
  const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right);
  if (!registered || ['model','smallModel','endpoint','effort','providerRevision'].some(field=>Object.hasOwn(registered,field)&&!same(registered[field],arm.identity.runtime?.[field]))
    || Object.hasOwn(registered,'claudeVersion') && !arm.identity.executor?.version?.startsWith(registered.claudeVersion)
    || Object.hasOwn(registered,'roundTimeoutMs') && !same(registered.roundTimeoutMs,arm.identity.budgets?.roundTimeoutMs)
    || Object.hasOwn(registered,'maxTurns') && !same(registered.maxTurns,arm.identity.budgets?.maxTurns)
    || Object.hasOwn(registered,'stagnationThreshold') && !same(registered.stagnationThreshold,arm.identity.budgets?.stagnation)
    || policy.schedule?.jobs!==undefined && policy.schedule.jobs!==arm.identity.plan.pairedJobs) throw new Error(`${strategy} 运行条件与预登记政策不符`);
  const results:any[]=report.results, attempts:any[]=report.attempts;
  if (!Array.isArray(results) || !Array.isArray(attempts) || new Set(results.map(key)).size!==results.length || results.some(value=>!planned.includes(key(value)))
    || new Set(attempts.map(value=>value.id)).size!==attempts.length || attempts.some(value=>!planned.includes(value.unit))) throw new Error(`${strategy} 结果或尝试身份重复/超出计划`);
  const byUnit=new Map(results.map(value=>[key(value),value]));
  const complete=planned.every(unit=>['pass','fail'].includes(byUnit.get(unit)?.status) && attempts.some(value=>value.unit===unit))
    && attempts.every(value=>value.state==='completed');
  const unknownByMetric=Object.fromEntries(knownFields.map(field=>[field,attempts.filter(value=>!number(value.usage?.[field])).length]));
  const partialUsageAttempts=attempts.filter(value=>value.usage?.usageSource!==policy.metric.requiredUsageSource).length;
  const sum=(field:string)=>attempts.reduce((total,value)=>total+(number(value.usage?.[field])?value.usage[field]:0),0);
  const units=planned.map(unit=>{const value=byUnit.get(unit); return {unit,status:value?.status??'not-run',feedback:value?.checks?.feedback??null,failures:value?.failures??[]};});
  return {byUnit,summary:{attempts:attempts.length,complete,units,
    nonqualifiedAttempts:attempts.filter(value=>value.usage?.verdict==='unqualified').length,
    unknownVerdictAttempts:attempts.filter(value=>!['qualified','unqualified'].includes(value.usage?.verdict)).length,
    inputAndCacheTokens:inputFields.reduce((total,field)=>total+sum(field),0),outputTokens:sum('outputTokens'),
    metricTotals:Object.fromEntries([...knownFields,'thinkingTokens','wallMs'].map(field=>[field,sum(field)])),
    unknownByMetric,partialUsageAttempts,unknownThinkingAttempts:attempts.filter(value=>!number(value.usage?.thinkingTokens)).length,
    usageComplete:attempts.length>0 && Object.values(unknownByMetric).every(value=>value===0) && partialUsageAttempts===0,
    actualWallMs:number(report.timing?.actualWallMs)?report.timing.actualWallMs:null,
    servedModels:report.runtime?.servedModels??[],providerRevision:report.runtime?.providerRevision??null,
    stops:attempts.map(value=>({attempt:value.id,stopped:value.usage?.stopped??null,endedBy:value.usage?.endedBy??null,error:value.error??null})),
    humanReviewMinutes:null,humanCorrectionMinutes:null,humanReworkMinutes:null}};
}
const full=inspect(fullFile,'full'), candidate=inspect(candidateFile,'on-demand');
const common=(identity:any)=>{const {contextPolicy:_strategy,...rest}=identity; return JSON.stringify(rest);};
if (common(fullFile.value.experimentIdentity)!==common(candidateFile.value.experimentIdentity)) throw new Error('两组除资料策略外的冻结条件不同');
const complete=full.summary.complete && candidate.summary.complete;
const measured=complete && full.summary.usageComplete && candidate.summary.usageComplete;
const relativeReduction=measured && full.summary.inputAndCacheTokens>0 ? 1-candidate.summary.inputAndCacheTokens/full.summary.inputAndCacheTokens : null;
const qualityNoRegression=planned.every(unit=>guards.every(guard=>full.byUnit.get(unit)?.checks?.feedback?.[guard]!==true || candidate.byUnit.get(unit)?.checks?.feedback?.[guard]===true));
const candidateAllPass=planned.every(unit=>candidate.byUnit.get(unit)?.status==='pass' && guards.every(guard=>candidate.byUnit.get(unit)?.checks?.feedback?.[guard]===true));
const candidateNoCriticalErrors=candidate.summary.nonqualifiedAttempts===0 && candidate.summary.unknownVerdictAttempts===0;
const qualityPass=complete && qualityNoRegression && candidateAllPass && candidateNoCriticalErrors;
const outputNotIncreased=measured && candidate.summary.outputTokens<=full.summary.outputTokens;
const wallNotIncreased=number(full.summary.actualWallMs) && number(candidate.summary.actualWallMs) && candidate.summary.actualWallMs<=full.summary.actualWallMs;
const candidateEligible=measured && qualityPass && outputNotIncreased && wallNotIncreased && relativeReduction!==null && relativeReduction>=policy.metric.minimumRelativeReduction;
const result={format:'renderweave-context-trial-comparison/1',complete,candidateEligible,
  decision:!complete?'incomplete':candidateEligible?'requires-source-verification':'retain-full',
  verifiedRealModelObservations:0,sourceVerification:'仅从报告不能证明真实执行来源；须另核原生CLI、冻结派发和尝试原件登记。',
  sources:{policy:{file:policyFile.file,sha256:policyFile.sha256},pair:{file:pairFile.file,sha256:pairFile.sha256},full:{file:fullFile.file,sha256:fullFile.sha256},onDemand:{file:candidateFile.file,sha256:candidateFile.sha256}},
  full:full.summary,onDemand:candidate.summary,relativeReduction,guards:{qualityNoRegression,candidateAllPass,candidateNoCriticalErrors,outputNotIncreased,wallNotIncreased},
  monetaryCost:null,totalCostImprovement:null,note:'保守工程决策线；人工分钟、金额及提供方修订未知。不改写原始报告、不修改默认。'};
await writeFile(resolve(values.out!),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
process.exitCode=complete?0:3;
