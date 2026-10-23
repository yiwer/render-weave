/**
 * 容量基线（票据 15，ADR-0017）：在本机 Docker Compose 上从空环境起服务，经开放 API 出图，测 worker 的 CPU、内存与用时。
 * 先 npm run build（推送用命令行）与 npm run fetch-fonts；每个阶段都先清空容器与数据卷，结束后再清空（加 --keep 保留）。
 *
 *   node service/scripts/capacity.mjs profile [--cpus 1]   单项画像：M402、价签、最大的线路牌、展开上限、1 亿像素，草稿预览、Excel 导入与提交千项批次时接口进程被占住多久
 *   node service/scripts/capacity.mjs long [--items 1000] [--recycle 500] [--cpus 1]   千项 M402 长批次（--items 是总项数），单个 worker
 *   node service/scripts/capacity.mjs scale [--workers 1,2,4,8,16] [--items 200] [--cpus 1]   多个 worker 的吞吐（--items 是每个 worker 的项数）
 *   node service/scripts/capacity.mjs soak [--hours 3] [--workers 2] [--tenants 3] [--cpus 1]   几个租户连续出图几小时，按事先定的标准判通过
 *
 * 结果写到 out/stage4/capacity/<阶段>-<时间>/report.json，摘要打印到标准输出。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { capture, ensureEnv, root, run } from './docker.mjs';
import {
  API, backlog, call, expectStatus, finished, itemTimings, M402_DIR, m402Items, median, memoryPeak, openTenant, percentile, platformLogin,
  PRICE_TAG_DIR, priceTagItems, push, resourceStore, restart, sleep, statsSampler, submit, webhookReceiver,
} from './stage4.mjs';

const { positionals, values: options } = parseArgs({ allowPositionals: true, options: {
  cpus: { type: 'string', default: '1' }, memory: { type: 'string', default: '2g' }, recycle: { type: 'string', default: '500' }, timeout: { type: 'string', default: '60000' },
  items: { type: 'string' }, workers: { type: 'string' }, hours: { type: 'string', default: '3' }, tenants: { type: 'string', default: '3' }, keep: { type: 'boolean', default: false },
} });
const phase = positionals[0];
if (!['profile', 'long', 'scale', 'soak'].includes(phase)) {
  console.error('用法：node service/scripts/capacity.mjs profile|long|scale|soak [--cpus 1] [--memory 2g] [--recycle 500] [--timeout 60000] [--items N] [--workers N] [--hours N] [--tenants N] [--keep]');
  process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(root, 'out/stage4/capacity', `${phase}-${stamp}`);
await mkdir(out, { recursive: true });
const mib = (bytes) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const GREETING_DIR = join(root, 'fixtures/workspaces/single-text');
const STRESS_DIR = join(out, 'stress-workspace');

/**
 * 压力细牌（与 service/test/seed.ts 的相同；seed.ts 引用服务源码，脚本加载不了，在这里按同样的写法生成）：一个纵向循环，每项一行 0.6 mm 的字。2,000 项是缺省的展开上限，
 * 用来看展开上限之内最费时的一项离单项超时还有多远。按引擎的发布函数生成静态数据定义，写成工作区目录再推送。
 */
