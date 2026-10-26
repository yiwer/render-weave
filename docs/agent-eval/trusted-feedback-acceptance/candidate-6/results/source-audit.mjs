// 只读指定已完成分段的固定报告和封存尝试；不读取/遍历其他正在执行的 run。
// 用法：node audit.mjs 1。后续分段必须收到明确授权再传 2；分段 2 为累计值，不能与分段 1 相加。
import {readFile, readdir, lstat, writeFile} from 'node:fs/promises';
import {join, resolve, relative, basename} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const root='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-6';
const candidateRoot='F:/GenCode/render-weave/out/harness-acceptance-20/candidate-6';
const destination=fileURLToPath(new URL('.',import.meta.url));
const segment=Number(process.argv[2]??'1');
if(![1,2].includes(segment))throw new Error('只接受明确指定的已完成分段 1 或 2');
const stamp=new Date().toISOString().replaceAll(':','').replaceAll('.','');
const out=join(destination,`segment-${segment}-${stamp}`);
const hash=b=>createHash('sha256').update(b).digest('hex');
const prefixed=b=>'sha256:'+hash(b);
const cleanHash=x=>String(x).replace(/^sha256:/,'');
const checks=[],findings=[],observations=[],tracked=new Map();
function check(condition,label,detail){checks.push({label,pass:!!condition});if(!condition)findings.push({label,detail:detail??null});}
function equal(actual,expected,label){check(isDeepStrictEqual(actual,expected),label,{actual,expected});}
async function bytes(file){const b=await readFile(file);tracked.set(resolve(file),hash(b));return b;}
async function json(file){return JSON.parse((await bytes(file)).toString('utf8'));}
async function snapshot(dir){
  const files={},directories=[];
  async function visit(current,prefix=''){
    for(const item of (await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const rel=prefix+item.name,path=join(current,item.name);
      if(item.isSymbolicLink())throw new Error(`原件不应包含链接：${path}`);
      if(item.isDirectory()){directories.push(rel);await visit(path,rel+'/');}
      else files[rel]=hash(await readFile(path));
    }
  }
  await visit(dir);return {files,directories};
}
function parseLines(b,label){return b.toString('utf8').split(/\r?\n/).flatMap((line,index)=>{
  if(!line.trim())return [];
  try{return [{line:index+1,sha256:hash(line),event:JSON.parse(line)}];}
  catch{check(false,label+':json-line-'+(index+1));return [];}
});}
function target(doc,path){
  const tokens=path.slice(1).split('/').map(x=>x.replaceAll('~1','/').replaceAll('~0','~'));let parent=doc;
  for(const token of tokens.slice(0,-1)){if(!parent||!Object.hasOwn(parent,token))return null;parent=parent[token];}
  const key=tokens.at(-1);return parent&&Object.hasOwn(parent,key)?{parent,key,value:parent[key]}:null;
}
const segmentDir=join(root,'dispatch',`segment-${segment}`);
const completed=await json(join(segmentDir,'completed.json'));
check(!completed.stopped&&!completed.monitorError&&!completed.recordError&&!completed.childError,'指定分段已正常结束',completed);
equal(completed.segment,segment,'完成回执的分段号');
const registered=await json(join(root,'registration.json'));
equal(hash(await bytes(join(root,'registration.json'))),completed.registrationSha256,'登记原件 SHA');
equal(hash(await bytes(join(root,'activation.json'))),completed.activationSha256,'激活原件 SHA');
for(const channel of ['stdout','stderr'])equal(hash(await bytes(join(segmentDir,channel+'.log'))),completed[channel+'Sha256'],channel+'固定日志 SHA');
const reports=await json(join(segmentDir,'reports.json'));
equal(reports.length,segment,'分段固定报告数');
const selectedReport=reports.find(row=>row.sha256===(segment===2?'3e12be8957425fc613099f4153796b9df2e9043bfebe87303f8b1740ae855771':'4582ecd461db16b42a1f4fe452b4907d45420352e1ac55fbd8054d3e16a3f0b4'));
if(!selectedReport)throw new Error('没有根代理指定的固定报告');
const reportPath=join(segmentDir,'report-'+basename(selectedReport.file));
const reportBytes=await bytes(reportPath),report=JSON.parse(reportBytes);
equal(hash(reportBytes),selectedReport.sha256,'固定报告 SHA');
const bindingBytes=await bytes(join(root,'binding/binding.json')),binding=JSON.parse(bindingBytes);
const {id:bindingId,...bindingBody}=binding;
equal(bindingId,prefixed(JSON.stringify(bindingBody)),'绑定内容身份');
equal(hash(bindingBytes),registered.binding.sha256,'登记绑定 SHA');
equal(bindingId,completed.bindingId,'回执绑定 ID');
equal(report.candidateBinding,{id:bindingId,candidateId:binding.candidate.id},'报告候选绑定');
equal(report.experimentIdentity,binding.identity,'报告实验身份');
const experimentId=prefixed(JSON.stringify(binding.identity));
equal(experimentId,registered.experimentId,'登记实验 ID');
const candidate=await json(join(candidateRoot,'candidate.json'));
equal(candidate.id,prefixed(JSON.stringify(candidate.identity)),'候选内容身份');
equal(candidate.id,binding.candidate.id,'绑定候选 ID');
equal(candidate.id,completed.candidateId,'完成回执候选 ID');
equal(hash(await bytes(join(candidateRoot,'candidate.json'))),registered.candidate.manifestSha256,'候选清单 SHA');
equal(prefixed(await bytes(registered.executor.file)),binding.identity.executor.files.command,'实际原生执行器二进制 SHA');
equal(hash(await bytes(registered.executor.node)),registered.executor.nodeSha256,'Node 二进制 SHA');
const configBytes=await bytes(join(root,'inputs/config.real-model.json')),config=JSON.parse(configBytes);
equal(prefixed(configBytes),binding.identity.config,'评分配置 SHA');
equal(report.results.length,segment*8,'累计有效单元数');
equal(report.attempts.length,segment*8,'累计唯一尝试数');
equal(new Set(report.attempts.map(a=>a.id)).size,report.attempts.length,'尝试 ID 不重复');
const indexFile=join(candidateRoot,'content/dist/index.js');
equal(prefixed(await bytes(indexFile)),candidate.identity.files['dist/index.js'],'公开只读入口字节');
const {readReview}=await import(pathToFileURL(indexFile).href);
const metrics={inputTokens:'input_tokens',outputTokens:'output_tokens',cacheReadTokens:'cache_read_input_tokens',cacheCreationTokens:'cache_creation_input_tokens'};
const totals=Object.fromEntries(Object.keys(metrics).map(key=>[key,0]));
let sealedFiles=0,nativeApiMs=0,nativeRuntimeMs=0,roundWallMs=0,attemptElapsedMs=0;
const snapshots=[];
for(const a of report.attempts){
  const repetition=Number(/^run-(\d+)\//.exec(a.unit)?.[1]);
  if(!Number.isInteger(repetition)||repetition<1||repetition>segment)throw new Error('报告含超出已授权分段的尝试');
  const unit=report.results.find(x=>`run-${x.repetition}/${x.id}`===a.unit),scenario=config.scenarios.find(x=>x.id===unit?.id);
  if(!scenario)throw new Error('尝试缺少对应核准场景');
  const dir=resolve(root,'observations',a.dir);
  if(!relative(resolve(root,'observations',`run-${repetition}`),dir).startsWith(unit.id+'/')&&!relative(resolve(root,'observations',`run-${repetition}`),dir).startsWith(unit.id+'\\'))throw new Error('尝试路径越界');
  equal((await readdir(join(root,'observations',a.unit,'attempts'))).sort(),[a.id],a.unit+':只有一个已登记实际尝试');
  const before=await snapshot(dir);snapshots.push({dir,before});
  const seal=await json(join(dir,'completed.seal.json')),completion=await json(join(dir,'completed.json')),started=await json(join(dir,'started.json'));
  equal(hash(JSON.stringify(seal.completion)),seal.sha256,a.unit+':封存对象 SHA');
  equal(completion,seal.completion,a.unit+':完成回执与封存一致');
  const actualPayload=Object.fromEntries(Object.entries(before.files).filter(([name])=>!['completed.json','completed.seal.json'].includes(name)));
  equal(Object.keys(actualPayload).sort(),Object.keys(completion.files).sort(),a.unit+':封存完整文件集合');
  for(const [file,sha] of Object.entries(completion.files))equal(actualPayload[file],sha,a.unit+':seal:'+file);
  sealedFiles+=Object.keys(completion.files).length;
  equal(started.id,a.id,a.unit+':started ID');equal(started.experiment,experimentId,a.unit+':started 实验');
  equal(started.input.from,scenario.seedRound,a.unit+':本轮来自预置 seed');
  equal(a.state,'completed',a.unit+':完成状态');equal(a.elapsedMs,completion.elapsedMs,a.unit+':尝试耗时');
  const rd=join(dir,'round'),round=await json(join(rd,'round.json')),proof=await json(join(rd,'evaluation.json')),execution=await json(join(rd,'execution.json'));
  equal(proof.experiment,experimentId,a.unit+':轮次实验封存');
  for(const [file,sha]of Object.entries(proof.files))equal(hash(await bytes(join(rd,file))),cleanHash(sha),a.unit+':evaluation:'+file);
  equal(execution.status,'completed',a.unit+':执行完成');equal(execution.recordSha256,hash(await bytes(join(rd,'round.json'))),a.unit+':最终提交指纹');
  equal(round.runtime.maxTurns,binding.identity.budgets.maxTurns[scenario.task],a.unit+':任务轮数预算');
  equal(round.runtime.roundTimeoutMs,binding.identity.budgets.roundTimeoutMs,a.unit+':时间预算');
  equal(round.runtime.stagnationThreshold,binding.identity.budgets.stagnation,a.unit+':停滞预算');
  for(const key of ['model','smallModel','endpoint','effort'])equal(round.runtime[key],binding.identity.runtime[key],a.unit+':runtime:'+key);
  const provenance=await json(join(rd,'logs/provenance.json'));
  equal(provenance.mcpContract,binding.identity.mcpContract,a.unit+':MCP 合同');
  for(const [file,sha]of Object.entries(provenance.materials))equal(cleanHash(binding.identity.materials[file]),sha,a.unit+':资料:'+file);
  for(const [file,sha]of Object.entries(provenance.actualMaterials))equal(hash(await bytes(join(rd,'logs',file))),sha,a.unit+':实际资料:'+file);
  const events=parseLines(await bytes(join(rd,'logs/stream.jsonl')),a.unit+':原生流');
  const init=events.filter(x=>x.event.type==='system'&&x.event.subtype==='init');
  const assistants=events.filter(x=>x.event.type==='assistant');
  const results=events.filter(x=>x.event.type==='result');
  const apiErrors=events.filter(x=>x.event.type==='error'||x.event.type==='system'&&x.event.subtype==='api_retry'||x.event.type==='assistant'&&x.event.is_api_error_message===true);
  check(init.length>0,a.unit+':原生初始化存在');check(assistants.length>0,a.unit+':实际响应存在');equal(results.length,1,a.unit+':唯一原生结果');
  for(const e of init){equal(e.event.claude_code_version,registered.executor.version.split(' ')[0],a.unit+':CLI版本:'+e.line);equal(e.event.model,binding.identity.runtime.model,a.unit+':初始化模型:'+e.line);}
  for(const e of assistants)equal(e.event.message?.model,binding.identity.runtime.model,a.unit+':响应模型:'+e.line);
  const result=results.at(-1)?.event;
  equal(result?.is_error,false,a.unit+':原生结果非错误');equal(result?.subtype,'success',a.unit+':原生正常结束');equal(round.run.exitCode,0,a.unit+':执行器退出');
  equal(round.run.turns,result?.num_turns,a.unit+':返回轮次计数');equal(round.run.servedModel,binding.identity.runtime.model,a.unit+':轮次记录服务模型');
  const usage={};for(const [key,nativeKey]of Object.entries(metrics)){
    const value=result?.usage?.[nativeKey];check(Number.isFinite(value),a.unit+':用量已知:'+key);usage[key]=value??null;
    equal(round.run[key],value,a.unit+':轮次用量:'+key);equal(a.usage[key],value,a.unit+':报告用量:'+key);if(Number.isFinite(value))totals[key]+=value;
  }
  equal(round.run.thinkingTokens,result?.usage?.output_tokens_details?.thinking_tokens,a.unit+':思考包含在输出中');
  roundWallMs+=round.run.wallMs;attemptElapsedMs+=a.elapsedMs;nativeApiMs+=result.duration_api_ms;nativeRuntimeMs+=result.duration_ms;
  const checked=await json(join(rd,'check.json')),toolLog=parseLines(await bytes(join(rd,'logs/tools.jsonl')),a.unit+':工具日志');
  const tools=toolLog.map(x=>({line:x.line,...x.event})),lastCheck=tools.filter(x=>x.tool==='check_outcome'&&!x.isError).at(-1);
  const compares=tools.filter(x=>x.tool==='compare_reference'&&!x.isError);
  const policy=await json(scenario.policy),seed=await json(join(scenario.seedRound,'agent',policy.candidate)),seedCheck=await json(join(scenario.seedRound,'check.json'));
  const review=await readReview(rd,{persistArtifacts:false});
  check(review.execution?.committed===true,a.unit+':公开只读审核确认已提交');
  const current=review.view?.candidates.find(x=>x.path===policy.candidate)?.document;if(!current)throw new Error(a.unit+'没有有效审核候选');
  const masked=structuredClone(current),targetEvidence=[];
  for(const correction of policy.corrections){
    const actual=target(current,correction.pointer),old=target(seed,correction.pointer);
    targetEvidence.push({pointer:correction.pointer,expected:correction.after,actual:actual?.value??null});
    equal(old?.value,correction.before,a.unit+':种子已知缺陷:'+correction.pointer);
    equal(actual?.value,correction.after,a.unit+':核准目标:'+correction.pointer);
    const value=target(masked,correction.pointer);if(value)value.parent[value.key]=correction.before;
  }
  equal(masked,seed,a.unit+':全部非目标属性保持');
  const paths=seedCheck.candidates.map(x=>x.path).sort();equal(checked.candidates.map(x=>x.path).sort(),paths,a.unit+':候选集合保持');
  for(const file of paths.filter(x=>x!==policy.candidate))equal(hash(await bytes(join(rd,'agent',file))),hash(await bytes(join(scenario.seedRound,'agent',file))),a.unit+':其他候选保持:'+file);
  equal(lastCheck?.contentIdentity,checked.contentIdentity.id,a.unit+':最后工具与宿主终检内容身份');
  const template=scenario.task.startsWith('template');
  const later=compares.filter(x=>x.regionOffset>=20&&x.regionCatalog?.some(r=>r.id===policy.requiredLaterPageRegion));
  const defectPages=later.filter(x=>x.regionIssues?.includes(policy.requiredLaterPageRegion));
  if(template){
    equal(compares.at(-1)?.reportId,checked.assessment.visual.reportId,a.unit+':最后比较与终检视觉报告');
    check(defectPages.length>0,a.unit+':后续页实际取得核准缺陷');
    check(checked.assessment.visual.coverage.unknownRegions>0&&checked.assessment.visual.status==='needsReview',a.unit+':未知视觉范围保留');
  }else for(const id of policy.unknownIds)check(seedCheck.assessment.coverage.unknownItems.includes(id)&&checked.assessment.coverage.unknownItems.includes(id)&&checked.assessment.coverage.passed===false,a.unit+':未知语义保留:'+id);
  const guards=Object.fromEntries(['targetCorrection','nonTargetPreservation','unknownRetained','finalCheckMatches','pagination'].map(key=>[key,unit.checks.feedback[key]]));
  for(const [key,value]of Object.entries(guards))equal(value,true,a.unit+':固定报告守卫:'+key);
  equal(unit.status,'pass',a.unit+':固定报告状态');
  observations.push({unit:a.unit,attemptId:a.id,directory:dir,sealSha256:tracked.get(resolve(dir,'completed.seal.json')),sealedFiles:Object.keys(completion.files).length,
    source:{nativeCliVersion:[...new Set(init.map(x=>x.event.claude_code_version))],initializationModels:[...new Set(init.map(x=>x.event.model))],responseModels:[...new Set(assistants.map(x=>x.event.message?.model))],responseEvents:assistants.map(x=>({line:x.line,sha256:x.sha256,model:x.event.message?.model})),resultLine:results.at(-1)?.line,resultSha256:results.at(-1)?.sha256,apiErrors:apiErrors.map(x=>({line:x.line,sha256:x.sha256,type:x.event.type,subtype:x.event.subtype??null})),providerRevision:null},
    runtime:round.runtime,usage,nativeReportedCostUsd:result.total_cost_usd??null,nativeCostMeaning:'CLI 本地 list 估价；不是实际账单',nativeApiMs:result.duration_api_ms,nativeRuntimeMs:result.duration_ms,roundWallMs:round.run.wallMs,attemptElapsedMs:a.elapsedMs,nativeTurns:result.num_turns,
    status:unit.status,guards,targetEvidence,finalContentIdentity:checked.contentIdentity.id,lastToolCheck:{line:lastCheck.line,at:lastCheck.at,contentIdentity:lastCheck.contentIdentity},
    visual:template?{finalReportId:checked.assessment.visual.reportId,unknownRegions:checked.assessment.visual.coverage.unknownRegions,requiredLaterPageRegion:policy.requiredLaterPageRegion,defectPages:defectPages.map(x=>({line:x.line,at:x.at,reportId:x.reportId,regionOffset:x.regionOffset,regionIssues:x.regionIssues})),allCompareCalls:compares.map(x=>({line:x.line,at:x.at,reportId:x.reportId,regionOffset:x.regionOffset??null,nextRegionOffset:x.nextRegionOffset??null,regionIssues:x.regionIssues}))}:null,humanReview:null});
}
for(const [key,value]of Object.entries(totals))equal(value,report.totals[key],'原生用量总和:'+key);
equal(roundWallMs,report.totals.wallMs,'轮次墙钟求和');equal(attemptElapsedMs,report.timing.attemptsElapsedMs,'尝试耗时求和');
const segmentTiming=[];
for(const file of (await readdir(join(root,'observations/segments'))).filter(x=>x.endsWith('.completed.json'))){
  const end=await json(join(root,'observations/segments',file)),start=await json(join(root,'observations/segments',file.replace('.completed','.started')));
  if(Date.parse(end.endedAt)<=Date.parse(report.endedAt))segmentTiming.push({startedAt:start.startedAt,endedAt:end.endedAt,wallMs:Date.parse(end.endedAt)-Date.parse(start.startedAt)});
}
equal(segmentTiming.reduce((n,x)=>n+x.wallMs,0),report.timing.actualWallMs,'固定报告已完成会话墙钟');
for(const {dir,before}of snapshots){const after=await snapshot(dir);equal(after,before,dir+':审核前后完整文件/目录集合与 SHA 保持');}
for(const [file,sha]of tracked)equal(hash(await readFile(file)),sha,'读取来源事后保持:'+file);
const result={format:'renderweave-candidate6-independent-source-audit/1',createdAt:new Date().toISOString(),segment,scope:`固定分段 ${segment} 报告中的 ${report.attempts.length} 个已封存尝试；不对活动 observations 根做集合断言`,candidateId:candidate.id,bindingId,experimentId,
  report:{file:reportPath,sha256:hash(reportBytes),gate:report.gate},sourceVerified:findings.length===0,modelCallsByAudit:0,checks,findings,observations,sealedFiles,
  usage:{nativeSums:totals,reportedTotals:report.totals,nativeApiMs,nativeRuntimeMs,roundWallMs,attemptElapsedMs,timing:report.timing,wrapperWallMs:Date.parse(completed.endedAt)-Date.parse(completed.startedAt),segmentTiming},
  retainedFiles:[...tracked].map(([file,sha256])=>({file,sha256})),attemptSnapshots:snapshots.map(({dir,before})=>({directory:dir,...before})),humanReview:null,humanMinutes:null,actualMonetaryCost:null,
  limitations:['原生 CLI、模型字段与哈希证明本地来源链，不是提供方签名认证；providerRevision 未知。','四类用量直接核对原生 result；thinking 已包含于 output，CLI cost 是 list 估价。','四项成果守卫及模板分页守卫为自动证据，不代表业务人工已通过。','读取 seed 只用于核准纠偏比较，不计作真实观测；历史候选结果未修改或复用。','第二段须另获完成通知后审计；累计报告不能与前段重复计费。']};
await writeFile(out+'.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
await writeFile(out+'.md',`# 候选6票21分段${segment}独立来源审计\n\n${findings.length?'发现待处理项':'限定范围核查通过'}：${checks.length}项核查、${findings.length}项发现；${observations.length} 个实际尝试、${sealedFiles} 个封存文件。\n\n候选：${candidate.id}\n绑定：${bindingId}\n报告 SHA：${hash(reportBytes)}\n\n- 原生 CLI：${registered.executor.version}；响应模型：${binding.identity.runtime.model}。\n- 固定报告：${report.gate.completeness.pass}通过、${report.gate.completeness.fail}失败、${report.gate.completeness.invalid}无效、${report.gate.completeness.notRun}未运行。\n- 原生输入 ${totals.inputTokens}、输出 ${totals.outputTokens}、缓存读取 ${totals.cacheReadTokens}、缓存写入 ${totals.cacheCreationTokens}。\n- 实际会话墙钟 ${report.timing.actualWallMs} ms；尝试耗时和 ${attemptElapsedMs} ms；轮次墙钟和 ${roundWallMs} ms，三者口径分开。\n- 每个封存尝试均核完整文件集合及SHA；公开 readReview 仅 persistArtifacts:false，前后完整文件/目录集合不变。\n- ${observations.filter(x=>x.visual).length}个模板尝试有后续页缺陷取证，最后工具/终检身份一致；人工结论与分钟仍未知。\n\n本次仅审计已封存范围，不核第二段运行状态，不修改产品/候选/历史报告，不调用模型。完整证据：[JSON](${basename(out)}.json)。\n`,{flag:'wx'});
console.log(JSON.stringify({json:out+'.json',jsonSha256:hash(await readFile(out+'.json')),markdown:out+'.md',checks:checks.length,findings,attempts:observations.length,sealedFiles,totals,timing:report.timing},null,2));
if(findings.length)process.exitCode=1;
