import { describe, expect, it } from 'vitest';
import { loadWorkspace, publishStaticSchema, render, ProblemCodes, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir, textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';
import { decodePixels, pixelAtMm } from './support/pixels.js';

const FONT = 'res:font-hei-medium';
const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
const ref = (name: string, version = 1) => ({ name, version });
const text = (name: string, slot: string, extra: Record<string, unknown> = {}) => ({
  type: 'text', name, content: [{ slot }], font: FONT, fontSize: 5, color: '#333333',
  place: { width: 'hug', height: 'hug' }, ...extra,
});
const param = (name: string, type = 'number', extra: Record<string, unknown> = {}) => ({ name, displayName: name, visibility: 'public', type, ...extra });
const loop = (extra: Record<string, unknown> = {}) => ({
  type: 'loop', name: '循环', list: { var: 'items' }, template: '子模板', args: {},
  itemLayout: { direction: 'row', widths: 'equal' }, place: { width: 'fill', height: 'fill' }, ...extra,
});
const call = (extra: Record<string, unknown> = {}) => ({ type: 'call', name: '调用', template: '子模板', data: 'none', args: {},
  place: { width: 'fill', height: 'fill' }, ...extra });

function addTemplate(workspace: Workspace, name: string, base: string, children: unknown[], extra: Record<string, unknown> = {}): Workspace {
  const document = { dslVersion: 'renderweave-template/1', name, base: ref(base),
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children }, ...extra };
  return { ...workspace, templates: [...workspace.templates, { name, document }] };
}

function flatten(node: LayoutNode): LayoutNode[] { return [node, ...(node.children ?? []).flatMap(flatten)]; }
function at(result: RenderResult, path: string): LayoutNode {
  const found = result.layout && flatten(result.layout.root).find((node) => node.path === path);
  if (!found) throw new Error(`布局中没有 ${path}：${JSON.stringify(result.problems)}`);
  return found;
}
function byName(result: RenderResult, name: string): LayoutNode {
  return flatten(result.layout!.root).find((node) => node.name === name)!;
}
const codes = (result: RenderResult) => result.problems.map((p) => p.code);
const listField = (items: Record<string, unknown>) => ({ name: 'items', displayName: '列表', type: 'list', items });

async function referenceLoop(extra: Record<string, unknown> = {}): Promise<Workspace> {
  const workspace = await textLab([listField({ type: 'ref', ref: ref('站点实验') })], { children: [loop(extra)] });
  return addTemplate(workspace, '子模板', '站点实验', [text('站名', 'name')]);
}

/** 保留本票据所有循环；只移除票据 09 的道路合并与票据 10 的缩字组。 */
async function m402(): Promise<Workspace> {
  let workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  const strip = (node: Record<string, any>) => {
    if (node['fit']) delete node['fit']['widthOverflow'];
    if (node['children']) {
      node['children'] = node['children'].filter((child: Record<string, any>) => !child['mergeBy']);
      node['children'].forEach(strip);
    }
  };
  for (const name of ['标准线路单边', '站点']) workspace = withTemplate(workspace, name, (document) => strip(document['artboard']));
  return workspace;
}
const m402Request = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 },
  output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'final' };

