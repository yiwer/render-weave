/** 资料策略从公开 Agent CLI 观察：只使用合成校准说明与假执行器。 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';
import {runCli} from '../src/cli.js';
import {PassThrough} from 'node:stream';

let base: string;
beforeAll(async () => { base = await mkdtemp(join(tmpdir(), 'rw-context-')); await writeFile(join(base, 'brief.md'), '合成校准：提取线路号；不用于留出评分。'); });
afterAll(async () => { await rm(base, {recursive:true,force:true,maxRetries:10,retryDelay:100}); });
async function launch(name: string, policy?: string) {
  const out = join(base, name);
  const args = [join(repoRoot, 'dist/bin.js'), 'agent', 'run', '--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png'),
    '--brief', join(base, 'brief.md'), '--resources', resourcesDir, '--out', out, '--key-env', 'RW_CONTEXT_KEY', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-claude.mjs'), 'none']), ...(policy ? ['--context-policy', policy] : [])];
  const result = await promisify(execFile)(process.execPath, args, {cwd:repoRoot,env:{...process.env,RW_CONTEXT_KEY:'offline-context-test'},windowsHide:true}).catch(error => ({stdout:error.stdout,stderr:error.stderr,code:error.code}));
  return {out, ...result};
}
it('显式按需策略保留入口强制约束和成果格式，默认全量策略及effort保持原样', async () => {
  const full = await launch('full');
  const candidate = await launch('on-demand', 'on-demand');
  expect(candidate.stderr).not.toContain('未知选项');
  const fullFiles = await readdir(join(full.out, 'agent/docs'));
  const candidateFiles = await readdir(join(candidate.out, 'agent/docs'));
  expect(fullFiles).toContain('dsl-reference.md');
  expect(candidateFiles).not.toContain('dsl-reference.md');
  expect(candidateFiles).toEqual(expect.arrayContaining(['context-catalog.json', 'constraints.md', 'outcome.md', 'guide.md', 'brief.md']));
  const constraints = await readFile(join(candidate.out, 'agent/docs/constraints.md'), 'utf8');
  expect(constraints).toContain('变量名用英文');
  expect(constraints).toContain('毫米');
  expect(constraints).toContain('作用域');
  const guide = await readFile(join(candidate.out, 'agent/docs/guide.md'), 'utf8');
  expect(guide).toContain('素材的信任边界');
  expect(guide).toContain('文字能力的边界');
  const fullRecord = JSON.parse(await readFile(join(full.out, 'round.json'), 'utf8'));
  const candidateRecord = JSON.parse(await readFile(join(candidate.out, 'round.json'), 'utf8'));
  expect(fullRecord.runtime.effort).toBeNull(); expect(candidateRecord.runtime.effort).toBeNull();
  expect(fullRecord.inputs.contextPolicy.name).toBe('full');
  expect(candidateRecord.inputs.contextPolicy).toMatchObject({name:'on-demand',id:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(candidateRecord.inputs.contextPolicy.id).not.toBe(fullRecord.inputs.contextPolicy.id);
  const bundle=JSON.parse(await readFile(join(candidate.out,'logs/reference-materials.json'),'utf8'));
  expect(bundle.texts['reference/data-definition']).toBe(await readFile(join(repoRoot,'agent/reference/data-definition.md'),'utf8'));
  expect(Object.keys(candidateRecord.inputs.contextPolicy.available)).toContain('schema/template');
  const prompt = await readFile(join(candidate.out, 'logs/prompt.md'), 'utf8');
  expect(prompt).toContain('context-catalog.json');
  expect(prompt).not.toContain('dsl-reference.md');
  expect(await readFile(join(candidate.out, 'agent/docs/outcome.md'), 'utf8')).toBe(await readFile(join(full.out, 'agent/docs/outcome.md'), 'utf8'));
});
it('真实MCP的问题续页固定同一检查身份，后续缺项与未知可取回且修改文件不偷换已检查结果', async () => {
  const dir=join(base,'pages');await mkdir(join(dir,'workspace'),{recursive:true});await mkdir(join(dir,'candidates'));
  await writeFile(join(dir,'candidates/schema.json'),JSON.stringify({dslVersion:'renderweave-schema/1',name:'校准',fields:[]}));
  await writeFile(join(dir,'outcome.json'),JSON.stringify({candidates:['candidates/schema.json'],pending:[],notes:'明确合成校准'}));
  const target=join(dir,'target.json');await writeFile(target,JSON.stringify({task:'definition-extraction',contentBaseline:{name:'校准',items:[
    ...Array.from({length:240},(_,i)=>({id:`field-${i}`,label:`字段${i}`,definition:'校准',field:`field${i}`})),{id:'unknown-last',label:'未核准范围'}]}}));
  const mcp=startMcp(['--workspace',join(dir,'workspace'),'--resources',resourcesDir,'--root',dir,'--outcome-context',target]);
  try{
    const checked=await mcp.callJson('check_outcome');
    expect(checked.feedback).toMatchObject({tool:'outcome_feedback',reportId:expect.any(String),total:expect.any(Number)});
    await writeFile(join(dir,'candidates/schema.json'),'{');
    const rows:any[]=[];let offset=0;
    do{
      const page=await mcp.callJson('outcome_feedback',{reportId:checked.feedback.reportId,offset,limit:31,groupBy:'code'});
      expect(page.contentIdentity).toBe(checked.contentIdentity.id);
      expect(page.currentBytesChecked).toBe(false);
      expect(page.unknownTotal).toBeGreaterThan(0);
      rows.push(...page.groups.flatMap((group:any)=>group.items));offset=page.nextOffset;
      expect(JSON.stringify(page).length).toBeLessThan(40000);
    }while(offset!==null);
    expect(rows.some(row=>row.detail.item==='field-239')).toBe(true);
    expect(rows.some(row=>row.code==='coverage.unknown'&&row.detail.id==='unknown-last')).toBe(true);
    expect(rows.find(row=>row.detail.item==='field-239').detail.path).toBe('校准.field239');
    await expect(mcp.callJson('outcome_feedback',{reportId:'wrong'})).rejects.toThrow('检查报告');
    await mcp.callJson('check_outcome');
    await expect(mcp.callJson('outcome_feedback',{reportId:checked.feedback.reportId})).rejects.toThrow('检查报告');
  }finally{await mcp.close();}
});
it('大量视觉必修问题不会挡住续取入口，超长未知说明按分片完整恢复', async () => {
  const dir=join(base,'large-feedback');await mkdir(join(dir,'candidates'),{recursive:true});
  await writeFile(join(dir,'candidates/template.json'),JSON.stringify({dslVersion:'renderweave-template/1',name:'校准模板',base:{name:'问候',version:1},artboard:{sizeRange:{width:{min:100,max:100},height:{min:40,max:40}},layout:{mode:'free'},children:[]}}));
  const note='这是一段需要完整保留的未知说明\n"待核对"'.repeat(5000);
  await writeFile(join(dir,'outcome.json'),JSON.stringify({candidates:['candidates/template.json'],pending:[{file:'candidates/template.json',reason:'unreadable',note}],notes:'合成大报告'}));
  const target=join(dir,'target.json');await writeFile(target,JSON.stringify({task:'template-design',request:{template:'校准模板',dataset:{id:'ds-greeting'},parameters:{},output:{width:100,height:40,dpi:20,format:'png'},mode:'final'},
    baseline:{sampleWidthPx:100,sampleHeightPx:40,artboardWidthMm:100,artboardHeightMm:40,approvedRegions:Array.from({length:700},(_,i)=>({id:`r-${i}`,name:`核准区域${i}`,sampleRegion:{x:0,y:0,width:1,height:1},targetPathPattern:`校准模板/缺失${i}`,expectedFontSizeMm:7}))}}));
  const mcp=startMcp(['--workspace',singleTextDir,'--resources',resourcesDir,'--root',dir,'--outcome-context',target]);
  try{
    const result=await mcp.callJson('check_outcome');
    expect(result.feedback.total).toBeGreaterThan(700);
    const fragments:any[]=[];let offset=0;let lastMissing=false;
    do{const page=await mcp.callJson('outcome_feedback',{reportId:result.feedback.reportId,offset,limit:100});
      for(const item of page.groups.flatMap((group:any)=>group.items)){if(item.code==='pending')fragments.push(item.detail);if(item.detail.regionId==='r-699')lastMissing=true;}
      offset=page.nextOffset;
    }while(offset!==null);
    expect(lastMissing).toBe(true);
    const restored=JSON.parse(fragments.sort((a,b)=>a.index-b.index).map(value=>value.fragment).join(''));
    expect(restored.detail.note).toBe(note);
  }finally{await mcp.close();}
});
it('公开资料检查逐项验证参考、合同和共享样例，原20断链仍未解决；新增坏指针拒绝候选', async () => {
  const run = async (name:string, catalog?:string) => {
    const report=join(base,`${name}.json`);
    const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/context.ts','--check',report,...(catalog?['--catalog',catalog]:[])],{cwd:repoRoot,windowsHide:true})
      .catch(error=>({stdout:error.stdout,stderr:error.stderr,code:error.code}));
    return {result,report:JSON.parse(await readFile(report,'utf8'))};
  };
  const valid=await run('reachable');
  expect(valid.report.candidateReady).toBe(true);
  expect(valid.report.status).toBe('known-unresolved');
  expect(valid.report.unresolved).toEqual([expect.objectContaining({owner:'agent-template-authoring/20',status:'unresolved'})]);
  expect(valid.report.passed).toEqual(expect.arrayContaining([expect.objectContaining({target:'reference/data-definition'}),expect.objectContaining({kind:'shared-example'}),expect.objectContaining({kind:'tool-contract'})]));
  const catalog=JSON.parse(await readFile(join(repoRoot,'agent/context-catalog.json'),'utf8'));
  catalog.stages.push({id:'broken',name:'reference/nonexistent',when:'新增坏指针'});
  catalog.stages.push({id:'bad-pointer',name:'schema/template',pointer:'/nonexistent',when:'无效JSON指针'});
  catalog.stages.push({id:'bad-heading',name:'reference/template',heading:'不存在的章节',when:'丢失章节'});
  const bad=join(base,'bad-catalog.json');await writeFile(bad,JSON.stringify(catalog));
  const invalid=await run('unreachable',bad);
  expect(invalid.report.candidateReady).toBe(false);
  expect(invalid.report.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({owner:'agent-harness-hardening/17',target:'reference/nonexistent'})]));
  expect(invalid.report.unresolved.filter((value:any)=>value.owner==='agent-harness-hardening/17')).toHaveLength(3);
});
it('合法超长视觉区域名称不能挤掉首次检查的分页入口，原始异常名称仍可完整续取', async () => {
  const dir=join(base,'long-regions');await mkdir(join(dir,'candidates'),{recursive:true});
  await writeFile(join(dir,'candidates/template.json'),JSON.stringify({dslVersion:'renderweave-template/1',name:'校准模板',base:{name:'问候',version:1},artboard:{sizeRange:{width:{min:100,max:100},height:{min:40,max:40}},layout:{mode:'free'},children:[]}}));
  await writeFile(join(dir,'outcome.json'),JSON.stringify({candidates:['candidates/template.json'],pending:[],notes:'合法长区域校准'}));
  const longName='这是合法的核准区域名称'.repeat(300),target=join(dir,'target.json');
  await writeFile(target,JSON.stringify({task:'template-design',request:{template:'校准模板',dataset:{id:'ds-greeting'},parameters:{},output:{width:100,height:40,dpi:20,format:'png'},mode:'final'},
    baseline:{sampleWidthPx:100,sampleHeightPx:40,artboardWidthMm:100,artboardHeightMm:40,approvedRegions:Array.from({length:20},(_,i)=>({id:`long-${i}`,name:longName+i,sampleRegion:{x:0,y:0,width:1,height:1},targetPathPattern:`校准模板/缺失${i}`,expectedFontSizeMm:7}))}}));
  const mcp=startMcp(['--workspace',singleTextDir,'--resources',resourcesDir,'--root',dir,'--outcome-context',target]);
  try{
    const checked=await mcp.callJson('check_outcome');
    expect(JSON.stringify(checked).length).toBeLessThan(40000);
    expect(checked.feedback.reportId).toEqual(expect.any(String));
    expect(checked.assessment.style.passed).toBe(false);
    expect(checked.detailsTruncated).toBe(true);
    const items:any[]=[];let offset=0;
    do{const page=await mcp.callJson('outcome_feedback',{reportId:checked.feedback.reportId,offset});items.push(...page.groups.flatMap((group:any)=>group.items));offset=page.nextOffset;}while(offset!==null);
    const fragments=new Map<number,any[]>();
    for(const item of items)if(item.detail.encoding==='json'){const list=fragments.get(item.detail.itemId)??[];list.push(item.detail);fragments.set(item.detail.itemId,list);}
    const restored=[...items.filter(item=>item.detail.encoding!=='json'),...[...fragments.values()].map(values=>JSON.parse(values.sort((a,b)=>a.index-b.index).map(value=>value.fragment).join('')))];
    expect(restored.some(item=>item.detail.name===longName+'19')).toBe(true);
    expect(restored.some(item=>item.code==='style.missingRegion'&&item.detail.message.includes(longName+'19'))).toBe(true);
  }finally{await mcp.close();}
});
it('未知策略被明确拒绝，配对材料缺失输出未完成计划且不伪造冻结身份', async () => {
  const invalid=await launch('invalid-policy','made-up');expect(invalid.stderr).toContain('--context-policy 只能取 full 或 on-demand');
  const dir=join(base,'missing-inputs');await mkdir(dir);
  await writeFile(join(dir,'preparation.json'),JSON.stringify({format:'renderweave-feedback-preparation/1',source:'predeclared-synthetic-facts'}));
  await writeFile(join(dir,'config.json'),JSON.stringify({format:'renderweave-agent-eval-config/2',consecutivePasses:2,resources:resourcesDir,evidence:'mechanism',scenarios:[{
    id:'missing',name:'缺资料校准',kind:'feedback',language:'zh',task:'definition-extraction',sample:join(dir,'missing.png'),brief:join(dir,'missing.md'),seedRound:join(dir,'missing-seed'),feedback:join(dir,'feedback.md'),policy:join(dir,'policy.json'),pass:{targetCorrection:true,nonTargetPreservation:true,unknownRetained:true}}]}));
  const out=join(base,'missing-pair');
  const result=await promisify(execFile)(process.execPath,['--import','tsx','scripts/agent-eval/context.ts','--prepare-pair',out,'--config',join(dir,'config.json')],{cwd:repoRoot,windowsHide:true}).catch(error=>error);
  expect(result.code).toBe(3);
  const plan=JSON.parse(await readFile(join(out,'pair.json'),'utf8'));
  expect(plan.ready).toBe(false);expect(plan.arms).toEqual([]);expect(plan.units[0].missing).toContain('sample');
});
it('公开参考服务固定启动字节，之后修改资料文件不能替换该会话参考；不完整固定资料拒绝启动', async () => {
  const round=await launch('pinned-references','on-demand'),bundle=join(round.out,'logs/reference-materials.json');
  const mcp=startMcp(['--workspace',join(round.out,'snapshot'),'--resources',resourcesDir,'--root',join(round.out,'agent'),'--reference-bundle',bundle]);
  try{
    const before=await mcp.call('dsl_reference',{name:'reference/template'});
    const data=JSON.parse(await readFile(bundle,'utf8'));data.texts['reference/template']='替换参考的低可信文字';await writeFile(bundle,JSON.stringify(data));
    expect(await mcp.call('dsl_reference',{name:'reference/template'})).toEqual(before);
  }finally{await mcp.close();}
  await writeFile(bundle,JSON.stringify({format:'renderweave-reference-materials/1',texts:{}}));
  let errors='';const code=await runCli(['mcp','--workspace',join(round.out,'snapshot'),'--resources',resourcesDir,'--root',join(round.out,'agent'),'--reference-bundle',bundle],{stdin:new PassThrough(),stdout:()=>{},stderr:value=>{errors+=value;}});
  expect(code).not.toBe(0);expect(errors).toContain('固定 DSL 参考资料不完整');
});
it('票14双语四任务可冻结两份同条件配对计划，并从真实CLI按需读取参考及原检查反馈后纠偏', async () => {
  const execute=async(args:string[])=>promisify(execFile)(process.execPath,args,{cwd:repoRoot,env:{...process.env,RW_CONTEXT_KEY:'offline-context-test'},windowsHide:true,maxBuffer:1024*1024});
  const prepared=join(base,'calibration');
  await execute(['--import','tsx','scripts/agent-eval/prepare-feedback.ts','--out',prepared,'--resources',resourcesDir]);
  const config=join(prepared,'config.json'), pair=join(base,'pair');
  await execute(['--import','tsx','scripts/agent-eval/context.ts','--prepare-pair',pair,'--config',config,'--model','claude-haiku-5-5','--jobs','1','--timeout-ms','120000','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-feedback-claude.mjs'),'calibration'])]);
  const plan=JSON.parse(await readFile(join(pair,'pair.json'),'utf8'));
  expect(plan).toMatchObject({ready:true,realModelObservations:0,defaultChanged:false});
  expect(plan.arms.map((arm:any)=>arm.policy)).toEqual(['full','on-demand']);
  expect(plan.arms[0].identity.inputs).toEqual(plan.arms[1].identity.inputs);
  expect(plan.arms[0].identity.runtime).toEqual(plan.arms[1].identity.runtime);
  expect(plan.arms[0].identity.budgets).toEqual(plan.arms[1].identity.budgets);
  expect(plan.arms[0].identity.budgets.roundTimeoutMs).toBe(120000);
  expect(plan.arms[0].identity.plan).toEqual(plan.arms[1].identity.plan);
  expect(plan.arms[0].identity.contextPolicy.id).not.toBe(plan.arms[1].identity.contextPolicy.id);
  const changed=await execute(['--import','tsx','scripts/agent-eval/run.ts',...plan.arms[0].arguments,'--context-pair',join(pair,'pair.json'),'--model','different-model',
    '--out',join(base,'changed-pair'),'--reports',join(base,'changed-reports'),'--key-env','RW_CONTEXT_KEY']).catch(error=>error);
  expect(changed.stderr).toContain('配对冻结条件变化');
  const evaluated = join(base,'evaluated-policy'), reports = join(base,'evaluated-reports');
  const dispatched=await execute(['--import','tsx','scripts/agent-eval/run.ts',...plan.arms[1].arguments,'--context-pair',join(pair,'pair.json'),
    '--repetitions','1-1','--out',evaluated,'--reports',reports,'--label','context-candidate','--key-env','RW_CONTEXT_KEY']).catch(error=>error);
  expect(dispatched.code).toBe(3);
  const report=JSON.parse(await readFile(join(reports,(await readdir(reports)).find(name=>name.endsWith('.json'))!),'utf8'));
  expect(report.experimentIdentity.contextPolicy.name).toBe('on-demand');
  expect(report.attempts).toHaveLength(8);
  for(const attempt of report.attempts){
    const round=JSON.parse(await readFile(join(evaluated,attempt.dir,'round/round.json'),'utf8'));
    expect(round.inputs.contextPolicy.name).toBe('on-demand');
  }
  const preparedConfig=JSON.parse(await readFile(config,'utf8'));
  for(const scenario of preparedConfig.scenarios){
    const out=join(base,`strategy-${scenario.id}`);
    await execute([join(repoRoot,'dist/bin.js'),'agent','run','--from',scenario.seedRound,'--feedback',scenario.feedback,'--out',out,'--context-policy','on-demand',
      '--key-env','RW_CONTEXT_KEY','--claude',process.execPath,'--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-feedback-claude.mjs'),'calibration','--context-probe'])]);
    const observed=JSON.parse(await readFile(join(out,'agent/context-observation.json'),'utf8'));
    expect(observed.references).toContain('reference/data-definition');
    expect(observed.references).toContain('reference/template');
    expect(observed.pages).toBeGreaterThan(0);
    expect(observed.unknownTotal).toBeGreaterThan(0);
    if(scenario.task.startsWith('template')) expect(observed.instances).toEqual(expect.arrayContaining([expect.objectContaining({path:expect.any(String),sourceLocation:expect.objectContaining({template:expect.any(String),path:expect.any(String)})})]));
    const record=JSON.parse(await readFile(join(out,'round.json'),'utf8'));
    expect(record.inputs.contextPolicy.name).toBe('on-demand');
  }
},180000);
