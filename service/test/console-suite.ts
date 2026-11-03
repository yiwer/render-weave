/**
 * 出图控制台的浏览器端到端测试（票据 12，M281）：浏览器经接口进程打开 /console/，像客户操作员一样
 * 登录、看模板、调参数、填表、预览、出图、下载；每一步的结果再经开放 API 核对，不看控制台的内部状态。
 * 界面按原型方案一（M282）：首页是数据集，编辑页左表单、右草稿预览，出图在侧栏里进行。
 * 票据 14 另有出图记录、用量、资源与管理页（M300、M301）：客户管理员在另一个浏览器上下文里登录，操作员与管理员各看各的。
 * P1 票据 01 换成标题栏模块下拉与状态栏的新框架：换页走模块下拉（nav），既有用例只改了选择器；新框架另有三条用例。
 * P1 票据 06 的数据定义三页：另起草案 → 加必填字段 → 看差异与影响 → 发布 → 以旧版另发，九种字段类型，操作员只读。
 * P1 票据 11 的审批：管理页打开开关，代建工程师经开放 API 发起申请，发布记录页与发布模板修订页上退回与批准。
 * Docker 后端测试里浏览器是 tester 容器里的 Chromium，接口进程与 worker 是 Compose 里真实的进程（console.docker.test.ts）；
 * 本机另可用内存后端加本机浏览器快速跑（console.browser.test.ts，设 RW_BROWSER）。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServiceBackend } from '../src/backend.js';
import { createWorld, type World } from './api-suite.js';
import { unzip } from './records-suite.js';
import { checkDslDocument } from '../src/engine.js';
import { RESOURCES_DIR, seedAllElements, seedConsoleBadge, seedM402, seedPriceTag, seedStress } from './seed.js';
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
      await seedAllElements(storage);
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
    /** 标题栏的模块下拉（P1 票据 01）：点开后找名为 name 的模块。 */
    const nav = async (target: Page, name: string) => {
      await target.getByRole('button', { name: '切换模块' }).click();
      return target.getByRole('menu', { name: '模块' }).getByRole('menuitem', { name, exact: true });
    };
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

      await (await nav(page, '模板')).click();
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
      await (await nav(page, '数据集')).click();
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

    it.skipIf(options.inProcessWorker ?? false)('状态栏（P1 票据 01）：本标签页进行中的批次数，点开是那一批；取消结束后不再算', async () => {
      // 上一个用例建的二十份压力细牌：出一批要画一阵，提交后状态栏先看到它在进行。
      const stress = Array.from({ length: 20 }, (_, i) => `stress-${i + 1}`);
      const running = page.getByRole('contentinfo', { name: '状态栏' }).getByTestId('running-batches');
      await expect.poll(() => running.textContent(), { timeout: 15_000 }).toBe('没有进行中的批次');
      await page.goto(`${baseUrl}/console/#/deliver?datasets=${stress.join(',')}`);
      const stressSheet = page.getByRole('dialog', { name: '20 份数据集' });
      await stressSheet.getByLabel('宽（mm）').fill('200');
      await stressSheet.getByLabel('高（mm）').fill('2000');
      await stressSheet.getByRole('button', { name: '提交 20 张' }).click();
      await page.getByRole('button', { name: '取消批次' }).waitFor();
      const id = /batches\/([0-9a-f-]{36})/.exec(page.url())![1]!;
      await expect.poll(() => running.textContent()).toBe('进行中的批次 1');
      expect(await running.getAttribute('href')).toBe(`#/batches/${id}`);
      await page.getByRole('button', { name: '取消批次' }).click();
      await page.getByRole('button', { name: '确认取消' }).click();
      expect(await batchFinished()).toBe(id);
      await expect.poll(() => running.textContent(), { timeout: 15_000 }).toBe('没有进行中的批次');
      expect((await api('GET', `/v1/batches/${id}`)).body).toMatchObject({ status: 'finished', cancelRequested: true });
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

      await (await nav(page, '出图')).click();
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

      await (await nav(page, '用量')).click();
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
      await (await nav(adminPage, '用量')).click();
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
      await (await nav(adminPage, '管理')).click();
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

      // 代建写入的内容哈希与差异摘要（P1 票据 03）：代建工程师推送一个新资源，按主体筛选后看到它的差异，导出筛选结果。
      const stamp = await readFile(STAMP), stampSha256 = createHash('sha256').update(stamp).digest('hex');
      expect((await world.call('PUT', `/v1/authoring/tenants/${world.b.id}/contents/${stampSha256}`, world.b.engineer.token, new Uint8Array(stamp))).status).toBe(204);
      const pushed = await world.call('POST', `/v1/authoring/tenants/${world.b.id}/pushes`, world.b.engineer.token, {
        documents: [], resources: [{ id: 'audit-stamp', kind: 'image', versions: [{ version: 1, sha256: stampSha256, byteLength: stamp.length }] }] });
      expect(pushed.status, pushed.raw.slice(0, 300)).toBe(200);
      await adminPage.getByLabel('主体').selectOption({ label: '代建工程师' });
      await adminPage.getByRole('search', { name: '筛选审计日志' }).getByRole('button', { name: '查询' }).click();
      const engineerAudit = (await adminApi('GET', '/v1/audit-events?limit=50&actorKind=authoringToken')).body.events as { id: string }[];
      await expect.poll(() => auditRows.evaluateAll((items) => items.map((item) => [item.getAttribute('data-id'), item.getAttribute('data-actor-kind')])))
        .toEqual(engineerAudit.map((entry) => [entry.id, 'authoringToken']));
      const commit = auditRows.and(adminPage.locator('[data-action="push.commit"]')).first();
      await commit.getByText('新增 1 · 修改 0 · 删除 0').click();
      expect(await commit.locator('[data-path="resource:audit-stamp"]').textContent()).toContain(stampSha256.slice(0, 8));
      expect(await commit.locator(`[data-sha256="${stampSha256}"]`).count()).toBe(1);
      const exported = await downloadBytes(adminPage, () => adminPage.getByRole('button', { name: '导出 CSV' }).click());
      expect(exported.name).toMatch(/^audit-events-\d{4}-\d{2}-\d{2}\.csv$/);
      const lines = exported.bytes.toString('utf8').replace(/^\uFEFF/, '').trim().split('\r\n');
      expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(engineerAudit.map((entry) => entry.id));
      expect(lines.find((line) => line.includes('push.commit'))).toContain(stampSha256);
    }, 180_000);

    it('资源（票据 14）：操作员上传新资源、没有替换入口；客户管理员替换前看到影响检查的结果，确认后才应用，旧版本保留', async () => {
      const resource = async (id: string) => (await api('GET', `/v1/resources/${id}`)).body as { currentVersion: number; versions: unknown[] };
      await (await nav(page, '资源')).click();
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
      await (await nav(adminPage, '资源')).click();
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
      expect(await (await nav(page, '管理')).count()).toBe(0);
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

    it('新框架（P1 票据 01）：模块下拉按角色只列能进的模块，Ctrl+数字切换；Ctrl+K 只列模块与常用动作；状态栏；旧链接照旧能打开', async () => {
      const MEMBER = ['数据定义', '模板', '数据集', '出图', '资源', '用量'];
      const switcher = (target: Page) => target.getByRole('button', { name: '切换模块' });
      /** 模块下拉里的模块与快捷键，如"数据定义 Control+1"；读完按 Esc 关掉。 */
      const listed = async (target: Page) => {
        await switcher(target).click();
        await target.getByRole('menu', { name: '模块' }).waitFor();
        const items = await target.getByRole('menu', { name: '模块' }).getByRole('menuitem')
          .evaluateAll((entries) => entries.map((entry) => `${entry.querySelector('.menu-label')!.textContent} ${entry.getAttribute('aria-keyshortcuts')}`));
        await target.keyboard.press('Escape');
        expect(await target.getByRole('menu').count()).toBe(0);
        return items;
      };
      await page.goto(`${baseUrl}/console/#/datasets`);
      await page.getByRole('heading', { name: '数据集', level: 1 }).waitFor();
      expect(await listed(page)).toEqual(MEMBER.map((name, index) => `${name} Control+${index + 1}`));
      const adminPage = await asAdmin();
      expect(await listed(adminPage)).toEqual([...MEMBER, '管理'].map((name, index) => `${name} Control+${index + 1}`));

      // Ctrl+数字切换模块；数据定义列出已发布的静态数据定义，与开放 API 相同。
      await page.keyboard.press('Control+1');
      await page.getByRole('heading', { name: '数据定义', level: 1 }).waitFor();
      expect(hashOf()).toBe('#/definitions');
      const schemas = (await api('GET', '/v1/static-schemas')).body.staticSchemas as { name: string }[];
      await expect.poll(() => page.getByTestId('definition-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-name'))))
        .toEqual([...new Set(schemas.map((schema) => schema.name))]);
      await adminPage.keyboard.press('Control+7');
      await adminPage.getByRole('heading', { name: '管理', level: 1 }).waitFor();
      // 出图模块：出图记录与批次两页；批次是本标签页提交过的，状态与已交付张数与开放 API 相同。
      await page.keyboard.press('Control+4');
      await page.getByRole('heading', { name: '出图记录', level: 1 }).waitFor();
      expect(hashOf()).toBe('#/records');
      await page.getByRole('navigation', { name: '出图' }).getByRole('link', { name: '批次' }).click();
      await page.getByRole('heading', { name: '批次', level: 1 }).waitFor();
      const rows = page.getByTestId('batch-row');
      await expect.poll(() => rows.count()).toBeGreaterThanOrEqual(3);
      const ids = await rows.evaluateAll((items) => items.map((item) => item.getAttribute('data-id')!));
      for (const id of ids) {
        const view = (await api('GET', `/v1/batches/${id}`)).body as { status: string; summary: { delivered: number }; progress: { total: number } };
        expect(view.status).toBe('finished');
        await expect.poll(() => rows.and(page.locator(`[data-id="${id}"]`)).textContent()).toContain(`${view.summary.delivered} / ${view.progress.total}`);
      }

      // Ctrl+K：只列模块与常用动作，按角色；输入几个字筛选，回车打开，焦点落在要做的那一步上；不搜数据集与模板。
      const commands = (target: Page) => target.getByRole('dialog', { name: '模块与动作' });
      const options = (target: Page) => commands(target).getByRole('option').evaluateAll((items) => items.map((item) => item.querySelector('span')!.textContent));
      await page.keyboard.press('Control+k');
      await commands(page).waitFor();
      expect(await options(page)).toEqual([...MEMBER, '新建数据集', '从 Excel 导入', '上传资源']);
      await commands(page).getByRole('combobox').fill('M402');
      expect(await options(page)).toEqual([]);
      await commands(page).getByText('这里不搜数据集与模板').waitFor();
      await commands(page).getByRole('combobox').fill('上传');
      expect(await options(page)).toEqual(['上传资源']);
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: '资源', level: 1 }).waitFor();
      expect(hashOf()).toBe('#/resources');
      await expect.poll(() => page.evaluate('document.activeElement && document.activeElement.id')).toBe('upload-kind');
      await page.keyboard.press('Control+k');
      await commands(page).waitFor();
      await page.keyboard.press('Escape');
      expect(await commands(page).count()).toBe(0);
      await adminPage.keyboard.press('Control+k');
      await commands(adminPage).waitFor();
      expect(await options(adminPage)).toEqual([...MEMBER, '管理', '新建数据集', '从 Excel 导入', '上传资源', '管理成员', '创建 API 密钥', '查看审计日志']);
      await adminPage.keyboard.press('Escape');

      // 状态栏：连接、当前租户、本月剩余与进行中的批次，与开放 API 相同；左栏留给 Agent，现在不显示。
      const bar = page.getByRole('contentinfo', { name: '状态栏' });
      const tenant = (await api('GET', '/v1/tenant')).body as { name: string };
      const { images } = (await adminApi('GET', '/v1/usage')).body as { images: { limit: number; remaining: number } };
      expect(await bar.getByTestId('connection').textContent()).toBe('已连接');
      expect(await bar.getByTestId('tenant').textContent()).toBe(tenant.name);
      await expect.poll(() => bar.getByTestId('quota').textContent()).toBe(`本月剩余 ${images.remaining.toLocaleString('zh-CN')} / ${images.limit.toLocaleString('zh-CN')} 张`);
      await expect.poll(() => bar.getByTestId('running-batches').textContent(), { timeout: 15_000 }).toBe('没有进行中的批次');
      expect(await page.getByRole('complementary', { name: 'Agent 对话' }).count()).toBe(0);

      // 旧链接照旧能打开，模块下拉显示它所属的模块。
      for (const [link, module, shown] of [
        ['#/import', '数据集', () => page.getByRole('dialog').waitFor()],
        [`#/datasets/${M402}`, '数据集', () => page.getByRole('heading', { name: 'M402 开往万国城总站', level: 1 }).waitFor()],
        [`#/batches/${ids[0]}`, '出图', () => page.getByTestId('batch-status').waitFor()],
        [`#/records?batch=${ids[0]}`, '出图', () => expect.poll(() => page.getByRole('search', { name: '筛选出图记录' }).getByLabel('批次 ID').inputValue()).toBe(ids[0])],
        [`#/templates/${enc(BADGE)}`, '模板', () => page.getByRole('heading', { name: BADGE, level: 1 }).waitFor()],
        ['#/usage', '用量', () => page.getByTestId('usage-limit').waitFor()],
      ] as [string, string, () => Promise<unknown>][]) {
        await page.goto(`${baseUrl}/console/${link}`);
        await shown();
        expect(await switcher(page).getAttribute('aria-label'), link).toBe(`切换模块，当前为${module}`);
      }
    }, 120_000);

    it('新框架（P1 票据 01）：窄窗口下模块占满宽度、没有横向滚动；正文与背景对比度不低于 4.5，调和橙不承载文字', async () => {
      const luminance = (rgb: string) => {
        const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map((value) => {
          const c = Number(value) / 255;
          return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      const contrast = (a: string, b: string) => {
        const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (high! + 0.05) / (low! + 0.05);
      };
      // 正文与页面底的颜色、带字的元素里用调和橙的、页面比窗口宽出来的像素。
      const look = () => page.evaluate(`(() => {
        const body = getComputedStyle(document.body);
        const orange = [...document.querySelectorAll('body *')].filter((element) => element.childElementCount === 0 && element.textContent.trim()
          && getComputedStyle(element).color === 'rgb(241, 125, 19)').map((element) => element.textContent.trim());
        return { color: body.color, background: body.backgroundColor, orange, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`) as Promise<{ color: string; background: string; orange: string[]; overflow: number }>;
      const pages: [string, () => Promise<unknown>][] = [
        ['#/definitions', () => page.getByTestId('definition-row').first().waitFor()],
        [`#/definitions/${enc('线路牌')}`, () => page.getByTestId('field-row').first().waitFor()],
        ['#/definition-publications', () => page.getByTestId('publication-row').first().waitFor()],
        ['#/templates', () => page.getByRole('article', { name: `模板 ${BADGE}` }).waitFor()],
        ['#/datasets', () => page.getByRole('link', { name: 'M402 开往万国城总站' }).waitFor()],
        // 布局只看表单与站点表，不等草稿预览：预览排在模板页的缩略图后面，Docker 后端的单项超时只有 1.5 秒。
        [`#/datasets/${M402}`, () => page.getByLabel('停靠站点 第 8 项 站名', { exact: true }).waitFor()],
        ['#/records', () => page.getByTestId('record-row').first().waitFor()],
        ['#/batches', () => page.getByTestId('batch-row').first().waitFor()],
        ['#/resources', () => page.getByTestId('resource-row').first().waitFor()],
        ['#/usage', () => page.getByTestId('usage-limit').waitFor()],
      ];
      try {
        for (const width of [1440, 375]) {
          await page.setViewportSize({ width, height: 900 });
          for (const [link, shown] of pages) {
            await page.goto(`${baseUrl}/console/${link}`);
            await shown();
            const seen = await look();
            expect(seen.overflow, `${width} ${link}`).toBe(0);
            expect(seen.orange, `${width} ${link}`).toEqual([]);
            expect([seen.color, seen.background], link).toEqual(['rgb(34, 21, 15)', 'rgb(253, 251, 246)']);
            expect(contrast(seen.color, seen.background)).toBeGreaterThanOrEqual(4.5);
            expect((await page.getByRole('main').boundingBox())!.width, `${width} ${link}`).toBe(width);
          }
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    }, 180_000);

    /** 数据定义的一行（列表）与字段表的一行（详情）。 */
    const definitionRow = (target: Page, name: string) => target.locator(`[data-testid="definition-row"][data-name="${name}"]`);
    const fieldRow = (target: Page, name: string) => target.locator(`[data-testid="field-row"][data-field="${name}"]`);
    const publicationRow = (target: Page, name: string, version: number) => target.locator(`[data-testid="publication-row"][data-name="${name}"][data-version="${version}"]`);
    const openField = (target: Page, name: string) => fieldRow(target, name).getByRole('button').first().click();
    const menuLabels = (target: Page) => target.getByRole('menu').getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('.menu-label')!.textContent));
    const checkPassed = (target: Page) => target.getByTestId('check-status').filter({ hasText: '校验通过' }).waitFor();
    /** 添加字段：填共同的属性，别的由 fill 填；加入草案后等校验回来。 */
    const addField = async (target: Page, field: { displayName: string; name: string; type: string; required?: boolean }, fill?: () => Promise<void>) => {
      await target.getByRole('button', { name: '添加字段' }).click();
      await target.getByLabel('显示名称', { exact: true }).fill(field.displayName);
      await target.getByLabel('字段名称', { exact: true }).fill(field.name);
      await target.getByLabel('类型', { exact: true }).selectOption({ label: field.type });
      if (field.required) await target.getByLabel('必填', { exact: true }).check();
      await fill?.();
      await target.getByRole('button', { name: '加入草案' }).click();
      await fieldRow(target, field.name).waitFor();
    };

    it('数据定义（P1 票据 06）：另起草案 → 加必填字段 → 看差异与影响 → 发布 → 以旧版另发；每一步都与开放 API 相同', async () => {
      const target = await asAdmin(), name = '线路牌', path = enc(name);
      const definitionsApi = async () => ((await adminApi('GET', '/v1/definitions')).body.definitions as any[]).find((item) => item.name === name);
      const versionOf = async (version: number) => (await adminApi('GET', `/v1/static-schemas/${path}/versions/${version}`)).body;
      await (await nav(target, '数据定义')).click();
      await target.getByRole('heading', { name: '数据定义', level: 1 }).waitFor();

      // 列表：当前版本、草案状态与引用数；"从示例图提取""从数据集提取"在 P2 接入前不显示。
      const row = definitionRow(target, name), listed = await definitionsApi();
      await row.getByTestId('definition-version').filter({ hasText: 'v1' }).waitFor();
      expect(await row.getByTestId('definition-uses').textContent()).toBe(`${listed.versions[0].templates} 个模板 · ${listed.versions[0].datasets} 份数据集`);
      await row.getByTestId('definition-status').filter({ hasText: '已发布' }).waitFor();
      expect(await target.getByText('示例图').count() + await target.getByText('从数据集').count()).toBe(0);

      // 右键一行：导出编译产物与开放 API 相同，复制引用，在新标签页打开时带着会话。
      await row.getByTestId('definition-uses').click({ button: 'right' });
      expect(await menuLabels(target)).toEqual(['打开', '在新标签页打开', '查看发布记录', '导出编译产物 JSON Schema', '复制引用', '从这一版另起草案']);
      const exported = await downloadBytes(target, () => target.getByRole('menuitem', { name: /导出编译产物/ }).click());
      expect(exported.name).toBe('线路牌-v1.schema.json');
      expect(JSON.parse(exported.bytes.toString('utf8'))).toEqual((await versionOf(1)).compiled);
      // 剪贴板只在安全上下文里有（本机 127.0.0.1 有，Compose 网络里的 http://api 没有，也授不了权）；没有时把引用写在页面上，让人手动复制。
      const secure = await target.evaluate('window.isSecureContext');
      if (secure) await adminContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
      await row.getByTestId('definition-uses').click({ button: 'right' });
      await target.getByRole('menuitem', { name: /复制引用/ }).click();
      if (secure) {
        await target.getByRole('status').filter({ hasText: '已复制' }).waitFor();
        expect(JSON.parse(await target.evaluate('navigator.clipboard.readText()') as string)).toEqual({ name, version: 1 });
      } else {
        await target.getByRole('status').filter({ hasText: JSON.stringify({ name, version: 1 }) }).waitFor();
      }
      await row.getByRole('button', { name: /更多操作/ }).click();
      const [tab] = await Promise.all([adminContext.waitForEvent('page'), target.getByRole('menuitem', { name: '在新标签页打开' }).click()]);
      await tab.getByTestId('definition-meta').filter({ hasText: 'v1' }).waitFor();
      await tab.close();
      await row.getByTestId('definition-uses').click({ button: 'right' });
      await target.getByRole('menuitem', { name: '查看发布记录' }).click();
      await publicationRow(target, name, 1).waitFor();
      await target.getByTestId('records-filter').filter({ hasText: name }).waitFor();
      expect(await publicationRow(target, name, 1).getByTestId('publication-actor').textContent(), '种子直接写存储，审计里没有').toBe('没有记录');
      await (await nav(target, '数据定义')).click();

      // 从这一版另起草案：进详情，字段表列谁在用。
      await row.getByTestId('definition-uses').click({ button: 'right' });
      await target.getByRole('menuitem', { name: /另起草案/ }).click();
      await target.getByTestId('definition-meta').filter({ hasText: '基于 v1' }).waitFor();
      const draft = (await adminApi('GET', `/v1/definitions/${path}/draft`)).body;
      expect(draft).toMatchObject({ baseVersion: 1, updatedBy: world.b.admin.email });
      const routeNo = fieldRow(target, 'routeNo');
      expect(await routeNo.getByTestId('field-type').textContent()).toBe('文本');
      expect(await routeNo.getByTestId('field-constraints').textContent()).toBe('1–8 字');
      expect(await routeNo.getByTestId('field-required').textContent()).toBe('是');
      expect(await routeNo.getByTestId('field-uses').textContent()).toBe(ROUTE);
      expect(await fieldRow(target, 'stops').getByTestId('field-type').textContent()).toBe('列表 · 数据定义引用 · 停靠站点 v1');
      await target.getByRole('button', { name: '校验', exact: true }).click();
      await checkPassed(target);

      // 改字段名称、删字段：提示会影响的模板；取消之后草案没变。
      await openField(target, 'routeNo');
      await target.getByTestId('field-used-by').filter({ hasText: ROUTE }).waitFor();
      await target.getByLabel('字段名称', { exact: true }).fill('lineNo');
      const renameImpact = target.getByTestId('rename-impact');
      await renameImpact.filter({ hasText: ROUTE }).waitFor();
      expect(await renameImpact.textContent()).toContain('改字段名称等于删掉 routeNo');
      await target.getByRole('button', { name: '删除字段' }).click();
      await target.getByTestId('remove-impact').filter({ hasText: ROUTE }).waitFor();
      await target.getByRole('button', { name: '留着' }).click();
      await target.getByRole('button', { name: '取消改动' }).click();
      expect(await target.getByTestId('field-detail').count()).toBe(0);
      await routeNo.waitFor();
      expect((await adminApi('GET', `/v1/definitions/${path}/draft`)).body.sha256).toBe(draft.sha256);

      // 校验的问题定位到字段：严重问题时不能发布，改正之后恢复。
      await openField(target, 'fare');
      await target.getByLabel('下限', { exact: true }).fill('200');
      await target.getByRole('button', { name: '保存字段' }).click();
      await fieldRow(target, 'fare').getByTestId('field-problems').filter({ hasText: '下界 200 大于上界 100' }).waitFor();
      await target.getByTestId('check-status').filter({ hasText: '1 个严重问题' }).waitFor();
      expect(await fieldRow(target, 'fare').getByText('已修改').count()).toBe(1);
      expect(await target.getByRole('button', { name: /^发布/ }).isDisabled()).toBe(true);
      expect(await target.getByRole('button', { name: '预览编译产物' }).isDisabled()).toBe(true);
      await target.getByRole('list', { name: '校验问题' }).getByRole('button').click();
      await target.getByLabel('下限', { exact: true }).fill('0');
      await target.getByRole('button', { name: '保存字段' }).click();
      await checkPassed(target);
      expect(await fieldRow(target, 'fare').getByText('已修改').count(), '改回去了').toBe(0);

      // 手动加一个必填字段。选另一行时先保存当前这行。
      await addField(target, { displayName: '所属车队', name: 'depot', type: '文本', required: true }, () => target.getByLabel('最长（字）', { exact: true }).fill('20'));
      const depot = fieldRow(target, 'depot');
      expect(await depot.getByTestId('field-constraints').textContent()).toBe('最多 20 字');
      expect(await depot.getByTestId('field-required').textContent()).toBe('是');
      expect(await depot.getByText('新增').count()).toBe(1);
      await target.getByTestId('draft-changes').filter({ hasText: '新增 1、修改 0、删除 0' }).waitFor();
      await checkPassed(target);
      await openField(target, 'depot');
      await target.getByLabel('说明', { exact: true }).fill('运营这条线路的车队');
      await openField(target, 'fare');
      await expect.poll(async () => JSON.parse((await adminApi('GET', `/v1/definitions/${path}/draft`)).body.content).fields.at(-1))
        .toEqual({ name: 'depot', displayName: '所属车队', type: 'text', constraints: { required: true, maxLength: 20 }, description: '运营这条线路的车队' });
      await openField(target, 'fare');
      await checkPassed(target);

      // 编译预览与校验接口相同。
      await target.getByRole('button', { name: '预览编译产物' }).click();
      const preview = JSON.parse((await target.getByTestId('compiled-preview').textContent())!);
      const verdict = (await adminApi('GET', `/v1/definitions/${path}/draft/check`)).body;
      expect(preview).toEqual(verdict.compiled);
      expect(preview.required).toContain('depot');

      // 发布：先看字段级差异与预检结果，数字与开放 API 相同。
      await target.getByRole('button', { name: '发布为 v2' }).click();
      const saved = (await adminApi('GET', `/v1/definitions/${path}/draft`)).body;
      const preflight = (await adminApi('POST', `/v1/definitions/${path}/draft/publish-check`, { expectedSha256: saved.sha256 })).body;
      await target.getByRole('heading', { name: '发布为 线路牌 v2', level: 1 }).waitFor();
      const added = target.getByTestId('definition-diff').locator('li[data-path="depot"]');
      expect(await added.getAttribute('data-change')).toBe('added');
      expect(await added.textContent()).toContain('新增必填字段 所属车队，文本，最多 20 字');
      expect(preflight.datasets.mismatched).toBeGreaterThan(0);
      expect(await target.getByTestId('datasets-verdict').textContent()).toBe(`绑定 v1 的 ${preflight.datasets.total} 份数据集全部核对：${preflight.datasets.mismatched} 份按新版会失配。`);
      await target.getByTestId('dataset-samples').locator(`tr[data-id="${preflight.datasets.samples[0].id}"]`).filter({ hasText: 'depot' }).waitFor();
      await target.getByTestId('template-impact').locator(`li[data-name="${ROUTE}"]`).filter({ hasText: '绑定 v1' }).waitFor();
      expect(await target.getByTestId('datasets-incomplete').count()).toBe(0);
      expect(await target.getByTestId('publish-meta').locator('[data-sha256]').getAttribute('data-sha256')).toBe(saved.sha256);
      // 超过上限的情况写清楚（真要造 1,000 份数据集太慢，用改过的回答）。
      await target.route('**/draft/publish-check', async (route) => {
        const response = await route.fetch(), body = await response.json();
        await route.fulfill({ response, json: { ...body, datasets: { ...body.datasets, total: 1280, checked: 1000, complete: false } } });
      });
      await target.reload();
      await target.getByTestId('datasets-incomplete').filter({ hasText: '未全部核对' }).filter({ hasText: '共 1,280 份' }).filter({ hasText: '前 1,000 份' }).waitFor();
      await target.unroute('**/draft/publish-check');
      await target.reload();
      await target.getByRole('button', { name: '发布为 v2' }).click();

      // 发布之后到发布记录，展开这一版：谁、改动摘要、内容哈希。
      const v2 = publicationRow(target, name, 2);
      await v2.waitFor();
      const records = async () => ((await api('GET', `/v1/definition-publications?name=${path}`)).body.publications as any[]);
      const [newest] = await records();
      expect(newest).toMatchObject({ version: 2, baseVersion: 1, source: 'web', actor: { kind: 'member', label: world.b.admin.email } });
      expect(await v2.getByTestId('publication-actor').textContent()).toBe(world.b.admin.email);
      expect(await v2.getByTestId('publication-summary').textContent()).toBe('新增 depot');
      const detail = target.getByTestId('publication-detail');
      await detail.locator('li[data-path="depot"]').waitFor();
      expect(await detail.locator('[data-sha256]').first().getAttribute('data-sha256')).toBe(newest.sha256);
      expect(await detail.locator('[data-sha256]').nth(1).getAttribute('data-sha256')).toBe(newest.baseSha256);
      expect((await adminApi('GET', `/v1/definitions/${path}/draft`)).status, '草案已删除').toBe(404);
      const compiled = await downloadBytes(target, () => detail.getByRole('button', { name: '导出编译产物' }).click());
      expect(createHash('sha256').update(compiled.bytes).digest('hex'), '导出的字节就是发布的产物').toBe(newest.compiledSha256);
      expect(await detail.getByRole('button', { name: /另发/ }).count(), '当前版本不用另发').toBe(0);

      // 以旧版另发：一键得到内容与 v1 相同的 v3，旧版本不变。
      await publicationRow(target, name, 1).getByRole('button').first().click();
      await detail.getByRole('button', { name: '以这一版另发新版本' }).click();
      await target.getByTestId('republish-confirm').filter({ hasText: '把 v1 的内容发布为新版本' }).waitFor();
      const v2Before = (await adminApi('GET', `/v1/static-schemas/${path}/versions/2`)).raw;
      await target.getByRole('button', { name: '确认以 v1 另发' }).click();
      await target.getByRole('status').filter({ hasText: '发布为 v3' }).waitFor();
      const v3 = publicationRow(target, name, 3);
      await v3.getByTestId('publication-summary').filter({ hasText: '以 v1 的内容另发' }).waitFor();
      await v3.getByText('当前版本').waitFor();
      expect(await publicationRow(target, name, 2).getByText('当前版本').count()).toBe(0);
      const [first, third] = [await versionOf(1), await versionOf(3)];
      expect({ ...third.definition, version: 1 }).toEqual(first.definition);
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/2`)).raw, '旧版本不变').toBe(v2Before);
      expect((await records()).map((item) => item.version)).toEqual([3, 2, 1]);
      expect((await adminApi('GET', '/v1/audit-events?limit=500')).body.events.filter((event: any) => event.action === 'definition.publish').map((event: any) => event.object.id).slice(0, 2)).toEqual(['线路牌@3', '线路牌@2']);

      // 看已发布的版本：只读，可以切换。
      await (await nav(target, '数据定义')).click();
      await row.getByTestId('definition-version').filter({ hasText: 'v3' }).waitFor();
      await row.getByRole('link').click();
      await target.getByTestId('definition-meta').filter({ hasText: 'v3 · 当前版本' }).waitFor();
      await target.getByLabel('查看的版本').selectOption('2');
      await target.getByTestId('definition-meta').filter({ hasText: 'v2' }).waitFor();
      await fieldRow(target, 'depot').waitFor();
      await openField(target, 'depot');
      await target.getByTestId('field-detail').filter({ hasText: '运营这条线路的车队' }).waitFor();
      expect(await target.getByRole('button', { name: '添加字段' }).count()).toBe(0);
      await target.getByLabel('查看的版本').selectOption('1');
      await target.getByTestId('definition-meta').filter({ hasText: 'v1' }).waitFor();
      expect(await fieldRow(target, 'depot').count()).toBe(0);
    });

    it('数据定义（P1 票据 06）：新建空白数据定义，手动添加九种字段类型并发布成 v1；名称写错定位到那一行；草案可以删除', async () => {
      const target = await asAdmin(), name = `全字段${randomUUID().slice(0, 8)}`, path = enc(name);
      await target.goto(`${baseUrl}/console/#/definitions`);
      await target.getByRole('button', { name: '新建数据定义' }).click();
      await target.getByLabel('名称', { exact: true }).fill(name);
      await target.getByLabel('显示名称', { exact: true }).fill('九种字段');
      await target.getByRole('button', { name: '新建草案' }).click();
      await target.getByRole('heading', { name: '九种字段', level: 1 }).waitFor();
      await target.getByTestId('definition-meta').filter({ hasText: '还没发布过' }).waitFor();
      await target.getByText('还没有字段，添加第一个。').waitFor();
      await checkPassed(target);

      await addField(target, { displayName: '标题', name: 'title', type: '文本', required: true }, async () => {
        await target.getByLabel('最短（字）', { exact: true }).fill('1');
        await target.getByLabel('最长（字）', { exact: true }).fill('20');
        await target.getByLabel('可选值（一行一个）', { exact: true }).fill('甲\n乙');
      });
      await addField(target, { displayName: '金额', name: 'amount', type: '数值' }, async () => {
        await target.getByLabel('下限', { exact: true }).fill('0.5');
        await target.getByLabel('上限', { exact: true }).fill('100');
      });
      await addField(target, { displayName: '日期', name: 'day', type: '日期' });
      await addField(target, { displayName: '时刻', name: 'at', type: '时刻' });
      await addField(target, { displayName: '时间', name: 'moment', type: '时间' });
      await addField(target, { displayName: '启用', name: 'enabled', type: '布尔' });
      await addField(target, { displayName: '照片', name: 'photo', type: '图片' }, () => target.getByLabel('网址', { exact: true }).uncheck());
      await addField(target, { displayName: '标签', name: 'tags', type: '列表' }, async () => {
        await target.getByLabel('最多项数', { exact: true }).fill('3');
        await target.getByLabel('元素最长（字）', { exact: true }).fill('4');
      });
      await addField(target, { displayName: '站点', name: 'stops', type: '列表' }, async () => {
        await target.getByLabel('元素类型', { exact: true }).selectOption({ label: '数据定义引用' });
        await target.getByLabel('元素引用的数据定义', { exact: true }).selectOption({ value: '停靠站点@1' });
      });
      await addField(target, { displayName: '下一站', name: 'next', type: '数据定义引用' }, async () => { await target.getByLabel('引用的数据定义', { exact: true }).selectOption({ value: '停靠站点@1' }); });
      expect(await fieldRow(target, 'photo').getByTestId('field-constraints').textContent()).toBe('资源仓库');
      expect(await fieldRow(target, 'tags').getByTestId('field-type').textContent()).toBe('列表 · 文本');
      expect(await fieldRow(target, 'tags').getByTestId('field-constraints').textContent()).toBe('最多 3 项，最多 4 字');
      expect(await fieldRow(target, 'next').getByTestId('field-type').textContent()).toBe('数据定义引用 · 停靠站点 v1');

      // 名称写错的字段：问题定位到那一行，没写完也能存。
      await addField(target, { displayName: '写错的', name: '1bad', type: '文本' });
      await fieldRow(target, '1bad').getByTestId('field-problems').filter({ hasText: '字段名称必须以英文字母开头' }).waitFor();
      await target.getByTestId('check-status').filter({ hasText: '严重问题' }).waitFor();
      await openField(target, '1bad');
      await target.getByRole('button', { name: '删除字段' }).click();
      await target.getByTestId('remove-impact').filter({ hasText: '还没发布过' }).waitFor();
      await target.getByRole('button', { name: '确认删除字段' }).click();
      await fieldRow(target, '1bad').waitFor({ state: 'detached' });
      await checkPassed(target);

      const document = JSON.parse((await adminApi('GET', `/v1/definitions/${path}/draft`)).body.content);
      expect(document.fields.map((field: any) => field.type)).toEqual(['text', 'number', 'date', 'time', 'datetime', 'boolean', 'image', 'list', 'list', 'ref']);
      expect(document.fields[0].constraints).toEqual({ required: true, minLength: 1, maxLength: 20, enum: ['甲', '乙'] });
      expect(document.fields[1].constraints).toEqual({ min: 0.5, max: 100 });
      expect(document.fields[6].constraints).toEqual({ allowedSources: ['resource'] });
      expect(document.fields[7]).toMatchObject({ items: { type: 'text', constraints: { maxLength: 4 } }, constraints: { maxItems: 3 } });
      expect(document.fields[8].items).toEqual({ type: 'ref', ref: { name: '停靠站点', version: 1 } });
      expect(document.fields[9].ref).toEqual({ name: '停靠站点', version: 1 });

      // 上移一行：顺序写进草案。
      await openField(target, 'enabled');
      await target.getByRole('button', { name: '上移' }).click();
      await expect.poll(async () => JSON.parse((await adminApi('GET', `/v1/definitions/${path}/draft`)).body.content).fields[4].name).toBe('enabled');
      await target.getByRole('button', { name: '取消改动' }).click();
      await checkPassed(target);

      // 别人先保存了：这次改动没有写入，读回最新内容再改。
      const current = (await adminApi('GET', `/v1/definitions/${path}/draft`)).body;
      const other = await world.call('PUT', `/v1/definitions/${path}/draft?expectedSha256=${current.sha256}`, world.b.admin.token, current.content.replace('"九种字段"', '"九种字段（别人改的）"'), { 'content-type': 'application/json' });
      expect(other.status, other.raw.slice(0, 300)).toBe(200);
      await openField(target, 'day');
      await target.getByLabel('说明', { exact: true }).fill('不会写入');
      await target.getByRole('button', { name: '保存字段' }).click();
      await target.getByRole('alert').filter({ hasText: '别人刚保存过这份草案' }).waitFor();
      expect((await adminApi('GET', `/v1/definitions/${path}/draft`)).body.sha256).toBe(other.body.sha256);
      await target.getByRole('button', { name: '读回最新内容' }).click();
      await target.getByRole('heading', { name: '九种字段（别人改的）', level: 1 }).waitFor();
      expect(await target.getByRole('alert').count()).toBe(0);
      await checkPassed(target);

      // 首个版本：没有数据集与模板，发布记录写首个版本；发布的产物能再被开放 API 读出。
      await target.getByRole('button', { name: '发布为 v1' }).click();
      await target.getByTestId('dataset-impact').filter({ hasText: '这是首个版本' }).waitFor();
      await target.getByTestId('template-impact').filter({ hasText: '还没有模板用这个数据定义' }).waitFor();
      await target.getByRole('button', { name: '发布为 v1' }).click();
      await publicationRow(target, name, 1).getByTestId('publication-summary').filter({ hasText: '首个版本，10 个字段' }).waitFor();
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/1`)).status).toBe(200);

      // 草案可以删除；已发布的版本不受影响。
      await adminApi('POST', `/v1/definitions/${path}/draft`, { fromVersion: 1 });
      await target.goto(`${baseUrl}/console/#/definitions/${path}`);
      await target.getByTestId('definition-meta').filter({ hasText: '基于 v1' }).waitFor();
      await target.getByRole('button', { name: '删除草案' }).click();
      await target.getByRole('button', { name: '确认删除草案' }).click();
      await target.getByTestId('definition-meta').filter({ hasText: 'v1 · 当前版本' }).waitFor();
      expect((await adminApi('GET', `/v1/definitions/${path}/draft`)).status).toBe(404);
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/1`)).status).toBe(200);
    });

    it('数据定义（P1 票据 06）：客户操作员只读，看得到版本、草案与发布记录，没有任何写入口；直接调用写接口被拒绝', async () => {
      const name = '线路牌', path = enc(name), drafted = (await adminApi('POST', `/v1/definitions/${path}/draft`, { fromVersion: 3 })).body;
      await page.goto(`${baseUrl}/console/#/definitions`);
      const row = definitionRow(page, name);
      await row.getByTestId('definition-status').filter({ hasText: '有草案' }).waitFor();
      expect(await page.getByRole('button', { name: '新建数据定义' }).count()).toBe(0);
      await row.getByTestId('definition-uses').click({ button: 'right' });
      expect(await menuLabels(page)).toEqual(['打开', '在新标签页打开', '查看发布记录', '导出编译产物 JSON Schema', '复制引用']);
      await page.keyboard.press('Escape');
      expect(await page.getByRole('menu').count()).toBe(0);

      // 草案：字段表与校验结果都看得到，展开是只读的。
      await row.getByRole('link').click();
      await page.getByTestId('definition-meta').filter({ hasText: '基于 v3' }).waitFor();
      await page.getByRole('note').filter({ hasText: '改动与发布由客户管理员完成' }).waitFor();
      await checkPassed(page);
      await openField(page, 'routeNo');
      await page.getByTestId('field-used-by').filter({ hasText: ROUTE }).waitFor();
      expect(await page.getByTestId('field-detail').locator('input, select, textarea').count()).toBe(0);
      for (const label of ['添加字段', '删除草案', '改显示名称与说明', '保存字段', '删除字段']) expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
      expect(await page.getByRole('button', { name: /^发布/ }).count()).toBe(0);
      await page.getByRole('button', { name: '预览编译产物' }).click();
      await page.getByTestId('compiled-preview').waitFor();
      // 已发布的版本也一样；没有另起草案的入口。
      await page.getByLabel('查看的版本').selectOption('1');
      await page.getByTestId('definition-meta').filter({ hasText: 'v1' }).waitFor();
      expect(await page.getByRole('button', { name: /另起草案/ }).count()).toBe(0);
      // 发布这一步：只说明由谁来做，不发预检。
      await page.goto(`${baseUrl}/console/#/definitions/${path}/publish`);
      await page.getByText('发布由客户管理员完成').waitFor();
      expect(await page.getByRole('button', { name: /^发布/ }).count()).toBe(0);

      // 发布记录：谁、改动摘要与哈希都看得到，没有另发。
      await page.goto(`${baseUrl}/console/#/definition-publications`);
      const v2 = publicationRow(page, name, 2);
      await v2.getByTestId('publication-actor').filter({ hasText: world.b.admin.email }).waitFor();
      await page.locator(`[data-testid="draft-row"][data-name="${name}"]`).waitFor();
      await publicationRow(page, name, 1).getByRole('button').first().click();
      await page.getByTestId('publication-detail').locator('[data-sha256]').first().waitFor();
      expect(await page.getByRole('button', { name: /另发/ }).count()).toBe(0);

      // 权限以开放 API 为准。
      const operator = world.b.operator.token;
      expect((await world.call('POST', `/v1/definitions/${enc('新的')}/draft`, operator, { displayName: '新的' })).status).toBe(403);
      expect((await world.call('POST', `/v1/definitions/${path}/draft/publish`, operator, { expectedSha256: drafted.sha256 })).status).toBe(403);
      expect((await world.call('DELETE', `/v1/definitions/${path}/draft`, world.b.admin.token)).status).toBe(204);
    });

    it('打开绑定的字段（P1 票据 08、13）：地址带 field 时，详情页展开那一行，已发布的版本与草案都一样', async () => {
      const target = await asAdmin(), name = '胸牌', path = enc(name);
      const expanded = async () => {
        await target.goto(`${baseUrl}/console/#/definitions/${path}?field=fullName`);
        await target.reload();
        await target.getByTestId('field-detail').waitFor();
        expect(await fieldRow(target, 'fullName').getByRole('button').first().getAttribute('aria-expanded')).toBe('true');
      };
      await expanded();
      expect((await adminApi('POST', `/v1/definitions/${path}/draft`, { fromVersion: 1 })).status).toBe(201);
      await expanded();
      expect((await world.call('DELETE', `/v1/definitions/${path}/draft`, world.b.admin.token)).status).toBe(204);
    });

    /** 代建工程师经开放 API：从这个名称的最新版本另起草案，加一个字段，发布。开着审批策略时答 202。 */
    const engineerPublish = async (name: string, field: string) => {
      const url = `/v1/authoring/tenants/${world.b.id}/definitions/${enc(name)}/draft`, token = world.b.engineer.token;
      const versions = ((await adminApi('GET', '/v1/definitions')).body.definitions as any[]).find((item) => item.name === name).versions as { version: number }[];
      const draft = await world.call('GET', url, token);
      const opened = draft.status === 200 ? draft : await world.call('POST', url, token, { fromVersion: versions.at(-1)!.version });
      expect([200, 201], opened.raw.slice(0, 300)).toContain(opened.status);
      const content = draft.status === 200 ? draft.body.content as string : (await world.call('GET', url, token)).body.content as string, document = JSON.parse(content);
      document.fields.push({ name: field, displayName: `字段 ${field}`, type: 'text' });
      const saved = await world.call('PUT', `${url}?expectedSha256=${opened.body.sha256}`, token, `${JSON.stringify(document, null, 2)}\n`, { 'content-type': 'application/json' });
      expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
      const requested = await world.call('POST', `${url}/publish`, token, { expectedSha256: saved.body.sha256 });
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      return requested.body.request as { id: string; version: number };
    };
    const requestRow = (target: Page, id: string) => target.locator(`[data-testid="request-row"][data-id="${id}"]`);

    it('审批（P1 票据 11）：管理页打开开关；代建工程师的发布成为申请；发布记录页上退回要留言，批准后生效；操作员只读', async () => {
      const target = await asAdmin(), name = '线路牌';
      await (await nav(target, '管理')).click();
      await target.getByRole('tab', { name: '审批策略' }).click();
      const policy = target.getByTestId('approval-policy');
      expect(await policy.getByTestId('approval-note').textContent()).toContain('缺省直发；有严重问题的成果任何人都不能批准');
      const definitions = policy.locator('[data-scope="definitions"]').getByRole('checkbox');
      expect(await definitions.isChecked()).toBe(false);
      await definitions.check();
      await policy.locator('[data-scope="definitions"]').filter({ hasText: world.b.admin.email }).waitFor();
      expect((await adminApi('GET', '/v1/approval-policy')).body.definitions).toMatchObject({ required: true, updatedBy: world.b.admin.email });

      // 退回：没写留言不能确认；退回后这一份不再显示，代建工程师看得到留言。
      const first = await engineerPublish(name, 'approvalOne');
      await (await nav(target, '数据定义')).click();
      await target.getByRole('link', { name: '发布记录' }).click();
      const row = requestRow(target, first.id);
      await row.getByRole('button').click();
      const detail = target.getByTestId('request-detail');
      await detail.getByTestId('definition-diff').locator('[data-path="approvalOne"][data-change="added"]').waitFor();
      await detail.getByRole('button', { name: '退回' }).click();
      const confirm = detail.getByRole('button', { name: '确认退回' });
      expect(await confirm.isDisabled()).toBe(true);
      await detail.getByLabel('退回的留言').fill('字段说明写清楚再发');
      await confirm.click();
      await target.getByTestId('request-notice').filter({ hasText: '已退回' }).waitFor();
      await row.waitFor({ state: 'detached' });
      expect((await world.call('GET', `/v1/authoring/tenants/${world.b.id}/publish-requests/${first.id}`, world.b.engineer.token)).body).toMatchObject({ status: 'rejected', message: '字段说明写清楚再发', decidedBy: world.b.admin.email });

      // 操作员看得到待批准的申请，没有批准与退回。
      const second = await engineerPublish(name, 'approvalTwo');
      await page.goto(`${baseUrl}/console/#/definition-publications`);
      await page.reload();
      const seen = requestRow(page, second.id);
      await seen.getByRole('button').click();
      await page.getByTestId('request-detail').getByText('发布申请由客户管理员处理').waitFor();
      expect(await page.getByRole('button', { name: '批准' }).count() + await page.getByRole('button', { name: '退回' }).count()).toBe(0);

      // 批准：生效之后新版本出现在发布记录里，主体是批准的人。
      await target.reload();
      await requestRow(target, second.id).getByRole('button').click();
      await target.getByTestId('request-detail').getByRole('button', { name: '批准' }).click();
      await target.getByTestId('request-notice').filter({ hasText: '已批准并生效' }).waitFor();
      const published = publicationRow(target, name, second.version);
      await published.waitFor();
      expect(await published.getByTestId('publication-actor').textContent()).toBe(world.b.admin.email);
      expect((await adminApi('GET', `/v1/publish-requests/${second.id}`)).body).toMatchObject({ status: 'approved', decidedBy: world.b.admin.email });
      expect((await adminApi('GET', `/v1/static-schemas/${enc(name)}/versions/${second.version}`)).status).toBe(200);

      expect((await world.call('PUT', '/v1/approval-policy', world.b.admin.token, { definitions: false })).status).toBe(200);
    });

    /** 代建工程师经开放 API：改模板的第一个颜色，保存。开着审批策略时答 202。 */
    const engineerSave = async (name: string, color: string) => {
      const url = `/v1/authoring/tenants/${world.b.id}/templates/${enc(name)}/working-copy`, token = world.b.engineer.token;
      const existing = await world.call('GET', url, token);
      const opened = existing.status === 200 ? existing : await world.call('POST', url, token);
      const content = (await world.call('GET', url, token)).body.content as string;
      const stashed = await world.call('PUT', `${url}?expectedSha256=${opened.body.sha256}`, token, content.replace(/"#[0-9A-Fa-f]{6}"/, `"${color}"`), { 'content-type': 'application/json' });
      expect(stashed.status, stashed.raw.slice(0, 300)).toBe(200);
      const requested = await world.call('POST', `${url}/save`, token, { expectedSha256: stashed.body.sha256 });
      expect(requested.status, requested.raw.slice(0, 300)).toBe(202);
      return requested.body.request as { id: string; baseRevision: number };
    };

    it('审批（P1 票据 11）：发布模板修订页上批准代建工程师的保存；基准变了的申请不能批准，只能标为过期', async () => {
      const target = await asAdmin(), name = '道路段', path = enc(name);
      expect((await world.call('PUT', '/v1/approval-policy', world.b.admin.token, { templates: true })).status).toBe(200);
      const revisionsApi = async () => (await adminApi('GET', `/v1/templates/${path}/revisions`)).body;
      const before = await revisionsApi();
      const first = await engineerSave(name, '#123456');
      await target.goto(`${baseUrl}/console/#/templates/${path}/publish`);
      await target.reload();

      const row = requestRow(target, first.id);
      await row.getByRole('button').click();
      const detail = target.getByTestId('request-detail');
      await detail.locator('.change').first().waitFor();
      expect((await revisionsApi()).currentRevision, '申请不改当前修订').toBe(before.currentRevision);
      await detail.getByRole('button', { name: '批准' }).click();
      await target.getByTestId('request-notice').filter({ hasText: '已批准并生效' }).waitFor();
      await target.getByTestId('current-revision').filter({ hasText: String(before.currentRevision + 1) }).waitFor();
      const after = await revisionsApi();
      expect(after.currentRevision).toBe(before.currentRevision + 1);
      expect(after.current).toMatchObject({ source: 'web', action: 'revision', by: world.b.admin.email });
      expect(after.revisions.at(-1)).toMatchObject({ source: 'web' });
      expect(after.revisions.at(-1).pushedBy).not.toBe(world.b.admin.email);

      // 申请之后当前修订变了：页面说明原因，不给批准，只能标为过期。
      const second = await engineerSave(name, '#654321');
      expect((await adminApi('POST', '/v1/template-current', { template: name, revision: before.currentRevision })).status).toBe(200);
      await target.reload();
      await requestRow(target, second.id).getByRole('button').click();
      await detail.getByTestId('request-stale').filter({ hasText: `当前修订已不是申请时的 ${second.baseRevision}` }).waitFor();
      expect(await detail.getByRole('button', { name: '批准' }).count()).toBe(0);
      await detail.getByRole('button', { name: '标为过期' }).click();
      await target.getByTestId('request-notice').filter({ hasText: '已标为过期' }).waitFor();
      await requestRow(target, second.id).waitFor({ state: 'detached' });
      expect((await adminApi('GET', `/v1/publish-requests/${second.id}`)).body).toMatchObject({ status: 'expired', decidedBy: world.b.admin.email });

      expect((await world.call('PUT', '/v1/approval-policy', world.b.admin.token, { templates: false })).status).toBe(200);
      expect((await world.call('DELETE', `/v1/authoring/tenants/${world.b.id}/templates/${path}/working-copy`, world.b.engineer.token)).status).toBe(204);
    });

    it('平台管理（P1 票据 12）：只进平台；看服务健康；开通租户 → 设套餐 → 建客户管理员，初始密码只显示一次；签发与吊销代建令牌', async () => {
      const platformContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      platformContext.setDefaultTimeout(30_000);
      const target = await platformContext.newPage();
      watch(target);
      await target.goto(`${baseUrl}/console/#/datasets`);
      await target.getByLabel('邮箱').fill(world.platformLogin.email);
      await target.getByLabel('密码').fill(world.platformLogin.password);
      await target.getByRole('button', { name: '登录' }).click();
      // 租户成员的旧链接也回到平台：没有租户内的模块，状态栏只有连接。
      await target.getByRole('heading', { name: '租户', level: 1 }).waitFor();
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe('#/platform');
      await target.getByRole('button', { name: '切换模块' }).click();
      expect(await target.getByRole('menu', { name: '模块' }).getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('.menu-label')!.textContent))).toEqual(['平台']);
      await target.keyboard.press('Escape');
      expect(await target.getByTestId('quota').count()).toBe(0);
      expect(await target.getByTestId('tenant').count()).toBe(0);
      await target.getByTestId('connection').filter({ hasText: '已连接' }).waitFor();
      await target.getByTestId('service-health').filter({ hasText: '接口 就绪' }).waitFor();
      await target.getByTestId('health-workers').waitFor();
      await target.getByTestId('health-queue').waitFor();
      await target.getByText('你对客户租户的每次操作都记进该租户的审计').waitFor();
      // 环境里已有的租户在列，没设够额度的显示套餐与本月出图。
      await target.getByTestId('tenant-row').first().waitFor();

      // 开通租户：开通后原地展开，还没设套餐。
      const tenantName = `平台用例 ${randomUUID().slice(0, 8)}`;
      await target.getByRole('button', { name: '开通租户' }).click();
      await target.getByLabel('租户名称').fill(tenantName);
      await target.getByRole('button', { name: '开通', exact: true }).click();
      const row = target.locator(`[data-testid="tenant-row"][data-name="${tenantName}"]`);
      await row.getByTestId('tenant-status').filter({ hasText: '未设套餐' }).waitFor();
      const detail = target.getByTestId('tenant-detail');
      await detail.waitFor();

      // 设套餐：回答与开放 API 相同，表格随之更新。
      await detail.getByLabel('每月出图（张）').fill('500');
      await detail.getByLabel('单张最大像素（MP）').fill('40');
      await detail.getByLabel('并发').fill('3');
      await detail.getByRole('button', { name: '保存套餐' }).click();
      await row.getByTestId('tenant-images').filter({ hasText: '0 / 500' }).waitFor();
      await row.getByTestId('tenant-status').filter({ hasText: '正常' }).waitFor();
      const platformToken = await world.login(world.platformLogin.email, world.platformLogin.password);
      const created = ((await server('GET', '/v1/platform/tenants', platformToken)).body.tenants as { id: string; name: string }[]).find((tenant) => tenant.name === tenantName)!;
      expect((await server('GET', `/v1/platform/tenants/${created.id}/plan`, platformToken)).body).toEqual({ monthlyImages: 500, maxPixels: 40_000_000, concurrency: 3 });

      // 建客户管理员：初始密码只显示一次，用它能登录，关掉之后页面上再也没有。
      const email = `platform-${randomUUID()}@example.test`;
      await target.getByTestId('tenant-detail').getByLabel('成员邮箱').fill(email);
      await target.getByTestId('tenant-detail').getByLabel('角色').selectOption('admin');
      await target.getByRole('button', { name: '创建账号' }).click();
      const secret = target.getByTestId('one-time-secret');
      const password = (await secret.textContent())!;
      expect(password.length).toBeGreaterThan(8);
      await row.getByTestId('tenant-members').filter({ hasText: '1' }).waitFor();
      await target.getByRole('button', { name: '我已保存，关闭' }).click();
      expect(await secret.count()).toBe(0);
      expect(await target.content()).not.toContain(password);
      const login = await server('POST', '/v1/sessions', '', { email, password });
      expect(login.status).toBe(201);
      expect(login.body.identity).toMatchObject({ kind: 'member', role: 'admin', tenantId: created.id });
      // 新的客户管理员在审计里看得到平台管理员的每一步，都标为跨租户。
      const audit = (await server('GET', '/v1/audit-events?limit=500', login.body.token)).body.events as { action: string; crossTenant: boolean; actor: { kind: string } }[];
      for (const action of ['tenant.create', 'plan.update', 'member.create', 'overview.read']) {
        expect(audit.find((event) => event.action === action), action).toMatchObject({ crossTenant: true, actor: { kind: 'platformUser' } });
      }

      // 代建令牌：Ctrl+K 的动作直接到签发；令牌只显示一次，能访问被指定的租户；吊销后失效。
      await target.keyboard.press('Control+k');
      await target.getByRole('combobox', { name: '筛选模块与动作' }).fill('签发');
      await target.keyboard.press('Enter');
      await target.getByRole('heading', { name: '代建令牌', level: 1 }).waitFor();
      await expect.poll(() => target.getByLabel('标签').evaluate((element) => element === element.ownerDocument.activeElement)).toBe(true);
      const label = `平台用例令牌 ${randomUUID().slice(0, 8)}`;
      await target.getByLabel('标签').fill(label);
      expect(await target.getByRole('button', { name: '签发', exact: true }).isDisabled(), '没选租户不能签发').toBe(true);
      await target.getByRole('checkbox', { name: tenantName }).check();
      await target.getByRole('button', { name: '签发', exact: true }).click();
      const issued = (await target.getByTestId('one-time-secret').textContent())!;
      world.secrets.push(issued, password);
      expect(issued.startsWith('rwa_')).toBe(true);
      expect((await server('GET', `/v1/authoring/tenants/${created.id}`, issued)).status).toBe(200);
      await target.getByRole('button', { name: '我已保存，关闭' }).click();
      const tokenRow = target.locator(`[data-testid="token-row"][data-label="${label}"]`);
      await tokenRow.getByTestId('token-state').filter({ hasText: '有效' }).waitFor();
      expect(await tokenRow.textContent()).toContain(tenantName);
      await tokenRow.getByRole('button', { name: '吊销' }).click();
      await tokenRow.getByRole('button', { name: '确认吊销' }).click();
      await tokenRow.getByTestId('token-state').filter({ hasText: '已吊销' }).waitFor();
      expect((await server('GET', `/v1/authoring/tenants/${created.id}`, issued)).status).toBe(401);
      await platformContext.close();
    });

    /** 经浏览器打开的接口进程读写工作副本：内容用 mutate 改好后整份暂存，回答新的内容哈希。 */
    const stash = async (name: string, mutate: (document: Record<string, unknown>) => void) => {
      const url = `/v1/templates/${enc(name)}/working-copy`, token = world.b.admin.token;
      let copy = await server('GET', url, token);
      if (copy.status === 404) {
        expect((await server('POST', url, token)).status).toBe(201);
        copy = await server('GET', url, token);
      }
      const document = JSON.parse(copy.body.content) as Record<string, unknown>;
      mutate(document);
      const saved = await server('PUT', `${url}?expectedSha256=${copy.body.sha256 as string}`, token, document);
      expect(saved.status, saved.raw.slice(0, 300)).toBe(200);
      return saved.body.sha256 as string;
    };
    /** 按路径找元素：path 不带模板名。 */
    const elementAt = (document: Record<string, unknown>, ...path: string[]) => {
      let node = document['artboard'] as Record<string, unknown>;
      for (const name of path) node = (node['children'] as Record<string, unknown>[]).find((child) => child['name'] === name)!;
      return node;
    };
    const revisionsOf = async (name: string) => (await server('GET', `/v1/templates/${enc(name)}/revisions`, world.b.admin.token)).body as {
      currentRevision: number; current: { source: string; action: string }; revisions: { revision: number; source: string; pushedBy: string; sha256: string }[];
    };
    const auditOf = async (action: string) => ((await server('GET', '/v1/audit-events?limit=500', world.b.admin.token)).body.events as
      { action: string; actor: { label: string }; object: { id: string }; beforeSha256?: string; afterSha256?: string }[]).filter((event) => event.action === action);

    it('发布模板修订（P1 票据 09）：改字号 → 看差异与对比 → 保存 → 指回上一修订；基准已变时看两边差异，明确选择覆盖才保存；操作员只读', async () => {
      const target = await asAdmin();
      const open = (hash: string) => target.goto(`${baseUrl}/console/${hash}`);
      const worked = () => target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true'), { timeout: 60_000 });
      const before = await revisionsOf(BADGE), first = before.currentRevision;

      // 改字号：工作副本改了一处属性、加了一个、删了一个。没有工作副本之前，这一页只有修订历史。
      await open(`#/templates/${enc(BADGE)}/publish`);
      await target.getByRole('heading', { name: '修订历史', level: 1 }).waitFor();
      expect(await target.getByRole('button', { name: /发布为修订/ }).count()).toBe(0);
      await stash(BADGE, (document) => {
        const unit = elementAt(document, '单位');
        unit['fontSize'] = 6.5;
        unit['letterSpacing'] = 0.1;
        delete unit['color'];
      });

      // 看差异：按元素路径列出，标出修改、新增与删除的属性。
      const compared = worked();
      await target.reload();
      await target.getByRole('heading', { name: `发布修订 ${first + 1}`, level: 1 }).waitFor();
      await compared;
      const change = target.locator(`[data-testid="change"][data-path="${BADGE}/单位"]`);
      await change.waitFor();
      expect(await change.getAttribute('data-change')).toBe('changed');
      expect(await target.getByTestId('changes-summary').textContent()).toBe('1 个元素');
      const property = (key: string) => change.locator(`[data-testid="change-property"][data-key="${key}"]`);
      expect(await property('fontSize').getAttribute('data-change')).toBe('changed');
      expect(await property('fontSize').textContent()).toMatch(/fontSize修改4→6\.5/);
      expect(await property('letterSpacing').getAttribute('data-change')).toBe('added');
      expect(await property('color').getAttribute('data-change')).toBe('removed');

      // 看对比：同一份样例数据集各渲染一张，图不同；换样例数据集两边一起换。
      const imageOf = (side: string) => target.getByTestId(side).getByRole('img');
      await imageOf('compare-current').waitFor();
      await imageOf('compare-working-copy').waitFor();
      await expect.poll(async () => (await imageOf('compare-working-copy').getAttribute('src')) !== (await imageOf('compare-current').getAttribute('src'))).toBe(true);
      const previews: { url: string; dataset: unknown }[] = [];
      const seen = (request: { url(): string; method(): string; postDataJSON(): { dataset: unknown } }) => {
        if (request.method() === 'POST' && request.url().includes('/v1/previews')) previews.push({ url: request.url(), dataset: request.postDataJSON().dataset });
      };
      target.on('request', seen);
      const blank = worked();
      await target.getByLabel('样例数据集').selectOption({ label: '空白数据（显示占位）' });
      await blank;
      await expect.poll(() => previews.length).toBe(2);
      target.off('request', seen);
      expect(previews[0]!.dataset).toEqual(previews[1]!.dataset);
      expect(previews.map((entry) => entry.url.endsWith('?workingCopies=true')).sort()).toEqual([false, true]);
      expect(previews[0]!.dataset).toHaveProperty('inline');

      // 保存：记新修订（来源网页），工作副本删除，提示写明审计记下了什么；审计确有前后内容哈希。
      const beforeSha = before.revisions.find((entry) => entry.revision === first)!.sha256;
      await target.getByRole('button', { name: `发布为修订 ${first + 1}` }).click();
      await target.getByRole('status').filter({ hasText: `已保存为修订 ${first + 1}` }).filter({ hasText: '审计已记下主体与前后内容哈希' }).waitFor();
      const saved = await revisionsOf(BADGE);
      expect(saved.currentRevision).toBe(first + 1);
      expect(saved.revisions.at(-1)).toMatchObject({ revision: first + 1, source: 'web', pushedBy: world.b.admin.email });
      expect((await server('GET', `/v1/templates/${enc(BADGE)}/working-copy`, world.b.admin.token)).status).toBe(404);
      expect((await auditOf('template.save')).at(0)).toMatchObject({ actor: { label: world.b.admin.email }, object: { id: BADGE }, beforeSha256: beforeSha, afterSha256: saved.revisions.at(-1)!.sha256 });

      // 修订历史：修订号、主体、时间、来源；指回前确认，指回后当前修订变了，审计同样记下。
      const row = (revision: number) => target.locator(`[data-testid="revision-row"][data-revision="${revision}"]`);
      await target.getByRole('heading', { name: '修订历史', level: 1 }).waitFor();
      await row(first + 1).filter({ hasText: '网页' }).filter({ hasText: world.b.admin.email }).waitFor();
      expect(await row(first + 1).getAttribute('data-current')).toBe('true');
      expect(await row(first + 1).getByRole('button', { name: '指回' }).count(), '当前修订不用指回').toBe(0);
      await row(first).getByRole('button', { name: '指回' }).click();
      expect((await revisionsOf(BADGE)).currentRevision, '确认之前不动').toBe(first + 1);
      await row(first).getByRole('button', { name: '确认指回' }).click();
      await target.getByRole('status').filter({ hasText: `当前修订已指回修订 ${first}` }).filter({ hasText: '审计已记下主体与前后内容哈希' }).waitFor();
      expect(await revisionsOf(BADGE)).toMatchObject({ currentRevision: first, current: { source: 'web', action: 'setCurrent' } });
      expect((await auditOf('template.setCurrent')).at(0)).toMatchObject({ actor: { label: world.b.admin.email }, beforeSha256: saved.revisions.at(-1)!.sha256, afterSha256: beforeSha });
      await expect.poll(() => row(first).getAttribute('data-current')).toBe('true');

      // 基准已变：工作副本基于修订 first，别人又把当前修订指向 first + 1。两边差异都摆出来，勾选之后才能覆盖。
      const sha256 = await stash(BADGE, (document) => { elementAt(document, '身份')['fontSize'] = 5.5; });
      expect((await server('POST', '/v1/template-current', world.b.admin.token, { template: BADGE, revision: first + 1 })).status).toBe(200);
      await target.reload();
      const conflict = target.getByTestId('revision-conflict');
      await conflict.waitFor();
      expect(await target.getByRole('button', { name: /发布为修订/ }).count(), '有冲突时没有普通的发布按钮').toBe(0);
      await conflict.getByTestId('conflict-ours').locator(`[data-testid="change"][data-path="${BADGE}/身份"]`).waitFor();
      await conflict.getByTestId('conflict-theirs').locator(`[data-testid="change"][data-path="${BADGE}/单位"]`).waitFor();
      const overwrite = conflict.getByRole('button', { name: '覆盖并发布' });
      expect(await overwrite.isDisabled()).toBe(true);
      expect((await server('POST', `/v1/templates/${enc(BADGE)}/working-copy/save`, world.b.admin.token, { expectedSha256: sha256 })).status, '不带覆盖答 409').toBe(409);
      await conflict.getByRole('checkbox').check();
      await overwrite.click();
      await target.getByRole('status').filter({ hasText: `已保存为修订 ${first + 2}` }).waitFor();
      expect((await revisionsOf(BADGE)).currentRevision).toBe(first + 2);

      // 操作员只读：看得到修订历史，没有指回、设计与发布。
      const reader = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      reader.setDefaultTimeout(30_000);
      const operator = await reader.newPage();
      watch(operator);
      await operator.goto(`${baseUrl}/console/#/templates/${enc(BADGE)}/publish`);
      await operator.getByLabel('邮箱').fill(world.b.operator.email);
      await operator.getByLabel('密码').fill(world.b.operator.password);
      await operator.getByRole('button', { name: '登录' }).click();
      await operator.locator(`[data-testid="revision-row"][data-revision="${first + 2}"]`).waitFor();
      expect(await operator.getByRole('button', { name: '指回' }).count()).toBe(0);
      expect(await operator.getByRole('link', { name: '打开设计' }).count()).toBe(0);
      await reader.close();

      // 指回最初的修订，别的用例看到的还是原样。
      expect((await server('POST', '/v1/template-current', world.b.admin.token, { template: BADGE, revision: first })).status).toBe(200);
    });

    it('模板设计（P1 票据 08）：点选元素，每种元素改一项属性，写回后通过 checkDslDocument、预览随之变化；撤销、重做、保存；参数、结构、规则；工具栏与右键菜单', async () => {
      const ALL = '全元素牌', at = (name: string) => `${ALL}/${name}`;
      const target = await asAdmin(), token = world.b.admin.token;
      const copyUrl = `/v1/templates/${enc(ALL)}/working-copy`;
      interface Reply { layout: { output: { width: number; height: number }; root: { path: string; x: number; y: number; width: number; height: number; children?: Reply['layout']['root'][] } } }
      /** 等一次工作副本预览；有上一次改动的预览还在路上时，只等请求内容对得上的。 */
      const worked = (match: (body: { template: string; dataset: { id?: string; inline?: unknown } }) => boolean = () => true) => target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.request().method() === 'POST' && response.status() === 200
        && match(response.request().postDataJSON() as never), { timeout: 60_000 });
      /** 等这次改动的预览：先等写回工作副本，再等写回之后发出的那一次预览。 */
      const afterStash = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 })
        .then(() => target.waitForRequest((request) => request.url().endsWith('/v1/previews?workingCopies=true') && request.method() === 'POST', { timeout: 60_000 }))
        .then(async (request) => (await request.response())!);
      const image = () => target.getByTestId('preview-image');
      const inspector = () => target.getByRole('complementary', { name: '检查器' });
      const fieldOf = (key: string) => inspector().locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const input = (key: string) => fieldOf(key).locator('input[type="text"]').first();
      /** 没写的属性收在"其他 N 项"里，展开它们才找得到。 */
      const expand = () => inspector().locator('details:not([open]) > summary').evaluateAll((items) => items.forEach((item) => (item as unknown as { click(): void }).click()));
      const documentNow = async (name = ALL) => JSON.parse((await server('GET', `/v1/templates/${enc(name)}/working-copy`, token)).body.content as string) as Record<string, unknown>;
      /** 做一次改动：等预览回来、图变了，再读工作副本，核对 checkDslDocument 没有严重问题。 */
      const edit = async (action: () => Promise<unknown>, name = ALL) => {
        const before = await image().getAttribute('src');
        const preview = afterStash();
        await action();
        const reply = await (await preview).json() as Reply;
        await expect.poll(() => image().getAttribute('src'), { message: '预览随之变化' }).not.toBe(before);
        const document = await documentNow(name);
        expect(checkDslDocument(document).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
        return { document, reply };
      };

      // 压测数据是名字里写了压测的数据集，工具栏单独列一组。
      expect((await server('POST', `/v1/datasets/badge-zhang/copies`, token, { id: 'badge-stress', name: '压测：长姓名' })).status).toBe(201);

      // 从模板列表进设计页：打开就有草稿预览，操作员看不到这个入口（下面单独核对）。
      await (await nav(target, '模板')).click();
      const first = worked((body) => body.template === ALL);
      await target.getByRole('article', { name: `模板 ${ALL}` }).getByRole('link', { name: '设计' }).click();
      let layout = (await (await first).json() as Reply).layout;
      await image().waitFor();
      expect(await target.getByRole('button', { name: /让 Agent|留评论/ }).count(), 'P2、P4 接入前不显示').toBe(0);

      /** 按布局摘要的元素框点在元素中央。 */
      const nodeOf = (path: string) => {
        const walk = (node: Reply['layout']['root']): Reply['layout']['root'] | undefined => (node.path === path ? node : node.children?.map(walk).find(Boolean));
        return walk(layout.root)!;
      };
      const positionOf = async (path: string) => {
        const box = (await target.getByTestId('design-canvas').boundingBox())!, node = nodeOf(path);
        return { x: ((node.x + node.width / 2) / layout.output.width) * box.width, y: ((node.y + node.height / 2) / layout.output.height) * box.height };
      };
      const clickElement = async (path: string) => {
        await target.getByTestId('design-canvas').click({ position: await positionOf(path) });
        await inspector().locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
        await expand();
      };
      const chooseRow = async (path: string) => {
        await inspector().getByRole('tab', { name: '结构' }).click();
        await inspector().locator(`[data-testid="structure-row"][data-path="${path}"]`).getByRole('button').first().click();
        await inspector().getByRole('tab', { name: '属性' }).click();
        await inspector().locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
        await expand();
      };

      // 点选：选中框与元素路径显示在图上，属性面板打开它在模板文档里的位置。
      await clickElement(at('文字'));
      expect(await target.getByTestId('select-box').getAttribute('data-path')).toBe(at('文字'));
      expect(await target.getByTestId('select-tag').textContent()).toBe(at('文字'));
      expect(await inspector().getByTestId('properties').getAttribute('data-type')).toBe('text');
      // 属性面板按 Schema 分组：位置尺寸、文字、颜色、适配、条件显示、状态样式。
      for (const group of ['位置尺寸', '文字', '颜色', '适配', '条件显示', '状态样式']) await inspector().getByRole('region', { name: group }).waitFor();
      expect(await input('place.left').inputValue()).toBe('2');

      // 每种元素改一项属性。text：字号从绑定变量换成数值。
      await edit(() => fieldOf('fontSize').locator('select').first().selectOption({ label: '数值' }));
      let { document, reply } = await edit(() => input('fontSize').fill('8'));
      const elementIn = (doc: Record<string, unknown>, name: string) => (doc['artboard'] as { children: Record<string, unknown>[] }).children.find((child) => child['name'] === name)!;
      expect(elementIn(document, '文字')['fontSize']).toBe(8);
      layout = reply.layout;

      await chooseRow(at('容器'));
      expect(await inspector().getByTestId('properties').getAttribute('data-type')).toBe('container');
      ({ document } = await edit(() => input('fill').fill('#DDEEFF')));
      expect(elementIn(document, '容器')['fill']).toBe('#DDEEFF');

      await chooseRow(at('循环'));
      ({ document } = await edit(() => input('itemLayout.heights.fixed').fill('4')));
      expect(elementIn(document, '循环')['itemLayout']).toMatchObject({ heights: { fixed: 4 } });

      await chooseRow(at('调用'));
      await edit(() => fieldOf('opacity').locator('select').first().selectOption({ label: '数值' }));
      ({ document } = await edit(() => input('opacity').fill('0.5')));
      expect(elementIn(document, '调用')['opacity']).toBe(0.5);

      await clickElement(at('图片'));
      await edit(() => fieldOf('opacity').locator('select').first().selectOption({ label: '数值' }));
      ({ document } = await edit(() => input('opacity').fill('0.4')));
      expect(elementIn(document, '图片')['opacity']).toBe(0.4);

      await clickElement(at('二维码'));
      // 换成"颜色"写入的初始值是黑色，与缺省相同，图还不变。
      const qrColor = afterStash();
      await fieldOf('foreground').locator('select').first().selectOption({ label: '颜色' });
      await qrColor;
      ({ document } = await edit(() => input('foreground').fill('#B4532A')));
      expect(elementIn(document, '二维码')['foreground']).toBe('#B4532A');

      await clickElement(at('条码'));
      const barColor = afterStash();
      await fieldOf('foreground').locator('select').first().selectOption({ label: '颜色' });
      await barColor;
      ({ document } = await edit(() => input('foreground').fill('#0B4EA2')));
      expect(elementIn(document, '条码')['foreground']).toBe('#0B4EA2');

      await clickElement(at('矩形'));
      ({ document } = await edit(() => input('cornerRadius').fill('5')));
      expect(elementIn(document, '矩形')['cornerRadius']).toBe(5);

      await clickElement(at('椭圆'));
      ({ document } = await edit(() => input('fill').fill('#123456')));
      expect(elementIn(document, '椭圆')['fill']).toBe('#123456');

      await clickElement(at('线条'));
      ({ document } = await edit(() => input('stroke.width').fill('2.5')));
      expect(elementIn(document, '线条')['stroke']).toEqual({ color: '#2B2824', width: 2.5 });

      await clickElement(at('多边形'));
      ({ document } = await edit(() => input('fill').fill('#654321')));
      expect(elementIn(document, '多边形')['fill']).toBe('#654321');

      await clickElement(at('路径'));
      ({ document, reply } = await edit(() => input('fill').fill('#2E7D4F')));
      expect(elementIn(document, '路径')['fill']).toBe('#2E7D4F');
      layout = reply.layout;

      // 画板也是一个可选的对象。
      await chooseRow(ALL);
      expect(await inspector().getByTestId('properties').getAttribute('data-type')).toBe('artboard');
      ({ document } = await edit(() => input('fill').fill('#FFF8EE')));
      expect((document['artboard'] as Record<string, unknown>)['fill']).toBe('#FFF8EE');

      // 未发布的改动数来自服务端的结构化差异；工作副本暂存，当前修订不动。
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      await target.getByTestId('unpublished-count').filter({ hasText: '13 处未发布' }).waitFor();
      expect((await server('GET', `/v1/templates/${enc(ALL)}`, token)).body.currentRevision).toBe(1);

      // 撤销与重做：写回工作副本，预览跟着变。
      const undone = await edit(() => target.getByRole('button', { name: '撤销', exact: true }).click());
      expect((undone.document['artboard'] as Record<string, unknown>)['fill']).toBe('#FFFFFF');
      const redone = await edit(() => target.keyboard.press('Control+y'));
      expect((redone.document['artboard'] as Record<string, unknown>)['fill']).toBe('#FFF8EE');

      // 保存就是暂存：写回失败时看得到未保存的改动数，改动还在页面里，"保存"重试。
      await target.route('**/working-copy?expectedSha256=*', (route) => route.abort());
      await input('fill').fill('#FFEEDD');
      await target.getByTestId('unsaved-count').filter({ hasText: '1 处未保存' }).waitFor();
      await target.getByTestId('save-failure').waitFor();
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill'], '服务端还是上一次的').toBe('#FFF8EE');
      await target.unroute('**/working-copy?expectedSha256=*');
      const retried = afterStash();
      await target.getByRole('button', { name: '保存', exact: true }).click();
      await retried;
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      expect(await target.getByTestId('save-failure').count()).toBe(0);
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill']).toBe('#FFEEDD');
      // Ctrl+S 立刻写回，不等暂存的延迟。
      await input('fill').fill('#FFEEDE');
      const flushed = target.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/working-copy?'));
      await target.keyboard.press('Control+s');
      await flushed;
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();

      // 别处先改了：写回被拒，明确选择才盖过去。
      const copy = await server('GET', copyUrl, token);
      const elsewhere = JSON.parse(copy.body.content as string) as Record<string, unknown>;
      elementIn(elsewhere, '矩形')['opacity'] = 0.9;
      expect((await server('PUT', `${copyUrl}?expectedSha256=${copy.body.sha256 as string}`, token, elsewhere)).status).toBe(200);
      await input('fill').fill('#FFEEDF');
      await target.getByTestId('save-failure').getByRole('button', { name: '用这里的盖过去' }).waitFor();
      const forced = afterStash();
      await target.getByTestId('save-failure').getByRole('button', { name: '用这里的盖过去' }).click();
      await forced;
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill']).toBe('#FFEEDF');

      // 工具栏：切换样例数据集；正式模式按问题清单说结果；缩放；平移时点图不改选中。
      await target.getByTestId('select-box').waitFor();
      const blank = worked((body) => body.dataset.inline !== undefined);
      await target.getByLabel('样例数据集').selectOption({ label: '空白数据（显示占位）' });
      await blank;
      await target.getByRole('group', { name: '模式' }).getByRole('button', { name: '正式' }).click();
      await target.getByText(/正式模式不出图：有 \d+ 个严重问题/).waitFor();
      await target.getByTestId('final-mode-note').filter({ hasText: '正式出图时不出图' }).waitFor();
      await target.getByRole('group', { name: '模式' }).getByRole('button', { name: '草稿' }).click();
      const again = worked((body) => body.dataset.id === 'badge-zhang');
      await target.getByLabel('样例数据集').selectOption('badge-zhang');
      layout = (await (await again).json() as Reply).layout;
      await image().waitFor();
      await target.getByRole('group', { name: '模式' }).getByRole('button', { name: '正式' }).click();
      await target.getByTestId('final-mode-note').filter({ hasText: /没有问题|没有问题边框/ }).waitFor();
      await target.getByRole('group', { name: '模式' }).getByRole('button', { name: '草稿' }).click();
      expect(await target.getByLabel('样例数据集').locator('optgroup[label="压测数据"] option').allTextContents()).toEqual(['压测：长姓名']);
      const stress = worked((body) => body.dataset.id === 'badge-stress');
      await target.getByLabel('样例数据集').selectOption('badge-stress');
      await stress;
      await target.getByLabel('样例数据集').selectOption('badge-zhang');
      await image().waitFor();
      const width = (await target.getByTestId('design-canvas').boundingBox())!.width;
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByTestId('zoom-level').filter({ hasText: '200%' }).waitFor();
      await expect.poll(async () => (await target.getByTestId('design-canvas').boundingBox())!.width).toBeGreaterThan(width * 1.9);
      await target.getByRole('group', { name: '工具' }).getByRole('button', { name: '平移' }).click();
      const stage = target.getByTestId('design-stage');
      const scrollOf = () => stage.evaluate((element) => element.scrollTop + element.scrollLeft);
      const stageBox = (await stage.boundingBox())!, before = await scrollOf();
      await target.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
      await target.mouse.down();
      await target.mouse.move(stageBox.x + stageBox.width / 2 - 80, stageBox.y + stageBox.height / 2 - 120, { steps: 3 });
      await target.mouse.up();
      expect(await scrollOf(), '拖动滚动台面').toBeGreaterThan(before);
      const pathBefore = await inspector().getByTestId('properties').getAttribute('data-path');
      expect(pathBefore).toBe(ALL);
      await target.keyboard.press('v');
      await target.getByRole('group', { name: '工具' }).getByRole('button', { name: '选择' }).and(target.locator('[aria-pressed="true"]')).waitFor();
      await target.getByTestId('zoom-level').click();
      await image().waitFor();
      await expect.poll(async () => Math.round((await target.getByTestId('design-canvas').boundingBox())!.width)).toBeLessThan(width * 1.1);

      // 右键菜单：复制元素路径、在结构中定位、打开绑定的字段；没有 Agent 与评论。
      await target.getByTestId('design-canvas').click({ button: 'right', position: await positionOf(at('文字')) });
      const menu = target.getByTestId('element-menu');
      await menu.getByRole('menuitem', { name: '复制元素路径' }).waitFor();
      expect(await menu.getByRole('menuitem', { name: '打开绑定的字段 fullName' }).getAttribute('href')).toBe(`#/definitions/${enc('胸牌')}?field=fullName`);
      expect(await menu.textContent()).not.toMatch(/Agent|评论/);
      await menu.getByRole('menuitem', { name: '在结构中定位' }).click();
      await inspector().getByRole('tab', { name: '结构', selected: true }).waitFor();
      expect(await inspector().locator(`[data-testid="structure-row"][data-path="${at('文字')}"]`).getAttribute('data-selected')).toBe('true');
      // 结构与预览双向：结构里选一行，图上出现它的框。
      await inspector().locator(`[data-testid="structure-row"][data-path="${at('矩形')}"]`).getByRole('button').first().click();
      await target.locator(`[data-testid="select-box"][data-path="${at('矩形')}"]`).waitFor();
      await target.getByTestId('design-canvas').click({ button: 'right', position: await positionOf(at('椭圆')) });
      await menu.getByRole('menuitem', { name: '复制元素路径' }).click();
      await target.getByRole('status').filter({ hasText: at('椭圆') }).waitFor();

      // 规则页：所选元素相关的检查项（经派生变量连带）、适配规则，改写回。
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('文字')) });
      await inspector().getByRole('tab', { name: '规则' }).click();
      await inspector().locator('[data-testid="check-row"][data-name="姓名太长"]').waitFor();
      expect(await inspector().locator('[data-testid="check-row"][data-name="没有照片"]').count(), '文字没有用照片').toBe(0);
      await inspector().getByTestId('fit-hint').filter({ hasText: '画板的 2 mm' }).waitFor();
      expect(await input('fit.compressMin').inputValue()).toBe('0.7');
      await input('fit.compressMin').fill('0.8');
      await expect.poll(async () => elementIn(await documentNow(), '文字')['fit']).toMatchObject({ compressMin: 0.8 });
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('图片')) });
      await inspector().locator('[data-testid="check-row"][data-name="没有照片"]').waitFor();
      await inspector().getByText('这个元素没有适配规则').waitFor();
      // 竖排的文字才有缩字组：写了组名，同组的元素列出来。
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('文字')) });
      await inspector().getByRole('tab', { name: '属性' }).click();
      await expand();
      await fieldOf('writingMode').locator('select').selectOption({ label: '竖排' });
      await inspector().getByRole('tab', { name: '规则' }).click();
      await fieldOf('fit.widthOverflow').getByRole('button', { name: '添加' }).click();
      await input('fit.widthOverflow.shrinkGroup').fill('站名组');
      await inspector().getByTestId('shrink-group').filter({ hasText: '缩字组 站名组：文字' }).waitFor();
      await expect.poll(async () => (elementIn(await documentNow(), '文字')['fit'] as { widthOverflow?: unknown }).widthOverflow).toEqual({ shrinkGroup: '站名组' });
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      expect(checkDslDocument(await documentNow()).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
      // 三步一起撤销：组名、添加缩字组、改竖排。
      for (let step = 0; step < 3; step++) await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => elementIn(await documentNow(), '文字')['writingMode']).toBeUndefined();

      // 参数页：对外参数与内部参数，改缺省值预览跟着变；约束按类型；加一个参数，撤销后没了。
      await inspector().getByRole('tab', { name: '参数' }).click();
      const parameter = (name: string) => inspector().locator(`[data-testid="parameter-row"][data-name="${name}"]`);
      await inspector().getByRole('region', { name: '内部参数' }).locator('[data-testid="parameter-row"][data-name="bandHeight"]').waitFor();
      await parameter('accentColor').getByRole('button').first().click();
      ({ document } = await edit(() => input('default').fill('#0B4EA2')));
      expect((document['parameters'] as Record<string, unknown>[]).find((item) => item['name'] === 'accentColor')).toMatchObject({ default: '#0B4EA2' });
      await parameter('nameSize').getByRole('button').first().click();
      await input('displayName').fill('姓名大小');
      await input('constraints.max').fill('20');
      await expect.poll(async () => (await documentNow())['parameters']).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'nameSize', displayName: '姓名大小', constraints: { min: 3, max: 20 } })]));
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      await inspector().getByLabel('新参数的名称').fill('footnote');
      await inspector().getByRole('button', { name: '添加参数' }).click();
      await parameter('footnote').waitFor();
      await expect.poll(async () => ((await documentNow())['parameters'] as unknown[]).length).toBe(4);
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => ((await documentNow())['parameters'] as unknown[]).length).toBe(3);

      // 结构页打开子模板：预览仍是调用它的模板，改子模板时那张图跟着变；图上点到子模板的元素也切过去。
      await inspector().getByRole('tab', { name: '结构' }).click();
      await inspector().locator(`[data-testid="structure-row"][data-path="${at('循环')}"]`).getByRole('button', { name: '打开 场次条' }).click();
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/场次条/design?in=${ALL}`);
      await inspector().locator('[data-testid="structure-row"][data-path="场次条/场次名称"]').getByRole('button').first().click();
      await inspector().getByRole('tab', { name: '属性' }).click();
      await inspector().locator('[data-testid="properties"][data-path="场次条/场次名称"]').waitFor();
      const child = afterStash();
      await input('fontSize').fill('4');
      expect(((await child).request().postDataJSON() as { template: string }).template).toBe(ALL);
      await expect.poll(async () => JSON.stringify(await documentNow('场次条'))).toContain('"fontSize":4');
      await target.locator('nav.crumbs').getByRole('link', { name: ALL }).click();
      await inspector().getByRole('tab', { name: '属性' }).waitFor();
      await target.getByTestId('design-canvas').click({ position: await positionOf(`${at('调用')}/场次名称`) });
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/场次条/design?in=${ALL}`);
      await inspector().locator('[data-testid="properties"][data-path="场次条/场次名称"]').waitFor();
      expect(await target.getByTestId('select-tag').textContent()).toBe(`${at('调用')}/场次名称`);
      // 跨模板撤销：撤回子模板上的字号。
      await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => JSON.stringify(await documentNow('场次条'))).toContain('"fontSize":3.2');
      await target.locator('nav.crumbs').getByRole('link', { name: ALL }).click();

      // 发布修订：差异里有这些改动，保存为新修订，回到列表不再有工作副本。
      await target.getByRole('button', { name: '发布修订' }).click();
      await target.getByRole('heading', { name: '发布修订 2', level: 1 }).waitFor();
      await target.locator(`[data-testid="change"][data-path="${at('椭圆')}"]`).waitFor();
      await target.getByTestId('compare-working-copy').getByRole('img').waitFor();
      await target.getByRole('button', { name: '发布为修订 2' }).click();
      await target.getByRole('status').filter({ hasText: '已保存为修订 2' }).waitFor();
      expect((await server('GET', `/v1/templates/${enc(ALL)}`, token)).body.currentRevision).toBe(2);
      // 子模板的工作副本是这次打开才开的，又都撤销了：离开时删掉，不留空的。
      await expect.poll(async () => (await server('GET', `/v1/templates/${enc('场次条')}/working-copy`, token)).status).toBe(404);

      // 复制为新模板：列表上复制，进设计页；没有修订可比，发布记修订 1。
      const copied = `全元素牌副本 ${randomUUID().slice(0, 8)}`;
      await (await nav(target, '模板')).click();
      const allCard = target.getByRole('article', { name: `模板 ${ALL}` });
      await allCard.getByRole('button', { name: '复制为新模板' }).click();
      await allCard.getByLabel('新模板名称').fill(copied);
      const copiedPreview = worked((body) => body.template === copied);
      await allCard.getByRole('button', { name: '复制', exact: true }).click();
      await copiedPreview;
      await target.getByTestId('unpublished-count').filter({ hasText: '新模板，未发布' }).waitFor();
      await target.getByRole('button', { name: '发布修订' }).click();
      await target.getByRole('heading', { name: '发布修订 1', level: 1 }).waitFor();
      await target.getByTestId('compare-working-copy').getByRole('img').waitFor();
      expect(await target.getByTestId('compare-current').count(), '没有当前修订可比').toBe(0);
      await target.getByRole('button', { name: '发布为修订 1' }).click();
      await target.getByRole('status').filter({ hasText: '已保存为修订 1' }).waitFor();
      expect((await server('GET', `/v1/templates/${enc(copied)}`, token)).body.currentRevision).toBe(1);

      // 操作员没有设计页。
      const reader = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      reader.setDefaultTimeout(30_000);
      const operator = await reader.newPage();
      watch(operator);
      await operator.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await operator.getByLabel('邮箱').fill(world.b.operator.email);
      await operator.getByLabel('密码').fill(world.b.operator.password);
      await operator.getByRole('button', { name: '登录' }).click();
      await operator.getByText('模板设计只给客户管理员').waitFor();
      expect((await server('POST', copyUrl, world.b.operator.token)).status, '接口同样拒绝').toBe(403);
      await reader.close();
    }, 300_000);

    it('退出后会话失效，回到登录页；整个过程没有脚本错误，也没有被内容安全策略拦下的资源', async () => {
      await page.getByRole('button', { name: '退出' }).click();
      await page.getByRole('button', { name: '登录' }).waitFor();
      expect(await page.evaluate(() => sessionStorage.getItem('renderweave.console.token'))).toBeNull();
      expect(pageErrors).toEqual([]);
    });
  });
}
