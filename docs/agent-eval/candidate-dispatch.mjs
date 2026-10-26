// 固定候选的外部串行监督；只调用登记的公开评估命令，不修改候选或补造封存。
import fs from 'node:fs';
import {join,dirname,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const write=(p,j)=>fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n',{flag:'wx'});
const hash=p=>sha(fs.readFileSync(p));
const cleanHash=s=>s.replace(/^sha256:/,'');
const {values}=parseArgs({options:{registration:{type:'string'},segment:{type:'string'},activation:{type:'string'},preflight:{type:'boolean'},'self-test':{type:'string'},'self-test-case':{type:'string'}},strict:true});
const isQuota=e=>Boolean(e&&(
 (e.type==='error'&&['GoUsageLimitError','insufficient_quota','credit_balance_too_low'].includes(e.error?.type??e.error?.code??e.code))||
 (e.type==='result'&&e.is_error===true&&(e.api_error_status===429||/Go usage limit exceeded|insufficient_quota|credit_balance_too_low|GoUsageLimitError/.test(e.result??'')))||
 (e.type==='assistant'&&e.is_api_error_message===true&&e.error==='rate_limit'&&e.message?.model==='<synthetic>'&&e.message.content?.some(x=>x.type==='text'&&/Go usage limit exceeded|Request rejected \(429\)/.test(x.text)))||
 (e.type==='system'&&e.subtype==='api_retry'&&(e.error_status===429||e.api_error_status===429||e.error?.status===429||/GoUsageLimitError|insufficient_quota|credit_balance_too_low/.test(JSON.stringify(e.error))))));
function units(root){
 const dirs=dir=>{if(!fs.existsSync(dir))return [];return fs.readdirSync(dir,{withFileTypes:true}).filter(e=>{assert(!e.isSymbolicLink(),'执行目录不可含链接');return e.isDirectory();}).map(e=>join(dir,e.name));};
 // 只读真实attempt的原生流；不遍历短命租约、兼容视图或模型可写工作目录。
 const result=[];for(const run of dirs(root).filter(p=>/run-\d+$/.test(p)))for(const scenario of dirs(run))result.push({directory:scenario,rounds:dirs(join(scenario,'attempts')).map(attempt=>join(attempt,'round'))});
 return result;
}
function quotaIn(root,final=false){
 for(const unit of units(root)){
  for(const round of unit.rounds){
   const file=join(round,'logs','stream.jsonl');if(!fs.existsSync(file))continue;
   const lines=fs.readFileSync(file,'utf8').split('\n');for(let i=0;i<lines.length;i++){let event;try{event=JSON.parse(lines[i]);}catch{continue;}if(isQuota(event))return {file,line:i+1,pointer:null,event,raw:lines[i],sha256:sha(lines[i])};}
  }
  // 产品已停止/退出时原生流可能没有对应事件。只认宿主公开回执，不以 exit 3 推断额度或正常完成。
  const receipts=[{file:join(unit.directory,'upstream-errors.json'),find:v=>v?.invalid?.kind==='quota'?'/invalid/kind':null}];
  for(const round of unit.rounds)receipts.push(
   {file:join(round,'round.json'),find:v=>v?.run?.stopped?.reason==='hardQuota'?'/run/stopped/reason':null},
   {file:join(round,'cleanup.json'),find:v=>{const i=Array.isArray(v?.events)?v.events.findIndex(e=>e.after==='stop'&&e.stop?.reason==='hardQuota'):-1;return i<0?null:`/events/${i}/stop/reason`;}});
  for(const {file,find} of receipts){
   let raw;try{raw=fs.readFileSync(file,'utf8');}catch(error){if(error.code==='ENOENT')continue;throw error;}
   let event;try{event=JSON.parse(raw);}catch(error){if(!final&&error instanceof SyntaxError)continue;throw error;}
   const pointer=find(event);if(pointer)return {file,line:null,pointer,event,raw,sha256:sha(raw)};
  }
 }
 return null;
}
function withoutKeys(){const env={...process.env};for(const key of ['OPEN_CODE_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])delete env[key];return env;}
async function supervise({command,args,cwd,env,out,observations,stop,started}){
 const file=name=>join(out,name),stdout=fs.openSync(file('stdout.log'),'wx'),stderr=fs.openSync(file('stderr.log'),'wx');
 let live=false,closed=false,stopping=false,reason=null,event=null,recordError=null,killResult=null,monitorError=null,childError=null;
 const child=spawn(command,args,{cwd,env,stdio:['ignore',stdout,stderr],windowsHide:true});
 const childStartedAt=new Date().toISOString();
 live=Number.isInteger(child.pid);
 child.once('spawn',()=>{try{write(file('pid.json'),{wrapperPid:process.pid,childPid:child.pid,childStartedAt,command,args});}catch(error){recordError=String(error);stopNow('pid-record-error');}});
 child.once('error',error=>{childError=String(error);});
 child.once('exit',()=>{live=false;});
 const finish=new Promise(resolveClose=>child.once('close',(exitCode,signal)=>{closed=true;resolveClose({exitCode,signal});}));
 function stopNow(why,found=null){
  if(stopping)return;stopping=true;reason=why;event=found;
  try{
   if(found)fs.writeFileSync(file('quota-event.jsonl'),found.raw+'\n',{flag:'wx'});
   const notice={at:new Date().toISOString(),reason:why,wrapperPid:process.pid,childPid:child.pid,childStartedAt,source:found?{file:found.file,line:found.line,pointer:found.pointer,sha256:found.sha256}:null,action:'taskkill-own-live-evaluation-tree',noRetry:true};
   write(file('stop-observed.json'),notice);if(!fs.existsSync(stop))write(stop,notice);
  }catch(error){recordError=String(error);}
  finally{
   // 只使用本次 spawn 持有且尚未收到 exit 的子进程；不枚举/按名终止其他进程。
   if(live&&!closed&&child.exitCode===null&&child.signalCode===null&&Number.isInteger(child.pid)){
    const killed=spawnSync('C:/Windows/System32/taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,encoding:'utf8',timeout:15000});
    killResult={at:new Date().toISOString(),ownedRootPid:child.pid,childStartedAt,exitCode:killed.status,signal:killed.signal,error:killed.error?String(killed.error):null,stdout:killed.stdout,stderr:killed.stderr};
   }else killResult={at:new Date().toISOString(),skipped:'owned-root-already-exited; descendant status unknown'};
   try{write(file('termination.json'),killResult);}catch(error){recordError=(recordError??'')+'; termination record: '+String(error);}
  }
 }
 function scan(){if(stopping)return;try{if(fs.existsSync(stop)){read(stop);stopNow('shared-stop');return;}const found=quotaIn(observations,closed);if(found)stopNow(found.pointer?'public-quota-receipt':'explicit-runtime-quota',found);}catch(error){monitorError=String(error);stopNow('monitor-error');}}
 const timer=setInterval(scan,250),onSignal=()=>stopNow('operator-signal');process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);
 const closedResult=await finish;scan();clearInterval(timer);process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);fs.closeSync(stdout);fs.closeSync(stderr);
 const result={...started,endedAt:new Date().toISOString(),...closedResult,stopped:stopping,stopReason:reason,monitorError,recordError,killResult,childError,stdoutSha256:hash(file('stdout.log')),stderrSha256:hash(file('stderr.log')),eventSource:event?{file:event.file,line:event.line,pointer:event.pointer,sha256:event.sha256}:null,interruptedSealNotFabricated:true};
 write(file('completed.json'),result);return result;
}
if(values['self-test']){
 assert(!values.registration&&!values.activation&&!values.segment&&!values.preflight,'自测不接受真实计划');assert.equal(process.platform,'win32','该定向树停止演练用于Windows');
 const root=resolve(values['self-test']);fs.mkdirSync(root);const results=[];
 const cases=['quoted-text','quota','shared-stop','stop-write-error','structured-quota','quota-receipt-after-exit','round-quota-after-exit','upstream-quota-after-exit','host-continues','committed-warning'];
 assert(!values['self-test-case']||cases.includes(values['self-test-case']),'未知本地演练');
 for(const kind of values['self-test-case']?[values['self-test-case']]:cases){
  const dir=join(root,kind);fs.mkdirSync(dir);const observed=join(dir,'observations'),logs=join(observed,'run-1','controlled','attempts','local-only','round','logs');fs.mkdirSync(logs,{recursive:true});
  const stop=kind==='stop-write-error'?join(dir,'not-directory','STOP.json'):join(dir,'STOP.json');if(kind==='stop-write-error')fs.writeFileSync(join(dir,'not-directory'),'guard');
  const childFile=join(dir,'owned-child.mjs'),grandchildFile=join(dir,'owned-grandchild.mjs');
  fs.writeFileSync(grandchildFile,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(dir,'grandchild.json'))},JSON.stringify({pid:process.pid}));setInterval(()=>fs.writeFileSync(${JSON.stringify(join(dir,'heartbeat'))},String(Date.now())),50);setTimeout(()=>process.exit(0),4000);`);
  const code=`import fs from 'node:fs';import {spawn} from 'node:child_process';const stream=${JSON.stringify(join(logs,'stream.jsonl'))};fs.writeFileSync(stream,JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Go usage limit exceeded Request rejected (429)'}]}})+'\\n'+JSON.stringify({type:'result',is_error:false,result:'insufficient_quota'})+'\\n');${kind==='quoted-text'?'setTimeout(()=>process.exit(0),700);':`spawn(process.execPath,[${JSON.stringify(grandchildFile)}],{windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000);setTimeout(()=>{${kind==='shared-stop'?`fs.writeFileSync(${JSON.stringify(stop)},JSON.stringify({reason:'controlled-stop'}));`:`fs.appendFileSync(stream,JSON.stringify({type:'system',subtype:'api_retry',error_status:429,error:'controlled runtime event'})+'\\n');`}},700);`}`;
  const fixture=kind==='structured-quota'?`import fs from 'node:fs';import {spawn} from 'node:child_process';spawn(process.execPath,[${JSON.stringify(grandchildFile)}],{windowsHide:true,stdio:'ignore'});setTimeout(()=>fs.writeFileSync(${JSON.stringify(join(logs,'stream.jsonl'))},JSON.stringify({type:'error',error:{type:'GoUsageLimitError'},metadata:{limitName:'five_hour'}})+'\\n'),700);setTimeout(()=>process.exit(0),2500);`:kind==='quota-receipt-after-exit'?`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(dirname(logs),'cleanup.json'))},JSON.stringify({events:[{after:'stop',stop:{reason:'hardQuota',type:'GoUsageLimitError',limit:'five_hour'},detail:'controlled unconfirmed cleanup'}]}));process.exit(3);`:code;
  const receipt=kind==='round-quota-after-exit'?{file:join(dirname(logs),'round.json'),value:{run:{stopped:{reason:'hardQuota'}}}}:kind==='upstream-quota-after-exit'?{file:join(observed,'run-1','controlled','upstream-errors.json'),value:{retries:[],invalid:{kind:'quota',task:'template-design',error:'controlled quota'}}}:null;
  const continueCase=['host-continues','committed-warning'].includes(kind);
  const continuing=`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(join(dirname(logs),'cleanup.json'))},JSON.stringify({events:[{after:${JSON.stringify(kind==='host-continues'?'stop':'result')},stop:{reason:'timeout'},detail:'controlled cleanup unconfirmed'}]}));${kind==='host-continues'?`fs.writeFileSync(${JSON.stringify(join(observed,'run-1','controlled','upstream-errors.json'))},JSON.stringify({retries:[],invalid:{kind:'host',task:'template-design',error:'controlled host'}}));`:`fs.writeFileSync(${JSON.stringify(join(dirname(logs),'round.json'))},JSON.stringify({verdict:'qualified',run:{}}));`}setTimeout(()=>{fs.writeFileSync(${JSON.stringify(join(dir,'next-unit-started.json'))},JSON.stringify({controlled:true}));process.exit(${kind==='host-continues'?3:0});},700);`;
  fs.writeFileSync(childFile,receipt?`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(receipt.file)},JSON.stringify(${JSON.stringify(receipt.value)}));process.exit(3);`:continueCase?continuing:fixture);const result=await supervise({command:process.execPath,args:[childFile],cwd:dir,env:withoutKeys(),out:dir,observations:observed,stop,started:{mode:'controlled-local-processes-only',kind,startedAt:new Date().toISOString(),modelCalls:0}});
  const normal=kind==='quoted-text'||continueCase;
  assert.equal(result.stopped,!normal);if(normal){assert.equal(result.exitCode,kind==='host-continues'?3:0);assert(!fs.existsSync(stop));if(continueCase)assert(fs.existsSync(join(dir,'next-unit-started.json')));}else if(kind.endsWith('-after-exit')){assert.equal(result.exitCode,3);assert.equal(result.killResult.exitCode,undefined);assert.match(result.killResult.skipped,/descendant status unknown/);assert(fs.existsSync(stop));}else {assert.equal(result.killResult.exitCode,0,JSON.stringify(result));const pids=[read(join(dir,'pid.json')).childPid,read(join(dir,'grandchild.json')).pid];for(const pid of pids)assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});if(kind==='stop-write-error')assert(result.recordError);}
  results.push(result);
 }
 write(join(root,'verification.json'),{checkedAt:new Date().toISOString(),launcherSha256:hash(fileURLToPath(import.meta.url)),results,modelCalls:0,networkCalls:0,thirdPartyProcessesTerminated:0});console.log(JSON.stringify({passed:results.length,out:root,modelCalls:0}));
}else{
 assert(values.registration&&values.segment,'需要 --registration 和 --segment');assert.equal(process.platform,'win32','当前监督已核验Windows进程树');
 const registrationFile=resolve(values.registration),registrationBytes=fs.readFileSync(registrationFile),reg=JSON.parse(registrationBytes),segment=Number(values.segment);
 assert(['renderweave-trusted-feedback-registration/3','original38-real-model-registration/3'].includes(reg.format));
 const command=reg.commands.find(item=>item.segment===segment);assert(command&&[1,2].includes(segment),'非法分段');
 const arg=name=>command.args[command.args.indexOf(name)+1];
 assert.equal(resolve(command.cwd),resolve(reg.candidate.directory,'content'));assert.equal(resolve(command.command),resolve(reg.executor.node));assert.equal(hash(process.execPath),reg.executor.nodeSha256);assert.equal(hash(reg.executor.file),reg.executor.sha256);
 const candidate=read(join(reg.candidate.directory,'candidate.json')),bindingBytes=fs.readFileSync(join(reg.binding.directory,'binding.json')),binding=JSON.parse(bindingBytes),{id,...body}=binding;
 assert.equal(candidate.id,reg.candidate.id);assert.equal(hash(join(reg.candidate.directory,'candidate.json')),reg.candidate.manifestSha256);assert.equal(sha(bindingBytes),reg.binding.sha256);assert.equal(id,reg.binding.id);assert.equal(id,'sha256:'+sha(JSON.stringify(body)));assert.equal(binding.candidate.id,candidate.id);assert.equal(sha(JSON.stringify(binding.identity)),cleanHash(reg.experimentId));
 assert.equal(resolve(arg('--candidate-binding')),resolve(reg.binding.directory));assert.equal(sha(fs.readFileSync(arg('--config'))),cleanHash(binding.identity.config));assert.equal(arg('--jobs'),'1');assert.equal(arg('--repeat'),'2');assert.equal(arg('--repetitions'),`${segment}-${segment}`);
 assert.equal(arg('--model'),binding.identity.runtime.model);assert.equal(arg('--small-model'),binding.identity.runtime.smallModel);assert.equal(arg('--context-policy'),'full');assert.equal(arg('--timeout-ms'),String(binding.identity.budgets.roundTimeoutMs));assert.equal(arg('--stagnation-threshold'),String(binding.identity.budgets.stagnation));assert.equal(resolve(arg('--claude')),resolve(reg.executor.file));
 assert(!command.args.includes('--max-turns')&&!command.args.includes('--effort')&&!command.args.includes('--claude-args'),'不覆盖既定预算或执行器');assert.equal(arg('--key-env'),'OPEN_CODE_API_KEY');
 assert.equal(hash(reg.endpointAuthorization.file),reg.endpointAuthorization.sha256);
 if(reg.sourcePreparation){
  assert.equal(hash(reg.sourcePreparation.file),reg.sourcePreparation.sha256);const preparation=read(reg.sourcePreparation.file);
  for(const [path,digest] of Object.entries(preparation.files))assert.equal(hash(join(dirname(reg.sourcePreparation.file),path)),cleanHash(digest),'固定输入 '+path);
  for(const item of Object.values(preparation.sourceFiles??{}))assert.equal(hash(item.source),cleanHash(item.sha256),'原始来源 '+item.source);
 }
 if(reg.inputPreservation){assert.equal(hash(reg.inputPreservation.file),reg.inputPreservation.sha256);for(const item of read(reg.inputPreservation.file).files)assert.equal(hash(item.path),cleanHash(item.sha256),'输入保全 '+item.path);}
 const stop=resolve(reg.sharedStop),globalRoot=dirname(stop),output=resolve(reg.output),observations=resolve(arg('--out')),reports=resolve(arg('--reports'));
 assert(reg.coordinator,'登记必须绑定候选专属共享执行根');
 assert.equal(resolve(reg.coordinator.directory),globalRoot);assert.equal(reg.coordinator.candidateId,candidate.id);assert.equal(reg.coordinator.manifestSha256,reg.candidate.manifestSha256);assert.equal(stop,join(globalRoot,'STOP.json'));
 const nested=(parent,child)=>{const rel=relative(resolve(parent),resolve(child));return !rel||!rel.startsWith('..')&&!isAbsolute(rel);};
 for(const protectedRoot of [reg.candidate.directory,reg.binding.directory,output])assert(!nested(protectedRoot,globalRoot)&&!nested(globalRoot,protectedRoot),'共享执行根必须与候选、绑定及本计划目录分开');
 assert(!fs.existsSync(stop),'已有共享STOP，禁止派发或预检通过');assert(!fs.existsSync(join(globalRoot,'ACTIVE.lock')),'共享执行根已有活动或待核查锁');
 assert(!quotaIn(observations,true),'本计划已有公开额度停止证据，禁止后续分段');
 for(const p of [observations,reports]){const rel=relative(output,p);assert(rel&&!rel.startsWith('..')&&!isAbsolute(rel),'输出须在本计划根内');}
 const verification=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/agent-eval/freeze.ts','--verify',reg.candidate.directory,'--current'],{cwd:command.cwd,env:withoutKeys(),windowsHide:true,encoding:'utf8'});assert.equal(verification.status,0,verification.stderr);
 if(values.preflight){assert(!values.activation,'预检不接收真实派发授权');console.log(JSON.stringify({verified:true,segment,candidateId:candidate.id,bindingId:id,registrationSha256:sha(registrationBytes),publicCandidateVerification:verification.stdout,observationsCreated:false,modelCalls:0}));}
 else{
  assert(values.activation,'缺少独立复核后的明确派发激活');const activationBytes=fs.readFileSync(resolve(values.activation)),activation=JSON.parse(activationBytes);
  assert.equal(activation.dispatchAuthorized,true);assert(activation.segments.includes(segment));assert.equal(activation.registrationSha256,sha(registrationBytes));assert.equal(activation.launcherSha256,hash(fileURLToPath(import.meta.url)));assert.equal(activation.candidateId,candidate.id);assert.equal(activation.bindingId,id);assert.equal(hash(activation.independentReview.file),activation.independentReview.sha256);
  for(const prerequisite of activation.prerequisites??[]){assert.equal(hash(prerequisite.file),prerequisite.sha256);if(prerequisite.requireCompleted){const prior=read(prerequisite.file);assert.equal(prior.candidateId,candidate.id,'前置计划必须使用相同候选');assert([0,1,3].includes(prior.exitCode)&&!prior.stopped&&!prior.childError,'前置计划未正常结束');}}
  assert(process.env.OPEN_CODE_API_KEY,'缺少凭据，未派发');assert(!fs.existsSync(stop),'已有共享STOP，禁止派发');
  const dispatch=join(output,'dispatch'),dir=join(dispatch,`segment-${segment}`);fs.mkdirSync(dispatch,{recursive:true});assert(!fs.existsSync(dir),'已消费的分段不得重跑');
  if(segment===1)assert(!fs.existsSync(observations),'首段观测目录必须不存在');else {const prior=read(join(dispatch,'segment-1','completed.json'));assert.equal(prior.candidateId,candidate.id,'首段必须使用相同候选');assert([0,1,3].includes(prior.exitCode)&&!prior.stopped&&!prior.childError,'首段没有正常完成或已停止');}
  fs.mkdirSync(globalRoot,{recursive:true});const lock=join(globalRoot,'ACTIVE.lock');fs.mkdirSync(lock);const owner={pid:process.pid,registration:registrationFile,segment,at:new Date().toISOString()};write(join(lock,'owner.json'),owner);
  let complete=false;
  try{
   assert(!fs.existsSync(stop),'锁定后发现共享STOP');fs.mkdirSync(dir);const started={format:'renderweave-supervised-dispatch/1',startedAt:new Date().toISOString(),wrapperPid:process.pid,registrationSha256:sha(registrationBytes),activationSha256:sha(activationBytes),launcherSha256:hash(fileURLToPath(import.meta.url)),candidateId:candidate.id,bindingId:id,segment,command};write(join(dir,'started.json'),started);
   assert(!fs.existsSync(stop),'spawn前发现共享STOP');assert.deepEqual(read(join(lock,'owner.json')),owner,'spawn前仍持有自身独占锁');
   const result=await supervise({...command,env:process.env,out:dir,observations,stop,started});
   const snapshots=[];if(fs.existsSync(reports))for(const name of fs.readdirSync(reports)){const p=join(reports,name);if(fs.statSync(p).isFile()){const b=fs.readFileSync(p);fs.writeFileSync(join(dir,'report-'+name),b,{flag:'wx'});snapshots.push({file:p,sha256:sha(b)});}}write(join(dir,'reports.json'),snapshots);
   complete=!result.stopped||(result.killResult?.exitCode===0&&!result.recordError&&fs.existsSync(stop));process.exitCode=result.stopped?3:(result.exitCode??2);console.log(JSON.stringify({segment,exitCode:result.exitCode,stopped:result.stopped,stopReason:result.stopReason,dir}));
  }finally{
   // 正常结束或已证实定向清树才释放本进程自己的锁；未知清理状态保留锁供维护者核查。
   if(complete){assert.deepEqual(read(join(lock,'owner.json')),owner);fs.unlinkSync(join(lock,'owner.json'));fs.rmdirSync(lock);}
  }
 }
}
