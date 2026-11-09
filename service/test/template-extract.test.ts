/**
 * 提取为子模板（模板设计页票据 19）：纯函数加引擎渲染比对。M402 的名称区、站名、顶栏与胸牌的照片区、页眉、网格里的一格，
 * 提取前后用引擎出同一张图，字节相同；新旧模板都过带变量表的静态检查。
 */
import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { elementAt, type JsonObject } from '../console/src/template/document.js';
import { extractTemplate, planExtract } from '../console/src/template/extract.js';
import { checkDslDocument, checkTemplateStatic, loadWorkspace, render, type Workspace } from '../src/engine.js';
import { CONSOLE_BADGE_DIR, M402_DIR, RESOURCES_DIR } from './seed.js';

let m402: Workspace, badge: Workspace;
const documentOf = (workspace: Workspace, name: string) => workspace.templates.find((entry) => entry.name === name)!.document as JsonObject;
const withTemplates = (workspace: Workspace, documents: readonly JsonObject[]): Workspace => ({
  ...workspace, templates: [...workspace.templates.filter((entry) => !documents.some((document) => document['name'] === entry.name)), ...documents.map((document) => ({ name: String(document['name']), document }))],
});
const M402_REQUEST = async () => ({ ...JSON.parse(await readFile(`${M402_DIR}render-request-m402.json`, 'utf8')) as JsonObject, mode: 'draft' });
const BADGE_REQUEST = { template: '会议胸牌', dataset: { id: 'badge-zhang' }, output: { width: 100, height: 140, dpi: 150, format: 'png' }, mode: 'draft' };

