// 原型用的示意数据。线路牌的字段与 M402 的站点取自 docs/examples/m402-dsl/，其余是编的。
const IMG = (n) => `imgs/${n}.png`;

const DEFS = [
  { id: 'route-sign', name: '线路牌', display: '线路牌（单线路单方向）', ver: 'v2', verAt: '10-28', draft: 'changed', changes: 3, by: 'designer', at: '2 小时前',
    refs: ['停靠站点 v1'], templates: 2, datasets: 24,
    fields: [
      ['routeNo', '线路号', 'text', ['必填', '1–10 字'], 'mod'], ['routeNoImage', '线路号图片', 'image', ['只取资源']], ['fareType', '票制', 'text', ['最多 10 字']],
      ['fare', '票价（元）', 'number', ['0–100']], ['fareNote', '票价说明', 'text', ['最多 20 字'], 'add'], ['operator', '运营方', 'text', ['最多 20 字']],
      ['firstDeparture', '首班', 'time', []], ['lastDeparture', '末班', 'time', []], ['nightLine', '夜班线路', 'bool', [], 'add'], ['serviceNote', '运营说明', 'text', ['最多 20 字']],
      ['scheduleType', '班车类型', 'text', ['最多 10 字']], ['departureTimes', '班次时刻', 'list', ['元素：时刻', '最多 60 项']], ['stops', '停靠站点', 'list', ['必填', '元素：停靠站点 v1', '2–50 项']],
    ],
    versions: [['草稿', 'draft', '相对 v2 有 3 处改动', 'designer · 2 小时前'], ['v2', 'cur', '22 份数据集 · 1 个模板', 'admin 发布于 2026-10-28'], ['v1', '', '2 份数据集 · 1 个模板', 'admin 发布于 2026-09-02']] },
  { id: 'stop', name: '停靠站点', display: '停靠站点', ver: 'v1', verAt: '09-02', draft: 'same', by: 'admin', at: '09-02', usedBy: '线路牌', templates: 0, datasets: 0,
    fields: [['name', '站名', 'text', ['必填', '1–20 字']], ['landmark', '地标', 'image', ['只取资源']], ['road', '所在道路', 'text', ['必填', '1–12 字']], ['badges', '站名上方的标识', 'list', ['元素：文本（地铁、医院）', '最多 3 项']]],
    versions: [['草稿', 'same', '与 v1 相同', ''], ['v1', 'cur', '被 线路牌 v1、v2 引用', 'admin 发布于 2026-09-02']] },
  { id: 'badge', name: '胸牌', display: '会议胸牌', ver: 'v3', verAt: '11-03', draft: 'pending', by: 'operator', at: '昨天', refs: ['场次 v1'], templates: 2, datasets: 128,
    fields: [['name', '姓名', 'text', ['必填', '1–12 字']], ['company', '单位', 'text', ['最多 24 字']], ['role', '身份', 'text', ['讲者、嘉宾、工作人员']], ['photo', '照片', 'image', []], ['seat', '座位', 'text', ['最多 8 字']], ['code', '编号', 'text', ['必填']], ['sessions', '参会场次', 'list', ['元素：场次 v1', '最多 4 项']]],
    versions: [['草稿', 'draft', '相对 v3 有 1 处改动 · 等待批准', 'operator · 昨天'], ['v3', 'cur', '128 份数据集 · 2 个模板', 'admin 发布于 2026-11-03'], ['v2', '', '没有数据集在用', '2026-10-12'], ['v1', '', '没有数据集在用', '2026-09-20']] },
  { id: 'session', name: '场次', display: '参会场次', ver: 'v1', verAt: '09-20', draft: 'same', by: 'admin', at: '09-20', usedBy: '胸牌', templates: 0, datasets: 0,
    fields: [['time', '开始', 'time', ['必填']], ['title', '场次名称', 'text', ['必填', '最多 16 字']], ['room', '会场', 'text', ['最多 8 字']]],
    versions: [['草稿', 'same', '与 v1 相同', ''], ['v1', 'cur', '被 胸牌 v1–v3 引用', 'admin 发布于 2026-09-20']] },
  { id: 'price-tag', name: '商品价签', display: '商品价签', ver: 'v2', verAt: '10-15', draft: 'same', by: 'operator', at: '10-15', templates: 1, datasets: 48,
    fields: [['title', '品名', 'text', ['必填', '最多 18 字']], ['price', '售价', 'number', ['必填', '≥ 0']], ['origin', '原价', 'number', ['≥ 0']], ['unit', '单位', 'text', ['最多 4 字']], ['points', '卖点', 'list', ['元素：文本', '最多 3 项']], ['barcode', '条码', 'text', ['必填', 'EAN-13']]],
    versions: [['草稿', 'same', '与 v2 相同', ''], ['v2', 'cur', '48 份数据集 · 1 个模板', 'operator 发布于 2026-10-15'], ['v1', '', '没有数据集在用', '2026-09-28']] },
];
const TYPE = { text: ['文', '文本'], number: ['数', '数值'], time: ['刻', '时刻'], bool: ['布', '布尔'], image: ['图', '图片'], list: ['列', '列表'] };

