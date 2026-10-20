import { describe, expect, it } from 'vitest';
import { ProblemCodes, render, type LayoutNode, type RenderResult } from '../src/index.js';
import { loadStopName, stopNameRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, inkRows, pixelAt, runsInColumn } from './support/pixels.js';

const stopName = (result: RenderResult): LayoutNode => result.layout!.root.children![0]!;
const isWhite = ([r, g, b]: number[]) => r! > 245 && g! > 245 && b! > 245;

describe('竖排站名：两端分布、收紧字距与纵向压缩（M402 站名区 20 × 73 mm，字号 10 mm）', () => {
  it('2 字站名：首字墨迹贴顶、末字墨迹贴底，中间是字距，不压缩', async () => {
    const result = await render(await loadStopName(), stopNameRequest('田贝'));

    expect(result.problems).toEqual([]);
    expect(stopName(result).text).toMatchObject({
      content: '田贝',
      writingMode: 'vertical',
      fontSize: 10,
      height: 73,
      compression: 1,
      overflow: false,
    });
    expect(stopName(result).text!.spacing).toBeGreaterThan(50);

    // 图上：最上一行与最下一行墨迹分别贴着画板上下边缘（120 DPI 下 73 mm 为 345 像素）。
    const pixels = await decodePixels(result.image!.bytes);
    expect(inkRows(pixels, isWhite)).toEqual({ top: 0, bottom: 344 });
    await expectMatchesGolden('vertical-2-chars', result.image!.bytes);
  });

  it('7 字站名（M402 最长）：放得下，字距不小于 0，不压缩', async () => {
    const result = await render(await loadStopName(), stopNameRequest('李朗国际珠宝园'));

    expect(result.problems).toEqual([]);
    expect(stopName(result).text).toMatchObject({ fontSize: 10, height: 73, compression: 1, overflow: false });
    expect(stopName(result).text!.spacing).toBeGreaterThanOrEqual(0);
    expect(stopName(result).text!.spacing).toBeLessThan(1);
    await expectMatchesGolden('vertical-7-chars', result.image!.bytes);
  });

  it('11 字站名：字距收到 0，再纵向压缩到放下为止，字号不变', async () => {
    const result = await render(await loadStopName(), stopNameRequest('布吉街道办事处公交总站'));
    const text = stopName(result).text!;

    expect(result.problems).toEqual([]);
    expect(text).toMatchObject({ fontSize: 10, height: 73, spacing: 0, overflow: false });
    expect(text.compression).toBeGreaterThanOrEqual(0.6);
    expect(text.compression).toBeLessThan(0.7);
    const pixels = await decodePixels(result.image!.bytes);
    expect(inkRows(pixels, isWhite)).toEqual({ top: 0, bottom: 344 });
    await expectMatchesGolden('vertical-11-chars', result.image!.bytes);
  });

  it('压缩到 60% 仍放不下：严重问题以元素路径定位到站名，正式出图不输出图片', async () => {
    const result = await render(await loadStopName(), stopNameRequest('布吉街道办事处公交总站候车'));

    expect(result.problems.map((p) => [p.code, p.level, p.location])).toEqual([
      [ProblemCodes.layoutTextOverflow, 'severe', { kind: 'element', path: '竖排站名/站名' }],
    ]);
    expect(result.problems[0]!.message).toContain('字形压到 60% 后仍需高');
    expect(stopName(result).text).toMatchObject({ fontSize: 10, spacing: 0, compression: 0.6, overflow: true });
    expect(result.image).toBeUndefined();
  });

  it('模板把下限设得更高时按模板的下限；onFail 为 hint 时只记提示', async () => {
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0]['fit'] = { steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.8, onFail: 'hint' };
    });
    const result = await render(workspace, stopNameRequest('布吉街道办事处公交总站'));

    expect(result.problems.map((p) => [p.code, p.level])).toEqual([[ProblemCodes.layoutTextOverflow, 'hint']]);
    expect(stopName(result).text).toMatchObject({ compression: 0.8, overflow: true });
    expect(result.image).toBeDefined();
  });

  it('不允许压缩字形时，字距收到 0 仍放不下即报问题，不压缩', async () => {
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0]['fit'] = { steps: ['tightenSpacing'] };
    });
    const result = await render(workspace, stopNameRequest('布吉街道办事处公交总站'));

    expect(result.problems.map((p) => p.code)).toEqual([ProblemCodes.layoutTextOverflow]);
    expect(stopName(result).text).toMatchObject({ spacing: 0, compression: 1, overflow: true });
  });

  it('未指定缩字组时，字号比列宽更宽时报问题', async () => {
    const result = await render(await loadStopName(), stopNameRequest('田贝', { output: { width: 12, height: 73, dpi: 120, format: 'png' } }));
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0]['place']['width'] = { fixed: 8 };
    });
    const narrow = await render(workspace, stopNameRequest('田贝'));

    expect(result.problems).toEqual([]);
    expect(narrow.problems.map((p) => p.code)).toEqual([ProblemCodes.layoutTextOverflow]);
    expect(narrow.problems[0]!.message).toContain('字号 10 mm 比可用宽 8 mm 更宽');
  });

  it('上、中、下对齐时字格相接，整段在框内对齐', async () => {
    const aligned = async (verticalAlign: string) => {
      const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
        document['artboard']['children'][0]['verticalAlign'] = verticalAlign;
      });
      const result = await render(workspace, stopNameRequest('建设路'));
      return { text: stopName(result).text!, ink: inkRows(await decodePixels(result.image!.bytes), isWhite) };
    };
    const top = await aligned('top');
    const center = await aligned('center');
    const bottom = await aligned('bottom');

    expect(top.text).toMatchObject({ height: 30, spacing: 0, compression: 1 });
    // 墨迹在字格内略有留白，所以只比较三种对齐之间的相对位置：每种相差 (73 - 30) / 2 mm，约 101 像素。
    expect(center.ink.top - top.ink.top).toBeGreaterThanOrEqual(100);
    expect(center.ink.top - top.ink.top).toBeLessThanOrEqual(103);
    expect(bottom.ink.top - center.ink.top).toBeGreaterThanOrEqual(100);
    expect(bottom.ink.top - center.ink.top).toBeLessThanOrEqual(103);
  });

  it('fit 的步骤顺序与压缩下限不合规定时，模板检查报问题', async () => {
    const withFit = async (fit: unknown) => {
      const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
        document['artboard']['children'][0]['fit'] = fit;
      });
      return (await render(workspace, stopNameRequest('田贝'))).problems.map((p) => [p.code, p.location]);
    };
    const location = { kind: 'element', path: '竖排站名/站名' };
    const blocked = [ProblemCodes.renderExpansionBlocked, { kind: 'input', source: 'render' }];

    expect(await withFit({ steps: ['compressGlyphs', 'tightenSpacing'] })).toEqual([[ProblemCodes.templateInvalid, location], blocked]);
    expect(await withFit({ steps: ['compressGlyphs'] })).toEqual([[ProblemCodes.templateInvalid, location], blocked]);
    expect(await withFit({ steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.5 })).toEqual([
      [ProblemCodes.templateInvalid, location],
      blocked,
    ]);
    expect(await withFit({ steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: 'stopNames' } })).toEqual([]);
  });

  it('同样的输入两次渲染，布局摘要与图片字节都相同', async () => {
    const workspace = await loadStopName();
    const first = await render(workspace, stopNameRequest('布吉街道办事处公交总站'));
    const second = await render(workspace, stopNameRequest('布吉街道办事处公交总站'));

    expect(second.layout).toEqual(first.layout);
    expect(Buffer.compare(Buffer.from(second.image!.bytes), Buffer.from(first.image!.bytes))).toBe(0);
  });
});

