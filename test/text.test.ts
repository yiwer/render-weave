import { describe, expect, it } from 'vitest';
import { ProblemCodes, render, type LayoutNode, type RenderResult, type TextSummary } from '../src/index.js';
import { loadM402Lab, m402LabRequest, textLab, textLabRequest } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { boundsIn, decodePixels, type Pixels } from './support/pixels.js';

/** 254 DPI 下 1 mm 为 10 像素。 */
const DPI = 254;
const MEDIUM = 'res:font-hei-medium';
const HEAVY = 'res:font-hei-heavy';
const TAN_12 = Math.tan((12 * Math.PI) / 180);

const FIELDS = [
  { name: 'label', displayName: '标签', type: 'text' },
  { name: 'fare', displayName: '票价', type: 'number' },
  { name: 'first', displayName: '首班', type: 'time' },
  { name: 'day', displayName: '日期', type: 'date' },
  { name: 'updatedAt', displayName: '更新时间', type: 'datetime' },
  { name: 'accessible', displayName: '无障碍', type: 'boolean' },
  { name: 'logo', displayName: '标志', type: 'image' },
  { name: 'times', displayName: '班次', type: 'list', items: { type: 'time' } },
  { name: 'stop', displayName: '站点', type: 'ref', ref: { name: '站点实验', version: 1 } },
];

const text = (name: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'text',
  name,
  content,
  font: MEDIUM,
  fontSize: 5,
  ...extra,
});

/** 一列文本元素，每个占一行。 */
const column = (children: unknown[]) => ({ fill: '#FFFFFF', layout: { mode: 'stack', direction: 'column', gap: 1 }, children });

function node(result: RenderResult, name: string): LayoutNode {
  const find = (current: LayoutNode): LayoutNode | undefined =>
    current.name === name ? current : current.children?.map(find).find((found) => found !== undefined);
  return find(result.layout!.root)!;
}

const summary = (result: RenderResult, name: string): TextSummary => node(result, name).text!;
const contentOf = (result: RenderResult, name: string) => summary(result, name).content;

const isInk = ([r, g, b]: [number, number, number, number]) => r + g + b < 600;
const near = ([r, g, b]: [number, number, number, number], [er, eg, eb]: [number, number, number], tolerance = 30) =>
  Math.abs(r - er) <= tolerance && Math.abs(g - eg) <= tolerance && Math.abs(b - eb) <= tolerance;

/** 一个毫米矩形内满足条件的像素数。 */
function countIn(pixels: Pixels, mm: { x: number; y: number; width: number; height: number }, match: (rgba: [number, number, number, number]) => boolean) {
  const scale = DPI / 25.4;
  let count = 0;
  for (let y = Math.round(mm.y * scale); y < Math.round((mm.y + mm.height) * scale); y++) {
    for (let x = Math.round(mm.x * scale); x < Math.round((mm.x + mm.width) * scale); x++) {
      const i = (y * pixels.width + x) * 4;
      if (match([pixels.data[i]!, pixels.data[i + 1]!, pixels.data[i + 2]!, pixels.data[i + 3]!])) count++;
    }
  }
  return count;
}

