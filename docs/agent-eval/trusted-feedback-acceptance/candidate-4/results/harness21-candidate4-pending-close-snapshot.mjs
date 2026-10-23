import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const base='F:/GenCode/render-weave/out/harness21-trusted-feedback-candidate-4';
const round=join(base,'observations/run-2/zh-definition-extraction/attempts/c3e402ab-7c05-47bb-aaee-229080618d48/round');
const output='C:/Users/Administrator/.codex/visualizations/2026/10/23/01a167fb-6fcb-7771-8713-7be4f73bddf8/harness21-candidate4-pending-close-snapshot.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const files={},directories=[];
async function walk(dir,prefix='') { for(const name of (await readdir(dir)).sort()) { const path=join(dir,name),rel=prefix+name,s=await lstat(path); if(s.isSymbolicLink()) throw Error('link '+rel); if(s.isDirectory()){directories.push(rel);await walk(path,rel+'/');}else files[rel]={sha256:sha(await readFile(path)),size:s.size}; } }
await walk(round);
const execution=JSON.parse(await readFile(join(round,'execution.json'),'utf8'));
const record=JSON.parse(await readFile(join(round,'round.json'),'utf8'));
const stream=(await readFile(join(round,'logs/stream.jsonl'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));
const result=stream.findLast(x=>x.type==='result');
const proof={format:'harness-pending-close-readonly/1',at:new Date().toISOString(),round,execution,record:{verdict:record.verdict,endedAt:record.endedAt,run:record.run},recordShaMatches:files['round.json'].sha256===execution.recordSha256,nativeResult:{type:result?.type,subtype:result?.subtype,isError:result?.is_error,durationMs:result?.duration_ms},files,directories,meaning:'轮次提交已记录，但执行宿主未回收且评估尚未封存；不声称观测完成，不重评分或修改原件。'};
await writeFile(output,JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,sha256:sha(await readFile(output)),files:Object.keys(files).length,directories:directories.length,recordShaMatches:proof.recordShaMatches}));
