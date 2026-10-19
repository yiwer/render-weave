import { describe, expect, it } from 'vitest';
import { ProblemCodes, render, type LayoutNode, type RenderResult } from '../src/index.js';
import { labRequest, loadSkeleton, skeletonRequest, withLabTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { boundsOf, decodePixels, pixelAtMm } from './support/pixels.js';

/** 按元素路径在布局摘要中找元素。 */
function node(result: RenderResult, path: string): LayoutNode {
  const search = (current: LayoutNode): LayoutNode | undefined =>
    current.path === path ? current : (current.children ?? []).map(search).find(Boolean);
  const found = search(result.layout!.root);
  if (!found) throw new Error(`布局摘要中没有 ${path}`);
  return found;
}

const box = (n: LayoutNode) => ({ x: n.x, y: n.y, width: n.width, height: n.height });
const rect = (name: string, place: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: 'rect',
  name,
  fill: '#FF0000',
  place,
  ...extra,
});
const fixed = (width: number, height: number, extra: Record<string, unknown> = {}) => ({
  width: { fixed: width },
  height: { fixed: height },
  ...extra,
});

async function lab(artboard: Record<string, unknown>, width: number, height: number, dpi = 120) {
  return render(withLabTemplate(await loadSkeleton(), artboard), labRequest(width, height, dpi));
}

describe('M402 版式骨架：画板宽度变化时重新排布', () => {
  it('740 mm：网格四行与各区域位置符合设计稿结构', async () => {
    const result = await render(await loadSkeleton(), skeletonRequest(740));

    expect(result.problems).toEqual([]);
    expect(box(node(result, 'M402 版式骨架/站点面板'))).toEqual({ x: 0, y: 34, width: 740, height: 100 });
    expect(box(node(result, 'M402 版式骨架/站点面板/站点列占位'))).toEqual({ x: 23, y: 38, width: 694, height: 96 });
    expect(box(node(result, 'M402 版式骨架/道路带'))).toEqual({ x: 0, y: 134, width: 740, height: 10 });
    expect(box(node(result, 'M402 版式骨架/底栏'))).toEqual({ x: 0, y: 144, width: 740, height: 21 });
    expect(box(node(result, 'M402 版式骨架/底栏/服务时间箭头'))).toEqual({ x: 115, y: 144, width: 8, height: 21 });
    expect(box(node(result, 'M402 版式骨架/底栏/服务时间内容'))).toEqual({ x: 123, y: 144, width: 611, height: 21 });
    expect(box(node(result, 'M402 版式骨架/底栏/底带收尾'))).toEqual({ x: 734, y: 144, width: 6, height: 21 });
    expect(box(node(result, 'M402 版式骨架/顶栏/票价框'))).toMatchObject({ y: 9, width: 120, height: 16 });
    await expect(`${JSON.stringify(result.layout, null, 2)}\n`).toMatchFileSnapshot('./snapshots/m402-skeleton-740.layout.json');
    await expectMatchesGolden('m402-skeleton-740', result.image!.bytes);
  });

  it('1500 mm：站点面板与道路带随宽度变宽，固定尺寸的元素不变，右侧元素随之右移', async () => {
    const narrow = await render(await loadSkeleton(), skeletonRequest(740));
    const wide = await render(await loadSkeleton(), skeletonRequest(1500));
    const grow = 1500 - 740;

    expect(wide.problems).toEqual([]);
    expect(node(wide, 'M402 版式骨架/站点面板').width).toBe(1500);
    expect(node(wide, 'M402 版式骨架/站点面板/站点列占位').width).toBe(1454);
    expect(node(wide, 'M402 版式骨架/道路带/道路段列占位').width).toBe(1454);
    expect(node(wide, 'M402 版式骨架/顶栏/顶栏留白').width).toBeCloseTo(node(narrow, 'M402 版式骨架/顶栏/顶栏留白').width + grow, 3);
    for (const fixedPath of ['顶栏/开往箭头', '顶栏/票价框', '底栏/服务时间箭头', '底栏/底带收尾', '底栏/下一站区']) {
      const path = `M402 版式骨架/${fixedPath}`;
      expect({ path, ...box(node(wide, path)), x: 0 }).toEqual({ path, ...box(node(narrow, path)), x: 0 });
    }
    expect(node(wide, 'M402 版式骨架/底栏/底带收尾').x).toBe(1494);
    expect(node(wide, 'M402 版式骨架/顶栏/票价框').x).toBe(node(narrow, 'M402 版式骨架/顶栏/票价框').x + grow);
    expect(wide.image).toMatchObject({ widthPx: 7087, heightPx: 780 });
    await expectMatchesGolden('m402-skeleton-1500', wide.image!.bytes);
  });
});