const TEMPLATES = [
  { id: 'route-sign-h', name: '线路牌 · 横版', def: 'route-sign', base: 'v2', size: '1500–3000 × 335–670 mm', shape: 'wide', art: 'm402-base', params: 3, datasets: 22, month: 8640, by: 'designer', at: '3 天前' },
  { id: 'route-sign-night', name: '线路牌 · 夜间配色', def: 'route-sign', base: 'v1', upgrade: 'v2', size: '1500–3000 × 335–670 mm', shape: 'wide', art: 'm402-color-navy', params: 2, datasets: 2, month: 576, by: 'designer', at: '10-30' },
  { id: 'badge', name: '会议胸牌', def: 'badge', base: 'v3', size: '90–100 × 130–140 mm', shape: 'tall', art: 'badge-base', params: 4, datasets: 128, month: 2816, by: 'designer', at: '昨天' },
  { id: 'badge-wide', name: '嘉宾胸牌 · 宽版', def: 'badge', base: 'v3', size: '100–110 × 135–145 mm', shape: 'tall', art: 'badge-wide', params: 3, datasets: 12, month: 128, by: 'operator', at: '11-05' },
  { id: 'price-points', name: '价签卖点', def: 'price-tag', base: 'v2', size: '60–90 × 40–60 mm', shape: 'tall', art: 'svg:price', params: 2, datasets: 48, month: 320, by: 'operator', at: '10-16' },
];

// ── 数据集：线路牌 24、胸牌 128、价签 48 ──
const ROUTES = [['M402', '万国城总站', '建设路总站'], ['18 路', '火车站', '梅林关'], ['M191', '科技园', '月亮湾'], ['B796', '福田口岸', '下梅林'], ['M223', '南山书城', '大学城'], ['高峰 46', '布吉街', '黄贝岭'],
  ['M312', '盐田港', '莲塘'], ['E11', '机场东', '罗湖口岸'], ['M133', '梧桐山', '东门'], ['N7', '皇岗口岸', '龙华汽车站'], ['M460', '松岗', '宝安中心'], ['B828', '大梅沙', '沙头角']];