describe('文字片段', () => {
  it('片段可单独设颜色、字号与字体，未设的沿用文本元素的设置', async () => {
    const workspace = await textLab(FIELDS, {
      fill: '#FFFFFF',
      children: [
        text(
          '票价',
          [
            { text: '票价：', color: '#333333' },
            { slot: 'label', color: '#FF6A00' },
            { slot: 'fare', format: '0.##', color: '#FF6A00', font: HEAVY, fontSize: 10 },
            { text: '元' },
          ],
          { fontSize: 8, color: '#0000FF', place: { left: 2, top: 2, width: 'hug', height: 'hug' } },
        ),
      ],
    });
    const result = await render(workspace, textLabRequest({ label: '一票制', fare: 2 }, 80, 16, DPI));
    const pixels = await decodePixels(result.image!.bytes);
    const fare = summary(result, '票价');

    expect(result.problems).toEqual([]);
    expect(fare.content).toBe('票价：一票制2元');
    expect(fare.fragments).toEqual([
      { text: '票价：', font: MEDIUM, fontSize: 8, color: '#333333FF', slant: 0 },
      { text: '一票制', font: MEDIUM, fontSize: 8, color: '#FF6A00FF', slant: 0 },
      { text: '2', font: HEAVY, fontSize: 10, color: '#FF6A00FF', slant: 0 },
      { text: '元', font: MEDIUM, fontSize: 8, color: '#0000FFFF', slant: 0 },
    ]);
    // 汉字与全角冒号的前进宽度都是 1 em：前 3 个字在 2–26 mm，后 3 个字在 26–50 mm。
    const band = (x: number, width: number) => ({ x, y: 2, width, height: 10 });
    expect(countIn(pixels, band(2, 24), (p) => near(p, [0x33, 0x33, 0x33], 40))).toBeGreaterThan(500);
    expect(countIn(pixels, band(2, 24), (p) => near(p, [0xff, 0x6a, 0x00]))).toBe(0);
    expect(countIn(pixels, band(26, 24), (p) => near(p, [0xff, 0x6a, 0x00]))).toBeGreaterThan(500);
    expect(countIn(pixels, band(26, 24), (p) => near(p, [0x33, 0x33, 0x33], 40))).toBe(0);
    // 行高取最大的片段（10 mm），"元"沿用元素的蓝色。
    expect(fare.height).toBe(10);
    expect(countIn(pixels, band(50, 30), (p) => near(p, [0, 0, 255], 60))).toBeGreaterThan(300);
  });

  it('同一行中字号不同的片段按基线对齐，宽为前进宽度之和', async () => {
    const workspace = await textLab(FIELDS, {
      fill: '#FFFFFF',
      children: [
        text('混排', [{ text: 'H', fontSize: 10 }, { text: 'H', fontSize: 20 }], { place: { left: 2, top: 2, width: 'hug', height: 'hug' } }),
      ],
    });
    const result = await render(workspace, textLabRequest({}, 40, 24, DPI));
    const pixels = await decodePixels(result.image!.bytes);
    const mixed = summary(result, '混排');
    // 前进宽度与字号成正比：小 H 占总宽的三分之一。
    const split = Math.round((2 + mixed.width / 3) * 10);
    const small = boundsIn(pixels, { left: 0, top: 0, right: split, bottom: pixels.height }, isInk)!;
    const large = boundsIn(pixels, { left: split, top: 0, right: pixels.width, bottom: pixels.height }, isInk)!;

    expect(mixed.height).toBe(20);
    expect(Math.abs(small.bottom - large.bottom)).toBeLessThanOrEqual(1);
    // 大 H 的墨迹高约为小 H 的两倍。
    expect((large.bottom - large.top) / (small.bottom - small.top)).toBeCloseTo(2, 1);
  });

  it('插槽绑定的字段缺值时结果为空，不回退到占位内容', async () => {
    const workspace = await textLab(FIELDS, column([text('票价', [{ text: '票价：' }, { slot: 'fare', format: '0.##' }, { text: '元' }])]));
    const result = await render(workspace, textLabRequest({}, 60, 10, 72));

    expect(result.problems).toEqual([]);
    expect(summary(result, '票价').fragments.map((fragment) => fragment.text)).toEqual(['票价：', '', '元']);
  });

  it('竖排文字的片段可单独设颜色', async () => {
    const workspace = await textLab(FIELDS, {
      fill: '#FFFFFF',
      children: [
        text('站名', [{ text: '东', color: '#E60012' }, { text: '门', color: '#333333' }], {
          fontSize: 10,
          writingMode: 'vertical',
          place: { left: 0, top: 0, width: { fixed: 10 }, height: { fixed: 20 } },
        }),
      ],
    });
    const result = await render(workspace, textLabRequest({}, 10, 20, DPI));
    const pixels = await decodePixels(result.image!.bytes);
    const top = { x: 0, y: 0, width: 10, height: 10 };
    const bottom = { x: 0, y: 10, width: 10, height: 10 };

    expect(result.problems).toEqual([]);
    expect(countIn(pixels, top, (p) => near(p, [0xe6, 0x00, 0x12], 40))).toBeGreaterThan(500);
    expect(countIn(pixels, top, (p) => near(p, [0x33, 0x33, 0x33], 40))).toBe(0);
    expect(countIn(pixels, bottom, (p) => near(p, [0x33, 0x33, 0x33], 40))).toBeGreaterThan(500);
    expect(countIn(pixels, bottom, (p) => near(p, [0xe6, 0x00, 0x12], 40))).toBe(0);
  });
});

