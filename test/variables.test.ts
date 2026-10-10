import { describe, expect, it } from 'vitest';
import { ProblemCodes, loadWorkspace, render, type LayoutNode, type Problem, type RenderResult } from '../src/index.js';
import { m402Dir, resourcesDir, textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAtMm } from './support/pixels.js';

const MEDIUM = 'res:font-hei-medium';
const where = (problems: readonly Problem[]) => problems.map((p) => [p.code, p.location, p.message]);

function find(result: RenderResult, name: string): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode | undefined =>
    node.name === name ? node : node.children?.map(walk).find((found) => found !== undefined);
  const node = walk(result.layout!.root);
  if (!node) throw new Error(`布局摘要中没有 ${name}`);
  return node;
}

const contentOf = (result: RenderResult, name: string) => find(result, name).text?.content;

/** 去掉循环容器（票据 08）与按宽度统一缩字（票据 10）后的 M402 草稿模板，其余写法原样。 */
async function m402Draft() {
  const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  const strip = (node: Record<string, any>) => {
    if (node['fit']) delete node['fit']['widthOverflow'];
    if (Array.isArray(node['children'])) {
      node['children'] = node['children'].filter((child: Record<string, any>) => child['type'] !== 'loop');
      node['children'].forEach(strip);
    }
  };
  return withTemplate(withTemplate(workspace, '标准线路单边', (document) => strip(document['artboard'])), '站点', (document) =>
    strip(document['artboard']),
  );
}

function m402Request(parameters: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    template: '标准线路单边',
    dataset: { id: 'ds-m402-wanguocheng' },
    parameters,
    output: { width: 740, height: 165, dpi: 120, format: 'png' },
    mode: 'final',
    ...overrides,
  };
}

describe('M402 顶栏与底栏：草稿模板的参数、派生变量、检查项与条件显示', () => {
  it('本站序号为 5：开往万国城总站，下一站田贝及其地标，票价与服务时间', async () => {
    const result = await render(await m402Draft(), m402Request({ currentIndex: 5 }));

    expect(result.problems).toEqual([]);
    expect(contentOf(result, '终点站')).toBe('万国城总站');
    expect(contentOf(result, '下一站')).toBe('下一站：田贝');
    expect(find(result, '下一站地标')).toMatchObject({ visible: true, image: { source: 'res:landmark-2' } });
    expect(contentOf(result, '票价')).toBe('票价：一票制2元');
    expect(contentOf(result, '服务时间')).toBe('始发站服务时间：07:30-22:30');
    expect(contentOf(result, '运营说明')).toBe('（工作日运营）「定时班车」');
    // 有线路号图片时显示图片，线路号文字隐藏。
    expect(find(result, '线路号图片')).toMatchObject({ visible: true, image: { source: 'res:route-no-m402' } });
    expect(find(result, '线路号').visible).toBe(false);
    await expectMatchesGolden('m402-bars', result.image!.bytes);
  });

  it.each([
    [0, '未标本站'],
    [35, '本站是末站'],
  ])('本站序号为 %s（%s）时"下一站"整行隐藏', async (currentIndex) => {
    const result = await render(await m402Draft(), m402Request({ currentIndex }));

    expect(result.problems).toEqual([]);
    expect(find(result, '下一站区')).toMatchObject({ visible: false, width: 0 });
    expect(find(result, '服务时间箭头').x).toBe(0);
  });

  it('下一站没有地标时只隐藏地标', async () => {
    const result = await render(await m402Draft(), m402Request({ currentIndex: 1 }));

    expect(contentOf(result, '下一站')).toBe('下一站：建设路');
    expect(find(result, '下一站地标').visible).toBe(false);
  });

  it('本站序号超过站点数：检查项报严重问题，正式出图不输出图片', async () => {
    const result = await render(await m402Draft(), m402Request({ currentIndex: 36 }));

    expect(result.problems).toEqual([
      {
        code: ProblemCodes.checkFailed,
        level: 'severe',
        location: { kind: 'check', template: '标准线路单边', name: '本站序号不能超过站点数' },
        message: '本站序号超过了停靠站点数',
      },
    ]);
    expect(result.image).toBeUndefined();
    expect(find(result, '下一站区').visible).toBe(false);
  });

  it('没有线路号图片时显示倾斜描边的线路号文字', async () => {
    const workspace = await m402Draft();
    const m402 = workspace.datasets.find((dataset) => dataset.id === 'ds-m402-wanguocheng')!;
    const { routeNoImage: _image, ...data } = m402.document.data as Record<string, unknown>;
    const result = await render(workspace, m402Request({ currentIndex: 5 }, { dataset: { inline: { dataset: m402.document.dataset, data } } }));

    expect(result.problems).toEqual([]);
    expect(find(result, '线路号图片').visible).toBe(false);
    expect(find(result, '线路号')).toMatchObject({ visible: true, text: { content: 'M402', fragments: [{ slant: 12, color: '#E60012FF' }] } });
    await expectMatchesGolden('m402-route-no-text', result.image!.bytes);
  });

  it('对外参数：取值违反约束、类型不对、填写了内部参数或模板没有的参数都是严重问题', async () => {
    const workspace = await m402Draft();
    const tooLarge = await render(workspace, m402Request({ currentIndex: 51 }));
    const wrongType = await render(workspace, m402Request({ currentIndex: '5' }));
    const others = await render(workspace, m402Request({ currentIndex: 5, primaryColor: '#000000', title: '甲' }));

    expect(where(tooLarge.problems)).toEqual([
      [ProblemCodes.parameterInvalid, { kind: 'parameter', name: 'currentIndex' }, '对外参数"本站序号"（currentIndex）51 不能大于 50'],
      [ProblemCodes.checkFailed, { kind: 'check', template: '标准线路单边', name: '本站序号不能超过站点数' }, '本站序号超过了停靠站点数'],
    ]);
    // 类型不对的值不用，按缺省值 0 出图：下一站隐藏。
    expect(where(wrongType.problems)).toEqual([
      [ProblemCodes.parameterInvalid, { kind: 'parameter', name: 'currentIndex' }, '对外参数"本站序号"（currentIndex）必须是数值'],
    ]);
    expect(find(wrongType, '下一站区').visible).toBe(false);
    expect(where(others.problems)).toEqual([
      [
        ProblemCodes.parameterInternal,
        { kind: 'parameter', name: 'primaryColor' },
        '"主色"（primaryColor）是内部参数，只由模板设计者设定，调用方不能填写（M15）',
      ],
      [ProblemCodes.parameterUnknown, { kind: 'parameter', name: 'title' }, '模板"标准线路单边"没有对外参数 title'],
    ]);
  });
});

