/** 从公开 CLI 与真实 MCP 观察修复周期，不访问私有计数器。 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { readReview, readPreviousRound, runAgentTask, loadWorkspace, render, changeReview, applyAgentRound } from '../src/index.js';
import { repoRoot, resourcesDir, singleTextDir } from './support/fixtures.js';
let root: string;
beforeAll(async () => { root = await mkdtemp(join(tmpdir(), 'rw-stagnation-')); });
afterAll(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
async function run(name: string, actions: unknown[], extra: string[] = [], baseline: boolean | readonly string[] = true, taskArgs?: string[]) {
  const dir = join(root, name), preset = join(dir, 'preset'), out = join(dir, 'round');
  await mkdir(join(preset, 'candidates'), { recursive: true });
  await writeFile(join(dir, 'brief.md'), '从图中提取线路字段');
  await writeFile(join(dir, 'facts.json'), JSON.stringify({ name: '核准字段', items: (Array.isArray(baseline) ? baseline : ['number', 'title', 'station']).map(field => ({ id: field, label: field, definition: '线路', field })) }));
  await writeFile(join(preset, 'actions.json'), JSON.stringify(actions));
  await writeFile(join(preset, 'outcome.json'), JSON.stringify({ candidates: ['candidates/schema.json'], pending: [], notes: '提取线路字段' }));
  const child = spawn(process.execPath, [join(repoRoot, 'dist/bin.js'), 'agent', 'run', ...(taskArgs ?? ['--task', 'definition-extraction', '--sample', join(resourcesDir, 'images/test/quadrants.png')]),
    ...(taskArgs?.includes('--from') ? [] : ['--brief', join(dir, 'brief.md'), '--resources', resourcesDir]), ...(baseline ? ['--content-baseline', join(dir, 'facts.json')] : []), '--out', out,
    '--key-env', 'RW_STAGNATION_KEY', '--timeout-ms', '8000', '--claude', process.execPath,
    '--claude-args', JSON.stringify([join(repoRoot, 'test/support/fake-stagnation.mjs'), preset]), ...extra],
  { cwd: repoRoot, env: { ...process.env, RW_STAGNATION_KEY: 'offline' }, windowsHide: true, stdio: 'pipe' });
  let stdout = '', stderr = ''; child.stdout!.on('data', bytes => stdout += bytes); child.stderr!.on('data', bytes => stderr += bytes);
  const [code] = await once(child, 'close');
  return { out, code, result: stdout ? JSON.parse(stdout) : undefined, stderr };
}
it('核准必修问题在两次完整写入和复测后仍相同，停止并保留可接续检查点', async () => {
  const job = await run('same-candidate', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
  ]);
  expect(job.code, job.stderr).toBe(1);
  expect(job.result?.stopped).toMatchObject({ reason: 'stagnation', threshold: 2 });
  const review = await readReview(job.out);
  expect(review.execution?.status).toBe('stopped');
  expect(review.view?.round.source).toBe('hostRecovery');
  expect(review.checkpoint?.check.coverageVerification?.missingItems).toEqual(['title', 'station']);
  expect((await readPreviousRound(job.out)).checkpoint?.id).toBe(review.checkpoint?.id);
  expect(JSON.parse(await readFile(join(job.out, 'round.json'), 'utf8')).verdict).toBe('unqualified');
  expect((await changeReview(job.out, {type:'approve'})).problems.length).toBeGreaterThan(0);
  expect((await applyAgentRound({roundDir:job.out, workspace:join(root,'never-applied')})).applied).toBeUndefined();
  const original = await readFile(join(job.out,'round.json'),'utf8'), state = await readFile(join(job.out,'execution.json'),'utf8');
  const feedback = join(root,'feedback.md');
  await writeFile(feedback,'补齐 title 与 station');
  const resumed = await run('resumed',[{kind:'check'},{kind:'write',fields:['number','title','station']},{kind:'checkAndFinish'}], [], false, ['--from',job.out,'--feedback',feedback]);
  expect(resumed.result?.stopped).toBeUndefined(); expect(resumed.result?.verdict, resumed.stderr).toBe('qualified');
  expect(await readFile(join(job.out,'round.json'),'utf8')).toBe(original);
  expect(await readFile(join(job.out,'execution.json'),'utf8')).toBe(state);
});
const template = (size: number) => ({dslVersion:'renderweave-template/1',name:'对照',base:{name:'问候',version:1},
  artboard:{sizeRange:{width:{min:10,max:200},height:{min:10,max:200}},layout:{mode:'free'},children:[
    {type:'text',name:'站名',content:[{text:'科技园'}],font:'res:font-hei-medium',fontSize:size,color:'#000000',place:{left:10,top:10,width:{fixed:60},height:{fixed:30}}}]}});
async function runTemplate(name: string, actions: unknown[]) {
  const dir = join(root, name); await mkdir(dir);
  const sample = join(dir, 'sample.png'), reference = join(dir, 'reference.json'), requestFile = join(dir, 'request.json');
  const request = {template:'对照',dataset:{id:'ds-greeting'},parameters:{},output:{width:100,height:60,dpi:50,format:'png' as const},mode:'final' as const};
  const workspace = await loadWorkspace({dir:singleTextDir,resourcesDir});
  const image = (await render({...workspace,templates:[...workspace.templates,{name:'对照',document:template(10),source:'candidate.json'}]},request)).image!;
  await writeFile(sample, image.bytes); await writeFile(requestFile, JSON.stringify(request));
  await writeFile(reference, JSON.stringify({sampleWidthPx:image.widthPx,sampleHeightPx:image.heightPx,artboardWidthMm:100,artboardHeightMm:60,
    approvedRegions:[{id:'stop',name:'站名',sampleRegion:{x:0,y:0,width:image.widthPx,height:image.heightPx},targetPathPattern:'对照/站名',expectedFontSizeMm:10,expectedText:'科技园'}]}));
  return run(name, actions, ['--timeout-ms','15000','--stagnation-threshold','1'], false, ['--task','template-design','--sample',sample,'--workspace',singleTextDir,'--dataset','ds-greeting','--request',requestFile,'--reference',reference]);
}
it('核准字号偏差仍在且完整修复后没有改善，按视觉必修证据停止', async () => {
  const job = await runTemplate('style-no-progress', [
    {kind:'write',document:template(6)},{kind:'check'},
    {kind:'write',document:template(6)},{kind:'check'},
  ]);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'stagnation'});
  expect(job.result.stopped.cycles[0].required.some((item: string) => item.startsWith('style.'))).toBe(true);
});
it('核准字号偏差虽未消除但已真实缩小，不能因问题名称相同停止', async () => {
  const job = await runTemplate('style-progress', [
    {kind:'write',document:template(6)},{kind:'check'},
    {kind:'write',document:template(7)},{kind:'check'},
  ]);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'timeout'});
  expect((await readReview(job.out)).checkpoint?.check.styleVerification?.anomalies).toEqual(expect.arrayContaining([expect.objectContaining({kind:'fontSizeTooSmall'})]));
});
it('显式阈值一只需一个完整修复周期，生效值显示并固定在轮次记录', async () => {
  const job = await run('threshold-one', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'stagnation', threshold: 1 });
  expect(job.stderr).toContain('停滞阈值 1');
  const review = await readReview(job.out);
  expect(review.execution?.start?.runtime).toMatchObject({ stagnationThreshold: 1 });
  expect(JSON.parse(await readFile(join(job.out, 'round.json'), 'utf8')).runtime).toMatchObject({ stagnationThreshold: 1 });
});
it.each([0, -1, 1.5, NaN, Infinity])('非法停滞阈值 %s 在执行器启动前拒绝', async threshold => {
  await expect(runAgentTask({ out: join(root, 'invalid'), key: 'offline', keyEnv: 'RW_STAGNATION_KEY', stagnationThreshold: threshold }))
    .rejects.toThrow(/stagnation-threshold.*正整数/);
});
it('此前没有必修问题时，首次新问题不能被当成一次修复失败', async () => {
  const job = await run('new-problem', [
    { kind: 'write', fields: ['number', 'title', 'station'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' }, { kind: 'finish' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).execution?.status).toBe('completed');
});
it('候选字节虽变化但核准缺项不改善，两次完整修改复测仍停止', async () => {
  const job = await run('changed-without-progress', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'unrelated'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'unrelated', 'other'] }, { kind: 'check' },
  ]);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'stagnation', threshold: 2 });
  const cycles = job.result.stopped.cycles;
  expect(cycles).toHaveLength(2);
  expect(cycles[0].beforeIdentity).not.toBe(cycles[0].afterIdentity);
  expect(cycles[1].repairs).toEqual([expect.objectContaining({ path: 'candidates/schema.json', toolCallId: expect.any(String) })]);
});
it.each([['正确候选', ['number', 'title', 'station']], ['仍有缺项', ['number']]])('%s 的紧邻确认和交回复检不构成修复机会', async (name, fields) => {
  const job = await run(`confirm-${name}`, [
    { kind: 'write', fields }, { kind: 'check' }, { kind: 'check' }, { kind: 'check' }, { kind: 'finish' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).execution?.status).toBe('completed');
});
it('必修问题真实改善会重新开始无进展周期，仍能正式交回', async () => {
  const job = await run('improvement', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'unrelated'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'title'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'title', 'unrelated'] }, { kind: 'check' }, { kind: 'finish' },
  ]);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).checkpoint?.check.coverageVerification?.missingItems).toEqual(['station']);
});
it('没有核准内容依据且不存在技术错误时，不推断停滞而由整轮预算兜底', async () => {
  const job = await run('unknown-baseline', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
  ], ['--stagnation-threshold', '1'], false);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'timeout' });
});
it('完整候选反复违反数据定义硬约束时，即使没有内容基准也可证明停滞', async () => {
  const job = await run('technical-constraint', [
    { kind: 'write', fields: ['number', 'number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number', 'number'] }, { kind: 'check' },
  ], [], false);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'stagnation' });
  const checkpoint = (await readReview(job.out)).checkpoint!;
  expect(checkpoint.check.assessment.candidates).toBe('invalid');
  expect(job.result.stopped.cycles[0].required).not.toEqual([]);
});
it('检查时仍有未完成写入，不能将已有字节当成完整修复失败', async () => {
  const job = await run('unfinished-write', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'writePending', fields: ['number'] },
    { kind: 'check' }, { kind: 'finish' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).execution?.status).toBe('completed');
});
it('写入未列入成果集合的杂项文件，不会得到候选修复机会', async () => {
  const job = await run('unlisted-write', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', path: 'candidates/unlisted.json', fields: ['number'] }, { kind: 'check' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toMatchObject({ reason: 'timeout' });
});
it('执行器已正式交回后，异步检查读取不得再新判定停滞', async () => {
  const job = await run('submitted', [
    { kind: 'write', fields: ['number'] }, { kind: 'check' },
    { kind: 'write', fields: ['number'] }, { kind: 'checkAndFinish' },
  ], ['--stagnation-threshold', '1']);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).execution?.status).toBe('completed');
});
it('达到阈值的最后自检后只重复诊断并正式交回，不会被当成下一修复周期', async () => {
  const job = await run('final-check', [
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'check'}, {kind:'finish',delayMs:300},
  ], ['--stagnation-threshold','1']);
  expect(job.result?.stopped, job.stderr).toBeUndefined();
  expect((await readReview(job.out)).execution?.status).toBe('completed');
});
const manyFields = Array.from({length:180}, (_, index) => `approvedField${index}`);
it('截断的检查明细未读全，即使候选写入和复测重复也不能证明完整修复机会', async () => {
  const job = await run('incomplete-feedback', [
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'write',fields:['number']},{kind:'check'},
  ], ['--stagnation-threshold','1'], manyFields);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'timeout'});
});
it('读完同一报告全部页后获得完整修复机会，分页本身不增加周期', async () => {
  const job = await run('complete-feedback', [
    {kind:'write',fields:['number']},{kind:'check'},{kind:'pages'},
    {kind:'write',fields:['number']},{kind:'check'},{kind:'pages'},
  ], ['--stagnation-threshold','1'], manyFields);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'stagnation'});
  expect(job.result.stopped.cycles).toHaveLength(1);
  expect(job.result.stopped.cycles[0].feedback.before.pages.length).toBeGreaterThan(1);
  expect(job.result.stopped.cycles[0].feedback.after.pages.at(-1).nextOffset).toBeNull();
});
it('只读部分页就修改候选，后续完整分页不能倒推此前获得完整修复机会', async () => {
  const job = await run('partial-feedback', [
    {kind:'write',fields:['number']},{kind:'check'},{kind:'pages',onlyFirst:true},
    {kind:'write',fields:['number']},{kind:'check'},{kind:'pages'},
  ], ['--stagnation-threshold','1'], manyFields);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'timeout'});
});
it('半写成果未提交完整检查点，下一次完整复测不能沿用断裂的修复周期', async () => {
  const job = await run('partial-file', [
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'write',raw:'{"unfinished":'},{kind:'check'},
    {kind:'write',fields:['number']},{kind:'check'},
  ], ['--stagnation-threshold','1']);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'timeout'});
});
it('检查发现候选已变化却缺少完整写入事件，不能沿用旧无进展证据停止', async () => {
  const job = await run('unobserved-change', [
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'write',fields:['number']},{kind:'check'},
    {kind:'silentWrite',fields:['number','title']},{kind:'check'},
  ], ['--stagnation-threshold','1']);
  expect(job.result?.stopped, job.stderr).toMatchObject({reason:'timeout'});
});
