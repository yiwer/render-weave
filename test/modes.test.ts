import { describe, expect, it } from 'vitest';
import { render, ProblemCodes, publishStaticSchema, type LayoutNode, type RenderResult } from '../src/index.js';
import { textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { decodePixels, pixelAtMm } from './support/pixels.js';

const field = (name = 'name', extra = {}) => ({ name, displayName: '站名', type: 'text', constraints: { required: true }, ...extra });
const label = (extra = {}) => ({ type: 'text', name: '站名文字', font: 'res:font-hei-regular', fontSize: 5,
  content: [{ slot: 'name' }], color: '#222222', place: { left: 5, top: 5, width: { fixed: 30 }, height: { fixed: 10 } }, ...extra });
const image = (extra = {}) => ({ type: 'image', name: '图片', source: { var: 'logo' },
  place: { left: 40, top: 5, width: { fixed: 10 }, height: { fixed: 10 } }, ...extra });
const request = (data = {}, mode = 'final') => ({ ...textLabRequest(data, 100, 60, 254), mode });
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const text = (result: RenderResult) => flatten(result.layout!.root).find((node) => node.text)!.text!;
const codes = (result: RenderResult) => result.problems.map((problem) => problem.code);
const red = (pixel: number[]) => pixel[0]! > 180 && pixel[1]! < 50 && pixel[2]! < 60;

describe('渲染检查顺序与停止条件', () => {
  it('版本不一致仍汇总模板静态、数据集与参数问题；静态检查使用模板基准', async () => {
    const base = await textLab([field()], { children: [label({ content: [{ slot: 'unknown' }] })] },
      { parameters: [{ name: 'title', displayName: '标题', type: 'text', visibility: 'public' }] });
    const second = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '另一个定义', displayName: '另一个定义',
      fields: [field('other')] }, base.staticSchemas).published!;
    for (const mode of ['draft', 'final']) {
      const result = await render({ ...base, staticSchemas: [...base.staticSchemas, second] },
        { ...request({}, mode), dataset: { inline: { dataset: { staticSchema: second.ref }, data: {} } } });
      expect(codes(result)).toEqual([ProblemCodes.templateUnknownVariable, ProblemCodes.datasetRequiredMissing,
        ProblemCodes.datasetStaticSchemaMismatch, ProblemCodes.parameterMissing, ProblemCodes.renderExpansionBlocked]);
      expect(result.image).toBeUndefined();
      expect(result.layout).toBeUndefined();
    }
  });

  it('数据集找不到也执行模板静态检查与参数检查', async () => {
    const base = await textLab([field()], { children: [label({ content: [{ slot: 'unknown' }] })] });
    const result = await render(base, { ...request(), dataset: { id: 'missing' }, parameters: { extra: 1 } });
    expect(codes(result)).toEqual([ProblemCodes.datasetNotFound, ProblemCodes.templateUnknownVariable,
      ProblemCodes.parameterUnknown, ProblemCodes.renderExpansionBlocked]);
  });

  it('模板无法解析时仍校验数据集，两种模式都不出图', async () => {
    const base = withTemplate(await textLab([field()], { children: [label()] }), '文字实验', (doc) => { doc.artboard = null; });
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(codes(final)).toEqual([ProblemCodes.templateInvalid, ProblemCodes.datasetRequiredMissing, ProblemCodes.renderExpansionBlocked]);
    expect(draft.problems).toEqual(final.problems);
    expect(final.layout).toBeUndefined();
    expect(draft.layout).toBeUndefined();
    expect(draft.image).toBeUndefined();
  });

  it('内存工作区中的数据集身份损坏时返回问题而不抛异常，其他检查仍执行', async () => {
    const base = await textLab([], { children: [] });
    const result = await render({ ...base, datasets: [{ id: 'broken', document: {} as never }] },
      { ...request(), dataset: { id: 'broken' }, parameters: { unknown: 1 } });
    expect(codes(result)).toEqual([ProblemCodes.inputUnreadable, ProblemCodes.parameterUnknown, ProblemCodes.renderExpansionBlocked]);
  });

  it('调用成环时仍汇总数据与参数问题', async () => {
    const base = await textLab([field()], { children: [{ type: 'call', name: '递归', template: '文字实验', data: 'current' }] });
    const result = await render(base, { ...request({}, 'draft'), parameters: { extra: 1 } });
    expect(codes(result)).toEqual([ProblemCodes.templateCallCycle, ProblemCodes.datasetRequiredMissing,
      ProblemCodes.parameterUnknown, ProblemCodes.renderExpansionBlocked]);
    expect(result.image).toBeUndefined();
  });
});

