// Server mode: what does the user see when /api/diff answers 400, and what happens after one failed request?
const { chromium } = require('playwright');
const [BASE, DIR] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.accept(); });
  const diffs = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/diff')) diffs.push({ t: Date.now(), body: r.postData()?.length }); });
  page.on('response', async (r) => { if (r.url().endsWith('/api/diff')) diffs.push({ status: r.status() }); });
  await page.goto(BASE + '/');
  await page.fill('#login', 'admin'); await page.fill('#password', 'audit-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  console.log('logged in');

  // A) edit a seeded document record -> server rejects (schema/seed drift)
  await page.evaluate(() => { location.hash = '#/documents/all?view=list'; }); await page.waitForSelector('table.list tbody tr');
  await page.click('table.list tbody tr:not(.group-row) td:nth-child(2)'); await page.waitForSelector('.form-page');
  const before = await page.inputValue('.title-field input');
  await page.fill('.title-field input', before + ' EDITED');
  await page.click('.dirty .btn.primary');
  await page.waitForTimeout(800);
  const after = await page.inputValue('.title-field input');
  console.log('A) dialogs:', JSON.stringify(dialogs.splice(0)), '| title before:', JSON.stringify(before), 'after save+reject:', JSON.stringify(after), '| form error box:', await page.$eval('.form-page', (e) => e.querySelector('.alert')?.textContent ?? null));
  await page.screenshot({ path: `${DIR}/server-400-after.png` });

  // B) create a new timesheet line with negative hours -> client accepts, server guard rejects
  await page.evaluate(() => { location.hash = '#/timesheets/timesheets/new?view=list'; }); await page.waitForSelector('.form-page');
  const desc = await page.$('.title-field input'); if (desc) await desc.fill('Audit negative hours');
  const hours = await page.$('#f-unit_amount'); if (hours) await hours.fill('-5');
  await page.click('.dirty .btn.primary');
  await page.waitForTimeout(800);
  console.log('B) dialogs:', JSON.stringify(dialogs.splice(0)), '| url now:', page.url().split('#')[1], '| page says:', (await page.textContent('main')).slice(0, 120).replace(/\s+/g, ' '));
  await page.screenshot({ path: `${DIR}/server-400-new-record.png` });

  // C) one network failure on /api/diff, then later edits
  await page.evaluate(() => { location.hash = '#/contacts/contacts?view=list'; }); await page.waitForSelector('table.list tbody tr');
  await page.click('table.list tbody tr:not(.group-row) td:nth-child(2)'); await page.waitForSelector('.form-page');
  const contactUrl = page.url();
  let aborted = 0;
  await page.route('**/api/diff', (route) => { if (aborted++ === 0) route.abort('connectionreset'); else route.continue(); });
  const n0 = diffs.filter((d) => d.body).length;
  const name0 = await page.inputValue('.title-field input');
  await page.fill('.title-field input', name0 + ' X1'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(600);
  await page.fill('.title-field input', name0 + ' X2'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(600);
  await page.fill('.title-field input', name0 + ' X3'); await page.click('.dirty .btn.primary'); await page.waitForTimeout(1500);
  const sent = diffs.filter((d) => d.body).length - n0;
  console.log('C) saves clicked: 3 | /api/diff requests issued after the failure:', sent, '| dialogs:', JSON.stringify(dialogs.splice(0)), '| UI shows:', JSON.stringify(await page.inputValue('.title-field input')));
  const server = await page.evaluate(async () => { const r = await fetch('/api/db'); const d = await r.json(); return d.records['res.partner'].map((p) => p.name); });
  console.log('C) server partner names containing X:', JSON.stringify(server.filter((n) => / X\d/.test(n))));
  // wait for one poll cycle (15 s) to see whether polling recovers
  await page.waitForTimeout(17000);
  console.log('C) after 17 s: UI still shows', JSON.stringify(await page.inputValue('.title-field input')), '| new /api/db polls?', 'see below');
  const polls = [];
  page.on('request', (r) => { if (r.url().endsWith('/api/db')) polls.push(1); });
  await page.waitForTimeout(16000);
  console.log('C) /api/db polls in next 16 s:', polls.length);
  await page.screenshot({ path: `${DIR}/server-after-network-failure.png` });
  await browser.close();
})();