describe('文字描边', () => {
  const RED = '#FF0000';
  const isRed = ([r, g, b]: number[]) => r! > 200 && g! < 60 && b! < 60;
  const isBlack = ([r, g, b]: number[]) => r! < 60 && g! < 60 && b! < 60;

  /** 254 DPI 下 1 mm 为 10 像素；描边 0.8 mm 即字形外侧约 8 像素。 */
  async function strokedOneBars(boxHeight: number) {
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      const text = document['artboard']['children'][0];
      text['verticalAlign'] = 'top';
      text['color'] = '#000000';
      text['stroke'] = { color: RED, width: 0.8 };
      text['place'] = { left: 0, top: 2, width: { fixed: 20 }, height: { fixed: boxHeight } };
    });
    const result = await render(
      workspace,
      stopNameRequest('一一一一', { output: { width: 20, height: 73, dpi: 254, format: 'png' } }),
    );
    const pixels = await decodePixels(result.image!.bytes);
    const centerX = Math.round(pixels.width / 2);
    return {
      text: stopName(result).text!,
      red: runsInColumn(pixels, centerX, isRed).map((run) => run.length),
      black: runsInColumn(pixels, centerX, isBlack).map((run) => run.length),
    };
  }

  it('竖排压缩后描边宽度不变，字形本身按比例变矮', async () => {
    const normal = await strokedOneBars(40);
    const compressed = await strokedOneBars(26);

    expect(normal.text.compression).toBe(1);
    expect(compressed.text.compression).toBe(0.65);
    // "一"的横笔上下各有一段描边：共 4 个字 8 段，每段约 8 像素，压缩前后一致。
    expect(normal.red).toHaveLength(8);
    expect(compressed.red).toHaveLength(8);
    for (const length of [...normal.red, ...compressed.red]) {
      expect(length).toBeGreaterThanOrEqual(6);
      expect(length).toBeLessThanOrEqual(9);
    }
    expect(Math.max(...compressed.red) - Math.min(...normal.red)).toBeLessThanOrEqual(2);
    // 横笔本身变矮：压缩后的黑色段明显短于压缩前。
    expect(Math.max(...compressed.black)).toBeLessThan(Math.min(...normal.black));
  });

  it('横排文字同样描边，描边画在填充之下', async () => {
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0] = {
        type: 'text',
        name: '线路号',
        content: [{ slot: 'name' }],
        font: 'res:font-hei-heavy',
        fontSize: 10,
        color: '#000000',
        stroke: { color: RED, width: 0.8 },
        horizontalAlign: 'center',
        verticalAlign: 'center',
        place: { left: 0, top: 0, width: { fixed: 20 }, height: { fixed: 73 } },
      };
    });
    const result = await render(workspace, stopNameRequest('一', { output: { width: 20, height: 73, dpi: 254, format: 'png' } }));
    const pixels = await decodePixels(result.image!.bytes);
    const centerX = Math.round(pixels.width / 2);
    const red = runsInColumn(pixels, centerX, isRed).map((run) => run.length);

    expect(result.problems).toEqual([]);
    expect(red).toHaveLength(2);
    for (const length of red) {
      expect(length).toBeGreaterThanOrEqual(6);
      expect(length).toBeLessThanOrEqual(9);
    }
    // 横笔中央仍是填充色，说明描边没有盖住字形。
    const blackRun = runsInColumn(pixels, centerX, isBlack)[0]!;
    expect(isBlack(pixelAt(pixels, centerX, blackRun.start + Math.floor(blackRun.length / 2)))).toBe(true);
  });
});

