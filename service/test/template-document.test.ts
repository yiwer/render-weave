/**
 * 模板文档的读取（模板设计页票据 04）：图上点到哪些元素、上一层是谁、为什么不显示。纯函数，入口与页面用的相同。
 */
import { describe, expect, it } from 'vitest';
import { hiddenReason, hitStack, parentInstance } from '../console/src/template/document.js';
import type { LayoutNode } from '../console/src/types.js';

const node = (path: string, x: number, y: number, width: number, height: number, children?: LayoutNode[], visible = true): LayoutNode => ({
  path, name: path.split('/').at(-1)!, type: children ? 'container' : 'text', x, y, width, height, visible, ...(children ? { children } : {}),
});

describe('hitStack', () => {
  const root = node('牌', 0, 0, 100, 100, [
    node('牌/底', 0, 0, 100, 50, [node('牌/底/字', 10, 10, 20, 10)]),
    node('牌/盖', 5, 5, 50, 30),
    node('牌/藏', 0, 0, 100, 100, [node('牌/藏/里', 0, 0, 100, 100)], false),
  ]);

  it('最深、最后画的在前，画板在最后；隐藏的元素连同子元素都不算', () => {
    expect(hitStack(root, 15, 15).map((item) => item.path)).toEqual(['牌/盖', '牌/底/字', '牌/底', '牌']);
    expect(hitStack(root, 90, 90).map((item) => item.path)).toEqual(['牌']);
    expect(hitStack(root, 200, 200)).toEqual([]);
  });
});

describe('parentInstance', () => {
  it('循环项的上一层是循环容器，循环容器的上一层是路径的上一段，画板没有上一层', () => {
    expect(parentInstance('牌/面板/列[12]/名称/站名')).toBe('牌/面板/列[12]/名称');
    expect(parentInstance('牌/面板/列[12]')).toBe('牌/面板/列');
    expect(parentInstance('牌/面板/列')).toBe('牌/面板');
    expect(parentInstance('牌')).toBeUndefined();
  });
});

describe('hiddenReason', () => {
  const document = { artboard: { children: [
    { type: 'text', name: '绑定', visible: { var: 'hasFare' } },
    { type: 'text', name: '关掉', visible: false },
    { type: 'container', name: '外层', visible: { var: 'showOuter' }, children: [{ type: 'text', name: '里面' }] },
    { type: 'text', name: '普通' },
  ] } };

  it('说清是自身还是上一层、按变量还是设成了否', () => {
    expect(hiddenReason(document, '牌/绑定')).toContain('这个元素按变量 hasFare 决定显示');
    expect(hiddenReason(document, '牌/关掉')).toContain('这个元素的显示设为否');
    expect(hiddenReason(document, '牌/外层/里面')).toContain('上一层「外层」按变量 showOuter 决定显示');
    expect(hiddenReason(document, '牌/普通')).toBe('当前数据下这个元素不显示，图上没有框。');
  });
});
