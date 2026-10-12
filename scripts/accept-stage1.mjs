/** 首期稳定性验收：构建后运行 node scripts/accept-stage1.mjs [输出目录]。 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadWorkspace, render } from '../dist/index.js';

const out = resolve(process.argv[2] ?? 'out/stage1/windows');
const serialCount = Number(process.argv[3] ?? 30);
assert(Number.isInteger(serialCount) && serialCount >= 30 && serialCount <= 200, '串行次数须为 30–200');
const workspace = await loadWorkspace({ dir: 'docs/examples/m402-dsl', resourcesDir: 'fixtures/resources' });
const request = JSON.parse(await readFile('docs/examples/m402-dsl/render-request-m402.json', 'utf8'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inputBefore = JSON.stringify([workspace.staticSchemas, workspace.templates, workspace.datasets, request]);
const finite = (value) => {
  if (typeof value === 'number') assert(Number.isFinite(value), '布局摘要存在非有限数值');
  else if (value && typeof value === 'object') Object.values(value).forEach(finite);
};
let expected;
const timings = [];
const memory = [];
async function verify() {
  const start = performance.now();
  const result = await render(workspace, request);
  assert.deepEqual(result.problems, []);
  assert(result.image);
  finite(result.layout);
  const fingerprint = { image: hash(result.image.bytes), layout: hash(JSON.stringify(result.layout)),
    width: result.image.widthPx, height: result.image.heightPx, dpi: result.image.dpi };
  if (expected) assert.deepEqual(fingerprint, expected);
  else expected = fingerprint;
  timings.push(performance.now() - start);
  memory.push(process.memoryUsage().rss);
}
// 五次预热、多次串行、四次并发；只验证独立函数调用，共用 CLI 输出目录不属于并发接口。
for (let i = 0; i < 5; i++) await verify();
const warmRss = memory.at(-1);
for (let i = 0; i < serialCount; i++) await verify();
await Promise.all(Array.from({ length: 4 }, verify));
assert.equal(JSON.stringify([workspace.staticSchemas, workspace.templates, workspace.datasets, request]), inputBefore, '渲染改写了输入');

const invalid = [null, [], {}, true, 'request'];
for (const key of ['width', 'height', 'dpi']) {
  for (const value of [null, '120', -1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1e308, 1e-300]) {
    invalid.push({ ...request, output: { ...request.output, [key]: value } });
  }
}
invalid.push({ ...request, mode: 'preview' }, { ...request, output: { ...request.output, format: 'svg' } },
  { ...request, dataset: { id: 'missing' } }, { ...request, template: 'missing' });
for (const input of invalid) {
  const result = await render(workspace, input);
  assert(!result.image);
  assert(result.problems.some((problem) => problem.level === 'severe'));
  finite(result.layout);
}
const sorted = timings.slice(5, 5 + serialCount).sort((a, b) => a - b);
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const report = {
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  successfulRenders: timings.length, serialMeasured: serialCount, concurrent: 4, invalidRequestsRejected: invalid.length,
  fingerprint: expected, inputsUnchanged: true,
  serialMs: { median: Math.round(sorted[Math.floor(serialCount / 2)]), p95: Math.round(sorted[Math.ceil(serialCount * .95) - 1]), max: Math.round(sorted.at(-1)) },
  rssMiB: { afterWarmup: mb(warmRss), afterSerial: mb(memory[4 + serialCount]), final: mb(memory.at(-1)), max: mb(Math.max(...memory)) },
  serialRssGrowthLimitMiB: 256,
  note: '耗时与 RSS 是本机观察值，不是容量保证；RSS 包含 WASM 缓存与并发峰值，本轮未做长时间泄漏检测。',
};
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'stability.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
// 观察进程外部行为，防止每张图泄漏约 10.4 MiB 像素缓冲区的已知回归；不是长期容量保证。
assert(memory[4 + serialCount] - warmRss < 256 * 1024 * 1024, '预热后串行 RSS 增长达到 256 MiB，请检查资源释放');
