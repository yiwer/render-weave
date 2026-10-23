/** 资料策略从公开 Agent CLI 观察：只使用合成校准说明与假执行器。 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { repoRoot, resourcesDir } from './support/fixtures.js';
import { startMcp } from './support/mcp-client.js';

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
  const fullRecord = JSON.parse(await readFile(join(full.out, 'round.json'), 'utf8'));
  const candidateRecord = JSON.parse(await readFile(join(candidate.out, 'round.json'), 'utf8'));
  expect(fullRecord.runtime.effort).toBeNull(); expect(candidateRecord.runtime.effort).toBeNull();
  expect(fullRecord.inputs.contextPolicy.name).toBe('full');
  expect(candidateRecord.inputs.contextPolicy).toMatchObject({name:'on-demand',id:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(candidateRecord.inputs.contextPolicy.id).not.toBe(fullRecord.inputs.contextPolicy.id);
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
  const bad=join(base,'bad-catalog.json');await writeFile(bad,JSON.stringify(catalog));
  const invalid=await run('unreachable',bad);
  expect(invalid.report.candidateReady).toBe(false);
  expect(invalid.report.unresolved).toEqual(expect.arrayContaining([expect.objectContaining({owner:'agent-harness-hardening/17',target:'reference/nonexistent'})]));
});
it('票14双语四任务可冻结两份同条件配对计划，并从真实CLI按需读取参考及原检查反馈后纠偏', async () => {
  const execute=async(args:string[])=>promisify(execFile)(process.execPath,args,{cwd:repoRoot,env:{...process.env,RW_CONTEXT_KEY:'offline-context-test'},windowsHide:true,maxBuffer:1024*1024});
  const prepared=join(base,'calibration');
  await execute(['--import','tsx','scripts/agent-eval/prepare-feedback.ts','--out',prepared,'--resources',resourcesDir]);
  const config=join(prepared,'config.json'), pair=join(base,'pair');
  await execute(['--import','tsx','scripts/agent-eval/context.ts','--prepare-pair',pair,'--config',config,'--model','claude-haiku-5-5','--jobs','1','--claude',process.execPath,
    '--claude-args',JSON.stringify([join(repoRoot,'test/support/fake-feedback-claude.mjs'),'calibration'])]);
  const plan=JSON.parse(await readFile(join(pair,'pair.json'),'utf8'));
  expect(plan).toMatchObject({ready:true,realModelObservations:0,defaultChanged:false});
  expect(plan.arms.map((arm:any)=>arm.policy)).toEqual(['full','on-demand']);
  expect(plan.arms[0].identity.inputs).toEqual(plan.arms[1].identity.inputs);
  expect(plan.arms[0].identity.runtime).toEqual(plan.arms[1].identity.runtime);
  expect(plan.arms[0].identity.budgets).toEqual(plan.arms[1].identity.budgets);
  expect(plan.arms[0].identity.plan).toEqual(plan.arms[1].identity.plan);
  expect(plan.arms[0].identity.contextPolicy.id).not.toBe(plan.arms[1].identity.contextPolicy.id);
  const changed=await execute(['--import','tsx','scripts/agent-eval/run.ts',...plan.arms[0].arguments,'--context-pair',join(pair,'pair.json'),'--model','different-model',
    '--out',join(base,'changed-pair'),'--reports',join(base,'changed-reports'),'--key-env','RW_CONTEXT_KEY']).catch(error=>error);
  expect(changed.stderr).toContain('配对冻结条件变化');
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
    const record=JSON.parse(await readFile(join(out,'round.json'),'utf8'));
    expect(record.inputs.contextPolicy.name).toBe('on-demand');
  }
},180000);
