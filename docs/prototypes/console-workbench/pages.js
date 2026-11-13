// 各页的呈现。每个函数返回 { crumbs, body, peek?, after? }；外壳、路由、键盘与浮层在 app.js。
const PAGES = {};
const ROOT_DEFS = ['route-sign', 'badge', 'price-tag'];
const SPARK = { 'route-sign': [620, 540, 196, 1840, 560, 720, 250, 182, 2194, 0, 96, 2018], badge: [0, 0, 0, 0, 128, 0, 0, 0, 0, 2816, 0, 0], 'price-tag': [0, 0, 0, 0, 0, 0, 0, 320, 0, 0, 0, 0] };
const DAYS = SPARK['route-sign'].map((v, i) => v + SPARK.badge[i] + SPARK['price-tag'][i]);

// ───────── 各页共用的小件 ─────────
const tplOf = (id) => TEMPLATES.find((t) => t.id === id);
/** 改动记号：实心菱形是新增，空心菱形是改动。 */
const dia = (k = '') => `<i class="dia ${k}"></i>`;
const draftPill = (d) => (d.draft === 'changed' ? `<span class="draft">${dia()}${d.changes} 处改动</span>` : d.draft === 'pending' ? `<span class="draft wait">${dia('mod')}待批准</span>` : '');
const delta = (chg) => (chg ? `<span class="delta ${chg}">${chg === 'add' ? '新增' : '改动'}</span>` : '');
/** 图形 + 数字，代替「模板 2 · 数据集 24」这样的字。 */
const pair = (icon, n, title) => `<span class="pair" title="${title}">${ic(icon)}<b>${n}</b></span>`;
const ty = (t) => `<span class="ty">${ic(t)}${TYPE[t][1]}</span>`;
const mini = (n) => `<span class="mini">${art(n)}</span>`;
const GO = `<span class="go">${ic('arrow')}</span>`;
const GRIP = '<svg class="grip" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="3" r="1.1"/><circle cx="6" cy="3" r="1.1"/><circle cx="2" cy="7" r="1.1"/><circle cx="6" cy="7" r="1.1"/><circle cx="2" cy="11" r="1.1"/><circle cx="6" cy="11" r="1.1"/></svg>';
const peekHead = (icon, kind, id, title, acts = '', extra = '') => `<div class="peek-head"><div class="ph">${glyph(icon, 'lg')}<div class="ph-t"><div class="peek-kind"><span>${kind}</span>${id ? `<code>${id}</code>` : ''}${extra}</div><h2>${title}</h2></div></div>${acts ? `<div class="peek-acts">${acts}</div>` : ''}</div>`;

// ───────── 总览 ─────────
PAGES.overview = () => {
  const live = BATCHES[0], lc = count(live.cells), running = lc.run || lc.wait;
  const link = (run) => `<svg class="link ${run ? 'run' : ''}" width="24" height="12" viewBox="0 0 24 12" aria-hidden="true"><path class="l" d="M1 6h19"/><path d="m17 2.5 3.5 3.5L17 9.5"/></svg>`;
  const lanes = ROOT_DEFS.map((id) => {
    const d = defOf(id), ds = DATASETS.filter((x) => x.def === id), tp = TEMPLATES.filter((t) => t.def === id);
    const bad = ds.filter((x) => x.problems).length, old = ds.filter((x) => x.old).length, batch = BATCHES.find((b) => b.def === id), c = count(batch.cells), busy = c.run || c.wait;
    const max = Math.max(...SPARK[id], 1), sum = SPARK[id].reduce((a, b) => a + b, 0);
    return `<div class="lane">
      <a href="#/definitions?sel=${id}">${glyph(id, 'lg')}<div class="dt"><div class="dn">${d.display}</div><div class="dm"><span class="ver">${d.ver}</span>${draftPill(d)}</div></div></a>
      <a href="#/templates?def=${id}">${link()}<div class="tps">${tp.map((t) => `<div class="tp">${mini(t.art)}<b class="cell-trunc">${t.name}</b>${t.upgrade ? `<span class="ver up" title="基准还是 ${t.base}，可以升级到 ${t.upgrade}">${t.base}</span>` : ''}</div>`).join('')}</div></a>
      <a class="m-ds" href="#/datasets?def=${id}">${link()}<div class="big">${ds.length}</div><div class="side">
        <div class="dist-w"><div class="dist" title="通过 ${ds.length - bad - old} · 有问题 ${bad} · 可迁移 ${old}"><i class="ok" style="flex-grow:${ds.length - bad - old}"></i>${bad ? `<i class="bad" style="flex-grow:${bad}"></i>` : ''}${old ? `<i class="old" style="flex-grow:${old}"></i>` : ''}</div></div>
        <div class="notes">${bad ? st('bad', `${bad} 有问题`) : ''}${old ? st('warn', `${old} 可迁移`) : ''}${!bad && !old ? st('ok', '全部通过') : ''}</div></div></a>
      <a class="m-out" href="#/batches?sel=${batch.id}">${link(busy)}<div class="big">${fmt(sum)}</div><div class="side">
        <div class="spark" title="本月每天的出图张数">${SPARK[id].map((v, i) => `<i class="${i === 11 ? 'today' : ''}" style="height:${Math.max(8, v / max * 100)}%;--i:${i}"></i>`).join('')}</div>
        <div class="last">${busy ? `${ring(pct(c))}<span class="cell-trunc">${batch.name}</span><b class="mono" data-live="pct">${pct(c)}%</b>` : `<span class="${c.bad ? 'bad-i' : 'ok-i'}">${ic(c.bad ? 'fail' : 'check')}</span><span class="cell-trunc">${batch.name}</span><span class="faint mono">${batch.at.slice(0, 5)}</span>`}</div></div></a>
    </div>`;
  }).join('');
  const recent = [...DATASETS.slice(3, 6), DATASETS[24], DATASETS[25], DATASETS[7], DATASETS[26], DATASETS[152]];
  return {
    crumbs: [['总览']],
    body: `<div class="pane">
      <div class="head"><h1>总览</h1><span class="sub">11 月 12 日 周四</span><div class="spacer"></div><a class="btn" href="#/datasets" data-toast="新建数据集（示意）">新建数据集</a><button class="btn primary" data-toast="出图…（示意：选模板与数据集）">出图…</button></div>
      <div class="ov-top">
        <section class="card todo">
          <div class="card-h"><b>等你处理</b><span class="count mono">3</span></div>
          <a class="todo-row" href="#/definitions?sel=badge"><span class="glyph warn">${ic('seal')}</span><b>会议胸牌</b><span class="t">草稿申请发布 v4</span><span class="w">operator · 昨天</span>${GO}</a>
          <a class="todo-row" href="#/datasets?sel=ds-18路-a&st=bad"><span class="glyph bad">${ic('alert')}</span><b>18 路 开往火车站</b><span class="t">1 个严重问题，出不了正式图</span><span class="w">2 小时前</span>${GO}</a>
          <a class="todo-row" href="#/batches?sel=b-1112-01"><span class="glyph bad">${ic('fail')}</span><b>十一月线路牌换版</b><span class="t">${lc.bad} 个渲染项失败</span><span class="w">${running ? '还在出图' : '已结束'}</span>${GO}</a>
        </section>
        <a class="card loomcard" href="#/batches?sel=${live.id}" title="打开这个批次">
          <div class="lm">
            <div class="micro">${running ? `${spin()}正在出图` : `<span class="ok-i">${ic('check')}</span>最近一批`}</div>
            <div class="lm-name">${live.name}</div>
            <div class="lm-pct"><b data-live="pct">${pct(lc)}%</b></div>
            <div class="lm-sub"><span class="mono"><span data-live="done">${lc.ok + lc.bad}</span> / ${lc.total}</span> 张${lc.bad ? `<i class="pt bad"></i>${lc.bad} 失败` : ''}</div>
          </div>
          ${loomSvg(live.cells)}
        </a>
      </div>
      <div class="h2"><b>流水</b><span>一个数据定义一行</span></div>
      <div class="lanes">
        <div class="lane-h"><div>${ic('def')}数据定义</div><div>${ic('tpl')}模板</div><div>${ic('ds')}数据集</div><div>${ic('batch')}出图<small>本月 · 张</small></div></div>
        ${lanes}
        <div class="lane-foot">另有 2 个只被引用、不直接出图：<a href="#/definitions?sel=stop">停靠站点</a><a href="#/definitions?sel=session">参会场次</a></div>
      </div>
      <div class="h2"><b>最近出图</b><div class="spacer"></div><a class="btn quiet sm" href="#/records">全部出图记录 ${ic('arrow')}</a></div>
      <div class="strip">${recent.map((d, i) => `<div class="outc" data-rec="${d.id}"><div class="frame">${art(d.art)}</div><div class="c"><span class="cell-trunc">${d.name}</span><span class="mono">${['10:42', '10:42', '10:41', '11-10', '11-10', '10:40', '11-10', '11-08'][i]}</span></div></div>`).join('')}</div>
    </div>`,
  };
};