describe('堆叠布局', () => {
  const three = [rect('甲', fixed(10, 10)), rect('乙', fixed(10, 10)), rect('丙', fixed(10, 10))];

  it('主方向分布：靠前、居中、靠后、两端、均分', async () => {
    const xs = async (justifyContent: string) => {
      const result = await lab({ layout: { mode: 'stack', direction: 'row', justifyContent }, children: three }, 100, 20);
      return ['甲', '乙', '丙'].map((name) => node(result, `布局实验/${name}`).x);
    };
    expect(await xs('start')).toEqual([0, 10, 20]);
    expect(await xs('center')).toEqual([35, 45, 55]);
    expect(await xs('end')).toEqual([70, 80, 90]);
    expect(await xs('spaceBetween')).toEqual([0, 45, 90]);
    expect(await xs('spaceEvenly')).toEqual([17.5, 45, 72.5]);
  });

  it('交叉方向对齐：容器的 alignItems 与元素自己的 alignSelf', async () => {
    const result = await lab(
      {
        layout: { mode: 'stack', direction: 'row', alignItems: 'center' },
        children: [rect('甲', fixed(10, 10)), rect('乙', fixed(10, 10, { alignSelf: 'end' })), rect('丙', { width: { fixed: 10 }, height: 'fill' })],
      },
      100,
      20,
    );
    expect(node(result, '布局实验/甲').y).toBe(5);
    expect(node(result, '布局实验/乙').y).toBe(10);
    expect(box(node(result, '布局实验/丙'))).toEqual({ x: 20, y: 0, width: 10, height: 20 });
  });

  it('填满的元素按权重分剩余空间；超过最大尺寸的固定在最大尺寸，余下的分给其他元素', async () => {
    const weighted = await lab(
      {
        layout: { mode: 'stack', direction: 'row' },
        children: [rect('甲', fixed(20, 10)), rect('乙', { width: 'fill', height: { fixed: 10 } }), rect('丙', { width: { fill: 3 }, height: { fixed: 10 } })],
      },
      100,
      20,
    );
    const limited = await lab(
      {
        layout: { mode: 'stack', direction: 'row' },
        children: [rect('甲', fixed(20, 10)), rect('乙', { width: 'fill', maxWidth: 10, height: { fixed: 10 } }), rect('丙', { width: 'fill', height: { fixed: 10 } })],
      },
      100,
      20,
    );
    expect(['乙', '丙'].map((name) => [node(weighted, `布局实验/${name}`).x, node(weighted, `布局实验/${name}`).width])).toEqual([
      [20, 20],
      [40, 60],
    ]);
    expect(['乙', '丙'].map((name) => [node(limited, `布局实验/${name}`).x, node(limited, `布局实验/${name}`).width])).toEqual([
      [20, 10],
      [30, 70],
    ]);
  });

  it('外边距、纵向堆叠与间距', async () => {
    const result = await lab(
      {
        layout: { mode: 'stack', direction: 'column', gap: 5 },
        children: [rect('甲', fixed(10, 10, { margin: { left: 3, top: 2 } })), rect('乙', fixed(10, 10)), rect('丙', fixed(10, 10))],
      },
      20,
      100,
    );
    expect(['甲', '乙', '丙'].map((name) => [node(result, `布局实验/${name}`).x, node(result, `布局实验/${name}`).y])).toEqual([
      [3, 2],
      [0, 17],
      [0, 32],
    ]);
  });

  it('随内容的容器取子元素的总尺寸加间距与内边距', async () => {
    const result = await lab(
      {
        children: [
          {
            type: 'container',
            name: '一行',
            layout: { mode: 'stack', direction: 'row', gap: 2 },
            padding: 3,
            place: { left: 1, top: 1 },
            children: [rect('甲', fixed(10, 10)), rect('乙', fixed(20, 5))],
          },
        ],
      },
      100,
      50,
    );
    expect(box(node(result, '布局实验/一行'))).toEqual({ x: 1, y: 1, width: 38, height: 16 });
    expect(node(result, '布局实验/一行/乙').x).toBe(16);
  });

  it('隐藏的元素不参与布局，布局摘要中标为不显示', async () => {
    const result = await lab(
      {
        layout: { mode: 'stack', direction: 'row', gap: 5 },
        children: [rect('甲', fixed(10, 10)), rect('乙', fixed(10, 10), { visible: false }), rect('丙', fixed(10, 10))],
      },
      100,
      20,
    );
    expect(node(result, '布局实验/丙').x).toBe(15);
    expect(node(result, '布局实验/乙')).toMatchObject({ visible: false, width: 0, height: 0 });
  });

  it('放不下时报严重问题，定位到容器', async () => {
    const result = await lab({ layout: { mode: 'stack', direction: 'row' }, children: three.map((r) => ({ ...r, place: fixed(15, 10) })) }, 30, 20);

    expect(result.problems.map((p) => [p.code, p.level, p.location])).toEqual([
      [ProblemCodes.layoutContentOverflow, 'severe', { kind: 'element', path: '布局实验' }],
    ]);
    expect(result.problems[0]!.message).toContain('需要 45 mm，可用 30 mm');
    expect(result.image).toBeUndefined();
  });
});