describe('M402 循环展开', () => {
  it('35 列等分、本站高亮、已过站灰字及半透明地标、嵌套标识行、班次内容宽度和末项无分隔符', async () => {
    const result = await render(await m402(), m402Request);
    expect(result.problems).toEqual([]);
    const stations = at(result, '标准线路单边/站点面板/站点列');
    expect(stations.type).toBe('loop');
    expect(stations.children).toHaveLength(35);
    for (let i = 0; i < 35; i++) {
      const item = stations.children![i]!;
      expect(item.path).toBe(`标准线路单边/站点面板/站点列[${i + 1}]`);
      expect(item.width).toBeCloseTo((740 - 46) / 35, 3);
      expect(item.x).toBeCloseTo(23 + (694 / 35) * i, 3);
    }
    const station = (i: number, element: string) => at(result, `标准线路单边/站点面板/站点列[${i}]/${element}`);
    expect(station(5, '名称区/站名').text?.fragments[0]?.color).toBe('#E60012FF');
    expect(station(4, '名称区/站名').text?.fragments[0]?.color).toBe('#C8C8C8FF');
    expect(station(6, '名称区/站名').text?.fragments[0]?.color).toBe('#333333FF');
    expect(station(1, '名称区/站名').height - station(5, '名称区/站名').height).toBeCloseTo(9);
    expect(station(1, '名称区/地标').visible).toBe(false);
    expect(station(2, '标识行[1]/标识图').image?.source).toBe('res:icon-metro');
    const icons = flatten(result.layout!.root).filter((node) => node.image?.source === 'res:icon-hospital');
    expect(icons.length).toBeGreaterThan(0);
    const pixels = await decodePixels(result.image!.bytes);
    const current = station(5, '名称区');
    expect(pixelAtMm(pixels, current.x + 0.5, current.y + 0.5, 120).slice(0, 3)).toEqual([255, 240, 0]);
    const passed = station(4, '名称区/地标');
    const future = station(6, '名称区/地标');
    const darkness = (node: LayoutNode) => {
      let darkest = 255;
      for (let y = 1; y < 7; y += 0.25) for (let x = 1; x < 7; x += 0.25) {
        darkest = Math.min(darkest, pixelAtMm(pixels, node.x + x, node.y + y, 120)[0]!);
      }
      return darkest;
    };
    expect(darkness(passed)).toBeGreaterThan(darkness(future) + 80);
    const departures = byName(result, '班次列');
    expect(departures.children).toHaveLength(15);
    const times = departures.children!.map((item) => flatten(item).find((node) => node.name === '时刻')!.text!.content);
    expect(times).toEqual(['08:00', '08:25', '08:50', '09:10', '09:30', '09:50', '10:30', '17:35', '17:50', '18:00', '18:15', '18:30', '18:50', '19:35', '20:25']);
    expect(flatten(departures).filter((node) => node.name === '分隔' && node.visible)).toHaveLength(14);
    expect(departures.children![14]!.width).toBeLessThan(departures.children![0]!.width);
    await expectMatchesGolden('m402-stops', result.image!.bytes);
  });

  it('第 12 站超长站名的问题定位贯穿调用链', async () => {
    const workspace = await m402();
    const document = structuredClone(workspace.datasets[0]!.document) as any;
    document.data.stops[11].name = '一二三四五六七八九十一二三四五六七八九十';
    const result = await render(workspace, { ...m402Request, mode: 'draft', dataset: { inline: document } });
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.layoutTextOverflow,
      location: { kind: 'element', path: '标准线路单边/站点面板/站点列[12]/名称区/站名' } }));
    expect(result.image).toBeDefined();
  });
});

