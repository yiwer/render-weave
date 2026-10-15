import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryResourceRepository, render, ProblemCodes, type LayoutNode, type RenderResult, type Workspace } from '../src/index.js';
import { resourcesDir, textLab, textLabRequest, withTemplate } from './support/fixtures.js';

const label = (extra: Record<string, unknown> = {}) => ({ type: 'text', name: '站名', font: 'res:subset', fontSize: 10,
  content: [{ text: 'A深田圳B' }], color: '#123456', place: { width: 'hug', height: 'hug' }, ...extra });
const request = textLabRequest({}, 100, 100, 120);
const flatten = (node: LayoutNode): LayoutNode[] => [node, ...(node.children ?? []).flatMap(flatten)];
const texts = (result: RenderResult) => flatten(result.layout!.root).filter((node) => node.text);
const summary = (result: RenderResult) => texts(result)[0]!.text!;
const codes = (result: RenderResult) => result.problems.map((p) => p.code);

async function workspace(children: unknown[], style = 'Regular'): Promise<Workspace> {
  const base = await textLab([], { fill: '#FFFFFF', children });
  const bytes = await readFile(join(resourcesDir, 'font-subsets', `TestSubset-${style}.otf`));
  const subset = createMemoryResourceRepository([{ id: 'subset', kind: 'font', bytes }]);
  return { ...base, resources: {
    get: (id) => id === 'subset' ? subset.get(id) : base.resources.get(id),
    read: (id) => id === 'subset' ? subset.read(id) : base.resources.read(id),
    list: () => [...base.resources.list(), ...subset.list()],
  } };
}

