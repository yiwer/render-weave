/**
 * 阶段 4 验收脚本（票据 15，PRD「完成标准」）：在本机 Docker Compose 上从空环境起完整服务，走完整个流程。
 * 全程只经产品的入口——平台管理员命令、开放 API、代建推送与离线重放命令、浏览器里的出图控制台；不手工改数据库、不手工复制文件。
 *
 * 平台管理员建租户与套餐 → 代建工程师推送 M402 与价签 → 客户操作员登录控制台：调对外参数看预览、用表单填一份数据、
 * 按本站序号出 3 张、用 Excel 导入一批价签出图、下载图片、导出出图记录 → 用 renderweave 离线读取与重放 →
 * 用量与剩余额度正确，超额整批拒绝 → 客户开发者用 API 密钥交付，收到签名的 webhook，导出的记录离线重放。
 *
 * 先 npm run build 与 npm run fetch-fonts；RW_BROWSER 指向本机 Chromium 内核浏览器（如 Edge）的可执行文件。
 * 用法：node service/scripts/accept-stage4.mjs [--headed] [--keep] [--walkthrough]
 *   --keep         结束后保留环境；
 *   --walkthrough  另开一个"走查客户"租户（推送同样的内容），打印控制台地址与操作员的初始密码，保留环境，供真人走查。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import yauzl from 'yauzl';
import { capture, ensureEnv, root, run, up } from './docker.mjs';
import {
  API, call, expectStatus, finished, m402Items, M402_DIR, openTenant, platformLogin, PRICE_TAG_DIR, push, renderweave, resourceStore, sleep, submit, webhookReceiver,
} from './stage4.mjs';

const { values: options } = parseArgs({ options: { headed: { type: 'boolean', default: false }, keep: { type: 'boolean', default: false }, walkthrough: { type: 'boolean', default: false } } });
const browserPath = process.env.RW_BROWSER;
if (!browserPath) {
  console.error('请设 RW_BROWSER：本机 Chromium 内核浏览器的可执行文件，如 C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  process.exit(2);
}
const out = join(root, 'out/stage4/acceptance', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(out, { recursive: true });
const steps = [];
let last = Date.now();
/** 记一步：名称、用时与要点；失败时连同已完成的步骤一起写进报告。 */
const step = (name, detail = {}) => {
  const now = Date.now();
  steps.push({ name, ms: now - last, ...detail });
  console.error(`✓ ${name}（${((now - last) / 1000).toFixed(1)} 秒）${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ''}`);
  last = now;
};
const check = (condition, message) => { if (!condition) throw new Error(message); };

/** 解开 zip 到目录，返回条目名 → 字节。 */
async function extract(bytes, dir) {
  const entries = await new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const found = new Map();
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) return zip.readEntry();
        zip.openReadStream(entry, (failure, stream) => {
          if (failure) return reject(failure);
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => { found.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(found));
      zip.readEntry();
    });
  });
  for (const [name, content] of entries) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  return entries;
}

/** 离线读取批次、读取并重放每一项的记录（ADR-0019：导出包自足）。 */
function replayOffline(batchDir, indexes, label) {
  const read = renderweave(['batch-read', '--batch', batchDir]);
  check(read.code === 0, `batch-read 失败：${read.stderr}`);
  for (const index of indexes) {
    const record = join(batchDir, index);
    const opened = renderweave(['record-read', '--record', record]);
    check(opened.code === 0, `record-read ${index} 失败：${opened.stderr}`);
    const replayed = renderweave(['replay', '--record', record, '--out', join(out, `replayed-${label}-${index}`)]);
    check(replayed.code === 0, `replay ${index} 失败：${replayed.stderr}`);
  }
}

