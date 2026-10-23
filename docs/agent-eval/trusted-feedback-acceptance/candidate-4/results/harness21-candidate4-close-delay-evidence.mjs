import assert from 'node:assert/strict';
import {readFile,writeFile,readdir,copyFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const ext='C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8';
const root='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const before=await json(join(ext,'harness21-candidate4-pending-close-snapshot.json'));
const inspection=await json(join(ext,'harness21-candidate4-pending-close-inspector.json'));
const attempt=join(before.round,'..'),sealBytes=await readFile(join(attempt,'completed.seal.json')),seal=JSON.parse(sealBytes);
assert.equal(seal.sha256,sha(JSON.stringify(seal.completion)));
const files={},directories=[];
async function walk(relative=''){for(const item of await readdir(join(before.round,relative),{withFileTypes:true})){assert.ok(!item.isSymbolicLink());const p=relative?relative+'/'+item.name:item.name;if(item.isDirectory()){directories.push(p);await walk(p);}else{const bytes=await readFile(join(before.round,p));files[p]={sha256:sha(bytes),size:bytes.length};}}}
await walk();
for(const [file,value] of Object.entries(before.files))assert.deepEqual(files[file],value,file+' unchanged');
assert.deepEqual(directories.sort(),before.directories.sort());
const added=Object.keys(files).filter(path=>!(path in before.files));assert.deepEqual(added,['evaluation.json']);
for(const [file,digest] of Object.entries(seal.completion.files))assert.equal(sha(await readFile(join(attempt,file))),digest);
const directory=join(root,'audit/close-delay');await mkdir(directory);
const evidence=[];
for(const name of ['harness21-candidate4-pending-close-snapshot.json','harness21-candidate4-pending-close-processes.json','harness21-candidate4-pending-close-inspector.json','harness21-pending-close-inspector.mjs','harness21-close-inspector.mjs','harness21-candidate4-pending-close-snapshot.mjs','harness21-candidate4-close-delay-evidence.mjs']){const bytes=await readFile(join(ext,name));await copyFile(join(ext,name),join(directory,name),1);evidence.push({file:'audit/close-delay/'+name,sha256:sha(bytes),bytes:bytes.length});}
const result={format:'renderweave-observation-debug-intervention/1',createdAt:new Date().toISOString(),unit:'run-2/zh-definition-extraction',attemptId:'c3e402ab-7c05-47bb-aaee-229080618d48',candidateId:'sha256:7ce9b838a00faa36038bb1c68e1d9e957380c23ead0d0abedf6dc0c1da449804',round:before.round,executionCommittedAt:before.execution.events.at(-1).at,debugRequestedAt:'2026-10-23T20:39:14.015Z',inspectorConnectedAt:inspection.startedAt,inspectorDisconnectedAt:inspection.endedAt,attemptSealedAt:seal.completion.endedAt,elapsedMs:seal.completion.elapsedMs,roundWallMs:before.record.run.wallMs,observedActiveResourceTypes:inspection.resourcesBefore,stackAvailable:false,reasonUnknown:true,diagnosticIntervention:true,performanceComparable:false,unattendedCloseProven:false,endpoint:'127.0.0.1:9229',pid:125740,scope:'临时loopback inspector，仅资源类型和调用位置请求；pause未取得栈，resume及关闭连接。没有env/凭据/heap内容读取、强制Promise、业务写入或模型重跑。',limits:['调试连接前已经发生收尾等待；不能从断开后59ms封存推断原因或修复效果','业务守卫及原生结果按原报告保留；本项不证明无人介入的正常收尾，也不用于性能比较','原始elapsed和会话时间完整保留，不扣除调试或等待时间；诊断辅助时间单列','监督预算3600000ms未改变，未触发timeout/取消/额度；未重跑该单元'],verification:{priorFiles:Object.keys(before.files).length,unchangedPriorFiles:Object.keys(before.files).length,unchangedDirectories:directories.length,addedAfterSnapshot:added,verifiedSealedFiles:Object.keys(seal.completion.files).length,sealSha256:sha(sealBytes)},evidence};
await writeFile(join(root,'audit/close-delay-diagnostic.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({unit:result.unit,elapsedMs:result.elapsedMs,verification:result.verification}));