describe('缺字逐字替代', () => {
  it.each(['horizontal', 'vertical'])('%s 只替代缺字，原字与样式保留，像素等于显式指定对应字体', async (writingMode) => {
    const base = await workspace([label({ writingMode, ...(writingMode === 'horizontal' && { slant: 12 }),
      stroke: { color: '#FFFFFF', width: 0.3 } })]);
    const original = JSON.stringify(base.templates);
    const result = await render(base, request);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphFallback]);
    expect(result.problems[0]).toMatchObject({ level: 'hint', location: { kind: 'element', path: '文字实验/站名' } });
    expect(result.problems[0]!.message).toContain('"深" (U+6DF1)');
    expect(result.problems[0]!.message).toContain('"圳" (U+5733)');
    expect(summary(result)).toMatchObject({ content: 'A深田圳B', font: 'res:subset', fontFallback: true });
    expect(summary(result).fragments.map((f) => [f.text, f.font, f.sourceFont])).toEqual([
      ['A', 'res:subset', undefined], ['深', 'res:font-hei-regular', 'res:subset'], ['田', 'res:subset', undefined],
      ['圳', 'res:font-hei-regular', 'res:subset'], ['B', 'res:subset', undefined],
    ]);
    expect(summary(result).fragments.every((f) => f.fontSize === 10 && f.color === '#123456FF')).toBe(true);
    const reference = withTemplate(base, '文字实验', (doc) => {
      doc.artboard.children[0].font = 'res:font-hei-regular';
    });
    // 子集原有轮廓与完整字体相同，但字形 ID 已改变；用完整字体验证实际选字、测量和绘制。
    const expected = await render(reference, request);
    expect(expected.problems).toEqual([]);
    expect(result.image!.bytes).toEqual(expected.image!.bytes);
    expect(JSON.stringify(base.templates)).toBe(original);
    const repeated = await render(base, request);
    expect(repeated.layout).toEqual(result.layout);
    expect(repeated.problems).toEqual(result.problems);
    expect(repeated.image!.bytes).toEqual(result.image!.bytes);
  });

  it.each([['Regular', 'regular'], ['Medium', 'medium'], ['Bold', 'bold']])('读取 %s 的 OS/2 字重，选择 %s', async (style, expected) => {
    const result = await render(await workspace([label({ content: [{ text: '深' }] })], style), request);
    expect(summary(result).fragments[0]!.font).toBe(`res:font-hei-${expected}`);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphFallback]);
  });

  it('缺档选最近字重；等距离选较轻者，与配置顺序无关', async () => {
    const base = await workspace([label({ content: [{ text: '深' }] })], 'Medium');
    const closest = await render(base, request, { fallbackFonts: ['font-hei-bold', 'font-hei-regular', 'not-installed'] });
    expect(summary(closest).fragments[0]!.font).toBe('res:font-hei-regular');
    const bold = await workspace([label({ content: [{ text: '深' }] })], 'Bold');
    const tie = await render(bold, request, { fallbackFonts: ['font-hei-heavy', 'font-hei-medium'] });
    expect(summary(tie).fragments[0]!.font).toBe('res:font-hei-medium');
  });

  it.each(['horizontal', 'vertical'])('%s 同一元素合并重复缺字，成功和失败分别上报，正式失败、草稿有图', async (writingMode) => {
    const base = await workspace([label({ writingMode, content: [{ text: '深深\u{10FFFF}\u{10FFFF}' }] })]);
    const result = await render(base, request);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphFallback, ProblemCodes.textGlyphMissing]);
    expect(result.problems.map((p) => p.level)).toEqual(['hint', 'severe']);
    expect(result.problems[0]!.message.match(/U\+6DF1/g)).toHaveLength(1);
    expect(result.problems[1]!.message.match(/U\+10FFFF/g)).toHaveLength(1);
    expect(result.image).toBeUndefined();
    const draft = await render(base, { ...request, mode: 'draft' });
    expect(draft.image).toBeDefined();
    expect(draft.problems).toEqual(result.problems);
  });

  it('补充平面字符按码点替代，不把代理对拆成两个缺字', async () => {
    const result = await render(await workspace([label({ content: [{ text: 'A\u{1F100}B' }] })]), request);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphFallback]);
    expect(summary(result).fragments.map((f) => f.text)).toEqual(['A', '\u{1F100}', 'B']);
    expect(result.problems[0]!.message).toContain('U+1F100');
  });

  it('没有缺字、空串和空格不会触发后备字体读取或改变摘要', async () => {
    const base = await workspace([label({ content: [{ text: ' A田B ' }, { text: '' }] })]);
    const reads: string[] = [];
    const result = await render({ ...base, resources: { ...base.resources, read: async (id) => {
      reads.push(id); return base.resources.read(id);
    } } }, request);
    expect(reads).toEqual(['subset']);
    expect(result.problems).toEqual([]);
    expect(summary(result).fontFallback).toBeUndefined();
    expect(summary(result).fragments).toHaveLength(2);
  });

  it('原字体已是思源黑体时直接报缺字，不加载其他字重或重复读取', async () => {
    const base = await workspace([label({ font: 'res:font-hei-medium', content: [{ text: '\u{10FFFF}' }] })]);
    const reads: string[] = [];
    const result = await render({ ...base, resources: { ...base.resources, read: async (id) => {
      reads.push(id); return base.resources.read(id);
    } } }, request);
    expect(reads).toEqual(['font-hei-medium']);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphMissing]);
    expect(summary(result).fontFallback).toBeUndefined();
  });

  it.each([{ fallbackFonts: [] }, { fallbackFonts: ['not-installed'] }, { fallbackFonts: ['subset'] }])('后备配置 $fallbackFonts 无法替代时报告严重问题', async ({ fallbackFonts }) => {
    const result = await render(await workspace([label()]), request, { fallbackFonts });
    expect(codes(result)).toEqual([ProblemCodes.textGlyphMissing]);
    expect(result.image).toBeUndefined();
    expect(summary(result).fontFallback).toBeUndefined();
  });

  it('隐藏元素及隐藏祖先中的缺字不检查', async () => {
    const result = await render(await workspace([label({ visible: false }),
      { type: 'container', name: '隐藏容器', visible: false, children: [label({ name: '内部站名' })] }]), request);
    expect(result.problems).toEqual([]);
    expect(result.image).toBeDefined();
  });

  it('片段颜色、字号、倾斜和原字体分别保留，邻接缺字合并', async () => {
    const result = await render(await workspace([label({ content: [
      { text: 'A深圳', color: '#FF0000', fontSize: 7, slant: -12 },
      { text: '深田', font: 'res:font-hei-bold', color: '#0000FF', fontSize: 12 },
    ] })]), request);
    expect(summary(result).fragments).toEqual([
      { text: 'A', font: 'res:subset', fontSize: 7, color: '#FF0000FF', slant: -12 },
      { text: '深圳', font: 'res:font-hei-regular', sourceFont: 'res:subset', fontSize: 7, color: '#FF0000FF', slant: -12 },
      { text: '深田', font: 'res:font-hei-bold', fontSize: 12, color: '#0000FFFF', slant: 0 },
    ]);
  });

  it('缩字组重排保留替代字体与标识，提示只报一次', async () => {
    const base = await workspace([label({ writingMode: 'vertical', place: { width: { fixed: 7 }, height: { fixed: 60 } },
      fit: { widthOverflow: { shrinkGroup: '站名' } } })]);
    const result = await render(base, request);
    expect(codes(result)).toEqual([ProblemCodes.textGlyphFallback]);
    expect(summary(result)).toMatchObject({ fontFallback: true, shrinkGroup: '站名', fontSize: 7 });
    expect(summary(result).fragments.every((f) => f.fontSize === 7)).toBe(true);
  });

  it('循环中的插槽缺字按实例路径报告', async () => {
    const base = await workspace([]);
    const loop = await textLab([{ name: 'items', displayName: '站点', type: 'list', items: { type: 'ref', ref: { name: '站点实验', version: 1 } } }],
      { children: [{ type: 'loop', name: '站点列', list: { var: 'items' }, template: '站点', args: {},
        itemLayout: { direction: 'row', widths: 'equal' }, place: { width: 'fill', height: 'fill' } }] });
    const document = { dslVersion: 'renderweave-template/1', name: '站点', base: { name: '站点实验', version: 1 },
      artboard: { sizeRange: { width: { min: 1, max: 100 }, height: { min: 1, max: 100 } },
        children: [label({ content: [{ slot: 'name' }] })] } };
    const result = await render({ ...loop, resources: base.resources, templates: [...loop.templates, { name: '站点', document }] },
      textLabRequest({ items: [{ name: '田' }, { name: '深' }, { name: '\u{10FFFF}' }] }, 100, 100));
    expect(result.problems.map((p) => [p.code, p.location])).toEqual([
      [ProblemCodes.textGlyphFallback, { kind: 'element', path: '文字实验/站点列[2]/站名' }],
      [ProblemCodes.textGlyphMissing, { kind: 'element', path: '文字实验/站点列[3]/站名' }],
    ]);
  });
});