describe('展示格式', () => {
  const formatted = async (data: Record<string, unknown>, slots: { slot: string; format?: string }[]) => {
    const workspace = await textLab(FIELDS, column(slots.map((slot, index) => text(`格式${index + 1}`, [slot]))));
    const result = await render(workspace, textLabRequest(data, 80, 120, 72));
    expect(result.problems).toEqual([]);
    return slots.map((_, index) => contentOf(result, `格式${index + 1}`));
  };

  it('时刻、日期与时间按模式输出；未给格式时按数据集中的写法', async () => {
    const data = { first: '07:30:15', day: '2026-01-02', updatedAt: '2025-01-02 09:08:12' };
    const shortFirst = { first: '07:30' };

    expect(
      await formatted(data, [
        { slot: 'first', format: 'HH:mm' },
        { slot: 'first', format: 'H:mm' },
        { slot: 'first' },
        { slot: 'day', format: 'yyyy年M月d日' },
        { slot: 'day', format: 'MM/dd' },
        { slot: 'day' },
        { slot: 'updatedAt', format: 'M月d日 HH:mm' },
        { slot: 'updatedAt', format: 'HH:mm:ss' },
        { slot: 'updatedAt' },
      ]),
    ).toEqual(['07:30', '7:30', '07:30:15', '2026年1月2日', '01/02', '2026-01-02', '1月2日 09:08', '09:08:12', '2025-01-02 09:08:12']);
    expect(await formatted(shortFirst, [{ slot: 'first', format: 'HH:mm:ss' }])).toEqual(['07:30:00']);
  });

  it.each([
    [2.1, '0.##', '2.1'],
    [2, '0.##', '2'],
    [2.5, '0', '3'],
    [2.005, '0.00', '2.01'],
    [0.125, '0.##', '0.13'],
    [1234.5, '0.00', '1234.50'],
    [0.5, '00.0', '00.5'],
    [9.995, '#0.00', '10.00'],
    [-2.5, '0', '-3'],
    [-0.001, '0.##', '0'],
    [2.1, undefined, '2.1'],
    [1.5e-7, undefined, '0.00000015'],
    [1e21, undefined, '1000000000000000000000'],
  ])('数值 %s 按 %s 输出为 %s（十进制四舍五入，没有浮点误差）', async (fare, format, expected) => {
    expect(await formatted({ fare }, [{ slot: 'fare', ...(format && { format }) }])).toEqual([expected]);
  });

  it('插槽可以经过单引用取字段', async () => {
    expect(await formatted({ stop: { name: '东门' } }, [{ slot: 'stop.name' }])).toEqual(['东门']);
  });
});

