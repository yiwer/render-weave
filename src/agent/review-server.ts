/**
 * 本地审核页（第三阶段 PRD 第 10 条，M221 的最小可用版本）：`renderweave agent review` 启动的单用户本地服务。
 * 只绑定 127.0.0.1，只服务一个轮次目录；页面与数据都来自本服务，审核结果经 changeReview 写入 review.json。
 *
 * 它是命令行附带的本地页面，不是阶段 4 的 HTTP 服务外壳：只用 node:http，没有框架，不出图、不发布（M227）。
 * 防止其他网页借浏览器改动审核结果：Host 必须是本机地址加本服务端口（防 DNS 重绑定）；
 * 写操作必须是 application/json，且 Origin（若有）必须是本服务（跨站请求会先预检，本服务不应答 CORS）。
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeError } from '../util.js';
import { PREVIEW_DIR } from './preview.js';
import { changeReview, readReview } from './review.js';

const PAGE = fileURLToPath(new URL('../../web/review.html', import.meta.url));
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export interface ReviewServer {
  /** 审核页地址，如 http://127.0.0.1:53124/。 */
  readonly url: string;
  close(): Promise<void>;
}

/** 启动审核页服务；port 为 0 或省略时由系统分配端口。 */
export async function startReviewServer(options: { readonly roundDir: string; readonly port?: number }): Promise<ReviewServer> {
  let port = 0;
  // 写操作逐个执行：两个页面同时操作时，每次都基于最新的 review.json。
  let queue: Promise<unknown> = Promise.resolve();
  const server = createServer((request, response) => {
    handle(request, response).catch((error) => send(response, 500, { error: describeError(error) }));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(response, 403, { error: '只接受本机地址的请求' });
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
      response.end(await readFile(PAGE));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/review') {
      const result = await readReview(options.roundDir);
      return send(response, result.view || result.execution ? 200 : 409, result);
    }
    if (request.method === 'GET' && url.pathname === '/sample') {
      const { view, problems } = await readReview(options.roundDir);
      if (!view) return send(response, 409, { problems });
      const extension = view.round.sample.slice(view.round.sample.lastIndexOf('.') + 1);
      response.writeHead(200, { 'content-type': IMAGE_TYPES[extension] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(await readFile(join(view.round.dir, view.round.sample)));
      return;
    }
    // 预览图：RenderWeave 重新渲染、缓存在轮次目录 previews/ 下的 PNG，文件名是输入的哈希。
    const preview = /^\/previews\/([0-9a-f]{64}\.png)$/.exec(url.pathname);
    if (request.method === 'GET' && preview) {
      let bytes: Buffer;
      try { bytes = await readFile(join(options.roundDir, PREVIEW_DIR, preview[1]!)); } catch { return send(response, 404, { error: '没有这张预览图' }); }
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      response.end(bytes);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/review') {
      const origin = request.headers.origin;
      if (origin !== undefined && origin !== `http://${host}`) return send(response, 403, { error: '不接受其他网页发来的审核操作' });
      if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(response, 415, { error: '审核操作必须是 application/json' });
      let change: unknown;
      try {
        change = JSON.parse(await readBody(request));
      } catch (error) {
        return send(response, 400, { error: `审核操作不是有效的 JSON：${describeError(error)}` });
      }
      const result = queue.then(() => changeReview(options.roundDir, change));
      queue = result.catch(() => undefined);
      const { view, problems } = await result;
      return send(response, problems.length > 0 ? 409 : 200, { ...(view ? { view } : {}), problems });
    }
    return send(response, 404, { error: '没有这个地址' });
  }

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(options.port ?? 0, '127.0.0.1', () => done());
  });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    }),
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error(`超过 ${MAX_BODY_BYTES} 字节`);
    chunks.push(chunk as Buffer);
  }
  // 严格按 UTF-8 解码：其他编码的中文（如 Windows 命令行按本地代码页发出的）会被拒绝，而不是悄悄变成乱码存进 review.json。
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new Error('请求体不是有效的 UTF-8');
  }
}
