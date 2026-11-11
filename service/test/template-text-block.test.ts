/**
 * 文字一块与适配摘要（模板设计页第三轮票据 04）：字体族与字重两个下拉写什么引用、适配收成的一行怎么说、
 * 换书写方向之后写回的文档由引擎的 checkDslDocument 判断（只在另一个方向才合法的写法由 writeProperty 的 reconcile 去掉）。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../console/src/template/document.js';
import { fitDigest, fitLine } from '../console/src/template/fit.js';
import { familyOf, fontFamilies, fontInFamily } from '../console/src/template/fonts.js';
import { writeProperty } from '../console/src/template/properties.js';
import { checkDslDocument } from '../src/engine.js';
import { ALL_ELEMENTS_FILE } from './seed.js';

const NAME = '全元素牌', TEXT = `${NAME}/文字`;
let original: JsonObject;
const fresh = (): JsonObject => JSON.parse(JSON.stringify(original)) as JsonObject;
const severe = (document: unknown) => checkDslDocument(document).problems.filter((problem) => problem.level === 'severe');
const textOf = (document: JsonObject): JsonObject => ((document['artboard'] as JsonObject)['children'] as JsonObject[]).find((child) => child['name'] === '文字')!;
/** 依次写几项，每一步都不能多出严重问题。 */
const written = (document: JsonObject, ...writes: readonly (readonly [string[], unknown])[]): JsonObject => writes.reduce((current, [path, value]) => {
  const next = writeProperty(current, TEXT, path, value);
  expect(severe(next), path.join('.')).toEqual([]);
  return next;
}, document);

beforeAll(async () => {
  original = JSON.parse(await readFile(ALL_ELEMENTS_FILE, 'utf8')) as JsonObject;
  expect(severe(original)).toEqual([]);
});

describe('字体族与字重', () => {
  const families = fontFamilies(['font-hei-medium', 'font-hei-heavy', 'font-song-regular', 'font-song-heavy', 'font-kai', 'font-yuan-light', 'font-yuan-bold']);
  const family = (name: string) => families.find((item) => item.family === name)!;

  it('引用在哪一族；资源库里没有的不属于任何一族', () => {
    expect(familyOf(families, 'res:font-hei-heavy')?.family).toBe('hei');
    expect(familyOf(families, 'res:font-kai')?.family).toBe('kai');
    expect(familyOf(families, 'res:font-gone')).toBeUndefined();
  });

  it('换字体族：字重留着', () => {
    expect(fontInFamily(family('song'), 'Heavy')).toBe('res:font-song-heavy');
    expect(fontInFamily(family('hei'), 'Medium')).toBe('res:font-hei-medium');
  });

  it('这一族没有这个字重：取 Regular，再没有取最细的', () => {
    expect(fontInFamily(family('song'), 'Medium')).toBe('res:font-song-regular');
    expect(fontInFamily(family('kai'), 'Heavy')).toBe('res:font-kai');
    expect(fontInFamily(family('yuan'), 'Medium')).toBe('res:font-yuan-light');
    expect(fontInFamily(family('hei'), undefined)).toBe('res:font-hei-medium');
  });
});

describe('适配收成一行', () => {
  it('没写适配：不适配', () => {
    expect(fitDigest(undefined)).toEqual({ rule: '不适配', over: false });
    expect(fitDigest({})).toEqual({ rule: '不适配', over: false });
    expect(fitLine(fitDigest(undefined))).toBe('不适配');
  });

  it('适配顺序用箭头连起来，竖排有缩字组时带上组名', () => {
    expect(fitDigest({ steps: ['tightenSpacing', 'compressGlyphs'] }).rule).toBe('收紧字距 → 压缩字形');
    expect(fitDigest({ steps: ['compressGlyphs', 'shrink'], minFontSize: 6 }).rule).toBe('压缩字形 → 缩字');
    expect(fitDigest({ steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: 'stopNames' } }).rule).toBe('收紧字距 → 压缩字形 · 缩字组 stopNames');
    expect(fitDigest({ steps: [], widthOverflow: { shrinkGroup: 'stopNames', minFontSize: 5 } }).rule).toBe('不适配 · 缩字组 stopNames');
  });

  it('这一处的结果：没有压缩或压到几成，字号是排出来的', () => {
    const fit = { steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: 'stopNames' } };
    expect(fitLine(fitDigest(fit, { compression: 1, fontSize: 10, overflow: false }))).toBe('收紧字距 → 压缩字形 · 缩字组 stopNames · 这一处：没有压缩，字号 10 mm');
    expect(fitDigest(fit, { compression: 0.7421, fontSize: 8.126, overflow: false })).toEqual({ rule: '收紧字距 → 压缩字形 · 缩字组 stopNames', result: '这一处：压到 74%，字号 8.13 mm', over: false });
  });

  it('仍放不下：结果里写明，并且标出来', () => {
    expect(fitDigest({ steps: ['tightenSpacing'] }, { compression: 1, fontSize: 4, overflow: true })).toEqual({ rule: '收紧字距', result: '这一处：没有压缩，字号 4 mm，仍放不下', over: true });
  });
});