// ───────── 数据定义 ─────────
const fieldRows = (d) => d.fields.map(([n, dn, t, cons, chg]) => `<div title="${cons.join(' · ')}">${ic(t)}<b class="cell-trunc">${dn}</b><span class="r">${delta(chg)}<code>${n}</code></span></div>`).join('');
function peekDefinition(d) {
  const nextVer = `v${Number(d.ver.slice(1)) + 1}`;
  const acts = `<a class="btn primary" href="#/definitions/${d.id}">打开编辑 <kbd>↵</kbd></a>${d.draft === 'changed' ? `<a class="btn" href="#/definitions/${d.id}?publish=1">发布 ${nextVer}…</a>` : d.draft === 'pending' ? `<button class="btn" data-toast="已批准，${d.display} ${nextVer} 发布了">批准发布 ${nextVer}</button>` : ''}<button class="btn quiet" data-toast="复制为新的数据定义（示意）">${ic('copy')}复制</button>`;
  return `${peekHead(d.id, '数据定义', d.name, d.display, acts, `<span class="ver">${d.ver}</span>${draftPill(d)}`)}
    <div class="peek-sec"><div class="sec-t"><b>字段</b><span class="mono">${d.fields.length}</span></div><div class="frows">${fieldRows(d)}</div></div>
    <div class="peek-sec"><div class="sec-t"><b>版本</b>发布后不可变</div><ul class="tl">${d.versions.map(([v, k, a, b]) => `<li class="${k === 'draft' ? 'wip' : k === 'cur' ? 'cur' : ''}"><div class="t1">${v === '草稿' ? '<b>草稿</b>' : `<span class="ver">${v}</span>`}<span>${a}</span></div>${b ? `<div class="t2">${b}</div>` : ''}</li>`).join('')}</ul></div>
    <div class="peek-sec uses"><div class="sec-t"><b>在用</b></div>${d.usedBy ? `<a href="#/definitions?sel=${d.usedBy === '线路牌' ? 'route-sign' : 'badge'}">${ic('def')}<span>被 <b>${d.usedBy}</b> 引用</span>${GO}</a>` : `<a href="#/templates?def=${d.id}">${ic('tpl')}<span><b class="mono">${d.templates}</b> 个模板</span>${GO}</a><a href="#/datasets?def=${d.id}">${ic('ds')}<span><b class="mono">${d.datasets}</b> 份数据集</span>${GO}</a>`}</div>`;
}
PAGES.definitions = (r) => {
  if (r.path[1]) return definitionEditor(r);
  const sel = state.sel.definitions ?? r.q.sel ?? 'route-sign'; state.sel.definitions = sel;
  const rows = DEFS.map((d) => ({ id: d.id, cells: [
    `<div class="nm">${glyph(d.id)}<b class="cell-trunc">${d.display}</b></div>`, `<div class="vd"><span class="ver">${d.ver}</span><span class="faint mono">${d.verAt}</span></div>`, draftPill(d), `<span class="num">${d.fields.length}</span>`,
    d.usedBy ? `<span class="refd" title="只被引用，不直接出图"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v5.5A1.5 1.5 0 0 0 5.5 10H12M9.5 7.5 12 10l-2.5 2.5"/></svg>${d.usedBy}</span>` : `${pair('tpl', d.templates, '模板')}${pair('ds', d.datasets, '数据集')}`] }));
  return {
    crumbs: [['数据定义']], list: 'definitions', open: (id) => go(`#/definitions/${id}`), peek: (id) => peekDefinition(defOf(id)),
    body: `<div class="pane">
      <div class="head"><h1>数据定义</h1><span class="count mono">${DEFS.length}</span><div class="spacer"></div><button class="btn" data-toast="待批准的发布（示意）">发布记录</button><button class="btn primary" data-toast="新建数据定义（示意）">新建数据定义 <kbd>N</kbd></button></div>
      <div class="filters"><label class="search">${ic('search')}<input placeholder="筛选名称" data-filter><kbd>/</kbd></label><div class="chips"><button class="chip on">全部 <i class="n">5</i></button><button class="chip">${dia()}有改动 <i class="n">1</i></button><button class="chip">${dia('mod')}待批准 <i class="n">1</i></button></div></div>
      ${ledger('minmax(200px,1.5fr) 120px minmax(110px,.9fr) 44px 124px', ['名称', '已发布', '草稿', { t: '字段', c: 'num' }, '在用'], rows, sel)}
      ${keysNote()}
    </div>`,
  };
};

