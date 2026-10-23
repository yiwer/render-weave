/** 票18专用原件归档：按内容去重，保留所有源相对路径；不重写轮次绝对路径或提供恢复执行协议。 */
import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {parseArgs} from 'node:util';

const {values}=parseArgs({options:{pack:{type:'string'},restore:{type:'string'},out:{type:'string'}},strict:true});
if (!values.out || Boolean(values.pack)===Boolean(values.restore)) throw new Error('使用 --pack <输入清单> 或 --restore <归档目录>，及 --out <新目录>');
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const out=resolve(values.out);
type Entry={path:string;sha256:string;bytes:number};
type Root={label:string;originalPath:string;entries:Entry[];directories?:string[]};
const validPath=(path:string)=>path && !path.split('/').some(part=>!part||part==='.'||part==='..'||/[\\:]/.test(part));
if(values.pack){
  const input=JSON.parse(await readFile(resolve(values.pack),'utf8'));
  if(input.format!=='renderweave-context-trial-archive-inputs/1' || !Array.isArray(input.roots) || !input.roots.length)throw new Error('不是票18归档输入清单');
  await mkdir(out);await mkdir(join(out,'blobs'));
  const roots:Root[]=[],seen=new Set<string>();
  for(const source of input.roots){
    if(typeof source.label!=='string'|| !/^[a-zA-Z0-9_-]+$/.test(source.label)||seen.has(source.label)||typeof source.path!=='string')throw new Error('归档源标签无效或重复');
    seen.add(source.label);
    const root:Root={label:source.label,originalPath:resolve(source.path),entries:[],directories:[]};
    if(out===root.originalPath || out.startsWith(root.originalPath+'\\') || out.startsWith(root.originalPath+'/'))throw new Error('归档不能放入来源目录');
    async function visit(relative:string):Promise<void>{
      for(const entry of (await readdir(join(root.originalPath,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){
        const path=relative?relative+'/'+entry.name:entry.name;
        if(entry.isDirectory()){root.directories!.push(path);await visit(path);}
        else if(entry.isFile()){
          const bytes=await readFile(join(root.originalPath,path)),hash=sha(bytes),blob=join(out,'blobs',hash);
          try{await writeFile(blob,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
          root.entries.push({path,sha256:hash,bytes:bytes.length});
        }else throw new Error(`归档源有非普通文件：${root.label}/${path}`);
      }
    }
    await visit('');roots.push(root);
  }
  const manifest=Buffer.from(JSON.stringify({format:'renderweave-context-trial-archive/1',createdAt:new Date().toISOString(),roots,
    limitation:'恢复仅重现原文件字节；记录中的绝对路径不改写，不保证任意位置可以直接接续执行。'},null,2)+'\n');
  await writeFile(join(out,'manifest.json'),manifest,{flag:'wx'});
  await writeFile(join(out,'manifest.sha256'),sha(manifest)+'\n',{flag:'wx'});
  process.stdout.write(JSON.stringify({archive:out,manifestSha256:sha(manifest),files:roots.reduce((n,root)=>n+root.entries.length,0)})+'\n');
}else{
  const archive=resolve(values.restore!),bytes=await readFile(join(archive,'manifest.json'));
  if((await readFile(join(archive,'manifest.sha256'),'utf8')).trim()!==sha(bytes))throw new Error('归档清单摘要不符');
  const manifest=JSON.parse(bytes.toString('utf8'));
  if(manifest.format!=='renderweave-context-trial-archive/1' || !Array.isArray(manifest.roots))throw new Error('不是票18原件归档');
  await mkdir(out);let count=0;
  for(const root of manifest.roots as Root[]){
    if(!/^[a-zA-Z0-9_-]+$/.test(root.label))throw new Error('归档源标签无效');
    await mkdir(join(out,root.label));
    for(const path of root.directories??[]){
      if(!validPath(path))throw new Error('归档目录路径无效');
      await mkdir(join(out,root.label,path),{recursive:true});
    }
    for(const entry of root.entries){
      if(!validPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256))throw new Error('归档文件路径或摘要无效');
      const data=await readFile(join(archive,'blobs',entry.sha256));
      if(data.length!==entry.bytes || sha(data)!==entry.sha256)throw new Error(`原件摘要不符：${root.label}/${entry.path}`);
      const file=join(out,root.label,entry.path);await mkdir(dirname(file),{recursive:true});await writeFile(file,data,{flag:'wx'});
      if(sha(await readFile(file))!==entry.sha256)throw new Error(`恢复摘要不符：${root.label}/${entry.path}`);
      count++;
    }
  }
  process.stdout.write(JSON.stringify({restored:out,manifestSha256:sha(bytes),filesVerified:count,sourceRoots:manifest.roots.length})+'\n');
}
