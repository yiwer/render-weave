/** 把离线校准报告和图像打包成可独立打开的证据页。 */
import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';

const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' }, flip: { type: 'string' } }, strict: true });
if (!values.from || !values.out) throw new Error('需要 --from <试验目录> --out <证据页目录>');
const source = resolve(values.from), target = resolve(values.out);
const report = JSON.parse(await readFile(join(source, 'report.json'), 'utf8'));
await mkdir(target, { recursive: true });
await copyFile(join(source, 'report.json'), join(target, 'report.json'));
await copyFile(join(source, 'reference.jpg'), join(target, 'reference.jpg'));
for (const row of report.rows) {
  if (!/^[a-z0-9-]+$/.test(row.id)) throw new Error('非法报告 ID');
  const path = join(source, row.id, 'actual.png');
  try { await access(path); } catch { row.image = null; continue; }
  await copyFile(path, join(target, row.id + '.png'));
  row.image = row.id + '.png';
}
let flip = null;
if (values.flip) {
  const dir = resolve(values.flip);
  flip = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  if (flip.sourceReportSha256 !== createHash('sha256').update(await readFile(join(source, 'report.json'))).digest('hex')) throw new Error('FLIP 不属于本次报告');
  await copyFile(join(dir, 'report.json'), join(target, 'flip-report.json'));
  for (const row of flip.rows.filter((r) => r.heatmap)) {
    if (!/^[a-z0-9-]+\.png$/.test(row.heatmap)) throw new Error('非法热图路径');
    await copyFile(join(dir, row.heatmap), join(target, row.heatmap));
  }
}
const compact = { scope: report.scope, checks: report.checks, flip, rows: report.rows.map(({ id, label, image, metrics, originalPixel, controlledPixel, renderProblems }) =>
  ({ id, label, image, metrics, originalPixel: originalPixel && { ssim: originalPixel.ssim, rgbSimilarity: originalPixel.rgbSimilarity },
    controlledPixel: controlledPixel && { ssim: controlledPixel.ssim, rgbSimilarity: controlledPixel.rgbSimilarity }, renderProblems })) };
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>模板还原评判 · 离线校准</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f5f2;color:#18242c;font:15px/1.55 system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:28px}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:0 0 12px}p{max-width:95ch}a{color:#174ead}.note{border-left:4px solid #d17f20;background:#fff7e8;padding:12px 16px}.controls{display:flex;gap:12px;flex-wrap:wrap;margin:20px 0}select{max-width:100%;font:inherit;padding:8px;background:white;border:1px solid #bdc8ce;border-radius:6px}.card{background:white;border:1px solid #dce1e3;border-radius:10px;padding:16px;margin:16px 0}.stage{position:relative;width:100%;min-height:20px;background:#e5e5e5}.stage img{width:100%;display:block}.box{position:absolute;border:1px solid #087eed;background:#087eed12;pointer-events:none}.facts{display:flex;gap:24px;flex-wrap:wrap}.fact{min-width:130px}.fact strong{display:block;font-size:23px}.muted{color:#53616c;font-size:13px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:9px;border-bottom:1px solid #e1e5e7;text-align:left;white-space:nowrap}th{background:#f2f4f5}.ok{color:#17683c}.bad{color:#a33724}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;background:#f6f7f8;padding:12px;font-size:12px}button{font:inherit;border:1px solid #c4cdd2;background:white;border-radius:5px;padding:5px 10px;cursor:pointer}button:hover{background:#edf4ff}ul{padding-left:22px}@media(max-width:600px){main{padding:14px}h1{font-size:23px}.card{padding:10px}.facts{gap:14px}.controls{display:block}.controls>*{display:block;margin:8px 0}}
</style><main><h1>模板还原评判：用缺陷检验指标</h1><p>先核对该出现的内容，再观察顺序、字号与位置。SSIM 保留为像素诊断，不合成未经校准的总分。</p>
<p class="note">“布局项匹配”只代表本试验覆盖的文本与资源在布局摘要中匹配。遮挡、裁切、透明度、分字排版、人类视觉偏好仍未验证。受控正例是项目维护模板，不是原图的金标准。</p>
<div class="controls"><label>候选 <select id="candidate"></select></label><label>参考 <select id="reference"><option value="sample">原始示例图</option><option value="control">受控正例</option></select></label><label>角色 <select id="role"></select></label><label><input type="checkbox" id="boxes">显示匹配框</label></div>
<section class="card"><h2 id="label"></h2><div class="facts" id="facts"></div></section>
<section class="card"><h2 id="refTitle">原始示例图</h2><div class="stage"><img id="refImg" alt="对照图"></div></section>
<section class="card"><h2>被测输出</h2><div class="stage" id="actualStage"><img id="actual" alt="被测模板输出"></div><p id="geometry" class="muted"></p></section>
<section class="card"><h2>FLIP 局部误差</h2><p id="flipSummary"></p><div class="stage"><img id="flipImage" alt="FLIP 感知差异热图"></div><p class="muted">低误差为暗色，高误差为亮色。参考随上方选项切换；只能定位外观差异，不能证明内容完整或判断根因。<a href="flip-report.json" id="flipLink">FLIP 原始报告</a></p></section>
<section class="card"><h2>分角色诊断</h2><div class="scroll"><table><thead><tr><th>角色</th><th>匹配/预期</th><th>逆序比例</th><th>字号中位数 mm</th><th>相对正例位置偏差</th><th>字号对数偏差</th></tr></thead><tbody id="roles"></tbody></table></div><pre id="details"></pre></section>
<section class="card"><h2>全部候选</h2><p class="muted">跨数据输入会合理改变像素。表中原图 SSIM 不能用作跨数据质量排名；历史候选没有获批的精确几何标注，因此不给结构总分。</p><div class="scroll"><table><thead><tr><th>候选</th><th>布局内容</th><th>站名</th><th>时刻</th><th>地标</th><th>站名字号</th><th>原图 SSIM</th><th>正例 SSIM</th></tr></thead><tbody id="all"></tbody></table></div></section>
<section class="card"><h2 id="checksTitle"></h2><ul id="checks"></ul><p><a href="report.json">完整机器可读报告</a></p></section></main>
<script>const DATA=${JSON.stringify(compact).replaceAll('<', '\\u003c')};
const $=id=>document.getElementById(id),fmt=(v,n=3)=>v==null?'—':v.toFixed(n),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names={'stations':'站名','roads':'道路','terminal':'终点','operator':'运营方','service-times':'时刻','service-note':'服务说明','next-stop':'下一站','landmarks':'站点地标','next-landmark':'下一站地标','badges':'标识'};
const state={matched:'已覆盖项匹配',mismatch:'存在未匹配项',unknown:'未知'},metric=(row,id)=>row.metrics.roles.find(x=>x.id===id),ratio=r=>r?r.matched+'/'+r.expected:'—';
$('candidate').innerHTML=DATA.rows.map(r=>'<option value="'+r.id+'">'+esc(r.label)+'</option>').join('');
$('role').innerHTML=Object.entries(names).map(([id,label])=>'<option value="'+id+'">'+label+'</option>').join('');
function draw(){const row=DATA.rows.find(r=>r.id===$('candidate').value),role=metric(row,$('role').value);$('label').textContent=row.label;$('refImg').src=$('reference').value==='sample'?'reference.jpg':'control.png';$('refTitle').textContent=$('reference').value==='sample'?'原始示例图':'受控正例（项目维护模板）';$('actual').src=row.image||'';
const flip=DATA.flip?.rows.find(r=>r.id===row.id&&r.reference===$('reference').value);$('flipImage').hidden=!flip;$('flipLink').hidden=!DATA.flip;if(flip){$('flipImage').src=flip.heatmap;$('flipSummary').textContent='均值 '+fmt(flip.meanError,4)+' · 五区均值：'+Object.entries(flip.regionMeans).map(([k,v])=>k+' '+fmt(v,4)).join('；');}else{$('flipImage').removeAttribute('src');$('flipSummary').textContent='本候选未做 FLIP 比较；跨数据变化不作像素质量排名。';}
$('facts').innerHTML=[['布局内容',state[row.metrics.content]],['站名',ratio(metric(row,'stations'))],['时刻',ratio(metric(row,'service-times'))],['原图 SSIM',fmt(row.originalPixel?.ssim)],['正例 SSIM',fmt(row.controlledPixel?.ssim)]].map(([label,value])=>'<div class="fact"><span class="muted">'+label+'</span><strong>'+esc(value)+'</strong></div>').join('');
$('roles').innerHTML=row.metrics.roles.map(r=>'<tr><td>'+esc(names[r.id]||r.id)+'</td><td>'+ratio(r)+'</td><td>'+fmt(r.inversionRate)+'</td><td>'+fmt(r.fontSizeMm?.median,2)+'</td><td>'+fmt(r.geometry?.meanCenterError,4)+'</td><td>'+fmt(r.geometry?.meanFontLogError)+'</td></tr>').join('');
$('geometry').textContent=row.controlledPixel?'结构偏差相对受控正例；中心距离按画板宽、高分别归一化。字号对数偏差为 0 表示一致。':'没有参考图的精确布局标注，仅报告输出的内容和字号证据。';
$('details').textContent=JSON.stringify({role:role?.id,missingOrUnmatched:role?.missingOrUnmatched,unexpected:role?.unexpected,unassignedText:role?.unassignedText,diagnostics:row.metrics.diagnostics,renderProblems:row.renderProblems,unknown:row.metrics.unknown},null,2);
document.querySelectorAll('.box').forEach(n=>n.remove());if($('boxes').checked)for(const m of role?.matches||[]){if(!m)continue;const n=document.createElement('div');n.className='box';Object.assign(n.style,{left:m.box.x*100+'%',top:m.box.y*100+'%',width:m.box.width*100+'%',height:m.box.height*100+'%'});n.title=m.value;$('actualStage').append(n);}}
$('all').innerHTML=DATA.rows.map(r=>'<tr><td><button data-id="'+r.id+'">'+esc(r.label)+'</button></td><td>'+state[r.metrics.content]+'</td><td>'+ratio(metric(r,'stations'))+'</td><td>'+ratio(metric(r,'service-times'))+'</td><td>'+ratio(metric(r,'landmarks'))+'</td><td>'+fmt(metric(r,'stations')?.fontSizeMm?.median,2)+'</td><td>'+fmt(r.originalPixel?.ssim)+'</td><td>'+fmt(r.controlledPixel?.ssim)+'</td></tr>').join('');
$('all').addEventListener('click',e=>{const id=e.target.dataset.id;if(id){$('candidate').value=id;draw();window.scrollTo({top:0,behavior:'smooth'});}});for(const id of ['candidate','reference','role','boxes'])$(id).addEventListener('change',draw);
$('checksTitle').textContent='校准断言 '+DATA.checks.filter(c=>c.pass).length+'/'+DATA.checks.length;$('checks').innerHTML=DATA.checks.map(c=>'<li class="'+(c.pass?'ok':'bad')+'">'+(c.pass?'通过：':'失败：')+esc(c.name)+'</li>').join('');draw();
</script></html>`;
await writeFile(join(target, 'index.html'), html);
console.log(JSON.stringify({ page: join(target, 'index.html'), rows: report.rows.length }));
