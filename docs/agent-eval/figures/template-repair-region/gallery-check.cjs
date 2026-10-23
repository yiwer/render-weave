const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(resolve(__dirname, 'index.html')).href);
    let combinations = 0;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      for (const rep of ['1', '2']) for (const stage of ['0', '1']) {
        await page.selectOption('#rep', rep); await page.selectOption('#stage', stage);
        await page.waitForFunction(() => [...document.images].filter(i => !i.hidden).every(i => i.complete && i.naturalWidth > 0));
        if (await page.locator('img:visible').count() !== 4) throw Error('缺少结果图');
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('页面横向溢出');
        for (const arm of ['role', 'region']) if (!(await page.locator('#' + arm + 'feedback').textContent()).length) throw Error('缺少反馈');
        combinations++;
      }
      await page.selectOption('#rep', '1'); await page.selectOption('#stage', '1');
      await page.screenshot({ path: resolve('out/region-gallery-' + width + '.png'), fullPage: true });
    }
    if (errors.length) throw Error(errors.join(';'));
    const result = { pass: true, combinations, viewports: [1440, 390], pageErrors: errors };
    writeFileSync(resolve(__dirname, 'gallery-check.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
