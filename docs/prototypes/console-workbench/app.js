// 外壳、路由、选择、键盘与浮层。各页的内容在 pages.js，示意数据在 data.js。
const state = { sel: {}, checked: new Set(), record: null };
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmt = (n) => n.toLocaleString('en-US');
const defOf = (id) => DEFS.find((d) => d.id === id);
const count = (cells) => cells.reduce((c, s) => { c[s] += 1; return c; }, { ok: 0, bad: 0, run: 0, wait: 0, stop: 0, total: cells.length });
const pct = (c) => Math.round((c.ok + c.bad) / c.total * 100);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ───────── 小部件 ─────────
const ICONS = {
  search: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>',
  home: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx=".6"/><rect x="9" y="2.5" width="4.5" height="4.5" rx=".6"/><rect x="2.5" y="9" width="4.5" height="4.5" rx=".6"/><rect x="9" y="9" width="4.5" height="4.5" rx=".6"/>',
  res: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5"/>',
  usage: '<path d="M3.5 13V8.5M8 13V3M12.5 13V6"/>',
  admin: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4"/>',
  upload: '<path d="M8 11V3M5 6l3-3 3 3M3 13h10"/>',
  check: '<path d="m3.5 8.4 3 3 6-6.8"/>',
  alert: '<path d="M8 2.6 14 13H2z"/><path d="M8 6.6v3M8 11.2v.1"/>',
  seal: '<circle cx="8" cy="8" r="5.5"/><path d="m5.6 8.2 1.7 1.7 3.2-3.6"/>',
  fail: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.2"/><path d="m6 6 4 4M10 6l-4 4"/>',
  arrow: '<path d="M3 8h10M9.5 4.5 13 8l-3.5 3.5"/>',
  more: '<path d="m4.5 6.5 3.5 3.5 3.5-3.5"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  prev: '<path d="M13 8H3M6.5 4.5 3 8l3.5 3.5"/>',
  tpl: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.6"/><path d="M2.5 6.2h11M6.2 6.2v7.3"/>',
  def: '<path d="M5.6 2.5H4.4a1.2 1.2 0 0 0-1.2 1.2v2.5L2 8l1.2 1.8v2.5a1.2 1.2 0 0 0 1.2 1.2h1.2M10.4 2.5h1.2a1.2 1.2 0 0 1 1.2 1.2v2.5L14 8l-1.2 1.8v2.5a1.2 1.2 0 0 1-1.2 1.2h-1.2"/>',
  ds: '<rect x="2.5" y="3" width="11" height="10" rx="1.5"/><path d="M2.5 6.4h11M2.5 9.7h11M6.4 6.4V13"/>',
  batch: '<rect x="5" y="5" width="8.5" height="8.5" rx="1.4"/><path d="M3 10.6V3.9a1.4 1.4 0 0 1 1.4-1.4H11"/>',
  bolt: '<path d="M8.8 1.8 3.6 9h4l-.9 5.2L12.4 7h-4z"/>',
  panel: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6.2 3v10"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.4"/><path d="M10.5 3.3A1.3 1.3 0 0 0 9.2 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 .8 1.2"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  // 每个数据定义一个图形，代替重复出现的名字
  'route-sign': '<rect x="1.5" y="4.5" width="13" height="7" rx="1.3"/><path d="M4.5 8h.01M8 8h.01M11.5 8h.01"/>',
  stop: '<circle cx="8" cy="8" r="2.2"/><path d="M1.5 8h4.3M10.2 8h4.3"/>',
  badge: '<rect x="3.5" y="3.5" width="9" height="10.5" rx="1.3"/><path d="M8 1.5v2M6 11.4h4"/><circle cx="8" cy="7.6" r="1.5"/>',
  session: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  'price-tag': '<path d="M2.5 7.9V3.5a1 1 0 0 1 1-1h4.4a1 1 0 0 1 .7.3l5 5a1 1 0 0 1 0 1.4l-4.4 4.4a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1-.3-.7z"/><path d="M5.6 5.6h.01"/>',
  // 字段类型
  text: '<path d="M4 4.5h8M8 4.5V12"/>',
  number: '<path d="M6.3 3 5.1 13M10.9 3 9.7 13M3.3 6.2h10M2.7 9.8h10"/>',
  time: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  bool: '<rect x="1.8" y="4.8" width="12.4" height="6.4" rx="3.2"/><circle cx="10.8" cy="8" r="1.5"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1"/><path d="m2.5 11 3.5-3.5 3 3 2-2 2.5 2.5"/>',
  list: '<path d="M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01"/>',
};
const ic = (n) => `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const glyph = (n, size = '') => `<span class="glyph ${size}">${ic(n)}</span>`;
const spin = () => '<svg class="spin" width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="6" r="4.5" opacity=".22"/><path class="arc" d="M6 1.5A4.5 4.5 0 0 1 10.5 6"/></svg>';
/** 状态：通过只留一个对勾，例外才写字。 */
const st = (k, t = '') => `<span class="st ${k}">${k === 'ok' ? ic('check') : k === 'run' ? spin() : '<i></i>'}${t}</span>`;
const ring = (p) => `<svg class="ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6"/><circle class="fg" cx="8" cy="8" r="6" pathLength="100" stroke-dasharray="${p} 100"/></svg>`;
const LOGO = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><rect width="24" height="24" rx="5" fill="#2440e0"/><path d="M5 9h14M5 15h14" stroke="#ff8a00"/><path d="M9 5v14M15 5v14" stroke="#fff"/><path d="M13 9h4M7 15h4" stroke="#ff8a00" stroke-linecap="butt"/></svg>';

// 没有价签的真实渲染图，这一张是手画的示意。
const BARCODE = [3, 1, 2, 1, 1, 3, 1, 2, 2, 1, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 3, 1, 2].reduce((a, w, i) => { if (i % 2 === 0) a.out += `<rect x="${a.x}" y="286" width="${w * 2.4}" height="58"/>`; a.x += w * 2.4; return a; }, { x: 438, out: '' }).out;
const PRICE = `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400" font-family="Microsoft YaHei UI, PingFang SC, sans-serif"><rect width="600" height="400" fill="#fff"/><rect width="600" height="64" fill="#d6401f"/><text x="28" y="43" fill="#fff" font-size="26" font-weight="700">周末特惠</text><text x="572" y="42" fill="#fff" font-size="18" text-anchor="end" opacity=".85">11.08 – 11.09</text><text x="28" y="124" font-size="36" font-weight="700" fill="#101216">冻干咖啡 12 颗装</text><text x="28" y="162" font-size="19" fill="#4b5262">· 三秒即溶　· 中度烘焙</text><text x="28" y="298" font-size="40" font-weight="700" fill="#d6401f">¥</text><text x="64" y="302" font-size="112" font-weight="800" fill="#d6401f" letter-spacing="-3">39</text><text x="196" y="302" font-size="52" font-weight="800" fill="#d6401f">.90</text><text x="290" y="300" font-size="22" fill="#5f6675">/ 盒</text><text x="28" y="356" font-size="20" fill="#8a919e" text-decoration="line-through">原价 ¥ 49.90</text><g fill="#101216">${BARCODE}</g><text x="572" y="366" font-size="13" text-anchor="end" fill="#4b5262" font-family="Consolas, monospace">6901234510000</text></svg>`)}`;
const art = (n, cls = '') => `<img ${cls ? `class="${cls}" ` : ''}src="${n === 'svg:price' ? PRICE : IMG(n)}" alt="">`;
/** 看样：图的四角带裁切线，像一张印前的样张。 */
const proof = (n, shape, h) => `<span class="proof ${shape === 'wide' ? 'wide' : ''}"${h ? ` style="--h:${h}px"` : ''}>${art(n)}</span>`;
/**
 * 织机：进行中的批次画成一块正在织的布。经线竖着，每个渲染项是一根纬线；
 * 出完的织进去，正在出的那根有梭子在走，排队的还只是经线。相邻两根纬线错开一根经线，是平纹。
 */
