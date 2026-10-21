/**
 * 出图控制台的浏览器端到端测试，本机快速版：内存后端、进程内 worker、本机浏览器（票据 12）。
 * 只在设了 RW_BROWSER（Chromium 内核浏览器的可执行文件）时运行，先在 service/ 下 npm run build 构建控制台；
 * 验收以 Docker 后端（console.docker.test.ts）为准。例：
 *   $env:RW_BROWSER = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'; npx vitest run service/test/console.browser.test.ts
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApi } from '../src/api/app.js';
import { rendererBuildId } from '../src/engine.js';
import { createLogger } from '../src/log.js';
import { createMemoryBackend } from '../src/memory.js';
import { inProcessRunner, startScheduler } from '../src/worker/scheduler.js';
import { describeConsole } from './console-suite.js';

const CONSOLE_DIR = fileURLToPath(new URL('../dist/console/', import.meta.url));
const browser = process.env['RW_BROWSER'];
if (browser && !existsSync(`${CONSOLE_DIR}index.html`)) throw new Error('控制台没有构建：先在 service/ 下执行 npm run build');
const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
const silentLogger = { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return silentLogger; } } as never;

describeConsole('内存后端', async () => createMemoryBackend(), {
  skip: !browser,
  inProcessWorker: true,
  start: async (backend) => {
    const app = createApi({ backend, build: 'sha256:test', logger: createLogger('api', 'sha256:test', 'info', silent), passwordCost: 'test', secretKey: randomBytes(32), consoleDir: CONSOLE_DIR });
    // 批次项按引擎的构建标识领取（ADR-0019）：进程内 worker 用本进程引擎的构建标识。
    const scheduler = startScheduler({ backend, runner: inProcessRunner(backend), logger: silentLogger, pollMs: 20, workerId: 'console-browser', build: await rendererBuildId(), leaseMs: 120_000 });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return { baseUrl: address, stop: async () => { await scheduler.stop(); await app.close(); } };
  },
  launch: { executablePath: browser ?? '', headless: true },
});