describe('草稿占位与共同问题清单', () => {
  it('必填字段缺失用显示名称占位，正式始终为空；边框可见，输入不被修改', async () => {
    const base = await textLab([field()], { fill: '#FFFFFF', children: [label()] });
    const saved = JSON.stringify(base.templates);
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(final.image).toBeUndefined();
    expect(draft.image).toBeDefined();
    expect(text(final).content).toBe('');
    expect(text(draft).content).toBe('〔站名〕');
    expect(text(draft).fragments[0]!.placeholder).toBe(true);
    expect(draft.problems).toEqual(final.problems);
    expect(codes(draft)).toEqual([ProblemCodes.datasetRequiredMissing]);
    const pixels = await decodePixels(draft.image!.bytes);
    expect(red(pixelAtMm(pixels, 5.2, 7, 254))).toBe(true);
    expect(JSON.stringify(base.templates)).toBe(saved);
    const repeated = await render(base, request({}, 'draft'));
    expect(repeated.layout).toEqual(draft.layout);
    expect(repeated.image!.bytes).toEqual(draft.image!.bytes);
  });

  it('正常可选缺值不占位、不画边框，两种模式字节相同', async () => {
    const base = await textLab([field('name', { constraints: {} })], { fill: '#FFFFFF', children: [label()] });
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(draft.problems).toEqual([]);
    expect(text(draft).content).toBe('');
    expect(draft.layout).toEqual(final.layout);
    expect(draft.image!.bytes).toEqual(final.image!.bytes);
  });

  it.each([null, 12, ''])('字段值 %j 因问题显示为空时占位', async (name) => {
    const base = await textLab([field('name', { constraints: { required: true, minLength: 1 } })], { children: [label()] });
    const final = await render(base, request({ name }));
    const draft = await render(base, request({ name }, 'draft'));
    expect(text(draft).content).toBe('〔站名〕');
    expect(draft.problems).toEqual(final.problems);
  });

  it('占位引出的溢出与缺字不进入真实内容的问题清单', async () => {
    const base = await textLab([field('name', { displayName: '非常长的站名\u{10FFFF}' })],
      { children: [label({ place: { width: { fixed: 2 }, height: { fixed: 5 } } })] });
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(draft.image).toBeDefined();
    expect(text(draft).overflow).toBe(true);
    expect(draft.problems).toEqual(final.problems);
    expect(codes(draft)).toEqual([ProblemCodes.datasetRequiredMissing]);
  });

  it('必填图片缺值只画边框，可选图片缺值保持空白', async () => {
    const base = await textLab([{ name: 'logo', displayName: '图标', type: 'image', constraints: { required: true } },
      { name: 'optional', displayName: '可选图标', type: 'image' }], { fill: '#FFFFFF', children: [image(),
      image({ name: '可选图片', source: { var: 'optional' }, place: { left: 60, top: 5, width: { fixed: 10 }, height: { fixed: 10 } } })] });
    const draft = await render(base, request({}, 'draft'));
    const final = await render(base, request());
    expect(draft.problems).toEqual(final.problems);
    const pixels = await decodePixels(draft.image!.bytes);
    expect(red(pixelAtMm(pixels, 40.2, 8, 254))).toBe(true);
    expect(pixelAtMm(pixels, 45, 10, 254)).toEqual([255, 255, 255, 255]);
    expect(pixelAtMm(pixels, 60.2, 8, 254)).toEqual([255, 255, 255, 255]);
  });

  it('未被元素引用的字段和参数问题不画边框', async () => {
    const base = await textLab([field()], { fill: '#FFFFFF', children: [label({ content: [{ text: '田' }] })] });
    const draft = await render(base, { ...request({}, 'draft'), parameters: { wrong: 1 } });
    const clean = await render(base, request({ name: '田' }));
    expect(codes(draft)).toEqual([ProblemCodes.datasetRequiredMissing, ProblemCodes.parameterUnknown]);
    expect(draft.image!.bytes).toEqual(clean.image!.bytes);
  });

  it('缺值参数用参数显示名称；派生变量的缺值追溯到已有字段问题', async () => {
    const base = await textLab([{ name: 'n', displayName: '原数值', type: 'number', constraints: { required: true } }],
      { children: [label({ content: [{ slot: 'title' }, { slot: 'sum' }] })] },
      { parameters: [{ name: 'title', displayName: '标题', type: 'text', visibility: 'public' }],
        derived: [{ name: 'sum', displayName: '合计', type: 'number', op: 'add', left: { var: 'n' }, right: { value: 1 } }] });
    const draft = await render(base, request({}, 'draft'));
    const final = await render(base, request());
    expect(text(draft).content).toBe('〔标题〕〔合计〕');
    expect(draft.problems).toEqual(final.problems);
  });

  it('单引用缺值的后代插槽使用叶字段显示名称；可选引用正常缺失不占位', async () => {
    for (const required of [true, false]) {
      const base = await textLab([{ name: 'stop', displayName: '停靠站点', type: 'ref', ref: { name: '站点实验', version: 1 }, constraints: { required } }],
        { children: [label({ content: [{ slot: 'stop.name' }] })] });
      const draft = await render(base, request({}, 'draft'));
      expect(text(draft).content).toBe(required ? '〔站名〕' : '');
    }
  });

  it('子模板循环仅标记问题实例，采用被调用作用域的字段名称', async () => {
    const base = await textLab([{ name: 'items', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '站点实验', version: 1 } } }],
      { children: [{ type: 'loop', name: '站点列', list: { var: 'items' }, template: '站点',
        itemLayout: { direction: 'row', widths: 'equal' }, place: { width: 'fill', height: 'fill' } }] });
    const document = { dslVersion: 'renderweave-template/1', name: '站点', base: { name: '站点实验', version: 1 },
      artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } }, children: [label()] } };
    const workspace = { ...base, templates: [...base.templates, { name: '站点', document }] };
    const draft = await render(workspace, request({ items: [{ name: '田' }, { name: null }, {}] }, 'draft'));
    expect(flatten(draft.layout!.root).filter((node) => node.text).map((node) => [node.path, node.text!.content])).toEqual([
      ['文字实验/站点列[1]/站名文字', '田'], ['文字实验/站点列[2]/站名文字', '〔站名〕'], ['文字实验/站点列[3]/站名文字', ''],
    ]);
    expect(draft.problems).toEqual((await render(workspace, request({ items: [{ name: '田' }, { name: null }, {}] }))).problems);
  });

  it('子模板参数的空默认值不占位，未填写的必需参数才占位', async () => {
    const base = await textLab([], { children: [{ type: 'call', name: '调用', template: '子模板', data: 'none',
      place: { width: 'fill', height: 'fill' } }] });
    const document = { dslVersion: 'renderweave-template/1', name: '子模板', base: { name: '空数据定义', version: 1 },
      parameters: [
        { name: 'empty', displayName: '空默认值', type: 'text', visibility: 'public', default: '' },
        { name: 'title', displayName: '标题', type: 'text', visibility: 'public' },
      ], artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } },
        children: [label({ content: [{ slot: 'empty' }, { slot: 'title' }] })] } };
    const workspace = { ...base, templates: [...base.templates, { name: '子模板', document }] };
    const draft = await render(workspace, request({}, 'draft'));
    expect(text(draft).content).toBe('〔标题〕');
    expect(text(draft).fragments[0]!.placeholder).toBeUndefined();
    expect(draft.problems).toEqual((await render(workspace, request())).problems);
  });

  it('取项引用追溯到选中的列表项字段，其他项的问题不会污染可选缺值', async () => {
    const base = await textLab([{ name: 'items', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '站点实验', version: 1 } } }],
      { children: [label({ content: [{ slot: 'first.name' }, { slot: 'last.name' }] })] },
      { derived: [
        { name: 'first', displayName: '首站', type: 'ref', ref: { name: '站点实验', version: 1 }, op: 'pickItem', list: { var: 'items' }, position: 'first' },
        { name: 'last', displayName: '末站', type: 'ref', ref: { name: '站点实验', version: 1 }, op: 'pickItem', list: { var: 'items' }, position: 'last' },
      ] });
    const draft = await render(base, request({ items: [{ name: null }, {}] }, 'draft'));
    expect(text(draft).fragments.map((fragment) => fragment.text)).toEqual(['〔站名〕', '']);
    expect(draft.problems).toEqual((await render(base, request({ items: [{ name: null }, {}] }))).problems);
  });

  it('无法用于文字的插槽显示变量名称占位，未定义变量用引用名定位', async () => {
    const base = await textLab([{ name: 'flag', displayName: '开关', type: 'boolean' }],
      { children: [label({ content: [{ slot: 'flag' }, { slot: 'missing' }] })] });
    const draft = await render(base, request({ flag: true }, 'draft'));
    expect(text(draft).content).toBe('〔开关〕〔missing〕');
    expect(draft.problems).toEqual((await render(base, request({ flag: true }))).problems);
  });
});

