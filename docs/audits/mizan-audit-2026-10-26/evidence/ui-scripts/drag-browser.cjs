// Real mouse gesture: as non-admin "clerk", group Invoices kanban by Status and drag a Draft invoice into "Posted".
const { chromium } = require('playwright');
const [BASE, DIR] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.goto(BASE + '/'); await page.fill('#login', 'clerk'); await page.fill('#password', 'clerk-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  const serverMoves = () => page.evaluate(async () => (await (await fetch('/api/db')).json()).records['account.move'].filter((m) => m.move_type === 'out_invoice').map((m) => `${m.id}:${m.name}:${m.state}:lines=${(m.line_ids ?? []).length}`));
  console.log('server before:', JSON.stringify(await serverMoves()));
  await page.evaluate(() => { location.hash = '#/accounting/invoices?view=kanban'; }); await page.waitForSelector('.search-toggle');
  await page.click('.search-toggle');
  const groupBtns = await page.$$eval('.search-panel section:nth-of-type(2) button', (bs) => bs.map((b) => b.textContent));
  console.log('group-by options offered:', JSON.stringify(groupBtns));
  await page.click('.search-panel section:nth-of-type(2) button:has-text("Status")');
  await page.click('h1.cp-title');
  await page.waitForSelector('section.column');
  const cols = await page.$$eval('section.column', (cs) => cs.map((c) => `${c.getAttribute('aria-label')}(${c.querySelectorAll('article.card').length})`));
  console.log('columns:', cols.join(' '));
  const draftCard = page.locator('section.column[aria-label="Draft"] article.card').first();
  const postedCol = page.locator('section.column[aria-label="Posted"]');
  await draftCard.dragTo(postedCol);
  await page.waitForTimeout(1200);
  console.log('columns after drag:', (await page.$$eval('section.column', (cs) => cs.map((c) => `${c.getAttribute('aria-label')}(${c.querySelectorAll('article.card').length})`))).join(' '));
  console.log('server after:', JSON.stringify(await serverMoves()), '| dialogs:', JSON.stringify(dialogs));
  await page.screenshot({ path: `${DIR}/kanban-drag-posted.png` });
  await browser.close();
})();