describe('网格布局', () => {
  it('行列取固定、比例与随内容，行列间距、跨行跨列与格内对齐', async () => {
    const result = await lab(
      {
        layout: {
          mode: 'grid',
          rows: [{ fixed: 10 }, { fraction: 1 }, { fraction: 2 }, 'hug'],
          columns: [{ fixed: 20 }, { fraction: 1 }],
          rowGap: 2,
          columnGap: 4,
        },
        children: [
          rect('甲', { row: 1, column: 1 }),
          rect('乙', { row: 2, column: 2, rowSpan: 2 }),
          rect('丙', { row: 4, column: 1, height: { fixed: 6 } }),
          rect('丁', { row: 3, column: 1, width: { fixed: 10 }, height: { fixed: 10 }, justifySelf: 'center', alignSelf: 'end' }),
          rect('戊', { row: 4, column: 2, margin: 2 }),
        ],
      },
      100,
      100,
    );
    expect(result.problems).toEqual([]);
    expect(box(node(result, '布局实验/甲'))).toEqual({ x: 0, y: 0, width: 20, height: 10 });
    expect(box(node(result, '布局实验/乙'))).toEqual({ x: 24, y: 12, width: 76, height: 80 });
    expect(box(node(result, '布局实验/丙'))).toEqual({ x: 0, y: 94, width: 20, height: 6 });
    expect(box(node(result, '布局实验/丁'))).toEqual({ x: 5, y: 82, width: 10, height: 10 });
    expect(box(node(result, '布局实验/戊'))).toEqual({ x: 26, y: 96, width: 72, height: 2 });
  });

  it('行列位置超出网格、缺少行列时模板检查报问题', async () => {
    const grid = { mode: 'grid', rows: [{ fixed: 10 }], columns: [{ fixed: 10 }] };
    const outside = await lab({ layout: grid, children: [rect('甲', { row: 2, column: 1 })] }, 20, 20);
    const missing = await lab({ layout: grid, children: [rect('甲', { column: 1 })] }, 20, 20);
    const wrongMode = await lab({ layout: { mode: 'stack', direction: 'row' }, children: [rect('甲', { row: 1 })] }, 20, 20);

    expect(outside.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.templateInvalid, { kind: 'element', path: '布局实验/甲' }],
      [ProblemCodes.renderExpansionBlocked, { kind: 'input', source: 'render' }]]);
    expect(missing.problems.map((p) => p.code)).toEqual([ProblemCodes.templateInvalid, ProblemCodes.renderExpansionBlocked]);
    expect(wrongMode.problems.map((p) => p.code)).toEqual([ProblemCodes.templateUnknownProperty, ProblemCodes.renderExpansionBlocked]);
  });
});