describe('循环列表与尺寸', () => {
  it.each([
    ['equal', [20, 20]],
    [{ fixed: 18 }, [18, 18]],
    ['content', [5, 15]],
  ])('循环项宽度 %j，空隙参与布局', async (widths, expected) => {
    const workspace = await referenceLoop({ itemLayout: { direction: 'row', widths, gap: 2 } });
    const result = await render(workspace, textLabRequest({ items: [{ name: '甲' }, { name: '乙丙丁' }] }, 42, 10));
    expect(result.problems).toEqual([]);
    const items = at(result, '文字实验/循环').children!;
    expect(items.map((node) => node.width)).toEqual(expected);
    expect(items[1]!.x).toBe(expected[0]! + 2);
  });

  it.each([{}, { items: [] }])('缺值或空列表不生成循环项：%j', async (data) => {
    const result = await render(await referenceLoop(), textLabRequest(data, 40, 10));
    expect(result.problems).toEqual([]);
    expect(at(result, '文字实验/循环').children).toEqual([]);
  });

  it('仅显式参数传入循环信息；子模板自己的参数、内部参数和派生变量各自求值', async () => {
    let workspace = await textLab([listField({ type: 'text' })], { children: [loop({ args: {
      index: { loop: 'index' }, first: { loop: 'isFirst' }, last: { loop: 'isLast' }, count: { loop: 'count' }, label: { var: 'label' },
    } })] }, { parameters: [param('label', 'text', { default: '父' }), param('own', 'text', { default: '父私有' })] });
    workspace = addTemplate(workspace, '子模板', '单值·文本', [
      text('值', 'value'), text('序号', 'index'), text('总数', 'count'), text('传入', 'label'), text('自身', 'own'), text('派生', 'next'),
      { type: 'rect', name: '首项', visible: { var: 'first' }, fill: '#00FF00', place: { width: { fixed: 1 }, height: { fixed: 1 } } },
      { type: 'rect', name: '末项', visible: { var: 'last' }, fill: '#FF0000', place: { width: { fixed: 1 }, height: { fixed: 1 } } },
    ], { parameters: [param('index'), param('count'), param('first', 'boolean'), param('last', 'boolean'), param('label', 'text'),
      param('own', 'text', { visibility: 'internal', default: '子' })],
      derived: [{ name: 'next', displayName: '下序号', type: 'number', op: 'add', left: { var: 'index' }, right: { value: 1 } }] });
    const result = await render(workspace, textLabRequest({ items: ['甲', '乙'] }, 100, 10));
    expect(result.problems).toEqual([]);
    for (let i = 1; i <= 2; i++) {
      const node = (name: string) => at(result, `文字实验/循环[${i}]/${name}`);
      expect(node('序号').text?.content).toBe(String(i));
      expect(node('总数').text?.content).toBe('2');
      expect(node('传入').text?.content).toBe('父');
      expect(node('自身').text?.content).toBe('子');
      expect(node('派生').text?.content).toBe(String(i + 1));
      expect(node('首项').visible).toBe(i === 1);
      expect(node('末项').visible).toBe(i === 2);
    }
  });

  it.each([
    ['text', '文本', '甲', '甲'], ['number', '数值', 12.3, '12.3'], ['date', '日期', '2026-10-11', '2026-10-11'],
    ['time', '时刻', '08:30', '08:30'], ['datetime', '时间', '2026-10-11 08:30:00', '2026-10-11 08:30:00'],
    ['boolean', '布尔', true, undefined], ['image', '图片', 'res:landmark-1', undefined],
  ])('基本类型 %s 包装为单值·%s，并可直接预览同一模板', async (kind, label, value, expected) => {
    let workspace = await textLab([listField({ type: kind })], { children: [loop()] });
    const child = kind === 'image' ? { type: 'image', name: '内容', source: { var: 'value' }, place: { width: 'fill', height: 'fill' } }
      : kind === 'boolean' ? { type: 'rect', name: '内容', visible: { var: 'value' }, fill: '#00FF00' } : text('内容', 'value');
    workspace = addTemplate(workspace, '子模板', `单值·${label}`, [child]);
    const result = await render(workspace, textLabRequest({ items: [value] }, 100, 10));
    expect(result.problems).toEqual([]);
    expect(at(result, '文字实验/循环[1]/内容').text?.content).toBe(expected);
    if (kind === 'image') expect(at(result, '文字实验/循环[1]/内容').image?.source).toBe(value);
    const direct = await render(workspace, { ...textLabRequest({}, 100, 10), template: '子模板',
      dataset: { inline: { dataset: { staticSchema: ref(`单值·${label}`) }, data: { value } } } });
    expect(direct.problems).toEqual([]);
    expect(direct.image?.bytes).toEqual(result.image?.bytes);
  });
});

