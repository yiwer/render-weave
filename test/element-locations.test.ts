/**
 * 渲染入口的元素定位与模板静态检查（阶段 5 P1 票据 07、验收 A05）：页面靠元素定位从图上点选到模板文档，出图服务保存模板前做静态检查。
 * 输入是 M402 工作区：线路牌模板循环调用站点，站点再调用子模板。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkTemplateStatic, loadWorkspace, render, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';

let workspace: Workspace;
let request: unknown;

beforeAll(async () => {
  workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  request = { ...JSON.parse(await readFile(join(m402Dir, 'render-request-m402.json'), 'utf8')), mode: 'draft' };
});

describe('render 的 elementLocations', () => {
  it('不要就没有；要了也不改变图片、问题与布局摘要', async () => {
    const plain = await render(workspace, request);
    const located = await render(workspace, request, { elementLocations: true });
    expect(plain).not.toHaveProperty('elements');
    expect(located.elements!.length).toBeGreaterThan(10);
    expect(located.problems).toEqual(plain.problems);
    expect(located.layout).toEqual(plain.layout);
    expect(Buffer.compare(Buffer.from(located.image!.bytes), Buffer.from(plain.image!.bytes))).toBe(0);
  }, 120_000);

  it('循环与子模板调用里的元素指向它所在的模板文档；每个实例的路径都在布局摘要里，且都可见', async () => {
    const { elements, layout } = await render(workspace, request, { elementLocations: true });
    const byPath = new Map(elements!.map((element) => [element.path, element.source]));
    const visible = new Map<string, boolean>();
    const walk = (node: NonNullable<typeof layout>['root']) => { visible.set(node.path, node.visible); node.children?.forEach(walk); };
    walk(layout!.root);
    for (const { path } of elements!) expect(visible.get(path), path).toBe(true);

    // 根模板的元素：源是根模板，路径相同。
    const rootName = layout!.root.path;
    expect(byPath.get(rootName)).toEqual({ template: rootName, path: rootName });
    // 循环的第 3 项与第 7 项：实例路径不同，源相同，都指向被调模板的同一个元素。
    const instances = elements!.filter((element) => /\[\d+\]/.test(element.path) && element.source.template !== rootName);
    expect(instances.length).toBeGreaterThan(5);
    for (const { path, source } of instances) {
      expect(source.path.split('/')[0], path).toBe(source.template);
      expect(source.path, path).not.toMatch(/\[\d+\]/);
    }
    const sample = instances.find((element) => element.source.path !== element.source.template)!;
    const sameSource = instances.filter((element) => element.source.path === sample.source.path);
    expect(sameSource.length, sample.source.path).toBeGreaterThan(1);
    expect(new Set(sameSource.map((element) => element.path)).size).toBe(sameSource.length);
    expect(new Set(instances.map((element) => element.source.template)).size, '多层调用').toBeGreaterThan(1);
  }, 120_000);
});

describe('checkTemplateStatic', () => {
  it('合规的模板没有严重问题；根模板不存在时无法展开，绑定了没有的字段报严重问题；不需要数据集', () => {
    expect(checkTemplateStatic(workspace, '标准线路单边')).toMatchObject({ blocked: false });
    expect(checkTemplateStatic(workspace, '标准线路单边').problems.filter((problem) => problem.level === 'severe')).toEqual([]);
    expect(checkTemplateStatic(workspace, '没有这个模板')).toMatchObject({ blocked: true, problems: [{ code: 'input.templateNotFound' }] });
    const entry = workspace.templates.find((template) => template.name === '标准线路单边')!;
    const edited = JSON.parse(JSON.stringify(entry.document).replace('{"var":"routeNoImage"}', '{"var":"noSuchField"}'));
    const overlay = { ...workspace, templates: [...workspace.templates.filter((template) => template !== entry), { ...entry, document: edited }] };
    const checked = checkTemplateStatic(overlay, '标准线路单边');
    expect(checked.problems.some((problem) => problem.level === 'severe' && problem.message.includes('noSuchField'))).toBe(true);
  });
});
