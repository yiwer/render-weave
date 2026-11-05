/**
 * 渲染入口的元素求值（模板设计页票据 02、验收 A04）：页面不再实现一遍求值，变量取值、命中的分支、参数来源与各实例的状态都由引擎回答。
 * 输入是 M402 工作区：主模板循环调用站点，本站序号 5。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorkspace, render, type InspectedVariable, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';

const ROOT = '标准线路单边';
const STOP_NAME = (index: number) => `${ROOT}/站点面板/站点列[${index}]/名称区/站名`;
let workspace: Workspace;
let request: Record<string, unknown>;
const variable = (variables: readonly InspectedVariable[], name: string) => variables.find((item) => item.name === name)!;

beforeAll(async () => {
  workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  request = { ...JSON.parse(await readFile(join(m402Dir, 'render-request-m402.json'), 'utf8')), mode: 'draft' };
});

describe('render 的 inspect', () => {
  it('不要就没有；要了也不改变图片、问题清单与布局摘要', async () => {
    const plain = await render(workspace, request);
    const asked = await render(workspace, request, { inspect: STOP_NAME(12) });
    expect(plain).not.toHaveProperty('inspection');
    expect(asked.inspection).toBeDefined();
    expect(asked.problems).toEqual(plain.problems);
    expect(asked.layout).toEqual(plain.layout);
    expect(Buffer.compare(Buffer.from(asked.image!.bytes), Buffer.from(plain.image!.bytes))).toBe(0);
  }, 120_000);

  it('循环项里的元素：作用域是被调模板，变量取这一项的值，分支标出命中，参数追到真正的来源', async () => {
    const { inspection } = await render(workspace, request, { inspect: STOP_NAME(12) });
    expect(inspection).toMatchObject({ path: STOP_NAME(12), template: '站点', source: '站点/名称区/站名' });
    const { variables } = inspection!;
    expect(variable(variables, 'index')).toMatchObject({ kind: 'parameter', type: 'number', value: 12, origin: { kind: 'loop', loop: 'index', template: ROOT } });
    expect(variable(variables, 'currentIndex')).toMatchObject({ value: 5, origin: { kind: 'request', template: ROOT, name: 'currentIndex' } });
    expect(variable(variables, 'stopNameSize'), '经调用传入的值追到主模板的内部参数').toMatchObject({ value: 10, origin: { kind: 'default', template: ROOT, name: 'stopNameSize', visibility: 'internal' } });
    expect(variable(variables, 'nameColor')).toMatchObject({ origin: { kind: 'default', template: '站点', visibility: 'internal' } });
    expect(variable(variables, 'stopState'), '第 12 站在本站之后，走"否则"').toMatchObject({ kind: 'derived', value: '未到站', branch: -1 });
    expect(variable(variables, 'name')).toMatchObject({ kind: 'field', type: 'text' });
  }, 120_000);

  it('同一个定义的全部实例带状态取值，能算出每个取值有几处；取值范围能确定时也回答', async () => {
    const { inspection } = await render(workspace, request, { inspect: STOP_NAME(5) });
    expect(variable(inspection!.variables, 'stopState')).toMatchObject({ value: '本站', branch: 2 });
    expect(inspection!.instances).toHaveLength(35);
    const counts = new Map<string, number>();
    for (const { state } of inspection!.instances) counts.set(state!, (counts.get(state!) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ 已过站: 4, 本站: 1, 未到站: 30 });
    expect(inspection!.states?.by).toBe('stopState');
    expect(inspection!.states?.known).toEqual(expect.arrayContaining(['普通', '已过站', '本站', '未到站']));
  }, 120_000);

  it('根模板：列表只给项数，引用给一层字段；检查项回答当前是否成立', async () => {
    const { inspection } = await render(workspace, request, { inspect: ROOT });
    expect(inspection).toMatchObject({ path: ROOT, template: ROOT, source: ROOT });
    expect(variable(inspection!.variables, 'stops').value).toEqual({ list: 35 });
    const terminal = variable(inspection!.variables, 'terminal').value as { fields: Record<string, unknown> };
    expect(terminal.fields['name']).toBe('万国城总站');
    expect(inspection!.checks).toEqual([expect.objectContaining({ level: 'severe', failed: false })]);
    const outOfRange = await render(workspace, { ...request, parameters: { currentIndex: 40 } }, { inspect: ROOT });
    expect(outOfRange.inspection!.checks[0]!.failed).toBe(true);
  }, 120_000);

  it('隐藏的元素也能问；路径不存在时没有这个字段，不报错', async () => {
    const hidden = await render(workspace, request, { inspect: `${ROOT}/顶栏/线路号` });
    expect(hidden.inspection?.instances).toEqual([{ path: `${ROOT}/顶栏/线路号`, visible: false }]);
    const missing = await render(workspace, request, { inspect: `${ROOT}/没有这个元素` });
    expect(missing).not.toHaveProperty('inspection');
    expect(missing.image).toBeDefined();
  }, 120_000);
});
