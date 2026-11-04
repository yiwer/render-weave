// 仅对仓库受控夹具做自动审核验收；每次独占新目录，不调用模型。
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { importExcelRound, readReview, changeReview, applyAgentRound, initializeResourceStore, importResources, replayOutputRecord } from '../dist/index.js';
import { runCli } from '../dist/cli.js';

if(process.argv.length!==4 || process.argv[2]!=='--out') throw new Error('用法：node scripts/accept-excel-output.mjs --out <新目录>');
const root=resolve(process.argv[3]);await mkdir(root,{recursive:false});
const load=async file=>JSON.parse(await readFile(file,'utf8'));
const check=(condition,message)=>{if(!condition) throw new Error(message);};
const resources=join(root,'resources');check(!(await initializeResourceStore(resources)).problems.length,'资源初始化失败');
check(!(await importResources({sourceDir:'fixtures/resources',dir:resources})).problems.length,'资源导入失败');
const truth=(await load('fixtures/excel/price-tags.json')).rows;
const report={format:'renderweave-excel-output-acceptance/1',basis:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixtureOnly:true,modelCalls:0,scenarios:[]};
async function cli(args,log) {
  let stdout='',stderr='';const code=await runCli(args,{stdout:s=>stdout+=s,stderr:s=>stderr+=s});
  await writeFile(log,JSON.stringify({args,code,stdout,stderr},null,2));check(code===0,stderr);
  return JSON.parse(stdout);
}
for(const nested of [false,true]) {
  const name=nested?'catalog':'price-tags',dir=join(root,name);await mkdir(dir);
  const workspace=join(dir,'workspace');await cp(nested?'fixtures/workspaces/excel-catalog':'fixtures/workspaces/price-tag',workspace,{recursive:true});
  if(nested) await cp('fixtures/excel/output/template-catalog-item.json',join(workspace,'template-catalog-item.json'));
  const round=join(dir,'review');await importExcelRound({from:nested?'scripts/prototypes/excel-agent/evidence-p05/nested-01':'scripts/prototypes/excel-agent/evidence-p04/live-01',workspace,out:round});
  const review=await readReview(round);check(!review.problems.length && !!review.view,'审核不可读取');
  if(nested) check(isDeepStrictEqual(review.view.candidates[0].document.data.batches[0].items,truth.map(r=>r.data)),'嵌套数据不符合独立真值');
  else for(const candidate of review.view.candidates) check(isDeepStrictEqual(candidate.document.data,truth.find(r=>r.itemId===candidate.name)?.data),'价签不符合独立真值');
  for(const p of review.view.pending) check(!(await changeReview(round,{type:'decide',item:p.item,action:'adopt',note:'仓库受控夹具与独立真值逐字段核对'})).problems.length,'处理失败');
  check(!(await changeReview(round,{type:'confirmRest',confirmed:true})).problems.length,'整体确认失败');
  check(!(await changeReview(round,{type:'approve',comment:'自动验收仅适用于仓库夹具，不代表客户业务核准'})).problems.length,'核准失败');
  check(!(await applyAgentRound({roundDir:round})).problems.length,'应用失败');
  const prepared=join(dir,'prepared'),delivery=join(dir,'delivery');
  const preparation=await cli(['agent','prepare-output','--round',round,'--resources',resources,'--plan',`fixtures/excel/output/${nested?'catalog':'price-tags'}-plan.json`,'--out',prepared],join(dir,'prepare-cli.json'));
  const result=await cli(['agent','deliver-output','--prepared',prepared,'--out',delivery],join(dir,'deliver-cli.json'));
  check(result.state==='delivered' && result.summary.delivered===(nested?5:6),'交付数量不符');
  const replay=join(dir,'replay');check(!!(await replayOutputRecord({dir:join(delivery,'0001/0001'),outDir:replay})).replayed,'独立重放失败');
  check((await readFile(join(replay,'image.png'))).equals(await readFile(join(delivery,'0001/0001/image.png'))),'重放图片字节不同');
  const request=await load(join(prepared,'request-001.json'));
  const positions=nested?request.items.map(i=>i.parameters.productIndex):null;
  if(nested) check(isDeepStrictEqual(positions,[1,2,4,5,6]),'跳过后列表位置被重排');
  report.scenarios.push({name,preparation,state:result.state,summary:result.summary,skipped:result.skipped,positions,replayMatched:true});
}
await writeFile(join(root,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