function loomSvg(cells) {
  const pitch = Math.min(5.3, 122 / Math.max(cells.length - 1, 1));
  const warp = Array.from({ length: 24 }, (_, k) => `M${16 + k * 8} 9v134`).join('');
  const rows = cells.map((s, i) => { const y = 15 + i * pitch; return `<g class="w ${s}"><line x1="12" x2="204" y1="${y}" y2="${y}" stroke-dashoffset="${i % 2 ? 3.25 : 11.25}"/><rect class="sh" x="5" y="${y - 3}" width="14" height="6" rx="3"/></g>`; }).join('');
  return `<svg class="loom" viewBox="0 0 216 152" aria-hidden="true"><path class="warp-l" d="${warp}"/><g data-mcells>${rows}</g><rect class="beam" x="4" y="4" width="208" height="5" rx="2.5"/><rect class="beam" x="4" y="143" width="208" height="5" rx="2.5"/></svg>`;
}

/** 台账：所有列表页共用。rows 是 { id, cls?, cells[] }，每一格各占一列。 */
function ledger(cols, heads, rows, sel, _name, foot = '') {
  return `<div class="ledger" style="--cols:${cols}"><div class="glide"></div><div class="lh">${heads.map((h) => `<div class="${h.c ?? ''}">${h.t ?? h}</div>`).join('')}</div>${rows.map((r) => `<div class="lr ${r.cls ?? ''} ${r.id === sel ? 'sel' : ''}" data-row="${r.id}">${r.cells.map((c) => `<div class="lc">${c}</div>`).join('')}</div>`).join('')}${foot}</div>`;
}
const keysNote = (extra = '打开') => `<div class="footnote"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>${extra}</span><span><kbd>/</kbd>筛选</span></div>`;
/** 问题清单的一条：级别与说明一行，字段与元素路径一行；元素路径只留末三段，全文在悬停提示里。 */
const problemHtml = (p, attrs = '') => {
  const segs = (p.el ?? '').split('/').filter(Boolean), tail = segs.slice(-3);
  const el = segs.length ? `<span class="el cell-trunc" title="元素路径：${p.el}">${segs.length > 3 ? '<i>…</i>' : ''}${tail.map((s, i) => (i === tail.length - 1 ? `<b>${s}</b>` : s)).join('<i>/</i>')}</span>` : '';
  return `<div class="problem ${p.hint ? 'tip' : ''}" ${attrs}><div class="p1"><span class="lv">${p.lv}</span><span>${p.text}</span></div><div class="p2"><code>${p.path}</code>${el}</div></div>`;
};
function weft(cells) {
  const c = count(cells), seg = (k, n) => `<i class="${k}" style="flex-grow:${n};${n ? '' : 'display:none'}"></i>`;
  return `<div class="weft">${seg('ok', c.ok)}${seg('bad', c.bad)}${seg('run', c.run)}${seg('rest', c.wait + c.stop)}</div>`;
}

