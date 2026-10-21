/**
 * 数据集校验的公开入口（票据 10）：出图服务保存数据集、表单实时提示都用它。
 * 问题与工作区读取加渲染时对同一数据集的检查相同，字段问题定位到字段路径（M107）。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkDataset, loadWorkspace, render, type Workspace } from '../src/index.js';
import { m402Dir, resourcesDir } from './support/fixtures.js';

const bytes = (text: string) => new Uint8Array(Buffer.from(text));
const json = (value: unknown) => bytes(JSON.stringify(value, null, 2));
let workspace: Workspace;
let original: any;
let request: any;

beforeAll(async () => {
  workspace = await loadWorkspace({ dir: m402Dir, resourcesDir });
  original = JSON.parse(await readFile(join(m402Dir, 'dataset-m402.json'), 'utf8'));
  request = JSON.parse(await readFile(join(m402Dir, 'render-request-m402.json'), 'utf8'));
});

describe('checkDataset', () => {
  it('合格的数据集没有问题，并给出解析后的身份与数据', () => {
    const check = checkDataset(json(original), workspace);
    expect(check.problems).toEqual([]);
    expect(check.dataset).toEqual({ dataset: original.dataset, data: original.data });
  });

  it('字段问题与渲染时对同一数据集的检查相同，定位到字段路径', async () => {
    const document = structuredClone(original);
    document.data.fare = '两元';
    document.data.stops[3].landmark = 'res:no-such-landmark';
    document.data.stops[4].landmark = 'res:font-hei-medium';
    document.data.color = 'red';
    delete document.data.routeNo;
    const check = checkDataset(json(document), workspace);
    expect(check.problems.map((problem) => [problem.code, problem.location])).toEqual(expect.arrayContaining([
      ['dataset.typeMismatch', { kind: 'field', path: 'fare' }],
      ['dataset.resourceNotFound', { kind: 'field', path: 'stops[4].landmark' }],
      ['dataset.resourceKindMismatch', { kind: 'field', path: 'stops[5].landmark' }],
      ['dataset.unknownKey', { kind: 'field', path: 'color' }],
      ['dataset.requiredMissing', { kind: 'field', path: 'routeNo' }],
    ]));
    const rendered = await render(workspace, { ...request, mode: 'draft', dataset: { inline: document } });
    expect(rendered.problems.filter((problem) => problem.location.kind === 'field')).toEqual(check.problems);
  });

  it('超过 15 位有效数字的数值原文报出来，按双精度读取会失真（M112）', () => {
    const text = JSON.stringify(original).replace('"fare":2', '"fare":2.12345678901234567');
    const check = checkDataset(bytes(text), workspace);
    expect(check.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'dataset.tooManyDigits', location: { kind: 'input', source: 'dataset' }, message: expect.stringContaining('2.12345678901234567') }),
    ]));
  });

  it('静态数据定义不在工作区时报出，与渲染相同；身份部分仍然给出', () => {
    const document = { ...original, dataset: { ...original.dataset, staticSchema: { name: '线路牌', version: 9 } } };
    const check = checkDataset(json(document), workspace);
    expect(check.problems).toEqual([expect.objectContaining({ code: 'input.staticSchemaNotFound', location: { kind: 'input', source: 'dataset.staticSchema' } })]);
    expect(check.dataset?.dataset.staticSchema).toEqual({ name: '线路牌', version: 9 });
  });

  it('不是 JSON、不是数据集文档时只有问题，没有数据集', () => {
    const broken = checkDataset(bytes('{"dataset":'), workspace);
    expect(broken.dataset).toBeUndefined();
    expect(broken.problems).toEqual([expect.objectContaining({ code: 'input.unreadable', location: { kind: 'input', source: 'dataset' } })]);
    for (const value of [{ template: '标准线路单边' }, { dataset: { staticSchema: { name: '线路牌', version: 1 } }, data: {}, extra: 1 }, []]) {
      const check = checkDataset(json(value), workspace);
      expect(check.dataset).toBeUndefined();
      expect(check.problems).toEqual([expect.objectContaining({ code: 'dataset.invalid', location: { kind: 'input', source: 'dataset' } })]);
    }
  });
});
