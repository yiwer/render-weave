import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { expect, it } from 'vitest';
import { createMemoryBackend } from '../src/memory.js';
import { createWorld } from './api-suite.js';
import { seedGreeting, seedDocuments, SINGLE_TEXT } from './seed.js';

it.skipIf(!process.env['RW_BROWSER'])('范围出图在提交前拦截遗漏参数，范围值与 false/0/空字符串缺省值不误报缺失', async () => {
  const backend = createMemoryBackend(), world = await createWorld(backend, { api: { consoleDir: 'service/dist/console' } });
  const storage = backend.tenant(world.b.id).storage;
  await seedGreeting(storage, { withFont: true });
  const template = JSON.parse(await readFile(`${SINGLE_TEXT}template-greeting.json`, 'utf8'));
  template.parameters = [
    { name: 'position', displayName: '序号', visibility: 'public', type: 'number', constraints: { integer: true, min: 1, max: 3 } },
    { name: 'caption', displayName: '标题', visibility: 'public', type: 'text' },
    { name: 'enabled', displayName: '开关', visibility: 'public', type: 'boolean', default: false },
    { name: 'offset', displayName: '偏移', visibility: 'public', type: 'number', default: 0 },
    { name: 'note', displayName: '说明', visibility: 'public', type: 'text', default: '' },
  ];
  await seedDocuments(storage, [Buffer.from(JSON.stringify(template))]);
  const url = await world.app.listen({ host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ executablePath: process.env['RW_BROWSER']!, headless: true });
  try {
    const page = await browser.newPage(); page.setDefaultTimeout(4000); let submissions = 0;
    page.on('request', r => { if (r.url().endsWith('/v1/batches') && r.method() === 'POST') submissions++; });
    await page.goto(`${url}/console/#/deliver?datasets=ds-greeting`);
    await page.getByLabel('邮箱').fill(world.b.operator.email); await page.getByLabel('密码').fill(world.b.operator.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    const sheet = page.getByRole('dialog');
    await sheet.getByLabel('按一个整数参数的范围，每个值出一张').check();
    await sheet.getByLabel('从', { exact: true }).fill('1'); await sheet.getByLabel('到', { exact: true }).fill('3');
    await sheet.getByRole('button', { name: '提交 3 张', exact: true }).click();
    expect(submissions).toBe(0);
    await sheet.getByText('请填写“标题”后再提交。', { exact: true }).waitFor();
    await sheet.getByLabel('标题', { exact: true }).fill('已填写');
    const posted = page.waitForResponse(r => r.url().endsWith('/v1/batches') && r.request().method() === 'POST');
    await sheet.getByRole('button', { name: '提交 3 张', exact: true }).click();
    const reply = await posted; expect(reply.status()).toBe(202); expect(submissions).toBe(1);
    expect(reply.request().postDataJSON().items.map((i: any) => i.parameters)).toEqual([1, 2, 3].map(position => ({ enabled: false, offset: 0, note: '', caption: '已填写', position })));
  } finally { await browser.close(); await world.app.close(); }
}, 30000);