describe('M402 站点模板：状态样式与绑定', () => {
  const stopRequest = (parameters: Record<string, unknown>, data: Record<string, unknown> = { name: '东门', road: '东门路', landmark: 'res:landmark-3' }) => ({
    template: '站点',
    dataset: { inline: { dataset: { staticSchema: { name: '停靠站点', version: 1 } }, data } },
    parameters,
    output: { width: 20, height: 100, dpi: 120, format: 'png' },
    mode: 'final',
  });

  it.each([
    [0, '#333333FF'],
    [3, '#333333FF'],
    [5, '#E60012FF'],
    [7, '#C8C8C8FF'],
  ])('本站序号为 %s 时第 5 站的站名颜色为 %s', async (currentIndex, color) => {
    const result = await render(await m402Draft(), stopRequest({ index: 5, currentIndex, stopNameSize: 10 }));

    expect(result.problems).toEqual([]);
    expect(find(result, '站名').text).toMatchObject({ content: '东门', fontSize: 10, fragments: [{ color }] });
  });

  it('本站：名称区填充高亮底色；已过站：地标半透明', async () => {
    const workspace = await m402Draft();
    const current = await render(workspace, stopRequest({ index: 5, currentIndex: 5, stopNameSize: 10 }));
    const passed = await render(workspace, stopRequest({ index: 5, currentIndex: 7, stopNameSize: 10 }));
    const nameArea = find(current, '名称区');
    const landmark = find(passed, '地标');
    const at = (result: RenderResult, x: number, y: number) => decodePixels(result.image!.bytes).then((pixels) => pixelAtMm(pixels, x, y, 120));

    // 名称区左侧内边距里的一点：本站为黄色，已过站没有填充。
    expect((await at(current, nameArea.x + 0.5, nameArea.y + 20)).slice(0, 3)).toEqual([0xff, 0xf0, 0x00]);
    expect((await at(passed, nameArea.x + 0.5, nameArea.y + 20))[3]).toBe(0);
    // 地标中心（深灰的 ③）以 35% 的不透明度画出。
    const center = await at(passed, landmark.x + landmark.width / 2, landmark.y + landmark.height / 2);
    expect(center[3]).toBeGreaterThan(40);
    expect(center[3]).toBeLessThan(140);
  });

  it('字号绑定对外参数；没有地标时地标隐藏', async () => {
    const result = await render(await m402Draft(), stopRequest({ index: 2, currentIndex: 5, stopNameSize: 12 }, { name: '建设路', road: '建设路' }));

    expect(result.problems).toEqual([]);
    expect(find(result, '站名').text).toMatchObject({ content: '建设路', fontSize: 12, fragments: [{ color: '#C8C8C8FF' }] });
    expect(find(result, '地标').visible).toBe(false);
  });
});

