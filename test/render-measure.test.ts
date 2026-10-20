/**
 * 不出图的度量与模板说明（阶段 4 票据 06，ADR-0017「进入队列前的限制」）：
 * 出图服务在入队前用 measureRender 量出像素与展开规模，用 describeTemplate 列出模板的对外信息；两者都不加载 CanvasKit。
 */
import { describe, expect, it } from 'vitest';
import { describeTemplate, loadWorkspace, measureRender, mmToPx, render, type LayoutNode, type Workspace } from '../src/index.js';
import { greetingRequest, loadSingleText, m402Dir, resourcesDir } from './support/fixtures.js';

const m402Request = { template: '标准线路单边', dataset: { id: 'ds-m402-wanguocheng' }, parameters: { currentIndex: 5 },
  output: { width: 740, height: 165, dpi: 120, format: 'png' }, mode: 'draft' };

/** 布局摘要里显示的节点：自身与祖先都可见。 */
function visibleNodes(node: LayoutNode): LayoutNode[] {
  if (node.visible === false) return [];
  return [node, ...(node.children ?? []).flatMap(visibleNodes)];
}
const loopItems = (node: LayoutNode): number =>
  (node.type === 'loop' && node.visible !== false ? node.children?.length ?? 0 : 0) + (node.children ?? []).reduce((sum, child) => sum + loopItems(child), 0);

describe('measureRender', () => {
  it.each<[string, () => Promise<Workspace>, { output: { width: number; dpi: number } }]>([
    ['问候牌', loadSingleText, greetingRequest({ mode: 'draft' }) as never],
    ['M402 线路牌（35 站，嵌套循环）', () => loadWorkspace({ dir: m402Dir, resourcesDir }), m402Request],
  ])('%s：像素与出图一致，元素数与循环项数与布局摘要一致', async (_name, load, request) => {
    const workspace = await load();
    const measured = measureRender(workspace, request);
    const rendered = await render(workspace, request);
    expect(measured.problems.filter((problem) => problem.level === 'severe')).toEqual([]);
    expect(measured.measure).toEqual({
      widthPx: rendered.image!.widthPx,
      heightPx: rendered.image!.heightPx,
      elements: visibleNodes(rendered.layout!.root).length,
      loopItems: loopItems(rendered.layout!.root),
    });
    expect(measured.measure!.widthPx).toBe(mmToPx(request.output.width, request.output.dpi));
  });

  it('M402 的规模：35 站，循环项数多于站数（站内还有标识行）', async () => {
    const measured = measureRender(await loadWorkspace({ dir: m402Dir, resourcesDir }), m402Request);
    expect(measured.measure!.loopItems).toBeGreaterThan(35);
    expect(measured.measure!.elements).toBeGreaterThan(measured.measure!.loopItems);
  });

  it.each([
    ['数据集不存在', { dataset: { id: 'no-such-dataset' } }],
    ['模板不存在', { template: '没有这个模板' }],
    ['像素超出引擎上限', { output: { width: 1500, height: 200, dpi: 2000, format: 'png' } }],
    ['请求不合法', { output: { width: -1, height: 40, dpi: 120, format: 'png' } }],
  ])('无法展开（%s）时没有度量，问题清单与单次渲染完全相同', async (_name, overrides) => {
    const workspace = await loadSingleText();
    const request = greetingRequest({ mode: 'draft', ...overrides });
    const measured = measureRender(workspace, request);
    const rendered = await render(workspace, request);
    expect(rendered.image).toBeUndefined();
    expect(measured.measure).toBeUndefined();
    expect(measured.problems).toEqual(rendered.problems);
  });
});

describe('describeTemplate', () => {
  it('列出名称、基准、适用尺寸范围与对外参数；内部参数不列', async () => {
    const workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
    const entry = workspace.templates.find((template) => template.name === '标准线路单边')!;
    expect(describeTemplate(entry.document)).toEqual({
      problems: [],
      template: {
        name: '标准线路单边',
        base: { name: '线路牌', version: 1 },
        sizeRange: { width: { min: 740, max: 1500 }, height: { min: 165, max: 165 } },
        parameters: [{ name: 'currentIndex', displayName: '本站序号', type: 'number', constraints: { integer: true, min: 0, max: 50 }, default: 0 }],
      },
    });
  });

  it('没有对外参数的模板列出空表；读不了的模板只有问题清单', async () => {
    const workspace = await loadSingleText();
    expect(describeTemplate(workspace.templates[0]!.document).template).toMatchObject({ name: '问候牌', base: { name: '问候', version: 1 }, parameters: [] });
    const broken = describeTemplate({ dslVersion: 'renderweave-template/1', name: '坏模板' });
    expect(broken.template).toBeUndefined();
    expect(broken.problems.length).toBeGreaterThan(0);
    expect(describeTemplate('不是对象').template).toBeUndefined();
  });
});
