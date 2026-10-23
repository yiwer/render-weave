/**
 * 原38人工比较材料：只读原轮次，在独立副本经公开入口取得有效成果并渲染。
 * 不是批准/应用或模型派发入口；不把预览DPI当实际出图DPI。
 */
import {readFile,writeFile,mkdir,readdir,cp} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {spawnSync} from 'node:child_process';

const {values}=parseArgs({options:{runtime:{type:'string'},round:{type:'string'},out:{type:'string'},scope:{type:'string'},candidate:{type:'string'},preflight:{type:'boolean'}},strict:true});
for(const key of ['runtime','round','out','scope']) if(!values[key]) throw new Error('缺少 --'+key);
const runtime=resolve(values.runtime),round=resolve(values.round),out=resolve(values.out);
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
async function inventory(root){
  const files=[];
  async function walk(dir){
    for(const entry of (await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
      const file=join(dir,entry.name);
      if(entry.isSymbolicLink())throw new Error('审核副本不跟随链接：'+file);
      if(entry.isDirectory())await walk(file);
      else if(entry.isFile())files.push({path:relative(root,file).split(sep).join('/'),sha256:hash(await readFile(file))});
    }
  }
  await walk(root);return files;
}
function inside(root,path){
  if(typeof path!=='string'||isAbsolute(path))throw new Error('轮次内路径无效');
  const file=resolve(root,path),rel=relative(root,file);
  if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw new Error('轮次内路径越界');
  return file;
}
const before=await inventory(round);
await mkdir(out); // 必须是新目录；不覆盖之前的材料。
const generatorBytes=await readFile(fileURLToPath(import.meta.url));
await writeFile(join(out,'prepare-review.mjs'),generatorBytes,{flag:'wx'});
await cp(round,join(out,'round-copy'),{recursive:true,errorOnExist:true,force:false});
const copy=join(out,'round-copy');
if(JSON.stringify(before)!==JSON.stringify(await inventory(copy)))throw new Error('副本身份不符');
const api=await import(pathToFileURL(join(runtime,'dist/index.js')).href);
const reviewed=await api.readReview(copy);
if(!reviewed.view)throw new Error('公开审核无法读取：'+JSON.stringify(reviewed.problems));
const previous=await api.readPreviousRound(copy);
if(previous.checkpoint)throw new Error('恢复草稿另行登记，本包只取正式交回成果');
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
const source=inside(copy,previous.record.inputs.sample.file);
const sourceBytes=await readFile(source);
const ext=sourceBytes[0]===255&&sourceBytes[1]===216?'.jpg':'.png';
await writeFile(join(out,'source'+ext),sourceBytes,{flag:'wx'});
if(result.image)await writeFile(join(out,'actual-request.png'),result.image.bytes,{flag:'wx'});
if(reviewed.view.preview?.image)await writeFile(join(out,'review-preview.png'),await readFile(inside(copy,reviewed.view.preview.image)),{flag:'wx'});
await writeFile(join(out,'actual-render.json'),JSON.stringify({request,layout:result.layout,problems:result.problems,image:result.image?{dpi:result.image.dpi,widthPx:result.image.widthPx,heightPx:result.image.heightPx,sha256:hash(result.image.bytes)}:null},null,2)+'\n',{flag:'wx'});
await writeFile(join(out,'public-review.json'),JSON.stringify(reviewed,null,2)+'\n',{flag:'wx'});
const effectiveFiles=[];
await mkdir(join(out,'effective-candidates'));
for(let index=0;index<previous.candidates.length;index++){
  const item=previous.candidates[index],file=String(index+1).padStart(2,'0')+'.json';
  await writeFile(join(out,'effective-candidates',file),item.bytes,{flag:'wx'});
  effectiveFiles.push({source:item.path,file:'effective-candidates/'+file,sha256:hash(item.bytes)});
}
const scope=await readFile(resolve(values.scope),'utf8');
await writeFile(join(out,'scope.md'),scope,{flag:'wx'});
const reviewItems=[...scope.matchAll(/^\| (Z\d{2}) \| ([^|]+) \|/gm)].map(match=>({id:match[1],label:match[2].trim(),decision:null,allApplicableInstancesReviewed:null,sourceLocation:null,resultLocation:null,evidence:null,comment:null}));
const blank={allowedDecisions:['accept','issue','unknown','not-applicable'],format:'original38-independent-review/1',status:'not-reviewed',scopeSha256:hash(Buffer.from(scope)),reviewer:null,startedAt:null,endedAt:null,activeMinutes:null,autoDiagnosticsSeenBeforeFirstJudgment:null,originalJudgment:null,items:reviewItems,corrections:[],businessAcceptance:null};
await writeFile(join(out,'review-template.json'),JSON.stringify(blank,null,2)+'\n',{flag:'wx'});
const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const html=['<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>原38独立比较</title>',
'<style>body{font:16px/1.6 system-ui;margin:32px;max-width:1600px;color:#172b4d}img{width:100%;height:auto;border:1px solid #ddd}h2{margin-top:36px}pre{white-space:pre-wrap;background:#f4f6f8;padding:16px}a{color:#1458b0}</style>',
'<h1>原38 · 独立原始质量比较</h1><p>本包未审核、未批准、未应用。先对照原图记录独立判断，再查看诊断。复制 review-template.json 填写审核记录；工时未计量时保留 null。</p>',
'<p>实际请求：'+esc(JSON.stringify(request.output))+'；原始候选的审核修改已通过公开入口生效。模式：'+esc(request.mode||'final')+'。</p>',
'<h2>原图</h2><img alt="原始参考图" src="source'+ext+'">',
'<h2>实际请求的出图</h2>',result.image?'<img alt="实际请求结果" src="actual-request.png">':'<p>本次实际请求没有出图；记录受阻，不能当成通过。</p>',
'<h2>审核预览</h2><p>预览为草稿模式，DPI由公开审核入口独立决定：'+esc(reviewed.view.preview?.dpi??'unknown')+'。它不代表上述实际请求的正式交付。</p>',
reviewed.view.preview?.image?'<img alt="公开审核草稿预览" src="review-preview.png">':'<p>无审核预览。</p>',
'<h2>人工覆盖范围</h2><pre>'+esc(scope)+'</pre>',
'<p><a href="review-template.json">空白独立审核记录</a> · <a href="manifest.json">材料身份</a></p>',
'<details><summary>完成独立判断后展开诊断入口</summary><p><a href="actual-render.json">实际出图布局与问题</a> · <a href="public-review.json">公开审核结果</a></p></details></html>'].join('\n');
await writeFile(join(out,'review.html'),html,{flag:'wx'});
const after=await inventory(round);
if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('原始轮次在打包期间变化，材料不能使用');
await verifyRuntime();
const manifest={generatorSha256:hash(generatorBytes),candidate,preflight:!!values.preflight,format:'original38-review-package/1',scope:'模板/修改成果独立比较；首页不显示模型自评，完整原件与公开诊断另存，未自动核准人审独立性',status:'prepared-not-reviewed',createdAt:new Date().toISOString(),runtime,rendererBuildId:await api.rendererBuildId(),round,sourceRoundFiles:before,originalRoundUnchanged:true,sourceImageSha256:hash(await readFile(source)),outcomeSha256:previous.outcomeSha256,reviewSha256:previous.reviewSha256,contentIdentity:reviewed.view.contentIdentity??null,effectiveFiles,request,actualImage:result.image?{dpi:result.image.dpi,widthPx:result.image.widthPx,heightPx:result.image.heightPx}:null,previewImage:reviewed.view.preview?.image?{dpi:reviewed.view.preview.dpi,widthPx:reviewed.view.preview.widthPx,heightPx:reviewed.view.preview.heightPx}:null,humanReview:null,files:await inventory(out)};
await writeFile(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({out,originalRoundUnchanged:true,effectiveCandidates:effectiveFiles.length,actualImage:manifest.actualImage,previewImage:manifest.previewImage,reviewStatus:blank.status}));

