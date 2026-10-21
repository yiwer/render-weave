/**
 * 页面共用的小工具：# 路由、加载数据、草稿预览的排队。
 * - 路由用 location.hash（如 #/datasets/badge-1?template=会议胸牌），接口进程只需提供 index.html 与构建产物；
 * - 预览按租户限并发与频率（票据 06）：本页的预览排成一队、一次一个；被限频（429）时等几秒再试，不报错。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api.js';
import type { PreviewReply, Problem } from './types.js';

export interface Route { readonly path: readonly string[]; readonly query: URLSearchParams }

function parseHash(): Route {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?', 2);
  return { path: path.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment)), query: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseHash);
  useEffect(() => {
    const update = () => setRoute(parseHash());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

/** 生成 # 链接：路径各段按 URL 编码，查询参数略去空值。 */
export function href(path: readonly string[], query: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1]))).toString();
  return `#/${path.map(encodeURIComponent).join('/')}${search ? `?${search}` : ''}`;
}
export const go = (path: readonly string[], query?: Record<string, string | undefined>) => { location.hash = href(path, query); };

export interface Loaded<T> { readonly data?: T; readonly problems?: readonly Problem[]; readonly loading: boolean; readonly reload: () => void }

/** 加载数据；key 变了重新加载，先到的旧结果不覆盖新的。 */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [state, setState] = useState<{ data?: T; problems?: readonly Problem[]; loading: boolean }>({ loading: true });
  const [round, setRound] = useState(0);
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    let live = true;
    setState((previous) => ({ ...previous, loading: true }));
    loader.current().then(
      (data) => { if (live) setState({ data, loading: false }); },
      (error: unknown) => { if (live) setState({ problems: problemsOf(error), loading: false }); },
    );
    return () => { live = false; };
  }, [key, round]);
  return { ...state, reload: useCallback(() => setRound((value) => value + 1), []) };
}

export function problemsOf(error: unknown): readonly Problem[] {
  if (error instanceof ApiError) return error.problems;
  return [{ code: 'console.error', level: 'severe', location: { kind: 'input', source: 'console' }, message: error instanceof Error ? error.message : String(error) }];
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
let queue: Promise<unknown> = Promise.resolve();

/**
 * 排队出一张草稿预览。stale() 为真时不再发送（页面已换了请求或离开）；
 * 被限频时等 3 秒再试，onWait 告诉页面正在等。
 */
export function queuePreview(request: unknown, stale: () => boolean, onWait?: (waiting: boolean) => void): Promise<PreviewReply | undefined> {
  const task = async () => {
    for (let attempt = 0; ; attempt++) {
      if (stale()) return undefined;
      try {
        const reply = await api.preview(request);
        onWait?.(false);
        return reply;
      } catch (error) {
        const limited = error instanceof ApiError && error.status === 429 && attempt < 20;
        if (!limited) throw error;
        onWait?.(true);
        await sleep(3000);
      }
    }
  };
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export interface LivePreview {
  readonly reply?: PreviewReply;
  readonly problems?: readonly Problem[];
  readonly loading: boolean;
  readonly waiting: boolean;
  readonly refresh: () => void;
}

/** 请求变了就在 delayMs 之后重新预览；只显示最后一次请求的结果。request 为 undefined 时不预览。 */
export function useLivePreview(request: unknown, delayMs = 600): LivePreview {
  const text = request === undefined ? '' : JSON.stringify(request);
  const [state, setState] = useState<{ reply?: PreviewReply; problems?: readonly Problem[]; loading: boolean; waiting: boolean }>({ loading: false, waiting: false });
  const [round, setRound] = useState(0);
  const latest = useRef(0), forced = useRef(false);
  useEffect(() => {
    if (!text) return undefined;
    const ticket = ++latest.current, stale = () => ticket !== latest.current;
    const delay = forced.current ? 0 : delayMs;
    forced.current = false;
    const timer = window.setTimeout(() => {
      setState((previous) => ({ ...previous, loading: true }));
      queuePreview(JSON.parse(text), stale, (waiting) => { if (!stale()) setState((previous) => ({ ...previous, waiting })); }).then(
        (reply) => { if (reply && !stale()) setState({ reply, loading: false, waiting: false }); },
        (error: unknown) => { if (!stale()) setState({ problems: problemsOf(error), loading: false, waiting: false }); },
      );
    }, delay);
    return () => { window.clearTimeout(timer); };
  }, [text, round, delayMs]);
  useEffect(() => () => { latest.current++; }, []);
  return { ...state, refresh: useCallback(() => { forced.current = true; setRound((value) => value + 1); }, []) };
}
