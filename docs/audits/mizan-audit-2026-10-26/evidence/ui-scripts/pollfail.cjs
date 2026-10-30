// One failed background poll (GET /api/db every 15 s), then the user keeps working: are later saves sent?
const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  const sent = []; page.on('request', (r) => { if (/\/api\/(diff|db)$/.test(r.url())) sent.push(`${r.method()} ${r.url().split('/api/')[1]} @${Math.round((Date.now() - t0) / 1000)}s`); });
  let t0 = Date.now();
  await page.goto(BASE + '/'); await page.fill('#login', 'admin'); await page.fill('#password', 'audit-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  t0 = Date.now(); sent.length = 0;
  let failed = false;
  await page.route('**/api/db', (route) => { if (!failed) { failed = true; return route.abort('internetdisconnected'); } return route.continue(); });
  await page.waitForTimeout(16500); // first poll fires and fails
  await page.evaluate(() => { location.hash = '#/contacts/contacts/2'; }); await page.waitForSelector('.title-field input');
  const orig = await page.inputValue('.title-field input');
  await page.fill('.title-field input', orig + ' after-blip'); await page.click('.dirty .btn.primary');
  await page.waitForTimeout(17000);
  const server = await page.evaluate(async () => (await (await fetch('/api/db')).json()).records['res.partner'].find((p) => p.id === 2).name);
  console.log('requests:', JSON.stringify(sent));
  console.log('UI shows:', JSON.stringify(await page.inputValue('.title-field input')), '| server has:', JSON.stringify(server), '| dialogs:', JSON.stringify(dialogs));
  await browser.close();
})();
