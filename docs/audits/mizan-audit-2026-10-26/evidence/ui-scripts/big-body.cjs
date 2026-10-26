const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  await page.goto(BASE + '/');
  await page.fill('#login', 'admin'); await page.fill('#password', 'audit-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  const out = await page.evaluate(async () => {
    const big = 'x'.repeat(6 * 1024 * 1024);
    try {
      const r = await fetch('/api/diff', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ upserts: {}, deletes: {}, messages: [], removedMessages: [], seq: {}, settings: null, pad: big }) });
      return `HTTP ${r.status} ${r.headers.get('content-type')} ${(await r.text()).slice(0, 80)}`;
    } catch (e) { return `fetch rejected: ${e.name}: ${e.message}`; }
  });
  console.log('6 MB /api/diff ->', out);
  await browser.close();
})();