function definitionEditor(r) {
  const d = defOf(r.path[1]) ?? DEFS[0], view = r.q.view ?? 'table';
  const sel = state.sel.fields ?? r.q.field ?? 'routeNo'; state.sel.fields = sel;
  const nextVer = `v${Number(d.ver.slice(1)) + 1}`;
  const rows = d.fields.map(([n, dn, t, cons, chg]) => ({ id: n, cls: 'frow', cells: [GRIP, `<b class="cell-trunc">${dn}</b>`, `<code class="cell-trunc">${n}</code>`, ty(t),
    `<div class="cons">${cons.map((c) => `<span>${c}</span>`).join('')}</div>`, delta(chg)] }));
  const dsl = `{\n  <span class="k">"dslVersion"</span>: <span class="s">"renderweave-schema/1"</span>,\n  <span class="k">"name"</span>: <span class="s">"${d.name}"</span>,\n  <span class="k">"displayName"</span>: <span class="s">"${d.display}"</span>,\n  <span class="k">"fields"</span>: [\n${d.fields.map(([n, dn, t]) => `    { <span class="k">"name"</span>: <span class="s">"${n}"</span>, <span class="k">"displayName"</span>: <span class="s">"${dn}"</span>, <span class="k">"type"</span>: <span class="s">"${t}"</span> }`).join(',\n')}\n  ]\n}`;
  return {
    crumbs: [['数据定义', '#/definitions'], [d.display]], list: 'fields', peek: (id) => peekField(d, id), peekW: 372,
    after: () => { if (r.q.publish) openPublish(d); },
    body: `<div class="pane">
      <div class="head">${glyph(d.id, 'lg')}<h1>${d.display}</h1><span class="ver">${d.ver}</span><div class="spacer"></div>
        <div class="seg"><button class="${view === 'table' ? 'on' : ''}" data-go="#/definitions/${d.id}">字段表</button><button class="${view === 'dsl' ? 'on' : ''}" data-go="#/definitions/${d.id}?view=dsl">DSL</button></div>
        <button class="btn primary" data-act="publish">发布 ${nextVer}…</button></div>
      ${d.draft === 'changed' ? `<div class="ribbon"><span class="draft">${dia()}草稿 · ${d.changes} 处改动</span><span class="muted">发布之前，模板和数据集看不到这些改动</span><div class="spacer"></div>${st('ok', '已保存')}<button class="btn sm" data-act="publish">看差异</button></div>` : ''}
      ${view === 'dsl' ? `<div class="dsl">${dsl}</div>` : `${ledger('14px minmax(120px,1fr) minmax(110px,.9fr) 78px minmax(170px,1.5fr) 44px', ['', '显示名称', '字段名称', '类型', '约束', ''], rows, sel, 'fields', `<a class="add-row" data-toast="添加字段（示意）">${ic('plus')}添加字段 <kbd>A</kbd></a>`)}${keysNote('改名')}`}
    </div>`,
  };
}
function peekField(d, id) {
  const f = d.fields.find((x) => x[0] === id) ?? d.fields[0], [n, dn, t, cons, chg] = f;
  const req = cons.includes('必填');
  return `${peekHead(t, '字段', n, dn, '', delta(chg))}
    <div class="peek-sec insp"><label>显示名称</label><input class="field" value="${dn}"><div class="hint">给人看的名字，随时可以改。</div>
      <label>字段名称</label><input class="field mono" value="${n}"><div class="hint">数据集和模板绑定都用它；改名会影响绑定。</div>
      <label>字段类型</label><div class="seg">${Object.entries(TYPE).map(([k, v]) => `<button class="${k === t ? 'on' : ''}">${v[1]}</button>`).join('')}</div></div>
    <div class="peek-sec"><div class="sec-t"><b>约束</b></div>
      <div class="param"><span>必填</span><div><button class="toggle ${req ? 'on' : ''}" data-toggle></button></div></div>
      ${t === 'text' ? `<div class="param"><span>字数</span><div class="insp two"><input class="field mono" value="1"><input class="field mono" value="${n === 'routeNo' ? 10 : 20}"></div></div>` : ''}
      ${t === 'number' ? '<div class="param"><span>范围</span><div class="insp two"><input class="field mono" value="0"><input class="field mono" value="100"></div></div>' : ''}
      ${t === 'list' ? `<div class="param"><span>元素</span><div>${cons.find((c) => c.startsWith('元素'))?.slice(3) ?? ''}</div></div><div class="param"><span>项数</span><div class="insp two"><input class="field mono" value="${n === 'stops' ? 2 : 0}"><input class="field mono" value="${n === 'stops' ? 50 : 60}"></div></div>` : ''}
      ${t === 'image' ? '<div class="param"><span>来源</span><div class="seg"><button class="on">只取资源</button><button>也允许 URL</button></div></div>' : ''}</div>
    ${chg === 'mod' ? `<div class="peek-sec"><div class="sec-t"><b>相对 ${d.ver}</b></div><ul class="diff"><li>${dia('mod')}<span>字数上限 <s>8</s> → <b>10</b></span></li></ul></div>` : ''}
    <div class="peek-sec uses"><div class="sec-t"><b>绑定它的模板</b></div>${chg === 'add' ? '<span class="faint" style="font-size:12.5px">还没发布，模板里绑不到它。</span>' : `<a href="#/templates?sel=route-sign-h">${ic('tpl')}<span>线路牌 · 横版</span><span class="faint">${n === 'stops' ? '1 个循环容器' : '2 处'}</span>${GO}</a><a href="#/templates?sel=route-sign-night">${ic('tpl')}<span>线路牌 · 夜间配色</span><span class="faint">1 处</span>${GO}</a>`}</div>`;
}
function openPublish(d) {
  const nextVer = `v${Number(d.ver.slice(1)) + 1}`;
  openDrawer(`<div class="drawer-h">${glyph(d.id, 'lg')}<div><div class="peek-kind"><span>发布数据定义</span><code>${d.name}</code></div><h2>${d.display}<span class="to">${ic('arrow')}</span>${nextVer}</h2></div><div class="spacer"></div><button class="icon-btn" data-act="close" title="关闭 Esc">${ic('close')}</button></div>
    <div class="peek-sec insp"><label>版本标识</label><input class="field mono" value="${nextVer}" style="width:220px"><div class="hint">缺省是下一个编号，也可以写「2026-11」这样的字符串。</div></div>
    <div class="peek-sec"><div class="sec-t"><b>相对 ${d.ver} 的差异</b><span class="mono">3</span></div><ul class="diff">
      <li>${dia()}<span>新增字段 <b>票价说明</b> <code>fareNote</code> · 文本，最多 20 字</span></li>
      <li>${dia()}<span>新增字段 <b>夜班线路</b> <code>nightLine</code> · 布尔</span></li>
      <li>${dia('mod')}<span><b>线路号</b> <code>routeNo</code> 的字数上限 <s>8</s> → <b>10</b></span></li></ul></div>
    <div class="peek-sec"><div class="sec-t"><b>发布以后</b></div><dl class="facts" style="grid-template-columns:64px 1fr">
      <dt>模板</dt><dd>2 个模板的基准仍是 ${d.ver} / v1，不会自己变；想用新字段时逐个升级。</dd>
      <dt>数据集</dt><dd>24 份数据集仍符合各自的版本，照常出图；需要新字段的再迁移。</dd>
      <dt>兼容</dt><dd>${st('ok', `只加不减，旧数据集迁移到 ${nextVer} 不用人工处理`)}</dd></dl></div>
    <div class="drawer-f"><span class="muted">本租户发布前不需要批准</span><div class="spacer"></div><button class="btn" data-act="close">取消</button><button class="btn primary" data-act="close" data-toast="${d.display} ${nextVer} 发布了">发布 ${nextVer}</button></div>`);
}

