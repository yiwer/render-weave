// 用引擎真实渲染，生成原型的 data.json 与 imgs/。用法：在仓库根跑 npx tsx docs/prototypes/template-design/build-data.mts
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadWorkspace, render, publishStaticSchema, dslDocumentKind, openResourceRepository } from '../../../src/index.js';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url)), OUT = fileURLToPath(new URL('./', import.meta.url)), resourcesDir = join(REPO, 'fixtures/resources');
const clone = <T>(x: T): T => structuredClone(x);
const flatten = (n: any, d = 0): any[] => [{ ...n, children: undefined, _d: d }, ...(n.children ?? []).flatMap((c: any) => flatten(c, d + 1))];
const round = (v: number) => Math.round(v * 1000) / 1000;

async function shot(ws: any, fam: string, id: string, req: any) {
  const t = performance.now();
  const r: any = await render(ws, { ...req, mode: 'draft' }, { elementLocations: true });
  const ms = Math.round(performance.now() - t);
  const file = `imgs/${fam}-${id}.png`;
  if (r.image) await writeFile(join(OUT, file), r.image.bytes);
  const src = new Map((r.elements ?? []).map((e: any) => [e.path, e.source]));
  const nodes = r.layout ? flatten(r.layout.root).map((n: any) => {
    const s: any = src.get(n.path);
    const o: any = { p: n.path, n: n.name, t: n.type, x: round(n.x), y: round(n.y), w: round(n.width), h: round(n.height), v: n.visible ? 1 : 0, d: n._d };
    if (s) o.s = [s.template, s.path];
    if (n.text) o.tx = { c: n.text.content, fs: n.text.fontSize, sp: round(n.text.spacing), cmp: n.text.compression, ov: n.text.overflow ? 1 : 0, sg: n.text.shrinkGroup, wm: n.text.writingMode, col: n.text.fragments?.[0]?.color, w: round(n.text.width), h: round(n.text.height), ff: n.text.fontFallback ? 1 : 0 };
    if (n.image) o.im = { src: n.image.source, fit: n.image.fit, nw: n.image.naturalWidth, nh: n.image.naturalHeight };
    return o;
  }) : [];
  console.log(fam, id, `${ms}ms`, `${r.image?.widthPx}x${r.image?.heightPx}`, `${Math.round((r.image?.bytes.length ?? 0) / 1024)}KB`, `nodes=${nodes.length}`, `problems=${r.problems.length}`);
  return { img: file, widthPx: r.image?.widthPx, heightPx: r.image?.heightPx, dpi: req.output.dpi, ms, problems: r.problems, nodes, output: { width: req.output.width, height: req.output.height } };
}

async function jsonDocs(dir: string) {
  const out: any[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.json'))) out.push(JSON.parse(await readFile(join(dir, f), 'utf8')));
  return out;
}
async function jsonBlocks(file: string) {
  const text = await readFile(join(REPO, file), 'utf8');
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].flatMap((m) => { try { return [JSON.parse(m[1]!)]; } catch { return []; } });
}
function memWs(base: any, mutate: (name: string, doc: any) => void) {
  return { ...base, templates: base.templates.map((t: any) => { const document = clone(t.document); mutate(t.name, document); return { ...t, document }; }) };
}
const setDefault = (doc: any, n: string, val: any) => { const p = (doc.parameters || []).find((x: any) => x.name === n); if (p) p.default = val; };

await mkdir(join(OUT, 'imgs'), { recursive: true });

// ——— M402 ———
const m402dir = join(REPO, 'docs/examples/m402-dsl');
const ws = await loadWorkspace({ dir: m402dir, resourcesDir });
const docs = await jsonDocs(m402dir);
const mTemplates = Object.fromEntries(docs.filter((d) => d.dslVersion === 'renderweave-template/1').map((d) => [d.name, d]));
const mSchemas = Object.fromEntries(docs.filter((d) => d.dslVersion === 'renderweave-schema/1').map((d) => [`${d.name}@${d.version}`, d]));
const baseReq = JSON.parse(await readFile(join(m402dir, 'render-request-m402.json'), 'utf8'));
const ds = clone((ws.datasets[0] as any).document);
const DPI = 100;
const mReq = (over: any = {}) => ({ ...baseReq, output: { ...baseReq.output, dpi: DPI, ...(over.output || {}) }, parameters: over.parameters ?? baseReq.parameters, dataset: { inline: over.data ?? ds } });
const mk = (fn: (d: any) => void) => { const d = clone(ds); fn(d); return d; };
const mSamples: any[] = [];
async function mS(id: string, label: string, note: string, group: string, over: any = {}) {
  const data = over.data ?? ds;
  const s = await shot(ws, 'm402', id, mReq(over));
  mSamples.push({ id, label, note, group, params: over.parameters ?? baseReq.parameters, data: data.data, ...s });
}
await mS('base', 'M402 开往万国城', '本站 5 · 740 mm', '数据集');
await mS('noindex', 'M402 不标本站', '本站 0', '数据集', { parameters: { currentIndex: 0 } });
await mS('terminal', 'M402 末站', '本站 35', '数据集', { parameters: { currentIndex: 35 } });
await mS('textno', '没有线路号图片', '线路号改用文字', '数据集', { data: mk((d) => { delete d.data.routeNoImage; }) });
await mS('wide', '1500 mm 宽', '同数据，重新排布', '压测', { output: { width: 1500 } });
await mS('six', '只有 6 站', '站少时列很宽', '压测', { parameters: { currentIndex: 2 }, data: mk((d) => { d.data.stops = d.data.stops.slice(0, 6); }) });
await mS('fifty', '50 站（上限）', '列宽收窄，站名被压', '压测', { parameters: { currentIndex: 12 }, data: mk((d) => { const st = d.data.stops; while (st.length < 50) { const b = clone(st[st.length % 35]); b.name = b.name + '北'; st.push(b); } }) });
await mS('longname', '两个超长站名', '放不下的站名报严重问题', '压测', { data: mk((d) => { d.data.stops[9].name = '粤宝宝丽路口东侧公交枢纽站'; d.data.stops[17].name = '广州国际生物岛南门外环路站'; }) });
await mS('missing', '缺值与越界', '本站 40，首站站名为空', '压测', { parameters: { currentIndex: 40 }, data: mk((d) => { delete d.data.routeNoImage; delete d.data.fare; d.data.stops[0].name = ''; }) });
const mVariants: any = {};
for (const v of [8, 12, 14]) mVariants[`标准线路单边|param|stopNameSize|${v}`] = await shot(memWs(ws, (n, d) => { if (n === '标准线路单边') setDefault(d, 'stopNameSize', v); }), 'm402', `stop${v}`, mReq());
for (const [k, c] of [['green', '#1D6B3C'], ['navy', '#293642']] as const) mVariants[`标准线路单边|param|primaryColor|${c}`] = await shot(memWs(ws, (n, d) => { if (n === '标准线路单边') setDefault(d, 'primaryColor', c); }), 'm402', `color-${k}`, mReq());

