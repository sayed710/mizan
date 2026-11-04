// In Arabic (dir=rtl), where does the minus sign of a negative amount end up visually?
const { chromium } = require('playwright');
const [BASE, DIR] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('mizan-lang', 'ar'); } catch {} });
  const page = await ctx.newPage();
  await page.goto(BASE + '/#/accounting/bank?view=list'); await page.waitForSelector('table.list');
  await page.waitForTimeout(200);
  const res = await page.evaluate(() => {
    const out = [];
    for (const td of document.querySelectorAll('td.num, .journal-card dd, dd')) {
      const tx = td.textContent;
      const i = tx.indexOf('-');
      if (i < 0 || !/\d/.test(tx)) continue;
      const node = [...td.childNodes].find((n) => n.nodeType === 3 && n.textContent.includes('-')) ?? td.firstChild;
      if (!node || node.nodeType !== 3) continue;
      const r = document.createRange(); r.setStart(node, node.textContent.indexOf('-')); r.setEnd(node, node.textContent.indexOf('-') + 1);
      const minus = r.getBoundingClientRect();
      const full = document.createRange(); full.selectNodeContents(td); const box = full.getBoundingClientRect();
      out.push(`${JSON.stringify(tx)} minus at x=${Math.round(minus.left)} text spans ${Math.round(box.left)}..${Math.round(box.right)} => minus is ${minus.left - box.left > (box.right - box.left) / 2 ? 'RIGHT (trailing)' : 'LEFT (leading)'}`);
    }
    return out.slice(0, 6);
  });
  console.log(res.join('\n'));
  await page.screenshot({ path: `${DIR}/bank-lines-ar.png`, clip: { x: 0, y: 0, width: 1366, height: 420 } });
  await browser.close();
})();
