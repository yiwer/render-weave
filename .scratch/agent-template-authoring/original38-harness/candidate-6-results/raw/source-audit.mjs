// 只读已收到完成通知的固定分段；不遍历其他活动 run，不调用模型、评分或审核写入。
// node audit.mjs 1；第二段必须另获完成通知后使用2，累计报告不能重复加总。
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

const root = 'F:/GenCode/render-weave/out/harness-original38-candidate-6';
const candidateRoot = 'F:/GenCode/render-weave/out/harness-acceptance-20/candidate-6';
const destination = fileURLToPath(new URL('.', import.meta.url));
const segment = Number(process.argv[2] ?? '1');
if (![1,2].includes(segment)) throw new Error('只接受已明确完成的分段1或2');
const hash = b => createHash('sha256').update(b).digest('hex');
const prefixed = b => 'sha256:' + hash(b);
const clean = h => String(h).replace(/^sha256:/, '');
const checks = [], findings = [], observations = [], tracked = new Map(), snapshots = [];
function check(pass,label,detail) { checks.push({label,pass:!!pass}); if(!pass)findings.push({label,detail:detail??null}); }
function equal(actual,expected,label) {check(isDeepStrictEqual(actual,expected),label,{actual,expected});}
async function bytes(file) {const b=await readFile(file);tracked.set(resolve(file),hash(b));return b;}
async function json(file) {return JSON.parse((await bytes(file)).toString('utf8'));}
async function snapshot(dir) {
  const files={},directories=[];
  async function walk(current,prefix='') {
    for(const entry of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const rel=prefix+entry.name,p=join(current,entry.name);
      if(entry.isSymbolicLink())throw new Error('原件含链接：'+p);
      if(entry.isDirectory()){directories.push(rel);await walk(p,rel+'/');}
      else files[rel]=hash(await readFile(p));
    }
  }
  await walk(dir);return {files,directories};
}
function lines(b,label) {return b.toString('utf8').split(/\r?\n/).flatMap((raw,i)=>{if(!raw.trim())return [];try{return [{line:i+1,sha256:hash(raw),raw,event:JSON.parse(raw)}];}catch{check(false,label+':JSON行'+(i+1));return [];}});}
const sd=join(root,'dispatch',`segment-${segment}`), completed=await json(join(sd,'completed.json'));
equal(completed.segment,segment,'分段号');check(!completed.stopped&&!completed.monitorError&&!completed.recordError&&!completed.childError,'已正常结束的分段');
const registered=await json(join(root,'registration.json'));
equal(hash(await bytes(join(root,'registration.json'))),completed.registrationSha256,'登记SHA');
equal(hash(await bytes(join(root,'activation.json'))),completed.activationSha256,'激活SHA');
for(const channel of ['stdout','stderr'])equal(hash(await bytes(join(sd,channel+'.log'))),completed[channel+'Sha256'],channel+'SHA');
const reports=await json(join(sd,'reports.json'));
const reportRows=[];
for(const ref of reports){const file=join(sd,'report-'+basename(ref.file)),b=await bytes(file);equal(hash(b),ref.sha256,'固定报告SHA:'+basename(file));reportRows.push({file,bytes:b,report:JSON.parse(b)});}
const selected=reportRows.sort((a,b)=>Date.parse(b.report.endedAt)-Date.parse(a.report.endedAt))[0];
if(!selected)throw new Error('没有固定报告');
const {file:reportPath,bytes:reportBytes,report}=selected;
const bindingBytes=await bytes(join(registered.binding.directory,'binding.json')),binding=JSON.parse(bindingBytes);
const {id:bindingId,...body}=binding;
equal(bindingId,prefixed(JSON.stringify(body)),'绑定内容身份');equal(hash(bindingBytes),registered.binding.sha256,'登记绑定SHA');
equal(bindingId,completed.bindingId,'完成绑定ID');equal(report.candidateBinding,{id:bindingId,candidateId:binding.candidate.id},'报告绑定');equal(report.experimentIdentity,binding.identity,'报告实验身份');
const experimentId=prefixed(JSON.stringify(binding.identity));equal(experimentId,registered.experimentId,'登记实验ID');
const candidate=await json(join(candidateRoot,'candidate.json'));
equal(candidate.id,prefixed(JSON.stringify(candidate.identity)),'候选内容身份');equal(candidate.id,binding.candidate.id,'候选与绑定');equal(candidate.id,completed.candidateId,'完成候选ID');
equal(hash(await bytes(join(candidateRoot,'candidate.json'))),registered.candidate.manifestSha256,'候选清单SHA');
equal(prefixed(await bytes(registered.executor.file)),binding.identity.executor.files.command,'原生执行器SHA');equal(hash(await bytes(registered.executor.node)),registered.executor.nodeSha256,'Node二进制SHA');
const command=registered.commands.find(x=>x.segment===segment),configFile=command.args[command.args.indexOf('--config')+1],configBytes=await bytes(configFile),config=JSON.parse(configBytes);
equal(prefixed(configBytes),binding.identity.config,'配置SHA');equal(report.results.length,segment*4,'累计业务单元数');equal(report.attempts.length,segment*5,'累计模型阶段数');
equal(new Set(report.attempts.map(a=>a.id)).size,report.attempts.length,'尝试ID唯一');
const metrics={inputTokens:'input_tokens',outputTokens:'output_tokens',cacheReadTokens:'cache_read_input_tokens',cacheCreationTokens:'cache_creation_input_tokens'};
const totals=Object.fromEntries(Object.keys(metrics).map(k=>[k,0]));
let sealedFiles=0,nativeApiMs=0,nativeRuntimeMs=0,roundWallMs=0,attemptElapsedMs=0,thinkingTokens=0,toolCalls=0;
for(const unit of report.results){
  const expected=report.attempts.filter(a=>a.unit===`run-${unit.repetition}/${unit.id}`).map(a=>a.id).sort();
  equal((await readdir(join(root,'evaluation',`run-${unit.repetition}`,unit.id,'attempts'))).sort(),expected,unit.id+':原件尝试集合与报告一致');
}
for(const a of report.attempts){
  const repetition=Number(/^run-(\d+)\//.exec(a.unit)?.[1]);if(!(repetition>=1&&repetition<=segment))throw new Error('尝试超出已授权分段');
  const unit=report.results.find(x=>`run-${x.repetition}/${x.id}`===a.unit),scenario=config.scenarios.find(x=>x.id===unit?.id);if(!scenario)throw new Error('缺核准场景');
  const dir=resolve(root,'evaluation',a.dir),parent=resolve(root,'evaluation',a.unit,'attempts');
  if(relative(parent,dir)!==a.id)throw new Error('尝试目录越界');
  const before=await snapshot(dir);snapshots.push({dir,before});
  const seal=await json(join(dir,'completed.seal.json')),completion=await json(join(dir,'completed.json')),started=await json(join(dir,'started.json'));
  equal(hash(JSON.stringify(seal.completion)),seal.sha256,a.id+':封存对象SHA');equal(completion,seal.completion,a.id+':完成回执一致');
  const payload=Object.fromEntries(Object.entries(before.files).filter(([n])=>!['completed.json','completed.seal.json'].includes(n)));
  equal(Object.keys(payload).sort(),Object.keys(completion.files).sort(),a.id+':完整封存文件集合');
  for(const [file,sha]of Object.entries(completion.files))equal(payload[file],sha,a.id+':seal:'+file);
  sealedFiles+=Object.keys(completion.files).length;
  equal(started.id,a.id,a.id+':开始ID');equal(started.experiment,experimentId,a.id+':开始实验');equal(a.experiment,experimentId,a.id+':报告实验');equal(a.state,'completed',a.id+':完成状态');equal(a.elapsedMs,completion.elapsedMs,a.id+':尝试耗时');
  const rd=join(dir,'round'),round=await json(join(rd,'round.json')),proof=await json(join(rd,'evaluation.json')),execution=await json(join(rd,'execution.json'));
  equal(proof.experiment,experimentId,a.id+':轮次实验');
  for(const[file,sha]of Object.entries(proof.files))equal(hash(await bytes(join(rd,file))),clean(sha),a.id+':evaluation:'+file);
  equal(execution.status,'completed',a.id+':执行完成');equal(execution.recordSha256,hash(await bytes(join(rd,'round.json'))),a.id+':提交指纹');
  equal(round.runtime.maxTurns,binding.identity.budgets.maxTurns[round.task],a.id+':轮数预算');equal(round.runtime.roundTimeoutMs,binding.identity.budgets.roundTimeoutMs,a.id+':时限');equal(round.runtime.stagnationThreshold,binding.identity.budgets.stagnation,a.id+':停滞');
  for(const k of ['model','smallModel','endpoint','effort'])equal(round.runtime[k],binding.identity.runtime[k],a.id+':runtime:'+k);
  const provenance=await json(join(rd,'logs/provenance.json'));
  equal(provenance.mcpContract,binding.identity.mcpContract,a.id+':MCP');
  for(const [file,sha]of Object.entries(provenance.materials))equal(clean(binding.identity.materials[file]),sha,a.id+':资料:'+file);
  for(const [file,sha]of Object.entries(provenance.actualMaterials))equal(hash(await bytes(join(rd,'logs',file))),sha,a.id+':实际资料:'+file);
  const stream=lines(await bytes(join(rd,'logs/stream.jsonl')),a.id+':原生流'),init=stream.filter(x=>x.event.type==='system'&&x.event.subtype==='init'),responses=stream.filter(x=>x.event.type==='assistant'),results=stream.filter(x=>x.event.type==='result');
  check(init.length>0,a.id+':原生init');check(responses.length>0,a.id+':原生响应');equal(results.length,1,a.id+':唯一原生result');
  for(const e of init){equal(e.event.claude_code_version,registered.executor.version.split(' ')[0],a.id+':CLI:'+e.line);equal(e.event.model,binding.identity.runtime.model,a.id+':init模型:'+e.line);}
  for(const e of responses)equal(e.event.message?.model,binding.identity.runtime.model,a.id+':响应模型:'+e.line);
  const result=results.at(-1)?.event;equal(result?.is_error,false,a.id+':原生非错误');equal(result?.subtype,'success',a.id+':原生成功');equal(round.run.exitCode,0,a.id+':执行器退出');equal(round.run.turns,result?.num_turns,a.id+':原生轮数直录');equal(round.run.servedModel,binding.identity.runtime.model,a.id+':返回模型');
  const usage={};for(const[k,native]of Object.entries(metrics)){const value=result?.usage?.[native];check(Number.isFinite(value),a.id+':用量已知:'+k);equal(round.run[k],value,a.id+':round用量:'+k);equal(a.usage[k],value,a.id+':report用量:'+k);usage[k]=value??null;if(Number.isFinite(value))totals[k]+=value;}
  equal(round.run.thinkingTokens,result?.usage?.output_tokens_details?.thinking_tokens,a.id+':思考子集');thinkingTokens+=round.run.thinkingTokens;roundWallMs+=round.run.wallMs;attemptElapsedMs+=a.elapsedMs;nativeApiMs+=result.duration_api_ms;nativeRuntimeMs+=result.duration_ms;
  const checked=await json(join(rd,'check.json')),tools=lines(await bytes(join(rd,'logs/tools.jsonl')),a.id+':工具日志'),last=tools.filter(x=>x.event.tool==='check_outcome'&&!x.event.isError).at(-1);
  equal(last?.event.contentIdentity,checked.contentIdentity?.id,a.id+':最后工具与宿主终检身份');toolCalls+=a.usage.toolCalls;
  const retry=stream.filter(x=>x.event.type==='system'&&x.event.subtype==='api_retry'),apiErrors=stream.filter(x=>x.event.type==='error'||x.event.type==='assistant'&&x.event.is_api_error_message===true);
  const eventProof=x=>({line:x.line,sha256:x.sha256,event:x.event});
  observations.push({unit:a.unit,stage:a.stage,attemptId:a.id,directory:dir,sealedFiles:Object.keys(completion.files).length,sealSha256:tracked.get(resolve(dir,'completed.seal.json')),status:unit.status,task:round.task,source:{cliVersions:[...new Set(init.map(x=>x.event.claude_code_version))],responseModels:[...new Set(responses.map(x=>x.event.message?.model))],responseEvents:responses.map(x=>({line:x.line,sha256:x.sha256,model:x.event.message?.model})),resultLine:results.at(-1)?.line,resultSha256:results.at(-1)?.sha256,apiRetries:retry.map(eventProof),apiErrors:apiErrors.map(eventProof),providerRevision:null},runtime:round.runtime,usage,thinkingTokens:round.run.thinkingTokens,nativeReportedCostUsd:result.total_cost_usd??null,nativeCostMeaning:'CLI本地list估价，不是实际账单',nativeApiMs:result.duration_api_ms,nativeRuntimeMs:result.duration_ms,roundWallMs:round.run.wallMs,attemptElapsedMs:a.elapsedMs,nativeTurns:result.num_turns,finalCheckIdentity:checked.contentIdentity?.id,lastToolCheck:last?{line:last.line,at:last.event.at,contentIdentity:last.event.contentIdentity}:null,verdict:round.verdict,humanReview:null});
}
for(const[k,v]of Object.entries(totals))equal(v,report.totals[k],'原生累计:'+k);
equal(thinkingTokens,report.totals.thinkingTokens,'思考累计');equal(toolCalls,report.totals.toolCalls,'工具调用累计');equal(roundWallMs,report.totals.wallMs,'轮次墙钟累计');equal(attemptElapsedMs,report.timing.attemptsElapsedMs,'尝试耗时累计');
const segmentTiming=[];
for(const file of (await readdir(join(root,'evaluation/segments'))).filter(x=>x.endsWith('.completed.json'))){
  const end=await json(join(root,'evaluation/segments',file));if(Date.parse(end.endedAt)>Date.parse(report.endedAt))continue;
  const start=await json(join(root,'evaluation/segments',file.replace('.completed','.started')));segmentTiming.push({startedAt:start.startedAt,endedAt:end.endedAt,wallMs:Date.parse(end.endedAt)-Date.parse(start.startedAt)});
}
equal(segmentTiming.reduce((n,x)=>n+x.wallMs,0),report.timing.actualWallMs,'评估会话时间累计');
for(const {dir,before}of snapshots)equal(await snapshot(dir),before,dir+':只读前后完整集合SHA');
for(const[file,sha]of tracked)equal(hash(await readFile(file)),sha,'所读来源保持:'+file);
const retryCounts={nativeApiRetries:observations.reduce((n,x)=>n+x.source.apiRetries.length,0),nativeApiErrorMessages:observations.reduce((n,x)=>n+x.source.apiErrors.length,0),outerRetries:report.results.reduce((n,x)=>n+x.retries,0)};
const artifact={format:'renderweave-original38-candidate6-source-audit/1',createdAt:new Date().toISOString(),segment,scope:`仅固定第${segment}段累计报告中的已封存阶段，不读取其他活动run`,candidateId:candidate.id,bindingId,experimentId,report:{file:reportPath,sha256:hash(reportBytes),originalEvidence:report.evidence,gate:report.gate},sourceVerified:findings.length===0,modelCallsByAudit:0,publicReaderCalls:0,checks,findings,observations,sealedFiles,retryCounts,usage:{nativeSums:totals,reportedTotals:report.totals,nativeApiMs,nativeRuntimeMs,roundWallMs,attemptElapsedMs,timing:report.timing,wrapperWallMs:Date.parse(completed.endedAt)-Date.parse(completed.startedAt),segmentTiming},businessResults:report.results.map(x=>({id:x.id,repetition:x.repetition,status:x.status,retries:x.retries,checks:x.checks})),retainedFiles:[...tracked].map(([file,sha256])=>({file,sha256})),attemptSnapshots:snapshots.map(({dir,before})=>({directory:dir,...before})),humanReview:null,humanMinutes:null,actualMonetaryCost:null,limits:['原报告unverified/realModelObservations0保持；实际原生来源由本审计另证。','来源链不等于提供方签名认证；providerRevision未知。','四类用量来自原生result；thinking是output子集，CLI金额是本地list估价。','本次仅核来源与固定自动评分原件，不重评分、不代替业务人审。','累计报告不能与第一段重复加总；未完成槽不计失败。','仅对已封存尝试逐目录核前后完整集合，不对仍活动的evaluation根断言。']};
const stamp=new Date().toISOString().replaceAll(':','').replaceAll('.',''),out=join(destination,`segment-${segment}-${stamp}`);
await writeFile(out+'.json',JSON.stringify(artifact,null,2)+'\n',{flag:'wx'});
await writeFile(out+'.md',`# 原四候选6分段${segment}来源核验\n\n${findings.length?'存在待查项':'限定范围通过'}：${checks.length}项核查、${findings.length}项发现，${observations.length}个真实模型阶段、${sealedFiles}份封存文件。\n\n报告SHA：${hash(reportBytes)}。固定结果${report.gate.completeness.pass}pass/${report.gate.completeness.fail}fail/${report.gate.completeness.invalid}invalid/${report.gate.completeness.notRun}not-run。\n\n原生CLI ${registered.executor.version}；响应模型${binding.identity.runtime.model}。原生API重试${retryCounts.nativeApiRetries}，原生API错误消息${retryCounts.nativeApiErrorMessages}，外层重试${retryCounts.outerRetries}。\n\ninput ${totals.inputTokens}，cacheRead ${totals.cacheReadTokens}，cacheCreation ${totals.cacheCreationTokens}，output ${totals.outputTokens}。实际会话墙钟${report.timing.actualWallMs}ms；轮次${roundWallMs}ms；尝试${attemptElapsedMs}ms，分别记账。\n\n所读原件与已封存尝试完整集合及SHA前后保持；未调用模型、审核或评分入口。原报告unverified不回写，实际金额/人工结论/分钟仍未知。第二段若未获完成通知不在本次范围。\n\n详细证据：[JSON](${basename(out)}.json)。\n`,{flag:'wx'});
console.log(JSON.stringify({json:out+'.json',sha256:hash(await readFile(out+'.json')),markdown:out+'.md',checks:checks.length,findings,attempts:observations.length,sealedFiles,retryCounts,totals,timing:report.timing},null,2));
if(findings.length)process.exitCode=1;
