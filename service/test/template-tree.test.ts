/**
 * 跨模板的结构树（模板设计页票据 05）：纯函数，用 M402 与胸牌的真实模板。胸牌的场次行被循环与调用两处用，树里是两行。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ancestorKeys, buildTree, calledTemplates, treeKeyOf, type TreeNode } from '../console/src/template/tree.js';
import type { JsonObject } from '../console/src/template/document.js';

const M402 = fileURLToPath(new URL('../../docs/examples/m402-dsl/', import.meta.url));
const load = async (file: string) => JSON.parse(await readFile(`${M402}${file}`, 'utf8')) as JsonObject;
let docs: Record<string, JsonObject>;
const of = (name: string) => docs[name];
const find = (node: TreeNode, key: string): TreeNode | undefined => (node.key === key ? node : [...node.children, ...(node.called?.children ?? [])].map((child) => find(child, key)).find(Boolean));

beforeAll(async () => {
  docs = Object.fromEntries((await Promise.all(['template-route-sign.json', 'template-stop.json', 'template-road-segment.json', 'template-stop-badge.json', 'template-departure-time.json'].map(load))).map((doc) => [String(doc['name']), doc]));
});

describe('buildTree', () => {
  it('循环容器展开到被调模板的元素，key 是调用链上的位置，定义指回模板文档', () => {
    const tree = buildTree('标准线路单边', of)!;
    expect(tree).toMatchObject({ key: '标准线路单边', type: 'artboard', layout: '网格' });
    const loop = find(tree, '标准线路单边/站点面板/站点列')!;
    expect(loop.called).toMatchObject({ template: '站点', base: '停靠站点 v1', feed: '每项的数据：停靠站点 v1（stops 的一项）', state: 'ok' });
    const name = find(tree, '标准线路单边/站点面板/站点列/名称区/站名')!;
    expect(name).toMatchObject({ template: '站点', path: '站点/名称区/站名', type: 'text', hasStates: true });
    const badge = find(tree, '标准线路单边/站点面板/站点列/标识行')!;
    expect(badge.called?.template, '多层调用').toBe('标识图标');
    expect(find(tree, '标准线路单边/顶栏/线路号')).toMatchObject({ conditional: true });
  });

  it('同一个模板被调两处是两行，定义相同', () => {
    const shared = { dslVersion: 'renderweave-template/1', name: '行', base: { name: '空数据定义', version: 1 }, artboard: { sizeRange: {}, children: [{ type: 'text', name: '字' }] } };
    const root = { name: '牌', base: { name: '空数据定义', version: 1 }, artboard: { layout: { mode: 'stack', direction: 'column' }, children: [{ type: 'call', name: '甲', template: '行' }, { type: 'call', name: '乙', template: '行' }] } };
    const tree = buildTree('牌', (name) => ({ 牌: root, 行: shared } as Record<string, JsonObject>)[name])!;
    expect(find(tree, '牌/甲/字')).toMatchObject({ template: '行', path: '行/字' });
    expect(find(tree, '牌/乙/字')).toMatchObject({ template: '行', path: '行/字' });
    expect(tree.layout).toBe('纵');
  });

  it('调用成环不无限展开；读不到的模板标出来', () => {
    const a = { name: '甲', artboard: { children: [{ type: 'call', name: '调乙', template: '乙' }] } };
    const b = { name: '乙', artboard: { children: [{ type: 'call', name: '调甲', template: '甲' }, { type: 'loop', name: '循环', template: '没有' }] } };
    const tree = buildTree('甲', (name) => ({ 甲: a, 乙: b } as Record<string, JsonObject>)[name])!;
    expect(find(tree, '甲/调乙/调甲')?.called?.state).toBe('cycle');
    expect(find(tree, '甲/调乙')?.called?.feed, '调用没写 data 就是不传数据').toBe('不传数据');
    expect(find(tree, '甲/调乙/循环')?.called?.state).toBe('missing');
  });

  it('根模板没读到时没有树', () => {
    expect(buildTree('没有', () => undefined)).toBeUndefined();
  });
});

describe('calledTemplates', () => {
  it('列出调用树里的全部模板，页面据此读内容', () => {
    expect([...calledTemplates('标准线路单边', of)].sort()).toEqual(['标准线路单边', '标识图标', '班次时刻', '站点', '道路段'].sort());
  });
});

describe('实例路径与树的 key', () => {
  it('去掉循环序号；展开要打开的是各层祖先', () => {
    expect(treeKeyOf('牌/面板/列[12]/名称/站名')).toBe('牌/面板/列/名称/站名');
    expect(ancestorKeys('牌/面板/列[12]/名称/站名')).toEqual(['牌', '牌/面板', '牌/面板/列', '牌/面板/列/名称']);
  });
});
