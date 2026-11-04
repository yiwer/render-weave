import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { importExcelRound, readReview, changeReview, startReviewServer, publishStaticSchema } from '../src/index.js';
import { runCli } from '../src/cli.js';
let root: string, sequence = 0;
const note = ' 制作\n甲 & <script>test</script> ';
const load = async (p: string) => JSON.parse(await readFile(p, 'utf8'));
const save = (p: string, value: unknown) => writeFile(p, JSON.stringify(value));
const python = (args: string[]) => execFileSync('python', ['-X','utf8',...args], { windowsHide: true, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
beforeAll(async () => { root = await mkdtemp(join(tmpdir(),'rw-comments-')); });
afterAll(async () => { await rm(root,{recursive:true,force:true}); });
async function fixture(variant='good') {
  const dir=join(root,String(++sequence)), from=join(dir,'from'), workspace=join(dir,'workspace'), round=join(dir,'round');
  for(const p of [join(from,'inputs'),join(from,'attempt-01'),workspace]) await mkdir(p,{recursive:true});
  const file=join(from,'inputs/source.xlsx'); python(['test/support/excel-comments.py',file,variant]);
  const sourceHash=createHash('sha256').update(await readFile(file)).digest('hex');
  const publishedResult=publishStaticSchema({dslVersion:'renderweave-schema/1',name:'comment-test',fields:[
    {name:'label',displayName:'名称',type:'text',constraints:{required:true}}, {name:'note',displayName:'批注',type:'text'}, {name:'emptyNote',displayName:'空批注',type:'text'}
  ]},[]);
  expect(publishedResult.problems).toEqual([]); const published=publishedResult.published!;
  await save(join(workspace,'schema.json'),published.definition); await save(join(workspace,'compiled.schema.json'),published.compiled);
  await save(join(from,'inputs/target.json'),{selected:published,staticSchemas:[published],datasetIds:[]});
  await writeFile(join(from,'inputs/brief.md'),'按目标定义读取正文和批注，保留全部批注来源。');
  await save(join(from,'start.json'),{model:'test',endpoint:'test'}); await save(join(from,'result.json'),{passed:true,attempts:[],usage:{}});
  await save(join(from,'submission.json'),{attemptId:'attempt-01',notes:'合成测试',pending:[]});
  const plan={format:'rw-excel-plan/2',sourceHash,definition:published.ref,datasets:[{id:'item',value:{op:'object',fields:{
    label:{op:'cell',sheet:'sheet-1',cell:'A1'}, note:{op:'comment',sheet:'sheet-1',cell:'B2'},emptyNote:{op:'comment',sheet:'sheet-1',cell:'C3'}
  }}}],context:[],commentContext:[]};
  const candidate={datasets:[{dataset:{id:'item',staticSchema:published.ref},data:{label:'甲',note,emptyNote:''}}],sources:[
    {datasetId:'item',path:'/label',sheet:'sheet-1',cells:['A1'],rule:'cell'},
    ...[['/note','B2'],['/emptyNote','C3']].map(([path,cell])=>({datasetId:'item',path,sheet:'sheet-1',cells:[cell],rule:'comment',parts:['xl/comments1.xml']}))
  ]};
  await save(join(from,'attempt-01/plan.json'),plan);await save(join(from,'attempt-01/candidate.json'),candidate);
  await writeFile(join(from,'attempt-01/transform.py'),'raise RuntimeError("import must not execute me")');
  return {dir,from,workspace,round,out:round,plan,candidate,file};
}
it('正式读取 CLI 分页保留空单元格批注、富文本及 VML 零基锚点，导入与审核来源一致',async()=>{
  const f=await fixture(); const view=join(f.dir,'view.json'), region=join(f.dir,'region.json');
  python(['agent/excel/workbook.py','read','--input',f.file,'--out',view]);
  python(['agent/excel/workbook.py','region','--input',view,'--sheet','sheet-1','--range','B2:C3','--page-size','1','--out',region]);
  expect((await load(region)).comments).toMatchObject([{cell:'B2',text:note,vml:{row:1,column:1,anchor:[0,0,0,0,4,0,4,0]}}]);
  await importExcelRound(f);const review=(await readReview(f.round)).view!;
  expect(review.canApprove).toBe(false);expect(review.excel!.comments).toMatchObject([{cell:'B2',text:note,author:'测试作者',part:'xl/comments1.xml'},{cell:'C3',text:''}]);
  const server=await startReviewServer({roundDir:f.round});
  try {
    const response=await fetch(new URL('/api/review',server.url));expect(response.status).toBe(200);
    expect((await response.json() as any).view.excel.comments[0].text).toBe(note);
    const html=await(await fetch(server.url)).text();expect(html).toContain('批注原文与来源');expect(html).toContain('零基行列');
    for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new Script(match[1]!);
  } finally {await server.close();}
});
it.each(['wrong-anchor','duplicate-anchor','missing-anchor','foreign-shape','control','image','dtd','malformed','external-rel','traversal-rel','duplicate-comment','unknown-part','orphan'])('原件 %s 不可通过正式导入',async variant=>{
  const f=await fixture(variant);await expect(importExcelRound(f)).rejects.toThrow('独立工作簿检查失败');
  expect((await readReview(f.round)).view).toBeUndefined();
});
it('有批注但无 VML 时保留原文并明确没有显示框',async()=>{
  const f=await fixture('no-vml');await importExcelRound(f);
  expect((await readReview(f.round)).view!.excel!.comments![0]).not.toHaveProperty('vml');
});
it('VML Visible=false 不被误当成可见批注',async()=>{
  const f=await fixture('hidden-flag');await importExcelRound(f);
  expect((await readReview(f.round)).view!.excel!.comments!.map(c=>c.vml!.visible)).toEqual([false,false]);
});
it.each(['value','cell','part'])('伪造批注 %s 被独立来源检查拒绝',async kind=>{
  const f=await fixture();
  if(kind==='value')f.candidate.datasets[0]!.data.note='伪造';
  if(kind==='cell')f.candidate.sources[1]!.cells=['C3'];
  if(kind==='part')(f.candidate.sources[1] as any).parts=['xl/comments2.xml'];
  await save(join(f.from,'attempt-01/candidate.json'),f.candidate);
  await expect(importExcelRound(f)).rejects.toThrow('独立工作簿检查失败');
});
it('包内原件批注被改，即使同时改 sourceHash，也不能沿用旧候选',async()=>{
  const f=await fixture('changed-comment');await expect(importExcelRound(f)).rejects.toThrow('valueMismatch');
});
it('正文排除范围不能覆盖批注，明确未映射理由才可进入待审',async()=>{
  const f=await fixture();delete (f.plan.datasets[0]!.value.fields as any).note;delete (f.candidate.datasets[0]!.data as any).note;
  f.candidate.sources.splice(1,1);(f.plan.context as any[]).push({sheet:'sheet-1',range:'B2',reason:'空白正文'});
  await save(join(f.from,'attempt-01/plan.json'),f.plan);await save(join(f.from,'attempt-01/candidate.json'),f.candidate);
  await expect(importExcelRound(f)).rejects.toThrow('unclassifiedComment');
  (f.plan.commentContext as any[]).push({sheet:'sheet-1',cell:'B2',reason:'本次定义不映射的制作说明，待人工核对'});
  await save(join(f.from,'attempt-01/plan.json'),f.plan);
  const round=join(f.dir,'next');await importExcelRound({...f,out:round});
  expect((await readReview(round)).view!.excel!.commentContext).toHaveLength(1);
  expect((await readReview(round)).view!.canApprove).toBe(false);
});
it('批注原文修改按同一来源重放，既有证据篡改后不可审核',async()=>{
  const f=await fixture();await importExcelRound(f);const review=(await readReview(f.round)).view!;
  const value=structuredClone(review.candidates[0]!.document) as any;value.data.note='人工核对后的说明';
  await changeReview(f.round,{type:'decide',item:1,action:'edit',value,note:'修正制作说明'});
  const next=join(f.dir,'next');const result=await importExcelRound({...f,out:next,previous:f.round});
  expect(result.corrections).toMatchObject([{path:'/note',status:'replayed',reason:'修正制作说明'}]);
  await cp(join(f.from,'inputs/source.xlsx'),join(next,'excel/source.xlsx'));
  await writeFile(join(next,'excel/view.json'),'{}');expect((await readReview(next)).view).toBeUndefined();
});
it('未完成提取包返回失败原因，不先报 submission.json 缺失',async()=>{
  const f=await fixture();await save(join(f.from,'result.json'),{passed:false,attempts:[{mechanical:{issues:[{code:'unreadWorkbookParts'}]}}]});
  await rm(join(f.from,'submission.json'));let error='';
  const exit=await runCli(['agent','import-excel','--from',f.from,'--workspace',f.workspace,'--out',f.round],{stdout:()=>{},stderr:s=>error+=s});
  expect(exit).not.toBe(0);expect(error).toContain('提取包尚未完成');expect(error).toContain('unreadWorkbookParts');expect(error).not.toContain('ENOENT');
});
