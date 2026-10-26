/**
 * 原38人工比较材料：只读原轮次，在独立副本经公开入口取得有效成果并渲染。
 * 不是批准/应用或模型派发入口；不把预览DPI当实际出图DPI。
 */
import {readFile,writeFile,mkdir,readdir,cp,realpath,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';

const {values}=parseArgs({options:{runtime:{type:'string'},round:{type:'string'},out:{type:'string'},scope:{type:'string'},candidate:{type:'string'},evaluation:{type:'string'},binding:{type:'string'},preflight:{type:'boolean'}},strict:true});
for(const key of ['runtime','round','out','scope']) if(!values[key]) throw new Error('缺少 --'+key);
const runtime=resolve(values.runtime),round=resolve(values.round),out=resolve(values.out);
// 在创建目录前按真实父目录判断，不能让链接或误填路径改写原件/候选。
async function rejectLinks(path){
  let current=resolve(path);
  while(true){if((await lstat(current)).isSymbolicLink())throw new Error('来源或输出父目录不能是链接：'+current);const parent=dirname(current);if(parent===current)break;current=parent;}
}
async function outsideSources(roots){
  await rejectLinks(dirname(out));
  for(const root of roots)await rejectLinks(root);
  const actualOut=join(await realpath(dirname(out)),out.split(/[\\/]/).at(-1));
  for(const root of roots){const actualRoot=await realpath(root),rel=relative(actualRoot,actualOut);if(!rel||!rel.startsWith('..'+sep)&&rel!=='..'&&!isAbsolute(rel))throw new Error('输出目录必须在来源之外：'+root);}
}
await outsideSources([round,runtime,dirname(resolve(values.scope)),...(values.candidate?[resolve(values.candidate)]:[]),...(values.evaluation?[resolve(values.evaluation)]:[]),...(values.binding?[resolve(values.binding)]:[])]);
if(values.candidate&&(!values.evaluation||!values.binding))throw new Error('正式包需要 --evaluation 与 --binding，不能只核对新渲染器');
if(!values.candidate&&!values.preflight)throw new Error('正式审核材料必须提供 --candidate；离线工具预演须明确 --preflight');
let candidate=null;
async function verifyRuntime(){
  if(!values.candidate)return;
  const directory=resolve(values.candidate);
  if(runtime!==join(directory,'content'))throw new Error('runtime 必须是候选 content');
  const checked=spawnSync(process.execPath,[join(runtime,'node_modules/tsx/dist/cli.mjs'),join(runtime,'scripts/agent-eval/freeze.ts'),'--verify',directory,'--current'],{cwd:runtime,encoding:'utf8',windowsHide:true});
  if(checked.status!==0)throw new Error('候选核查失败：'+checked.stderr+checked.stdout);
  const bytes=await readFile(join(directory,'candidate.json'));
  const parsed=JSON.parse(bytes);
  candidate={id:parsed.id,manifestSha256:createHash('sha256').update(bytes).digest('hex'),directory};
}
await verifyRuntime();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function inventory(root,attemptSeal=false){
  const files=[];
  async function walk(dir){
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=join(dir,entry.name);
      if(attemptSeal&&entry.isDirectory()&&/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(entry.name))continue;
      if(attemptSeal&&dir===root&&(['completed.json','completed.seal.json'].includes(entry.name)||/^\.metadata-.*\.tmp$/.test(entry.name)))continue;
      if(entry.isSymbolicLink())throw new Error('审核副本不跟随链接：'+file);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile())files.push({path:relative(root,file).split(sep).join('/'),sha256:hash(await readFile(file))});
    }
  }
  await walk(root);return files;
}
async function directoryInventory(root){
  const directories=[];
  async function walk(dir){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw new Error('目录清单不得含链接');
      if(entry.isDirectory()){const file=join(dir,entry.name);directories.push(relative(root,file).split(sep).join('/'));await walk(file);}
    }
  }
  await walk(root);return directories.sort();
}
function inside(root,path){
  if(typeof path!=='string'||isAbsolute(path))throw new Error('轮次内路径无效');
  const file=resolve(root,path),rel=relative(root,file);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('轮次内路径越界');
  return file;
}
let observationProof=null;
async function verifyObservation(){
  if(!values.candidate)return;
  const evaluation=await realpath(resolve(values.evaluation)),actualRound=await realpath(round);
  const rel=relative(evaluation,actualRound).split(sep).join('/');
  const match=/^run-(\d+)[/]([^/]+)[/]attempts[/]([a-f0-9-]+)[/]round$/.exec(rel);
  if(!match)throw new Error('正式包只接受本实验 attempts 中封存的 round 原件');
  const evaluationBytes=await readFile(join(evaluation,'eval.json'));
  const saved=JSON.parse(evaluationBytes);
  const bindingBytes=await readFile(join(resolve(values.binding),'binding.json'));
  const binding=JSON.parse(bindingBytes),{id,...body}=binding;
  if(binding.format!=='renderweave-candidate-binding/1'||id!=='sha256:'+hash(JSON.stringify(body)))throw new Error('计划绑定完整性不符');
  if(binding.candidate.id!==candidate.id||saved.candidateBinding?.candidateId!==candidate.id||saved.candidateBinding?.id!==id||JSON.stringify(saved.identity)!==JSON.stringify(binding.identity))throw new Error('源实验不属于本候选和计划');
  if('sha256:'+hash(await readFile(join(resolve(values.binding),'config.json')))!==binding.identity.config)throw new Error('绑定配置字节变化');
  const resourceIds=Object.keys(binding.identity.resources).filter(key=>key.startsWith('resource-bytes/')).map(key=>key.slice(15));
  if(resourceIds.length!==Object.keys(binding.resourceEvidence??{}).length)throw new Error('绑定资源清单不全');
  for(const resourceId of resourceIds){const resource=binding.resourceEvidence[resourceId];if(!resource||!/^resources[/][a-f0-9]{64}\.bin$/.test(resource.file)||resource.sha256!==binding.identity.resources['resource-bytes/'+resourceId])throw new Error('绑定资源身份无效');const path=inside(resolve(values.binding),resource.file);await rejectLinks(path);if('sha256:'+hash(await readFile(path))!==resource.sha256)throw new Error('绑定资源字节变化');}
  const attempt=dirname(actualRound),startBytes=await readFile(join(attempt,'started.json')),start=JSON.parse(startBytes);
  const sealBytes=await readFile(join(attempt,'completed.seal.json')),seal=JSON.parse(sealBytes),completion=seal.completion;
  const compatibility=await readFile(join(attempt,'completed.json'),'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return undefined;throw error;});
  const experiment='sha256:'+hash(JSON.stringify(saved.identity));
  if(start.format!=='renderweave-eval-attempt/1'||start.id!==match[3]||start.experiment!==experiment||start.legacy||!['template-design','template-revision'].includes(start.task))throw new Error('尝试来源不符');
  if(!binding.units.some(unit=>unit.scenario===match[2]&&unit.repetition===Number(match[1])&&unit.stage===start.stage))throw new Error('尝试不属于预登记单元');
  if(!seal.completion||seal.sha256!==hash(JSON.stringify(seal.completion))||(compatibility!==undefined&&seal.sha256!==hash(JSON.stringify(compatibility)))||completion.eligible===false)throw new Error('尝试完成封存无效');
  const attemptFiles=await inventory(attempt,true);
  const actual=Object.fromEntries(attemptFiles.map(item=>[item.path,item.sha256]));
  const expected=completion.files;
  if(Object.keys(actual).length!==Object.keys(expected??{}).length||Object.entries(actual).some(([file,sha])=>expected[file]!==sha))throw new Error('尝试原件与封存文件不一致');
  const observation=JSON.parse(await readFile(join(actualRound,'evaluation.json')));
  if(observation.format!=='renderweave-eval-observation/1'||observation.experiment!==experiment)throw new Error('轮次实验封存不符');
  observationProof={evaluation,bindingDirectory:resolve(values.binding),candidateId:candidate.id,bindingId:id,experiment,unit:{scenario:match[2],repetition:Number(match[1]),stage:start.stage},attemptId:start.id,evaluationSha256:hash(evaluationBytes),bindingSha256:hash(bindingBytes),startedSha256:hash(startBytes),completionSealSha256:hash(sealBytes),sourceFiles:completion.files};
}
await verifyObservation();
const originalObservationProof=JSON.stringify(observationProof);
const before=await inventory(round);
const directoriesBefore=await directoryInventory(round);
await mkdir(out); // 必须是新目录；不覆盖之前的材料。
const generatorBytes=await readFile(fileURLToPath(import.meta.url));
await writeFile(join(out,'prepare-review.mjs'),generatorBytes,{flag:'wx'});
await cp(round,join(out,'round-copy'),{recursive:true,errorOnExist:true,force:false});
if(observationProof){
  await writeFile(join(out,'observation-source.json'),JSON.stringify(observationProof,null,2)+'\n',{flag:'wx'});
  await writeFile(join(out,'source-eval.json'),await readFile(join(observationProof.evaluation,'eval.json')),{flag:'wx'});
  await writeFile(join(out,'source-binding.json'),await readFile(join(observationProof.bindingDirectory,'binding.json')),{flag:'wx'});
}
const copy=join(out,'round-copy');
if((await lstat(copy)).isSymbolicLink()||!(await lstat(copy)).isDirectory())throw new Error('轮次副本必须是普通目录');
if(JSON.stringify(before)!==JSON.stringify(await inventory(copy)))throw new Error('副本身份不符');
if(JSON.stringify(directoriesBefore)!==JSON.stringify(await directoryInventory(copy)))throw new Error('副本完整目录集合不符');
const api=await import(pathToFileURL(join(runtime,'dist/index.js')).href);
const reviewed=await api.readReview(copy,{persistArtifacts:false});
if(!reviewed.view)throw new Error('公开审核无法读取：'+JSON.stringify(reviewed.problems));
const previous=await api.readPreviousRound(copy);
if(previous.checkpoint)throw new Error('恢复草稿另行登记，本包只取正式交回成果');
let revisionRequirement=null;
if(previous.record.task==='template-revision'){
  const input=previous.record.inputs.requirement;
  if(!input?.file||!input.sha256)throw new Error('修改成果缺少封存修改要求');
  const bytes=await readFile(inside(copy,input.file));
  if(hash(bytes)!==input.sha256)throw new Error('修改要求与封存身份不符');
  revisionRequirement={file:'round-copy/'+input.file.split(sep).join('/'),sha256:input.sha256,text:bytes.toString('utf8')};
}
if(!previous.record.inputs.resourceSnapshot)throw new Error('缺固定资源，不能使用当前资源代替');
const resourceRoot=inside(copy,previous.record.inputs.resourceSnapshot.directory);
const workspace=await api.loadWorkspace({dir:join(copy,'snapshot'),resourcesDir:resourceRoot});
const documents=previous.candidates.map(item=>({path:item.path,document:JSON.parse(Buffer.from(item.bytes).toString('utf8'))}));
const templates=documents.filter(item=>String(item.document.dslVersion).startsWith('renderweave-template/')).map(item=>({name:item.document.name,document:item.document,source:item.path}));
if(!templates.length)throw new Error('不是模板成果');
const names=new Set(templates.map(item=>item.name));
const effective={...workspace,templates:[...workspace.templates.filter(item=>!names.has(item.name)),...templates]};
const request=JSON.parse(await readFile(join(copy,'request.json'),'utf8'));
const result=await api.render(effective,request);
// 对照图另用公开render生成；不把缓存缺失说成未渲染，也不修改实际请求的DPI。
const comparisonRequest={...request,mode:'draft',output:{...request.output,dpi:120,format:'png'}};
const comparison=await api.render(effective,comparisonRequest);
// 修改前基准使用本轮固定 snapshot，而非参考照片或当前业务工作区。
const beforeRevision=revisionRequirement?await api.render(workspace,request):null;
if(beforeRevision?.image)await writeFile(join(out,'before-revision.png'),beforeRevision.image.bytes,{flag:'wx'});
if(beforeRevision)await writeFile(join(out,'before-revision-render.json'),JSON.stringify({purpose:'修改前固定snapshot，核对非目标保持',request,problems:beforeRevision.problems,image:beforeRevision.image?{dpi:beforeRevision.image.dpi,widthPx:beforeRevision.image.widthPx,heightPx:beforeRevision.image.heightPx,sha256:hash(beforeRevision.image.bytes)}:null},null,2)+'\n',{flag:'wx'});
const source=inside(copy,previous.record.inputs.sample.file);
const sourceBytes=await readFile(source);
const ext=sourceBytes[0]===255&&sourceBytes[1]===216?'.jpg':'.png';
await writeFile(join(out,'source'+ext),sourceBytes,{flag:'wx'});
if(result.image)await writeFile(join(out,'actual-request.png'),result.image.bytes,{flag:'wx'});
if(comparison.image)await writeFile(join(out,'comparison-preview.png'),comparison.image.bytes,{flag:'wx'});
await writeFile(join(out,'comparison-preview-render.json'),JSON.stringify({purpose:'仅供人工对照，不是实际正式请求',request:comparisonRequest,problems:comparison.problems,image:comparison.image?{dpi:comparison.image.dpi,widthPx:comparison.image.widthPx,heightPx:comparison.image.heightPx,sha256:hash(comparison.image.bytes)}:null},null,2)+'\n',{flag:'wx'});
const instances=[];
function collect(node){if(!node)return;const {children,...entry}=node;instances.push(entry);for(const child of children??[])collect(child);}
collect(result.layout?.root);
await writeFile(join(out,'layout-inventory.json'),JSON.stringify({format:'original38-public-layout-inventory/1',basis:'实际请求的公开render布局摘要',completeTraversal:true,nodes:instances.length,textNodes:instances.filter(item=>item.text).length,limitations:['实例库存不等于业务正确；布局框坐标不含旋转，最终遮挡与人工接受另行判断。'],instances},null,2)+'\n',{flag:'wx'});
await writeFile(join(out,'actual-render.json'),JSON.stringify({request,layout:result.layout,problems:result.problems,image:result.image?{dpi:result.image.dpi,widthPx:result.image.widthPx,heightPx:result.image.heightPx,sha256:hash(result.image.bytes)}:null},null,2)+'\n',{flag:'wx'});
await writeFile(join(out,'public-review.json'),JSON.stringify(reviewed,null,2)+'\n',{flag:'wx'});
const effectiveFiles=[];
await mkdir(join(out,'effective-candidates'));
for(let index=0;index<previous.candidates.length;index++){
  const item=previous.candidates[index],file=String(index+1).padStart(2,'0')+'.json';
  await writeFile(join(out,'effective-candidates',file),item.bytes,{flag:'wx'});
  effectiveFiles.push({source:item.path,file:'effective-candidates/'+file,sha256:hash(item.bytes)});
}
const sourceScope=await readFile(resolve(values.scope),'utf8');
let scope=sourceScope;
if(revisionRequirement){
  // 原库存的原图事实保留为单独来源；修改审核不能沿用与授权变化冲突的判据。
  await writeFile(join(out,'source-scope.md'),sourceScope,{flag:'wx'});
  scope='# 本轮模板修改审核范围\n\n修改要求优先于原图描述。以本页展示的封存修改要求为准；Z10、Z12检查授权变化，其他类别及这两类的非目标属性对照修改前固定snapshot保持不变。下表原图事实只供定位，不能覆盖本轮修改要求。\n\n'+sourceScope
    .replace(/^\| Z10 \|.*$/m,'| Z10 | 地标圈号（本轮授权变化） | 以封存修改要求为准：地标紧接竖排站名最后一个字，成为最后一格；有地标与无地标各列的末格底边齐平 | 核对全部适用实例；地标内容、颜色和所属站等非目标属性对照修改前保持不变 |')
    .replace(/^\| Z12 \|.*$/m,'| Z12 | 道路名称（本轮授权变化） | 以封存修改要求为准：道路名两端留白与字间距相同 | 核对全部15段；道路文字、颜色、分组等非目标属性对照修改前保持不变 |');
}
await writeFile(join(out,'scope.md'),scope,{flag:'wx'});
const reviewItems=[...scope.matchAll(/^\| (Z\d{2}) \| ([^|]+) \|/gm)].map(match=>({id:match[1],label:match[2].trim(),...(revisionRequirement?{reviewBasis:match[1]==='Z10'?'按封存修改要求：地标为竖排最后一格，各列末格底边齐平；内容、颜色、所属站等非目标属性与修改前保持不变。':match[1]==='Z12'?'按封存修改要求：道路名两端留白与字间距相同；文字、颜色、分组等非目标属性与修改前保持不变。':'非目标保持：与本轮修改前固定snapshot对照；原图仅供定位，完整修改要求优先。',requirementFile:revisionRequirement.file,requirementSha256:revisionRequirement.sha256}:{}),decision:null,allApplicableInstancesReviewed:null,sourceLocation:null,resultLocation:null,evidence:null,comment:null}));
const blank={allowedDecisions:['accept','issue','unknown','not-applicable'],format:'original38-independent-review/1',status:'not-reviewed',scopeSha256:hash(Buffer.from(scope)),revisionRequirement,reviewer:null,startedAt:null,endedAt:null,activeMinutes:null,autoDiagnosticsSeenBeforeFirstJudgment:null,originalJudgment:null,items:reviewItems,corrections:[],businessAcceptance:null};
await writeFile(join(out,'review-template.json'),JSON.stringify(blank,null,2)+'\n',{flag:'wx'});
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html=['<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>原38独立比较</title>',
'<style>body{font:16px/1.6 system-ui;margin:32px;max-width:1600px;color:#172b4d}img{width:100%;height:auto;border:1px solid #ddd}h2{margin-top:36px}pre{white-space:pre-wrap;background:#f4f6f8;padding:16px}a{color:#1458b0}</style>',
'<h1>原38 · 独立原始质量比较</h1><p>本包未审核、未批准、未应用。先对照原图记录独立判断，再查看诊断。复制 review-template.json 填写审核记录；工时未计量时保留 null。</p>',
'<p>实际请求：'+esc(JSON.stringify(request.output))+'；本包以公开读取入口取得的有效候选生成。模式：'+esc(request.mode||'final')+'。</p>',
revisionRequirement?'<h2>本轮修改要求优先</h2><p>以下封存修改要求优先于原图与旧样式库存。Z10、Z12按授权变化核对，其他项以及两类中的非目标属性对照修改前基准保持不变。不要把要求改变的位置或间距判作偏离原图。</p><pre>'+esc(revisionRequirement.text)+'</pre><p><a href="'+esc(revisionRequirement.file)+'">查看本轮封存修改要求原文</a> · SHA256 '+revisionRequirement.sha256+'</p>':'',
'<h2>原图</h2><img alt="原始参考图" src="source'+ext+'">',
revisionRequirement?'<h2>修改前基准图</h2><p>本轮固定snapshot经公开render按同一实际请求出图，用来核对非目标保持；它不是原图，也不是新模型成果。</p>'+(beforeRevision?.image?'<img alt="修改前固定snapshot基准" src="before-revision.png">':'<p>修改前基准未出图；非目标保持存在证据缺口，不能自动判为接受。</p>'):'',
'<h2>实际请求的出图</h2>',result.image?'<img alt="实际请求结果" src="actual-request.png">':'<p>本次实际请求没有出图；记录受阻，不能当成通过。</p>',
'<h2>高分辨率对照预览</h2><p>用相同有效候选经公开render另画120 DPI草稿，只供人工放大对照；它不代表上述实际请求的正式交付。</p>',
comparison.image?'<img alt="120 DPI对照草稿" src="comparison-preview.png">':'<p>无对照草稿图片；查看对应渲染记录。</p>',
'<h2>人工覆盖范围</h2><pre>'+esc(scope)+'</pre>',
'<p><a href="review-template.json">空白独立审核记录</a> · <a href="manifest.json">材料身份</a></p>',
'<details><summary>完成独立判断后展开诊断入口</summary><p><a href="actual-render.json">实际出图布局与问题</a> · <a href="layout-inventory.json">完整布局实例库存</a> · <a href="public-review.json">公开审核结果</a> · <a href="comparison-preview-render.json">对照预览请求与记录</a></p></details></html>'].join('\n');
await writeFile(join(out,'review.html'),html,{flag:'wx'});
const after=await inventory(round);
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('原始轮次在打包期间变化，材料不能使用');
if(JSON.stringify(directoriesBefore)!==JSON.stringify(await directoryInventory(round)))throw new Error('原始轮次目录集合变化');
if(JSON.stringify(before)!==JSON.stringify(await inventory(copy))||JSON.stringify(directoriesBefore)!==JSON.stringify(await directoryInventory(copy)))throw new Error('公开读取后副本完整路径集合或字节变化');
await verifyRuntime();
await verifyObservation();
if(JSON.stringify(observationProof)!==originalObservationProof)throw new Error('源实验或尝试记录在打包期间改变');
const manifest={observationProof,generatorSha256:hash(generatorBytes),candidate,preflight:!!values.preflight,format:'original38-review-package/2',scope:'模板/修改成果独立比较；首页不显示模型自评，完整原件与公开诊断另存，未自动核准人审独立性',status:'prepared-not-reviewed',createdAt:new Date().toISOString(),runtime,rendererBuildId:await api.rendererBuildId(),round,revisionRequirement,sourceScopeSha256:hash(Buffer.from(sourceScope)),sourceRoundFiles:before,sourceRoundDirectories:directoriesBefore,originalRoundUnchanged:true,copyUnchangedAfterPublicRead:true,publicReadOptions:{persistArtifacts:false},sourceImageSha256:hash(await readFile(source)),outcomeSha256:previous.outcomeSha256,reviewSha256:previous.reviewSha256,contentIdentity:reviewed.view.contentIdentity??null,effectiveFiles,request,actualImage:result.image?{dpi:result.image.dpi,widthPx:result.image.widthPx,heightPx:result.image.heightPx}:null,previewImage:comparison.image?{source:'separate-public-render',dpi:comparison.image.dpi,widthPx:comparison.image.widthPx,heightPx:comparison.image.heightPx}:null,layoutInventory:{nodes:instances.length,textNodes:instances.filter(item=>item.text).length},humanReview:null,files:await inventory(out)};
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,originalRoundUnchanged:true,effectiveCandidates:effectiveFiles.length,actualImage:manifest.actualImage,previewImage:manifest.previewImage,reviewStatus:blank.status}));