// ───────── 路由 ─────────
const view = $('#view'), scrim = $('#scrim'), drawer = $('#drawer'), palette = $('#palette'), keys = $('#keys');
let current = null, route = null;
function parse(hash = location.hash) {
  const [p, qs = ''] = hash.replace(/^#\/?/, '').split('?');
  const path = decodeURIComponent(p).split('/').filter(Boolean);
  return { path: PAGES[path[0]] ? path : ['overview'], q: Object.fromEntries(new URLSearchParams(qs)) };
}
const toHash = (r) => { const s = new URLSearchParams(r.q).toString(); return `#/${r.path.join('/')}${s ? `?${s}` : ''}`; };
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const OVERLAY_KEYS = ['publish', 'cell', 'rec', 'k', 'keys'];

function render() {
  route = parse();
  const r = route, key = r.path[0];
  if (r.q.sel) state.sel[key] = r.q.sel;
  if (r.q.field) state.sel.fields = r.q.field;
  if (r.q.stop) state.stop = Number(r.q.stop);
  if (key === 'definitions' && r.path[1] && state.fieldsOf !== r.path[1]) { state.fieldsOf = r.path[1]; if (!r.q.field) state.sel.fields = (defOf(r.path[1]) ?? DEFS[0]).fields[0][0]; }
  if (key !== 'datasets' || r.path[1]) state.checked.clear();
  closeOverlays(true);
  document.body.classList.toggle('shooting', 'shot' in r.q);
  if ('rail' in r.q) state.railMin = r.q.rail === 'min';
  else if (state.railMin == null) { let s = null; try { s = localStorage.getItem('rw-rail'); } catch { /* 存不了就不记 */ } state.railMin = !('shot' in r.q) && s === 'min'; }
  document.body.classList.toggle('rail-min', state.railMin);
  current = PAGES[key](r);
  view.innerHTML = current.body + (current.peek ? `<aside class="peek" id="peek" ${current.peekW ? `style="width:${current.peekW}px"` : ''}></aside>` : '');
  renderRail(); renderTop(); renderScenes();
  renderPeek(); placeGlides(true); placeSegs(true);
  $('.lr.sel, .tcard.sel, .res.sel', view)?.scrollIntoView({ block: 'nearest' });
  current.after?.();
  if (r.q.k) openPalette(r.q.k === '1' ? '' : r.q.k);
  if (r.q.keys) keys.classList.add('on');
}

function renderRail() {
  const k = route.path[0], on = (id) => (k === id || (id === 'batches' && k === 'records') ? 'on' : '');
  const c = count(BATCHES[0].cells), live = c.run || c.wait;
  const item = (id, icon, label, em = '') => `<a class="nav-item ${on(id)}" href="#/${id}" data-tip="${label}">${ic(icon)}<span class="lb">${label}</span>${em}</a>`;
  // 四个工位是串在经线上的珠子；有批次在出图时，「出图」那一颗外面有一段弧在转，数据集到出图那一段线在走
  const orbit = '<svg class="orbit" viewBox="0 0 34 34" aria-hidden="true"><circle cx="17" cy="17" r="15.5" pathLength="100" stroke-dasharray="24 76"/></svg>';
  const station = (id, icon, label, em, busy) => `<a class="station ${on(id)} ${busy ? 'busy' : ''}" href="#/${id}" data-tip="${label}"><span class="bead">${ic(icon)}${busy ? orbit : ''}</span><span class="lb">${label}</span><em class="lb">${em}</em></a>`;
  const warp = `<svg class="warp" width="2" height="108" viewBox="0 0 2 108" aria-hidden="true"><path d="M1 0v108"/>${live ? '<path class="run" d="M1 72v36"/>' : ''}</svg>`;
  const used = MONTH_USED / QUOTA * 100;
  $('#rail').innerHTML = `<div class="brand"><a class="logo" href="#/overview" title="总览">${LOGO}</a><b class="lb">RenderWeave</b><button class="icon-btn rail-toggle" data-act="rail" data-tip="展开左栏  [" title="收起或展开左栏  [">${ic('panel')}</button></div>
    <button class="rail-search" data-act="palette" data-tip="搜索与跳转  Ctrl K">${ic('search')}<span class="lb">搜索与跳转</span><kbd class="lb">Ctrl K</kbd></button>
    ${item('overview', 'home', '总览', '<em class="todo-n" title="等你处理">3</em>')}
    <div class="nav-label"><span class="lb">出图流水</span></div>
    <div class="flow">${warp}${station('definitions', 'def', '数据定义', DEFS.length)}${station('templates', 'tpl', '模板', TEMPLATES.length)}${station('datasets', 'ds', '数据集', DATASETS.length)}${station('batches', 'batch', '出图', live ? `<span id="rail-pct">${pct(c)}%</span>` : '', live)}</div>
    <div class="nav-label"><span class="lb">支撑</span></div>
    ${item('resources', 'res', '资源', `<em class="lb">${RESOURCES.length}</em>`)}${item('usage', 'usage', '用量')}${item('admin', 'admin', '管理')}
    <div class="rail-foot"><a class="quota" href="#/usage" data-tip="本月 ${fmt(MONTH_USED)} / ${fmt(QUOTA)} 张" title="本月正式出图，19 天后重置"><svg class="q-ring" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle class="fg" cx="12" cy="12" r="9" pathLength="100" stroke-dasharray="${used} 100"/></svg><div class="q-full lb"><b>${fmt(MONTH_USED)}</b><span>本月 · 额度 ${fmt(QUOTA)}</span></div></a>
      <div class="me" data-tip="admin · 示例科技"><span class="avatar">管<i class="conn" title="已连接"></i></span><div class="who lb"><b>admin</b><span>示例科技 · 客户管理员</span></div><button class="icon-btn lb" data-toast="切换租户（示意）" title="切换租户">${ic('more')}</button></div></div>`;
}
function toggleRail() {
  state.railMin = !state.railMin;
  try { localStorage.setItem('rw-rail', state.railMin ? 'min' : 'full'); } catch { /* 存不了就不记 */ }
  if (route.q.rail) { delete route.q.rail; history.replaceState(null, '', toHash(route)); }
  const b = document.body; b.classList.add('rail-anim'); b.classList.toggle('rail-min', state.railMin);
  clearTimeout(toggleRail.t); toggleRail.t = setTimeout(() => b.classList.remove('rail-anim'), 320);
}
/** 分段控件只有一块滑块，换选项时滑过去。 */
function placeSegs(instant) {
  $$('.seg').forEach((seg) => {
    let th = $('.thumb', seg); if (!th) { th = document.createElement('i'); th.className = 'thumb'; seg.prepend(th); }
    const on = $('button.on', seg);
    if (instant) th.style.transition = 'none';
    th.style.opacity = on ? 1 : 0;
    if (on) { th.style.width = `${on.offsetWidth}px`; th.style.height = `${on.offsetHeight}px`; th.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`; }
    if (instant) { void th.offsetWidth; th.style.transition = ''; }
  });
}
function renderTop() {
  const b = BATCHES[0], c = count(b.cells), live = c.run || c.wait, n = current.crumbs.length;
  $('#top').innerHTML = `<div class="crumbs">${current.crumbs.map(([t, h], i) => `${i ? '<i>/</i>' : ''}${i === n - 1 ? `<b>${t}</b>` : h ? `<a href="${h}">${t}</a>` : `<span>${t}</span>`}`).join('')}</div><div class="spacer"></div>
    ${live ? `<a class="running" href="#/batches?sel=${b.id}" title="正在出图的批次">${ring(pct(c))}<span>${b.name}</span><b class="mono" id="top-pct">${pct(c)}%</b></a>` : ''}
    <button class="icon-btn" data-act="keys" title="快捷键 ?"><kbd>?</kbd></button>`;
}

// ───────── 选择：就地换选中行，只重画速览 ─────────
const selKey = () => (current.list === 'stops' ? 'stop' : current.list === 'fields' ? 'field' : 'sel');
const selId = () => (current.list === 'stops' ? String(state.stop) : state.sel[current.list]);
function renderPeek() {
  const peek = $('#peek'); if (!peek) return;
  const id = selId();
  peek.innerHTML = id == null ? '<div class="empty-peek">这个筛选下没有东西。</div>' : `<div class="peek-body">${current.peek(id)}</div>`;
  peek.scrollTop = 0; placeSegs(true);
}
function placeGlides(instant) {
  $$('.ledger', view).forEach((l) => {
    const g = $('.glide', l), row = $('.lr.sel:not([hidden])', l);
    if (instant) g.style.transition = 'none';
    g.style.height = row ? `${row.offsetHeight}px` : '0';
    if (row) g.style.transform = `translateY(${row.offsetTop}px)`;
    if (instant) { void g.offsetHeight; g.style.transition = ''; }
  });
}
function select(id) {
  if (!current.list || id === selId()) return;
  if (current.list === 'stops') state.stop = Number(id); else state.sel[current.list] = id;
  $$('[data-row].sel', view).forEach((el) => el.classList.remove('sel'));
  $$('[data-row]', view).filter((el) => el.dataset.row === id).forEach((el) => el.classList.add('sel'));
  placeGlides(); renderPeek();
  if (current.list === 'stops') placeStop();
  route.q[selKey()] = id; history.replaceState(null, '', toHash(route));
}
function move(d) {
  const rows = $$('[data-row]', view).filter((el) => !el.hidden); if (!rows.length) return;
  const i = rows.findIndex((el) => el.dataset.row === selId()), next = rows[clamp(i + d, 0, rows.length - 1)];
  select(next.dataset.row); next.scrollIntoView({ block: 'nearest' });
}

// ───────── 浮层 ─────────
let toastTimer;
function toast(msg) { const t = $('#toast'); t.innerHTML = `${ic('check')}<span></span>`; t.lastChild.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600); }
function openDrawer(html) { drawer.innerHTML = html; drawer.scrollTop = 0; scrim.classList.add('on'); drawer.classList.add('on'); placeSegs(true); }
function closeOverlays(keepHash) {
  [scrim, drawer, palette, keys].forEach((el) => el.classList.remove('on'));
  state.record = null; $$('.cell.cur').forEach((c) => c.classList.remove('cur'));
  if (keepHash || !route || !OVERLAY_KEYS.some((k) => k in route.q)) return;
  OVERLAY_KEYS.forEach((k) => delete route.q[k]); history.replaceState(null, '', toHash(route)); renderScenes();
}
const overlayOpen = () => [drawer, palette, keys].some((el) => el.classList.contains('on'));

// 搜索与跳转
let palItems = [], palIdx = 0;
const PAL_PAGES = [['总览', '#/overview'], ['数据定义', '#/definitions'], ['模板', '#/templates'], ['数据集', '#/datasets'], ['出图 · 批次', '#/batches'], ['出图 · 出图记录', '#/records'], ['资源', '#/resources'], ['用量', '#/usage'], ['管理', '#/admin']].map(([n, h]) => ({ g: '前往', k: '页面', n, h }));
const PAL_ACTS = [{ n: '新建数据集', t: '新建数据集（示意）' }, { n: '批量出图…', t: '批量出图…（示意：选模板与数据集）' }, { n: '上传资源', t: '选择文件上传（示意）' }, { n: '发布 线路牌 v3…', h: '#/definitions/route-sign?publish=1' }, { n: '收起或展开左栏', a: 'rail', r: '[' }].map((a) => ({ g: '动作', k: '动作', ...a }));
const PAL_IC = { 动作: 'bolt', 页面: 'arrow', 数据定义: 'def', 模板: 'tpl', 数据集: 'ds', 批次: 'batch', 资源: 'res' };
function palSource() {
  return [...PAL_ACTS, ...PAL_PAGES,
    ...DEFS.map((d) => ({ g: '数据定义', k: '数据定义', n: d.display, id: d.name, h: `#/definitions?sel=${d.id}`, r: d.ver })),
    ...TEMPLATES.map((t) => ({ g: '模板', k: '模板', n: t.name, id: t.id, h: `#/templates?sel=${t.id}`, r: t.size })),
    ...DATASETS.map((d) => ({ g: '数据集', k: '数据集', n: d.name, id: d.id, h: `#/datasets?sel=${d.id}`, r: defOf(d.def).display })),
    ...BATCHES.map((b) => ({ g: '批次', k: '批次', n: b.name, id: b.id, h: `#/batches?sel=${b.id}`, r: b.at })),
    ...RESOURCES.map(([id, kind]) => ({ g: '资源', k: '资源', n: `res:${id}`, h: `#/resources?sel=${id}`, r: kind }))];
}
function renderPal(q) {
  q = q.trim().toLowerCase();
  const all = palSource();
  const groups = q ? [...new Set(all.map((x) => x.g))].map((g) => [g, all.filter((x) => x.g === g && `${x.n} ${x.id ?? ''}`.toLowerCase().includes(q)).slice(0, 5)])
    : [['最近', [all.find((x) => x.id === 'ds-m402-wanguocheng'), all.find((x) => x.id === '线路牌'), all.find((x) => x.id === 'b-1112-01')]], ['动作', PAL_ACTS], ['前往', PAL_PAGES]];
  palItems = groups.flatMap(([, items]) => items); palIdx = 0;
  let i = 0;
  $('#pal-list').innerHTML = palItems.length ? groups.filter(([, items]) => items.length).map(([g, items]) => `<div class="pal-g">${g}</div>${items.map((x) => `<div class="pal-i ${i === 0 ? 'on' : ''}" data-i="${i++}" title="${x.k}">${glyph(PAL_IC[x.k], 'sm')}<span>${x.n}</span>${x.id ? `<code>${x.id}</code>` : ''}<span class="r">${x.r ?? ''}</span></div>`).join('')}`).join('')
    : '<div class="empty-peek">没有找到。换个说法，或者按 ID 找。</div>';
}
function openPalette(q = '') {
  [drawer, keys].forEach((el) => el.classList.remove('on'));
  palette.innerHTML = `<div class="pal-in">${ic('search')}<input id="pal-q" placeholder="找对象，或者说要做的事" autocomplete="off"><kbd>Esc</kbd></div><div class="pal-list" id="pal-list"></div><div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>↵</kbd>打开</span></div>`;
  scrim.classList.add('on'); palette.classList.add('on');
  const input = $('#pal-q'); input.value = q; renderPal(q); input.focus();
}
function palMove(d) {
  if (!palItems.length) return;
  palIdx = clamp(palIdx + d, 0, palItems.length - 1);
  $$('.pal-i', palette).forEach((el, i) => { el.classList.toggle('on', i === palIdx); if (i === palIdx) el.scrollIntoView({ block: 'nearest' }); });
}
function palRun(i = palIdx) { const x = palItems[i]; if (!x) return; closeOverlays(); if (x.a) act(x.a); else if (x.h) go(x.h); else toast(x.t); }

// ───────── 进行中的批次：每 4 秒出完一张 ─────────
const LIVE = BATCHES[0];
function updateWeft(el, cells) {
  const c = count(cells);
  [['ok', c.ok], ['bad', c.bad], ['run', c.run], ['rest', c.wait + c.stop]].forEach(([k, n]) => { const i = $(`.${k}`, el); i.style.flexGrow = n; i.style.display = n ? '' : 'none'; });
}
function tick() {
  const i = LIVE.cells.indexOf('run'); if (i < 0) return;
  LIVE.cells[i] = 'ok';
  const w = LIVE.cells.indexOf('wait'); if (w >= 0) LIVE.cells[w] = 'run';
  const c = count(LIVE.cells), done = !c.run && !c.wait;
  if (done) LIVE.dur = '4 分 36 秒';
  $$('#rail-pct, #top-pct, [data-live="pct"]').forEach((el) => { el.textContent = `${pct(c)}%`; });
  $$('.ring .fg').forEach((el) => el.setAttribute('stroke-dasharray', `${pct(c)} 100`));
  $$('[data-mcells] .w').forEach((el, n) => el.setAttribute('class', `w ${LIVE.cells[n]}`));
  $$('[data-live="done"]').forEach((el) => { el.textContent = c.ok + c.bad; });
  const row = $(`.lr[data-row="${LIVE.id}"]`, view);
  if (row && current.list === 'batches') {
    if (done) row.innerHTML = batchRow(LIVE).map((x) => `<div class="lc">${x}</div>`).join('');
    else { updateWeft($('.weft', row), LIVE.cells); $('.prog span', row).textContent = `${c.ok + c.bad}/${c.total}`; }
  }
  const cells = $(`[data-cells="${LIVE.id}"]`);
  if (cells) {
    if (done) renderPeek();
    else { $$('.cell', cells).forEach((el, n) => { el.className = `cell ${LIVE.cells[n]}${el.classList.contains('cur') ? ' cur' : ''}`; }); $('[data-live="counts"]').textContent = batchCounts(LIVE); }
  }
  if (done) { renderRail(); renderTop(); if (route.path[0] === 'overview') render(); toast(`批次「${LIVE.name}」出完了：${c.ok} 张完成，${c.bad} 项失败`); }
}

// ───────── 原型自己的场景条 ─────────
const SCENES = [['总览', '#/overview'], ['数据定义', '#/definitions'], ['· 编辑', '#/definitions/route-sign'], ['· 发布', '#/definitions/route-sign?publish=1'], ['模板', '#/templates'], ['数据集', '#/datasets'], ['· 多选', '#/datasets?def=route-sign&checked=1'],
  ['· 编辑', '#/datasets/ds-m402-wanguocheng'], ['出图', '#/batches'], ['· 出图记录', '#/batches?cell=5'], ['全部记录', '#/records'], ['用量', '#/usage'], ['资源', '#/resources'], ['管理', '#/admin'], ['搜索', '#/overview?k=M402']];
const sceneSig = (r) => `${r.path.join('/')}|${['publish', 'checked', 'cell', 'k'].filter((k) => r.q[k]).join()}`;
function renderScenes() {
  const now = sceneSig(route);
  $('#scenes').innerHTML = `<span>原型</span>${SCENES.map(([t, h]) => `<a href="${h}" class="${sceneSig(parse(h)) === now ? 'on' : ''}">${t}</a>`).join('')}<a data-act="reset" title="批次进度回到开头" style="cursor:pointer">↺</a>`;
}

// ───────── 事件 ─────────
function act(name) {
  if (name === 'palette') openPalette();
  else if (name === 'rail') toggleRail();
  else if (name === 'keys') keys.classList.toggle('on');
  else if (name === 'close') closeOverlays();
  else if (name === 'publish') openPublish(defOf(route.path[1]) ?? DEFS[0]);
  else if (name === 'uncheck') { state.checked.clear(); $$('.check.on', view).forEach((el) => el.classList.remove('on')); renderBulk(); }
  else if (name === 'reset') location.reload();
  else if (name === 'replay') {
    const note = $('#replay-note'), stage = $('.stage', drawer); note.innerHTML = `${spin()} 正在只用这条记录重新渲染…`;
    stage?.classList.remove('scanning'); void stage?.offsetWidth; stage?.classList.add('scanning');
    setTimeout(() => { stage?.classList.remove('scanning'); note.innerHTML = '<span class="verdict"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="m4.8 8.3 2.2 2.2 4.2-4.8"/></svg>逐字节一致</span><span class="faint">重新渲染 1.8 秒 · 构建标识相同</span>'; }, 900);
  }
}
const onlyOn = (el) => { [...el.parentElement.children].forEach((s) => s.classList.toggle('on', s === el)); placeSegs(); };
document.addEventListener('click', (e) => {
  const at = (s) => e.target.closest(s);
  let x;
  if ((x = at('[data-toast]'))) toast(x.dataset.toast);
  if ((x = at('[data-act]'))) { act(x.dataset.act); if (x.tagName !== 'A') return; }
  if (e.target === scrim) return closeOverlays();
  if ((x = at('.pal-i'))) return palRun(Number(x.dataset.i));
  if ((x = at('[data-go]'))) return go(x.dataset.go);
  if ((x = at('[data-view]'))) { state.tplView = x.dataset.view; return render(); }
  if ((x = at('[data-color]'))) { state.tplColor = x.dataset.color; renderPeek(); const img = $('.tcard[data-row="route-sign-h"] img, .lr[data-row="route-sign-h"] img', view); if (img) img.src = IMG(x.dataset.color); return; }
  if ((x = at('[data-toggle]'))) return x.classList.toggle('on');
  if ((x = at('[data-check]'))) { const id = x.dataset.check; if (state.checked.has(id)) state.checked.delete(id); else state.checked.add(id); x.classList.toggle('on'); return renderBulk(); }
  if ((x = at('[data-step]'))) return stepRecord(Number(x.dataset.step));
  if ((x = at('[data-cell], [data-cell-go]'))) return openRecord(BATCHES.find((b) => b.id === state.sel.batches), Number(x.dataset.cell ?? x.dataset.cellGo));
  if ((x = at('[data-rec]'))) return openRecord(null, 0, DATASETS.find((d) => d.id === x.dataset.rec));
  if ((x = at('#canvas'))) { const b = x.getBoundingClientRect(), i = clamp(Math.round(((e.clientX - b.left) / b.width * 2000 - 88) / 53.6), 0, STOPS.length - 1); select(String(i)); return $('.stops .lr.sel')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  if ((x = at('.seg button, button.chip, .swatches button, .tabs a:not([href])'))) return onlyOn(x);
  if ((x = at('[data-row]')) && !at('a, button, input')) select(x.dataset.row);
});
document.addEventListener('dblclick', (e) => { const x = e.target.closest('[data-row]'); if (x && !e.target.closest('a, button, input, .check')) current.open?.(x.dataset.row); });
function stepRecord(d) { if (!state.record) return; const { batch, i } = state.record, n = batch.cells.length; openRecord(batch, (i + d + n) % n); }

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.matches('#pal-q')) renderPal(t.value);
  else if (t.matches('[data-filter]')) { const q = t.value.trim().toLowerCase(); $$('[data-row], .rec', view).forEach((el) => { el.hidden = Boolean(q) && !el.textContent.toLowerCase().includes(q); }); placeGlides(); }
  else if (t.matches('[data-redraw]')) { const r = $('#redraw'); r.classList.add('on'); clearTimeout(r.timer); r.timer = setTimeout(() => r.classList.remove('on'), 420); }
});
document.addEventListener('mouseover', (e) => { const row = e.target.closest('.stops [data-row]'); if (row) hlStop(Number(row.dataset.row)); });
document.addEventListener('mouseout', (e) => { if (e.target.closest('.stops [data-row]') && !e.relatedTarget?.closest?.('.stops [data-row]')) hlStop(state.stop); });

document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return palette.classList.contains('on') ? closeOverlays() : openPalette(); }
  if (palette.classList.contains('on')) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); palMove(e.key === 'ArrowDown' ? 1 : -1); } else if (e.key === 'Enter') palRun(); else if (e.key === 'Escape') closeOverlays();
    return;
  }
  if (e.key === 'Escape') { if (typing) document.activeElement.blur(); else if (overlayOpen()) closeOverlays(); else if (state.checked.size) act('uncheck'); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (drawer.classList.contains('on')) { if (e.key === 'ArrowLeft') stepRecord(-1); if (e.key === 'ArrowRight') stepRecord(1); return; }
  const k = e.key;
  if (k === '/') { const f = $('[data-filter]', view); if (f) { e.preventDefault(); f.focus(); } }
  else if (k === '?') keys.classList.toggle('on');
  else if (k === '[') toggleRail();
  else if (k === 'ArrowDown' || k === 'j' || k === 'ArrowRight') { e.preventDefault(); move(1); }
  else if (k === 'ArrowUp' || k === 'k' || k === 'ArrowLeft') { e.preventDefault(); move(-1); }
  else if (k === 'Enter') current.open?.(selId());
  else if (k === ' ' && current.list === 'datasets') { e.preventDefault(); $('.lr.sel .check', view)?.click(); }
  else if (k === 'n' || k === 'N') $('.head .btn.primary', view)?.click();
});

keys.innerHTML = `<div class="sec-t" style="margin-bottom:6px"><b>快捷键</b></div>${[['搜索与跳转', 'Ctrl K'], ['筛选这一页', '/'], ['上一个 / 下一个', '↑ ↓'], ['打开', '↵'], ['勾选（数据集）', '空格'], ['新建', 'N'], ['收起 / 展开左栏', '['], ['出图记录里上一张 / 下一张', '← →'], ['关掉浮层、取消勾选', 'Esc']].map(([a, b]) => `<div><span>${a}</span><span>${b.split(' ').map((x) => `<kbd>${x}</kbd>`).join('')}</span></div>`).join('')}`;
window.addEventListener('hashchange', render);
function boot() { render(); setInterval(tick, 4000); }
