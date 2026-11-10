/**
 * 出图控制台的浏览器端到端测试（票据 12，M281）：浏览器经接口进程打开 /console/，像客户操作员一样
 * 登录、看模板、调参数、填表、预览、出图、下载；每一步的结果再经开放 API 核对，不看控制台的内部状态。
 * 界面按原型方案一（M282）：首页是数据集，编辑页左表单、右草稿预览，出图在侧栏里进行。
 * 票据 14 另有出图记录、用量、资源与管理页（M300、M301）：客户管理员在另一个浏览器上下文里登录，操作员与管理员各看各的。
 * P1 票据 01 换成标题栏模块下拉与状态栏的新框架：换页走模块下拉（nav），既有用例只改了选择器；新框架另有三条用例。
 * P1 票据 06、14、17 的数据定义与静态数据定义：打开数据定义 → 加必填字段 → 看差异与影响 → 发布 → 接着改、接着发布，九种字段类型，删除，操作员只读。
 * P1 票据 11 的审批：管理页打开开关，代建工程师经开放 API 发起申请，发布记录页与发布模板修订页上退回与批准。
 * Docker 后端测试里浏览器是 tester 容器里的 Chromium，接口进程与 worker 是 Compose 里真实的进程（console.docker.test.ts）；
 * 本机另可用内存后端加本机浏览器快速跑（console.browser.test.ts，设 RW_BROWSER）。
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext, type Dialog, type LaunchOptions, type Locator, type Page } from 'playwright-core';
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
/** 预览按租户每分钟限频，撞上时页面自己重试：等图要等得过一个窗口。Docker 后端用的是真实上限。 */
const PREVIEW_WINDOW_MS = 90_000;
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
    /**
     * 离开设计页回到模板列表。页面可能问"还没保存，确定离开"：由页面自己换地址，
     * page.goto 也算一次导航，会把这个确认框关掉，页面就留在了设计页，连累下一个用例。
     */
    const leaveDesign = async (target: Page, trialKey?: string) => {
      const accept = (dialog: Dialog) => { void dialog.accept(); };
      target.on('dialog', accept);
      try {
        await target.evaluate("location.hash = '#/templates'");
        await target.getByRole('heading', { name: '模板', level: 1 }).waitFor();
      } finally { target.off('dialog', accept); }
      if (trialKey) await target.evaluate((key) => { localStorage.removeItem(key); }, `renderweave.design.trial.${trialKey}`);
    };
    /** 展开结构树的一行；已经展开的不再点（选中时树会自己展开到那一行）。 */
    const openRow = async (scope: Locator, name: string) => {
      // 先等这一行出来：刚切到结构页时树还没画，数不到按钮会误以为已经展开。
      await scope.getByRole('button', { name: new RegExp(`^(展开|收起) ${name}$`, 'u') }).first().waitFor();
      const button = scope.getByRole('button', { name: `展开 ${name}`, exact: true });
      if (await button.count()) await button.click();
      await scope.getByRole('button', { name: `收起 ${name}`, exact: true }).waitFor();
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
      await page.getByRole('link', { name: '标准表格批量出图…' }).click();
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
      const MEMBER = ['数据定义', '静态数据定义', '模板', '数据集', '出图', '资源', '用量'];
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
      // 模块与动作、模块切换紧跟品牌，账号与退出在右边；模块菜单从下拉框左边向右展开（M362）。
      const rects = () => page.evaluate(`(() => { const of = (selector) => { const box = document.querySelector(selector)?.getBoundingClientRect(); return box && [box.left, box.right]; }; return { brand: of('.brand'), command: of('.command-button'), switcher: of('.switcher-button'), who: of('.who'), menu: of('[role="menu"]'), width: innerWidth }; })()`) as Promise<Record<'brand' | 'command' | 'switcher' | 'who', [number, number]> & { menu?: [number, number]; width: number }>;
      const titlebar = await rects();
      expect(titlebar.brand[1]).toBeLessThanOrEqual(titlebar.command[0]);
      expect(titlebar.command[1]).toBeLessThanOrEqual(titlebar.switcher[0]);
      expect(titlebar.switcher[1]).toBeLessThan(titlebar.width / 2);
      expect(titlebar.who[0]).toBeGreaterThan(titlebar.width / 2);
      await switcher(page).click();
      await page.getByRole('menu', { name: '模块' }).waitFor();
      expect((await rects()).menu![0]).toBe(titlebar.switcher[0]);
      await page.keyboard.press('Escape');
      const adminPage = await asAdmin();
      expect(await listed(adminPage)).toEqual([...MEMBER, '管理'].map((name, index) => `${name} Control+${index + 1}`));

      // Ctrl+数字切换模块；静态数据定义列出已发布的版本，与开放 API 相同。
      await page.keyboard.press('Control+1');
      await page.getByRole('heading', { name: '数据定义', level: 1 }).waitFor();
      expect(hashOf()).toBe('#/definitions');
      await page.keyboard.press('Control+2');
      await page.getByRole('heading', { name: '静态数据定义', level: 1 }).waitFor();
      expect(hashOf()).toBe('#/static-schemas');
      const schemas = (await api('GET', '/v1/static-schemas')).body.staticSchemas as { name: string; version: number }[];
      await expect.poll(() => page.getByTestId('version-card').evaluateAll((cards) => cards.map((card) => `${card.getAttribute('data-name')}@${card.getAttribute('data-version')}`).sort()), { timeout: 15_000 })
        .toEqual(schemas.map((schema) => `${schema.name}@${schema.version}`).sort());
      await adminPage.keyboard.press('Control+8');
      await adminPage.getByRole('heading', { name: '管理', level: 1 }).waitFor();
      // 出图模块：出图记录与批次两页；批次是本标签页提交过的，状态与已交付张数与开放 API 相同。
      await page.keyboard.press('Control+5');
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
      expect(await options(page)).toEqual([...MEMBER, '新建数据集', '智能导入数据集', '标准表格批量出图', '上传资源']);
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
      expect(await options(adminPage)).toEqual([...MEMBER, '管理', '新建数据集', '智能导入数据集', '标准表格批量出图', '上传资源', '管理成员', '创建 API 密钥', '查看审计日志']);
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

    it('新框架（P1 票据 01）：窄窗口下模块占满宽度、没有横向滚动；正文与背景对比度不低于 4.5，铅笔赭不承载文字', async () => {
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
          && getComputedStyle(element).color === 'rgb(179, 128, 71)').map((element) => element.textContent.trim());
        return { color: body.color, background: body.backgroundColor, orange, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`) as Promise<{ color: string; background: string; orange: string[]; overflow: number }>;
      const pages: [string, () => Promise<unknown>][] = [
        ['#/definitions', () => page.getByTestId('definition-card').first().waitFor()],
        [`#/definitions/${enc('线路牌')}`, () => page.getByTestId('field-row').first().waitFor()],
        ['#/static-schemas', () => page.getByTestId('version-card').first().waitFor()],
        [`#/static-schemas/${enc('线路牌')}/1`, () => page.getByTestId('tree-field').first().waitFor()],
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
            expect([seen.color, seen.background], link).toEqual(['rgb(29, 38, 46)', 'rgb(247, 244, 236)']);
            expect(contrast(seen.color, seen.background)).toBeGreaterThanOrEqual(4.5);
            expect((await page.getByRole('main').boundingBox())!.width, `${width} ${link}`).toBe(width);
          }
        }
      } finally {
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
    }, 180_000);

    /** 静态数据定义的一张卡片（一个版本）、数据定义的一张卡片、字段的一行（表单）与字段树上的一个字段。 */
    const versionCard = (target: Page, name: string, version: number | string) => target.locator(`[data-testid="version-card"][data-name="${name}"][data-version="${version}"]`);
    const definitionCard = (target: Page, name: string) => target.locator(`[data-testid="definition-card"][data-name="${name}"]`);
    const fieldRow = (target: Page, name: string) => target.locator(`[data-testid="field-row"][data-field="${name}"]`);
    const treeField = (target: Page, name: string) => target.locator(`[data-testid="tree-field"][data-field="${name}"]`);
    const publicationRow = (target: Page, name: string, version: number | string) => target.locator(`[data-testid="publication-row"][data-name="${name}"][data-version="${version}"]`);
    const openField = (target: Page, name: string) => fieldRow(target, name).getByRole('button').first().click();
    const menuLabels = (target: Page) => target.getByRole('menu').getByRole('menuitem').evaluateAll((items) => items.map((item) => item.querySelector('.menu-label')!.textContent));
    const checkPassed = (target: Page) => target.getByTestId('check-status').filter({ hasText: '校验通过' }).waitFor();
    const inspector = (target: Page) => target.getByRole('form', { name: '编辑字段' });
    const saveDraft = async (target: Page) => {
      await target.getByRole('button', { name: '保存', exact: true }).click();
      await target.getByTestId('save-status').filter({ hasText: '已保存' }).waitFor();
    };
    /** 添加字段：填共同的属性，别的由 fill 填。改动先留在页面上，要保存才写。 */
    const addField = async (target: Page, field: { displayName: string; name: string; type: string; required?: boolean }, fill?: (form: Locator) => Promise<void>) => {
      await target.getByRole('button', { name: '添加字段' }).click();
      const form = inspector(target);
      await form.getByLabel('显示名称', { exact: true }).fill(field.displayName);
      await form.getByLabel('字段名称', { exact: true }).fill(field.name);
      await form.getByLabel('类型', { exact: true }).selectOption({ label: field.type });
      if (field.required) await form.getByRole('button', { name: '必填', exact: true }).click();
      await fill?.(form);
      await fieldRow(target, field.name).waitFor();
    };

    it('静态数据定义与数据定义（P1 票据 06、14、17）：打开数据定义 → 加必填字段 → 看差异与影响 → 发布 → 接着改、接着发布；每一步都与开放 API 相同', async () => {
      const target = await asAdmin(), name = '线路牌', path = enc(name);
      const definitionsApi = async () => ((await adminApi('GET', '/v1/definitions')).body.definitions as any[]).find((item) => item.name === name);
      const versionOf = async (version: number | string) => (await adminApi('GET', `/v1/static-schemas/${path}/versions/${version}`)).body;
      await (await nav(target, '静态数据定义')).click();
      await target.getByRole('heading', { name: '静态数据定义', level: 1 }).waitFor();

      // 卡片：版本、字段数、引用深度与谁在用，都与开放 API 相同；"从示例图提取""从数据集提取"在 P2 接入前不显示。
      const card = versionCard(target, name, 1), listed = await definitionsApi();
      await card.getByTestId('version-badge').filter({ hasText: 'v1' }).waitFor();
      await card.getByText('当前版本').waitFor();
      const all = (await adminApi('GET', '/v1/static-schemas')).body.staticSchemas as { name: string; version: number; fieldCount: number; referenceDepth: number }[];
      const summary = all.find((item) => item.name === name && item.version === 1)!;
      expect(summary).toMatchObject({ fieldCount: (await versionOf(1)).definition.fields.length, referenceDepth: 1 });
      expect(await card.getByTestId('version-fields').textContent()).toBe(String(summary.fieldCount));
      expect(await card.getByTestId('version-depth').textContent()).toBe('1');
      expect(await card.getByTestId('version-uses').textContent()).toBe(`${listed.versions[0].templates} 模板 · ${listed.versions[0].datasets} 数据集`);
      expect(await target.getByText('示例图').count() + await target.getByText('从数据集').count()).toBe(0);

      // 搜索与排序。
      const shown = () => target.getByTestId('version-card').evaluateAll((cards) => cards.map((item) => item.getAttribute('data-name')));
      await target.getByLabel('搜索静态数据定义').fill('线路');
      await expect.poll(shown).toEqual([name]);
      await target.getByLabel('搜索静态数据定义').fill('');
      await target.getByLabel('排序').selectOption('nameDesc');
      const descending = all.map((item) => item.name).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      await expect.poll(shown).toEqual(descending);
      await target.getByLabel('排序').selectOption('newest');

      // 右键一张卡片：导出编译产物与开放 API 相同，复制引用，在新标签页打开时带着会话。
      await card.click({ button: 'right' });
      expect(await menuLabels(target)).toEqual(['打开', '在新标签页打开', '查看发布记录', '导出编译产物 JSON Schema', '复制引用', '打开这个数据定义', '复制为新的数据定义']);
      const exported = await downloadBytes(target, () => target.getByRole('menuitem', { name: /导出编译产物/ }).click());
      expect(exported.name).toBe('线路牌-v1.schema.json');
      expect(JSON.parse(exported.bytes.toString('utf8'))).toEqual((await versionOf(1)).compiled);
      // 剪贴板只在安全上下文里有（本机 127.0.0.1 有，Compose 网络里的 http://api 没有，也授不了权）；没有时把引用写在页面上，让人手动复制。
      const secure = await target.evaluate('window.isSecureContext');
      if (secure) await adminContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
      await card.click({ button: 'right' });
      await target.getByRole('menuitem', { name: /复制引用/ }).click();
      if (secure) {
        await target.getByRole('status').filter({ hasText: '已复制' }).waitFor();
        expect(JSON.parse(await target.evaluate('navigator.clipboard.readText()') as string)).toEqual({ name, version: 1 });
      } else {
        await target.getByRole('status').filter({ hasText: JSON.stringify({ name, version: 1 }) }).waitFor();
      }
      await card.getByRole('button', { name: /更多操作/ }).click();
      const [tab] = await Promise.all([adminContext.waitForEvent('page'), target.getByRole('menuitem', { name: '在新标签页打开' }).click()]);
      await tab.getByTestId('static-facts').filter({ hasText: 'v1' }).waitFor();
      await tab.close();
      await card.click({ button: 'right' });
      await target.getByRole('menuitem', { name: '查看发布记录' }).click();
      await publicationRow(target, name, 1).waitFor();
      await target.getByTestId('records-filter').filter({ hasText: name }).waitFor();
      expect(await publicationRow(target, name, 1).getByTestId('publication-actor').textContent(), '种子直接写存储，审计里没有').toBe('没有记录');
      await (await nav(target, '静态数据定义')).click();

      // 打开这个数据定义：推送来的也能直接改；进编辑页，表单列字段，检查器看谁在用。
      await card.click({ button: 'right' });
      await target.getByRole('menuitem', { name: '打开这个数据定义' }).click();
      await target.getByTestId('definition-meta').filter({ hasText: '已发布 v1' }).waitFor();
      const draft = (await adminApi('GET', `/v1/definitions/${path}`)).body;
      const routeNo = fieldRow(target, 'routeNo');
      expect(await routeNo.getByTestId('field-type').textContent()).toBe('文本');
      expect(await routeNo.getByTestId('field-constraints').textContent()).toBe('1–8 字');
      expect(await routeNo.getByTestId('field-required').textContent()).toBe('必填');
      expect(await fieldRow(target, 'stops').getByTestId('field-type').textContent()).toBe('列表 · 数据定义引用 · 停靠站点 v1');
      await target.getByRole('button', { name: '校验', exact: true }).click();
      await checkPassed(target);

      // 改字段名称、删字段：提示会影响的模板；撤销、重做、回到已保存都不碰服务端。
      await openField(target, 'routeNo');
      await target.getByTestId('field-used-by').filter({ hasText: ROUTE }).waitFor();
      await inspector(target).getByLabel('字段名称', { exact: true }).fill('lineNo');
      const renameImpact = target.getByTestId('rename-impact');
      await renameImpact.filter({ hasText: ROUTE }).waitFor();
      expect(await renameImpact.textContent()).toContain('改字段名称等于删掉 routeNo');
      await target.getByTestId('save-status').filter({ hasText: '有没保存的改动' }).waitFor();
      await target.getByRole('button', { name: '删除字段', exact: true }).click();
      await target.getByTestId('remove-impact').filter({ hasText: ROUTE }).waitFor();
      // 有影响的字段用弹窗问：确认按钮总在窗口里，不会落到检查器下面看不见（M379）。
      const confirmBox = await target.getByRole('dialog', { name: '删除字段' }).getByRole('button', { name: '确认删除字段' }).evaluate((button) => { const box = button.getBoundingClientRect(); return [box.top, box.bottom, button.ownerDocument.documentElement.clientHeight]; });
      expect(confirmBox[0]).toBeGreaterThanOrEqual(0);
      expect(confirmBox[1]).toBeLessThanOrEqual(confirmBox[2]!);
      await target.getByRole('button', { name: '留着' }).click();
      await target.getByRole('button', { name: '撤销' }).click();
      await routeNo.waitFor();
      await target.getByRole('button', { name: '重做' }).click();
      await fieldRow(target, 'lineNo').waitFor();
      await target.getByRole('button', { name: '回到已保存' }).click();
      await routeNo.waitFor();
      await target.getByTestId('save-status').filter({ hasText: '已保存' }).waitFor();
      expect((await adminApi('GET', `/v1/definitions/${path}`)).body.sha256).toBe(draft.sha256);

      // 有没保存的改动时换页先问：答否留在这里，改动还在；保存之后不再问。
      await inspector(target).getByLabel('说明', { exact: true }).fill('还没保存');
      const asked: string[] = [];
      target.once('dialog', (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
      await target.getByRole('navigation', { name: '位置' }).getByRole('link', { name: '数据定义' }).click();
      await expect.poll(() => asked).toEqual(['有没保存的改动，离开就丢了。确定离开？']);
      await expect.poll(() => target.evaluate('location.hash')).toBe(`#/definitions/${path}`);
      expect(await inspector(target).getByLabel('说明', { exact: true }).inputValue()).toBe('还没保存');
      await target.getByRole('button', { name: '回到已保存' }).click();

      // 校验的问题定位到字段：严重问题时不能发布，改正之后恢复。
      await openField(target, 'fare');
      await inspector(target).getByLabel('下限', { exact: true }).fill('200');
      await target.getByTestId('check-status').filter({ hasText: '保存之后校验' }).waitFor();
      await saveDraft(target);
      await fieldRow(target, 'fare').getByTestId('field-problems').filter({ hasText: '下界 200 大于上界 100' }).waitFor();
      await target.getByTestId('check-status').filter({ hasText: '1 个严重问题' }).waitFor();
      expect(await fieldRow(target, 'fare').getByText('已修改').count()).toBe(1);
      expect(await target.getByRole('button', { name: /^发布/ }).isDisabled()).toBe(true);
      await target.getByRole('button', { name: '编译产物' }).click();
      await target.getByTestId('compiled-unavailable').filter({ hasText: '改正严重问题' }).waitFor();
      await target.getByRole('list', { name: '校验问题' }).getByRole('button').click();
      await inspector(target).getByLabel('下限', { exact: true }).fill('0');
      await saveDraft(target);
      await checkPassed(target);
      expect(await fieldRow(target, 'fare').getByText('已修改').count(), '改回去了').toBe(0);

      // 手动加一个必填字段。
      await addField(target, { displayName: '所属车队', name: 'depot', type: '文本', required: true }, (form) => form.getByLabel('最长（字）', { exact: true }).fill('20'));
      const depot = fieldRow(target, 'depot');
      expect(await depot.getByTestId('field-constraints').textContent()).toBe('最多 20 字');
      expect(await depot.getByTestId('field-required').textContent()).toBe('必填');
      expect(await depot.getByText('新增').count()).toBe(1);
      await target.getByTestId('definition-changes').filter({ hasText: '与 v1 相比新增 1、修改 0、删除 0' }).waitFor();
      await inspector(target).getByLabel('说明', { exact: true }).fill('运营这条线路的车队');
      await target.keyboard.press('Control+s');
      await target.getByTestId('save-status').filter({ hasText: '已保存' }).waitFor();
      await expect.poll(async () => JSON.parse((await adminApi('GET', `/v1/definitions/${path}`)).body.content).fields.at(-1))
        .toEqual({ name: 'depot', displayName: '所属车队', type: 'text', constraints: { required: true, maxLength: 20 }, description: '运营这条线路的车队' });
      await checkPassed(target);

      // 树状图与表单是同一个会话：选中的字段一起走，切换不丢没保存的改动。
      await target.getByRole('button', { name: '树状图' }).click();
      await treeField(target, 'depot').getByRole('button').waitFor();
      await target.getByTestId('definition-map').waitFor();
      // 搜索时不匹配的节点变淡，不消失（M380）。
      await target.getByLabel('搜索字段').fill('depot');
      await target.locator('[data-testid="tree-field"][data-field="fare"][data-dimmed="true"]').waitFor();
      expect(await treeField(target, 'depot').getAttribute('data-dimmed')).toBeNull();
      await target.getByLabel('搜索字段').fill('');
      await treeField(target, 'fare').getByRole('button').click();
      expect(await inspector(target).getByLabel('字段名称', { exact: true }).inputValue()).toBe('fare');
      await inspector(target).getByLabel('说明', { exact: true }).fill('没保存的说明');
      await target.getByRole('button', { name: '表单', exact: true }).click();
      expect(await fieldRow(target, 'fare').getByRole('button').first().getAttribute('aria-pressed')).toBe('true');
      expect(await inspector(target).getByLabel('说明', { exact: true }).inputValue()).toBe('没保存的说明');
      // 数据定义 DSL 是页面上现在的内容；编译产物按存下来的内容算，有没保存的改动时先说明（M380）。
      await target.getByRole('button', { name: '数据定义 DSL' }).click();
      const liveDsl = JSON.parse((await target.getByTestId('definition-dsl').textContent())!);
      expect(liveDsl.fields.find((field: any) => field.name === 'fare').description).toBe('没保存的说明');
      await target.getByRole('button', { name: '编译产物' }).click();
      await target.getByTestId('compiled-unavailable').filter({ hasText: '保存之后' }).waitFor();
      await target.getByRole('button', { name: '表单', exact: true }).click();
      await target.getByRole('button', { name: '撤销' }).click();
      await target.getByTestId('save-status').filter({ hasText: '已保存' }).waitFor();
      await checkPassed(target);

      // 编译预览与校验接口相同。
      await target.getByRole('button', { name: '编译产物' }).click();
      const preview = JSON.parse((await target.getByTestId('compiled-preview').textContent())!);
      const verdict = (await adminApi('GET', `/v1/definitions/${path}/check`)).body;
      expect(preview).toEqual(verdict.compiled);
      expect(preview.required).toContain('depot');

      // 发布：先看字段级差异与预检结果，数字与开放 API 相同。
      await target.getByRole('button', { name: '发布为 v2' }).click();
      const saved = (await adminApi('GET', `/v1/definitions/${path}`)).body;
      const preflight = (await adminApi('POST', `/v1/definitions/${path}/publish-check`, { expectedSha256: saved.sha256 })).body;
      await target.getByRole('heading', { name: '发布为 线路牌 v2', level: 1 }).waitFor();
      // 确认卡先给结论：能发，但有影响要看，数字与预检相同。
      const confirm = target.getByTestId('publish-confirm');
      expect(await confirm.getAttribute('data-tone')).toBe('warn');
      await confirm.getByText('可以发布，有影响要看').waitFor();
      expect(await confirm.locator('[data-check="datasets"]').getAttribute('data-tone')).toBe('warn');
      await confirm.locator('[data-check="datasets"]').filter({ hasText: `${preflight.datasets.mismatched} 份数据集按 v2 会失配` }).filter({ hasText: '继续按 v1 校验和出图' }).waitFor();
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
      await target.route('**/publish-check', async (route) => {
        const response = await route.fetch(), body = await response.json();
        await route.fulfill({ response, json: { ...body, datasets: { ...body.datasets, total: 1280, checked: 1000, complete: false } } });
      });
      await target.reload();
      await target.getByTestId('datasets-incomplete').filter({ hasText: '未全部核对' }).filter({ hasText: '共 1,280 份' }).filter({ hasText: '前 1,000 份' }).waitFor();
      await target.unroute('**/publish-check');
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
      const afterPublish = (await adminApi('GET', `/v1/definitions/${path}`)).body;
      expect(afterPublish.versions.map((item: any) => item.version), '发布只多了一个静态版本（ADR-0030）').toEqual([1, 2]);
      const compiled = await downloadBytes(target, () => detail.getByRole('button', { name: '导出编译产物' }).click());
      expect(createHash('sha256').update(compiled.bytes).digest('hex'), '导出的字节就是发布的产物').toBe(newest.compiledSha256);

      // 发布之后接着改：还是同一个数据定义。把内容改回 v1 的样子，进编辑页看过，发布成自定义的版本；旧版本不变。
      const v2Before = (await adminApi('GET', `/v1/static-schemas/${path}/versions/2`)).raw;
      const { version: _old, ...oldContent } = (await versionOf(1)).definition;
      const restored = await world.call('PUT', `/v1/definitions/${path}?expectedSha256=${afterPublish.sha256}`, world.b.admin.token, `${JSON.stringify(oldContent, null, 2)}\n`, { 'content-type': 'application/json' });
      expect(restored.status, restored.raw.slice(0, 300)).toBe(200);
      await target.goto(`${baseUrl}/console/#/definitions/${path}`);
      await target.reload();
      await target.getByTestId('definition-meta').filter({ hasText: '已发布 v2' }).waitFor();
      await checkPassed(target);
      await target.getByRole('button', { name: '发布为 v3' }).click();

      // 发布页：版本框缺省是下一个编号，写法不对、已经发布过都不让发。
      await target.getByRole('heading', { name: '发布为 线路牌 v3', level: 1 }).waitFor();
      const versionBox = target.getByLabel('版本', { exact: true }), versionHint = target.getByTestId('publish-version-hint');
      expect(await versionBox.inputValue()).toBe('v3');
      await versionBox.fill('Not Valid');
      await versionHint.filter({ hasText: '要以小写字母或数字开头' }).waitFor();
      expect(await target.getByRole('button', { name: '发布', exact: true }).isDisabled()).toBe(true);
      await versionBox.fill('v1');
      await versionHint.filter({ hasText: '已经发布过 v1' }).waitFor();
      expect(await target.getByRole('button', { name: '发布为 v1' }).isDisabled()).toBe(true);
      await versionBox.fill('2026-08');
      await target.getByRole('heading', { name: '发布为 线路牌 2026-08', level: 1 }).waitFor();
      await target.getByTestId('publish-confirm').locator('.version-step.to').filter({ hasText: '2026-08' }).waitFor();
      await target.getByLabel('发布说明（可选）').fill('回到第一版的字段');
      await target.getByRole('button', { name: '发布为 2026-08' }).click();

      // 发布记录：写版本，有说明，最新的看发布的先后；旧版本不变。
      const tagged = publicationRow(target, name, '2026-08');
      await tagged.getByTestId('publication-summary').filter({ hasText: '删除 depot' }).waitFor();
      await tagged.getByText('当前版本').waitFor();
      await target.getByTestId('publication-note').filter({ hasText: '回到第一版的字段' }).waitFor();
      expect(await publicationRow(target, name, 2).getByText('当前版本').count()).toBe(0);
      const [first, third] = [await versionOf(1), await versionOf('2026-08')];
      expect({ ...third.definition, version: 1 }).toEqual(first.definition);
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/2`)).raw, '旧版本不变').toBe(v2Before);
      expect((await records()).map((item) => item.version)).toEqual(['2026-08', 2, 1]);
      expect((await adminApi('GET', `/v1/definitions/${path}`)).body, '发布之后内容不变').toMatchObject({ sha256: restored.body.sha256 });

      // 看已发布的版本：只读，可以切换；四种看法与开放 API 相同。
      await (await nav(target, '静态数据定义')).click();
      await versionCard(target, name, '2026-08').getByText('当前版本').waitFor();
      expect(await versionCard(target, name, '2026-08').getByTestId('version-badge').textContent()).toBe('2026-08');
      expect(await versionCard(target, name, 2).getByText('当前版本').count()).toBe(0);
      await versionCard(target, name, 2).getByText('历史版本').waitFor();
      await versionCard(target, name, '2026-08').getByRole('link').click();
      await target.getByTestId('static-facts').filter({ hasText: '2026-08 · 当前' }).waitFor();
      await target.getByRole('navigation', { name: '位置' }).getByText(`${name} 2026-08`).waitFor();
      await target.getByTestId('publication-note').filter({ hasText: '回到第一版的字段' }).waitFor();
      await target.getByLabel('查看的版本').selectOption('2');
      await target.getByTestId('static-facts').filter({ hasText: 'v2' }).waitFor();
      await target.getByRole('navigation', { name: '位置' }).getByText(`${name} v2`).waitFor();
      await treeField(target, 'depot').getByRole('button').click();
      await target.getByTestId('field-facts').filter({ hasText: '运营这条线路的车队' }).waitFor();
      expect(await target.getByRole('button', { name: '添加字段' }).count()).toBe(0);
      await target.getByRole('tab', { name: '字段表单' }).click();
      await fieldRow(target, 'depot').waitFor();
      await target.getByRole('tab', { name: '编译产物 JSON Schema' }).click();
      const second = await versionOf(2);
      expect(JSON.parse((await target.getByTestId('compiled-json-schema').textContent())!)).toEqual(second.compiled);
      await target.getByRole('tab', { name: '数据定义 DSL' }).click();
      expect(JSON.parse((await target.getByTestId('definition-dsl').textContent())!)).toEqual(second.definition);
      await target.getByLabel('查看的版本').selectOption('1');
      await target.getByTestId('static-facts').filter({ hasText: 'v1' }).waitFor();
      await treeField(target, 'routeNo').waitFor();
      expect(await treeField(target, 'depot').count()).toBe(0);
    });

    it('静态数据定义（P1 票据 14、17）：详情页复制成新的数据定义，要换名称；卡片能搜索、能删除', async () => {
      const target = await asAdmin(), name = '胸牌', path = enc(name), copy = `胸牌副本${randomUUID().slice(0, 8)}`;
      const original = (await adminApi('GET', `/v1/static-schemas/${path}/versions/1`)).body.definition;
      await target.goto(`${baseUrl}/console/#/static-schemas/${path}/1`);
      await target.getByRole('button', { name: '复制为新的数据定义' }).click();
      const form = target.getByRole('form', { name: '复制为新的数据定义' });
      await form.getByLabel('名称', { exact: true }).fill(name);
      await form.getByRole('button', { name: '复制', exact: true }).click();
      await form.getByText('没有复制').waitFor();
      await form.getByLabel('名称', { exact: true }).fill(copy);
      await form.getByLabel('显示名称').fill('胸牌的副本');
      await form.getByRole('button', { name: '复制', exact: true }).click();
      await target.getByRole('heading', { name: '胸牌的副本', level: 1 }).waitFor();
      await target.getByTestId('definition-meta').filter({ hasText: '还没发布过' }).waitFor();
      const document = JSON.parse((await adminApi('GET', `/v1/definitions/${enc(copy)}`)).body.content);
      expect(document).toMatchObject({ name: copy, displayName: '胸牌的副本', fields: original.fields });
      expect(document.version, '数据定义不带版本号').toBeUndefined();

      // 卡片：字段数、发布状态、搜索；删除要确认。
      await (await nav(target, '数据定义')).click();
      const card = definitionCard(target, copy);
      expect(await card.getByTestId('definition-fields').textContent()).toBe(String(original.fields.length));
      expect(await card.getByTestId('definition-state').textContent()).toBe('还没发布过');
      await target.getByLabel('搜索数据定义').fill('没有这个');
      await target.getByTestId('definitions-empty').filter({ hasText: '没有匹配的数据定义' }).waitFor();
      await target.getByLabel('搜索数据定义').fill('胸牌的');
      await card.waitFor();
      await card.getByRole('button', { name: '删除' }).click();
      await card.getByRole('button', { name: '确认删除' }).click();
      await card.waitFor({ state: 'detached' });
      expect((await adminApi('GET', `/v1/definitions/${enc(copy)}`)).status).toBe(404);
    });

    it('数据定义（P1 票据 06、14、17）：新建空白数据定义，手动添加九种字段类型并发布成 v1；名称写错定位到那一行；别人先保存时读回；发布之后接着改；删除不影响已发布的版本', async () => {
      const target = await asAdmin(), name = `全字段${randomUUID().slice(0, 8)}`, path = enc(name);
      await target.goto(`${baseUrl}/console/#/definitions`);
      // 新建用弹窗（M362）：焦点落在名称上；Esc、取消、点背后的遮罩都关掉，什么也不建，焦点回到按钮；服务端拒绝时错误显示在弹窗里。
      const opener = target.getByRole('button', { name: '新建数据定义' }), dialog = target.getByRole('dialog', { name: '新建数据定义' });
      await opener.click();
      await dialog.waitFor();
      expect(await target.evaluate('document.activeElement.id')).toBe('new-definition-name');
      await target.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
      expect(await target.evaluate('document.activeElement.textContent')).toBe('新建数据定义');
      await opener.click();
      await dialog.getByRole('button', { name: '取消' }).click();
      await dialog.waitFor({ state: 'detached' });
      await opener.click();
      await dialog.waitFor();
      await target.mouse.click(8, 300);
      await dialog.waitFor({ state: 'detached' });
      await opener.click();
      await target.getByLabel('名称', { exact: true }).fill('线路牌');
      await dialog.getByRole('button', { name: '新建', exact: true }).click();
      await dialog.getByText('没有新建').waitFor();
      await target.getByLabel('名称', { exact: true }).fill(name);
      await target.getByLabel('显示名称', { exact: true }).fill('九种字段');
      await dialog.getByRole('button', { name: '新建', exact: true }).click();
      await target.getByRole('heading', { name: '九种字段', level: 1 }).waitFor();
      await target.getByTestId('definition-meta').filter({ hasText: '还没发布过' }).waitFor();
      await target.getByText('还没有字段，添加第一个。').waitFor();
      await checkPassed(target);

      await addField(target, { displayName: '标题', name: 'title', type: '文本', required: true }, async (form) => {
        await form.getByLabel('最短（字）', { exact: true }).fill('1');
        await form.getByLabel('最长（字）', { exact: true }).fill('20');
        // 可选值列表（M390）：一项一个输入框。打字就算启用；回车加一项，焦点到新的一项；空的项不进文档。
        const choice = (n: number) => form.getByLabel(`可选值 第 ${n} 项`, { exact: true });
        expect(await form.getByRole('button', { name: '添加可选值' }).count(), '没启用时只有一个输入框').toBe(0);
        await choice(1).fill('甲');
        expect(await form.getByLabel('启用可选值').isChecked()).toBe(true);
        await choice(1).press('Enter');
        await choice(2).pressSequentially('乙');
        await form.getByRole('button', { name: '添加可选值' }).click();
        await expect.poll(() => choice(3).evaluate((element) => element === element.ownerDocument.activeElement), { message: '焦点到新的一项' }).toBe(true);
        // 重复的当场提示；空的一项按退格删掉，焦点回到上一项。
        await choice(3).fill('甲');
        await form.getByTestId('enum-row').nth(2).getByRole('alert').filter({ hasText: '和前面的重复了' }).waitFor();
        await choice(3).fill('');
        expect(await form.getByTestId('enum-row').nth(2).getByRole('alert').count()).toBe(0);
        await choice(3).press('Backspace');
        expect(await form.getByTestId('enum-row').count()).toBe(2);
        // 粘贴多行拆成多项；上下移动；删除一项。
        await choice(2).fill('');
        await target.evaluate(`(() => {
          const data = new DataTransfer();
          data.setData('text', '乙\\r\\n丙\\n\\n丁');
          document.querySelector('input[aria-label="可选值 第 2 项"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        })()`);
        expect(await form.getByTestId('enum-row').locator('input').evaluateAll((items) => items.map((item) => (item as unknown as { value: string }).value))).toEqual(['甲', '乙', '丙', '丁']);
        await form.getByRole('button', { name: '下移可选值 第 1 项' }).click();
        await form.getByRole('button', { name: '删除可选值 第 4 项' }).click();
        await form.getByRole('button', { name: '删除可选值 第 3 项' }).click();
        await form.getByRole('button', { name: '下移可选值 第 1 项' }).click();
        expect(await form.getByRole('button', { name: '上移可选值 第 1 项' }).isDisabled()).toBe(true);
        expect(await form.getByRole('button', { name: '下移可选值 第 2 项' }).isDisabled()).toBe(true);
        expect(await choice(1).inputValue()).toBe('甲');
        expect(await choice(2).inputValue()).toBe('乙');
        const choiceText = fieldRow(target, 'title').getByTestId('field-constraints');
        expect(await choiceText.textContent()).toContain('甲、乙');
        // 取消勾选：这条约束没了，回到一个空的输入框；再打字又启用。
        await form.getByLabel('启用可选值').uncheck();
        expect(await form.getByTestId('enum-row').count()).toBe(1);
        expect(await choice(1).inputValue()).toBe('');
        expect(await choiceText.textContent()).not.toContain('甲');
        await choice(1).fill('甲');
        await choice(1).press('Enter');
        await choice(2).pressSequentially('乙');
        expect(await choiceText.textContent()).toContain('甲、乙');
        // 可选约束（M379）：打字就算启用，取消勾选就去掉这条，勾上时焦点到输入框。
        const limits = fieldRow(target, 'title').getByTestId('field-constraints');
        expect(await form.getByLabel('启用最短（字）').isChecked()).toBe(true);
        expect(await limits.textContent()).toContain('1–20 字');
        await form.getByLabel('启用最短（字）').uncheck();
        expect(await form.getByLabel('最短（字）', { exact: true }).inputValue()).toBe('');
        expect(await limits.textContent()).toContain('最多 20 字');
        await form.getByLabel('启用最短（字）').check();
        expect(await target.evaluate('document.activeElement.id')).toBe('field-minLength');
        await form.getByLabel('最短（字）', { exact: true }).fill('1');
        expect(await limits.textContent()).toContain('1–20 字');
        // 必填开关不被字段拉宽：底色到最后一个按钮为止（M362）。
        expect(await form.getByRole('group', { name: '必填状态' }).evaluate((group) => group.getBoundingClientRect().right - group.lastElementChild!.getBoundingClientRect().right)).toBeLessThan(4);
      });
      await addField(target, { displayName: '金额', name: 'amount', type: '数值' }, async (form) => {
        await form.getByLabel('下限', { exact: true }).fill('0.5');
        await form.getByLabel('上限', { exact: true }).fill('100');
        expect(await form.getByLabel('可选值 第 1 项', { exact: true }).getAttribute('inputmode'), '数值枚举用数字键盘').toBe('decimal');
      });
      await addField(target, { displayName: '日期', name: 'day', type: '日期' });
      await addField(target, { displayName: '时刻', name: 'at', type: '时刻' });
      await addField(target, { displayName: '时间', name: 'moment', type: '时间' });
      await addField(target, { displayName: '启用', name: 'enabled', type: '布尔' });
      await addField(target, { displayName: '照片', name: 'photo', type: '图片' }, (form) => form.getByLabel('网址', { exact: true }).uncheck());
      await addField(target, { displayName: '标签', name: 'tags', type: '列表' }, async (form) => {
        await form.getByLabel('最多项数', { exact: true }).fill('3');
        await form.getByLabel('元素最长（字）', { exact: true }).fill('4');
        expect(await form.getByLabel('元素可选值 第 1 项', { exact: true }).count(), '列表元素也是同一个组件').toBe(1);
      });
      await addField(target, { displayName: '站点', name: 'stops', type: '列表' }, async (form) => {
        await form.getByLabel('元素类型', { exact: true }).selectOption({ label: '数据定义引用' });
        await form.getByLabel('元素引用的数据定义', { exact: true }).selectOption({ value: '停靠站点@1' });
      });
      await addField(target, { displayName: '下一站', name: 'next', type: '数据定义引用' }, async (form) => { await form.getByLabel('引用的数据定义', { exact: true }).selectOption({ value: '停靠站点@1' }); });
      expect(await fieldRow(target, 'photo').getByTestId('field-constraints').textContent()).toBe('资源仓库');
      expect(await fieldRow(target, 'tags').getByTestId('field-type').textContent()).toBe('列表 · 文本');
      expect(await fieldRow(target, 'tags').getByTestId('field-constraints').textContent()).toBe('最多 3 项，最多 4 字');
      expect(await fieldRow(target, 'next').getByTestId('field-type').textContent()).toBe('数据定义引用 · 停靠站点 v1');
      await target.getByTestId('field-kinds').filter({ hasText: '10 个字段' }).filter({ hasText: '列表 2' }).waitFor();

      // 名称写错的字段：问题定位到那一行，没写完也能存。
      await addField(target, { displayName: '写错的', name: '1bad', type: '文本' });
      await saveDraft(target);
      await fieldRow(target, '1bad').getByTestId('field-problems').filter({ hasText: '字段名称必须以英文字母开头' }).waitFor();
      await target.getByTestId('check-status').filter({ hasText: '严重问题' }).waitFor();
      await openField(target, '1bad');
      // 没发布过、没有模板读的字段：直接删，不问，撤销就回来（M379）。
      await target.getByRole('button', { name: '删除字段', exact: true }).click();
      await fieldRow(target, '1bad').waitFor({ state: 'detached' });
      expect(await target.getByRole('dialog').count()).toBe(0);
      await target.getByRole('button', { name: '撤销' }).click();
      await fieldRow(target, '1bad').waitFor();
      await fieldRow(target, '1bad').getByRole('button', { name: /^删除字段/ }).click();
      await fieldRow(target, '1bad').waitFor({ state: 'detached' });
      await saveDraft(target);
      await checkPassed(target);

      const document = JSON.parse((await adminApi('GET', `/v1/definitions/${path}`)).body.content);
      expect(document.fields.map((field: any) => field.type)).toEqual(['text', 'number', 'date', 'time', 'datetime', 'boolean', 'image', 'list', 'list', 'ref']);
      expect(document.fields[0].constraints).toEqual({ required: true, minLength: 1, maxLength: 20, enum: ['甲', '乙'] });
      expect(document.fields[1].constraints).toEqual({ min: 0.5, max: 100 });
      expect(document.fields[6].constraints).toEqual({ allowedSources: ['resource'] });
      expect(document.fields[7]).toMatchObject({ items: { type: 'text', constraints: { maxLength: 4 } }, constraints: { maxItems: 3 } });
      expect(document.fields[8].items).toEqual({ type: 'ref', ref: { name: '停靠站点', version: 1 } });
      expect(document.fields[9].ref).toEqual({ name: '停靠站点', version: 1 });

      // 上移一行、切必填、复制一行：保存之后才写。
      await fieldRow(target, 'enabled').getByRole('button', { name: /^上移字段/ }).click();
      await fieldRow(target, 'day').getByTestId('field-required').click();
      await fieldRow(target, 'day').getByRole('button', { name: /^复制字段/ }).click();
      await fieldRow(target, 'dayCopy').waitFor();
      await saveDraft(target);
      const moved = JSON.parse((await adminApi('GET', `/v1/definitions/${path}`)).body.content).fields as any[];
      expect(moved.map((field) => field.name).slice(2, 7)).toEqual(['day', 'dayCopy', 'at', 'enabled', 'moment']);
      expect(moved[2].constraints).toEqual({ required: true });
      await fieldRow(target, 'dayCopy').getByRole('button', { name: /^删除字段/ }).click();
      await fieldRow(target, 'dayCopy').waitFor({ state: 'detached' });
      await saveDraft(target);

      // 树状图上拖动节点排序，能撤销；点节点选中，拖过不算点；放大缩小（M380）。
      await target.getByRole('button', { name: '树状图' }).click();
      const mapOrder = () => target.getByTestId('tree-field').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-field')!));
      const mapBefore = await mapOrder();
      const firstBox = (await treeField(target, mapBefore[0]!).boundingBox())!, secondBox = (await treeField(target, mapBefore[1]!).boundingBox())!;
      await target.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      await target.mouse.down();
      await target.mouse.move(firstBox.x + firstBox.width / 2, secondBox.y + secondBox.height / 2 + 2, { steps: 8 });
      await target.mouse.up();
      await expect.poll(mapOrder).toEqual([mapBefore[1], mapBefore[0], ...mapBefore.slice(2)]);
      await target.getByTestId('save-status').filter({ hasText: '有没保存的改动' }).waitFor();
      // 松手就停：之后再移动鼠标，节点不跟着走。
      expect(await target.locator('.map-field.dragging').count()).toBe(0);
      const droppedAt = () => treeField(target, mapBefore[1]!).boundingBox();
      await target.waitForTimeout(400); // 等节点滑到位
      const dropped = await droppedAt();
      await target.mouse.move(firstBox.x + 200, firstBox.y + 120, { steps: 4 });
      expect(await droppedAt()).toEqual(dropped);
      await target.getByRole('button', { name: '撤销' }).click();
      await expect.poll(mapOrder).toEqual(mapBefore);
      await treeField(target, mapBefore[1]!).getByRole('button').click();
      expect(await inspector(target).getByLabel('字段名称', { exact: true }).inputValue()).toBe(mapBefore[1]);
      // 拖空白处平移，松手就停：之后再移动鼠标，图不跟着走（M380）。
      const layerAt = () => target.evaluate(`document.querySelector('.map-layer').style.transform`) as Promise<string>;
      const canvas = (await target.locator('.map-canvas').boundingBox())!, startedAt = await layerAt();
      await target.mouse.move(canvas.x + 40, canvas.y + canvas.height / 2);
      await target.mouse.down();
      await target.mouse.move(canvas.x + 90, canvas.y + canvas.height / 2 + 20, { steps: 4 });
      await target.mouse.up();
      const panned = await layerAt();
      expect(panned).not.toBe(startedAt);
      await target.mouse.move(canvas.x + 300, canvas.y + 60, { steps: 4 });
      expect(await layerAt()).toBe(panned);
      await target.getByRole('button', { name: '适合窗口' }).click();
      const widthOf = async () => (await treeField(target, mapBefore[0]!).boundingBox())!.width;
      const fitted = await widthOf();
      await target.getByRole('button', { name: '缩小' }).click();
      await expect.poll(widthOf).toBeLessThan(fitted);
      await target.getByRole('button', { name: '适合窗口' }).click();
      await expect.poll(widthOf).toBeCloseTo(fitted, 0);
      await target.getByRole('button', { name: '表单', exact: true }).click();
      await checkPassed(target);

      // 别人先保存了：这次改动没有写入，读回最新内容再改。
      const current = (await adminApi('GET', `/v1/definitions/${path}`)).body;
      const other = await world.call('PUT', `/v1/definitions/${path}?expectedSha256=${current.sha256}`, world.b.admin.token, current.content.replace('"九种字段"', '"九种字段（别人改的）"'), { 'content-type': 'application/json' });
      expect(other.status, other.raw.slice(0, 300)).toBe(200);
      await openField(target, 'day');
      await inspector(target).getByLabel('说明', { exact: true }).fill('不会写入');
      await target.getByRole('button', { name: '保存', exact: true }).click();
      await target.getByRole('alert').filter({ hasText: '别人刚保存过这个数据定义' }).waitFor();
      expect((await adminApi('GET', `/v1/definitions/${path}`)).body.sha256).toBe(other.body.sha256);
      await target.getByRole('button', { name: '读回最新内容' }).click();
      await target.getByRole('heading', { name: '九种字段（别人改的）', level: 1 }).waitFor();
      expect(await target.getByRole('alert').count()).toBe(0);
      expect(await inspector(target).getByLabel('说明', { exact: true }).inputValue(), '读回之后不留没写入的内容').toBe('');
      await target.getByTestId('save-status').filter({ hasText: '已保存' }).waitFor();
      await checkPassed(target);

      // 首个版本：没有数据集与模板，发布记录写首个版本；发布的产物能再被开放 API 读出。
      await target.getByRole('button', { name: '发布为 v1' }).click();
      await target.getByTestId('publish-confirm').getByText('可以发布', { exact: true }).waitFor();
      await target.getByTestId('dataset-impact').filter({ hasText: '这是首个版本' }).waitFor();
      await target.getByTestId('template-impact').filter({ hasText: '还没有模板用这个数据定义' }).waitFor();
      await target.getByRole('button', { name: '发布为 v1' }).click();
      await publicationRow(target, name, 1).getByTestId('publication-summary').filter({ hasText: '首个版本，10 个字段' }).waitFor();
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/1`)).status).toBe(200);

      // 发布不影响数据定义（ADR-0030）：卡片写已发布的版本，点开接着改。
      await (await nav(target, '数据定义')).click();
      const card = definitionCard(target, name);
      await card.getByTestId('definition-state').filter({ hasText: '已发布 v1' }).waitFor();
      expect(await card.getByTestId('definition-fields').textContent()).toBe('10');
      await card.getByRole('link').first().click();
      await target.getByTestId('definition-meta').filter({ hasText: '已发布 v1' }).waitFor();
      expect(await target.getByText('草案').count(), '页面上没有"草案"这个东西').toBe(0);

      // 删除数据定义：已发布的版本不受影响，标来源已删除；名称不能再用。
      await target.locator('.check-bar').getByRole('button', { name: '删除', exact: true }).click();
      await target.getByRole('button', { name: '确认删除', exact: true }).click();
      await target.getByRole('heading', { name: '数据定义', level: 1 }).waitFor();
      await definitionCard(target, name).waitFor({ state: 'detached' });
      expect((await adminApi('GET', `/v1/definitions/${path}`)).status).toBe(404);
      expect((await adminApi('GET', `/v1/static-schemas/${path}/versions/1`)).body).toMatchObject({ sourceDeleted: true });
      expect((await adminApi('POST', '/v1/definitions', { name, displayName: '再建一次' })).status).toBe(409);
      await (await nav(target, '静态数据定义')).click();
      const orphan = versionCard(target, name, 1);
      await orphan.getByTestId('source-deleted').filter({ hasText: '来源已删除' }).waitFor();
      await orphan.click({ button: 'right' });
      expect(await menuLabels(target)).toEqual(['打开', '在新标签页打开', '查看发布记录', '导出编译产物 JSON Schema', '复制引用', '复制为新的数据定义']);
      await target.keyboard.press('Escape');
      await orphan.getByRole('link').click();
      await target.getByTestId('static-facts').filter({ hasText: 'v1 · 当前' }).waitFor();
      await target.getByTestId('static-source').filter({ hasText: '数据定义已删除' }).waitFor();
      expect(await target.getByRole('link', { name: '打开数据定义' }).count()).toBe(0);
      await target.goto(`${baseUrl}/console/#/definitions/${path}`);
      await target.getByText('已发布的版本还在').waitFor();
    });

    it('数据定义（P1 票据 06、14）：客户操作员只读，看得到内容、版本与发布记录，没有任何写入口；直接调用写接口被拒绝', async () => {
      const name = '线路牌', path = enc(name), drafted = (await adminApi('GET', `/v1/definitions/${path}`)).body;
      await page.goto(`${baseUrl}/console/#/definitions`);
      const card = definitionCard(page, name);
      await card.waitFor();
      expect(await page.getByRole('button', { name: '新建数据定义' }).count()).toBe(0);
      expect(await card.getByRole('button', { name: '删除' }).count() + await card.getByRole('link', { name: '发布', exact: true }).count()).toBe(0);
      expect(await card.getByTestId('definition-state').textContent()).toBe('已发布 2026-08');

      // 字段表与校验结果都看得到，检查器是只读的。
      await card.getByRole('link').first().click();
      await page.getByTestId('definition-meta').filter({ hasText: '已发布 2026-08' }).waitFor();
      await page.getByRole('note').filter({ hasText: '改动与发布由客户管理员完成' }).waitFor();
      await checkPassed(page);
      await openField(page, 'routeNo');
      await page.getByTestId('field-used-by').filter({ hasText: ROUTE }).waitFor();
      expect(await page.getByRole('complementary', { name: '字段检查器' }).locator('input, select, textarea').count()).toBe(0);
      for (const label of ['添加字段', '删除', '保存', '撤销', '回到已保存', '确认删除字段']) expect(await page.getByRole('button', { name: label }).count(), label).toBe(0);
      expect(await page.getByRole('button', { name: /^(发布|复制字段|删除字段)/ }).count()).toBe(0);
      expect(await page.getByLabel('显示名称', { exact: true }).getAttribute('readonly')).not.toBeNull();
      await page.getByRole('button', { name: '编译产物' }).click();
      await page.getByTestId('compiled-preview').waitFor();
      await page.getByRole('button', { name: '树状图' }).click();
      await page.getByTestId('map-status').waitFor();
      expect(await page.getByTestId('map-status').textContent()).not.toContain('拖动');

      // 静态数据定义也一样：右键没有复制，详情页也没有。
      await page.goto(`${baseUrl}/console/#/static-schemas`);
      const version = versionCard(page, name, 1);
      await version.click({ button: 'right' });
      expect(await menuLabels(page)).toEqual(['打开', '在新标签页打开', '查看发布记录', '导出编译产物 JSON Schema', '复制引用', '打开这个数据定义']);
      await page.keyboard.press('Escape');
      expect(await page.getByRole('menu').count()).toBe(0);
      await version.getByRole('link').click();
      await page.getByTestId('static-facts').filter({ hasText: 'v1' }).waitFor();
      expect(await page.getByRole('button', { name: '复制为新的数据定义' }).count()).toBe(0);

      // 发布这一步：只说明由谁来做，不发预检。
      await page.goto(`${baseUrl}/console/#/definitions/${path}/publish`);
      await page.getByText('发布由客户管理员完成').waitFor();
      expect(await page.getByRole('button', { name: /^发布/ }).count()).toBe(0);

      // 发布记录：谁、改动摘要与哈希都看得到。
      await page.goto(`${baseUrl}/console/#/definition-publications`);
      const v2 = publicationRow(page, name, 2);
      await v2.getByTestId('publication-actor').filter({ hasText: world.b.admin.email }).waitFor();
      await publicationRow(page, name, 1).getByRole('button').first().click();
      await page.getByTestId('publication-detail').locator('[data-sha256]').first().waitFor();

      // 权限以开放 API 为准。
      const operator = world.b.operator.token;
      expect((await world.call('POST', '/v1/definitions', operator, { name: '新的', displayName: '新的' })).status).toBe(403);
      expect((await world.call('POST', `/v1/definitions/${path}/publish`, operator, { expectedSha256: drafted.sha256 })).status).toBe(403);
    });

    it('打开绑定的字段（P1 票据 08、13、14）：地址带 field 时选中那个字段；数据定义进编辑页，静态版本进只读页', async () => {
      const target = await asAdmin(), name = '胸牌', path = enc(name);
      await target.goto(`${baseUrl}/console/#/definitions/${path}?field=fullName`);
      await target.reload();
      await inspector(target).waitFor();
      expect(await inspector(target).getByLabel('字段名称', { exact: true }).inputValue()).toBe('fullName');
      expect(await fieldRow(target, 'fullName').getByRole('button').first().getAttribute('aria-pressed')).toBe('true');
      await target.goto(`${baseUrl}/console/#/static-schemas/${path}/1?field=fullName`);
      await target.reload();
      await target.getByTestId('field-facts').filter({ hasText: 'fullName' }).waitFor();
      expect(await treeField(target, 'fullName').getByRole('button').getAttribute('aria-pressed')).toBe('true');
    });

    it('下拉（M362）：下拉框是同一个箭头，选项样式同模块下拉；选别的项，宽度不跳，值照旧写回', async () => {
      const target = await asAdmin();
      await target.goto(`${baseUrl}/console/#/definitions`);
      const sort = target.locator('.list-sort select');
      await sort.waitFor();
      const look = () => target.evaluate(`(() => {
        const select = document.querySelector('.list-sort select'), style = getComputedStyle(select), options = [...select.options].map((option) => { const own = getComputedStyle(option); return [option.value, own.minHeight, own.backgroundColor, own.fontWeight]; });
        return { supported: CSS.supports('appearance', 'base-select'), appearance: style.appearance, arrow: style.backgroundImage, width: select.getBoundingClientRect().width, options, picker: getComputedStyle(select, '::picker(select)').backgroundColor };
      })()`) as Promise<{ supported: boolean; appearance: string; arrow: string; width: number; options: [string, string, string, string][]; picker: string }>;
      const shown = await look();
      expect(shown.arrow).toContain('svg');
      expect(shown.appearance).toBe(shown.supported ? 'base-select' : 'none');
      if (shown.supported) {
        expect(shown.picker).toBe('rgb(253, 252, 248)');
        expect(shown.options[0]).toEqual(['updated', '34px', 'rgb(238, 230, 216)', '600']);
        expect(shown.options[1]).toEqual(['oldest', '34px', 'rgba(0, 0, 0, 0)', '400']);
      }
      await sort.selectOption('name');
      expect(await sort.inputValue()).toBe('name');
      expect((await look()).width).toBe(shown.width);
    });

    it('灵动小图（P1 票据 15）：空状态的小图在动，减少动态时停在完成态；校验通过有印章；用量的天平按用量倾斜', async () => {
      const target = await asAdmin(), name = '胸牌', path = enc(name);
      await target.goto(`${baseUrl}/console/#/definitions`);
      await target.getByLabel('搜索数据定义').fill('没有这个');
      await target.getByTestId('definitions-empty').locator('svg.motif').waitFor();
      const motion = () => target.evaluate(`(() => { const style = getComputedStyle(document.querySelector('[data-testid="definitions-empty"] svg.motif .m-write')); return [style.animationName, style.strokeDashoffset]; })()`) as Promise<string[]>;
      const titleThread = () => target.evaluate(`getComputedStyle(document.querySelector('.title-row h1'), '::after').backgroundImage`) as Promise<string>;
      expect((await motion())[0]).toBe('m-write');
      expect(await titleThread()).toContain('keyframes');
      try {
        await target.emulateMedia({ reducedMotion: 'reduce' });
        expect(await motion()).toEqual(['none', '0px']);
        expect(await titleThread()).not.toContain('keyframes');
      } finally {
        await target.emulateMedia({ reducedMotion: 'no-preference' });
      }

      await target.goto(`${baseUrl}/console/#/static-schemas`);
      await target.getByLabel('搜索静态数据定义').fill('没有这个');
      await target.getByTestId('versions-empty').locator('svg.motif-graph').waitFor();

      await target.goto(`${baseUrl}/console/#/definitions/${path}`);
      await target.reload();
      await checkPassed(target);
      await target.getByTestId('check-status').locator('svg.motif-seal').waitFor();

      await target.goto(`${baseUrl}/console/#/usage`);
      await target.getByTestId('usage-limit').waitFor();
      const { images } = (await adminApi('GET', '/v1/usage')).body;
      expect(await target.getByTestId('usage-beam').getAttribute('data-tilt')).toBe(String(Math.round((Math.min((images.used + images.reserved) / Math.max(images.limit, 1), 1) - .5) * 24)));
    });

    it('登录页（P1 票据 15）：右边是没有声音、没有控件的视频，不放说明文字；减少动态时只放封面，窄窗口不放；密码可以显示', async () => {
      const open = async (options: { viewport?: { width: number; height: number }; reducedMotion?: 'reduce' }) => {
        const opened = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 900 }, locale: 'zh-CN', ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}) });
        const tab = await opened.newPage();
        await tab.goto(`${baseUrl}/console/`);
        await tab.getByRole('button', { name: '登录' }).waitFor();
        return { opened, tab };
      };
      const { opened, tab } = await open({});
      try {
        const video = await tab.evaluate(`(() => { const v = document.querySelector('.login-art video'); return { muted: v.muted, autoplay: v.autoplay, loop: v.loop, controls: v.controls, src: v.getAttribute('src'), poster: v.getAttribute('poster') }; })()`) as { muted: boolean; autoplay: boolean; loop: boolean; controls: boolean; src: string; poster: string };
        expect(video).toMatchObject({ muted: true, autoplay: true, loop: true, controls: false });
        const whole = await tab.request.get(`${baseUrl}${video.src}`), part = await tab.request.get(`${baseUrl}${video.src}`, { headers: { range: 'bytes=0-99' } });
        expect([whole.status(), whole.headers()['content-type']]).toEqual([200, 'video/mp4']);
        expect([part.status(), (await part.body()).length]).toEqual([206, 100]);
        expect((await tab.request.get(`${baseUrl}${video.poster}`)).headers()['content-type']).toBe('image/jpeg');
        expect(await tab.getByText('账号由平台管理员开通').count() + await tab.getByText('出图控制台：').count()).toBe(0);
        const password = tab.getByLabel('密码');
        await password.fill('看得见');
        expect(await password.getAttribute('type')).toBe('password');
        await tab.getByRole('button', { name: '显示' }).click();
        expect(await password.getAttribute('type')).toBe('text');
      } finally {
        await opened.close();
      }
      const still = await open({ reducedMotion: 'reduce' });
      expect([await still.tab.locator('.login-art video').count(), await still.tab.locator('.login-art img').count()]).toEqual([0, 1]);
      await still.opened.close();
      const narrow = await open({ viewport: { width: 375, height: 800 } });
      expect(await narrow.tab.locator('.login-art').count()).toBe(0);
      expect(await narrow.tab.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth')).toBe(0);
      await narrow.opened.close();
    });

    /** 代建工程师经开放 API：在这个数据定义上加一个字段，发布。开着审批策略时答 202。 */
    const engineerPublish = async (name: string, field: string) => {
      const url = `/v1/authoring/tenants/${world.b.id}/definitions/${enc(name)}`, token = world.b.engineer.token;
      const opened = await world.call('GET', url, token);
      expect(opened.status, opened.raw.slice(0, 300)).toBe(200);
      const document = JSON.parse(opened.body.content);
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
      await (await nav(target, '静态数据定义')).click();
      await target.getByRole('navigation', { name: '静态数据定义' }).getByRole('link', { name: '发布记录' }).click();
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
      await detail.getByTestId('request-stale').filter({ hasText: `当前修订已不是申请时的 ${second.baseRevision}` }).filter({ hasText: '点"标为过期"收掉它' }).waitFor();
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
      await target.getByTestId('publish-confirm').getByText(`发布后出图读修订 ${first + 1}`).waitFor();
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
      interface Reply { problems?: unknown; layout: { output: { width: number; height: number }; root: { path: string; x: number; y: number; width: number; height: number; children?: Reply['layout']['root'][] } } }
      /** 等一次工作副本预览；有上一次改动的预览还在路上时，只等请求内容对得上的。 */
      const worked = (match: (body: { template: string; dataset: { id?: string; inline?: unknown } }) => boolean = () => true) => target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.request().method() === 'POST' && response.status() === 200
        && match(response.request().postDataJSON() as never), { timeout: 60_000 });
      /** 等这次改动的预览：先等写回工作副本，再等写回之后发出的那一次预览。 */
      const afterStash = () => {
        // 两个监听都在动作之前注册；浏览器可能在 PUT 的回调抵达测试进程前就发出了预览请求。
        const saved = target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
        const preview = target.waitForRequest((request) => request.url().endsWith('/v1/previews?workingCopies=true') && request.method() === 'POST', { timeout: 60_000 });
        return Promise.all([saved, preview]).then(async ([, request]) => (await request.response())!);
      };
      const image = () => target.getByTestId('preview-image');
      const inspector = () => target.getByRole('complementary', { name: '检查器' });
      const side = () => target.getByRole('complementary', { name: '结构与变量' });
      const fieldOf = (key: string) => inspector().locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const input = (key: string) => fieldOf(key).locator('input[type="text"]').first();
      const documentNow = async (name = ALL) => JSON.parse((await server('GET', `/v1/templates/${enc(name)}/working-copy`, token)).body.content as string) as Record<string, unknown>;
      /** 做一次改动：等预览回来、图变了，再读工作副本，核对 checkDslDocument 没有严重问题。 */
      const edit = async (action: () => Promise<unknown>, name = ALL) => {
        const before = await image().getAttribute('src');
        const preview = afterStash();
        await action();
        const reply = await (await preview).json() as Reply;
        await expect.poll(() => image().getAttribute('src'), { message: `预览随之变化；预览回答的问题：${JSON.stringify(reply.problems ?? []).slice(0, 400)}`, timeout: 10_000 }).not.toBe(before);
        const document = await documentNow(name);
        expect(checkDslDocument(document).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
        return { document, reply };
      };

      // 压测数据是名字里写了压测的数据集，工具栏单独列一组。
      expect((await server('POST', `/v1/datasets/badge-zhang/copies`, token, { id: 'badge-stress', name: '压测：长姓名' })).status).toBe(201);

      // 只看不改（模板设计页票据 01）：不开工作副本，离开之后审计里也没有。
      await (await nav(target, '模板')).click();
      const looked = worked((body) => body.template === ALL);
      await target.getByRole('article', { name: `模板 ${ALL}` }).getByRole('link', { name: '设计' }).click();
      await looked;
      await image().waitFor();
      expect((await server('GET', copyUrl, token)).status, '只看不开工作副本').toBe(404);
      await (await nav(target, '模板')).click();
      await target.getByRole('article', { name: `模板 ${ALL}` }).waitFor();
      expect((await server('GET', copyUrl, token)).status, '离开之后也没有').toBe(404);
      const events = (await server('GET', '/v1/audit-events?limit=200', token)).body.events as { action: string; object: { id: string } }[];
      expect(events.filter((event) => event.action.startsWith('templateWorkingCopy.') && event.object.id === ALL), '只看不改不留审计').toEqual([]);

      // 从模板列表进设计页：打开就有草稿预览，操作员看不到这个入口（下面单独核对）。
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
      };
      const chooseRow = async (path: string) => {
        await side().getByRole('tab', { name: '结构' }).click();
        await side().locator(`[data-testid="structure-row"][data-path="${path}"]`).getByRole('button').first().click();
        await inspector().locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
      };

      // 点选：选中框与元素路径显示在图上，属性面板打开它在模板文档里的位置。
      await clickElement(at('文字'));
      expect(await target.getByTestId('select-box').getAttribute('data-path')).toBe(at('文字'));
      expect(await target.getByTestId('design-scope').getAttribute('data-path')).toBe(at('文字'));
      expect(await target.getByTestId('select-tag').textContent()).toMatch(/^文字 · [\d.]+ × [\d.]+ mm$/);
      expect(await inspector().getByTestId('properties').getAttribute('data-type')).toBe('text');
      // 属性面板按元素类型分组（方案第 7 节的表），先后也照它。
      for (const group of ['内容', '文字', '适配', '位置与尺寸', '显示', '状态样式']) await inspector().getByRole('region', { name: group }).waitFor();
      expect(await inspector().getByTestId('properties').locator('section > h3').allTextContents(), '状态样式在顶上（票据 17），不再是一组').toEqual(['基本', '内容', '文字', '适配', '位置与尺寸', '显示']);
      expect(await inspector().locator('details').count(), '没有"其他 N 项"').toBe(0);
      expect(await input('place.left').inputValue()).toBe('2');

      // 每种元素改一项属性。text：字号断开绑定，当前值 5 变成字面值，图不变；再改成 8。
      await expect.poll(() => fieldOf('fontSize').getByTestId('bound-chip').textContent()).toContain('5');
      const unbound = afterStash();
      await fieldOf('fontSize').getByTestId('unbind-button').click();
      await unbound;
      expect(await input('fontSize').inputValue(), '断开时当前值变成字面值').toBe('5');
      let { document, reply } = await edit(() => input('fontSize').fill('8'));
      const elementIn = (doc: Record<string, unknown>, name: string) => (doc['artboard'] as { children: Record<string, unknown>[] }).children.find((child) => child['name'] === name)!;
      expect(elementIn(document, '文字')['fontSize']).toBe(8);
      layout = reply.layout;

      await chooseRow(at('容器'));
      expect(await inspector().getByTestId('properties').getAttribute('data-type')).toBe('container');
      ({ document } = await edit(() => input('fill').fill('#DDEEFF')));
      expect(elementIn(document, '容器')['fill']).toBe('#DDEEFF');

      await chooseRow(at('循环'));
      ({ document } = await edit(() => inspector().getByLabel('每项高', { exact: true }).fill('4')));
      expect(elementIn(document, '循环')['itemLayout']).toMatchObject({ heights: { fixed: 4 } });

      await chooseRow(at('调用'));
      ({ document } = await edit(() => input('opacity').fill('0.5')));
      expect(elementIn(document, '调用')['opacity']).toBe(0.5);

      await clickElement(at('图片'));
      ({ document } = await edit(() => input('opacity').fill('0.4')));
      expect(elementIn(document, '图片')['opacity']).toBe(0.4);

      await clickElement(at('二维码'));
      ({ document } = await edit(() => input('foreground').fill('#B4532A')));
      expect(elementIn(document, '二维码')['foreground']).toBe('#B4532A');

      await clickElement(at('条码'));
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
      await target.getByTestId('unsaved-count').filter({ hasText: '已保存' }).waitFor();
      expect(await target.getByTestId('save-failure').count()).toBe(0);
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill']).toBe('#FFEEDD');
      // Ctrl+S 立刻写回，不等暂存的延迟。
      await input('fill').fill('#FFEEDE');
      const flushed = target.waitForRequest((request) => request.method() === 'PUT' && request.url().includes('/working-copy?'));
      await target.keyboard.press('Control+s');
      await flushed;
      await target.getByTestId('unsaved-count').filter({ hasText: '已保存' }).waitFor();
      expect(await target.getByRole('button', { name: '保存', exact: true }).isDisabled(), '都保存了，没什么可点').toBe(true);

      // 改了没点保存就离开先问（M383）：改动已暂存，不会丢；保存按钮还能点。换页与退出登录都问，答否留在这一页。
      await input('fill').fill('#FFEEE0');
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存，未保存' }).waitFor();
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill'], '已经暂存').toBe('#FFEEE0');
      expect(await target.getByRole('button', { name: '保存', exact: true }).isDisabled()).toBe(false);
      const question = '这些改动已经暂存，下次打开还在，但你还没点保存。确定离开？', crumb = target.locator('nav.crumbs').getByRole('link', { name: '模板', exact: true });
      const asked: string[] = [], answerNo = () => { target.once('dialog', (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); }); };
      answerNo();
      await crumb.click();
      await expect.poll(() => asked).toEqual([question]);
      await expect.poll(() => target.evaluate('decodeURIComponent(location.hash)')).toBe(`#/templates/${ALL}/design`);
      expect(await input('fill').inputValue()).toBe('#FFEEE0');
      answerNo();
      await target.getByRole('button', { name: '退出', exact: true }).click();
      await expect.poll(() => asked).toEqual([question, question]);
      await inspector().getByTestId('properties').waitFor();
      // 答是：走得了，改动留在工作副本里，下次打开还在。
      target.once('dialog', (dialog) => { void dialog.accept(); });
      await crumb.click();
      await target.getByRole('heading', { name: '模板', level: 1 }).waitFor();
      expect(((await documentNow())['artboard'] as Record<string, unknown>)['fill']).toBe('#FFEEE0');
      await target.goBack();
      await target.getByTestId('unsaved-count').filter({ hasText: '已保存' }).waitFor();
      await chooseRow(ALL);
      expect(await input('fill').inputValue()).toBe('#FFEEE0');
      // 点了保存、或者改回上次保存的内容，都不再问：走到模板列表再回来。
      await input('fill').fill('#FFEEE1');
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存，未保存' }).waitFor();
      await target.getByRole('button', { name: '保存', exact: true }).click();
      await target.getByTestId('unsaved-count').filter({ hasText: '已保存' }).waitFor();
      await input('fill').fill('#FFEEE2');
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存，未保存' }).waitFor();
      await input('fill').fill('#FFEEE1');
      await target.getByTestId('unsaved-count').filter({ hasText: '已保存' }).waitFor();
      await crumb.click();
      await target.getByRole('heading', { name: '模板', level: 1 }).waitFor();
      expect(asked, '这次没问').toEqual([question, question]);
      await target.goBack();
      await chooseRow(ALL);
      expect(await input('fill').inputValue()).toBe('#FFEEE1');

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
      const sampleCard = (id: string) => target.locator(`[data-testid="sample-card"][data-id="${id}"]`);
      await sampleCard('').click();
      await blank;
      await target.getByTestId('final-mode-note').filter({ hasText: /正式出图时不出图：有 \d+ 个严重问题/ }).waitFor();
      const again = worked((body) => body.dataset.id === 'badge-zhang');
      await sampleCard('badge-zhang').click();
      layout = (await (await again).json() as Reply).layout;
      await image().waitFor();
      await target.getByTestId('final-mode-note').filter({ hasText: /没有问题|没有问题边框/ }).waitFor();
      expect(await target.getByRole('group', { name: '压测' }).getByTestId('sample-card').count(), '名字里写了压测的单独一组').toBe(1);
      expect(await target.getByRole('group', { name: '压测' }).getByTestId('sample-card').textContent()).toContain('压测：长姓名');
      const stress = worked((body) => body.dataset.id === 'badge-stress');
      await sampleCard('badge-stress').click();
      await stress;
      await sampleCard('badge-zhang').click();
      await image().waitFor();
      const width = (await target.getByTestId('design-canvas').boundingBox())!.width;
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByRole('button', { name: '放大' }).click();
      await target.getByTestId('zoom-level').filter({ hasText: '244%' }).waitFor();
      await expect.poll(async () => (await target.getByTestId('design-canvas').boundingBox())!.width).toBeGreaterThan(width * 1.9);
      await target.getByRole('group', { name: '工具' }).getByRole('button', { name: '平移' }).click();
      const stage = target.getByTestId('design-stage');
      const canvasAt = async () => { const box = (await target.getByTestId('design-canvas').boundingBox())!; return box.x + box.y; };
      const stageBox = (await stage.boundingBox())!, before = await canvasAt();
      await target.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
      await target.mouse.down();
      await target.mouse.move(stageBox.x + stageBox.width / 2 - 80, stageBox.y + stageBox.height / 2 - 120, { steps: 3 });
      await target.mouse.up();
      expect(await canvasAt(), '拖动挪动舞台上的图').toBeLessThan(before);
      const pathBefore = await inspector().getByTestId('properties').getAttribute('data-path');
      expect(pathBefore).toBe(ALL);
      await target.keyboard.press('v');
      await target.getByRole('group', { name: '工具' }).getByRole('button', { name: '选择' }).and(target.locator('[aria-pressed="true"]')).waitFor();
      await target.getByTestId('zoom-level').click();
      await image().waitFor();
      await expect.poll(async () => Math.round((await target.getByTestId('design-canvas').boundingBox())!.width)).toBeLessThan(width * 1.1);
      // 滚轮以光标为锚缩放，Ctrl+0 回到适应；Ctrl+\ 收起面板，适应按腾出来的空隙算。
      await target.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
      await target.mouse.wheel(0, -400);
      await expect.poll(async () => (await target.getByTestId('zoom-level').textContent()) !== '100%').toBe(true);
      await target.keyboard.press('Control+0');
      await target.getByTestId('zoom-level').filter({ hasText: '100%' }).waitFor();
      await target.keyboard.press('Control+\\');
      await expect.poll(() => side().count()).toBe(0);
      expect(await inspector().count()).toBe(0);
      await target.keyboard.press('Control+\\');
      await side().waitFor();
      await inspector().waitFor();

      // 右键菜单：复制元素路径、在结构中定位、打开绑定的字段；没有 Agent 与评论。
      await target.getByTestId('design-canvas').click({ button: 'right', position: await positionOf(at('文字')) });
      const menu = target.getByTestId('element-menu');
      await menu.getByRole('menuitem', { name: '复制元素路径' }).waitFor();
      expect(await menu.getByRole('menuitem', { name: '打开绑定的字段 fullName' }).getAttribute('href')).toBe(`#/definitions/${enc('胸牌')}?field=fullName`);
      expect(await menu.textContent()).not.toMatch(/Agent|评论/);
      await menu.getByRole('menuitem', { name: '在结构中定位' }).click();
      await side().getByRole('tab', { name: '结构', selected: true }).waitFor();
      expect(await side().locator(`[data-testid="structure-row"][data-path="${at('文字')}"]`).getAttribute('data-selected')).toBe('true');
      // 结构与预览双向：结构里选一行，图上出现它的框。
      await side().locator(`[data-testid="structure-row"][data-path="${at('矩形')}"]`).getByRole('button').first().click();
      await target.locator(`[data-testid="select-box"][data-path="${at('矩形')}"]`).waitFor();
      await target.getByTestId('design-canvas').click({ button: 'right', position: await positionOf(at('椭圆')) });
      await menu.getByRole('menuitem', { name: '复制元素路径' }).click();
      await target.getByRole('status').filter({ hasText: at('椭圆') }).waitFor();

      // 检查器：所选元素相关的检查项（经派生变量连带）、适配规则，改写回。
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('文字')) });
      await inspector().locator('[data-testid="check-row"][data-name="姓名太长"]').waitFor();
      expect(await inspector().locator('[data-testid="check-row"][data-name="没有照片"]').count(), '文字没有用照片').toBe(0);
      // 适配收成一行（第三轮票据 04），点开才是编辑器。
      await inspector().getByTestId('fit-summary').click();
      await inspector().getByTestId('fit-hint').filter({ hasText: '画板的 2 mm' }).waitFor();
      expect(await input('fit.compressMin').inputValue()).toBe('0.7');
      await input('fit.compressMin').fill('0.8');
      await expect.poll(async () => elementIn(await documentNow(), '文字')['fit']).toMatchObject({ compressMin: 0.8 });
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('图片')) });
      await inspector().locator('[data-testid="check-row"][data-name="没有照片"]').waitFor();
      // 竖排的文字才有缩字组：写了组名，同组的元素列出来。
      await target.getByTestId('design-canvas').click({ position: await positionOf(at('文字')) });
      await fieldOf('writingMode').getByRole('button', { name: '竖排' }).click();
      await inspector().getByTestId('fit-summary').click();
      await fieldOf('fit.widthOverflow').getByRole('button', { name: '添加' }).click();
      await input('fit.widthOverflow.shrinkGroup').fill('站名组');
      await inspector().getByTestId('shrink-group').filter({ hasText: '缩字组 站名组：文字' }).waitFor();
      await expect.poll(async () => (elementIn(await documentNow(), '文字')['fit'] as { widthOverflow?: unknown }).widthOverflow).toEqual({ shrinkGroup: '站名组' });
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      expect(checkDslDocument(await documentNow()).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
      // 三步一起撤销：组名、添加缩字组、改竖排。
      for (let step = 0; step < 3; step++) await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => elementIn(await documentNow(), '文字')['writingMode']).toBeUndefined();

      // 变量页：对外参数与内部参数，改缺省值预览跟着变；约束按类型；加一个参数，撤销后没了。
      await side().getByRole('tab', { name: '变量' }).click();
      const parameter = (name: string) => side().locator(`[data-testid="parameter-row"][data-name="${name}"]`);
      await side().getByRole('region', { name: '内部参数' }).locator('[data-testid="parameter-row"][data-name="bandHeight"]').waitFor();
      await parameter('accentColor').getByRole('button').first().click();
      ({ document } = await edit(() => input('default').fill('#0B4EA2')));
      expect((document['parameters'] as Record<string, unknown>[]).find((item) => item['name'] === 'accentColor')).toMatchObject({ default: '#0B4EA2' });
      await parameter('nameSize').getByRole('button').first().click();
      await input('displayName').fill('姓名大小');
      await input('constraints.max').fill('20');
      await expect.poll(async () => (await documentNow())['parameters']).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'nameSize', displayName: '姓名大小', constraints: { min: 3, max: 20 } })]));
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      await side().getByLabel('新参数的名称').fill('footnote');
      await side().getByRole('button', { name: '添加参数' }).click();
      await parameter('footnote').waitFor();
      await expect.poll(async () => ((await documentNow())['parameters'] as unknown[]).length).toBe(4);
      await target.getByTestId('unsaved-count').filter({ hasText: '已暂存' }).waitFor();
      await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => ((await documentNow())['parameters'] as unknown[]).length).toBe(3);

      // 结构页打开子模板：预览仍是调用它的模板，改子模板时那张图跟着变；图上点到子模板的元素也切过去。
      await side().getByRole('tab', { name: '结构' }).click();
      await openRow(side().locator(`[data-testid="structure-row"][data-path="${at('循环')}"]`), '循环');
      await side().locator('[data-testid="structure-row"][data-path="场次条/场次名称"]').first().getByRole('button').first().click();
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/场次条/design?in=${ALL}`);
      await inspector().locator('[data-testid="properties"][data-path="场次条/场次名称"]').waitFor();
      const child = afterStash();
      await input('fontSize').fill('4');
      expect(((await child).request().postDataJSON() as { template: string }).template).toBe(ALL);
      await expect.poll(async () => JSON.stringify(await documentNow('场次条'))).toContain('"fontSize":4');
      await target.locator('nav.crumbs').getByRole('link', { name: ALL }).click();
      await inspector().waitFor();
      await target.getByTestId('design-canvas').click({ position: await positionOf(`${at('调用')}/场次名称`) });
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/场次条/design?in=${ALL}`);
      await inspector().locator('[data-testid="properties"][data-path="场次条/场次名称"]').waitFor();
      expect(await target.getByTestId('design-scope').getAttribute('data-path')).toBe(`${at('调用')}/场次名称`);
      // 跨模板撤销：撤回子模板上的字号。
      await target.getByRole('button', { name: '撤销', exact: true }).click();
      await expect.poll(async () => JSON.stringify(await documentNow('场次条'))).toContain('"fontSize":3.2');
      await target.locator('nav.crumbs').getByRole('link', { name: ALL }).click();

      // 发布修订：差异里有这些改动，保存为新修订，回到列表不再有工作副本。
      await target.getByRole('button', { name: '发布修订' }).click();
      await target.getByRole('heading', { name: '发布修订 2', level: 1 }).waitFor();
      await target.locator(`[data-testid="change"][data-path="${at('椭圆')}"]`).waitFor();
      await target.getByTestId('compare-working-copy').getByRole('img').waitFor({ timeout: PREVIEW_WINDOW_MS });
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
      await target.getByTestId('compare-working-copy').getByRole('img').waitFor({ timeout: PREVIEW_WINDOW_MS });
      expect(await target.getByTestId('compare-current').count(), '没有当前修订可比').toBe(0);
      await target.getByRole('button', { name: '发布为修订 1' }).click();
      await target.getByRole('status').filter({ hasText: '已保存为修订 1' }).waitFor();
      expect((await server('GET', `/v1/templates/${enc(copied)}`, token)).body.currentRevision).toBe(1);

      // 窄窗口：面板默认收起，页面不横向滚动，操作条还能把面板打开。
      await target.setViewportSize({ width: 420, height: 800 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.reload();
      await image().waitFor();
      expect(await side().count()).toBe(0);
      expect(await target.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
      await target.getByRole('button', { name: '检查器面板' }).click();
      await inspector().waitFor();
      await target.setViewportSize({ width: 1440, height: 1000 });

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

    it('模板设计（票据 04）：点第 12 站的站名，范围条写定义在站点、图上 35 处；Alt 穿透、右键列层叠、Esc 与 Enter；隐藏的元素写明原因', async () => {
      const ROOT = '标准线路单边', stop = (index: number) => `${ROOT}/站点面板/站点列[${index}]/名称区/站名`;
      const target = await asAdmin();
      interface Node { path: string; x: number; y: number; width: number; height: number; children?: Node[] }
      const replied = target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.status() === 200, { timeout: 60_000 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      const { layout } = await (await replied).json() as { layout: { output: { width: number; height: number }; root: Node } };
      const canvas = target.getByTestId('design-canvas');
      await target.getByTestId('preview-image').waitFor();
      const position = async (path: string) => {
        const walk = (node: Node): Node | undefined => (node.path === path ? node : node.children?.map(walk).find(Boolean));
        const box = (await canvas.boundingBox())!, node = walk(layout.root)!;
        return { x: ((node.x + node.width / 2) / layout.output.width) * box.width, y: ((node.y + node.height / 2) / layout.output.height) * box.height };
      };
      const scope = target.getByTestId('design-scope');
      const scopeAt = (path: string) => expect.poll(() => scope.getAttribute('data-path')).toBe(path);
      /** 范围条从左到右是根到叶：路径的第一段在最左边。 */
      const scopeLeftToRight = async () => { const lefts = await scope.locator('.scope-segment').evaluateAll((items) => items.map((item) => item.getBoundingClientRect().left)); expect(lefts).toEqual([...lefts].sort((a, b) => a - b)); };
      const inspector = () => target.getByRole('complementary', { name: '检查器' });

      // 没选中：检查器是画板。
      await inspector().locator(`[data-testid="properties"][data-type="artboard"]`).waitFor();
      await scopeAt(ROOT);

      await canvas.click({ position: await position(stop(12)) });
      await scopeAt(stop(12));
      await scopeLeftToRight();
      expect(await scope.getAttribute('data-count')).toBe('35');
      expect(await scope.textContent()).toContain('定义在 站点，图上 35 处，这是第 12 处，改一处全改');
      await inspector().locator('[data-testid="properties"][data-path="站点/名称区/站名"]').waitFor();
      await inspector().getByTestId('design-impact').filter({ hasText: '这里改的是模板「站点」，图上 35 处一起变' }).waitFor();
      expect(await target.locator('.select-box.other').count(), '其余 34 处是虚线框').toBe(34);
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/站点/design?in=${ROOT}`);

      // 结构树跨模板：选中时展开到那一行，循环项数、状态标记都在；树上悬停标出全部实例；只读不开工作副本。
      const side0 = target.getByRole('complementary', { name: '结构与变量' });
      const nameRow = side0.locator('[data-testid="structure-row"][data-path="站点/名称区/站名"]');
      await nameRow.waitFor();
      expect(await nameRow.getAttribute('data-selected')).toBe('true');
      expect(await nameRow.textContent()).toContain('状态');
      expect(await side0.locator(`[data-testid="structure-row"][data-path="${ROOT}/站点面板/站点列"]`).getByTestId('loop-count').textContent()).toBe('×35');
      expect(await side0.locator('[data-testid="structure-row"][data-path="站点/名称区/地标"]').getByTestId('row-hidden').count(), '地标在有些站显示').toBe(0);
      await side0.getByRole('button', { name: '进入模板「站点」 · 每项的数据：停靠站点 v1（stops 的一项）' }).waitFor();
      await side0.locator(`[data-testid="structure-row"][data-path="${ROOT}/道路带"]`).hover();
      await expect.poll(() => target.getByTestId('hover-box').count()).toBeGreaterThan(0);
      await nameRow.hover();
      await expect.poll(() => target.getByTestId('hover-box').count(), { message: '35 处都标出来' }).toBeGreaterThanOrEqual(35);
      await target.getByTestId('design-scope').hover();
      for (const template of ['站点', '标识图标', '道路段', '班次时刻']) expect((await server('GET', `/v1/templates/${enc(template)}/working-copy`, world.b.admin.token)).status, `${template} 没开工作副本`).toBe(404);
      // 树上点一行，图上出现它的框，检查器跟着走。
      await side0.locator(`[data-testid="structure-row"][data-path="${ROOT}/站点面板/站点列"]`).getByRole('button').first().click();
      await inspector().locator(`[data-testid="properties"][data-path="${ROOT}/站点面板/站点列"]`).waitFor();
      await canvas.click({ position: await position(stop(12)) });
      await scopeAt(stop(12));

      // 上下层：Esc 到名称区，再到这一项，再到循环容器，再回到站名。
      await target.keyboard.press('Escape');
      await scopeAt(`${ROOT}/站点面板/站点列[12]/名称区`);
      await target.keyboard.press('Escape');
      await scopeAt(`${ROOT}/站点面板/站点列[12]`);
      await target.keyboard.press('Escape');
      await scopeAt(`${ROOT}/站点面板/站点列`);
      await expect.poll(() => decodeURIComponent(new URL(target.url()).hash)).toBe(`#/templates/${enc(ROOT) && ROOT}/design`);
      await target.keyboard.press('Enter');
      await scopeAt(`${ROOT}/站点面板/站点列[1]`);

      // Alt + 点：沿层叠穿透。
      await canvas.click({ position: await position(stop(12)) });
      await scopeAt(stop(12));
      await canvas.click({ position: await position(stop(12)), modifiers: ['Alt'] });
      await scopeAt(`${ROOT}/站点面板/站点列[12]/名称区`);

      // 范围条的路径能点。
      await scope.getByRole('button', { name: '站点面板' }).click();
      await scopeAt(`${ROOT}/站点面板`);

      // 右键：这里的元素，从最深到画板。
      await canvas.click({ button: 'right', position: await position(stop(12)) });
      const menu = target.getByTestId('element-menu');
      const stack = await menu.getByTestId('stack-item').allTextContents();
      expect(stack[0]).toContain('站名');
      expect(stack.at(-1)).toContain(ROOT);
      await menu.getByTestId('stack-item').filter({ hasText: '名称区' }).click();
      await scopeAt(`${ROOT}/站点面板/站点列[12]/名称区`);

      // 点舞台空白处取消选中，回到画板。
      await target.mouse.click((await target.getByTestId('design-stage').boundingBox())!.x + 320, (await target.getByTestId('design-stage').boundingBox())!.y + 30);
      await expect.poll(() => scope.getAttribute('data-count')).toBe('0');

      // 叠加层（票据 06）：只画不出图。结构框、数据与固定内容；选中容器时的排布参考线。
      const layer = (name: string) => target.getByRole('group', { name: '叠加层' }).getByRole('button', { name });
      const before = await target.getByTestId('preview-image').getAttribute('src');
      await layer('结构').click();
      await expect.poll(() => target.getByTestId('structure-box').count()).toBeGreaterThan(100);
      await layer('结构').click();
      await layer('数据').click();
      await expect.poll(() => target.getByTestId('data-box').count()).toBeGreaterThan(35);
      expect(await target.getByTestId('fixed-box').count(), '开往箭头这类图形不算，固定文字算').toBeGreaterThan(0);
      await target.getByTestId('overlay-legend').filter({ hasText: '灰底是数据驱动' }).waitFor();
      await layer('数据').click();
      await canvas.click({ position: await position(`${ROOT}/顶栏/运营方`) });
      await target.keyboard.press('Escape');
      await scopeAt(`${ROOT}/顶栏`);
      await expect.poll(() => target.getByTestId('guide-gap').count(), { message: '顶栏是横向堆叠' }).toBeGreaterThan(0);
      await expect.poll(() => target.getByTestId('guide-pad').count()).toBeGreaterThan(0);
      await target.keyboard.press('Escape');
      await scopeAt(ROOT);
      await expect.poll(() => target.getByTestId('guide-track').count(), { message: '根模板是四行的网格' }).toBe(3);
      expect(await target.getByTestId('guide-label').allTextContents()).toEqual(['34 mm', '1 份', '10 mm', '21 mm', '1 份']);
      expect(await target.getByTestId('preview-image').getAttribute('src'), '叠加层不重新出图').toBe(before);

      // 适配层：M402 有 7 处被压缩，最低 65%；50 站的压测数据有放不下的。结论和布局摘要对得上。
      await layer('适配').click();
      await expect.poll(() => target.getByTestId('fit-box').count()).toBe(7);
      await target.getByTestId('overlay-legend').filter({ hasText: '适配：7 处被压缩，最低 65%' }).waitFor();
      const m402 = await server('GET', '/v1/datasets/ds-m402-wanguocheng', world.b.admin.token);
      const fifty = JSON.parse(JSON.stringify(m402.body.content ? JSON.parse(m402.body.content as string) : m402.body)) as { dataset: Record<string, unknown>; data: { stops: { name: string }[] } };
      while (fifty.data.stops.length < 50) { const copy = { ...fifty.data.stops[fifty.data.stops.length % 35]! }; copy.name = `${copy.name}北`; fifty.data.stops.push(copy); }
      fifty.dataset = { id: 'm402-stress-50', name: '压测：50 站', staticSchema: fifty.dataset['staticSchema'] };
      expect((await server('POST', '/v1/datasets', world.b.admin.token, fifty)).status).toBe(201);
      await target.reload();
      await target.getByTestId('preview-image').waitFor();
      const replied50 = target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && (response.request().postDataJSON() as { dataset: { id?: string } }).dataset.id === 'm402-stress-50', { timeout: 60_000 });
      await target.locator('[data-testid="sample-card"][data-id="m402-stress-50"]').click();
      const fiftyLayout = (await (await replied50).json() as { layout: { root: Node } }).layout.root;
      const texts = (node: Node & { text?: { compression: number; overflow: boolean } }): (Node & { text?: { compression: number; overflow: boolean } })[] => [node, ...(node.children ?? []).flatMap(texts)];
      const compressed = texts(fiftyLayout).filter((node) => node.text && node.text.compression < 0.999).length, over = texts(fiftyLayout).filter((node) => node.text?.overflow).length;
      expect(over).toBeGreaterThan(0);
      await layer('适配').click();
      await expect.poll(() => target.getByTestId('overflow-box').count()).toBe(over);
      expect(await target.getByTestId('fit-box').count() + over).toBe(compressed);
      await target.getByTestId('overlay-legend').filter({ hasText: `${compressed} 处被压缩` }).filter({ hasText: `${over} 处放不下` }).waitFor();

      // 隐藏的元素：结构页选中，写明原因，范围条写当前样例不显示。
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' });
      await openRow(side, '顶栏');
      await side.locator(`[data-testid="structure-row"][data-path="${ROOT}/顶栏/线路号"]`).getByRole('button').first().click();
      await inspector().getByTestId('hidden-reason').filter({ hasText: '按变量 noRouteNoImage 决定显示' }).waitFor();
      expect(await scope.textContent()).toContain('当前样例不显示');
    }, 120_000);

    it('模板设计（票据 07）：样例带上换数据、试值、看问题、改动与 DSL；试值不写进模板', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      const copyUrl = `/v1/templates/${enc(ROOT)}/working-copy`;
      const isMain = (response: { url(): string; request(): { method(): string } }) => response.url().endsWith('/v1/previews?workingCopies=true') && response.request().method() === 'POST';
      // 上一个用例也在这一页：先离开，清掉记住的试值，再进来。
      await leaveDesign(target, ROOT);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const card = (id: string) => target.locator(`[data-testid="sample-card"][data-id="${id}"]`);
      // 其他样例依次补一次缩略图；每张卡片都写结论。
      await expect.poll(() => card('ds-m402-wanguocheng').getByTestId('sample-state').textContent(), { timeout: 30_000 }).toMatch(/没有问题|个提示|个严重问题/);
      expect(await card('m402-stress-50').count(), '上一个用例建的压测数据').toBe(1);

      // 试值：改本站序号与画板宽，请求带上试值，工作副本与审计都不动。
      const eventsBefore = ((await server('GET', '/v1/audit-events?limit=200', token)).body.events as unknown[]).length;
      const knob = target.locator('[data-testid="parameter-knob"][data-name="currentIndex"]');
      const withIndex = target.waitForRequest((request) => request.url().endsWith('/v1/previews?workingCopies=true') && (request.postDataJSON() as { parameters: Record<string, unknown> }).parameters['currentIndex'] === 5, { timeout: 30_000 });
      await knob.getByRole('textbox').fill('5');
      await knob.getByRole('textbox').press('Enter');
      await withIndex;
      const withWidth = target.waitForRequest((request) => request.url().endsWith('/v1/previews?workingCopies=true') && (request.postDataJSON() as { output: { width: number } }).output.width === 1000, { timeout: 30_000 });
      const size = target.locator('[data-testid="size-knob"][data-name="width"]');
      await size.getByRole('textbox').fill('1000');
      await size.getByRole('textbox').press('Enter');
      await withWidth;
      expect((await server('GET', copyUrl, token)).status, '试值不开工作副本').toBe(404);
      expect(((await server('GET', '/v1/audit-events?limit=200', token)).body.events as unknown[]).length, '试值不写审计').toBe(eventsBefore);
      await expect.poll(() => card('m402-stress-50').getByTestId('sample-state').textContent()).toMatch(/没重新出|还没出/);
      // 试值记在浏览器里，刷新还在。
      await target.reload();
      await target.getByTestId('preview-image').waitFor();
      expect(await knob.getByRole('textbox').inputValue()).toBe('5');
      await target.getByRole('button', { name: '恢复缺省' }).click();
      await expect.poll(() => knob.getByRole('textbox').inputValue()).toBe('0');

      // 切到 50 站：放不下的问题定位到元素；缺字段的样例定位到变量页。
      const problemsTab = target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: /问题/ });
      const toFifty = target.waitForResponse((response) => isMain(response) && (response.request().postDataJSON() as { dataset: { id?: string } }).dataset.id === 'm402-stress-50', { timeout: 60_000 });
      await card('m402-stress-50').click();
      await toFifty;
      await problemsTab.click();
      await target.getByRole('list', { name: '预览的问题' }).getByRole('button').first().click();
      await expect.poll(() => target.getByTestId('design-scope').getAttribute('data-path')).toMatch(/道路段列\[\d+\]/);
      await card('ds-m402-wanguocheng').count();

      // 改动页：没改时写还没有；改了能看差异，并在图上和当前修订对比。
      const samplesTab = target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: '样例' });
      await samplesTab.click();
      await card('ds-m402-wanguocheng').click();
      const changesTab = target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: /改动/ });
      await changesTab.click();
      await target.getByTestId('tray-changes').getByText('还没有改动').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' });
      await target.locator('nav.crumbs').getByRole('link', { name: ROOT }).click();
      await side.getByRole('tab', { name: '变量' }).click();
      await side.locator('[data-testid="parameter-row"][data-name="primaryColor"]').getByRole('button').first().click();
      const stashed = target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await target.getByRole('complementary', { name: '检查器' }).locator('[data-testid="property-field"][data-key="default"]').first().locator('input[type="text"]').first().fill('#1D6B3C');
      await stashed;
      await target.getByTestId('tray-changes').getByTestId('change').first().waitFor();
      await target.getByRole('button', { name: '在图上对比' }).click();
      await target.getByTestId('compare-clip').getByRole('img').waitFor();
      const bar = (await target.getByTestId('compare-bar').boundingBox())!;
      const clipBefore = (await target.getByTestId('compare-clip').boundingBox())!.width;
      await target.mouse.move(bar.x + 1, bar.y + bar.height / 2);
      await target.mouse.down();
      await target.mouse.move(bar.x - 120, bar.y + bar.height / 2, { steps: 3 });
      await target.mouse.up();
      await expect.poll(async () => (await target.getByTestId('compare-clip').boundingBox())!.width).toBeLessThan(clipBefore);
      await target.getByRole('button', { name: '关掉对比' }).click();
      expect(await target.getByTestId('compare-clip').count()).toBe(0);

      // DSL 页：选中的元素或整份，含改动。
      await target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: 'DSL' }).click();
      await target.getByRole('group', { name: 'DSL 的范围' }).getByRole('button', { name: '整份模板' }).click();
      await expect.poll(() => target.getByTestId('design-dsl').textContent()).toContain('#1D6B3C');
      await target.getByRole('group', { name: 'DSL 的范围' }).getByRole('button', { name: '选中的元素' }).click();
      await expect.poll(() => target.getByTestId('design-dsl').textContent()).toContain('"sizeRange"');

      // 收尾：丢掉工作副本，不影响别的用例。
      expect((await server('DELETE', copyUrl, token)).status).toBe(204);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 08）：变量面板有当前值，悬停标出谁在用；选中变量右边显示它；取值只从接口来', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      await side.getByRole('tab', { name: '变量' }).click();
      const row = (name: string) => side.locator(`[data-name="${name}"]`);
      // 四组都有当前值。
      for (const group of ['字段', '对外参数', '内部参数', '派生变量', '检查项']) await side.getByRole('region', { name: group }).waitFor();
      await expect.poll(() => row('routeNo').textContent()).toContain('M402');
      await expect.poll(() => row('stops').textContent()).toContain('35 项');
      await expect.poll(() => row('stopCount').textContent()).toContain('35');
      await expect.poll(() => row('primaryColor').textContent()).toContain('#FF8000');
      await expect.poll(() => row('本站序号不能超过站点数').textContent()).toContain('未成立');

      // 悬停标出谁在用，连带派生变量。
      await row('stops').hover();
      await expect.poll(() => target.getByTestId('use-box').count()).toBeGreaterThan(0);
      await target.getByTestId('design-scope').hover();
      await expect.poll(() => target.getByTestId('use-box').count()).toBe(0);

      // 选中字段：只读，链到数据定义。
      await row('routeNo').getByRole('button').click();
      const panel = inspector.getByTestId('variable-inspector');
      await panel.filter({ hasText: '字段属于数据定义' }).waitFor();
      expect(await panel.getByRole('link', { name: /打开数据定义/ }).getAttribute('href')).toBe(`#/definitions/${enc('线路牌')}?field=routeNo`);

      // 选中内部参数：改缺省值写进模板，图跟着变；谁在用可以点。
      await row('stopNameSize').getByRole('button').click();
      await inspector.locator('[data-testid="variable-inspector"][data-name="stopNameSize"]').waitFor();
      await inspector.getByTestId('variable-uses').getByRole('button', { name: '站点列' }).waitFor();
      const before = await target.getByTestId('preview-image').getAttribute('src');
      await inspector.locator('[data-testid="property-field"][data-key="default"]').first().locator('input[type="text"]').first().fill('12');
      await expect.poll(() => target.getByTestId('preview-image').getAttribute('src'), { timeout: 15_000 }).not.toBe(before);
      await expect.poll(() => row('stopNameSize').textContent()).toContain('12');

      // 选中元素后右边回到元素；作用域换成它的模板，取值是这一处实例的。
      await inspector.getByTestId('variable-uses').getByRole('button', { name: '站点列' }).click();
      await inspector.locator(`[data-testid="properties"][data-path="${ROOT}/站点面板/站点列"]`).waitFor();

      // 试值让检查项成立：问题定位到检查项，右边显示它。
      const knob = target.locator('[data-testid="parameter-knob"][data-name="currentIndex"]');
      await knob.getByRole('textbox').fill('40');
      await knob.getByRole('textbox').press('Enter');
      await expect.poll(() => row('本站序号不能超过站点数').textContent(), { timeout: 15_000 }).toContain('成立·严重');
      await target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: /问题/ }).click();
      await target.getByRole('list', { name: '预览的问题' }).getByRole('button', { name: /本站序号超过了停靠站点数/ }).click();
      await inspector.locator('[data-testid="variable-inspector"][data-kind="check"]').waitFor();

      // 进到子模板：作用域换了，取值是这一处实例的；派生变量标出命中。
      await target.getByRole('region', { name: '样例带' }).getByRole('tab', { name: '样例' }).click();
      await target.getByRole('button', { name: '恢复缺省' }).click();
      const knobValue = target.locator('[data-testid="parameter-knob"][data-name="currentIndex"]');
      await knobValue.getByRole('textbox').fill('5');
      await knobValue.getByRole('textbox').press('Enter');
      await side.getByRole('tab', { name: '结构' }).click();
      await openRow(side, '站点面板');
      await openRow(side, '站点列');
      await side.locator('[data-testid="structure-row"][data-path="站点/名称区"]').getByRole('button').first().click();
      await side.getByRole('tab', { name: '变量' }).click();
      await row('stopState').getByRole('button').click();
      await inspector.locator('[data-testid="variable-inspector"][data-kind="derived"]').waitFor();
      await inspector.getByTestId('branch-hit').waitFor();

      // 收尾：丢掉工作副本与试值。
      expect((await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token)).status).toBe(204);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 09）：值格能绑定、断开、提取为参数，来源链跳到真正的参数；数值拖标签松手才写回', async () => {
      const ROOT = '标准线路单边', STOP = '站点', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const stopDocument = async () => JSON.parse((await server('GET', `/v1/templates/${enc(STOP)}/working-copy`, token)).body.content as string) as { parameters: { name: string }[]; artboard: unknown };
      /** 站名这个元素在文档里的样子。 */
      const stopName = async () => {
        const find = (node: Record<string, unknown>): Record<string, unknown> | undefined => (node['name'] === '站名' ? node : ((node['children'] ?? []) as Record<string, unknown>[]).map(find).find(Boolean));
        return find((await stopDocument()).artboard as Record<string, unknown>)!;
      };
      await openRow(side, '站点面板');
      await openRow(side, '站点列');
      await openRow(side, '名称区');
      await side.locator('[data-testid="structure-row"][data-path="站点/名称区/站名"]').getByRole('button').first().click();
      await inspector.locator('[data-testid="properties"][data-path="站点/名称区/站名"]').waitFor();

      // 绑定态：显示名称与当前值；值从主模板的内部参数来。
      const size = field('fontSize');
      await expect.poll(() => size.getByTestId('bound-chip').textContent()).toContain('站名字号');
      await expect.poll(() => size.getByTestId('bound-chip').textContent()).toContain('10');
      await expect.poll(() => size.getByTestId('value-origin').textContent()).toBe(`来自 ${ROOT}「站名字号」（内部参数）`);
      // 被状态覆盖：颜色前有圆点，写明哪些取值；字号没有。
      expect(await field('color').getByTestId('state-dot').getAttribute('title')).toContain('已过站、本站');
      expect(await size.getByTestId('state-dot').count()).toBe(0);
      // 不能绑定：字体没有按钮，写明原因。
      expect(await field('font').getByTestId('bind-button').count()).toBe(0);
      await field('font').getByTestId('font-select').focus();
      await field('font').getByTestId('no-binding').filter({ hasText: '用状态样式' }).waitFor();

      // 弹层只列类型相符的变量，分组、带当前值；Esc 关掉，不动选中。
      await field('color').getByTestId('bound-chip').click();
      const popover = field('color').getByTestId('binding-popover');
      const option = (name: string) => popover.locator(`[data-testid="binding-option"][data-name="${name}"]`);
      await option('passedColor').waitFor();
      expect(await option('stopNameSize').count(), '数值不能绑颜色').toBe(0);
      expect(await option('name').count(), '文本不能绑颜色').toBe(0);
      expect(await popover.getByRole('region', { name: '参数' }).count()).toBe(1);
      expect(await option('nameColor').getAttribute('aria-pressed')).toBe('true');
      await target.keyboard.press('Escape');
      expect(await popover.count()).toBe(0);
      await inspector.locator('[data-testid="properties"][data-path="站点/名称区/站名"]').waitFor();

      // 换绑定：写回 { var }。
      await field('color').getByTestId('bound-chip').click();
      const rebound = stashed();
      await option('passedColor').click();
      await rebound;
      expect((await stopName())['color']).toEqual({ var: 'passedColor' });

      // 断开：当前值变成字面值。
      await expect.poll(() => field('color').getByTestId('bound-chip').textContent()).toContain('已过站');
      const cut = stashed();
      await field('color').getByTestId('unbind-button').click();
      await cut;
      expect((await stopName())['color']).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(await field('color').getByTestId('value-cell').getAttribute('data-state')).toBe('literal');

      // 提取为参数：起名可改，存当前值，一步撤销。
      await field('color').getByTestId('bind-button').click();
      await popover.getByRole('button', { name: '提取为参数' }).click();
      const naming = popover.getByRole('form', { name: '提取为参数' });
      expect(await naming.getByLabel('名称', { exact: true }).inputValue()).toBe('color');
      expect(await naming.getByLabel('显示名称').inputValue()).toBe('站名颜色');
      await naming.getByLabel('名称', { exact: true }).fill('passedColor');
      await naming.getByRole('alert').filter({ hasText: '已经有' }).waitFor();
      expect(await naming.getByRole('button', { name: '提取并绑定' }).isDisabled()).toBe(true);
      await naming.getByLabel('名称', { exact: true }).fill('stopTextColor');
      const extracted = stashed();
      await naming.getByRole('button', { name: '提取并绑定' }).click();
      await extracted;
      expect((await stopName())['color']).toEqual({ var: 'stopTextColor' });
      expect((await stopDocument()).parameters.map((item) => item.name)).toContain('stopTextColor');
      await expect.poll(() => field('color').getByTestId('bound-chip').textContent()).toContain('站名颜色');
      const undone = stashed();
      await target.keyboard.press('Control+z');
      await undone;
      expect((await stopDocument()).parameters.map((item) => item.name), '参数和绑定一起撤销').not.toContain('stopTextColor');
      expect((await stopName())['color']).toMatch(/^#/);

      // 拖标签：拖的时候只改显示，松手才写回。
      // 先滚进视野：鼠标不会自己滚，标签在视口外时拖不到它（容器里的字体高，检查器更长）。
      const label = field('letterSpacing').locator('label').first();
      await label.scrollIntoViewIfNeeded();
      const box = (await label.boundingBox())!;
      let writes = 0;
      const countWrites = (request: { method(): string; url(): string }) => { if (request.method() === 'PUT' && request.url().includes('/working-copy?')) writes++; };
      target.on('request', countWrites);
      await target.mouse.move(box.x + 8, box.y + box.height / 2);
      await target.mouse.down();
      await target.mouse.move(box.x + 38, box.y + box.height / 2, { steps: 4 });
      await expect.poll(() => field('letterSpacing').locator('input[type="text"]').first().inputValue()).toBe('3');
      expect(writes, '还没松手').toBe(0);
      const dragged = stashed();
      await target.mouse.up();
      await dragged;
      target.off('request', countWrites);
      expect(writes).toBe(1);
      expect((await stopName())['letterSpacing']).toBe(3);

      // 经循环信息传入的写明是循环序号。
      await side.getByRole('tab', { name: '变量' }).click();
      await side.locator('[data-name="index"]').getByRole('button').click();
      await inspector.getByTestId('value-origin').filter({ hasText: '循环序号，由循环 站点列 传入' }).waitFor();

      // 来源链一键跳过去：右边是主模板的参数。
      await side.locator('[data-name="stopNameSize"]').getByRole('button').click();
      await inspector.getByTestId('value-origin').getByRole('button', { name: `${ROOT}「站名字号」` }).click();
      await inspector.locator('[data-testid="variable-inspector"][data-name="stopNameSize"]').waitFor();
      await expect.poll(() => target.url()).toContain(`/templates/${enc(ROOT)}/design`);
      await inspector.getByTestId('variable-current').waitFor();
      expect(await inspector.getByTestId('value-origin').count(), '值就在这里，不用再说来自哪').toBe(0);

      // 收尾：丢掉工作副本。
      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 10）：检查器按类型分组；竖排适配只给合法步骤并写明这一处的结果；内容插入字段、改格式、片段样式；双击图上文字就地改；字体按族列字重', async () => {
      const ROOT = '标准线路单边', STOP = '站点', NAME_AT = `${ROOT}/站点面板/站点列[12]/名称区/站名`, token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      interface Node { path: string; x: number; y: number; width: number; height: number; children?: Node[] }
      const replied = target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.status() === 200, { timeout: 60_000 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      const { layout } = await (await replied).json() as { layout: { output: { width: number; height: number }; root: Node } };
      await target.getByTestId('preview-image').waitFor();
      const inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const stopName = async () => {
        const document = JSON.parse((await server('GET', `/v1/templates/${enc(STOP)}/working-copy`, token)).body.content as string) as { artboard: Record<string, unknown> };
        const find = (node: Record<string, unknown>): Record<string, unknown> | undefined => (node['name'] === '站名' ? node : ((node['children'] ?? []) as Record<string, unknown>[]).map(find).find(Boolean));
        return find(document.artboard)!;
      };

      // 双击图上的文字：就地打开内容编辑，焦点在里面；打字写回，Esc 收起，选中不动。
      const walk = (node: Node): Node | undefined => (node.path === NAME_AT ? node : node.children?.map(walk).find(Boolean));
      const canvas = target.getByTestId('design-canvas'), box = (await canvas.boundingBox())!, stop = walk(layout.root)!;
      await canvas.dblclick({ position: { x: ((stop.x + stop.width / 2) / layout.output.width) * box.width, y: ((stop.y + stop.height / 2) / layout.output.height) * box.height } });
      const inline = target.getByTestId('inline-text');
      await inline.getByTestId('content-slot').filter({ hasText: '站名' }).waitFor();
      await expect.poll(() => inline.getByTestId('content-gap').last().evaluate((element) => element === element.ownerDocument.activeElement)).toBe(true);
      const typed = stashed();
      await target.keyboard.type('站');
      await typed;
      expect((await stopName())['content']).toEqual([{ slot: 'name' }, { text: '站' }]);
      await target.keyboard.press('Escape');
      expect(await inline.count()).toBe(0);
      await expect.poll(() => target.getByTestId('design-scope').getAttribute('data-path')).toBe(NAME_AT);

      // 按类型分组，没有"其他 N 项"；片段是字段，不是 JSON。
      await inspector.locator('[data-testid="properties"][data-path="站点/名称区/站名"]').waitFor();
      expect(await inspector.getByTestId('properties').locator('section > h3').allTextContents(), '状态样式在顶上（票据 17），不再是一组').toEqual(['基本', '内容', '文字', '适配', '位置与尺寸', '显示']);
      expect(await inspector.locator('details').count()).toBe(0);
      expect(await inspector.getByRole('region', { name: '内容' }).locator('textarea').count()).toBe(0);

      // 字体族与字重两个下拉（第三轮票据 04），值还是资源引用。
      const font = field('font').getByTestId('font-select');
      expect(await field('font').getByTestId('font-family').inputValue()).toBe('hei');
      expect(await font.inputValue()).toBe('res:font-hei-medium');
      expect(await font.locator('option').allTextContents()).toEqual(['Medium', 'Heavy']);

      // 适配收成一行（第三轮票据 04）：规则与这一处的结果；点开才是编辑器。
      const summary = inspector.getByTestId('fit-summary');
      expect(await summary.getByTestId('fit-rule').textContent()).toBe('收紧字距 → 压缩字形 · 缩字组 stopNames');
      await expect.poll(() => summary.getByTestId('fit-here').textContent()).toMatch(/^这一处：(没有压缩|压到 \d+%)，字号 [\d.]+ mm$/);
      expect(await field('fit.steps').count(), '没点开时不列适配的字段').toBe(0);
      await summary.click();
      // 竖排的适配：只有三种步骤，这一处的结果在最后一行；用不上的写明要什么。
      const steps = field('fit.steps').locator('select');
      expect((await steps.locator('option').allTextContents()).filter((label) => !label.startsWith('缺省'))).toEqual(['不适配', '收紧字距', '收紧字距 → 压缩字形']);
      await expect.poll(() => inspector.getByTestId('fit-result').textContent()).toMatch(/^这一处：(没有压缩|压到 \d+%)，字号 [\d.]+ mm，字距 [\d.]+ mm/);
      await inspector.getByTestId('shrink-group').filter({ hasText: '缩字组 stopNames：站名，共 1 个成员' }).waitFor();
      await inspector.getByTestId('fit-mode').filter({ hasText: '竖排' }).waitFor();
      expect(await field('fit.compressMin').locator('input[type="text"]').inputValue()).toBe('0.6');
      const changedSteps = stashed();
      await steps.selectOption({ label: '收紧字距' });
      await changedSteps;
      expect((await stopName())['fit']).toMatchObject({ steps: ['tightenSpacing'] });
      await inspector.getByTestId('fit-off').filter({ hasText: '步骤里有压缩字形才生效' }).waitFor();
      expect(await field('fit.compressMin').count()).toBe(0);
      expect(await summary.getByTestId('fit-rule').textContent(), '摘要跟着改').toBe('收紧字距 · 缩字组 stopNames');
      // 竖排不能倾斜：这一项不列出来（第三轮票据 04）。
      expect(await field('slant').count()).toBe(0);

      // 内容：打 / 选字段，只列能显示成文字的，光标跟着走。
      const editor = inspector.getByTestId('content-editor');
      await editor.getByTestId('content-text').click();
      await target.keyboard.press('End');
      await target.keyboard.press('/');
      const picker = editor.getByTestId('slot-picker');
      await picker.getByRole('textbox').waitFor();
      expect(await picker.locator('[data-name="nameColor"]').count(), '颜色不能显示成文字').toBe(0);
      await picker.getByRole('textbox').fill('index');
      const withSlot = stashed();
      await target.keyboard.press('Enter');
      await withSlot;
      expect((await stopName())['content']).toEqual([{ slot: 'name' }, { text: '站' }, { slot: 'index' }]);
      // 选字段时按 Esc：就是打了一个 /。
      await editor.getByTestId('content-gap').last().click();
      await target.keyboard.press('/');
      await picker.getByRole('textbox').waitFor();
      const slashed = stashed();
      await target.keyboard.press('Escape');
      await slashed;
      expect((await stopName())['content']).toEqual([{ slot: 'name' }, { text: '站' }, { slot: 'index' }, { text: '/' }]);
      expect(await inspector.getByTestId('properties').count(), 'Esc 没有变成选上一层').toBe(1);
      // 退格删掉 / 这段，光标回到空位。
      const unslashed = stashed();
      await target.keyboard.press('Backspace');
      await unslashed;
      expect((await stopName())['content']).toEqual([{ slot: 'name' }, { text: '站' }, { slot: 'index' }]);

      // 点插槽改展示格式：不合法的不写回，当场说明。
      await editor.locator('[data-testid="content-slot"][data-slot="index"]').click();
      const piece = editor.getByTestId('piece-popover');
      const format = piece.getByLabel('展示格式');
      await format.fill('HH:mm');
      await piece.getByTestId('format-problem').filter({ hasText: '含时分秒' }).waitFor();
      await format.fill('xx');
      await piece.getByTestId('format-problem').filter({ hasText: '不是可用的格式符' }).waitFor();
      await target.waitForTimeout(800);
      expect(((await stopName())['content'] as unknown[])[2], '不合法的没写回').toEqual({ slot: 'index' });
      const formatted = stashed();
      await piece.getByTestId('format-presets').getByRole('button', { name: '0.00' }).click();
      await formatted;
      expect(((await stopName())['content'] as unknown[])[2]).toEqual({ slot: 'index', format: '0.00' });
      await editor.locator('[data-testid="content-slot"][data-slot="index"]').filter({ hasText: '0.00' }).waitFor();
      // 文本字段不带格式。
      await editor.locator('[data-testid="content-slot"][data-slot="name"]').click();
      await piece.getByTestId('format-none').waitFor();
      // 片段样式：竖排没有倾斜。
      expect(await piece.locator('[data-key="content.0.slant"]').count()).toBe(0);
      const sized = stashed();
      await piece.locator('[data-key="content.0.fontSize"]').locator('input[type="text"]').first().fill('8');
      await sized;
      expect(((await stopName())['content'] as unknown[])[0]).toEqual({ slot: 'name', fontSize: 8 });
      // 删除这个插槽。
      await editor.locator('[data-testid="content-slot"][data-slot="index"]').click();
      const removed = stashed();
      await piece.getByRole('button', { name: '删除这个插槽' }).click();
      await removed;
      expect(((await stopName())['content'] as Record<string, unknown>[]).some((item) => item['slot'] === 'index')).toBe(false);

      // 收尾：丢掉工作副本。
      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 12）：结构树上复制、上移、改名、包进容器再拆开、拖进容器、删除，每步一次撤销；重名当场拦下；被多处调用的先确认', async () => {
      const ALL = '全元素牌', ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      const current = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body;
        return JSON.parse(body.content as string) as { artboard: { children: { name: string; type: string; children?: { name: string }[] }[] } };
      };
      const before = await current(ALL);
      const names = async () => (await current(ALL)).artboard.children.map((child) => child.name);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const row = (name: string) => side.locator(`[data-testid="structure-row"][data-path="${ALL}/${name}"]`);
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const selectedPath = () => inspector.getByTestId('properties').getAttribute('data-path');
      await side.getByText('顺序就是 DSL 的顺序').waitFor();

      // 复制：放在原件后面，自动起名，选中副本。
      await row('矩形').getByRole('button').first().click();
      let saved = stashed();
      await target.keyboard.press('Control+d');
      await saved;
      expect(await names()).toContain('矩形2');
      expect((await names()).indexOf('矩形2')).toBe((await names()).indexOf('矩形') + 1);
      await expect.poll(selectedPath).toBe(`${ALL}/矩形2`);

      // 上移：顺序就是 DSL 的顺序。
      saved = stashed();
      await target.keyboard.press('Alt+ArrowUp');
      await saved;
      expect((await names()).indexOf('矩形2')).toBe((await names()).indexOf('矩形') - 1);

      // 改名：重名当场拦下，不写回；换个名字就改。
      await target.keyboard.press('F2');
      const input = side.getByTestId('rename-input');
      await input.fill('椭圆');
      await input.press('Enter');
      await side.getByRole('alert').filter({ hasText: '模板内唯一' }).waitFor();
      await input.fill('色块');
      saved = stashed();
      await input.press('Enter');
      await saved;
      expect(await names()).toContain('色块');
      await expect.poll(selectedPath).toBe(`${ALL}/色块`);

      // 右键：包进容器，再拆开。
      await row('色块').click({ button: 'right' });
      saved = stashed();
      await target.getByRole('menu', { name: '元素' }).getByRole('menuitem', { name: '包进容器' }).click();
      await saved;
      const wrapped = (await current(ALL)).artboard.children.find((child) => child.type === 'container' && child.children?.[0]?.name === '色块');
      expect(wrapped?.name, '新容器起了没重的名字').toBe('容器2');
      await row('容器2').click({ button: 'right' });
      saved = stashed();
      await target.getByRole('menu', { name: '元素' }).getByRole('menuitem', { name: '拆开容器' }).click();
      await saved;
      expect(await names()).toContain('色块');
      expect(await names()).not.toContain('容器2');

      // 拖进容器：拖到"容器"那一行的中间。
      const box = (await row('容器').boundingBox())!;
      saved = stashed();
      await row('色块').dragTo(row('容器'), { targetPosition: { x: 40, y: box.height / 2 } });
      await saved;
      const container = (await current(ALL)).artboard.children.find((child) => child.name === '容器')!;
      expect(container.children?.map((child) => child.name)).toContain('色块');

      // 删除：选中回到父容器。
      await side.locator(`[data-testid="structure-row"][data-path="${ALL}/容器/色块"]`).getByRole('button').first().click();
      saved = stashed();
      await target.keyboard.press('Delete');
      await saved;
      expect(JSON.stringify(await current(ALL))).not.toContain('色块');
      await expect.poll(selectedPath).toBe(`${ALL}/容器`);

      // 每步一次撤销：七步撤完，和开始时一样。
      for (let step = 0; step < 7; step++) {
        saved = stashed();
        await target.getByRole('button', { name: '撤销', exact: true }).click();
        await saved;
      }
      expect(await current(ALL)).toEqual(before);

      // 检查器里改名同样拦下重名。
      await row('文字').getByRole('button').first().click();
      const nameInput = inspector.locator('[data-testid="property-field"][data-key="name"]').first().locator('input[type="text"]').first();
      await nameInput.fill('矩形');
      await inspector.locator('[data-testid="property-field"][data-key="name"]').getByRole('alert').filter({ hasText: '模板内唯一' }).waitFor();
      await target.waitForTimeout(800);
      expect(await current(ALL)).toEqual(before);
      await nameInput.fill('文字');

      // 被多处调用的子模板：删站名之前先说清图上几处；不确定就不动。
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ROOT);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      await openRow(side, '站点面板');
      await openRow(side, '站点列');
      await openRow(side, '名称区');
      await side.locator('[data-testid="structure-row"][data-path="站点/名称区/站名"]').getByRole('button').first().click();
      await inspector.locator('[data-testid="properties"][data-path="站点/名称区/站名"]').waitFor();
      const asked: string[] = [];
      target.once('dialog', (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
      await target.keyboard.press('Delete');
      await expect.poll(() => asked).toEqual([expect.stringContaining('图上 35 处')]);
      expect((await server('GET', `/v1/templates/${enc('站点')}/working-copy`, token)).status, '没确定就不动').toBe(404);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 14）：从元素目录点一下加到选中的容器；把字段拖到图上生成绑定好的文字；列表字段选基准相符的模板变循环；拖经结构页签放到树上', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Node = { name: string; type: string; content?: unknown; list?: unknown; template?: string; place?: Record<string, unknown>; children?: Node[] };
      const current = async () => {
        const copy = await server('GET', `/v1/templates/${enc(ROOT)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(ROOT)}/content`, token)).body;
        return JSON.parse(body.content as string) as { artboard: Node };
      };
      const childrenOf = async (name: string) => (await current()).artboard.children!.find((child) => child.name === name)!.children ?? [];
      const before = await current();
      const replied = target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.status() === 200, { timeout: 60_000 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      const { layout } = await (await replied).json() as { layout: { output: { width: number; height: number }; root: { path: string; x: number; y: number; width: number; height: number; children?: unknown[] } } };
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const row = (name: string) => side.locator(`[data-testid="structure-row"][data-path="${ROOT}/${name}"]`);

      // 选中顶栏，到"添加"页：写明加到哪。点矩形，加在顶栏的最后，堆叠里只写尺寸。
      await row('顶栏').getByRole('button').first().click();
      await side.getByRole('tab', { name: '添加' }).click();
      await side.getByTestId('add-target').filter({ hasText: '「顶栏」的最后' }).waitFor();
      let saved = stashed();
      await side.locator('[data-testid="add-element"][data-kind="rect"]').click();
      await saved;
      const top = await childrenOf('顶栏');
      expect(top.at(-1)).toMatchObject({ name: '矩形', type: 'rect', place: { width: { fixed: 20 }, height: { fixed: 10 } } });
      await expect.poll(() => inspector.getByTestId('properties').getAttribute('data-path')).toBe(`${ROOT}/顶栏/矩形`);

      // 字段拖到图上的道路带：生成绑好插槽的文字，名字取显示名称（重名加序号），放进这个模板自己的容器。
      const walk = (node: { path: string; x: number; y: number; width: number; height: number; children?: unknown[] }): typeof node | undefined => (node.path === `${ROOT}/道路带` ? node : (node.children as typeof node[] | undefined)?.map(walk).find(Boolean));
      const road = walk(layout.root)!, canvas = target.getByTestId('design-canvas'), box = (await canvas.boundingBox())!;
      saved = stashed();
      await side.locator('[data-testid="add-field"][data-name="routeNo"]').dragTo(canvas, { targetPosition: { x: ((road.x + road.width / 2) / layout.output.width) * box.width, y: ((road.y + road.height / 2) / layout.output.height) * box.height } });
      await saved;
      const added = (await childrenOf('道路带')).find((child) => child.type === 'text' && JSON.stringify(child.content) === JSON.stringify([{ slot: 'routeNo' }]));
      expect(added?.name, '名字取显示名称，主模板里已有"线路号"，加序号').toBe('线路号2');

      // 列表字段：选基准相符的模板，变成循环容器。
      await side.locator('[data-testid="add-field"][data-name="stops"]').click();
      const form = side.getByRole('form', { name: /从 .* 创建/ });
      expect(await form.getByLabel('被调模板').locator('option').allTextContents(), '道路段的基准也是停靠站点 v1').toEqual(['选一个模板', '站点', '道路段', '+ 新建模板…']);
      await form.getByLabel('被调模板').selectOption('站点');
      saved = stashed();
      await form.getByRole('button', { name: '添加循环容器' }).click();
      await saved;
      expect(JSON.stringify(await current())).toContain('"list":{"var":"stops"},"template":"站点"');

      // 拖经"结构"页签放到树上：椭圆放进底栏。
      const ellipse = side.locator('[data-testid="add-element"][data-kind="ellipse"]');
      const from = (await ellipse.boundingBox())!;
      await target.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await target.mouse.down();
      const tab = (await side.getByRole('tab', { name: '结构' }).boundingBox())!;
      await target.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 5 });
      await row('底栏').waitFor();
      const bottom = (await row('底栏').boundingBox())!;
      saved = stashed();
      await target.mouse.move(bottom.x + 60, bottom.y + bottom.height / 2, { steps: 5 });
      await target.mouse.up();
      await saved;
      expect((await childrenOf('底栏')).some((child) => child.type === 'ellipse')).toBe(true);

      // 四次添加，四次撤销，回到开始的样子。
      for (let step = 0; step < 4; step++) {
        saved = stashed();
        await target.getByRole('button', { name: '撤销', exact: true }).click();
        await saved;
      }
      expect(await current()).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 16）：stopState 的分支编辑器标出命中，改取值、加一支、换条件写法；新建派生变量与检查项，重名拦下；删还在用的先确认', async () => {
      const ROOT = '标准线路单边', STOP = '站点', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Doc = { derived?: { name: string; op: string; branches?: { when: Record<string, unknown>; then: unknown }[] }[]; checks?: { name: string }[] };
      const current = async () => {
        const copy = await server('GET', `/v1/templates/${enc(STOP)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(STOP)}/content`, token)).body;
        return JSON.parse(body.content as string) as Doc;
      };
      const stopState = async () => (await current()).derived!.find((item) => item.name === 'stopState')!;
      const before = await current();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await openRow(side, '站点面板');
      await openRow(side, '站点列');
      await side.locator('[data-testid="structure-row"][data-path="站点/名称区"]').getByRole('button').first().click();
      await side.getByRole('tab', { name: '变量' }).click();
      await side.locator('[data-name="stopState"]').getByRole('button').click();
      const editor = inspector.getByTestId('derived-editor');
      const rows = editor.getByTestId('branch-row');
      await expect.poll(() => rows.count()).toBe(3);
      // 本站序号缺省是 0：第 1 支"普通"成立，高亮。
      await expect.poll(() => rows.nth(0).getAttribute('data-hit')).toBe('true');
      expect(await editor.getByLabel('结果类型').inputValue()).toBe('text');

      // 改取值。
      let saved = stashed();
      await rows.nth(0).getByLabel('第 1 支的取值', { exact: true }).fill('常态');
      await saved;
      await expect.poll(async () => (await stopState()).branches![0]!.then).toEqual({ value: '常态' });

      // 加一支，再去掉。
      saved = stashed();
      await editor.getByRole('button', { name: '加一支' }).click();
      await saved;
      await expect.poll(async () => (await stopState()).branches!.length).toBe(4);
      saved = stashed();
      await editor.getByRole('button', { name: '去掉第 4 支' }).click();
      await saved;
      await expect.poll(async () => (await stopState()).branches!.length).toBe(3);

      // 第 2 支换成"全部成立"。
      saved = stashed();
      await rows.nth(1).getByLabel('第 2 支的写法', { exact: true }).selectOption('all');
      await saved;
      await expect.poll(async () => Object.keys((await stopState()).branches![1]!.when)).toEqual(['all']);

      // 新建派生变量：重名拦下，换个名字就建好并选中。
      await side.getByRole('button', { name: '新建派生变量' }).click();
      const creating = side.getByRole('form', { name: '新建派生变量' });
      await creating.getByLabel('新派生变量的名称').fill('stopState');
      await creating.getByRole('button', { name: '新建' }).click();
      await creating.getByRole('alert').filter({ hasText: '已经有' }).waitFor();
      await creating.getByLabel('新派生变量的名称').fill('stopCount');
      await creating.getByLabel('运算').selectOption({ label: '加' });
      saved = stashed();
      await creating.getByRole('button', { name: '新建' }).click();
      await saved;
      await inspector.locator('[data-testid="variable-inspector"][data-name="stopCount"]').waitFor();
      await editor.getByLabel('算法').waitFor();
      expect((await current()).derived!.map((item) => item.name)).toContain('stopCount');

      // 删还在用的 stopState：先列出谁在用，不确定就不动。
      await side.locator('[data-name="stopState"]').getByRole('button').click();
      const asked: string[] = [];
      target.once('dialog', (dialog) => { asked.push(dialog.message()); void dialog.dismiss(); });
      await inspector.getByRole('button', { name: '删除这个派生变量' }).click();
      await expect.poll(() => asked).toEqual([expect.stringContaining('在用')]);
      expect((await current()).derived!.map((item) => item.name)).toContain('stopState');

      // 没人用的 stopCount 直接删。
      await side.locator('[data-name="stopCount"]').getByRole('button').click();
      saved = stashed();
      await inspector.getByRole('button', { name: '删除这个派生变量' }).click();
      await saved;
      expect((await current()).derived!.map((item) => item.name)).not.toContain('stopCount');

      // 检查项：新建再删掉。
      await side.getByRole('button', { name: '新建检查项' }).click();
      const check = side.getByRole('form', { name: '新建检查项' });
      await check.getByLabel('新检查项的名称').fill('noName');
      saved = stashed();
      await check.getByRole('button', { name: '新建' }).click();
      await saved;
      await inspector.locator('[data-testid="variable-inspector"][data-name="noName"]').waitFor();
      saved = stashed();
      await inspector.getByRole('button', { name: '删除这个检查项' }).click();
      await saved;
      expect((await current()).checks ?? []).toEqual([]);

      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      expect(await current()).toEqual(before);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 15）：循环的表单只列基准相符的模板，传入参数换来源，每项排布的互斥直接禁用并写原因，合并相邻；进入被调模板不离开这张图', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Loop = { name: string; args?: Record<string, unknown>; itemLayout?: Record<string, unknown>; mergeBy?: string; children?: Loop[] };
      const current = async () => {
        const copy = await server('GET', `/v1/templates/${enc(ROOT)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(ROOT)}/content`, token)).body;
        return JSON.parse(body.content as string) as { artboard: Loop };
      };
      const find = (node: Loop, name: string): Loop | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const loopNow = async (name: string) => find((await current()).artboard, name)!;
      const before = await current();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await openRow(side, '站点面板');
      await side.locator(`[data-testid="structure-row"][data-path="${ROOT}/站点面板/站点列"]`).getByRole('button').first().click();
      const form = inspector.getByTestId('loop-form');
      await form.waitFor();

      // 来源：列表是 stops，模板只列基准是停靠站点 v1 的。
      expect(await form.getByLabel('循环的列表').inputValue()).toBe('stops');
      // 模板列表加载完之前只有当前值与新建一项：等它加载完（Docker 里接口慢，直接读会读到半截）。
      await expect.poll(() => form.getByLabel('被调模板').locator('option').allTextContents()).toEqual(['站点', '道路段', '+ 新建模板…']);
      await form.getByText('只列基准是 停靠站点 v1 的').waitFor();

      // 传入参数：一行一个对外参数；换成固定值，再换回变量。
      const args = inspector.getByTestId('args-form'), row = (name: string) => args.locator(`[data-testid="arg-row"][data-name="${name}"]`);
      expect(await row('index').locator('select').first().inputValue(), '序号经循环信息传入').toBe('loop');
      let saved = stashed();
      await row('currentIndex').locator('select').first().selectOption('value');
      await saved;
      expect((await loopNow('站点列')).args!['currentIndex']).toEqual({ value: 0 });
      saved = stashed();
      await row('currentIndex').locator('select').first().selectOption('var');
      await saved;
      expect((await loopNow('站点列')).args!['currentIndex']).toMatchObject({ var: expect.any(String) });

      // 每项排布：等分时折行用不了并写明原因；换随内容后能折行，这时等分用不了。
      const layout = inspector.getByTestId('item-layout-form');
      await layout.getByTestId('wrap-blocked').filter({ hasText: '折行不能配等分' }).waitFor();
      expect(await layout.getByRole('button', { name: '放不下就折行' }).isDisabled()).toBe(true);
      saved = stashed();
      await layout.getByLabel('每项宽的尺寸方式').selectOption('content');
      await saved;
      saved = stashed();
      await layout.getByRole('button', { name: '放不下就折行' }).click();
      await saved;
      expect((await loopNow('站点列')).itemLayout).toMatchObject({ widths: 'content', wrap: true });
      expect(await layout.getByLabel('每项宽的尺寸方式').locator('option[value="equal"]').isDisabled()).toBe(true);
      // 换方向：每项宽跟着换成每项高。
      saved = stashed();
      await layout.getByRole('group', { name: '方向' }).getByRole('button', { name: '纵向' }).click();
      await saved;
      expect((await loopNow('站点列')).itemLayout).toMatchObject({ direction: 'column', heights: 'content' });
      await layout.getByTestId('loop-result').filter({ hasText: /这一处：35 项/ }).waitFor();

      // 合并相邻：道路段列按道路合并，别的尺寸用不了；取消合并，spanBy 一起去掉。
      await openRow(side, '道路带');
      await side.locator(`[data-testid="structure-row"][data-path="${ROOT}/道路带/道路段列"]`).getByRole('button').first().click();
      await inspector.getByTestId('merge-row').waitFor();
      expect(await inspector.getByLabel('合并相邻同值项').inputValue()).toBe('road');
      expect(await inspector.getByTestId('item-layout-form').getByLabel(/^每项(宽|高)的尺寸方式$/).locator('option[value="content"]').isDisabled()).toBe(true);
      await inspector.getByTestId('item-layout-form').getByTestId('wrap-blocked').filter({ hasText: '合并相邻' }).waitFor();
      saved = stashed();
      await inspector.getByLabel('合并相邻同值项').selectOption('');
      await saved;
      const road = await loopNow('道路段列');
      expect(road.mergeBy).toBeUndefined();
      expect(road.itemLayout).not.toHaveProperty('spanBy');

      // 进入被调模板：选中它的画板，图还是这一张。
      await inspector.getByTestId('enter-template').click();
      await inspector.locator('[data-testid="properties"][data-path="道路段"]').waitFor();
      await expect.poll(() => target.url()).toContain(`in=${enc(ROOT)}`);

      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      expect(await current()).toEqual(before);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 13）：拖胸牌相框的下边，拖动中只画幽灵框不写回，Esc 取消，松手一步撤销；方向键换位；拖 M402 顶栏的间距条', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, BADGE);
      type Node = { name: string; place?: Record<string, unknown>; layout?: Record<string, unknown>; children?: Node[] };
      const current = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body;
        return JSON.parse(body.content as string) as { artboard: Node };
      };
      const find = (node: Node, name: string): Node | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const badgeBefore = await current(BADGE), routeBefore = await current(ROOT);
      const photo = async () => find((await current(BADGE)).artboard, '照片')!;
      const writes: string[] = [];
      target.on('request', (request) => { if (request.method() === 'PUT' && request.url().includes('/working-copy?')) writes.push(request.url()); });
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(BADGE)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      await side.locator(`[data-testid="structure-row"][data-path="${BADGE}/照片"]`).getByRole('button').first().click();
      await inspector.getByTestId('handle-notes').filter({ hasText: '拖右下的手柄改宽高' }).waitFor();
      // 纵向堆叠里宽高都固定：右边、下边、右下角，外加拖动改顺序。
      expect(await target.getByTestId('handle').evaluateAll((handles) => handles.map((handle) => handle.getAttribute('data-handle')))).toEqual(['e', 's', 'se']);
      const bottom = target.locator('[data-testid="handle"][data-handle="s"]');
      const press = async () => {
        const box = (await bottom.boundingBox())!;
        await target.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await target.mouse.down();
        await target.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 15, { steps: 5 });
        await target.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 30, { steps: 5 });
      };

      // 拖动中：幽灵框与读数，不写回；Esc 取消。
      await press();
      await target.getByTestId('handle-ghost').waitFor();
      const readout = await target.getByTestId('handle-readout').textContent();
      expect(readout).toMatch(/^宽 24 × 高 \d+(\.5)? mm$/u);
      expect(writes).toEqual([]);
      await target.keyboard.press('Escape');
      await target.getByTestId('handle-ghost').waitFor({ state: 'detached' });
      await target.mouse.up();
      expect(await inspector.getByTestId('properties').getAttribute('data-path'), 'Esc 取消拖动，不是选上一层').toBe(`${BADGE}/照片`);
      expect(writes).toEqual([]);
      expect((await photo()).place).toEqual({ width: { fixed: 24 }, height: { fixed: 24 } });

      // 再拖一次松手：写回吸到 0.5 mm 的高，和读数一致；选中不变。
      await press();
      const shown = await target.getByTestId('handle-readout').textContent();
      let saved = stashed();
      await target.mouse.up();
      await saved;
      const height = ((await photo()).place!['height'] as { fixed: number }).fixed;
      expect(height).toBeGreaterThan(24);
      expect(height * 2).toBe(Math.round(height * 2));
      expect(shown).toBe(`宽 24 × 高 ${height} mm`);
      expect(await inspector.getByTestId('properties').getAttribute('data-path')).toBe(`${BADGE}/照片`);
      await target.getByTestId('select-tag').filter({ hasText: `× ${height} mm` }).waitFor({ timeout: PREVIEW_WINDOW_MS });
      // 一步撤销。
      saved = stashed();
      await target.keyboard.press('Control+z');
      await saved;
      expect((await photo()).place).toEqual({ width: { fixed: 24 }, height: { fixed: 24 } });

      // 方向键：在堆叠里和后一个换位。先在图上点它，焦点回到页面。
      const body = (await target.getByTestId('handle-move').boundingBox())!;
      await target.mouse.click(body.x + body.width / 2, body.y + body.height / 2);
      saved = stashed();
      await target.keyboard.press('ArrowDown');
      await target.getByTestId('handle-readout').filter({ hasText: '放到第 3 位（共 8 位）' }).waitFor();
      await saved;
      expect((await current(BADGE)).artboard.children!.map((child) => child.name).slice(0, 3)).toEqual(['页眉', '姓名', '照片']);
      saved = stashed();
      await target.keyboard.press('Control+z');
      await saved;
      expect(await current(BADGE)).toEqual(badgeBefore);

      // M402 顶栏：选中横向堆叠，拖第一个间距条，写 layout.gap。
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      await side.locator(`[data-testid="structure-row"][data-path="${ROOT}/顶栏"]`).getByRole('button').first().click();
      await inspector.getByTestId('handle-notes').filter({ hasText: '拖间距条改间距' }).waitFor();
      const bar = (await target.locator('[data-testid="handle-bar"][data-handle="gap:0"]').boundingBox())!;
      await target.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
      await target.mouse.down();
      await target.mouse.move(bar.x + bar.width / 2 + 12, bar.y + bar.height / 2, { steps: 6 });
      const gapText = (await target.getByTestId('handle-readout').textContent())!;
      expect(gapText).toMatch(/^间距 \d+(\.5)? mm$/u);
      saved = stashed();
      await target.mouse.up();
      await saved;
      const gap = find((await current(ROOT)).artboard, '顶栏')!.layout!['gap'] as number;
      expect(gap).toBeGreaterThan(8);
      expect(gapText).toBe(`间距 ${gap} mm`);

      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await server('DELETE', `/v1/templates/${enc(BADGE)}/working-copy`, token);
      expect(await current(ROOT)).toEqual(routeBefore);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 17）：站名按站点状态的取值带命中数，选"本站"后改的值写进覆盖，有圆点能重置，名称这类不能覆盖；定位到本站；换依据时对不上的取值当场标红', async () => {
      const ROOT = '标准线路单边', STOP = '站点', NAME = `${STOP}/名称区/站名`, token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Node = { name: string; opacity?: number; states?: { by: { var: string }; cases: Record<string, Record<string, unknown>> }; children?: Node[] };
      const current = async () => {
        const copy = await server('GET', `/v1/templates/${enc(STOP)}/working-copy`, token);
        const body = copy.status === 200 ? copy.body : (await server('GET', `/v1/templates/${enc(STOP)}/content`, token)).body;
        return JSON.parse(body.content as string) as { artboard: Node };
      };
      const find = (node: Node, name: string): Node | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const stopName = async () => find((await current()).artboard, '站名')!;
      const before = await current();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await target.goto(`${baseUrl}/console/#/templates/${enc(STOP)}/design?in=${enc(ROOT)}`);
      await target.getByTestId('preview-image').waitFor();
      // 本站序号 5：已过站 4 处、本站 1 处、未到站 30 处。
      const knob = target.locator('[data-testid="parameter-knob"][data-name="currentIndex"]');
      await knob.getByRole('textbox').fill('5');
      await knob.getByRole('textbox').press('Enter');
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      for (const row of ['站点面板', '站点列', '名称区']) await openRow(side, row);
      await side.locator(`[data-testid="structure-row"][data-path="${NAME}"]`).getByRole('button').first().click();
      await inspector.locator(`[data-testid="properties"][data-path="${NAME}"]`).waitFor();
      const bar = inspector.getByTestId('state-bar'), chip = (value: string) => bar.locator(`[data-testid="state-chip"][data-value="${value}"]`);
      expect(await bar.getByRole('combobox').inputValue()).toBe('stopState');
      // 能作为依据的只列单值变量：站点列表（stops 在主模板）不在这里，布尔的有地标在。
      expect(await bar.getByRole('combobox').locator('option').allTextContents()).toContain('有地标（hasLandmark）');
      expect(await bar.locator('[data-testid="state-chip"]').evaluateAll((chips) => chips.map((item) => item.getAttribute('data-value')))).toEqual(['', '普通', '已过站', '本站', '未到站']);
      await expect.poll(() => chip('本站').getAttribute('aria-label'), { timeout: PREVIEW_WINDOW_MS }).toBe('本站，当前样例 1 处');
      expect(await chip('已过站').getAttribute('aria-label')).toBe('已过站，当前样例 4 处');
      expect(await chip('未到站').getAttribute('aria-label')).toBe('未到站，当前样例 30 处，还没覆盖');
      // 不分状态时：颜色被覆盖，标签前有圆点。
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`);
      await field('color').getByTestId('state-dot').waitFor();

      // 选"本站"：说明命中几处，名称不能覆盖，颜色有圆点能重置；顺序不分取值。
      await chip('本站').click();
      expect(await chip('本站').getAttribute('aria-pressed')).toBe('true');
      await bar.getByTestId('state-hint').filter({ hasText: '当前样例有 1 处' }).waitFor();
      await field('name').getByTestId('field-blocked').filter({ hasText: '不能按取值换' }).waitFor();
      await field('color').getByTestId('state-reset').waitFor();
      expect(await field('opacity').getByTestId('state-reset').count()).toBe(0);
      await inspector.getByTestId('handle-notes').filter({ hasText: '顺序不分取值' }).waitFor();
      // 定位到第一处：图上选中本站的那一处。
      await bar.getByTestId('state-locate').click();
      await expect.poll(() => target.getByTestId('select-box').getAttribute('data-path')).toMatch(/站点列\[\d+\]\/名称区\/站名$/u);
      expect(await chip('本站').getAttribute('aria-pressed'), '定位不换取值').toBe('true');

      // 在"本站"下改不透明度：写进覆盖，自身属性不动；重置回去。
      let saved = stashed();
      await field('opacity').getByRole('textbox').fill('0.8');
      await field('opacity').getByRole('textbox').press('Tab');
      await saved;
      let name = await stopName();
      expect(name.states!.cases['本站']).toEqual({ color: { var: 'currentTextColor' }, opacity: 0.8 });
      expect(name.opacity).toBeUndefined();
      await field('opacity').getByTestId('state-dot').waitFor();
      saved = stashed();
      await field('opacity').getByTestId('state-reset').click();
      await saved;
      name = await stopName();
      expect(name.states!.cases['本站']).toEqual({ color: { var: 'currentTextColor' } });

      // 换依据：原来的取值对不上布尔，当场标红并写明引擎会报的代码；撤销回来。
      saved = stashed();
      await bar.getByRole('combobox').selectOption('hasLandmark');
      await saved;
      expect((await stopName()).states!.by).toEqual({ var: 'hasLandmark' });
      await bar.getByTestId('state-problem').filter({ hasText: '列出的取值 "已过站"、"本站" 不会出现：hasLandmark 只可能是 true、false（template.unknownStateValue）' }).waitFor();
      expect(await chip('已过站').getAttribute('class')).toContain('unknown');
      expect(await chip('true').getAttribute('class')).toContain('empty');
      saved = stashed();
      await target.getByRole('button', { name: '撤销' }).click();
      await saved;
      expect((await stopName()).states!.by).toEqual({ var: 'stopState' });

      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      expect(await current()).toEqual(before);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 18）：模板列表从空白新建，空画板写明下一步；加一个字段就能发布为修订 1；从列表字段加循环时当场新建被调模板，基准预先填好', async () => {
      const NAME = `空白站点 ${randomUUID().slice(0, 6)}`, BADGE = `站名标识 ${randomUUID().slice(0, 6)}`, token = world.b.admin.token;
      const target = await asAdmin();
      type Node = { name: string; type?: string; template?: string; content?: unknown; children?: Node[] };
      const copyOf = async (name: string) => {
        const reply = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        return reply.status === 200 ? JSON.parse(reply.body.content as string) as { base: unknown; artboard: Node & { sizeRange: unknown } } : undefined;
      };
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      await (await nav(target, '模板')).click();
      await target.getByRole('button', { name: '新建模板' }).click();
      const dialog = target.getByRole('dialog', { name: '新建模板' });
      await dialog.getByLabel('名称').fill(NAME);
      await dialog.getByLabel('基准').selectOption({ label: '停靠站点（停靠站点 v1）' });
      for (const [label, value] of [['宽 最小', '8'], ['宽 最大', '800'], ['高 最小', '80'], ['高 最大', '110'], ['默认宽', '20'], ['默认高', '100']] as const) await dialog.getByLabel(label, { exact: true }).fill(value);
      // 默认尺寸要在范围里，不对时当场说，不能提交。
      await dialog.getByLabel('默认宽', { exact: true }).fill('900');
      await dialog.getByTestId('new-template-problem').filter({ hasText: '默认宽要在适用范围里' }).waitFor();
      expect(await dialog.getByRole('button', { name: '新建' }).isDisabled()).toBe(true);
      await dialog.getByLabel('默认宽', { exact: true }).fill('20');
      await dialog.getByRole('button', { name: '新建' }).click();

      // 进设计页：一块空画板，舞台下方写明下一步；样例带用默认尺寸与空白数据。
      await target.getByTestId('preview-image').waitFor();
      expect(await copyOf(NAME)).toEqual({ dslVersion: 'renderweave-template/1', name: NAME, base: { name: '停靠站点', version: 1 }, artboard: { sizeRange: { width: { min: 8, max: 800 }, height: { min: 80, max: 110 } } } });
      await target.getByTestId('unpublished-count').filter({ hasText: '新模板，未发布' }).waitFor();
      expect(await target.locator('[data-testid="size-knob"][data-name="width"]').getByRole('textbox').inputValue()).toBe('20');
      const hint = target.getByTestId('stage-hint');
      await hint.filter({ hasText: '空画板' }).waitFor();
      await hint.getByRole('button', { name: '打开"添加"页' }).click();
      const side = target.getByRole('complementary', { name: '结构与变量' });
      expect(await side.getByRole('tab', { name: '添加' }).getAttribute('aria-selected')).toBe('true');
      let saved = stashed();
      await side.locator('[data-testid="add-field"][data-name="name"]').click();
      await saved;
      expect((await copyOf(NAME))!.artboard.children!.map((child) => [child.type, child.content])).toEqual([['text', [{ slot: 'name' }]]]);
      await hint.waitFor({ state: 'detached' });

      // 发布：没有修订可比，记修订 1。
      await target.getByRole('button', { name: '发布修订' }).click();
      await target.getByRole('heading', { name: '发布修订 1', level: 1 }).waitFor();
      await target.getByRole('button', { name: '发布为修订 1' }).click();
      await target.getByRole('status').filter({ hasText: '已保存为修订 1' }).waitFor();
      expect((await server('GET', `/v1/templates/${enc(NAME)}`, token)).body.currentRevision).toBe(1);

      // 从列表字段加循环：当场新建被调模板，基准预先填好是单值·文本 v1。
      await target.goto(`${baseUrl}/console/#/templates/${enc(NAME)}/design`);
      await target.getByTestId('preview-image').waitFor();
      await side.getByRole('tab', { name: '添加' }).click();
      await side.locator('[data-testid="add-field"][data-name="badges"]').click();
      const choose = side.getByRole('form', { name: '从 站名上方的标识 创建' });
      // 基准是单值·文本 v1 的已有模板（M402 的标识图标等）列在前面，最后一项是当场新建。
      const choices = await choose.getByLabel('被调模板').locator('option').allTextContents();
      expect(choices).toContain('标识图标');
      expect(choices.at(-1)).toBe('+ 新建模板…');
      await choose.getByLabel('被调模板').selectOption({ label: '+ 新建模板…' });
      const callee = target.getByRole('dialog', { name: '新建模板' });
      expect(await callee.getByTestId('new-template-base').textContent()).toBe('单值·文本 v1');
      await callee.getByLabel('名称').fill(BADGE);
      await callee.getByRole('button', { name: '新建' }).click();
      await callee.waitFor({ state: 'detached' });
      expect(await choose.getByLabel('被调模板').inputValue()).toBe(BADGE);
      saved = stashed();
      await choose.getByRole('button', { name: '添加循环容器' }).click();
      await saved;
      const loop = (await copyOf(NAME))!.artboard.children!.find((child) => child.type === 'loop');
      expect(loop).toMatchObject({ template: BADGE, list: { var: 'badges' } });
      expect(await copyOf(BADGE)).toMatchObject({ base: { name: '单值·文本', version: 1 }, artboard: { sizeRange: { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } } } });

      // 检查器里循环的表单同样能当场新建，建好就换过去。
      const AGAIN = `站名标识二 ${randomUUID().slice(0, 6)}`;
      await side.getByRole('tab', { name: '结构' }).click();
      await side.locator(`[data-testid="structure-row"][data-path="${NAME}/${loop!.name}"]`).getByRole('button').first().click();
      const loopForm = target.getByRole('complementary', { name: '检查器' }).getByTestId('loop-form');
      await loopForm.getByLabel('被调模板').selectOption({ label: '+ 新建模板…' });
      const second = target.getByRole('dialog', { name: '新建模板' });
      expect(await second.getByTestId('new-template-base').textContent()).toBe('单值·文本 v1');
      await second.getByLabel('名称').fill(AGAIN);
      saved = stashed();
      await second.getByRole('button', { name: '新建' }).click();
      await saved;
      expect((await copyOf(NAME))!.artboard.children!.find((child) => child.type === 'loop')!.template).toBe(AGAIN);
      expect(target.url(), '没有整页重载').not.toContain('/console/?');

      for (const name of [NAME, BADGE, AGAIN]) await server('DELETE', `/v1/templates/${enc(name)}/working-copy`, token);
      await leaveDesign(target, NAME);
    }, 180_000);

    it('模板设计（票据 19）：把 M402 站点的名称区提取成子模板，列出带走的参数与派生变量；提取前后的图逐像素相同；一步撤销两边一起回去', async () => {
      const ROOT = '标准线路单边', STOP = '站点', NAME = `站名区 ${randomUUID().slice(0, 6)}`, token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Node = { name: string; type?: string; template?: string; data?: unknown; args?: Record<string, unknown>; children?: Node[] };
      const contentOf = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        return copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body.content as string;
      };
      const find = (node: Node, name: string): Node | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const before = await contentOf(STOP);
      await target.goto(`${baseUrl}/console/#/templates/${enc(STOP)}/design?in=${enc(ROOT)}`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' });
      for (const row of ['站点面板', '站点列']) await openRow(side, row);
      await side.locator(`[data-testid="structure-row"][data-path="${STOP}/名称区"]`).click({ button: 'right' });
      await target.getByRole('menu', { name: '元素' }).getByRole('menuitem', { name: '提取为子模板…' }).click();
      const dialog = target.getByRole('dialog', { name: '提取为子模板' });
      expect(await dialog.getByLabel('新模板名称').inputValue()).toBe('名称区');
      expect(await dialog.getByTestId('extract-base').textContent()).toBe('停靠站点 v1，调用传当前数据');
      expect(await dialog.getByTestId('extract-parameters').locator('code').allTextContents()).toEqual(['index', 'currentIndex', 'stopNameSize', 'nameColor', 'passedColor', 'currentTextColor', 'highlightColor']);
      expect(await dialog.getByTestId('extract-derived').locator('code').allTextContents()).toEqual(['stopState', 'hasLandmark']);
      // 尺寸范围按图上 35 处的实际尺寸放宽；名称不能和已有模板重。
      expect(Number(await dialog.getByLabel('宽 最小', { exact: true }).inputValue())).toBeGreaterThan(0);
      await dialog.getByLabel('新模板名称').fill('道路段');
      await dialog.getByTestId('extract-problem').filter({ hasText: '已有模板「道路段」' }).waitFor();
      await dialog.getByLabel('新模板名称').fill(NAME);
      await dialog.getByRole('button', { name: '提取' }).click();
      await target.getByRole('status').filter({ hasText: `已提取为子模板「${NAME}」：提取前后的图逐像素相同。` }).waitFor({ timeout: PREVIEW_WINDOW_MS });

      // 原地换成调用，传当前数据与同名参数；新模板带着名称区本身、对外参数与派生变量。
      const call = find((JSON.parse(await contentOf(STOP)) as { artboard: Node }).artboard, '名称区')!;
      expect(call).toMatchObject({ type: 'call', template: NAME, data: 'current', args: { index: { var: 'index' }, highlightColor: { var: 'highlightColor' } } });
      const callee = JSON.parse(await contentOf(NAME)) as { base: unknown; parameters: { name: string; visibility: string }[]; derived: { name: string }[]; artboard: Node };
      expect(callee.base).toEqual({ name: '停靠站点', version: 1 });
      expect(callee.parameters.every((parameter) => parameter.visibility === 'public')).toBe(true);
      expect(callee.derived.map((item) => item.name)).toEqual(['stopState', 'hasLandmark']);
      expect(callee.artboard.children!.map((child) => [child.type, child.name])).toEqual([['container', '名称区']]);
      await target.getByRole('complementary', { name: '检查器' }).locator(`[data-testid="properties"][data-path="${STOP}/名称区"][data-type="call"]`).waitFor();

      // 一步撤销：两边一起回去，原模板逐字节还原。
      const stashed = target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes(enc(STOP)) && response.status() === 200, { timeout: 60_000 });
      await target.getByRole('button', { name: '撤销' }).click();
      await stashed;
      await expect.poll(() => contentOf(STOP)).toBe(before);
      await expect.poll(async () => (JSON.parse(await contentOf(NAME)) as { artboard: Node }).artboard.children ?? []).toEqual([]);
      expect(await target.getByRole('button', { name: '撤销' }).isDisabled()).toBe(true);

      for (const name of [STOP, NAME]) await server('DELETE', `/v1/templates/${enc(name)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('模板设计（票据 20）：第二期验收：在主模板里给站点列从空白新建站点模板，不写 DSL 做出标识行循环、竖排站名、缩字组、地标、状态样式与 stopState；M402 的数据出图和原来的站点模板逐字节相同，0 个严重问题', async () => {
      const ROOT = '标准线路单边', NAME = `我的站点 ${randomUUID().slice(0, 6)}`, token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      type Node = Record<string, unknown> & { name: string; type?: string; children?: Node[] };
      const contentOf = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body.content as string) as Node & { artboard: Node; parameters?: Node[]; derived?: Node[] };
      };
      const find = (node: Node, name: string): Node | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const text = (key: string) => field(key).locator('input[type="text"]').first();
      /** 一步改动：等它写回工作副本。 */
      const write = async (action: () => Promise<unknown>) => {
        const saved = target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
        await action();
        await saved;
      };
      const selected = (path: string) => inspector.locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
      const bind = async (key: string, variable: string) => {
        await field(key).getByTestId('bind-button').click();
        await write(() => field(key).locator(`[data-testid="binding-option"][data-name="${variable}"]`).click());
      };
      const states = async (by: string, cases: Readonly<Record<string, () => Promise<unknown>>>) => {
        await write(() => inspector.getByLabel('状态样式按哪个变量').selectOption(by));
        for (const [value, change] of Object.entries(cases)) {
          await inspector.locator(`[data-testid="state-chip"][data-value="${value}"]`).click();
          await write(change);
        }
        await inspector.locator('[data-testid="state-chip"][data-value=""]').click();
      };

      // 原来的样子：打开时舞台与样例带出的每一张图，记下请求、图与严重问题数，最后原样重放。
      type Reply = { image?: { base64: string }; problems: { level: string; code: string; message: string }[] };
      const severeOf = (reply: Reply) => reply.problems.filter((problem) => problem.level === 'severe');
      const shots = new Map<string, Promise<{ body: unknown; reply: Reply }>>();
      const collect = (response: { url(): string; status(): number; request(): { postData(): string | null; postDataJSON(): unknown }; json(): Promise<unknown> }) => {
        const key = response.request().postData() ?? '';
        if (response.url().endsWith('/v1/previews?workingCopies=true') && response.status() === 200 && !shots.has(key)) shots.set(key, response.json().then((reply) => ({ body: response.request().postDataJSON(), reply: reply as Reply })));
      };
      target.on('response', collect);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const cards = target.getByTestId('sample-card');
      await expect.poll(async () => (await cards.getByTestId('sample-state').allTextContents()).every((state) => state !== '还没出'), { timeout: PREVIEW_WINDOW_MS }).toBe(true);
      target.off('response', collect);
      const before = await Promise.all(shots.values());
      expect(before.length).toBeGreaterThan(0);
      const started = Date.now();

      // 站点列换成当场从空白新建的模板，基准预先填好；进入它。
      await openRow(side, '站点面板');
      await side.locator(`[data-testid="structure-row"][data-path="${ROOT}/站点面板/站点列"]`).getByRole('button').first().click();
      await inspector.getByTestId('loop-form').getByLabel('被调模板').selectOption({ label: '+ 新建模板…' });
      const dialog = target.getByRole('dialog', { name: '新建模板' });
      expect(await dialog.getByTestId('new-template-base').textContent()).toBe('停靠站点 v1');
      await dialog.getByLabel('名称').fill(NAME);
      for (const [label, value] of [['宽 最小', '8'], ['宽 最大', '800'], ['高 最小', '80'], ['高 最大', '110']] as const) await dialog.getByLabel(label, { exact: true }).fill(value);
      await write(() => dialog.getByRole('button', { name: '新建' }).click());
      await inspector.getByTestId('enter-template').click();
      await selected(NAME);
      // 文档条写的是这个子模板自己的基准与尺寸，图还是主模板这张。
      await target.getByTestId('design-facts').filter({ hasText: '停靠站点 v1 · 8–800 × 80–110 mm' }).waitFor();

      // 画板：纵向堆叠，居中。
      await write(() => field('layout').getByRole('button', { name: '纵向堆叠' }).click());
      await write(() => field('layout').getByRole('button', { name: '上中', exact: true }).click());

      // 对外参数：主模板按这三个名字传。
      await side.getByRole('tab', { name: '变量' }).click();
      for (const [name, label, fallback, min] of [['index', '序号', '1', '1'], ['currentIndex', '本站序号', '0', '0'], ['stopNameSize', '站名字号', '10', '5']] as const) {
        await side.getByLabel('新参数的名称').fill(name);
        await write(() => side.getByRole('button', { name: '添加参数' }).click());
        await inspector.locator(`[data-testid="variable-inspector"][data-name="${name}"]`).waitFor();
        await write(() => text('displayName').fill(label));
        await write(() => field('type').locator('select').first().selectOption({ label: '数值' }));
        if (name !== 'stopNameSize') await write(() => field('constraints.integer').locator('select').first().selectOption({ label: '是' }));
        await write(() => text('constraints.min').fill(min));
        await write(() => text('default').fill(fallback));
      }

      // 派生变量 stopState：三支加否则。
      const derive = async (name: string, label: string) => {
        await side.getByRole('button', { name: '新建派生变量' }).click();
        const creating = side.getByRole('form', { name: '新建派生变量' });
        await creating.getByLabel('新派生变量的名称').fill(name);
        await write(() => creating.getByRole('button', { name: '新建' }).click());
        await inspector.locator(`[data-testid="variable-inspector"][data-name="${name}"]`).waitFor();
        const editor = inspector.getByTestId('derived-editor');
        await write(() => editor.getByLabel('显示名称').fill(label));
        return editor;
      };
      let editor = await derive('stopState', '站点状态');
      const branch = async (index: number, left: string, op: string, right: { var: string } | { value: string }, then: string) => {
        const at = `第 ${index} 支`, condition = `${at}第 1 个条件`;
        if (index > 1) await write(() => editor.getByRole('button', { name: '加一支' }).click());
        await write(() => editor.getByLabel(`${condition}的左侧`, { exact: true }).selectOption(left));
        await write(() => editor.getByLabel(`${condition}的比较`, { exact: true }).selectOption(op));
        if ('var' in right) {
          await write(() => editor.getByLabel(`${condition}的右侧的写法`, { exact: true }).selectOption('var'));
          if (await editor.getByLabel(`${condition}的右侧`, { exact: true }).inputValue() !== right.var) await write(() => editor.getByLabel(`${condition}的右侧`, { exact: true }).selectOption(right.var));
        } else {
          await write(() => editor.getByLabel(`${condition}的右侧`, { exact: true }).fill(right.value));
        }
        await write(() => editor.getByLabel(`${at}的取值`, { exact: true }).fill(then));
      };
      await branch(1, 'currentIndex', 'eq', { value: '0' }, '普通');
      await branch(2, 'index', 'lt', { var: 'currentIndex' }, '已过站');
      await branch(3, 'index', 'eq', { var: 'currentIndex' }, '本站');
      await write(() => editor.getByLabel('否则的取值', { exact: true }).fill('未到站'));

      // 派生变量 hasLandmark：地标为空就不显示。
      editor = await derive('hasLandmark', '有地标');
      await write(() => editor.getByLabel('结果类型').selectOption('boolean'));
      await write(() => editor.getByLabel('第 1 支第 1 个条件的左侧', { exact: true }).selectOption('landmark'));
      await write(() => editor.getByLabel('第 1 支第 1 个条件的比较', { exact: true }).selectOption('empty'));
      // 换成布尔时固定值都成了"否"：第 1 支不用动，否则取"是"。
      expect(await editor.getByLabel('第 1 支的取值', { exact: true }).inputValue()).toBe('false');
      await write(() => editor.getByLabel('否则的取值', { exact: true }).selectOption('true'));
      expect((await contentOf(NAME)).derived).toEqual(JSON.parse(JSON.stringify((await contentOf('站点')).derived)));

      // 标识行：从列表字段加循环，每项固定 9 mm、间距 1，高 10 mm，下边距 2。
      await side.getByRole('tab', { name: '添加' }).click();
      await side.locator('[data-testid="add-field"][data-name="badges"]').click();
      const choose = side.getByRole('form', { name: '从 站名上方的标识 创建' });
      await choose.getByLabel('被调模板').selectOption('标识图标');
      await write(() => choose.getByRole('button', { name: '添加循环容器' }).click());
      await selected(`${NAME}/站名上方的标识`);
      await write(() => text('name').fill('标识行'));
      await selected(`${NAME}/标识行`);
      const items = inspector.getByTestId('item-layout-form');
      await write(() => items.getByLabel('每项宽', { exact: true }).fill('9'));
      await write(() => text('itemLayout.gap').fill('1'));
      await write(() => field('place.width').locator('select').first().selectOption({ label: '随内容' }));
      await write(() => text('place.height').fill('10'));
      await field('place.margin').getByTestId('edges-toggle').click();
      await write(() => text('place.margin.bottom').fill('2'));

      // 名称区：容器，内边距 1，纵向居中，宽随内容、高撑满；本站时高亮底色。
      await write(() => side.locator('[data-testid="add-element"][data-kind="container"]').click());
      await selected(`${NAME}/容器`);
      await write(() => text('name').fill('名称区'));
      await selected(`${NAME}/名称区`);
      await write(() => text('padding').fill('1'));
      await write(() => field('layout').getByRole('button', { name: '上中', exact: true }).click());
      await write(() => field('place.width').locator('select').first().selectOption({ label: '随内容' }));
      await write(() => field('place.height').locator('select').first().selectOption({ label: '撑满' }));
      await states('stopState', { 本站: () => text('fill').fill('#FFF000') });

      // 站名：从字段加进名称区，竖排、分散对齐，字号绑站名字号，收紧字距再压缩字形，缩字组 stopNames。
      await write(() => side.locator('[data-testid="add-field"][data-name="name"]').click());
      await selected(`${NAME}/名称区/站名`);
      const font = field('font').getByTestId('font-select'), family = field('font').getByTestId('font-family');
      if (await family.inputValue() !== 'hei') await write(() => family.selectOption('hei'));
      if (await font.inputValue() !== 'res:font-hei-medium') await write(() => font.selectOption('res:font-hei-medium'));
      await bind('fontSize', 'stopNameSize');
      await write(() => text('color').fill('#333333'));
      await write(() => field('writingMode').getByRole('button', { name: '竖排' }).click());
      await write(() => field('verticalAlign').getByRole('button', { name: '分散' }).click());
      await write(() => field('horizontalAlign').getByRole('button', { name: '居中' }).click());
      await inspector.getByTestId('fit-summary').click();
      await write(() => field('fit.steps').locator('select').first().selectOption({ label: '收紧字距 → 压缩字形' }));
      await write(() => field('fit.widthOverflow').getByRole('button', { name: '添加' }).click());
      await write(() => text('fit.widthOverflow.shrinkGroup').fill('stopNames'));
      await write(() => text('fit.widthOverflow.minFontSize').fill('5'));
      await write(() => field('place.width').locator('select').first().selectOption({ label: '随内容' }));
      await write(() => field('place.height').locator('select').first().selectOption({ label: '撑满' }));
      await states('stopState', { 已过站: () => text('color').fill('#C8C8C8'), 本站: () => text('color').fill('#E60012') });

      // 地标：从字段加在站名后面，8 × 8 mm、上边距 1，完整显示；没有地标不显示，已过站变淡。
      await write(() => side.locator('[data-testid="add-field"][data-name="landmark"]').click());
      await selected(`${NAME}/名称区/地标`);
      await bind('visible', 'hasLandmark');
      const fit = field('fit');
      if (await fit.getByRole('button', { name: '完整显示' }).count()) await write(() => fit.getByRole('button', { name: '完整显示' }).click());
      else await write(() => fit.locator('select').first().selectOption({ label: '完整显示' }));
      await write(() => text('place.width').fill('8'));
      await write(() => text('place.height').fill('8'));
      await field('place.margin').getByTestId('edges-toggle').click();
      await write(() => text('place.margin.top').fill('1'));
      await states('stopState', { 已过站: () => text('opacity').fill('0.35') });
      const minutes = (Date.now() - started) / 60_000;

      // 结果：结构和原来的站点模板一样；同一个预览请求出的图逐字节相同，每份样例的问题数也一样，当前样例没有严重问题。
      const made = await contentOf(NAME);
      expect(made.parameters!.map((item) => [item['name'], item['type'], item['visibility']])).toEqual([['index', 'number', 'public'], ['currentIndex', 'number', 'public'], ['stopNameSize', 'number', 'public']]);
      expect(made.artboard).toMatchObject({ layout: { mode: 'stack', direction: 'column', alignItems: 'center' }, children: [
        { type: 'loop', name: '标识行', list: { var: 'badges' }, template: '标识图标', itemLayout: { direction: 'row', widths: { fixed: 9 }, gap: 1 } },
        { type: 'container', name: '名称区', padding: 1, states: { by: { var: 'stopState' }, cases: { 本站: { fill: '#FFF000' } } }, children: [
          { type: 'text', name: '站名', content: [{ slot: 'name' }], writingMode: 'vertical', verticalAlign: 'distribute', fontSize: { var: 'stopNameSize' }, fit: { steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: 'stopNames', minFontSize: 5 } } },
          { type: 'image', name: '地标', source: { var: 'landmark' }, visible: { var: 'hasLandmark' }, states: { by: { var: 'stopState' }, cases: { 已过站: { opacity: 0.35 } } } },
        ] },
      ] });
      expect(find((await contentOf(ROOT)).artboard, '站点列')).toMatchObject({ template: NAME, args: { index: { loop: 'index' } } });
      for (const [index, shot] of before.entries()) {
        const now = await server('POST', '/v1/previews?workingCopies=true', token, shot.body);
        expect(now.status).toBe(200);
        expect(shot.reply.image?.base64, '原来出了图').toBeTruthy();
        expect(severeOf(now.body as Reply).map((problem) => problem.code), `第 ${index + 1} 张的严重问题和原来一样`).toEqual(severeOf(shot.reply).map((problem) => problem.code));
        expect((now.body as Reply).image?.base64 === shot.reply.image?.base64, `第 ${index + 1} 张和原来的站点模板出的图逐字节相同`).toBe(true);
      }
      // 舞台上的当前样例：没有严重问题。
      await expect.poll(() => target.getByText(/正式出图时不出图/).count(), { timeout: PREVIEW_WINDOW_MS }).toBe(0);
      console.log(`票据 20：从空白做出站点模板，用例动手 ${minutes.toFixed(1)} 分钟`);

      // 发布：主模板调用的新模板还没发布，发布页写明先发布它；发布它之后主模板就能发布（这里不真的发布主模板）。
      const accept = (dialog: Dialog) => { void dialog.accept(); };
      target.on('dialog', accept);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/publish`);
      const callees = target.getByTestId('publish-callees-first');
      await callees.filter({ hasText: `「${NAME}」是这里调用的新模板，还没发布` }).waitFor();
      expect(await target.getByRole('button', { name: /^发布为修订/ }).isDisabled()).toBe(true);
      await callees.getByRole('link', { name: `「${NAME}」` }).click();
      await target.getByRole('heading', { name: '发布修订 1', level: 1 }).waitFor();
      await target.getByRole('button', { name: '发布为修订 1' }).click();
      await target.getByRole('status').filter({ hasText: '已保存为修订 1' }).waitFor();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/publish`);
      await expect.poll(() => target.getByRole('button', { name: /^发布为修订/ }).isDisabled(), { timeout: 30_000 }).toBe(false);
      expect(await callees.count()).toBe(0);
      target.off('dialog', accept);

      for (const name of [ROOT, NAME]) await server('DELETE', `/v1/templates/${enc(name)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 600_000);

    it('模板设计（第三轮 01）：宽高一格，打数就是固定，随内容与没写时淡色显示实际尺寸，按比例改权重，固定值能绑定；撤销回到原样', async () => {
      const ALL = '全元素牌', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ALL);
      const content = async () => {
        const copy = await server('GET', `/v1/templates/${enc(ALL)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(ALL)}/content`, token)).body.content as string) as { artboard: { children: { name: string; place?: Record<string, unknown> }[] } };
      };
      const placeOf = async (name: string) => (await content()).artboard.children.find((child) => child.name === name)!.place!;
      const before = await content();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const cell = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first().getByTestId('size-cell');
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const write = async (action: () => Promise<unknown>) => { const saved = stashed(); await action(); await saved; };
      const width = cell('place.width'), number = width.getByRole('textbox'), mode = width.getByLabel('宽的尺寸方式');

      // 自由布局里的矩形：一格里是 22 加"固定"，没有第二个控件。
      await side.locator(`[data-testid="structure-row"][data-path="${ALL}/矩形"]`).getByRole('button').first().click();
      await inspector.locator(`[data-testid="properties"][data-path="${ALL}/矩形"]`).waitFor();
      expect(await number.inputValue()).toBe('22');
      expect(await mode.inputValue()).toBe('fixed');
      expect(await inspector.locator('[data-testid="property-field"][data-key="place.width.fixed"]').count(), '固定值不再是另一格').toBe(0);
      // 打数就是固定。
      await write(() => number.fill('30'));
      expect((await placeOf('矩形'))['width']).toEqual({ fixed: 30 });
      // 换随内容：数值框空着，淡色是这一处的实际宽（布局摘要）。
      await write(() => mode.selectOption('hug'));
      expect((await placeOf('矩形'))['width']).toBe('hug');
      expect(await number.inputValue()).toBe('');
      await expect.poll(() => number.getAttribute('placeholder')).toMatch(/^\d+(\.\d)?$/);
      // 随内容时打数：直接变固定。
      await write(() => number.fill('12.5'));
      expect((await placeOf('矩形'))['width']).toEqual({ fixed: 12.5 });
      // 按比例撑满：框里改的是权重。
      await write(() => mode.selectOption('ratio'));
      expect((await placeOf('矩形'))['width']).toEqual({ fill: 1 });
      await write(() => number.fill('2'));
      expect((await placeOf('矩形'))['width']).toEqual({ fill: 2 });
      // 不合法的不写回，当场说。
      await number.fill('0');
      await width.getByRole('alert').filter({ hasText: '比例要大于 0' }).waitFor();
      await target.waitForTimeout(800);
      expect((await placeOf('矩形'))['width']).toEqual({ fill: 2 });
      // 换回固定取实际宽；固定值能绑定数值变量，绑定时是灰底条。
      await write(() => mode.selectOption('fixed'));
      expect((await placeOf('矩形'))['width']).toMatchObject({ fixed: expect.any(Number) });
      await width.getByTestId('bind-button').click();
      await write(() => width.locator('[data-testid="binding-option"][data-name="bandHeight"]').click());
      expect((await placeOf('矩形'))['width']).toEqual({ fixed: { var: 'bandHeight' } });
      await width.getByTestId('bound-chip').filter({ hasText: '色带高度' }).waitFor();
      await write(() => width.getByTestId('unbind-button').click());
      expect((await placeOf('矩形'))['width']).toEqual({ fixed: 2 });

      // 堆叠里的文字：宽没写，下拉写"缺省"（宽高并排后半行放不下全称，引擎怎么排在提示里，第三轮票据 05），框里淡色是实际宽。
      await openRow(side, '容器');
      await side.locator(`[data-testid="structure-row"][data-path="${ALL}/容器/容器内文字"]`).getByRole('button').first().click();
      await inspector.locator(`[data-testid="properties"][data-path="${ALL}/容器/容器内文字"]`).waitFor();
      expect(await mode.inputValue()).toBe('');
      expect(await mode.locator('option:checked').textContent()).toBe('缺省');
      expect(await mode.getAttribute('title')).toBe('缺省（随内容）');
      await expect.poll(() => number.getAttribute('placeholder')).toMatch(/^\d+(\.\d)?$/);
      expect(await cell('place.height').getByLabel('高的尺寸方式').inputValue()).toBe('fill');

      // 撤销：一直撤到不能撤，回到原样。
      const undo = target.getByRole('button', { name: '撤销', exact: true });
      for (let step = 0; step < 20 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await content()).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ALL);
    }, 180_000);

    it('模板设计（第三轮 02）：内外边距一格写四边，点开直接改某一边，四边一样时收回成一个数；一边能绑定与提取为参数；撤销回到原样', async () => {
      const ALL = '全元素牌', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ALL);
      type Element = { name: string; padding?: unknown; cornerRadius?: unknown; place?: Record<string, unknown>; children?: Element[] };
      const content = async () => {
        const copy = await server('GET', `/v1/templates/${enc(ALL)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(ALL)}/content`, token)).body.content as string) as { parameters: Record<string, unknown>[]; artboard: { children: Element[] } };
      };
      const box = async () => (await content()).artboard.children.find((child) => child.name === '容器')!;
      const before = await content();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const cell = (key: string) => field(key).getByTestId('edges-cell');
      const whole = (key: string) => cell(key).locator('input[type="text"]').first();
      const part = (key: string, edge: string) => field(`${key}.${edge}`);
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const write = async (action: () => Promise<unknown>) => { const saved = stashed(); await action(); await saved; };
      const popover = inspector.getByTestId('binding-popover');

      // 容器的内边距：一格里是 1，没有"的写法"下拉，四边没展开。
      await side.locator(`[data-testid="structure-row"][data-path="${ALL}/容器"]`).getByRole('button').first().click();
      await inspector.locator(`[data-testid="properties"][data-path="${ALL}/容器"]`).waitFor();
      expect(await whole('padding').inputValue()).toBe('1');
      expect(await field('padding').locator('select').count(), '不再有"分别设置"下拉').toBe(0);
      expect(await cell('padding').getByTestId('edges-parts').count()).toBe(0);
      // 在这一格打数：四边都是它。
      await write(() => whole('padding').fill('2'));
      expect((await box()).padding).toBe(2);

      // 点开：四个值格，各是 2；直接改下边，只有下边变，一格里换成摘要。
      await field('padding').getByRole('button', { name: '展开内边距的四边' }).click();
      const parts = cell('padding').getByTestId('edges-parts');
      expect(await parts.locator('label').allTextContents()).toEqual(['上', '下', '左', '右']);
      expect(await parts.locator('input[type="text"]').evaluateAll((inputs) => inputs.map((input) => (input as unknown as { value: string }).value))).toEqual(['2', '2', '2', '2']);
      await write(() => part('padding', 'bottom').locator('input[type="text"]').fill('3'));
      expect((await box()).padding).toEqual({ top: 2, right: 2, bottom: 3, left: 2 });
      await expect.poll(() => cell('padding').getAttribute('data-state')).toBe('parts');
      expect(await whole('padding').inputValue()).toBe('');
      expect(await whole('padding').getAttribute('placeholder')).toBe('上左右 2 · 下 3');
      // 改回和别的边一样：收回成一个数。
      await write(() => part('padding', 'bottom').locator('input[type="text"]').fill('2'));
      expect((await box()).padding).toBe(2);
      await expect.poll(() => whole('padding').inputValue()).toBe('2');

      // 一边绑定变量：别的边留着；断开时这一边变成变量现在的值（2），四边又一样，收回。
      await part('padding', 'top').getByTestId('bind-button').click();
      await write(() => popover.locator('[data-testid="binding-option"][data-name="bandHeight"]').click());
      expect((await box()).padding).toEqual({ top: { var: 'bandHeight' }, right: 2, bottom: 2, left: 2 });
      await part('padding', 'top').getByTestId('bound-chip').filter({ hasText: '色带高度' }).waitFor();
      expect(await whole('padding').getAttribute('placeholder')).toBe('上 色带高度 · 下左右 2');
      await write(() => part('padding', 'top').getByTestId('unbind-button').click());
      expect((await box()).padding).toBe(2);

      // 一边提取为参数：名字带上这一边，参数加上，只有这一边绑定它。
      await part('padding', 'left').getByTestId('bind-button').click();
      await popover.getByRole('button', { name: '提取为参数' }).click();
      const naming = popover.getByRole('form', { name: '提取为参数' });
      expect(await naming.getByLabel('名称', { exact: true }).inputValue()).toBe('paddingLeft');
      expect(await naming.getByLabel('显示名称').inputValue()).toBe('容器内边距（左）');
      expect(await naming.getByTestId('extract-value').textContent()).toBe('2');
      await write(() => naming.getByRole('button', { name: '提取并绑定' }).click());
      expect((await box()).padding).toEqual({ top: 2, right: 2, bottom: 2, left: { var: 'paddingLeft' } });
      expect((await content()).parameters.at(-1)).toEqual({ name: 'paddingLeft', displayName: '容器内边距（左）', visibility: 'internal', type: 'number', default: 2 });

      // 四边不一样时在一格里打数：四边都改。
      await write(() => whole('padding').fill('1'));
      expect((await box()).padding).toBe(1);
      await expect.poll(() => cell('padding').getAttribute('data-state')).toBe('literal');
      // 收起。
      await field('padding').getByRole('button', { name: '收起内边距的四边' }).click();
      expect(await cell('padding').getByTestId('edges-parts').count()).toBe(0);
      // 圆角是四角。
      await field('cornerRadius').getByRole('button', { name: '展开圆角的四角' }).waitFor();

      // 堆叠里的文字：外边距没写，淡色是 0；点开只打下边，只写那一边。
      await openRow(side, '容器');
      await side.locator(`[data-testid="structure-row"][data-path="${ALL}/容器/容器内文字"]`).getByRole('button').first().click();
      await inspector.locator(`[data-testid="properties"][data-path="${ALL}/容器/容器内文字"]`).waitFor();
      expect(await cell('place.margin').getAttribute('data-state')).toBe('unset');
      expect(await whole('place.margin').inputValue()).toBe('');
      expect(await whole('place.margin').getAttribute('placeholder')).toBe('0');
      await field('place.margin').getByRole('button', { name: '展开外边距的四边' }).click();
      await write(() => part('place.margin', 'bottom').locator('input[type="text"]').fill('2'));
      const inner = async () => (await box()).children!.find((child) => child.name === '容器内文字')!.place!;
      expect((await inner())['margin']).toEqual({ bottom: 2 });
      expect(await whole('place.margin').getAttribute('placeholder')).toBe('下 2');
      // 清空这一边：一边都不剩，整格去掉。
      await write(() => part('place.margin', 'bottom').locator('input[type="text"]').fill(''));
      expect((await inner())['margin']).toBeUndefined();

      // 撤销：一直撤到不能撤，回到原样。
      const undo = target.getByRole('button', { name: '撤销', exact: true });
      for (let step = 0; step < 20 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await content()).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ALL);
    }, 180_000);

    it('模板设计（第三轮 03）：排布用方向图标与九宫格，间距与内边距一行；换排布时子元素的位置键跟着换；循环的每项方向是两个图标；撤销回到原样', async () => {
      const ALL = '全元素牌', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ALL);
      type Element = { name: string; layout?: Record<string, unknown>; itemLayout?: Record<string, unknown>; place?: Record<string, unknown>; children?: Element[] };
      const content = async () => {
        const copy = await server('GET', `/v1/templates/${enc(ALL)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(ALL)}/content`, token)).body.content as string) as { artboard: Element & { children: Element[] } };
      };
      const named = async (name: string) => (await content()).artboard.children.find((child) => child.name === name)!;
      const before = await content();
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const write = async (action: () => Promise<unknown>) => { const saved = stashed(); await action(); await saved; };
      const pick = async (path: string) => {
        await side.locator(`[data-testid="structure-row"][data-path="${path}"]`).getByRole('button').first().click();
        await inspector.locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
      };
      const attributes = (nodes: ReturnType<typeof field>, name: string) => nodes.evaluateAll((all, key) => all.map((node) => (node as unknown as { getAttribute(key: string): string | null }).getAttribute(key)), name);
      const head = field('layout');
      const flow = (name: string) => head.getByTestId('flow-buttons').getByRole('button', { name, exact: true });
      const cell = (name: string) => head.getByTestId('align-grid').getByRole('button', { name, exact: true });
      const lit = () => attributes(head.locator('[data-testid="align-cell"][aria-pressed="true"]'), 'aria-label');
      const paired = () => attributes(inspector.locator('[data-testid="prop-pair"] > [data-testid="property-field"]'), 'data-key');
      const spread = head.getByLabel('主轴分布');

      // 容器是横向堆叠：四个图标里按下的是它，九宫格亮左上（两根轴都没写），间距与内边距并排一行；方向、对齐不再是一项项的下拉。
      await pick(`${ALL}/容器`);
      expect(await head.getAttribute('data-flow')).toBe('row');
      expect(await attributes(head.getByTestId('flow-buttons').getByRole('button'), 'aria-label')).toEqual(['自由', '横向堆叠', '纵向堆叠', '网格']);
      expect(await flow('横向堆叠').getAttribute('aria-pressed')).toBe('true');
      expect(await head.getByTestId('align-cell').count()).toBe(9);
      expect(await lit()).toEqual(['左上']);
      expect(await paired()).toEqual(['layout.gap', 'padding']);
      for (const key of ['layout.mode', 'layout.direction', 'layout.justifyContent', 'layout.alignItems']) expect(await field(key).count(), key).toBe(0);

      // 横向点右中：左中右是主轴，上中下是交叉轴。
      await write(() => cell('右中').click());
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'row', gap: 1, justifyContent: 'end', alignItems: 'center' });
      expect(await lit()).toEqual(['右中']);
      // 换成纵向：只改方向，对齐的两个键留着，亮的那格跟着转到下中；子元素的位置键堆叠里都认得，不动。
      await write(() => flow('纵向堆叠').click());
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'column', gap: 1, justifyContent: 'end', alignItems: 'center' });
      expect((await named('容器')).children![0]!.place).toEqual({ height: 'fill' });
      expect(await head.getAttribute('data-flow')).toBe('column');
      expect(await lit()).toEqual(['下中']);

      // 两端在小下拉里：主轴分空隙，九宫格只管交叉轴，对上的一列三格都亮；点左下只改交叉轴（开头不写）。
      await write(() => spread.selectOption({ label: '两端' }));
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'column', gap: 1, justifyContent: 'spaceBetween', alignItems: 'center' });
      expect(await lit()).toEqual(['上中', '居中', '下中']);
      await write(() => cell('左下').click());
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'column', gap: 1, justifyContent: 'spaceBetween' });
      expect(await lit()).toEqual(['左上', '左中', '左下']);
      // 选回挨着排：主轴回到开头。
      await write(() => spread.selectOption({ label: '挨着排' }));
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'column', gap: 1 });
      expect(await lit()).toEqual(['左上']);

      // 换成网格：一个子元素一行一列，纵向的间距带成行间距；子元素补上行列；九宫格收起，行列轨道照旧，行间距与列间距并排。
      await write(() => flow('网格').click());
      expect((await named('容器')).layout).toEqual({ mode: 'grid', rows: ['hug'], columns: ['hug'], rowGap: 1 });
      expect((await named('容器')).children![0]!.place).toMatchObject({ row: 1, column: 1 });
      expect(await head.getByTestId('align-grid').count()).toBe(0);
      expect(await field('layout.rows').count()).toBe(1);
      expect(await field('layout.columns').count()).toBe(1);
      expect(await paired()).toEqual(['layout.rowGap', 'layout.columnGap']);
      // 换成自由：只剩 mode，子元素的行列清掉；没有并排的一行，内边距照常一项。
      await write(() => flow('自由').click());
      expect((await named('容器')).layout).toEqual({ mode: 'free' });
      expect((await named('容器')).children![0]!.place ?? {}).not.toHaveProperty('row');
      expect(await head.getAttribute('data-flow')).toBe('free');
      expect(await head.getByTestId('align-grid').count()).toBe(0);
      expect(await paired()).toEqual([]);
      expect(await field('padding').count()).toBe(1);
      // 再点回横向堆叠。
      await write(() => flow('横向堆叠').click());
      expect((await named('容器')).layout).toEqual({ mode: 'stack', direction: 'row' });
      expect(await paired()).toEqual(['layout.gap', 'padding']);

      // 循环的每项方向：同样的两个图标，点横向写 direction，每项高换成每项宽。
      await pick(`${ALL}/循环`);
      const direction = inspector.getByRole('group', { name: '方向' });
      expect(await attributes(direction.getByRole('button'), 'aria-label')).toEqual(['横向', '纵向']);
      expect(await direction.getByRole('button', { name: '纵向' }).getAttribute('aria-pressed')).toBe('true');
      expect(await direction.locator('svg').count()).toBe(2);
      await write(() => direction.getByRole('button', { name: '横向' }).click());
      const heights = before.artboard.children.find((child) => child.name === '循环')!.itemLayout!['heights'];
      expect((await named('循环')).itemLayout).toEqual({ direction: 'row', widths: heights });
      expect(await direction.getByRole('button', { name: '横向' }).getAttribute('aria-pressed')).toBe('true');

      // 撤销：一直撤到不能撤，回到原样。
      const undo = target.getByRole('button', { name: '撤销', exact: true });
      for (let step = 0; step < 20 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await content()).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ALL);
    }, 180_000);

    it('模板设计（第三轮 04）：文字的字体族与字重两个下拉，字号与字距一行，书写方向与对齐三组图标，竖排多"分散"、不列倾斜；适配收成一行，收起展开不写回；状态覆盖的圆点与重置照旧；撤销回到原样', async () => {
      const ALL = '全元素牌', ROOT = '标准线路单边', STOP = '站点', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ALL);
      type Element = { name: string; states?: { cases: Record<string, Record<string, unknown>> }; children?: Element[]; [key: string]: unknown };
      const contentOf = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body.content as string) as { artboard: Element & { children: Element[] } };
      };
      const find = (node: Element, name: string): Element | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const severe = async (name: string) => checkDslDocument(await contentOf(name)).problems.filter((problem) => problem.level === 'severe');
      const before = await contentOf(ALL);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const write = async (action: () => Promise<unknown>) => { const saved = stashed(); await action(); await saved; };
      const pick = async (path: string) => {
        await side.locator(`[data-testid="structure-row"][data-path="${path}"]`).getByRole('button').first().click();
        await inspector.locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
      };
      const attributes = (nodes: Locator, name: string) => nodes.evaluateAll((all, key) => all.map((node) => (node as unknown as { getAttribute(key: string): string | null }).getAttribute(key)), name);
      const labels = (key: string) => attributes(field(key).getByRole('button'), 'aria-label');
      const pressed = (key: string) => attributes(field(key).locator('button[aria-pressed="true"]'), 'aria-label');
      const choose = (key: string, name: string) => field(key).getByRole('button', { name, exact: true });
      const note = (name: string) => inspector.getByRole('region', { name }).getByTestId('section-note');
      const text = async () => find((await contentOf(ALL)).artboard, '文字')!;
      const summary = inspector.getByTestId('fit-summary'), rule = summary.getByTestId('fit-rule');

      // 字体：字体族与字重两个下拉一行，标签收起；换字重写的是这一族里另一个字体资源的引用。
      await pick(`${ALL}/文字`);
      const family = field('font').getByTestId('font-family'), weight = field('font').getByTestId('font-select');
      expect(await family.inputValue()).toBe('hei');
      expect(await family.locator('option').allTextContents()).toContain('hei');
      expect(await weight.inputValue()).toBe('res:font-hei-medium');
      expect(await weight.locator('option').allTextContents()).toEqual(['Medium', 'Heavy']);
      const selects = [(await family.boundingBox())!, (await weight.boundingBox())!];
      expect(Math.abs(selects[0]!.y - selects[1]!.y), '两个下拉在一行').toBeLessThan(2);
      await write(() => weight.selectOption({ label: 'Heavy' }));
      expect((await text())['font']).toBe('res:font-hei-heavy');
      expect(await family.inputValue()).toBe('hei');

      // 字号与字距一行：字号绑定着，值格与来源链照旧，来源链排在这一行下面；字距打数写回。
      expect(await attributes(inspector.locator('[data-testid="prop-pair"] > [data-testid="property-field"]'), 'data-key')).toEqual(['fontSize', 'letterSpacing']);
      // 前面的用例改过这个参数的显示名称，也断开过字号的绑定：没绑着就先绑回去，值格只认绑着，不认名称。
      if (typeof find(before.artboard, '文字')!['fontSize'] !== 'object') {
        await field('fontSize').getByTestId('bind-button').click();
        await write(() => field('fontSize').locator('[data-testid="binding-option"][data-name="nameSize"]').click());
      }
      await field('fontSize').getByTestId('bound-chip').waitFor();
      const cells =[(await field('fontSize').boundingBox())!, (await field('letterSpacing').boundingBox())!];
      expect(Math.abs(cells[0]!.y - cells[1]!.y), '字号与字距在一行').toBeLessThan(2);
      expect(cells[1]!.x).toBeGreaterThan(cells[0]!.x + cells[0]!.width - 1);
      const origin = (await field('fontSize').getByTestId('value-origin').boundingBox())!;
      expect(origin.width, '来源链占满这一行').toBeGreaterThan(cells[0]!.width + cells[1]!.width);
      expect(await field('color').getByTestId('bound-chip').count()).toBe(1);
      await write(() => field('letterSpacing').locator('input[type="text"]').fill('0.5'));
      expect((await text())['letterSpacing']).toBe(0.5);

      // 三组图标一行：书写方向没写，缺省的横排描边、不按下；水平对齐写着开头；横排的垂直对齐没有分散，倾斜在。
      const aligns = inspector.getByTestId('text-aligns');
      expect(await attributes(aligns.getByRole('group'), 'aria-label')).toEqual(['书写方向', '水平对齐', '垂直对齐']);
      const groups = await aligns.getByRole('group').evaluateAll((all) => all.map((node) => (node as unknown as { getBoundingClientRect(): { top: number } }).getBoundingClientRect().top));
      expect(Math.max(...groups) - Math.min(...groups), '三组在一行').toBeLessThan(2);
      expect(await labels('writingMode')).toEqual(['横排', '竖排']);
      expect(await labels('horizontalAlign')).toEqual(['开头', '居中', '末尾', '分散', '均分']);
      expect(await labels('verticalAlign')).toEqual(['上', '居中', '下']);
      expect(await pressed('writingMode')).toEqual([]);
      expect(await attributes(field('writingMode').locator('button.implied'), 'aria-label')).toEqual(['横排']);
      expect(await pressed('horizontalAlign')).toEqual(['开头']);
      expect(await aligns.locator('svg').count(), '书写方向与左中右是图标').toBe(5);
      // 倾斜没写，不占一行，在底部的"+ 属性"里（第三轮票据 05）。
      const slantOffer = inspector.getByTestId('add-property').locator('button[data-key="slant"]');
      expect(await field('slant').count()).toBe(0);
      expect(await slantOffer.count()).toBe(1);
      expect(await note('适配').textContent()).toBe('横排');

      // 横排写上分散与倾斜；换成竖排：只在横排才有的两项跟着去掉，垂直对齐多出分散，倾斜不列，文档没有严重问题。
      await write(() => choose('horizontalAlign', '分散').click());
      expect((await text())['horizontalAlign']).toBe('distribute');
      expect(await pressed('horizontalAlign')).toEqual(['分散']);
      await write(() => slantOffer.click());
      expect((await text())['slant']).toBe(0);
      await write(() => field('slant').locator('input[type="text"]').fill('8'));
      expect((await text())['slant']).toBe(8);
      await write(() => choose('writingMode', '竖排').click());
      const vertical = await text();
      expect(vertical['writingMode']).toBe('vertical');
      expect(vertical).not.toHaveProperty('horizontalAlign');
      expect(vertical).not.toHaveProperty('slant');
      expect(await pressed('writingMode')).toEqual(['竖排']);
      expect(await labels('horizontalAlign')).toEqual(['开头', '居中', '末尾']);
      expect(await labels('verticalAlign')).toEqual(['上', '居中', '下', '分散']);
      expect(await field('slant').count()).toBe(0);
      expect(await slantOffer.count(), '竖排不能倾斜，菜单里也不列').toBe(0);
      expect(await note('适配').textContent()).toBe('竖排');
      await write(() => choose('verticalAlign', '分散').click());
      expect((await text())['verticalAlign']).toBe('distribute');
      expect(await pressed('verticalAlign')).toEqual(['分散']);
      expect(await severe(ALL)).toEqual([]);

      // 适配收成一行：规则与这一处的结果；没点开时不列适配的字段。收起展开不写回。
      expect(await summary.getAttribute('aria-expanded')).toBe('false');
      expect(await rule.textContent()).toBe('收紧字距 → 压缩字形');
      await expect.poll(() => summary.getByTestId('fit-here').textContent(), { timeout: PREVIEW_WINDOW_MS }).toMatch(/^这一处：(没有压缩|压到 \d+%)，字号 [\d.]+ mm(，仍放不下)?$/);
      expect(await field('fit.steps').count()).toBe(0);
      const held = await contentOf(ALL), puts: string[] = [];
      const listen = (request: { method(): string; url(): string }) => { if (request.method() === 'PUT') puts.push(request.url()); };
      target.on('request', listen);
      await summary.click();
      expect(await summary.getAttribute('aria-expanded')).toBe('true');
      await inspector.getByTestId('fit-mode').filter({ hasText: '竖排' }).waitFor();
      expect(await field('fit.steps').count()).toBe(1);
      await summary.click();
      expect(await summary.getAttribute('aria-expanded')).toBe('false');
      expect(await field('fit.steps').count()).toBe(0);
      await target.waitForTimeout(1200);
      target.off('request', listen);
      expect(puts, '收起展开不写回').toEqual([]);
      expect(await contentOf(ALL)).toEqual(held);

      // 点开改：摘要跟着变；加了缩字组带上组名。
      await summary.click();
      await write(() => field('fit.steps').locator('select').first().selectOption({ label: '收紧字距' }));
      expect(await rule.textContent()).toBe('收紧字距');
      await write(() => field('fit.widthOverflow').getByRole('button', { name: '添加' }).click());
      await write(() => field('fit.widthOverflow.shrinkGroup').locator('input[type="text"]').fill('牌面'));
      await expect.poll(() => rule.textContent()).toBe('收紧字距 · 缩字组 牌面');
      expect((await text())['fit']).toMatchObject({ steps: ['tightenSpacing'], widthOverflow: { shrinkGroup: '牌面' } });
      expect(await severe(ALL)).toEqual([]);
      // 换回横排：垂直对齐的分散与缩字组跟着去掉，倾斜又列出来。
      await write(() => choose('writingMode', '横排').click());
      const back = await text();
      expect(back['writingMode']).toBe('horizontal');
      expect(back).not.toHaveProperty('verticalAlign');
      expect(back['fit']).toMatchObject({ steps: ['tightenSpacing'] });
      expect(back['fit']).not.toHaveProperty('widthOverflow');
      expect(await rule.textContent()).toBe('收紧字距');
      expect(await note('适配').textContent()).toBe('横排');
      expect(await slantOffer.count(), '换回横排，倾斜回到菜单里').toBe(1);
      expect(await severe(ALL)).toEqual([]);

      // 撤销：一直撤到不能撤，回到原样。
      const undo = target.getByRole('button', { name: '撤销', exact: true });
      for (let step = 0; step < 30 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await contentOf(ALL)).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ALL);

      // 状态覆盖照旧：站名的颜色被覆盖，标题写几项；选"本站"点水平对齐，写进这个取值的覆盖，图标组上有圆点，能重置。
      const stopBefore = await contentOf(STOP);
      const stopName = async () => find((await contentOf(STOP)).artboard, '站名')!;
      await target.goto(`${baseUrl}/console/#/templates/${enc(STOP)}/design?in=${enc(ROOT)}`);
      await target.getByTestId('preview-image').waitFor();
      for (const row of ['站点面板', '站点列', '名称区']) await openRow(side, row);
      await pick(`${STOP}/名称区/站名`);
      expect(await note('文字').textContent()).toBe('1 项被状态覆盖');
      expect(await note('文字').getAttribute('title')).toContain('颜色');
      expect(await field('horizontalAlign').getByTestId('state-dot').count()).toBe(0);
      expect(await pressed('verticalAlign')).toEqual(['分散']);
      expect(await rule.textContent()).toBe('收紧字距 → 压缩字形 · 缩字组 stopNames');
      await inspector.locator('[data-testid="state-chip"][data-value="本站"]').click();
      const reset = inspector.locator('[data-testid="state-reset"][data-key="horizontalAlign"]');
      expect(await reset.count()).toBe(0);
      await write(() => choose('horizontalAlign', '末尾').click());
      const overridden = await stopName();
      expect(overridden.states!.cases['本站']).toMatchObject({ horizontalAlign: 'end' });
      expect(overridden['horizontalAlign']).toBe(find(stopBefore.artboard, '站名')!['horizontalAlign']);
      expect(await pressed('horizontalAlign')).toEqual(['末尾']);
      expect(await field('horizontalAlign').getByTestId('state-dot').getAttribute('title')).toContain('本站');
      expect(await note('文字').textContent()).toBe('2 项被状态覆盖');
      expect(await severe(STOP)).toEqual([]);
      await write(() => reset.click());
      expect((await stopName()).states!.cases['本站']).not.toHaveProperty('horizontalAlign');
      expect(await field('horizontalAlign').getByTestId('state-dot').count()).toBe(0);
      for (let step = 0; step < 20 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await contentOf(STOP)).toEqual(stopBefore);
      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 240_000);

    it('模板设计（第三轮 05）：检查器只显示写了的与常用的属性，别的从"+ 属性"加，加上的项行内能去掉；宽高并排成一行；选了取值时加的项写进覆盖；撤销回到原样', async () => {
      const ALL = '全元素牌', ROOT = '标准线路单边', STOP = '站点', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ALL);
      type Element = { name: string; states?: { cases: Record<string, Record<string, unknown>> }; children?: Element[]; [key: string]: unknown };
      const contentOf = async (name: string) => {
        const copy = await server('GET', `/v1/templates/${enc(name)}/working-copy`, token);
        return JSON.parse(copy.status === 200 ? copy.body.content as string : (await server('GET', `/v1/templates/${enc(name)}/content`, token)).body.content as string) as { artboard: Element & { children: Element[] } };
      };
      const find = (node: Element, name: string): Element | undefined => (node.name === name ? node : (node.children ?? []).map((child) => find(child, name)).find(Boolean));
      const severe = async (name: string) => checkDslDocument(await contentOf(name)).problems.filter((problem) => problem.level === 'severe');
      const before = await contentOf(ALL);
      const element = async (name: string) => find((await contentOf(ALL)).artboard, name)!;
      await target.goto(`${baseUrl}/console/#/templates/${enc(ALL)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      const field = (key: string) => inspector.locator(`[data-testid="property-field"][data-key="${key}"]`).first();
      const stashed = () => target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
      const write = async (action: () => Promise<unknown>) => { const saved = stashed(); await action(); await saved; };
      const pick = async (path: string) => {
        await side.locator(`[data-testid="structure-row"][data-path="${path}"]`).getByRole('button').first().click();
        await inspector.locator(`[data-testid="properties"][data-path="${path}"]`).waitFor();
      };
      const attributes = (nodes: Locator, name: string) => nodes.evaluateAll((all, key) => all.map((node) => (node as unknown as { getAttribute(key: string): string | null }).getAttribute(key)), name);
      const menu = inspector.getByTestId('add-property');
      const add = (key: string) => menu.locator(`button[data-key="${key}"]`);
      const offered = () => attributes(menu.locator('button'), 'data-key');
      const drop = (key: string) => field(key).getByTestId('property-remove');
      const typed = (key: string) => field(key).locator('input[type="text"]').first();
      /** 没写的不常用项不显示、在菜单里；常用的写没写都显示、不在菜单里。 */
      const expectHidden = async (keys: readonly string[]) => {
        const menuKeys = await offered();
        for (const key of keys) { expect(await field(key).count(), `${key} 没写，不显示`).toBe(0); expect(menuKeys, `${key} 在"+ 属性"里`).toContain(key); }
      };
      const expectShown = async (keys: readonly string[]) => {
        const menuKeys = await offered();
        for (const key of keys) { expect(await field(key).count(), `${key} 总是显示`).toBe(1); expect(menuKeys, `${key} 不在"+ 属性"里`).not.toContain(key); }
      };

      // 文字：常用的（内容、文字块、位置与尺寸、显示）没写也显示；倾斜、描边、内边距、最小最大宽高、旋转没写，收在底部的"+ 属性"里。
      await pick(`${ALL}/文字`);
      const textBefore = find(before.artboard, '文字')!;
      for (const key of ['slant', 'stroke', 'padding', 'rotation']) expect(textBefore, `样例里文字没写 ${key}`).not.toHaveProperty(key);
      await expectShown(['font', 'fontSize', 'letterSpacing', 'color', 'writingMode', 'horizontalAlign', 'verticalAlign', 'place.left', 'place.right', 'place.top', 'place.bottom', 'place.width', 'place.height', 'visible', 'opacity']);
      await expectHidden(['slant', 'stroke', 'padding', 'place.minWidth', 'place.maxWidth', 'place.minHeight', 'place.maxHeight', 'rotation']);
      expect(await menu.getByRole('button').allTextContents()).toEqual(['倾斜', '描边', '内边距', '最小宽', '最大宽', '最小高', '最大高', '旋转']);
      expect(await inspector.getByTestId('property-remove').count(), '常用的项没有"去掉"').toBe(0);

      // 宽高并排成一行，名称缩成 W、H；读屏的名称还是"宽""高"。
      const pair = inspector.getByTestId('size-pair');
      expect(await attributes(pair.locator('> [data-testid="property-field"]'), 'data-key')).toEqual(['place.width', 'place.height']);
      expect(await pair.locator('> [data-testid="property-field"] > label').allTextContents()).toEqual(['W', 'H']);
      const cells = [(await field('place.width').boundingBox())!, (await field('place.height').boundingBox())!];
      expect(Math.abs(cells[0]!.y - cells[1]!.y), '宽高在一行').toBeLessThan(2);
      expect(cells[1]!.x).toBeGreaterThan(cells[0]!.x + cells[0]!.width - 1);
      expect(await field('place.width').getByRole('textbox', { name: '宽', exact: true }).count()).toBe(1);
      expect(await field('place.height').getByRole('combobox', { name: '高的尺寸方式' }).count()).toBe(1);
      const input = (await field('place.width').getByRole('textbox', { name: '宽', exact: true }).boundingBox())!;
      expect(input.width, '半行里数值框放得下四位数').toBeGreaterThanOrEqual(40);

      // 加一项：写它的初值，这一行出现在它的分组里、从菜单里消失，焦点落进它的编辑器。
      await write(() => add('rotation').click());
      expect((await element('文字'))['rotation']).toBe(0);
      await expectShown(['rotation']);
      expect(await inspector.getByRole('region', { name: '位置与尺寸' }).locator('[data-testid="property-field"][data-key="rotation"]').count()).toBe(1);
      expect(await inspector.locator('[data-testid="property-field"]:focus-within').first().getAttribute('data-key')).toBe('rotation');
      await write(() => typed('rotation').fill('15'));
      expect((await element('文字'))['rotation']).toBe(15);
      expect(await severe(ALL)).toEqual([]);
      // 清空输入框：键删掉了，这一行先留着（人还要接着打字），不跳回菜单；再打数照常写回。
      await write(() => typed('rotation').fill(''));
      expect(await element('文字')).not.toHaveProperty('rotation');
      await expectShown(['rotation']);
      await write(() => typed('rotation').fill('30'));
      expect((await element('文字'))['rotation']).toBe(30);
      // 去掉：删掉这个键，回到菜单里。
      expect(await drop('rotation').getAttribute('aria-label')).toBe('去掉旋转（度）');
      await write(() => drop('rotation').click());
      expect(await element('文字')).not.toHaveProperty('rotation');
      await expectHidden(['rotation']);

      // 一组的项（描边）：加上是带必填子项的初值；"去掉"只有行内这一个。
      await write(() => add('stroke').click());
      expect((await element('文字'))['stroke']).toEqual({ color: '#000000', width: 1 });
      await expectShown(['stroke']);
      expect(await field('stroke').getByRole('button', { name: '去掉描边', exact: true }).count()).toBe(1);
      expect(await severe(ALL)).toEqual([]);
      await write(() => drop('stroke').click());
      expect(await element('文字')).not.toHaveProperty('stroke');
      await expectHidden(['stroke']);
      // 加了再撤销：这一行跟着没了，不留空行。
      const undo = target.getByRole('button', { name: '撤销', exact: true });
      await write(() => add('padding').click());
      expect((await element('文字'))['padding']).toBe(0);
      await expectShown(['padding']);
      await write(() => undo.click());
      expect(await element('文字')).not.toHaveProperty('padding');
      await expectHidden(['padding']);

      // 容器：写了的不常用项（样例里的圆角）显示着、能去掉；开关加上就是打开；最大宽从这一处的实际宽度起，画面不变。
      await pick(`${ALL}/容器`);
      const boxBefore = find(before.artboard, '容器')!;
      await expectShown(['layout', 'padding', 'fill', 'place.width', 'place.height']);
      if ('cornerRadius' in boxBefore) expect(await drop('cornerRadius').count(), '写了的圆角能去掉').toBe(1);
      for (const key of ['clip', 'stroke']) expect(boxBefore, `样例里容器没写 ${key}`).not.toHaveProperty(key);
      await expectHidden(['clip', 'stroke', 'place.maxWidth', 'rotation']);
      await write(() => add('clip').click());
      expect((await element('容器'))['clip']).toBe(true);
      await expectShown(['clip']);
      await write(() => add('place.maxWidth').click());
      const limit = ((await element('容器'))['place'] as Record<string, unknown>)['maxWidth'];
      expect(limit, '最大宽的初值是量出来的宽，不是 0').toBeGreaterThan(0);
      await expectShown(['place.maxWidth']);
      expect(await severe(ALL)).toEqual([]);
      await write(() => drop('place.maxWidth').click());
      expect((await element('容器'))['place']).toEqual(boxBefore['place']);
      await write(() => drop('clip').click());
      expect(await element('容器')).toEqual(boxBefore);

      // 循环：反序、只取一段在"+ 属性"里，加上显示在循环那一栏。
      await pick(`${ALL}/循环`);
      const loopBefore = find(before.artboard, '循环')!;
      for (const key of ['reverse', 'slice']) expect(loopBefore, `样例里循环没写 ${key}`).not.toHaveProperty(key);
      await expectHidden(['reverse', 'slice']);
      await write(() => add('reverse').click());
      expect((await element('循环'))['reverse']).toBe(true);
      expect(await inspector.getByRole('region', { name: '循环', exact: true }).locator('[data-testid="property-field"][data-key="reverse"]').count()).toBe(1);
      await write(() => add('slice').click());
      expect((await element('循环'))['slice']).toEqual({ start: 1 });
      expect(await severe(ALL)).toEqual([]);
      await write(() => drop('slice').click());
      await write(() => drop('reverse').click());
      expect(await element('循环')).toEqual(loopBefore);

      // 线条：随框缩放要先有视图框，没有时按钮是灰的、写明先加哪一项。
      await pick(`${ALL}/线条`);
      const lineBefore = find(before.artboard, '线条')!;
      expect(lineBefore, '样例里线条没写视图框').not.toHaveProperty('viewBox');
      await expectHidden(['viewBox', 'fit']);
      expect(await add('fit').isDisabled()).toBe(true);
      expect(await add('fit').getAttribute('title')).toBe('先加视图框');
      await write(() => add('viewBox').click());
      expect((await element('线条'))['viewBox']).toEqual([0, 0, 1, 1]);
      expect(await add('fit').isDisabled()).toBe(false);
      await write(() => add('fit').click());
      expect((await element('线条'))['fit']).toBe('fill');
      expect(await severe(ALL)).toEqual([]);
      await write(() => drop('fit').click());
      await write(() => drop('viewBox').click());
      expect(await element('线条')).toEqual(lineBefore);

      // 画板：尺寸范围、缩字下限、排布总是显示；描边、圆角、裁剪从"+ 属性"加，写在 artboard 上。
      await pick(ALL);
      await expectShown(['sizeRange', 'minFontSize', 'layout', 'padding']);
      const boardKeys = ['stroke', 'cornerRadius', 'clip'].filter((key) => !(key in before.artboard));
      expect(boardKeys.length, '样例里画板至少有一项没写').toBeGreaterThan(0);
      await expectHidden(boardKeys);
      await write(() => add(boardKeys[0]!).click());
      expect((await contentOf(ALL)).artboard).toHaveProperty(boardKeys[0]!);
      await expectShown([boardKeys[0]!]);
      expect(await severe(ALL)).toEqual([]);
      await write(() => drop(boardKeys[0]!).click());
      expect(await contentOf(ALL)).toEqual(before);

      // 撤销：一直撤到不能撤，回到原样。
      for (let step = 0; step < 40 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await contentOf(ALL)).toEqual(before);
      await server('DELETE', `/v1/templates/${enc(ALL)}/working-copy`, token);
      await leaveDesign(target, ALL);

      // 状态样式模式：选"本站"后从"+ 属性"加的项写进这个取值的覆盖，自身属性不动；这一行有圆点、没有"去掉"，重置后回到菜单里。
      const stopBefore = await contentOf(STOP);
      const stopName = async () => find((await contentOf(STOP)).artboard, '站名')!;
      expect(find(stopBefore.artboard, '站名')!, '样例里站名没写旋转').not.toHaveProperty('rotation');
      await target.goto(`${baseUrl}/console/#/templates/${enc(STOP)}/design?in=${enc(ROOT)}`);
      await target.getByTestId('preview-image').waitFor();
      for (const row of ['站点面板', '站点列', '名称区']) await openRow(side, row);
      await pick(`${STOP}/名称区/站名`);
      // 站名在纵向堆叠里：宽高照样并排，外边距在下一行；自身对齐只在堆叠里才有，在菜单里。
      expect(await attributes(pair.locator('> [data-testid="property-field"]'), 'data-key')).toEqual(['place.width', 'place.height']);
      await expectShown(['place.margin']);
      await expectHidden(['rotation', 'place.alignSelf']);
      await inspector.locator('[data-testid="state-chip"][data-value="本站"]').click();
      await expectHidden(['rotation']);
      expect(await add('rotation').getAttribute('title')).toBe('写进这个取值的覆盖');
      await write(() => add('rotation').click());
      const overridden = await stopName();
      expect(overridden.states!.cases['本站']).toMatchObject({ rotation: 0 });
      expect(overridden).not.toHaveProperty('rotation');
      await expectShown(['rotation']);
      expect(await field('rotation').getByTestId('state-dot').count()).toBe(1);
      expect(await drop('rotation').count(), '覆盖的项用"重置为自身属性"，没有"去掉"').toBe(0);
      expect(await severe(STOP)).toEqual([]);
      // 换回自身属性：自身没写旋转，这一行不显示。
      await inspector.locator('[data-testid="state-chip"][data-value=""]').click();
      await expectHidden(['rotation']);
      await inspector.locator('[data-testid="state-chip"][data-value="本站"]').click();
      await expectShown(['rotation']);
      await write(() => field('rotation').getByTestId('state-reset').click());
      expect((await stopName()).states?.cases['本站'] ?? {}).not.toHaveProperty('rotation');
      await expectHidden(['rotation']);
      for (let step = 0; step < 20 && await undo.isEnabled(); step++) await write(() => undo.click());
      expect(await contentOf(STOP)).toEqual(stopBefore);
      await server('DELETE', `/v1/templates/${enc(STOP)}/working-copy`, token);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 240_000);

    // 打点（票据 11）：平时不跑，要真实的 worker 才有意义。排队与渲染的拆分另查 render_tasks；用法见票据 11 的 Answer。
    it.skipIf(!process.env['RW_TIMING'])('模板设计（打点）：改一项到换图的耗时', async () => {
      const ROOT = '标准线路单边', token = world.b.admin.token;
      const target = await asAdmin();
      await leaveDesign(target, ROOT);
      await target.goto(`${baseUrl}/console/#/templates/${enc(ROOT)}/design`);
      await target.getByTestId('preview-image').waitFor();
      const side = target.getByRole('complementary', { name: '结构与变量' }), inspector = target.getByRole('complementary', { name: '检查器' });
      // 等样例带补完缩略图，别和打点抢并发。
      await expect.poll(() => target.locator('[data-testid="sample-card"]').first().getByTestId('sample-state').textContent(), { timeout: 60_000 }).toMatch(/没有问题|个提示|个严重问题/);
      await target.waitForTimeout(5_000);
      await side.getByRole('tab', { name: '变量' }).click();
      await side.locator('[data-name="stopNameSize"]').getByRole('button').click();
      const input = inspector.locator('[data-testid="property-field"][data-key="default"]').first().locator('input[type="text"]').first();
      const span = (response: { request(): { timing(): { requestStart: number; responseEnd: number } } }) => { const timing = response.request().timing(); return Math.round(timing.responseEnd - Math.max(0, timing.requestStart)); };
      const rows: { readonly total: number; readonly write: number; readonly preview: number }[] = [];
      for (let round = 0; round < 12; round++) {
        const before = await target.getByTestId('preview-image').getAttribute('src');
        const write = target.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes('/working-copy?') && response.status() === 200, { timeout: 60_000 });
        const preview = target.waitForResponse((response) => response.url().endsWith('/v1/previews?workingCopies=true') && response.status() === 200, { timeout: 60_000 });
        const started = Date.now();
        await input.fill(String(9 + (round % 3)));
        const [written, previewed] = await Promise.all([write, preview]);
        await expect.poll(() => target.getByTestId('preview-image').getAttribute('src'), { interval: 10, timeout: 30_000 }).not.toBe(before);
        rows.push({ total: Date.now() - started, write: span(written), preview: span(previewed) });
        await target.waitForTimeout(1_500);
      }
      console.log(`TIMING ${JSON.stringify(rows)}`);
      await server('DELETE', `/v1/templates/${enc(ROOT)}/working-copy`, token);
      await leaveDesign(target, ROOT);
    }, 180_000);

    it('没有模板也能按静态数据定义创建和编辑数据集，历史版本保持固定，错误的版本与模板组合明确拒绝', async () => {
      const created = await world.call('POST', '/v1/platform/tenants', world.platform, { name: '无模板数据集测试' });
      const owner = await world.member(created.body.id, 'admin'), operator = await world.member(created.body.id, 'operator');
      const schema = 'inventory-card', token = owner.token, draftUrl = `/v1/definitions/${schema}`;
      expect((await server('GET', '/v1/templates', token)).body.templates).toEqual([]);
      const isolated = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
      const target = await isolated.newPage(); watch(target);
      try {
        await target.goto(`${baseUrl}/console/#/datasets/new`);
        await target.getByLabel('邮箱').fill(operator.email);
        await target.getByLabel('密码').fill(operator.password);
        await target.getByRole('button', { name: '登录' }).click();
        await target.getByText('还没有可用的静态数据定义。', { exact: false }).waitFor();
        for (const version of [1, 2]) {
          const made = version === 1 ? await server('POST', draftUrl.slice(0, draftUrl.lastIndexOf('/')), token, { name: schema, displayName: '库存卡' }) : await server('GET', draftUrl, token);
          expect(made.status, made.raw).toBe(version === 1 ? 201 : 200);
          const document = { dslVersion: 'renderweave-schema/1', name: schema, displayName: '库存卡', fields: [
            { name: 'sku', displayName: '货号', type: 'text', constraints: { required: true } },
            ...(version === 2 ? [{ name: 'bin', displayName: '库位', type: 'text', constraints: { required: true } }] : []),
          ] };
          const saved = await server('PUT', `${draftUrl}?expectedSha256=${made.body.sha256}`, token, document);
          expect(saved.status, saved.raw).toBe(200);
          const published = await server('POST', `${draftUrl}/publish`, token, { expectedSha256: saved.body.sha256 });
          expect(published.status, published.raw).toBe(201);
        }
        await target.reload();
        await target.getByLabel('数据定义与版本').selectOption(JSON.stringify([schema, 1]));
        await mkdir('out/dataset-module', { recursive: true });
        await target.screenshot({ path: 'out/dataset-module/new.png', fullPage: true });
        await target.getByRole('button', { name: '开始填写' }).click();
        await target.getByLabel('数据集 ID').fill('inventory-001');
        await target.getByLabel('名称', { exact: true }).fill('一号仓库存卡');
        await target.getByLabel('货号', { exact: true }).fill('000123');
        expect(await target.getByLabel('库位', { exact: true }).count()).toBe(0);
        await target.getByText('数据可以独立保存。', { exact: false }).waitFor();
        await target.getByRole('button', { name: '保存', exact: true }).click();
        await target.getByRole('status').filter({ hasText: '已保存数据集 inventory-001' }).waitFor();
        await target.reload();
        expect(await target.getByLabel('货号', { exact: true }).inputValue()).toBe('000123');
        await target.getByLabel('货号', { exact: true }).fill('000124');
        await target.getByRole('button', { name: '保存', exact: true }).click();
        await target.getByRole('status').filter({ hasText: '已保存' }).waitFor();
        const dataset = (await server('GET', '/v1/datasets/inventory-001', operator.token)).body;
        expect(dataset.dataset.staticSchema).toEqual({ name: schema, version: 1 });
        expect(dataset.data).toEqual({ sku: '000124' });
        expect(await target.getByRole('button', { name: '出图…' }).isDisabled()).toBe(true);
        await target.screenshot({ path: 'out/dataset-module/editor.png', fullPage: true });
        await target.getByRole('link', { name: /数据定义.*库存卡/ }).click();
        await target.getByRole('link', { name: '新建数据集', exact: true }).click();
        await target.getByLabel('货号', { exact: true }).waitFor();
        expect(new URL(target.url()).hash).toContain('version=1');
        expect(await target.getByLabel('库位', { exact: true }).count()).toBe(0);
        await target.goto(`${baseUrl}/console/#/datasets/new?schema=${schema}&version=UP`);
        await target.getByText('请选择静态数据定义的名称和确切版本', { exact: true }).waitFor();
        await target.goto(`${baseUrl}/console/#/datasets/new?schema=${schema}&version=99`);
        await target.getByText('打不开数据集', { exact: true }).waitFor();
        expect(await target.getByLabel('数据集 ID').count()).toBe(0);
        await target.goto(`${baseUrl}/console/#/datasets`);
        await target.getByRole('link', { name: '一号仓库存卡' }).waitFor();
        await target.screenshot({ path: 'out/dataset-module/list.png', fullPage: true });
        await page.goto(`${baseUrl}/console/#/datasets/new?schema=${enc('线路牌')}&version=1&template=${enc(BADGE)}`);
        await page.getByText('模板使用的静态数据定义与所选版本不一致，请重新选择', { exact: true }).waitFor();
        expect(await page.getByLabel('数据集 ID').count()).toBe(0);
      } finally { await isolated.close(); }
    }, 120_000);

    it('退出后会话失效，回到登录页；整个过程没有脚本错误，也没有被内容安全策略拦下的资源', async () => {
      await page.getByRole('button', { name: '退出' }).click();
      await page.getByRole('button', { name: '登录' }).waitFor();
      expect(await page.evaluate(() => sessionStorage.getItem('renderweave.console.token'))).toBeNull();
      expect(pageErrors).toEqual([]);
    });
  });
}