describe('子模板数据与调用框', () => {
  it('三种数据来源，多层单引用与子模板再调用；作用域不继承', async () => {
    let workspace = await textLab([{ name: 'stop', displayName: '站', type: 'ref', ref: ref('站点实验') }], {
      layout: { mode: 'stack', direction: 'row' }, children: [
        call({ name: '引用调用', data: { var: 'stop' }, template: '站点模板' }),
        call({ name: '当前调用', data: 'current', template: '当前模板' }),
        call({ name: '空调用', template: '空模板' }),
      ],
    }, { parameters: [param('label', 'text', { default: '不继承' })] });
    workspace = addTemplate(workspace, '站点模板', '站点实验', [text('站名', 'name')]);
    workspace = addTemplate(workspace, '当前模板', '文字实验', [call({ name: '再调用', data: { var: 'stop' }, template: '站点模板' })]);
    workspace = addTemplate(workspace, '空模板', '空数据定义', [text('标签', 'label')], { parameters: [param('label', 'text', { default: '独立' })] });
    const nested = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '包装', displayName: '包装',
      fields: [{ name: 'inner', displayName: '内层', type: 'ref', ref: ref('站点实验') }] }, workspace.staticSchemas).published!;
    const root = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '多层', displayName: '多层',
      fields: [{ name: 'outer', displayName: '外层', type: 'ref', ref: nested.ref }] }, [...workspace.staticSchemas, nested]).published!;
    workspace = { ...workspace, staticSchemas: [...workspace.staticSchemas, nested, root] };
    workspace = addTemplate(workspace, '多层模板', '多层', [call({ data: { var: 'outer.inner' }, template: '站点模板' })]);
    const result = await render(workspace, textLabRequest({ stop: { name: '甲站' } }, 90, 10));
    expect(result.problems).toEqual([]);
    expect(at(result, '文字实验/引用调用/站名').text?.content).toBe('甲站');
    expect(at(result, '文字实验/当前调用/再调用/站名').text?.content).toBe('甲站');
    expect(at(result, '文字实验/空调用/标签').text?.content).toBe('独立');
    const deep = await render(workspace, { ...textLabRequest({}, 90, 10), template: '多层模板',
      dataset: { inline: { dataset: { staticSchema: root.ref }, data: { outer: { inner: { name: '乙站' } } } } } });
    expect(deep.problems).toEqual([]);
    expect(at(deep, '多层模板/调用/站名').text?.content).toBe('乙站');
  });

  it('固定调用框重新排布并保持字号；随内容框取自然尺寸，画板外观也保留', async () => {
    let workspace = await textLab([], { layout: { mode: 'stack', direction: 'row' }, children: [
      call({ name: '窄框', place: { width: { fixed: 20 }, height: { fixed: 10 } } }),
      call({ name: '宽框', place: { width: { fixed: 40 }, height: { fixed: 10 } } }),
      call({ name: '自然框', place: { width: 'hug', height: 'hug' } }),
    ] });
    workspace = addTemplate(workspace, '子模板', '空数据定义', [], { artboard: { size: 'hug', sizeRange: range,
      fill: '#00FF00', padding: 1, layout: { mode: 'stack', direction: 'row', justifyContent: 'end' },
      children: [{ ...text('文字', 'unused'), content: [{ text: '甲乙' }] }] } });
    const result = await render(workspace, textLabRequest({}, 80, 10));
    expect(result.problems).toEqual([]);
    expect(at(result, '文字实验/窄框/文字')).toMatchObject({ x: 9, width: 10, text: { fontSize: 5 } });
    expect(at(result, '文字实验/宽框/文字')).toMatchObject({ x: 49, width: 10, text: { fontSize: 5 } });
    expect(at(result, '文字实验/自然框')).toMatchObject({ width: 12, height: 7 });
    const pixels = await decodePixels(result.image!.bytes);
    expect(pixelAtMm(pixels, 0.5, 0.5, 120).slice(0, 3)).toEqual([0, 255, 0]);
  });

  it('尺寸范围使用实际调用框检查；草稿继续出图，正式不出图', async () => {
    let workspace = await referenceLoop();
    workspace = withTemplate(workspace, '子模板', (document) => { document['artboard']['sizeRange']['width'] = { min: 25, max: 30 }; });
    const request = textLabRequest({ items: [{ name: '甲' }, { name: '乙' }] }, 40, 10);
    for (const mode of ['draft', 'final']) {
      const result = await render(workspace, { ...request, mode });
      expect(result.problems.map((p) => [p.code, p.location])).toEqual([1, 2].map((i) => [ProblemCodes.renderSizeOutOfRange,
        { kind: 'element', path: `文字实验/循环[${i}]` }]));
      expect(Boolean(result.image)).toBe(mode === 'draft');
    }
  });
});

