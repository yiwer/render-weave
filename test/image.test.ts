import { describe, expect, it } from 'vitest';
import { ProblemCodes, createMemoryResourceRepository, render, type LayoutNode, type RenderResult } from '../src/index.js';
import { labRequest, loadSkeleton, withLabTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAtMm, type Pixels } from './support/pixels.js';

/** 254 DPI 下 1 mm 为 10 像素。 */
const DPI = 254;

const image = (name: string, source: string, place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'image',
  name,
  source,
  place,
  ...extra,
});
const at = (left: number, top: number, width: number, height: number) => ({ left, top, width: { fixed: width }, height: { fixed: height } });

async function lab(children: unknown[], width: number, height: number) {
  return render(withLabTemplate(await loadSkeleton(), { fill: '#FFFFFF', children }), labRequest(width, height, DPI));
}

function node(result: RenderResult, name: string): LayoutNode {
  return result.layout!.root.children!.find((child) => child.name === name)!;
}

type Rgb = [number, number, number];
const near = (pixels: Pixels, x: number, y: number, [r, g, b]: Rgb, tolerance = 40) => {
  const [pr, pg, pb] = pixelAtMm(pixels, x, y, DPI);
  return Math.abs(pr - r) <= tolerance && Math.abs(pg - g) <= tolerance && Math.abs(pb - b) <= tolerance;
};
const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 200, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 220, 0];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

