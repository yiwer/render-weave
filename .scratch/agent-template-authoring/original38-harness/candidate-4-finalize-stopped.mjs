// 候选4被跨批额度停止后的部分结果归档；不伪造中断封存，不运行模型或重新评分。
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,readdir,access,lstat,cp,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const repo='F:/GenCode/render-weave',base=join(repo,'out'),root=join(base,'harness-original38-candidate-4');
const external='C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8';
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p));
const save=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx'});
const absent=async p=>access(p).then(()=>{throw Error('目标已存在:'+p);},e=>assert.equal(e.code,'ENOENT'));
async function tree(dir,prefix=''){
 assert.equal((await lstat(dir)).isSymbolicLink(),false,'根不得为链接:'+dir);
 const files=[],directories=[];
 for(const item of await readdir(dir,{withFileTypes:true})){
  const path=prefix+item.name,full=join(dir,item.name);assert.equal(item.isSymbolicLink(),false,path);
  if(item.isDirectory()){directories.push(path);const child=await tree(full,path+'/');files.push(...child.files);directories.push(...child.directories);}
  else {assert.ok(item.isFile(),path);files.push({path,sha256:sha(await readFile(full))});}
 }
 return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),directories:directories.sort()};
}
const metadata=join(base,'harness-original38-candidate-4-evidence-metadata');await absent(metadata);
const registrationBytes=await readFile(join(root,'registration.json')),registration=JSON.parse(registrationBytes);
const dispatch=[];
for(const segment of [1,2]){
 const ended=await json(join(root,'dispatch-segment-'+segment+'/completed.json'));
 assert.equal(ended.signal,null);assert.ok([0,1,3].includes(ended.exitCode));
 dispatch.push({segment,...ended});
}
const operatorStop=await json(join(root,'dispatch-segment-2/operator-stop.json'));
const sharedStop=await json(join(base,'harness21-trusted-feedback-candidate-4/STOP.json'));
assert.equal(sharedStop.reason,'quota-or-429');assert.equal(operatorStop.action,'terminate-own-registered-eval-process-tree');
const analysis=join(base,'harness-original38-candidate-4-post-stop-analysis');
const offlineProof=await json(join(analysis,'verification.json'));assert.equal(offlineProof.sourceUnchanged,true);assert.equal(offlineProof.modelCalls,0);
const reportPaths=[join(root,'reports/2026-10-23-harness-original38-candidate-4.json'),...(await readdir(join(analysis,'reports'))).filter(n=>n.includes('.rescore-')).map(n=>join(analysis,'reports',n))];
assert.equal(reportPaths.length,2,'必须保留首段首次报告及一份事后离线评分');
const reports=await Promise.all(reportPaths.map(async path=>{const bytes=await readFile(path);return {path,sha256:sha(bytes),report:JSON.parse(bytes)};}));
const final=reports.find(x=>x.report.rescoring);assert.ok(final,'必须存在另存的事后报告');
const {report}=final;assert.equal(report.format,'renderweave-agent-eval/4');
assert.deepEqual(report.gate.completeness,{planned:8,pass:4,fail:1,invalid:0,notRun:3,complete:false});assert.equal(report.results.length,5);
const auditPath=process.argv[2];assert.ok(auditPath,'需显式提供已核对合成API错误的停止后联合来源报告');
const auditBytes=await readFile(auditPath),audit=JSON.parse(auditBytes),source=audit.plans.find(p=>p.name==='original38');
assert.deepEqual(audit.issues,[]);assert.equal(source.sealedAttempts,6);assert.equal(source.pendingAttempts,1);assert.equal(source.attempts.length,7);
assert.equal(source.bindingId,registration.binding.id);assert.equal(source.candidateId,registration.candidate.id);
for(const actual of reports)assert.ok(source.reports.some(r=>r.sha256===actual.sha256),'报告须经来源核对:'+actual.path);
assert.equal(source.timing.actualWallMs,report.timing.actualWallMs);
const preregPath=join(repo,'.scratch/agent-template-authoring/original38-harness/conditional-english-reference.candidate-4.json');
const preregBytes=await readFile(preregPath),prereg=JSON.parse(preregBytes);
const sharedResultPath=join(base,'harness21-trusted-feedback-candidate-4/registration.candidate-4.results.json');
const sharedBytes=await readFile(sharedResultPath),shared=JSON.parse(sharedBytes);
assert.equal(prereg.sourceRegistration.sha256,sha(await readFile(prereg.sourceRegistration.file)));
assert.equal(prereg.candidateId,registration.candidate.id);assert.equal(shared.candidate.id,prereg.candidateId);
const sharedSource=audit.plans.find(p=>p.name==='ticket21');assert.equal(sharedSource.pendingAttempts,0);assert.equal(sharedSource.sealedAttempts,13);
const entries=prereg.entries.map(entry=>{
 const actual=shared.slots.find(s=>s.slot===entry.slot);assert.ok(actual);
 for(const key of ['scenario','repetition','unit','language','task','maxTurns'])assert.equal(actual[key],entry[key]);
 assert.equal(actual.candidateId,prereg.candidateId);assert.equal(actual.bindingId,prereg.bindingId);
 assert.equal(actual.experimentId.replace('sha256:',''),prereg.experimentId);assert.equal(actual.dispatchOwner,'harness-21');
 assert.ok(['pass','not-run'].includes(actual.status));assert.equal(actual.attempts.length,actual.status==='pass'?1:0);
 for(const attempt of actual.attempts){const observed=sharedSource.attempts.find(a=>a.attemptId===attempt.id);assert.equal(observed?.status,'sealed');assert.equal('sha256:'+observed.sealSha256,attempt.sealSha256);assert.equal(observed.unit,entry.unit);}
 if(actual.status==='pass'){assert.equal(actual.sourceVerification?.verified,true);for(const guard of prereg.requiredGuards)assert.equal(actual.guards[guard],true);}
 return {...entry,status:actual.status,sourceObservation:actual.status==='pass'?{attempt:actual.attempts[0],sourceRegistration:{path:sharedResultPath,sha256:sha(sharedBytes)},report:actual.resultReport.file,reportSha256:actual.resultReport.sha256,guards:actual.guards}:null,referenceDecision:actual.status==='pass'?'同身份受控英文纠偏可引用；不替代真实参考或独立人审':'额度停止后未派发，不引用通过',countsAsNewObservation:false};
});
assert.equal(entries.length,4);assert.equal(entries.filter(x=>x.status==='pass').length,2);
const reviews=[],reviewSources=[];
for(const repetition of [1])for(const task of ['template','revision']){
 const directory=join(base,`harness-original38-review/zh-${task}-r${repetition}-candidate-4`),bytes=await readFile(join(directory,'manifest.json')),manifest=JSON.parse(bytes);
 assert.equal(manifest.observationProof.candidateId,registration.candidate.id);
 assert.equal(manifest.observationProof.bindingId,registration.binding.id);
 assert.equal(manifest.observationProof.unit.repetition,repetition);
 assert.equal(manifest.observationProof.unit.scenario,'m402-'+task);
 const observed=source.attempts.find(a=>a.attemptId===manifest.observationProof.attemptId);assert.ok(observed);
 assert.equal(observed.unit,`run-${repetition}/m402-${task}`);assert.equal(observed.stage,task);assert.equal(observed.status,'sealed');
 assert.equal(sha(await readFile(join(observed.directory,'completed.seal.json'))),manifest.observationProof.completionSealSha256);
 assert.equal(manifest.candidate.id,registration.candidate.id);assert.equal(manifest.candidate.manifestSha256,registration.candidate.manifestSha256);
 assert.equal(manifest.generatorSha256,sha(await readFile(join(repo,'.scratch/agent-template-authoring/original38-harness/prepare-review-v3.mjs'))));
 assert.equal(manifest.generatorSha256,sha(await readFile(join(directory,'prepare-review.mjs'))));
 assert.equal(manifest.preflight,false);assert.equal(manifest.humanReview,null);assert.equal(manifest.status,'prepared-not-reviewed');
 const before=await tree(directory);assert.deepEqual(before.files.filter(f=>f.path!=='manifest.json'),[...manifest.files].sort((a,b)=>a.path.localeCompare(b.path)));
 const original=await tree(join(observed.directory,'round'));
 assert.deepEqual(original.files,[...manifest.sourceRoundFiles].sort((a,b)=>a.path.localeCompare(b.path)));
 assert.deepEqual(original.directories,[...manifest.sourceRoundDirectories].sort());
 const human=await json(join(directory,'review-template.json'));assert.equal(human.status,'not-reviewed');
 for(const key of ['reviewer','startedAt','endedAt','activeMinutes','autoDiagnosticsSeenBeforeFirstJudgment','originalJudgment','businessAcceptance'])assert.equal(human[key],null);
 assert.deepEqual(human.corrections,[]);assert.equal(human.items.length,16);
 for(const item of human.items)for(const [key,value]of Object.entries(item))if(!['id','label'].includes(key))assert.equal(value,null,key);
 const label=`zh-${task}-r${repetition}`;
 reviews.push({directory,archivedRelativePath:'metadata/reviews/'+label,manifestSha256:sha(bytes),attemptId:manifest.observationProof.attemptId,independentHumanReview:null});
 reviewSources.push({directory,label,before});
}
const result={format:'original38-candidate-results/1',recordedAt:new Date().toISOString(),candidate:registration.candidate,binding:registration.binding,experimentId:registration.experimentId,registrationSha256:sha(registrationBytes),reports:reports.map(x=>({path:x.path,sha256:x.sha256,gate:x.report.gate})),report:{path:final.path,sha256:final.sha256,gate:report.gate,mechanismEvidenceUnchanged:report.evidence},sourceAudit:{path:auditPath,sha256:sha(auditBytes),checks:audit.checks,issues:audit.issues,sourceVerifiedRealBusinessObservations:5,sourceVerifiedStartedModelStages:7,completedSealedStages:6,interruptedUnsealedStages:1},units:report.results.map(x=>({scenario:x.id,repetition:x.repetition,status:x.status,pass:x.pass,failures:x.failures,retries:x.retries,checks:x.checks})),attempts:source.attempts,totals:report.totals,timing:report.timing,dispatch,operatorStop,sharedStop,offlineRescoreVerification:offlineProof,reviews,limitations:['计划8槽保留：5有效业务观测为4pass/1fail；3not-run中包含1个已启动且在外部停止时尚未封存的模板尝试，另外2场景未启动；未重跑有效失败。','机制报告realModelObservations字段保持原字节；实际模型来源由原生执行器、响应与封存核对另证。','业务达线与执行完整性分别记录；中文独立样式审核及分钟尚未完成，纯英文真实参考仍需其单独材料核准与执行。','提供方模型修订、实际货币账单及人工分钟未知；未产生12例留出实际观测。','与21并发，不由两批墙钟差异推断策略收益。']};
// 所有源先读齐；结果和审核包仅在独立临时目录内落盘，完成后一次rename发布。
const preparedFiles=[];
for(const [name,file]of [['finalize.mjs',import.meta.filename],['verify-restored.mjs',join(base,'harness-original38-candidate4-stopped-verify-restored.mjs')],['source-audit.mjs',process.argv[3]]])preparedFiles.push({name,bytes:await readFile(file)});
const plan=join(base,'harness-acceptance-20/plans/original-four');
for(const file of ['config.json','original-config.json','preparation.json'])preparedFiles.push({name:'plan-'+file,bytes:await readFile(join(plan,file))});
const staging=metadata+'.staging-'+randomUUID();await mkdir(staging);
for(const file of preparedFiles)await writeFile(join(staging,file.name),file.bytes,{flag:'wx'});
await save(join(staging,'shared-english-reference.results.json'),{format:'original38-conditional-observation-reference-results/1',recordedAt:new Date().toISOString(),candidateId:registration.candidate.id,preregistration:{path:preregPath,sha256:sha(preregBytes)},entries,sharedObserved:2,newObservationsCreated:0,borrowedUsageAdded:0,scope:prereg.scope,notReplacements:prereg.notReplacements});
await writeFile(join(staging,'source-usage-audit.final.json'),auditBytes,{flag:'wx'});
await save(join(staging,'registration.results.json'),result);
await mkdir(join(staging,'reviews'));
for(const item of reviewSources){await cp(item.directory,join(staging,'reviews',item.label),{recursive:true,errorOnExist:true,force:false});assert.deepEqual(await tree(item.directory),item.before);assert.deepEqual(await tree(join(staging,'reviews',item.label)),item.before);}
const analysisBefore=await tree(analysis);await cp(analysis,join(staging,'post-stop-analysis'),{recursive:true,errorOnExist:true,force:false});assert.deepEqual(await tree(analysis),analysisBefore);assert.deepEqual(await tree(join(staging,'post-stop-analysis')),analysisBefore);
await save(join(staging,'archive-inputs.json'),{format:'renderweave-context-trial-archive-inputs/1',roots:[{label:'original38',path:root},{label:'candidate',path:registration.candidate.directory},{label:'plan-binding',path:registration.binding.directory},{label:'plan-inputs',path:join(plan,'inputs')},{label:'plan-resources',path:join(plan,'resources')},{label:'metadata',path:metadata}]});
await absent(metadata);await rename(staging,metadata);
console.log(JSON.stringify({root,reportSha256:final.sha256,gate:report.gate.completeness,attempts:source.attempts.length,sourceChecks:audit.checks,sharedEnglish:entries.map(e=>({slot:e.slot,status:e.status})),archiveInputs:join(metadata,'archive-inputs.json')}));