// ——— 胸牌（docs/dsl 的示例）———
const defBlocks = await jsonBlocks('docs/dsl/data-definition.md');
const entries: any[] = [];
const bSchemas: any = {};
for (const d of defBlocks.filter((d) => dslDocumentKind(d) === 'definition')) {
  const { published, problems } = publishStaticSchema(d, entries) as any;
  if (problems.length) console.log('schema problems', problems);
  entries.push(published);
  bSchemas[`${d.name}@${d.version ?? 1}`] = d;
}
const bDs = defBlocks.find((d) => dslDocumentKind(d) === 'dataset');
const bTpl = (await jsonBlocks('docs/dsl/template.md')).filter((d) => dslDocumentKind(d) === 'template');
const { repository } = await openResourceRepository(resourcesDir);
const bWs: any = { staticSchemas: entries, templates: bTpl.map((document) => ({ name: document.name, document })), datasets: [{ id: bDs.dataset.id, document: bDs }], resources: repository, problems: [] };
const bTemplates = Object.fromEntries(bTpl.map((d) => [d.name, d]));
const bReq = (over: any = {}) => ({ template: '标准胸牌', dataset: { inline: over.data ?? bDs }, parameters: over.parameters ?? { showQr: true }, output: { width: 90, height: 130, dpi: 220, format: 'png', ...(over.output || {}) }, mode: 'draft' });
const bk = (fn: (d: any) => void) => { const d = clone(bDs); fn(d); return d; };
const bSamples: any[] = [];
async function bS(id: string, label: string, note: string, group: string, over: any = {}) {
  const data = over.data ?? bDs;
  const s = await shot(bWs, 'badge', id, bReq(over));
  bSamples.push({ id, label, note, group, params: over.parameters ?? { showQr: true }, data: data.data, ...s });
}
console.log('badge data keys', Object.keys(bDs.data), 'role', bDs.data.role);
await bS('base', `${bDs.data.fullName} · ${bDs.data.role}`, '90 × 130 mm', '数据集');
await bS('guest', '嘉宾身份', '身份色跟着变', '数据集', { data: bk((d) => { d.data.role = '嘉宾'; }) });
await bS('staff', '工作人员 · 无场次', '隐藏的元素不占位', '数据集', { data: bk((d) => { d.data.role = '工作人员'; d.data.sessions = []; }) });
await bS('noqr', '不显示签到码', '对外参数 showQr 关闭', '数据集', { parameters: { showQr: false } });
await bS('longname', '超长姓名', '收紧字距、压缩字形、再缩字', '压测', { data: bk((d) => { d.data.fullName = '欧阳司马上官慕容娜娜'; }) });
await bS('nophoto', '没有照片', '检查项给提示', '压测', { data: bk((d) => { delete d.data.photo; }) });
await bS('wide', '100 × 140 mm', '尺寸范围的上限', '压测', { output: { width: 100, height: 140 } });
const bVariants: any = {};
const setNameSize = (v: number) => (n: string, d: any) => { if (n !== '标准胸牌') return; (function w(e: any) { if (e.name === '姓名') e.fontSize = v; (e.children || []).forEach(w); })(d.artboard); };
for (const v of [6, 10]) bVariants[`标准胸牌|标准胸牌/姓名|fontSize|${v}`] = await shot(memWs(bWs, setNameSize(v)), 'badge', `name${v}`, bReq());

const out = {
  families: [
    { id: 'm402', label: '线路牌', hint: '横版，堆叠与循环为主', root: '标准线路单边', templates: mTemplates, schemas: mSchemas, samples: mSamples, variants: mVariants,
      knobs: [{ label: '本站序号', options: [['0', 'noindex'], ['5', 'base'], ['35', 'terminal']] }, { label: '画板宽', options: [['740', 'base'], ['1500', 'wide']] }] },
    { id: 'badge', label: '胸牌', hint: '竖版，网格加自由布局', root: '标准胸牌', templates: bTemplates, schemas: bSchemas, samples: bSamples, variants: bVariants,
      knobs: [{ label: '显示签到码', options: [['开', 'base'], ['关', 'noqr']] }, { label: '画板', options: [['90×130', 'base'], ['100×140', 'wide']] }] },
  ],
};
await writeFile(join(OUT, 'data.json'), JSON.stringify(out));
console.log('data.json KB', Math.round(JSON.stringify(out).length / 1024));
