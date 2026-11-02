/**
 * 模板设计页的编辑会话（P1 票据 08，M355）：页面里的文档、撤销与重做、暂存。
 * - 预览只能渲染已暂存的工作副本（POST /v1/previews?workingCopies=true），所以每次改动都写回：改完 500 毫秒暂存一次，暂存完再预览。
 *   "保存"是立刻暂存；还没写回服务端的改动算未保存，写回失败时留在这里，看得到数目、能重试；
 * - 撤销与重做只在这一页、这一次打开里有，撤销也是一次写回。子模板各有自己的工作副本，撤销按改动的先后，跨模板也一样；
 * - 打开设计页要读内容，内容只从工作副本来：没有工作副本就开一份。这次开的、离开时与开的时候一样（没改或都撤销了），就删掉，不留空的工作副本；
 *   基准已变而这边没有改动的旧工作副本，打开时换成当前修订，不让它显得有冲突。
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
  /** 服务端工作副本的原文与内容哈希。 */
  readonly savedText: string;
  readonly sha256: string;
  readonly baseRevision?: number;
  /** 写回失败：stale 是别处先改了，missing 是工作副本没了（在别处发布或丢弃了）。 */
  readonly failure?: { readonly problems: readonly Problem[]; readonly stale?: string; readonly missing?: boolean };
}

export interface DesignState {
  readonly docs: ReadonlyMap<string, DesignDoc>;
  /** 还没写回服务端的改动数：逐个属性比，改回原值就不算。 */
  readonly unsaved: number;
  readonly saving: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** 写回成功的次数：变了就要重新预览。 */
  readonly stashes: number;
  readonly problems?: readonly Problem[];
}

interface Step { readonly template: string; readonly before: string; after: string; readonly key?: string; at: number }

/** 连续改同一项（输入框打字）合成一步撤销。 */
const COALESCE_MS = 1500;
const STASH_DELAY_MS = 500;

export interface DesignSession {
  subscribe(listener: () => void): () => void;
  getState(): DesignState;
  open(name: string): Promise<void>;
  /** 一次改动：记进撤销，稍后写回。key 相同的连续改动合成一步。 */
  edit(name: string, document: JsonObject, key?: string): void;
  /** 返回这一步所在的模板：页面要切过去，让人看得到改了什么。 */
  undo(): string | undefined;
  redo(): string | undefined;
  /** 立刻写回全部改动，写完才结束。 */
  flush(): Promise<void>;
  /** 丢掉这里的改动，读回服务端的内容；工作副本没了就重新开一份。 */
  reload(name: string): Promise<void>;
  /** 别处先改了时，用这里的内容盖过去。 */
  overwrite(name: string): Promise<void>;
  /** 离开页面：写回未写的，删掉打开过没改的。 */
  dispose(): void;
}

const missing = (error: unknown) => error instanceof ApiError && error.status === 404;

export function createDesignSession(): DesignSession {
  const docs = new Map<string, DesignDoc>(), listeners = new Set<() => void>();
  const opening = new Map<string, Promise<void>>(), running = new Map<string, Promise<void>>();
  /** 这次打开时才开的工作副本，记它开的时候的原文。 */
  const created = new Map<string, string>();
  let undoSteps: Step[] = [], redoSteps: Step[] = [], stashes = 0, problems: readonly Problem[] | undefined, timer: number | undefined;

  const compute = (): DesignState => ({
    docs: new Map(docs),
    unsaved: [...docs.values()].reduce((sum, doc) => (doc.text === doc.savedText ? sum : sum + Math.max(1, changeCount(parseTemplateText(doc.savedText), doc.document))), 0),
    saving: running.size > 0, canUndo: undoSteps.length > 0, canRedo: redoSteps.length > 0, stashes,
    ...(problems ? { problems } : {}),
  });
  let state = compute();
  const changed = () => { state = compute(); for (const listener of listeners) listener(); };

  /** 读工作副本，没有就开一份（别的标签页抢先开了也算有）。 */
  const load = async (name: string) => {
    const read = async () => { try { return await api.workingCopy(name); } catch (error) { if (missing(error)) return undefined; throw error; } };
    const start = async () => {
      let opened = true;
      try { await api.openWorkingCopy(name); } catch (error) { if (!(error instanceof ApiError && error.status === 409)) throw error; opened = false; }
      const fresh = await api.workingCopy(name);
      if (opened) created.set(name, fresh.content);
      return fresh;
    };
    let copy = await read();
    if (copy && copy.baseRevision !== undefined) {
      const check = await api.checkWorkingCopy(name);
      if (check.conflict?.ours.status === 'unchanged') {
        await api.discardWorkingCopy(name);
        copy = undefined;
      }
    }
    copy ??= await start();
    docs.set(name, {
      name, document: parseTemplateText(copy.content), text: copy.content, savedText: copy.content, sha256: copy.sha256,
      ...(copy.baseRevision === undefined ? {} : { baseRevision: copy.baseRevision }),
    });
  };

  const stash = (name: string): Promise<void> => {
    const already = running.get(name);
    if (already) return already.then(() => stash(name));
    const doc = docs.get(name);
    if (!doc || doc.text === doc.savedText || doc.failure?.stale || doc.failure?.missing) return Promise.resolve();
    const text = doc.text;
    const work = api.stashWorkingCopy(name, doc.sha256, text).then(
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
    open(name) {
      if (docs.has(name)) return Promise.resolve();
      const pending = opening.get(name);
      if (pending) return pending;
      const work = load(name).then(
        () => { problems = undefined; },
        (error: unknown) => { problems = problemsOf(error); },
      ).finally(() => { opening.delete(name); changed(); });
      opening.set(name, work);
      return work;
    },
    edit(name, document, key) {
      const doc = docs.get(name);
      if (!doc) return;
      const text = templateText(document);
      if (text === doc.text) return;
      const now = Date.now(), last = undoSteps.at(-1);
      if (key !== undefined && last && last.key === key && last.template === name && now - last.at < COALESCE_MS && redoSteps.length === 0) {
        last.after = text;
        last.at = now;
        if (last.before === last.after) undoSteps.pop();
      } else {
        undoSteps.push({ template: name, before: doc.text, after: text, ...(key !== undefined ? { key } : {}), at: now });
      }
      redoSteps = [];
      apply(name, text);
    },
    undo() {
      const step = undoSteps.pop();
      if (!step) return undefined;
      redoSteps.push(step);
      apply(step.template, step.before);
      return step.template;
    },
    redo() {
      const step = redoSteps.pop();
      if (!step) return undefined;
      // 重做之后的下一次改动不和它合成一步。
      undoSteps.push({ ...step, at: 0 });
      apply(step.template, step.after);
      return step.template;
    },
    flush,
    async reload(name) {
      docs.delete(name);
      undoSteps = undoSteps.filter((step) => step.template !== name);
      redoSteps = redoSteps.filter((step) => step.template !== name);
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
