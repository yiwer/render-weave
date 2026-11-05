/**
 * 数据定义的编辑会话（M360，参照旧 RenderWeave 的 EditorSession）：页面上的改动先留在这里，点"保存"才写一次。
 * 表单与树状图是同一个会话的两种看法，切换不丢东西；撤销、重做与"回到已保存"都在这一层，不碰服务端。
 * 纯函数：不认识的键原样带回，校验一律以服务端的问题清单为准（M351）。
 */
import type { DefinitionDocument, DefinitionField } from '../types.js';
import { canonical, NEW_FIELD } from './definition.js';

interface Snapshot {
  readonly document: DefinitionDocument;
  readonly selected: number | undefined;
}

export interface DefinitionSession extends Snapshot {
  /** 上次保存到服务端的内容：有没有改动、回到已保存都跟它比。 */
  readonly saved: DefinitionDocument;
  readonly undo: readonly Snapshot[];
  readonly redo: readonly Snapshot[];
  /** 连续改同一处时合成一步撤销：记着上一次改的是哪一处。 */
  readonly editing?: string | undefined;
  /** 撤销、重做或读回之后加一：输入框留着自己打的字，要靠它换一份。 */
  readonly generation: number;
}

export type SessionAction =
  /** 改了文档。key 相同的连续改动合成一步撤销（如打字）；不给 key 的每次都算一步。 */
  | { readonly type: 'edit'; readonly document: DefinitionDocument; readonly selected?: number | undefined; readonly key?: string }
  | { readonly type: 'select'; readonly index: number | undefined }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  /** 丢掉没保存的改动，回到上次保存的内容；这一步也能撤销。 */
  | { readonly type: 'restore' }
  /** 写到服务端了：这份内容成为新的基准，撤销历史留着。 */
  | { readonly type: 'saved'; readonly document: DefinitionDocument }
  /** 读回服务端的内容，从头开始。 */
  | { readonly type: 'load'; readonly document: DefinitionDocument };

export const openSession = (document: DefinitionDocument, selected?: number): DefinitionSession =>
  ({ document, selected, saved: document, undo: [], redo: [], generation: 0 });

const snapshot = ({ document, selected }: DefinitionSession): Snapshot => ({ document, selected });
const clampSelection = (document: DefinitionDocument, selected: number | undefined) =>
  (selected !== undefined && Array.isArray(document.fields) && selected < document.fields.length ? selected : undefined);

export function sessionReducer(session: DefinitionSession, action: SessionAction): DefinitionSession {
  switch (action.type) {
    case 'edit': {
      const merge = action.key !== undefined && action.key === session.editing;
      return {
        ...session, document: action.document, selected: 'selected' in action ? action.selected : session.selected,
        undo: merge ? session.undo : [...session.undo, snapshot(session)], redo: [], editing: action.key,
      };
    }
    case 'select': return { ...session, selected: action.index, editing: undefined };
    case 'undo': {
      const previous = session.undo.at(-1);
      if (!previous) return session;
      return { ...session, ...previous, selected: clampSelection(previous.document, previous.selected), undo: session.undo.slice(0, -1), redo: [...session.redo, snapshot(session)], editing: undefined, generation: session.generation + 1 };
    }
    case 'redo': {
      const next = session.redo.at(-1);
      if (!next) return session;
      return { ...session, ...next, selected: clampSelection(next.document, next.selected), redo: session.redo.slice(0, -1), undo: [...session.undo, snapshot(session)], editing: undefined, generation: session.generation + 1 };
    }
    case 'restore':
      if (!isDirty(session)) return session;
      return { ...session, document: session.saved, selected: clampSelection(session.saved, session.selected), undo: [...session.undo, snapshot(session)], redo: [], editing: undefined, generation: session.generation + 1 };
    case 'saved': return { ...session, saved: action.document, document: action.document, editing: undefined };
    case 'load': return { ...openSession(action.document, clampSelection(action.document, session.selected)), generation: session.generation + 1 };
  }
}

export const isDirty = (session: DefinitionSession) => canonical(session.document) !== canonical(session.saved);

/** 还没写成字段列表的（接口上能存）：页面改不了，问题照样显示。 */
export const fieldsOf = (document: DefinitionDocument): readonly DefinitionField[] | undefined =>
  (Array.isArray(document.fields) && document.fields.every((field) => typeof field === 'object' && field !== null) ? document.fields : undefined);

const withFields = (document: DefinitionDocument, fields: readonly DefinitionField[]): DefinitionDocument => ({ ...document, fields });

export const replaceField = (document: DefinitionDocument, index: number, field: DefinitionField) =>
  withFields(document, document.fields.map((item, at) => (at === index ? field : item)));
export const appendField = (document: DefinitionDocument) => withFields(document, [...document.fields, NEW_FIELD]);
export const removeField = (document: DefinitionDocument, index: number) => withFields(document, document.fields.filter((_item, at) => at !== index));

/** 交换相邻两个字段；到头了答 undefined。 */
export function moveField(document: DefinitionDocument, index: number, by: -1 | 1): DefinitionDocument | undefined {
  const target = index + by;
  if (target < 0 || target >= document.fields.length) return undefined;
  const next = [...document.fields];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return withFields(document, next);
}

/** 把一个字段挪到第 to 个的位置（树状图上拖动排序，M380）；没动或越界答 undefined。 */
export function moveFieldTo(document: DefinitionDocument, from: number, to: number): DefinitionDocument | undefined {
  if (from === to || from < 0 || to < 0 || from >= document.fields.length || to >= document.fields.length) return undefined;
  const next = [...document.fields];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return withFields(document, next);
}

/** 复制一个字段放在它后面：字段名称是身份，副本换一个不重复的名称。 */
export function copyField(document: DefinitionDocument, index: number): DefinitionDocument {
  const field = document.fields[index]!, names = new Set(document.fields.map((item) => item.name));
  let name = `${field.name}Copy`;
  for (let n = 2; names.has(name); n++) name = `${field.name}Copy${n}`;
  const next = [...document.fields];
  next.splice(index + 1, 0, { ...field, name, displayName: field.displayName ? `${field.displayName} 副本` : '' });
  return withFields(document, next);
}

/** 工具栏上的一句话：有几个字段、各是什么类型。 */
export function fieldKinds(fields: readonly DefinitionField[], label: (type: DefinitionField['type']) => string): string {
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(label(field.type), (counts.get(label(field.type)) ?? 0) + 1);
  return [...counts].map(([type, count]) => `${type} ${count}`).join(' · ');
}
