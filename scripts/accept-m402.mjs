/** M402 验收制品：npm run build 后运行，不改写共享 DSL、静态数据定义或数据集。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { loadWorkspace, readPngInfo, render } from '../dist/index.js';

const source = 'docs/examples/m402-dsl';
const output = resolve(process.argv[2] ?? 'out/ticket14');
const originals = new Map();
for (const name of (await readdir(source)).filter((name) => name.endsWith('.json'))) {
  originals.set(name, await readFile(join(source, name)));
}
const workspace = await loadWorkspace({ dir: source, resourcesDir: 'fixtures/resources' });
assert.deepEqual(workspace.problems, []);
const request = JSON.parse(originals.get('render-request-m402.json').toString());
const changedName = (index, name) => {
  const document = structuredClone(workspace.datasets.find((entry) => entry.id === request.dataset.id).document);
  document.data.stops[index - 1].name = name;
  return { ...request, dataset: { inline: document } };
};
const cases = [
  ['base', '本站 5 · 原始请求', request],
  ['current-0', '不标本站', { ...request, parameters: { currentIndex: 0 } }],
  ['current-35', '末站 35', { ...request, parameters: { currentIndex: 35 } }],
  ['current-36', '越界 36 · 正式不出图', { ...request, parameters: { currentIndex: 36 } }, 'check.failed'],
  ['wide', '宽度 1500 mm', { ...request, output: { ...request.output, width: 1500 } }],
  ['long-name', '第 9 站 · 11 字长站名', changedName(9, '深圳市龙岗区人民医院站')],
  ['missing-glyph', '第 12 站 · 缺字 U+31350', changedName(12, '粤宝\u{31350}'), 'text.glyphMissing'],
];
const flatten = (node) => [node, ...(node.children ?? []).flatMap(flatten)];
const summary = [];
for (const [id, label, input, expectedError] of cases) {
  const result = await render(workspace, input);
  assert.deepEqual(result.problems.map((problem) => problem.code), expectedError ? [expectedError] : [], id);
  assert.equal(Boolean(result.image), !expectedError, id);
  const dir = join(output, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'request.json'), JSON.stringify(input, null, 2) + '\n');
  await writeFile(join(dir, 'problems.json'), JSON.stringify(result.problems, null, 2) + '\n');
  await writeFile(join(dir, 'layout.json'), JSON.stringify(result.layout, null, 2) + '\n');
  if (result.image) await writeFile(join(dir, 'image.png'), result.image.bytes);
  else {
    // 只清除本场景的陈旧产物，重复运行时不会把旧图片误认成正式出图。
    await rm(join(dir, 'image.png'), { force: true });
    const draft = await render(workspace, { ...input, mode: 'draft' });
    assert.deepEqual(draft.problems, result.problems, `${id} 两种模式诊断`);
    assert.ok(draft.image);
    await writeFile(join(dir, 'draft.png'), draft.image.bytes);
  }
  const nodes = flatten(result.layout.root);
  const names = nodes.filter((node) => node.name === '站名');
  summary.push({ id, label, image: result.image ? readPngInfo(result.image.bytes) : null,
    problems: result.problems, stopCount: names.length,
    roadCount: nodes.find((node) => node.name === '道路段列').children.length,
    fontSizes: [...new Set(names.map((node) => node.text.fontSize))],
    nextStopVisible: nodes.find((node) => node.name === '下一站区').visible,
    ...(id === 'long-name' && { longName: names[8].text }),
  });
}
for (const [name, bytes] of originals) assert.deepEqual(await readFile(join(source, name)), bytes, `原文件 ${name}`);
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
await writeFile(join(output, 'inputs.sha256.json'), JSON.stringify(Object.fromEntries([...originals].map(([name, bytes]) =>
  [name, createHash('sha256').update(bytes).digest('hex')])), null, 2) + '\n');

const reference = relative(output, resolve('docs/examples/materials/m402-route-sign.jpg')).replaceAll('\\', '/');
const report = relative(output, resolve('docs/examples/m402-acceptance.md')).replaceAll('\\', '/');
await writeFile(join(output, 'comparison.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>M402 端到端验收对照</title><style>
body{font:16px system-ui;margin:24px;color:#172b4d;background:#f2f4f7}h1{font-size:24px}h2{font-size:18px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pair figure{margin:0;min-width:0}img{display:block;width:100%;background:white}
figcaption,p{margin:8px 0 16px;line-height:1.6}button{padding:8px 14px}body.actual .pair{width:7008px}
section{margin-top:32px}section img{max-width:1800px}a{color:#005eb8}</style>
<h1>M402 端到端验收</h1><p>左侧为参考设计稿，右侧为直接加载原工作区的正式出图；点击可切换到原像素尺寸横向查看。</p>
<button onclick="document.body.classList.toggle('actual')">切换原像素尺寸</button>
<div class="pair"><figure><h2>参考设计稿</h2><img src="${reference}"><figcaption>3496 × 780 像素</figcaption></figure>
<figure><h2>引擎输出 · 本站 5</h2><img src="base/image.png"><figcaption>740 × 165 mm · 120 DPI · 0 个问题</figcaption></figure></div>
<p>结论：首期结构与行为验收通过。四区结构、站点顺序、本站高亮和道路合并对齐；顶栏尺寸/字体、底栏起点与素材外观的差异见
<a href="${report}">验收记录</a>。</p>
${summary.slice(1).map((item) => `<section><h2>${item.label}</h2><p>${item.image ? `${item.image.width} × ${item.image.height} 像素，0 个问题` :
  `正式无图片；下图为草稿。问题：${item.problems.map((p) => p.code).join(', ')}`}</p><img src="${item.id}/${item.image ? 'image' : 'draft'}.png"></section>`).join('\n')}
</html>`);
console.log(JSON.stringify(summary.map(({ id, image, problems, fontSizes, longName }) => ({ id, image,
  problems: problems.map((p) => p.code), fontSizes, ...(longName && { compression: longName.compression }) })), null, 2));
console.log(`验收通过，原始 11 份 JSON 未改写。对照页：${join(output, 'comparison.html')}`);
