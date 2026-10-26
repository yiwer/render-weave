// 候选6公开归档/恢复与只读审核取证。只向三个独占新目录写入；不调用模型或改写来源路径。
import assert from 'node:assert/strict';
import {readFile,readdir,writeFile,lstat} from 'node:fs/promises';
import {join,resolve,relative,basename} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';

const evidence=fileURLToPath(new URL('.',import.meta.url));
const feedback='F:/GenCode/render-weave/out/harness-original38-candidate-6';
const candidate='F:/GenCode/render-weave/out/harness-acceptance-20/candidate-6';
const archive='F:/GenCode/render-weave/out/harness-original38-candidate6-evidence-archive';
const restored=archive+'-restored';
const roots=[{label:'observations',path:feedback},{label:'candidate',path:candidate}];
const reviewRoot='F:/GenCode/render-weave/out/harness-original38-review';
const reviewIndex=join(reviewRoot,'zh-candidate-6-index-v2');
const reviewIndexBytes=await readFile(join(reviewIndex,'packages.json'));
const reviewPackages=JSON.parse(reviewIndexBytes);
const finalReviewBytes=await readFile('F:/GenCode/render-weave/out/harness-original38-candidate6-review-audit/final-v2.json');
const finalReview=JSON.parse(finalReviewBytes);
roots.push({label:'plan',path:'F:/GenCode/render-weave/out/harness-acceptance-20/plans/original-four'});
roots.push({label:basename(reviewIndex),path:reviewIndex});
for(const pkg of reviewPackages.packages)roots.push({label:pkg.name,path:join(reviewRoot,pkg.name)});
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const write=async(name,value)=>writeFile(join(evidence,name),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const input={format:'renderweave-context-trial-archive-inputs/1',roots};
const findings=[],checks=[],stages=[];
const check=(pass,label,detail=null)=>{checks.push({label,pass:!!pass});if(!pass)findings.push({label,detail});};
const equal=(actual,expected,label)=>check(isDeepStrictEqual(actual,expected),label,{actual,expected});
const knownKeys=[...new Set(['OPEN_CODE_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','GOOGLE_API_KEY','GEMINI_API_KEY'].map(k=>process.env[k]).filter(v=>typeof v==='string'&&v.length>=8))].map(v=>Buffer.from(v));
async function snapshot(dir,scan=false){
 const files={},directories=[];let knownKeyMatches=0;
 async function visit(current,prefix=''){
  for(const entry of(await readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
   const rel=prefix+entry.name,file=join(current,entry.name);
   assert.ok(!entry.isSymbolicLink(),`来源或恢复件含链接：${file}`);
   if(entry.isDirectory()){directories.push(rel);await visit(file,rel+'/');}
   else{const bytes=await readFile(file);files[rel]={sha256:sha(bytes),bytes:bytes.length};if(scan)for(const key of knownKeys)if(bytes.includes(key))knownKeyMatches++;}
  }
 }
 await visit(dir);return {files,directories,...(scan?{keyScan:{availableKeys:knownKeys.length,knownKeyMatches:knownKeys.length?knownKeyMatches:null,filesScanned:Object.keys(files).length}}:{})};
}
async function run(name,args){
 const env={...process.env};for(const key of Object.keys(env))if(/(?:API_KEY|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))delete env[key];
 const startedAt=new Date().toISOString(),command=[process.execPath,'node_modules/tsx/dist/cli.mjs','scripts/agent-eval/archive-context-trial.ts',...args];
 const value=await new Promise((done,reject)=>{
  const child=spawn(command[0],command.slice(1),{cwd:join(candidate,'content'),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);
  child.on('close',(exitCode,signal)=>done({command,cwd:join(candidate,'content'),startedAt,endedAt:new Date().toISOString(),exitCode,signal,stdout,stderr}));
 });
 await write(name+'.stdout.log',value.stdout);await write(name+'.stderr.log',value.stderr);stages.push(value);await write(name+'.json',value);assert.equal(value.exitCode,0,name+'失败');return value;
}
for(const dir of [archive,restored])assert.equal(await lstat(dir).then(()=>true,()=>false),false,'必须独占新输出：'+dir);

equal(sha(finalReviewBytes),'3dd2ff0f4ecfc91e8ccf8270fa982998bf6ac94147dea3d23b450e29c0691c42','最新独审final-v2 SHA');
equal(sha(reviewIndexBytes),finalReview.index.packagesSha256,'最新四包目录SHA');
equal(sha(await readFile(join(reviewIndex,'index.html'))),finalReview.index.sha256,'最新HTML索引SHA');
equal(reviewPackages.packages.length,4,'只归档四个正式新版包');
const packageChecks=[];
for(const pkg of reviewPackages.packages){
 const base=join(reviewRoot,pkg.name),manifest=await json(join(base,'manifest.json')),template=await json(join(base,'review-template.json'));
 equal(sha(await readFile(join(base,'manifest.json'))),pkg.manifestSha256,pkg.name+':清单SHA');
 equal(manifest.observationProof.attemptId,pkg.attemptId,pkg.name+':真实attempt');
 equal(manifest.observationProof.candidateId,reviewPackages.candidateId,pkg.name+':同一候选');
 equal(template.items.length,16,pkg.name+':16人工项');
 check(template.items.every(x=>x.decision===null)&&template.reviewer===null&&template.activeMinutes===null,pkg.name+':人工未填');
 equal(sha(await readFile(join(base,pkg.taskBrief.file.split('/').slice(2).join('/')))),pkg.taskBrief.sha256,pkg.name+':任务brief原件');
 for(const img of pkg.unchangedImages)equal(sha(await readFile(join(base,img.file))),img.sha256,pkg.name+':图片SHA:'+img.file);
 packageChecks.push({name:pkg.name,attemptId:pkg.attemptId,manifestSha256:pkg.manifestSha256,humanItems:16,humanReview:null,actualImage:pkg.actualImage,previewImage:pkg.previewImage});
}
if(findings.length)throw new Error('归档前新版材料校验失败：'+JSON.stringify(findings));
await write('review-packages.json',{index:reviewIndex,indexSha256:sha(reviewIndexBytes),independentReviewSha256:sha(finalReviewBytes),packages:packageChecks});
await write('inputs.json',input);
const before={};for(const root of roots){console.log('snapshot-before '+root.label);before[root.label]=await snapshot(root.path,true);}
await write('source-before.json',before);
for(const [label,state]of Object.entries(before))check(state.keyScan.knownKeyMatches===0,label+':已知凭据扫描仅计数',state.keyScan);
await run('pack',['--pack',join(evidence,'inputs.json'),'--out',archive]);
const manifestBytes=await readFile(join(archive,'manifest.json')),manifest=JSON.parse(manifestBytes);
equal((await readFile(join(archive,'manifest.sha256'),'utf8')).trim(),sha(manifestBytes),'归档清单SHA');
equal(manifest.roots.map(x=>x.label),roots.map(x=>x.label),'归档根集合');
let files=0,directories=0;
for(const root of manifest.roots){
 equal(resolve(root.originalPath),resolve(roots.find(x=>x.label===root.label).path),root.label+':原绝对路径保持');
 const recorded=Object.fromEntries(root.entries.map(x=>[x.path,{sha256:x.sha256,bytes:x.bytes}]));
 equal(recorded,before[root.label].files,root.label+':归档完整文件集合及SHA');
 equal(root.directories,before[root.label].directories,root.label+':归档完整目录集合');
 files+=root.entries.length;directories+=root.directories.length;
}
const archiveBefore=await snapshot(archive);
await write('archive-before.json',archiveBefore);
await run('restore',['--restore',archive,'--out',restored]);
const restoredBefore={};for(const root of roots){
 const state=await snapshot(join(restored,root.label),true);restoredBefore[root.label]=state;
 equal(state,before[root.label],root.label+':恢复完整文件/目录/SHA和已知凭据扫描');
}
await write('restored-before-review.json',restoredBefore);
const report=await json(join(feedback,'dispatch/segment-2/report-2026-10-25-harness-original38-candidate-6.segment-e06b63de-580d-4f84-ab30-6f4d87172788.json'));
const {readReview}=await import(pathToFileURL(join(restored,'candidate/content/dist/index.js')).href);
const views=[];
for(const attempt of report.attempts){
 assert.ok(/^run-[12]\/[a-z0-9-]+\/attempts\/[a-f0-9-]+$/.test(attempt.dir),'轮次必须来自固定10阶段');
 const dir=join(restored,'observations/evaluation',attempt.dir,'round');
 const value=await readReview(dir,{persistArtifacts:false});
 check(value.execution?.committed===true,attempt.id+':恢复公开审核已提交');
 equal(value.execution?.status,'completed',attempt.id+':恢复执行完成');
 equal(value.view?.round.verdict,'qualified',attempt.id+':恢复公开成果结论');
 views.push({unit:attempt.unit,id:attempt.id,path:dir,committed:value.execution?.committed??null,status:value.execution?.status??null,verdict:value.view?.round.verdict??null,problems:value.problems,persistArtifacts:false});
}
await write('restored-public-views.json',views);
const sourceAfter={},restoredAfter={};
for(const root of roots){
 console.log('snapshot-after '+root.label);
 sourceAfter[root.label]=await snapshot(root.path,true);restoredAfter[root.label]=await snapshot(join(restored,root.label),true);
 equal(sourceAfter[root.label],before[root.label],root.label+':原件完整集合与SHA前后不变');
 equal(restoredAfter[root.label],restoredBefore[root.label],root.label+':恢复件公开审核前后完整集合与SHA不变');
}
equal(await snapshot(archive),archiveBefore,'归档本体完整文件/目录/SHA前后不变');
equal((await readdir(restored)).sort(),roots.map(x=>x.label).sort(),'恢复顶层只有登记标签');
await write('source-after.json',sourceAfter);await write('restored-after-review.json',restoredAfter);
const proof={format:'renderweave-harness-original38-candidate6-archive-verification/1',createdAt:new Date().toISOString(),candidateId:report.candidateBinding.candidateId,bindingId:report.candidateBinding.id,archive,restored,manifestSha256:sha(manifestBytes),roots:roots.map(x=>({label:x.label,original:x.path,restored:join(restored,x.label),files:Object.keys(before[x.label].files).length,directories:before[x.label].directories.length,keyScan:before[x.label].keyScan})),files,directories,labelRootDirectories:roots.length,publicViews:views.length,checks,findings,stages,modelCalls:0,sourceModified:false,humanReview:null,limits:['通过候选6公开archive-context-trial CLI保存/恢复，公开readReview固定persistArtifacts:false。','绝对路径字节原样保留；原始source目录仍存在。本次证明同宿主只读审核可读，不声称任意搬迁接续执行。','8业务单元自动通过不等同人工业务验收；工时与人工结论未代填。','已知凭据仅按本进程可用值逐文件匹配并输出计数；未记录任何凭据值。','候选根供其他计划只读使用；审计没有生成模型请求或修改冻结包。']};
await write('verification.json',proof);
await write('README.md',`# 原四候选6归档恢复复验\n\n${findings.length?'存在待处理项':'限定范围复验通过'}：${files} 文件、${directories} 目录（另有 ${roots.length} 个恢复标签根），${views.length} 次公开只读审核。\n\n- 归档清单 SHA：${sha(manifestBytes)}。\n- 原始、恢复、归档本体均核完整路径集合及文件SHA；前后不变。\n- 两来源根的已知凭据命中：${roots.map(x=>x.label+'='+before[x.label].keyScan.knownKeyMatches).join('，')}；可用键数量 ${knownKeys.length}，不输出值。\n- 恢复时不改写绝对路径，原始来源仍存在；不承诺跨宿主任意搬迁直接执行。\n- 没有模型调用，没有代填人工结论。票据状态不变。\n\n完整证明见 [verification.json](verification.json)，公开命令及输出见 pack/restore JSON 与日志。\n`);
/* index deferred until process exit */
const evidenceFiles=[];for(const entry of(await readdir(evidence,{withFileTypes:true})).filter(x=>x.isFile()).sort((a,b)=>a.name.localeCompare(b.name))){const b=await readFile(join(evidence,entry.name));evidenceFiles.push({file:entry.name,bytes:b.length,sha256:sha(b)});}
await write('evidence-files-before-exit.json',{createdAt:new Date().toISOString(),files:evidenceFiles.filter(x=>x.file!=='run.log')});
console.log(JSON.stringify({proof:join(evidence,'verification.json'),proofSha256:sha(await readFile(join(evidence,'verification.json'))),manifestSha256:sha(manifestBytes),checks:checks.length,findings,files,directories,publicViews:views.length,keyScan:roots.map(x=>({label:x.label,...before[x.label].keyScan}))},null,2));
if(findings.length)process.exitCode=1;