describe('竖排固定字间距 letterSpacing 与 tightenSpacing（M243）', () => {
  async function renderVertical(
    textProps: Record<string, unknown>,
    boxHeight = 73,
    dpi = 254,
  ): Promise<RenderResult> {
    const workspace = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0] = {
        ...document['artboard']['children'][0],
        verticalAlign: 'top',
        place: { left: 0, top: 0, width: { fixed: 20 }, height: { fixed: boxHeight } },
        ...textProps,
      };
    });
    return render(workspace, stopNameRequest('一一一一', { output: { width: 20, height: 73, dpi, format: 'png' } }));
  }

  it('非分布竖排正负 letterSpacing 跨片段计算自然高度、字形位置与 spacing；单字与空文本不加，下限为 0；两端分布忽略 letterSpacing', async () => {
    const pos = await renderVertical({
      content: [{ text: '一一', color: '#000000' }, { text: '一一', color: '#000000' }],
      letterSpacing: 2,
      fit: undefined,
      place: { left: 0, top: 0, width: { fixed: 20 }, height: 'hug' },
    });
    expect(pos.problems).toEqual([]);
    expect(stopName(pos).height).toBe(46);
    expect(stopName(pos).text).toMatchObject({ height: 46, spacing: 2, compression: 1, overflow: false });
    const posPixels = await decodePixels(pos.image!.bytes);
    const basePixels = await decodePixels((await renderVertical({ fit: undefined })).image!.bytes);
    const posRuns = runsInColumn(posPixels, 100, (p) => !isWhite(p));
    const baseRuns = runsInColumn(basePixels, 100, (p) => !isWhite(p));
    expect(posRuns).toHaveLength(4);
    for (let k = 0; k < 4; k++) {
      expect(Math.abs((posRuns[k]!.start - baseRuns[k]!.start) - k * 20)).toBeLessThanOrEqual(1);
    }

    const neg = await renderVertical({
      letterSpacing: -1.5,
      fit: undefined,
      place: { left: 0, top: 0, width: { fixed: 20 }, height: 'hug' },
    });
    expect(neg.problems).toEqual([]);
    expect(stopName(neg).height).toBe(35.5);
    expect(stopName(neg).text).toMatchObject({ height: 35.5, spacing: -1.5, compression: 1, overflow: false });

    const single = await renderVertical({
      content: [{ text: '一' }],
      letterSpacing: 4,
      fit: undefined,
      place: { left: 0, top: 0, width: { fixed: 20 }, height: 'hug' },
    });
    expect(stopName(single).height).toBe(10);
    expect(stopName(single).text).toMatchObject({ height: 10, spacing: 0 });

    const empty = await renderVertical({
      content: [],
      letterSpacing: 4,
      fit: undefined,
      place: { left: 0, top: 0, width: { fixed: 20 }, height: 'hug' },
    });
    expect(stopName(empty).height).toBe(0);
    expect(stopName(empty).text).toMatchObject({ height: 0, spacing: 0 });

    const clamped = await renderVertical({
      content: [{ text: '一一' }],
      letterSpacing: -25,
      fit: undefined,
      place: { left: 0, top: 0, width: { fixed: 20 }, height: 'hug' },
    });
    expect(stopName(clamped).height).toBe(0);
    expect(stopName(clamped).text).toMatchObject({ height: 0, spacing: -25, overflow: false });

    const distributed = await renderVertical({ verticalAlign: 'distribute', letterSpacing: 5 }, 73, 120);
    const distributedZero = await renderVertical({ verticalAlign: 'distribute', letterSpacing: 0 }, 73, 120);
    expect(stopName(distributed).text).toEqual(stopName(distributedZero).text);
  });

  it.each([
    [49, 3, 1, 49, false],
    [43, 1, 1, 43, false],
    [40, 0, 1, 40, false],
    [30, 0, 0.75, 30, false],
    [20, 0, 0.6, 24, true],
  ])('非分布竖排 tightenSpacing（可用高 %d mm）：先收紧字距到 %d mm，再压到 %d', async (boxHeight, spacing, compression, extent, overflow) => {
    const result = await renderVertical(
      { letterSpacing: 3, fit: { steps: ['tightenSpacing', 'compressGlyphs'] } },
      boxHeight,
    );
    expect(stopName(result).text).toMatchObject({ spacing, compression, height: extent, overflow });
    expect(result.problems.map((p) => p.code)).toEqual(overflow ? [ProblemCodes.layoutTextOverflow] : []);
  });

  it('非分布竖排仅配置 tightenSpacing 时收紧到 0 即止，不压缩字形', async () => {
    const fitTightenOnly = await renderVertical({ letterSpacing: 3, fit: { steps: ['tightenSpacing'] } }, 43);
    expect(stopName(fitTightenOnly).text).toMatchObject({ spacing: 1, compression: 1, height: 43, overflow: false });

    const overflowTightenOnly = await renderVertical({ letterSpacing: 3, fit: { steps: ['tightenSpacing'] } }, 35);
    expect(stopName(overflowTightenOnly).text).toMatchObject({ spacing: 0, compression: 1, height: 40, overflow: true });
    expect(overflowTightenOnly.problems.map((p) => p.code)).toEqual([ProblemCodes.layoutTextOverflow]);
  });
});
