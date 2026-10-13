/** 编译 CLI 的取消与中断验收：Ctrl+C 在项间停止并返回 130；在写入、单项发布与批次发布处强杀进程后，batch-read 只认已发布完成清单的项。 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = resolve(process.argv[2] ?? 'out/stage2/cancel-windows');
await mkdir(out, { recursive: true });
const run = await mkdtemp(join(out, 'run-'));
const resources = join(run, 'resources'), bin = resolve('dist/bin.js');
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true });
const json = async file => JSON.parse(await readFile(file, 'utf8'));
execFileSync(process.execPath, [bin, 'resources-init', '--resources', resources], { windowsHide: true });
execFileSync(process.execPath, [bin, 'resources-import', '--source', 'fixtures/resources', '--resources', resources], { windowsHide: true });
const evidence = { run };

/** 启动子进程，等到 stdout/stderr 出现标记后执行 action；返回退出码、信号与输出。 */
function launch(args, { code, env = {}, until, action }) {
  const child = spawn(process.execPath, code ? ['--input-type=module', '-e', code] : [bin, ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let stdout = '', stderr = '', fired = false;
  const check = () => { if (until && !fired && until(stdout, stderr)) { fired = true; action(child, () => stderr); } };
  child.stdout.on('data', chunk => { stdout += chunk; check(); });
  child.stderr.on('data', chunk => { stderr += chunk; check(); });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`超时：${stderr}`)); }, 120_000);
    child.on('error', reject);
    child.on('exit', (status, signal) => { clearTimeout(timer); done({ status, signal, stdout, stderr, fired }); });
  });
}
const readBatchCli = dir => { const r = cli('batch-read', '--batch', dir); return { status: r.status, reading: r.stdout ? JSON.parse(r.stdout) : undefined, stderr: r.stderr }; };

// 一、Ctrl+C：M402 每项约 1 秒，第一项完成后中断，当前项提交后停止，其余未执行，batch.json 照常发布。
const m402 = await json('docs/examples/output-record/m402-batch-request.json');
const m402Request = join(run, 'm402-6.json');
await writeFile(m402Request, JSON.stringify({ ...m402, items: m402.items.slice(0, 6) }));
const deliverArgs = dir => ['deliver', '--workspace', 'docs/examples/m402-dsl', '--resources', resources, '--request', m402Request, '--out', dir];
async function assertCancelled(name, result, dir) {
  assert.equal(result.status, 130, result.stderr);
  assert.match(result.stderr, /收到中断/); assert.match(result.stderr, /delivery\.cancelled/);
  const manifest = await json(join(dir, 'batch.json'));
  assert(manifest.summary.delivered >= 1 && manifest.summary.notRun >= 1, JSON.stringify(manifest.summary));
  assert.equal(manifest.summary.delivered + manifest.summary.notRun, 6);
  assert.deepEqual(manifest.problems.map(p => p.code), ['delivery.cancelled']);
  const read = readBatchCli(dir);
  assert.equal(read.status, 0); assert.equal(read.reading.state, 'finished');
  const last = manifest.items.filter(item => item.status === 'delivered').at(-1);
  assert.equal(cli('record-read', '--record', join(dir, last.directory)).status, 0);
  evidence[name] = { exit: result.status, summary: manifest.summary, directory: dir };
}
// 在子进程内经 bin 注册的监听触发 SIGINT：Windows 无法从外部投递 POSIX 信号，这里验证 bin 的接线与退出码。
const viaListener = join(run, 'sigint-listener');
const emitCode = `
process.argv = [process.execPath, ${JSON.stringify(bin)}, ...${JSON.stringify(deliverArgs(viaListener))}];
const write = process.stderr.write.bind(process.stderr);
let sent = false;
process.stderr.write = (chunk, ...rest) => {
  const result = write(chunk, ...rest);
  if (!sent && String(chunk).startsWith('[1/')) { sent = true; setImmediate(() => process.emit('SIGINT')); }
  return result;
};
await import(${JSON.stringify(pathToFileURL(bin).href)});
`;
await assertCancelled('sigintListener', await launch([], { code: emitCode }), viaListener);
if (process.platform !== 'win32') {
  // 真实信号；再按一次恢复默认行为，进程立即结束，batch.json 未发布，由 batch-read 辨认。
  const real = join(run, 'sigint-real');
  await assertCancelled('sigintReal', await launch(deliverArgs(real), { until: (_, err) => err.includes('[1/6]'), action: child => child.kill('SIGINT') }), real);
  const twice = join(run, 'sigint-twice');
  const second = await launch(deliverArgs(twice), { until: (_, err) => err.includes('[1/6]'), action: (child, err) => {
    child.kill('SIGINT');
    const timer = setInterval(() => { if (err().includes('收到中断')) { clearInterval(timer); child.kill('SIGINT'); } }, 10);
  } });
  assert.equal(second.signal, 'SIGINT', `${second.status} ${second.stderr}`);
  const read = readBatchCli(twice);
  assert.equal(read.status, 1); assert.equal(read.reading.state, 'unfinished'); assert.match(read.stderr, /未完成运行/);
  assert(read.reading.items.some(item => item.status === 'delivered'));
  evidence.sigintTwice = { signal: second.signal, batchRead: read.status, items: read.reading.items.map(item => [item.index, item.status]) };
}

