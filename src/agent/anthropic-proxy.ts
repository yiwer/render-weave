/** Anthropic 透明本机转发：上游凭据只属于宿主，执行器仅得到随轮次关闭的令牌。 */
import { randomBytes } from 'node:crypto';
import { Agent as HttpAgent, createServer, request as httpRequest, type ClientRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { ModelProxy } from './model-proxy.js';
import { credentialRedactor } from './credential-redaction.js';
export async function startAnthropicProxy(options: { upstream: string; key: string }): Promise<ModelProxy> {
  const token = randomBytes(24).toString('hex'), safe = credentialRedactor([options.key, token]);
  const upstream = new URL(options.upstream), secure = upstream.protocol === 'https:';
  if (upstream.protocol !== 'http:' && !secure || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('模型端点必须是没有内嵌凭据、查询或片段的 HTTP(S) 地址');
  const agent = secure ? new HttpsAgent({ keepAlive: true }) : new HttpAgent({ keepAlive: true });
  const active = new Set<ClientRequest>();
  let port = 0;
  const server = createServer(async (request, response) => {
    const reject = (status: number, message: string) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ type: 'error', error: { type: 'permission_error', message } })); };
    if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(request.headers.host ?? '') || request.headers.origin !== undefined) { reject(403, '仅接受本轮本机模型请求'); return; }
    if (request.headers.authorization !== `Bearer ${token}` && request.headers['x-api-key'] !== token) { reject(401, '本轮令牌不对'); return; }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1');
    const allowed = request.method === 'POST' && ['/v1/messages', '/v1/messages/count_tokens'].includes(path.pathname) || request.method === 'GET' && path.pathname === '/v1/models';
    if (!allowed) { reject(404, '不是受支持的模型接口'); return; }
    const chunks: Buffer[] = []; let size = 0;
    try { for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 64 * 1024 * 1024) { reject(413, '模型请求过大'); return; } chunks.push(bytes); } }
    catch { response.destroy(); return; }
    const target = new URL(upstream.toString()); target.pathname = upstream.pathname.replace(/\/$/, '') + path.pathname; target.search = path.search;
    const headers: Record<string, string> = { authorization: `Bearer ${options.key}`, 'content-type': 'application/json', 'accept-encoding': 'identity' };
    for (const name of ['anthropic-version', 'anthropic-beta', 'x-claude-code-session-id', 'x-opencode-session']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name];
    const forwarded = (secure ? httpsRequest : httpRequest)(target, { method: request.method, headers, agent, timeout: 600_000 }, received => {
      response.writeHead(received.statusCode ?? 502, { 'content-type': received.headers['content-type'] ?? 'application/json', ...(received.headers['retry-after'] ? { 'retry-after': received.headers['retry-after'] } : {}) });
      const redacted = safe.stream(); received.on('error', () => response.destroy()); redacted.on('error', () => response.destroy());
      received.pipe(redacted).pipe(response);
    });
    active.add(forwarded);
    forwarded.on('close', () => active.delete(forwarded));
    forwarded.on('timeout', () => forwarded.destroy(new Error('模型服务响应超时')));
    forwarded.on('error', error => { if (!response.headersSent) reject(502, safe.text(error.message)); else response.destroy(); });
    response.on('close', () => { if (!response.writableFinished) forwarded.destroy(); });
    forwarded.end(Buffer.concat(chunks));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('本机模型代理地址不可用'); port = address.port;
  return { url: `http://127.0.0.1:${port}`, token, async close() { for (const request of active) request.destroy(); agent.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}