describe('网格中的元素不静默重叠（M237）', () => {
  const block = (name: string, place: Record<string, unknown>, width: number, height = 5) => rect(name, { ...place, ...fixed(width, height) });
  /** 网格放在随内容的容器里，测量与排列都按网格自己的内容。 */
  const hugGrid = (layout: Record<string, unknown>, children: unknown[]) => ({
    children: [{ type: 'container', name: '格', place: { width: 'hug', height: 'hug' }, layout: { mode: 'grid', ...layout }, children }],
  });
  const overflow = (result: RenderResult) => result.problems.map((p) => [p.code, p.location, p.message]);

  it('随内容测量时比例列按比例放大到放得下内容', async () => {
    const result = await lab(hugGrid({ columns: [{ fraction: 1 }, { fraction: 3 }], rows: [{ fixed: 5 }] },
      [block('一', { row: 1, column: 1 }, 5), block('三', { row: 1, column: 2 }, 5)]), 100, 20);
    expect(result.problems).toEqual([]);
    expect(box(node(result, '布局实验/格'))).toEqual({ x: 0, y: 0, width: 20, height: 5 });
    expect(node(result, '布局实验/格/三').x).toBe(5);
  });

  it('随内容测量时跨比例列的元素按所跨份数计入每份尺寸', async () => {
    const result = await lab(hugGrid({ columns: [{ fraction: 1 }, { fraction: 1 }], rows: [{ fixed: 5 }], columnGap: 2 },
      [block('跨', { row: 1, column: 1, columnSpan: 2 }, 22), rect('右', { row: 1, column: 2 })]), 100, 20);
    expect(result.problems).toEqual([]);
    expect(node(result, '布局实验/格').width).toBe(22);
    expect(box(node(result, '布局实验/格/右'))).toEqual({ x: 12, y: 0, width: 10, height: 5 });
  });

  it('跨列元素把放不下的部分平均分给所跨的随内容列', async () => {
    const result = await lab({ layout: { mode: 'grid', columns: ['hug', 'hug', { fraction: 1 }], rows: [{ fixed: 8 }, { fixed: 8 }], columnGap: 1 },
      children: [block('短', { row: 1, column: 1 }, 5), block('长', { row: 2, column: 1, columnSpan: 2 }, 30), rect('右', { row: 1, column: 3 })] }, 100, 16);
    expect(result.problems).toEqual([]);
    expect(box(node(result, '布局实验/右'))).toEqual({ x: 31, y: 0, width: 69, height: 8 });
  });

  it('跨行元素同样撑开所跨的随内容行', async () => {
    const result = await lab({ layout: { mode: 'grid', columns: [{ fixed: 10 }, { fixed: 10 }], rows: ['hug', 'hug', { fraction: 1 }] },
      children: [block('高', { row: 1, column: 1, rowSpan: 2 }, 10, 20), block('矮', { row: 1, column: 2 }, 10, 4), rect('下', { row: 2, column: 2 })] }, 20, 30);
    expect(result.problems).toEqual([]);
    expect(box(node(result, '布局实验/下'))).toEqual({ x: 10, y: 12, width: 10, height: 8 });
  });

  it('跨度小的元素先撑开轨道', async () => {
    const result = await lab({ layout: { mode: 'grid', columns: ['hug', 'hug', 'hug', { fraction: 1 }], rows: [{ fixed: 5 }, { fixed: 5 }, { fixed: 5 }] },
      children: [block('三格', { row: 1, column: 1, columnSpan: 3 }, 34), block('两格', { row: 2, column: 1, columnSpan: 2 }, 10),
        rect('一', { row: 3, column: 1 }), rect('二', { row: 3, column: 2 }), rect('三', { row: 3, column: 3 })] }, 100, 15);
    expect(result.problems).toEqual([]);
    expect(['一', '二', '三'].map((name) => node(result, `布局实验/${name}`).width)).toEqual([13, 13, 8]);
  });

  it('元素连同边距比所在单元格大时报内容超出，位置是网格容器', async () => {
    const result = await lab({ layout: { mode: 'grid', columns: [{ fixed: 10 }, { fixed: 10 }, 'hug', { fraction: 1 }], rows: [{ fixed: 8 }] },
      children: [block('宽块', { row: 1, column: 1 }, 18), block('边距块', { row: 1, column: 2, margin: { left: 3 } }, 8),
        block('跨比例', { row: 1, column: 3, columnSpan: 2 }, 30), rect('填满', { row: 1, column: 1 })] }, 40, 8);
    const at = { kind: 'element', path: '布局实验' };
    expect(overflow(result)).toEqual([
      [ProblemCodes.layoutContentOverflow, at, '内容放不下：元素“宽块”需要 18 × 5 mm，所在单元格 10 × 8 mm'],
      [ProblemCodes.layoutContentOverflow, at, '内容放不下：元素“边距块”连同边距需要 11 × 5 mm，所在单元格 10 × 8 mm'],
      [ProblemCodes.layoutContentOverflow, at, '内容放不下：元素“跨比例”需要 30 × 5 mm，所在单元格 20 × 8 mm'],
    ]);
  });
});

