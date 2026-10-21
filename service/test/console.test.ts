/**
 * 出图控制台的静态文件（票据 12）：接口进程在 /console/ 下提供构建好的单页应用。
 * 这里不开浏览器，只经 HTTP 核对回答；浏览器里的主路径见 console-suite.ts（Docker 后端）。
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api/app.js';
import { CONSOLE_CSP } from '../src/api/console.js';
import { createLogger } from '../src/log.js';
import { createMemoryBackend } from '../src/memory.js';

const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
const api = (consoleDir?: string) => createApi({
  backend: createMemoryBackend(), build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'info', silent), secretKey: randomBytes(32),
  ...(consoleDir === undefined ? {} : { consoleDir }),
});

describe('出图控制台的静态文件', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rw-console-'));
    await mkdir(join(dir, 'assets'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>控制台</title>');
    await writeFile(join(dir, 'assets', 'index-1a2b3c.js'), 'console.log(1)');
    await writeFile(join(dir, 'notes.md'), '不认识的类型不提供');
    await writeFile(join(tmpdir(), 'rw-console-outside.html'), '目录之外');
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it('index.html 不缓存，带内容哈希的文件长期缓存；都带内容安全策略；根路径转到 /console/', async () => {
    const app = api(dir);
    const index = await app.inject({ method: 'GET', url: '/console/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.headers['content-security-policy']).toBe(CONSOLE_CSP);
    expect(index.headers['x-frame-options']).toBe('DENY');
    expect(index.body).toContain('控制台');

    const script = await app.inject({ method: 'GET', url: '/console/assets/index-1a2b3c.js' });
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');

    for (const url of ['/', '/console']) {
      const moved = await app.inject({ method: 'GET', url });
      expect(moved.statusCode, url).toBe(302);
      expect(moved.headers['location'], url).toBe('/console/');
    }
  });

  it('只回答构建目录里认识的文件：目录之外、不认识的类型与不存在的都答 404 问题清单', async () => {
    const app = api(dir);
    for (const url of ['/console/notes.md', '/console/missing.js', '/console/../rw-console-outside.html', '/console/%2e%2e/rw-console-outside.html',
      '/console/assets/..%2f..%2frw-console-outside.html', '/console/index.html/']) {
      const reply = await app.inject({ method: 'GET', url });
      expect(reply.statusCode, url).toBe(404);
      expect(reply.body, url).not.toContain('目录之外');
      expect(JSON.parse(reply.body).problems[0].code, url).toBe('request.notFound');
    }
  });

  it('没有构建时答 404 并说明怎样构建；控制台的路由不属于开放 API，不在路由表与描述里', async () => {
    const app = api(join(dir, 'not-built'));
    const reply = await app.inject({ method: 'GET', url: '/console/' });
    expect(reply.statusCode).toBe(404);
    expect(JSON.parse(reply.body).problems[0].message).toContain('npm run build');
    expect(app.routeTable.filter((route) => route.url === '/' || route.url.startsWith('/console'))).toEqual([]);
    const doc = JSON.parse((await app.inject({ method: 'GET', url: '/v1/openapi.json' })).body);
    expect(Object.keys(doc.paths).filter((path) => path === '/' || path.startsWith('/console'))).toEqual([]);
  });
});
