/**
 * 数据定义的编辑会话（P1 票据 14，M360）：撤销、重做、回到已保存与保存基准；对字段的增删改移。
 * 只经"给会话与动作、得到新的会话"这个接缝，不开页面。
 */
import { describe, expect, it } from 'vitest';
import { appendField, copyField, fieldKinds, fieldsOf, isDirty, moveField, openSession, removeField, replaceField, sessionReducer, type DefinitionSession, type SessionAction } from '../console/src/form/definition-session.js';
import type { DefinitionDocument, DefinitionField } from '../console/src/types.js';

const field = (name: string, extra: Partial<DefinitionField> = {}): DefinitionField => ({ name, displayName: name.toUpperCase(), type: 'text', ...extra });
const DOCUMENT = { dslVersion: 'renderweave-schema/1', name: '样例', displayName: '样例', fields: [field('a'), field('b'), field('c')] } as DefinitionDocument;
const run = (session: DefinitionSession, ...actions: SessionAction[]) => actions.reduce(sessionReducer, session);
const edit = (document: DefinitionDocument, key?: string): SessionAction => ({ type: 'edit', document, ...(key ? { key } : {}) });
const named = (displayName: string): DefinitionDocument => ({ ...DOCUMENT, displayName });
const namesOf = (document: DefinitionDocument) => document.fields.map((item) => item.name);

describe('编辑会话', () => {
  it('打开时没有改动，选中给定的字段；改了才算有改动，改回去又没有', () => {
    const opened = openSession(DOCUMENT, 1);
    expect(opened.selected).toBe(1);
    expect(isDirty(opened)).toBe(false);
    const changed = run(opened, edit(named('改过')));
    expect(isDirty(changed)).toBe(true);
    expect(isDirty(run(changed, edit(DOCUMENT)))).toBe(false);
  });

  it('连续改同一处合成一步撤销：打字不会一个字一步；换了一处、或选了别的字段，就是新的一步', () => {
    const typed = run(openSession(DOCUMENT), edit(named('甲'), 'title'), edit(named('甲乙'), 'title'), edit(named('甲乙丙'), 'title'));
    expect(typed.undo).toHaveLength(1);
    expect(run(typed, { type: 'undo' }).document.displayName).toBe('样例');

    const other = run(typed, edit(named('甲乙丙丁'), 'description'));
    expect(other.undo).toHaveLength(2);
    expect(run(typed, { type: 'select', index: 1 }, edit(named('又改'), 'title')).undo).toHaveLength(2);
    const keyless = run(openSession(DOCUMENT), edit(named('一')), edit(named('二')));
    expect(keyless.undo, '不给 key 的每次都算一步').toHaveLength(2);
  });

  it('撤销与重做来回走，选中跟着回去；撤销之后再改就没有重做了；到头了什么都不变', () => {
    const opened = openSession(DOCUMENT, 0);
    expect(run(opened, { type: 'undo' })).toBe(opened);
    expect(run(opened, { type: 'redo' })).toBe(opened);
    const removed = run(opened, { type: 'edit', document: removeField(DOCUMENT, 2), selected: 1 });
    const undone = run(removed, { type: 'undo' });
    expect(namesOf(undone.document)).toEqual(['a', 'b', 'c']);
    expect(undone.selected).toBe(0);
    expect(undone.generation, '输入框要换一份').toBeGreaterThan(removed.generation);
    const redone = run(undone, { type: 'redo' });
    expect(namesOf(redone.document)).toEqual(['a', 'b']);
    expect(redone.selected).toBe(1);
    expect(run(undone, edit(named('新的改动'))).redo).toEqual([]);
  });

  it('撤销到字段更少的文档时，选中不会指到不存在的字段', () => {
    const appended = run(openSession({ ...DOCUMENT, fields: [field('a')] }, 0), { type: 'edit', document: { ...DOCUMENT, fields: [field('a'), field('b')] }, selected: 1 });
    const removed = run(appended, { type: 'edit', document: { ...DOCUMENT, fields: [field('a')] }, selected: 0 });
    expect(run(removed, { type: 'undo' }).selected).toBe(1);
    expect(run(removed, { type: 'undo' }, { type: 'undo' }).selected).toBe(0);
    const past: DefinitionSession = { ...openSession({ ...DOCUMENT, fields: [field('a')] }, 0), undo: [{ document: { ...DOCUMENT, fields: [field('a')] }, selected: 5 }] };
    expect(run(past, { type: 'undo' }).selected).toBeUndefined();
  });

  it('回到已保存丢掉没保存的改动，这一步也能撤销；没有改动时什么都不做', () => {
    const opened = openSession(DOCUMENT);
    expect(run(opened, { type: 'restore' })).toBe(opened);
    const restored = run(opened, edit(named('改过')), { type: 'restore' });
    expect(restored.document).toBe(DOCUMENT);
    expect(isDirty(restored)).toBe(false);
    expect(run(restored, { type: 'undo' }).document.displayName).toBe('改过');
  });

  it('保存之后这份内容成为基准，撤销历史留着：撤销到保存之前又算有改动', () => {
    const edited = named('存过的');
    const saved = run(openSession(DOCUMENT), edit(edited), { type: 'saved', document: edited });
    expect(isDirty(saved)).toBe(false);
    expect(saved.saved).toBe(edited);
    expect(saved.undo).toHaveLength(1);
    const undone = run(saved, { type: 'undo' });
    expect(undone.document).toBe(DOCUMENT);
    expect(isDirty(undone)).toBe(true);
    expect(run(saved, edit(named('再改')), { type: 'restore' }).document).toBe(edited);
  });

  it('读回服务端的内容：从头开始，没有历史，输入框换一份，选中留在还存在的字段上', () => {
    const fresh = { ...DOCUMENT, fields: [field('a')], displayName: '别人改的' };
    const before = run(openSession(DOCUMENT, 2), edit(named('没写入')));
    const loaded = run(before, { type: 'load', document: fresh });
    expect(loaded.document).toBe(fresh);
    expect(loaded.saved).toBe(fresh);
    expect(isDirty(loaded)).toBe(false);
    expect([loaded.undo, loaded.redo]).toEqual([[], []]);
    expect(loaded.selected).toBeUndefined();
    expect(loaded.generation).toBeGreaterThan(before.generation);
    expect(run(openSession(DOCUMENT, 0), { type: 'load', document: fresh }).selected).toBe(0);
  });
});

