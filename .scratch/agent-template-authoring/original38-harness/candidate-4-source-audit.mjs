// 单次只读快照；不调用产品入口或模型，不读取环境变量/凭据，不改运行目录。
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
const hash=async p=>sha(await readFile(p));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const unique=a=>[...new Set(a.filter(x=>typeof x==='string'))].sort();
const finite=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const optional=async p=>readFile(p).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const json=async p=>{const b=await optional(p);return b?JSON.parse(b):null;};
const directories=async p=>(await readdir(p,{withFileTypes:true}).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(x=>x.isDirectory()).map(x=>x.name).sort();
const metrics={inputTokens:'input_tokens',cacheReadTokens:'cache_read_input_tokens',cacheCreationTokens:'cache_creation_input_tokens',outputTokens:'output_tokens'};
const defs=[
  {name:'original38',root:'F:/GenCode/render-weave/out/harness-original38-candidate-4/evaluation',binding:'F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four/binding-4',reports:'F:/GenCode/render-weave/out/harness-original38-candidate-4/reports',plannedObservations:8},
  {name:'ticket21',root:'F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4/observations',binding:'F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4/binding',reports:'F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4/reports',plannedObservations:16},
];
defs[0].retrospectiveReports='F:/GenCode/render-weave/out/harness-original38-candidate-4-post-stop-analysis/reports';
defs[0].stopReceipt='F:/GenCode/render-weave/out/harness-original38-candidate-4/dispatch-segment-2/operator-stop.json';
defs[1].retrospectiveReports='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4/post-stop/reports';
defs[1].stopReceipt='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4/STOP.json';
const previousFile=join(import.meta.dirname,'harness-live-source-usage-candidate4-stopped.json');
const previousBytes=await readFile(previousFile),previous=JSON.parse(previousBytes);
const snapshotAt=new Date().toISOString(),issues=[],checks=[],localCliApiErrors=[];
function check(name,passed){checks.push({name,passed:!!passed});if(!passed)issues.push(name);}
// Only this complete observed envelope is classified locally. Other synthetic
// messages remain in the remote-response model check and therefore fail.
const quotaText='API Error: Request rejected (429) · Go usage limit exceeded';
function isLocalCliQuotaError(e){
 return e.type==='assistant'&&e.is_api_error_message===true&&e.error==='rate_limit'
  &&e.message?.type==='message'&&e.message.role==='assistant'&&e.message.model==='<synthetic>'
  &&Object.values(metrics).every(k=>e.message.usage?.[k]===0)
  &&Array.isArray(e.message.content)&&e.message.content.length===1
  &&e.message.content[0].type==='text'&&e.message.content[0].text===quotaText;
}
const envelope={type:'assistant',is_api_error_message:true,error:'rate_limit',message:{type:'message',role:'assistant',model:'<synthetic>',usage:Object.fromEntries(Object.values(metrics).map(k=>[k,0])),content:[{type:'text',text:quotaText}]}};
check('分类器:精确错误信封',isLocalCliQuotaError(envelope));
for(const [label,mutate] of [
 ['非API错误',x=>delete x.is_api_error_message],['另一错误',x=>x.error='server_error'],
 ['非synthetic',x=>x.message.model='other-model'],['非零用量',x=>x.message.usage.input_tokens=1],
 ['缺少计量',x=>delete x.message.usage.output_tokens],['不同文本',x=>x.message.content[0].text+='!'],
 ['额外内容',x=>x.message.content.push({type:'text',text:'extra'})],
]){const e=structuredClone(envelope);mutate(e);check('分类器拒绝:'+label,!isLocalCliQuotaError(e));}
async function hashes(dir,prefix=''){
 const result={};
 for(const e of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
  if(e.isSymbolicLink()){issues.push('sealed原件含链接:'+join(dir,e.name));continue;}
  if(e.isDirectory()&&/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(e.name))continue;
  if(!prefix&&(['completed.json','completed.seal.json'].includes(e.name)||/^\.metadata-.*\.tmp$/.test(e.name)))continue;
  const name=prefix+e.name,path=join(dir,e.name);
  if(e.isDirectory())Object.assign(result,await hashes(path,name+'/'));else result[name]=await hash(path);
 }
 return result;
}
function parseStream(bytes,sealed,label){
 if(!bytes)return {events:[],records:[],partialTail:false};
 const events=[],records=[];let partialTail=false,line=0,start=0;
 while(start<bytes.length){
  line++;const newline=bytes.indexOf(10,start),end=newline<0?bytes.length:newline;
  const contentEnd=end>start&&bytes[end-1]===13?end-1:end,raw=bytes.subarray(start,contentEnd);
  if(raw.length)try{const event=JSON.parse(raw.toString('utf8'));events.push(event);records.push({event,line,byteOffset:start,byteLength:raw.length,eventSha256:sha(raw)});}
  catch{if(!sealed&&newline<0)partialTail=true;else issues.push('非完整事件:'+label+':'+line);}
  start=newline<0?bytes.length:newline+1;
 }
 return {events,records,partialTail};
}
function usageFrom(events){
 const messages=new Map(),terminal={};
 const known=u=>Object.fromEntries(Object.entries(metrics).filter(([,key])=>finite(u?.[key])).map(([key,source])=>[key,u[source]]));
 for(const e of events){if(e.type==='assistant'&&typeof e.message?.id==='string')messages.set(e.message.id,{...messages.get(e.message.id),...known(e.message.usage)});if(e.type==='result')Object.assign(terminal,known(e.usage));}
 const values={},sources={};for(const key of Object.keys(metrics)){if(terminal[key]!==undefined){values[key]=terminal[key];sources[key]='result';}else{const seen=[...messages.values()].map(x=>x[key]).filter(finite);values[key]=seen.length?seen.reduce((a,b)=>a+b,0):null;sources[key]=seen.length?'messages-partial':'unknown';}}
 return {values,sources,uniqueMessageIds:messages.size};
}
function union(intervals){let sum=0,end=-Infinity;for(const[a,b]of [...intervals].sort((x,y)=>x[0]-y[0])){sum+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return sum;}
const plans=[],globalIds=new Set();
for(const def of defs){
 const stopBytes=await optional(def.stopReceipt),stopReceipt=stopBytes?{file:def.stopReceipt,sha256:sha(stopBytes),record:JSON.parse(stopBytes)}:null;
 const manifestBytes=await readFile(join(def.root,'eval.json')),manifest=JSON.parse(manifestBytes),binding=await json(join(def.binding,'binding.json')),identity=manifest.identity,experiment='sha256:'+sha(JSON.stringify(identity));
 const {id,...body}=binding;
 check(def.name+':绑定身份',id==='sha256:'+sha(JSON.stringify(body))&&equal(identity,binding.identity)&&manifest.candidateBinding?.id===id&&manifest.candidateBinding?.candidateId===binding.candidate.id);
 check(def.name+':原生执行器摘要','sha256:'+await hash(identity.executor.command)===identity.executor.files.command);
 const attemptDirs=[];
 for(const run of(await directories(def.root)).filter(x=>/^run-\d+$/.test(x)))for(const scenario of await directories(join(def.root,run)))for(const id of await directories(join(def.root,run,scenario,'attempts')))attemptDirs.push({unit:run+'/'+scenario,dir:join(def.root,run,scenario,'attempts',id)});
 const attempts=[];
 for(const item of attemptDirs){
  const {dir,unit}=item,startedBytes=await readFile(join(dir,'started.json')),started=JSON.parse(startedBytes);
  const sealBytes=await optional(join(dir,'completed.seal.json')),seal=sealBytes?JSON.parse(sealBytes):null,completion=seal?.completion;
  check(def.name+':唯一attempt:'+started.id,!globalIds.has(started.id)&&started.id===basename(dir)&&started.format==='renderweave-eval-attempt/1'&&!started.legacy&&started.experiment===experiment);globalIds.add(started.id);
  const [run,scenario]=unit.split('/');check(def.name+':计划阶段:'+started.id,binding.units.some(x=>x.scenario===scenario&&x.repetition===Number(run.slice(4))&&x.stage===started.stage));
  let verifiedFiles=null;
  if(seal){
   check(def.name+':封存摘要:'+started.id,sha(JSON.stringify(completion))===seal.sha256);
   const compatibility=await json(join(dir,'completed.json'));check(def.name+':兼容完成记录:'+started.id,!compatibility||sha(JSON.stringify(compatibility))===seal.sha256);
   const actual=await hashes(dir);check(def.name+':封存全部文件:'+started.id,equal(actual,completion.files));verifiedFiles=Object.keys(actual).length;
   if(finite(completion.elapsedMs)&&completion.endedAt&&started.startedAt)check(def.name+':尝试耗时:'+started.id,Date.parse(completion.endedAt)-Date.parse(started.startedAt)===completion.elapsedMs);
  }
  const roundDir=join(dir,'round'),round=await json(join(roundDir,'round.json')),startRound=await json(join(roundDir,'round-start.json')),proof=await json(join(roundDir,'evaluation.json'));
  const streamBytes=await optional(join(roundDir,'logs/stream.jsonl')),parsed=parseStream(streamBytes,!!seal,started.id),events=parsed.events;
  const init=events.filter(x=>x.type==='system'&&x.subtype==='init'),assistant=events.filter(x=>x.type==='assistant'),results=events.filter(x=>x.type==='result'),usage=usageFrom(events);
  const localRecords=parsed.records.filter(x=>isLocalCliQuotaError(x.event));
  const remoteAssistant=assistant.filter(x=>!isLocalCliQuotaError(x));
  for(const record of localRecords){const {event,...location}=record;localCliApiErrors.push({plan:def.name,attemptId:started.id,streamFile:join(roundDir,'logs/stream.jsonl'),streamSha256:sha(streamBytes),...location,byteRangeConvention:'zero-based offset/length; excludes CR/LF terminator; SHA256 over exact original UTF-8 bytes',classification:'local-native-cli-api-rate-limit-error',originalModel:event.message.model,originalEvent:event});}
  const versions=unique(init.map(x=>x.claude_code_version)),initialModels=unique(init.map(x=>x.model)),models=unique(remoteAssistant.map(x=>x.message?.model)),allModels=unique(assistant.map(x=>x.message?.model)),resultModels=unique(results.flatMap(x=>Object.keys(x.modelUsage??{})));
  const runtime=round?.runtime??startRound?.runtime;
  if(runtime)check(def.name+':轮次运行参数:'+started.id,runtime.model===identity.runtime.model&&runtime.smallModel===identity.runtime.smallModel&&runtime.endpoint===identity.runtime.endpoint&&runtime.stagnationThreshold===identity.budgets.stagnation&&runtime.roundTimeoutMs===identity.budgets.roundTimeoutMs&&runtime.maxTurns===identity.budgets.maxTurns[started.task]&&(runtime.effort??null)===identity.runtime.effort);
  if(versions.length)check(def.name+':CLI版本:'+started.id,versions.every(x=>identity.executor.version.startsWith(x+' ')));
  if(initialModels.length)check(def.name+':初始化模型:'+started.id,initialModels.every(x=>x===identity.runtime.model));
  if(models.length)check(def.name+':响应消息模型:'+started.id,models.every(x=>x===identity.runtime.model));
  if(resultModels.length)check(def.name+':终结模型:'+started.id,resultModels.every(x=>x===identity.runtime.model));
  check(def.name+':最多一个终结事件:'+started.id,results.length<=1);
  if(proof)check(def.name+':评估来源:'+started.id,proof.experiment===experiment);
  if(seal&&round?.run){for(const key of Object.keys(metrics))check(def.name+':轮次用量:'+started.id+':'+key,(round.run[key]??null)===usage.values[key]);}
  const sealedTerminal=!!seal&&results.length===1;
  attempts.push({attemptId:started.id,unit,stage:started.stage,task:started.task,directory:dir,startedAt:started.startedAt,endedAt:completion?.endedAt??null,
   status:seal?'sealed':results.length?'terminal-unsealed-pending':'running-pending',verifiedFiles,
   sourceStatus:models.length&&versions.length?'observed-native-cli-response':init.length?'initialization-only-pending':'pending',registeredEndpoint:identity.runtime.endpoint,
   observedCliVersions:versions,initializationModels:initialModels,responseMessageModels:models,allAssistantMessageModels:allModels,resultModels,assistantEvents:assistant.length,remoteResponseEvents:remoteAssistant.length,localCliApiErrorEvents:localRecords.length,uniqueMessageIds:usage.uniqueMessageIds,resultEvents:results.length,partialTrailingLine:parsed.partialTail,
   stopBoundary:!seal&&stopReceipt?'dispatch stopped; original attempt remains unsealed/pending; no completion or duration inferred':null,
   usageStatus:sealedTerminal&&Object.values(usage.values).every(finite)?'complete-result':'pending-or-partial',usage:usage.values,usageSources:usage.sources,
   thinkingTokens:finite(results.at(-1)?.usage?.output_tokens_details?.thinking_tokens)?results.at(-1).usage.output_tokens_details.thinking_tokens:null,
   attemptElapsedMs:completion?.elapsedMs??null,roundWallMs:round?.run?.wallMs??null,cliDurationMs:results.at(-1)?.duration_ms??null,apiDurationMs:results.at(-1)?.duration_api_ms??null,
   exitCode:round?.run?.exitCode??null,endedBy:round?.run?.endedBy??null,stopped:round?.run?.stopped??null,hasRunError:!!completion?.error||!!round?.run?.error,
   providerRevision:null,monetaryCost:null,startedSha256:sha(startedBytes),sealSha256:sealBytes?sha(sealBytes):null,streamSha256:streamBytes?sha(streamBytes):null,streamBytes:streamBytes?.length??0});
 }
 const intervals=[],segments=[];
 const segmentDir=join(def.root,'segments'),segmentNames=await readdir(segmentDir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const file of segmentNames.filter(x=>x.endsWith('.started.json')).sort()){
  const startBytes=await readFile(join(segmentDir,file)),begin=JSON.parse(startBytes),endBytes=await optional(join(segmentDir,file.replace('.started.json','.completed.json'))),end=endBytes?JSON.parse(endBytes):null;
  const a=Date.parse(begin.startedAt),b=Date.parse(end?.endedAt??'');check(def.name+':分段身份:'+file,begin.experiment===experiment);
  const complete=Number.isFinite(a)&&Number.isFinite(b)&&b>=a;if(complete)intervals.push([a,b]);
  segments.push({file,startedAt:begin.startedAt,endedAt:end?.endedAt??null,first:begin.first,last:begin.last,jobs:begin.jobs,status:complete?'complete':'pending',elapsedMs:complete?b-a:null,startSha256:sha(startBytes),endSha256:endBytes?sha(endBytes):null});
 }
 const reports=[];
 for(const reportDirectory of [def.reports,def.retrospectiveReports])for(const name of (await readdir(reportDirectory).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(x=>x.endsWith('.json')).sort()){
  const bytes=await readFile(join(reportDirectory,name)),report=JSON.parse(bytes);if(report.format!=='renderweave-agent-eval/4')continue;
  check(def.name+':报告实验:'+name,equal(report.experimentIdentity,identity));
  check(def.name+':报告attempt唯一:'+name,new Set(report.attempts.map(x=>x.id)).size===report.attempts.length);
  let compared=0;for(const a of report.attempts){const observed=attempts.find(x=>x.attemptId===a.id);if(!observed||observed.status!=='sealed')continue;for(const key of Object.keys(metrics))check(def.name+':报告用量:'+a.id+':'+key,(a.usage?.[key]??null)===observed.usage[key]);compared++;}
  for(const key of Object.keys(metrics)){check(def.name+':报告汇总:'+key,report.totals[key]===report.attempts.reduce((s,a)=>s+(a.usage?.[key]??0),0));check(def.name+':报告未知计数:'+key,report.totals.unknownByMetric[key]===report.attempts.filter(a=>a.usage?.[key]===undefined).length);}
  const isRetrospective=!!report.rescoring;
  if(isRetrospective){check(def.name+':事后报告来源:'+name,report.rescoring.sourceIdentity===experiment);check(def.name+':事后报告完整已启动集合:'+name,equal(report.attempts.map(a=>a.id).sort(),attempts.map(a=>a.attemptId).sort()));}
  reports.push({file:join(reportDirectory,name),sha256:sha(bytes),origin:isRetrospective?'post-stop-retrospective-rescore':reportDirectory===def.reports?'original-runtime-report':'copy-of-original-report',rescoring:report.rescoring??null,gate:report.gate.completeness,attempts:report.attempts.length,comparedSealedAttempts:compared,unsealedAttemptsNotCompared:report.attempts.filter(a=>attempts.some(o=>o.attemptId===a.id&&o.status!=='sealed')).map(a=>({id:a.id,reportedUsage:a.usage??null})),mechanismRealModelObservations:report.evidence.realModelObservations,totals:report.totals,timing:report.timing});
 }
 const sealed=attempts.filter(a=>a.status==='sealed'),totals={};
 for(const key of Object.keys(metrics))totals[key]={sealedKnown:sealed.reduce((s,a)=>s+(a.usage[key]??0),0),sealedUnknown:sealed.filter(a=>a.usage[key]===null).length,pendingKnown:attempts.filter(a=>a.status!=='sealed').reduce((s,a)=>s+(a.usage[key]??0),0),pendingUnknown:attempts.filter(a=>a.status!=='sealed'&&a.usage[key]===null).length};
 const plan={name:def.name,root:def.root,experiment,candidateId:binding.candidate.id,bindingId:id,registeredNativeVersion:identity.executor.version,nativeExecutorSha256:identity.executor.files.command,
  manifestSha256:sha(manifestBytes),stopReceipt,plannedObservations:def.plannedObservations,plannedModelStages:binding.units.length,attemptsAtSnapshot:attempts.length,sealedAttempts:sealed.length,pendingAttempts:attempts.length-sealed.length,
  notStartedStages:binding.units.filter(u=>!attempts.some(a=>a.unit===`run-${u.repetition}/${u.scenario}`&&a.stage===u.stage)).length,
  totals,timing:{segments:segments.length,incompleteSegments:segments.filter(x=>x.status==='pending').length,actualWallMs:segments.length&&segments.every(x=>x.status==='complete')?union(intervals):null,knownCompletedSegmentsWallMs:union(intervals),knownSealedAttemptElapsedMs:sealed.reduce((s,a)=>s+(a.attemptElapsedMs??0),0),unknownSealedAttemptDurations:sealed.filter(a=>a.attemptElapsedMs===null).length,knownSealedRoundWallMs:sealed.reduce((s,a)=>s+(a.roundWallMs??0),0)},segments,attempts,reports};
 plans.push(plan);
}
for(const p of previous.plans){const current=plans.find(x=>x.name===p.name);check(p.name+':旧快照尝试集合不变',equal(p.attempts.map(x=>x.attemptId).sort(),current.attempts.map(x=>x.attemptId).sort()));for(const old of p.attempts){const now=current.attempts.find(x=>x.attemptId===old.attemptId);check(p.name+':原始流/封存/用量未改变:'+old.attemptId,!!now&&old.streamSha256===now.streamSha256&&old.sealSha256===now.sealSha256&&old.status===now.status&&equal(old.usage,now.usage)&&equal(old.usageSources,now.usageSources));}}
const classificationsOfPriorIssues=previous.issues.map(issue=>({originalIssue:issue,classifiedErrors:localCliApiErrors.filter(e=>issue===`${e.plan}:响应消息模型:${e.attemptId}`).map(e=>({attemptId:e.attemptId,eventSha256:e.eventSha256,line:e.line})),remainingIssue:issues.includes(issue)}));
check('旧两条告警均有精确原始事件',classificationsOfPriorIssues.length===2&&classificationsOfPriorIssues.every(x=>x.classifiedErrors.length===1&&!x.remainingIssue));
const output=resolve(process.argv[2]??join(import.meta.dirname,'harness-live-source-usage-'+snapshotAt.replaceAll(':','-')+'.json'));
if(relative(import.meta.dirname,output).startsWith('..')||resolve(output)===resolve(import.meta.dirname))throw new Error('审核结果必须保存在脚本所在外部目录');
const result={format:'renderweave-independent-live-source-usage-audit/2',snapshotStartedAt:snapshotAt,snapshotFinishedAt:new Date().toISOString(),auditScript:{file:import.meta.filename,sha256:await hash(import.meta.filename)},previousAudit:{file:previousFile,sha256:sha(previousBytes),checks:previous.checks,issues:previous.issues},classificationsOfPriorIssues,localCliApiErrors,plans,checks:checks.length,issues,
 limitations:['仅将完整匹配的CLI本地429错误信封从真实响应模型检查中单列；其他synthetic仍失败。使用未过滤的原始事件计算用量，零值错误事件不删除。','事后rescore只是另存诊断，不增加真实观测；各报告累计总计彼此不相加。','两个计划已停止，原四未封存轮次仍保留原pending状态与未知完整耗时；不据此伪造完成记录。','21 run-2/zh-definition-extraction的626845ms包含临时inspector诊断介入，根因未知，不作为无人介入正常收尾/性能证据。','只从唯一attempt原件计数，不重复计兼容阶段视图或多份累计报告。','本地原生CLI、固定endpoint配置及响应消息模型证明可观测来源，不是远端提供方签名认证；providerRevision未知。','四类token分别记账，thinking仅为output子集，不重复相加；CLI list-price估算不当作实际账单，人工分钟未知。','不调用模型，不读取环境变量或密钥配置，不改候选、旧结果或运行目录。']};
await writeFile(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,checks:checks.length,issues,plans:plans.map(p=>({name:p.name,attempts:p.attemptsAtSnapshot,sealed:p.sealedAttempts,pending:p.pendingAttempts,notStartedStages:p.notStartedStages,versions:unique(p.attempts.flatMap(a=>a.observedCliVersions)),responseModels:unique(p.attempts.flatMap(a=>a.responseMessageModels)),totals:p.totals,timing:p.timing}))},null,2));
if(issues.length)process.exitCode=1;
