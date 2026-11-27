const { chromium } = require('playwright');
const fs = require('fs');
const [BASE, DBFILE] = process.argv.slice(2);
const dbJson = fs.readFileSync(DBFILE, 'utf8');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript((d) => { try { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('mizan-db-v32', d); sessionStorage.setItem('seeded', '1'); } } catch {} }, dbJson);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.dismiss());
  let t = Date.now();
  await page.goto(BASE + '/#/'); await page.waitForSelector('.app-grid');
  console.log('initial load (2.2MB db in localStorage):', Date.now() - t, 'ms');
  const time = async (label, hash, sel) => {
    const t0 = Date.now();
    await page.evaluate((h) => { location.hash = h; }, hash);
    await page.waitForSelector(sel, { timeout: 120000 });
    await page.waitForTimeout(0);
    const ms = Date.now() - t0;
    const nodes = await page.evaluate(() => document.getElementsByTagName('*').length);
    console.log(`${label}: ${ms} ms, DOM nodes ${nodes}`);
  };
  await time('Contacts list (5,0xx partners)', '#/contacts/contacts?view=list', 'table.list tbody tr');
  await time('Contacts kanban', '#/contacts/contacts?view=kanban', 'article.card');
  await time('Invoices list (2,0xx moves)', '#/accounting/invoices?view=list', 'table.list tbody tr');
  // keystroke latency in a form: the whole app re-renders from one store
  await page.evaluate(() => { location.hash = '#/contacts/contacts/10001'; }); await page.waitForSelector('.form-page');
  const input = await page.$('.title-field input');
  const t1 = Date.now(); await input.type('abcdefghij'); const typeMs = Date.now() - t1;
  console.log('typing 10 chars in a contact form:', typeMs, 'ms');
  const t2 = Date.now(); await page.click('.dirty .btn.primary'); await page.waitForTimeout(50); console.log('save (commit + localStorage write of whole db):', Date.now() - t2, 'ms');
  await browser.close();
})();
