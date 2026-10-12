import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes, type ReadInputBarcodeFormat } from 'zxing-wasm/reader';
import { render, type LayoutNode, type RenderResult } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { textLab, textLabRequest } from './support/fixtures.js';
import { decodePixels, pixelAt } from './support/pixels.js';
import { expectMatchesGolden } from './support/golden.js';

const require = createRequire(import.meta.url);
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))).buffer } });
const cases = [
  { format: 'EAN-13', decoder: 'EAN13', content: '0012345678905', other: '5901234123457', modules: 95, left: 11, right: 7 },
  { format: 'EAN-8', decoder: 'EAN8', content: '01234565', other: '96385074', modules: 67, left: 7, right: 7 },
  { format: 'UPC-A', decoder: 'UPCA', content: '012345678905', other: '036000291452', modules: 95, left: 9, right: 9 },
] as const;
type Case = typeof cases[number];
const at = (width = 55, height = 30) => ({ left: 5.17, top: 5.23, width: { fixed: width }, height: { fixed: height } });
const barcode = (c: Case, extra: Record<string, unknown> = {}) => ({ type: 'barcode', name: '商品码', format: c.format, content: c.content, place: at(), ...extra });
const work = (c: Case, extra: Record<string, unknown> = {}, fields: unknown[] = [], declarations: Record<string, unknown> = {}) =>
  textLab(fields, { fill: '#FFFFFF', children: [barcode(c, extra)] }, declarations);
const request = (dpi = 120, format = 'png', data: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) => ({
  ...textLabRequest(data, 65, 42, dpi, parameters), output: { width: 65, height: 42, dpi, format },
});
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const nodeOf = (result: RenderResult) => flatten(result.layout!.root).find(node => node.name === '商品码')!;
const param = (name: string, type: string, value: unknown) => ({ name, displayName: name, type, visibility: 'public', default: value });
const decode = (bytes: Uint8Array, decoder: ReadInputBarcodeFormat) => readBarcodes(bytes, { formats: [decoder], tryHarder: true });

async function expectDecoded(bytes: Uint8Array, c: Case, content: string) {
  const decoded = await decode(bytes, c.decoder);
  expect(decoded).toHaveLength(1);
  expect(decoded[0]!.isValid).toBe(true);
  expect(decoded[0]!.format).toBe(c.decoder);
  // ZXing 3.1.5 对 UPCA 返回 EAN 的 13 位表示；只接受这个确切映射，不去零、不转数值。
  const expected = c.format === 'UPC-A' ? `0${content}` : content;
  expect(decoded[0]!.text).toBe(expected);
  expect(Array.from(decoded[0]!.bytes)).toEqual(Array.from(Buffer.from(expected, 'ascii')));
}

