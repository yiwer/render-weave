// 按 canvas/project/canvas.json 的画板尺寸给每张画板截一张 PNG，写到 screenshots/。
// "减少动态"下截取：动画停在终态，登录视频停在封面帧。
// 前提：canvas/project/support.js 已放好（见 README「看稿」）；service/ 装过依赖；RW_BROWSER 指向 Edge 或 Chrome。
// 用法：node docs/prototypes/desktop-workbench/screenshots.mjs
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = join(here, 'canvas');
const out = join(here, 'screenshots');
const browserPath = process.env.RW_BROWSER;
if (!browserPath) throw new Error('请把 RW_BROWSER 设为 Edge 或 Chrome 的可执行文件路径');
if (!existsSync(join(root, 'project', 'support.js'))) throw new Error('缺 canvas/project/support.js，见 README「看稿」');
const { chromium } = createRequire(join(here, '../../../service/package.json'))('playwright-core');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer((request, response) => {
  const file = normalize(join(root, decodeURIComponent(new URL(request.url, 'http://x').pathname)));
  if (!file.startsWith(root) || !existsSync(file)) { response.writeHead(404).end(); return; }
  const type = TYPES[extname(file)] ?? (readFileSync(file).subarray(4, 8).toString() === 'ftyp' ? 'video/mp4' : 'image/jpeg');
  response.writeHead(200, { 'content-type': type });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const canvas = JSON.parse(readFileSync(join(root, 'project', 'canvas.json'), 'utf8'));
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
try {
  for (const name of canvas.order) {
    const board = canvas.boards[name];
    const context = await browser.newContext({ viewport: { width: board.w, height: board.h }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`${base}/project/${name}`, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    const holes = await page.evaluate(() => (document.body.innerText.match(/\{\{[^}]*\}\}/g) ?? []).length);
    const file = `${board.title.split(' ')[0]}-${name.replace('.dc.html', '')}.png`;
    await page.screenshot({ path: join(out, file) });
    console.log(`${file} ${board.w}×${board.h}${errors.length ? ` 页面错误 ${errors.length}` : ''}${holes ? ` 未填的变量 ${holes}` : ''}`);
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
