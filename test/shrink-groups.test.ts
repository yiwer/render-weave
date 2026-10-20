import { describe, expect, it } from 'vitest';
import { loadWorkspace, publishStaticSchema, render, ProblemCodes, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir, textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';

const fit = (group = '站名', minFontSize = 5) => ({ steps: ['tightenSpacing', 'compressGlyphs'],
  widthOverflow: { shrinkGroup: group, minFontSize }, compressMin: 0.6 });
const label = (name: string, extra: Record<string, unknown> = {}) => ({ type: 'text', name,
  content: [{ text: '田田田田田田田田' }], font: 'res:font-hei-medium', fontSize: 10, color: '#000000',
  writingMode: 'vertical', horizontalAlign: 'center', verticalAlign: 'distribute', fit: fit(),
  place: { width: 'fill', height: 'fill' }, ...extra });
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const texts = (result: RenderResult) => flatten(result.layout!.root).filter((node) => node.text);

async function columns(children: unknown[], widths: number[], height = 65, mode = 'final'): Promise<RenderResult> {
  const workspace = await textLab([], { fill: '#FFFFFF', layout: { mode: 'grid', columns: widths.map((fixed) => ({ fixed })), rows: [{ fraction: 1 }] },
    children: children.map((child, i) => ({ ...child as object, place: { column: i + 1, row: 1, width: 'fill', height: 'fill' } })) });
  return render(workspace, { ...textLabRequest({}, widths.reduce((a, b) => a + b, 0), height, 120), mode });
}

describe('缩字组的两轮排版', () => {
  it('最窄成员决定全组字号，重新测量后纵向压缩减轻，首轮溢出不泄漏', async () => {
    const ungrouped = await columns([label('原始', { fit: { steps: ['tightenSpacing', 'compressGlyphs'] } })], [10]);
    const result = await columns([label('窄列'), label('宽列')], [7, 20]);
    expect(result.problems).toEqual([]);
    for (const node of texts(result)) {
      expect(node.text).toMatchObject({ shrinkGroup: '站名', fontSize: 7, compression: 1, overflow: false });
      expect(node.text!.fragments[0]!.fontSize).toBe(7);
      expect(node.text!.compression).toBeGreaterThan(texts(ungrouped)[0]!.text!.compression);
    }
    const expected = await columns(['窄列', '宽列'].map((name) => label(name, {
      fontSize: 7, fit: { steps: ['tightenSpacing', 'compressGlyphs'] },
    })), [7, 20]);
    expect(result.image!.bytes).toEqual(expected.image!.bytes);
  });

  it('竖排文本含不同字号片段时，缩字组按比例同步缩放各片段 fontSize（M244）', async () => {
    const mixedContent = [
      { text: '田贝', font: 'res:font-hei-bold', fontSize: 10 },
      { text: '（北门）', font: 'res:font-hei-regular', fontSize: 7 },
    ];
    const unshrunk = await columns([label('主副站名', { content: mixedContent }), label('普通站名')], [15, 15], 73);
    expect(unshrunk.problems).toEqual([]);
    expect(texts(unshrunk)[0]!.text).toMatchObject({
      fontSize: 10,
      width: 10,
      fragments: [
        { text: '田贝', font: 'res:font-hei-bold', fontSize: 10 },
        { text: '（北门）', font: 'res:font-hei-regular', fontSize: 7 },
      ],
    });

    const shrunk = await columns([label('主副站名', { content: mixedContent }), label('窄列')], [15, 8], 73);
    expect(shrunk.problems).toEqual([]);
    expect(texts(shrunk).map((node) => node.text!.fontSize)).toEqual([8, 8]);
    expect(texts(shrunk)[0]!.text).toMatchObject({
      shrinkGroup: '站名',
      fontSize: 8,
      width: 8,
      overflow: false,
      fragments: [
        { text: '田贝', font: 'res:font-hei-bold', fontSize: 8 },
        { text: '（北门）', font: 'res:font-hei-regular', fontSize: 5.6 },
      ],
    });

    const expected = await columns(
      [
        label('主副站名', {
          fontSize: 8,
          content: [
            { text: '田贝', font: 'res:font-hei-bold', fontSize: 8 },
            { text: '（北门）', font: 'res:font-hei-regular', fontSize: 5.6 },
          ],
          fit: { steps: ['tightenSpacing', 'compressGlyphs'] },
        }),
        label('窄列', { fontSize: 8, fit: { steps: ['tightenSpacing', 'compressGlyphs'] } }),
      ],
      [15, 8],
      73,
    );
    expect(shrunk.image!.bytes).toEqual(expected.image!.bytes);
  });

  it('同组取最高字号下限，低于下限仍放不下时报严重问题，即使 onFail 为 hint', async () => {
    const result = await columns([label('窄列', { fit: { ...fit(), onFail: 'hint' } }), label('高下限', { fit: fit('站名', 7) })], [4, 20]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([7, 7]);
    expect(result.problems).toEqual([expect.objectContaining({ code: ProblemCodes.layoutTextOverflow, level: 'severe',
      location: { kind: 'element', path: '文字实验/窄列' } })]);
    expect(result.image).toBeUndefined();
    const draft = await columns([label('窄列'), label('宽列')], [4, 20], 65, 'draft');
    expect(texts(draft).map((node) => node.text!.fontSize)).toEqual([5, 5]);
    expect(draft.image).toBeDefined();
  });

  it('组名隔离；同组不同原始字号取较小值，不放大', async () => {
    const result = await columns([label('甲', { fontSize: 12 }), label('乙', { fontSize: 9 }),
      label('另一组', { fit: fit('另一组') })], [30, 30, 30], 100);
    expect(result.problems).toEqual([]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([9, 9, 10]);
  });

  it('列宽先扣文本内边距，精确到毫米小数后统一字号', async () => {
    const result = await columns([label('带内边距', { padding: { left: 1.2, right: 1.3 } }), label('宽列')], [8.75, 20]);
    expect(result.problems).toEqual([]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([6.25, 6.25]);
  });

  it.each(['free', 'grid'])('%s 布局中随内容文本受可用宽度约束，第二轮更新自然高度', async (mode) => {
    const workspace = await textLab([], { layout: mode === 'free' ? { mode } : { mode, columns: [{ fraction: 1 }], rows: [{ fraction: 1 }] },
      children: [label('随内容', { verticalAlign: 'top', content: [{ text: '田贝' }],
        place: { width: 'hug', height: 'hug', ...(mode === 'free' ? { left: 1 } : { row: 1, column: 1 }) } })] });
    const result = await render(workspace, textLabRequest({}, mode === 'free' ? 8 : 7, 65));
    expect(result.problems).toEqual([]);
    expect(texts(result)[0]).toMatchObject({ width: 7, height: 14, text: { fontSize: 7, compression: 1 } });
  });

  it('隐藏成员及隐藏祖先不参与计算，空文本仍按可见文本框参与', async () => {
    const result = await columns([label('可见'), label('隐藏', { visible: false }),
      { type: 'container', name: '隐藏容器', visible: false, children: [label('隐藏后代')] },
      label('空文本', { content: [] })], [20, 1, 1, 8]);
    expect(result.problems).toEqual([]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([8, 8]);
  });

  it('组内原始字号小于最高下限时报告配置错误', async () => {
    const result = await columns([label('较小', { fontSize: 6 }), label('较大', { fit: fit('站名', 7) })], [20, 20]);
    expect(result.problems.some((p) => p.code === ProblemCodes.templateInvalid && p.message.includes('最小字号'))).toBe(true);
    expect(result.image).toBeUndefined();
  });

  it('很长的站名只按纵向压缩，不能因高度不足降低全组字号', async () => {
    const result = await columns([label('超长', { content: [{ text: '田'.repeat(20) }] }), label('短')], [15, 15]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([10, 10]);
    expect(result.problems.map((p) => p.code)).toEqual([ProblemCodes.layoutTextOverflow]);
  });

  it('仅高度不足仍遵循原有 onFail，缩字组不覆盖竖排的提示等级', async () => {
    const result = await columns([label('超长', { content: [{ text: '田'.repeat(20) }], fit: { ...fit(), onFail: 'hint' } })], [15]);
    expect(result.problems.map((p) => [p.code, p.level])).toEqual([[ProblemCodes.layoutTextOverflow, 'hint']]);
    expect(texts(result)[0]!.text!.fontSize).toBe(10);
    expect(result.image).toBeDefined();
  });

  it.each([
    null, {}, { shrinkGroup: '' }, { shrinkGroup: ' g ' }, { shrinkGroup: 3 },
    { shrinkGroup: 'g', minFontSize: 4 }, { shrinkGroup: 'g', minFontSize: '5' }, { shrinkGroup: 'g', typo: true },
  ])('非法配置静态拒绝：%j', async (widthOverflow) => {
    const result = await columns([label('非法', { fit: { ...fit(), widthOverflow } })], [20]);
    expect(result.layout).toBeUndefined();
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('横排不能使用按列宽缩字组', async () => {
    const result = await columns([label('横排', { writingMode: 'horizontal', verticalAlign: 'top', fit: { widthOverflow: { shrinkGroup: 'g' } } })], [20]);
    expect(result.problems.map((p) => p.code)).toContain(ProblemCodes.templateInvalid);
    expect(result.layout).toBeUndefined();
  });
});

describe('缩字组的下限取画板的值（M238）', () => {
  const grouped = { steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: '站名' }, compressMin: 0.6 };
  const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
  async function lowered(widths: number[], artboard: Record<string, unknown>): Promise<RenderResult> {
    const workspace = await textLab([], { fill: '#FFFFFF', ...artboard, layout: { mode: 'grid', columns: widths.map((fixed) => ({ fixed })), rows: [{ fraction: 1 }] },
      children: widths.map((_w, i) => label(`列${i + 1}`, { fit: grouped, place: { column: i + 1, row: 1, width: 'fill', height: 'fill' } })) });
    return render(workspace, { ...textLabRequest({}, widths.reduce((a, b) => a + b, 0), 65, 120), mode: 'draft' });
  }

  it('画板写 3 mm 时全组可缩到 5 mm 以下；不写时仍停在 5 mm', async () => {
    const result = await lowered([4, 20], { minFontSize: 3 });
    expect(result.problems).toEqual([]);
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([4, 4]);
    expect(texts(await lowered([4, 20], {})).map((node) => node.text!.fontSize)).toEqual([5, 5]);
  });

  it('缩字组的下限低于画板的值时静态拒绝', async () => {
    const workspace = await textLab([], { minFontSize: 4, children: [label('站名', { fit: { ...grouped, widthOverflow: { shrinkGroup: '站名', minFontSize: 3 } } })] });
    const result = await render(workspace, { ...textLabRequest({}, 20, 65, 120), mode: 'draft' });
    expect(result.problems).toContainEqual(expect.objectContaining({ code: ProblemCodes.templateInvalid,
      message: 'widthOverflow.minFontSize 不能低于画板的 minFontSize 4 mm（M238）' }));
  });

  it('跨模板的缩字组取各成员下限中最高的，到了下限仍放不下时写明组名与下限', async () => {
    let workspace = await textLab([], { fill: '#FFFFFF', minFontSize: 3, layout: { mode: 'grid', columns: [{ fixed: 3.5 }, { fixed: 20 }], rows: [{ fraction: 1 }] },
      children: [label('主站名', { fit: grouped, place: { column: 1, row: 1, width: 'fill', height: 'fill' } }),
        { type: 'call', name: '调用', template: '子模板', data: 'none', place: { column: 2, row: 1 } }] });
    workspace = { ...workspace, templates: [...workspace.templates, { name: '子模板', document: { dslVersion: 'renderweave-template/1', name: '子模板',
      base: { name: '空数据定义', version: 1 }, artboard: { sizeRange: range, minFontSize: 4, children: [label('子站名', { fit: grouped })] } } }] };
    const result = await render(workspace, { ...textLabRequest({}, 23.5, 65, 120), mode: 'draft' });
    expect(texts(result).map((node) => node.text!.fontSize)).toEqual([4, 4]);
    expect(result.problems.map((p) => [p.location, p.message])).toEqual([[{ kind: 'element', path: '文字实验/主站名' },
      '竖排文字"田田田田田田田田"放不下：字号 4 mm 比可用宽 3.5 mm 更宽（缩字组 站名 已到最小字号 4 mm）']]);
  });
});

async function calledWorkspace(): Promise<Workspace> {
  const workspace = await textLab([{ name: 'items', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '站点实验', version: 1 } } }],
    { layout: { mode: 'stack', direction: 'row' }, children: [
      { type: 'loop', name: '站点列', list: { var: 'items' }, template: '站点', itemLayout: { direction: 'row', widths: 'equal' }, place: { width: 'fill', height: 'fill' } },
      { type: 'call', name: '独立调用', template: '固定文本', data: 'none', place: { width: { fixed: 20 }, height: 'fill' } },
    ] });
  const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
  return { ...workspace, templates: [...workspace.templates,
    { name: '站点', document: { dslVersion: 'renderweave-template/1', name: '站点', base: { name: '站点实验', version: 1 },
      artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'column', alignItems: 'center' }, children: [
        { type: 'container', name: '背景', fill: '#FFFF00', padding: { left: 1, right: 1 }, place: { width: 'hug', height: 'fill' },
          layout: { mode: 'stack', direction: 'column', alignItems: 'center' }, children: [
            label('站名', { content: [{ slot: 'name' }], place: { width: 'hug', height: 'fill' } }),
          ] },
      ] } } },
    { name: '固定文本', document: { dslVersion: 'renderweave-template/1', name: '固定文本', base: { name: '空数据定义', version: 1 },
      artboard: { sizeRange: range, children: [label('站名')] } } },
  ] };
}

describe('跨循环与子模板的缩字组', () => {
  it('随内容的祖先受列宽约束，内边距扣除后全组统一，并重算背景自然宽度', async () => {
    const workspace = await calledWorkspace();
    const request = textLabRequest({ items: [{ name: '田贝' }, { name: '东门' }] }, 36, 65);
    const result = await render(workspace, request);
    expect(result.problems).toEqual([]);
    expect(texts(result).map((node) => [node.path, node.text!.fontSize])).toEqual([
      ['文字实验/站点列[1]/背景/站名', 6], ['文字实验/站点列[2]/背景/站名', 6], ['文字实验/独立调用/站名', 6],
    ]);
    expect(flatten(result.layout!.root).filter((node) => node.name === '背景').map((node) => node.width)).toEqual([8, 8]);
    const wide = await render(workspace, { ...request, output: { width: 80, height: 65, dpi: 120, format: 'png' } });
    expect(wide.problems).toEqual([]);
    expect(texts(wide).map((node) => node.text!.fontSize)).toEqual([10, 10, 10]);
    const repeated = await render(workspace, request);
    expect(repeated.layout).toEqual(result.layout);
    expect(repeated.image!.bytes).toEqual(result.image!.bytes);
  });
});

describe('站点密度：先收窄列间留白，放不下才全组缩字', () => {
  it.each([2, 20, 35, 50])('%d 站在 740/1500 mm 宽均保持 10 mm 字号', async (count) => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const doc = structuredClone(workspace.datasets[0]!.document) as any;
    doc.data.stops = Array.from({ length: count }, () => ({ name: '田贝', road: '建设路' }));
    for (const width of [740, 1500]) {
      const result = await render(workspace, { template: '标准线路单边', dataset: { inline: doc }, parameters: { currentIndex: 1 },
        output: { width, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
      expect(result.problems).toEqual([]);
      const names = texts(result).filter((node) => node.name === '站名');
      expect(names).toHaveLength(count);
      expect(new Set(names.map((node) => node.text!.fontSize))).toEqual(new Set([10]));
      expect(names.every((node) => node.text!.shrinkGroup === 'stopNames')).toBe(true);
    }
  });

  it('59 站只在列宽不足时微缩；加宽后恢复 10 mm，v1 的 50 站约束保持不变', async () => {
    let workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const previous = workspace.staticSchemas.find((entry) => entry.ref.name === '线路牌')!;
    const definition = structuredClone(previous.definition) as any;
    delete definition.version;
    delete definition.fields.find((field: any) => field.name === 'stops').constraints.maxItems;
    const next = publishStaticSchema(definition, workspace.staticSchemas);
    expect(next.problems).toEqual([]);
    expect(next.published!.ref.version).toBe(2);
    workspace = { ...workspace, staticSchemas: [...workspace.staticSchemas, next.published!] };
    workspace = withTemplate(workspace, '标准线路单边', (document) => {
      document['base'] = next.published!.ref;
      delete document['parameters'].find((parameter: any) => parameter.name === 'currentIndex').constraints.max;
    });
    const doc = structuredClone(workspace.datasets[0]!.document) as any;
    doc.dataset.staticSchema = next.published!.ref;
    doc.data.stops = Array.from({ length: 59 }, () => ({ name: '田贝', road: '建设路' }));
    for (const width of [740, 1500]) {
      const result = await render(workspace, { template: '标准线路单边', dataset: { inline: doc }, parameters: { currentIndex: 59 },
        output: { width, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
      expect(result.problems).toEqual([]);
      const names = texts(result).filter((node) => node.name === '站名');
      expect(names).toHaveLength(59);
      expect(new Set(names.map((node) => node.text!.fontSize))).toEqual(new Set([width === 740 ? 9.763 : 10]));
      const pitch = names[1]!.x - names[0]!.x;
      expect(pitch).toBeCloseTo((width - 46) / 59, 2);
      expect(pitch - names[0]!.text!.fontSize).toBeGreaterThanOrEqual(1.99);
    }
    const oldWorkspace = withTemplate(workspace, '标准线路单边', (document) => { document['base'] = previous.ref; });
    doc.dataset.staticSchema = previous.ref;
    const rejected = await render(oldWorkspace, { template: '标准线路单边', dataset: { inline: doc }, parameters: { currentIndex: 1 },
      output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
    expect(rejected.problems.some((problem) => problem.code === ProblemCodes.datasetConstraintViolated &&
      problem.location.kind === 'field' && problem.location.path === 'stops')).toBe(true);
  });

  it('完整共享草稿直接出图，与票据 09 的图片一致', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const result = await render(workspace, { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 },
      output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
    expect(result.problems).toEqual([]);
    expect(new Set(texts(result).filter((node) => node.name === '站名').map((node) => node.text!.fontSize))).toEqual(new Set([10]));
    await expectMatchesGolden('m402-roads', result.image!.bytes);
  });

  it('50 站加宽名称区内边距，触发全组缩字；减到下限仍可正常出图', async () => {
    let workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    workspace = withTemplate(workspace, '站点', (document) => {
      const area = document['artboard']['children'].find((node: any) => node.name === '名称区');
      area.padding.left = 4; area.padding.right = 4;
      area.children = area.children.filter((node: any) => node.name === '站名');
    });
    const doc = structuredClone(workspace.datasets[0]!.document) as any;
    doc.data.stops = Array.from({ length: 50 }, () => ({ name: '田贝', road: '建设路' }));
    const result = await render(workspace, { template: '标准线路单边', dataset: { inline: doc }, parameters: { currentIndex: 1 },
      output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
    expect(result.problems).toEqual([]);
    expect(new Set(texts(result).filter((node) => node.name === '站名').map((node) => node.text!.fontSize))).toEqual(new Set([5.88]));
  });
});