describe.each(cases)('$format 完整编号', c => {
  it('固定原文：前导零、文字开关、120/300 DPI × PNG/JPEG 独立核对格式与编号', async () => {
    for (const content of [c.content, c.other]) for (const showText of [false, true]) {
      const workspace = await work(c, { content, showText, font: 'res:font-hei-regular' });
      for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
        const result = await render(workspace, request(dpi, format));
        expect(result.problems).toEqual([]);
        await expectDecoded(result.image!.bytes, c, content);
        const summary = nodeOf(result).barcode!;
        expect(summary.format).toBe(c.format);
        expect(summary.modules).toBe(c.modules);
        expect(summary.quietZoneModules).toEqual({ left: c.left, right: c.right });
        expect(Number.isInteger(summary.moduleSizePx)).toBe(true);
        expect(summary.moduleSizePx).toBeGreaterThanOrEqual(2);
        expect(summary.symbol.x - summary.drawn.x).toBeGreaterThanOrEqual(c.left * summary.moduleSizePx * 25.4 / dpi - 0.002);
        expect(summary.drawn.x + summary.drawn.width - summary.symbol.x - summary.symbol.width).toBeGreaterThanOrEqual(c.right * summary.moduleSizePx * 25.4 / dpi - 0.002);
        expect(Boolean(summary.label)).toBe(showText);
        if (showText) {
          expect(summary.label!.text.fragments.map(f => f.text).join('')).toBe(content);
          expect(summary.label!.text.fragments[0]!.font).toBe('res:font-hei-regular');
          expect(summary.label!.box.y).toBeGreaterThan(summary.symbol.y + summary.symbol.height + 1);
        }
      }
    }
  });

  it('字段/参数与状态绑定、颜色、90°旋转沿用既有流程', async () => {
    const workspace = await work(c, { content: { var: 'productId' }, showText: true, font: 'res:font-hei-regular', rotation: 90,
      foreground: { var: 'ink' }, background: { var: 'paper' }, place: { ...at(), left: 12, top: 25 },
      states: { by: { var: 'alternate' }, cases: { true: { content: { var: 'otherId' } } } },
    }, [{ name: 'productId', displayName: '商品编号', type: 'text' }], { parameters: [param('alternate', 'boolean', false),
      param('otherId', 'text', c.other), param('ink', 'color', '#001166'), param('paper', 'color', '#FFFFDD')] });
    for (const alternate of [false, true]) {
      const result = await render(workspace, { ...request(120, 'png', { productId: c.content }, { alternate }), output: { width: 80, height: 80, dpi: 120, format: 'png' } });
      expect(result.problems).toEqual([]);
      await expectDecoded(result.image!.bytes, c, alternate ? c.other : c.content);
    }
  });

  it('格式专属留白参与 2 px 下限；精确像素边界通过、少一像素失败', async () => {
    const total = c.modules + c.left + c.right;
    const make = (pixels: number) => textLab([], { fill: '#FFFFFF', layout: { mode: 'grid', columns: [{ fixed: pixels / 10 }], rows: [{ fixed: 20 }] },
      children: [barcode(c, { place: { row: 1, column: 1 } })] });
    const result = await render(await make(total * 2), request(254));
    expect(result.problems).toEqual([]);
    const summary = nodeOf(result).barcode!;
    expect(summary.moduleSizePx).toBe(2);
    expect(summary.quietZoneMm).toEqual({ left: expect.closeTo(c.left * 0.2, 3), right: expect.closeTo(c.right * 0.2, 3) });
    await expectDecoded(result.image!.bytes, c, c.content);
    const pixels = await decodePixels(result.image!.bytes);
    for (let x = 0; x < c.left * 2; x++) expect(pixelAt(pixels, x, 30)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(pixels, c.left * 2, 30)).toEqual([0, 0, 0, 255]);
    for (let x = (c.left + c.modules) * 2; x < total * 2; x++) expect(pixelAt(pixels, x, 30)).toEqual([255, 255, 255, 255]);
    const workspace = await make(total * 2 - 1);
    const final = await render(workspace, request(254));
    const draft = await render(workspace, { ...request(254), mode: 'draft' });
    expect(final.image).toBeUndefined();
    expect(final.problems.map(p => p.code)).toEqual(['barcode.sizeInvalid']);
    expect(draft.problems).toEqual(final.problems);
    expect(await decode(draft.image!.bytes, c.decoder)).toEqual([]);
  });

  it.each(['缺位', '多位', '空格', '字母', '全角', '换行', '空串', '错校验位'])(
    '%s 不猜补或改写；草稿无伪码且与正式诊断一致', async scenario => {
      const values: Record<string, string> = { 缺位: c.content.slice(0, -1), 多位: `0${c.content}`, 空格: ` ${c.content.slice(1)}`,
        字母: `A${c.content.slice(1)}`, 全角: `０${c.content.slice(1)}`, 换行: `${c.content.slice(0, -1)}\n`, 空串: '',
        错校验位: `${c.content.slice(0, -1)}${(Number(c.content.at(-1)) + 1) % 10}` };
      const workspace = await work(c, { content: values[scenario], showText: true, font: 'res:font-hei-regular' });
      const input = request();
      const before = JSON.stringify([workspace.templates, input]);
      const final = await render(workspace, input);
      const draft = await render(workspace, { ...input, mode: 'draft' });
      const code = scenario === '错校验位' ? 'barcode.checksumInvalid' : 'barcode.contentInvalid';
      expect(final.problems.some(p => p.code === code && p.location.kind === 'element' && p.location.path === '文字实验/商品码')).toBe(true);
      expect(final.image).toBeUndefined();
      expect(draft.problems).toEqual(final.problems);
      expect(nodeOf(draft).barcode).toBeUndefined();
      expect(await decode(draft.image!.bytes, c.decoder)).toEqual([]);
      const pixels = await decodePixels(draft.image!.bytes);
      let red = 0;
      for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i]! > 200 && pixels.data[i + 1]! < 80) red++;
      expect(red).toBeGreaterThan(0);
      expect(JSON.stringify([workspace.templates, input])).toBe(before);
    });

  it('数值字段不转换；隐藏错误内容不编码', async () => {
    const workspace = await work(c, { content: { var: 'id' } }, [{ name: 'id', displayName: '数值编号', type: 'number' }]);
    const input = request(120, 'png', { id: Number(c.content) });
    const final = await render(workspace, input);
    const draft = await render(workspace, { ...input, mode: 'draft' });
    expect(final.problems.some(p => p.code === 'template.typeMismatch')).toBe(true);
    expect(final.image).toBeUndefined();
    expect(draft.problems).toEqual(final.problems);
    expect(await decode(draft.image!.bytes, c.decoder)).toEqual([]);
    expect((await render(await work(c, { content: '', visible: false }), request())).problems).toEqual([]);
  });

  it('循环中的校验位问题定位第二项，第一项可扫码', async () => {
    const base = await textLab([{ name: 'ids', displayName: '商品编号', type: 'list', items: { type: 'text' } }], { fill: '#FFFFFF', children: [
      { type: 'loop', name: '商品列', list: { var: 'ids' }, template: '商品项', args: {}, itemLayout: { direction: 'row', widths: 'equal' }, place: { width: { fixed: 130 }, height: { fixed: 42 } } },
    ] });
    const child = { dslVersion: 'renderweave-template/1', name: '商品项', base: { name: '单值·文本', version: 1 }, artboard: {
      sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } }, children: [barcode(c, { content: { var: 'value' } })],
    } };
    const workspace = { ...base, templates: [...base.templates, { name: child.name, document: child }] };
    const input = { ...request(120, 'png', { ids: [c.content, `${c.content.slice(0, -1)}${(Number(c.content.at(-1)) + 1) % 10}`] }), output: { width: 130, height: 42, dpi: 120, format: 'png' } };
    const final = await render(workspace, input);
    const draft = await render(workspace, { ...input, mode: 'draft' });
    expect(draft.problems).toEqual(final.problems);
    expect(final.problems).toEqual([expect.objectContaining({ code: 'barcode.checksumInvalid', location: { kind: 'element', path: '文字实验/商品列[2]/商品码' } })]);
    await expectDecoded(draft.image!.bytes, c, c.content);
  });

  it('重复确定性、golden 和独立 CLI 样例', async () => {
    const workspace = await work(c, { showText: true, font: 'res:font-hei-regular' });
    const result = await render(workspace, request());
    expect(await render(workspace, request())).toEqual(result);
    expect(await render(workspace, { ...request(), mode: 'draft' })).toEqual(result);
    await expectMatchesGolden(`retail-${c.decoder}`, result.image!.bytes);
    const out = await mkdtemp(join(tmpdir(), 'renderweave-retail-'));
    const file = join(out, 'request.json');
    const input = JSON.parse(await readFile(`docs/examples/retail-barcode-dsl/render-request-${c.decoder.toLowerCase()}.json`, 'utf8'));
    await writeFile(file, JSON.stringify(input));
    const args = ['render', '--workspace', 'docs/examples/retail-barcode-dsl', '--resources', 'fixtures/resources', '--request', file, '--out', out];
    const io = { stdout: (_: string) => {}, stderr: (_: string) => {} };
    expect(await runCli(args, io)).toBe(0);
    await expectDecoded(await readFile(join(out, 'image.png')), c, c.content);
    input.parameters.productId = c.content.slice(0, -1);
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(1);
    expect(existsSync(join(out, 'image.png'))).toBe(false);
    input.mode = 'draft';
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(0);
    expect(await decode(await readFile(join(out, 'image.png')), c.decoder)).toEqual([]);
  });
});
