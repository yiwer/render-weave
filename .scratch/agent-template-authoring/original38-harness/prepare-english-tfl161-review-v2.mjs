/** 原38 TfL161首次/唯一纠偏的独立审核包v2；旧包及旧生成器保持原字节。 */
import {readFile,writeFile,mkdir,readdir,cp,realpath,lstat} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';

const {values}=parseArgs({options:{registration:{type:'string'},round:{type:'string'},out:{type:'string'},'first-package':{type:'string'},'verify-inputs':{type:'boolean'}},strict:true});
assert(values.registration,'缺少 --registration');
if(values['verify-inputs'])assert(!values.round&&!values.out,'输入预检不接收round/out，也不创建审核包');
else assert(values.round&&values.out,'实际审核包需要 --round 和新的 --out');
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=async p=>JSON.parse(await readFile(p,'utf8'));
const slash=p=>p.split(sep).join('/');
const same=(a,b,label)=>assert.deepEqual(a,b,label);
const inside=(root,path)=>{
  assert(typeof path==='string'&&!isAbsolute(path),'相对路径无效');
  const full=resolve(root,path),rel=relative(root,full);
  assert(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel),'相对路径越界');
  return full;
};
async function rejectLinks(path){
  for(let current=resolve(path);;current=dirname(current)){
    assert(!(await lstat(current)).isSymbolicLink(),'来源或输出父链不能是链接：'+current);
    if(dirname(current)===current)break;
  }
}
async function inventory(root){
  const files=[],directories=[];
  async function walk(dir){
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(dir,entry.name),rel=slash(relative(root,path));
      assert(!entry.isSymbolicLink(),'来源内不能含链接：'+path);
      if(entry.isDirectory()){directories.push(rel);await walk(path);}
      else {assert(entry.isFile(),'非普通文件：'+path);const bytes=await readFile(path);files.push({path:rel,bytes:bytes.length,sha256:hash(bytes)});}
    }
  }
  await walk(root);return {files:files.sort((a,b)=>a.path.localeCompare(b.path)),directories:directories.sort()};
}
async function requireNewOutside(out,roots){
  await rejectLinks(dirname(out));
  const actual=join(await realpath(dirname(out)),out.split(/[\\/]/).at(-1));
  for(const root of roots){await rejectLinks(root);const rel=relative(await realpath(root),actual);assert(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel),'输出必须在全部来源之外：'+root);}
  try{await lstat(out);throw new Error('输出已存在，不能覆盖：'+out);}catch(error){if(error.code!=='ENOENT')throw error;}
}
const registrationFile=resolve(values.registration),registrationDir=dirname(registrationFile);
await rejectLinks(registrationFile);
const registrationBytes=await readFile(registrationFile),registration=JSON.parse(registrationBytes);
assert.equal(registration.format,'original38-english-tfl161-registration/1');
const candidateDir=resolve(registration.candidate.directory),runtime=join(candidateDir,'content');
const bindingDir=resolve(registration.binding.directory),materials=resolve(registration.materials.directory);
const correction=registration.design.unit==='original38-en-tfl161/correction-1';
assert(correction||registration.design.unit==='original38-en-tfl161/design-1','仅支持首次与唯一纠偏单元');
assert(correction?!!values['first-package']:!values['first-package'],'纠偏必须提供 --first-package，首次不得混入首轮包');
const firstPackage=correction?resolve(values['first-package']):null;
let firstManifest=null,firstProof=null,firstPackageBefore=null,firstRoundBefore=null,firstRecord=null,firstOutcome=null,firstManifestSha256=null,firstProofSha256=null;
if(firstPackage){
  await rejectLinks(firstPackage);
  const manifestBytes=await readFile(join(firstPackage,'manifest.json')),proofBytes=await readFile(join(firstPackage,'source-proof.json'));
  firstManifest=JSON.parse(manifestBytes);firstProof=JSON.parse(proofBytes);
  same(firstManifest.format,'original38-tfl161-actual-review-package/1','首次真实审核包格式');
  same(firstManifest.sourceProof,firstProof,'首次manifest与来源记录');same(firstProof.unit,'original38-en-tfl161/design-1','必须是真实首次');
  same(firstProof.candidateId,registration.candidate.id,'首次与纠偏同候选');
  firstPackageBefore=await inventory(firstPackage);
  same(firstPackageBefore.files.filter(item=>item.path!=='manifest.json'),firstManifest.files,'首次包完整文件/SHA');same(firstPackageBefore.directories,firstManifest.directories,'首次包完整目录');
  await rejectLinks(firstProof.round);firstRoundBefore=await inventory(firstProof.round);same(firstRoundBefore,firstProof.sourceRound,'首次原件完整集合/SHA');
  firstRecord=await json(join(firstProof.round,'round.json'));same(firstRecord.inputs.previous,null,'首次没有上一轮');same(firstRecord.round,1,'真实首次轮号');
  same(hash(await readFile(join(firstProof.round,'outcome.json'))),firstProof.outcomeSha256,'首次真实outcome');
  same(registration.firstDesign?.status,'completed','登记首次已完成');same(await realpath(registration.firstDesign.out),await realpath(firstProof.round),'登记首次原件');same(hash(await readFile(join(firstProof.round,'round.json'))),registration.firstDesign.roundRecordSha256,'登记首次round记录');
  firstOutcome=(await json(join(firstPackage,'independent-review.json'))).firstOutcome;
  same(firstOutcome.outcomeSha256,firstProof.outcomeSha256,'首次表中的实际outcome');same(firstOutcome.bindingId,firstProof.bindingId,'首次表绑定');same(firstOutcome.actualImage,firstManifest.actualImage,'首次表实际图片');
  firstManifestSha256=hash(manifestBytes);firstProofSha256=hash(proofBytes);
}
const round=values.round?resolve(values.round):null,out=values.out?resolve(values.out):null;
const sources=[registrationDir,bindingDir,materials,candidateDir,runtime,...(round?[round]:[]),...(firstPackage?[firstPackage,firstProof.round]:[])];
for(const path of sources)await rejectLinks(path);
if(out)await requireNewOutside(out,sources);

