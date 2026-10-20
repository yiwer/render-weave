import { describe, expect, it } from 'vitest';
import { ProblemCodes, createMemoryResourceRepository, render, type LayoutNode, type RenderResult } from '../src/index.js';
import { labRequest, loadSkeleton, textLab, textLabRequest, withLabTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAt, pixelAtMm, type Pixels } from './support/pixels.js';

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
    const gifWorkspace = {
      ...withLabTemplate(await loadSkeleton(), { children: [image('图', 'res:gif-icon', at(0, 0, 10, 10))] }),
      resources: createMemoryResourceRepository([
        { id: 'gif-icon', kind: 'image', bytes: new TextEncoder().encode('GIF89a') },
      ]),
    };
    const gif = await render(gifWorkspace, labRequest(20, 20));
    const location = { kind: 'element', path: '布局实验/图' };

    expect(missing.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceNotFound, location]]);
    expect(font.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceKindMismatch, location]]);
    expect(gif.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.resourceUnsupportedFormat, location]]);
  });

  it('来源写法不对时模板检查报问题；没有来源时不画内容', async () => {
    const wrong = await lab([image('图', 'logo.png', at(0, 0, 10, 10))], 20, 20);
    const empty = await lab([{ type: 'image', name: '空图', place: at(0, 0, 10, 10) }], 20, 20);

    expect(wrong.problems.map((p) => p.code)).toEqual([ProblemCodes.templateInvalid, ProblemCodes.renderExpansionBlocked]);
    expect(empty.problems).toEqual([]);
    expect(node(empty, '空图').image).toBeUndefined();
  });

  it('tint 单色重染：同一地标资源在原色、本站红色与已过站半透明灰色状态下的像素颜色、透明度与布局摘要', async () => {
    const workspace = await textLab(
      [{ name: 'status', displayName: '状态', type: 'text' }],
      {
        children: [
          image('原色地标', 'res:landmark-1', at(0, 0, 10, 10)),
          image('本站地标', 'res:landmark-1', at(10, 0, 10, 10), { tint: '#D2401E' }),
          image('状态地标', 'res:landmark-1', at(20, 0, 10, 10), {
            tint: { var: 'defaultTint' },
            states: {
              by: { var: 'status' },
              cases: {
                passed: { tint: '#80808080' },
              },
            },
          }),
        ],
      },
      {
        parameters: [
          { name: 'defaultTint', displayName: '默认重染色', visibility: 'public', type: 'color', default: '#D2401E' },
        ],
      },
    );
    const result = await render(workspace, textLabRequest({ status: 'passed' }, 30, 10, DPI));
    expect(result.problems).toEqual([]);

    const origSummary = node(result, '原色地标').image!;
    const redSummary = node(result, '本站地标').image!;
    const graySummary = node(result, '状态地标').image!;
    expect('tint' in origSummary).toBe(false);
    expect(redSummary.tint).toBe('#D2401EFF');
    expect(graySummary.tint).toBe('#80808080');

    const pixels = await decodePixels(result.image!.bytes);
    // 10 mm 在 254 DPI 下为 100 像素；四角透明区域保持完全透明。
    expect(pixelAt(pixels, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(pixels, 102, 2)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(pixels, 202, 2)).toEqual([0, 0, 0, 0]);

    // 找出原色地标中的不透明墨迹像素与半透明边缘像素，核对同偏移处的重染颜色与 Alpha 乘算。
    let opaqueOffset: [number, number] | undefined;
    let edgeOffset: [number, number] | undefined;
    for (let y = 0; y < 100; y++) {
      for (let x = 0; x < 100; x++) {
        const [, , , a] = pixelAt(pixels, x, y);
        if (a === 255 && !opaqueOffset) opaqueOffset = [x, y];
        if (a >= 80 && a <= 180 && !edgeOffset) edgeOffset = [x, y];
      }
    }
    expect(opaqueOffset).toBeDefined();
    expect(edgeOffset).toBeDefined();

    const [ox, oy] = opaqueOffset!;
    expect(pixelAt(pixels, ox, oy)).toEqual([34, 34, 34, 255]);
    expect(pixelAt(pixels, 100 + ox, oy)).toEqual([210, 64, 30, 255]);
    const [gr, gg, gb, ga] = pixelAt(pixels, 200 + ox, oy);
    expect(Math.abs(gr - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(gg - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(gb - 128)).toBeLessThanOrEqual(2);
    expect(Math.abs(ga - 128)).toBeLessThanOrEqual(1);

    const [ex, ey] = edgeOffset!;
    const [, , , origEdgeAlpha] = pixelAt(pixels, ex, ey);
    const [, , , redEdgeAlpha] = pixelAt(pixels, 100 + ex, ey);
    const [, , , grayEdgeAlpha] = pixelAt(pixels, 200 + ex, ey);
    expect(redEdgeAlpha).toBe(origEdgeAlpha);
    expect(Math.abs(grayEdgeAlpha - Math.round((origEdgeAlpha * 128) / 255))).toBeLessThanOrEqual(1);
  });

  it('栅格化后的 SVG 图片同样支持 tint 单色重染并保留透明背景', async () => {
    const svgBytes = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="6" fill="#000000"/></svg>',
    );
    const base = await loadSkeleton();
    const original = base.resources;
    const workspace = {
      ...withLabTemplate(base, {
        children: [image('矢量图标', 'res:svg-icon', at(0, 0, 10, 10), { tint: '#1F6FEB' })],
      }),
      resources: {
        get: (id: string) => (id === 'svg-icon' ? { id, kind: 'image' as const } : original.get(id)),
        read: (id: string) => (id === 'svg-icon' ? Promise.resolve(svgBytes) : original.read(id)),
        list: () => original.list(),
      },
    };
    const result = await render(workspace, labRequest(10, 10, DPI));
    expect(result.problems).toEqual([]);
    expect(node(result, '矢量图标').image!.tint).toBe('#1F6FEBFF');

    const pixels = await decodePixels(result.image!.bytes);
    expect(pixelAt(pixels, 2, 2)).toEqual([0, 0, 0, 0]);
    expect(pixelAt(pixels, 50, 50)).toEqual([31, 111, 235, 255]);
  });

  it('tint 绑定非颜色变量时静态检查报类型不匹配；绑定的颜色变量缺值时按透明 #00000000 处理', async () => {
    const mismatchWorkspace = await textLab(
      [{ name: 'title', displayName: '标题', type: 'text' }],
      { children: [image('图', 'res:landmark-1', at(0, 0, 10, 10), { tint: { var: 'title' } })] },
    );
    const mismatch = await render(mismatchWorkspace, textLabRequest({ title: '测试' }, 10, 10, DPI));
    expect(mismatch.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.templateTypeMismatch, { kind: 'element', path: '文字实验/图' }],
    ]);

    const missingColorWorkspace = await textLab(
      [{ name: 'flag', displayName: '开关', type: 'boolean' }],
      { children: [image('缺值图', 'res:landmark-1', at(0, 0, 10, 10), { tint: { var: 'tintColor' } })] },
      {
        parameters: [{ name: 'tintColor', displayName: '重染色', visibility: 'public', type: 'color' }],
      },
    );
    const draft = await render(missingColorWorkspace, {
      ...textLabRequest({ flag: true }, 10, 10, DPI),
      mode: 'draft',
    });
    expect(draft.problems.map((p) => p.code)).toEqual([ProblemCodes.parameterMissing]);
    expect(node(draft, '缺值图').image!.tint).toBe('#00000000');
    const pixels = await decodePixels(draft.image!.bytes);
    // 中心处原本是不透明地标像素，缺值重染为 #00000000 后完全透明（草稿预览未在此画问题红框）。
    expect(pixelAt(pixels, 50, 50)).toEqual([0, 0, 0, 0]);
  });
});
