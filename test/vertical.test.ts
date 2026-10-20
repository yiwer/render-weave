import { describe, expect, it } from 'vitest';
import { ProblemCodes, render, type LayoutNode, type RenderResult } from '../src/index.js';
import { loadStopName, stopNameRequest, textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { boundsIn, decodePixels, inkRows, pixelAt, runsInColumn } from './support/pixels.js';

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

describe('竖排固定字间距 letterSpacing 与 tightenSpacing（M255）', () => {
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

describe('竖排片段独立字体字号与方向性标点旋转（M256）', () => {
  const isInk = ([r, g, b]: [number, number, number, number]) => r + g + b < 700;

  it('主站名 10 mm 粗体 + （北门） 7 mm 常规体在同一竖排文本元素内两端分布、括号顺时针旋转 90°、并参与缩字组', async () => {
    const mixedContent = (main: string, sub = '（北门）') => [
      { text: main, font: 'res:font-hei-bold', fontSize: 10, color: '#1F2328' },
      { text: sub, font: 'res:font-hei-regular', fontSize: 7, color: '#57606A' },
    ];

    const singleWs = withTemplate(await loadStopName(), '竖排站名', (document) => {
      document['artboard']['children'][0] = {
        ...document['artboard']['children'][0],
        font: 'res:font-hei-bold',
        fontSize: 10,
        content: mixedContent('田贝'),
      };
    });
    const single = await render(singleWs, stopNameRequest('田贝'));
    expect(single.problems).toEqual([]);
    expect(stopName(single).text).toMatchObject({
      content: '田贝（北门）',
      writingMode: 'vertical',
      fontSize: 10,
      width: 10,
      height: 73,
      compression: 1,
      overflow: false,
      fragments: [
        { text: '田贝', font: 'res:font-hei-bold', fontSize: 10, color: '#1F2328FF', slant: 0 },
        { text: '（北门）', font: 'res:font-hei-regular', fontSize: 7, color: '#57606AFF', slant: 0 },
      ],
    });
    // 6 个字格总高 10×2 + 7×4 = 48 mm（小于 6 个 10 mm 字格的 60 mm），首字“田”贴顶、末字旋转后的“）”贴底。
    expect(stopName(single).text!.spacing).toBeGreaterThan(5);
    const singlePixels = await decodePixels(single.image!.bytes);
    expect(inkRows(singlePixels, isWhite)).toEqual({ top: 0, bottom: 344 });

    // 末字“）”顺时针旋转 90° 后为向上开口的弧“︶”，位于底部区域，其墨迹宽大于高的 2 倍。
    const closeBracketInk = boundsIn(
      singlePixels,
      { left: 0, top: 332, right: singlePixels.width, bottom: singlePixels.height },
      isInk,
    )!;
    expect(closeBracketInk.right - closeBracketInk.left).toBeGreaterThan((closeBracketInk.bottom - closeBracketInk.top) * 2);

    // 多列看板：第 1 列正常 10/7 mm、第 2 列长主站名 + 副站名纵向压缩、第 3–4 列因 8 mm 窄列触发缩字组按比例缩为 8/5.6 mm。
    const boardWs = await textLab([], {
      fill: '#FFFFFF',
      padding: 2,
      layout: { mode: 'grid', columns: [{ fixed: 14 }, { fixed: 14 }, { fixed: 14 }, { fixed: 8 }], rows: [{ fraction: 1 }], columnGap: 2 },
      children: [
        {
          type: 'text',
          name: '常规主副站名',
          content: mixedContent('田贝'),
          font: 'res:font-hei-bold',
          fontSize: 10,
          writingMode: 'vertical',
          horizontalAlign: 'center',
          verticalAlign: 'distribute',
          fit: { steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.6 },
          place: { column: 1, row: 1, width: 'fill', height: 'fill' },
        },
        {
          type: 'text',
          name: '长主副站名压缩',
          content: mixedContent('李朗国际珠宝园'),
          font: 'res:font-hei-bold',
          fontSize: 10,
          writingMode: 'vertical',
          horizontalAlign: 'center',
          verticalAlign: 'distribute',
          fit: { steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.6 },
          place: { column: 2, row: 1, width: 'fill', height: 'fill' },
        },
        {
          type: 'text',
          name: '缩字组主副站名',
          content: mixedContent('翠竹'),
          font: 'res:font-hei-bold',
          fontSize: 10,
          writingMode: 'vertical',
          horizontalAlign: 'center',
          verticalAlign: 'distribute',
          fit: { steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.6, widthOverflow: { shrinkGroup: 'stopNames' } },
          place: { column: 3, row: 1, width: 'fill', height: 'fill' },
        },
        {
          type: 'text',
          name: '缩字组窄列',
          content: mixedContent('东门', '（南）'),
          font: 'res:font-hei-bold',
          fontSize: 10,
          writingMode: 'vertical',
          horizontalAlign: 'center',
          verticalAlign: 'distribute',
          fit: { steps: ['tightenSpacing', 'compressGlyphs'], compressMin: 0.6, widthOverflow: { shrinkGroup: 'stopNames' } },
          place: { column: 4, row: 1, width: 'fill', height: 'fill' },
        },
      ],
    });
    const board = await render(boardWs, textLabRequest({}, 60, 77, 120));
    expect(board.problems).toEqual([]);
    const cols = board.layout!.root.children!;
    expect(cols[0]!.text).toMatchObject({
      fontSize: 10,
      width: 10,
      height: 73,
      compression: 1,
      fragments: [{ fontSize: 10 }, { fontSize: 7 }],
    });
    // 7 个 10 mm 字 + 4 个 7 mm 字（总字格 98 mm < 11 个 10 mm 字的 110 mm），压缩比高于纯 10 mm 的 11 字站名。
    expect(cols[1]!.text).toMatchObject({
      fontSize: 10,
      width: 10,
      height: 73,
      spacing: 0,
      overflow: false,
      fragments: [{ fontSize: 10 }, { fontSize: 7 }],
    });
    expect(cols[1]!.text!.compression).toBeGreaterThan(0.75);
    expect(cols[1]!.text!.compression).toBeLessThan(0.85);
    expect(cols[2]!.text).toMatchObject({
      shrinkGroup: 'stopNames',
      fontSize: 8,
      width: 8,
      height: 73,
      compression: 1,
      fragments: [{ fontSize: 8 }, { fontSize: 5.6 }],
    });
    expect(cols[3]!.text).toMatchObject({
      shrinkGroup: 'stopNames',
      fontSize: 8,
      width: 8,
      height: 73,
      compression: 1,
      fragments: [{ fontSize: 8 }, { fontSize: 5.6 }],
    });
    await expectMatchesGolden('vertical-fragments-punctuation', board.image!.bytes);
  });

  it('常见方向性标点绕字格中心顺时针旋转 90° 绘制，首尾为括号时旋转后墨迹贴齐上下边界', async () => {
    const distributed = await render(await loadStopName(), stopNameRequest('（北门）'));
    expect(distributed.problems).toEqual([]);
    const distPixels = await decodePixels(distributed.image!.bytes);
    expect(inkRows(distPixels, isWhite)).toEqual({ top: 0, bottom: 344 });
    // 首字“（”顺时针旋转 90° 后为向下开口的“︵”：中轴顶部有墨迹，左右两端向下延伸更深。
    const centerX = Math.round(distPixels.width / 2);
    const centerTopRun = runsInColumn(distPixels, centerX, (p) => !isWhite(p))[0]!;
    const sideTopRun = runsInColumn(distPixels, centerX - 14, (p) => !isWhite(p))[0]!;
    expect(centerTopRun.start).toBeLessThanOrEqual(2);
    expect(sideTopRun.start + sideTopRun.length).toBeGreaterThanOrEqual(centerTopRun.start + centerTopRun.length + 2);

    // 旋转标点参与纵向压缩并带文字描边时，描边宽度不随压缩变形。
    const strokedRotated = withTemplate(await loadStopName(), '竖排站名', (document) => {
      const text = document['artboard']['children'][0];
      text['content'] = [
        { text: '——', fontSize: 10 },
        { text: '——', fontSize: 8 },
      ];
      text['verticalAlign'] = 'top';
      text['color'] = '#000000';
      text['stroke'] = { color: '#FF0000', width: 0.8 };
      text['place'] = { left: 0, top: 2, width: { fixed: 20 }, height: { fixed: 24 } };
    });
    const strokedRes = await render(strokedRotated, stopNameRequest('一', { output: { width: 20, height: 73, dpi: 254, format: 'png' } }));
    expect(strokedRes.problems).toEqual([]);
    expect(stopName(strokedRes).text!.compression).toBeCloseTo(24 / 36, 3);

    // 破折号“—”、省略号“…”、波浪号“～”旋转 90° 后变为竖向长条（墨迹高 > 墨迹宽 × 2）；各类括号旋转后宽 > 高。
    const punctWs = await textLab([], {
      fill: '#FFFFFF',
      layout: { mode: 'stack', direction: 'row', gap: 0 },
      children: ['—', '…', '～', '【', '《', '「', '〔'].map((ch, idx) => ({
        type: 'text',
        name: `标点${idx}`,
        content: [{ text: ch }],
        font: 'res:font-hei-regular',
        fontSize: 10,
        writingMode: 'vertical',
        verticalAlign: 'top',
        place: { width: { fixed: 10 }, height: { fixed: 10 } },
      })),
    });
    const punctResult = await render(punctWs, textLabRequest({}, 70, 10, 254));
    expect(punctResult.problems).toEqual([]);
    const punctPixels = await decodePixels(punctResult.image!.bytes);
    for (let idx = 0; idx < 3; idx++) {
      const box = boundsIn(punctPixels, { left: idx * 100, top: 0, right: (idx + 1) * 100, bottom: 100 }, isInk)!;
      expect(box.bottom - box.top).toBeGreaterThan((box.right - box.left) * 2);
    }
    for (let idx = 3; idx < 6; idx++) {
      const box = boundsIn(punctPixels, { left: idx * 100, top: 0, right: (idx + 1) * 100, bottom: 100 }, isInk)!;
      expect(box.right - box.left).toBeGreaterThan(box.bottom - box.top);
    }
  });
});
