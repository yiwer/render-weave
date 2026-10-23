/**
 * 阶段 4 验收与容量基线（票据 15）的共用步骤：只经产品的入口操作服务——平台管理员命令、开放 API 与代建推送命令，
 * 不手工改数据库、不手工复制文件；另读 docker stats、worker 的日志与就绪检查做测量。
 */
import { createHmac } from 'node:crypto';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { capture, root, run } from './docker.mjs';

export const API = `http://127.0.0.1:${process.env.RW_API_PORT ?? 8080}`;
export const M402_DIR = join(root, 'docs/examples/m402-dsl');
export const PRICE_TAG_DIR = join(root, 'fixtures/workspaces/price-tag');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const median = (values) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
export const percentile = (values, p) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

/** 开放 API 的客户端：JSON 请求体按 JSON 发，字节按 application/octet-stream 发；回答带状态、JSON 正文与原始字节。 */
export async function call(method, path, { token, body, headers = {} } = {}) {
  const binary = body instanceof Uint8Array;
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const json = (response.headers.get('content-type') ?? '').includes('json') && bytes.length;
  return { status: response.status, body: json ? JSON.parse(Buffer.from(bytes).toString('utf8')) : undefined, bytes, headers: response.headers };
}

/** 要求状态码，否则带回答正文抛错。 */
export async function expectStatus(pending, status, what) {
  const reply = await pending;
  if (reply.status !== status) throw new Error(`${what}：期望 ${status}，实际 ${reply.status}：${JSON.stringify(reply.body ?? '').slice(0, 500)}`);
  return reply;
}

/** 用平台管理员命令建账号（初始密码只在标准输出出现一次），再登录。 */
export async function platformLogin(email) {
  const out = capture('docker', ['compose', 'exec', '-T', 'api', 'node', 'service/dist/main.js', 'platform-admin', email]);
  const password = /初始密码（只显示这一次）：(\S+)/.exec(out)?.[1];
  if (!password) throw new Error('平台管理员命令没有给出初始密码');
  return { email, password, token: (await expectStatus(call('POST', '/v1/sessions', { body: { email, password } }), 201, '平台管理员登录')).body.token };
}

/**
 * 平台管理员开通一个租户：建租户与套餐、客户管理员与操作员，签发代建令牌；客户管理员登录后建 API 密钥。
 * 返回各身份的令牌与初始密码（只在本进程里用，不写文件）。
 */
export async function openTenant(platform, { name, plan, domain }) {
  const tenant = (await expectStatus(call('POST', '/v1/platform/tenants', { token: platform.token, body: { name, plan } }), 201, '建租户')).body;
  const member = async (role) => {
    const email = `${role}@${domain}`;
    const created = (await expectStatus(call('POST', `/v1/platform/tenants/${tenant.id}/members`, { token: platform.token, body: { email, role } }), 201, `建${role}`)).body;
    const token = (await expectStatus(call('POST', '/v1/sessions', { body: { email, password: created.initialPassword } }), 201, `${role} 登录`)).body.token;
    return { id: created.member.id, email, password: created.initialPassword, token };
  };
  const admin = await member('admin'), operator = await member('operator');
  const key = (await expectStatus(call('POST', '/v1/api-keys', { token: admin.token, body: { name: `${name} 的系统` } }), 201, '建 API 密钥')).body.key;
  const engineer = (await expectStatus(call('POST', '/v1/platform/authoring-tokens', { token: platform.token, body: { label: `${name} 的代建`, tenantIds: [tenant.id] } }), 201, '签发代建令牌')).body.token;
  return { id: tenant.id, name, admin, operator, key, engineer };
}

/** 运行命令行 renderweave（引擎的 dist，先 npm run build）；返回退出码与输出。 */
export function renderweave(args, env = {}) {
  const result = spawnSync(process.execPath, [join(root, 'dist/bin.js'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** 本地的资源版本仓库：从测试与样例共用的资源目录导入（字体先 npm run fetch-fonts）。 */
export async function resourceStore(dir) {
  await mkdir(join(dir, '..'), { recursive: true });
  for (const args of [['resources-init', '--resources', dir], ['resources-import', '--source', join(root, 'fixtures/resources'), '--resources', dir]]) {
    const result = renderweave(args);
    if (result.code !== 0) throw new Error(`renderweave ${args[0]} 失败：${result.stderr}`);
  }
  return dir;
}

/** 代建推送：令牌只经环境变量传入。 */
export function push(tenant, workspace, resources) {
  const result = renderweave(['push', '--server', API, '--tenant', tenant.id, '--workspace', workspace, '--resources', resources], { RENDERWEAVE_AUTHORING_TOKEN: tenant.engineer });
  if (result.code !== 0) throw new Error(`推送 ${workspace} 失败（退出码 ${result.code}）：${result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout);
}

/** M402 线路牌的批次项：本站序号 1–35 轮转，出图参数取样例的渲染请求。 */
export async function m402Items(count, prefix = 'm402', output) {
  const single = JSON.parse(await readFile(join(M402_DIR, 'render-request-m402.json'), 'utf8'));
  return {
    template: single.template,
    items: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${String(i + 1).padStart(4, '0')}`, dataset: single.dataset,
      parameters: { currentIndex: (i % 35) + 1 }, output: output ?? single.output })),
  };
}

/** 价签的批次项：Excel 样例的六行数据轮转，写在请求里。 */
export async function priceTagItems(count, prefix = 'tag') {
  const sample = JSON.parse(await readFile(join(root, 'fixtures/excel/price-tags.json'), 'utf8'));
  return {
    template: '商品价签',
    items: Array.from({ length: count }, (_, i) => {
      const row = sample.rows[i % sample.rows.length];
      return { id: `${prefix}-${String(i + 1).padStart(4, '0')}`, dataset: { inline: { dataset: { staticSchema: sample.staticSchema }, data: row.data } },
        parameters: { storeName: '示例超市' }, output: { width: 100, height: 50, dpi: 300, format: 'png' } };
    }),
  };
}

/** 提交批次；答 202 时返回批次。 */
export async function submit(token, request, headers = {}) {
  return (await expectStatus(call('POST', '/v1/batches', { token, body: request, headers }), 202, '提交批次')).body;
}

/** 轮询到批次结束。 */
export async function finished(token, batchId, timeoutMs = 3_600_000, pollMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await expectStatus(call('GET', `/v1/batches/${batchId}`, { token }), 200, '查批次');
    if (reply.body.status === 'finished') return reply.body;
    if (Date.now() > deadline) throw new Error(`批次 ${batchId} 没有在 ${timeoutMs} ms 内结束`);
    await sleep(pollMs);
  }
}