describe('图片元素', () => {
  it.each(['png', 'jpg', 'webp'])('支持 %s 格式', async (format) => {
    const result = await lab([image('测试图', `res:test-quadrants-${format}`, at(0, 0, 20, 10), { fit: 'fill' })], 20, 10);
    const pixels = await decodePixels(result.image!.bytes);

    expect(result.problems).toEqual([]);
    expect(node(result, '测试图').image).toMatchObject({ source: `res:test-quadrants-${format}`, naturalWidth: 200, naturalHeight: 100 });
    expect(near(pixels, 5, 2.5, RED)).toBe(true);
    expect(near(pixels, 15, 2.5, GREEN)).toBe(true);
    expect(near(pixels, 5, 7.5, BLUE)).toBe(true);
    expect(near(pixels, 15, 7.5, YELLOW)).toBe(true);
  });

  it('完整显示：按比例缩放到放得下并居中，四边黑边都在', async () => {
    const result = await lab([image('测试图', 'res:test-quadrants-png', at(0, 0, 20, 20), { fit: 'contain' })], 20, 20);
    const pixels = await decodePixels(result.image!.bytes);

    expect(node(result, '测试图').image!.drawn).toEqual({ x: 0, y: 5, width: 20, height: 10 });
    expect(near(pixels, 10, 2, WHITE)).toBe(true);
    expect(near(pixels, 0.2, 10, BLACK)).toBe(true);
    expect(near(pixels, 10, 5.3, BLACK)).toBe(true);
    expect(near(pixels, 5, 8, RED)).toBe(true);
  });

  it('铺满裁剪：按比例缩放到铺满元素框，居中裁去两侧', async () => {
    const result = await lab([image('测试图', 'res:test-quadrants-png', at(0, 0, 20, 20), { fit: 'cover' })], 20, 20);
    const pixels = await decodePixels(result.image!.bytes);

    expect(node(result, '测试图').image!.drawn).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    // 左右两侧的黑边被裁掉，上下的还在。
    expect(near(pixels, 0.2, 5, RED)).toBe(true);
    expect(near(pixels, 19.8, 15, YELLOW)).toBe(true);
    expect(near(pixels, 10, 0.2, BLACK)).toBe(true);
  });

  it('拉伸：铺满元素框且不保持比例，四边黑边都在', async () => {
    const result = await lab([image('测试图', 'res:test-quadrants-png', at(0, 0, 20, 20), { fit: 'fill' })], 20, 20);
    const pixels = await decodePixels(result.image!.bytes);

    expect(node(result, '测试图').image!.drawn).toEqual({ x: 0, y: 0, width: 20, height: 20 });
    expect(near(pixels, 0.2, 5, BLACK)).toBe(true);
    expect(near(pixels, 10, 0.2, BLACK)).toBe(true);
    expect(near(pixels, 5, 5, RED)).toBe(true);
  });

  it('缺省为完整显示', async () => {
    const result = await lab([image('测试图', 'res:test-quadrants-png', at(0, 0, 20, 20))], 20, 20);
    expect(node(result, '测试图').image).toMatchObject({ fit: 'contain', drawn: { x: 0, y: 5, width: 20, height: 10 } });
  });

  it('随内容：一边固定时另一边按比例；两边都随内容时按 96 DPI 换算天然尺寸', async () => {
    const result = await lab(
      [
        image('定宽', 'res:test-quadrants-png', { left: 0, top: 0, width: { fixed: 30 }, height: 'hug' }),
        image('定高', 'res:test-quadrants-png', { left: 0, top: 20, width: 'hug', height: { fixed: 10 } }),
        image('天然', 'res:test-quadrants-png', { left: 0, top: 40, width: 'hug', height: 'hug' }),
      ],
      100,
      80,
    );

    expect(node(result, '定宽')).toMatchObject({ width: 30, height: 15 });
    expect(node(result, '定高')).toMatchObject({ width: 20, height: 10 });
    expect(node(result, '天然')).toMatchObject({ width: 52.917, height: 26.458 });
  });

  it('M402 图片资源：线路号、地标与标识图标都能显示', async () => {
    const result = await lab(
      [
        image('线路号图片', 'res:route-no-m402', at(2, 2, 60, 26)),
        ...[1, 2, 3, 4].map((n) => image(`地标${n}`, `res:landmark-${n}`, at(66 + (n - 1) * 10, 2, 8, 8))),
        image('地铁', 'res:icon-metro', at(66, 14, 9, 9)),
        image('医院', 'res:icon-hospital', at(76, 14, 9, 9)),
      ],
      110,
      30,
    );

    expect(result.problems).toEqual([]);
    expect(node(result, '线路号图片').image).toMatchObject({ naturalWidth: 466, naturalHeight: 138 });
    await expectMatchesGolden('m402-images', result.image!.bytes);
  });

  it('三种适配方式的 golden 图片', async () => {
    const result = await lab(
      [
        image('完整显示', 'res:test-quadrants-png', at(2, 2, 20, 20), { fit: 'contain' }),
        image('铺满裁剪', 'res:test-quadrants-png', at(26, 2, 20, 20), { fit: 'cover' }),
        image('拉伸', 'res:test-quadrants-png', at(50, 2, 20, 20), { fit: 'fill' }),
      ],
      72,
      24,
    );
    expect(result.problems).toEqual([]);
    await expectMatchesGolden('image-fits', result.image!.bytes);
  });

  it('资源不存在、引用了字体资源、格式不受支持时报问题，定位到元素', async () => {
    const missing = await lab([image('图', 'res:no-such-image', at(0, 0, 10, 10))], 20, 20);
    const font = await lab([image('图', 'res:font-hei-medium', at(0, 0, 10, 10))], 20, 20);
    const svgWorkspace = {
      ...withLabTemplate(await loadSkeleton(), { children: [image('图', 'res:svg-icon', at(0, 0, 10, 10))] }),
      resources: createMemoryResourceRepository([
        { id: 'svg-icon', kind: 'image', bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') },
      ]),
    };
    const svg = await render(svgWorkspace, labRequest(20, 20));
    const location = { kind: 'element', path: '布局实验/图' };

    expect(missing.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceNotFound, location]]);
    expect(font.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceKindMismatch, location]]);
    expect(svg.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceUnsupportedFormat, location]]);
    expect(svg.problems[0]!.message).toContain('SVG 图片尚未支持');
  });

  it('来源写法不对时模板检查报问题；没有来源时不画内容', async () => {
    const wrong = await lab([image('图', 'logo.png', at(0, 0, 10, 10))], 20, 20);
    const empty = await lab([{ type: 'image', name: '空图', place: at(0, 0, 10, 10) }], 20, 20);

    expect(wrong.problems.map((p) => p.code)).toEqual([ProblemCodes.templateInvalid, ProblemCodes.renderExpansionBlocked]);
    expect(empty.problems).toEqual([]);
    expect(node(empty, '空图').image).toBeUndefined();
  });
});