const ROUTE_ART = ['m402-base', 'm402-terminal', 'm402-stop12', 'm402-stop8', 'm402-longname', 'm402-six', 'm402-fifty', 'm402-color-green'];
const SUR = '张李王刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹'.split('');
const GIV = ['三', '四', '芳', '伟', '静', '敏', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀英', '晓东', '海燕', '建国', '思源', '一诺', '子涵', '雨桐'];
const ORG = ['示例科技有限公司', '城市公交集团', '万国城商业', '东门设计事务所', '深南出版社', '文锦数据'];
const GOODS = ['冻干咖啡 12 颗装', '燕麦奶 1L', '手冲滤纸 100 片', '挂耳咖啡 10 包', '厚乳拿铁 250ml', '气泡水 330ml×6', '海盐苏打饼', '黑巧克力 72%', '每日坚果 30 包', '冷萃茶 500ml', '全麦吐司', '希腊酸奶 400g'];
const AGO = ['刚刚', '12 分钟前', '1 小时前', '2 小时前', '今天 09:14', '昨天', '昨天', '11-10', '11-09', '11-08', '11-06', '11-05', '11-03', '10-30'];

const DATASETS = [];
ROUTES.forEach(([no, a, b], i) => [a, b].forEach((to, j) => {
  const n = i * 2 + j, old = n === 20 || n === 21, bad = n === 2;
  DATASETS.push({ id: n === 0 ? 'ds-m402-wanguocheng' : `ds-${no.replace(/\s/g, '').toLowerCase()}-${j ? 'b' : 'a'}`, name: `${no} 开往${to}`, def: 'route-sign', ver: old ? 'v1' : 'v2', old,
    problems: bad ? 2 : 0, art: bad ? 'm402-missing' : ROUTE_ART[n % ROUTE_ART.length], tpl: old ? 'route-sign-night' : 'route-sign-h', at: AGO[n % AGO.length], by: n % 3 ? 'operator' : 'admin',
    last: n < 16 ? ['今天 10:42', '今天 10:41', '今天 10:41', '今天 10:40'][n % 4] : n === 2 ? null : '10-08', facts: [['线路号', no], ['终点', to], ['票价', '2 元 · 一票制'], ['首末班', '07:30 – 22:30'], ['停靠站点', `${[35, 28, 12, 8, 31, 6, 50, 22][n % 8]} 站`]] });
}));
const BADGE_ART = ['badge-base', 'badge-guest', 'badge-staff', 'badge-longname', 'badge-nophoto'];
for (let i = 0; i < 128; i += 1) {
  const name = i === 0 ? '张三' : SUR[(i * 7) % SUR.length] + GIV[(i * 5) % GIV.length], role = ['讲者', '嘉宾', '工作人员', '嘉宾', '嘉宾'][i % 5];
  DATASETS.push({ id: i === 0 ? 'badge-zhang' : `badge-${String(i + 1).padStart(4, '0')}`, name: `${name}的胸牌`, def: 'badge', ver: 'v3', problems: 0, art: BADGE_ART[i % 5], tpl: 'badge', at: AGO[(i + 3) % AGO.length], by: 'operator',
    last: '11-10 16:20', facts: [['姓名', name], ['单位', ORG[i % ORG.length]], ['身份', role], ['编号', `SP${String(i + 1).padStart(4, '0')}`], ['参会场次', `${1 + (i % 3)} 场`]] });
}
GOODS.forEach((g, i) => [0, 1, 2, 3].forEach((k) => {
  const n = i * 4 + k;
  DATASETS.push({ id: `tag-${String(n + 1).padStart(3, '0')}`, name: k ? `${g}（门店 ${k + 1}）` : g, def: 'price-tag', ver: 'v2', problems: 0, art: 'svg:price', tpl: 'price-points', at: AGO[(n + 6) % AGO.length], by: 'operator',
    last: '11-08 18:02', facts: [['品名', g], ['售价', `¥ ${(9.9 + i * 3.1).toFixed(2)}`], ['单位', ['盒', '瓶', '包'][i % 3]], ['卖点', '2 条'], ['条码', `69012345${String(10000 + n * 37).slice(0, 5)}`]] });
}));
const PROBLEMS = [
  { lv: '严重', text: '「所在道路」必填，这一站没有填', path: 'stops[7].road', el: '标准线路单边/站点面板/站点列[8]/道路区/路名' },
  { lv: '提示', text: '站名超过 8 个字，会启用字形压缩', path: 'stops[11].name', el: '标准线路单边/站点面板/站点列[12]/名称区/站名', hint: true },
];

// ── 批次与渲染项 ──
const items = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const BATCHES = [
  { id: 'b-1112-01', name: '十一月线路牌换版', tpl: 'route-sign-h', def: 'route-sign', at: '今天 10:38', dur: '进行中', by: 'operator', src: '控制台', out: '2400 × 536 mm · 300 DPI · PNG',
    cells: items(24, (i) => (i < 13 ? 'ok' : i === 13 ? 'bad' : i < 16 ? 'ok' : i < 18 ? 'run' : 'wait')).map((s, i) => (i === 2 ? 'bad' : s)) },
  { id: 'b-1110-02', name: '技术大会胸牌 · 第一批', tpl: 'badge', def: 'badge', at: '11-10 16:02', dur: '18 分 04 秒', by: 'operator', src: '控制台', out: '95 × 135 mm · 300 DPI · PNG', cells: items(128, () => 'ok') },
  { id: 'b-1108-01', name: '周末促销价签', tpl: 'price-points', def: 'price-tag', at: '11-08 17:55', dur: '6 分 41 秒', by: 'api:store-sync', src: 'API 密钥', out: '70 × 50 mm · 203 DPI · PNG', cells: items(48, (i) => (i === 19 || i === 33 ? 'bad' : 'ok')) },
  { id: 'b-1105-01', name: '嘉宾胸牌补印', tpl: 'badge-wide', def: 'badge', at: '11-05 09:20', dur: '1 分 52 秒', by: 'operator', src: '控制台', out: '105 × 140 mm · 300 DPI · PNG', cells: items(12, () => 'ok') },
  { id: 'b-1103-02', name: '夜间线路牌试印', tpl: 'route-sign-night', def: 'route-sign', at: '11-03 20:11', dur: '已取消', by: 'designer', src: '控制台', out: '2400 × 536 mm · 150 DPI · PNG', canceled: true, cells: items(6, (i) => (i < 4 ? 'ok' : 'stop')) },
  { id: 'b-1101-01', name: '十月线路牌', tpl: 'route-sign-h', def: 'route-sign', at: '11-01 08:30', dur: '9 分 15 秒', by: 'admin', src: '控制台', out: '2400 × 536 mm · 300 DPI · PNG', cells: items(22, () => 'ok') },
];
const BUILD = 'sha256:1e000e8087ba…c41d';

// ── 用量 ──
const MONTH_USED = 12480, QUOTA = 50000;
const RESOURCES = [
  ['route-no-m402', '图片', 'SVG', 2, 'M402'], ['landmark-1', '图片', 'SVG', 1, '◎'], ['landmark-2', '图片', 'SVG', 1, '✚'], ['landmark-3', '图片', 'SVG', 3, 'Ⓜ'], ['landmark-4', '图片', 'SVG', 1, '◈'],
  ['bus-group-logo', '图片', 'PNG', 4, '巴'], ['badge-header-wave', '图片', 'SVG', 2, '〜'], ['avatar-placeholder', '图片', 'PNG', 1, '☺'], ['conf-2026-logo', '图片', 'SVG', 2, '26'],
  ['source-han-sans-bold', '字体', 'OTF', 1, 'Aa'], ['source-han-sans-regular', '字体', 'OTF', 1, 'Aa'], ['din-condensed', '字体', 'TTF', 1, '12'], ['route-italic', '字体', 'TTF', 2, 'M4'],
  ['promo-burst', '图片', 'SVG', 1, '✸'], ['store-logo', '图片', 'PNG', 1, '店'],
];
const STOPS = [['建设路总站', '建设路', '', ''], ['建设路', '建设路', '地铁', ''], ['中国银行大厦', '建设路', '', ''], ['门诊部', '深南路', '', 'landmark-2'], ['东门', '东门路', '', 'landmark-3'], ['田贝', '文锦路', '', 'landmark-2'], ['洪湖公园', '文锦路', '', 'landmark-2'],
  ['东晓街道办', '文锦北路', '', 'landmark-1'], ['草埔地铁站', '文锦北路', '', 'landmark-4'], ['荣超花园', '龙岗大道', '', 'landmark-1'], ['粤宝宝丽路口', '粤宝路', '', ''], ['粤宝', '粤宝路', '', ''], ['粤宝红岗路口', '粤宝路', '', ''], ['德兴花园', '西环路', '', ''],
  ['钱排村', '西环路', '', ''], ['德福花园', '西环路', '', ''], ['莲花山庄', '西环路', '', ''], ['春蕾幼儿园', '西环路', '', ''], ['东升学校', '西环路', '', ''], ['金沙花园', '西环路', '', ''], ['森鑫源学校', '西环路', '', ''], ['布吉中学', '吉华路', '医院', ''],
  ['布吉天虹', '中兴路', '', ''], ['大世纪花园', '中兴路', '', ''], ['布龙立交', '东西干道', '', ''], ['石芽岭公园', '东西干道', '', ''], ['大龙山物流园', '东西干道', '', ''], ['左庭右院', '红棉路', '', ''], ['尚峰花园', '布澜路', '', ''], ['石芽岭地铁站', '布澜路', '', ''],
  ['联创科技园', '布澜路', '', ''], ['第三人民医院', '布澜路', '医院', ''], ['李朗国际珠宝园', '布澜路', '', ''], ['左右家私', '平吉大道', '', ''], ['万国城总站', '平朗路', '', '']];
const TIMES = ['08:00', '08:25', '08:50', '09:10', '09:30', '09:50', '10:30', '17:35', '17:50', '18:00', '18:15', '18:30', '18:50', '19:35', '20:25'];
