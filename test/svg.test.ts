import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryResourceRepository, ProblemCodes, render, type RenderOptions } from '../src/index.js';
import { labRequest, loadSkeleton, resourcesDir, withLabTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAt } from './support/pixels.js';

const at = (left = 0, top = 0, width = 20, height = 20) => ({ left, top, width: { fixed: width }, height: { fixed: height } });
const picture = (name = '图', place: unknown = at(), fit = 'contain') => ({ type: 'image', name, source: 'res:test-vector-svg', place, fit });
const wrap = (body: string, dimensions = 'width="80" height="40"') => `<svg xmlns="http://www.w3.org/2000/svg" ${dimensions}>${body}</svg>`;
async function inline(svg: string, options: RenderOptions = {}, children = [picture()], dpi = 254, mode = 'final') {
  const workspace = withLabTemplate(await loadSkeleton(), { fill: '#FFFFFF', children });
  const original = workspace.resources;
  const bytes = new TextEncoder().encode(svg);
  return render({ ...workspace, resources: {
    get: (id) => id === 'test-vector-svg' ? { id, kind: 'image' } : original.get(id),
    read: (id) => id === 'test-vector-svg' ? Promise.resolve(bytes) : original.read(id),
  } }, { ...labRequest(100, 40, dpi), mode }, options);
}