async function stressWorkspace() {
  const { publishStaticSchema } = await import(pathToFileURL(join(root, 'dist/index.js')).href);
  const item = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '压力项', version: 1, displayName: '压力项', fields: [{ name: 'label', displayName: '标签', type: 'text' }] }, []);
  const entry = { ref: item.published.ref, definition: item.published.definition, compiled: item.published.compiled };
  const list = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '压力', version: 1, displayName: '压力',
    fields: [{ name: 'items', displayName: '列表', type: 'list', items: { type: 'ref', ref: { name: '压力项', version: 1 } } }] }, [entry]);
  const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
  const documents = {
    'schema-item.json': item.published.definition, 'compiled-item.json': item.published.compiled,
    'schema-list.json': list.published.definition, 'compiled-list.json': list.published.compiled,
    'template-row.json': { dslVersion: 'renderweave-template/1', name: '压力细项卡', base: { name: '压力项', version: 1 },
      artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
        { type: 'text', name: '标签', content: [{ slot: 'label' }], font: 'res:font-hei-medium', fontSize: 0.6, color: '#333333', place: { width: 'fill', height: 'fill' } }] } },
    'template-sheet.json': { dslVersion: 'renderweave-template/1', name: '压力细牌', base: { name: '压力', version: 1 },
      artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children: [
        { type: 'loop', name: '列', list: { var: 'items' }, template: '压力细项卡', args: {}, itemLayout: { direction: 'column', heights: 'equal' }, place: { width: 'fill', height: 'fill' } }] } },
  };
  await mkdir(STRESS_DIR, { recursive: true });
  for (const [name, document] of Object.entries(documents)) await writeFile(join(STRESS_DIR, name), `${JSON.stringify(document, null, 2)}
`);
  return STRESS_DIR;
}
/** 压力细牌的一项：2,000 行，每行 40 个字（与 Docker 后端测试里取消用的那一项相同）。 */
const stressItem = (id) => ({ id, dataset: { inline: { dataset: { staticSchema: { name: '压力', version: 1 } },
  data: { items: Array.from({ length: 2000 }, (_, i) => ({ label: `第 ${i + 1} 项${'站'.repeat(40)}` })) } } }, output: { width: 200, height: 2000, dpi: 120, format: 'png' } });

// worker 可以起多个：不映射到宿主的端口（就绪检查从容器里读），CPU 与内存按参数限制。
const override = join(out, 'compose.override.yaml');
await writeFile(override, `services:\n  worker:\n    ports: !reset []\n    cpus: ${Number(options.cpus)}\n`);
process.env.COMPOSE_FILE = [join(root, 'compose.yaml'), override].join(process.platform === 'win32' ? ';' : ':');
const workerEnv = { RW_WORKER_MEMORY: options.memory, RW_RENDER_RECYCLE_AFTER: options.recycle, RW_RENDER_TIMEOUT_MS: options.timeout, RW_LOG_LEVEL: 'info' };
// 投递给宿主机上的接收端（soak 用）。
Object.assign(process.env, workerEnv, { RW_WEBHOOK_ALLOW_PRIVATE: 'true' });

const machine = {
  docker: JSON.parse(capture('docker', ['info', '--format', '{{json .}}'])),
  node: process.version, platform: process.platform,
};
const environment = { cpus: machine.docker.NCPU, memory: machine.docker.MemTotal, kernel: machine.docker.KernelVersion, docker: machine.docker.ServerVersion, worker: { ...workerEnv, cpus: Number(options.cpus) } };

ensureEnv();
run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
const report = { phase, startedAt: new Date().toISOString(), environment, results: {} };
let stats;
try {
  const workers = phase === 'soak' ? Number(options.workers ?? 2) : 1;
  run('docker', ['compose', 'up', '-d', '--build', '--wait', '--scale', `worker=${workers}`, 'api', 'worker']);
  const platform = await platformLogin('platform@capacity.test');
  const resources = await resourceStore(join(out, 'resources'));
  const plan = { monthlyImages: 100_000_000, maxPixels: 100_000_000, concurrency: 4 };
  const tenantCount = phase === 'soak' ? Number(options.tenants) : 1;
  const tenants = [];
  for (let i = 1; i <= tenantCount; i++) {
    const tenant = await openTenant(platform, { name: `容量租户 ${i}`, plan, domain: `tenant${i}.capacity.test` });
    for (const dir of [M402_DIR, PRICE_TAG_DIR, GREETING_DIR, ...(phase === 'profile' ? [await stressWorkspace()] : [])]) push(tenant, dir, resources);
    tenants.push(tenant);
  }
  stats = statsSampler();
  const started = Date.now();
  if (phase === 'profile') report.results = await profile(tenants[0]);
  if (phase === 'long') report.results = await long(tenants[0]);
  if (phase === 'scale') report.results = await scale(tenants[0]);
  if (phase === 'soak') report.results = await soak(tenants, workers);
  report.durationMs = Date.now() - started;
} finally {
  await stats?.stop();
  report.finishedAt = new Date().toISOString();
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(out, 'stats.json'), JSON.stringify(stats?.samples ?? []));
  if (!options.keep) run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
}
console.log(JSON.stringify({ out, ...report.results }, null, 2));