describe('对字段的改动', () => {
  it('增、删、改只动那一个字段，文档上不认识的键原样带回', () => {
    const document = { ...DOCUMENT, futureKey: { keep: true } } as DefinitionDocument;
    const fields = [appendField(document), removeField(document, 1), replaceField(document, 1, field('b2'))];
    expect(fields.map(namesOf)).toEqual([['a', 'b', 'c', ''], ['a', 'c'], ['a', 'b2', 'c']]);
    for (const next of fields) expect(next).toMatchObject({ futureKey: { keep: true } });
    expect(namesOf(document), '不改原文档').toEqual(['a', 'b', 'c']);
  });

  it('上移下移交换相邻两个；到头了答 undefined', () => {
    expect(namesOf(moveField(DOCUMENT, 1, -1)!)).toEqual(['b', 'a', 'c']);
    expect(namesOf(moveField(DOCUMENT, 1, 1)!)).toEqual(['a', 'c', 'b']);
    expect(moveField(DOCUMENT, 0, -1)).toBeUndefined();
    expect(moveField(DOCUMENT, 2, 1)).toBeUndefined();
  });

  it('复制放在它后面，字段名称不重复，约束照抄；没写显示名称的副本也不写', () => {
    const copied = copyField({ ...DOCUMENT, fields: [field('a', { constraints: { required: true } }), field('aCopy'), field('b', { displayName: '' })] }, 0);
    expect(namesOf(copied)).toEqual(['a', 'aCopy2', 'aCopy', 'b']);
    expect(copied.fields[1]).toMatchObject({ displayName: 'A 副本', constraints: { required: true } });
    expect(copyField({ ...DOCUMENT, fields: [field('b', { displayName: '' })] }, 0).fields[1]!.displayName).toBe('');
  });

  it('还没写成字段列表的草案页面改不了；工具栏数各类型字段', () => {
    expect(fieldsOf({ ...DOCUMENT, fields: 'not a list' } as unknown as DefinitionDocument)).toBeUndefined();
    expect(fieldsOf({ ...DOCUMENT, fields: [1] } as unknown as DefinitionDocument)).toBeUndefined();
    expect(fieldsOf(DOCUMENT)).toBe(DOCUMENT.fields);
    expect(fieldKinds([field('a'), field('b', { type: 'number' }), field('c')], (type) => (type === 'text' ? '文本' : '数值'))).toBe('文本 2 · 数值 1');
  });
});
