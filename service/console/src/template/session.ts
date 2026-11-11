/**
 * 模板设计页的编辑会话（P1 票据 08，M356）：页面里的文档、撤销与重做、暂存。
 * - 预览只能渲染已暂存的工作副本（POST /v1/previews?workingCopies=true），所以每次改动都写回：改完 500 毫秒暂存一次，暂存完再预览。
 *   还没写回服务端的改动算未保存，写回失败时留在这里，看得到数目、能重试；
 * - "保存"也是立刻暂存，另外记一笔"这些改动看过了"：自上次点保存以来有改动就算没点保存，离开时提醒（M383）；
 * - 撤销与重做只在这一页、这一次打开里有，撤销也是一次写回。子模板各有自己的工作副本，撤销按改动的先后，跨模板也一样；
 *   一次改两个模板（提取为子模板，票据 19）记成一步，撤销时两边一起回去；
 * - 打开设计页只读内容：有工作副本读工作副本，没有就读当前修订，不写任何东西（模板设计页票据 01）。第一次写回时才开工作副本；
 *   这次开的、离开时与开的时候一样（都撤销了），就删掉，不留空的工作副本；
 *   基准已变而这边没有改动的旧工作副本，打开时丢掉、改读当前修订，不让它显得有冲突。
 */
import { api, ApiError } from '../api.js';
import { problemsOf } from '../hooks.js';
import type { Problem } from '../types.js';
import { changeCount, parseTemplateText, templateText, type JsonObject } from './document.js';

export interface DesignDoc {
  readonly name: string;
  /** 页面里最新的文档与原文。 */
  readonly document: JsonObject;
  readonly text: string;
  /** 服务端上这份内容的原文与内容哈希：有工作副本时是工作副本，没有时是当前修订。 */
  readonly savedText: string;
  /** 上次点"保存"时的原文，没点过就是打开时的。 */
  readonly confirmedText: string;
  readonly sha256: string;
  readonly baseRevision?: number;
  /** 服务端有没有这个模板的工作副本：第一次写回时才开。 */
  readonly opened: boolean;
  /** 写回失败：stale 是别处先改了，missing 是工作副本没了（在别处发布或丢弃了）。 */
  readonly failure?: { readonly problems: readonly Problem[]; readonly stale?: string; readonly missing?: boolean };
}

export interface DesignState {
  readonly docs: ReadonlyMap<string, DesignDoc>;
  /** 还没写回服务端的改动数：逐个属性比，改回原值就不算。 */
  readonly unsaved: number;
  /** 自上次点"保存"以来的改动数，同样逐个属性比。这些改动多半已经暂存，不会丢，只是离开时要提醒。 */
  readonly unconfirmed: number;
  readonly saving: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** 写回成功的次数：变了就要重新预览。 */
  readonly stashes: number;
  readonly problems?: readonly Problem[];
}

interface Change { readonly template: string; readonly before: string; after: string }
/** 一步撤销：通常改一个模板；提取为子模板时两个模板一起改。 */
interface Step { readonly changes: readonly Change[]; readonly key?: string; at: number }

/** 连续改同一项（输入框打字）合成一步撤销。 */
const COALESCE_MS = 1500;
const STASH_DELAY_MS = 500;

export interface DesignSession {
  subscribe(listener: () => void): () => void;
  getState(): DesignState;
  /**
   * 读一个模板；quiet 时读不到不算页面的错（结构树读被调模板，树里单独标）。
   * created：这个工作副本是这一页刚建的（提取为子模板），离开时内容还和建的时候一样就删掉。
   */
  open(name: string, options?: { readonly quiet?: boolean; readonly created?: boolean }): Promise<void>;
  /** 一次改动：记进撤销，稍后写回。key 相同的连续改动合成一步。 */
  edit(name: string, document: JsonObject, key?: string): void;
  /** 一次改几个模板，记成一步撤销（提取为子模板）。模板都要已经读进来。 */
  editMany(changes: readonly { readonly name: string; readonly document: JsonObject }[]): void;
  /** 返回这一步所在的模板：页面要切过去，让人看得到改了什么。 */
  undo(): string | undefined;
  redo(): string | undefined;
  /** 立刻写回全部改动，写完才结束。 */
  flush(): Promise<void>;
  /** 点"保存"：立刻写回，写回成功的不再算没点保存。 */
  save(): Promise<void>;
  /** 丢掉这里的改动，读回服务端的内容；工作副本没了就重新开一份。 */
  reload(name: string): Promise<void>;
  /** 别处先改了时，用这里的内容盖过去。 */
  overwrite(name: string): Promise<void>;
  /** 离开页面：写回未写的，删掉打开过没改的。 */
  dispose(): void;
}