describe('自由布局', () => {
  it('可以距右、距下定位；填满时取容器尺寸减去距边', async () => {
    const result = await lab(
      { children: [rect('角标', { right: 5, bottom: 5, ...fixed(20, 10) }), rect('横条', { left: 10, width: 'fill', height: { fixed: 5 } })] },
      100,
      50,
    );
    expect(box(node(result, '布局实验/角标'))).toEqual({ x: 75, y: 35, width: 20, height: 10 });
    expect(box(node(result, '布局实验/横条'))).toEqual({ x: 10, y: 0, width: 90, height: 5 });
  });
});

describe('外观与图形（254 DPI 下 1 mm 为 10 像素）', () => {
  const DPI = 254;
  const white = { fill: '#FFFFFF' };
  const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;
  const isBlue = ([r, g, b]: number[]) => b! > 200 && r! < 60 && g! < 60;
  const isWhite = ([r, g, b]: number[]) => r! > 240 && g! > 240 && b! > 240;
  const pixels = async (result: RenderResult) => {
    expect(result.problems).toEqual([]);
    return decodePixels(result.image!.bytes);
  };

  it('叠放顺序等于元素顺序，后面的画在上面', async () => {
    const image = await pixels(
      await lab({ ...white, children: [rect('红', { left: 10, top: 10, ...fixed(20, 20) }), rect('蓝', { left: 20, top: 20, ...fixed(20, 20) }, { fill: '#0000FF' })] }, 50, 50, DPI),
    );
    expect(isRed(pixelAtMm(image, 15, 15, DPI))).toBe(true);
    expect(isBlue(pixelAtMm(image, 25, 25, DPI))).toBe(true);
  });

  it('四角可各自设圆角', async () => {
    const image = await pixels(await lab({ ...white, children: [rect('框', { left: 5, top: 5, ...fixed(40, 20) }, { cornerRadius: { topLeft: 10 } })] }, 50, 30, DPI));
    expect(isWhite(pixelAtMm(image, 5.5, 5.5, DPI))).toBe(true);
    expect(isRed(pixelAtMm(image, 44.5, 5.5, DPI))).toBe(true);
    expect(isRed(pixelAtMm(image, 5.5, 24.5, DPI))).toBe(true);
  });

  it('透明度让元素与背景混合', async () => {
    const image = await pixels(await lab({ ...white, children: [rect('半透明', { left: 0, top: 0, ...fixed(10, 10) }, { opacity: 0.5 })] }, 20, 20, DPI));
    const [r, g, b] = pixelAtMm(image, 5, 5, DPI);
    expect(r).toBeGreaterThan(250);
    expect(g).toBeGreaterThan(120);
    expect(g).toBeLessThan(135);
    expect(b).toBeGreaterThan(120);
  });

  it('旋转绕元素框中心，不影响布局', async () => {
    const result = await lab({ ...white, children: [rect('竖条', { left: 5, top: 15, ...fixed(30, 10) }, { rotation: 90 })] }, 40, 40, DPI);
    const image = await pixels(result);
    expect(box(node(result, '布局实验/竖条'))).toEqual({ x: 5, y: 15, width: 30, height: 10 });
    expect(isRed(pixelAtMm(image, 20, 7, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(image, 7, 20, DPI))).toBe(true);
  });

  it('矩形的描边画在框内', async () => {
    const image = await pixels(
      await lab({ ...white, children: [{ type: 'rect', name: '边框', stroke: { color: '#0000FF', width: 2 }, place: { left: 10, top: 10, ...fixed(20, 20) } }] }, 40, 40, DPI),
    );
    expect(isWhite(pixelAtMm(image, 9.5, 20, DPI))).toBe(true);
    expect(isBlue(pixelAtMm(image, 10.5, 20, DPI))).toBe(true);
    expect(isBlue(pixelAtMm(image, 11.5, 20, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(image, 12.5, 20, DPI))).toBe(true);
  });

  it('椭圆、线条与虚线', async () => {
    const image = await pixels(
      await lab(
        {
          ...white,
          children: [
            { type: 'ellipse', name: '圆点', fill: '#FF0000', place: { left: 5, top: 5, ...fixed(30, 20) } },
            { type: 'line', name: '实线', from: [0, 5], to: [20, 5], stroke: { color: '#0000FF', width: 1 }, place: { left: 10, top: 30, ...fixed(20, 10) } },
            { type: 'line', name: '虚线', from: [0, 5], to: [20, 5], stroke: { color: '#0000FF', width: 1, dash: [2, 2] }, place: { left: 10, top: 40, ...fixed(20, 10) } },
          ],
        },
        50,
        60,
        DPI,
      ),
    );
    expect(isRed(pixelAtMm(image, 20, 15, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(image, 5.5, 5.5, DPI))).toBe(true);
    expect(isBlue(pixelAtMm(image, 20, 35, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(image, 20, 36, DPI))).toBe(true);
    expect(isBlue(pixelAtMm(image, 11, 45, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(image, 13, 45, DPI))).toBe(true);
  });

  it('多边形的坐标以毫米计、相对元素框，框变大时图形不拉伸（M94）', async () => {
    const triangle = (size: number) =>
      lab({ ...white, children: [{ type: 'polygon', name: '三角', points: [[0, 0], [10, 0], [0, 10]], fill: '#FF0000', place: { left: 5, top: 5, ...fixed(size, size) } }] }, 40, 40, DPI);
    const small = boundsOf(await pixels(await triangle(10)), isRed);
    const large = boundsOf(await pixels(await triangle(30)), isRed);

    expect(large).toEqual(small);
    expect(small!.right - small!.left).toBeGreaterThanOrEqual(98);
    expect(small!.right - small!.left).toBeLessThanOrEqual(100);
  });

  it('路径支持 SVG 语法与填充规则', async () => {
    const ring = (fillRule: string) =>
      lab({ ...white, children: [{ type: 'path', name: '方环', d: 'M0 0 H20 V20 H0 Z M5 5 H15 V15 H5 Z', fill: '#FF0000', fillRule, place: { left: 10, top: 10, ...fixed(20, 20) } }] }, 40, 40, DPI);
    expect(isWhite(pixelAtMm(await pixels(await ring('evenodd')), 20, 20, DPI))).toBe(true);
    expect(isRed(pixelAtMm(await pixels(await ring('nonzero')), 20, 20, DPI))).toBe(true);
  });

  it('容器可以裁剪超出部分', async () => {
    const clipped = (clip: boolean) =>
      lab(
        { ...white, children: [{ type: 'container', name: '窗口', clip, place: { left: 10, top: 10, ...fixed(10, 10) }, children: [rect('大块', fixed(30, 30))] }] },
        40,
        40,
        DPI,
      );
    expect(isRed(pixelAtMm(await pixels(await clipped(true)), 15, 15, DPI))).toBe(true);
    expect(isWhite(pixelAtMm(await pixels(await clipped(true)), 25, 25, DPI))).toBe(true);
    expect(isRed(pixelAtMm(await pixels(await clipped(false)), 25, 25, DPI))).toBe(true);
  });

  it('路径数据不合法、线条缺少描边时报问题', async () => {
    const badPath = await lab({ children: [{ type: 'path', name: '坏路径', d: 'M0 0 Q', fill: '#FF0000', place: fixed(10, 10) }] }, 20, 20);
    const noStroke = await lab({ children: [{ type: 'line', name: '线', from: [0, 0], to: [10, 0], place: fixed(10, 10) }] }, 20, 20);

    expect(badPath.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.templateInvalid, { kind: 'element', path: '布局实验/坏路径' }]]);
    expect(noStroke.problems.map((p) => p.code)).toEqual([ProblemCodes.templateInvalid, ProblemCodes.renderExpansionBlocked]);
  });
});
