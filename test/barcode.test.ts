import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { createMemoryResourceRepository, render, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { runCli } from '../src/cli.js';
import { resourcesDir, textLab, textLabRequest } from './support/fixtures.js';
import { decodePixels, pixelAt } from './support/pixels.js';
import { expectMatchesGolden } from './support/golden.js';

const require = createRequire(import.meta.url);
prepareZXingModule({ overrides: { wasmBinary: Uint8Array.from(readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))).buffer } });
const decode = async (bytes: Uint8Array) => (await readBarcodes(bytes, { formats: ['Code128'], tryHarder: true })).map(code => code.text);
const at = (width = 110, height = 32) => ({ left: 5.17, top: 5.23, width: { fixed: width }, height: { fixed: height } });
const barcode = (extra: Record<string, unknown> = {}) => ({ type: 'barcode', name: '资产码', format: 'CODE128', content: 'RW-M402-000123', place: at(), ...extra });
const param = (name: string, type: string, value: unknown) => ({ name, displayName: name, type, visibility: 'public', default: value });
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const nodeOf = (result: RenderResult) => flatten(result.layout!.root).find(node => node.name === '资产码')!;
const work = (extra: Record<string, unknown> = {}, fields: unknown[] = [], declarations: Record<string, unknown> = {}) =>
  textLab(fields, { fill: '#FFFFFF', children: [barcode(extra)] }, declarations);
const request = (dpi = 120, format = 'png', data: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) => ({
  ...textLabRequest(data, 120, 45, dpi, parameters), output: { width: 120, height: 45, dpi, format },
});