// webhook 投递给宿主机上的接收端：放开内网地址，投递任务看得勤一点。
Object.assign(process.env, { RW_WEBHOOK_ALLOW_PRIVATE: 'true', RW_WEBHOOK_POLL_MS: '200' });
ensureEnv();
run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
let browser, hooks, status = 1;
const report = { startedAt: new Date().toISOString(), steps };
try {
  const { build, image } = up();
  step('从空环境起服务', { build, image });

  // 平台管理员：命令行建账号，再经开放 API 建租户、套餐与成员，签发代建令牌。月额度 20 张，后面用它测超额。
  const platform = await platformLogin('platform@acceptance.test');
  const plan = { monthlyImages: 20, maxPixels: 100_000_000, concurrency: 2 };
  const tenant = await openTenant(platform, { name: '验收客户', plan, domain: 'customer.acceptance.test' });
  step('平台管理员建租户与套餐', { tenant: tenant.id, plan });

  // 代建工程师：本地资源版本仓库，推送 M402 与价签两份工作区。
  const resources = await resourceStore(join(out, 'resources'));
  const pushed = [M402_DIR, PRICE_TAG_DIR].map((dir) => push(tenant, dir, resources).summary);
  step('代建工程师推送', { pushed });

  browser = await chromium.launch({ executablePath: browserPath, headless: !options.headed });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  context.setDefaultTimeout(60_000);
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  /** 先挂上的等待：前一步失败、浏览器关掉时它也会失败，不让它盖住真正的错误。 */
  const waiting = (promise) => { promise.catch(() => undefined); return promise; };
  const download = async (click) => {
    const pending = waiting(page.waitForEvent('download'));
    await click();
    const file = await pending;
    return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
  };
  const batchFinished = async () => {
    await page.getByTestId('batch-status').filter({ hasText: /已完成|部分失败|已取消/ }).waitFor({ timeout: 300_000 });
    return { id: /batches\/([0-9a-f-]{36})/.exec(page.url())[1], status: await page.getByTestId('batch-status').textContent() };
  };
  const nav = (name) => page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });

  // 客户操作员登录。
  await page.goto(`${API}/console/`);
  await page.getByLabel('邮箱').fill(tenant.operator.email);
  await page.getByLabel('密码').fill(tenant.operator.password);
  await page.getByRole('button', { name: '登录' }).click();
  await page.getByRole('heading', { name: '数据集', level: 1 }).waitFor();
  step('操作员登录控制台');

  // 在模板的只读预览上调对外参数。
  await nav('模板').click();
  const card = page.getByRole('article', { name: '模板 标准线路单边' });
  const firstPreview = waiting(page.waitForResponse((response) => response.url().endsWith('/v1/previews')));
  await card.getByRole('link', { name: '预览与调参' }).click();
  check((await firstPreview).status() === 200, '模板预览失败');
  const tuned = waiting(page.waitForResponse((response) => response.url().endsWith('/v1/previews') && response.request().postDataJSON()?.parameters?.currentIndex === 12));
  // 带范围的整数参数另有一个滑块（"本站序号（拖动）"），按名称精确找输入框。
  await page.getByLabel('本站序号', { exact: true }).fill('12');
  check((await tuned).status() === 200, '调参后的预览失败');
  await page.getByTestId('preview-image').waitFor();
  step('调对外参数看草稿预览');

  // 用表单填一份数据：复制样例数据集，改运营方，保存后经开放 API 读回。
  await page.goto(`${API}/console/#/datasets`);
  await page.getByRole('link', { name: 'M402 开往万国城总站' }).click();
  await page.getByRole('button', { name: '复制为新数据集' }).click();
  await page.getByLabel('新数据集 ID').fill('ds-m402-acceptance');
  await page.getByLabel('新名称').fill('M402 验收');
  await page.getByRole('button', { name: '复制', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已复制为 ds-m402-acceptance' }).waitFor();
  await page.goto(`${API}/console/#/datasets/ds-m402-acceptance`);
  await page.getByLabel('运营方').fill('验收公交有限公司');
  await page.getByTestId('check-summary').filter({ hasText: '没有问题' }).waitFor();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: /^已保存$/ }).waitFor();
  const saved = await expectStatus(call('GET', '/v1/datasets/ds-m402-acceptance', { token: tenant.operator.token }), 200, '读回数据集');
  check(saved.body.data.operator === '验收公交有限公司', '读回的运营方不对');
  await page.getByTestId('preview-image').waitFor();
  step('用表单填一份数据并保存');

  // 按本站序号 1–3 出 3 张，下载整批图片。
  await page.getByRole('link', { name: '出图…' }).click();
  const sheet = page.getByRole('dialog', { name: 'M402 验收' });
  await sheet.getByLabel('按一个整数参数的范围，每个值出一张').check();
  await sheet.getByLabel('从').fill('1');
  await sheet.getByLabel('到').fill('3');
  await sheet.getByRole('button', { name: '提交 3 张' }).click();
  const formBatch = await batchFinished();
  check(formBatch.status === '已完成', `表单出图：${formBatch.status}`);
  const images = await download(() => page.getByRole('button', { name: '下载整批图片（zip）' }).click());
  const imageEntries = await extract(images.bytes, join(out, 'form-images'));
  check(imageEntries.size === 3, `整批图片应有 3 张，实际 ${imageEntries.size}`);
  for (const [name, bytes] of imageEntries) {
    const served = await call('GET', `/v1/batches/${formBatch.id}/items/${Number(name.slice(0, 4))}/files/image.png`, { token: tenant.operator.token });
    check(Buffer.compare(Buffer.from(served.bytes), bytes) === 0, `${name} 与开放 API 的不同`);
  }
  step('批量正式交付 3 张并下载图片', { batch: formBatch.id });

  // Excel 导入：价签样例表，逐行预览后提交能提交的行。
  await page.goto(`${API}/console/#/datasets`);
  await page.getByRole('link', { name: '从 Excel 导入…' }).click();
  const importSheet = page.getByRole('dialog');
  await importSheet.getByLabel('模板', { exact: true }).selectOption('商品价签');
  await importSheet.getByLabel('Excel 文件（.xlsx）').setInputFiles(join(root, 'fixtures/excel/price-tags.xlsx'));
  const summary = await page.getByTestId('import-summary').filter({ hasText: /可提交 \d+ 行/ }).textContent();
  const accepted = Number(/可提交 (\d+) 行/.exec(summary)[1]);
  check(accepted > 0, '价签表没有可提交的行');
  await importSheet.getByRole('button', { name: `提交 ${accepted} 张` }).click();
  const excelBatch = await batchFinished();
  check(excelBatch.status === '已完成', `Excel 出图：${excelBatch.status}`);
  step('Excel 导入一批价签并交付', { batch: excelBatch.id, rows: accepted });

  // 出图记录：只看表单出的那一批，导出整批记录，离线读取与重放。
  await nav('出图记录').click();
  await page.getByRole('heading', { name: '出图记录', level: 1 }).waitFor();
  await page.getByTestId('record-row').and(page.locator(`[data-batch="${formBatch.id}"]`)).first().getByRole('link', { name: `只看批次 ${formBatch.id.slice(0, 8)}` }).click();
  const bar = page.getByRole('region', { name: `批次 ${formBatch.id.slice(0, 8)}` });
  const exported = await download(() => bar.getByRole('button', { name: '导出整批记录（zip）' }).click());
  await extract(exported.bytes, join(out, 'console-export'));
  replayOffline(join(out, 'console-export', `batch-${formBatch.id}`), ['0001', '0002', '0003'], 'console');
  step('导出出图记录并离线重放', { file: exported.name });

  // 用量：控制台上的数与开放 API 相同；已用是两批交付的张数。
  await nav('用量').click();
  const usage = (await expectStatus(call('GET', '/v1/usage', { token: tenant.operator.token }), 200, '用量')).body.images;
  const shown = await Promise.all(['limit', 'used', 'reserved', 'remaining'].map((name) => page.getByTestId(`usage-${name}`).textContent()));
  check(JSON.stringify(shown) === JSON.stringify([usage.limit, usage.used, usage.reserved, usage.remaining].map((n) => n.toLocaleString('zh-CN'))), `用量页 ${shown} 与开放 API ${JSON.stringify(usage)} 不同`);
  check(usage.used === 3 + accepted && usage.reserved === 0 && usage.remaining === plan.monthlyImages - usage.used, `用量不对：${JSON.stringify(usage)}`);
  step('用量与剩余额度', usage);

  // 客户开发者用 API 密钥走同样的流程：经开放 API 写一份数据集、看草稿预览，注册 webhook，带幂等键提交 2 张，
  // 下载图片，收到签名的 webhook，导出的记录离线重放。
  const sample = await expectStatus(call('GET', '/v1/datasets/ds-m402-wanguocheng', { token: tenant.key }), 200, '读样例数据集');
  const document = JSON.parse(Buffer.from(sample.bytes).toString('utf8'));
  document.dataset = { ...document.dataset, id: 'ds-m402-api', name: 'M402 开放 API' };
  document.data.operator = '开放 API 客户';
  await expectStatus(call('POST', '/v1/datasets', { token: tenant.key, body: document }), 201, '经开放 API 写数据集');
  const { items: [single] } = await m402Items(1);
  const preview = await expectStatus(call('POST', '/v1/previews', { token: tenant.key,
    body: { template: '标准线路单边', dataset: { id: 'ds-m402-api' }, parameters: { currentIndex: 3 }, output: single.output } }), 200, '草稿预览');
  check(preview.body.image?.base64 && preview.body.problems.length === 0, `草稿预览没有图片或有问题：${JSON.stringify(preview.body.problems)}`);
  hooks = await webhookReceiver();
  const registered = await expectStatus(call('POST', '/v1/webhooks', { token: tenant.key, body: { url: hooks.url, description: '验收' } }), 201, '注册 webhook');
  const request = { template: '标准线路单边', items: [1, 2].map((n) => ({ id: `api-${n}`, dataset: { id: 'ds-m402-api' }, parameters: { currentIndex: n }, output: single.output })) };
  const batch = await submit(tenant.key, request, { 'Idempotency-Key': 'acceptance-api-1' });
  const again = await expectStatus(call('POST', '/v1/batches', { token: tenant.key, body: request, headers: { 'Idempotency-Key': 'acceptance-api-1' } }), 200, '幂等重试');
  check(again.body.id === batch.id, '幂等重试没有拿回同一批次');
  const done = await finished(tenant.key, batch.id);
  check(done.outcome === 'completed', `开放 API 的批次：${done.outcome}`);
  const downloaded = await expectStatus(call('GET', `/v1/batches/${batch.id}/items/1/files/image.png`, { token: tenant.key }), 200, '下载图片');
  check(Buffer.from(downloaded.bytes.subarray(1, 4)).toString() === 'PNG', '下载的不是 PNG');
  const deadline = Date.now() + 60_000;
  while (!hooks.received.some((entry) => JSON.parse(entry.body).data.batch.id === batch.id) && Date.now() < deadline) await sleep(200);
  const event = hooks.received.find((entry) => JSON.parse(entry.body).data.batch.id === batch.id);
  check(event, '60 秒内没有收到这一批的 webhook');
  check(hooks.verify(event, registered.body.secret), 'webhook 的签名核不上');
  check(hooks.received.filter((entry) => JSON.parse(entry.body).data.batch.id === batch.id).length === 1, '同一批次的 webhook 不止一次');
  const apiExport = await expectStatus(call('GET', `/v1/batches/${batch.id}/export.zip`, { token: tenant.key }), 200, '导出');
  await extract(apiExport.bytes, join(out, 'api-export'));
  replayOffline(join(out, 'api-export', `batch-${batch.id}`), ['0001', '0002'], 'api');
  step('客户开发者经开放 API 写数据集、预览、交付、收到签名的 webhook、离线重放', { batch: batch.id, event: event.headers['renderweave-event-id'] });

  // 超额：剩余不够这一批时整批拒绝（429 带剩余额度），不建批次，用量不变。
  const before = (await call('GET', '/v1/usage', { token: tenant.key })).body.images;
  const over = await call('POST', '/v1/batches', { token: tenant.key, body: await m402Items(before.remaining + 1, 'over') });
  check(over.status === 429 && over.body.problems[0].code === 'quota.exceeded', `超额应答 429 quota.exceeded，实际 ${over.status}`);
  check(over.body.quota?.remaining === before.remaining, `429 带的剩余额度不对：${JSON.stringify(over.body.quota)}`);
  const after = (await call('GET', '/v1/usage', { token: tenant.key })).body.images;
  check(JSON.stringify(after) === JSON.stringify(before), '被拒绝的批次改变了用量');
  step('超额整批拒绝', { remaining: before.remaining, requested: before.remaining + 1 });

  check(pageErrors.length === 0, `控制台有脚本错误：${pageErrors.join('；')}`);

  // 日志里没有密钥（A04）：本次生成的密码、会话与 API 密钥、代建令牌、webhook 签名密钥都不在服务日志里。日志另存一份供 key 扫描。
  const logs = capture('docker', ['compose', 'logs', '--no-color', '--no-log-prefix', 'setup', 'api', 'worker']);
  await writeFile(join(out, 'service-logs.txt'), logs);
  const secrets = [platform.password, platform.token, tenant.admin.password, tenant.admin.token, tenant.operator.password, tenant.operator.token,
    tenant.key, tenant.engineer, registered.body.secret];
  const leaked = secrets.filter((secret) => logs.includes(secret)).length;
  check(leaked === 0, `服务日志里出现了 ${leaked} 项密钥`);
  step('服务日志里没有本次生成的密钥', { lines: logs.split('\n').filter(Boolean).length, secrets: secrets.length });
  status = 0;

  if (options.walkthrough) {
    const guest = await openTenant(platform, { name: '走查客户', plan: { monthlyImages: 1000, maxPixels: 100_000_000, concurrency: 2 }, domain: 'walkthrough.acceptance.test' });
    for (const dir of [M402_DIR, PRICE_TAG_DIR]) push(guest, dir, resources);
    report.walkthrough = { console: `${API}/console/`, tenant: guest.id };
    console.log(`\n真人走查：打开 ${API}/console/，用操作员 ${guest.operator.email} 登录，初始密码 ${guest.operator.password}`);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = status === 0;
  await writeFile(join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser?.close();
  await hooks?.close();
  if (!options.keep && !options.walkthrough) run('docker', ['compose', '--profile', 'test', 'down', '-v', '--remove-orphans']);
}
console.error(status === 0 ? `验收通过，报告：${join(out, 'report.json')}` : `验收没有通过，报告：${join(out, 'report.json')}`);
process.exitCode = status;
