const { chromium } = require('playwright');
const [BASE] = process.argv.slice(2);
(async () => {
  const browser = await chromium.launch();
  const admin = await (await browser.newContext()).newPage();
  await admin.goto(BASE + '/'); await admin.fill('#login', 'admin'); await admin.fill('#password', 'audit-pass-123');
  await admin.click('button[type=submit]'); await admin.waitForSelector('.app-grid');
  const made = await admin.evaluate(async () => (await fetch('/api/users', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'mizan' }, body: JSON.stringify({ login: 'clerk', name: 'Clerk', password: 'clerk-pass-123' }) })).status);
  console.log('create clerk user:', made);
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  const dialogs = []; page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  await page.goto(BASE + '/'); await page.fill('#login', 'clerk'); await page.fill('#password', 'clerk-pass-123');
  await page.click('button[type=submit]'); await page.waitForSelector('.app-grid');
  await page.evaluate(() => { location.hash = '#/settings/general'; }); await page.waitForSelector('#lock_date');
  const enabled = await page.evaluate(() => ['company', 'currency', 'lock_date', 'audit_trail'].map((id) => `${id}:${document.getElementById(id)?.disabled ? 'disabled' : 'enabled'}`).join(' '));
  console.log('controls for non-admin:', enabled);
  await page.fill('#lock_date', '2026-06-30');
  await page.waitForTimeout(100);
  const optimistic = await page.inputValue('#lock_date');
  await page.waitForTimeout(1500);
  const settled = await page.inputValue('#lock_date');
  await page.check('#audit_trail'); await page.waitForTimeout(1500);
  console.log(`lock_date: shown right after edit=${JSON.stringify(optimistic)}, after server reply=${JSON.stringify(settled)} | audit_trail checked after reply=${await page.isChecked('#audit_trail')} | dialogs=${JSON.stringify(dialogs)}`);
  // Reset demo as non-admin
  await page.click('button.btn.danger'); await page.waitForTimeout(1000);
  console.log('Reset demo as clerk -> dialogs:', JSON.stringify(dialogs.slice(-2)));
  await browser.close();
})();
