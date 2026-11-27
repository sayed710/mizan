const { chromium } = require('playwright');
const [BASE, DIR] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  for (const lang of ['en', 'ar']) {
    for (const vp of [{ width: 1366, height: 860, tag: 'desktop' }, { width: 375, height: 800, tag: 'mobile' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      await ctx.addInitScript((l) => { try { localStorage.setItem('mizan-lang', l); } catch {} }, lang);
      const page = await ctx.newPage();
      page.on('dialog', (d) => d.dismiss());
      await page.goto(BASE + '/#/'); await page.waitForSelector('.app-grid');
      if (vp.tag === 'desktop') await page.screenshot({ path: `${DIR}/home-${lang}.png` });
      await page.evaluate(() => { location.hash = '#/accounting/invoices?view=list'; }); await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/invoices-list-${lang}-${vp.tag}.png` });
      await page.click('table.list tbody tr:not(.group-row) td:nth-child(2)'); await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/invoice-form-${lang}-${vp.tag}.png`, fullPage: vp.tag === 'desktop' });
      if (vp.tag === 'desktop') {
        await page.evaluate(() => { location.hash = '#/accounting/dashboard'; }); await page.waitForTimeout(250);
        await page.screenshot({ path: `${DIR}/accounting-dashboard-${lang}.png`, fullPage: true });
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log('ok');
})();
