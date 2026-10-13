/**
 * PRD A12 千项长批次验收：同一进程先以 50 项 M402 批次预热，再顺序正式交付 1,000 项（本站 1–35 循环）。
 * 逐项核对图片与布局摘要和预热结果一致；全程采样 RSS，最后 50 项中位数较前 50 项中位数增长不得超过 256 MiB；
 * 记录耗时、峰值、磁盘实际占用与去重方式，并核对源输入未变、最后一项复制后可独立重放。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? `out/stage2/long-${process.platform === 'win32' ? 'windows' : 'linux'}`);
const total = Number(process.argv[3] ?? 1000), warmupItems = 50, window = 50, limitMiB = 256;
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const { deliverBatch, importResources, initializeResourceStore, loadWorkspace, openVersionedResourceStore, replayOutputRecord } = await import('../dist/index.js');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mib = bytes => Math.round(bytes / 1024 / 1024 * 10) / 10;
const median = values => { const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1; return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; };
async function tree(dir) {
  const files = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); files[relative(dir, path)] = hash(await readFile(path)); }
  }
  return hash(JSON.stringify(Object.entries(files).sort()));
}

const workspaceDir = 'docs/examples/m402-dsl', resources = join(run, 'resources');
assert.deepEqual((await initializeResourceStore(resources)).problems, []);
assert.deepEqual((await importResources({ sourceDir: 'fixtures/resources', dir: resources })).problems, []);
const store = (await openVersionedResourceStore(resources)).store;
const workspace = await loadWorkspace({ dir: workspaceDir, resourcesDir: resources });
const single = JSON.parse(await readFile(join(workspaceDir, 'render-request-m402.json'), 'utf8'));
const inputsBefore = { workspace: await tree(workspaceDir), resources: await tree(resources) };
const request = (prefix, count) => ({ template: single.template, mode: 'final', items: Array.from({ length: count }, (_, i) =>
  ({ id: `${prefix}-${String(i + 1).padStart(4, '0')}`, dataset: single.dataset, parameters: { currentIndex: (i % 35) + 1 }, output: single.output })) });
const stopOf = index => ((index - 1) % 35) + 1;

// 全程采样：每秒一次，另在每项结束时记一次。
const timeline = [], started = performance.now();
// heapUsed 是 V8 堆，external 含 ArrayBuffer 与 WASM 线性内存，用来区分增长来源。
const sample = phase => { const { rss, heapUsed, external } = process.memoryUsage(); timeline.push({ t: Math.round(performance.now() - started), phase, rss, heapUsed, external }); return { rss, heapUsed, external }; };
const sampler = setInterval(() => sample('interval'), 1000);

// 预热：记录每个本站的图片与布局摘要哈希，作为长批次的比较基准。
const expected = new Map();
const warmup = await deliverBatch({ workspace, resources: store, request: request('warmup', warmupItems), outDir: join(run, 'warmup'),
  onItem: async item => {
    assert.equal(item.status, 'delivered', JSON.stringify(item.problems));
    const files = [await readFile(join(item.directory, 'image.png')), await readFile(join(item.directory, 'layout.json'))].map(hash);
    const stop = stopOf(item.index), seen = expected.get(stop);
    if (seen) assert.deepEqual(files, seen, `预热中本站 ${stop} 前后不一致`); else expected.set(stop, files);
    sample('warmup');
  } });
assert.equal(warmup.summary.delivered, warmupItems);

const batchDir = join(run, 'long'), itemRss = [];
const mainStarted = performance.now();
const result = await deliverBatch({ workspace, resources: store, request: request('item', total), outDir: batchDir,
  onItem: async item => {
    assert.equal(item.status, 'delivered', JSON.stringify(item.problems));
    const files = [await readFile(join(item.directory, 'image.png')), await readFile(join(item.directory, 'layout.json'))].map(hash);
    assert.deepEqual(files, expected.get(stopOf(item.index)), `第 ${item.index} 项与预热结果不一致`);
    itemRss.push(sample('item'));
    if (item.index % 100 === 0) { const now = itemRss.at(-1); console.log(`${item.index}/${total} rss=${mib(now.rss)} heap=${mib(now.heapUsed)} external=${mib(now.external)} MiB ${Math.round((performance.now() - mainStarted) / 1000)} s`); }
  } });
const seconds = (performance.now() - mainStarted) / 1000;
clearInterval(sampler);
assert.deepEqual(result.problems, []);
assert.equal(result.summary.delivered, total);

const windowMedian = (key, part) => median(part.map(entry => entry[key]));
const first = windowMedian('rss', itemRss.slice(0, window)), last = windowMedian('rss', itemRss.slice(-window)), growth = last - first;
const peak = Math.max(...timeline.map(entry => entry.rss));

// 磁盘：按 (设备, inode) 去重统计实际占用，与逐文件相加的表观大小对比；去重方式看资源副本的链接数。
let apparent = 0, actual = 0;
const counted = new Set();
for (const entry of await readdir(batchDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const info = await stat(join(entry.parentPath, entry.name), { bigint: true }), key = `${info.dev}:${info.ino}`;
  apparent += Number(info.size);
  if (!counted.has(key)) { counted.add(key); actual += Number(info.size); }
}
const fonts = (await readdir(join(batchDir, '0001'))).filter(file => file.endsWith('.bin'));
const links = await Promise.all(fonts.map(async file => Number((await stat(join(batchDir, '0001', file), { bigint: true })).nlink)));
const dedup = links.every(count => count === total) ? 'hardlink' : links.every(count => count === 1) ? 'copy' : 'mixed';

// 最后一项复制到别处后独立重放；源工作区与资源仓库未被改动。
const copy = join(run, 'last-copy');
await cp(join(batchDir, String(total).padStart(4, '0')), copy, { recursive: true });
assert((await replayOutputRecord({ dir: copy, outDir: join(run, 'last-replay') })).replayed);
const inputsAfter = { workspace: await tree(workspaceDir), resources: await tree(resources) };
assert.deepEqual(inputsAfter, inputsBefore);

const evidence = {
  run, total, warmupItems, seconds: Math.round(seconds * 10) / 10, itemsPerSecond: Math.round(total / seconds * 100) / 100,
  rssMiB: { firstWindowMedian: mib(first), lastWindowMedian: mib(last), growth: mib(growth), limit: limitMiB, peak: mib(peak) },
  heapUsedMiB: { firstWindowMedian: mib(windowMedian('heapUsed', itemRss.slice(0, window))), lastWindowMedian: mib(windowMedian('heapUsed', itemRss.slice(-window))) },
  externalMiB: { firstWindowMedian: mib(windowMedian('external', itemRss.slice(0, window))), lastWindowMedian: mib(windowMedian('external', itemRss.slice(-window))) },
  disk: { apparentMiB: mib(apparent), actualMiB: mib(actual), files: counted.size, dedup, resourceLinks: Object.fromEntries(fonts.map((file, i) => [file, links[i]])) },
  inputsUnchanged: true, lastItemReplayed: true,
};
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'rss-timeline.json'), JSON.stringify(timeline.map(({ t, phase, rss, heapUsed, external }) => [t, phase, mib(rss), mib(heapUsed), mib(external)])) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
assert(growth <= limitMiB * 1024 * 1024, `RSS 增长 ${mib(growth)} MiB 超过 ${limitMiB} MiB`);
console.log(`PASS: ${total} items in ${evidence.seconds}s; RSS ${evidence.rssMiB.firstWindowMedian} → ${evidence.rssMiB.lastWindowMedian} MiB (peak ${evidence.rssMiB.peak}); disk ${evidence.disk.actualMiB} MiB actual / ${evidence.disk.apparentMiB} MiB apparent (${dedup}); ${run}`);