const FIELDS = [
  { name: 'label', displayName: '标签', type: 'text' },
  { name: 'fare', displayName: '票价', type: 'number' },
  { name: 'first', displayName: '首班', type: 'time' },
  { name: 'logo', displayName: '标志', type: 'image', constraints: { allowedSources: ['resource'] } },
  { name: 'stops', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '站点实验', version: 1 } } },
  { name: 'tags', displayName: '标记', type: 'list', items: { type: 'text' } },
];

const text = (name: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ type: 'text', name, content, font: MEDIUM, fontSize: 4, ...extra });
const slot = (name: string, path: string) => text(name, [{ slot: path }]);
const column = (children: unknown[]) => ({ layout: { mode: 'stack', direction: 'column', gap: 1 }, children });
const derived = (name: string, type: string, operation: Record<string, unknown>, ref?: { name: string; version: number }) => ({
  name,
  displayName: name,
  type,
  ...(ref && { ref }),
  ...operation,
});
const STOP_REF = { name: '站点实验', version: 1 };

describe('派生变量', () => {
  const declarations = {
    parameters: [
      { name: 'current', displayName: '本站', visibility: 'public', type: 'number', constraints: { integer: true, min: 0 }, default: 0 },
    ],
    derived: [
      derived('count', 'number', { op: 'length', of: { var: 'stops' } }),
      derived('labelLength', 'number', { op: 'length', of: { var: 'label' } }),
      derived('tagCount', 'number', { op: 'length', of: { var: 'tags' } }),
      derived('firstStop', 'ref', { op: 'pickItem', list: { var: 'stops' }, position: 'first' }, STOP_REF),
      derived('lastStop', 'ref', { op: 'pickItem', list: { var: 'stops' }, position: 'last' }, STOP_REF),
      derived('nextIndex', 'number', { op: 'add', left: { var: 'current' }, right: { value: 1 } }),
      derived('nextStop', 'ref', { op: 'pickItem', list: { var: 'stops' }, position: { index: { var: 'nextIndex' } } }, STOP_REF),
      derived('sum', 'number', { op: 'add', left: { var: 'fare' }, right: { value: 0.2 } }),
      derived('diff', 'number', { op: 'subtract', left: { var: 'fare' }, right: { value: 0.3 } }),
      derived('state', 'text', {
        op: 'branch',
        branches: [
          { when: { left: { var: 'current' }, op: 'eq', right: { value: 0 } }, then: { value: '普通' } },
          { when: { left: { var: 'first' }, op: 'lt', right: { value: '08:00' } }, then: { value: '早班' } },
        ],
        otherwise: { value: '其他' },
      }),
      derived('sameTime', 'boolean', {
        op: 'branch',
        branches: [{ when: { left: { var: 'first' }, op: 'eq', right: { value: '07:30:00' } }, then: { value: true } }],
        otherwise: { value: false },
      }),
      derived('noLabel', 'boolean', {
        op: 'branch',
        branches: [{ when: { left: { var: 'label' }, op: 'empty' }, then: { value: true } }],
        otherwise: { value: false },
      }),
    ],
  };
  const artboard = column([
    slot('站数', 'count'),
    slot('标签字数', 'labelLength'),
    slot('标记数', 'tagCount'),
    slot('首站', 'firstStop.name'),
    slot('末站', 'lastStop.name'),
    slot('下一站', 'nextStop.name'),
    slot('加', 'sum'),
    slot('减', 'diff'),
    slot('状态', 'state'),
    text('同一时刻', [{ text: '不同' }], { states: { by: { var: 'sameTime' }, cases: { true: { content: [{ text: '相同' }] } } } }),
    text('无标签', [{ text: '没有标签' }], { visible: { var: 'noLabel' } }),
  ]);
  const data = { label: '东门站', fare: 0.1, first: '07:30', stops: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] };
  const run = async (current: number, overrides: Record<string, unknown> = {}) => {
    const result = await render(await textLab(FIELDS, artboard, declarations), textLabRequest({ ...data, ...overrides }, 60, 80, 72, { current }));
    expect(result.problems).toEqual([]);
    return result;
  };

  it('长度、取项、加减与条件分支', async () => {
    const result = await run(1);
    const names = ['站数', '标签字数', '标记数', '首站', '末站', '下一站', '加', '减', '状态', '同一时刻'];

    // 加减按十进制计算：0.1 + 0.2 得 0.3，不是 0.30000000000000004。缺省的列表长度为 0。
    // 本站序号 1：下一站序号 2，取第 2 项"乙"。
    expect(names.map((name) => contentOf(result, name))).toEqual(['3', '3', '0', '甲', '丙', '乙', '0.3', '-0.2', '早班', '相同']);
    expect(find(result, '无标签').visible).toBe(false);
  });

  it('取项超出范围得空值；条件分支按序取首个命中；空文本算空', async () => {
    const result = await run(0, { label: '', first: '07:00' });

    // 第一个分支（本站序号为 0）先命中，即使首班早于 08:00 的第二个分支也成立。
    expect(contentOf(result, '状态')).toBe('普通');
    expect(contentOf(result, '下一站')).toBe('甲');
    expect(contentOf(result, '同一时刻')).toBe('不同');
    expect(find(result, '无标签').visible).toBe(true);
    expect(contentOf(await run(3), '下一站')).toBe('');
  });
});

