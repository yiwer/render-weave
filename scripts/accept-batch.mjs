/** 编译 CLI 的 M402 批量正式交付验收：35 项本站、混合失败、失败项另组新批次及目标保护；保留出图供人核对。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? 'out/stage2/batch-windows');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const workspace = 'docs/examples/m402-dsl', resources = join(run, 'resources');
const cli = (...args) => execFileSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8', windowsHide: true });
const deliver = (request, dir) => spawnSync(process.execPath, ['dist/bin.js', 'deliver', '--workspace', workspace, '--resources', resources,
  '--request', request, '--out', dir], { encoding: 'utf8', windowsHide: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function tree(dir) {
  const files = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) { const path = join(entry.parentPath, entry.name); files[relative(dir, path)] = hash(await readFile(path)); }
  }
  return files;
}
cli('resources-init', '--resources', resources);
cli('resources-import', '--source', 'fixtures/resources', '--resources', resources);
const { loadWorkspace, render } = await import('../dist/index.js');
const m402 = await loadWorkspace({ dir: workspace, resourcesDir: resources });
const evidence = { run };

// 35 项：退出码 0，按输入顺序，每项与同请求的公开 render 逐字节一致，各项高亮不同。
const fullRequest = 'docs/examples/output-record/m402-batch-request.json', full = join(run, 'm402-35');
let started = performance.now();
const fullRun = deliver(fullRequest, full);
const fullSeconds = (performance.now() - started) / 1000;
assert.equal(fullRun.status, 0, fullRun.stderr);
assert.equal((fullRun.stderr.match(/：已交付/g) ?? []).length, 35);
const request = await json(fullRequest), manifest = await json(join(full, 'batch.json'));
assert.deepEqual(JSON.parse(fullRun.stdout).summary, { total: 35, delivered: 35, failed: 0, notRun: 0 });
assert.deepEqual(manifest.items.map(item => [item.id, item.status, item.directory]), request.items.map((item, i) => [item.id, 'delivered', String(i + 1).padStart(4, '0')]));
const images = {};
for (const [i, item] of request.items.entries()) {
  const expected = await render(m402, { template: request.template, mode: request.mode, dataset: item.dataset, parameters: item.parameters, output: item.output });
  const dir = join(full, manifest.items[i].directory), bytes = await readFile(join(dir, 'image.png'));
  assert.deepEqual(bytes, Buffer.from(expected.image.bytes));
  assert.deepEqual(await json(join(dir, 'layout.json')), expected.layout);
  assert.deepEqual(await json(join(dir, 'problems.json')), expected.problems);
  images[item.id] = hash(bytes);
}
assert.equal(new Set(Object.values(images)).size, 35);
evidence.full = { exit: fullRun.status, seconds: Math.round(fullSeconds * 10) / 10, summary: manifest.summary, build: manifest.build, directory: full };

// 一项记录独立复制后读取并重放。
const independent = join(run, 'm402-35-independent');
await cp(join(full, '0035'), independent, { recursive: true });
cli('record-read', '--record', independent);
cli('replay', '--record', independent, '--out', join(run, 'm402-35-replay'));
for (const file of ['image.png', 'layout.json', 'problems.json']) assert.deepEqual(await readFile(join(run, 'm402-35-replay', file)), await readFile(join(independent, file)));

// 混合批次：只有本站 36、错误数据版本、超大尺寸与缺失数据集失败，退出码 1，其他项照常交付。
const mixed = join(run, 'm402-mixed'), mixedRun = deliver('docs/examples/output-record/m402-mixed-batch-request.json', mixed);
assert.equal(mixedRun.status, 1, mixedRun.stderr);
const mixedManifest = await json(join(mixed, 'batch.json'));
assert.deepEqual(mixedManifest.items.map(item => [item.id, item.status]), [['m402-01', 'delivered'], ['stop-36', 'failed'], ['m402-02', 'delivered'],
  ['wrong-version', 'failed'], ['m402-03', 'delivered'], ['too-large', 'failed'], ['no-dataset', 'failed'], ['m402-35', 'delivered']]);
for (const item of mixedManifest.items.filter(entry => entry.status === 'delivered')) {
  assert.equal(hash(await readFile(join(mixed, item.directory, 'image.png'))), images[item.id]);
}
const failures = {};
for (const item of mixedManifest.items.filter(entry => entry.status === 'failed')) failures[item.id] = (await json(join(mixed, item.directory, 'problems.json'))).map(p => p.code);
assert(failures['stop-36'].includes('check.failed'));
assert.deepEqual(failures['wrong-version'], ['record.invalid']);
assert(failures['too-large'].includes('request.outputTooLarge'));
assert.deepEqual(failures['no-dataset'], ['record.invalid']);

// 修正后的失败项显式组成新批次；原批次一字不改，再次写入同一目标被拒绝。
const before = await tree(mixed);
const retryRequest = join(run, 'retry-request.json'), retry = join(run, 'm402-retry');
const fixed = request.items.filter(item => ['m402-04', 'm402-05'].includes(item.id)).map(item => ({ ...item, id: item.id === 'm402-04' ? 'too-large' : 'no-dataset' }));
await writeFile(retryRequest, JSON.stringify({ template: request.template, mode: request.mode, items: fixed }));
const retryRun = deliver(retryRequest, retry);
assert.equal(retryRun.status, 0, retryRun.stderr);
const sameTarget = deliver(retryRequest, mixed);
assert.equal(sameTarget.status, 1); assert.match(sameTarget.stderr, /delivery\.writeFailed/);
assert.deepEqual(await tree(mixed), before);
evidence.mixed = { exit: mixedRun.status, summary: mixedManifest.summary, failures, directory: mixed };
evidence.retry = { exit: retryRun.status, summary: (await json(join(retry, 'batch.json'))).summary, sameTargetExit: sameTarget.status, originalUnchanged: true };
const attempt = (requestFile, dir) => deliver(requestFile, dir).status;
// 不是 JSON 为请求读取错误 2；是 JSON 但不是批量请求为整批拒绝 1，均不建目录。
evidence.usage = { notJsonExit: attempt('README.md', join(run, 'never-1')), notBatchExit: attempt('package.json', join(run, 'never-2')) };
assert.deepEqual(evidence.usage, { notJsonExit: 2, notBatchExit: 1 });
let diskBytes = 0;
for (const entry of await readdir(full, { recursive: true, withFileTypes: true })) if (entry.isFile()) diskBytes += (await stat(join(entry.parentPath, entry.name))).size;
evidence.full.diskBytes = diskBytes;

await writeFile(join(out, 'hashes.json'), JSON.stringify(images, null, 2) + '\n');
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform }, null, 2) + '\n');
console.log(`PASS: 35 items delivered in ${evidence.full.seconds}s; mixed batch failed only the 4 bad items; retry kept the original batch; ${run}`);
