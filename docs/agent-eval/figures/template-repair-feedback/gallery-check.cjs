const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(resolve('docs/agent-eval/figures/template-repair-feedback/index.html')).href);
    const cases = await page.locator('#case option').evaluateAll(ns => ns.map(n => n.value));
    let combinations = 0;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      for (const id of cases) for (const repetition of ['1', '2']) for (const round of ['0', '1']) {
        await page.selectOption('#case', id); await page.selectOption('#repeat', repetition); await page.selectOption('#round', round);
        await page.waitForFunction(() => [...document.images].filter(i => !i.hidden).every(i => i.complete && i.naturalWidth > 0));
        if (await page.locator('img:visible').count() !== 4) throw Error('missing result image ' + id + repetition + round);
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('overflow ' + width + ' ' + id);
        if ((await page.locator('#feedback').textContent()).length === 0) throw Error('missing feedback');
        combinations++;
      }
      await page.selectOption('#case', 'b'); await page.selectOption('#repeat', '1'); await page.selectOption('#round', '1');
      await page.waitForFunction(() => [...document.images].filter(i => !i.hidden).every(i => i.complete && i.naturalWidth > 0));
      await page.screenshot({ path: 'out/repair-gallery-' + width + '.png', fullPage: true });
    }
    if (errors.length) throw Error(errors.join(';'));
    const result = { pass: true, cases, combinations, viewports: [1440, 390], pageErrors: errors };
    writeFileSync('docs/agent-eval/figures/template-repair-feedback/gallery-check.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
