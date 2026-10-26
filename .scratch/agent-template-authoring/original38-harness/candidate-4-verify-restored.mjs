import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,stat,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const base='F:/GenCode/render-weave/out',archive=join(base,'harness-original38-candidate-4-evidence-archive');
const restored=join(base,'harness-original38-candidate-4-evidence-restored'),root=join(restored,'original38');
// 显式验证固定候选4 reader；只读恢复必须保持全部路径与字节。
const readerCandidate=process.argv[2];assert.ok(readerCandidate,'必须显式指定经独立审查、包含persistArtifacts:false的冻结reader候选');
const readerManifestBytes=await readFile(join(readerCandidate,'candidate.json')),readerManifest=JSON.parse(readerManifestBytes);
const validation=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/agent-eval/freeze.ts','--verify',readerCandidate,'--current'],{cwd:join(readerCandidate,'content'),encoding:'utf8',windowsHide:true});
assert.equal(validation.status,0,validation.stderr+validation.stdout);
assert.equal(readerManifest.id,'sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804');
const readerFile=join(readerCandidate,'content/dist/index.js');
const {readReview}=await import(pathToFileURL(readerFile));
const sha=b=>createHash('sha256').update(b).digest('hex');
const bytes=await readFile(join(archive,'manifest.json')),manifestSha256=sha(bytes);assert.equal((await readFile(join(archive,'manifest.sha256'),'utf8')).trim(),manifestSha256);
const manifest=JSON.parse(bytes);
async function completeTree(dir,prefix=''){
 assert.equal((await lstat(dir)).isSymbolicLink(),false,'根不得为链接:'+dir);
 const files=[],directories=[];
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const path=prefix+entry.name;assert.ok(!entry.isSymbolicLink(),'不得含链接:'+path);
  if(entry.isDirectory()){directories.push(path);const nested=await completeTree(join(dir,entry.name),path+'/');files.push(...nested.files);directories.push(...nested.directories);}
  else {assert.ok(entry.isFile(),path);files.push(path);}
 }
 return {files:files.sort(),directories:directories.sort()};
}
async function verifyWhole(root,dir){
 const actual=await completeTree(dir);
 assert.deepEqual(actual.files,root.entries.map(e=>e.path).sort(),'完整文件集合:'+dir);
 assert.deepEqual(actual.directories,[...(root.directories??[])].sort(),'完整目录集合:'+dir);
 for(const entry of root.entries){const data=await readFile(join(dir,entry.path));assert.equal(data.length,entry.bytes);assert.equal(sha(data),entry.sha256,join(dir,entry.path));}
}
async function verifyTop(){
 assert.equal((await lstat(restored)).isSymbolicLink(),false);
 const entries=await readdir(restored,{withFileTypes:true});
 assert.deepEqual(entries.map(e=>e.name).sort(),manifest.roots.map(r=>r.label).sort(),'恢复顶层标签完整集合');
 for(const entry of entries)assert.ok(entry.isDirectory()&&!entry.isSymbolicLink(),'顶层必须是普通目录:'+entry.name);
}
await verifyTop();
for(const entry of manifest.roots)await verifyWhole(entry,join(restored,entry.label));
const source=JSON.parse(await readFile(join(restored,'metadata/source-usage-audit.final.json'))).plans.find(p=>p.name==='original38');
assert.equal(source.attempts.length,7);assert.equal(source.attempts.filter(x=>x.status==='sealed').length,6);const views=[];
for(const record of source.attempts.filter(x=>x.status==='sealed')){
 assert.equal(record.status,'sealed');
 const path=join(root,'evaluation',record.unit,'attempts',record.attemptId,'round');
 const review=await readReview(path,{persistArtifacts:false});assert.ok(review.view,record.unit);assert.equal(review.problems.length,0,JSON.stringify(review.problems));assert.equal(review.execution?.committed,true);
 views.push({unit:record.unit,stage:record.stage,attemptId:record.attemptId,path,viewPresent:true,problems:review.problems.length,committed:review.execution.committed,status:review.execution.status,verdict:review.view.round.verdict});
}
let filesVerifiedAfterReview=0,logicalBytes=0,directoriesVerified=0;
for(const source of manifest.roots){
 await verifyWhole(source,join(restored,source.label));await verifyWhole(source,source.originalPath);
 for(const directory of source.directories??[]){assert.equal((await stat(join(restored,source.label,directory))).isDirectory(),true);directoriesVerified++;}
 for(const entry of source.entries){
  const bytes=await readFile(join(restored,source.label,entry.path));assert.equal(bytes.length,entry.bytes);assert.equal(sha(bytes),entry.sha256,entry.path);
  const original=await readFile(join(source.originalPath,entry.path));assert.equal(original.length,entry.bytes);assert.equal(sha(original),entry.sha256,'原件:'+entry.path);
  filesVerifiedAfterReview++;logicalBytes+=entry.bytes;
 }
}
await verifyTop();
const validationAfter=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/agent-eval/freeze.ts','--verify',readerCandidate,'--current'],{cwd:join(readerCandidate,'content'),encoding:'utf8',windowsHide:true});
assert.equal(validationAfter.status,0,validationAfter.stderr+validationAfter.stdout);
const result={format:'renderweave-original38-restore-verification/1',verifiedAt:new Date().toISOString(),archive,restored,manifestSha256,filesVerifiedAfterReview,directoriesVerified,logicalBytes,sourceFilesVerified:filesVerifiedAfterReview,views,
reader:{candidate:readerCandidate,candidateId:readerManifest.id,manifestSha256:sha(readerManifestBytes),module:readerFile,moduleSha256:sha(await readFile(readerFile)),options:{persistArtifacts:false},publicCandidateVerificationExit:validation.status,publicCandidateVerificationAfterExit:validationAfter.status},
completePathSetsVerifiedBeforeAndAfter:true,interruptedUnsealedAttempt:{id:'32362262-a3e4-475a-b470-cd46e2865710',bytesPreserved:true,publicReviewInvoked:false,completionManufactured:false},
limitations:['5个有效业务观测的6个封存阶段可读；另1个中断未封存尝试只核归档字节，未补封存、未接续、不改业务或人审结论。','以同一冻结候选4的公开入口只读读取其实际轮次，不把恢复读取记作新模型观测或接续成功。','恢复后公开readReview(persistArtifacts:false)读取，再核恢复文件和目录完整集合及全部字节；原始根同样完整核对，不仅遍历清单内文件。','原始绝对路径不改写，不证明任意迁移后可以直接接续运行；不批准、不应用、不调用模型。']};
await writeFile(join(base,'harness-original38-candidate4-stopped-archive-verification.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({filesVerifiedAfterReview,directoriesVerified,logicalBytes,sourceFilesVerified:filesVerifiedAfterReview,publicReviewViews:views.length,manifestSha256}));
