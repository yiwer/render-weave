// 本计划的原样命令与只写一次派发记录；不修改冻结代码、预算或判据。
import fs from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4';
const otherStop='F:/GenCode/render-weave/out/harness-original38-candidate-4/STOP.json';
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(join(root,'registration.candidate-4.authorized.json'));
const registration=JSON.parse(bytes),activation=JSON.parse(fs.readFileSync(join(root,'activation.json')));
assert.equal(sha(bytes),activation.registrationSha256);assert.equal(registration.status,'authorized-not-dispatched');
assert.equal(sha(fs.readFileSync(join(root,'endpoint-authorization.json'))),activation.authorizationSha256);
assert.ok(process.env.OPEN_CODE_API_KEY,'缺少已登记密钥环境变量');
const block=Number(process.argv[2]),command=registration.execution.blocks.find(x=>x.block===block);assert.ok(command);
assert.ok(!fs.existsSync(join(root,'block-'+block+'-not-dispatched.json')),'该分段已登记不派发');
const stop=join(root,'STOP.json');assert.ok(!fs.existsSync(stop)&&!fs.existsSync(otherStop),'存在共享停止记录');
if(block>1){const prior=JSON.parse(fs.readFileSync(join(root,'dispatch',`block-${block-1}.completed.json`)));assert.ok([0,1,3].includes(prior.exitCode)&&!prior.stopped);}
const dir=join(root,'dispatch'),file=suffix=>join(dir,`block-${block}.${suffix}`);
const before=new Set(fs.readdirSync(join(root,'reports')));
const stdout=fs.openSync(file('stdout.log'),'wx'),stderr=fs.openSync(file('stderr.log'),'wx');
const started={format:'renderweave-feedback-dispatch/1',block,startedAt:new Date().toISOString(),candidateId:activation.candidateId,bindingId:activation.bindingId,experimentId:activation.experimentId,registrationSha256:sha(bytes),authorizationSha256:activation.authorizationSha256,launcherSha256:sha(fs.readFileSync(fileURLToPath(import.meta.url))),cwd:registration.execution.cwd,command,keyEnvironmentName:'OPEN_CODE_API_KEY',wrapperPid:process.pid};
fs.writeFileSync(file('started.json'),JSON.stringify(started,null,2)+'\n',{flag:'wx'});
const child=spawn(command.command,command.args,{cwd:registration.execution.cwd,env:process.env,stdio:['ignore',stdout,stderr],windowsHide:true});
fs.writeFileSync(file('pid.json'),JSON.stringify({wrapperPid:process.pid,childPid:child.pid,startedAt:started.startedAt},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({started:true,block,pid:child.pid,cwd:registration.execution.cwd}));
let stopped=false;
const timer=setInterval(()=>{
  const errors=fs.readFileSync(file('stderr.log'),'utf8');
  const quota=/硬额度|额度.{0,12}(?:用尽|耗尽)|hard.?quota|insufficient.{0,12}quota|(?:重试|HTTP|status|error|错误).{0,100}\b429\b/i.test(errors);
  if(stopped||!quota&&!fs.existsSync(stop)&&!fs.existsSync(otherStop))return;
  stopped=true;
  if(!fs.existsSync(stop))fs.writeFileSync(stop,JSON.stringify({at:new Date().toISOString(),reason:quota?'quota-or-429':'shared-stop',block,childPid:child.pid,stderrSha256:sha(errors)},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({stopped:true,block,reason:quota?'quota-or-429':'shared-stop'}));
  if(child.pid)spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});
},1000);
child.once('error',error=>{fs.writeFileSync(file('spawn-error.json'),JSON.stringify({name:error.name,message:error.message},null,2)+'\n',{flag:'wx'});});
child.once('close',(exitCode,signal)=>{
  clearInterval(timer);fs.closeSync(stdout);fs.closeSync(stderr);
  const reports=[];
  for(const name of fs.readdirSync(join(root,'reports')).filter(x=>!before.has(x))){
    const data=fs.readFileSync(join(root,'reports',name));const target=file('report-'+name);fs.writeFileSync(target,data,{flag:'wx'});reports.push({file:name,snapshot:target,sha256:sha(data)});
  }
  const complete={...started,endedAt:new Date().toISOString(),exitCode,signal,stopped,reports,stdoutSha256:sha(fs.readFileSync(file('stdout.log'))),stderrSha256:sha(fs.readFileSync(file('stderr.log')))};
  fs.writeFileSync(file('completed.json'),JSON.stringify(complete,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({completed:true,block,exitCode,stopped,reports}));process.exitCode=exitCode??2;
});