// 二、强杀：在第 2 项内容写入中、第 2 项完成清单发布前、batch.json 发布前分别 SIGKILL。
const greeting = await json('fixtures/workspaces/single-text/render-request-greeting.json');
const { template, mode, ...item } = greeting;
const smallRequest = join(run, 'greeting-3.json');
await writeFile(smallRequest, JSON.stringify({ template, mode, items: ['a', 'b', 'c'].map(id => ({ id, ...item })) }));
const hangCode = dir => `
import fs from 'node:fs/promises';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const at = resolve(process.env.HANG_AT), hang = async () => { process.stdout.write('READY\\n'); await new Promise(() => { setInterval(() => {}, 1000); }); };
const { link, open } = fs;
if (process.env.HANG_ON === 'link') fs.link = async (from, to) => resolve(String(to)) === at ? hang() : link(from, to);
else fs.open = async (path, ...rest) => resolve(String(path)) === at ? hang() : open(path, ...rest);
syncBuiltinESMExports();
const { runCli } = await import(${JSON.stringify(pathToFileURL(resolve('dist/cli.js')).href)});
process.exitCode = await runCli(${JSON.stringify(['deliver', '--workspace', 'fixtures/workspaces/single-text', '--resources', resources, '--request', smallRequest, '--out', dir])},
  { stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text) });
`;
const crashes = [
  ['writingItem2', 'open', '0002/image.png', [[1, 'delivered', 'a'], [2, 'incomplete', undefined]]],
  ['beforeItem2Manifest', 'link', '0002/record.json', [[1, 'delivered', 'a'], [2, 'incomplete', undefined]]],
  ['beforeBatchManifest', 'link', 'batch.json', [[1, 'delivered', 'a'], [2, 'delivered', 'b'], [3, 'delivered', 'c']]],
];
evidence.crashes = {};
for (const [name, on, at, expected] of crashes) {
  const dir = join(run, `crash-${name}`);
  const result = await launch([], { code: hangCode(dir), env: { HANG_ON: on, HANG_AT: join(dir, at) }, until: stdout => stdout.includes('READY'), action: child => child.kill('SIGKILL') });
  assert(result.fired, `${name} 未到达中断点：${result.stderr}`);
  const read = readBatchCli(dir);
  assert.equal(read.status, 1, read.stderr); assert.equal(read.reading.state, 'unfinished');
  assert.deepEqual(read.reading.items.map(entry => [entry.index, entry.status, entry.id]), expected);
  for (const entry of read.reading.items) assert.equal(cli('record-read', '--record', entry.directory).status, entry.status === 'delivered' ? 0 : 1);
  // 已完整的项复制走后仍可独立重放。
  const last = read.reading.items.filter(entry => entry.status === 'delivered').at(-1), copy = join(run, `${name}-copy`);
  await cp(last.directory, copy, { recursive: true });
  assert.equal(cli('replay', '--record', copy, '--out', join(run, `${name}-replay`)).status, 0);
  evidence.crashes[name] = { batchRead: read.status, items: read.reading.items.map(entry => [entry.index, entry.status]), directory: dir };
}

await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
await writeFile(join(out, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform }, null, 2) + '\n');
console.log(`PASS: cancel exits 130 after the current item; ${crashes.length} kill points leave only published items readable; ${run}`);
