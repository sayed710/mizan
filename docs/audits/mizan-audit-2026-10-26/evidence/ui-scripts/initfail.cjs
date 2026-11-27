// Server mode: if GET /api/db fails once at startup (network blip), what data does the app show, and what does a save send?
const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.goto(BASE + '/'); await page.fill('#login', 'admin'); await page.fill('#password', 'audit-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  // 1) real data on the server: partner 1 gets a real phone + street (another user's work)
  const serverPartner = () => page.evaluate(async () => { const d = await (await fetch('/api/db')).json(); const p = d.records['res.partner'].find((x) => x.id === 1); return { name: p.name, phone: p.phone, city: p.city }; });
  await page.evaluate(() => { location.hash = '#/contacts/contacts/1'; }); await page.waitForSelector('#f-phone');
  await page.fill('#f-phone', '+20 2 REAL-PHONE'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(800);
  console.log('server before:', JSON.stringify(await serverPartner()));
  // 2) reload; the first /api/db request fails at the network level
  let n = 0;
  await page.route('**/api/db', (route) => (n++ === 0 ? route.abort('connectionreset') : route.continue()));
  await page.reload(); await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => ({ grid: !!document.querySelector('.app-grid'), login: !!document.querySelector('#login'), bodyLen: document.body.innerText.length, company: document.querySelector('.company')?.textContent }));
  console.log('after failed /api/db at startup -> UI:', JSON.stringify(shown));
  await page.evaluate(() => { location.hash = '#/contacts/contacts/1'; }); await page.waitForTimeout(500);
  const phoneShown = await page.$('#f-phone') ? await page.inputValue('#f-phone') : null;
  console.log('partner 1 phone shown in UI:', JSON.stringify(phoneShown));
  if (phoneShown !== null) {
    await page.fill('.title-field input', (await page.inputValue('.title-field input')) + ' (renamed)'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(1000);
    await page.unroute('**/api/db');
    console.log('server after a save from that session:', JSON.stringify(await serverPartner()), '| dialogs:', JSON.stringify(dialogs));
  }
  await browser.close();
})();
