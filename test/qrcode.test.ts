import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { render, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { textLab, textLabRequest } from './support/fixtures.js';
import { decodePixels, pixelAt, type Pixels } from './support/pixels.js';
import { expectMatchesGolden } from './support/golden.js';

// jsQR 的 CommonJS 导出是函数，声明文件则使用 default；显式按其声明导入运行时函数。
const jsQR = createRequire(import.meta.url)('jsqr') as typeof import('jsqr').default;

const at = (width = 40, height = 40) => ({ left: 5.17, top: 5.23, width: { fixed: width }, height: { fixed: height } });
const qr = (extra: Record<string, unknown> = {}) => ({ type: 'qrcode', name: '查询码', content: 'https://example.com/M402', place: at(), ...extra });
const param = (name: string, type: string, value?: unknown) => ({ name, displayName: name, type, visibility: 'public', ...(value !== undefined && { default: value }) });
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const qrNode = (result: RenderResult) => flatten(result.layout!.root).find(n => n.name === '查询码')!;
async function decode(bytes: Uint8Array) {
  const pixels = await decodePixels(bytes);
  return jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data;
}
async function workspace(extra: Record<string, unknown> = {}, fields: unknown[] = [], declarations: Record<string, unknown> = {}) {
  return textLab(fields, { fill: '#FFFFFF', children: [qr(extra)] }, declarations);
}
const request = (dpi = 120, format = 'png', data: Record<string, unknown> = {}, parameters: Record<string, unknown> = {}) => ({
  ...textLabRequest(data, 60, 60, dpi, parameters), output: { width: 60, height: 60, dpi, format },
});

describe('二维码最终图片与诊断', () => {
  it('独立样例经 CLI 出图；空参数正式失败并清旧图，草稿保留问题框', async () => {
    const out = await mkdtemp(join(tmpdir(), 'renderweave-qr-'));
    const file = join(out, 'request.json');
    const input = JSON.parse(await readFile('docs/examples/qrcode-dsl/render-request-query.json', 'utf8'));
    const args = ['render', '--workspace', 'docs/examples/qrcode-dsl', '--resources', 'fixtures/resources', '--request', file, '--out', out];
    const messages: string[] = [];
    const io = { stdout: (text: string) => messages.push(text), stderr: (text: string) => messages.push(text) };
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(0);
    expect(await decode(await readFile(join(out, 'image.png')))).toBe(input.parameters.queryUrl);
    expect(JSON.parse(await readFile(join(out, 'layout.json'), 'utf8')).root.children[0].qrcode.format).toBe('qr');
    input.parameters.queryUrl = '';
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(1);
    expect(existsSync(join(out, 'image.png'))).toBe(false);
    expect(messages.join('')).toContain('qrcode.contentInvalid');
    input.mode = 'draft';
    await writeFile(file, JSON.stringify(input));
    expect(await runCli(args, io)).toBe(0);
    expect(await decode(await readFile(join(out, 'image.png')))).toBeUndefined();
  });
  it.each(['L', 'M', 'Q', 'H'])('纠错 %s：中文、数字与 URL 从最终 PNG/JPEG 解码', async errorCorrectionLevel => {
    for (const content of ['001234567890', '文锦北路🚍东晓街道办②', 'https://example.com/routes/M402?stop=5']) {
      const work = await workspace({ content, errorCorrectionLevel });
      for (const dpi of [120, 300]) for (const format of ['png', 'jpeg']) {
        const result = await render(work, request(dpi, format));
        expect(result.problems).toEqual([]);
        expect(await decode(result.image!.bytes)).toBe(content);
        const summary = qrNode(result).qrcode!;
        expect(summary).toMatchObject({ format: 'qr', errorCorrectionLevel, quietZoneModules: 4 });
        expect(Number.isInteger(summary.moduleSizePx)).toBe(true);
        expect(summary.moduleSizePx).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('缺省 M；非正方形框居中保留留白，像素没有灰色接缝，PNG golden 固定', async () => {
    const result = await render(await workspace({ place: at(45, 35) }), request(120));
    expect(result.problems).toEqual([]);
    const summary = qrNode(result).qrcode!;
    expect(summary.errorCorrectionLevel).toBe('M');
    expect(summary.drawn.width).toBe(summary.drawn.height);
    expect(summary.drawn.x).toBeGreaterThan(5.17);
    expect(summary.drawn.x + summary.drawn.width).toBeLessThanOrEqual(50.171);
    expect(summary.drawn.y + summary.drawn.height).toBeLessThanOrEqual(40.231);
    expect(summary.quietZoneMm).toBeCloseTo(4 * summary.moduleSizePx * 25.4 / 120, 3);
    const pixels = await decodePixels(result.image!.bytes);
    const colors = new Set<string>();
    for (let i = 0; i < pixels.data.length; i += 4) {
      colors.add(`${pixels.data[i]},${pixels.data[i + 1]},${pixels.data[i + 2]},${pixels.data[i + 3]}`);
    }
    expect([...colors].sort()).toEqual(['0,0,0,255', '255,255,255,255']);
    expect(await decode(result.image!.bytes)).toBe('https://example.com/M402');
    await expectMatchesGolden('qrcode-query', result.image!.bytes);
  });

  it('字段、参数、颜色绑定与状态样式使用真实取值；90°旋转仍可解码', async () => {
    const fields = [{ name: 'url', displayName: '查询网址', type: 'text' }];
    const declarations = { parameters: [param('payload', 'text', '参数查询'), param('ink', 'color', '#001166'), param('paper', 'color', '#FFFFDD'), param('highlight', 'boolean', true)] };
    const work = await workspace({ content: { var: 'url' }, foreground: { var: 'ink' }, background: { var: 'paper' }, rotation: 90,
      states: { by: { var: 'highlight' }, cases: { true: { content: { var: 'payload' } } } } }, fields, declarations);
    for (const highlight of [true, false]) {
      const result = await render(work, request(120, 'png', { url: '字段查询' }, { highlight }));
      expect(result.problems).toEqual([]);
      expect(await decode(result.image!.bytes)).toBe(highlight ? '参数查询' : '字段查询');
      const pixels = await decodePixels(result.image!.bytes);
      expect(Array.from(pixels.data).includes(0x11)).toBe(true);
    }
  });

  it.each([
    ['空内容', { content: '' }, 'qrcode.contentInvalid'],
    ['无效 Unicode', { content: '\ud800' }, 'qrcode.contentInvalid'],
    ['超过最大字节容量', { content: '汉'.repeat(1000) }, 'qrcode.capacityExceeded'],
    ['超过 H 容量', { content: 'a'.repeat(1300), errorCorrectionLevel: 'H' }, 'qrcode.capacityExceeded'],
    ['同色', { foreground: '#ffffff' }, 'qrcode.colorsInvalid'],
    ['透明前景', { foreground: '#00000080' }, 'qrcode.colorsInvalid'],
    ['透明背景', { background: '#FFFFFF00' }, 'qrcode.colorsInvalid'],
    ['尺寸不足', { place: at(5, 5) }, 'qrcode.sizeInvalid'],
    ['随内容宽', { place: { ...at(), width: 'hug', minWidth: 40 } }, 'qrcode.sizeInvalid'],
    ['缺省随内容不能靠下限伪装定宽', { place: { height: { fixed: 40 }, minWidth: 40 } }, 'qrcode.sizeInvalid'],
    ['零尺寸', { place: at(0, 0) }, 'qrcode.sizeInvalid'],
  ])('%s：正式阻断，草稿只画问题位置，无伪码', async (_label, extra, code) => {
    const work = await workspace(extra);
    const final = await render(work, request());
    const draft = await render(work, { ...request(), mode: 'draft' });
    expect(final.problems.some(p => p.code === code)).toBe(true);
    expect(final.problems.find(p => p.code === code)?.location).toEqual({ kind: 'element', path: '文字实验/查询码' });
    expect(final.image).toBeUndefined();
    expect(draft.problems).toEqual(final.problems);
    expect(draft.image).toBeDefined();
    expect(qrNode(draft).qrcode).toBeUndefined();
    expect(await decode(draft.image!.bytes)).toBeUndefined();
    const pixels = await decodePixels(draft.image!.bytes);
    let red = 0;
    for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i]! > 200 && pixels.data[i + 1]! < 80) red++;
    expect(red).toBeGreaterThan(0);
  });

  it('恰好 2 px 可解码，小一像素拒绝；填满网格得到确定尺寸', async () => {
    const make = (width: number) => textLab([], { fill: '#FFFFFF', layout: { mode: 'grid', columns: [{ fixed: width }], rows: [{ fixed: width }] },
      children: [qr({ content: '1', place: { row: 1, column: 1 } })] });
    const result = await render(await make(5.8), request(254));
    expect(result.problems).toEqual([]);
    expect(qrNode(result).qrcode?.moduleSizePx).toBe(2);
    expect(await decode(result.image!.bytes)).toBe('1');
    const small = await render(await make(5.7), request(254));
    expect(small.problems.some(p => p.code === 'qrcode.sizeInvalid')).toBe(true);
    expect(small.image).toBeUndefined();
  });

  it.each(['number', 'boolean', 'image'])('%s 变量不能当二维码文本，草稿不转换成有效码', async type => {
    const value = type === 'number' ? 123 : type === 'boolean' ? true : 'res:icon-metro';
    const work = await workspace({ content: { var: 'payload' } }, [], { parameters: [param('payload', type, value)] });
    const result = await render(work, { ...request(), mode: 'draft' });
    expect(result.problems.some(p => p.code === 'template.typeMismatch')).toBe(true);
    expect(result.image).toBeDefined();
    expect(await decode(result.image!.bytes)).toBeUndefined();
  });

  it.each([{ content: 123 }, { errorCorrectionLevel: 'unknown' }, { errorCorrectionLevel: { var: 'level' } }, { quietZone: 0 }])(
    '非法 DSL %j 在出图前拒绝', async extra => {
      const result = await render(await workspace(extra), request());
      expect(result.image).toBeUndefined();
      expect(result.problems.some(p => p.code === 'template.invalid' || p.code === 'template.unknownProperty')).toBe(true);
    },
  );

  it('重复渲染以及无问题草稿与正式的图片、摘要完全一致', async () => {
    const work = await workspace();
    const input = request();
    const before = JSON.stringify([work.templates, input]);
    const final = await render(work, input);
    const repeated = await render(work, input);
    const draft = await render(work, { ...input, mode: 'draft' });
    expect(repeated).toEqual(final);
    expect(draft).toEqual(final);
    expect(JSON.stringify([work.templates, input])).toBe(before);
  });

  it('可选字段缺失时没有占位二维码；隐藏元素不编码，但仍检查未知绑定', async () => {
    const fields = [{ name: 'url', displayName: '网址', type: 'text' }];
    const visible = await workspace({ content: { var: 'url' } }, fields);
    expect((await render(visible, request())).problems.some(p => p.code === 'qrcode.contentInvalid')).toBe(true);
    const hidden = await workspace({ content: { var: 'url' }, visible: false }, fields);
    const result = await render(hidden, request());
    expect(result.problems).toEqual([]);
    expect(qrNode(result).visible).toBe(false);
    const unknown = await workspace({ content: { var: 'unknown' }, visible: false });
    expect((await render(unknown, request())).problems.some(p => p.code === 'template.unknownVariable')).toBe(true);
  });

  it('循环实例独立绑定文本，错误只定位第二项；第一项仍可扫码，输入不变', async () => {
    const work = await textLab([{ name: 'items', displayName: '查询列表', type: 'list', items: { type: 'text' } }], {
      fill: '#FFFFFF', children: [{ type: 'loop', name: '查询列', list: { var: 'items' }, template: '查询项', args: {},
        itemLayout: { direction: 'row', widths: 'equal' }, place: { width: { fixed: 100 }, height: { fixed: 50 } } }],
    });
    const child = { dslVersion: 'renderweave-template/1', name: '查询项', base: { name: '单值·文本', version: 1 },
      artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } }, children: [qr({ content: { var: 'value' }, place: at(35, 35) })] } };
    const nested: Workspace = { ...work, templates: [...work.templates, { name: child.name, document: child }] };
    const input = { ...request(120, 'png', { items: ['第一站查询', ''] }), output: { width: 100, height: 50, dpi: 120, format: 'png' }, mode: 'draft' };
    const before = JSON.stringify([nested.templates, input]);
    const result = await render(nested, input);
    expect(result.problems).toEqual([expect.objectContaining({ code: 'qrcode.contentInvalid', location: { kind: 'element', path: '文字实验/查询列[2]/查询码' } })]);
    const pixels = await decodePixels(result.image!.bytes);
    const width = Math.floor(pixels.width / 2);
    expect(jsQR(crop(pixels, 0, width), width, pixels.height)?.data).toBe('第一站查询');
    expect(JSON.stringify([nested.templates, input])).toBe(before);
  });
});

// 测试经编码后的图片；裁剪在像素上交给独立解码器，不接触编码器矩阵。
function crop(pixels: Pixels, left: number, width: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * pixels.height * 4);
  for (let y = 0; y < pixels.height; y++) for (let x = 0; x < width; x++) data.set(pixelAt(pixels, x + left, y), (y * width + x) * 4);
  return data;
}
