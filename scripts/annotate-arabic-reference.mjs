/** 从独立原图测量参考墨迹；不读取候选的尺寸作为真值。node --import tsx scripts/annotate-arabic-reference.mjs */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadCanvasKit } from '../src/canvaskit.ts';

const source = resolve(process.argv[2] ?? 'out/arabic-board-retest-2026-10-20/r3-template/agent/sample.png');
const output = resolve(process.argv[3] ?? 'out/agent-reference-annotation');
const bytes = await readFile(source), hash = createHash('sha256').update(bytes).digest('hex');
assert.equal(hash, '622e340e787706113d6f579d53b892e4a7ed6f2a3b85041b5c2f0c5c6300f1da', '标注只用于这张原图');
const ck = await loadCanvasKit(), image = ck.MakeImageFromEncoded(bytes);
assert.ok(image); assert.equal(image.width(), 3200); assert.equal(image.height(), 3600);
const pixels = image.readPixels(0, 0, { width: 3200, height: 3600, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
assert.ok(pixels instanceof Uint8Array);
// 以下 ROI 在已目视检查的 1504×1692 展示坐标上圈定；测量始终读取原始 3200×3600 像素。
// 文字ROI只含一行文字，排除线路轴/标签底色边缘；原图背景由每个ROI左上角采样。
const specs = [];
const add = (id, name, roi, path, state, text) => specs.push({ id, name, roi, targetPathPattern: path, ...(state ? { state } : {}), ...(text ? { expectedText: text } : {}) });
add('header-label', '顶栏中英文标题', [1090, 32, 240, 29], '*/本站栏目标题');
add('header-ar', '本站阿文大标题', [980, 63, 342, 70], '*/本站名称行/本站阿文名');
add('header-en', '本站英文标题', [850, 89, 125, 31], '*/本站名称行/本站英文名', undefined, 'Palm Park');
add('code-label', '站码标题', [70, 30, 185, 30], '*/站点编号标题');
add('code-value', '站码数值', [135, 72, 110, 42], '*/站点编号值');
add('towards-label', '方向标签', [1088, 202, 172, 35], '*/开往标题');
add('destination-ar', '方向阿文大字', [1055, 242, 206, 73], '*/终点站名称行/终点站阿文名');
add('destination-en', '方向英文', [970, 270, 75, 38], '*/终点站名称行/终点站英文名', undefined, 'Port');
add('via-line', '始发与途经说明', [812, 323, 452, 34], '*/始发与途经行');
add('route-label', '线路号牌标签', [1336, 215, 45, 26], '*/线路号前缀');
add('route-main', '线路号牌主字', [1303, 244, 106, 69], '*/线路号主字');
add('route-secondary', '线路号牌副字', [1341, 319, 35, 25], '*/线路号副字', undefined, '12');
add('count-label', '站数标签', [162, 190, 155, 30], '*/站数标题');
add('count-value', '站数数值', [173, 223, 142, 42], '*/站数值');
add('trip-label', '全程标签', [118, 285, 199, 30], '*/全程时长标题');
add('trip-value', '全程时长里程', [68, 316, 251, 46], '*/全程时长里程值');
for (const [side, x] of [['右', 782], ['左', 75]]) {
  add(`table-${side}-time`, `${side}栏分钟标题`, [x - 5, 429, 107, 28], `*/${side}栏表头分钟`);
  add(`table-${side}-transfer`, `${side}栏换乘标题`, [x + 98, 429, 205, 28], `*/${side}栏表头换乘`);
  add(`table-${side}-stops`, `${side}栏站名标题`, [x + 523, 429, 128, 28], `*/${side}栏表头站点`);
}
const right = [[482, 517], [556, 588], [628, 660], [700, 731], [773, 804], [850, 884], [932, 964], [1005, 1037]];
const left = [[482, 516], [556, 588], [627, 660], [699, 731], [772, 803], [842, 875], [914, 947], [986, 1019]];
for (let index = 1; index <= 16; index++) {
  const side = index <= 8 ? '右' : '左', row = (index - 1) % 8, [arY, enY] = (index <= 8 ? right : left)[row];
  const state = index < 6 ? 'passed' : index === 6 ? 'current' : index === 16 ? 'terminal' : 'normal';
  const prefix = `*/${side}栏站点列表[${index}]/*`;
  add(`stop-${index}-ar`, `第 ${index} 站阿文`, [index <= 8 ? 1085 : 400, index === 15 ? arY - 4 : arY, index <= 8 ? 296 : 277, enY - arY - 1 + (index === 15 ? 4 : 0) + (index === 11 ? 3 : 0)], `${prefix}/站点阿文名`, state);
  add(`stop-${index}-en`, `第 ${index} 站副标题`, [index <= 8 ? 1068 : 400, enY, index <= 8 ? 313 : 277, 23], `${prefix}/站点副标题`, state);
}
add('current-badge', '本站提示白字', [792, 865, 163, 25], '*/右栏站点列表[6]/*/本站提示文字', 'current');
add('time-value', '剩余分钟数', [70, 499, 61, 29], '*/左栏站点列表[9]/*/预计分钟文字', 'normal');
add('transfer-badge', '换乘线路号文字', [179, 569, 30, 24], '*/左栏站点列表[10]/*/换乘线路列表[1]/换乘线路号', 'normal');
add('legend-time', '图例时间说明', [588, 1098, 402, 26], '*/时间近似说明');
add('legend-transfer', '图例换乘说明', [1004, 1098, 132, 26], '*/换乘图例文字');
add('legend-passed', '图例过站说明', [1182, 1098, 89, 26], '*/过站图例文字');
add('legend-current', '图例本站说明', [1310, 1098, 95, 26], '*/本站图例文字');
add('service-access-label', '无障碍栏目标题', [160, 1176, 235, 28], '*/无障碍标题');
add('service-access-body', '无障碍正文', [205, 1210, 190, 29], '*/低地板说明');
add('service-fare-label', '票价栏目标题', [590, 1176, 153, 28], '*/票价标题');
add('service-fare-value', '票价金额', [588, 1222, 155, 31], '*/票价金额行');
add('service-fare-body', '票制正文', [557, 1270, 186, 33], '*/票制说明行');
add('service-frequency-label', '发车间隔标题', [888, 1176, 202, 28], '*/发车间隔标题');
add('service-peak-body', '高峰时段正文', [825, 1210, 265, 30], '*/高峰时段行');
add('service-interval-value', '发车间隔数值', [990, 1244, 100, 30], '*/高峰间隔值');
add('service-subtitle', '平峰粗体小标题', [990, 1280, 100, 30], '*/平峰时段标题');
add('service-hours-label', '运营时间标题', [1260, 1176, 176, 28], '*/运营时间标题');
add('service-hours-body', '运营时间正文', [1150, 1241, 286, 32], '*/工作日首末班');
add('footer-customer-label', '客服栏目标题', [385, 1478, 335, 30], '*/客服标题');
add('footer-phone', '客服电话占位', [505, 1518, 216, 46], '*/客服电话文字');
add('footer-contact', '运营信息正文', [250, 1575, 470, 31], '*/运营与更新日期行');
add('footer-live-title', '实时到站标题', [990, 1492, 290, 37], '*/实时到站标题');
add('footer-sms-ar', '短信阿文说明', [808, 1537, 471, 31], '*/短信查询阿文说明');
add('footer-sms-en', '短信英文说明', [952, 1569, 327, 29], '*/短信查询英文说明', undefined, 'Scan for live arrivals · SMS stop code 2048');
add('footer-qr', '二维码占位标签', [1330, 1527, 40, 29], '*/二维码占位文字', undefined, 'QR');

const ratio = 3200 / 1504;
const pixel = (x, y) => Array.from(pixels.slice((y * 3200 + x) * 4, (y * 3200 + x) * 4 + 3));
const distance = (a, b) => Math.max(...a.map((n, i) => Math.abs(n - b[i])));
const hex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();
const evidence = [];
const approvedRegions = specs.map((spec) => {
  const [x, y, w, h] = spec.roi.map((n) => Math.round(n * ratio));
  const background = pixel(x, y), colors = new Map();
  let left = x + w, top = y + h, right = x, bottom = y, count = 0;
  for (let cy = y; cy < y + h; cy++) for (let cx = x; cx < x + w; cx++) {
    const rgb = pixel(cx, cy);
    if (distance(rgb, background) < 70) continue;
    left = Math.min(left, cx); top = Math.min(top, cy); right = Math.max(right, cx); bottom = Math.max(bottom, cy); count++;
    const color = hex(rgb); colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  assert.ok(count > 30, `${spec.id} 未找到可测文字`);
  const color = [...colors].sort((a, b) => b[1] - a[1])[0][0];
  const sampleRegion = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
  const touches = left <= x || top <= y || right >= x + w - 1 || bottom >= y + h - 1;
  evidence.push({ id: spec.id, roi: { x, y, width: w, height: h }, background: hex(background), color, count, touchesRoiEdge: touches, sampleRegion });
  return { id: spec.id, name: spec.name, targetPathPattern: spec.targetPathPattern, ...(spec.state ? { state: spec.state } : {}), ...(spec.expectedText ? { expectedText: spec.expectedText } : {}),
    sampleRegion, boxKind: 'ink', expectedColor: color, toleranceRatio: { min: 0.8, max: 1.2 }, positionToleranceMm: 2 };
});
// 最长文本按本图 16 个阿文站名的实测墨迹宽度选择，单列锚点避免把它推断成业务状态。
const longest = approvedRegions.filter((r) => /^stop-\d+-ar$/.test(r.id)).sort((a, b) => b.sampleRegion.width - a.sampleRegion.width)[0];
approvedRegions.push({ ...longest, id: 'longest-stop-ar', name: '原图最宽阿文站名', state: 'longestText' });
assert.deepEqual(evidence.filter((e) => e.touchesRoiEdge).map((e) => e.id), [], 'ROI 触边须重新目视复核，不能发布被裁断的墨迹框');
const shapes = [
  ['marker-first', '首站方标', [1395, 496, 30, 31], '*/右栏站点列表[1]/*/首末站方标', 'passed'],
  ['marker-passed', '过站圆标', [1397, 570, 26, 26], '*/右栏站点列表[2]/*/途经站圆标', 'passed'],
  ['marker-current', '本站圆标', [1391, 859, 38, 38], '*/右栏站点列表[6]/*/本站圆标', 'current'],
  ['marker-normal', '普通圆标', [690, 498, 26, 26], '*/左栏站点列表[9]/*/途经站圆标', 'normal'],
  ['marker-terminal', '终点方标', [688, 997, 30, 30], '*/左栏站点列表[16]/*/首末站方标', 'terminal'],
  ['highlight-current', '本站高亮底块', [771, 837, 670, 83], '*/右栏站点列表[6]/本站高亮底块', 'current'],
];
for (const [id, name, roi, targetPathPattern, state] of shapes) {
  const [x, y, width, height] = roi.map((n) => Math.round(n * ratio));
  approvedRegions.push({ id, name, sampleRegion: { x, y, width, height }, targetPathPattern, state, boxKind: 'layout', positionToleranceMm: 2 });
}
const baseline = { sampleWidthPx: 3200, sampleHeightPx: 3600, artboardWidthMm: 800, artboardHeightMm: 900, sampleSha256: hash, complete: false, approvedRegions };
await mkdir(output, { recursive: true });
for (let offset = 0; offset < specs.length; offset += 20) {
  const surface = ck.MakeSurface(1600, 700), canvas = surface.getCanvas(), paint = new ck.Paint();
  canvas.clear(ck.WHITE);
  for (const [index, spec] of specs.slice(offset, offset + 20).entries()) {
    const [x, y, width, height] = spec.roi.map((n) => Math.round(n * ratio));
    const scale = Math.min(380 / (width + 24), 116 / (height + 24));
    const left = index % 4 * 400 + 10, top = Math.floor(index / 4) * 140 + 10;
    canvas.drawImageRectOptions(image, ck.XYWHRect(x - 12, y - 12, width + 24, height + 24), ck.XYWHRect(left, top, (width + 24) * scale, (height + 24) * scale), ck.FilterMode.Linear, ck.MipmapMode.None, paint);
    paint.setStyle(ck.PaintStyle.Stroke); paint.setStrokeWidth(1); paint.setColor(ck.Color(230, 20, 60));
    const b = approvedRegions[offset + index].sampleRegion;
    canvas.drawRect(ck.XYWHRect(left + (b.x - x + 12) * scale, top + (b.y - y + 12) * scale, b.width * scale, b.height * scale), paint);
    paint.setStyle(ck.PaintStyle.Fill); paint.setColor(ck.BLACK);
  }
  const snapshot = surface.makeImageSnapshot();
  await writeFile(join(output, `contact-${offset / 20 + 1}.png`), snapshot.encodeToBytes());
  snapshot.delete(); paint.delete(); surface.dispose();
}
await writeFile(join(output, 'reference.json'), JSON.stringify(baseline, null, 2));
await writeFile(join(output, 'annotation-evidence.json'), JSON.stringify({ source, sha256: hash, provenance: '独立 coding agent 按原图圈定 ROI，像素扫描取前景边界与主色；未用候选尺寸生成参考，未冒充客户审核',
  coordinateSystem: '原图像素；画板 800×900 mm；禁止将墨迹高度当 fontSize',
  limitations: ['覆盖79个文字区域、重复列出的最长阿文项及6个图形几何锚点，清单不完整', '6个图形锚点只测布局几何，图标语义、底色、层级、遮挡与混排仍需独立审核', '颜色使用原图前景主色，与候选文字颜色的差异不代表感知误差', '最长文本是本图墨迹最宽项，不是新数据的压力场景'], evidence }, null, 2));
// 生成标注审查页：叠框及逐项裁切用于检查漏字、混入背景和ROI触边。
const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
const escape = (s) => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const boxes = approvedRegions.map((r) => `<g><title>${escape(r.id+' '+r.name)}</title><rect x="${r.sampleRegion.x}" y="${r.sampleRegion.y}" width="${r.sampleRegion.width}" height="${r.sampleRegion.height}" fill="none" stroke="#e01a46" stroke-width="3"/></g>`).join('');
const cards = approvedRegions.map((r) => `<article><b>${escape(r.id+' · '+r.name)}</b><p>${(r.sampleRegion.width/4).toFixed(2)} × ${(r.sampleRegion.height/4).toFixed(2)} mm · ${r.expectedColor ?? '图形几何'}</p><svg viewBox="${r.sampleRegion.x-8} ${r.sampleRegion.y-8} ${r.sampleRegion.width+16} ${r.sampleRegion.height+16}" width="360" height="90"><use href="#reference-image"/></svg></article>`).join('');
await writeFile(join(output, 'annotation.html'), `<!doctype html><meta charset="utf-8"><title>原图参考标注复核</title><style>body{font:16px system-ui;margin:24px;background:#f2f5f7;color:#16283e}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}article{background:white;padding:16px;border-radius:10px}p{color:#52657a}</style><h1>原图参考标注复核</h1><p>来源 ${hash}；独立原图测量，非客户批准。点击/悬停叠框查看ID；全部未知边界见 annotation-evidence.json。</p><svg viewBox="0 0 3200 3600" width="800"><defs><image id="reference-image" width="3200" height="3600" href="${dataUrl}"/></defs><use href="#reference-image"/>${boxes}</svg><main>${cards}</main>`);
image.delete();
console.log(JSON.stringify({ output, regions: approvedRegions.length, longest: longest.id, roiEdges: evidence.filter((e) => e.touchesRoiEdge).map((e) => e.id) }));