/** 一段时间里某个容器的内存与 CPU：中位数与最大值。 */
function containerLoad(name, from, to = Date.now()) {
  const picked = stats.samples.filter((sample) => sample.name.startsWith(name) && sample.t >= from && sample.t <= to);
  return { samples: picked.length, memoryMiB: { median: mib(median(picked.map((s) => s.memory)) ?? 0), max: mib(Math.max(0, ...picked.map((s) => s.memory))) },
    cpu: { median: median(picked.map((s) => s.cpu)), max: Math.max(0, ...picked.map((s) => s.cpu)) } };
}

/** 各项用时的分布：首项（含子进程启动后第一次读字体与资源）单列。 */
function distribution(timings) {
  const ms = timings.map((item) => item.ms), rest = ms.slice(1);
  if (!rest.length) return { items: ms.length, first: ms[0] };
  return { items: ms.length, first: ms[0], median: median(rest), p95: percentile(rest, 95), p99: percentile(rest, 99), max: Math.max(...rest) };
}

/** 同时交付几个批次：返回结束时的批次（summary 是各批之和）、这几批的逐项用时与这段时间的 worker 用量。 */
async function deliver(tenant, ...requests) {
  // docker 的日志时间来自 Docker 的虚拟机，与宿主的时钟可能差一点：往前多取 10 秒，再按批次筛。
  const since = new Date(Date.now() - 10_000).toISOString(), from = Date.now();
  const batches = [];
  for (const request of requests) batches.push(await submit(tenant.key, request));
  const ended = await Promise.all(batches.map((batch) => finished(tenant.key, batch.id)));
  const elapsedMs = Date.now() - from;
  await sleep(1500);
  const ids = new Set(batches.map((batch) => batch.id));
  const timings = itemTimings(since).items.filter((item) => ids.has(item.batchId)).sort((a, b) => a.at.localeCompare(b.at));
  const summary = {};
  for (const done of ended) for (const [key, value] of Object.entries(done.summary)) summary[key] = (summary[key] ?? 0) + value;
  return { done: { ...ended[0], summary }, timings, elapsedMs, worker: containerLoad('worker', from) };
}

