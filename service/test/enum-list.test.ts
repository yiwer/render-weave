/**
 * 可选值列表（M390）：每一项的文字与文档里的 enum 互相转换。只经纯函数这个接缝，不开页面；页面上的增删移动在 console-suite.ts。
 */
import { describe, expect, it } from 'vitest';
import { duplicateIndexes, enumTexts, enumValue, pastedLines } from '../console/src/form/enum-list.js';

describe('可选值列表', () => {
  it('读：文档里的 enum 读成文字，没有就是空的', () => {
    expect(enumTexts(['甲', '乙'])).toEqual(['甲', '乙']);
    expect(enumTexts([1, 2.5])).toEqual(['1', '2.5']);
    expect(enumTexts(undefined)).toEqual([]);
    expect(enumTexts('甲')).toEqual([]);
  });

  it('写：去掉首尾空白，空的项不算，一项都没有就是没有这条约束', () => {
    expect(enumValue([' 甲 ', '', '  ', '乙'], false)).toEqual(['甲', '乙']);
    expect(enumValue(['', ' '], false)).toBeUndefined();
    expect(enumValue([], false)).toBeUndefined();
  });

  it('写：顺序照页面上的；文本枚举里的数字还是文字', () => {
    expect(enumValue(['乙', '甲'], false)).toEqual(['乙', '甲']);
    expect(enumValue(['1', '2'], false)).toEqual(['1', '2']);
  });

  it('数值枚举写成数值，读不成数的原样写回，由服务端报问题', () => {
    expect(enumValue(['1', ' 2.5 ', '-3'], true)).toEqual([1, 2.5, -3]);
    expect(enumValue(['1', '一'], true)).toEqual([1, '一']);
  });

  it('重复：标后面那一项；空的项不算；数值按值比，文本按字比', () => {
    expect([...duplicateIndexes(['甲', '乙', '甲', '甲'], false)]).toEqual([2, 3]);
    expect([...duplicateIndexes(['', ' ', '甲'], false)]).toEqual([]);
    expect([...duplicateIndexes([' 甲', '甲 '], false)]).toEqual([1]);
    expect([...duplicateIndexes(['1', '1.0'], true)]).toEqual([1]);
    expect([...duplicateIndexes(['1', '1.0'], false)]).toEqual([]);
  });

  it('粘贴：按行拆开，各种换行都认，去掉空行', () => {
    expect(pastedLines('甲\n乙\r\n\r\n 丙 \r丁')).toEqual(['甲', '乙', '丙', '丁']);
    expect(pastedLines('只有一项')).toEqual(['只有一项']);
    expect(pastedLines('\n\n')).toEqual([]);
  });
});