const missing = (error: unknown) => error instanceof ApiError && error.status === 404;

/** 离开时问的话：已暂存的不会丢，还没写回的才可能丢。 */
export const leaveQuestion = (state: Pick<DesignState, 'unsaved'>) => (state.unsaved
  ? `有 ${state.unsaved} 处改动还没写回，离开可能丢失。确定离开？`
  : '这些改动已经暂存，下次打开还在，但你还没点保存。确定离开？');

export function createDesignSession(): DesignSession {
  const docs = new Map<string, DesignDoc>(), listeners = new Set<() => void>();
  const opening = new Map<string, Promise<void>>(), running = new Map<string, Promise<void>>();
  /** 这次打开时才开的工作副本，记它开的时候的原文。 */
  const created = new Map<string, string>();
  let undoSteps: Step[] = [], redoSteps: Step[] = [], stashes = 0, problems: readonly Problem[] | undefined, timer: number | undefined;

  /** 从哪一份原文算起改了多少处：改回原值就不算。 */
  const changesSince = (origin: (doc: DesignDoc) => string) => [...docs.values()].reduce((sum, doc) => (doc.text === origin(doc) ? sum : sum + Math.max(1, changeCount(parseTemplateText(origin(doc)), doc.document))), 0);
  const compute = (): DesignState => ({
    docs: new Map(docs),
    unsaved: changesSince((doc) => doc.savedText), unconfirmed: changesSince((doc) => doc.confirmedText),
    saving: running.size > 0, canUndo: undoSteps.length > 0, canRedo: redoSteps.length > 0, stashes,
    ...(problems ? { problems } : {}),
  });
  let state = compute();
  const changed = () => { state = compute(); for (const listener of listeners) listener(); };

  /** 读内容：有工作副本读工作副本，没有就读当前修订，不写任何东西。 */
  const load = async (name: string) => {
    const read = async () => { try { return await api.workingCopy(name); } catch (error) { if (missing(error)) return undefined; throw error; } };
    let copy = await read();
    if (copy && copy.baseRevision !== undefined) {
      const check = await api.checkWorkingCopy(name);
      if (check.conflict?.ours.status === 'unchanged') {
        await api.discardWorkingCopy(name);
        copy = undefined;
      }
    }
    if (copy) {
      docs.set(name, {
        name, document: parseTemplateText(copy.content), text: copy.content, savedText: copy.content, confirmedText: copy.content, sha256: copy.sha256, opened: true,
        ...(copy.baseRevision === undefined ? {} : { baseRevision: copy.baseRevision }),
      });
      return;
    }
    const current = await api.templateContent(name);
    docs.set(name, { name, document: parseTemplateText(current.content), text: current.content, savedText: current.content, confirmedText: current.content, sha256: current.sha256, baseRevision: current.revision, opened: false });
  };

  /**
   * 第一次写回前开工作副本，返回暂存要带的预期哈希。别的标签页抢先开了也算有；
   * 服务端的内容已经不是打开时读到的（别人先保存了新修订或先暂存了），按"别处先改了"处理，由人决定。
   */
  const ensureCopy = async (doc: DesignDoc): Promise<string> => {
    if (doc.opened) return doc.sha256;
    let mine = true;
    try { await api.openWorkingCopy(doc.name); } catch (error) { if (!(error instanceof ApiError && error.status === 409)) throw error; mine = false; }
    const fresh = await api.workingCopy(doc.name);
    if (mine && fresh.content === doc.savedText) created.set(doc.name, fresh.content);
    const latest = docs.get(doc.name) ?? doc;
    docs.set(doc.name, { ...latest, opened: true, ...(fresh.baseRevision === undefined ? {} : { baseRevision: fresh.baseRevision }) });
    if (fresh.sha256 !== doc.sha256) {
      throw new ApiError(409, [{ code: 'draft.stale', level: 'severe', location: { kind: 'input', source: `templateWorkingCopy:${doc.name}` }, message: `模板 ${doc.name} 在打开之后被别处改过了` }], { currentSha256: fresh.sha256 });
    }
    return doc.sha256;
  };

  const stash = (name: string): Promise<void> => {
    const already = running.get(name);
    if (already) return already.then(() => stash(name));
    const doc = docs.get(name);
    if (!doc || doc.text === doc.savedText || doc.failure?.stale || doc.failure?.missing) return Promise.resolve();
    const text = doc.text;
    const work = ensureCopy(doc).then((expected) => api.stashWorkingCopy(name, expected, text)).then(
      (saved) => {
        const latest = docs.get(name);
        if (!latest) return;
        const { failure: _failure, ...rest } = latest;
        docs.set(name, { ...rest, savedText: text, sha256: saved.sha256 });
        stashes++;
      },
      (error: unknown) => {
        const latest = docs.get(name);
        if (!latest) return;
        const stale = error instanceof ApiError && error.status === 409 ? error.body?.['currentSha256'] as string | undefined : undefined;
        docs.set(name, { ...latest, failure: { problems: problemsOf(error), ...(stale ? { stale } : {}), ...(missing(error) ? { missing: true } : {}) } });
      },
    ).finally(() => {
      running.delete(name);
      changed();
      // 写回期间又改了：接着写。失败的等下一次改动或"保存"。
      const latest = docs.get(name);
      if (latest && latest.text !== latest.savedText && !latest.failure) void stash(name);
    });
    running.set(name, work);
    changed();
    return work;
  };

  const flush = async () => {
    if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
    await Promise.all([...docs.keys()].map(stash));
    // 写回期间又改的那一轮也要等完。
    await Promise.all([...running.values()]);
  };
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => { timer = undefined; void flush(); }, STASH_DELAY_MS);
  };

  const apply = (name: string, text: string) => {
    const doc = docs.get(name);
    if (!doc) return;
    const { failure, ...rest } = doc;
    // 别处先改了、工作副本没了这两种要人决定，别的失败改一下就重试。
    docs.set(name, { ...rest, document: parseTemplateText(text), text, ...(failure && (failure.stale || failure.missing) ? { failure } : {}) });
    schedule();
    changed();
  };

  return {
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getState: () => state,
    open(name, options) {
      if (docs.has(name)) return Promise.resolve();
      const pending = opening.get(name);
      if (pending) return pending;
      const work = load(name).then(
        () => {
          if (!options?.quiet) problems = undefined;
          const doc = docs.get(name);
          if (options?.created && doc) created.set(name, doc.savedText);
        },
        (error: unknown) => { if (!options?.quiet) problems = problemsOf(error); },
      ).finally(() => { opening.delete(name); changed(); });
      opening.set(name, work);
      return work;
    },
    edit(name, document, key) {
      const doc = docs.get(name);
      if (!doc) return;
      const text = templateText(document);
      if (text === doc.text) return;
      const now = Date.now(), last = undoSteps.at(-1), only = last?.changes.length === 1 ? last.changes[0]! : undefined;
      if (key !== undefined && last && only && last.key === key && only.template === name && now - last.at < COALESCE_MS && redoSteps.length === 0) {
        only.after = text;
        last.at = now;
        if (only.before === only.after) undoSteps.pop();
      } else {
        undoSteps.push({ changes: [{ template: name, before: doc.text, after: text }], ...(key !== undefined ? { key } : {}), at: now });
      }
      redoSteps = [];
      apply(name, text);
    },
    editMany(changes) {
      const step: Change[] = [];
      for (const { name, document } of changes) {
        const doc = docs.get(name), text = templateText(document);
        if (doc && text !== doc.text) step.push({ template: name, before: doc.text, after: text });
      }
      if (!step.length) return;
      undoSteps.push({ changes: step, at: Date.now() });
      redoSteps = [];
      for (const change of step) apply(change.template, change.after);
    },
    // 返回这一步的最后一个模板：提取时最后改的是原模板，页面切回它。
    undo() {
      const step = undoSteps.pop();
      if (!step) return undefined;
      redoSteps.push(step);
      for (const change of step.changes) apply(change.template, change.before);
      return step.changes.at(-1)!.template;
    },
    redo() {
      const step = redoSteps.pop();
      if (!step) return undefined;
      // 重做之后的下一次改动不和它合成一步。
      undoSteps.push({ ...step, at: 0 });
      for (const change of step.changes) apply(change.template, change.after);
      return step.changes.at(-1)!.template;
    },
    flush,
    async save() {
      await flush();
      for (const [name, doc] of docs) if (doc.text === doc.savedText) docs.set(name, { ...doc, confirmedText: doc.text });
      changed();
    },
    async reload(name) {
      docs.delete(name);
      undoSteps = undoSteps.filter((step) => !step.changes.some((change) => change.template === name));
      redoSteps = redoSteps.filter((step) => !step.changes.some((change) => change.template === name));
      changed();
      await this.open(name);
    },
    async overwrite(name) {
      const doc = docs.get(name);
      if (!doc?.failure?.stale) return;
      const { failure, ...rest } = doc;
      docs.set(name, { ...rest, sha256: failure.stale! });
      changed();
      await flush();
    },
    dispose() {
      void flush().then(() => {
        for (const [name, original] of created) {
          if (docs.get(name)?.savedText === original) void api.discardWorkingCopy(name).catch(() => undefined);
        }
      });
    },
  };
}