describe('文字一块的写回', () => {
  it('书写方向、水平对齐、垂直对齐各写各的键，文档没有严重问题', () => {
    const next = written(fresh(), [['writingMode'], 'vertical'], [['verticalAlign'], 'distribute'], [['horizontalAlign'], 'center']);
    expect(textOf(next)).toMatchObject({ writingMode: 'vertical', verticalAlign: 'distribute', horizontalAlign: 'center' });
    expect(Object.keys(textOf(next)).sort()).toEqual([...Object.keys(textOf(original)), 'writingMode', 'verticalAlign'].sort());
  });

  it('换成竖排：水平对齐的分散、均分回到缺省，倾斜去掉', () => {
    for (const align of ['distribute', 'spaceEvenly']) {
      const next = written(fresh(), [['horizontalAlign'], align], [['slant'], 8], [['writingMode'], 'vertical']);
      expect(textOf(next)).not.toHaveProperty('horizontalAlign');
      expect(textOf(next)).not.toHaveProperty('slant');
    }
    // 居中在两个方向都有，留着。
    expect(textOf(written(fresh(), [['horizontalAlign'], 'center'], [['writingMode'], 'vertical']))['horizontalAlign']).toBe('center');
  });

  it('换成竖排：带缩字的适配顺序与缩字下限去掉（回到不适配），别的键留着；竖排也合法的顺序不动', () => {
    const shrunk = written(fresh(), [['fit'], { steps: ['compressGlyphs', 'shrink'], compressMin: 0.8, minFontSize: 6, onFail: 'hint' }], [['writingMode'], 'vertical']);
    expect(textOf(shrunk)['fit']).toEqual({ compressMin: 0.8, onFail: 'hint' });
    const kept = written(fresh(), [['writingMode'], 'vertical']);
    expect(textOf(kept)['fit']).toEqual(textOf(original)['fit']);
  });

  it('片段上的倾斜也去掉，文字和别的样式留着', () => {
    const content = [{ text: '甲', slant: 10, color: '#FF0000' }, { text: '乙' }];
    const next = written(fresh(), [['content'], content], [['writingMode'], 'vertical']);
    expect(textOf(next)['content']).toEqual([{ text: '甲', color: '#FF0000' }, { text: '乙' }]);
  });

  it('换回横排：垂直对齐的分散回到缺省，缩字组去掉', () => {
    const vertical = written(fresh(), [['writingMode'], 'vertical'], [['verticalAlign'], 'distribute'],
      [['fit'], { steps: ['tightenSpacing', 'compressGlyphs'], widthOverflow: { shrinkGroup: 'stopNames', minFontSize: 5 } }]);
    const next = written(vertical, [['writingMode'], 'horizontal']);
    expect(textOf(next)).not.toHaveProperty('verticalAlign');
    expect(textOf(next)['fit']).toEqual({ steps: ['tightenSpacing', 'compressGlyphs'] });
    // 下对齐两个方向都有，留着。
    expect(textOf(written(fresh(), [['verticalAlign'], 'bottom'], [['writingMode'], 'vertical'], [['writingMode'], 'horizontal']))['verticalAlign']).toBe('bottom');
  });

  it('横排点一下横排、去掉书写方向：别的都不动', () => {
    const same = written(fresh(), [['writingMode'], 'horizontal']);
    expect({ ...textOf(same), writingMode: undefined }).toEqual({ ...textOf(original), writingMode: undefined });
    expect(written(same, [['writingMode'], undefined])).toEqual(original);
  });

  it('不是文字的元素写不到这条路上：原样', () => {
    const next = writeProperty(fresh(), `${NAME}/容器`, ['layout'], { mode: 'free' });
    expect(severe(next)).toEqual([]);
  });
});
