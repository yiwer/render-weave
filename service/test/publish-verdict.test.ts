/** 发布确认的结论（M365）：预检结果怎么写成"能不能发、发了会怎样"。 */
import { describe, expect, it } from 'vitest';
import { publishVerdict, templatePublishVerdict } from '../console/src/form/publish-verdict.js';
import type { DefinitionFieldChange, DefinitionPublishCheck, Problem } from '../console/src/types.js';

const added: DefinitionFieldChange = { path: 'depot', change: 'added' };
const location = { kind: 'definition', schema: '线路牌', path: 'depot' } as const;
const clean: DefinitionPublishCheck = {
  sha256: 'a'.repeat(64), baseVersion: 1, version: 2, problems: [],
  diff: { definition: [], fields: [added] },
  datasets: { total: 42, checked: 42, complete: true, mismatched: 0, samples: [] },
  templates: [{ name: '线路牌-横版', base: { name: '线路牌', version: 1 } }],
};
const line = (check: DefinitionPublishCheck, key: string) => publishVerdict(check).lines.find((item) => item.key === key)!;
const datasets = (patch: Partial<NonNullable<DefinitionPublishCheck['datasets']>>) => ({ ...clean, datasets: { ...clean.datasets!, ...patch } });

describe('发布确认的结论', () => {
  it('预检没给出版本就不能发布，只说问题', () => {
    const problems: readonly Problem[] = [{ level: 'severe', code: 'a', message: 'a', location }, { level: 'severe', code: 'b', message: 'b', location }, { level: 'hint', code: 'c', message: 'c', location }];
    const verdict = publishVerdict({ sha256: clean.sha256, baseVersion: 1, problems });
    expect(verdict).toMatchObject({ tone: 'bad', label: '不能发布' });
    expect(verdict.lines).toEqual([{ key: 'problems', tone: 'bad', text: '2 个严重问题', note: '改正之后才能发布' }]);
  });

  it('什么影响都没有时直接说可以发布；提示不挡发布，但要说', () => {
    expect(publishVerdict(clean)).toMatchObject({ tone: 'ok', label: '可以发布' });
    expect(line(clean, 'datasets').text).toBe('42 份数据集都能按 v2 通过校验');
    expect(line(clean, 'templates').text).toBe('1 个模板照旧绑定 v1');
    const hinted = { ...clean, problems: [{ level: 'hint', code: 'c', message: 'c', location }] satisfies readonly Problem[] };
    expect(publishVerdict(hinted).tone).toBe('ok');
    expect(line(hinted, 'problems').text).toBe('校验通过，有 1 条提示');
  });

  it('有失配的数据集：能发，但要看影响，并说清它们继续按旧版出图', () => {
    const check = datasets({ mismatched: 7 });
    expect(publishVerdict(check)).toMatchObject({ tone: 'warn', label: '可以发布，有影响要看' });
    expect(line(check, 'datasets')).toEqual({ key: 'datasets', tone: 'warn', text: '7 份数据集按 v2 会失配', note: '它们继续按 v1 校验和出图' });
  });

  it('没核对完不算通过：写清核对了多少，已发现的失配照说', () => {
    const none = datasets({ total: 1280, checked: 1000, complete: false });
    expect(publishVerdict(none).tone).toBe('warn');
    expect(line(none, 'datasets')).toMatchObject({ text: '1,280 份数据集只核对了前 1,000 份', note: '这些都能按 v2 通过校验' });
    expect(line(datasets({ total: 1280, checked: 1000, complete: false, mismatched: 312 }), 'datasets').note).toBe('其中 312 份按 v2 会失配，它们继续按 v1 校验和出图');
  });

  it('首个版本没有旧版可比，数据集和模板都没什么可说', () => {
    const { baseVersion: _none, ...rest } = clean;
    const first: DefinitionPublishCheck = { ...rest, version: 1, diff: { definition: [], fields: [added, { path: 'width', change: 'added' }] }, templates: [] };
    expect(publishVerdict(first)).toMatchObject({ tone: 'ok', label: '可以发布' });
    expect(publishVerdict(first).lines.map((item) => item.text)).toEqual(['校验通过', '首个版本，2 个字段', '还没有数据集绑定', '还没有模板用这个数据定义']);
  });

  it('改动的说法：合并计数；没有改动和删除绑定用的字段都要提醒', () => {
    const removed: DefinitionFieldChange = { path: 'memo', change: 'removed', affectsBindings: true };
    const mixed = { ...clean, diff: { definition: [{ key: 'displayName', before: 'a', after: 'b' }], fields: [added, added, { path: 'fare', change: 'changed' as const }, removed], order: { before: ['a'], after: ['a'] } } };
    expect(line(mixed, 'changes')).toEqual({
      key: 'changes', tone: 'warn', text: '新增 2、修改 1、删除 1 个字段',
      note: '删除的字段，按它写的模板绑定和数据集的键不再有对应',
    });
    const fieldsUntouched = { ...clean, diff: { definition: [{ key: 'displayName', before: 'a', after: 'b' }], fields: [], order: { before: ['a'], after: ['a'] } } };
    expect(line(fieldsUntouched, 'changes')).toEqual({ key: 'changes', tone: 'ok', text: '改了数据定义的属性，调整了字段顺序' });
    const same = { ...clean, diff: { definition: [], fields: [] } };
    expect(line(same, 'changes')).toEqual({ key: 'changes', tone: 'warn', text: '内容和 v1 相同', note: '发布只会多一个内容相同的版本' });
  });

  it('模板绑定不同版本时不写具体版本', () => {
    const check = { ...clean, templates: [{ name: 'a', base: { name: '线路牌', version: 1 } }, { name: 'b', base: { name: '线路牌', version: 2 } }] };
    expect(line(check, 'templates').text).toBe('2 个模板照旧绑定各自的版本');
  });
});

describe('模板修订的结论', () => {
  const facts = { severe: 0, hints: 0, status: 'modified', summary: '1 个元素', next: 13 } as const;

  it('能发时说清发了会怎样', () => {
    const verdict = templatePublishVerdict(facts);
    expect(verdict).toMatchObject({ tone: 'ok', label: '可以发布' });
    expect(verdict.lines.map((item) => item.text)).toEqual(['静态检查通过', '改动 1 个元素', '发布后出图读修订 13']);
    expect(templatePublishVerdict({ ...facts, hints: 2 }).lines[0]!.text).toBe('静态检查通过，有 2 条提示');
    expect(templatePublishVerdict({ ...facts, status: 'added', summary: '没有改动', next: 1 }).lines[1]!.text).toBe('这是新模板，还没有修订可比');
  });

  it('挡住发布的按先后只说最要紧的：严重问题、基准已变、没有改动', () => {
    const conflict = { baseRevision: 11, currentRevision: 12 };
    expect(templatePublishVerdict({ ...facts, severe: 1, conflict, status: 'unchanged' })).toMatchObject({ tone: 'bad', label: '不能发布' });
    const changed = templatePublishVerdict({ ...facts, conflict, status: 'unchanged' });
    expect(changed).toMatchObject({ tone: 'warn', label: '基准已变' });
    expect(changed.lines[1]).toMatchObject({ key: 'conflict', text: '工作副本基于修订 11，当前修订已是 12' });
    expect(templatePublishVerdict({ ...facts, status: 'unchanged' })).toMatchObject({ tone: 'warn', label: '没有改动，不用发布' });
  });
});
