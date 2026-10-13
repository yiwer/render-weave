/** 完整 M402 和 SVG/缺字替代的编译 CLI 自足记录验收。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/stage2/closure-windows');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-')), origin = join(run, 'origin');
const resources = join(origin, 'resources'), extra = join(origin, 'extra');
await mkdir(extra, { recursive: true });
const cli = (...args) => execFileSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8', windowsHide: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
cli('resources-init', '--resources', resources);
cli('resources-import', '--source', 'fixtures/resources', '--resources', resources);
await cp('fixtures/resources/font-subsets/TestSubset-Regular.otf', join(extra, 'subset.otf'));
await cp('fixtures/workspaces/record-media/text.svg', join(extra, 'text.svg'));
await writeFile(join(extra, 'resources.json'), JSON.stringify({ resources: [
  { id: 'subset', kind: 'font', file: 'subset.otf' }, { id: 'record-text-svg', kind: 'image', file: 'text.svg' },
] }));
cli('resources-import', '--source', extra, '--resources', resources);
const hashes = {}, evidence = {};
for (const [name, source, requestFile] of [
  ['m402', 'docs/examples/m402-dsl', 'render-request-m402.json'],
  ['media', 'fixtures/workspaces/record-media', 'render-request.json'],
]) {
  const workspace = join(origin, name); await cp(source, workspace, { recursive: true });
  const single = await json(join(workspace, requestFile)), { template, mode, ...item } = single;
  const batch = join(origin, `${name}-batch.json`);
  await writeFile(batch, JSON.stringify({ template, mode, items: [{ id: name, ...item }] }));
  const delivery = join(origin, `${name}-batch`), record = join(delivery, '0001'), independent = join(run, `${name}-independent`);
  const optionArgs = name === 'media' ? ['--options', join(workspace, 'options.json')] : [];
  const plain = join(origin, `${name}-plain`);
  // render CLI 没有字体选项；通过公开 API 比较完全相同的配置与版本字节。
  const { loadWorkspace, render } = await import('../dist/index.js');
  const direct = await render(await loadWorkspace({ dir: workspace, resourcesDir: resources }), single,
    name === 'media' ? await json(join(workspace, 'options.json')) : {});
  assert(direct.image && direct.layout); await mkdir(plain);
  await writeFile(join(plain, 'image.png'), direct.image.bytes);
  await writeFile(join(plain, 'layout.json'), JSON.stringify(direct.layout, null, 2) + '\n');
  await writeFile(join(plain, 'problems.json'), JSON.stringify(direct.problems, null, 2) + '\n');
  process.stdout.write(cli('deliver', '--workspace', workspace, '--resources', resources, '--request', batch, '--out', delivery, ...optionArgs));
  for (const file of ['image.png', 'layout.json', 'problems.json']) assert.deepEqual(await readFile(join(record, file)), await readFile(join(plain, file)));
  assert.equal(direct.problems.length, name === 'media' ? 1 : 0);
  if (name === 'media') assert.equal(direct.problems[0].code, 'text.glyphFallback');
  await cp(record, independent, { recursive: true });
  const input = await json(join(record, 'input.json'));
  // 修改所有当前模板、数据集和字体选项；历史记录已经持有实际内容。
  for (const template of input.documents.templates) {
    const path = template.source; if (!path) continue;
    const document = await json(path); document.artboard.fill = '#000000'; await writeFile(path, JSON.stringify(document));
  }
  await writeFile(join(workspace, requestFile), JSON.stringify({ ...single, parameters: {} }));
  if (name === 'm402') {
    const file = join(workspace, 'dataset-m402.json'), data = await json(file);
    data.data.routeNo = 'CHANGED'; await writeFile(file, JSON.stringify(data));
  }
  await writeFile(join(workspace, 'options.json'), JSON.stringify({ fallbackFonts: [], svgFonts: [] }));
  evidence[name] = { record: independent, replay: join(run, `${name}-replay`), templates: input.documents.templates.length,
    schemas: input.documents.staticSchemas.map(s => s.ref), problems: direct.problems, build: (await json(join(record, 'record.json'))).build };
}
// 改变资源文件位置后，再移走原工作区、仓库和原记录；受控目录先检查两端。
const objects = join(resources, 'objects'), relocated = join(resources, 'relocated-objects'), moved = join(run, 'unavailable-origin');
for (const path of [objects, relocated, origin, moved]) { const rel = relative(run, path); assert(rel && !rel.startsWith('..') && !isAbsolute(rel)); }
await rename(objects, relocated); await rename(origin, moved);
for (const name of ['m402', 'media']) {
  const item = evidence[name];
  cli('record-read', '--record', item.record);
  process.stdout.write(cli('replay', '--record', item.record, '--out', item.replay));
  hashes[name] = {};
  for (const file of ['image.png', 'layout.json', 'problems.json']) {
    const bytes = await readFile(join(item.record, file)); assert.deepEqual(await readFile(join(item.replay, file)), bytes);
    hashes[name][file] = hash(bytes);
  }
}
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform }, null, 2) + '\n');
console.log(`PASS: M402 and PNG/JPEG/WebP/SVG with glyph fallback replay independently; ${run}`);