async function profile(tenant) {
  const workloads = [
    { name: 'M402 740×165 mm 120 dpi', request: await m402Items(35) },
    { name: '价签 100×50 mm 300 dpi', request: await priceTagItems(30) },
    // 单边最多 20,000 像素（引擎上限）：1500 mm 宽时 338 dpi 是线路牌能出的最大一张（约 4,400 万像素）；各站用时差得多，取本站 1–10。
    { name: 'M402 1500×165 mm 338 dpi（单边 2 万像素上限）', request: await m402Items(10, 'm402-max', { width: 1500, height: 165, dpi: 338, format: 'png' }) },
    { name: '压力细牌 2,000 项（展开上限）', request: { template: '压力细牌', items: [1, 2, 3].map((n) => stressItem(`stress-${n}`)) } },
    { name: '问候牌 1 亿像素（200×200 mm 1270 dpi）', request: { template: '问候牌', items: Array.from({ length: 3 }, (_, i) =>
      ({ id: `huge-${i + 1}`, dataset: { id: 'ds-greeting' }, output: { width: 200, height: 200, dpi: 1270, format: 'png' } })) } },
  ];
  const results = [];
  for (const workload of workloads) {
    // 每种负载换一个新的 worker 容器：内存峰值（cgroup 的 memory.peak）从零算起。
    restart(['worker'], {}, ['--no-deps']);
    const { done, timings, elapsedMs, worker } = await deliver(tenant, workload.request);
    results.push({ name: workload.name, summary: done.summary, elapsedMs, timing: distribution(timings), worker, workerPeakMiB: mib(memoryPeak('worker')),
      itemsMs: timings.map((item) => [item.index, item.ms]) });
    console.error(`${workload.name}：${JSON.stringify(results.at(-1))}`);
  }
  // 草稿预览：接口进程入队、worker 渲染、接口进程取走，端到端用时。
  const single = (await m402Items(1)).items[0], latencies = [];
  for (let i = 0; i < 20; i++) {
    const from = performance.now();
    await expectStatus(call('POST', '/v1/previews', { token: tenant.operator.token, body: { template: '标准线路单边', dataset: single.dataset, parameters: { currentIndex: (i % 35) + 1 }, output: single.output } }), 200, '预览');
    latencies.push(Math.round(performance.now() - from));
  }
  results.push({ name: 'M402 草稿预览（端到端）', timing: { items: 20, first: latencies[0], median: median(latencies.slice(1)), p95: percentile(latencies.slice(1), 95), max: Math.max(...latencies.slice(1)) } });
  return { workloads: results, imports: await imports(tenant), submits: await submits(tenant), api: containerLoad('api', 0), postgres: containerLoad('postgres', 0) };
}

/** 接口进程处理一个请求期间，每 20 ms 探一次 /healthz：最长的一次就是它被这个请求占住的时长。 */
async function probing(request) {
  let active = true, worst = 0;
  const probe = (async () => {
    while (active) {
      const from = performance.now();
      await fetch(`${API}/healthz`);
      worst = Math.max(worst, performance.now() - from);
      await sleep(20);
    }
  })();
  const from = performance.now();
  const reply = await request();
  const ms = Math.round(performance.now() - from);
  active = false;
  await probe;
  return { reply, ms, healthzWorstMs: Math.round(worst) };
}

/**
 * 提交千项批次（票据 13 说与 Excel 导入一起定）：接口进程在一个请求里固定批次、逐项量像素与展开规模、预占额度、入队。
 * 线路牌引用已保存的数据集，价签的数据写在请求里；提交后立即取消，不占 worker。
 */
async function submits(tenant) {
  const results = [];
  for (const [name, request] of [['M402 千项（引用已保存的数据集）', await m402Items(1000, 'submit')], ['价签千项（数据写在请求里）', await priceTagItems(1000, 'submit')]]) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const { reply, ms, healthzWorstMs } = await probing(() => call('POST', '/v1/batches', { token: tenant.key, body: request }));
      if (reply.status === 202) {
        await call('POST', `/v1/batches/${reply.body.id}/cancel`, { token: tenant.key });
        await finished(tenant.key, reply.body.id);
      }
      runs.push({ status: reply.status, ms, healthzWorstMs });
    }
    results.push({ name, bytes: Buffer.byteLength(JSON.stringify(request)), runs });
    console.error(`${name}：${JSON.stringify(results.at(-1))}`);
  }
  return results;
}

/**
 * Excel 导入在接口进程里同步解析（票据 13 留到这里定）：一千行的价签表，与把主表补到单元格上限（50 万个）的最坏情形。
 * 导入期间每 20 ms 探一次 /healthz，最长的一次就是接口进程被解析占住的时长。
 */
