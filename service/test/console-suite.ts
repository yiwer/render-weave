/**
 * 出图控制台的浏览器端到端测试（票据 12，M281）：浏览器经接口进程打开 /console/，像客户操作员一样
 * 登录、看模板、调参数、填表、预览、出图、下载；每一步的结果再经开放 API 核对，不看控制台的内部状态。
 * 界面按原型方案一（M282）：首页是数据集，编辑页左表单、右草稿预览，出图在侧栏里进行。
 * 票据 14 另有出图记录、用量、资源与管理页（M300、M301）：客户管理员在另一个浏览器上下文里登录，操作员与管理员各看各的。
 * Docker 后端测试里浏览器是 tester 容器里的 Chromium，接口进程与 worker 是 Compose 里真实的进程（console.docker.test.ts）；
 * 本机另可用内存后端加本机浏览器快速跑（console.browser.test.ts，设 RW_BROWSER）。
 */
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { createWorld, type World } from './api-suite.js';
import { unzip } from './records-suite.js';
import { RESOURCES_DIR, seedConsoleBadge, seedM402, seedPriceTag, seedStress } from './seed.js';
import { xlsxOf } from './xlsx-fixture.js';

export interface ConsoleSuiteOptions {
  /** 浏览器打开的接口进程：它提供 /console/ 与开放 API，与 backend 读写同一份数据。 */
  readonly start: (backend: ServiceBackend) => Promise<{ readonly baseUrl: string; readonly stop: () => Promise<void> }>;
  readonly launch: LaunchOptions;
  /** 没有浏览器时整组跳过（只用于本机的内存后端）。 */
  readonly skip?: boolean;
  /** worker 在接口进程里：渲染时占住事件循环，取消的用例要等很久，跳过（以 Docker 后端为准）。 */
  readonly inProcessWorker?: boolean;
  /** webhook 接收端监听的地址，与接口进程的投递任务看得到的地址（票据 14 的投递记录）。 */
  readonly receiverHost: { readonly bind: string; readonly advertise: string };
}

const BADGE = '会议胸牌';
const ROUTE = '标准线路单边';
const M402 = 'ds-m402-wanguocheng';
/** 照片字段上传的新图。 */
const UPLOAD = `${RESOURCES_DIR}images/m402/landmark-1.png`;
/** 姓名框 50 mm、字号 9 mm，压到 60% 仍放不下十个字：草稿标出问题，正式交付失败（layout.textOverflow）。 */
const LONG_NAME = '欧阳娜娜娜娜娜娜娜娜';
/** 替换 landmark-2 用的新内容（与原图不同的一张）。 */
const REPLACEMENT = `${RESOURCES_DIR}images/m402/landmark-3.png`;
/** 资源页上传的新图。 */
const STAMP = `${RESOURCES_DIR}images/m402/icon-metro.png`;
const enc = encodeURIComponent;

