const { chromium } = require('playwright');
const [BASE, DIR] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  for (const lang of ['ar', 'en']) {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 800 } });
    await ctx.addInitScript((l) => { try { localStorage.setItem('mizan-lang', l); } catch {} }, lang);
    const page = await ctx.newPage();
    await page.goto(BASE + '/#/accounting/invoices/1?view=list'); await page.waitForSelector('.form-page'); await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({ sx: scrollX, sy: scrollY, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, sheetRect: JSON.stringify(document.querySelector('.sheet')?.getBoundingClientRect()), widest: [...document.querySelectorAll('.form-page *')].map((e) => [e.className || e.tagName, Math.round(e.getBoundingClientRect().width)]).sort((a, b) => b[1] - a[1]).slice(0, 4) }));
    console.log(lang, JSON.stringify(m));
    await page.screenshot({ path: `${DIR}/invoice-form-${lang}-mobile.png` });
    await page.screenshot({ path: `${DIR}/invoice-form-${lang}-mobile-full.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
})();
