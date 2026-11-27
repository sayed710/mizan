const { chromium } = require('playwright');
const fs = require('fs');
const [BASE, DBFILE, DIR] = process.argv.slice(2);
const dbJson = fs.readFileSync(DBFILE, 'utf8');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 1100 } });
  await ctx.addInitScript((d) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('mizan-db-v32', d); sessionStorage.setItem('seeded', '1'); } localStorage.setItem('mizan-lang', 'en'); } catch {} }, dbJson);
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/print/account.move/10'); await page.waitForTimeout(500);
  const txt = (await page.textContent('body')).replace(/\s+/g, ' ');
  const pick = (re) => (txt.match(re) ?? [''])[0];
  console.log('header/company:', pick(/Mizan[^$]{0,40}|My Company[^$]{0,20}/), '| currency mentions:', JSON.stringify(txt.match(/\b(USD|SAR|EUR)\b/g)), '| amounts:', JSON.stringify(txt.match(/[$€][\d,]+\.\d\d/g)?.slice(0, 6)));
  await page.screenshot({ path: `${DIR}/print-sar-invoice.png` });
  await browser.close();
})();