async function imports(tenant) {
  const { xlsxOf } = await import(pathToFileURL(join(root, 'service/test/xlsx-fixture.ts')).href);
  const header = ['渲染项 ID', '品名', '规格', '单位', '产地', '货号', '零售价'];
  // 补的列是数值：XML 小，解压后的字节数在 32 MiB 之内，卡住的是单元格数。
  const row = (i, extra) => [`T${i}`, `测试商品 ${i}`, null, '瓶', null, String(i).padStart(7, '0'), 2.5, ...Array.from({ length: extra }, (_, j) => i * 1000 + j)];
  const cases = [
    { name: '价签 1,000 行', rows: [header, ...Array.from({ length: 1000 }, (_, i) => row(i + 1, 0))] },
    { name: '价签 1,000 行，补到 50 万个单元格', rows: [[...header, ...Array.from({ length: 492 }, (_, j) => `备注列 ${j}`)], ...Array.from({ length: 998 }, (_, i) => row(i + 1, 492))] },
  ];
  const results = [];
  for (const { name, rows } of cases) {
    const workbook = Buffer.from(await xlsxOf([{ name: '商品价签', rows }])).toString('base64');
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const { reply, ms, healthzWorstMs } = await probing(() => call('POST', '/v1/excel-imports', { token: tenant.operator.token,
        body: { template: '商品价签', workbook, output: { width: 100, height: 50, dpi: 300, format: 'png' } } }));
      runs.push({ status: reply.status, ms, healthzWorstMs, accepted: reply.body?.batch?.items?.length, problems: reply.body?.problems?.length });
    }
    results.push({ name, bytes: Math.round((workbook.length * 3) / 4), runs });
    console.error(`${name}：${JSON.stringify(results.at(-1))}`);
  }
  return results;
}

async function long(tenant) {
  const total = Number(options.items ?? 1000);
  const { done, timings, elapsedMs, worker } = await deliver(tenant, await m402Items(total));
  const ms = timings.map((item) => item.ms);
  // 内存是否随项数增长：worker 容器在前 5% 与后 5% 时间里的内存中位数。
  const samples = stats.samples.filter((sample) => sample.name.startsWith('worker'));
  const span = samples.length ? samples.at(-1).t - samples[0].t : 0, edge = span * 0.05;
  const window = (from, to) => mib(median(samples.filter((s) => s.t >= from && s.t <= to).map((s) => s.memory)) ?? 0);
  const restarts = itemTimings(report.startedAt).restarts;
  return {
    summary: done.summary, elapsedMs, throughputPerMinute: Math.round((total / elapsedMs) * 60_000 * 10) / 10,
    timing: distribution(timings), first50MedianMs: median(ms.slice(1, 51)), last50MedianMs: median(ms.slice(-50)),
    workerMemoryMiB: { first5pct: window(samples[0]?.t ?? 0, (samples[0]?.t ?? 0) + edge), last5pct: window((samples.at(-1)?.t ?? 0) - edge, samples.at(-1)?.t ?? 0), max: worker.memoryMiB.max },
    workerPeakMiB: mib(memoryPeak('worker')), worker, restarts: restarts.length, restartReasons: [...new Set(restarts.map((r) => r.reason))],
  };
}

async function scale(tenant) {
  const counts = (options.workers ?? '1,2,4,8,16').split(',').map(Number), perWorker = Number(options.items ?? 200), results = [];
  for (const workers of counts) {
    restart(['worker'], {}, ['--no-deps', '--scale', `worker=${workers}`]);
    // 一批最多 1,000 项：拆成每批 500 项，同时提交。
    const total = perWorker * workers, requests = [];
    for (let offset = 0; offset < total; offset += 500) requests.push(await m402Items(Math.min(500, total - offset), `scale${workers}-${offset}`));
    const { done, timings, elapsedMs } = await deliver(tenant, ...requests);
    const from = Date.now() - elapsedMs;
    results.push({ workers, items: total, summary: done.summary, elapsedMs, throughputPerMinute: Math.round((total / elapsedMs) * 60_000 * 10) / 10,
      timing: distribution(timings), worker: containerLoad('worker', from), api: containerLoad('api', from), postgres: containerLoad('postgres', from), s3: containerLoad('s3', from) });
    console.error(`${workers} 个 worker：${JSON.stringify(results.at(-1))}`);
  }
  return { scale: results };
}

