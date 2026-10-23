/** 从已完成/部分完成的实验目录归档结果；不调用模型、不重评分。 */
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.root || !values.out) throw new Error('需要 --root <实验目录> --out <报告目录>');
const root = resolve(values.root), out = resolve(values.out);
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const exists = async (p) => { try { await access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const manifest = await json(join(root, 'manifest.json')), live = await json(join(root, 'live-report.json'));
if (sha(await readFile(join(root, 'manifest.json'))) !== live.manifestSha256) throw new Error('输入登记与执行记录不一致');
await mkdir(out, { recursive: true });
await copyFile(join(root, 'reference.png'), join(out, 'reference.png'));
await copyFile(join(root, 'manifest.json'), join(out, 'manifest.json'));
const baseline = {};
for (const c of manifest.cases) {
  baseline[c.id] = await json(join(root, c.id, 'initial/report.json'));
  await copyFile(join(root, c.id, 'initial/base.png'), join(out, c.id + '-initial.png'));
}
const rows = [];
for (const unit of manifest.order) {
  const item = live.rows.find((r) => r.id === unit.id), rounds = [];
  for (const [index, round] of (item?.rounds ?? []).entries()) {
    const reportPath = join(round.dir, 'repair-score/report.json');
    const score = await exists(reportPath) ? await json(reportPath) : null;
    const stream = join(round.dir, 'logs/stream.jsonl');
    const events = await exists(stream) ? (await readFile(stream, 'utf8')).split('\n').filter(Boolean).flatMap((s) => { try { return [JSON.parse(s)]; } catch { return []; } }) : [];
    const startup = events.find((e) => e.type === 'system' && e.subtype === 'init');
    const traceComplete = !!startup && events.some((e) => e.type === 'result');
    const calls = new Map();
    for (const event of events) for (const block of event.message?.content ?? []) if (block.type === 'tool_use') calls.set(block.id, { name: block.name, input: block.input });
    const reads = [...calls.values()].filter((c) => c.name === 'Read').map((c) => c.input.file_path?.replaceAll('\\', '/') ?? '');
    const evidenceFile = index === 0 ? join(root, unit.caseId, unit.arm + '.md') : join(round.dir, 'feedback.md');
    const feedback = await exists(evidenceFile) ? await readFile(evidenceFile, 'utf8') : null;
    const image = unit.id + '-round-' + (index + 1) + '.png';
    const imagePath = join(round.dir, 'repair-score/base.png');
    const imageAvailable = await exists(imagePath);
    if (imageAvailable) await copyFile(imagePath, join(out, image));
    if (score) await writeFile(join(out, unit.id + '-round-' + (index + 1) + '.json'), JSON.stringify(score, null, 2) + '\n');
    const contextPath = join(round.dir, 'context.json');
    const context = await exists(contextPath) ? await json(contextPath) : null;
    const contextFile = unit.id + '-round-' + (index + 1) + '-context.json';
    if (context) await copyFile(contextPath, join(out, contextFile));
    rounds.push({ iteration: index + 1, record: round.record, score: score && { available: score.available, qualified: score.qualified, repaired: score.repaired,
      targetCount: score.targetCount, addedFailures: score.addedFailures, cleanSuccess: score.cleanSuccess, checks: score.measurement?.checks ?? null, pixel: score.measurement?.pixel ?? null },
      image: imageAvailable ? image : null, imageSha256: imageAvailable ? sha(await readFile(imagePath)) : null, contextFile: context ? contextFile : null, feedback,
      startup: startup ? { model: startup.model, skills: startup.skills, tools: startup.tools, mcpServers: startup.mcp_servers } : null,
      behavior: traceComplete ? { toolCalls: calls.size, readRequirement: reads.some((p) => p.endsWith('/docs/requirement.md')), readFeedback: reads.some((p) => p.endsWith('/docs/feedback.md')),
        viewImages: [...calls.values()].filter((c) => c.name === 'mcp__rw__view_image').length, layoutInspections: [...calls.values()].filter((c) => c.name === 'mcp__rw__inspect_layout').length,
        dslChaptersRead: [...new Set(reads.filter((p) => /\/dsl\/section-\d+\.md$/.test(p)).map((p) => p.split('/').at(-1)))],
        nativeImageReads: reads.filter((p) => /\.(?:png|jpe?g|webp)$/i.test(p)).map((p) => p.split('/').at(-1)),
        dslReferenceCalls: [...calls.values()].filter((c) => c.name === 'mcp__rw__dsl_reference').length,
        candidateEdits: [...calls.values()].filter((c) => ['Edit', 'Write'].includes(c.name) && /[\\/]candidates[\\/]/.test(c.input?.file_path ?? '')).length } : null });
  }
  const complete = item?.status === 'completed' && rounds.length === manifest.rounds;
  const measured = rounds.map((r) => r.record.run);
  const final = complete ? rounds.at(-1).score : null;
  const first = rounds[0]?.score;
  rows.push({ ...unit, status: item?.status ?? 'notRun', failure: item?.failure ?? null, rounds, final,
    wallMs: complete && measured.every((r) => Number.isFinite(r.wallMs)) ? measured.reduce((s, r) => s + r.wallMs, 0) : null,
    peak: complete && measured.every((r) => Number.isFinite(r.context?.peakInputTokens)) ? Math.max(...measured.map((r) => r.context.peakInputTokens)) : null,
    regressedTargets: complete && first?.available && final?.available ? first.repaired.filter((id) => !final.repaired.includes(id)) : null,
    exploratoryAllChecks: {
      remainingFailures: complete && final?.available && final.checks ? final.checks.filter((c) => !c.pass).map((c) => c.id) : null,
      regressedFromFirst: complete && first?.available && final?.available && first.checks && final.checks ? first.checks.filter((c) => c.pass && final.checks.find((f) => f.id === c.id)?.pass !== true).map((c) => c.id) : null,
    } });
}
const paired = manifest.order.filter((u) => u.arm === 'image').map((u) => `${u.caseId}-${u.repetition}`)
  .filter((key) => ['image', 'evidence'].every((arm) => rows.find((r) => `${r.caseId}-${r.repetition}` === key && r.arm === arm)?.status === 'completed'));
const average = (xs) => xs.length && xs.every(Number.isFinite) ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
const summary = (arm, pairedOnly) => {
  const all = rows.filter((r) => r.arm === arm), done = all.filter((r) => r.status === 'completed' && (!pairedOnly || paired.includes(`${r.caseId}-${r.repetition}`)));
  const known = done.filter((r) => Array.isArray(r.final?.addedFailures));
  const early = done.filter((r) => r.rounds[0]?.score?.cleanSuccess);
  return { planned: all.length, completed: done.length, targets: done.length * 2, repaired: done.reduce((s, r) => s + (r.final?.repaired.length ?? 0), 0),
    repairedRate: done.length ? done.reduce((s, r) => s + (r.final?.repaired.length ?? 0), 0) / (done.length * 2) : null,
    cleanSuccess: done.filter((r) => r.final?.cleanSuccess).length, qualified: done.filter((r) => r.final?.qualified).length,
    addedFailures: known.reduce((s, r) => s + r.final.addedFailures.length, 0), addedFailureUnits: known.filter((r) => r.final.addedFailures.length).length,
    unknownAddedUnits: done.length - known.length, meanPeak: average(done.map((r) => r.peak)), meanWallMs: average(done.map((r) => r.wallMs)),
    maximumPeak: done.length && done.every((r) => Number.isFinite(r.peak)) ? Math.max(...done.map((r) => r.peak)) : null,
    totalWallMs: done.length && done.every((r) => Number.isFinite(r.wallMs)) ? done.reduce((s, r) => s + r.wallMs, 0) : null,
    maxTurnsEndings: done.reduce((s, r) => s + r.rounds.filter((x) => x.record.run.endedBy === 'error_max_turns').length, 0),
    regressedTargets: done.reduce((s, r) => s + (r.regressedTargets?.length ?? 0), 0), unknownRegressionUnits: done.filter((r) => r.regressedTargets === null).length,
    exploratoryAllChecks: { allPassedUnits: done.filter((r) => r.final?.qualified && r.exploratoryAllChecks.remainingFailures?.length === 0).length,
      remainingFailures: done.reduce((s, r) => s + (r.exploratoryAllChecks.remainingFailures?.length ?? 0), 0), unknownRemainingUnits: done.filter((r) => r.exploratoryAllChecks.remainingFailures === null).length,
      regressedFromFirst: done.reduce((s, r) => s + (r.exploratoryAllChecks.regressedFromFirst?.length ?? 0), 0), unknownRegressionUnits: done.filter((r) => r.exploratoryAllChecks.regressedFromFirst === null).length },
    exploratoryEarlyStop: { firstRoundCleanSuccess: early.length, secondRoundMsAfterSuccess: early.every((r) => Number.isFinite(r.rounds[1].record.run.wallMs)) ? early.reduce((s, r) => s + r.rounds[1].record.run.wallMs, 0) : null,
      finalCleanSuccessAmongEarly: early.filter((r) => r.final?.cleanSuccess).length } };
};
const report = { format: 'renderweave-repair-results/1', createdAt: new Date().toISOString(), manifestSha256: live.manifestSha256, sourceCommit: manifest.head,
  scope: '受控参考模板的三组退化；每单元固定两轮，每轮执行器参数 maxTurns=20。目标恢复与合格交回分列；新增缺陷按固定检查项计。',
  groups: Object.fromEntries(['image', 'evidence'].map((a) => [a, summary(a, false)])), pairedGroups: Object.fromEntries(['image', 'evidence'].map((a) => [a, summary(a, true)])),
  completePairs: paired, cases: manifest.cases, baseline, rows, limitations: ['同一模板、每坏例每臂仅两次，不代表跨业务泛化', '受控参考结构已知，不能外推任意PNG自动标注质量', '布局匹配不证明最终遮挡、裁切、墨迹可见', '两轮预算不等于两次文件编辑；无效与未运行项不计入模型质量分母，单列覆盖', '新增失败检查项可能来自同一视觉根因，不是独立缺陷数量'] };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const compact = { ...report, baseline: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, { checks: v.checks }])), rows: rows.map((r) => ({ ...r, rounds: r.rounds.map((x) => ({ ...x, record: { verdict: x.record.verdict, run: x.record.run } })) })) };
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Haiku 模板修复反馈对照</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f4f5f3;color:#182b32;font:15px/1.6 system-ui,sans-serif}main{max-width:1450px;padding:28px;margin:auto}h1{font-size:28px}h2{font-size:19px}p{max-width:100ch}section{background:white;border:1px solid #d9e1df;border-radius:8px;padding:18px;margin:18px 0}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;white-space:nowrap}th,td{text-align:left;padding:9px;border-bottom:1px solid #dce3e1}th{background:#edf2ef}img{display:block;width:100%;background:#eee}.controls{display:flex;gap:20px;flex-wrap:wrap}select{font:inherit;padding:7px}.muted{color:#52676e}.note{padding:14px;border-left:4px solid #d29a35;background:#fff6df}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f6f7f7;padding:12px}a{color:#175ca0}.bad{color:#9e3d2c}@media(max-width:600px){main{padding:12px}section{padding:10px}h1{font-size:22px}}</style>
<main><h1>Haiku：只看图与元素差异反馈</h1><p>相同坏例、相同参考、相同工具；每次固定两轮，每轮执行器参数 maxTurns=20。元素反馈每轮新增最多两条、1200字符，历史反馈仍可回读。</p><p class="note">目标修复按布局证据评分，技术交回另列。新增缺陷指原通过检查项变失败，可能共享根因；这不是人类视觉盲评。峰值为单元内两轮的最大有效输入，耗时为两轮模型执行时间之和。</p>
<section><h2>成对完成样本</h2><div class="scroll"><table><thead><tr><th>方式</th><th>完成单元</th><th>目标修复</th><th>目标全修且无新增</th><th>新增失败项</th><th>平均峰值</th><th>平均耗时</th></tr></thead><tbody id="summary"></tbody></table></div><p id="coverage" class="muted"></p><p id="allChecks" class="note"></p></section>
<section class="controls"><label>坏例 <select id="case"></select></label><label>重复 <select id="repeat"><option>1</option><option>2</option></select></label><label>阶段 <select id="round"><option value="0">第一轮后</option><option value="1" selected>第二轮后</option></select></label></section>
<section><h2>参考目标（维护模板出图）</h2><img src="reference.png" alt="参考目标"></section><section><h2>相同起点</h2><img id="initial" alt="损坏模板"><pre id="initialChecks"></pre></section>
<section><h2>只看图</h2><p id="imageFacts"></p><img id="imageImg" alt="只看图的修复结果"><pre id="imageDetails"></pre></section>
<section><h2>最多两条元素差异反馈</h2><p id="evidenceFacts"></p><img id="evidenceImg" alt="元素反馈的修复结果"><details><summary>本轮收到的文字</summary><pre id="feedback"></pre></details><pre id="evidenceDetails"></pre></section>
<section><h2>逐单元原始结果</h2><div class="scroll"><table><thead><tr><th>样本</th><th>状态</th><th>修复</th><th>新增失败项</th><th>峰值</th><th>耗时/分钟</th></tr></thead><tbody id="units"></tbody></table></div><p><a href="report.json">完整报告</a> · <a href="manifest.json">冻结输入与版本</a></p><ul id="limits"></ul></section></main>
<script>const D=${JSON.stringify(compact).replaceAll('<', '\\u003c')};const $=s=>document.getElementById(s),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),num=n=>n==null?'未知':Math.round(n).toLocaleString(),mins=n=>n==null?'未知':(n/60000).toFixed(2),names={image:'只看图',evidence:'元素反馈'};
$('summary').innerHTML=Object.entries(D.pairedGroups).map(([a,g])=>'<tr><td>'+names[a]+'</td><td>'+g.completed+'</td><td>'+g.repaired+'/'+g.targets+'</td><td>'+g.cleanSuccess+'/'+g.completed+'</td><td>'+g.addedFailures+(g.unknownAddedUnits?'，未知'+g.unknownAddedUnits+'单元':'')+'</td><td>'+num(g.meanPeak)+'</td><td>'+mins(g.meanWallMs)+'分钟</td></tr>').join('');
$('coverage').textContent='成对完成 '+D.completePairs.length+' 组；计划12单元。失败、无效和未运行状态均保留在下表。';$('case').innerHTML=D.cases.map(c=>'<option value="'+c.id+'">'+c.id.toUpperCase()+' · '+esc(c.label)+'</option>').join('');
$('allChecks').textContent='事后附加观测（不替换事前主指标）：'+Object.entries(D.pairedGroups).map(([a,g])=>names[a]+'全部固定检查通过 '+g.exploratoryAllChecks.allPassedUnits+'/'+g.completed+'；相对第一轮回退 '+g.exploratoryAllChecks.regressedFromFirst+' 项'+(g.exploratoryAllChecks.unknownRegressionUnits?'，未知 '+g.exploratoryAllChecks.unknownRegressionUnits+' 单元':'')).join('。')+'。目标全修仍可能遗留初始就失败的非目标项。';
$('units').innerHTML=D.rows.map(r=>'<tr><td>'+r.id+'</td><td>'+r.status+'</td><td>'+(r.final?r.final.repaired.length+'/2':'未取得')+'</td><td>'+(r.final?.addedFailures==null?'未知':r.final.addedFailures.length)+'</td><td>'+num(r.peak)+'</td><td>'+mins(r.wallMs)+'</td></tr>').join('');$('limits').innerHTML=D.limitations.map(s=>'<li>'+esc(s)+'</li>').join('');
function draw(){const c=$('case').value,rep=Number($('repeat').value),round=Number($('round').value);$('initial').src=c+'-initial.png';$('initialChecks').textContent=JSON.stringify({初始失败项:D.baseline[c].checks.filter(x=>!x.pass).map(x=>x.id)},null,2);for(const arm of ['image','evidence']){const r=D.rows.find(x=>x.caseId===c&&x.repetition===rep&&x.arm===arm),s=r?.rounds[round],im=$(arm+'Img');im.hidden=!s?.image;if(s?.image)im.src=s.image;else im.removeAttribute('src');$(arm+'Facts').textContent=s?'本轮耗时 '+mins(s.record.run.wallMs)+' 分钟；峰值 '+num(s.record.run.context?.peakInputTokens)+'；交回 '+s.record.verdict:'本阶段未取得结果';$(arm+'Details').textContent=JSON.stringify({修复目标:s?.score?.repaired??null,新增失败项:s?.score?.addedFailures??null,当前全部失败:s?.score?.checks?.filter(x=>!x.pass).map(x=>x.id)??null},null,2);if(arm==='evidence')$('feedback').textContent=s?.feedback??'未提供';}}
for(const id of ['case','repeat','round'])$(id).onchange=draw;draw();</script></html>`;
await writeFile(join(out, 'index.html'), html);
console.log(JSON.stringify({ groups: report.groups, pairedGroups: report.pairedGroups, completePairs: paired.length, out }));
