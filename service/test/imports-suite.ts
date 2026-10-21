/**
 * Excel 导入（票据 13，M248）：只经 HTTP 驱动，断言导入预览（逐行的数据集与问题、可以直接提交的批量请求）、
 * 空白表，以及按预览提交之后的交付结果。
 * 同一组用例跑两种后端：内存后端加进程内 worker 进 npm test；PostgreSQL 加 S3 在 Docker 后端测试里跑。
 * 测试进程里的接口进程接受的批次带测试进程的构建标识，两种后端都在测试进程里起一个同构建的 worker 交付（同批量交付的用例）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import type { ServiceBackend } from '../src/backend.js';
import { publishStaticSchema, rendererBuildId } from '../src/engine.js';
import { inProcessRunner, startScheduler, type Scheduler } from '../src/worker/scheduler.js';
import { createWorld, type World } from './api-suite.js';
import { CONSOLE_BADGE_DIR, seedConsoleBadge, seedDocuments, seedM402, seedPriceTag } from './seed.js';
import { xlsxOf, type FixtureCell, type FixtureOptions } from './xlsx-fixture.js';

const EXCEL_DIR = fileURLToPath(new URL('../../fixtures/excel/', import.meta.url));
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PRICE_OUTPUT = { width: 100, height: 50, dpi: 200, format: 'png' };
const ROUTE_OUTPUT = { width: 1100, height: 165, dpi: 72, format: 'png' };
const PRICE_TAG = { name: '商品价签', version: 1 };
const PRICE_HEADER = ['渲染项 ID', '品名', '规格', '单位', '产地', '货号', '零售价', '会员价', '促销', '促销截止', '卖点'];
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
/** 日期的 Excel 序号：1900 日期系统从 1899-12-30 起算（跳过 Excel 当作存在的 1900-02-29），1904 日期系统从 1904-01-01 起算。 */
const serial = (date: string, date1904 = false) => (Date.parse(`${date}T00:00:00Z`) - Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) / 86_400_000;

/** 读出 zip 里的一个文件（空白表的结构检查用）。 */
function entryText(bytes: Uint8Array, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        zip.openReadStream(entry, (failed, stream) => {
          if (failed || !stream) return reject(failed);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks).toString('utf8')); });
        });
      });
      zip.on('end', () => reject(new Error(`zip 里没有 ${name}`)));
      zip.readEntry();
    });
  });
}
/** 工作表 XML 第一行里内联字符串的文字。 */
const headerOf = (xml: string) => [...(/<row r="1"[^>]*>(.*?)<\/row>/s.exec(xml)?.[1] ?? '').matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => match[1]);