async function soak(tenants, workers) {
  const until = Date.now() + Number(options.hours) * 3_600_000;
  const hooks = await webhookReceiver();
  const secrets = new Map();
  for (const tenant of tenants) {
    const created = await expectStatus(call('POST', '/v1/webhooks', { token: tenant.key, body: { url: hooks.url, description: '容量基线' } }), 201, '注册 webhook');
    secrets.set(tenant.id, created.body.secret);
  }
  const batches = [], previews = [], samples = [];
  // 每 30 秒记一次队列积压。
  const sampling = setInterval(() => { backlog().then((queue) => samples.push({ t: Date.now(), queue }), () => undefined); }, 30_000);
  const sizes = [1, 10, 50, 200];
  const driver = async (tenant, offset) => {
    for (let round = offset; Date.now() < until; round++) {
      const size = sizes[round % sizes.length], kind = round % 3 === 2 ? 'tag' : 'm402';
      const request = kind === 'tag' ? await priceTagItems(size, `r${round}`) : await m402Items(size, `r${round}`);
      const from = Date.now();
      const batch = await submit(tenant.key, request);
      const done = await finished(tenant.key, batch.id, 3_600_000, 1000);
      batches.push({ tenant: tenant.id, batchId: batch.id, kind, size, submittedAt: from, ms: Date.now() - from, delivered: done.summary.delivered, failed: done.summary.failed });
      const single = (await m402Items(1)).items[0], start = Date.now();
      const preview = await call('POST', '/v1/previews', { token: tenant.operator.token, body: { template: '标准线路单边', dataset: single.dataset, parameters: { currentIndex: (round % 35) + 1 }, output: single.output } });
      previews.push({ t: start, ms: Date.now() - start, status: preview.status });
    }
  };
  await Promise.all(tenants.map((tenant, index) => driver(tenant, index)));
  clearInterval(sampling);
  await sleep(5_000);
  await hooks.close();

  // 计量对得上：每个租户本期已用等于交付成功的项数，预占归零。
  const metering = [];
  for (const tenant of tenants) {
    const usageNow = (await expectStatus(call('GET', '/v1/usage', { token: tenant.key }), 200, '用量')).body.images;
    const delivered = batches.filter((b) => b.tenant === tenant.id).reduce((sum, b) => sum + b.delivered, 0);
    metering.push({ tenant: tenant.id, used: usageNow.used, reserved: usageNow.reserved, delivered });
  }
  const signed = hooks.received.filter((entry) => {
    const tenantId = JSON.parse(entry.body).tenantId;
    return hooks.verify(entry, secrets.get(tenantId));
  }).length;
  const start = stats.samples[0]?.t ?? Date.now(), end = stats.samples.at(-1)?.t ?? Date.now(), hour = 3_600_000;
  // 内存趋势：前一小时与最后一小时的中位数，另按每 10 分钟的中位数做最小二乘，换算成每小时增长（去掉前 10 分钟的预热）。
  const trend = (name) => {
    const picked = stats.samples.filter((s) => s.name === name);
    const buckets = new Map();
    for (const s of picked) {
      if (s.t < start + 600_000) continue;
      const key = Math.floor((s.t - start) / 600_000);
      buckets.set(key, [...(buckets.get(key) ?? []), s.memory]);
    }
    const points = [...buckets].map(([key, memories]) => [key / 6, median(memories) / 1024 / 1024]);
    const n = points.length, mx = points.reduce((a, p) => a + p[0], 0) / n, my = points.reduce((a, p) => a + p[1], 0) / n;
    const spread = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
    // 不到 20 分钟只有一两个点，算不出斜率。
    const slope = n >= 2 && spread > 0 ? points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / spread : 0;
    const window = (from, to) => mib(median(picked.filter((s) => s.t >= from && s.t <= to).map((s) => s.memory)) ?? 0);
    return { firstHourMedianMiB: window(start, start + hour), lastHourMedianMiB: window(end - hour, end), maxMiB: mib(Math.max(0, ...picked.map((s) => s.memory))),
      slopeMiBPerHour: Math.round(slope * 10) / 10, points: n };
  };
  const latency = (list, from, to) => {
    const bySize = {};
    for (const size of sizes) {
      const ms = list.filter((b) => b.size === size && b.submittedAt >= from && b.submittedAt < to).map((b) => b.ms);
      bySize[size] = { batches: ms.length, median: median(ms), p95: percentile(ms, 95) };
    }
    return bySize;
  };
  const logs = itemTimings(report.startedAt);
  const memory = Object.fromEntries([...new Set(stats.samples.map((s) => s.name))].sort().map((name) => [name, trend(name)]));
  const latencyMs = { firstHour: latency(batches, start, start + hour), lastHour: latency(batches, end - hour, end + 1) };
  /**
   * 判定（跑之前定好）：接口进程与各 worker 最后一小时的内存中位数比第一小时多不过 max(32 MiB, 10%)；
   * 各种批次大小最后一小时的用时中位数不超过第一小时的 1.2 倍加 1 秒；没有失败项与失败的预览；
   * 每个租户已用等于交付成功的项数、预占归零；每个批次一个签名核得上的 webhook。PostgreSQL 与对象存储的缓存随数据增长，只记不判。
   */
  const verdict = {
    memory: Object.entries(memory).filter(([name]) => /^(api|worker)/.test(name))
      .every(([, m]) => m.lastHourMedianMiB - m.firstHourMedianMiB <= Math.max(32, m.firstHourMedianMiB * 0.1)),
    latency: sizes.every((size) => !latencyMs.firstHour[size].median || !latencyMs.lastHour[size].median
      || latencyMs.lastHour[size].median <= latencyMs.firstHour[size].median * 1.2 + 1000),
    failures: batches.every((b) => b.failed === 0) && previews.every((p) => p.status === 200),
    metering: metering.every((m) => m.used === m.delivered && m.reserved === 0),
    webhooks: signed === batches.length && hooks.received.length === batches.length,
  };
  const purgeLines = capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', 'api']).split('\n').filter((line) => line.includes('清理预览与重放的任务行')).length;
  const queued = samples.map((s) => (s.queue?.queued.batchItem ?? 0) + (s.queue?.queued.preview ?? 0));
  return {
    hours: Math.round(((end - start) / hour) * 100) / 100, tenants: tenants.length, workers,
    batches: batches.length, items: batches.reduce((sum, b) => sum + b.size, 0), delivered: batches.reduce((sum, b) => sum + b.delivered, 0), failed: batches.reduce((sum, b) => sum + b.failed, 0),
    itemTiming: distribution(logs.items.filter((item) => item.kind === 'batchItem')), restarts: logs.restarts.length,
    batchLatencyMs: latencyMs,
    previewMs: { firstHour: median(previews.filter((p) => p.t < start + hour).map((p) => p.ms)), lastHour: median(previews.filter((p) => p.t >= end - hour).map((p) => p.ms)), failed: previews.filter((p) => p.status !== 200).length },
    backlog: { samples: samples.length, queuedMedian: median(queued), queuedMax: Math.max(0, ...queued), oldestQueuedMsMax: Math.max(0, ...samples.map((s) => s.queue?.oldestQueuedMs ?? 0)) },
    memory,
    webhooks: { received: hooks.received.length, signed, expected: batches.length },
    metering, purgeLogLines: purgeLines, verdict, passed: Object.values(verdict).every(Boolean),
  };
}
