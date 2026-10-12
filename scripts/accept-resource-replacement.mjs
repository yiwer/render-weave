/** 从临时工作区经编译 CLI 替换图片和字体，再用固定 v1 出图。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openVersionedResourceStore } from '../dist/index.js';

const out = process.argv[2] ?? 'out/stage2/replacement-windows';
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const workspace = join(run, 'workspace'), resources = join(run, 'resources');
await cp('docs/examples/m402-dsl', workspace, { recursive: true });
const cli = (...args) => execFileSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8' });
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
cli('resources-init', '--resources', resources);
cli('resources-import', '--source', 'fixtures/resources', '--resources', resources);
const initial = (await openVersionedResourceStore(resources)).store;
const mapping = Object.fromEntries(initial.list().map(item => [item.id, item.version]));
const versions = join(run, 'versions-v1.json');
await writeFile(versions, JSON.stringify(mapping));
const request = join(workspace, 'render-request-m402.json');
const hashes = {};
async function output(name, historical = false) {
  process.stdout.write(cli('render', '--workspace', workspace, '--resources', resources, '--request', request,
    '--out', join(out, name), ...(historical ? ['--versions', versions] : [])));
  assert.deepEqual(await json(join(out, name, 'problems.json')), []);
  hashes[name] = Object.fromEntries(await Promise.all(['image.png', 'layout.json', 'problems.json'].map(async file => [file, hash(await readFile(join(out, name, file)))])));
}
await output('before');
const source = await json('fixtures/resources/resources.json');
const evidence = [];
for (const [id, kind, candidateId, name] of [
  ['icon-metro', 'image', 'icon-hospital', 'after-image'],
  ['font-hei-medium', 'font', 'font-hei-heavy', 'after-font'],
]) {
  const candidate = join('fixtures/resources', source.resources.find(item => item.id === candidateId).file);
  const reportFile = join(run, `${id}-check.json`);
  const report = JSON.parse(cli('resources-check', '--resources', resources, '--workspace', workspace, '--id', id,
    '--kind', kind, '--file', candidate, '--out', reportFile));
  assert.equal(report.resource.version, 1);
  assert(report.impact.references.length > 0);
  const args = ['resources-apply', '--resources', resources, '--workspace', workspace, '--file', candidate, '--check', reportFile];
  assert.equal(JSON.parse(cli(...args)).version, 2);
  const stale = spawnSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8' });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /resource\.replacementStale/);
  const old = JSON.parse(cli('resources-get', '--resources', resources, '--id', id, '--version', '1'));
  assert.deepEqual(old, initial.get(id, 1));
  assert.deepEqual(await (await openVersionedResourceStore(resources)).store.read(id, 1), await initial.read(id, 1));
  await output(name);
  const previous = name === 'after-image' ? 'before' : 'after-image';
  assert.notEqual(hashes[name]['image.png'], hashes[previous]['image.png']);
  await output(`${name}-v1`, true);
  assert.deepEqual(hashes[`${name}-v1`], hashes.before);
  evidence.push({ id, kind, from: 1, to: 2, references: report.impact.references.map(({ kind, document, path }) => ({ kind, document, path })), configuration: report.impact.configuration, staleExitCode: stale.status });
}
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch }, null, 2) + '\n');
console.log(`PASS: image/font v2 changed current output; fixed v1 restored original image/layout/problems; stale reports rejected; ${out}`);
