/** 经编译 CLI 在临时工作区导入，再独立比较源字节、图片、问题和布局。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openVersionedResourceStore, loadWorkspace, render } from '../dist/index.js';

const out = process.argv[2] ?? 'out/stage2/resources-windows';
await mkdir(out, { recursive: true });
const workspace = await mkdtemp(join(out, 'workspace-'));
const resources = await mkdtemp(join(out, 'resources-'));
await cp('docs/examples/m402-dsl', workspace, { recursive: true });
const cli = (...args) => execFileSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8' });
cli('resources-init', '--resources', resources);
const imported = JSON.parse(cli('resources-import', '--source', 'fixtures/resources', '--resources', resources));
const metadata = JSON.parse(cli('resources-list', '--resources', resources));
assert.equal(imported.length, 15);
assert.equal(metadata.length, 15);
assert(metadata.every(item => item.version === 1));
const opened = await openVersionedResourceStore(resources);
assert.deepEqual(opened.problems, []);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const hashes = { resources: {} };
const sourceManifestBytes = await readFile('fixtures/resources/resources.json');
for (const item of JSON.parse(sourceManifestBytes).resources) {
  const sourceBytes = new Uint8Array(await readFile(join('fixtures/resources', item.file)));
  assert.deepEqual(await opened.store.read(item.id, 1), sourceBytes);
  const info = opened.store.get(item.id, 1);
  assert.equal(info.kind, item.kind);
  assert.equal(info.sha256, hash(sourceBytes));
  hashes.resources[item.id] = info.sha256;
}
assert.deepEqual(await readFile('fixtures/resources/resources.json'), sourceManifestBytes);
const requestFile = join(workspace, 'render-request-m402.json');
for (const [name, repository] of [['before', 'fixtures/resources'], ['after', resources]]) {
  process.stdout.write(cli('render', '--workspace', workspace, '--resources', repository, '--request', requestFile, '--out', join(out, name)));
}
for (const file of ['image.png', 'layout.json', 'problems.json']) {
  const before = await readFile(join(out, 'before', file));
  const after = await readFile(join(out, 'after', file));
  assert.deepEqual(after, before);
  hashes[file] = hash(after);
}
const old = await loadWorkspace({ dir: workspace, resourcesDir: 'fixtures/resources' });
const fixed = opened.store.pin(Object.fromEntries(metadata.map(item => [item.id, item.version])));
assert.deepEqual(fixed.problems, []);
const result = await render({ ...old, resources: fixed.repository }, JSON.parse(await readFile(requestFile, 'utf8')));
assert.deepEqual(result.problems, []);
assert.equal(hash(result.image.bytes), hashes['image.png']);
assert.deepEqual(result.layout, JSON.parse(await readFile(join(out, 'after', 'layout.json'), 'utf8')));
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`PASS: 15 resources imported as v1; legacy/current/pinned M402 image, problems and layout identical; ${out}`);