describe('插槽与展示格式的检查', () => {
  it('引用的字段不存在、路径经过列表或文本、取值不能显示为文字、展示格式与类型不符时报问题，定位到元素', async () => {
    const cases: [string, unknown, string, string][] = [
      ['未知字段', { slot: 'farePrice' }, ProblemCodes.templateUnknownVariable, '插槽 farePrice：变量 farePrice 不存在：既不是数据字段，也不是参数或派生变量'],
      ['未知子字段', { slot: 'stop.road' }, ProblemCodes.templateUnknownVariable, '插槽 stop.road：stop 中没有字段 road'],
      ['经过列表', { slot: 'times.value' }, ProblemCodes.templateInvalidPath, '插槽 times.value：times 的类型是列表[时刻]，路径只能经过单引用'],
      ['经过文本', { slot: 'label.length' }, ProblemCodes.templateInvalidPath, '插槽 label.length：label 的类型是文本，路径只能经过单引用'],
      ['图片', { slot: 'logo' }, ProblemCodes.templateTypeMismatch, '插槽 logo 的类型是图片，不能显示为文字'],
      ['引用', { slot: 'stop' }, ProblemCodes.templateTypeMismatch, '插槽 stop 的类型是数据定义引用（站点实验 v1），不能显示为文字'],
      [
        '布尔',
        { slot: 'accessible' },
        ProblemCodes.templateTypeMismatch,
        '插槽 accessible 的类型是布尔，不能显示为文字，按真假显示不同文字请用条件显示或状态样式',
      ],
      ['时刻格式用于数值', { slot: 'fare', format: 'HH:mm' }, ProblemCodes.templateTypeMismatch, '插槽 fare：展示格式"HH:mm"含时分秒，只能用于时刻或时间，不能用于数值'],
      ['数值格式用于时刻', { slot: 'first', format: '0.##' }, ProblemCodes.templateTypeMismatch, '插槽 first：数值格式"0.##"不能用于时刻'],
      ['日期格式用于时刻', { slot: 'first', format: 'M月d日' }, ProblemCodes.templateTypeMismatch, '插槽 first：展示格式"M月d日"含年月日，只能用于日期或时间，不能用于时刻'],
      ['格式用于文本', { slot: 'label', format: 'HH:mm' }, ProblemCodes.templateTypeMismatch, '插槽 label：文本类型不带展示格式"HH:mm"'],
    ];
    const workspace = await textLab(FIELDS, column(cases.map(([name, slot]) => text(name, [{ text: '前' }, slot]))));
    const result = await render(workspace, textLabRequest({ label: '甲', fare: 2, first: '07:30', stop: { name: '东门' } }, 80, 120, 72));

    expect(result.problems.map((p) => [p.code, p.location, p.message])).toEqual(
      cases.map(([name, , code, message]) => [code, { kind: 'element', path: `文字实验/${name}` }, message]),
    );
    // 没有通过检查的插槽求值为空，文字片段照常输出；正式出图不输出图片。
    expect(contentOf(result, '未知字段')).toBe('前');
    expect(result.image).toBeUndefined();
  });

  it('展示格式写法不对时模板检查报问题', async () => {
    const workspace = await textLab(FIELDS, column([text('时刻', [{ slot: 'first', format: 'hh:mm' }]), text('数值', [{ slot: 'fare', format: '0.#0' }])]));
    const result = await render(workspace, textLabRequest({}, 80, 40, 72));

    expect(result.problems.map((p) => [p.code, p.location, p.message])).toEqual([
      [
        ProblemCodes.templateInvalid,
        { kind: 'element', path: '文字实验/时刻' },
        '插槽 first：展示格式"hh:mm"中的 hh 不是可用的格式符：日期用 yyyy、MM、M、dd、d，时刻用 HH、H、mm、ss，数值用 0 与 #',
      ],
      [
        ProblemCodes.templateInvalid,
        { kind: 'element', path: '文字实验/数值' },
        '插槽 fare：数值格式"0.#0"写法不对：整数部分写若干个 0（前面可加 #），小数部分写若干个 0 再接若干个 #，如 0、0.##、0.00',
      ],
      [ProblemCodes.renderExpansionBlocked, { kind: 'input', source: 'render' }, '输入无法展开，草稿预览与正式出图均停止；具体原因见上述问题'],
    ]);
  });

  it('字重由字体资源决定：写 fontWeight 时说明该怎么写', async () => {
    const workspace = await textLab(FIELDS, column([text('标题', [{ text: '开往', fontWeight: 700 }])]));
    const result = await render(workspace, textLabRequest({}, 80, 40, 72));

    expect(result.problems.map((p) => [p.code, p.message])).toEqual([
      [ProblemCodes.templateInvalid, '字重由字体资源决定，不写 fontWeight：改用对应字重的字体资源，如 font 写 res:font-hei-heavy（M115）'],
      [ProblemCodes.renderExpansionBlocked, '输入无法展开，草稿预览与正式出图均停止；具体原因见上述问题'],
    ]);
  });

  it('竖排文字的片段只能单独设颜色，竖排不能倾斜', async () => {
    const vertical = { writingMode: 'vertical', place: { left: 0, top: 0, width: { fixed: 10 }, height: { fixed: 30 } } };
    const workspace = await textLab(FIELDS, {
      children: [
        text('站名', [{ text: '东门', fontSize: 8 }], vertical),
        text('倾斜站名', [{ text: '东门' }], { ...vertical, name: '倾斜站名', slant: 12 }),
      ],
    });
    const result = await render(workspace, textLabRequest({}, 30, 30, 72));

    expect(result.problems.map((p) => [p.code, p.location.kind === 'element' && p.location.path, p.message])).toEqual([
      [ProblemCodes.templateUnsupported, '文字实验/站名', '竖排文字的片段暂只能单独设颜色 color'],
      [ProblemCodes.templateUnsupported, '文字实验/倾斜站名', '竖排文字的倾斜 slant 尚未支持'],
      [ProblemCodes.renderExpansionBlocked, false, '输入无法展开，草稿预览与正式出图均停止；具体原因见上述问题'],
    ]);
  });
});