describe('草稿边框', () => {
  it('实际溢出在草稿中有边框，问题与正式一致', async () => {
    const base = await textLab([], { fill: '#FFFFFF', children: [label({ content: [{ text: '田'.repeat(10) }] })] });
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(codes(final)).toEqual([ProblemCodes.layoutTextOverflow]);
    expect(draft.problems).toEqual(final.problems);
    expect(final.image).toBeUndefined();
    expect(red(pixelAtMm(await decodePixels(draft.image!.bytes), 5.2, 7, 254))).toBe(true);
  });

  it('旋转后的边框仍在正确位置，不被透明度、裁剪及后画元素遮盖', async () => {
    const base = await textLab([], { fill: '#FFFFFF', children: [
      { type: 'container', name: '旋转容器', rotation: 90, opacity: 0, clip: true,
        place: { left: 20, top: 20, width: { fixed: 20 }, height: { fixed: 10 } }, children: [
          label({ font: 'res:missing-font', content: [{ text: '田' }],
            place: { left: 0, top: 0, width: { fixed: 30 }, height: { fixed: 10 } } }),
        ] },
      { type: 'rect', name: '覆盖', fill: '#FFFFFF', place: { width: 'fill', height: 'fill' } },
    ] });
    const draft = await render(base, request({}, 'draft'));
    expect(codes(draft)).toEqual([ProblemCodes.resourceNotFound]);
    // 子元素超出裁剪框，绕容器中心旋转后，边框仍应延伸到 y=45。
    const pixels = await decodePixels(draft.image!.bytes);
    expect(red(pixelAtMm(pixels, 25.2, 20, 254))).toBe(true);
    expect(red(pixelAtMm(pixels, 25.2, 40, 254))).toBe(true);
    expect(pixelAtMm(pixels, 20.2, 22, 254)).toEqual([255, 255, 255, 255]);
  });

  it('没有问题时草稿与正式完全相同', async () => {
    const base = await textLab([field()], { children: [label()] });
    const draft = await render(base, request({ name: '田' }, 'draft'));
    const final = await render(base, request({ name: '田' }));
    expect(draft).toEqual(final);
  });

  it('只有提示时正式出图成功且没有草稿边框', async () => {
    const base = await textLab([], { fill: '#FFFFFF', children: [label({ content: [{ text: '田'.repeat(10) }], fit: { onFail: 'hint' } })] });
    const final = await render(base, request());
    const draft = await render(base, request({}, 'draft'));
    expect(final.image).toBeDefined();
    expect(final.problems[0]!.level).toBe('hint');
    expect(draft.problems).toEqual(final.problems);
    const point = async (result: RenderResult) => pixelAtMm(await decodePixels(result.image!.bytes), 5.2, 7, 254);
    expect(red(await point(final))).toBe(false);
    expect(red(await point(draft))).toBe(true);
  });
});