describe('绑定与缺值', () => {
  const declarations = {
    parameters: [
      { name: 'accent', displayName: '强调色', visibility: 'internal', type: 'color', default: '#E60012' },
      { name: 'size', displayName: '字号', visibility: 'public', type: 'number', constraints: { min: 1 }, default: 6 },
      { name: 'alpha', displayName: '透明度', visibility: 'public', type: 'number', default: 1 },
      { name: 'tint', displayName: '底色', visibility: 'public', type: 'color' },
    ],
  };
  const artboard = {
    fill: '#FFFFFF',
    children: [
      { type: 'rect', name: '强调块', fill: { var: 'accent' }, place: { left: 0, top: 0, width: { fixed: 10 }, height: { fixed: 10 } } },
      { type: 'rect', name: '底色块', fill: { var: 'tint' }, place: { left: 10, top: 0, width: { fixed: 10 }, height: { fixed: 10 } } },
      { type: 'rect', name: '变宽块', fill: '#0000FF', place: { left: 0, top: 10, width: { fixed: { var: 'size' } }, height: { fixed: 2 } } },
      text('字号', [{ text: '甲' }], { fontSize: { var: 'size' }, opacity: { var: 'alpha' }, place: { left: 0, top: 14 } }),
      text('票价字号', [{ text: '乙' }], { fontSize: { var: 'fare' }, place: { left: 20, top: 14 } }),
      { type: 'image', name: '标志', source: { var: 'logo' }, place: { left: 30, top: 0, width: { fixed: 8 }, height: { fixed: 8 } } },
    ],
  };
  const run = async (parameters: Record<string, unknown>, data: Record<string, unknown>, mode = 'final') =>
    render(await textLab(FIELDS, artboard, declarations), { ...textLabRequest(data, 40, 30, 120, parameters), mode });

  it('颜色、尺寸、字号、透明度与图片来源都可以绑定', async () => {
    const result = await run({ size: 8, tint: '#00FF00' }, { fare: 5, logo: 'res:landmark-1' });
    const pixels = await decodePixels(result.image!.bytes);

    expect(result.problems).toEqual([]);
    expect(pixelAtMm(pixels, 5, 5, 120).slice(0, 3)).toEqual([0xe6, 0x00, 0x12]);
    expect(pixelAtMm(pixels, 15, 5, 120).slice(0, 3)).toEqual([0x00, 0xff, 0x00]);
    expect(find(result, '变宽块').width).toBe(8);
    expect(find(result, '字号').text?.fontSize).toBe(8);
    expect(find(result, '票价字号').text?.fontSize).toBe(5);
    expect(find(result, '标志').image?.source).toBe('res:landmark-1');
  });

  it('缺值：颜色为透明、图片不画内容；数值缺值或超出范围时报问题，有缺省值用缺省值，没有则元素不显示', async () => {
    const result = await run({ alpha: 1.5 }, {}, 'draft');
    const pixels = await decodePixels(result.image!.bytes);

    expect(where(result.problems)).toEqual([
      [ProblemCodes.parameterMissing, { kind: 'parameter', name: 'tint' }, '必须提供对外参数"底色"（tint）：它没有缺省值'],
      [
        ProblemCodes.templateBindingValueInvalid,
        { kind: 'element', path: '文字实验/字号' },
        'opacity 绑定的 alpha 取值 1.5 不能用：opacity 必须是数、不小于 0、不大于 1，按缺省值 1 处理（M119）',
      ],
      [ProblemCodes.templateBindingValueInvalid, { kind: 'element', path: '文字实验/票价字号' }, 'fontSize 绑定的 fare 缺值，数值属性没有空值，该元素不显示（M119）'],
    ]);
    // 没有提供的颜色参数：底色块透明，看到画板的白色。
    expect(pixelAtMm(pixels, 15, 5, 120).slice(0, 3)).toEqual([0xff, 0xff, 0xff]);
    expect(find(result, '票价字号').visible).toBe(false);
    expect(find(result, '标志').image).toBeUndefined();
    expect(find(result, '字号').visible).toBe(true);
  });
});

