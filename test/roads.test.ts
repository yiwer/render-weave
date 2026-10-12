import { describe, expect, it } from 'vitest';
import { loadWorkspace, publishStaticSchema, render, ProblemCodes, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir, textLab, textLabRequest, withTemplate } from './support/fixtures.js';
import { expectMatchesGolden } from './support/golden.js';

const range = { width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } };
const ref = (name: string) => ({ name, version: 1 });
const text = (name: string, slot: string) => ({ type: 'text', name, content: [{ slot }], font: 'res:font-hei-medium',
  fontSize: 5, color: '#333333', place: { width: 'hug', height: 'hug' } });
const param = (name: string, type = 'number') => ({ name, displayName: name, type, visibility: 'public' });
const loop = (extra: Record<string, unknown> = {}) => ({ type: 'loop', name: '合并', list: { var: 'items' }, template: '组', mergeBy: 'name',
  itemLayout: { direction: 'row', widths: 'equal', spanBy: 'groupSize', gap: 2 },
  place: { width: 'fill', height: 'fill' }, ...extra });
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const named = (result: RenderResult, name: string) => flatten(result.layout!.root).find((node) => node.name === name)!;

async function lab(extra: Record<string, unknown> = {}, children: unknown[] = [text('组名', 'name')], declarations = {}): Promise<Workspace> {
  const workspace = await textLab([{ name: 'items', displayName: '列表', type: 'list', items: { type: 'ref', ref: ref('站点实验') } }],
    { children: [loop(extra)] });
  return { ...workspace, templates: [...workspace.templates, { name: '组', document: {
    dslVersion: 'renderweave-template/1', name: '组', base: ref('站点实验'), ...declarations,
    artboard: { sizeRange: range, layout: { mode: 'stack', direction: 'row' }, children },
  } }] };
}

describe('合并相邻同值项', () => {
  it('只合并相邻项，按原始列跨宽；路径与循环信息保留原始序号', async () => {
    const keys = ['index', 'count', 'groupSize', 'isFirst', 'isLast'];
    const workspace = await lab({ args: Object.fromEntries(keys.map((key) => [key, { loop: key }])) },
      keys.map((key) => key.startsWith('is')
        ? { type: 'rect', name: key, visible: { var: key }, fill: '#FF0000', place: { width: { fixed: 1 }, height: { fixed: 1 } } }
        : text(key, key)), { parameters: keys.map((key) => param(key, key.startsWith('is') ? 'boolean' : 'number')) });
    const result = await render(workspace, textLabRequest({ items: ['甲', '甲', '乙', '甲'].map((name) => ({ name })) }, 206, 15));
    expect(result.problems).toEqual([]);
    const groups = named(result, '合并').children!;
    expect(groups.map((node) => [node.path, node.x, node.width])).toEqual([
      ['文字实验/合并[1]', 0, 102], ['文字实验/合并[3]', 104, 50], ['文字实验/合并[4]', 156, 50],
    ]);
    expect(groups.map((node) => node.children!.slice(0, 3).map((child) => child.text!.content))).toEqual([
      ['1', '4', '2'], ['3', '4', '1'], ['4', '4', '1'],
    ]);
    expect(groups.map((node) => node.children![3]!.visible)).toEqual([true, false, false]);
    expect(groups.map((node) => node.children![4]!.visible)).toEqual([false, false, true]);
  });

  it('缺值各自成组，空文本是有效同值键；不合并时 groupSize 为 1', async () => {
    const data = { items: [{}, {}, { name: '' }, { name: '' }, { name: '甲' }] };
    const result = await render(await lab({}, []), textLabRequest(data, 108, 10));
    expect(result.problems).toEqual([]);
    expect(named(result, '合并').children!.map((node) => [node.path, node.width])).toEqual([
      ['文字实验/合并[1]', 20], ['文字实验/合并[2]', 20], ['文字实验/合并[3]', 42], ['文字实验/合并[5]', 20],
    ]);
    const plain = await lab({ mergeBy: undefined, itemLayout: { direction: 'row', widths: 'equal' }, args: { size: { loop: 'groupSize' } } },
      [text('项数', 'size')], { parameters: [param('size')] });
    const unmerged = await render(plain, textLabRequest({ items: [{ name: '甲' }, { name: '甲' }] }, 40, 10));
    expect(unmerged.problems).toEqual([]);
    expect(named(unmerged, '合并').children!.map((node) => node.children![0]!.text!.content)).toEqual(['1', '1']);
  });

  it.each([{ items: [] }, { items: [{ name: '甲' }] }])('空列表或单项没有多余空隙：%j', async ({ items }) => {
    const result = await render(await lab(), textLabRequest({ items }, 40, 10));
    expect(result.problems).toEqual([]);
    const groups = named(result, '合并').children!;
    expect(groups).toHaveLength(items.length);
    if (items.length) expect(groups[0]!.width).toBe(40);
  });

  it('随内容仍按原始列等分计算，最长组决定所需列宽', async () => {
    const result = await render(await lab({ place: { width: 'hug', height: 'fill' } }),
      textLabRequest({ items: [{ name: '甲' }, { name: '甲' }, { name: '乙丙丁' }] }, 100, 10));
    expect(result.problems).toEqual([]);
    const merged = named(result, '合并');
    expect(merged.width).toBeCloseTo(49, 2);
    expect(merged.children![0]!.width).toBeCloseTo(32, 2);
    expect(merged.children![1]!.width).toBeCloseTo(15, 2);
  });

  it('可沿单引用字段合并，使用首项数据；布尔 false 与数值 0 都是有效键', async () => {
    for (const type of ['boolean', 'number']) {
      let workspace = await lab({ mergeBy: 'detail.key' }, [text('组名', 'name')]);
      const detail = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '细节', displayName: '细节',
        fields: [{ name: 'key', displayName: '键', type }] }, workspace.staticSchemas).published!;
      const station = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '新项', displayName: '新项', fields: [
        { name: 'name', displayName: '名称', type: 'text' }, { name: 'detail', displayName: '细节', type: 'ref', ref: ref('细节') },
      ] }, [...workspace.staticSchemas, detail]).published!;
      const root = publishStaticSchema({ dslVersion: 'renderweave-schema/1', name: '新根', displayName: '新根', fields: [
        { name: 'items', displayName: '列表', type: 'list', items: { type: 'ref', ref: ref('新项') } },
      ] }, [...workspace.staticSchemas, detail, station]).published!;
      workspace = { ...workspace, staticSchemas: [...workspace.staticSchemas, detail, station, root] };
      workspace = withTemplate(workspace, '组', (document) => { document['base'] = ref('新项'); });
      workspace = withTemplate(workspace, '文字实验', (document) => { document['base'] = ref('新根'); });
      const value = type === 'boolean' ? false : 0;
      const request = { ...textLabRequest({}, 40, 10), dataset: { inline: { dataset: { staticSchema: ref('新根') },
        data: { items: [{ name: '首', detail: { key: value } }, { name: '次', detail: { key: value } }] } } } };
      const result = await render(workspace, request);
      expect(result.problems).toEqual([]);
      expect(named(result, '合并').children).toHaveLength(1);
      expect(named(result, '组名').text!.content).toBe('首');
    }
  });

  it.each([
    { mergeBy: 'unknown' }, { mergeBy: 'name.unknown' }, { mergeBy: '' },
    { itemLayout: { direction: 'row', widths: 'content', spanBy: 'groupSize' } },
    { itemLayout: { direction: 'row', widths: 'equal' } },
    { mergeBy: undefined },
  ])('非法合并规则静态报告，即使循环隐藏：%j', async (extra) => {
    const result = await render(await lab({ ...extra, visible: false }), textLabRequest({}, 40, 10));
    expect(result.problems.some((problem) => problem.code === ProblemCodes.templateInvalid || problem.code === ProblemCodes.templateTypeMismatch)).toBe(true);
    expect(result.layout).toBeUndefined();
  });
});