describe('CODE128 最终图片与诊断', () => {
  it.each([false, true])('下方文字 %s：120/300 DPI × PNG/JPEG 从独立解码器读回原始编号', async showText => {
    for (const content of ['000012345678', 'RW-M402-000123', ' a^FNC1~ ']) {
      const workspace = await work({ content, showText, ...(showText && { font: 'res:font-hei-regular' }) });
      for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
        const result = await render(workspace, request(dpi, format));
        expect(result.problems).toEqual([]);
        expect(await decode(result.image!.bytes)).toEqual([content]);
        const summary = nodeOf(result).barcode!;
        expect(summary.format).toBe('CODE128');
        expect(summary.quietZoneModules).toBe(10);
        expect(Number.isInteger(summary.moduleSizePx)).toBe(true);
        expect(summary.moduleSizePx).toBeGreaterThanOrEqual(2);
        expect(summary.symbol.x - summary.drawn.x).toBeGreaterThanOrEqual(summary.quietZoneMm - 0.001);
        expect(summary.drawn.x + summary.drawn.width - summary.symbol.x - summary.symbol.width).toBeGreaterThanOrEqual(summary.quietZoneMm - 0.002);
        if (showText) {
          expect(summary.label!.text.fragments.map(fragment => fragment.text).join('')).toBe(content);
          expect(summary.label!.box.y).toBeGreaterThan(summary.symbol.y + summary.symbol.height + 1);
          expect(summary.label!.text.fragments[0]!.font).toBe('res:font-hei-regular');
        } else expect(summary.label).toBeUndefined();
      }
    }
  });

  it('全部 95 个可打印 ASCII 原样编码，不解析转义指令', async () => {
    const content = Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).join('');
    const result = await render(await work({ content, place: at(590, 32) }), { ...request(), output: { width: 600, height: 45, dpi: 120, format: 'png' } });
    expect(result.problems).toEqual([]);
    expect(await decode(result.image!.bytes)).toEqual([content]);
  });

  it('下方文字 golden、重复确定性、无问题草稿和正式一致，输入不变', async () => {
    const workspace = await work({ showText: true, font: 'res:font-hei-regular' });
    const input = request();
    const before = JSON.stringify([workspace.templates, input]);
    const result = await render(workspace, input);
    expect(await render(workspace, input)).toEqual(result);
    expect(await render(workspace, { ...input, mode: 'draft' })).toEqual(result);
    expect(JSON.stringify([workspace.templates, input])).toBe(before);
    await expectMatchesGolden('barcode-asset', result.image!.bytes);
  });

  it('整数像素条空没有灰缝，左右留白不小于 10 模块，恰好 2 px 可读、小一像素失败', async () => {
    const initial = await render(await work({ content: '1' }), request(254));
    const modules = nodeOf(initial).barcode!.modules;
    const make = (width: number) => textLab([], { fill: '#FFFFFF', layout: { mode: 'grid', columns: [{ fixed: width }], rows: [{ fixed: 20 }] },
      children: [barcode({ content: '1', place: { row: 1, column: 1 } })] });
    const width = (modules + 20) * 2 / 10;
    const result = await render(await make(width), request(254));
    expect(result.problems).toEqual([]);
    expect(nodeOf(result).barcode!.moduleSizePx).toBe(2);
    expect(await decode(result.image!.bytes)).toEqual(['1']);
    const pixels = await decodePixels(result.image!.bytes);
    const colors = new Set<string>();
    for (let i = 0; i < pixels.data.length; i += 4) colors.add(`${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]},${pixels.data[i + 3]}`);
    expect([...colors].sort()).toEqual(['0,0,0,255', '255,255,255,255']);
    expect(pixelAt(pixels, 19, 30)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(pixels, 20, 30)).toEqual([0, 0, 0, 255]);
    const small = await render(await make(width - 0.1), request(254));
    expect(small.image).toBeUndefined();
    expect(small.problems.some(p => p.code === 'barcode.sizeInvalid')).toBe(true);
  });

  it('文本字段/参数、颜色、显示开关和状态样式绑定；90°旋转仍可解码', async () => {
    const fields = [{ name: 'assetId', displayName: '资产编号', type: 'text' }];
    const declarations = { parameters: [param('alternate', 'text', '000099'), param('ink', 'color', '#001166'), param('paper', 'color', '#FFFFDD'), param('label', 'boolean', true)] };
    const workspace = await work({ content: { var: 'assetId' }, foreground: { var: 'ink' }, background: { var: 'paper' },
      showText: { var: 'label' }, font: 'res:font-hei-regular', rotation: 90, place: { ...at(), left: 15, top: 54 },
      states: { by: { var: 'label' }, cases: { true: { content: { var: 'alternate' } } } } }, fields, declarations);
    for (const label of [true, false]) {
      const result = await render(workspace, { ...request(120, 'png', { assetId: 'FIELD-0001' }, { label }), output: { width: 140, height: 140, dpi: 120, format: 'png' } });
      expect(result.problems).toEqual([]);
      expect(await decode(result.image!.bytes)).toEqual([label ? '000099' : 'FIELD-0001']);
      expect(Boolean(nodeOf(result).barcode!.label)).toBe(label);
    }
  });

  it.each([
    ['空内容', { content: '' }, 'barcode.contentInvalid'],
    ['中文', { content: '资产001' }, 'barcode.contentInvalid'],
    ['换行', { content: 'A\nB' }, 'barcode.contentInvalid'],
    ['DEL', { content: '\x7f' }, 'barcode.contentInvalid'],
    ['输入超长', { content: 'A'.repeat(501), showText: true, font: 'res:font-hei-regular' }, 'barcode.capacityExceeded'],
    ['同色', { foreground: '#ffffff' }, 'barcode.colorsInvalid'],
    ['透明前景', { foreground: '#00000080' }, 'barcode.colorsInvalid'],
    ['透明背景', { background: '#ffffff00' }, 'barcode.colorsInvalid'],
    ['框宽不足', { place: at(10) }, 'barcode.sizeInvalid'],
    ['条高不足', { place: at(110, 5) }, 'barcode.sizeInvalid'],
    ['下方文字放不下', { showText: true, font: 'res:font-hei-regular', fontSize: 25 }, 'barcode.sizeInvalid'],
    ['文字挤占条高', { showText: true, font: 'res:font-hei-regular', place: at(110, 8) }, 'barcode.sizeInvalid'],
    ['随内容宽', { place: { ...at(), width: 'hug', minWidth: 110 } }, 'barcode.sizeInvalid'],
    ['缺省随内容', { place: { minWidth: 110, height: { fixed: 32 } } }, 'barcode.sizeInvalid'],
  ])('%s：正式阻断，草稿只有问题框，诊断相同', async (_label, extra, code) => {
    const workspace = await work(extra);
    const final = await render(workspace, request());
    const draft = await render(workspace, { ...request(), mode: 'draft' });
    expect(final.problems.some(p => p.code === code)).toBe(true);
    expect(final.problems.find(p => p.code === code)?.location).toEqual({ kind: 'element', path: '文字实验/资产码' });
    expect(final.image).toBeUndefined();
    expect(draft.problems).toEqual(final.problems);
    expect(draft.image).toBeDefined();
    expect(nodeOf(draft).barcode).toBeUndefined();
    expect(await decode(draft.image!.bytes)).toEqual([]);
    const pixels = await decodePixels(draft.image!.bytes);
    let red = 0;
    for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i]! > 200 && pixels.data[i + 1]! < 80) red++;
    expect(red).toBeGreaterThan(0);
  });

  it('500 字符在编码器上限内；超过尺寸只报尺寸问题而不抛异常', async () => {
    const result = await render(await work({ content: 'A'.repeat(500) }), request());
    expect(result.problems.map(p => p.code)).toEqual(['barcode.sizeInvalid']);
  });

  it.each(['number', 'boolean', 'image'])('%s 变量不能变成条形码文本', async type => {
    const workspace = await work({ content: { var: 'payload' } }, [], { parameters: [param('payload', type, type === 'number' ? 123 : type === 'boolean' ? true : 'res:icon-metro')] });
    const final = await render(workspace, request());
    const draft = await render(workspace, { ...request(), mode: 'draft' });
    expect(final.problems.some(p => p.code === 'template.typeMismatch')).toBe(true);
    expect(final.image).toBeUndefined();
    expect(draft.problems).toEqual(final.problems);
    expect(await decode(draft.image!.bytes)).toEqual([]);
  });

  it.each([{ format: 'EAN-13' }, { format: { var: 'format' } }, { content: 123 }, { showText: true }, { font: { var: 'font' } }, { quietZone: 0 }])(
    '非法 DSL %j 在出图前拒绝', async extra => {
      const result = await render(await work(extra), request());
      expect(result.image).toBeUndefined();
      expect(result.problems.some(p => p.code === 'template.invalid' || p.code === 'template.unknownProperty')).toBe(true);
    });

  it('隐藏元素不编码或读字体，但保留静态引用检查；可选字段缺失报空内容', async () => {
    const result = await render(await work({ visible: false, content: '', showText: true, font: 'res:missing' }), request());
    expect(result.problems).toEqual([]);
    expect(nodeOf(result).visible).toBe(false);
    expect((await render(await work({ visible: false, content: { var: 'unknown' } }), request())).problems.some(p => p.code === 'template.unknownVariable')).toBe(true);
    const optional = await work({ content: { var: 'id' } }, [{ name: 'id', displayName: '编号', type: 'text' }]);
    expect((await render(optional, request())).problems.some(p => p.code === 'barcode.contentInvalid')).toBe(true);
    expect((await render(await work({ showText: false, font: 'res:missing' }), request())).problems).toEqual([]);
  });

  it('字体缺字逐字替代；缺少字体或无可用替代时正式阻断、草稿不留部分有效码', async () => {
    const base = await work({ content: 'A01B', showText: true, font: 'res:subset' });
    const subset = createMemoryResourceRepository([{ id: 'subset', kind: 'font', bytes: await readFile(join(resourcesDir, 'font-subsets/TestSubset-Regular.otf')) }]);
    const workspace: Workspace = { ...base, resources: {
      get: id => id === 'subset' ? subset.get(id) : base.resources.get(id),
      read: id => id === 'subset' ? subset.read(id) : base.resources.read(id),
    } };
    const success = await render(workspace, request());
    expect(success.problems.map(p => p.code)).toEqual(['text.glyphFallback']);
    expect(nodeOf(success).barcode!.label!.text.fontFallback).toBe(true);
    expect(nodeOf(success).barcode!.label!.text.fragments.map(f => f.font)).toEqual(['res:subset', 'res:font-hei-regular', 'res:subset']);
    expect(await decode(success.image!.bytes)).toEqual(['A01B']);
    for (const candidate of [workspace, await work({ showText: true, font: 'res:missing' })]) {
      const final = await render(candidate, request(), { fallbackFonts: [] });
      const draft = await render(candidate, { ...request(), mode: 'draft' }, { fallbackFonts: [] });
      expect(final.problems.some(p => p.level === 'severe')).toBe(true);
      expect(final.image).toBeUndefined();
      expect(draft.problems).toEqual(final.problems);
      expect(nodeOf(draft).barcode).toBeUndefined();
      expect(await decode(draft.image!.bytes)).toEqual([]);
    }
  });

  it('循环绑定按实例定位，第二项失败不伪造码，第一项仍可独立解码', async () => {
    const base = await textLab([{ name: 'ids', displayName: '编号列表', type: 'list', items: { type: 'text' } }], { fill: '#FFFFFF', children: [
      { type: 'loop', name: '资产列', list: { var: 'ids' }, template: '编号项', args: {}, itemLayout: { direction: 'row', widths: 'equal' }, place: { width: { fixed: 240 }, height: { fixed: 45 } } },
    ] });
    const child = { dslVersion: 'renderweave-template/1', name: '编号项', base: { name: '单值·文本', version: 1 }, artboard: {
      sizeRange: { width: { min: 1, max: 200 }, height: { min: 1, max: 100 } }, children: [barcode({ content: { var: 'value' } })],
    } };
    const workspace = { ...base, templates: [...base.templates, { name: child.name, document: child }] };
    const input = { ...request(120, 'png', { ids: ['000001', '非法'] }), output: { width: 240, height: 45, dpi: 120, format: 'png' } };
    const final = await render(workspace, input);
    const draft = await render(workspace, { ...input, mode: 'draft' });
    expect(draft.problems).toEqual(final.problems);
    expect(final.problems).toEqual([expect.objectContaining({ code: 'barcode.contentInvalid', location: { kind: 'element', path: '文字实验/资产列[2]/资产码' } })]);
    expect(await decode(draft.image!.bytes)).toEqual(['000001']);
  });

  it('独立样例经 CLI 出图，失败清除旧图并返回非零，草稿保留诊断', async () => {
    const out = await mkdtemp(join(tmpdir(), 'renderweave-code128-'));
    const file = join(out, 'request.json');
    const input = JSON.parse(await readFile('docs/examples/barcode-dsl/render-request-asset.json', 'utf8'));
    const args = ['render', '--workspace', 'docs/examples/barcode-dsl', '--resources', 'fixtures/resources', '--request', file, '--out', out];
    const io = { stdout: (_: string) => {}, stderr: (_: string) => {} };
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(0);
    expect(await decode(await readFile(join(out, 'image.png')))).toEqual([input.parameters.assetId]);
    expect(JSON.parse(await readFile(join(out, 'layout.json'), 'utf8')).root.children[0].barcode.format).toBe('CODE128');
    input.parameters.assetId = '错误';
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(1);
    expect(existsSync(join(out, 'image.png'))).toBe(false);
    input.mode = 'draft';
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(0);
    expect(await decode(await readFile(join(out, 'image.png')))).toEqual([]);
  });
});
