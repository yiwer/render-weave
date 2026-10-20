import { describe, expect, it } from 'vitest';
import { render, ProblemCodes, type RenderResult } from '../src/index.js';
import { textLab, textLabRequest } from './support/fixtures.js';
import { boundsOf, decodePixels, pixelAt, type Pixels } from './support/pixels.js';

const fit = { steps: ['compressGlyphs', 'shrink'] };
const summary = (result: RenderResult) => result.layout!.root.children![0]!.text!;
async function sample(width: number, extra: Record<string, unknown> = {}, height = 20, mode = 'final'): Promise<RenderResult> {
  const workspace = await textLab([], { fill: '#FFFFFF', children: [{ type: 'text', name: '横排',
    content: [{ text: '田田田田' }], font: 'res:font-hei-medium', fontSize: 10, color: '#000000',
    verticalAlign: 'center', fit, place: { width: 'fill', height: 'fill' }, ...extra }] });
  return render(workspace, { ...textLabRequest({}, width, height, 254), mode });
}
const ink = ([r, g, b]: number[]) => r! + g! + b! < 600;
function inkColumns(pixels: Pixels): { left: number; right: number }[] {
  const groups: { left: number; right: number }[] = [];
  let inside = false;
  for (let x = 0; x < pixels.width; x++) {
    let found = false;
    for (let y = 0; y < pixels.height; y++) if (ink(pixelAt(pixels, x, y))) { found = true; break; }
    if (found && !inside) groups.push({ left: x, right: x });
    if (found) groups.at(-1)!.right = x;
    inside = found;
  }
  return groups;
}