const env={...process.env};
for(const key of ['OPEN_CODE_API_KEY','ANTHROPIC_API_KEY','GOOGLE_API_KEY','GEMINI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'])delete env[key];
function publicVerify(script,args){
  const command=[join(runtime,'node_modules/tsx/dist/cli.mjs'),join(runtime,'scripts/agent-eval',script),...args];
  const result=spawnSync(process.execPath,command,{cwd:runtime,env,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,'公开预检失败：'+result.stderr+result.stdout);
  return {command:[process.execPath,...command],exitCode:result.status,stdout:result.stdout,stderr:result.stderr};
}
const candidateVerification=publicVerify('freeze.ts',['--verify',candidateDir,'--current']);
const stageVerification=publicVerify('stage.ts',['--verify',bindingDir]);
const candidateBytes=await readFile(join(candidateDir,'candidate.json')),candidate=JSON.parse(candidateBytes);
same(candidate.id,registration.candidate.id,'候选ID');same(hash(candidateBytes),registration.candidate.manifestSha256,'候选清单');
const bindingBytes=await readFile(join(bindingDir,'binding.json')),binding=JSON.parse(bindingBytes),{id:bindingId,...bindingBody}=binding;
same(binding.format,'renderweave-candidate-stage/1','公开阶段绑定');same(bindingId,'sha256:'+hash(JSON.stringify(bindingBody)),'绑定内容ID');
same(bindingId,registration.binding.id,'登记绑定ID');same(hash(bindingBytes),registration.binding.sha256,'登记绑定SHA');same(binding.candidate.id,candidate.id,'阶段候选');
same(binding.unit,registration.design.unit,'当前首次/纠偏单元');
const requestBytes=await readFile(join(bindingDir,'request.json')),stageRequest=JSON.parse(requestBytes);
same('sha256:'+hash(requestBytes),binding.identity.config,'阶段请求身份');same(stageRequest.args,binding.identity.request,'绑定参数');
const args={};for(let i=0;i<stageRequest.args.length;i+=2)args[stageRequest.args[i].slice(2)]=stageRequest.args[i+1];
same(resolve(args.out),resolve(registration.design.out),'登记输出');
if(correction){
  assert(args.from&&args.feedback,'纠偏必须从真实首次与实际反馈接续');same(await realpath(args.from),await realpath(firstProof.round),'绑定from指向首次');
  assert(!args.checkpoint,'不能用恢复草稿替换首次成果');
  same(resolve(args.feedback),resolve(registration.correction.feedback),'登记的真实反馈');
  assert(stageRequest.materials.some(item=>resolve(item.file)===join(firstPackage,'source-proof.json')&&item.sha256==='sha256:'+firstProofSha256),'纠偏绑定必须包含首次来源证明');
  const inheritedPaths={workspace:join(materials,'manual-input/workspace'),request:join(firstProof.round,firstRecord.inputs.request.file),reference:join(firstProof.round,firstRecord.inputs.reference.file)};
  for(const [name,path] of Object.entries(inheritedPaths))if(args[name])same(resolve(args[name]),path,'显式参数不能替换继承来源：'+name);
  if(args.task)same(args.task,'template-design','接续继承设计任务');
}else{
  assert(!args.from,'首次不能是接续');same(resolve(args.workspace),join(materials,'manual-input/workspace'),'手工输入工作区');
  same(resolve(args.request),join(materials,'manual-input/request.json'),'实际请求');same(resolve(args.reference),join(materials,'manual-input/reference.json'),'核准参考');same(args.task,'template-design','设计任务');
}
const materialBefore=await inventory(materials),preservation=await json(join(registrationDir,'material-preservation.json'));
same(materialBefore.files.map(({path,sha256})=>({path,sha256})),preservation.files,'全部59材料原件');same(materialBefore.files.length,59,'完整材料数量');
const inputBytes=await readFile(join(materials,'input-manifest.json')),packageBytes=await readFile(join(materials,'package-manifest.json'));
same(hash(inputBytes),registration.materials.inputManifestSha256,'34输入清单');same(hash(packageBytes),registration.materials.packageManifestSha256,'57载荷清单');
const approvalBytes=await readFile(registration.materials.approvalFile),approval=JSON.parse(approvalBytes);
same(hash(approvalBytes),registration.materials.approvalSha256,'包外核准');same(approval.status,'approved','材料核准状态');
same(approval.inputManifestSha256,hash(inputBytes),'核准输入');same(approval.packageManifestSha256,hash(packageBytes),'核准材料包');
for(const entry of JSON.parse(inputBytes).files)same(hash(await readFile(inside(materials,entry.path))),entry.sha256,'核准输入：'+entry.path);
const preparedBytes=await readFile(join(registrationDir,'independent-review.prepared.json')),prepared=JSON.parse(preparedBytes);
const originalBlank=await json(join(materials,'review/independent-review.blank.json'));
same(prepared.items,originalBlank.items,'英文39项原范围');same(prepared.items.length,39,'英文审核项数');same(new Set(prepared.items.map(item=>item.id)).size,39,'审核ID唯一');
same(prepared.candidateId,candidate.id,'空表候选');same(prepared.bindingId,bindingId,'空表绑定');
for(const key of ['firstOutcome','correctedOutcome','reviewer','humanReviewMinutes','humanCorrectionMinutes','overallConclusion'])same(prepared[key],null,'空人审：'+key);
for(const item of prepared.items)for(const key of ['firstConclusion','correctedConclusion','evidence','reviewMinutes'])same(item[key],null,item.id+' 人审空值');
const reference=await json(join(materials,'manual-input/reference.json'));
same(reference.approvedRegions.map(item=>item.id),prepared.items.map(item=>item.id),'参考与审核逐项对应');
const sourceImage=await readFile(join(materials,'render/page-13-200dpi.png'));
same(hash(sourceImage),reference.sampleSha256,'整页原图');
const sourceDimensions={width:sourceImage.readUInt32BE(16),height:sourceImage.readUInt32BE(20)};
same(sourceDimensions,{width:reference.sampleWidthPx,height:reference.sampleHeightPx},'原图尺寸');
// 复用核准材料中的原像素页首视口，不生成、重画或增强图像。
const sourcePanel=await readFile(join(materials,'measurement/panel-inspection-only.png'));
const {PNG}=createRequire(join(runtime,'package.json'))('pngjs');
const pagePixels=PNG.sync.read(sourceImage),panelPixels=PNG.sync.read(sourcePanel),region=reference.boardRegion;
same({width:panelPixels.width,height:panelPixels.height},{width:region.width,height:region.height},'页首视口尺寸');
for(let y=0;y<region.height;y++)same(panelPixels.data.subarray(y*region.width*4,(y+1)*region.width*4),pagePixels.data.subarray(((y+region.y)*pagePixels.width+region.x)*4,((y+region.y)*pagePixels.width+region.x+region.width)*4),'页首第'+y+'行原像素一致');
const fixedFiles={registration:registrationFile,approval:registration.materials.approvalFile,prepared:join(registrationDir,'independent-review.prepared.json'),binding:join(bindingDir,'binding.json'),stageRequest:join(bindingDir,'request.json'),candidate:join(candidateDir,'candidate.json')};
const fixedHashes={};for(const [name,path] of Object.entries(fixedFiles))fixedHashes[name]=hash(await readFile(path));
if(values['verify-inputs']){
  same(await inventory(materials),materialBefore,'输入预检后材料完整集合不变');
  if(firstPackage){same(await inventory(firstPackage),firstPackageBefore,'预检后首次包不变');same(await inventory(firstProof.round),firstRoundBefore,'预检后首次原件不变');}
  console.log(JSON.stringify({status:'inputs-verified-no-package',stage:correction?'correction-1':'design-1',candidateId:candidate.id,bindingId,firstPackage,firstManifestSha256,firstProofSha256,materialFiles:59,inputFiles:JSON.parse(inputBytes).files.length,reviewItems:39,sourceDimensions,modelCalls:0,createdPackage:false}));
}else{
  same(await realpath(round),await realpath(resolve(args.out)),'只接受阶段登记的原始轮次');
  const startBytes=await readFile(join(bindingDir,'dispatch-start.json')),start=JSON.parse(startBytes);
  const dispatchBytes=await readFile(join(bindingDir,'dispatch.json')),dispatch=JSON.parse(dispatchBytes);
  same(start.binding,bindingId,'实际派发开始绑定');same(await realpath(start.out),await realpath(round),'实际派发输出');
  same(dispatch.format,'renderweave-stage-dispatch/1','实际公开派发记录');same(dispatch.candidate,candidate.id,'派发候选');same(dispatch.binding,bindingId,'派发绑定');same(dispatch.unit,binding.unit,'派发单元');same(dispatch.invalid,null,'派发期间身份未漂移');
  const before=await inventory(round);
  assert(!before.directories.some(path=>path.split('/').some(part=>/^\.write-lock(?:-|$)/.test(part))),'轮次仍在写入，不能生成实际包');
  // 公开stage只在列出文件时排除瞬时租约目录；完整读前/后集合仍保留这些目录。
  const sealedFiles=Object.fromEntries(before.files.filter(f=>!f.path.split('/').slice(0,-1).some(part=>/^\.write-(?:lock|released|abandoned)(?:-|$)/.test(part))).map(f=>[f.path,'sha256:'+f.sha256]));
  same(sealedFiles,dispatch.files,'公开派发封存的完整轮次文件');
  await mkdir(out);
  const write=(path,bytes)=>writeFile(join(out,path),bytes,{flag:'wx'}),writeJson=(path,data)=>write(path,JSON.stringify(data,null,2)+'\n');
  const generatorBytes=await readFile(fileURLToPath(import.meta.url));await write('prepare-english-tfl161-review-v2.mjs',generatorBytes);
  await cp(round,join(out,'round-copy'),{recursive:true,errorOnExist:true,force:false});
  const copy=join(out,'round-copy');same(await inventory(copy),before,'普通轮次副本完整集合');
  const api=await import(pathToFileURL(join(runtime,'dist/index.js')).href);
  const reviewed=await api.readReview(copy,{persistArtifacts:false});
  assert(reviewed.view,'公开审核无法读取：'+JSON.stringify(reviewed.problems));
  const previous=await api.readPreviousRound(copy);
  assert(!previous.checkpoint,'恢复草稿不能作为首次正式交回成果');
  assert(previous.outcomeSha256,'缺正式outcome；不得用草稿冒充实际交回');
  assert(!previous.applied&&!reviewed.view.saved,'只接受首次人审之前的原始成果，不能用已审核或应用成果替换');
  same(previous.record.task,'template-design','实际任务');
  if(correction){
    const link=previous.record.inputs.previous;
    assert(link&&!link.checkpoint&&!link.basisChanged,'必须直接接续真实首次，不能替换检查点或已保存基础');
    same(await realpath(link.dir),await realpath(firstProof.round),'实际previous指向首次');same(link.round,firstRecord.round,'实际previous轮号');same(previous.record.round,firstRecord.round+1,'唯一接续轮号');
    same(link.outcomeSha256,firstProof.outcomeSha256,'实际previous成果SHA');same(link.reviewSha256,firstManifest.sourceProof.sourceRound.files.find(item=>item.path==='review.json')?.sha256??null,'实际previous审核SHA');same(link.reviewStatus,null,'首次未由生成者审核');
    same(await readFile(inside(copy,previous.record.inputs.reference.file)),await readFile(inside(firstProof.round,firstRecord.inputs.reference.file)),'实际继承的核准参考不变');
    same(hash(await readFile(inside(copy,previous.record.inputs.feedback.file))),hash(await readFile(args.feedback)),'实际反馈内容');
  }else same(previous.record.inputs.previous,null,'实际首次不含previous');
  assert(previous.record.inputs.resourceSnapshot,'缺本轮固定资源');
  const resourceRoot=inside(copy,previous.record.inputs.resourceSnapshot.directory);
  const workspace=await api.loadWorkspace({dir:join(copy,'snapshot'),resourcesDir:resourceRoot});
  const documents=previous.candidates.map(item=>({path:item.path,document:JSON.parse(Buffer.from(item.bytes).toString('utf8'))}));
  assert(documents.length&&documents.every(item=>String(item.document.dslVersion).startsWith('renderweave-template/')),'交回须为模板成果');
  const templates=documents.map(item=>({name:item.document.name,document:item.document,source:item.path}));
  const names=new Set(templates.map(item=>item.name));assert.equal(names.size,templates.length,'候选模板名重复');
  const effective={...workspace,templates:[...workspace.templates.filter(item=>!names.has(item.name)),...templates]};
  const actualRequestBytes=await readFile(join(copy,'request.json')),actualRequest=JSON.parse(actualRequestBytes);
  same(actualRequest,await json(join(materials,'manual-input/request.json')),'实际请求保持核准尺寸/DPI/模式');
  same(hash(await readFile(inside(copy,previous.record.inputs.sample.file))),hash(sourceImage),'轮次原图与核准整页相同');
  const actual=await api.render(effective,actualRequest);
  await write('source-page-13-200dpi.png',sourceImage);
  await write('source-panel-original-pixels.png',sourcePanel);
  if(firstPackage){
    await write('first-package-manifest.json',await readFile(join(firstPackage,'manifest.json')));await write('first-source-proof.json',await readFile(join(firstPackage,'source-proof.json')));
    if(firstManifest.actualImage)await write('first-actual-request.png',await readFile(join(firstPackage,'actual-request.png')));
    await writeJson('first-package-location.json',{directory:firstPackage,manifestSha256:firstManifestSha256,sourceProofSha256:firstProofSha256,round:firstProof.round});
  }
  if(actual.image)await write('actual-request.png',actual.image.bytes);
  const imageInfo=image=>image?{widthPx:image.widthPx,heightPx:image.heightPx,dpi:image.dpi,sha256:hash(image.bytes)}:null;
  await writeJson('actual-render.json',{purpose:'核准的原始正式请求；失败和无图如实保留',request:actualRequest,problems:actual.problems,layout:actual.layout,image:imageInfo(actual.image)});
  await writeJson('public-review.json',reviewed);
  // 草稿只供诊断页，首页及39项比较始终使用原始请求的实际成果。
  let draft=null;
  if(!actual.image){const request={...actualRequest,mode:'draft'};const result=await api.render(effective,request);draft={purpose:'仅诊断；不是原始正式请求成果',request,problems:result.problems,image:imageInfo(result.image)};if(result.image)await write('diagnostic-draft.png',result.image.bytes);await writeJson('diagnostic-draft.json',draft);}
  const instances=[];function collect(node){if(!node)return;const {children,...item}=node;instances.push(item);for(const child of children??[])collect(child);}collect(actual.layout?.root);
  await writeJson('layout-inventory.json',{format:'original38-public-layout-inventory/1',source:'原始请求公开render布局摘要',completeTraversal:true,limitations:['布局框和文本匹配不等于视觉正确；旋转、遮挡及字体/图标差异仍需人工判断。'],instances});
  await mkdir(join(out,'effective-candidates'));const effectiveFiles=[];
  for(const [index,item] of previous.candidates.entries()){const path='effective-candidates/'+String(index+1).padStart(2,'0')+'.json';await write(path,item.bytes);effectiveFiles.push({originalPath:item.path,file:path,sha256:hash(item.bytes)});}
  const sourceProof={format:'original38-tfl161-stage-source/2',candidateId:candidate.id,candidateManifestSha256:hash(candidateBytes),bindingId,bindingSha256:hash(bindingBytes),unit:binding.unit,round,firstPackage:firstPackage?{directory:firstPackage,manifestSha256:firstManifestSha256,sourceProofSha256:firstProofSha256,round:firstProof.round,candidateId:firstProof.candidateId,bindingId:firstProof.bindingId,outcomeSha256:firstProof.outcomeSha256}:null,previousLink:previous.record.inputs.previous,dispatchExitCode:dispatch.exitCode,dispatchStartSha256:hash(startBytes),dispatchSha256:hash(dispatchBytes),outcomeSha256:previous.outcomeSha256,contentIdentity:reviewed.view.contentIdentity??null,materialFiles:59,inputFiles:34,sourceImageSha256:hash(sourceImage),sourcePanel:{file:'source-panel-original-pixels.png',sha256:hash(sourcePanel),source:'measurement/panel-inspection-only.png',matchesFullPageRegionPixels:true,region},actualRequestSha256:hash(actualRequestBytes),actualImage:imageInfo(actual.image),sourceRound:before};
  await writeJson('source-proof.json',sourceProof);
  for(const [name,bytes] of Object.entries({'registration.json':registrationBytes,'binding.json':bindingBytes,'stage-request.json':requestBytes,'dispatch-start.json':startBytes,'dispatch.json':dispatchBytes,'material-approval.json':approvalBytes,'approved-review.prepared.json':preparedBytes,'actual-request.json':actualRequestBytes}))await write('source-'+name,bytes);
  await write('approved-material-scope.md',await readFile(join(materials,'REVIEW.md')));
  const currentOutcome={round,candidateId:candidate.id,bindingId,outcomeSha256:previous.outcomeSha256,actualImage:imageInfo(actual.image)};
  const blank={...prepared,status:'prepared-not-reviewed',firstOutcome:correction?firstOutcome:currentOutcome,correctedOutcome:correction?currentOutcome:null,firstPackage:correction?sourceProof.firstPackage:null,autoDiagnosticsSeenBeforeFirstJudgment:null,startedAt:null,endedAt:null};
  await writeJson('independent-review.json',blank);
  await write('time-events.blank.json',await readFile(join(materials,'review/time-events.blank.json')));
  const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
  const board=reference.boardRegion,scale=0.5,boardDisplayWidth=board.width*scale,boardDisplayHeight=board.height*scale;
  const crop=(src,box,pixelWidth=reference.sampleWidthPx,factor=scale)=>`<div class="crop" style="width:${box.width*factor}px;height:${box.height*factor}px"><img alt="同尺度坐标窗口" src="${src}" style="width:${pixelWidth*factor}px;left:${-box.x*factor}px;top:${-box.y*factor}px"></div>`;
  const phaseLabel=correction?'唯一纠偏':'首次设计';
  const firstImage=firstManifest?.actualImage??null;
  const resultPixelWidth=actual.image?actual.image.widthPx:board.width;
  const resultScale=boardDisplayWidth/resultPixelWidth;
  const actualBox=box=>({x:(box.x-board.x)*resultPixelWidth/board.width,y:(box.y-board.y)*(actual.image?.heightPx??board.height)/board.height,width:box.width*resultPixelWidth/board.width,height:box.height*(actual.image?.heightPx??board.height)/board.height});
  const firstBox=box=>({x:(box.x-board.x)*firstImage.widthPx/board.width,y:(box.y-board.y)*firstImage.heightPx/board.height,width:box.width*firstImage.widthPx/board.width,height:box.height*firstImage.heightPx/board.height});
  const firstCard=box=>correction?`<div><p>首次设计原始成果</p>${firstImage?crop('first-actual-request.png',firstBox(box),firstImage.widthPx,board.width/firstImage.widthPx):'<p>首次原始请求无成果图</p>'}</div>`:'';
  const cards=blank.items.map(item=>`<section id="${esc(item.id)}"><h3>${esc(item.id)} · ${esc(item.text??'图形/符号')} · ${esc(item.state)}</h3><div class="pair"><div><p>原图区域</p>${crop('source-page-13-200dpi.png',item.sourceRegionPx,reference.sampleWidthPx,1)}</div>${firstCard(item.sourceRegionPx)}<div><p>${phaseLabel}成果同一参考坐标窗口</p>${actual.image?crop('actual-request.png',actualBox(item.sourceRegionPx),resultPixelWidth,board.width/resultPixelWidth):'<p>原始请求无成果图</p>'}</div></div><p>结论、证据、分钟待独立审核填写。${esc(item.note??'')}</p></section>`).join('\n');
  const firstOverview=correction?`<div><p>首次设计原始成果</p>${firstImage?crop('first-actual-request.png',{x:0,y:0,width:firstImage.widthPx,height:firstImage.heightPx},firstImage.widthPx,boardDisplayWidth/firstImage.widthPx):'<p>首次原始正式请求未产生图片。</p>'}</div>`:'';
  const firstLinks=correction?`${firstImage?'<a href="first-actual-request.png">首次原始成果图</a> · ':''}<a href="first-package-manifest.json">首次包固定清单</a> · <a href="first-source-proof.json">首次来源证明</a> · `:'';
  const style='<style>body{font:16px/1.6 system-ui;margin:28px;color:#172b4d}h2{margin-top:36px}a{color:#1458b0}pre{white-space:pre-wrap}figure{margin:0}.pair{display:flex;gap:24px;overflow:auto;align-items:flex-start}.pair>div{flex:none}.crop{position:relative;overflow:hidden;border:1px solid #aaa;background:white}.crop img{position:absolute;max-width:none;height:auto}section{padding:16px 0;border-top:1px solid #ddd}.full{max-width:827px;width:100%;height:auto}code{overflow-wrap:anywhere}</style>';
  await write('review.html',`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>TfL161 英文${phaseLabel}独立审核</title>${style}<h1>TfL161 · ${phaseLabel}独立审核</h1><p>${correction?'本包比较原图、真实首次设计及唯一纠偏；首次结果原件保留，纠偏不覆盖首次。':'本包为真实首次设计。'}本包未审核、未批准、未应用。先看核准原图与实际成果，在独立副本填写39项判断及真实分钟，再查看诊断。模型自评和自动结果不在本页展示。</p><p>仅审核页首${board.width}×${board.height}像素范围；14个显示关键点是示意，不是完整实际站序。“You are here”不表示已知实际命名本站。历史图不用于实时运营。</p><p>实际请求 ${esc(JSON.stringify(actualRequest.output))}，模式 ${esc(actualRequest.mode)}。2mm是已核准缩字下限，源字体和字号未知；字体与手工SVG为明确替代，不能自动视为忠实通过。</p><h2>原样整页参考</h2><p><a href="source-page-13-200dpi.png">打开未改动整页原图</a>。本页仅缩放显示，原文件保持${sourceDimensions.width}×${sourceDimensions.height}像素。</p><img class="full" alt="原样第13页整页" src="source-page-13-200dpi.png"><h2>页首范围与实际成果 · 同尺度</h2><p>各幅共用相同画板显示宽度${boardDisplayWidth}px，参考高度${boardDisplayHeight}px。可横向滚动，链接打开原始像素图。</p><div class="pair"><div><p>原图页首范围</p>${crop('source-page-13-200dpi.png',board)}</div>${firstOverview}<div><p>${phaseLabel}原始正式请求成果</p>${actual.image?crop('actual-request.png',{x:0,y:0,width:actual.image.widthPx,height:actual.image.heightPx},resultPixelWidth,resultScale):'<p>原始正式请求未产生图片；不能把诊断草稿当作正式成果。</p>'}</div></div><p><a href="source-panel-original-pixels.png">原图页首原始像素</a> · ${firstLinks}${actual.image?'<a href="actual-request.png">打开本轮原始请求成果图</a> · ':''}<a href="independent-review.json">39项空白判断表</a> · <a href="time-events.blank.json">空白工时事件表</a></p><h2>39项逐区域对照</h2><p>以下成果窗口只按核准参考坐标取景，不代表系统已定位正确元素。移位或遗漏必须结合上方完整成果判断，不能只看窗口。所有项结论与分钟保持空白。</p>${cards}<h2>审核边界</h2><p>${esc(blank.additionalScope.join('；'))}</p><p>实际命名本站、完整实际站序、源字体/字号、未确认图标服务语义及实时运营信息继续未知；原混合图负评和停止阿文还原决定不变。</p><p>完成本轮独立判断后再打开 <a href="diagnostics.html">单独诊断页</a>，并记录是否已提前看过。<a href="source-proof.json">来源身份</a> · <a href="manifest.json">完整材料摘要</a>。本包中已核准的是输入，不是实际成果。</p></html>`);
  await write('diagnostics.html',`<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>TfL161 自动诊断（后看）</title>${style}<h1>自动诊断 · 不代替独立人审</h1><p>建议先在<a href="review.html">原图与实际成果页</a>完成判断。此页包含自动检查和模型原始记录；若已提前查看，在审核表如实记录。</p><p><a href="actual-render.json">实际请求、布局与问题</a> · <a href="public-review.json">公开审核结果（含原模型说明）</a> · <a href="layout-inventory.json">全部布局实例</a> · <a href="source-proof.json">派发来源证明</a></p>${draft?'<h2>独立诊断草稿</h2><p>原始正式请求无图。以下草稿仅帮助定位问题，不能冒充正式成果。</p><a href="diagnostic-draft.json">草稿请求与问题</a>'+(draft.image?'<img class="full" alt="仅诊断草稿" src="diagnostic-draft.png">':'<p>草稿也没有图片。</p>'):''}</html>`);
  same(await inventory(round),before,'读取/渲染后原轮次完整路径集合与SHA');same(await inventory(copy),before,'公开读取后副本完整路径集合与SHA');same(await inventory(materials),materialBefore,'核准材料完整集合');
  if(firstPackage){same(await inventory(firstPackage),firstPackageBefore,'实际包完成后首次审核包完整集合不变');same(await inventory(firstProof.round),firstRoundBefore,'实际包完成后首次原轮次完整集合不变');}
  same(await readFile(join(bindingDir,'dispatch-start.json')),startBytes,'开始记录未变');same(await readFile(join(bindingDir,'dispatch.json')),dispatchBytes,'完成记录未变');
  for(const [name,path] of Object.entries(fixedFiles))same(hash(await readFile(path)),fixedHashes[name],'固定来源未变：'+name);
  const finalCandidateVerification=publicVerify('freeze.ts',['--verify',candidateDir,'--current']);
  await writeJson('verification.json',{candidateVerification,stageVerification,finalCandidateVerification,sourceRoundUnchanged:true,copyUnchangedAfterPublicRead:true,materialsUnchanged:true,firstPackageUnchanged:correction?true:null,firstRoundUnchanged:correction?true:null,publicReadOptions:{persistArtifacts:false},modelCalls:0,humanJudgmentsWritten:0});
  const manifest={format:'original38-tfl161-actual-review-package/2',stage:correction?'correction-1':'design-1',status:'prepared-not-reviewed',createdAt:new Date().toISOString(),sourceProof,generatorSha256:hash(generatorBytes),rendererBuildId:await api.rendererBuildId(),publicIndexSha256:hash(await readFile(join(runtime,'dist/index.js'))),runtime,publicReadOptions:{persistArtifacts:false},sourceRoundUnchanged:true,copyUnchangedAfterPublicRead:true,firstPackageUnchanged:correction?true:null,firstRoundUnchanged:correction?true:null,materialDirectoryUnchanged:true,materialInventory:materialBefore,effectiveFiles,reviewItems:39,actualRequest,actualImage:imageInfo(actual.image),humanReview:null,files:(await inventory(out)).files,directories:(await inventory(out)).directories,excluded:['manifest.json']};
  await writeJson('manifest.json',manifest);
  console.log(JSON.stringify({out,candidateId:candidate.id,bindingId,round,reviewItems:39,actualImage:manifest.actualImage,originalRoundUnchanged:true,sourceRoundFiles:before.files.length,sourceRoundDirectories:before.directories.length,humanJudgmentsWritten:0,modelCalls:0}));
}
