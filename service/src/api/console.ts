/**
 * 出图控制台的静态文件（票据 12，M248、M279）：接口进程把构建好的单页应用放在 /console/ 下；控制台只调用开放 API，没有自己的后端接口。
 * - 文件在启动时读进内存：只回答目录里已有的文件，客户端拼不出目录之外的路径；控制台用 # 路由，没有回退到 index.html 的路径；
 * - index.html 不缓存，assets/ 下带内容哈希的文件长期缓存；视频可以按范围读（Safari 没有 206 不播）；
 * - 内容安全策略只允许同源的脚本、样式与请求，图片另允许 blob:（预览图与资源图片经开放 API 读成 blob 再显示）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { fail, ServiceProblemCodes } from './problems.js';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export const CONSOLE_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' blob: data:", "connect-src 'self'", "font-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

interface ConsoleFile { readonly bytes: Buffer; readonly type: string }

/** 读入构建好的控制台；目录不存在（没构建）时返回 undefined。 */
function loadConsole(dir: string): Map<string, ConsoleFile> | undefined {
  try { if (!statSync(dir).isDirectory()) return undefined; } catch { return undefined; }
  const files = new Map<string, ConsoleFile>();
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name), name = relative(dir, path).split(sep).join('/');
    const type = CONTENT_TYPES[extname(name).toLowerCase()];
    if (type) files.set(name, { bytes: readFileSync(path), type });
  }
  return files.has('index.html') ? files : undefined;
}

/** 请求头 Range 对应的 [起, 止]（都含）；写错或超出文件答 undefined。 */
function parseRange(header: string, size: number): readonly [number, number] | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return undefined;
  const start = match[1] ? Number(match[1]) : Math.max(size - Number(match[2]), 0);
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? [start, end] : undefined;
}

export function registerConsoleRoutes(app: FastifyInstance, consoleDir: string | undefined): void {
  const files = consoleDir === undefined ? undefined : loadConsole(consoleDir);
  const send = (reply: FastifyReply, name: string, range?: string) => {
    const file = files?.get(name);
    if (!file) {
      throw fail(404, ServiceProblemCodes.notFound, 'request.path', files ? '请求的对象不存在' : '出图控制台没有构建：先在 service/ 下执行 npm run build');
    }
    reply.type(file.type)
      .header('cache-control', name.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('content-security-policy', CONSOLE_CSP)
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('x-frame-options', 'DENY');
    if (!file.type.startsWith('video/')) return reply.send(file.bytes);
    reply.header('accept-ranges', 'bytes');
    if (range === undefined) return reply.send(file.bytes);
    const size = file.bytes.length, span = parseRange(range, size);
    if (!span) return reply.code(416).header('content-range', `bytes */${size}`).send();
    return reply.code(206).header('content-range', `bytes ${span[0]}-${span[1]}/${size}`).send(file.bytes.subarray(span[0], span[1] + 1));
  };
  const toConsole = (_request: unknown, reply: FastifyReply) => reply.redirect('/console/', 302);
  app.get('/', { config: { access: 'public', openapi: false }, logLevel: 'warn' }, toConsole);
  app.get('/console', { config: { access: 'public', openapi: false }, logLevel: 'warn' }, toConsole);
  app.get('/console/', { config: { access: 'public', openapi: false }, logLevel: 'warn' }, async (_request, reply) => send(reply, 'index.html'));
  app.get('/console/*', { config: { access: 'public', openapi: false }, logLevel: 'warn' }, async (request, reply) => send(reply, (request.params as { '*': string })['*'], request.headers.range));
}
