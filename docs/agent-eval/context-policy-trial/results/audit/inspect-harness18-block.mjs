import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const block=Number(process.argv[2]);
if(![3,4].includes(block))throw new Error('Only completed aggregate block 3 or 4');
const root='F:/GenCode/render-weave/out/harness18-context-trial';
const reportFile=path.join(root,`dispatch/block-${block}.report.json`);
const bytes=fs.readFileSync(reportFile), report=JSON.parse(bytes);
const arm=block===3?'on-demand':'full';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
const completed=JSON.parse(fs.readFileSync(path.join(root,`dispatch/block-${block}.completed.json`),'utf8'));
const mapping={inputTokens:'input_tokens',cacheReadTokens:'cache_read_input_tokens',cacheCreationTokens:'cache_creation_input_tokens',outputTokens:'output_tokens'};
const sums=Object.fromEntries(Object.keys(mapping).map(k=>[k,0]));
const rows=[];
for(const attempt of report.attempts){
 const file=path.join(root,arm,attempt.dir,'round/logs/stream.jsonl');
 const raw=fs.readFileSync(file);
 const entries=raw.toString('utf8').trim().split('\n').map(s=>JSON.parse(s));
 const results=entries.filter(x=>x.type==='result');
 if(results.length!==1)throw new Error('Expected one terminal result for '+attempt.id);
 const usage=results[0].usage,metrics={};
 for(const [k,v] of Object.entries(mapping)){
   if(!Number.isFinite(usage[v]))throw new Error('Unknown '+v);
   metrics[k]=usage[v]; sums[k]+=usage[v];
   if(usage[v]!==attempt.usage[k])throw new Error('Per-attempt mismatch '+attempt.id+' '+k);
 }
 rows.push({attemptId:attempt.id,unit:attempt.unit,streamSha256:digest(raw),streamBytes:raw.length,resultCount:results.length,initModels:[...new Set(entries.filter(x=>x.type==='system'&&x.subtype==='init').map(x=>x.model))],assistantModels:[...new Set(entries.filter(x=>x.type==='assistant').map(x=>x.message?.model).filter(Boolean))],metrics});
}
const comparisons=Object.keys(mapping).map(k=>({metric:k,reportTotal:report.totals[k],rawResultsSum:sums[k],unknown:report.totals.unknownByMetric[k],equal:report.totals[k]===sums[k]}));
if(rows.length!==16||comparisons.some(x=>!x.equal||x.unknown!==0))throw new Error('Aggregate mismatch or incomplete arm');
const audit={block,arm,checkedAt:new Date().toISOString(),reportSha256:digest(bytes),source:'one native stream result usage per immutable attempt; independent four-counter sums and model event inspection',scope:'aggregate arm report includes both repetitions; earlier block audit is not additional observations',thinking:'contained in output, not added',humanMinutes:null,providerRevision:null,attempts:rows.length,comparisons,observations:rows};
const output=path.join(import.meta.dirname,`harness18-block${block}-aggregate-cost-source-inspection.json`);
fs.writeFileSync(output,JSON.stringify(audit,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({output,arm,attempts:rows.length,comparisons,initModels:[...new Set(rows.flatMap(x=>x.initModels))],assistantModels:[...new Set(rows.flatMap(x=>x.assistantModels))]},null,2));