describe('模板静态检查', () => {
  it('重名、成环、运算数与结果的类型、检查项、绑定与状态样式的类型都报问题，以模板变量或元素路径定位', async () => {
    const declarations = {
      parameters: [{ name: 'label', displayName: '标签参数', visibility: 'public', type: 'text', default: '甲' }],
      derived: [
        derived('a', 'number', { op: 'add', left: { var: 'b' }, right: { value: 1 } }),
        derived('b', 'number', { op: 'add', left: { var: 'a' }, right: { value: 1 } }),
        derived('twice', 'number', { op: 'add', left: { var: 'first' }, right: { value: 1 } }),
        derived('pick', 'text', { op: 'pickItem', list: { var: 'fare' }, position: 'first' }),
        derived('mood', 'text', {
          op: 'branch',
          branches: [{ when: { left: { var: 'fare' }, op: 'gt', right: { value: '高' } }, then: { value: '贵' } }],
          otherwise: { value: 1 },
        }),
        derived('stopName', 'text', { op: 'pickItem', list: { var: 'stops' }, position: 'last' }),
      ],
      checks: [{ name: '票价检查', problemWhen: { var: 'fare' }, level: 'hint', message: '票价有问题' }],
    };
    const workspace = await textLab(
      FIELDS,
      column([
        { type: 'rect', name: '色块', fill: { var: 'fare' } },
        { type: 'rect', name: '未知', fill: { var: 'accent' }, visible: false },
        { type: 'rect', name: '状态', fill: '#000000', states: { by: { var: 'mood' }, cases: { 便宜: { fill: '#FFFFFF' } } } },
        { type: 'rect', name: '列表状态', fill: '#000000', states: { by: { var: 'stops' }, cases: { 甲: { opacity: 0.5 } } } },
        { type: 'rect', name: '覆盖类型', fill: '#000000', states: { by: { var: 'label' }, cases: { 甲: { opacity: { var: 'first' } } } } },
      ]),
      declarations,
    );
    const result = await render(workspace, textLabRequest({ fare: 2 }, 40, 40, 72));
    const variable = (name: string) => ({ kind: 'variable', template: '文字实验', name });
    const element = (name: string) => ({ kind: 'element', path: `文字实验/${name}` });

    expect(where(result.problems)).toEqual([
      [ProblemCodes.templateDuplicateVariable, variable('label'), '参数 label 与数据字段重名：数据字段、参数与派生变量共用一个命名空间（M90 S3）'],
      [ProblemCodes.templateVariableCycle, variable('a'), '派生变量之间的引用成环：a → b → a'],
      [ProblemCodes.templateTypeMismatch, variable('twice'), 'left first 的类型是时刻，需要数值'],
      [ProblemCodes.templateTypeMismatch, variable('pick'), '取项的 list fare 的类型是数值，必须是列表'],
      [ProblemCodes.templateTypeMismatch, variable('mood'), '比较 gt 的运算数：固定值 "高" 不是数值'],
      [ProblemCodes.templateTypeMismatch, variable('mood'), '"否则"的结果：固定值 1 不是文本'],
      [ProblemCodes.templateTypeMismatch, variable('stopName'), '派生变量声明为文本，取项得到的是数据定义引用（站点实验 v1）'],
      [ProblemCodes.templateTypeMismatch, { kind: 'check', template: '文字实验', name: '票价检查' }, '问题条件 problemWhen fare 的类型是数值，需要布尔'],
      [ProblemCodes.templateTypeMismatch, element('色块'), 'fill 绑定的 fare 的类型是数值，fill 需要颜色（M71）'],
      [ProblemCodes.templateUnknownVariable, element('未知'), 'fill 绑定的 accent：变量 accent 不存在：既不是数据字段，也不是参数或派生变量'],
      [ProblemCodes.templateUnknownStateValue, element('状态'), '状态样式按 mood：列出的取值 "便宜" 不会出现，mood 只可能是 贵、1'],
      [ProblemCodes.templateTypeMismatch, element('列表状态'), '状态样式按 stops：列表[数据定义引用（站点实验 v1）]不能作为状态样式的依据'],
      [ProblemCodes.templateTypeMismatch, element('覆盖类型'), 'opacity 绑定的 first 的类型是时刻，opacity 需要数值（M71）'],
    ]);
  });

  it('声明写法不对时模板无法展开，两种模式都不出图', async () => {
    const declarations = {
      parameters: [
        { name: 'theme', displayName: '主题色', visibility: 'internal', type: 'color' },
        { name: 'count', displayName: '数量', visibility: 'public', type: 'number', constraints: { min: 1 }, default: 0 },
      ],
      derived: [
        derived('noOtherwise', 'text', { op: 'branch', branches: [{ when: { left: { var: 'label' }, op: 'empty' }, then: { value: '空' } }] }),
        { name: 'untyped', displayName: '未声明类型', op: 'length', of: { var: 'label' } },
      ],
    };
    const workspace = await textLab(
      FIELDS,
      column([
        text('字体', [{ text: '甲' }], { font: { var: 'label' } }),
        { type: 'rect', name: '改名', states: { by: { var: 'label' }, cases: { 甲: { name: '乙' } } } },
      ]),
      declarations,
    );
    const result = await render(workspace, { ...textLabRequest({}, 40, 40, 72), mode: 'draft' });
    const variable = (name: string) => ({ kind: 'variable', template: '文字实验', name });
    const element = (name: string) => ({ kind: 'element', path: `文字实验/${name}` });

    expect(result.image).toBeUndefined();
    expect(where(result.problems)).toEqual([
      [ProblemCodes.templateInvalid, variable('theme'), '内部参数"主题色"必须有缺省值 default（M15）'],
      [ProblemCodes.templateInvalid, variable('count'), '参数"数量"的缺省值0 不能小于 1'],
      [ProblemCodes.templateInvalid, variable('noOtherwise'), '条件分支必须有"否则" otherwise（M23）'],
      [
        ProblemCodes.templateInvalid,
        variable('untyped'),
        '派生变量必须声明结果类型 type：text、number、date、time、datetime、boolean、image、color、ref（M23）',
      ],
      [ProblemCodes.templateInvalid, element('字体'), '文本的字体 font 不能绑定变量；需要按取值换字体时用状态样式'],
      [ProblemCodes.templateInvalid, element('改名'), '状态样式不能覆盖 name（取值"甲"）'],
    ]);
  });
});
