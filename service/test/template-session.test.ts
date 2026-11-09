/**
 * 模板设计页的编辑会话（模板设计页票据 01）：打开只读内容，第一次写回才开工作副本。
 * 只经会话的公开入口驱动，开放 API 用替身，断言发了哪些写入。接口本身的行为在 template-copies 用例里。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const server = vi.hoisted(() => ({
  copy: undefined as { content: string; sha256: string; baseRevision?: number } | undefined,
  current: { content: '{"name":"牌"}\n', sha256: 'current-1', revision: 3 },
  conflictUnchanged: false,
  calls: [] as string[],
}));
vi.mock('../console/src/hooks.js', () => ({ problemsOf: (error: { problems?: unknown }) => error.problems ?? [] }));
vi.mock('../console/src/api.js', () => ({
  ApiError: class extends Error {
    constructor(readonly status: number, readonly problems: readonly unknown[], readonly body?: Record<string, unknown>) { super('api error'); }
  },
  api: {
    workingCopy: async () => {
      server.calls.push('read-copy');
      if (!server.copy) { const { ApiError } = await import('../console/src/api.js'); throw new ApiError(404, []); }
      return server.copy;
    },
    templateContent: async () => { server.calls.push('read-content'); return { name: '牌', ...server.current }; },
    checkWorkingCopy: async () => { server.calls.push('check'); return server.conflictUnchanged ? { conflict: { ours: { status: 'unchanged' } } } : {}; },
    openWorkingCopy: async () => { server.calls.push('open'); server.copy = { content: server.current.content, sha256: server.current.sha256, baseRevision: server.current.revision }; return server.copy; },
    stashWorkingCopy: async (_name: string, expected: string, text: string) => { server.calls.push(`stash:${expected}`); server.copy = { content: text, sha256: `sha-${text.length}`, baseRevision: server.current.revision }; return { sha256: server.copy.sha256 }; },
    discardWorkingCopy: async () => { server.calls.push('discard'); server.copy = undefined; },
  },
}));
vi.stubGlobal('window', globalThis);

const { createDesignSession } = await import('../console/src/template/session.js');
const NAME = '牌';
const edited = { name: '牌', artboard: { fill: '#FF0000' } };

beforeEach(() => {
  server.copy = undefined;
  server.current = { content: '{"name":"牌"}\n', sha256: 'current-1', revision: 3 };
  server.conflictUnchanged = false;
  server.calls = [];
});

describe('模板设计的编辑会话', () => {
  it('没有工作副本时只读当前修订，不写任何东西', async () => {
    const session = createDesignSession();
    await session.open(NAME);
    const doc = session.getState().docs.get(NAME)!;
    expect(doc.opened).toBe(false);
    expect(doc.sha256).toBe('current-1');
    expect(doc.baseRevision).toBe(3);
    expect(server.calls).toEqual(['read-copy', 'read-content']);
    session.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(server.calls.filter((call) => call === 'open' || call === 'discard' || call.startsWith('stash'))).toEqual([]);
  });

  it('第一次写回才开工作副本，预期哈希是打开时读到的内容', async () => {
    const session = createDesignSession();
    await session.open(NAME);
    session.edit(NAME, edited);
    await session.flush();
    expect(server.calls).toEqual(['read-copy', 'read-content', 'open', 'read-copy', 'stash:current-1']);
    expect(session.getState().docs.get(NAME)!.opened).toBe(true);
  });

  it('打开之后别处保存了新修订：第一次写回按"别处先改了"处理，由人决定，不悄悄盖掉', async () => {
    const session = createDesignSession();
    await session.open(NAME);
    server.current = { content: '{"name":"牌","new":true}\n', sha256: 'current-2', revision: 4 };
    session.edit(NAME, edited);
    await session.flush();
    const failure = session.getState().docs.get(NAME)!.failure;
    expect(failure?.stale).toBe('current-2');
    expect(server.calls.filter((call) => call.startsWith('stash'))).toEqual([]);
    await session.overwrite(NAME);
    expect(server.calls.at(-1)).toBe('stash:current-2');
    expect(session.getState().docs.get(NAME)!.failure).toBeUndefined();
  });

  it('改了又都撤销：离开时删掉这次开的工作副本', async () => {
    const session = createDesignSession();
    await session.open(NAME);
    session.edit(NAME, edited);
    await session.flush();
    session.undo();
    await session.flush();
    session.dispose();
    await vi.waitFor(() => expect(server.calls.at(-1)).toBe('discard'));
  });

  it('基准已变而这边没有改动的旧工作副本：打开时丢掉，改读当前修订', async () => {
    server.copy = { content: '{"name":"牌"}\n', sha256: 'old', baseRevision: 2 };
    server.conflictUnchanged = true;
    const session = createDesignSession();
    await session.open(NAME);
    expect(server.calls).toEqual(['read-copy', 'check', 'discard', 'read-content']);
    expect(session.getState().docs.get(NAME)!.opened).toBe(false);
  });

  it('改结构的每个操作一步撤销，撤销还原字节（票据 12）', async () => {
    const { duplicateElement, wrapInContainer } = await import('../console/src/template/structure.js');
    const { parseTemplateText } = await import('../console/src/template/document.js');
    const original = `${JSON.stringify({ name: NAME, artboard: { children: [{ type: 'rect', name: '甲', place: { left: 1, top: 1 } }] } }, null, 2)}\n`;
    server.current = { content: original, sha256: 'current-1', revision: 3 };
    const session = createDesignSession();
    await session.open(NAME);
    const text = () => session.getState().docs.get(NAME)!.text;
    const copied = duplicateElement(parseTemplateText(text()), NAME, `${NAME}/甲`)!;
    session.edit(NAME, copied.document, 'structure:duplicate');
    const wrapped = wrapInContainer(parseTemplateText(text()), NAME, copied.path)!;
    session.edit(NAME, wrapped.document, 'structure:wrap');
    session.undo();
    expect(parseTemplateText(text())).toEqual(copied.document);
    session.undo();
    expect(text()).toBe(original);
  });

  it('已有工作副本：读它，改动直接暂存，不再开', async () => {
    server.copy = { content: '{"name":"牌"}\n', sha256: 'mine', baseRevision: 3 };
    const session = createDesignSession();
    await session.open(NAME);
    session.edit(NAME, edited);
    await session.flush();
    expect(server.calls).toEqual(['read-copy', 'check', 'stash:mine']);
  });
});
