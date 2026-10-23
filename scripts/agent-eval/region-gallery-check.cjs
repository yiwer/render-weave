/** 验证本地结果页的模板/重复/阶段切换、图片和窄屏；不调用模型。 */
const { chromium } = require('playwright');
const { pathToFileURL } = require('node:url');
const { resolve, join } = require('node:path');
const { readFileSync, writeFileSync } = require('node:fs');
const { parseArgs } = require('node:util');
const { values } = parseArgs({ options: { root: { type: 'string' } }, strict: true });
if (!values.root) throw Error('需要 --root 归档目录');
const root = resolve(values.root), report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(pathToFileURL(join(root, 'index.html')).href);
    let combinations = 0;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1100 });
      for (const c of report.cases) for (const rep of ['1', '2']) for (const stage of ['0', '1']) {
        await page.selectOption('#case', c.id); await page.selectOption('#rep', rep); await page.selectOption('#stage', stage);
        await page.waitForFunction(() => [...document.images].filter(i => !i.hidden).every(i => i.complete && i.naturalWidth > 0));
        if (await page.locator('#summary tr').count() !== 6) throw Error('缺少策略汇总');
        if (await page.locator('#reference').getAttribute('src') !== report.baselines[c.id].reference) throw Error('参考图模板混淆');
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('页面横向溢出');
        for (const arm of ['role', 'region']) {
          const expected = report.rows.find(r => r.caseId === c.id && r.repetition === Number(rep) && r.arm === arm)?.rounds[Number(stage)];
          const path = await page.locator('#' + arm + 'img').getAttribute('src');
          if (path !== (expected?.archived.image?.file ?? null)) throw Error('候选图单元混淆');
          if (!(await page.locator('#' + arm + 'feedback').textContent()).length) throw Error('缺少反馈说明');
        }
        combinations++;
      }
      await page.selectOption('#case', 'all');
      if (!(await page.locator('#shown').textContent()).includes('汇总全部模板')) throw Error('未区分汇总和展示模板');
      await page.screenshot({ path: join(root, 'gallery-' + width + '.png'), fullPage: true });
    }
    if (errors.length) throw Error(errors.join(';'));
    const result = { pass: true, combinations, viewports: [1440, 390], pageErrors: errors };
    writeFileSync(join(root, 'gallery-check.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
