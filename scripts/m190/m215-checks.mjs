// M215 用户验收指出的两处版面约定的自动检查，评估脚本与模板辅助修改的实跑共用。
// 用法：node scripts/m190/m215-checks.mjs --workspace <工作区> --resources <资源仓库> --request <出图请求.json> [--out <草稿.png>]
// 按出图请求以草稿模式渲染，输出问题数与两项检查的结果（JSON）。需要先 npm run build。
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 约定一（领域约定 10，M27、M77）：地标是竖排站名的最后一格，无地标站名的底边与有地标列的地标底边齐平。
 * 取第 1 站（无地标）与第 4 站（有地标）比较，差值单位毫米，2 mm 以内通过。stops 是数据集中的站点列表。
 */
export function landmarkBaseline(layout, stops) {
  if (!Array.isArray(stops) || stops.length < 4) return { found: false, reason: '数据集中没有 stops 列表或不足 4 站' };
  const nodes = [];
  (function walk(n) { nodes.push(n); for (const c of n.children ?? []) walk(c); })(layout.root);
  const visible = nodes.filter((n) => n.visible !== false && typeof n.y === 'number');
  // 比较前去掉首尾空白（含全角空格）：有的模板用空格给地标占位。
  const name = (content) => visible.find((n) => n.type === 'text' && n.text?.content?.trim() === content && n.text?.writingMode === 'vertical');
  const plain = name(stops[0].name), marked = name(stops[3].name);
  if (!plain || !marked) return { found: false };
  const prefix = marked.path.slice(0, marked.path.lastIndexOf(']') + 1);
  const landmark = visible.filter((n) => n.type === 'image' && n.path.startsWith(prefix) && n.y >= marked.y).sort((a, b) => b.y - a.y)[0];
  if (!landmark) return { found: false, reason: '有地标的列中找不到地标图片' };
  const delta = Number((plain.y + plain.height - (landmark.y + landmark.height)).toFixed(2));
  return { found: true, deltaMm: delta, pass: Math.abs(delta) <= 2 };
}

/** 约定二（领域约定 11，M131）：道路名用同间隔分布。静态检查工作区模板中插槽绑定 road 的文字元素。 */
export async function roadAlign(workspaceDir) {
  const aligns = [];
  for (const f of (await readdir(workspaceDir)).sort()) {
    if (!f.endsWith('.json')) continue;
    const doc = JSON.parse(await readFile(join(workspaceDir, f), 'utf8'));
    if (doc.dslVersion !== 'renderweave-template/1') continue;
    (function walk(v) {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== 'object') return;
      if (v.type === 'text' && Array.isArray(v.content) && v.content.some((c) => typeof c.slot === 'string' && /(^|\.)road$/.test(c.slot))) aligns.push(v.horizontalAlign ?? 'start');
      Object.values(v).forEach(walk);
    })(doc);
  }
  return { aligns, pass: aligns.length > 0 && aligns.every((a) => a === 'spaceEvenly') };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const [workspaceDir, resourcesDir, requestFile] = [opt('workspace'), opt('resources'), opt('request')];
  if (!workspaceDir || !resourcesDir || !requestFile) {
    console.error('用法：node scripts/m190/m215-checks.mjs --workspace <工作区> --resources <资源仓库> --request <出图请求.json> [--out <草稿.png>]');
    process.exit(2);
  }
  const engine = await import(pathToFileURL(join(REPO, 'dist/index.js')).href);
  const workspace = await engine.loadWorkspace({ dir: workspaceDir, resourcesDir });
  const request = { ...JSON.parse(await readFile(requestFile, 'utf8')), mode: 'draft' };
  const result = await engine.render(workspace, request);
  if (result.image && opt('out')) await writeFile(opt('out'), result.image.bytes);
  const dataset = workspace.datasets.find((entry) => entry.id === request.dataset.id);
  const severe = result.problems.filter((problem) => problem.level === 'severe');
  console.log(JSON.stringify({
    problems: { severe: severe.length, hint: result.problems.length - severe.length, codes: [...new Set(severe.map((problem) => problem.code))] },
    landmarkBaseline: result.layout ? landmarkBaseline(result.layout, dataset.document.data.stops) : { found: false, reason: '没有布局摘要' },
    roadAlign: await roadAlign(workspaceDir),
  }, null, 2));
}