describe('倾斜', () => {
  const slanted = async (slant: number) => {
    const workspace = await textLab(FIELDS, {
      fill: '#FFFFFF',
      children: [text('线路号', [{ text: 'H' }], { fontSize: 20, slant, place: { left: 5, top: 2, width: 'hug', height: 'hug' } })],
    });
    const result = await render(workspace, textLabRequest({}, 40, 24, DPI));
    return { result, pixels: await decodePixels(result.image!.bytes), node: node(result, '线路号') };
  };

  /** 墨迹在上、下两条横带中的最左像素列。 */
  const leftEdges = (pixels: Pixels, ink: { top: number; bottom: number }) => {
    const band = (top: number) => boundsIn(pixels, { left: 0, top, right: pixels.width, bottom: top + 10 }, isInk)!.left;
    return { top: band(ink.top + 5), bottom: band(ink.bottom - 15) };
  };

  it('以错切变换模拟，正角度向右倾；宽包含倾斜带来的外扩，墨迹不出元素框', async () => {
    const upright = await slanted(0);
    const right = await slanted(12);
    const ink = boundsIn(right.pixels, { left: 0, top: 0, right: right.pixels.width, bottom: right.pixels.height }, isInk)!;
    const edges = leftEdges(right.pixels, ink);
    const rise = (ink.bottom - 15 - (ink.top + 5)) / 10;

    expect(right.result.problems).toEqual([]);
    // 行框高 20 mm（思源黑体为 1 em），向右倾 12° 外扩 20 × tan 12° ≈ 4.251 mm。
    expect(right.node.width).toBeCloseTo(upright.node.width + 20 * TAN_12, 2);
    expect(right.node.text).toMatchObject({ width: right.node.width, height: 20, fragments: [{ slant: 12 }] });
    // 上带的左边比下带靠右 rise × tan 12°。
    expect((edges.top - edges.bottom) / 10).toBeCloseTo(rise * TAN_12, 0);
    expect(edges.top - edges.bottom).toBeGreaterThan(20);
    // 墨迹在元素框内。
    expect(ink.left).toBeGreaterThanOrEqual(Math.floor(right.node.x * 10));
    expect(ink.right).toBeLessThan(Math.ceil((right.node.x + right.node.width) * 10));
  });

  it('负角度向左倾', async () => {
    const left = await slanted(-12);
    const ink = boundsIn(left.pixels, { left: 0, top: 0, right: left.pixels.width, bottom: left.pixels.height }, isInk)!;
    const edges = leftEdges(left.pixels, ink);

    expect(edges.bottom - edges.top).toBeGreaterThan(20);
    expect(ink.left).toBeGreaterThanOrEqual(Math.floor(left.node.x * 10));
    expect(ink.right).toBeLessThan(Math.ceil((left.node.x + left.node.width) * 10));
  });

  it('多片段混排、倾斜与描边的 golden 图片', async () => {
    const workspace = await textLab(FIELDS, {
      fill: '#FFF4E0',
      layout: { mode: 'stack', direction: 'column', gap: 3 },
      padding: 3,
      children: [
        text(
          '混排',
          [
            { text: '票价：', color: '#333333' },
            { slot: 'label', color: '#FF6A00' },
            { slot: 'fare', format: '0.##', color: '#FF6A00', fontSize: 12, font: HEAVY },
            { text: '元', color: '#FF6A00' },
          ],
          { fontSize: 8 },
        ),
        text('倾斜描边', [{ text: 'M' }, { text: '402', color: '#1E5BB8', slant: -8 }, { text: '路', fontSize: 10, slant: 0 }], {
          font: HEAVY,
          fontSize: 16,
          color: '#E60012',
          slant: 12,
          stroke: { color: '#FFFFFF', width: 0.8 },
        }),
      ],
    });
    const result = await render(workspace, textLabRequest({ label: '一票制', fare: 2.5 }, 80, 40, 120));

    expect(result.problems).toEqual([]);
    await expectMatchesGolden('text-fragments', result.image!.bytes);
  });
});