// ───────── 模板 ─────────
const COLORS = [['m402-base', '#ff7f00', '橙'], ['m402-color-green', '#12964a', '绿'], ['m402-color-navy', '#1c2f66', '藏青']];
function peekTemplate(t) {
  const d = defOf(t.def), isRoute = t.id === 'route-sign-h', shown = isRoute ? (state.tplColor ?? t.art) : t.art;
  const acts = `<button class="btn primary" data-toast="进入模板设计页（另有方案，不在本原型里）">设计 <kbd>↵</kbd></button><a class="btn" href="#/datasets?def=${t.def}">用它新建数据集</a><button class="btn quiet" data-toast="复制为新模板（示意）">${ic('copy')}复制</button>`;
  return `${peekHead('tpl', '模板', t.id, t.name, acts)}
    <div class="stage">${proof(shown, t.shape, 220)}<span class="cap">样例 · ${t.shape === 'wide' ? 'M402 开往万国城总站' : t.def === 'badge' ? '张三的胸牌' : '冻干咖啡 12 颗装'}</span></div>
    <div class="peek-sec"><div class="sec-t"><b>对外参数</b>在这里试值，不写进模板</div>
      ${isRoute ? `<div class="param"><span>主色</span><div class="swatches">${COLORS.map(([a, c, n]) => `<button class="${shown === a ? 'on' : ''}" style="--c:${c}" title="${n}" data-color="${a}"></button>`).join('')}</div></div>
        <div class="param"><span>当前站序号</span><div><input class="field mono" value="5" style="width:72px"></div></div><div class="param"><span>显示票价</span><div><button class="toggle on" data-toggle></button></div></div>`
    : t.def === 'badge' ? `<div class="param"><span>会议名称</span><div><input class="field" value="2026 出图技术大会"></div></div><div class="param"><span>主色</span><div class="swatches"><button class="on" style="--c:#d6401f"></button><button style="--c:#2440e0"></button><button style="--c:#0f9d7a"></button></div></div><div class="param"><span>姓名字号</span><div><input class="field mono" value="72" style="width:72px"></div></div>${t.params > 3 ? '<div class="param"><span>显示座位</span><div><button class="toggle" data-toggle></button></div></div>' : ''}`
    : '<div class="param"><span>促销色</span><div class="swatches"><button class="on" style="--c:#d6401f"></button><button style="--c:#101216"></button></div></div><div class="param"><span>显示原价</span><div><button class="toggle on" data-toggle></button></div></div>'}</div>
    <div class="peek-sec"><dl class="facts"><dt>适用尺寸范围</dt><dd class="mono">${t.size}</dd><dt>基准数据定义</dt><dd><a class="lnk" href="#/definitions?sel=${t.def}">${d.display}</a> <span class="ver ${t.upgrade ? 'up' : ''}">${t.base}</span>${t.upgrade ? ` <button class="btn sm" style="margin-left:6px" data-toast="模板升级到 ${d.name} ${t.upgrade}（示意）">升级到 ${t.upgrade}</button>` : ''}</dd>
      <dt>数据集</dt><dd><a class="lnk" href="#/datasets?def=${t.def}"><b class="mono">${t.datasets}</b> 份能用它出图</a></dd><dt>本月出图</dt><dd class="mono">${fmt(t.month)} 张</dd><dt>最近修改</dt><dd>${t.by} · ${t.at}</dd></dl></div>`;
}
PAGES.templates = (r) => {
  const view = state.tplView ?? r.q.view ?? 'gallery', def = r.q.def ?? 'all'; state.tplView = view;
  const list = TEMPLATES.filter((t) => def === 'all' || t.def === def);
  let sel = state.sel.templates ?? r.q.sel ?? list[0].id; if (!list.some((t) => t.id === sel)) sel = list[0].id; state.sel.templates = sel;
  const verOf = (t) => `<span class="ver ${t.upgrade ? 'up' : ''}"${t.upgrade ? ` title="基准还是 ${t.base}，可以升级到 ${t.upgrade}"` : ''}>${t.base}</span>`;
  const card = (t) => `<div class="tcard ${t.shape} ${t.id === sel ? 'sel' : ''}" data-row="${t.id}"><div class="art-box">${art(t.art)}</div><div class="meta"><div class="l1"><b class="cell-trunc">${t.name}</b>${verOf(t)}</div><div class="l2"><span class="mono cell-trunc">${t.size}</span>${pair('ds', t.datasets, '能用它出图的数据集')}</div></div></div>`;
  const groups = ROOT_DEFS.filter((id) => list.some((t) => t.def === id)).map((id) => `<div class="group-t">${glyph(id, 'sm')}<b>${defOf(id).display}</b><span class="mono">${list.filter((t) => t.def === id).length}</span></div><div class="gallery">${list.filter((t) => t.def === id).map(card).join('')}</div>`).join('');
  const rows = list.map((t) => ({ id: t.id, cells: [`<div class="nm">${mini(t.art)}<b class="cell-trunc">${t.name}</b></div>`, `<div class="vd"><span class="muted cell-trunc">${defOf(t.def).name}</span>${verOf(t)}</div>`, `<span class="mono muted">${t.size}</span>`, `<span class="num">${t.params}</span>`, `<span class="num">${fmt(t.month)}</span>`] }));
  const chip = (id, label, n) => `<a class="chip ${def === id ? 'on' : ''}" href="#/templates${id === 'all' ? '' : `?def=${id}`}">${label} <i class="n">${n}</i></a>`;
  return {
    crumbs: [['模板']], list: 'templates', open: () => toast('进入模板设计页（另有方案，不在本原型里）'), peek: (id) => peekTemplate(tplOf(id)),
    body: `<div class="pane">
      <div class="head"><h1>模板</h1><span class="count mono">${list.length}</span><div class="spacer"></div><div class="seg"><button class="${view === 'gallery' ? 'on' : ''}" data-view="gallery">画廊</button><button class="${view === 'list' ? 'on' : ''}" data-view="list">列表</button></div><button class="btn primary" data-toast="新建模板（示意）">新建模板 <kbd>N</kbd></button></div>
      <div class="filters"><label class="search">${ic('search')}<input placeholder="筛选名称" data-filter><kbd>/</kbd></label><div class="chips">${chip('all', '全部', TEMPLATES.length)}${ROOT_DEFS.map((id) => chip(id, defOf(id).name, TEMPLATES.filter((t) => t.def === id).length)).join('')}</div></div>
      ${view === 'gallery' ? groups : ledger('minmax(220px,1.6fr) minmax(120px,1fr) 168px 52px 70px', ['名称', '基准数据定义', '适用尺寸范围', { t: '对外参数', c: 'num' }, { t: '本月出图', c: 'num' }], rows, sel)}
      ${keysNote('进设计页')}
    </div>`,
  };
};

