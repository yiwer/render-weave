/** 原38英文局部：原样旧候选只读重放；不创建模型轮次、outcome、批准或应用。 */
import {readFile,writeFile,mkdir,readdir,realpath,lstat} from 'node:fs/promises';
import {resolve,join,dirname,relative,basename,sep,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
const {values}=parseArgs({options:{candidate:{type:'string'},inventory:{type:'string'},out:{type:'string'}},strict:true});
for(const key of ['candidate','inventory','out'])if(!values[key])throw new Error('缺少 --'+key+'；本包仅允许20已冻结候选');
const candidateDir=resolve(values.candidate),runtime=join(candidateDir,'content'),out=resolve(values.out);
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=b=>JSON.parse(Buffer.from(b).toString('utf8'));
async function verifyCandidate(){
  const result=spawnSync(process.execPath,[join(runtime,'node_modules/tsx/dist/cli.mjs'),join(runtime,'scripts/agent-eval/freeze.ts'),'--verify',candidateDir,'--current'],{cwd:runtime,windowsHide:true,encoding:'utf8'});
  if(result.status!==0)throw new Error('候选核查失败：'+(result.error?.message??'')+result.stdout+result.stderr);
  const bytes=await readFile(join(candidateDir,'candidate.json'));
  return {id:json(bytes).id,manifestSha256:sha(bytes),directory:candidateDir};
}
const candidate=await verifyCandidate();
const inventoryBytes=await readFile(resolve(values.inventory)),inventory=json(inventoryBytes);
const legacy=inventory.legacyCandidate;
if(inventory.format!=='renderweave-original38-en-inventory-draft/1'||legacy.outcomePresent!==false||inventory.entries.length!==41)throw new Error('不是登记的原38局部库存');
const sourceRecords=[...Object.values(inventory.sources),legacy.round,...legacy.candidates,...legacy.snapshotWorkspace.files,legacy.request,legacy.resourceManifest,...legacy.resources];
async function verifySources(){
  const checked=[];
  for(const item of sourceRecords){
    const bytes=await readFile(item.file),actual=sha(bytes);
    if(actual!==item.sha256)throw new Error('原始材料变化：'+item.file);
    checked.push({file:item.file,sha256:actual});
  }
  return checked;
}
async function rejectLinks(path){
  let current=resolve(path);
  while(true){if((await lstat(current)).isSymbolicLink())throw new Error('来源或输出父目录不能是链接：'+current);const parent=dirname(current);if(parent===current)break;current=parent;}
}
await rejectLinks(dirname(out));
for(const file of [candidateDir,resolve(values.inventory),...sourceRecords.map(item=>item.file)])await rejectLinks(file);
const actualOut=join(await realpath(dirname(out)),basename(out));
for(const root of [candidateDir,dirname(resolve(values.inventory)),...sourceRecords.map(item=>dirname(item.file))]){
  const rel=relative(await realpath(root),actualOut);
  if(!rel||!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))throw new Error('输出目录必须在来源之外：'+root);
}
const sourceFiles=await verifySources();
await mkdir(out); // 新目录，不覆盖任何旧报告。
const save=async(file,bytes)=>{const target=join(out,file);await mkdir(dirname(target),{recursive:true});await writeFile(target,bytes,{flag:'wx'});};
const saveJson=(file,value)=>save(file,JSON.stringify(value,null,2)+'\n');
await save('prepare-legacy-en-review.mjs',await readFile(fileURLToPath(import.meta.url)));
await save('inventory.json',inventoryBytes);
await save('source.png',await readFile(inventory.sources.sample.file));
await save('historical-reference.json',await readFile(inventory.sources.reference.file));
await save('historical-round.json',await readFile(legacy.round.file));
await save('request.json',await readFile(legacy.request.file));
for(const item of legacy.snapshotWorkspace.files)await save('workspace/'+basename(item.file),await readFile(item.file));
for(const item of legacy.candidates)await save('workspace/'+basename(item.file),await readFile(item.file));
await save('resources/resources.json',await readFile(legacy.resourceManifest.file));
for(const item of legacy.resources){
  const rel=relative(dirname(legacy.resourceManifest.file),item.file);
  if(isAbsolute(rel)||rel==='..'||rel.startsWith('..'+sep))throw new Error('资源路径越界');
  await save('resources/'+rel.split(sep).join('/'),await readFile(item.file));
}
const api=await import(pathToFileURL(join(runtime,'dist/index.js')).href);
const workspace=await api.loadWorkspace({dir:join(out,'workspace'),resourcesDir:join(out,'resources')});
const request=json(await readFile(join(out,'request.json')));
const final=await api.render(workspace,request);
const draftRequest={...request,mode:'draft'};
const draft=await api.render(workspace,draftRequest,{comparisonEvidence:true});
const metadata=image=>image?{dpi:image.dpi,widthPx:image.widthPx,heightPx:image.heightPx,sha256:sha(image.bytes)}:null;
if(final.image)await save('actual-request.png',final.image.bytes);
if(draft.image)await save('draft.png',draft.image.bytes);
if(draft.evidence?.image)await save('content.png',draft.evidence.image.bytes);
await saveJson('public-render.json',{request,final:{problems:final.problems,layout:final.layout,image:metadata(final.image)},draft:{request:draftRequest,problems:draft.problems,layout:draft.layout,image:metadata(draft.image),contentImage:metadata(draft.evidence?.image)}});
const blank={format:'original38-en-independent-review/1',status:'not-reviewed',candidate,inventorySha256:sha(inventoryBytes),sourceImageSha256:inventory.sources.sample.sha256,reviewer:null,startedAt:null,endedAt:null,activeMinutes:null,autoDiagnosticsSeenBeforeFirstJudgment:null,entries:inventory.entries.map(item=>({id:item.id,sourceFactsApproved:null,measurementApproved:null,content:null,style:null,state:null,visibility:null,allApplicableInstancesReviewed:null,decision:null,evidence:null,comment:null})),longestEnglishText:{reviewedAcrossAll16Stops:null,text:null,stopIndex:null},businessAcceptance:null,scope:'仅英文与几何局部；不得判断整图正式可交付',allowedDecisions:['accept','issue','unknown','not-applicable']};
await saveJson('review-template.json',blank);
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function crop(file,box){
  const pad=Math.max(12,Math.min(box.width,box.height)*0.2);
  const x=Math.max(0,box.x-pad),y=Math.max(0,box.y-pad),w=Math.min(inventory.sources.sample.widthPx,box.x+box.width+pad)-x,h=Math.min(inventory.sources.sample.heightPx,box.y+box.height+pad)-y;
  return '<div class="crop" style="aspect-ratio:'+w+'/'+h+'"><img src="'+file+'" alt="同位置上下文" style="position:absolute;max-width:none;width:'+(inventory.sources.sample.widthPx/w*100)+'%;height:'+(inventory.sources.sample.heightPx/h*100)+'%;left:'+(-x/w*100)+'%;top:'+(-y/h*100)+'%"></div>';
}
const panels=inventory.entries.map(item=>{
 const box=item.location.contextRegionPx;
 return '<section id="'+esc(item.id)+'"><h2>'+esc(item.id)+'</h2><p>'+esc(item.sourceFacts.englishText??item.sourceFacts.appearance)+' · 源图状态：'+esc(item.sourceFacts.observedState)+'。这些事实及历史框仍待核准。</p><div class="pair"><div><h3>原图</h3>'+crop('source.png',box)+'</div><div><h3>原样候选的干净草稿内容</h3>'+(draft.evidence?.image?crop('content.png',box):'<p>没有内容图，保持未知。</p>')+'</div></div></section>';
});
await save('review.html',['<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>原38英文局部独立审核</title>','<style>body{font:16px/1.6 system-ui;max-width:1500px;margin:32px auto;padding:0 20px;color:#172b4d}img{max-width:100%}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}.crop{position:relative;overflow:hidden;border:1px solid #ccc;background:white}section{margin:40px 0}pre{white-space:pre-wrap}a{color:#1458b0}</style>',
'<h1>原38 · 英文与几何局部独立审核</h1><p>原样历史候选，无最终outcome；本包不是新模型观测，未审核、未批准、未应用。先看原图和候选，记录独立判断，再查看诊断。</p>',
'<p>实际请求保留800×900毫米、50 DPI、currentIndex=6。局部图使用相同整板坐标，仅作定位；坐标框、物理尺寸、容差尚未获独立核准。没有自动比较或通过结论。混排项只核英文，其他文字保持原样；不作阿文还原。</p>',
'<p><a href="review-template.json">复制空白人工记录后填写</a> · <a href="inventory.json">41项范围与未知</a> · <a href="manifest.json">材料身份</a></p>',
'<details><summary>整图上下文</summary><div class="pair"><img src="source.png" alt="原图">'+(draft.evidence?.image?'<img src="content.png" alt="原样候选干净草稿内容">':'<p>无图</p>')+'</div></details>',...panels,
'<details><summary>完成独立判断后查看公开渲染诊断</summary><p><a href="public-render.json">正式请求与草稿的完整问题、布局及图片身份</a> · <a href="draft.png">含诊断边框的草稿</a></p><p>正式请求是否出图：'+(final.image?'有图，仍须审核':'没有图片，受阻')+'。草稿内容不证明正式可交付；原有文字塑形阻断不绕过。</p></details></html>'].join('\n'));
if(JSON.stringify(sourceFiles)!==JSON.stringify(await verifySources()))throw new Error('原始材料发生变化');
if(JSON.stringify(candidate)!==JSON.stringify(await verifyCandidate()))throw new Error('候选发生变化');
const files=[];
async function walk(dir){for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())files.push({path:relative(out,file).split(sep).join('/'),sha256:sha(await readFile(file))});else throw new Error('材料含非普通文件');}}
await walk(out);
await saveJson('manifest.json',{format:'original38-en-local-review-package/1',createdAt:new Date().toISOString(),status:'prepared-not-reviewed',candidate,rendererBuildId:await api.rendererBuildId(),inventorySha256:sha(inventoryBytes),sourceFiles,originalSourcesUnchanged:true,request,finalImage:metadata(final.image),contentImage:metadata(draft.evidence?.image),newModelObservations:0,automaticComparison:null,humanReview:null,files});
console.log(JSON.stringify({out,entries:panels.length,status:'prepared-not-reviewed',newModelObservations:0,finalImage:metadata(final.image),contentImage:metadata(draft.evidence?.image),originalSourcesUnchanged:true}));