describe('M402 演示：票价、服务时间、运营说明与线路号文字', () => {
  it('各自直接绑定数据字段，按设计稿的样式显示', async () => {
    const workspace = await loadM402Lab({
      layout: { mode: 'stack', direction: 'column' },
      children: [
        {
          type: 'container',
          name: '顶栏',
          fill: '#FF8000',
          padding: { left: 6, right: 6 },
          layout: { mode: 'stack', direction: 'row', gap: 8, alignItems: 'center' },
          place: { width: 'fill', height: { fixed: 30 } },
          children: [
            {
              type: 'text',
              name: '线路号',
              content: [{ slot: 'routeNo' }],
              font: HEAVY,
              fontSize: 24,
              color: '#E60012',
              slant: 12,
              stroke: { color: '#FFFFFF', width: 0.8 },
            },
            {
              type: 'container',
              name: '票价框',
              fill: '#FFFFFF',
              cornerRadius: 5.5,
              padding: { top: 1.5, bottom: 1.5, left: 6, right: 12 },
              layout: { mode: 'stack', direction: 'row', alignItems: 'center' },
              place: { width: { fixed: 120 }, height: { fixed: 16 } },
              children: [
                {
                  type: 'text',
                  name: '票价',
                  content: [
                    { text: '票价：', color: '#333333' },
                    { slot: 'fareType', color: '#FF6A00' },
                    { slot: 'fare', format: '0.##', color: '#FF6A00' },
                    { text: '元', color: '#FF6A00' },
                  ],
                  font: MEDIUM,
                  fontSize: 8,
                  place: { width: 'fill', height: 'hug' },
                },
              ],
            },
          ],
        },
        {
          type: 'container',
          name: '服务时间内容',
          fill: '#FFEF00',
          padding: { left: 3 },
          layout: { mode: 'stack', direction: 'row', gap: 4, alignItems: 'center' },
          place: { width: 'fill', height: { fixed: 21 } },
          children: [
            {
              type: 'text',
              name: '服务时间',
              content: [
                { text: '始发站服务时间：' },
                { slot: 'firstDeparture', format: 'HH:mm' },
                { text: '-' },
                { slot: 'lastDeparture', format: 'HH:mm' },
              ],
              font: MEDIUM,
              fontSize: 10,
              color: '#222222',
            },
            {
              type: 'text',
              name: '运营说明',
              content: [{ text: '（' }, { slot: 'serviceNote' }, { text: '）「' }, { slot: 'scheduleType' }, { text: '」' }],
              font: MEDIUM,
              fontSize: 5.5,
              color: '#222222',
            },
          ],
        },
      ],
    });
    const result = await render(workspace, m402LabRequest(260, 51));
    const routeNo = node(result, '线路号');

    expect(result.problems).toEqual([]);
    expect(contentOf(result, '票价')).toBe('票价：一票制2元');
    expect(summary(result, '票价').fragments.map((fragment) => fragment.color)).toEqual(['#333333FF', '#FF6A00FF', '#FF6A00FF', '#FF6A00FF']);
    expect(contentOf(result, '服务时间')).toBe('始发站服务时间：07:30-22:30');
    expect(contentOf(result, '运营说明')).toBe('（工作日运营）「定时班车」');
    expect(routeNo.text).toMatchObject({ content: 'M402', fontSize: 24, height: 24, fragments: [{ slant: 12 }] });
    await expectMatchesGolden('m402-text-fragments', result.image!.bytes);
  });
});
