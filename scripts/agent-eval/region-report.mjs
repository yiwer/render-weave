/** 归档区域反馈实验与共享前缀停止对照；不调用模型、不重新评分。 */
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { root: { type: 'string' }, out: { type: 'string' } }, strict: true });
if (!values.root || !values.out) throw new Error('需要 --root 与 --out');
const root = resolve(values.root), out = resolve(values.out);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const sha = b => createHash('sha256').update(b).digest('hex');
const exists = async p => { try { await access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const manifest = await json(join(root, 'manifest.json')), live = await json(join(root, 'live-report.json'));
if (manifest.comparison !== 'role-region' || live.manifestSha256 !== sha(await readFile(join(root, 'manifest.json')))) throw new Error('实验类型或输入指纹不匹配');
await mkdir(out, { recursive: true });
for (const file of ['reference.png', 'manifest.json', 'live-report.json']) await copyFile(join(root, file), join(out, file));
await copyFile(join(root, 'c/initial/base.png'), join(out, 'initial.png'));
const initial = await json(join(root, 'c/initial/report.json'));
const rows = [];
for (const unit of manifest.order) {
  const item = live.rows.find(r => r.id === unit.id), rounds = [];
  for (const [i, round] of (item?.rounds ?? []).entries()) {
    const prefix = `${unit.id}-round-${i + 1}`;
    const score = await exists(join(round.dir, 'repair-score/report.json')) ? await json(join(round.dir, 'repair-score/report.json')) : null;
    const decision = await exists(join(round.dir, 'repair-score/stop-decision.json')) ? await json(join(round.dir, 'repair-score/stop-decision.json')) : null;
    if (decision && decision.measurementSha256 !== sha(await readFile(join(round.dir, 'repair-score/report.json')))) throw new Error('停止决定不匹配评分：' + prefix);
    const record = await json(join(round.dir, 'round.json'));
    if (JSON.stringify(record) !== JSON.stringify(round.record)) throw new Error('执行记录不一致：' + prefix);
    const files = { record: 'round.json', context: 'context.json', score: 'repair-score/report.json', decision: 'repair-score/stop-decision.json', image: 'repair-score/base.png' };
    const archived = {};
    for (const [key, path] of Object.entries(files)) if (await exists(join(round.dir, path))) {
      const name = prefix + '-' + key + (key === 'image' ? '.png' : '.json');
      await copyFile(join(round.dir, path), join(out, name));
      archived[key] = { file: name, sha256: sha(await readFile(join(round.dir, path))) };
    }
    const feedbackPath = i === 0 ? join(root, 'c', unit.arm + '.md') : join(round.dir, 'feedback.md');
    const feedback = await exists(feedbackPath) ? await readFile(feedbackPath, 'utf8') : null;
    rounds.push({ iteration: i + 1, record, score: score && { qualified: score.qualified, available: score.available, repaired: score.repaired, targetCount: score.targetCount,
      addedFailures: score.addedFailures, cleanSuccess: score.cleanSuccess, checks: score.measurement?.checks ?? null, pixel: score.measurement?.pixel ?? null }, decision, feedback, archived });
  }
  if (rounds[0]?.decision && rounds[1] && !(Date.parse(rounds[0].decision.decidedAt) < Date.parse(rounds[1].record.startedAt))) throw new Error('停止决定没有先于第二轮：' + unit.id);
  const completed = item?.status === 'completed' && rounds.length === 2;
  const metrics = count => {
    const prefix = rounds.slice(0, count), final = prefix.at(-1);
    const available = final?.score?.available && final.decision;
    const firstChecks = rounds[0]?.score?.checks, finalChecks = final?.score?.checks;
    return { rounds: count, repaired: final?.score?.repaired.length ?? null, allPassed: available ? final.decision.stop : null,
      addedFailures: final?.score?.addedFailures ?? null,
      remainingFailures: finalChecks ? finalChecks.filter(c => !c.pass).map(c => c.id) : null,
      regressions: firstChecks && finalChecks ? firstChecks.filter(c => c.pass && finalChecks.find(f => f.id === c.id)?.pass !== true).map(c => c.id) : null,
      peak: prefix.length === count && prefix.every(r => Number.isFinite(r.record.run.context?.peakInputTokens)) ? Math.max(...prefix.map(r => r.record.run.context.peakInputTokens)) : null,
      wallMs: prefix.length === count && prefix.every(r => Number.isFinite(r.record.run.wallMs)) ? prefix.reduce((sum, r) => sum + r.record.run.wallMs, 0) : null };
  };
  rows.push({ ...unit, status: item?.status ?? 'notRun', failure: item?.failure ?? null, rounds,
    first: rounds.length ? metrics(1) : null, fixed: completed ? metrics(2) : null,
    stopped: completed && rounds[0]?.decision ? metrics(rounds[0].decision.stop ? 1 : 2) : null });
}
const average = xs => xs.length && xs.every(Number.isFinite) ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const summarize = (arm, policy) => {
  const planned = rows.filter(r => r.arm === arm), done = planned.filter(r => r[policy]);
  const known = done.map(r => r[policy]);
  return { planned: planned.length, measured: done.length, targetCount: done.length * 2, repaired: known.reduce((s, r) => s + (r.repaired ?? 0), 0),
    unknownRepair: known.filter(r => r.repaired === null).length, allPassed: known.filter(r => r.allPassed === true).length, unknownAllPassed: known.filter(r => r.allPassed === null).length,
    addedFailures: known.reduce((s, r) => s + (r.addedFailures?.length ?? 0), 0), unknownAdded: known.filter(r => r.addedFailures === null).length,
    remainingFailures: known.reduce((s, r) => s + (r.remainingFailures?.length ?? 0), 0), unknownRemaining: known.filter(r => r.remainingFailures === null).length,
    regressions: known.reduce((s, r) => s + (r.regressions?.length ?? 0), 0), unknownRegressions: known.filter(r => r.regressions === null).length,
    modelRounds: known.reduce((s, r) => s + r.rounds, 0), meanPeak: average(known.map(r => r.peak)), meanWallMs: average(known.map(r => r.wallMs)),
    maximumPeak: known.length && known.every(r => Number.isFinite(r.peak)) ? Math.max(...known.map(r => r.peak)) : null,
    totalWallMs: known.length && known.every(r => Number.isFinite(r.wallMs)) ? known.reduce((s, r) => s + r.wallMs, 0) : null };
};
const groups = Object.fromEntries(['role', 'region'].map(arm => [arm, Object.fromEntries(['first', 'fixed', 'stopped'].map(policy => [policy, summarize(arm, policy)]))]));
const report = { format: 'renderweave-region-results/1', createdAt: new Date().toISOString(), manifestSha256: live.manifestSha256, sourceCommit: manifest.head,
  scope: '同一 C 位置坏例，每臂重复两次；第一轮停止决定先登记，第二轮仍真实执行。stopped 使用同一批实际调用的前缀，不是独立随机化实验。',
  initialChecks: initial.checks, groups, rows };
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const compact = { ...report, rows: rows.map(r => ({ ...r, rounds: r.rounds.map(x => ({ ...x, record: { verdict: x.record.verdict, run: x.record.run } })) })) };
await writeFile(join(out, 'index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>区域反馈与停止条件实测</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f3f5f4;color:#183038;font:15px/1.6 system-ui,sans-serif}main{max-width:1450px;padding:24px;margin:auto}section{background:white;border:1px solid #d8e0dc;border-radius:8px;margin:18px 0;padding:18px}h1{font-size:27px}h2{font-size:19px}table{border-collapse:collapse;white-space:nowrap;width:100%}td,th{text-align:left;border-bottom:1px solid #ddd;padding:9px}.scroll{overflow:auto}img{width:100%;display:block}pre{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f5;padding:10px}.controls{display:flex;gap:20px;flex-wrap:wrap}select{font:inherit;padding:6px}.note{background:#fff5df;border-left:4px solid #d29932;padding:12px}@media(max-width:600px){main{padding:10px}section{padding:10px}h1{font-size:22px}}</style>
<main><h1>两条反馈应该覆盖几个区域？</h1><p>Haiku 5.5 · 相同位置坏例 · 每臂重复两次 · 固定两轮，每轮 maxTurns=20。</p><p class="note">role：按角色选两条；region：按已登记参考区域去重。停止条件是全部登记检查通过且技术交回有效。共享首轮并执行影子续跑，停止成本来自实际前缀，不能视为独立随机化停止臂。</p>
<section><h2>修复与成本</h2><div class="scroll"><table><thead><tr><th>反馈</th><th>策略</th><th>单元</th><th>修复</th><th>全检查通过</th><th>新增失败</th><th>轮间回退</th><th>平均峰值</th><th>平均分钟</th></tr></thead><tbody id="summary"></tbody></table></div></section>
<section class="controls"><label>重复 <select id="rep"><option>1</option><option>2</option></select></label><label>阶段 <select id="stage"><option value="0">第一轮</option><option value="1" selected>第二轮（含影子续跑）</option></select></label></section>
<section><h2>参考目标</h2><img src="reference.png" alt="受控参考"></section><section><h2>相同起点</h2><img src="initial.png" alt="位置坏例"></section>
${['role', 'region'].map(a => `<section><h2>${a === 'role' ? '按角色选择' : '按区域去重'}</h2><p id="${a}facts"></p><img id="${a}img" alt="${a}修复结果"><pre id="${a}checks"></pre><details><summary>本轮反馈</summary><pre id="${a}feedback"></pre></details></section>`).join('')}
<section><h2>边界</h2><p>只在同一受控中文线路牌上验证。内容与几何来自布局证据，遮挡、裁切、墨迹、任意图片标注和人工偏好仍未验证。新增失败项可能属于同一根因。未知值不会算作零缺陷。</p><a href="report.json">逐单元报告</a> · <a href="manifest.json">冻结指纹</a> · <a href="probe/report.json">固定版本样式探针</a></section></main>
<script>const D=${JSON.stringify(compact).replaceAll('<', '\\u003c')};const $=s=>document.getElementById(s),n=v=>v==null?'未知':Math.round(v).toLocaleString(),m=v=>v==null?'未知':(v/60000).toFixed(2),names={role:'角色',region:'区域'},policies={first:'首轮',fixed:'固定两轮',stopped:'按登记决定停止（共享前缀）'};
$('summary').innerHTML=Object.entries(D.groups).flatMap(([a,g])=>Object.entries(g).map(([p,s])=>'<tr><td>'+names[a]+'</td><td>'+policies[p]+'</td><td>'+s.measured+'/'+s.planned+'</td><td>'+s.repaired+'/'+s.targetCount+'</td><td>'+s.allPassed+'/'+s.measured+(s.unknownAllPassed?' 未知'+s.unknownAllPassed:'')+'</td><td>'+s.addedFailures+(s.unknownAdded?' 未知'+s.unknownAdded:'')+'</td><td>'+s.regressions+(s.unknownRegressions?' 未知'+s.unknownRegressions:'')+'</td><td>'+n(s.meanPeak)+'</td><td>'+m(s.meanWallMs)+'</td></tr>')).join('');
function draw(){for(const arm of ['role','region']){const r=D.rows.find(r=>r.arm===arm&&r.repetition===Number($('rep').value)),x=r?.rounds[Number($('stage').value)],im=$(arm+'img');im.hidden=!x?.archived.image;if(x?.archived.image)im.src=x.archived.image.file;else im.removeAttribute('src');$(arm+'facts').textContent=x?'本轮 '+m(x.record.run.wallMs)+' 分钟；峰值 '+n(x.record.run.context?.peakInputTokens)+'；交回 '+x.record.verdict+'；登记停止 '+(x.decision?.stop??'未知'):'未取得结果';$(arm+'checks').textContent=JSON.stringify({修复目标:x?.score?.repaired??null,当前失败:x?.score?.checks?.filter(c=>!c.pass).map(c=>c.id)??null,新增失败:x?.score?.addedFailures??null},null,2);$(arm+'feedback').textContent=x?.feedback??'未知';}}$('rep').onchange=draw;$('stage').onchange=draw;draw();</script></html>`);
console.log(JSON.stringify({ groups, out }));