describe('M402 道路带', () => {
  it('15 段边界对齐原始 35 站，首段无分隔线，完整图片与 golden 一致', async () => {
    let workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const strip = (node: Record<string, any>) => {
      if (typeof node['fit'] === 'object') delete node['fit']['widthOverflow'];
      node['children']?.forEach(strip);
    };
    for (const name of ['标准线路单边', '站点']) workspace = withTemplate(workspace, name, (document) => strip(document['artboard']));
    const result = await render(workspace, { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' },
      parameters: { currentIndex: 5 }, output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'final' });
    expect(result.problems).toEqual([]);
    const groups = named(result, '道路段列').children!;
    const stations = named(result, '站点列').children!;
    expect(groups).toHaveLength(15);
    expect(stations).toHaveLength(35);
    const firstIndices = groups.map((node) => Number(node.path.match(/\[(\d+)\]$/)![1]) - 1);
    expect(firstIndices.map((index) => index + 1)).toEqual([1, 4, 5, 6, 8, 10, 11, 14, 22, 23, 25, 28, 29, 34, 35]);
    for (const [i, group] of groups.entries()) {
      const first = stations[firstIndices[i]!]!;
      const last = stations[(firstIndices[i + 1] ?? 35) - 1]!;
      expect(group.x).toBeCloseTo(first.x, 3);
      expect(group.x + group.width).toBeCloseTo(last.x + last.width, 2);
      expect(group.children!.find((node) => node.name === '分隔线')!.visible).toBe(i !== 0);
    }
    const names = flatten(result.layout!.root).filter((node) => node.name === '道路名');
    expect(names.every((node) => node.text!.spacing >= 0 && !node.text!.overflow)).toBe(true);
    expect(names.some((node) => node.text!.spacing > 10)).toBe(true);
    // 道路名左右各 2 mm 内边距；余宽包含两侧与字间同样大小的留白（M131）。
    for (const node of names) expect(node.text!.width + 2 * node.text!.spacing).toBeCloseTo(node.width - 4, 2);
    await expectMatchesGolden('m402-roads', result.image!.bytes);
  });
});