describe('SVG 图片', () => {
  it.each([127, 508])('三种适配方式与同图多尺寸：%s DPI golden', async (dpi) => {
    const workspace = withLabTemplate(await loadSkeleton(), { fill: '#FFFFFF', children: [
      ...['contain', 'cover', 'fill'].map((fit, n) => picture(fit, at(2 + n * 24, 2, 20, 20), fit)),
      picture('小图', at(76, 2, 10, 5)), picture('大图', at(76, 9, 20, 10)),
    ] });
    const result = await render(workspace, labRequest(98, 24, dpi));
    expect(result.problems).toEqual([]);
    expect(result.layout!.root.children!.slice(0, 3).map((n) => n.image!.drawn)).toEqual([
      { x: 2, y: 7, width: 20, height: 10 }, { x: 26, y: 2, width: 20, height: 20 }, { x: 50, y: 2, width: 20, height: 20 },
    ]);
    await expectMatchesGolden(`svg-fits-${dpi}`, result.image!.bytes);
  });

  it('高 DPI 放大仍保留窄矢量线，不能先按天然尺寸栅格化', async () => {
    const result = await inline(wrap('<rect x="4.25" width="0.25" height="10"/>', 'width="10" height="10"'), {},
      [picture('图', at(0, 0, 20, 20))], 508);
    expect(result.problems).toEqual([]);
    const pixels = await decodePixels(result.image!.bytes);
    expect(pixelAt(pixels, 169, 100)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(pixels, 170, 100)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(pixels, 179, 100)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(pixels, 180, 100)).toEqual([255, 255, 255, 255]);
  });

  it.each(['viewBox="0 0 80 40"', 'width="80" height="40"', 'width="21.1666667mm" height="10.5833333mm"'])
  ('天然尺寸按 96 DPI，用于随内容：%s', async (dimensions) => {
    const result = await inline(wrap('<rect width="80" height="40"/>', dimensions), {},
      [picture('图', { left: 0, top: 0, width: 'hug', height: 'hug' })]);
    expect(result.problems).toEqual([]);
    expect(result.layout!.root.children![0]).toMatchObject({ width: 21.167, height: 10.583 });
  });

  it.each(['<svg><g></svg>', '<svg width="0" height="1"/>', '<html/>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private">]><svg>&x;</svg>'])
  ('无法解析时定位到元素，草稿和正式问题一致：%s', async (svg) => {
    const final = await inline(svg);
    const draft = await inline(svg, {}, [picture()], 254, 'draft');
    expect(final.image).toBeUndefined();
    expect(final.problems).toEqual(draft.problems);
    expect(final.problems).toEqual([expect.objectContaining({ code: ProblemCodes.resourceUnreadable,
      location: { kind: 'element', path: '布局实验/图' } })]);
    expect(draft.image).toBeDefined();
  });

  it('清理脚本、事件、外部图片/字体/样式表，保留局部引用与安全 CSS', async () => {
    const source = `<?xml-stylesheet href="https://invalid.example/style.css"?>` + wrap(`
      <script>alert(1)</script><foreignObject/><animate attributeName="x"/>
      <style>@import "https://invalid.example/a.css"; @font-face {font-family: x; src: url(file:///font.otf)}
      .ok { fill: #ff0000; filter: url(https://invalid.example/filter.svg); }</style>
      <defs><linearGradient id="local"><stop stop-color="red"/></linearGradient></defs>
      <image href="https://invalid.example/a.png"/><use href="file:///image.svg#x"/>
      <rect class="ok" width="80" height="40" onclick="alert(1)" style="stroke: url(https://invalid.example/a);stroke-width: 0"/>
      <path id="p" d="M1 1L2 2" fill="url(#local)"/><use href="#p"/>
    `);
    const result = await inline(source);
    expect(result.problems).toEqual([]);
    expect(pixelAt(await decodePixels(result.image!.bytes), 100, 100)).toEqual([255, 0, 0, 255]);
  });

  it('CSS 转义 URL、相对引用及嵌套 data SVG 不改变渲染结果，局部引用仍可绘制', async () => {
    const nested = Buffer.from(wrap('<rect width="80" height="40" fill="red"/>')).toString('base64');
    const safeBody = '<defs><rect id="local" x="40" width="40" height="40" fill="blue"/></defs><use href="#local"/>';
    const source = wrap(String.raw`<style>.x {fill:u\72l(https://invalid.example/x)}</style>
      <rect class="x" width="40" height="40" fill="url(../x.svg#g)" style="filter: url('//invalid.example/f')"/>
      ${safeBody}<image width="80" height="40" href="data:image/svg+xml;base64,${nested}"/>`);
    const result = await inline(source);
    const clean = await inline(wrap('<rect width="40" height="40"/>' + safeBody));
    expect(result.problems).toEqual([]);
    expect(result.image!.bytes).toEqual(clean.image!.bytes);
    const pixels = await decodePixels(result.image!.bytes);
    expect(pixelAt(pixels, 50, 100)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(pixels, 150, 100)).toEqual([0, 0, 255, 255]);
  });

  it('内嵌 PNG 图片可绘制', async () => {
    const png = await readFile(join(resourcesDir, 'images/test/quadrants.png'));
    const result = await inline(wrap(`<image width="80" height="40" href="data:image/png;base64,${png.toString('base64')}"/>`));
    expect(result.problems).toEqual([]);
    expect(pixelAt(await decodePixels(result.image!.bytes), 50, 80)).toEqual([255, 0, 0, 255]);
  });

  it('SVG 中文只使用显式资源字体，重复渲染字节一致', async () => {
    const svg = wrap('<text x="2" y="28" font-family="Missing System Font" font-size="23">深圳</text>');
    const options = { svgFonts: ['font-hei-regular'] };
    const first = await inline(svg, options);
    const second = await inline(svg, options);
    expect(first.problems).toEqual([]);
    expect(first.image!.bytes).toEqual(second.image!.bytes);
    await expectMatchesGolden('svg-resource-font', first.image!.bytes);
    const missing = await inline(svg, { svgFonts: [] });
    expect(missing.image).toBeUndefined();
    expect(missing.problems[0]!.message).toContain('svgFonts');
  });

  it('默认字体也必须在资源仓库存在，系统字体不可作为后备', async () => {
    const workspace = withLabTemplate(await loadSkeleton(), { children: [picture()] });
    const result = await render({ ...workspace, resources: createMemoryResourceRepository([
      { id: 'test-vector-svg', kind: 'image', bytes: new TextEncoder().encode(wrap('<text y="20">Arial 深圳</text>')) },
    ]) }, labRequest(20, 20));
    expect(result.image).toBeUndefined();
    expect(result.problems[0]!.code).toBe(ProblemCodes.resourceUnreadable);
  });

  it('cover 极端宽高比超过栅格上限时返回元素问题，两种模式一致', async () => {
    const svg = wrap('<rect width="100000" height="1"/>', 'width="100000" height="1"');
    const final = await inline(svg, {}, [picture('图', at(), 'cover')]);
    const draft = await inline(svg, {}, [picture('图', at(), 'cover')], 254, 'draft');
    expect(final.image).toBeUndefined();
    expect(draft.image).toBeDefined();
    expect(final.problems).toEqual(draft.problems);
    expect(final.problems[0]!.message).toContain('超出上限');
  });

  it('损坏的资源字体不能让 SVG 文字静默消失', async () => {
    const workspace = withLabTemplate(await loadSkeleton(), { children: [picture()] });
    const result = await render({ ...workspace, resources: createMemoryResourceRepository([
      { id: 'test-vector-svg', kind: 'image', bytes: new TextEncoder().encode(wrap('<text y="20">深圳</text>')) },
      { id: 'broken-font', kind: 'font', bytes: new Uint8Array([1, 2, 3, 4]) },
    ]) }, labRequest(20, 20), { svgFonts: ['broken-font'] });
    expect(result.image).toBeUndefined();
    expect(result.problems[0]).toMatchObject({ code: ProblemCodes.resourceUnreadable,
      location: { kind: 'element', path: '布局实验/图' } });
  });
});