export function describeImports(name: string, makeBackend: () => Promise<ServiceBackend>): void {
  describe(`Excel 导入（${name}）`, () => {
    let world: World, scheduler: Scheduler | undefined;
    beforeAll(async () => {
      const backend = await makeBackend();
      world = await createWorld(backend);
      const storage = backend.tenant(world.b.id).storage;
      await seedM402(storage);
      await seedPriceTag(storage);
      await seedConsoleBadge(storage, { withFont: false });
      scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 5, workerId: 'imports-suite', build: await rendererBuildId(), leaseMs: 60_000 });
    });
    afterAll(async () => { await scheduler?.stop(); });

    const importWorkbook = (workbook: Uint8Array | string, template = '商品价签', extra: Record<string, unknown> = {}, token = world.b.operator.token) =>
      world.call('POST', '/v1/excel-imports', token, {
        template, workbook: typeof workbook === 'string' ? workbook : base64(workbook), output: template === '商品价签' ? PRICE_OUTPUT : ROUTE_OUTPUT, ...extra,
      });
    const readSample = async (file: string) => new Uint8Array(await readFile(`${EXCEL_DIR}${file}`));
    const expected = async (file: string) => JSON.parse(await readFile(`${EXCEL_DIR}${file}`, 'utf8')) as {
      staticSchema: { name: string; version: number }; rows: { itemId: string; data: unknown }[] };
    /** 提交预览里的批量请求，等批次结束。 */
    const deliver = async (batch: unknown) => {
      const submitted = await world.call('POST', '/v1/batches', world.b.operator.token, batch, { 'idempotency-key': `imports-${Math.random()}` });
      expect(submitted.status, submitted.raw.slice(0, 500)).toBe(202);
      const deadline = Date.now() + 120_000;
      for (;;) {
        const reply = await world.call('GET', `/v1/batches/${submitted.body.id}`, world.b.operator.token);
        if (reply.body.status === 'finished') return reply.body;
        if (Date.now() > deadline) throw new Error(`批次没有结束：${reply.raw.slice(0, 500)}`);
        await sleep(20);
      }
    };
    /** 一行的问题，按问题码与单元格列出。 */
    const where = (problems: readonly { code: string; cell?: { sheet: string; row: number; column?: string } }[]) =>
      problems.map(({ code, cell }) => `${code}@${cell?.sheet}!${cell?.column ?? ''}${cell?.row}`).sort();

    it('价签样例（扁平的字段）：一行一个渲染项，读出的数据与样例的 JSON 相同；不认识的列提示后忽略；按预览提交后全部交付', async () => {
      const { call, b } = world;
      const before = (await call('GET', '/v1/datasets', b.operator.token)).body;
      const reply = await importWorkbook(await readSample('price-tags.xlsx'), '商品价签', { parameters: { storeName: '城东店' } });
      expect(reply.status, reply.raw.slice(0, 800)).toBe(200);
      const want = await expected('price-tags.json');
      expect(reply.body).toMatchObject({ template: '商品价签', staticSchema: PRICE_TAG, sheet: '商品价签', summary: { rows: 6, accepted: 6, rejected: 0 } });
      expect(reply.body.rows.map((row: { row: number; itemId: string; status: string }) => [row.row, row.itemId, row.status]))
        .toEqual(want.rows.map((row, i) => [i + 2, row.itemId, 'accepted']));
      reply.body.rows.forEach((row: { dataset: unknown; problems: unknown[] }, i: number) => {
        expect(row.dataset).toEqual({ dataset: { staticSchema: PRICE_TAG, origin: { kind: 'excel', sheet: '商品价签', row: i + 2 } }, data: want.rows[i]!.data });
        expect(row.problems).toEqual([]);
      });
      expect(reply.body.problems).toEqual([expect.objectContaining({ level: 'hint', code: 'import.columnUnknown', cell: { sheet: '商品价签', row: 1, column: 'L', header: '备注' } })]);
      expect(reply.body.batch).toEqual({
        template: '商品价签', mode: 'final',
        items: reply.body.rows.map((row: { itemId: string; dataset: unknown }) => ({ id: row.itemId, dataset: { inline: row.dataset }, parameters: { storeName: '城东店' }, output: PRICE_OUTPUT })),
      });
      // 预览不保存任何东西：数据集不变，也没有批次。
      expect((await call('GET', '/v1/datasets', b.operator.token)).body).toEqual(before);

      const done = await deliver(reply.body.batch);
      expect(done.summary).toMatchObject({ total: 6, delivered: 6, failed: 0 });
      expect(done.items.map((item: { id: string }) => item.id)).toEqual(want.rows.map((row) => row.itemId));
    });

    it('线路牌样例（站点在另一张表）：主表的关联值对上"停靠站点"表的行，按顺序组成列表；第一行与 M402 数据集逐字段相同；提交后交付', async () => {
      const reply = await importWorkbook(await readSample('route-signs.xlsx'), '标准线路单边', { parameters: { currentIndex: 3 } }, world.b.key.token);
      expect(reply.status, reply.raw.slice(0, 800)).toBe(200);
      const want = await expected('route-signs.json');
      const m402 = JSON.parse(await readFile(fileURLToPath(new URL('../../docs/examples/m402-dsl/dataset-m402.json', import.meta.url)), 'utf8'));
      expect(want.rows[0]!.data).toEqual(m402.data);
      expect(reply.body).toMatchObject({ template: '标准线路单边', staticSchema: { name: '线路牌', version: 1 }, sheet: '线路牌（单线路单方向）', summary: { rows: 2, accepted: 2, rejected: 0 } });
      expect(reply.body.problems).toEqual([]);
      expect(reply.body.rows.map((row: { itemId: string; dataset: { data: unknown }; problems: unknown[] }) => [row.itemId, row.dataset.data, row.problems]))
        .toEqual(want.rows.map((row) => [row.itemId, row.data, []]));

      const done = await deliver(reply.body.batch);
      expect(done.summary).toMatchObject({ total: 2, delivered: 2, failed: 0 });
    });

    it('逐行逐列的问题：问题定位到工作表、行与列；有问题的行不进批量请求；空行跳过', async () => {
      const row = (id: string, name: string | null, unit: string, itemNo: FixtureCell, price: FixtureCell, extra: FixtureCell[] = []): FixtureCell[] =>
        [id, name, null, unit, null, itemNo, price, ...extra];
      const workbook = await xlsxOf([{ name: '商品价签', rows: [
        PRICE_HEADER,
        row('A1', '好的商品', '个', '0000001', 9.9),
        row('A2', '价格不对', '个', '0000002', 'abc'),
        row('A3', '单位不对', '斤', '0000003', 1),
        row('A4', null, '个', '0000004', 1),
        row('A1', '重复的 ID', '个', '0000005', 1),
        row('A6', '错误值', '个', '0000006', 1, [{ error: '#N/A' }]),
        row('A7', '卖点太多', '个', '0000007', 1, [null, null, null, '一、二、三、四']),
        row('A8', '卖点太长', '个', '0000008', 1, [null, null, null, '短、这个卖点太长了']),
        row('A9', '货号丢了零', '个', 12345, 1),
        [],
        row('A10', '两处问题', '盒', '0000010', -1, ['x']),
        row('A11', '数值溢出', '个', '0000011', '1e400'),
      ] }]);
      const reply = await importWorkbook(workbook);
      expect(reply.status, reply.raw.slice(0, 800)).toBe(200);
      expect(reply.body.summary).toEqual({ rows: 11, accepted: 1, rejected: 10 });
      expect(reply.body.problems).toEqual([]);
      const byId = Object.fromEntries(reply.body.rows.map((r: { row: number; status: string; problems: [] }) => [r.row, [r.status, where(r.problems)]]));
      expect(byId).toEqual({
        2: ['accepted', []],
        3: ['rejected', ['dataset.typeMismatch@商品价签!G3']],
        4: ['rejected', ['dataset.constraintViolated@商品价签!D4']],
        5: ['rejected', ['dataset.requiredMissing@商品价签!B5']],
        6: ['rejected', ['import.itemIdDuplicate@商品价签!A6']],
        7: ['rejected', ['import.cellError@商品价签!H7']],
        8: ['rejected', ['dataset.constraintViolated@商品价签!K8']],
        9: ['rejected', ['dataset.constraintViolated@商品价签!K9']],
        10: ['rejected', ['dataset.formatInvalid@商品价签!F10']],
        12: ['rejected', ['dataset.constraintViolated@商品价签!G12', 'dataset.typeMismatch@商品价签!H12']],
        // 写成数字却超出双精度范围的文字原样交给引擎，报类型不对，而不是变成 null。
        13: ['rejected', ['dataset.typeMismatch@商品价签!G13']],
      });
      // 引擎的问题原样保留（与保存数据集时相同），另带单元格：列号与表头。
      const tooLong = reply.body.rows.find((r: { row: number }) => r.row === 9).problems[0];
      expect(tooLong).toMatchObject({ level: 'severe', location: { kind: 'field', path: 'features[2]' }, cell: { sheet: '商品价签', row: 9, column: 'K', header: '卖点' } });
      expect(reply.body.batch.items.map((item: { id: string }) => item.id)).toEqual(['A1']);
    });

    it('表头上方可以有标题行；出图参数与对外参数不合规时作为整份的严重问题，回答里没有批量请求', async () => {
      const titled = await importWorkbook(await xlsxOf([{ name: '商品价签', rows: [['城东店价签 2026 年 11 月'], [], PRICE_HEADER, ['T1', '饮用水', null, '瓶', null, '0000001', 2]] }]));
      expect(titled.status, titled.raw.slice(0, 500)).toBe(200);
      expect(titled.body.problems).toEqual([]);
      expect(titled.body.rows).toEqual([expect.objectContaining({ row: 4, itemId: 'T1', status: 'accepted' })]);

      const sample = await readSample('price-tags.xlsx');
      const wide = await importWorkbook(sample, '商品价签', { output: { ...PRICE_OUTPUT, width: 200 } });
      expect(wide.status).toBe(200);
      expect(wide.body.summary).toMatchObject({ accepted: 6 });
      expect(wide.body.problems.filter((p: { level: string }) => p.level === 'severe')).toEqual([expect.objectContaining({ code: 'render.sizeOutOfRange' })]);
      expect(wide.body.batch).toBeUndefined();
      const parameters = await importWorkbook(sample, '商品价签', { parameters: { storeName: '城东店', nope: 1 } });
      expect(parameters.body.problems.filter((p: { level: string }) => p.level === 'severe')).toEqual([expect.objectContaining({ code: 'parameter.unknown', location: { kind: 'parameter', name: 'nope' } })]);
      expect(parameters.body.batch).toBeUndefined();
    });

    it('引用列表的问题：关联值找不到、站点表里的字段问题定位到站点表的单元格、没人引用的站点行提示；引用只能对应一行', async () => {
      const stops = (rows: FixtureCell[][]) => ({ name: '停靠站点', rows: [['停靠站点', '站名', '所在道路', '站名上方的标识'], ...rows] });
      // 说明与引用表放在前面：主表按名称（数据定义的名称）认出来。
      const workbook = await xlsxOf([
        { name: '填写说明', rows: [['站点写在"停靠站点"表里']] },
        stops([['G1', '甲站', '一路'], ['G1', '乙站', '一路', '地铁、医院'], ['G3', '丙站', null], ['G3', '丁站', '二路', '公交'], ['G9', '孤站', '三路']]),
        { name: '线路牌', rows: [['线路号', '票制', '停靠站点'], ['L1', null, 'G1'], ['L2', null, 'G404'], ['L3', null, 'G3'], ['L4', null, null]] },
      ]);
      const reply = await importWorkbook(workbook, '标准线路单边');
      expect(reply.status, reply.raw.slice(0, 800)).toBe(200);
      expect(reply.body.sheet).toBe('线路牌');
      expect(reply.body.summary).toEqual({ rows: 4, accepted: 1, rejected: 3 });
      expect(reply.body.rows[0].dataset.data).toEqual({ routeNo: 'L1', stops: [{ name: '甲站', road: '一路' }, { name: '乙站', road: '一路', badges: ['地铁', '医院'] }] });
      expect(reply.body.rows.map((r: { problems: [] }) => where(r.problems))).toEqual([
        [],
        ['import.referenceNotFound@线路牌!C3'],
        ['dataset.constraintViolated@停靠站点!D5', 'dataset.requiredMissing@停靠站点!C4'],
        ['dataset.requiredMissing@线路牌!C5'],
      ]);
      expect(where(reply.body.problems)).toEqual(['import.rowOrphan@停靠站点!6']);
      expect(reply.body.problems[0].level).toBe('hint');

      // 没有"停靠站点"这张表：写了关联值的行都找不到。
      const missing = await importWorkbook(await xlsxOf([{ name: '线路牌', rows: [['线路号', '停靠站点'], ['L1', 'G1']] }]), '标准线路单边');
      expect(where(missing.body.rows[0].problems)).toEqual(['import.referenceNotFound@线路牌!B2']);

      // 主表没有"停靠站点"列：站点表照样读，里面的行都没人引用，提示已忽略；各行缺必填的站点。
      const noColumn = await importWorkbook(await xlsxOf([{ name: '线路牌', rows: [['线路号'], ['L1']] }, stops([['G1', '甲站', '一路'], ['G1', '乙站', '一路']])]), '标准线路单边');
      expect(where(noColumn.body.problems)).toEqual(['import.columnMissing@线路牌!1', 'import.rowOrphan@停靠站点!2']);
      expect(where(noColumn.body.rows[0].problems)).toEqual(['dataset.requiredMissing@线路牌!2']);

      // 单个引用（胸牌的主场次）只能对应一行。
      const badge = await xlsxOf([
        { name: '会议胸牌', rows: [['姓名', '身份', '证件号', '会议日期', '主场次'], ['张三', '讲者', 'SP0001', '2026-11-20', '主旨']] },
        { name: '主场次', rows: [['主场次', '场次名称', '开始时刻'], ['主旨', '主旨演讲', '09:30'], ['主旨', '又一场', '10:30']] },
      ]);
      const twice = await importWorkbook(badge, '会议胸牌', { output: { width: 90, height: 130, dpi: 120, format: 'png' } });
      expect(where(twice.body.rows[0].problems)).toEqual(['import.referenceTooManyRows@会议胸牌!E2']);

      // 名为"参会场次"的表缺关联值的列，但没有行引用它：只提示，不妨碍提交。
      const stray = await xlsxOf([
        { name: '会议胸牌', rows: [['姓名', '身份', '证件号', '会议日期'], ['张三', '讲者', 'SP0001', '2026-11-20']] },
        { name: '参会场次', rows: [['场次名称', '开始时刻'], ['主旨演讲', '09:30']] },
      ]);
      const harmless = await importWorkbook(stray, '会议胸牌', { output: { width: 90, height: 130, dpi: 120, format: 'png' } });
      expect(where(harmless.body.problems)).toEqual(['import.columnMissing@参会场次!1']);
      expect(harmless.body.problems[0].level).toBe('hint');
      expect(harmless.body.batch.items).toHaveLength(1);
    });

    it.each<[string, FixtureOptions]>([
      ['Excel 的写法（共享字符串）', {}],
      ['内联字符串', { sharedStrings: false }],
      ['元素名带命名空间前缀', { prefix: 'x' }],
      ['不写行号与单元格坐标', { omitReferences: true }],
      ['1904 日期系统', { date1904: true }],
      ['部件是 UTF-16 编码', { utf16: true }],
    ])('单元格按字段类型读取：%s——富文本只取文字不取注音，公式取计算结果（数值按 15 位有效数字），日期与时刻可以是序号或文字，表头可以写字段名称', async (_label, options) => {
      const badge = JSON.parse(await readFile(`${CONSOLE_BADGE_DIR}dataset-badge-zhang.json`, 'utf8'));
      const workbook = await xlsxOf([
        { name: '会议胸牌', rows: [
          ['FullName', '单位', '身份', 'badgeno', '照片', '座位排号', '会议日期', '发证时间', '贵宾通道', '主场次', '参会场次', '标签'],
          [{ runs: ['张', '三'], phonetic: 'zhāng' }, { formula: 'CONCAT("示例科技","有限公司")', value: '示例科技有限公司' }, ' 讲者 ', 'SP0001', 'photo-sample',
            { formula: '0.1*120', value: 12.000000000000002 }, { date: serial('2026-11-20', options.date1904) }, '2026/11/1 9:30', '否', '主旨', '张三', '首次\n讲者'],
        ] },
        { name: '主场次', rows: [['主场次', '场次名称', '开始时刻', '会场'], ['主旨', '主旨演讲', 0.3958333333333333, '一号厅']] },
        { name: '参会场次', rows: [['参会场次', '场次名称', '开始时刻', '会场'], ['张三', '主旨演讲', '9:30', '一号厅'], ['张三', '分论坛：出图自动化', '14:00']] },
      ], options);
      const reply = await importWorkbook(workbook, '会议胸牌', { output: { width: 90, height: 130, dpi: 120, format: 'png' } });
      expect(reply.status, reply.raw.slice(0, 800)).toBe(200);
      expect(reply.body.problems).toEqual([]);
      expect(reply.body.rows).toEqual([expect.objectContaining({ row: 2, itemId: '第 2 行', status: 'accepted', problems: [] })]);
      expect(reply.body.rows[0].dataset.data).toEqual(badge.data);
    });

    it('空白表里重名的工作表加了序号，填好后照样导得回来', async () => {
      // 数据定义的显示名称与引用列表字段的显示名称都是"停靠站点"：空白表的引用表叫"停靠站点 (2)"。
      const item = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '站点表项', version: 1, displayName: '站点表项',
        fields: [{ name: 'title', displayName: '站名', type: 'text', constraints: { required: true } }] }, []);
      const itemEntry = { ref: item.published!.ref, definition: item.published!.definition, compiled: item.published!.compiled };
      const table = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '站点表', version: 1, displayName: '停靠站点',
        fields: [{ name: 'line', displayName: '线路', type: 'text', constraints: { required: true } },
          { name: 'stops', displayName: '停靠站点', type: 'list', items: { type: 'ref', ref: { name: '站点表项', version: 1 } } }] }, [itemEntry]);
      const bytesOf = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));
      await seedDocuments(world.backend.tenant(world.b.id).storage, [item.published!.definition, item.published!.compiled, table.published!.definition, table.published!.compiled, {
        dslVersion: 'renderweave-template/1', name: '站点表牌', base: { name: '站点表', version: 1 },
        artboard: { sizeRange: { width: { min: 10, max: 100 }, height: { min: 10, max: 100 } }, layout: { mode: 'stack', direction: 'row' }, children: [
          { type: 'text', name: '线路', content: [{ slot: 'line' }], font: 'res:font-hei-medium', fontSize: 4, color: '#333333' }] },
      }].map(bytesOf));

      const blank = await world.call('GET', `/v1/static-schemas/${encodeURIComponent('站点表')}/versions/1/workbook`, world.b.operator.token);
      const names = [...(await entryText(new Uint8Array(blank.bytes), 'xl/workbook.xml')).matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1]);
      expect(names).toEqual(['停靠站点', '停靠站点 (2)']);
      const output = { width: 50, height: 20, dpi: 72, format: 'png' };
      const filled = await importWorkbook(await xlsxOf([
        { name: '停靠站点', rows: [['线路', '停靠站点'], ['1 路', 'K']] },
        { name: '停靠站点 (2)', rows: [['停靠站点', '站名'], ['K', '甲'], ['K', '乙']] },
      ]), '站点表牌', { output });
      expect(filled.status, filled.raw.slice(0, 500)).toBe(200);
      expect(filled.body.problems).toEqual([]);
      expect(filled.body.rows).toEqual([expect.objectContaining({ status: 'accepted', problems: [], dataset: expect.objectContaining({ data: { line: '1 路', stops: [{ title: '甲' }, { title: '乙' }] } }) })]);
    });

    it('空白表：按数据定义生成，主表是数据定义的显示名称，表头是字段的显示名称，引用另起一张表；原样导回去表头全都认得、只报没有数据行', async () => {
      const { call, a, b } = world;
      const url = `/v1/static-schemas/${encodeURIComponent('线路牌')}/versions/1/workbook`;
      const reply = await call('GET', url, b.operator.token);
      expect(reply.status).toBe(200);
      expect(reply.headers['content-type']).toBe(XLSX);
      expect(reply.headers['content-disposition']).toBe(`attachment; filename="workbook.xlsx"; filename*=UTF-8''${encodeURIComponent('线路牌-v1.xlsx')}`);
      const bytes = new Uint8Array(reply.bytes);
      // 时间戳只写 DOS 时间 2026-01-01 00:00，中央目录里没有带 UTC 秒数的扩展时间戳：哪个时区生成的字节都一样。
      const view = new DataView(bytes.buffer, bytes.byteOffset), stamps: number[][] = [];
      for (let at = 0; at + 46 <= bytes.length; at++) {
        // 中央目录里的一项：签名 PK\x01\x02，修改时间在 +12，日期在 +14，扩展字段长度在 +30。
        if (view.getUint32(at, true) === 0x02014b50) stamps.push([view.getUint16(at + 12, true), view.getUint16(at + 14, true), view.getUint16(at + 30, true)]);
      }
      expect(stamps.length).toBeGreaterThan(4);
      expect(new Set(stamps.map((stamp) => stamp.join()))).toEqual(new Set([[0, ((2026 - 1980) << 9) | (1 << 5) | 1, 0].join()]));
      expect([...(await entryText(bytes, 'xl/workbook.xml')).matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1])).toEqual(['线路牌（单线路单方向）', '停靠站点']);
      expect(headerOf(await entryText(bytes, 'xl/worksheets/sheet1.xml'))).toEqual(
        ['渲染项 ID', '线路号', '线路号图片', '票制', '票价（元）', '运营方', '首班', '末班', '运营说明', '班车类型', '班次时刻', '停靠站点']);
      expect(headerOf(await entryText(bytes, 'xl/worksheets/sheet2.xml'))).toEqual(['停靠站点', '站名', '地标', '所在道路', '站名上方的标识']);

      const back = await importWorkbook(bytes, '标准线路单边');
      expect(back.status, back.raw.slice(0, 500)).toBe(200);
      expect(back.body).toMatchObject({ rows: [], summary: { rows: 0, accepted: 0, rejected: 0 } });
      expect(back.body.problems.map((p: { code: string }) => p.code)).toEqual(['import.noRows']);
      expect(back.body.batch).toBeUndefined();

      const priceTag = await call('GET', `/v1/static-schemas/${encodeURIComponent('商品价签')}/versions/1/workbook`, b.key.token);
      const priceSheet = await entryText(new Uint8Array(priceTag.bytes), 'xl/worksheets/sheet1.xml');
      expect(headerOf(priceSheet)).toEqual(PRICE_HEADER);
      // 只取一个值、可选值固定的列给下拉选择（列表要写几项，只给提示）。
      expect(priceSheet).toContain('<formula1>"个,瓶,袋,盒,千克"</formula1>');
      expect(priceSheet).toContain('<formula1>"是,否"</formula1>');
      // 文字类的列设成文本格式（样式 2），货号的前导零不丢；数值与是否的列不设。
      const textColumns = [...priceSheet.matchAll(/<col min="(\d+)"[^>]*?( style="2")?\/>/g)].filter((match) => match[2]).map((match) => PRICE_HEADER[Number(match[1]) - 1]);
      expect(textColumns).toEqual(['渲染项 ID', '品名', '规格', '单位', '产地', '货号', '促销截止', '卖点']);

      expect((await call('GET', url, a.operator.token)).status).toBe(404);
      expect((await call('GET', `/v1/static-schemas/${encodeURIComponent('线路牌')}/versions/9/workbook`, b.operator.token)).status).toBe(404);
    });

    it('上限：文件、主表行数、解压后的大小、单元格数与引用展开的行数超出就整份拒绝（413）；不是 .xlsx 的文件答 400；模板不存在答 400', async () => {
      const tooBig = await importWorkbook(new Uint8Array(5 * 1024 * 1024 + 1));
      expect(tooBig.status).toBe(413);
      expect(tooBig.body.problems).toEqual([expect.objectContaining({ code: 'limit.workbookTooLarge' })]);

      const manyRows = await xlsxOf([{ name: '商品价签', rows: [PRICE_HEADER, ...Array.from({ length: 1001 }, (_, i) => [`id-${i}`, '商品', null, '个', null, '0000001', 1])] }]);
      const rows = await importWorkbook(manyRows);
      expect(rows.status).toBe(413);
      expect(rows.body.problems).toEqual([expect.objectContaining({ code: 'limit.workbookTooLarge', message: expect.stringContaining('1,000') })]);

      // 压缩后很小、解开很大：按 zip 里登记的解压大小累计，超过上限就停在解开之前。
      const bomb = await xlsxOf([{ name: '商品价签', rows: [PRICE_HEADER, ['x'.repeat(33 * 1024 * 1024)]] }]);
      expect(bomb.length).toBeLessThan(1024 * 1024);
      const unzipped = await importWorkbook(bomb);
      expect(unzipped.status).toBe(413);
      expect(unzipped.body.problems).toEqual([expect.objectContaining({ code: 'limit.workbookTooLarge' })]);

      // 用不到的部件不解开：33 MiB 的数据透视缓存不算进上限。
      const pivot = await importWorkbook(await xlsxOf([{ name: '商品价签', rows: [PRICE_HEADER, ['T1', '饮用水', null, '瓶', null, '0000001', 2]] }],
        { extraParts: [['xl/pivotCache/pivotCacheRecords1.xml', new Uint8Array(33 * 1024 * 1024).fill(32)]] }));
      expect(pivot.status, pivot.raw.slice(0, 300)).toBe(200);
      expect(pivot.body.summary).toMatchObject({ accepted: 1 });

      // 登记的解压大小比实际小（想骗过上限）：解出的字节多于登记的就读不了。
      const lying = await xlsxOf([{ name: '商品价签', rows: [PRICE_HEADER, ['x'.repeat(2 * 1024 * 1024)]] }]);
      for (let at = lying.length - 46; at >= 0; at--) {
        // 中央目录里的一项：签名 PK\x01\x02，解压大小在 +24，文件名长度在 +28，文件名从 +46 起。
        if (lying[at] !== 0x50 || lying[at + 1] !== 0x4b || lying[at + 2] !== 1 || lying[at + 3] !== 2) continue;
        const nameLength = lying[at + 28]! | (lying[at + 29]! << 8);
        if (Buffer.from(lying.subarray(at + 46, at + 46 + nameLength)).toString() === 'xl/sharedStrings.xml') new DataView(lying.buffer, lying.byteOffset).setUint32(at + 24, 100, true);
      }
      const lied = await importWorkbook(lying);
      expect(lied.status).toBe(400);
      expect(lied.body.problems).toEqual([expect.objectContaining({ code: 'import.workbookUnreadable', message: expect.stringContaining('sharedStrings.xml') })]);

      for (const bytes of [new Uint8Array(Buffer.from('品名,单位\n水,瓶\n')), new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])]) {
        const unreadable = await importWorkbook(bytes);
        expect(unreadable.status).toBe(400);
        expect(unreadable.body.problems).toEqual([expect.objectContaining({ code: 'import.workbookUnreadable' })]);
      }
      // 带 DTD 的 XML 不读（防实体膨胀）。
      const withDoctype = await importWorkbook(await xlsxOf([{ name: '商品价签', rows: [PRICE_HEADER] }], { doctype: true }));
      expect(withDoctype.status).toBe(400);
      expect(withDoctype.body.problems).toEqual([expect.objectContaining({ code: 'import.workbookUnreadable', message: expect.stringContaining('DTD') })]);
      const notBase64 = await importWorkbook('这不是 base64');
      expect(notBase64.status).toBe(400);
      expect(notBase64.body.problems).toEqual([expect.objectContaining({ code: 'request.invalid' })]);

      const workbook = await readSample('price-tags.xlsx');
      const otherTenant = await importWorkbook(workbook, '商品价签', {}, world.a.operator.token);
      expect(otherTenant.status).toBe(400);
      expect(otherTenant.body.problems).toEqual([expect.objectContaining({ code: 'input.templateNotFound' })]);
      // 单元格数与引用展开的上限：另起一套上限很小的环境。
      const limited = await createWorld(world.backend, { api: { limits: { maxWorkbookCells: 40, maxImportReferenceRows: 3 } } });
      await seedPriceTag(world.backend.tenant(limited.b.id).storage);
      await seedConsoleBadge(world.backend.tenant(limited.b.id).storage);
      const limitedImport = async (sheets: Parameters<typeof xlsxOf>[0], template = '商品价签') => limited.call('POST', '/v1/excel-imports', limited.b.operator.token, {
        template, workbook: base64(await xlsxOf(sheets)), output: template === '商品价签' ? PRICE_OUTPUT : { width: 90, height: 130, dpi: 120, format: 'png' } });
      const cells = await limitedImport([{ name: '商品价签', rows: [PRICE_HEADER, PRICE_HEADER, PRICE_HEADER, PRICE_HEADER] }]);
      expect(cells.status).toBe(413);
      expect(cells.body.problems).toEqual([expect.objectContaining({ code: 'limit.workbookTooLarge', message: expect.stringContaining('40') })]);
      // 没用到的工作表不读，不算单元格。
      const unused = await limitedImport([{ name: '商品价签', rows: [PRICE_HEADER, ['T1', '饮用水', null, '瓶', null, '0000001', 2]] },
        { name: '备注', rows: Array.from({ length: 10 }, (_, i) => ['甲', '乙', '丙', '丁', `第 ${i + 1} 行`]) }]);
      expect(unused.status, unused.raw.slice(0, 300)).toBe(200);
      // 两行共用一组两个场次：展开 4 行，超过上限 3。
      const shared = await limitedImport([
        { name: '会议胸牌', rows: [['姓名', '身份', '证件号', '会议日期', '参会场次'], ['张三', '讲者', 'SP0001', '2026-11-20', 'S'], ['李四', '讲者', 'SP0002', '2026-11-20', 'S']] },
        { name: '参会场次', rows: [['参会场次', '场次名称', '开始时刻'], ['S', '主旨演讲', '09:30'], ['S', '分论坛', '14:00']] },
      ], '会议胸牌');
      expect(shared.status).toBe(413);
      expect(shared.body.problems).toEqual([expect.objectContaining({ code: 'limit.workbookTooLarge', message: expect.stringContaining('引用展开') })]);

      // 数据定义是引擎内置的子模板：没有可以导入的字段。
      const builtin = await importWorkbook(workbook, '价签卖点');
      expect(builtin.status).toBe(400);
      expect(builtin.body.problems).toEqual([expect.objectContaining({ code: 'request.invalid', location: { kind: 'input', source: 'request.template' } })]);
    });
  });
}