/** 提取 template 里的 path，出 request 那张图，和提取前比；返回提取的结果。 */
async function samePixels(workspace: Workspace, template: string, path: string, request: unknown, name = `提取 ${path.split('/').at(-1)}`) {
  const before = await render(workspace, request);
  expect(before.image, JSON.stringify(before.problems).slice(0, 300)).toBeDefined();
  const document = documentOf(workspace, template);
  const plan = planExtract(document, template, path, [{ width: 10, height: 10 }], new Set());
  expect(plan.problem).toBeUndefined();
  const result = extractTemplate(document, template, path, { name, sizeRange: { width: { min: 0.1, max: 5000 }, height: { min: 0.1, max: 5000 } } });
  if ('problem' in result) throw new Error(result.problem);
  for (const changed of [result.caller, result.callee]) expect(checkDslDocument(changed).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
  const after = withTemplates(workspace, [result.caller, result.callee]);
  const root = (request as { template: string }).template;
  expect(checkTemplateStatic(after, root).problems.filter((problem) => problem.level === 'severe')).toEqual([]);
  const drawn = await render(after, request);
  // 问题照旧（元素路径多了一层调用，只比问题码与说明）。
  const said = (problems: readonly { code: string; message: string }[]) => problems.map((problem) => `${problem.code} ${problem.message}`).sort();
  expect(said(drawn.problems)).toEqual(said(before.problems));
  expect(Buffer.from(drawn.image!.bytes).equals(Buffer.from(before.image!.bytes)), `${path} 提取前后的图不同`).toBe(true);
  return { ...result, plan };
}

beforeAll(async () => {
  m402 = await loadWorkspace({ dir: M402_DIR, resourcesDir: RESOURCES_DIR });
  badge = await loadWorkspace({ dir: CONSOLE_BADGE_DIR, resourcesDir: RESOURCES_DIR });
}, 60_000);

describe('提取前后图逐像素相同', () => {
  it('M402 站点模板的名称区：状态样式跟着容器走，参数变成对外参数由调用传入，派生变量连同依赖复制过去', async () => {
    const { caller, callee, plan } = await samePixels(m402, '站点', '站点/名称区', await M402_REQUEST(), '站名区');
    expect(plan.parameters).toEqual(['index', 'currentIndex', 'stopNameSize', 'nameColor', 'passedColor', 'currentTextColor', 'highlightColor']);
    expect(plan.derived).toEqual(['stopState', 'hasLandmark']);
    expect([...plan.fields].sort()).toEqual(['landmark', 'name']);
    expect(elementAt(caller, '站点/名称区')!.element).toEqual({
      type: 'call', name: '名称区', place: { width: 'hug', height: 'fill' }, template: '站名区', data: 'current',
      args: Object.fromEntries(plan.parameters.map((name) => [name, { var: name }])),
    });
    const moved = elementAt(callee, '站名区/名称区')!.element;
    expect(moved['states']).toEqual(elementAt(documentOf(m402, '站点'), '站点/名称区')!.element['states']);
    expect(moved['place']).toEqual({ width: 'hug', height: 'fill' });
    expect((callee['parameters'] as JsonObject[]).every((parameter) => parameter['visibility'] === 'public')).toBe(true);
    expect(callee['base']).toEqual(documentOf(m402, '站点')['base']);
  });

  it('M402 的站名（缩字组、竖排、状态样式）与顶栏（网格里没写宽高，在空板上写明撑满）', async () => {
    await samePixels(m402, '站点', '站点/名称区/站名', await M402_REQUEST());
    const { callee } = await samePixels(m402, '标准线路单边', '标准线路单边/顶栏', await M402_REQUEST());
    expect(elementAt(callee, '提取 顶栏/顶栏')!.element['place']).toEqual({ width: 'fill', height: 'fill' });
  });

  it('胸牌的照片区（纵向堆叠里的固定尺寸）、页眉（容器）与信息网格里的一格', async () => {
    const { caller } = await samePixels(badge, '会议胸牌', '会议胸牌/照片', BADGE_REQUEST, '照片区');
    expect(elementAt(caller, '会议胸牌/照片')!.element).toEqual({ type: 'call', name: '照片', place: { width: { fixed: 24 }, height: { fixed: 24 } }, template: '照片区', data: 'current' });
    await samePixels(badge, '会议胸牌', '会议胸牌/页眉', BADGE_REQUEST);
    await samePixels(badge, '会议胸牌', '会议胸牌/信息/座位', BADGE_REQUEST);
  });
});

describe('提取前先看', () => {
  it('建议的名称不和已有模板重；尺寸范围取各处实际尺寸，最小一半、最大两倍', () => {
    const plan = planExtract(documentOf(m402, '站点'), '站点', '站点/名称区', [{ width: 9.7, height: 70 }, { width: 12.3, height: 80 }], new Set(['名称区', '名称区2']));
    expect(plan.name).toBe('名称区3');
    expect(plan.sizeRange).toEqual({ width: { min: 4.8, max: 24.6 }, height: { min: 35, max: 160 } });
    expect(planExtract(documentOf(m402, '站点'), '站点', '站点/名称区', [], new Set()).sizeRange).toEqual({ width: { min: 1, max: 2000 }, height: { min: 1, max: 2000 } });
  });

  it('画板不能提取；状态样式改了位置或显示的不能提取，写明原因', () => {
    expect(planExtract(documentOf(m402, '站点'), '站点', '站点', [], new Set()).problem).toContain('画板不能提取');
    const stop = documentOf(m402, '站点'), path = '站点/名称区/地标', element = elementAt(stop, path)!.element;
    const moving = { ...element, states: { by: { var: 'stopState' }, cases: { 本站: { place: { width: { fixed: 10 }, height: { fixed: 10 } } } } } };
    const document = JSON.parse(JSON.stringify(stop)) as JsonObject;
    (elementAt(document, '站点/名称区')!.element['children'] as JsonObject[])[1] = moving;
    expect(planExtract(document, '站点', path, [], new Set()).problem).toBe('状态样式按取值改了位置与尺寸，提取后调用接不住：先去掉这几项覆盖再提取。');
    expect(extractTemplate(document, '站点', path, { name: 'x', sizeRange: { width: { min: 1, max: 2 }, height: { min: 1, max: 2 } } })).toHaveProperty('problem');
  });

  it('只用到某个单引用字段下面的值：提示可以改成只传这个字段；派生变量下面的值不算', () => {
    const text = (name: string, slot: string) => ({ type: 'text', name, content: [{ slot }], font: 'res:f', fontSize: 5 });
    const document: JsonObject = {
      dslVersion: 'renderweave-template/1', name: '卡', base: { name: '卡片', version: 1 },
      artboard: { sizeRange: { width: { min: 1, max: 9 }, height: { min: 1, max: 9 } }, children: [
        { type: 'container', name: '主人', children: [text('姓名', 'owner.name'), text('电话', 'owner.phone')] },
        { type: 'container', name: '混合', children: [text('姓名', 'owner.name'), text('标题', 'title')] },
      ] },
    };
    expect(planExtract(document, '卡', '卡/主人', [], new Set()).singleRef).toBe('owner');
    expect(planExtract(document, '卡', '卡/混合', [], new Set()).singleRef).toBeUndefined();
    // M402 的 terminal 是派生变量（取 stops 的最后一项）：终点站的 terminal.name 不算单引用字段，派生变量连同它用的 stops 一起带走。
    expect(planExtract(documentOf(m402, '标准线路单边'), '标准线路单边', '标准线路单边/顶栏/终点站', [], new Set())).toMatchObject({ derived: ['terminal'], fields: ['stops'] });
  });
});