// ───────── 数据集 ─────────
function peekDataset(d) {
  const t = tplOf(d.tpl), def = defOf(d.def);
  const acts = `<button class="btn primary" data-toast="出图…（示意：选模板与出图参数）">出图…</button><a class="btn" href="#/datasets/${d.def === 'route-sign' ? 'ds-m402-wanguocheng' : d.id}">打开编辑 <kbd>↵</kbd></a><button class="btn quiet" data-toast="复制为新的数据集（示意）">${ic('copy')}复制</button>`;
  return `${peekHead(d.def, def.name, d.id, d.name, acts, `<span class="ver ${d.old ? 'up' : ''}">${d.ver}</span>`)}
    <div class="stage">${proof(d.art, t.shape, 220)}<span class="cap">草稿预览 · ${t.name}</span></div>
    ${d.problems ? `<div class="peek-sec"><div class="sec-t"><b>问题清单</b>1 个严重 · 1 个提示</div>${PROBLEMS.map(problemHtml).join('')}</div>` : ''}
    ${d.old ? `<div class="peek-sec"><div class="sec-t"><b>可以迁移</b></div><p class="muted" style="font-size:12.5px;margin-bottom:9px">还在 ${def.name} v1。迁移会按 v2 生成一份新的数据集，原来这份不变。</p><button class="btn sm" data-toast="数据集迁移（示意）">迁移到 v2…</button></div>` : ''}
    <div class="peek-sec"><div class="sec-t"><b>内容</b><div class="spacer"></div>${d.problems ? '' : st('ok', '通过校验')}</div><dl class="facts">${d.facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></div>
    <div class="peek-sec"><dl class="facts"><dt>最近出图</dt><dd>${d.last ? `${d.last} · ${t.name}` : '<span class="faint">还没出过图</span>'}</dd><dt>最近修改</dt><dd>${d.by} · ${d.at}</dd></dl></div>`;
}
PAGES.datasets = (r) => {
  if (r.path[1]) return datasetEditor(r);
  const def = r.q.def ?? 'all', stf = r.q.st ?? 'all';
  const list = DATASETS.filter((d) => (def === 'all' || d.def === def) && (stf === 'all' || (stf === 'bad' ? d.problems : d.old)));
  let sel = state.sel.datasets ?? r.q.sel ?? list[0]?.id; if (!list.some((d) => d.id === sel)) sel = list[0]?.id; state.sel.datasets = sel;
  if (r.q.checked && !state.checked.size) list.slice(3, 6).forEach((d) => state.checked.add(d.id));
  const rows = list.map((d) => ({ id: d.id, cells: [`<span class="check ${state.checked.has(d.id) ? 'on' : ''}" data-check="${d.id}"></span>`, `<div class="nm">${mini(d.art)}<b class="cell-trunc">${d.name}</b></div>`,
    `<div class="vd"><span class="faint cell-trunc">${defOf(d.def).name}</span>${d.old ? `<span class="ver up" title="还在 ${d.ver}，可以迁移到 v2">${d.ver}</span>` : ''}</div>`, d.problems ? st('bad', `${d.problems} 个问题`) : st('ok'),
    d.last ? `<span class="when" title="${d.last}">${d.last.replace('今天 ', '')}</span>` : '<span class="faint">—</span>'] }));
  const q = (o) => { const p = { ...(def !== 'all' && { def }), ...(stf !== 'all' && { st: stf }), ...o }; Object.keys(p).forEach((k) => (p[k] === 'all' || p[k] == null) && delete p[k]); const s = new URLSearchParams(p).toString(); return `#/datasets${s ? `?${s}` : ''}`; };
  const chip = (id, label) => `<a class="chip ${def === id ? 'on' : ''}" href="${q({ def: id })}">${label} <i class="n">${id === 'all' ? DATASETS.length : DATASETS.filter((d) => d.def === id).length}</i></a>`;
  return {
    crumbs: [['数据集']], list: 'datasets', open: (id) => go(`#/datasets/${DATASETS.find((d) => d.id === id).def === 'route-sign' ? 'ds-m402-wanguocheng' : id}`), peek: (id) => peekDataset(DATASETS.find((d) => d.id === id)),
    body: `<div class="pane-wrap"><div class="pane">
      <div class="head"><h1>数据集</h1><span class="count mono">${list.length}${list.length < DATASETS.length ? ` / ${DATASETS.length}` : ''}</span><div class="spacer"></div><button class="btn" data-toast="智能导入：从表格、图片或文档识别出数据集（示意）">智能导入…</button><button class="btn" data-toast="标准表格批量出图（示意）">表格批量出图…</button><button class="btn primary" data-toast="新建数据集（示意）">新建数据集 <kbd>N</kbd></button></div>
      <div class="filters"><label class="search">${ic('search')}<input placeholder="筛选名称" data-filter><kbd>/</kbd></label><div class="chips">${chip('all', '全部')}${ROOT_DEFS.map((id) => chip(id, defOf(id).name)).join('')}</div><span class="vsep"></span>
        <div class="chips"><a class="chip ${stf === 'bad' ? 'on' : ''}" href="${q({ st: stf === 'bad' ? 'all' : 'bad' })}"><i class="pt bad"></i>有问题 <i class="n">1</i></a><a class="chip ${stf === 'old' ? 'on' : ''}" href="${q({ st: stf === 'old' ? 'all' : 'old' })}"><i class="pt old"></i>可迁移 <i class="n">2</i></a></div></div>
      ${ledger('16px minmax(220px,1.7fr) minmax(110px,.9fr) 92px 96px', ['', '名称', '数据定义', '校验', '最近出图'], rows, sel)}
      ${keysNote('打开编辑</span><span><kbd>空格</kbd>勾选')}
    </div><div id="bulk"></div></div>`,
    after: renderBulk,
  };
};
function renderBulk() {
  const el = document.getElementById('bulk'); if (!el) return;
  const n = state.checked.size;
  el.innerHTML = n ? `<div class="bulk"><b class="n">${n}</b><span>份已选</span><span class="vsep"></span><button data-toast="数据集迁移（示意）">迁移</button><button data-toast="导出为表格（示意）">导出</button><button data-toast="删除前会再问一次（示意）">删除</button><button data-act="uncheck">取消 <kbd>Esc</kbd></button><button class="go-btn" data-toast="这 ${n} 份合成一个批次出图（示意）">出图 ${n} 张${ic('arrow')}</button></div>` : '';
}