describe('横排压缩与缩字', () => {
  it.each([
    [40, 1, 10, 40, false], [30, 0.75, 10, 30, false], [24, 0.6, 10, 24, false],
    [20, 0.6, 8.333, 20, false], [12, 0.6, 5, 12, false], [10, 0.6, 5, 12, true],
  ])('可用宽 %d mm：先压到 %d 再缩到 %d mm', async (width, compression, size, extent, overflow) => {
    const result = await sample(width);
    expect(summary(result)).toMatchObject({ compression, fontSize: size, width: extent, overflow, spacing: 0 });
    expect(summary(result).fragments[0]!.fontSize).toBe(size);
    expect(result.problems.map((problem) => problem.code)).toEqual(overflow ? [ProblemCodes.layoutTextOverflow] : []);
    expect(!!result.image).toBe(!overflow);
  });

  it('模板可提高压缩与字号下限，提示问题允许出图；草稿保留严重问题', async () => {
    const result = await sample(12, { fit: { ...fit, compressMin: 0.8, minFontSize: 7, onFail: 'hint' } });
    expect(summary(result)).toMatchObject({ compression: 0.8, fontSize: 7, width: 22.4, overflow: true });
    expect(result.problems[0]).toMatchObject({ code: ProblemCodes.layoutTextOverflow, level: 'hint',
      location: { kind: 'element', path: '文字实验/横排' } });
    expect(result.image).toBeDefined();
    const draft = await sample(10, {}, 20, 'draft');
    expect(summary(draft).overflow).toBe(true);
    expect(draft.image).toBeDefined();
  });

  it('只允许压缩时保持字号；未写适配时保持字形', async () => {
    const compressed = await sample(20, { fit: { steps: ['compressGlyphs'] } });
    expect(summary(compressed)).toMatchObject({ compression: 0.6, fontSize: 10, overflow: true });
    const unfit = await sample(20, { fit: undefined });
    expect(summary(unfit)).toMatchObject({ compression: 1, fontSize: 10, width: 40, overflow: true });
  });

  it('高度也能触发缩字，不需要横向压缩时保持原比例', async () => {
    const original = await sample(50);
    const height = summary(original).height * 0.8;
    const shorter = await sample(50, {}, height);
    expect(shorter.problems).toEqual([]);
    expect(summary(shorter).fontSize).toBeCloseTo(8, 2);
    expect(summary(shorter).compression).toBe(1);
  });

  it('混合片段同比缩字，任一片段到达下限即停止，字号摘要与绘图同步', async () => {
    const content = [{ text: '田田', fontSize: 10, color: '#FF0000' },
      { text: '田田', fontSize: 20, color: '#0000FF' }];
    const result = await sample(18, { content });
    expect(result.problems).toEqual([]);
    expect(summary(result).fragments.map((fragment) => fragment.fontSize)).toEqual([5, 10]);
    const pixels = await decodePixels(result.image!.bytes);
    const red = boundsOf(pixels, ([r, g, b]) => r > 180 && g < 80 && b < 80)!;
    const blue = boundsOf(pixels, ([r, g, b]) => r < 80 && g < 80 && b > 180)!;
    expect(blue.bottom - blue.top).toBeGreaterThan((red.bottom - red.top) * 1.9);
    const narrow = await sample(17, { content });
    expect(summary(narrow).fragments.map((fragment) => fragment.fontSize)).toEqual([5, 10]);
    expect(summary(narrow).overflow).toBe(true);
  });

  it.each([
    { steps: ['shrink', 'compressGlyphs'] }, { steps: ['shrink'] }, { steps: ['compressGlyphs', 'compressGlyphs'] },
    { steps: ['compressGlyphs', 'tightenSpacing'] }, { steps: ['tightenSpacing', 'shrink'] },
    { ...fit, compressMin: 0.59 }, { ...fit, minFontSize: 4.9 }, { steps: ['compressGlyphs'], minFontSize: 5 },
    { steps: ['tightenSpacing', 'compressGlyphs'], minFontSize: 5 },
  ])('静态拒绝非法顺序或下限：%j', async (invalid) => {
    const result = await sample(40, { fit: invalid });
    expect(result.problems.map((problem) => problem.code)).toContain(ProblemCodes.templateInvalid);
    expect(result.layout).toBeUndefined();
  });

  it('横向压缩与缩字后描边仍保持 0.5 mm 厚度', async () => {
    for (const width of [60, 30, 15]) {
      const result = await sample(width, { content: [{ text: '丨丨丨丨' }], padding: 1,
        stroke: { color: '#FF0000', width: 0.5 } });
      expect(result.problems).toEqual([]);
      const pixels = await decodePixels(result.image!.bytes);
      // 单竖笔的中间水平截面：描边位于每根黑色竖笔两侧，不受内部笔画相接影响。
      const bounds = boundsOf(pixels, ([r, g, b]) => r < 50 && g < 50 && b < 50)!;
      const y = Math.round(bounds.top + (bounds.bottom - bounds.top) * 0.3);
      const redRuns: number[] = [];
      let length = 0;
      for (let x = 0; x <= pixels.width; x++) {
        const [r, g, b] = x < pixels.width ? pixelAt(pixels, x, y) : [0, 0, 0];
        if (r! > 180 && g! < 80 && b! < 80) length++;
        else if (length) { redRuns.push(length); length = 0; }
      }
      expect(redRuns.length).toBeGreaterThanOrEqual(8);
      for (const length of redRuns) {
        expect(length, `宽 ${width} mm 的描边像素段 ${redRuns}`).toBeGreaterThanOrEqual(4);
        expect(length).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('横排同间隔分布', () => {
  it.each([-15, 0, 15])('倾斜 %d 度、混合字号时，两侧留白与字间墨迹间隔相同', async (slant) => {
    const result = await sample(60, { horizontalAlign: 'spaceEvenly', slant, padding: { left: 2, right: 3 }, content: [
      { text: '口', fontSize: 8 }, { text: '田', fontSize: 12 }, { text: '目' },
    ] });
    expect(result.problems).toEqual([]);
    const columns = inkColumns(await decodePixels(result.image!.bytes));
    expect(columns).toHaveLength(3);
    const gaps = [columns[0]!.left - 20, columns[1]!.left - columns[0]!.right - 1,
      columns[2]!.left - columns[1]!.right - 1, 570 - columns[2]!.right - 1];
    expect(Math.min(...gaps)).toBeGreaterThan(50);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(2);
    for (const gap of gaps) expect(Math.abs(gap - summary(result).spacing * 10)).toBeLessThanOrEqual(2);
    expect(summary(result).width + 2 * summary(result).spacing).toBeCloseTo(55, 2);
  });

  it('单字居中，空文本不产生虚构字距', async () => {
    const single = await sample(40, { horizontalAlign: 'spaceEvenly', content: [{ text: '田' }] });
    expect(single.problems).toEqual([]);
    const bounds = boundsOf(await decodePixels(single.image!.bytes), ink)!;
    expect(Math.abs((bounds.left + bounds.right + 1) / 2 - 200)).toBeLessThanOrEqual(1);
    expect(summary(single).width + 2 * summary(single).spacing).toBeCloseTo(40, 2);
    const empty = await sample(40, { horizontalAlign: 'spaceEvenly', content: [] });
    expect(empty.problems).toEqual([]);
    expect(summary(empty)).toMatchObject({ width: 0, spacing: 0, compression: 1, overflow: false });
  });

  it('宽度不足时先把全部留白收到 0，再压缩、缩字；下限仍生效', async () => {
    const natural = await sample(60, { horizontalAlign: 'spaceEvenly' });
    const inkWidth = summary(natural).width - summary(natural).spacing * 3;
    const compressed = await sample(inkWidth * 0.8, { horizontalAlign: 'spaceEvenly' });
    expect(compressed.problems).toEqual([]);
    expect(summary(compressed)).toMatchObject({ spacing: 0, compression: 0.8, fontSize: 10 });
    const shrunk = await sample(inkWidth * 0.6 * 0.8, { horizontalAlign: 'spaceEvenly' });
    expect(shrunk.problems).toEqual([]);
    expect(summary(shrunk)).toMatchObject({ spacing: 0, compression: 0.6 });
    expect(summary(shrunk).fontSize).toBeCloseTo(8, 2);
    const failed = await sample(inkWidth * 0.6 * 0.4, { horizontalAlign: 'spaceEvenly' });
    expect(summary(failed)).toMatchObject({ spacing: 0, compression: 0.6, fontSize: 5, overflow: true });
    expect(failed.problems.map((problem) => problem.code)).toContain(ProblemCodes.layoutTextOverflow);
  });

  it('竖排不能设置横向同间隔分布', async () => {
    const result = await sample(40, { writingMode: 'vertical', horizontalAlign: 'spaceEvenly', fit: undefined });
    expect(result.problems.map((problem) => problem.code)).toContain(ProblemCodes.templateInvalid);
    expect(result.layout).toBeUndefined();
  });
});

describe('横排两端分布按墨迹铺满', () => {
  it.each([-15, 15])('倾斜 %d 度后按真实轮廓墨迹铺满，压缩后仍对齐', async (slant) => {
    for (const width of [60, 20]) {
      const result = await sample(width, { horizontalAlign: 'distribute', slant, padding: 1, content: [
        { text: '人', color: '#FF0000' }, { text: '田', color: '#00AA00' }, { text: '口', color: '#0000FF' },
      ] });
      expect(result.problems).toEqual([]);
      const pixels = await decodePixels(result.image!.bytes);
      const red = boundsOf(pixels, ([r, g, b]) => r > 180 && g < 80 && b < 80)!;
      const green = boundsOf(pixels, ([r, g, b]) => r < 80 && g > 100 && b < 80)!;
      const blue = boundsOf(pixels, ([r, g, b]) => r < 80 && g < 80 && b > 180)!;
      expect(Math.abs(red.left - 10)).toBeLessThanOrEqual(1);
      expect(Math.abs(blue.right - (width * 10 - 11))).toBeLessThanOrEqual(1);
      const gap1 = green.left - red.right - 1;
      const gap2 = blue.left - green.right - 1;
      expect(Math.abs(gap1 - gap2)).toBeLessThanOrEqual(2);
    }
  });

  it('不同字形、不同字号的墨迹间距一致，左右边缘贴内边距', async () => {
    const result = await sample(60, { horizontalAlign: 'distribute', padding: { left: 2, right: 3 }, content: [
      { text: '口', fontSize: 8 }, { text: '田', fontSize: 12 }, { text: '目' },
    ] });
    expect(result.problems).toEqual([]);
    expect(summary(result)).toMatchObject({ width: 55, compression: 1, fontSize: 10 });
    const columns = inkColumns(await decodePixels(result.image!.bytes));
    expect(columns).toHaveLength(3);
    expect(columns[0]!.left).toBeCloseTo(20, 0);
    expect(columns[2]!.right).toBeCloseTo(569, 0);
    const firstGap = columns[1]!.left - columns[0]!.right - 1;
    const secondGap = columns[2]!.left - columns[1]!.right - 1;
    expect(Math.abs(firstGap - secondGap)).toBeLessThanOrEqual(1);
    expect(Math.abs(firstGap - summary(result).spacing * 10)).toBeLessThanOrEqual(1);
  });

  it('单字按墨迹居中；空文本与空格不产生无效坐标', async () => {
    const single = await sample(40, { horizontalAlign: 'distribute', content: [{ text: '田' }] });
    expect(single.problems).toEqual([]);
    const bounds = boundsOf(await decodePixels(single.image!.bytes), ink)!;
    expect(Math.abs((bounds.left + bounds.right + 1) / 2 - 200)).toBeLessThanOrEqual(1);
    for (const value of ['', ' ', '田 田']) {
      const result = await sample(40, { horizontalAlign: 'distribute', content: [{ text: value }] });
      expect(result.problems).toEqual([]);
      expect(JSON.stringify(result.layout)).not.toMatch(/null|NaN|Infinity/);
      expect(result.image).toBeDefined();
    }
  });

  it('两端分布压缩到下限再缩字，结果仍铺满且不产生负字距', async () => {
    const natural = await sample(60, { horizontalAlign: 'distribute' });
    const inkWidth = 60 - summary(natural).spacing * 3;
    const result = await sample(inkWidth * 0.6 * 0.8, { horizontalAlign: 'distribute' });
    expect(result.problems).toEqual([]);
    expect(summary(result)).toMatchObject({ compression: 0.6, spacing: 0 });
    expect(summary(result).fontSize).toBeCloseTo(8, 2);
    const columns = inkColumns(await decodePixels(result.image!.bytes));
    expect(columns[0]!.left).toBe(0);
  });
});

describe('模板在画板上声明缩字下限（M238）', () => {
  const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
  const tag = (name: string, textFit: Record<string, unknown> = fit, place: Record<string, unknown> = { width: 'fill', height: 'fill' }) => ({
    type: 'text', name, content: [{ text: '田田田田' }], font: 'res:font-hei-medium', fontSize: 3.4, color: '#000000', fit: textFit, place });
  async function small(width: number, artboard: Record<string, unknown> = {}, textFit: Record<string, unknown> = fit): Promise<RenderResult> {
    const workspace = await textLab([], { fill: '#FFFFFF', ...artboard, children: [tag('品名', textFit)] });
    return render(workspace, { ...textLabRequest({}, width, 10, 254), mode: 'final' });
  }
  const messages = (result: RenderResult) => result.problems.map((p) => p.message);

  it('画板写 3 mm 后，3.4 mm 的品名能缩字放下；不写时与原来相同', async () => {
    const lowered = await small(7.5, { minFontSize: 3 });
    expect(lowered.problems).toEqual([]);
    expect(summary(lowered)).toMatchObject({ compression: 0.6, width: 7.5, overflow: false });
    expect(summary(lowered).fontSize).toBeGreaterThan(3);
    expect(summary(lowered).fontSize).toBeLessThan(3.4);
    const unchanged = await small(7.5);
    expect(summary(unchanged)).toMatchObject({ compression: 0.6, fontSize: 3.4, overflow: true });
  });

  it.each([
    [{}, fit, 3.4, '；字号已不高于最小字号 5 mm（缺省值，画板可写 minFontSize 调低），没有缩字'],
    [{ minFontSize: 3 }, fit, 3, '；已缩到最小字号 3 mm（画板 minFontSize）'],
    [{ minFontSize: 3 }, { ...fit, minFontSize: 3.2 }, 3.2, '；已缩到最小字号 3.2 mm（元素 fit.minFontSize）'],
  ])('到了下限仍放不下时写明下限与来源：画板 %j，适配 %j', async (artboard, textFit, size, tail) => {
    const result = await small(5, artboard, textFit);
    expect(summary(result)).toMatchObject({ fontSize: size, overflow: true });
    expect(messages(result)).toEqual([expect.stringMatching(/^文字"田田田田"放不下：需要 [\d.]+ × [\d.]+ mm，可用 5 × 10 mm/)]);
    expect(messages(result)[0]!.endsWith(tail)).toBe(true);
  });

  it('只压缩不缩字时，问题说明不提下限', async () => {
    const result = await small(5, { minFontSize: 3 }, { steps: ['compressGlyphs'] });
    expect(messages(result)[0]).not.toContain('最小字号');
  });

  it.each([
    [{ minFontSize: 1.4 }, fit, '画板的 minFontSize 不能低于 1.5 mm（M238）'],
    [{ minFontSize: '3' }, fit, '画板的 minFontSize 不能低于 1.5 mm（M238）'],
    [{ minFontSize: 3 }, { ...fit, minFontSize: 2.5 }, 'fit.minFontSize 不能低于画板的 minFontSize 3 mm（M238）'],
    [{}, { ...fit, minFontSize: 4.9 }, 'fit.minFontSize 不能低于 5 mm（缺省值，画板可写 minFontSize 调低）'],
  ])('下限写错时静态拒绝：画板 %j，适配 %j', async (artboard, textFit, message) => {
    const result = await small(20, artboard, textFit);
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.templateInvalid, message }));
    expect(result.layout).toBeUndefined();
  });

  it('被调模板用自己画板的下限，不继承调用方', async () => {
    let workspace = await textLab([], { fill: '#FFFFFF', minFontSize: 3, layout: { mode: 'grid', columns: [{ fixed: 7.5 }, { fixed: 7.5 }], rows: [{ fixed: 10 }] },
      children: [tag('主品名', fit, { row: 1, column: 1 }), { type: 'call', name: '调用', template: '子模板', data: 'none', place: { row: 1, column: 2 } }] });
    workspace = { ...workspace, templates: [...workspace.templates, { name: '子模板', document: { dslVersion: 'renderweave-template/1', name: '子模板',
      base: { name: '空数据定义', version: 1 }, artboard: { sizeRange: range, children: [tag('子品名')] } } }] };
    const result = await render(workspace, { ...textLabRequest({}, 15, 10, 254), mode: 'draft' });
    const sizeOf = (path: string) => {
      const find = (node: any): any => (node.path === path ? node : (node.children ?? []).map(find).find(Boolean));
      return find(result.layout!.root).text.fontSize;
    };
    expect(sizeOf('文字实验/主品名')).toBe(summary(await small(7.5, { minFontSize: 3 })).fontSize);
    expect(sizeOf('文字实验/调用/子品名')).toBe(3.4);
    expect(result.problems.map((p) => [p.code, p.location])).toEqual([[ProblemCodes.layoutTextOverflow, { kind: 'element', path: '文字实验/调用/子品名' }]]);
  });
});

describe('横排固定字间距 letterSpacing 与 tightenSpacing（M243）', () => {
  const tightenFit = { steps: ['tightenSpacing', 'compressGlyphs', 'shrink'] };

  it('正负 letterSpacing 跨片段连续计算自然宽度、字形位置与 spacing 摘要；单字与空文本不加，下限为 0', async () => {
    const fragments = [{ text: '田田' }, { text: '' }, { text: '田田' }];
    const positive = await sample(60, {
      content: fragments,
      letterSpacing: 2,
      fit: undefined,
      place: { left: 0, top: 0, width: 'hug', height: { fixed: 20 } },
    });
    expect(positive.problems).toEqual([]);
    expect(positive.layout!.root.children![0]!.width).toBe(46);
    expect(summary(positive)).toMatchObject({ width: 46, spacing: 2, compression: 1, overflow: false });
    const posCols = inkColumns(await decodePixels(positive.image!.bytes));
    expect(posCols).toHaveLength(4);
    const baseCols = inkColumns(await decodePixels((await sample(60, { content: fragments, fit: undefined })).image!.bytes));
    // 第 k 个字（k = 0..3）相对无字距时整体右移 k × 2 mm（254 DPI 下为 20 px）。
    for (let k = 0; k < 4; k++) {
      expect(Math.abs((posCols[k]!.left - baseCols[k]!.left) - k * 20)).toBeLessThanOrEqual(1);
    }

    const negative = await sample(60, {
      content: fragments,
      letterSpacing: -1,
      fit: undefined,
      place: { left: 0, top: 0, width: 'hug', height: { fixed: 20 } },
    });
    expect(negative.problems).toEqual([]);
    expect(negative.layout!.root.children![0]!.width).toBe(37);
    expect(summary(negative)).toMatchObject({ width: 37, spacing: -1, compression: 1, overflow: false });

    const single = await sample(40, {
      content: [{ text: '田' }],
      letterSpacing: 5,
      fit: undefined,
      place: { left: 0, top: 0, width: 'hug', height: { fixed: 20 } },
    });
    expect(single.layout!.root.children![0]!.width).toBe(10);
    expect(summary(single)).toMatchObject({ width: 10, spacing: 0 });

    const empty = await sample(40, {
      content: [],
      letterSpacing: 5,
      fit: undefined,
      place: { left: 0, top: 0, width: 'hug', height: { fixed: 20 } },
    });
    expect(empty.layout!.root.children![0]!.width).toBe(0);
    expect(summary(empty)).toMatchObject({ width: 0, spacing: 0 });

    const clamped = await sample(40, {
      content: [{ text: '田田' }],
      letterSpacing: -25,
      fit: undefined,
      place: { left: 0, top: 0, width: 'hug', height: { fixed: 20 } },
    });
    expect(clamped.layout!.root.children![0]!.width).toBe(0);
    expect(summary(clamped)).toMatchObject({ width: 0, spacing: -25, overflow: false });
  });

  it('letterSpacing 支持变量绑定，缺值时按 0 回退并报告问题；两端分布忽略 letterSpacing', async () => {
    const workspace = await textLab(
      [{ name: 'gap', displayName: '字距', type: 'number' }],
      {
        fill: '#FFFFFF',
        children: [
          {
            type: 'text',
            name: '横排',
            content: [{ text: '田田田' }],
            font: 'res:font-hei-medium',
            fontSize: 10,
            letterSpacing: { var: 'gap' },
            place: { width: 'hug', height: { fixed: 20 } },
          },
        ],
      },
    );
    const bound = await render(workspace, textLabRequest({ gap: 1.5 }, 50, 20, 254));
    expect(bound.problems).toEqual([]);
    expect(summary(bound)).toMatchObject({ width: 33, spacing: 1.5 });

    const missing = await render(workspace, { ...textLabRequest({}, 50, 20, 254), mode: 'draft' });
    expect(missing.problems.map((p) => p.code)).toContain(ProblemCodes.templateBindingValueInvalid);
    expect(summary(missing)).toMatchObject({ width: 30, spacing: 0 });

    const distributed = await sample(60, { horizontalAlign: 'distribute', letterSpacing: 5 });
    const distributedZero = await sample(60, { horizontalAlign: 'distribute', letterSpacing: 0 });
    expect(summary(distributed)).toEqual(summary(distributedZero));

    const evenly = await sample(60, { horizontalAlign: 'spaceEvenly', letterSpacing: -3 });
    const evenlyZero = await sample(60, { horizontalAlign: 'spaceEvenly', letterSpacing: 0 });
    expect(summary(evenly)).toEqual(summary(evenlyZero));
  });

  it.each([
    [46, 2, 1, 10, 46, false],
    [43, 1, 1, 10, 43, false],
    [40, 0, 1, 10, 40, false],
    [30, 0, 0.75, 10, 30, false],
    [24, 0, 0.6, 10, 24, false],
    [20, 0, 0.6, 8.333, 20, false],
    [10, 0, 0.6, 5, 12, true],
  ])('tightenSpacing 边界（可用宽 %d mm）：先收紧字距到 %d mm，再压到 %d、缩到 %d mm', async (width, spacing, compression, size, extent, overflow) => {
    const result = await sample(width, { letterSpacing: 2, fit: tightenFit });
    expect(summary(result)).toMatchObject({ spacing, compression, fontSize: size, width: extent, overflow });
    expect(result.problems.map((p) => p.code)).toEqual(overflow ? [ProblemCodes.layoutTextOverflow] : []);
  });

  it('仅配置 tightenSpacing 时收紧到 0 即止；负字距下跳过收紧直接压缩字形', async () => {
    const onlyTightenFit = await sample(43, { letterSpacing: 2, fit: { steps: ['tightenSpacing'] } });
    expect(summary(onlyTightenFit)).toMatchObject({ spacing: 1, compression: 1, width: 43, overflow: false });

    const onlyTightenOverflow = await sample(35, { letterSpacing: 2, fit: { steps: ['tightenSpacing'] } });
    expect(summary(onlyTightenOverflow)).toMatchObject({ spacing: 0, compression: 1, width: 40, overflow: true });
    expect(onlyTightenOverflow.problems.map((p) => p.code)).toEqual([ProblemCodes.layoutTextOverflow]);

    const negativeCompressed = await sample(28, { letterSpacing: -2, fit: tightenFit });
    expect(negativeCompressed.problems).toEqual([]);
    expect(summary(negativeCompressed)).toMatchObject({ spacing: -2, compression: 0.85, fontSize: 10, width: 28, overflow: false });
  });
});