/** webhook 接收端：一律答 200，记下收到的请求。 */
async function receiver(host: ConsoleSuiteOptions['receiverHost']) {
  const received: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => { received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }); response.writeHead(200).end('ok'); });
  });
  await new Promise<void>((resolve) => server.listen(0, host.bind, resolve));
  return {
    url: `http://${host.advertise}:${(server.address() as AddressInfo).port}/hooks`, received,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function describeConsole(name: string, makeBackend: () => Promise<ServiceBackend>, options: ConsoleSuiteOptions): void {
  describe.skipIf(options.skip ?? false)(`出图控制台（${name}）`, () => {
    let world: World, browser: Browser, context: BrowserContext, page: Page, baseUrl: string, stop: () => Promise<void>;
    /** 客户管理员的浏览器上下文（票据 14）：会话令牌在各自的标签页里，与操作员的互不影响。 */
    let adminContext: BrowserContext, admin: Page | undefined;
    let hooks: Awaited<ReturnType<typeof receiver>>;
    const pageErrors: string[] = [];
    const watch = (target: Page) => {
      // 脚本错误与内容安全策略拦下的资源都算失败；接口答 4xx 时浏览器打印的"Failed to load resource"不算。
      target.on('pageerror', (error) => pageErrors.push(error.message));
      target.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(message.text()); });
    };

    beforeAll(async () => {
      const backend = await makeBackend();
      world = await createWorld(backend);
      const storage = backend.tenant(world.b.id).storage;
      await seedM402(storage);
      await seedConsoleBadge(storage, { withFont: false });
      await seedStress(storage);
      await seedPriceTag(storage);
      ({ baseUrl, stop } = await options.start(backend));
      browser = await chromium.launch(options.launch);
      context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      context.setDefaultTimeout(30_000);
      page = await context.newPage();
      watch(page);
      adminContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      adminContext.setDefaultTimeout(30_000);
      hooks = await receiver(options.receiverHost);
    });
    afterAll(async () => {
      await browser?.close();
      await hooks?.close();
      await stop?.();
    });

    const api = (method: 'GET' | 'POST', url: string, body?: unknown) => world.call(method, url, world.b.operator.token, body);
    const datasetJson = async (id: string) => {
      const reply = await api('GET', `/v1/datasets/${encodeURIComponent(id)}`);
      expect(reply.status, reply.raw.slice(0, 300)).toBe(200);
      return JSON.parse(reply.raw) as { dataset: Record<string, unknown>; data: Record<string, unknown> };
    };
    const hashOf = () => decodeURIComponent(new URL(page.url()).hash);
    const previewImage = () => page.getByTestId('preview-image');
    const field = (path: string) => page.locator(`[data-path="${path}"]`);
    const status = (text: string | RegExp) => page.getByRole('status').filter({ hasText: text });
    /** 等到这一刻之后出的新一张预览：预览防抖、排队，等它回来再看图。 */
    const nextPreview = (match: (body: Record<string, unknown>) => boolean = () => true) => page.waitForResponse((response) => {
      if (!response.url().endsWith('/v1/previews') || response.request().method() !== 'POST') return false;
      try { return match(response.request().postDataJSON() as Record<string, unknown>); } catch { return false; }
    }, { timeout: 60_000 });
    /** 等批次结束，返回批次 ID。 */
    const batchFinished = async () => {
      await page.getByTestId('batch-status').filter({ hasText: /已完成|部分失败|已取消/ }).waitFor({ timeout: 120_000 });
      return /batches\/([0-9a-f-]{36})/.exec(page.url())![1]!;
    };
    const tiles = () => page.getByTestId('batch-item');
    const tileStatuses = () => tiles().evaluateAll((items) => items.map((item) => item.getAttribute('data-status')));
    const adminApi = (method: 'GET' | 'POST', url: string, body?: unknown) => world.call(method, url, world.b.admin.token, body);
    /** 直接请求浏览器打开的那个接口进程（Docker 后端是 Compose 里的）：批次只由接受它的构建交付，提交要经它。 */
    const server = async (method: string, path: string, token: string, body?: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      return { status: response.status, body: text && response.headers.get('content-type')?.startsWith('application/json') ? JSON.parse(text) : undefined, raw: text };
    };
    /** 客户管理员登录（只在第一次用到时）。 */
    const asAdmin = async (): Promise<Page> => {
      if (admin) return admin;
      const opened = await adminContext.newPage();
      watch(opened);
      await opened.goto(`${baseUrl}/console/`);
      await opened.getByLabel('邮箱').fill(world.b.admin.email);
      await opened.getByLabel('密码').fill(world.b.admin.password);
      await opened.getByRole('button', { name: '登录' }).click();
      await opened.getByRole('heading', { name: '数据集', level: 1 }).waitFor();
      return (admin = opened);
    };
    const nav = (target: Page, name: string) => target.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true });
    const downloadBytes = async (target: Page, click: () => Promise<void>) => {
      const download = target.waitForEvent('download');
      await click();
      const file = await download;
      return { name: file.suggestedFilename(), bytes: await readFile((await file.path())!) };
    };

    it('登录后首页是数据集；模板列表有缩略预览、适用尺寸范围与对应的数据定义；在只读预览上调对外参数看草稿预览', async () => {
      await page.goto(`${baseUrl}/console/`);
      await page.getByLabel('邮箱').fill(world.b.operator.email);
      await page.getByLabel('密码').fill(world.b.operator.password);
      await page.getByRole('button', { name: '登录' }).click();
      await page.getByRole('heading', { name: '数据集', level: 1 }).waitFor();
      await page.getByRole('link', { name: 'M402 开往万国城总站' }).waitFor();
      // 本月剩余张数操作员也看得到（M300，票据 12 时只给管理员），与开放 API 的相同。
      const { images } = (await adminApi('GET', '/v1/usage')).body as { images: { limit: number; remaining: number } };
      await expect.poll(() => page.getByTestId('quota').textContent()).toBe(`本月剩余 ${images.remaining.toLocaleString('zh-CN')} / ${images.limit.toLocaleString('zh-CN')} 张`);

      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '模板' }).click();
      const card = page.getByRole('article', { name: `模板 ${BADGE}` });
      await expect.poll(() => card.textContent()).toContain('90–100 × 130–140 mm');
      expect(await card.textContent()).toContain('会议胸牌（胸牌 v1）');
      const thumbnail = card.getByRole('img', { name: `${BADGE} 的缩略预览` });
      await thumbnail.waitFor();
      expect(await thumbnail.evaluate((image) => (image as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(100);
      expect(await page.getByRole('article', { name: `模板 ${ROUTE}` }).textContent()).toContain('740–1500 × 165 mm');
      // 子模板也是模板（ADR-0007），同样列出。
      await page.getByRole('article', { name: '模板 场次条' }).waitFor();

      const first = nextPreview();
      await card.getByRole('link', { name: '预览与调参' }).click();
      expect((await first).status()).toBe(200);
      await previewImage().waitFor();
      const before = await previewImage().getAttribute('src');
      const changed = nextPreview((body) => (body['parameters'] as Record<string, unknown>)['eventName'] === '2027 出图大会');
      await page.getByLabel('会议名称').fill('2027 出图大会');
      const reply = await changed;
      expect(reply.status()).toBe(200);
      expect((reply.request().postDataJSON() as { template: string }).template).toBe(BADGE);
      await expect.poll(() => previewImage().getAttribute('src')).not.toBe(before);
    });

    it('按编译产物生成的表单填一份数据：九种字段类型、服务端问题定位到字段、选图与上传；保存、修改、复制都经开放 API 可见', async () => {
      await page.getByRole('link', { name: '新建数据集' }).click();
      await page.getByLabel('数据集 ID').fill('badge-e2e-1');
      await page.getByLabel('名称', { exact: true }).fill('E2E 胸牌');
      await page.getByLabel('姓名', { exact: true }).fill('李四');
      await page.getByLabel('单位').fill('示例出图有限公司');
      await page.getByLabel('身份').selectOption('讲者');
      // 校验以服务端的问题清单为准：格式不对的证件号，问题显示在证件号下面。
      await page.getByLabel('证件号').fill('sp01');
      await expect.poll(() => field('badgeNo').textContent()).toContain('格式不正确');
      expect(await page.getByLabel('证件号').getAttribute('aria-invalid')).toBe('true');
      await page.getByLabel('证件号').fill('SP0002');
      await page.getByLabel('座位排号').fill('8');
      await page.getByLabel('会议日期').fill('2026-11-20');
      await page.getByLabel('发证时间').fill('2026-11-01T09:30:15');
      await page.getByLabel('贵宾通道').selectOption({ label: '是' });

      // 数据定义引用：一组字段；对象的列表：一行一项的表格；简单值的列表：一排小输入框。
      await page.getByRole('button', { name: '填写主场次' }).click();
      const main = page.getByRole('region', { name: '主场次' });
      await main.getByLabel('场次名称').fill('主旨演讲');
      await main.getByLabel('开始时刻').fill('09:30');
      await main.getByLabel('会场').fill('一号厅');
      for (const [index, session] of [['主旨演讲', '09:30', '一号厅'], ['分论坛：出图自动化', '14:00', '']].entries()) {
        await page.getByRole('button', { name: '+ 添加参会场次' }).click();
        await page.getByLabel(`参会场次 第 ${index + 1} 项 场次名称`, { exact: true }).fill(session[0]!);
        await page.getByLabel(`参会场次 第 ${index + 1} 项 开始时刻`, { exact: true }).fill(session[1]!);
        if (session[2]) await page.getByLabel(`参会场次 第 ${index + 1} 项 会场`, { exact: true }).fill(session[2]);
      }
      await page.getByRole('button', { name: '+ 添加标签' }).click();
      await page.getByLabel('标签 第 1 项', { exact: true }).fill('首次');

      // 图片字段：先从本租户的资源中选，再上传一张新图换掉。
      const photo = field('photo');
      await photo.getByRole('button', { name: '从资源中选照片' }).click();
      await photo.getByRole('option', { name: 'photo-sample' }).click();
      await expect.poll(() => photo.locator('output').textContent()).toBe('res:photo-sample');
      const uploadBytes = await readFile(UPLOAD);
      await photo.getByRole('button', { name: '从资源中选照片' }).click();
      await photo.getByLabel('上传照片的新图片').setInputFiles({ name: 'landmark-1.png', mimeType: 'image/png', buffer: uploadBytes });
      await expect.poll(() => photo.locator('output').textContent()).toMatch(/^res:image-[0-9a-f]{12}$/);
      const uploaded = (await photo.locator('output').textContent())!.slice(4);

      await expect.poll(() => page.getByTestId('check-summary').textContent()).toContain('没有问题');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await status('已保存数据集 badge-e2e-1').waitFor();
      expect(hashOf()).toContain('#/datasets/badge-e2e-1');

      const saved = await datasetJson('badge-e2e-1');
      expect(saved.dataset).toEqual({ id: 'badge-e2e-1', name: 'E2E 胸牌', staticSchema: { name: '胸牌', version: 1 } });
      expect(saved.data).toEqual({
        fullName: '李四', organization: '示例出图有限公司', role: '讲者', badgeNo: 'SP0002', photo: `res:${uploaded}`, seat: 8,
        eventDate: '2026-11-20', issuedAt: '2026-11-01 09:30:15', vip: true,
        mainSession: { title: '主旨演讲', startsAt: '09:30', room: '一号厅' },
        sessions: [{ title: '主旨演讲', startsAt: '09:30', room: '一号厅' }, { title: '分论坛：出图自动化', startsAt: '14:00' }],
        tags: ['首次'],
      });
      // 上传的新图是本租户 v1 的图片资源，内容与上传的相同。
      const resource = await api('GET', `/v1/resources/${uploaded}`);
      expect(resource.body).toMatchObject({ id: uploaded, kind: 'image', currentVersion: 1 });
      expect(Buffer.compare((await api('GET', `/v1/resources/${uploaded}/versions/1/content`)).bytes, uploadBytes)).toBe(0);

      // 修改：改座位后保存，读回的是新值。
      await page.getByLabel('座位排号').fill('9');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await status(/^已保存$/).waitFor();
      expect((await datasetJson('badge-e2e-1')).data['seat']).toBe(9);

      // 复制：副本只换身份部分的 ID 与名称。
      await page.getByRole('button', { name: '复制为新数据集' }).click();
      await page.getByLabel('新数据集 ID').fill('badge-e2e-2');
      await page.getByLabel('新名称').fill('E2E 胸牌副本');
      await page.getByRole('button', { name: '复制', exact: true }).click();
      await status('已复制为 badge-e2e-2').waitFor();
      const copy = await datasetJson('badge-e2e-2');
      expect(copy.dataset).toEqual({ id: 'badge-e2e-2', name: 'E2E 胸牌副本', staticSchema: { name: '胸牌', version: 1 } });
      expect(copy.data).toEqual({ ...saved.data, seat: 9 });
    });

    it('草稿预览把问题位置叠加在图上：放不下的姓名标在姓名框上，与清单同号', async () => {
      const done = nextPreview((body) => JSON.stringify(body).includes(LONG_NAME));
      await page.getByLabel('姓名', { exact: true }).fill(LONG_NAME);
      const reply = await (await done).json() as { problems: { code: string; location: { kind: string; path?: string } }[];
        layout: { output: { width: number; height: number }; root: { path: string; x: number; y: number; width: number; height: number; children?: unknown[] } } };
      expect(reply.problems.map((problem) => [problem.code, problem.location.path])).toContainEqual(['layout.textOverflow', `${BADGE}/姓名`]);
      const mark = page.getByTestId('problem-mark');
      await mark.waitFor();
      expect(await mark.getAttribute('aria-label')).toContain('放不下');
      await page.getByRole('list', { name: '预览的问题' }).getByText(`元素 ${BADGE}/姓名`).waitFor();
      // 叠加框的位置与布局摘要里的元素框一致（按图片的显示尺寸换算，允许 2 像素）。
      const find = (node: typeof reply.layout.root, path: string): typeof reply.layout.root | undefined =>
        node.path === path ? node : (node.children as (typeof node)[] | undefined)?.map((child) => find(child, path)).find(Boolean);
      const box = find(reply.layout.root, `${BADGE}/姓名`)!;
      const image = (await previewImage().boundingBox())!, marked = (await mark.boundingBox())!;
      const scale = image.width / reply.layout.output.width;
      expect(Math.abs(marked.x - image.x - box.x * scale)).toBeLessThanOrEqual(2);
      expect(Math.abs(marked.y - image.y - box.y * scale)).toBeLessThanOrEqual(2);
      expect(Math.abs(marked.width - box.width * scale)).toBeLessThanOrEqual(2);
      // 没保存的修改不影响已保存的数据集；有未保存的修改时不能出图。
      expect((await datasetJson('badge-e2e-2')).data['fullName']).toBe('李四');
      expect(await page.getByRole('button', { name: '出图…' }).isDisabled()).toBe(true);
    });

    it('主路径：线路牌的站点表格里改错会定位到单元格；按本站序号 1–6 出 6 张，逐项看进度，下载单张图片与整批压缩包', async () => {
      await page.goto(`${baseUrl}/console/#/datasets`);
      await page.getByRole('link', { name: 'M402 开往万国城总站' }).click();
      const stop8 = page.getByLabel('停靠站点 第 8 项 站名', { exact: true });
      expect(await stop8.inputValue()).toBe('东晓街道办');
      expect(await page.locator('table.list-table tbody tr').count()).toBe(35);
      // 清空第 8 站站名（必填）：服务端的问题定位到这个单元格；改回原值后没有未保存的修改，可以出图。
      await stop8.fill('');
      await expect.poll(() => field('stops[8].name').textContent()).toContain('必填字段"站名"（stops[8].name）缺失');
      expect(await stop8.getAttribute('aria-invalid')).toBe('true');
      expect(await page.getByRole('button', { name: '出图…' }).isDisabled()).toBe(true);
      await stop8.fill('东晓街道办');
      await expect.poll(() => page.getByTestId('check-summary').textContent()).toContain('已保存');

      await page.getByRole('link', { name: '出图…' }).click();
      const sheet = page.getByRole('dialog', { name: 'M402 开往万国城总站' });
      expect(await sheet.getByLabel('模板').inputValue()).toBe(ROUTE);
      await sheet.getByLabel('按一个整数参数的范围，每个值出一张').check();
      expect(await sheet.getByLabel('参数', { exact: true }).inputValue()).toBe('currentIndex');
      await sheet.getByLabel('从').fill('1');
      await sheet.getByLabel('到').fill('6');
      // 提交带幂等键（票据 07）：网络抖动时重试拿回同一批次。
      const submitted = page.waitForRequest((request) => request.url().endsWith('/v1/batches') && request.method() === 'POST');
      await sheet.getByRole('button', { name: '提交 6 张' }).click();
      expect((await submitted).headers()['idempotency-key']).toMatch(/^console-[0-9a-f]{32}$/);
      const batchId = await batchFinished();
      expect(hashOf()).toBe(`#/datasets/${M402}/batches/${batchId}`);
      expect(await page.getByTestId('batch-status').textContent()).toBe('已完成');
      expect(await tileStatuses()).toEqual(Array(6).fill('delivered'));
      expect(await tiles().evaluateAll((items) => items.map((item) => item.querySelector('.n')!.textContent))).toEqual(['1', '2', '3', '4', '5', '6']);
      // 顶栏的本月剩余随出图更新，与开放 API 的相同（阶段 4 真人走查发现它停在登录时的数）。
      const { images: quota } = (await adminApi('GET', '/v1/usage')).body as { images: { limit: number; remaining: number } };
      await expect.poll(() => page.getByTestId('quota').textContent()).toBe(`本月剩余 ${quota.remaining.toLocaleString('zh-CN')} / ${quota.limit.toLocaleString('zh-CN')} 张`);

      const view = await api('GET', `/v1/batches/${batchId}`);
      expect(view.body).toMatchObject({ template: ROUTE, status: 'finished', cancelRequested: false, outcome: 'completed', summary: { total: 6, delivered: 6, failed: 0 } });
      expect(view.body.items.map((item: { id: string }) => item.id)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `${M402}/currentIndex=${n}`));
      const records = await api('GET', `/v1/records?batchId=${batchId}`);
      expect(records.body.records).toHaveLength(6);
      const images = await Promise.all([1, 2, 3, 4, 5, 6].map(async (index) => (await api('GET', `/v1/batches/${batchId}/items/${index}/files/image.png`)).bytes));
      // 每张按 740 × 165 mm、120 DPI 出图；第 3 站与第 5 站的图不同（本站不同）。
      expect(images[2]!.readUInt32BE(16)).toBe(3496);
      expect(Buffer.compare(images[2]!, images[4]!)).not.toBe(0);

      await tiles().nth(2).click();
      await page.getByTestId('item-detail').getByRole('img').waitFor();
      const single = page.waitForEvent('download');
      await page.getByTestId('item-detail').getByRole('button', { name: '下载图片' }).click();
      const file = await single;
      expect(file.suggestedFilename()).toBe(`0003-${M402}_currentIndex=3.png`);
      expect(Buffer.compare(await readFile((await file.path())!), images[2]!)).toBe(0);

      const whole = page.waitForEvent('download');
      await page.getByRole('button', { name: '下载整批图片（zip）' }).click();
      const zip = await whole;
      expect(zip.suggestedFilename()).toBe(`batch-${batchId}-images.zip`);
      const entries = await unzip(await readFile((await zip.path())!));
      expect([...entries.keys()].sort()).toEqual(['0001.png', '0002.png', '0003.png', '0004.png', '0005.png', '0006.png']);
      for (const [index, bytes] of images.entries()) expect(Buffer.compare(entries.get(`000${index + 1}.png`)!, bytes)).toBe(0);

      await page.getByRole('button', { name: '关闭出图任务' }).click();
      expect(hashOf()).toBe(`#/datasets/${M402}?template=${ROUTE}`);
    }, 180_000);

    it('几份数据集一起出图：失败项显示与单次出图相同的问题说明', async () => {
      // 姓名放不下的数据集：数据本身合格，能保存；正式交付时排版放不下，这一项失败。
      const long = await world.call('POST', '/v1/datasets', world.b.operator.token, {
        dataset: { id: 'badge-long', name: '长姓名', staticSchema: { name: '胸牌', version: 1 } },
        data: { ...(await datasetJson('badge-e2e-1')).data, fullName: LONG_NAME },
      });
      expect(long.status, long.raw.slice(0, 300)).toBe(201);
      await page.getByRole('navigation', { name: '主导航' }).getByRole('link', { name: '数据集' }).click();
      await page.getByLabel('选择 长姓名').check();
      await page.getByLabel('选择 E2E 胸牌', { exact: true }).check();
      await page.getByRole('link', { name: '出图（2 份）' }).click();
      const sheet = page.getByRole('dialog', { name: '2 份数据集' });
      expect(await sheet.getByLabel('模板').inputValue()).toBe(BADGE);
      await sheet.getByRole('button', { name: '提交 2 张' }).click();
      const failedBatch = await batchFinished();
      expect(await page.getByTestId('batch-status').textContent()).toBe('部分失败');
      const failedTile = tiles().and(page.locator('[data-id="badge-long"]'));
      expect(await failedTile.getAttribute('data-status')).toBe('failed');
      await failedTile.click();
      expect(await page.getByTestId('item-detail').textContent()).toContain(`严重 · 元素 ${BADGE}/姓名：文字"${LONG_NAME}"放不下`);
      const failed = (await api('GET', `/v1/batches/${failedBatch}`)).body.items.find((item: { id: string }) => item.id === 'badge-long');
      expect(failed).toMatchObject({ status: 'failed', problems: [{ code: 'layout.textOverflow', location: { kind: 'element', path: `${BADGE}/姓名` } }] });
      expect((await api('GET', `/v1/batches/${failedBatch}`)).body).toMatchObject({ outcome: 'partiallyFailed', summary: { total: 2, delivered: 1, failed: 1 } });
    }, 180_000);

    it('Excel 导入（票据 13）：下载空白表；上传一份价签表，逐行预览，问题定位到单元格；提交能提交的行，批次经开放 API 核对', async () => {
      await page.goto(`${baseUrl}/console/#/datasets`);
      await page.getByRole('link', { name: '从 Excel 导入…' }).click();
      const sheet = page.getByRole('dialog');
      await sheet.getByLabel('模板', { exact: true }).selectOption('商品价签');

      // 空白表与开放 API 给的是同一份文件。
      const download = page.waitForEvent('download');
      await sheet.getByRole('button', { name: '下载空白表' }).click();
      const saved = await download;
      expect(saved.suggestedFilename()).toBe('商品价签-v1.xlsx');
      const blank = await api('GET', `/v1/static-schemas/${encodeURIComponent('商品价签')}/versions/1/workbook`);
      expect(Buffer.compare(await readFile(await saved.path()), Buffer.from(blank.bytes))).toBe(0);

      const header = ['渲染项 ID', '品名', '规格', '单位', '产地', '货号', '零售价'];
      const workbook = await xlsxOf([{ name: '商品价签', rows: [
        header, ['T1', '测试饮用水', null, '瓶', null, '0000001', 2], ['T2', '单位不对', null, '斤', null, '0000002', 3], ['T3', '测试面包', null, '袋', null, '0000003', 5.5],
      ] }]);
      await sheet.getByLabel('Excel 文件（.xlsx）').setInputFiles({ name: '价签.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from(workbook) });
      await page.getByTestId('import-summary').filter({ hasText: '可提交 2 行' }).waitFor();
      const rows = page.getByTestId('import-row');
      expect(await rows.evaluateAll((items) => items.map((item) => [item.getAttribute('data-row'), item.getAttribute('data-status')])))
        .toEqual([['2', 'accepted'], ['3', 'rejected'], ['4', 'accepted']]);
      expect(await rows.nth(1).textContent()).toContain('D3（单位）');

      const submitted = page.waitForResponse((response) => response.url().endsWith('/v1/batches') && response.request().method() === 'POST');
      await sheet.getByRole('button', { name: '提交 2 张' }).click();
      const reply = await submitted;
      expect(reply.status()).toBe(202);
      expect(reply.request().headers()['idempotency-key']).toMatch(/^console-[0-9a-f]{32}$/);
      const id = await batchFinished();
      expect(await tileStatuses()).toEqual(['delivered', 'delivered']);
      const view = (await api('GET', `/v1/batches/${id}`)).body;
      expect(view).toMatchObject({ template: '商品价签', summary: { total: 2, delivered: 2 } });
      expect(view.items.map((item: { id: string }) => item.id)).toEqual(['T1', 'T3']);
    });

    it.skipIf(options.inProcessWorker ?? false)('进行中的批次能取消：正在渲染的停下，没开始的项未执行', async () => {
      // 取消：压力细牌每项排两千行，正式出图要画一阵；二十项在点取消时还没交付完，后面的项没开始。
      const stress = Array.from({ length: 20 }, (_, i) => `stress-${i + 1}`);
      for (const id of stress) {
        const items = Array.from({ length: 2000 }, (_, i) => ({ label: `第 ${i + 1} 项${'站'.repeat(40)}` }));
        const created = await world.call('POST', '/v1/datasets', world.b.operator.token, { dataset: { id, staticSchema: { name: '压力', version: 1 } }, data: { items } });
        expect(created.status, created.raw.slice(0, 300)).toBe(201);
      }
      await page.goto(`${baseUrl}/console/#/deliver?datasets=${stress.join(',')}`);
      const stressSheet = page.getByRole('dialog', { name: '20 份数据集' });
      await stressSheet.getByLabel('宽（mm）').fill('200');
      await stressSheet.getByLabel('高（mm）').fill('2000');
      await stressSheet.getByRole('button', { name: '提交 20 张' }).click();
      await page.getByRole('button', { name: '取消批次' }).click();
      await page.getByRole('button', { name: '确认取消' }).click();
      const cancelled = await batchFinished();
      expect(await page.getByTestId('batch-status').textContent()).toBe('已取消');
      const view = (await api('GET', `/v1/batches/${cancelled}`)).body;
      expect(view).toMatchObject({ status: 'finished', cancelRequested: true, outcome: 'cancelled', problems: [{ code: 'delivery.cancelled' }] });
      expect(view.summary.notRun).toBeGreaterThanOrEqual(1);
      expect(await tileStatuses()).toEqual(view.items.map((item: { status: string }) => item.status));
    }, 240_000);

    it('出图记录（票据 14）：按时间、模板与批次查询；下载图片；按项与按批次导出，导出包与开放 API 的相同', async () => {
      type Entry = { batchId: string; index: number; id: string; template: string; deliveredAt: string };
      const key = (entry: Entry) => `${entry.batchId}#${entry.index}`;
      const rows = () => page.getByTestId('record-row');
      const shown = () => rows().evaluateAll((items) => items.map((item) => `${item.getAttribute('data-batch')}#${item.getAttribute('data-index')}`));
      const all = (await api('GET', '/v1/records?limit=50')).body.records as Entry[];
      const route = (await api('GET', `/v1/records?template=${enc(ROUTE)}`)).body.records as Entry[];
      expect(route).toHaveLength(6);
      const batchId = route[0]!.batchId;

      await nav(page, '出图记录').click();
      await page.getByRole('heading', { name: '出图记录', level: 1 }).waitFor();
      // 不筛选：与开放 API 的第一页相同，按登记时间倒序。
      await expect.poll(shown).toEqual(all.map(key));
      const search = page.getByRole('search', { name: '筛选出图记录' });
      await search.getByLabel('模板').selectOption(ROUTE);
      await search.getByRole('button', { name: '查询' }).click();
      await expect.poll(shown).toEqual(route.map(key));
      expect(hashOf()).toBe(`#/records?template=${ROUTE}`);

      // 按时间（日期按浏览器的本地时间，起止都含当日）：日期取这一租户最早与最晚一条记录的登记日期，跨过零点运行也成立。
      await search.getByRole('link', { name: '清除筛选' }).click();
      await expect.poll(shown).toEqual(all.map(key));
      const [first, last, before] = await page.evaluate(([oldest, newest]) => {
        const day = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
        const start = new Date(oldest!);
        return [day(start), day(new Date(newest!)), day(new Date(start.getFullYear(), start.getMonth(), start.getDate() - 1))];
      }, [all.at(-1)!.deliveredAt, all[0]!.deliveredAt]);
      await search.getByLabel('截止日期').fill(before!);
      await search.getByRole('button', { name: '查询' }).click();
      await page.getByText('没有符合条件的出图记录').waitFor();
      expect(await rows().count()).toBe(0);
      await search.getByLabel('起始日期').fill(first!);
      await search.getByLabel('截止日期').fill(last!);
      const queried = page.waitForRequest((request) => request.url().includes('/v1/records?'));
      await search.getByRole('button', { name: '查询' }).click();
      const query = new URL((await queried).url()).searchParams;
      // from 是起始日期的本地零点，to 是截止日期第二天的本地零点。
      expect([query.get('from'), query.get('to')]).toEqual(await page.evaluate(([from, to]) => {
        const next = new Date(`${to}T00:00:00`);
        next.setDate(next.getDate() + 1);
        return [new Date(`${from}T00:00:00`).toISOString(), next.toISOString()];
      }, [first, last]));
      const byTime = (await api('GET', `/v1/records?limit=50&from=${enc(query.get('from')!)}&to=${enc(query.get('to')!)}`)).body.records as Entry[];
      expect(byTime.length).toBeGreaterThan(0);
      await expect.poll(shown).toEqual(byTime.map(key));

      // 点一行的批次：只看这一批，与开放 API 按批次查的相同。
      await rows().and(page.locator(`[data-batch="${batchId}"]`)).first().getByRole('link', { name: `只看批次 ${batchId.slice(0, 8)}` }).click();
      await expect.poll(() => search.getByLabel('批次 ID').inputValue()).toBe(batchId);
      const batch = (await api('GET', `/v1/records?batchId=${batchId}`)).body.records as Entry[];
      await expect.poll(shown).toEqual(batch.map(key));

      // 下载一张图片：与开放 API 读到的字节相同。
      const third = rows().and(page.locator('[data-index="3"]'));
      const image = await downloadBytes(page, () => third.getByRole('button', { name: '下载图片' }).click());
      expect(image.name).toBe(`0003-${M402}_currentIndex=3.png`);
      expect(Buffer.compare(image.bytes, (await api('GET', `/v1/batches/${batchId}/items/3/files/image.png`)).bytes)).toBe(0);

      // 按项导出与按批次导出：解开后与开放 API 的导出包逐个文件相同，含出图记录 record.json。
      const sameZip = async (bytes: Buffer, path: string) => {
        const mine = await unzip(bytes), theirs = await unzip((await api('GET', path)).bytes);
        expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
        for (const [name, content] of theirs) expect(Buffer.compare(mine.get(name)!, content), name).toBe(0);
        return mine;
      };
      const item = await downloadBytes(page, () => third.getByRole('button', { name: '导出记录' }).click());
      expect(item.name).toBe(`batch-${batchId}-0003.zip`);
      expect([...(await sameZip(item.bytes, `/v1/batches/${batchId}/items/3/export.zip`)).keys()]).toContain(`batch-${batchId}-0003/record.json`);
      const bar = page.getByRole('region', { name: `批次 ${batchId.slice(0, 8)}` });
      const whole = await downloadBytes(page, () => bar.getByRole('button', { name: '导出整批记录（zip）' }).click());
      expect(whole.name).toBe(`batch-${batchId}.zip`);
      const entries = await sameZip(whole.bytes, `/v1/batches/${batchId}/export.zip`);
      expect(entries.has(`batch-${batchId}/batch.json`)).toBe(true);
      expect([...entries.keys()].filter((name) => name.endsWith('/record.json'))).toHaveLength(6);
      const images = await downloadBytes(page, () => bar.getByRole('button', { name: '下载整批图片（zip）' }).click());
      expect([...(await unzip(images.bytes)).keys()].sort()).toEqual(['0001.png', '0002.png', '0003.png', '0004.png', '0005.png', '0006.png']);
      await bar.getByRole('link', { name: '打开出图任务' }).click();
      expect(hashOf()).toBe(`#/batches/${batchId}`);
    }, 120_000);

    it('用量（票据 14）：操作员看到本月已用、预占与剩余，没有明细；客户管理员另看到用量明细，与开放 API 相同', async () => {
      const usage = (await adminApi('GET', '/v1/usage')).body as { period: string; images: Record<'limit' | 'used' | 'reserved' | 'remaining', number> };
      const numbers = (target: Page) => Promise.all(['limit', 'used', 'reserved', 'remaining'].map((name) => target.getByTestId(`usage-${name}`).textContent()));
      const expected = [usage.images.limit, usage.images.used, usage.images.reserved, usage.images.remaining].map((value) => value.toLocaleString('zh-CN'));
      const [year, month] = usage.period.split('-');
      const requested: string[] = [];
      const listen = (request: { url(): string }) => { requested.push(new URL(request.url()).pathname); };
      page.on('request', listen);

      await nav(page, '用量').click();
      await page.getByRole('heading', { name: '用量', level: 1 }).waitFor();
      await expect.poll(() => numbers(page)).toEqual(expected);
      await page.getByRole('heading', { name: `${year} 年 ${Number(month)} 月` }).waitFor();
      // 明细只给客户管理员（M300）：操作员的页面上没有明细，也不请求它。
      await page.getByText('用量明细只给客户管理员查看').waitFor();
      expect(await page.getByTestId('usage-event').count()).toBe(0);
      page.off('request', listen);
      expect(requested).toContain('/v1/usage');
      expect(requested).not.toContain('/v1/usage/events');

      const adminPage = await asAdmin();
      await nav(adminPage, '用量').click();
      await expect.poll(() => numbers(adminPage)).toEqual(expected);
      const events = (await adminApi('GET', '/v1/usage/events?limit=50')).body.events as { id: string; kind: string; batchId?: string; index?: number }[];
      expect(events.length).toBeGreaterThan(0);
      const shown = () => adminPage.getByTestId('usage-event').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')));
      await expect.poll(shown).toEqual(events.map((event) => event.id));
      expect(await adminPage.getByTestId('usage-event').first().textContent()).toContain(`${events[0]!.batchId!.slice(0, 8)} 第 ${events[0]!.index} 项`);
      // 按种类筛选明细，换计费周期：都与开放 API 相同。
      // 这里的用量都是出图张数：选输入 token 时一条也没有，选出图张数时又都回来。
      const ofKind = async (kind: string) => ((await adminApi('GET', `/v1/usage/events?limit=50&kind=${kind}`)).body.events as { id: string }[]).map((event) => event.id);
      await adminPage.getByLabel('种类').selectOption('inputTokens');
      expect(await ofKind('inputTokens')).toEqual([]);
      await adminPage.getByText('这个周期还没有用量').waitFor();
      await expect.poll(shown).toEqual([]);
      await adminPage.getByLabel('种类').selectOption('image');
      await expect.poll(shown).toEqual(await ofKind('image'));
      const previous = new Date(Date.UTC(Number(year), Number(month) - 2, 1)).toISOString().slice(0, 7);
      await adminPage.getByLabel('计费周期').fill(previous);
      const earlier = (await adminApi('GET', `/v1/usage?period=${previous}`)).body as typeof usage;
      await expect.poll(() => numbers(adminPage)).toEqual([earlier.images.limit, earlier.images.used, earlier.images.reserved, earlier.images.remaining].map((value) => value.toLocaleString('zh-CN')));
      await adminPage.getByRole('heading', { name: `${previous.slice(0, 4)} 年 ${Number(previous.slice(5))} 月` }).waitFor();
    });

    it('管理员页面（票据 14）：成员与角色；API 密钥只在创建时显示一次、可吊销；webhook 的注册与投递记录；审计日志与开放 API 相同', async () => {
      const adminPage = await asAdmin();
      const other = await world.member(world.b.id, 'operator');
      await nav(adminPage, '管理').click();
      await adminPage.getByRole('heading', { name: '管理', level: 1 }).waitFor();
      const status = (text: string) => adminPage.getByRole('status').filter({ hasText: text });

      // 成员与角色：改另一位成员的角色、停用；自己的角色与状态不在这里改。
      const memberOf = async (id: string) => ((await adminApi('GET', '/v1/members')).body.members as { id: string; role: string; active: boolean }[]).find((entry) => entry.id === id)!;
      const role = adminPage.getByLabel(`${other.email} 的角色`);
      await role.selectOption('admin');
      await status(`已把 ${other.email} 改为客户管理员`).waitFor();
      expect(await memberOf(other.id)).toMatchObject({ role: 'admin', active: true });
      await role.selectOption('operator');
      await status(`已把 ${other.email} 改为客户操作员`).waitFor();
      const row = adminPage.getByTestId('member-row').and(adminPage.locator(`[data-email="${other.email}"]`));
      await row.getByRole('button', { name: '停用' }).click();
      await row.getByRole('button', { name: '确认停用' }).click();
      await status(`已停用 ${other.email}`).waitFor();
      expect(await memberOf(other.id)).toMatchObject({ role: 'operator', active: false });
      // 停用的成员的会话随即失效；重新启用后能登录，旧会话不恢复。
      expect((await server('GET', '/v1/me', other.token)).status).toBe(401);
      await row.getByRole('button', { name: '启用' }).click();
      await status(`已启用 ${other.email}`).waitFor();
      expect(await memberOf(other.id)).toMatchObject({ role: 'operator', active: true });
      expect((await server('GET', '/v1/me', other.token)).status).toBe(401);
      expect((await server('POST', '/v1/sessions', '', { email: other.email, password: other.password })).status).toBe(201);
      expect(await adminPage.getByLabel(`${world.b.admin.email} 的角色`).isDisabled()).toBe(true);

      // API 密钥：创建时显示一次，能用；列表只有前缀；关掉或刷新后页面上不再有它；吊销后立即失效。
      await adminPage.getByRole('tab', { name: 'API 密钥' }).click();
      await adminPage.getByLabel('密钥名称').fill('E2E 密钥');
      await adminPage.getByRole('button', { name: '创建密钥' }).click();
      const shownKey = (await adminPage.getByTestId('one-time-secret').textContent())!;
      expect(shownKey).toMatch(/^rwk_/);
      world.secrets.push(shownKey);
      expect(await server('GET', '/v1/me', shownKey)).toMatchObject({ status: 200, body: { kind: 'apiKey', name: 'E2E 密钥' } });
      const key = ((await adminApi('GET', '/v1/api-keys')).body.apiKeys as { id: string; name: string; prefix: string }[]).find((entry) => entry.name === 'E2E 密钥')!;
      expect(shownKey.startsWith(key.prefix)).toBe(true);
      const keyRow = adminPage.getByTestId('api-key-row').and(adminPage.locator(`[data-id="${key.id}"]`));
      expect(await keyRow.textContent()).toContain(key.prefix);
      await adminPage.getByRole('button', { name: '我已保存，关闭' }).click();
      expect(await adminPage.content()).not.toContain(shownKey);
      await adminPage.reload();
      await adminPage.getByRole('tab', { name: 'API 密钥' }).click();
      await keyRow.waitFor();
      expect(await adminPage.content()).not.toContain(shownKey);
      await keyRow.getByRole('button', { name: '吊销' }).click();
      await keyRow.getByRole('button', { name: '确认吊销' }).click();
      await expect.poll(() => keyRow.textContent()).toContain('已吊销');
      expect((await server('GET', '/v1/me', shownKey)).status).toBe(401);

      // webhook：注册时显示一次签名密钥；批次结束时投递，投递记录与开放 API 相同，收到的签名用显示的密钥核得上。
      await adminPage.getByRole('tab', { name: 'webhook' }).click();
      await adminPage.getByLabel('接收地址').fill(hooks.url);
      await adminPage.getByLabel('说明').fill('E2E 接收端');
      await adminPage.getByRole('button', { name: '注册' }).click();
      const secret = (await adminPage.getByTestId('one-time-secret').textContent())!;
      expect(secret).toMatch(/^whsec_/);
      world.secrets.push(secret);
      await adminPage.getByRole('button', { name: '我已保存，关闭' }).click();
      const hook = ((await adminApi('GET', '/v1/webhooks')).body.webhooks as { id: string; description?: string; secretPrefix: string }[]).find((entry) => entry.description === 'E2E 接收端')!;
      expect(secret.startsWith(hook.secretPrefix)).toBe(true);
      const submitted = await server('POST', '/v1/batches', world.b.admin.token,
        { template: BADGE, items: [{ id: 'webhook-e2e', dataset: { id: 'badge-e2e-1' }, output: { width: 90, height: 130, dpi: 120, format: 'png' } }] });
      expect(submitted.status, submitted.raw.slice(0, 300)).toBe(202);
      const deliveries = async () => (await adminApi('GET', `/v1/webhooks/${hook.id}/deliveries`)).body.deliveries as { id: string; batchId: string; status: string }[];
      await expect.poll(async () => (await deliveries()).some((delivery) => delivery.batchId === submitted.body.id && delivery.status === 'succeeded'), { timeout: 120_000 }).toBe(true);
      const hookRow = adminPage.getByTestId('webhook-row').and(adminPage.locator(`[data-id="${hook.id}"]`));
      await hookRow.getByRole('button', { name: '投递记录' }).click();
      const deliveryRows = adminPage.getByTestId('delivery-row');
      const expectedDeliveries = (await deliveries()).map((delivery) => [delivery.id, delivery.status]);
      await expect.poll(() => deliveryRows.evaluateAll((items) => items.map((item) => [item.getAttribute('data-id'), item.getAttribute('data-status')]))).toEqual(expectedDeliveries);
      expect(await deliveryRows.first().textContent()).toContain('HTTP 200');
      const event = hooks.received.find((received) => received.body.includes(submitted.body.id))!;
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(event.headers['renderweave-signature']))!;
      expect(createHmac('sha256', secret).update(`${t}.${event.body}`).digest('hex')).toBe(v1);
      // 停用与重新启用。
      const hookActive = async () => ((await adminApi('GET', `/v1/webhooks/${hook.id}`)).body as { active: boolean }).active;
      await hookRow.getByRole('button', { name: '停用' }).click();
      await expect.poll(hookActive).toBe(false);
      await expect.poll(() => hookRow.textContent()).toContain('已停用');
      await hookRow.getByRole('button', { name: '启用' }).click();
      await expect.poll(hookActive).toBe(true);

      // 审计日志：与开放 API 的第一页相同，刚才的操作都在里面。
      await adminPage.getByRole('tab', { name: '审计日志' }).click();
      const audit = (await adminApi('GET', '/v1/audit-events?limit=50')).body.events as { id: string; action: string; object: { id: string } }[];
      const auditRows = adminPage.getByTestId('audit-row');
      await expect.poll(() => auditRows.evaluateAll((items) => items.map((item) => item.getAttribute('data-id')))).toEqual(audit.map((entry) => entry.id));
      for (const [action, id] of [['member.update', other.id], ['apiKey.create', key.id], ['apiKey.revoke', key.id], ['webhook.create', hook.id]]) {
        expect(audit.some((entry) => entry.action === action && entry.object.id === id), `${action} ${id}`).toBe(true);
      }
      const revoked = auditRows.and(adminPage.locator('[data-action="apiKey.revoke"]')).first();
      expect(await revoked.textContent()).toContain('吊销 API 密钥');
      expect(await revoked.textContent()).toContain(world.b.admin.email);
    }, 180_000);

    it('资源（票据 14）：操作员上传新资源、没有替换入口；客户管理员替换前看到影响检查的结果，确认后才应用，旧版本保留', async () => {
      const resource = async (id: string) => (await api('GET', `/v1/resources/${id}`)).body as { currentVersion: number; versions: unknown[] };
      await nav(page, '资源').click();
      await page.getByRole('heading', { name: '资源', level: 1 }).waitFor();
      const ids = ((await api('GET', '/v1/resources')).body.resources as { id: string }[]).map((entry) => entry.id);
      await expect.poll(() => page.getByTestId('resource-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-id')))).toEqual(ids);
      expect(await page.getByRole('button', { name: /^替换/ }).count()).toBe(0);
      const stamp = await readFile(STAMP);
      await page.getByLabel('种类').selectOption('image');
      await page.getByLabel('资源 ID（可不填）').fill('e2e-stamp');
      await page.getByLabel('选择文件').setInputFiles({ name: 'stamp.png', mimeType: 'image/png', buffer: stamp });
      await page.getByRole('button', { name: '上传', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已上传 e2e-stamp（v1）' }).waitFor();
      expect(await resource('e2e-stamp')).toMatchObject({ id: 'e2e-stamp', kind: 'image', currentVersion: 1 });
      expect(Buffer.compare((await api('GET', '/v1/resources/e2e-stamp/versions/1/content')).bytes, stamp)).toBe(0);
      await page.getByTestId('resource-row').and(page.locator('[data-id="e2e-stamp"]')).waitFor();

      // 替换 landmark-2（M402 数据集的几处地标）：先检查影响；没确认前资源不变。
      const adminPage = await asAdmin();
      await nav(adminPage, '资源').click();
      const before = await resource('landmark-2'), old = (await api('GET', '/v1/resources/landmark-2/versions/1/content')).bytes;
      await adminPage.getByRole('button', { name: '替换 landmark-2' }).click();
      const sheet = adminPage.getByRole('dialog', { name: '替换 landmark-2' });
      const next = await readFile(REPLACEMENT);
      await sheet.getByLabel('新内容').setInputFiles({ name: 'landmark-3.png', mimeType: 'image/png', buffer: next });
      await sheet.getByRole('button', { name: '检查影响' }).click();
      // 页面上的影响与另经开放 API 对同一内容做的检查相同。
      const report = await adminApi('POST', '/v1/resources/landmark-2/replacement-checks', new Uint8Array(next));
      expect(report.status).toBe(200);
      const references = (report.body as { check: { impact: { references: { kind: string; document: string; path: string }[] } } }).check.impact.references;
      expect(references).toContainEqual(expect.objectContaining({ kind: 'datasetImage', document: M402 }));
      await expect.poll(() => sheet.getByTestId('impact-reference').evaluateAll((rows) => rows.map((row) => `${row.getAttribute('data-document')} ${row.getAttribute('data-path')}`)))
        .toEqual(references.map((reference) => `${reference.document} ${reference.path}`));
      expect(await sheet.textContent()).toContain(`受影响的位置 ${references.length} 处`);
      expect(await resource('landmark-2')).toEqual(before);

      await sheet.getByRole('button', { name: '确认替换' }).click();
      await adminPage.getByRole('status').filter({ hasText: '已把 landmark-2 替换为 v2' }).waitFor();
      expect(await resource('landmark-2')).toMatchObject({ currentVersion: 2, versions: [expect.objectContaining({ version: 1 }), expect.objectContaining({ version: 2 })] });
      expect(Buffer.compare((await api('GET', '/v1/resources/landmark-2/versions/2/content')).bytes, next)).toBe(0);
      expect(Buffer.compare((await api('GET', '/v1/resources/landmark-2/versions/1/content')).bytes, old)).toBe(0);
      await expect.poll(() => adminPage.getByTestId('resource-row').and(adminPage.locator('[data-id="landmark-2"]')).textContent()).toContain('v2');
    });

    it('操作员看不到管理员页面（票据 14）：导航里没有"管理"，直接打开只看到说明；直接调用对应接口被拒绝', async () => {
      expect(await nav(page, '管理').count()).toBe(0);
      const requested: string[] = [];
      page.on('request', (request) => requested.push(new URL(request.url()).pathname));
      for (const tab of ['members', 'api-keys', 'webhooks', 'audit']) {
        await page.goto(`${baseUrl}/console/#/admin/${tab}`);
        await page.getByText('管理页面只给客户管理员').waitFor();
      }
      expect(requested.filter((path) => /^\/v1\/(members|api-keys|webhooks|audit-events)/.test(path))).toEqual([]);
      const token = world.b.operator.token, id = '00000000-0000-4000-8000-000000000000';
      for (const [method, path, body] of [
        ['GET', '/v1/members'], ['PATCH', `/v1/members/${world.b.admin.id}`, { role: 'operator' }],
        ['GET', '/v1/api-keys'], ['POST', '/v1/api-keys', { name: '越权' }], ['DELETE', `/v1/api-keys/${id}`],
        ['GET', '/v1/audit-events'], ['GET', '/v1/webhooks'], ['POST', '/v1/webhooks', { url: hooks.url }], ['GET', `/v1/webhooks/${id}/deliveries`],
        ['GET', '/v1/usage/events'], ['POST', '/v1/resources/landmark-2/replacements', { check: {} }],
      ] as [string, string, unknown?][]) {
        const reply = await server(method, path, token, body);
        expect(reply.status, `${method} ${path}`).toBe(403);
        expect(reply.body.problems[0].code, `${method} ${path}`).toBe('auth.forbidden');
      }
      // 替换检查的请求体是内容本身。
      const check = await fetch(`${baseUrl}/v1/resources/landmark-2/replacement-checks`,
        { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: new Uint8Array([1]) });
      expect(check.status).toBe(403);
      expect(((await adminApi('GET', '/v1/members')).body.members as { id: string }[]).find((entry) => entry.id === world.b.admin.id)).toMatchObject({ role: 'admin', active: true });
    });

    it('退出后会话失效，回到登录页；整个过程没有脚本错误，也没有被内容安全策略拦下的资源', async () => {
      await page.getByRole('button', { name: '退出' }).click();
      await page.getByRole('button', { name: '登录' }).waitFor();
      expect(await page.evaluate(() => sessionStorage.getItem('renderweave.console.token'))).toBeNull();
      expect(pageErrors).toEqual([]);
    });
  });
}
