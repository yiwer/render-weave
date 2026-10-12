/** 编译 CLI 的独立复制、构建边界和真正进程中断验收；保留出图供人核对。 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] ?? 'out/stage2/record-windows');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const origin = join(run, 'origin'), workspace = join(origin, 'workspace'), resources = join(origin, 'resources');
await cp('fixtures/workspaces/single-text', workspace, { recursive: true });
const cli = (...args) => execFileSync(process.execPath, ['dist/bin.js', ...args], { encoding: 'utf8', windowsHide: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
cli('resources-init', '--resources', resources);
cli('resources-import', '--source', 'fixtures/resources', '--resources', resources);
const single = await json(join(workspace, 'render-request-greeting.json'));
const { template, mode, ...item } = single;
const request = join(origin, 'batch.json'), config = join(origin, 'options.json');
await writeFile(request, JSON.stringify({ template, mode, items: [{ id: '../问候牌', ...item }] }));
await writeFile(config, JSON.stringify({ fallbackFonts: ['font-hei-medium', 'missing-fallback'], svgFonts: [] }));
const record = join(origin, 'record');
process.stdout.write(cli('deliver', '--workspace', workspace, '--resources', resources, '--request', request, '--options', config, '--out', record));
const copy = join(run, 'independent-record');
await cp(record, copy, { recursive: true });

// 在所有内容写完但完成清单尚未发布时强退子进程。
const interrupted = join(run, 'interrupted');
const childCode = `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
fs.link = async () => { process.stdout.write('READY\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); };
syncBuiltinESMExports();
const { runCli } = await import(${JSON.stringify(pathToFileURL(resolve('dist/cli.js')).href)});
process.exitCode = await runCli(${JSON.stringify(['deliver', '--workspace', workspace, '--resources', resources, '--request', request, '--options', config, '--out', interrupted])}, { stdout: console.log, stderr: console.error });
`;
const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '', ready = false;
child.stderr.on('data', chunk => stderr += chunk);
await new Promise((done, reject) => {
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`未到达清单发布点：${stderr}`)); }, 30000);
  child.stdout.on('data', chunk => { if (String(chunk).includes('READY')) { ready = true; child.kill('SIGKILL'); } });
  child.on('error', error => { clearTimeout(timer); reject(error); });
  child.on('exit', () => { clearTimeout(timer); ready ? done() : reject(new Error(`子进程提前退出：${stderr}`)); });
});
const partial = spawnSync(process.execPath, ['dist/bin.js', 'record-read', '--record', interrupted], { encoding: 'utf8', windowsHide: true });
assert.equal(partial.status, 1);
assert.match(partial.stderr, /record\.invalid/);

// 只移动本次 mkdtemp 下的确定目录，原工作区、版本仓库和原记录的路径全部失效。
const moved = join(run, 'unavailable-origin');
for (const path of [origin, moved]) assert(!relative(run, path).startsWith('..') && relative(run, path) !== '');
await rename(origin, moved);
const replay = join(run, 'replay');
process.stdout.write(cli('record-read', '--record', copy));
process.stdout.write(cli('replay', '--record', copy, '--out', replay));
const hashes = {};
for (const file of ['image.png', 'layout.json', 'problems.json']) {
  const bytes = await readFile(join(copy, file)); assert.deepEqual(await readFile(join(replay, file)), bytes);
  hashes[file] = hash(bytes);
}

// 相同文件复制到另一构建路径仍可重放；只改引擎字节或实际依赖字节均拒绝。
const build = join(run, 'build'); await mkdir(build);
await cp('dist', join(build, 'dist'), { recursive: true });
for (const file of ['package.json', 'package-lock.json']) await cp(file, join(build, file));
const copiedCli = (...args) => spawnSync(process.execPath, [join(build, 'dist/bin.js'), ...args], { encoding: 'utf8', windowsHide: true });
assert.equal(copiedCli('replay', '--record', copy, '--out', join(run, 'copied-build-replay')).status, 0);
const renderFile = join(build, 'dist/render.js'), originalCode = await readFile(renderFile);
await appendFile(renderFile, '\n// different engine bytes\n');
const changedEngine = copiedCli('replay', '--record', copy, '--out', join(run, 'wrong-engine'));
assert.equal(changedEngine.status, 1); assert.match(changedEngine.stderr, /record\.buildMismatch/);
await writeFile(renderFile, originalCode);
await cp('node_modules/qrcode', join(build, 'node_modules/qrcode'), { recursive: true });
await appendFile(join(build, 'node_modules/qrcode/lib/index.js'), '\n// different installed dependency bytes\n');
const changedDependency = copiedCli('replay', '--record', copy, '--out', join(run, 'wrong-dependency'));
assert.equal(changedDependency.status, 1); assert.match(changedDependency.stderr, /record\.buildMismatch/);
await writeFile(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2) + '\n');
await writeFile(join(out, 'evidence.json'), JSON.stringify({ independentCopy: true, originalPathsUnavailable: true, interruptedRecordExit: partial.status,
  changedEngineExit: changedEngine.status, changedDependencyExit: changedDependency.status, record: copy, replay, build: (await json(join(copy, 'record.json'))).build }, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform }, null, 2) + '\n');
console.log(`PASS: independent replay; interrupted delivery rejected; actual engine/dependency changes rejected; ${run}`);
