const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.goto(BASE + '/'); await page.fill('#login', 'admin'); await page.fill('#password', 'audit-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  const count = () => page.evaluate(async () => { const d = await (await fetch('/api/db')).json(); return { records: Object.values(d.records).reduce((s, r) => s + r.length, 0), partners: d.records['res.partner'].length, msgs: d.messages.length }; });
  // add some "production" data through the normal save path
  await page.evaluate(() => { location.hash = '#/contacts/contacts/new?view=list'; }); await page.waitForSelector('.title-field input');
  await page.fill('.title-field input', 'Real customer created in production'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(800);
  console.log('before reset:', JSON.stringify(await count()));
  await page.evaluate(() => { location.hash = '#/settings/general'; }); await page.waitForSelector('#lock_date');
  await page.click('button.btn.danger'); await page.waitForTimeout(1200);
  console.log('dialogs:', JSON.stringify(dialogs), '| after one click + OK:', JSON.stringify(await count()));
  await browser.close();
})();
