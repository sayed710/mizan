const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mizan-lang', 'ar'); } catch {} });
  const page = await ctx.newPage();
  const dialogs = [];
  let answer = '١٠٠';
  page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); if (d.type() === 'prompt') await d.accept(answer); else await d.accept(); });
  for (let id = 1; id <= 12; id++) {
    await page.goto(BASE + `/#/accounting/invoices/${id}?view=list`); await page.waitForSelector('.form-page');
    const labels = await page.$$eval('.form-header button', (bs) => bs.map((b) => b.textContent));
    const i = labels.findIndex((l) => /دفعة/.test(l));
    if (i < 0) continue;
    const totals = async () => (await page.textContent('dl.totals')).replace(/\s+/g, ' ');
    const before = await totals();
    await (await page.$$('.form-header button'))[i].click(); await page.waitForTimeout(400);
    const afterArabic = await totals();
    answer = '1,000';
    await (await page.$$('.form-header button'))[i].click(); await page.waitForTimeout(400);
    const afterComma = await totals();
    console.log(`invoice ${id} button "${labels[i]}" | prompts: ${JSON.stringify(dialogs)}`);
    console.log(`answer ١٠٠ -> changed=${before !== afterArabic} | answer "1,000" -> changed=${afterArabic !== afterComma} | no error dialog shown: ${!dialogs.some((d) => d.startsWith('alert'))}`);
    break;
  }
  await browser.close();
})();