describe('调用图与参数检查', () => {
  it('间接调用成环阻止展开；共享同一子模板的无环调用图可以正常渲染', async () => {
    let workspace = await textLab([], { layout: { mode: 'stack', direction: 'row' }, children: [
      call({ name: '甲', template: '甲' }), call({ name: '乙', template: '乙' }),
    ] });
    workspace = addTemplate(workspace, '甲', '空数据定义', [call({ template: '共享' })]);
    workspace = addTemplate(workspace, '乙', '空数据定义', [call({ template: '共享' })]);
    workspace = addTemplate(workspace, '共享', '空数据定义', [{ ...text('字', 'unused'), content: [{ text: '甲' }] }]);
    const ok = await render(workspace, textLabRequest({}, 40, 10));
    expect(ok.problems).toEqual([]);
    expect(at(ok, '文字实验/甲/调用/字').text?.content).toBe('甲');
    expect(at(ok, '文字实验/乙/调用/字').text?.content).toBe('甲');
    workspace = withTemplate(workspace, '共享', (document) => { document['artboard']['children'] = [call({ template: '甲' })]; });
    const cycle = await render(workspace, { ...textLabRequest({}, 40, 10), mode: 'draft' });
    expect(codes(cycle)).toContain(ProblemCodes.templateCallCycle);
    expect(cycle.image).toBeUndefined();
    expect(cycle.layout).toBeUndefined();
  });

  it.each([
    [call({ template: '不存在' }), ProblemCodes.templateNotFound],
    [call({ data: 'current' }), ProblemCodes.templateCallBaseMismatch],
    [call({ data: { var: 'items' } }), ProblemCodes.templateTypeMismatch],
    [call({ data: { var: 'items.name' } }), ProblemCodes.templateInvalidPath],
    [call({ data: { var: 'absent' } }), ProblemCodes.templateUnknownVariable],
    [loop({ list: { var: 'label' } }), ProblemCodes.templateTypeMismatch],
  ])('无法确定兼容调用数据时阻止展开：%j', async (element, code) => {
    let workspace = await textLab([listField({ type: 'ref', ref: ref('站点实验') }), { name: 'label', displayName: '名称', type: 'text' }],
      { children: [element] });
    workspace = addTemplate(workspace, '子模板', '空数据定义', []);
    const result = await render(workspace, { ...textLabRequest({}, 40, 10), mode: 'draft' });
    expect(codes(result)).toContain(code);
    expect(result.image).toBeUndefined();
    expect(result.layout).toBeUndefined();
  });

  it('子模板的基准版本必须精确匹配，缺少编译产物也不能展开', async () => {
    let workspace = await referenceLoop();
    workspace = withTemplate(workspace, '子模板', (document) => { document['base'] = ref('站点实验', 2); });
    const mismatch = await render(workspace, { ...textLabRequest({ items: [] }, 40, 10), mode: 'draft' });
    expect(codes(mismatch)).toContain(ProblemCodes.templateLoopBaseMismatch);
    expect(mismatch.layout).toBeUndefined();
    workspace = await referenceLoop();
    workspace = { ...workspace, staticSchemas: workspace.staticSchemas.map((schema) => schema.ref.name === '站点实验' ? { ref: schema.ref } : schema) };
    const missing = await render(workspace, { ...textLabRequest({ items: [] }, 40, 10), mode: 'draft' });
    expect(codes(missing)).toContain(ProblemCodes.compiledSchemaMissing);
    expect(missing.layout).toBeUndefined();
  });

  it('状态分支中的参数错误也静态检查；模板目标不能用状态切换', async () => {
    const workspace = await referenceLoop({ states: { by: { var: 'items' }, cases: { unused: { args: { typo: { value: 1 } } } } } });
    const result = await render(workspace, { ...textLabRequest({ items: [] }, 40, 10), mode: 'draft' });
    expect(codes(result)).toContain(ProblemCodes.parameterUnknown);
    const invalid = withTemplate(workspace, '文字实验', (document) => {
      document['artboard']['children'][0]['states']['cases']['unused'] = { template: '别的模板' };
    });
    const blocked = await render(invalid, { ...textLabRequest({}, 40, 10), mode: 'draft' });
    expect(codes(blocked)).toContain(ProblemCodes.templateInvalid);
    expect(blocked.image).toBeUndefined();
  });

  it('子模板画板求值失败时返回问题，不抛异常', async () => {
    let workspace = await textLab([{ name: 'width', displayName: '宽度', type: 'number' }], { children: [call({ args: { width: { var: 'width' } } })] });
    workspace = addTemplate(workspace, '子模板', '空数据定义', [], { parameters: [param('width')], artboard: {
      sizeRange: range, stroke: { color: '#000000', width: { var: 'width' } },
    } });
    const result = await render(workspace, { ...textLabRequest({}, 40, 10), mode: 'draft' });
    expect(codes(result)).toContain(ProblemCodes.templateBindingValueInvalid);
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.templateBindingValueInvalid,
      location: { kind: 'element', path: '文字实验/调用' } }));
    expect(result.image).toBeUndefined();
  });

  it('隐藏调用不求参数或加载资源；可见实例的资源错误保留调用路径', async () => {
    let workspace = await textLab([], { children: [call({ visible: false })] });
    workspace = addTemplate(workspace, '子模板', '空数据定义', [{ ...text('字', 'unused'), content: [{ text: '甲' }], font: 'res:missing' }]);
    const hidden = await render(workspace, textLabRequest({}, 40, 10));
    expect(hidden.problems).toEqual([]);
    expect(at(hidden, '文字实验/调用').visible).toBe(false);
    workspace = withTemplate(workspace, '文字实验', (document) => { document['artboard']['children'][0]['visible'] = true; });
    const visible = await render(workspace, textLabRequest({}, 40, 10));
    expect(visible.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.resourceNotFound,
      location: { kind: 'element', path: '文字实验/调用/字' } }));
  });

  it('普通调用中不能使用循环信息，未知循环信息也不接受', async () => {
    for (const element of [call({ args: { n: { loop: 'index' } } }), loop({ args: { n: { loop: 'unknown' } } })]) {
      const workspace = await textLab([], { children: [element] });
      const result = await render(workspace, { ...textLabRequest({}, 40, 10), mode: 'draft' });
      expect(codes(result)).toContain(ProblemCodes.templateInvalid);
      expect(result.image).toBeUndefined();
    }
  });

  it.each(['draft', 'final'])('隐藏元素中的调用成环也阻止展开：%s', async (mode) => {
    const workspace = await textLab([], { children: [call({ template: '文字实验', data: 'current', visible: false })] });
    const result = await render(workspace, { ...textLabRequest({}, 20, 10), mode });
    expect(codes(result)).toContain(ProblemCodes.templateCallCycle);
    expect(result.image).toBeUndefined();
    expect(result.layout).toBeUndefined();
  });

  it.each(['draft', 'final'])('循环模板基准不同阻止展开，空列表也检查：%s', async (mode) => {
    const workspace = withTemplate(await referenceLoop(), '子模板', (document) => { document['base'] = ref('单值·文本'); });
    const result = await render(workspace, { ...textLabRequest({ items: [] }, 20, 10), mode });
    expect(codes(result)).toContain(ProblemCodes.templateLoopBaseMismatch);
    expect(result.image).toBeUndefined();
    expect(result.layout).toBeUndefined();
  });

  it('内部、未知、必填和类型错误的参数在隐藏的调用声明中也能发现', async () => {
    let workspace = await referenceLoop({ visible: false, args: { internal: { value: 1 }, unknown: { value: 2 }, label: { loop: 'index' } } });
    workspace = withTemplate(workspace, '子模板', (document) => {
      document['parameters'] = [param('internal', 'number', { visibility: 'internal', default: 3 }), param('label', 'text'), param('required')];
    });
    const result = await render(workspace, { ...textLabRequest({ items: [] }, 20, 10), mode: 'draft' });
    expect(codes(result)).toEqual([ProblemCodes.parameterInternal, ProblemCodes.parameterUnknown, ProblemCodes.templateTypeMismatch, ProblemCodes.parameterMissing]);
    expect(result.problems.every((p) => p.location.kind === 'element' && p.location.path === '文字实验/循环')).toBe(true);
    expect(result.image).toBeDefined();
  });

  it('子模板读取调用方字段或未传入的循环信息时报告未知变量', async () => {
    let workspace = await referenceLoop();
    workspace = withTemplate(workspace, '子模板', (document) => { document['artboard']['children'] = [text('父列表', 'items'), text('循环序号', 'index')]; });
    const result = await render(workspace, textLabRequest({ items: [{ name: '甲' }] }, 20, 10));
    expect(codes(result)).toEqual([ProblemCodes.templateUnknownVariable, ProblemCodes.templateUnknownVariable]);
    expect(result.image).toBeUndefined();
  });

  it('循环参数约束和子模板检查项按实例定位', async () => {
    let workspace = await referenceLoop({ args: { index: { loop: 'index' } } });
    workspace = withTemplate(workspace, '子模板', (document) => {
      document['parameters'] = [param('index', 'number', { constraints: { max: 1 } })];
      document['derived'] = [{ name: 'bad', displayName: '第二项', type: 'boolean', op: 'branch',
        branches: [{ when: { left: { var: 'index' }, op: 'eq', right: { value: 2 } }, then: { value: true } }], otherwise: { value: false } }];
      document['checks'] = [{ name: '检查', problemWhen: { var: 'bad' }, level: 'hint', message: '第二项' }];
    });
    const result = await render(workspace, { ...textLabRequest({ items: [{ name: '甲' }, { name: '乙' }] }, 40, 10), mode: 'draft' });
    expect(result.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.parameterInvalid, { kind: 'parameter', name: 'index', path: '文字实验/循环[2]' }],
      [ProblemCodes.checkFailed, { kind: 'check', template: '子模板', name: '检查', path: '文字实验/循环[2]' }],
    ]);
  });
});