function datasetEditor(r) {
  const d = DATASETS[0];
  const stop = state.stop ?? Number(r.q.stop ?? 4); state.stop = stop;
  const f = (label, value, o = {}) => `<div class="${o.w2 ? 'w2' : ''}"><label>${label}${o.req ? ' <em>*</em>' : ''}</label><input class="field ${o.mono ? 'mono' : ''}" value="${value}" data-redraw>${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
  const rows = STOPS.map(([name, road, badge, lm], i) => ({ id: String(i), cells: [`<span class="idx">${i + 1}</span>`, `<b class="cell-trunc">${name}</b>`, `<span class="muted">${road}</span>`, lm ? `<code>res:${lm}</code>` : '<span class="faint">—</span>', badge ? `<span class="tag">${badge}</span>` : ''] }));
  return {
    crumbs: [['数据集', '#/datasets?def=route-sign'], [d.name]], list: 'stops', noPeek: true,
    after: () => { placeStop(); const row = document.querySelector('.stops .lr.sel'); if (row && r.q.stop) row.scrollIntoView({ block: 'nearest' }); },
    body: `<div class="pane">
      <div class="head">${glyph(d.def, 'lg')}<h1>${d.name}</h1><span class="ver">v2</span><div class="spacer"></div>${st('ok', '通过校验')}<span class="faint" style="font-size:12px">已保存 · 2 分钟前</span><button class="btn primary" data-toast="出图…（示意：选模板与出图参数）">出图…</button></div>
      <div class="form-sec"><div class="sec-h">线路与运营</div><div class="form-grid">
        ${f('线路号', 'M402', { req: true, hint: '1–10 字' })}<div><label>线路号图片</label><div class="field ref"><code class="cell-trunc">res:route-no-m402</code><span class="spacer"></span><span class="faint">换…</span></div></div>${f('票制', '一票制')}${f('票价（元）', '2', { mono: true })}
        ${f('运营方', '巴士集团')}${f('首班', '07:30', { mono: true })}${f('末班', '22:30', { mono: true })}${f('班车类型', '定时班车')}${f('运营说明', '工作日运营', { w2: true })}</div></div>
      <div class="form-sec"><div class="sec-h">班次时刻<span class="mono">${TIMES.length} / 60</span></div><div class="times">${TIMES.map((t) => `<span>${t}</span>`).join('')}<span class="add">${ic('plus')}</span></div></div>
      <div class="form-sec stops"><div class="sec-h">停靠站点<span class="mono">${STOPS.length} / 50</span><div class="spacer"></div><button class="btn sm" data-toast="从表格粘贴一列站名（示意）">粘贴一列…</button><button class="btn sm" data-toast="添加一站（示意）">${ic('plus')}添加</button></div>
        ${ledger('26px minmax(130px,1.2fr) minmax(100px,1fr) minmax(120px,1fr) 80px', ['#', '站名', '所在道路', '地标', '标识'], rows, String(stop), 'stops-ledger')}</div>
    </div>
    <aside class="preview-pane">
      <div class="preview-bar"><button class="btn sm">线路牌 · 横版${ic('more')}</button><code>2400 × 536 mm</code><div class="spacer"></div><span class="tag">草稿预览</span></div>
      <div class="stage preview-stage"><div class="canvas" id="canvas">${art('m402-base', 'art')}<div class="hl" id="hl"></div><div class="redraw" id="redraw">${spin()}正在重画</div></div></div>
      <div class="peek-sec"><div class="sec-t"><b id="stop-t"></b></div><dl class="facts" id="stop-f"></dl></div>
      <div class="peek-sec"><p class="faint" style="font-size:12px">表里选一行，图上框出这一站；在图上点一站，表里跳到它。</p></div>
      <div class="savebar"><span class="faint">手工录入 · 按 M402 设计稿逐项转录</span><div class="spacer"></div><button class="btn sm" data-toast="修改历史（示意）">修改历史</button></div>
    </aside>`,
  };
}
function hlStop(i) {
  const hl = document.getElementById('hl'); if (!hl) return;
  hl.style.cssText = `left:${(88 + i * 53.6 - 25) / 20}%;width:2.5%;top:27.5%;height:54%`; hl.dataset.n = `${i + 1} ${STOPS[i][0]}`;
}
function placeStop() {
  const hl = document.getElementById('hl'); if (!hl) return;
  const i = state.stop, s = STOPS[i];
  hlStop(i);
  document.getElementById('stop-t').textContent = `第 ${i + 1} 站 · ${s[0]}`;
  document.getElementById('stop-f').innerHTML = `<dt>所在道路</dt><dd>${s[1]}</dd><dt>地标</dt><dd>${s[3] ? `<code>res:${s[3]}</code>` : '<span class="faint">没有</span>'}</dd><dt>标识</dt><dd>${s[2] || '<span class="faint">没有</span>'}</dd><dt>元素路径</dt><dd class="mono" style="font-size:11.5px;color:var(--muted)">标准线路单边/站点面板/站点列[${i + 1}]</dd>`;
}

// ───────── 出图：批次与出图记录 ─────────
/** 列表里完成只留一个对勾；速览里（long）把字写出来。 */
const batchState = (b, long) => { const c = count(b.cells); return b.canceled ? st('off', '已取消') : c.run || c.wait ? st('run', '进行中') : c.bad ? st('bad', `${c.bad} 失败`) : st('ok', long ? '完成' : ''); };
const batchCounts = (b) => { const c = count(b.cells); return [`${c.ok} 完成`, c.bad && `${c.bad} 失败`, c.run && `${c.run} 正在出`, c.wait && `${c.wait} 排队`, c.stop && `${c.stop} 未出`].filter(Boolean).join(' · '); };
const batchItems = (b) => DATASETS.filter((d) => d.def === b.def);
function peekBatch(b) {
  const t = tplOf(b.tpl), c = count(b.cells), ds = batchItems(b), live = c.run || c.wait;
  const bad = b.cells.map((s, i) => (s === 'bad' ? i : -1)).filter((i) => i >= 0);
  const acts = `${live ? '<button class="btn" data-toast="批次已取消，出完的照常保留（示意）">取消批次</button>' : `${c.bad ? `<button class="btn primary" data-toast="失败的渲染项带幂等键重试（示意）">重试失败的 ${c.bad} 项</button>` : ''}<button class="btn ${c.bad ? '' : 'primary'}" data-toast="下载批次清单与图片（示意）">下载全部</button>`}<button class="btn quiet" data-toast="用同样的设置再出一次（示意）">再出一次</button>`;
  return `${peekHead(b.def, '批次', b.id, b.name, acts, batchState(b, true))}
    <div class="peek-sec"><div class="sec-t"><b>渲染项</b><span class="mono">${c.total}</span><div class="spacer"></div><span data-live="counts">${batchCounts(b)}</span></div>
      <div class="cells" style="--n:${b.cells.length > 60 ? 16 : 12}" data-cells="${b.id}">${b.cells.map((s, i) => `<button class="cell ${s}" data-cell="${i}" title="${ds[i % ds.length].name}"></button>`).join('')}</div>
      <div class="legend"><span><i class="ok"></i>完成</span><span><i class="bad"></i>失败</span>${live ? '<span><i class="run"></i>正在出</span><span><i></i>排队</span>' : ''}<div class="spacer"></div><span class="faint">点一格看这一张</span></div></div>
    ${bad.length ? `<div class="peek-sec"><div class="sec-t"><b>问题清单</b><span class="mono">${bad.length}</span></div>${bad.map((i) => problemHtml({ lv: '严重', text: `<b>${ds[i % ds.length].name}</b>「所在道路」没有填`, path: 'stops[7].road' }, `data-cell-go="${i}"`)).join('')}</div>` : ''}
    <div class="peek-sec"><dl class="facts"><dt>模板</dt><dd><a class="lnk" href="#/templates?sel=${t.id}">${t.name}</a></dd><dt>出图参数</dt><dd class="mono">${b.out}</dd><dt>发起</dt><dd>${b.by} · ${b.src} · ${b.at}</dd><dt>用时</dt><dd data-live="dur">${b.dur}</dd><dt>构建标识</dt><dd class="mono" style="font-size:11.5px">${BUILD}</dd></dl></div>`;
}
const outTabs = (on) => `<div class="tabs"><a class="${on === 'batches' ? 'on' : ''}" href="#/batches">批次<i>${BATCHES.length}</i></a><a class="${on === 'records' ? 'on' : ''}" href="#/records">出图记录<i>${fmt(MONTH_USED)}</i></a></div>`;
const batchRow = (b) => { const c = count(b.cells); return [`<div class="nm">${glyph(b.def)}<b class="cell-trunc">${b.name}</b></div>`, `<span class="muted cell-trunc">${tplOf(b.tpl).name}</span>`, `<div class="prog">${weft(b.cells)}<span>${c.ok + c.bad}/${c.total}</span></div>`, batchState(b), `<span class="when" title="${b.at}">${b.at.replace('今天 ', '')}</span>`]; };
PAGES.batches = (r) => {
  const sel = state.sel.batches ?? r.q.sel ?? BATCHES[0].id; state.sel.batches = sel;
  return {
    crumbs: [['出图'], ['批次']], list: 'batches', peek: (id) => peekBatch(BATCHES.find((b) => b.id === id)), open: () => openRecord(BATCHES.find((b) => b.id === state.sel.batches), 0),
    after: () => { if (r.q.cell != null) openRecord(BATCHES.find((b) => b.id === sel), Number(r.q.cell)); },
    body: `<div class="pane">
      <div class="head"><h1>出图</h1><div class="spacer"></div><button class="btn" data-toast="单张出图（示意）">单张出图…</button><button class="btn primary" data-toast="批量出图…（示意：选模板与数据集）">批量出图… <kbd>N</kbd></button></div>
      ${outTabs('batches')}
      ${ledger('minmax(190px,1.4fr) minmax(110px,.8fr) minmax(150px,1fr) 92px 92px', ['批次', '模板', '进度', '状态', '开始'], BATCHES.map((b) => ({ id: b.id, cells: batchRow(b) })), sel)}
      ${keysNote('看第一张')}
    </div>`,
  };
};
PAGES.records = (r) => {
  const day = (title, n, list, time, shape = '') => `<div class="day-t"><b>${title}</b><span class="mono">${n}</span></div><div class="rec-grid ${shape}">${list.map((d, i) => `<div class="rec" data-rec="${d.id}"><div class="frame">${art(d.art)}</div><div class="c"><span class="cell-trunc">${d.name}</span><span class="mono">${time(i)}</span></div></div>`).join('')}</div>`;
  const routes = DATASETS.filter((d) => d.def === 'route-sign' && !d.problems).slice(0, 9), badges = DATASETS.filter((d) => d.def === 'badge').slice(0, 12), tags = DATASETS.filter((d) => d.def === 'price-tag').slice(0, 7);
  return {
    crumbs: [['出图'], ['出图记录']], noPeek: true, after: () => { if (r.q.rec) openRecord(null, 0, DATASETS.find((d) => d.id === r.q.rec)); },
    body: `<div class="pane">
      <div class="head"><h1>出图</h1><div class="spacer"></div><button class="btn" data-toast="单张出图（示意）">单张出图…</button><button class="btn primary" data-toast="批量出图…（示意）">批量出图… <kbd>N</kbd></button></div>
      ${outTabs('records')}
      <div class="filters"><label class="search">${ic('search')}<input placeholder="按数据集找" data-filter><kbd>/</kbd></label><div class="chips"><button class="chip on">全部模板</button><button class="chip">线路牌 · 横版</button><button class="chip">会议胸牌</button><button class="chip">价签卖点</button></div><span class="vsep"></span><div class="chips"><button class="chip">只看正式出图</button></div></div>
      ${day('今天', '2,018 张', routes, (i) => `10:${42 - Math.floor(i / 2)}`, 'wide')}
      ${day('11-10 周二', '2,816 张', badges, (i) => `16:${String(20 - i).padStart(2, '0')}`)}
      ${day('11-08 周日', '320 张', tags, () => '18:02')}
    </div>`,
  };
};
function openRecord(batch, i, dataset) {
  const ds = dataset ?? batchItems(batch)[i % batchItems(batch).length], status = batch ? batch.cells[i] : 'ok';
  const t = tplOf(batch?.tpl ?? ds.tpl), b = batch ?? BATCHES.find((x) => x.def === ds.def);
  document.querySelectorAll('.cell.cur').forEach((c) => c.classList.remove('cur'));
  document.querySelector(`[data-cell="${i}"]`)?.classList.add('cur');
  const head = `<div class="drawer-h">${glyph(ds.def, 'lg')}<div><div class="peek-kind"><span>${status === 'ok' ? '出图记录' : '渲染项'}</span>${batch ? `<code>${i + 1} / ${batch.cells.length}</code>` : ''}</div><h2>${ds.name}</h2></div><div class="spacer"></div>${batch ? `<button class="icon-btn" data-step="-1" title="上一张 ←">${ic('prev')}</button><button class="icon-btn" data-step="1" title="下一张 →">${ic('arrow')}</button>` : ''}<button class="icon-btn" data-act="close" title="关闭 Esc">${ic('close')}</button></div>`;
  state.record = batch ? { batch, i } : null;
  if (status === 'ok') {
    openDrawer(`${head}<div class="stage big-stage">${proof(ds.art === 'm402-missing' ? 'm402-base' : ds.art, t.shape, 320)}<span class="cap">正式出图 · PNG · ${t.shape === 'wide' ? '2.4 MB' : '412 KB'}</span></div>
      <div class="peek-sec"><dl class="facts" id="rec-facts"><dt>模板</dt><dd>${t.name} <span class="faint">· 内容快照</span></dd><dt>数据集</dt><dd>${ds.name} <span class="faint">· 内容快照</span></dd><dt>出图参数</dt><dd class="mono">${b.out}</dd><dt>批次</dt><dd>${b.name} · ${b.at}</dd><dt>资源内容版本</dt><dd>3 项 <span class="faint">· route-no-m402 v2、bus-group-logo v4 …</span></dd><dt>构建标识</dt><dd class="mono" style="font-size:11.5px">${BUILD}</dd></dl></div>
      <div class="drawer-f"><button class="btn primary" data-toast="开始下载（示意）">下载</button><button class="btn" data-act="replay">重放</button><span class="replay-note" id="replay-note">只用这条记录重新渲染，再和原图逐字节比对</span><div class="spacer"></div><a class="btn quiet" href="#/datasets?sel=${ds.id}" data-act="close">打开数据集 ${ic('arrow')}</a></div>`);
  } else {
    openDrawer(`${head}<div class="peek-sec"><div class="sec-t"><b>${status === 'bad' ? '没有出图' : status === 'run' ? '正在出图' : status === 'stop' ? '批次取消，没有出' : '排队中'}</b></div>
      ${status === 'bad' ? `${problemHtml(PROBLEMS[0])}<p class="muted" style="font-size:12.5px;margin-top:10px">正式出图遇到严重问题就不出。改好数据集后，只重试这一项就行，其余的不用重出。</p>` : '<p class="muted" style="font-size:12.5px">这一项出完以后，这里会显示图和它的出图记录。</p>'}</div>
      <div class="peek-sec"><dl class="facts"><dt>模板</dt><dd>${t.name}</dd><dt>数据集</dt><dd>${ds.name}</dd><dt>出图参数</dt><dd class="mono">${b.out}</dd></dl></div>
      <div class="drawer-f">${status === 'bad' ? `<a class="btn primary" href="#/datasets?sel=ds-18路-a&st=bad" data-act="close">去改数据集</a><button class="btn" data-toast="这一项带幂等键重试（示意）">只重试这一项</button>` : ''}<div class="spacer"></div></div>`);
  }
}

// ───────── 用量 ─────────
PAGES.usage = () => {
  const max = 3000, byTpl = [...TEMPLATES].sort((a, b) => b.month - a.month), top = byTpl[0].month;
  const bars = Array.from({ length: 30 }, (_, i) => { const v = DAYS[i]; return `<div class="b ${i === 11 ? 'today' : ''} ${v == null ? 'future' : ''}" style="--i:${i}"><i style="height:${v == null ? 0 : Math.max(1, v / max * 100)}%"></i>${v == null ? '' : `<span class="tip">11-${String(i + 1).padStart(2, '0')}${i === 11 ? ' 今天' : ''} · ${fmt(v)} 张</span>`}</div>`; }).join('');
  return {
    crumbs: [['用量']], noPeek: true,
    body: `<div class="pane">
      <div class="head"><h1>用量</h1><span class="sub">只算正式出图，草稿预览不计</span><div class="spacer"></div><div class="seg"><button class="on">本月</button><button>上月</button><button>近 6 个月</button></div><button class="btn" data-toast="导出用量明细（示意）">导出明细</button></div>
      <div class="usage-top">
        <div><div class="sec-t"><b>本月已出</b></div><div class="hero" data-count="${MONTH_USED}">${fmt(MONTH_USED)}<small>张</small></div>
          <div class="meter"><i style="width:${MONTH_USED / QUOTA * 100}%"></i><u style="left:62.4%" title="按现在的速度，月底大约 31,200 张"></u></div>
          <div class="meter-l"><span>额度 <b class="mono">${fmt(QUOTA)}</b></span><span>还剩 <b class="mono">${fmt(QUOTA - MONTH_USED)}</b></span></div>
          <p class="forecast">${dia()}<span>月底约 <b class="mono">31,200</b> 张，够用 · 19 天后重置</span></p></div>
        <div><div class="sec-t"><b>每天出图</b>张<div class="spacer"></div><span>峰值 11-10 · <span class="mono">2,816</span></span></div>
          <div class="bars"><div class="grid" style="bottom:66.6%"><span>2,000</span></div><div class="grid" style="bottom:33.3%"><span>1,000</span></div>${bars}</div>
          <div class="axis"><span>11-01</span><span>11-08</span><span>11-15</span><span>11-22</span><span>11-30</span></div></div>
      </div>
      <div class="cols2">
        <div class="card pad"><div class="sec-t"><b>按模板</b></div>${byTpl.map((t) => `<a class="hbar" href="#/templates?sel=${t.id}"><span class="cell-trunc">${t.name}</span><div class="track"><i style="width:${Math.max(.6, t.month / top * 100)}%"></i></div><span class="v">${fmt(t.month)}</span></a>`).join('')}</div>
        <div class="card pad"><div class="sec-t"><b>按来源</b></div>
          ${[['operator', '控制台', 10112], ['admin', '控制台', 1472], ['store-sync', 'API 密钥', 320], ['designer', '控制台', 576]].sort((a, b) => b[2] - a[2]).map(([w, s, n]) => `<div class="hbar"><span class="cell-trunc">${w} <span class="faint">· ${s}</span></span><div class="track"><i style="width:${Math.max(.6, n / 10112 * 100)}%"></i></div><span class="v">${fmt(n)}</span></div>`).join('')}
          <div class="hbar off"><span>草稿预览</span><div class="track"></div><span class="v">不计</span></div></div>
      </div>
    </div>`,
  };
};

// ───────── 资源、管理 ─────────
function peekResource(id) {
  const [rid, kind, fmt2, ver, mark] = RESOURCES.find((x) => x[0] === id);
  const acts = '<button class="btn primary" data-toast="替换检查：先列出谁在引用，确认后才生效（示意）">替换…</button><button class="btn" data-toast="开始下载（示意）">下载</button>';
  return `${peekHead('res', `${kind} · ${fmt2}`, '', `<span class="mono">res:${rid}</span>`, acts, `<span class="ver">内容版本 v${ver}</span>`)}
    <div class="stage"><span class="proof"><span class="res-big" style="${kind === '字体' ? 'font-family:Georgia,serif' : ''}">${mark}</span></span></div>
    <div class="peek-sec"><dl class="facts"><dt>种类</dt><dd>${kind} <span class="faint">· 创建后不能改</span></dd><dt>内容版本</dt><dd>v${ver}，旧版本都留着，已有的出图记录不受影响</dd><dt>上传</dt><dd>designer · 10-2${ver}</dd></dl></div>
    <div class="peek-sec uses"><div class="sec-t"><b>谁在引用</b>替换前会再查一次</div><a href="#/templates?sel=route-sign-h">${ic('tpl')}<span>线路牌 · 横版</span><span class="faint">2 处</span>${GO}</a><a href="#/datasets?def=route-sign">${ic('ds')}<span><b class="mono">${kind === '字体' ? 0 : 6}</b> 份数据集</span>${GO}</a></div>`;
}
PAGES.resources = (r) => {
  const sel = state.sel.resources ?? r.q.sel ?? RESOURCES[0][0]; state.sel.resources = sel;
  return {
    crumbs: [['资源']], list: 'resources', peek: peekResource,
    body: `<div class="pane">
      <div class="head"><h1>资源</h1><span class="count mono">${RESOURCES.length}</span><span class="sub">引用时写成 <code>res:资源ID</code></span><div class="spacer"></div><button class="btn primary" data-toast="选择文件上传（示意）">上传 <kbd>N</kbd></button></div>
      <div class="drop"><span class="glyph">${ic('upload')}</span><span>拖到这页的任何地方就开始上传</span><span class="faint mono">PNG · JPEG · WebP · SVG · TTF · OTF</span></div>
      <div class="filters"><label class="search">${ic('search')}<input placeholder="筛选资源 ID" data-filter><kbd>/</kbd></label><div class="chips"><button class="chip on">全部 <i class="n">15</i></button><button class="chip">图片 <i class="n">11</i></button><button class="chip">字体 <i class="n">4</i></button></div></div>
      <div class="res-grid">${RESOURCES.map(([id, kind, f2, ver, mark]) => `<div class="res ${id === sel ? 'sel' : ''}" data-row="${id}"><div class="th" style="${kind === '字体' ? 'font-family:Georgia,serif' : 'color:var(--muted)'}">${mark}</div><div class="m"><code>${id}</code><span>${f2}<span class="ver">v${ver}</span></span></div></div>`).join('')}</div>
    </div>`,
  };
};
PAGES.admin = () => ({
  crumbs: [['管理']], noPeek: true,
  body: `<div class="pane">
    <div class="head"><h1>管理</h1><div class="spacer"></div><button class="btn primary" data-toast="邀请成员（示意）">邀请成员 <kbd>N</kbd></button></div>
    <div class="tabs"><a class="on">成员<i>3</i></a><a>API 密钥<i>2</i></a><a>webhook<i>1</i></a><a>审批策略</a><a>审计日志</a></div>
    ${ledger('minmax(240px,1.3fr) 110px minmax(200px,1.4fr) 100px 90px', ['成员', '角色', '能做什么', '最近活动', ''], [
    ['admin@example.test', '客户管理员', '全部，另管成员、密钥、通知与审批', '刚刚'], ['operator@example.test', '操作员', '数据集、出图、资源；发布要批准', '12 分钟前'], ['designer@example.test', '设计者', '数据定义、模板、资源', '2 小时前'],
  ].map(([a, b, c, d], i) => ({ id: String(i), cells: [`<div class="nm"><span class="avatar">${a[0].toUpperCase()}</span><b class="cell-trunc">${a}</b>${i ? '' : '<span class="tag">你</span>'}</div>`, `<span class="tag">${b}</span>`, `<span class="muted cell-trunc">${c}</span>`, `<span class="muted">${d}</span>`, i ? '<div class="acts"><button class="btn sm">改角色</button></div>' : ''] })), null)}
  </div>`,
});
