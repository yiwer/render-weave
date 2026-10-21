/**
 * 出图控制台的浏览器端到端测试（票据 12，M281）：浏览器经接口进程打开 /console/，像客户操作员一样
 * 登录、看模板、调参数、填表、预览、出图、下载；每一步的结果再经开放 API 核对，不看控制台的内部状态。
 * 界面按原型方案一（M282）：首页是数据集，编辑页左表单、右草稿预览，出图在侧栏里进行。
 * Docker 后端测试里浏览器是 tester 容器里的 Chromium，接口进程与 worker 是 Compose 里真实的进程（console.docker.test.ts）；
 * 本机另可用内存后端加本机浏览器快速跑（console.browser.test.ts，设 RW_BROWSER）。
 */
import { readFile } from 'node:fs/promises';
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
}

const BADGE = '会议胸牌';
const ROUTE = '标准线路单边';
const M402 = 'ds-m402-wanguocheng';
/** 照片字段上传的新图。 */
const UPLOAD = `${RESOURCES_DIR}images/m402/landmark-1.png`;
/** 姓名框 50 mm、字号 9 mm，压到 60% 仍放不下十个字：草稿标出问题，正式交付失败（layout.textOverflow）。 */
const LONG_NAME = '欧阳娜娜娜娜娜娜娜娜';

export function describeConsole(name: string, makeBackend: () => Promise<ServiceBackend>, options: ConsoleSuiteOptions): void {
  describe.skipIf(options.skip ?? false)(`出图控制台（${name}）`, () => {
    let world: World, browser: Browser, context: BrowserContext, page: Page, baseUrl: string, stop: () => Promise<void>;
    const pageErrors: string[] = [];

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
      // 脚本错误与内容安全策略拦下的资源都算失败；接口答 4xx 时浏览器打印的"Failed to load resource"不算。
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) pageErrors.push(message.text()); });
    });
    afterAll(async () => {
      await browser?.close();
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

    it('登录后首页是数据集；模板列表有缩略预览、适用尺寸范围与对应的数据定义；在只读预览上调对外参数看草稿预览', async () => {
      await page.goto(`${baseUrl}/console/`);
      await page.getByLabel('邮箱').fill(world.b.operator.email);
      await page.getByLabel('密码').fill(world.b.operator.password);
      await page.getByRole('button', { name: '登录' }).click();
      await page.getByRole('heading', { name: '数据集', level: 1 }).waitFor();
      await page.getByRole('link', { name: 'M402 开往万国城总站' }).waitFor();
      // 操作员读不到用量（M247），顶栏不显示剩余张数。
      expect(await page.getByTestId('quota').count()).toBe(0);

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

    it('退出后会话失效，回到登录页；整个过程没有脚本错误，也没有被内容安全策略拦下的资源', async () => {
      await page.getByRole('button', { name: '退出' }).click();
      await page.getByRole('button', { name: '登录' }).waitFor();
      expect(await page.evaluate(() => sessionStorage.getItem('renderweave.console.token'))).toBeNull();
      expect(pageErrors).toEqual([]);
    });
  });
}
