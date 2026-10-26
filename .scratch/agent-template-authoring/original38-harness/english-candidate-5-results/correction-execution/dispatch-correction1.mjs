import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const repo='F:/GenCode/render-weave';
const execution=repo+'/out/harness-original38-english-tfl161-correction-candidate-5/execution';
const prepared=repo+'/out/harness-original38-english-tfl161-correction-candidate-5';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const reg=read(prepared+'/registration.json');
const activation=read(execution+'/resume-authorization.json');
assert.equal(activation.bindingId,reg.binding.id);assert.equal(activation.dispatchAuthorized,true);
assert.equal(sha(fs.readFileSync(prepared+'/registration.json')),activation.registrationSha256);
assert.equal(sha(fs.readFileSync(activation.independentReview.file)),activation.independentReview.sha256);
assert.equal(sha(fs.readFileSync(reg.executor.file)),reg.executor.sha256);
assert.equal(sha(fs.readFileSync(process.execPath)),reg.executor.nodeSha256);
const sourceRoot=reg.materials.directory;
for(const f of read(prepared+'/material-preservation.json').files)assert.equal(sha(fs.readFileSync(sourceRoot+'/'+f.path)),f.sha256);
const {verifyStage,dispatchStage}=await import(pathToFileURL(reg.candidate.directory+'/content/scripts/agent-eval/candidate-stage.ts').href);
await verifyStage(reg.binding.directory);
assert.equal(fs.existsSync(reg.binding.directory+'/dispatch-start.json'),false);
assert.equal(fs.existsSync(reg.design.out),false);
const isQuota=e=>Boolean(e&&((e.type==='result'&&e.is_error===true&&(e.api_error_status===429||/Go usage limit exceeded|insufficient_quota|credit_balance_too_low|GoUsageLimitError/i.test(e.result??'')))||(e.type==='assistant'&&e.is_api_error_message===true&&e.error==='rate_limit'&&e.message?.model==='<synthetic>'&&e.message.content?.some(x=>x.type==='text'&&/Go usage limit exceeded|Request rejected \(429\)/i.test(x.text)))||(e.type==='system'&&e.subtype==='api_retry'&&/GoUsageLimitError|insufficient_quota|credit_balance_too_low/.test(JSON.stringify(e.error)))));
assert.equal(isQuota({type:'assistant',message:{content:[{type:'text',text:'Go usage limit exceeded'}]}}),false);
assert.equal(isQuota({type:'result',is_error:true,api_error_status:429}),true);
assert.equal(isQuota({type:'result',is_error:false,result:'Go usage limit exceeded'}),false);
if(process.argv.includes('--preflight')){console.log(JSON.stringify({verified:true,quotaPredicateChecks:3,modelCalls:0}));process.exit(0);}
assert.ok(process.env.OPEN_CODE_API_KEY,'缺少凭据；未派发');
fs.writeFileSync(execution+'/started.json',JSON.stringify({at:new Date().toISOString(),pid:process.pid,candidate:reg.candidate.id,binding:reg.binding.id},null,2)+'\n',{flag:'wx'});
let stopped=false,monitorError=null,cancelDelivered=null;
const cancelOnce=()=>{if(cancelDelivered===null)cancelDelivered=process.emit('SIGINT');};
const scan=()=>{
 try{
  const stream=reg.design.out+'/logs/stream.jsonl';
  if(!fs.existsSync(stream)||stopped)return;
  const lines=fs.readFileSync(stream,'utf8').split('\n');
  for(let i=0;i<lines.length;i++){let event;try{event=JSON.parse(lines[i]);}catch{continue;}if(!isQuota(event))continue;
   stopped=true;try{fs.writeFileSync(execution+'/quota-event.jsonl',lines[i]+'\n',{flag:'wx'});fs.writeFileSync(execution+'/STOP.json',JSON.stringify({at:new Date().toISOString(),reason:'explicit-runtime-quota',source:stream,line:i+1,eventSha256:sha(Buffer.from(lines[i])),action:'emit-SIGINT-to-own-public-stage-handler',cancellationListenerRegistered:process.listenerCount('SIGINT')>0,noRetry:true},null,2)+'\n',{flag:'wx'});
   }finally{cancelOnce();}break;
  }
 }catch(error){monitorError=String(error);if(!stopped){stopped=true;try{fs.writeFileSync(execution+'/monitor-error.json',JSON.stringify({at:new Date().toISOString(),error:monitorError,action:'cancel-own-stage'},null,2)+'\n',{flag:'wx'});}catch(recordError){monitorError+='; record: '+String(recordError);}finally{cancelOnce();}}}
};
const timer=setInterval(scan,250);
let code;
try{code=await dispatchStage(reg.binding.directory,'OPEN_CODE_API_KEY');}
catch(error){fs.writeFileSync(execution+'/dispatch-error.txt',String(error)+'\n',{flag:'wx'});code=2;}
finally{scan();clearInterval(timer);}
fs.writeFileSync(execution+'/completed.json',JSON.stringify({at:new Date().toISOString(),exitCode:code,quotaStopped:stopped&&!monitorError,monitorError,cancelDelivered,candidate:reg.candidate.id,binding:reg.binding.id},null,2)+'\n',{flag:'wx'});
process.exitCode=code;
