const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'ar-EG' });
  await ctx.addInitScript(() => { try { localStorage.setItem('mizan-lang', 'ar'); } catch {} });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.message()); if (d.type() === 'prompt') await d.accept('١٠٠'); else await d.accept(); });
  await page.goto(BASE + '/#/sales/orders/new?view=list'); await page.waitForSelector('.form-page');
  await page.click('text=إضافة بند').catch(() => {});
  const num = await page.$('.lines input[type=number]');
  if (num) { await num.click(); await page.keyboard.type('١٢٣'); console.log('number input after typing Arabic-Indic ١٢٣ ->', JSON.stringify(await num.inputValue())); }
  // Register Payment on an unpaid posted invoice via prompt answered with Arabic-Indic digits
  await page.goto(BASE + '/#/accounting/invoices?view=list'); await page.waitForSelector('table.list tbody tr');
  const rows = await page.$$('table.list tbody tr');
  for (const r of rows) { await r.click(); await page.waitForSelector('.form-page'); const btn = await page.$('.form-header button:has-text("تسجيل دفعة")'); if (btn) { const before = await page.textContent('dl.totals'); await btn.click(); await page.waitForTimeout(400); const after = await page.textContent('dl.totals'); console.log('prompt text:', JSON.stringify(dialogs.at(-1)), '| answered ١٠٠ -> totals changed?', before !== after); break; } await page.goBack(); await page.waitForSelector('table.list tbody tr'); }
  await browser.close();
})();