/** 队列积压：读第一个 worker 容器的就绪检查（worker 不一定映射到宿主的端口；接口进程的就绪检查不带积压）。 */
export function backlog() {
  const script = "fetch('http://127.0.0.1:8081/readyz').then(async (r) => console.log(JSON.stringify((await r.json()).queue ?? null)))";
  return new Promise((resolve, reject) => execFile('docker', ['compose', 'exec', '-T', 'worker', 'node', '-e', script], { cwd: root },
    (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())))));
}

/** worker 日志里每项的用时（"批次项完成"一行的 ms）；since 是 ISO 时间。 */
export function itemTimings(since) {
  const lines = capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', '--since', since, 'worker']).split('\n');
  const items = [], restarts = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    const entry = JSON.parse(line);
    if (entry.msg === '批次项完成' || entry.msg === '任务完成') items.push({ at: entry.time, kind: entry.kind, batchId: entry.batchId, index: entry.index, ms: entry.ms, status: entry.status });
    if (entry.msg === '渲染子进程换新') restarts.push({ at: entry.time, reason: entry.reason, tasks: entry.tasks });
  }
  return { items, restarts };
}

const UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, kB: 1000, MB: 1000 ** 2, GB: 1000 ** 3 };
const bytesOf = (text) => {
  const match = /^([\d.]+)\s*([A-Za-z]+)$/.exec(text.trim());
  return match ? Number(match[1]) * (UNITS[match[2]] ?? 1) : NaN;
};

/**
 * 持续读 docker stats：每个 renderweave 容器约每秒一行，记下内存（字节）与 CPU（百分比，100 是一个核）。
 * 返回 stop() 与 samples（{ t, name, memory, cpu }）。
 */
export function statsSampler() {
  const samples = [];
  const child = spawn('docker', ['stats', '--format', '{{json .}}'], { cwd: root });
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline), start = line.indexOf('{');
      buffer = buffer.slice(newline + 1);
      if (start < 0) continue;
      try {
        const entry = JSON.parse(line.slice(start));
        if (!entry.Name?.startsWith('renderweave-')) continue;
        samples.push({ t: Date.now(), name: entry.Name.replace(/^renderweave-/, ''), memory: bytesOf(entry.MemUsage.split('/')[0]), cpu: Number(entry.CPUPerc.replace('%', '')) });
      } catch { /* 刷新屏幕的控制字符等 */ }
    }
  });
  return { samples, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill(); }) };
}

/** 容器 cgroup 的内存峰值（memory.peak，自容器启动起），字节。 */
export function memoryPeak(service, index = 1) {
  return Number(capture('docker', ['compose', 'exec', '-T', '--index', String(index), service, 'cat', '/sys/fs/cgroup/memory.peak']).trim());
}

/** 按配置起服务（--build 之后由 up() 打标签的镜像不重建）；extra 是 docker compose up 的另加参数。 */
export function restart(services, env, extra = []) {
  Object.assign(process.env, env);
  run('docker', ['compose', 'up', '-d', '--wait', '--force-recreate', ...extra, ...services]);
}

/**
 * webhook 接收端（宿主机上）：一律答 200，记下收到的请求与收到的时刻；verify 按 docs/api.md 核对签名，时间戳与收到的时刻比。
 * 接口进程在容器里，经 host.docker.internal 投递过来（要 RW_WEBHOOK_ALLOW_PRIVATE=true）。
 */
export async function webhookReceiver() {
  const received = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => { received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() }); response.writeHead(200).end('ok'); });
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  return {
    url: `http://host.docker.internal:${server.address().port}/hooks`, received,
    verify(entry, secret) {
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(entry.headers['renderweave-signature'])) ?? [];
      return Boolean(t) && createHmac('sha256', Buffer.from(secret, 'utf8')).update(`${t}.${entry.body}`).digest('hex') === v1 && Math.abs(entry.at / 1000 - Number(t)) < 300;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
